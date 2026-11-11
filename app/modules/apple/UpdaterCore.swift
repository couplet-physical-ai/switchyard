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
    case buildMismatch(got: String, want: Int)
    case notNewer(build: Int, current: Int)
    case needsMacOS(version: String, minimum: String)
    case path(String)
    case unsigned(String)
    case quarantine
    case notInstalled
    case readOnly(String)
    case otherVolume
    case leftover(String)
    case move(String)
    /// The pin: this copy is signed with a certificate and the download is not signed with the
    /// same one. `got` is the download's leaf SHA-256 (or "ad hoc"), `want` this copy's.
    case otherSigner(got: String, want: String)

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
        case .buildMismatch(let got, let want): return "the download is build \(got), the feed \(want)"
        case .notNewer(let b, let current): return "build \(b) is not newer than this one (\(current))"
        case .needsMacOS(let v, let min): return "Switchyard \(v) needs macOS \(min) or later"
        case .path(let url): return "refused a download outside the Switchyard releases (\(url))"
        case .unsigned(let why): return "the signature does not hold (\(why))"
        case .quarantine: return "could not clear the quarantine flag"
        case .notInstalled: return "this copy is not in Applications, so it cannot update itself"
        case .readOnly: return "Update needs admin rights; run `brew upgrade --greedy --cask switchyard`"
        case .otherVolume: return "no staging folder on the app's volume"
        case .leftover(let path): return "\(path) is in the way"
        case .move(let why): return "could not swap the app: \(why)"
        case .otherSigner: return "update signed by a different certificate"
        }
    }
}

// MARK: - the feed

/// A newer build, as a feed names it.
struct SYRelease: Equatable {
    var version: String
    /// CFBundleVersion: M*1000000 + m*1000 + p. What "newer" means.
    var build: Int
    /// The ZIP.
    var url: URL
    /// Hex of the ZIP from latest.json; nil when the sum is a line of `sumsURL` (SHA256SUMS).
    var sha256: String?
    var sumsURL: URL?
    var notes: String
    var published: String
    var minimumSystemVersion: String?
    /// The pre-release channel: the release's own latest.json asset, read before anything else.
    var latestJSON: URL? = nil
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
    /// sy-ship's CFBundleVersion for a version: M*1000000 + m*1000 + p (0.1.1 → 1001).
    static func build(of version: String) -> Int? {
        guard let v = SYSemver.clean(version) else { return nil }
        let core = v.split(separator: "+")[0].split(separator: "-")[0].split(separator: ".").map { Int($0) ?? 0 }
        return (core.count > 0 ? core[0] : 0) * 1_000_000 + (core.count > 1 ? core[1] : 0) * 1_000 + (core.count > 2 ? core[2] : 0)
    }
    /// The release asset sy-ship publishes on every stable release (scripts/release/latest-json.py).
    static func latestJSON(repo: String) -> URL { URL(string: "https://github.com/\(repo)/releases/latest/download/latest.json")! }
    static func releasesAPI(repo: String) -> URL { URL(string: "https://api.github.com/repos/\(repo)/releases?per_page=20")! }
    static func latestSums(repo: String) -> URL { URL(string: "https://github.com/\(repo)/releases/latest/download/SHA256SUMS")! }

