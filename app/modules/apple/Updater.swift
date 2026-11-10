// Switchyard's in-app updater (README "Updates"): checks GitHub releases for a newer build,
// downloads and verifies it in the background, then swaps the bundle in place when asked.
//
// One engine per process (every window's session shares it); each session's module only
// answers `native.call({op:"state"})` and `native.later({op:"check"|"install"})` and hears
// `changed("update")`. Nothing here blocks the main thread: the work runs on `queue`.

import CryptoKit
import Foundation

final class Updater: ExactModule {
    required init(context: ExactModuleContext) {
        super.init(context: context)
        SYUpdateEngine.shared.attach(self.context)
    }

    override func call(_ request: [String: Any]) throws -> [String: Any] {
        switch request["op"] as? String {
        case "state": return SYUpdateEngine.shared.snapshot()
        default: throw ExactNativeRefusal("updater answers state")
        }
    }

    override func later(_ request: [String: Any], reply: ExactReply) {
        switch request["op"] as? String {
        case "check":
            SYUpdateEngine.shared.check(manual: request["manual"] as? Bool ?? true) { reply.send($0) }
        case "install":
            SYUpdateEngine.shared.install { reply.send($0) }
        case "state":
            reply.send(SYUpdateEngine.shared.snapshot())
        default:
            reply.fail("updater answers check, install and state")
        }
    }

    override func willQuit(done: @escaping () -> Void) {
        SYUpdateEngine.shared.quitting()
        done()
    }

    override func destroy() { SYUpdateEngine.shared.detach(context) }
}

let exactModule: ExactModule.Type = Updater.self

// MARK: - the engine

