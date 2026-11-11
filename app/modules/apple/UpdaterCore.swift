// The updater's logic with no Exact in it (README "Updates"): versions, the feed, which hosts
// may serve it, the checks a downloaded build must pass, and the swap. Updater.swift drives it;
// tools/updater-tests.sh compiles this file with UpdaterTests.swift into a CLI and runs it.
//
// Copper's updater (Search/Updater.swift) is the model: one small JSON file next to the
// download, a ZIP that is fetched, checked and put where this bundle is with two renames on
// the same volume, nothing that relaunches on its own, and a sweep at the next launch that
// removes only what the updater made.

import CryptoKit
import Foundation
import Security

// MARK: - versions

/// Numeric semver: `v1.2.3`, `1.2.3-rc.1`; a pre-release sorts below its release.
enum SYSemver {
    /// The version a tag names, without its `v`; nil for anything that is not one.
    static func clean(_ tag: String) -> String? {
        var t = tag.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("v") || t.hasPrefix("V") { t.removeFirst() }
        guard t.range(of: #"^\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$"#, options: .regularExpression) != nil else { return nil }
        return t
    }

    /// -1, 0 or 1. Build metadata (`+…`) is ignored, as semver says.
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

    /// Strictly newer, and both are versions.
    static func isNewer(_ a: String, than b: String) -> Bool {
        guard clean(a) != nil, clean(b) != nil else { return false }
        return compare(a, b) > 0
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

// MARK: - refusals

/// Why an update was not taken. `description` is what the pill says after "Update failed: ".
enum SYRefusal: Error, Equatable, LocalizedError {
    case feed(String)
    case insecure(String)
    case host(String)
    case download(String)
    case hash(got: String, want: String)
    case archive(String)
    case plist
    case wrongApp(String)
    case versionMismatch(got: String, want: String)
    case notNewer(String, current: String)
    case unsigned(String)
    case wrongTeam
    case quarantine
    case notInstalled
    case readOnly(String)
    case otherVolume
    case leftover(String)
    case move(String)

    var errorDescription: String? {
        switch self {
        case .feed(let why): return "the feed \(why)"
        case .insecure(let url): return "refused a non-https address (\(url))"
        case .host(let host): return "refused a download from \(host), not GitHub"
        case .download(let why): return "download failed: \(why)"
        case .hash: return "checksum mismatch"
        case .archive(let why): return "the zip \(why)"
        case .plist: return "the downloaded app has no readable Info.plist"
        case .wrongApp(let id): return "the download is \(id.isEmpty ? "not an app" : id), not Switchyard"
        case .versionMismatch(let got, let want): return "the download says \(got), the feed \(want)"
        case .notNewer(let v, let current): return "\(v) is not newer than \(current)"
        case .unsigned(let why): return "the signature does not hold (\(why))"
        case .wrongTeam: return "signed by another team"
        case .quarantine: return "could not clear the quarantine flag"
        case .notInstalled: return "this copy is not in Applications, so it cannot update itself"
        case .readOnly(let dir): return "\(dir) is not writable"
        case .otherVolume: return "no staging folder on the app's volume"
        case .leftover(let path): return "\(path) is in the way"
        case .move(let why): return "could not swap the app: \(why)"
        }
    }
}

// MARK: - the feed

/// A newer build, as a feed names it.
struct SYRelease: Equatable {
    var version: String
    /// The ZIP.
    var url: URL
    /// Hex of the ZIP from latest.json; nil when the sum is a line of `sumsURL` (SHA256SUMS).
    var sha256: String?
    var sumsURL: URL?
    var notes: String
    var published: String
    var minimumSystemVersion: String?
    /// "latest.json", "api" or "sums", for the log.
    var source: String

    /// A release that wants a newer macOS than this one is not offered (Copper's `runsHere`).
    var runsHere: Bool {
        guard let need = minimumSystemVersion, !need.isEmpty else { return true }
        let p = need.split(separator: ".").map { Int($0) ?? 0 }
        return ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(
            majorVersion: p.count > 0 ? p[0] : 0, minorVersion: p.count > 1 ? p[1] : 0, patchVersion: p.count > 2 ? p[2] : 0))
    }
}

enum SYFeed {
    static let defaultRepo = "couplet-physical-ai/switchyard"

    static func zipName(_ version: String) -> String { "Switchyard-\(version)-arm64.zip" }
    /// The release asset sy-ship publishes on every stable release (scripts/release/latest-json.py).
    static func latestJSON(repo: String) -> URL { URL(string: "https://github.com/\(repo)/releases/latest/download/latest.json")! }
    static func releasesAPI(repo: String) -> URL { URL(string: "https://api.github.com/repos/\(repo)/releases?per_page=20")! }
    static func latestSums(repo: String) -> URL { URL(string: "https://github.com/\(repo)/releases/latest/download/SHA256SUMS")! }

    /// `{"version","url","sha256","notes","published"}` (plus, ignored or checked when there:
    /// `build`, `dmg`, `minimumSystemVersion`, `bundleId`, `commit`).
    static func parseLatest(_ data: Data, bundleID: String) throws -> SYRelease {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SYRefusal.feed("answered something that is not JSON")
        }
        guard let raw = json["version"] as? String, let version = SYSemver.clean(raw) else {
            throw SYRefusal.feed("names no version")
        }
        guard let link = json["url"] as? String, let url = URL(string: link), url.host != nil else {
            throw SYRefusal.feed("names no zip")
        }
        let sha = (json["sha256"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard isHex64(sha) else { throw SYRefusal.feed("has no sha256 for the zip") }
        if let id = json["bundleId"] as? String, !id.isEmpty, id != bundleID {
            throw SYRefusal.wrongApp(id)
        }
        return SYRelease(
            version: version, url: url, sha256: sha, sumsURL: nil,
            notes: trimNotes(json["notes"] as? String ?? ""), published: json["published"] as? String ?? "",
            minimumSystemVersion: json["minimumSystemVersion"] as? String, source: "latest.json")
    }

    /// GitHub's releases list: the highest version among non-draft releases (pre-releases only on
    /// that channel) that carry `Switchyard-<v>-arm64.zip` and `SHA256SUMS`.
    static func pickFromAPI(_ data: Data, prerelease: Bool) throws -> SYRelease? {
        guard let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            throw SYRefusal.feed("(the releases API) answered something unreadable")
        }
        var best: SYRelease?
        for r in list {
            if r["draft"] as? Bool == true { continue }
            if r["prerelease"] as? Bool == true && !prerelease { continue }
            guard let tag = r["tag_name"] as? String, let version = SYSemver.clean(tag) else { continue }
            var zip: URL?, sums: URL?
            for a in r["assets"] as? [[String: Any]] ?? [] {
                guard let name = a["name"] as? String, let u = (a["browser_download_url"] as? String).flatMap(URL.init(string:)) else { continue }
                if name == zipName(version) { zip = u } else if name == "SHA256SUMS" { sums = u }
            }
            guard let zip, let sums else { continue }
            if let b = best, SYSemver.compare(version, b.version) <= 0 { continue }
            best = SYRelease(version: version, url: zip, sha256: nil, sumsURL: sums,
                             notes: trimNotes(r["body"] as? String ?? ""), published: r["published_at"] as? String ?? "",
                             minimumSystemVersion: nil, source: "api")
        }
        return best
    }

    /// `releases/latest/download/SHA256SUMS` names the latest stable zip, and so its version
    /// (the fallback when the API is rate limited).
    static func fromLatestSums(_ text: String, repo: String) -> SYRelease? {
        for (hex, name) in parseSums(text) {
            guard name.hasPrefix("Switchyard-"), name.hasSuffix("-arm64.zip") else { continue }
            let version = String(name.dropFirst("Switchyard-".count).dropLast("-arm64.zip".count))
            guard SYSemver.clean(version) == version,
                  let zip = URL(string: "https://github.com/\(repo)/releases/download/v\(version)/\(name)") else { continue }
            return SYRelease(version: version, url: zip, sha256: hex, sumsURL: nil, notes: "", published: "",
                             minimumSystemVersion: nil, source: "sums")
        }
        return nil
    }

    /// `shasum -a 256` lines: `<hex>  <file>` (a `*` before the name in binary mode).
    static func parseSums(_ text: String) -> [(String, String)] {
        text.split(whereSeparator: \.isNewline).compactMap { line in
            let parts = line.split(maxSplits: 1, whereSeparator: { $0 == " " || $0 == "\t" })
            guard parts.count == 2 else { return nil }
            let hex = parts[0].lowercased()
            var name = parts[1].trimmingCharacters(in: .whitespaces)
            if name.hasPrefix("*") { name.removeFirst() }
            guard isHex64(hex) else { return nil }
            return (hex, name)
        }
    }

    /// The line of SHA256SUMS for `name`, or nil.
    static func sum(in text: String, for name: String) -> String? {
        parseSums(text).first(where: { $0.1 == name })?.0
    }

    static func isHex64(_ s: String) -> Bool {
        s.count == 64 && s.allSatisfy { $0.isHexDigit && !$0.isUppercase }
    }

    static func trimNotes(_ body: String) -> String {
        let t = body.replacingOccurrences(of: "\r\n", with: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.count > 1500 else { return t }
        let cut = t.prefix(1500)
        let end = cut.lastIndex(of: "\n") ?? cut.lastIndex(of: " ") ?? cut.endIndex
        return String(cut[..<end]).trimmingCharacters(in: .whitespacesAndNewlines) + " …"
    }
}

// MARK: - which hosts may answer

/// The feed must be https; a zip, and every redirect on the way to it, must come from GitHub.
/// The one exception is the env-only test feed (SWITCHYARD_UPDATE_FEED): its own origin may serve
/// the feed and the zip, and it may be plain http only on 127.0.0.1.
struct SYHostPolicy {
    static let assetHosts: Set<String> = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]
    static let apiHost = "api.github.com"

    /// The test feed's base, when SWITCHYARD_UPDATE_FEED names an acceptable one.
    let testOrigin: URL?

    init(testFeed: URL? = nil) { testOrigin = testFeed }

    /// SWITCHYARD_UPDATE_FEED as a base URL: https anywhere, http only on 127.0.0.1; else nil.
    static func testFeedBase(_ raw: String?) -> URL? {
        guard let raw, !raw.isEmpty, let url = URL(string: raw), let host = url.host?.lowercased(), url.user == nil else { return nil }
        switch url.scheme?.lowercased() {
        case "https": return url
        case "http": return host == "127.0.0.1" ? url : nil
        default: return nil
        }
    }

    private func isTestOrigin(_ url: URL) -> Bool {
        guard let t = testOrigin else { return false }
        return url.scheme?.lowercased() == t.scheme?.lowercased() && url.host?.lowercased() == t.host?.lowercased() && url.port == t.port
    }

    /// Why `url` may not serve the feed (latest.json, the releases API, SHA256SUMS), or nil.
    func refuseFeed(_ url: URL) -> SYRefusal? {
        if isTestOrigin(url) { return nil }
        guard url.scheme?.lowercased() == "https" else { return .insecure(url.absoluteString) }
        let host = url.host?.lowercased() ?? ""
        return SYHostPolicy.assetHosts.contains(host) || host == SYHostPolicy.apiHost ? nil : .host(host)
    }

    /// Why `url` may not serve the zip, or be a hop of a redirect, or nil.
    func refuseAsset(_ url: URL) -> SYRefusal? {
        if isTestOrigin(url) { return nil }
        guard url.scheme?.lowercased() == "https" else { return .insecure(url.absoluteString) }
        let host = url.host?.lowercased() ?? ""
        return SYHostPolicy.assetHosts.contains(host) ? nil : .host(host.isEmpty ? url.absoluteString : host)
    }

    /// A redirect hop: GitHub sends downloads to objects/release-assets.githubusercontent.com.
    /// The API may move within api.github.com.
    func refuseHop(_ url: URL, api: Bool) -> SYRefusal? {
        if api, url.scheme?.lowercased() == "https", url.host?.lowercased() == SYHostPolicy.apiHost { return nil }
        return refuseAsset(url)
    }
}

// MARK: - checking a download

/// The tools the checks run (ditto, codesign, xattr): a seam, so tests can watch them.
struct SYTools {
    var run: (_ tool: String, _ args: [String]) throws -> String
    static let live = SYTools { tool, args in try SYProcess.run(tool, args, deadline: 180) }
}

/// A bundle is not trusted because it arrived: it is trusted because its zip's SHA-256 is the
/// feed's, it is this app, it is the version the feed named and newer than this one, its
/// signature holds under the strict check, and it carries no quarantine flag.
struct SYVerifier {
    let bundleID: String
    let current: String
    var tools: SYTools = .live
    /// The running copy's Team ID: nil for an ad-hoc signature (Switchyard's releases have no
    /// Developer ID). When there is one, the new bundle must carry the same.
    var team: String? = nil

    /// Checks `zip` and unpacks it into `dir` (on the app's volume); returns the new bundle.
    func verify(zip: URL, sha256 want: String, version: String, into dir: URL) throws -> URL {
        let got = try SYDigest.sha256(of: zip)
        guard got == want.lowercased() else { throw SYRefusal.hash(got: got, want: want) }
        let out = dir.appendingPathComponent("unzipped", isDirectory: true)
        try? FileManager.default.removeItem(at: out)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        do { _ = try tools.run("/usr/bin/ditto", ["-x", "-k", zip.path, out.path]) }
        catch { throw SYRefusal.archive("does not unpack") }
        let apps = (try? FileManager.default.contentsOfDirectory(at: out, includingPropertiesForKeys: nil))?.filter { $0.pathExtension == "app" } ?? []
        guard apps.count == 1, let app = apps.first else { throw SYRefusal.archive("holds \(apps.count) apps, not one") }
        guard let data = try? Data(contentsOf: app.appendingPathComponent("Contents/Info.plist")),
              let info = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else { throw SYRefusal.plist }
        let id = info["CFBundleIdentifier"] as? String ?? ""
        guard id == bundleID else { throw SYRefusal.wrongApp(id) }
        let ver = info["CFBundleShortVersionString"] as? String ?? ""
        guard ver == version else { throw SYRefusal.versionMismatch(got: ver, want: version) }
        guard SYSemver.isNewer(ver, than: current) else { throw SYRefusal.notNewer(ver, current: current) }
        do { _ = try tools.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path]) }
        catch { throw SYRefusal.unsigned((error as? LocalizedError)?.errorDescription ?? "codesign") }
        if let team, SYSign.team(of: app) != team { throw SYRefusal.wrongTeam }
        // Nothing this process downloads should carry the flag (Copper declares no
        // LSFileQuarantineEnabled); a test feed's zip or a copy made by hand may. Clear it, and
        // check it is gone: the checking is done here, not by Gatekeeper at the next launch.
        _ = try? tools.run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", app.path])
        guard !SYDigest.quarantined(app) else { throw SYRefusal.quarantine }
        return app
    }
}