    /// sy-ship's latest.json: `{version, build, url, dmg, sha256, notes, published,
    /// minimumSystemVersion, bundleId, commit}`. Required: version, build, url, sha256, bundleId
    /// (== this app's). Unknown fields are ignored.
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
        guard let build = (json["build"] as? Int) ?? Int(json["build"] as? String ?? ""), build > 0 else {
            throw SYRefusal.feed("names no build")
        }
        let sha = (json["sha256"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard isHex64(sha) else { throw SYRefusal.feed("has no sha256 for the zip") }
        let id = json["bundleId"] as? String ?? ""
        guard id == bundleID else { throw SYRefusal.wrongApp(id) }
        return SYRelease(
            version: version, build: build, url: url, sha256: sha, sumsURL: nil,
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
            var zip: URL?, sums: URL?, feed: URL?
            for a in r["assets"] as? [[String: Any]] ?? [] {
                guard let name = a["name"] as? String, let u = (a["browser_download_url"] as? String).flatMap(URL.init(string:)) else { continue }
                if name == zipName(version) { zip = u } else if name == "SHA256SUMS" { sums = u } else if name == "latest.json" { feed = u }
            }
            guard let zip, sums != nil || feed != nil else { continue }
            if let b = best, SYSemver.compare(version, b.version) <= 0 { continue }
            best = SYRelease(version: version, build: build(of: version) ?? 0, url: zip, sha256: nil, sumsURL: sums,
                             notes: trimNotes(r["body"] as? String ?? ""), published: r["published_at"] as? String ?? "",
                             minimumSystemVersion: nil, latestJSON: feed, source: "api")
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
            return SYRelease(version: version, build: build(of: version) ?? 0, url: zip, sha256: hex, sumsURL: nil, notes: "", published: "",
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

/// The trust anchor (releases are signed ad hoc, so there is no Team ID to pin; a copy signed
/// with a certificate also pins its leaf, SYVerifier): an https feed,
/// a zip at https://github.com/<repo>/releases/…, and redirects only to GitHub's release CDN
/// (objects.githubusercontent.com, release-assets.githubusercontent.com), checked on every hop.
/// The one exception is the env-only test feed (SWITCHYARD_UPDATE_FEED) on a non-GitHub origin:
/// that origin may serve the feed and the zip, and it may be plain http only on 127.0.0.1.
struct SYHostPolicy {
    static let cdnHosts: Set<String> = ["objects.githubusercontent.com", "release-assets.githubusercontent.com"]
    static let assetHosts: Set<String> = cdnHosts.union(["github.com"])
    static let apiHost = "api.github.com"

    let repo: String
    /// A test feed's origin, when SWITCHYARD_UPDATE_FEED names one off GitHub.
    let testOrigin: URL?

    init(repo: String = SYFeed.defaultRepo, testFeed: URL? = nil) {
        self.repo = repo
        testOrigin = testFeed.flatMap { SYHostPolicy.assetHosts.contains($0.host?.lowercased() ?? "") || $0.host?.lowercased() == SYHostPolicy.apiHost ? nil : $0 }
    }

    /// SWITCHYARD_UPDATE_FEED: a latest.json URL, or a base URL that serves one. https
    /// anywhere, http only on 127.0.0.1; else nil.
    static func testFeedURL(_ raw: String?) -> URL? {
        guard let raw, !raw.isEmpty, let url = URL(string: raw), let host = url.host?.lowercased(), url.user == nil else { return nil }
        switch url.scheme?.lowercased() {
        case "https": break
        case "http": guard host == "127.0.0.1" else { return nil }
        default: return nil
        }
        return url.path.hasSuffix(".json") ? url : url.appendingPathComponent("latest.json")
    }

    private func isTestOrigin(_ url: URL) -> Bool {
        guard let t = testOrigin else { return false }
        return url.scheme?.lowercased() == t.scheme?.lowercased() && url.host?.lowercased() == t.host?.lowercased() && url.port == t.port
    }

    /// On github.com, under this repo's releases.
    private func inRepo(_ url: URL) -> Bool {
        url.host?.lowercased() == "github.com" && url.port == nil && !url.path.contains("..")
            && url.path.lowercased().hasPrefix("/\(repo.lowercased())/releases/")
    }

    private func refuse(_ url: URL, cdn: Bool, api: Bool) -> SYRefusal? {
        if isTestOrigin(url) { return nil }
        guard url.scheme?.lowercased() == "https" else { return .insecure(url.absoluteString) }
        let host = url.host?.lowercased() ?? ""
        if inRepo(url) { return nil }
        if cdn, SYHostPolicy.cdnHosts.contains(host) { return nil }
        if api, host == SYHostPolicy.apiHost, url.path.lowercased().hasPrefix("/repos/\(repo.lowercased())/") { return nil }
        return host == "github.com" || host == SYHostPolicy.apiHost ? .path(url.absoluteString) : .host(host.isEmpty ? url.absoluteString : host)
    }

    /// The feed: latest.json on this repo's releases, or the releases API.
    func refuseFeed(_ url: URL) -> SYRefusal? { refuse(url, cdn: false, api: true) }
    /// A zip, SHA256SUMS or a release's latest.json: only https://github.com/<repo>/releases/….
    func refuseAsset(_ url: URL) -> SYRefusal? { refuse(url, cdn: false, api: false) }
    /// A redirect hop: GitHub's release CDN, or within this repo's releases (latest → v…); the
    /// API request may also move within its repo on api.github.com.
    func refuseHop(_ url: URL, api: Bool) -> SYRefusal? { refuse(url, cdn: true, api: api) }
}

// MARK: - checking a download

/// The tools the checks run (ditto, codesign, xattr): a seam, so tests can watch them.
struct SYTools {
    var run: (_ tool: String, _ args: [String]) throws -> String
    static let live = SYTools { tool, args in try SYProcess.run(tool, args, deadline: 180) }
}

/// A bundle is not trusted because it arrived: its zip's SHA-256 is the feed's, it is this app,
/// it is the version and build the feed named, its build is newer than this one's, and its
/// signature holds under SecStaticCodeCheckValidity's strict checks (and `codesign --verify
/// --deep --strict`). No Team ID (the certificate is self-signed): instead the pin, last. A copy
/// signed with a certificate takes only a build whose leaf certificate is the same one (its DER's
/// SHA-256); an ad-hoc copy takes a build signed either way (the one-time ad hoc → certificate
/// step).
struct SYVerifier {
    let bundleID: String
    /// The running bundle's CFBundleVersion.
    let currentBuild: Int
    var tools: SYTools = .live
    /// The running app's signer: a seam, as `tools` is, so tests inject one. Updater.swift reads
    /// it once at launch.
    var runningSigner: () throws -> SYSigner = { try SYSign.running() }

    struct Verified { let app: URL; let cdhash: String; let signer: SYSigner; let running: SYSigner }

    /// Checks `zip` and unpacks it into `dir` (on the app's volume).
    func verify(zip: URL, sha256 want: String, version: String, build: Int, into dir: URL) throws -> Verified {
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
        let rawBuild = info["CFBundleVersion"] as? String ?? ""
        guard let b = Int(rawBuild), b == build else { throw SYRefusal.buildMismatch(got: rawBuild, want: build) }
        guard b > currentBuild else { throw SYRefusal.notNewer(build: b, current: currentBuild) }
        let (cdhash, signer) = try SYSign.check(app)
        do { _ = try tools.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path]) }
        catch { throw SYRefusal.unsigned((error as? LocalizedError)?.errorDescription ?? "codesign") }
        // URLSession downloads carry no quarantine flag; a zip copied by hand may. Harmless.
        _ = try? tools.run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", app.path])
        guard !SYDigest.quarantined(app) else { throw SYRefusal.quarantine }
        // The pin, after every other check.
        let running = try runningSigner()
        if case .cert(let mine) = running, signer != running {
            throw SYRefusal.otherSigner(got: signer.leaf ?? "\(signer)", want: mine)
        }
        return Verified(app: app, cdhash: cdhash, signer: signer, running: running)
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
        return hex(hasher.finalize())
    }

    static func hex<D: Sequence>(_ bytes: D) -> String where D.Element == UInt8 {
        bytes.map { String(format: "%02x", $0) }.joined()
    }

    static func quarantined(_ url: URL) -> Bool {
        getxattr(url.path, "com.apple.quarantine", nil, 0, 0, XATTR_NOFOLLOW) >= 0
    }
}

/// Who signed some code, as the pin sees it.
enum SYSigner: Equatable, CustomStringConvertible {
    /// No certificate: `kSecCodeInfoFlags` has `kSecCodeSignatureAdhoc`.
    case adhoc
    /// The SHA-256 of the leaf certificate's DER (`kSecCodeInfoCertificates[0]`), lower-case hex.
    case cert(String)

    var leaf: String? { if case .cert(let h) = self { return h }; return nil }
    var description: String { leaf.map { "leaf sha256 \($0)" } ?? "ad hoc" }
}

enum SYSign {
    /// SecStaticCodeCheckValidity with strict validation, every architecture and nested code;
    /// returns the cdhash (kSecCodeInfoUnique) for the log and the signer for the pin.
    static func check(_ bundle: URL) throws -> (cdhash: String, signer: SYSigner) {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(bundle as CFURL, [], &code) == errSecSuccess, let code else {
            throw SYRefusal.unsigned("no code at the bundle")
        }
        let strict = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode)
        let status = SecStaticCodeCheckValidity(code, strict, nil)
        guard status == errSecSuccess else { throw SYRefusal.unsigned("SecStaticCodeCheckValidity \(status)") }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let dict = info as? [String: Any], let unique = dict[kSecCodeInfoUnique as String] as? Data
        else { throw SYRefusal.unsigned("no cdhash") }
        return (SYDigest.hex(unique), try signer(dict))
    }

    /// This process's signer (SecCodeCopySelf). Throws when it cannot be read: a copy that cannot
    /// say who signed it takes no update.
    static func running() throws -> SYSigner {
        var me: SecCode?
        guard SecCodeCopySelf([], &me) == errSecSuccess, let me else { throw SYRefusal.unsigned("cannot read this app's own signature") }
        var code: SecStaticCode?
        guard SecCodeCopyStaticCode(me, [], &code) == errSecSuccess, let code else { throw SYRefusal.unsigned("cannot read this app's own signature") }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let dict = info as? [String: Any]
        else { throw SYRefusal.unsigned("cannot read this app's own signature") }
        return try signer(dict)
    }

    /// A certificate chain's leaf → `.cert`; none, with the ad-hoc flag → `.adhoc`. Anything else
    /// (no signature at all) is refused.
    static func signer(_ info: [String: Any]) throws -> SYSigner {
        if let chain = info[kSecCodeInfoCertificates as String] as? [AnyObject], let first = chain.first {
            guard CFGetTypeID(first) == SecCertificateGetTypeID() else { throw SYRefusal.unsigned("an unreadable certificate") }
            let der = SecCertificateCopyData(first as! SecCertificate) as Data
            return .cert(SYDigest.hex(SHA256.hash(data: der)))
        }
        let flags = (info[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0
        guard flags & SecCodeSignatureFlags.adhoc.rawValue != 0 else { throw SYRefusal.unsigned("neither a certificate nor ad hoc") }
        return .adhoc
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
    /// rename(2), not a move: across volumes it fails (EXDEV) where a move would copy. EACCES and
    /// EPERM (a folder or bundle owned by another account) are the admin-rights refusal.
    func rename(_ from: URL, _ to: URL) throws {
        guard Darwin.rename(from.path, to.path) == 0 else {
            let e = errno
            if e == EACCES || e == EPERM { throw SYRefusal.readOnly(from.deletingLastPathComponent().path) }
            throw SYRefusal.move("\(from.lastPathComponent) → \(to.lastPathComponent): \(String(cString: strerror(e)))")
        }
    }
    func remove(_ url: URL) throws { try FileManager.default.removeItem(at: url) }
    func exists(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path) }
    func writable(_ dir: URL) -> Bool { access(dir.path, W_OK) == 0 }
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
        try writable()
        guard let a = ops.volume(target.deletingLastPathComponent()), let b = ops.volume(staging), a == b else { throw SYRefusal.otherVolume }
    }

    /// The folder takes a rename, and so does the bundle (renaming a directory rewrites its
    /// `..`): a brew copy owned by another account fails here, before anything is touched.
    func writable() throws {
        let parent = target.deletingLastPathComponent()
        guard ops.writable(parent), ops.writable(target) else { throw SYRefusal.readOnly(parent.path) }
    }

    func swap(_ fresh: URL) throws {
        try writable()
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
/// its executable, signed ad hoc (or with `identity`), so `codesign --verify --deep --strict`
/// holds.
enum SYFixture {
    /// A code-signing identity in a keychain file (the unit tests' throwaway certificates).
    struct Identity { let sha1: String; let keychain: URL }

    static func bundle(in dir: URL, id: String, version: String, build: Int? = nil, name: String = "Switchyard.app", sign: Bool = true,
                       identity: Identity? = nil) throws -> URL {
        let app = dir.appendingPathComponent(name, isDirectory: true)
        let macos = app.appendingPathComponent("Contents/MacOS", isDirectory: true)
        try FileManager.default.createDirectory(at: macos, withIntermediateDirectories: true)
        let info: [String: Any] = [
            "CFBundleIdentifier": id, "CFBundleShortVersionString": version, "CFBundleVersion": "\(build ?? SYFeed.build(of: version) ?? 1)",
            "CFBundleExecutable": "Switchyard", "CFBundleName": "Switchyard", "CFBundlePackageType": "APPL",
            "CFBundleInfoDictionaryVersion": "6.0",
        ]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
            .write(to: app.appendingPathComponent("Contents/Info.plist"))
        let exe = macos.appendingPathComponent("Switchyard")
        try? FileManager.default.removeItem(at: exe)
        try FileManager.default.copyItem(at: URL(fileURLWithPath: "/usr/bin/true"), to: exe)
        if sign {
            let who = identity.map { ["--sign", $0.sha1, "--keychain", $0.keychain.path] } ?? ["--sign", "-"]
            try SYProcess.run("/usr/bin/codesign", ["--force"] + who + [app.path], deadline: 60)
        }
        return app
    }

    /// The bundle, zipped the way a release is (`ditto -c -k --sequesterRsrc --keepParent`).
    static func zip(in dir: URL, id: String, version: String, build: Int? = nil, sign: Bool = true, identity: Identity? = nil) throws -> URL {
        let src = dir.appendingPathComponent("src", isDirectory: true)
        try FileManager.default.createDirectory(at: src, withIntermediateDirectories: true)
        let app = try bundle(in: src, id: id, version: version, build: build, sign: sign, identity: identity)
        let zip = dir.appendingPathComponent(SYFeed.zipName(version))
        try? FileManager.default.removeItem(at: zip)
        try SYProcess.run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app.path, zip.path], deadline: 60)
        return zip
    }
}