final class SYUpdateEngine: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    static let shared = SYUpdateEngine()

    static let defaultRepo = "couplet-physical-ai/switchyard"
    static let firstCheck: TimeInterval = 10
    static let period: TimeInterval = 6 * 3600

    // Facts of this process, fixed at launch.
    let current: String
    let bundleURL: URL
    let bundleID: String
    let repo: String
    let prerelease: Bool
    /// The releases list: GitHub's API, or a test feed's `<base>/releases` from the env
    /// SWITCHYARD_UPDATE_FEED (env only, never a setting; the end-to-end test's own feed).
    let releasesURL: URL?
    let testFeed: Bool
    private(set) var agent = false
    private(set) var installed = false
    private(set) var writable = false
    private var autoInstallEnv = false

    // State, under `lock`.
    private let lock = NSLock()
    private var state = "idle"
    private var progress = 0.0
    private var latest = ""
    private var notes = ""
    private var error = ""
    private var notice = ""
    private var checks = 0
    private var manual = false
    private var noticeGen = 0
    private var stagingDir: URL?
    private var stagedApp: URL?
    private var stagedVersion = ""

    // Work, on `queue`.
    private let queue = DispatchQueue(label: "com.exowatt.switchyard.updater", qos: .utility)
    private var timer: DispatchSourceTimer?
    private var started = false
    private var listeners: [ObjectIdentifier: ExactModuleContext] = [:]
    private var session: URLSession?
    private var download: (task: URLSessionDownloadTask, done: (Result<URL, Error>) -> Void)?
    private var lastPublishedPct = -1

    private override init() {
        let info = Bundle.main.infoDictionary ?? [:]
        current = info["CFBundleShortVersionString"] as? String ?? "0.0.0"
        bundleURL = Bundle.main.bundleURL.resolvingSymlinksInPath()
        bundleID = Bundle.main.bundleIdentifier ?? ""
        let config = ((info["ExactModuleConfig"] as? [String: Any])?["updater"] as? [String: Any]) ?? [:]
        let r = (config["repo"] as? String ?? "").trimmingCharacters(in: .whitespaces)
        let repoName = r.range(of: #"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"#, options: .regularExpression) != nil ? r : SYUpdateEngine.defaultRepo
        repo = repoName
        let env = ProcessInfo.processInfo.environment
        prerelease = env["SWITCHYARD_UPDATE_PRERELEASE"] == "1" || UserDefaults.standard.bool(forKey: "SwitchyardUpdatePrerelease")
        autoInstallEnv = env["SWITCHYARD_UPDATE_AUTOINSTALL"] == "1"
        if let feed = env["SWITCHYARD_UPDATE_FEED"], !feed.isEmpty, let base = URL(string: feed), base.scheme == "http" || base.scheme == "https" {
            releasesURL = URL(string: base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/releases?per_page=20")
            testFeed = true
        } else {
            releasesURL = URL(string: "https://api.github.com/repos/\(repoName)/releases?per_page=20")
            testFeed = false
        }
        super.init()
    }

    /// Installed means under /Applications or ~/Applications, with a writable parent: only
    /// then can the bundle be swapped. Dev builds (target/clients/…) and the agent never auto-check.
    var canInstall: Bool { installed && writable && !agent }
    var auto: Bool { canInstall }

    func attach(_ context: ExactModuleContext) {
        lock.withLock { listeners[ObjectIdentifier(context)] = context }
        queue.async { [self] in
            guard !started else { return }
            started = true
            agent = context.agent
            let parent = bundleURL.deletingLastPathComponent()
            let home = FileManager.default.homeDirectoryForCurrentUser.resolvingSymlinksInPath().path
            let dir = parent.path
            installed = bundleURL.pathExtension == "app" && (dir == "/Applications" || dir == home + "/Applications")
            writable = FileManager.default.isWritableFile(atPath: dir)
            log("launch: \(bundleID) \(current) at \(bundleURL.path); installed=\(installed) writable=\(writable) agent=\(agent) prerelease=\(prerelease) repo=\(repo) auto=\(auto)\(testFeed ? " TEST FEED \(releasesURL?.absoluteString ?? "")" : "")")
            if auto { startTimer() }
            publish()
        }
    }

    func detach(_ context: ExactModuleContext) {
        lock.withLock { _ = listeners.removeValue(forKey: ObjectIdentifier(context)) }
    }

    func quitting() {
        queue.async { [self] in
            timer?.cancel()
            timer = nil
            download?.task.cancel()
        }
    }

    private func startTimer() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + SYUpdateEngine.firstCheck, repeating: SYUpdateEngine.period, leeway: .seconds(30))
        t.setEventHandler { [weak self] in self?.runCheck(manual: false) { _ in } }
        t.resume()
        timer = t
    }

    func snapshot() -> [String: Any] {
        lock.withLock {
            [
                "supported": true, "state": state, "current": current, "latest": latest,
                "progress": Int((progress * 100).rounded()), "notes": notes, "error": error, "notice": notice,
                "canInstall": canInstall, "auto": auto, "autoInstall": autoInstallEnv && canInstall,
                "prerelease": prerelease, "checks": checks, "repo": repo,
            ]
        }
    }

    // MARK: checking

    func check(manual: Bool, reply: @escaping ([String: Any]) -> Void) {
        queue.async { [self] in runCheck(manual: manual, reply: reply) }
    }

    /// On `queue`. Replies once the check itself is decided (current, available, ready, error,
    /// or a download started); a download goes on in the background and publishes as it moves.
    private func runCheck(manual: Bool, reply: @escaping ([String: Any]) -> Void) {
        let busy = lock.withLock { () -> String? in
            switch state {
            case "checking", "downloading", "installing", "ready": return state
            default: return nil
            }
        }
        if let busy {
            if manual {
                set { $0.manual = true }
                if busy == "ready" { say(transient: false, "") }
                else if busy == "downloading" { sayProgress() }
            }
            return reply(snapshot())
        }
        set { s in s.state = "checking"; s.error = ""; s.manual = manual; s.progress = 0 }
        if manual { say(transient: false, "Checking for updates…") }
        log("check (\(manual ? "manual" : "auto")): \(repo), current \(current), prerelease channel \(prerelease ? "on" : "off")")
        findRelease { [self] found in
            queue.async { [self] in
                switch found {
                case .failure(let e):
                    fail("could not check: \(e.localizedDescription)")
                    reply(snapshot())
                case .success(nil):
                    log("check: no \(prerelease ? "" : "stable ")release with a zip and SHA256SUMS")
                    set { s in s.state = "current"; s.latest = ""; s.notes = ""; s.checks += 1 }
                    say(transient: true, "Switchyard \(current) is up to date · no \(prerelease ? "" : "stable ")release published yet")
                    reply(snapshot())
                case .success(let rel?):
                    guard SYSemver.compare(rel.version, current) > 0 else {
                        log("check: latest \(rel.version) is not newer than \(current)")
                        set { s in s.state = "current"; s.latest = rel.version; s.notes = rel.notes; s.checks += 1 }
                        say(transient: true, "Switchyard \(current) is up to date")
                        return reply(snapshot())
                    }
                    log("check: \(rel.version) is newer than \(current) (\(rel.zipURL.absoluteString))")
                    set { s in s.latest = rel.version; s.notes = rel.notes; s.checks += 1 }
                    guard canInstall else {
                        set { $0.state = "available" }
                        say(transient: true, "Switchyard \(rel.version) is available · this copy is not in Applications, so it cannot update itself")
                        return reply(snapshot())
                    }
                    if stagedVersion == rel.version, let app = stagedApp, FileManager.default.fileExists(atPath: app.path) {
                        set { $0.state = "ready" }
                        say(transient: false, "")
                        return reply(snapshot())
                    }
                    set { s in s.state = "downloading"; s.progress = 0 }
                    sayProgress()
                    reply(snapshot())
                    fetchAndStage(rel)
                }
            }
        }
    }

    struct Release { let version: String; let zipName: String; let zipURL: URL; let sumsURL: URL; let notes: String }

    private func findRelease(_ done: @escaping (Result<Release?, Error>) -> Void) {
        guard let url = releasesURL else { return done(.success(nil)) }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("Switchyard/\(current) (macOS updater)", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: req) { [self] data, response, err in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if (status == 403 || status == 429) && !testFeed {
                log("check: the API answered \(status) (rate limit): the releases/latest fallback")
                return fallback(done)
            }
            if let err { return done(.failure(err)) }
            guard status == 200, let data else { return done(.failure(SYUpdateError("the releases API answered HTTP \(status)"))) }
            guard let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
                return done(.failure(SYUpdateError("the releases API answered something unreadable")))
            }
            var best: Release?
            for r in list {
                if r["draft"] as? Bool == true { continue }
                if r["prerelease"] as? Bool == true && !prerelease { continue }
                guard let tag = r["tag_name"] as? String, let version = SYSemver.clean(tag) else { continue }
                let zipName = "Switchyard-\(version)-arm64.zip"
                var zip: URL?, sums: URL?
                for a in r["assets"] as? [[String: Any]] ?? [] {
                    guard let name = a["name"] as? String, let u = (a["browser_download_url"] as? String).flatMap(URL.init(string:)) else { continue }
                    if name == zipName { zip = u } else if name == "SHA256SUMS" { sums = u }
                }
                guard let zip, let sums else { continue }
                if let b = best, SYSemver.compare(version, b.version) <= 0 { continue }
                best = Release(version: version, zipName: zipName, zipURL: zip, sumsURL: sums, notes: SYUpdateEngine.trimNotes(r["body"] as? String ?? ""))
            }
            done(.success(best))
        }.resume()
    }

    /// The API is rate limited (60 an hour for an address): /releases/latest/download/SHA256SUMS
    /// names the latest stable zip, and so its version.
    private func fallback(_ done: @escaping (Result<Release?, Error>) -> Void) {
        guard let sumsURL = URL(string: "https://github.com/\(repo)/releases/latest/download/SHA256SUMS") else { return done(.success(nil)) }
        var req = URLRequest(url: sumsURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        req.setValue("Switchyard/\(current) (macOS updater)", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: req) { [self] data, response, err in
            if let err { return done(.failure(err)) }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if status == 404 { return done(.success(nil)) }
            guard status == 200, let data, let text = String(data: data, encoding: .utf8) else {
                return done(.failure(SYUpdateError("releases/latest answered HTTP \(status)")))
            }
            for (_, name) in SYUpdateEngine.sums(text) {
                guard name.hasPrefix("Switchyard-"), name.hasSuffix("-arm64.zip") else { continue }
                let version = String(name.dropFirst("Switchyard-".count).dropLast("-arm64.zip".count))
                guard SYSemver.clean(version) == version,
                      let zip = URL(string: "https://github.com/\(repo)/releases/download/v\(version)/\(name)"),
                      let sums = URL(string: "https://github.com/\(repo)/releases/download/v\(version)/SHA256SUMS") else { continue }
                return done(.success(Release(version: version, zipName: name, zipURL: zip, sumsURL: sums, notes: "")))
            }
            done(.success(nil))
        }.resume()
    }

    static func trimNotes(_ body: String) -> String {
        let t = body.replacingOccurrences(of: "\r\n", with: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.count > 1500 else { return t }
        let cut = t.prefix(1500)
        let end = cut.lastIndex(of: "\n") ?? cut.lastIndex(of: " ") ?? cut.endIndex
        return String(cut[..<end]).trimmingCharacters(in: .whitespacesAndNewlines) + " …"
    }

    /// `shasum -a 256` lines: `<hex>  <file>` (a `*` before the name in binary mode).
    static func sums(_ text: String) -> [(String, String)] {
        text.split(whereSeparator: \.isNewline).compactMap { line in
            let parts = line.split(maxSplits: 1, whereSeparator: { $0 == " " || $0 == "\t" })
            guard parts.count == 2 else { return nil }
            let hex = parts[0].lowercased()
            var name = parts[1].trimmingCharacters(in: .whitespaces)
            if name.hasPrefix("*") { name.removeFirst() }
            guard hex.count == 64, hex.allSatisfy(\.isHexDigit) else { return nil }
            return (hex, name)
        }
    }

    // MARK: downloading and verifying

    private func fetchAndStage(_ rel: Release) {
        var req = URLRequest(url: rel.sumsURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        req.setValue("Switchyard/\(current) (macOS updater)", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: req) { [self] data, response, err in
            queue.async { [self] in
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard err == nil, status == 200, let data, let text = String(data: data, encoding: .utf8) else {
                    return fail("could not read SHA256SUMS: \(err?.localizedDescription ?? "HTTP \(status)")")
                }
                guard let want = SYUpdateEngine.sums(text).first(where: { $0.1 == rel.zipName })?.0 else {
                    return fail("SHA256SUMS has no line for \(rel.zipName)")
                }
                log("download: \(rel.zipName), expecting sha256 \(want)")
                startDownload(rel.zipURL) { [self] result in
                    queue.async { [self] in
                        switch result {
                        case .failure(let e): fail("download failed: \(e.localizedDescription)")
                        case .success(let zip): stage(rel, zip: zip, sha256: want)
                        }
                    }
                }
            }
        }.resume()
    }

    private func startDownload(_ url: URL, done: @escaping (Result<URL, Error>) -> Void) {
        if session == nil {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 60
            config.timeoutIntervalForResource = 30 * 60
            config.httpAdditionalHeaders = ["User-Agent": "Switchyard/\(current) (macOS updater)"]
            let q = OperationQueue()
            q.maxConcurrentOperationCount = 1
            q.underlyingQueue = queue
            session = URLSession(configuration: config, delegate: self, delegateQueue: q)
        }
        lastPublishedPct = -1
        let task = session!.downloadTask(with: url)
        download = (task, done)
        task.resume()
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard totalBytesExpectedToWrite > 0 else { return }
        let p = min(1, Double(totalBytesWritten) / Double(totalBytesExpectedToWrite))
        let pct = Int(p * 100)
        set { $0.progress = p }
        if pct != lastPublishedPct {
            lastPublishedPct = pct
            if pct % 10 == 0 { log("download: \(pct)% of \(totalBytesExpectedToWrite) bytes") }
            sayProgress()
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // The file is gone once this returns: move it into the staging directory now.
        guard let pending = download, pending.task === downloadTask else { return }
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            download = nil
            return pending.done(.failure(SYUpdateError("HTTP \(status)")))
        }
        do {
            let dir = try freshStaging()
            let zip = dir.appendingPathComponent("update.zip")
            try FileManager.default.moveItem(at: location, to: zip)
            download = nil
            pending.done(.success(zip))
        } catch {
            download = nil
            pending.done(.failure(error))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let pending = download, pending.task === task else { return }
        download = nil
        pending.done(.failure(error ?? SYUpdateError("the download ended with no file")))
    }

    /// A staging directory on the same volume as the installed bundle, so the swap is a rename.
    private func freshStaging() throws -> URL {
        cleanStaging()
        let dir = try FileManager.default.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: bundleURL, create: true)
        lock.withLock { stagingDir = dir }
        return dir
    }

    private func cleanStaging() {
        let dir = lock.withLock { () -> URL? in
            defer { stagingDir = nil; stagedApp = nil; stagedVersion = "" }
            return stagingDir
        }
        if let dir { try? FileManager.default.removeItem(at: dir) }
    }

    private func stage(_ rel: Release, zip: URL, sha256 want: String) {
        do {
            let got = try SYUpdateEngine.sha256(of: zip)
            guard got == want else { throw SYUpdateError("checksum mismatch: got \(got), SHA256SUMS says \(want)") }
            log("verify: sha256 \(got) matches SHA256SUMS")
            let out = zip.deletingLastPathComponent().appendingPathComponent("unzipped", isDirectory: true)
            try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
            try SYUpdateEngine.run("/usr/bin/ditto", ["-x", "-k", zip.path, out.path], deadline: 120)
            try? FileManager.default.removeItem(at: zip)
            let apps = (try? FileManager.default.contentsOfDirectory(at: out, includingPropertiesForKeys: nil))?.filter { $0.pathExtension == "app" } ?? []
            guard apps.count == 1, let app = apps.first else { throw SYUpdateError("the zip holds \(apps.count) apps, not one") }
            guard let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")) as? [String: Any] else {
                throw SYUpdateError("the downloaded app has no readable Info.plist")
            }
            let id = info["CFBundleIdentifier"] as? String ?? "", ver = info["CFBundleShortVersionString"] as? String ?? ""
            guard id == bundleID else { throw SYUpdateError("the downloaded app is \(id), not \(bundleID)") }
            guard ver == rel.version else { throw SYUpdateError("the downloaded app says version \(ver), the release \(rel.version)") }
            log("verify: \(id) \(ver) (bundle identifier and version match)")
            let sig = try SYUpdateEngine.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path], deadline: 120)
            log("verify: codesign --verify --deep --strict passed\(sig.isEmpty ? "" : ": \(sig)")")
            do { try SYUpdateEngine.run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", app.path], deadline: 30) }
            catch { log("xattr: \(error.localizedDescription) (nothing to remove)") }
            set { s in s.stagedApp = app; s.stagedVersion = rel.version; s.state = "ready"; s.progress = 1 }
            say(transient: false, "")
            log("ready: \(rel.version) staged at \(app.path)")
        } catch {
            cleanStaging()
            fail(error.localizedDescription)
        }
    }

    static func sha256(of file: URL) throws -> String {
        let h = try FileHandle(forReadingFrom: file)
        defer { try? h.close() }
        var hasher = SHA256()
        while true {
            let chunk = try autoreleasepool { try h.read(upToCount: 1 << 20) }
            guard let chunk, !chunk.isEmpty else { break }
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// A child process with a deadline: past it the child is terminated, then killed.
    @discardableResult
    static func run(_ tool: String, _ args: [String], deadline: TimeInterval) throws -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        p.standardInput = FileHandle.nullDevice
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        let exited = DispatchSemaphore(value: 0)
        p.terminationHandler = { _ in exited.signal() }
        var output = Data()
        let readDone = DispatchSemaphore(value: 0)
        try p.run()
        DispatchQueue.global(qos: .utility).async {
            output = pipe.fileHandleForReading.readDataToEndOfFile()
            readDone.signal()
        }
        if exited.wait(timeout: .now() + deadline) == .timedOut {
            p.terminate()
            if exited.wait(timeout: .now() + 3) == .timedOut { kill(p.processIdentifier, SIGKILL); _ = exited.wait(timeout: .now() + 3) }
            throw SYUpdateError("\((tool as NSString).lastPathComponent) took longer than \(Int(deadline)) s")
        }
        _ = readDone.wait(timeout: .now() + 5)
        let text = String(decoding: output, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard p.terminationStatus == 0 else {
            throw SYUpdateError("\((tool as NSString).lastPathComponent) failed (\(p.terminationStatus))\(text.isEmpty ? "" : ": \(text.prefix(300))")")
        }
        return text
    }

    // MARK: installing

    func install(reply: @escaping ([String: Any]) -> Void) {
        queue.async { [self] in
            let (st, app, version) = lock.withLock { (state, stagedApp, stagedVersion) }
            guard st == "ready", let app, canInstall else {
                log("install refused: state \(st), canInstall \(canInstall)")
                return reply(["installed": false, "error": canInstall ? "no verified update is ready" : "this copy cannot update itself"])
            }
            set { $0.state = "installing" }
            say(transient: false, "")
            log("install: swapping \(bundleURL.path) for \(app.path)")
            do {
                let result = try FileManager.default.replaceItemAt(bundleURL, withItemAt: app, backupItemName: nil, options: [])
                let now = (NSDictionary(contentsOf: (result ?? bundleURL).appendingPathComponent("Contents/Info.plist")) as? [String: Any])?["CFBundleShortVersionString"] as? String ?? "?"
                log("install: swapped; \(bundleURL.path) is now \(now); relaunching")
                cleanStaging()
                set { s in s.stagedApp = nil; s.stagedVersion = "" }
                reply(["installed": true, "version": now])
            } catch {
                cleanStaging()
                fail("could not replace the app: \(error.localizedDescription)")
                reply(["installed": false, "error": error.localizedDescription])
            }
        }
    }

    // MARK: state

    private struct Mut {
        var state: String, progress: Double, latest: String, notes: String, error: String
        var checks: Int, manual: Bool, stagedApp: URL?, stagedVersion: String
    }

    /// Change the state under the lock and publish it.
    private func set(_ change: (inout Mut) -> Void) {
        lock.withLock {
            var m = Mut(state: state, progress: progress, latest: latest, notes: notes, error: error, checks: checks, manual: manual, stagedApp: stagedApp, stagedVersion: stagedVersion)
            change(&m)
            state = m.state; progress = m.progress; latest = m.latest; notes = m.notes; error = m.error
            checks = m.checks; manual = m.manual; stagedApp = m.stagedApp; stagedVersion = m.stagedVersion
        }
        publish()
    }

    /// The pill's transient line, said only for a manual check (an automatic one is silent
    /// until "ready"). A transient one clears itself after 8 s.
    private func say(transient: Bool, _ text: String) {
        let gen: Int? = lock.withLock {
            guard manual || text.isEmpty else { return nil }
            noticeGen += 1
            notice = text
            return noticeGen
        }
        guard let gen else { return }
        publish()
        guard transient, !text.isEmpty else { return }
        queue.asyncAfter(deadline: .now() + 8) { [self] in
            let cleared = lock.withLock { () -> Bool in
                guard noticeGen == gen else { return false }
                notice = ""
                manual = false
                return true
            }
            if cleared { publish() }
        }
    }

    private func sayProgress() {
        let (v, p) = lock.withLock { (latest, progress) }
        say(transient: false, "Downloading \(v) · \(Int(p * 100))%")
    }

    private func fail(_ reason: String) {
        log("error: \(reason)")
        set { s in
            if s.state == "checking" { s.checks += 1 }
            s.state = "error"; s.error = reason
        }
        say(transient: true, "Update failed: \(reason)")
    }

    private func publish() {
        let all = lock.withLock { Array(listeners.values) }
        for c in all { c.changed("update") }
    }

    private func log(_ line: String) {
        let text = "[updater] \(line)"
        print(text)
        fflush(stdout)
        SYUpdateLog.append(text)
    }
}

struct SYUpdateError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// The updater's lines also go to ~/Library/Logs/Switchyard/updater.log: a relaunched app's
/// stdout is /dev/null, and the swap is exactly what one wants to read back.
enum SYUpdateLog {
    static let url: URL? = {
        guard let lib = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first else { return nil }
        let dir = lib.appendingPathComponent("Logs/Switchyard", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("updater.log")
    }()
    private static let lock = NSLock()

    static func append(_ line: String) {
        guard let url else { return }
        let stamp = ISO8601DateFormatter().string(from: Date())
        let data = Data("\(stamp) pid \(getpid()) \(line)\n".utf8)
        lock.withLock {
            if let h = try? FileHandle(forWritingTo: url) {
                defer { try? h.close() }
                // Keep it small: start again past 1 MiB.
                if let end = try? h.seekToEnd(), end > 1 << 20 { try? h.truncate(atOffset: 0) }
                try? h.write(contentsOf: data)
            } else {
                try? data.write(to: url)
            }
        }
    }
}

/// Numeric semver: `v1.2.3`, `1.2.3-rc.1`; a pre-release sorts below its release.
enum SYSemver {
    static func clean(_ tag: String) -> String? {
        var t = tag.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("v") || t.hasPrefix("V") { t.removeFirst() }
        guard t.range(of: #"^\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$"#, options: .regularExpression) != nil else { return nil }
        return t
    }

    static func compare(_ a: String, _ b: String) -> Int {
        let (an, ap) = split(a), (bn, bp) = split(b)
        for i in 0..<3 {
            let x = i < an.count ? an[i] : 0, y = i < bn.count ? bn[i] : 0
            if x != y { return x < y ? -1 : 1 }
        }
        switch (ap.isEmpty, bp.isEmpty) {
        case (true, true): return 0
        case (true, false): return 1
        case (false, true): return -1
        default: break
        }
        for (x, y) in zip(ap, bp) where x != y {
            switch (Int(x), Int(y)) {
            case let (i?, j?): return i < j ? -1 : 1
            case (_?, nil): return -1
            case (nil, _?): return 1
            default: return x < y ? -1 : 1
            }
        }
        return ap.count == bp.count ? 0 : (ap.count < bp.count ? -1 : 1)
    }

    private static func split(_ v: String) -> ([Int], [String]) {
        let s = clean(v) ?? v
        let core = s.split(separator: "+", maxSplits: 1).first.map(String.init) ?? s
        let parts = core.split(separator: "-", maxSplits: 1)
        let nums = (parts.first ?? "").split(separator: ".").map { Int($0) ?? 0 }
        let pre = parts.count > 1 ? parts[1].split(separator: ".").map(String.init) : []
        return (nums, pre)
    }
}