enum SYDigest {
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

    static func quarantined(_ url: URL) -> Bool {
        getxattr(url.path, "com.apple.quarantine", nil, 0, 0, XATTR_NOFOLLOW) >= 0
    }
}

enum SYSign {
    /// The team that signed a bundle, as the system reads it: nil for an ad-hoc signature.
    static func team(of bundle: URL) -> String? {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(bundle as CFURL, [], &code) == errSecSuccess, let code else { return nil }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let signing = info as? [String: Any] else { return nil }
        return signing[kSecCodeInfoTeamIdentifier as String] as? String
    }
}

// MARK: - the swap

/// What the swap does to the disk: a seam, so a test can make the second rename fail.
protocol SYFileOps {
    func rename(_ from: URL, _ to: URL) throws
    func remove(_ url: URL) throws
    func exists(_ url: URL) -> Bool
    func writable(_ dir: URL) -> Bool
    func volume(_ url: URL) -> String?
}

struct SYLocalFileOps: SYFileOps {
    /// rename(2), not a move: across volumes it fails (EXDEV) where a move would copy.
    func rename(_ from: URL, _ to: URL) throws {
        guard Darwin.rename(from.path, to.path) == 0 else {
            throw SYRefusal.move("\(from.lastPathComponent) → \(to.lastPathComponent): \(String(cString: strerror(errno)))")
        }
    }
    func remove(_ url: URL) throws { try FileManager.default.removeItem(at: url) }
    func exists(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path) }
    func writable(_ dir: URL) -> Bool { FileManager.default.isWritableFile(atPath: dir.path) }
    func volume(_ url: URL) -> String? {
        guard let v = try? url.resourceValues(forKeys: [.volumeIdentifierKey]).volumeIdentifier else { return nil }
        return "\(v)"
    }
}

