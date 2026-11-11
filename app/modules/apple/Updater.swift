// Switchyard's in-app updater (README "Updates"), the Exact side: one engine per process that
// reads the feed, fetches and checks a newer build in the background, and swaps it in when the
// person presses "Relaunch to update". The logic it runs is UpdaterCore.swift (pure, tested by
// tools/updater-tests.sh); this file is the module, the timer, the network and the state.
//
// Each session's module only answers `native.call({op:"state"})` and
// `native.later({op:"check"|"install"})` and hears `changed("update")`. Nothing here blocks the
// main thread: the work runs on `queue`. Nothing relaunches on its own: the Contract calls
// `relaunch()` after a pressed install (or, for the end-to-end test only, the env
// SWITCHYARD_UPDATE_AUTOINSTALL=1).

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
        case "check": SYUpdateEngine.shared.check(manual: request["manual"] as? Bool ?? true) { reply.send($0) }
        case "install": SYUpdateEngine.shared.install { reply.send($0) }
        case "state": reply.send(SYUpdateEngine.shared.snapshot())
        default: reply.fail("updater answers check, install and state")
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

    static let firstCheck: TimeInterval = 10
    static let period: TimeInterval = 6 * 3600
    /// Staging folders made by the copy at this path, for its next launch's sweep (one key per
    /// bundle path: another copy of the app, a dev build say, never sweeps this one's).
    var stagingKey: String { "SwitchyardUpdateStaging " + bundleURL.path }

    // Facts of this process, fixed at launch.
    let current: String
    let bundleURL: URL
    let bundleID: String
    let repo: String
    let prerelease: Bool
    /// SWITCHYARD_UPDATE_FEED (env only, never a setting): a base URL serving latest.json.
    let testFeed: URL?
    let testFeedRefused: String?
    let policy: SYHostPolicy
    let autoInstallEnv: Bool
    private(set) var agent = false
    private(set) var installed = false
    private(set) var writable = false
    /// Under the agent, with no test feed: an in-process stub feed (SYStubFeed), never the network.
    private(set) var stub = false

    // State, under `lock`.
    private let lock = NSLock()
    private var state = "idle"
    private var progress = 0.0
    private var latest = ""
    private var notes = ""
    private var published = ""
    private var error = ""
    private var quiet = false
    private var flash = false
    private var flashGen = 0
    private var checks = 0
    private var lastChecked = 0.0
    private var stagingDir: URL?
    private var stagedApp: URL?
    private var stagedVersion = ""

    // Work, on `queue`.
    private let queue = DispatchQueue(label: "com.exowatt.switchyard.updater", qos: .utility)
    private var timer: DispatchSourceTimer?
    private var started = false
    private var listeners: [ObjectIdentifier: ExactModuleContext] = [:]
    private var session: URLSession!
    private var download: (task: URLSessionDownloadTask, done: (Result<URL, Error>) -> Void)?
    private var hopRefusals: [Int: SYRefusal] = [:]
    private var lastPublishedPct = -1

    private override init() {
        let info = Bundle.main.infoDictionary ?? [:]
        current = info["CFBundleShortVersionString"] as? String ?? "0.0.0"
        bundleURL = Bundle.main.bundleURL.resolvingSymlinksInPath()
        bundleID = Bundle.main.bundleIdentifier ?? ""
        let config = ((info["ExactModuleConfig"] as? [String: Any])?["updater"] as? [String: Any]) ?? [:]
        let r = (config["repo"] as? String ?? "").trimmingCharacters(in: .whitespaces)
        repo = r.range(of: #"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"#, options: .regularExpression) != nil ? r : SYFeed.defaultRepo
        let env = ProcessInfo.processInfo.environment
        prerelease = env["SWITCHYARD_UPDATE_PRERELEASE"] == "1" || UserDefaults.standard.bool(forKey: "SwitchyardUpdatePrerelease")
        autoInstallEnv = env["SWITCHYARD_UPDATE_AUTOINSTALL"] == "1"
        let raw = env["SWITCHYARD_UPDATE_FEED"] ?? ""
        testFeed = SYHostPolicy.testFeedBase(raw)
        testFeedRefused = !raw.isEmpty && testFeed == nil ? raw : nil
        policy = SYHostPolicy(testFeed: testFeed)
        super.init()
    }

    /// Installed: under /Applications or ~/Applications, in a writable folder, not the agent.
    /// Only such a copy checks by itself and can swap itself.
    var canInstall: Bool { installed && writable && !agent }
    var auto: Bool { canInstall }
    /// May fetch and check a newer build: an installed copy, or the agent's stub feed (which
    /// stages into a scratch folder and never swaps).
    private var canStage: Bool { canInstall || stub }

    func attach(_ context: ExactModuleContext) {
        lock.withLock { listeners[ObjectIdentifier(context)] = context }
        queue.async { [self] in
            guard !started else { return }
            started = true
            agent = context.agent
            stub = agent && testFeed == nil
            let parent = bundleURL.deletingLastPathComponent()
            let home = FileManager.default.homeDirectoryForCurrentUser.resolvingSymlinksInPath().path
            installed = bundleURL.pathExtension == "app" && (parent.path == "/Applications" || parent.path == home + "/Applications")
            writable = FileManager.default.isWritableFile(atPath: parent.path)
            makeSession()
            log("launch: \(bundleID) \(current) pid \(getpid()) at \(bundleURL.path); installed=\(installed) writable=\(writable) agent=\(agent) prerelease=\(prerelease) auto=\(auto)"
                + (testFeed.map { " TEST FEED \($0.absoluteString)" } ?? "") + (stub ? " STUB FEED (agent)" : "")
                + (testFeedRefused.map { " REFUSED TEST FEED \($0) (https, or http only on 127.0.0.1)" } ?? ""))
            // Copper's timing: what an earlier run left goes at launch, before the first check.
            // (A swap's aside is the bundle the previous process ran from until it quit.)
            sweep()
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
            if stub { cleanStaging() }
        }
    }

    private func startTimer() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + SYUpdateEngine.firstCheck, repeating: SYUpdateEngine.period, leeway: .seconds(30))
        t.setEventHandler { [weak self] in self?.runCheck(manual: false) { _ in } }
        t.resume()
        timer = t
    }

    private func makeSession() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 30 * 60
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpAdditionalHeaders = ["User-Agent": "Switchyard/\(current) (macOS updater)"]
        if stub { config.protocolClasses = [SYStubFeed.self] }
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.underlyingQueue = queue
        session = URLSession(configuration: config, delegate: self, delegateQueue: q)
    }

    func snapshot() -> [String: Any] {
        lock.withLock {
            [
                "supported": true, "state": state, "current": current, "latest": latest,
                "progress": Int((progress * 100).rounded(.down)), "notes": notes, "published": published,
                "error": error, "quiet": quiet, "flash": flash,
                "canInstall": canInstall, "auto": auto, "autoInstall": autoInstallEnv && canInstall,
                "prerelease": prerelease, "checks": checks, "lastChecked": lastChecked, "stub": stub,
            ]
        }
    }

    // MARK: checking

    func check(manual: Bool, reply: @escaping ([String: Any]) -> Void) {
        queue.async { [self] in runCheck(manual: manual, reply: reply) }
    }

    /// On `queue`. Replies once the check is decided (current, available, failed, or a download
    /// started); a download goes on in the background and publishes as it moves.
    private func runCheck(manual: Bool, reply: @escaping ([String: Any]) -> Void) {
        let busy = lock.withLock { ["checking", "downloading", "installing", "ready"].contains(state) }
        if busy {
            if manual { set { $0.flash = true } }
            return reply(snapshot())
        }
        set { s in s.state = "checking"; s.error = ""; s.quiet = false; s.flash = manual; s.progress = 0 }
        log("check (\(manual ? "manual" : "auto")): current \(current), channel \(prerelease ? "pre-release" : "stable")")
        if stub { SYStubFeed.step = lock.withLock { checks } ; SYStubFeed.current = current; SYStubFeed.bundleID = bundleID }
        findRelease { [self] found in
            queue.async { [self] in
                switch found {
                case .failure(let e):
                    // An automatic check that could not reach the feed says nothing (offline is
                    // not news); a manual one says why.
                    fail(describe(e), quiet: !manual, checked: true)
                    reply(snapshot())
                case .success(nil):
                    log("check: no \(prerelease ? "" : "stable ")release is published yet")
                    finished(latest: "", notes: "", published: "")
                    reply(snapshot())
                case .success(let rel?):
                    if let refusal = policy.refuseAsset(rel.url) ?? rel.sumsURL.flatMap(policy.refuseAsset) {
                        fail(describe(refusal), quiet: false, checked: true)
                        return reply(snapshot())
                    }
                    guard SYSemver.isNewer(rel.version, than: current), rel.runsHere else {
                        log("check (\(rel.source)): \(rel.version) is not newer than \(current)\(rel.runsHere ? "" : ", or needs macOS \(rel.minimumSystemVersion ?? "")")")
                        finished(latest: rel.version, notes: rel.notes, published: rel.published)
                        return reply(snapshot())
                    }
                    log("check (\(rel.source)): \(rel.version) is newer than \(current): \(rel.url.absoluteString)")
                    set { s in s.latest = rel.version; s.notes = rel.notes; s.published = rel.published; s.checks += 1; s.lastChecked = Date().timeIntervalSince1970 * 1000 }
                    guard canStage else {
                        set { $0.state = "available" }
                        return reply(snapshot())
                    }
                    if stagedVersion == rel.version, let app = stagedApp, FileManager.default.fileExists(atPath: app.path) {
                        set { $0.state = "ready" }
                        return reply(snapshot())
                    }
                    set { s in s.state = "downloading"; s.progress = 0 }
                    reply(snapshot())
                    fetchAndStage(rel)
                }
            }
        }
    }

    private func finished(latest v: String, notes n: String, published p: String) {
        let gen = lock.withLock { () -> Int in flashGen += 1; return flashGen }
        set { s in s.state = "current"; s.latest = v; s.notes = n; s.published = p; s.checks += 1; s.lastChecked = Date().timeIntervalSince1970 * 1000 }
        // "Up to date" shows in the pill for a few seconds after a manual check.
        queue.asyncAfter(deadline: .now() + 8) { [self] in
            let cleared = lock.withLock { () -> Bool in
                guard flashGen == gen, flash else { return false }
                flash = false
                return true
            }
            if cleared { publish() }
        }
    }

    /// latest.json first (one small file, no rate limit); the releases API (and SHA256SUMS) when
    /// it is missing or unreadable, and always on the pre-release channel. A test feed is only
    /// ever latest.json.
    private func findRelease(_ done: @escaping (Result<SYRelease?, Error>) -> Void) {
        if let raw = testFeedRefused { return done(.failure(SYRefusal.insecure(raw))) }
        if let base = testFeed {
            return fetchLatestJSON(base.appendingPathComponent("latest.json")) { done($0.map { $0 }) }
        }
        if prerelease && !stub { return fromAPI(done) }
        fetchLatestJSON(SYFeed.latestJSON(repo: repo)) { [self] result in
            switch result {
            case .success(let rel): done(.success(rel))
            case .failure(let e):
                if stub { return done(.failure(e)) }
                log("check: latest.json: \(describe(e)); the releases API instead")
                fromAPI(done)
            }
        }
    }

    private func fetchLatestJSON(_ url: URL, _ done: @escaping (Result<SYRelease, Error>) -> Void) {
        get(url, kind: "feed") { [self] result in
            done(result.flatMap { data in Result { try SYFeed.parseLatest(data, bundleID: bundleID) } })
        }
    }

    private func fromAPI(_ done: @escaping (Result<SYRelease?, Error>) -> Void) {
        get(SYFeed.releasesAPI(repo: repo), kind: "api", accept: "application/vnd.github+json") { [self] result in
            switch result {
            case .success(let data): done(Result { try SYFeed.pickFromAPI(data, prerelease: prerelease) })
            case .failure(SYHTTPStatus.code(let status)) where status == 403 || status == 429:
                log("check: the releases API answered \(status) (rate limit): releases/latest/download/SHA256SUMS instead")
                get(SYFeed.latestSums(repo: repo), kind: "feed") { [self] r in
                    switch r {
                    case .success(let data): done(.success(SYFeed.fromLatestSums(String(decoding: data, as: UTF8.self), repo: repo)))
                    case .failure(SYHTTPStatus.code(404)): done(.success(nil))
                    case .failure(let e): done(.failure(e))
                    }
                }
            case .failure(let e): done(.failure(e))
            }
        }
    }

    /// One GET, every hop checked (urlSession(_:task:willPerformHTTPRedirection:…)).
    private func get(_ url: URL, kind: String, accept: String? = nil, _ done: @escaping (Result<Data, Error>) -> Void) {
        if let refusal = kind == "asset" ? policy.refuseAsset(url) : policy.refuseFeed(url) { return done(.failure(refusal)) }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        if let accept { req.setValue(accept, forHTTPHeaderField: "Accept") }
        var task: URLSessionDataTask!
        task = session.dataTask(with: req) { [self] data, response, err in
            // A completion handler runs on the delegate queue, which is `queue`.
            if let refused = hopRefusals.removeValue(forKey: task.taskIdentifier) { return done(.failure(refused)) }
            if let err { return done(.failure(err)) }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard status == 200, let data else { return done(.failure(SYHTTPStatus.code(status))) }
            done(.success(data))
        }
        task.taskDescription = kind
        task.resume()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let next = request.url else { return completionHandler(nil) }
        if let refusal = policy.refuseHop(next, api: task.taskDescription == "api") {
            log("redirect refused: \(task.originalRequest?.url?.host ?? "?") → \(next.absoluteString) (\(describe(refusal)))")
            hopRefusals[task.taskIdentifier] = refusal
            task.cancel()
            return completionHandler(nil)
        }
        log("redirect: \(response.url?.host ?? "?") → \(next.host ?? "?")")
        completionHandler(request)
    }

    // MARK: downloading and checking

    private func fetchAndStage(_ rel: SYRelease) {
        if let sha = rel.sha256 { return startStage(rel, sha256: sha) }
        guard let sums = rel.sumsURL else { return fail("the release names no checksum", quiet: false) }
        get(sums, kind: "asset") { [self] result in
            queue.async { [self] in
                switch result {
                case .failure(let e): fail("could not read SHA256SUMS: \(describe(e))", quiet: false)
                case .success(let data):
                    guard let want = SYFeed.sum(in: String(decoding: data, as: UTF8.self), for: SYFeed.zipName(rel.version)) else {
                        return fail("SHA256SUMS has no line for \(SYFeed.zipName(rel.version))", quiet: false)
                    }
                    startStage(rel, sha256: want)
                }
            }
        }
    }

    private func startStage(_ rel: SYRelease, sha256 want: String) {
        let dir: URL
        do { dir = try freshStaging() } catch { return fail(describe(error), quiet: false) }
        log("download: \(rel.url.absoluteString) → \(dir.path), expecting sha256 \(want)")
        lastPublishedPct = -1
        let task = session.downloadTask(with: rel.url)
        task.taskDescription = "asset"
        download = (task, { [self] result in
            switch result {
            case .failure(let e): fail(describe(e), quiet: false)
            case .success(let zip): stage(rel, zip: zip, sha256: want, in: dir)
            }
        })
        task.resume()
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard totalBytesExpectedToWrite > 0 else { return }
        let p = min(1, Double(totalBytesWritten) / Double(totalBytesExpectedToWrite))
        let pct = Int(p * 100)
        guard pct != lastPublishedPct else { return }
        lastPublishedPct = pct
        if pct % 25 == 0 { log("download: \(pct)% of \(totalBytesExpectedToWrite) bytes") }
        set { $0.progress = p }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // The file is gone once this returns: move it into the staging folder now.
        guard let pending = download, pending.task === downloadTask, let dir = lock.withLock({ stagingDir }) else { return }
        download = nil
        if let refused = hopRefusals.removeValue(forKey: downloadTask.taskIdentifier) { return pending.done(.failure(refused)) }
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { return pending.done(.failure(SYRefusal.download("HTTP \(status)"))) }
        let zip = dir.appendingPathComponent("update.zip")
        do {
            try FileManager.default.moveItem(at: location, to: zip)
            pending.done(.success(zip))
        } catch {
            pending.done(.failure(error))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let pending = download, pending.task === task else { return }
        download = nil
        let refused = hopRefusals.removeValue(forKey: task.taskIdentifier)
        pending.done(.failure(refused ?? error ?? SYRefusal.download("it ended with no file")))
    }

    /// Copper's scratch folder: on the app's volume (itemReplacementDirectory appropriate for
    /// the bundle), so the last move is a rename; else a hidden sibling of the bundle. Its path
    /// is kept for the next launch's sweep.
    private func freshStaging() throws -> URL {
        cleanStaging()
        let files = FileManager.default
        var dir: URL
        if stub {
            dir = files.temporaryDirectory.appendingPathComponent("switchyard-update-stub-\(getpid())", isDirectory: true)
        } else {
            let parent = bundleURL.deletingLastPathComponent()
            guard files.isWritableFile(atPath: parent.path) else { throw SYRefusal.readOnly(parent.path) }
            dir = (try? files.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: bundleURL, create: true))
                ?? parent.appendingPathComponent(".Switchyard-update-\(getpid())", isDirectory: true)
            if (try? SYSwap(target: bundleURL, bundleID: bundleID).preflight(staging: dir)) == nil {
                try? files.removeItem(at: dir)
                dir = parent.appendingPathComponent(".Switchyard-update-\(getpid())", isDirectory: true)
                try files.createDirectory(at: dir, withIntermediateDirectories: true)
            }
            try SYSwap(target: bundleURL, bundleID: bundleID).preflight(staging: dir)
            var kept = UserDefaults.standard.stringArray(forKey: stagingKey) ?? []
            kept.append(dir.path)
            UserDefaults.standard.set(kept, forKey: stagingKey)
        }
        try files.createDirectory(at: dir, withIntermediateDirectories: true)
        lock.withLock { stagingDir = dir }
        return dir
    }

    private func cleanStaging() {
        let dir = lock.withLock { () -> URL? in
            defer { stagingDir = nil; stagedApp = nil; stagedVersion = "" }
            return stagingDir
        }
        guard let dir else { return }
        try? FileManager.default.removeItem(at: dir)
        let kept = (UserDefaults.standard.stringArray(forKey: stagingKey) ?? []).filter { $0 != dir.path }
        UserDefaults.standard.set(kept, forKey: stagingKey)
    }

    private func stage(_ rel: SYRelease, zip: URL, sha256 want: String, in dir: URL) {
        let verifier = SYVerifier(bundleID: bundleID, current: current, team: SYSign.team(of: bundleURL))
        do {
            let app = try verifier.verify(zip: zip, sha256: want, version: rel.version, into: dir)
            try? FileManager.default.removeItem(at: zip)
            log("verify: sha256 \(want) matches; ditto -x -k unpacked; \(bundleID) \(rel.version) is newer than \(current); codesign --verify --deep --strict passed; no quarantine")
            set { s in s.stagedApp = app; s.stagedVersion = rel.version; s.state = "ready"; s.progress = 1 }
            log("ready: \(rel.version) staged at \(app.path)")
        } catch {
            cleanStaging()
            fail(describe(error), quiet: false)
        }
    }

    // MARK: installing

    /// The pressed "Relaunch to update": Copper's swap (two renames, the first undone if the
    /// second fails). The Contract relaunches when this answers installed.
    func install(reply: @escaping ([String: Any]) -> Void) {
        queue.async { [self] in
            let (st, app, version) = lock.withLock { (state, stagedApp, stagedVersion) }
            guard st == "ready", let app, canInstall else {
                let why = !canInstall ? SYRefusal.notInstalled.errorDescription! : "no checked update is ready"
                log("install refused: \(why) (state \(st))")
                return reply(["installed": false, "error": why])
            }
            set { $0.state = "installing" }
            let swap = SYSwap(target: bundleURL, bundleID: bundleID)
            log("install: rename \(bundleURL.lastPathComponent) → \(swap.aside.lastPathComponent), then \(app.path) → \(bundleURL.path)")
            do {
                try swap.swap(app)
                let now = (NSDictionary(contentsOf: bundleURL.appendingPathComponent("Contents/Info.plist")) as? [String: Any])?["CFBundleShortVersionString"] as? String ?? "?"
                log("install: swapped; \(bundleURL.path) is now \(now) (was \(current)); \(swap.aside.lastPathComponent) goes at the next launch; relaunching")
                set { s in s.stagedApp = nil; s.stagedVersion = "" }
                reply(["installed": true, "version": now, "expected": version])
            } catch {
                cleanStaging()
                fail(describe(error), quiet: false)
                reply(["installed": false, "error": describe(error)])
            }
        }
    }

    /// At launch: the aside bundle a swap left, and the staging folders (with their downloads).
    private func sweep() {
        let kept = (UserDefaults.standard.stringArray(forKey: stagingKey) ?? []).map { URL(fileURLWithPath: $0) }
        let gone = SYSwap(target: bundleURL, bundleID: bundleID).sweep(staging: kept)
        if !kept.isEmpty { UserDefaults.standard.removeObject(forKey: stagingKey) }
        log(gone.isEmpty ? "sweep: nothing left over" : "sweep: removed \(gone.joined(separator: ", "))")
    }

    // MARK: state

    private struct Mut {
        var state: String, progress: Double, latest: String, notes: String, published: String, error: String
        var quiet: Bool, flash: Bool, checks: Int, lastChecked: Double, stagedApp: URL?, stagedVersion: String
    }

    /// Change the state under the lock and publish it.
    private func set(_ change: (inout Mut) -> Void) {
        lock.withLock {
            var m = Mut(state: state, progress: progress, latest: latest, notes: notes, published: published, error: error,
                        quiet: quiet, flash: flash, checks: checks, lastChecked: lastChecked, stagedApp: stagedApp, stagedVersion: stagedVersion)
            change(&m)
            state = m.state; progress = m.progress; latest = m.latest; notes = m.notes; published = m.published; error = m.error
            quiet = m.quiet; flash = m.flash; checks = m.checks; lastChecked = m.lastChecked; stagedApp = m.stagedApp; stagedVersion = m.stagedVersion
        }
        publish()
    }

    private func fail(_ reason: String, quiet q: Bool, checked: Bool = false) {
        log("error: \(reason)")
        set { s in
            if checked { s.checks += 1; s.lastChecked = Date().timeIntervalSince1970 * 1000 }
            s.state = "error"; s.error = reason; s.quiet = q
        }
    }

    private func describe(_ e: Error) -> String {
        if let r = e as? SYRefusal { return r.errorDescription ?? "\(r)" }
        if case SYHTTPStatus.code(let c) = e { return "HTTP \(c)" }
        return e.localizedDescription
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

enum SYHTTPStatus: Error { case code(Int) }

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

// MARK: - the agent's stub feed

/// Under the agent the updater never touches the network: this URLProtocol answers its session
/// (tests/update.test.contract). latest.json names, by the number of checks so far:
///   0: this version (up to date);
///   1: 9.9.9 with a sha256 that is not its zip's (downloads, then "checksum mismatch");
///   2+: 9.9.9 with the right sha256 (downloads through a GitHub-style redirect, passes every
///      check, and is ready; the agent's copy is not installed, so it never swaps).
/// The zip is a minimal ad-hoc-signed bundle with this app's id (SYFixture).
final class SYStubFeed: URLProtocol {
    static var step = 0
    static var current = "0.0.0"
    static var bundleID = ""
    private static let lock = NSLock()
    private static var made: (zip: Data, sha: String)?
    private var stopped = false

    static func zip() -> (zip: Data, sha: String)? {
        lock.withLock {
            if let made { return made }
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("switchyard-stub-zip-\(getpid())", isDirectory: true)
            defer { try? FileManager.default.removeItem(at: dir) }
            guard let zip = try? SYFixture.zip(in: dir, id: bundleID, version: "9.9.9"), let data = try? Data(contentsOf: zip),
                  let sha = try? SYDigest.sha256(of: zip) else { return nil }
            made = (data, sha)
            return made
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        let path = url.path
        if path.hasSuffix("/latest.json") {
            let base = "https://github.com/\(SYFeed.defaultRepo)/releases/download"
            let body: [String: Any]
            if SYStubFeed.step == 0 {
                body = ["version": SYStubFeed.current, "url": "\(base)/v\(SYStubFeed.current)/\(SYFeed.zipName(SYStubFeed.current))",
                        "sha256": String(repeating: "0", count: 64), "notes": "", "published": "2026-11-10T00:00:00Z"]
            } else {
                let sha = SYStubFeed.step == 1 ? String(repeating: "f", count: 64) : (SYStubFeed.zip()?.sha ?? "")
                body = ["version": "9.9.9", "url": "\(base)/v9.9.9/\(SYFeed.zipName("9.9.9"))", "sha256": sha,
                        "notes": "- The stub feed's release notes.", "published": "2026-11-10T00:00:00Z"]
            }
            return answer(200, (try? JSONSerialization.data(withJSONObject: body)) ?? Data(), type: "application/json")
        }
        if url.host == "github.com", path.hasSuffix(".zip") {
            // GitHub sends a download to its asset host; the session checks the hop.
            var next = request
            next.url = URL(string: "https://release-assets.githubusercontent.com/stub/\(url.lastPathComponent)")
            let moved = HTTPURLResponse(url: url, statusCode: 302, httpVersion: "HTTP/1.1", headerFields: ["Location": next.url!.absoluteString])!
            client?.urlProtocol(self, wasRedirectedTo: next, redirectResponse: moved)
            return
        }
        if url.host == "release-assets.githubusercontent.com", let zip = SYStubFeed.zip()?.zip {
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Length": "\(zip.count)", "Content-Type": "application/zip"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            // In ten pieces, a quarter second apart, so "Downloading · %" is seen.
            let piece = max(1, zip.count / 10 + 1)
            func send(_ at: Int) {
                guard !stopped else { return }
                guard at < zip.count else { client?.urlProtocolDidFinishLoading(self); return }
                client?.urlProtocol(self, didLoad: zip.subdata(in: at..<min(zip.count, at + piece)))
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.25) { send(at + piece) }
            }
            return send(0)
        }
        answer(404, Data("not found".utf8), type: "text/plain")
    }

    override func stopLoading() { stopped = true }

    private func answer(_ status: Int, _ body: Data, type: String) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": type, "Content-Length": "\(body.count)"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
}