/// Copper's `Swap`: the running bundle is renamed to a sibling, the staged one renamed into its
/// place, and the first rename undone if the second fails. The process that is running keeps
/// its files (the kernel follows the rename) until it quits; the next launch sweeps the aside.
struct SYSwap {
    let target: URL
    let bundleID: String
    var ops: SYFileOps = SYLocalFileOps()

    /// The bundle set aside during a swap: a sibling, so the move is a rename on one volume.
    var aside: URL { target.deletingLastPathComponent().appendingPathComponent(target.lastPathComponent + ".old") }

    /// Copper's checks before anything is fetched: the folder takes a rename, and the staging
    /// folder is on the app's volume (so the last move is a rename too).
    func preflight(staging: URL) throws {
        let parent = target.deletingLastPathComponent()
        guard ops.writable(parent) else { throw SYRefusal.readOnly(parent.path) }
        guard let a = ops.volume(parent), let b = ops.volume(staging), a == b else { throw SYRefusal.otherVolume }
    }

    func swap(_ fresh: URL) throws {
        _ = sweep(staging: [])
        guard !ops.exists(aside) else { throw SYRefusal.leftover(aside.lastPathComponent) }
        guard ops.exists(fresh) else { throw SYRefusal.move("the staged app is gone") }
        try ops.rename(target, aside)
        do {
            try ops.rename(fresh, target)
        } catch {
            try? ops.rename(aside, target)
            throw (error as? SYRefusal) ?? SYRefusal.move(error.localizedDescription)
        }
    }

    /// Removes what an earlier run left: the aside bundle (only when it is this app) and the
    /// staging folders it names (the downloads are inside them). Returns what went.
    func sweep(staging: [URL]) -> [String] {
        var gone: [String] = []
        if ops.exists(aside),
           let data = try? Data(contentsOf: aside.appendingPathComponent("Contents/Info.plist")),
           let info = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
           info["CFBundleIdentifier"] as? String == bundleID,
           (try? ops.remove(aside)) != nil {
            gone.append(aside.path)
        }
        for dir in staging where ops.exists(dir) {
            if (try? ops.remove(dir)) != nil { gone.append(dir.path) }
        }
        return gone
    }
}

// MARK: - a child process with a deadline

enum SYProcess {
    /// Past the deadline the child is terminated, then killed. Throws on a nonzero exit.
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
        let name = (tool as NSString).lastPathComponent
        if exited.wait(timeout: .now() + deadline) == .timedOut {
            p.terminate()
            if exited.wait(timeout: .now() + 3) == .timedOut { kill(p.processIdentifier, SIGKILL); _ = exited.wait(timeout: .now() + 3) }
            throw SYToolFailure(message: "\(name) took longer than \(Int(deadline)) s")
        }
        _ = readDone.wait(timeout: .now() + 5)
        let text = String(decoding: output, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard p.terminationStatus == 0 else {
            throw SYToolFailure(message: "\(name) failed (\(p.terminationStatus))\(text.isEmpty ? "" : ": \(text.prefix(300))")")
        }
        return text
    }
}

struct SYToolFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

// MARK: - a minimal bundle, for the agent's stub feed and the unit tests

/// `<dir>/Switchyard.app`: an Info.plist with `id` and `version`, a copy of /usr/bin/true as
/// its executable, signed ad hoc, so `codesign --verify --deep --strict` holds.
enum SYFixture {
    static func bundle(in dir: URL, id: String, version: String, name: String = "Switchyard.app", sign: Bool = true) throws -> URL {
        let app = dir.appendingPathComponent(name, isDirectory: true)
        let macos = app.appendingPathComponent("Contents/MacOS", isDirectory: true)
        try FileManager.default.createDirectory(at: macos, withIntermediateDirectories: true)
        let info: [String: Any] = [
            "CFBundleIdentifier": id, "CFBundleShortVersionString": version, "CFBundleVersion": "1",
            "CFBundleExecutable": "Switchyard", "CFBundleName": "Switchyard", "CFBundlePackageType": "APPL",
            "CFBundleInfoDictionaryVersion": "6.0",
        ]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
            .write(to: app.appendingPathComponent("Contents/Info.plist"))
        let exe = macos.appendingPathComponent("Switchyard")
        try? FileManager.default.removeItem(at: exe)
        try FileManager.default.copyItem(at: URL(fileURLWithPath: "/usr/bin/true"), to: exe)
        if sign { try SYProcess.run("/usr/bin/codesign", ["--force", "--sign", "-", app.path], deadline: 60) }
        return app
    }

    /// The bundle, zipped the way a release is (`ditto -c -k --keepParent`).
    static func zip(in dir: URL, id: String, version: String, sign: Bool = true) throws -> URL {
        let src = dir.appendingPathComponent("src", isDirectory: true)
        try FileManager.default.createDirectory(at: src, withIntermediateDirectories: true)
        let app = try bundle(in: src, id: id, version: version, sign: sign)
        let zip = dir.appendingPathComponent(SYFeed.zipName(version))
        try? FileManager.default.removeItem(at: zip)
        try SYProcess.run("/usr/bin/ditto", ["-c", "-k", "--keepParent", app.path, zip.path], deadline: 60)
        return zip
    }
}
