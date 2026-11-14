// Native unit tests of the updater's logic (UpdaterCore.swift). The app's build compiles every
// Swift file in modules/apple, so all of this is behind SWITCHYARD_UPDATER_TESTS:
// tools/updater-tests.sh compiles UpdaterCore.swift + this file with `-D SWITCHYARD_UPDATER_TESTS`
// into a CLI on a Mac and runs it; it exits nonzero when a case fails.

#if SWITCHYARD_UPDATER_TESTS
import CryptoKit
import Foundation

enum SYUpdaterTests {
    static var failures = 0
    static var passes = 0
    static let id = "com.exowatt.switchyard"

    static func check(_ ok: Bool, _ what: String, _ detail: @autoclosure () -> String = "") {
        if ok { passes += 1; print("  ok    \(what)") } else { failures += 1; print("  FAIL  \(what)\(detail().isEmpty ? "" : ": \(detail())")") }
    }

    static func refusal(_ body: () throws -> Void) -> SYRefusal? {
        do { try body(); return nil } catch let r as SYRefusal { return r } catch { return .move("unexpected \(error)") }
    }

    static func version(of app: URL) -> String {
        (NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")) as? [String: Any])?["CFBundleShortVersionString"] as? String ?? ""
    }

    static func inode(_ url: URL) -> UInt64 {
        ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.systemFileNumber] as? NSNumber)?.uint64Value ?? 0
    }

    static func scratch(_ name: String) -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("sy-updater-tests-\(getpid())/\(name)", isDirectory: true)
        try? FileManager.default.removeItem(at: dir)
        try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func run() -> Int32 {
        // The pin's real-process case: a copy of this CLI, signed with a throwaway certificate,
        // prints what SYSign.running() reads of itself.
        if CommandLine.arguments.contains("--print-running-signer") {
            do { print(try SYSign.running()); return 0 } catch { print("error: \(error)"); return 1 }
        }
        let started = Date()
        print("== versions"); versions()
        print("== latest.json"); latestJSON()
        print("== SHA256SUMS and the releases API"); sumsAndAPI()
        print("== hosts"); hosts()
        print("== the verify chain"); verifyChain()
        print("== the signer pin (throwaway certificates in a temp keychain)"); pinCases()
        print("== the swap"); swapCases()
        print("== the test hooks (HooksCore.swift)"); hooks()
        try? FileManager.default.removeItem(at: FileManager.default.temporaryDirectory.appendingPathComponent("sy-updater-tests-\(getpid())"))
        print(String(format: "%d passed, %d failed (%.1f s)", passes, failures, Date().timeIntervalSince(started)))
        return failures == 0 ? 0 : 1
    }

    // MARK: versions

    static func versions() {
        let less: [(String, String)] = [
            ("0.0.2", "0.0.3"), ("0.1.9", "0.1.10"), ("0.9.0", "1.0.0"), ("1.0.0-rc.1", "1.0.0"),
            ("1.0.0-alpha", "1.0.0-alpha.1"), ("1.0.0-alpha.1", "1.0.0-beta"), ("1.0.0-beta", "1.0.0-rc.1"),
            ("1.0.0-rc.2", "1.0.0-rc.10"), ("1.0.0-1", "1.0.0-alpha"), ("v0.1.0", "0.1.1"), ("0.1.1-rc.1", "v0.1.1"),
        ]
        for (a, b) in less {
            check(SYSemver.compare(a, b) == -1 && SYSemver.compare(b, a) == 1, "\(a) < \(b)")
        }
        check(SYSemver.compare("v0.1.1", "0.1.1") == 0, "v0.1.1 == 0.1.1 (the v prefix)")
        check(SYSemver.compare("0.1", "0.1.0") == 0, "0.1 == 0.1.0")
        check(SYSemver.compare("1.0.0+abc", "1.0.0") == 0, "build metadata is ignored")
        check(SYSemver.clean("v0.1.1") == "0.1.1" && SYSemver.clean("V2.0.0-rc.1") == "2.0.0-rc.1", "clean strips the v")
        check(SYSemver.clean("latest") == nil && SYSemver.clean("1.2.3.4") == nil && SYSemver.clean("") == nil, "clean refuses non-versions")
        check(SYSemver.isNewer("0.1.1", than: "0.1.0") && !SYSemver.isNewer("0.1.0", than: "0.1.0") && !SYSemver.isNewer("0.1.1-rc.1", than: "0.1.1"),
              "isNewer is strict, and a pre-release is older than its release")
        check(!SYSemver.isNewer("garbage", than: "0.0.1"), "isNewer refuses a non-version")
    }

    // MARK: latest.json

    static func latestJSON() {
        let sha = "4f2c" + String(repeating: "a", count: 60)
        let good = """
        {"version":"0.1.1","build":1001,"url":"https://github.com/couplet-physical-ai/switchyard/releases/download/v0.1.1/Switchyard-0.1.1-arm64.zip","dmg":"https://github.com/couplet-physical-ai/switchyard/releases/download/v0.1.1/Switchyard-0.1.1-arm64.dmg","sha256":"\(sha)","notes":"- faster yard","published":"2026-11-10T23:59:00Z","minimumSystemVersion":"14.0","bundleId":"com.exowatt.switchyard","commit":"482f675b9a3a868c8dab3b39bafb538221c1afbf","future":{"x":1}}
        """
        do {
            let r = try SYFeed.parseLatest(Data(good.utf8), bundleID: id)
            check(r.version == "0.1.1" && r.build == 1001 && r.minimumSystemVersion == "14.0" && r.sha256 == sha && r.url.lastPathComponent == "Switchyard-0.1.1-arm64.zip"
                  && r.notes == "- faster yard" && r.published == "2026-11-10T23:59:00Z" && r.source == "latest.json", "sy-ship's latest.json parses (unknown fields ignored)")
        } catch { check(false, "the schema parses", "\(error)") }
        let extra = """
        {"version":"v0.1.2","build":"1002","url":"https://github.com/x/y/releases/download/v0.1.2/Switchyard-0.1.2-arm64.zip","dmg":"https://github.com/x/y/z.dmg","sha256":"\(sha.uppercased())","notes":"","published":"","minimumSystemVersion":"14.0","bundleId":"\(id)","commit":"abc"}
        """
        let r2 = try? SYFeed.parseLatest(Data(extra.utf8), bundleID: id)
        check(r2?.version == "0.1.2" && r2?.build == 1002 && r2?.sha256 == sha, "a v prefix, a string build and upper-case hex are normalised")
        let noSha = #"{"build":1001,"bundleId":"com.exowatt.switchyard","version":"0.1.1","url":"https://github.com/a/b/c.zip","notes":""}"#
        check(refusal { _ = try SYFeed.parseLatest(Data(noSha.utf8), bundleID: id) } == .feed("has no sha256 for the zip"), "no sha256 → refused")
        let shortSha = #"{"build":1001,"bundleId":"com.exowatt.switchyard","version":"0.1.1","url":"https://github.com/a/b/c.zip","sha256":"abc"}"#
        check(refusal { _ = try SYFeed.parseLatest(Data(shortSha.utf8), bundleID: id) } == .feed("has no sha256 for the zip"), "a short sha256 → refused")
        let noVersion = #"{"build":1001,"bundleId":"com.exowatt.switchyard","version":"latest","url":"https://github.com/a/b/c.zip","sha256":"\#(sha)"}"#
        check(refusal { _ = try SYFeed.parseLatest(Data(noVersion.utf8), bundleID: id) } == .feed("names no version"), "a non-version → refused")
        let other = #"{"version":"0.1.1","build":1001,"url":"https://github.com/a/b/c.zip","sha256":"\#(sha)","bundleId":"com.example.other"}"#
        check(refusal { _ = try SYFeed.parseLatest(Data(other.utf8), bundleID: id) } == .wrongApp("com.example.other"), "another app's bundleId → refused")
        let noBuild = #"{"version":"0.1.1","url":"https://github.com/a/b/c.zip","sha256":"\#(sha)","bundleId":"com.exowatt.switchyard"}"#
        check(refusal { _ = try SYFeed.parseLatest(Data(noBuild.utf8), bundleID: id) } == .feed("names no build"), "no build → refused")
        let noId = #"{"version":"0.1.1","build":1001,"url":"https://github.com/a/b/c.zip","sha256":"\#(sha)"}"#
        check(refusal { _ = try SYFeed.parseLatest(Data(noId.utf8), bundleID: id) } == .wrongApp(""), "no bundleId → refused")
        check(SYFeed.build(of: "0.1.0") == 1000 && SYFeed.build(of: "0.1.1") == 1001 && SYFeed.build(of: "v1.2.3") == 1_002_003 && SYFeed.build(of: "0.0.4") == 4,
              "build = M*1000000 + m*1000 + p")
        check(refusal { _ = try SYFeed.parseLatest(Data("<html>".utf8), bundleID: id) } == .feed("answered something that is not JSON"), "HTML → refused")
    }

    // MARK: SHA256SUMS and the API

    static func sumsAndAPI() {
        let a = String(repeating: "a", count: 64), b = String(repeating: "b", count: 64)
        let text = "\(a)  Switchyard-0.1.1-arm64.zip\n\(b) *Switchyard-0.1.1-arm64.dmg\nnot a line\nabc  short.zip\n"
        let sums = SYFeed.parseSums(text)
        check(sums.count == 2 && SYFeed.sum(in: text, for: "Switchyard-0.1.1-arm64.zip") == a && SYFeed.sum(in: text, for: "Switchyard-0.1.1-arm64.dmg") == b,
              "SHA256SUMS lines parse (text and binary mode), bad lines skipped")
        check(SYFeed.sum(in: text, for: "Switchyard-0.1.2-arm64.zip") == nil, "no line for another zip")
        let latest = SYFeed.fromLatestSums(text, repo: "couplet-physical-ai/switchyard")
        check(latest?.version == "0.1.1" && latest?.sha256 == a && latest?.url.absoluteString == "https://github.com/couplet-physical-ai/switchyard/releases/download/v0.1.1/Switchyard-0.1.1-arm64.zip",
              "releases/latest SHA256SUMS names the zip and its sum")
        func rel(_ tag: String, pre: Bool = false, draft: Bool = false, sums: Bool = true) -> [String: Any] {
            let v = SYSemver.clean(tag) ?? tag
            var assets: [[String: Any]] = [["name": "Switchyard-\(v)-arm64.zip", "browser_download_url": "https://github.com/o/r/releases/download/\(tag)/Switchyard-\(v)-arm64.zip"]]
            if sums { assets.append(["name": "SHA256SUMS", "browser_download_url": "https://github.com/o/r/releases/download/\(tag)/SHA256SUMS"]) }
            return ["tag_name": tag, "prerelease": pre, "draft": draft, "assets": assets, "body": "notes \(tag)"]
        }
        let list = [rel("v0.1.0"), rel("v0.3.0", draft: true), rel("v0.2.0-rc.1", pre: true), rel("v0.1.5", sums: false), rel("v0.1.2")]
        let data = try! JSONSerialization.data(withJSONObject: list)
        check((try? SYFeed.pickFromAPI(data, prerelease: false))??.version == "0.1.2", "the API path: the highest stable release with a zip and SHA256SUMS (drafts, pre-releases, no-SUMS skipped)")
        check((try? SYFeed.pickFromAPI(data, prerelease: true))??.version == "0.2.0-rc.1", "the pre-release channel takes the rc")
        check((try? SYFeed.pickFromAPI(data, prerelease: true))??.sumsURL?.lastPathComponent == "SHA256SUMS", "an API release's sum comes from its SHA256SUMS")
        var withFeed = rel("v0.0.4", pre: true)
        withFeed["assets"] = (withFeed["assets"] as! [[String: Any]]) + [["name": "latest.json", "browser_download_url": "https://github.com/o/r/releases/download/v0.0.4/latest.json"]]
        let d2 = try! JSONSerialization.data(withJSONObject: [withFeed, rel("v0.0.3", pre: true)])
        let p4 = (try? SYFeed.pickFromAPI(d2, prerelease: true)) ?? nil
        check(p4?.version == "0.0.4" && p4?.build == 4 && p4?.latestJSON?.lastPathComponent == "latest.json", "the pre-release channel reads the newest pre-release's own latest.json")
    }

    // MARK: hosts

    static func hosts() {
        let p = SYHostPolicy(repo: "couplet-physical-ai/switchyard")
        let zip = "https://github.com/couplet-physical-ai/switchyard/releases/download/v0.1.1/Switchyard-0.1.1-arm64.zip"
        check(p.refuseAsset(URL(string: zip)!) == nil, "allowed zip: https://github.com/couplet-physical-ai/switchyard/releases/…")
        check(p.refuseFeed(URL(string: "https://github.com/couplet-physical-ai/switchyard/releases/latest/download/latest.json")!) == nil
              && p.refuseFeed(URL(string: "https://api.github.com/repos/couplet-physical-ai/switchyard/releases?per_page=20")!) == nil,
              "allowed feeds: latest.json on the repo's releases, the repo's releases API")
        for u in ["https://objects.githubusercontent.com/github-production-release-asset/x", "https://release-assets.githubusercontent.com/x",
                  "https://github.com/couplet-physical-ai/switchyard/releases/download/v0.1.1/latest.json"] {
            check(p.refuseHop(URL(string: u)!, api: false) == nil, "allowed redirect hop: \(u)")
        }
        let refused: [(String, SYRefusal)] = [
            ("http://github.com/couplet-physical-ai/switchyard/releases/download/v1/a.zip", .insecure("http://github.com/couplet-physical-ai/switchyard/releases/download/v1/a.zip")),
            ("https://example.com/Switchyard-0.1.1-arm64.zip", .host("example.com")),
            ("https://github.com.example.com/couplet-physical-ai/switchyard/releases/a.zip", .host("github.com.example.com")),
            ("https://github.com/someone-else/switchyard/releases/download/v9/Switchyard-9.0.0-arm64.zip", .path("https://github.com/someone-else/switchyard/releases/download/v9/Switchyard-9.0.0-arm64.zip")),
            ("https://github.com/couplet-physical-ai/switchyard/releases/../../x/a.zip", .path("https://github.com/couplet-physical-ai/switchyard/releases/../../x/a.zip")),
            ("https://objects.githubusercontent.com/a.zip", .host("objects.githubusercontent.com")),
            ("http://127.0.0.1:8123/Switchyard-0.0.3-arm64.zip", .insecure("http://127.0.0.1:8123/Switchyard-0.0.3-arm64.zip")),
        ]
        for (u, why) in refused { check(p.refuseAsset(URL(string: u)!) == why, "refused zip: \(u)", "\(String(describing: p.refuseAsset(URL(string: u)!)))") }
        check(p.refuseFeed(URL(string: "http://github.com/couplet-physical-ai/switchyard/releases/latest/download/latest.json")!) != nil, "a non-https feed → refused")
        // Redirects off-host.
        check(p.refuseHop(URL(string: "https://example.com/x")!, api: true) == .host("example.com"), "a redirect hop off GitHub → refused")
        check(p.refuseHop(URL(string: "http://release-assets.githubusercontent.com/x")!, api: false) != nil, "a redirect hop to plain http → refused")
        check(p.refuseHop(URL(string: "https://github.com/evil/repo/releases/download/v1/a.zip")!, api: false) != nil, "a redirect hop to another repo → refused")
        check(p.refuseHop(URL(string: "https://api.github.com/repos/couplet-physical-ai/switchyard/releases")!, api: true) == nil
              && p.refuseHop(URL(string: "https://api.github.com/repos/couplet-physical-ai/switchyard/releases")!, api: false) != nil,
              "a hop to the repo's API only on the API request")
        // The env-only test feed: a latest.json URL or a base.
        check(SYHostPolicy.testFeedURL("http://127.0.0.1:8123")?.absoluteString == "http://127.0.0.1:8123/latest.json", "test feed: a base gets /latest.json")
        check(SYHostPolicy.testFeedURL("https://github.com/couplet-physical-ai/switchyard/releases/download/v0.0.4/latest.json")?.lastPathComponent == "latest.json",
              "test feed: a latest.json URL is taken as it is")
        check(SYHostPolicy.testFeedURL("http://localhost:8123") == nil && SYHostPolicy.testFeedURL("http://example.com") == nil
              && SYHostPolicy.testFeedURL("file:///tmp/feed") == nil && SYHostPolicy.testFeedURL("") == nil, "test feed: other http, file: and empty → refused")
        let t = SYHostPolicy(repo: "couplet-physical-ai/switchyard", testFeed: SYHostPolicy.testFeedURL("http://127.0.0.1:8123"))
        check(t.refuseAsset(URL(string: "http://127.0.0.1:8123/Switchyard-0.0.3-arm64.zip")!) == nil, "test feed: its own origin may serve the zip")
        check(t.refuseAsset(URL(string: "http://127.0.0.1:9999/a.zip")!) != nil && t.refuseAsset(URL(string: "https://example.com/a.zip")!) != nil,
              "test feed: another port or host → still refused")
        let g = SYHostPolicy(repo: "couplet-physical-ai/switchyard", testFeed: SYHostPolicy.testFeedURL("https://github.com/couplet-physical-ai/switchyard/releases/download/v0.0.4/latest.json"))
        check(g.testOrigin == nil && g.refuseAsset(URL(string: "https://github.com/evil/x/releases/a.zip")!) != nil, "test feed on GitHub: the normal rules hold")
    }

    // MARK: the verify chain (real ditto, codesign, xattr)

    static func verifyChain() {
        let dir = scratch("verify")
        do {
            let zip = try SYFixture.zip(in: dir.appendingPathComponent("good"), id: id, version: "0.0.3")
            let sha = try SYDigest.sha256(of: zip)
            let v = SYVerifier(bundleID: id, currentBuild: 2)
            let ok = try v.verify(zip: zip, sha256: sha, version: "0.0.3", build: 3, into: dir.appendingPathComponent("stage-good"))
            check(version(of: ok.app) == "0.0.3" && !SYDigest.quarantined(ok.app) && ok.cdhash.count == 40,
                  "a good zip passes every check (sha, ditto, id, version, build 3 > 2, SecStaticCode strict, codesign); cdhash \(ok.cdhash)")

            check(refusal { _ = try v.verify(zip: zip, sha256: String(repeating: "0", count: 64), version: "0.0.3", build: 3, into: dir.appendingPathComponent("s1")) }
                  == .hash(got: sha, want: String(repeating: "0", count: 64)), "SHA mismatch → refused")

            // A corrupt zip (its sha matches the feed: the bytes are just not a zip), with an
            // installed copy beside it that must stay as it was.
            let installed = try SYFixture.bundle(in: dir.appendingPathComponent("Applications"), id: id, version: "0.0.2")
            let inode = self.inode(installed)
            let corrupt = dir.appendingPathComponent("corrupt.zip")
            var junk = Data("PK\u{3}\u{4}".utf8); junk.append(Data((0..<4096).map { UInt8(truncatingIfNeeded: $0 &* 31) }))
            try junk.write(to: corrupt)
            let r = refusal {
                let staged = try v.verify(zip: corrupt, sha256: try SYDigest.sha256(of: corrupt), version: "0.0.3", build: 3, into: dir.appendingPathComponent("s2"))
                try SYSwap(target: installed, bundleID: id).swap(staged.app)
            }
            check(r == .archive("does not unpack"), "a corrupt zip → refused", "\(String(describing: r))")
            check(version(of: installed) == "0.0.2" && self.inode(installed) == inode
                  && (try? SYProcess.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", installed.path], deadline: 60)) != nil
                  && !FileManager.default.fileExists(atPath: installed.path + ".old"),
                  "… and the installed app is untouched (same inode, version, valid signature, no aside)")

            let otherZip = try SYFixture.zip(in: dir.appendingPathComponent("other"), id: "com.example.impostor", version: "0.0.3")
            check(refusal { _ = try v.verify(zip: otherZip, sha256: try SYDigest.sha256(of: otherZip), version: "0.0.3", build: 3, into: dir.appendingPathComponent("s3")) }
                  == .wrongApp("com.example.impostor"), "a wrong bundle id → refused")

            let sameZip = try SYFixture.zip(in: dir.appendingPathComponent("same"), id: id, version: "0.0.2")
            check(refusal { _ = try v.verify(zip: sameZip, sha256: try SYDigest.sha256(of: sameZip), version: "0.0.2", build: 2, into: dir.appendingPathComponent("s4")) }
                  == .notNewer(build: 2, current: 2), "a build not newer (2 = 2) → refused")
            let olderZip = try SYFixture.zip(in: dir.appendingPathComponent("older"), id: id, version: "0.0.1")
            check(refusal { _ = try v.verify(zip: olderZip, sha256: try SYDigest.sha256(of: olderZip), version: "0.0.1", build: 1, into: dir.appendingPathComponent("s5")) }
                  == .notNewer(build: 1, current: 2), "an older build (1 < 2) → refused")
            check(refusal { _ = try v.verify(zip: zip, sha256: sha, version: "0.0.4", build: 4, into: dir.appendingPathComponent("s6")) }
                  == .versionMismatch(got: "0.0.3", want: "0.0.4"), "a bundle version that is not the feed's → refused")
            check(refusal { _ = try v.verify(zip: zip, sha256: sha, version: "0.0.3", build: 4, into: dir.appendingPathComponent("s6b")) }
                  == .buildMismatch(got: "3", want: 4), "a bundle CFBundleVersion that is not the feed's build → refused")

            // Signed, then changed: the strict check fails.
            let tamperDir = dir.appendingPathComponent("tamper")
            let tampered = try SYFixture.bundle(in: tamperDir.appendingPathComponent("src"), id: id, version: "0.0.3")
            try Data([0x00, 0x01]).write(to: tampered.appendingPathComponent("Contents/MacOS/Switchyard"))
            let tz = tamperDir.appendingPathComponent("t.zip")
            try SYProcess.run("/usr/bin/ditto", ["-c", "-k", "--keepParent", tampered.path, tz.path], deadline: 60)
            let tr = refusal { _ = try v.verify(zip: tz, sha256: try SYDigest.sha256(of: tz), version: "0.0.3", build: 3, into: dir.appendingPathComponent("s7")) }
            if case .unsigned? = tr { check(true, "a bundle changed after signing → refused (codesign --verify --deep --strict)") }
            else { check(false, "a bundle changed after signing → refused", "\(String(describing: tr))") }

            // Quarantined in the zip: cleared, and checked gone.
            let qDir = dir.appendingPathComponent("quarantine")
            let q = try SYFixture.bundle(in: qDir.appendingPathComponent("src"), id: id, version: "0.0.3")
            try SYProcess.run("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;Safari;", q.path], deadline: 30)
            let qz = qDir.appendingPathComponent("q.zip")
            try SYProcess.run("/usr/bin/ditto", ["-c", "-k", "--keepParent", q.path, qz.path], deadline: 60)
            let qa = try v.verify(zip: qz, sha256: try SYDigest.sha256(of: qz), version: "0.0.3", build: 3, into: dir.appendingPathComponent("s8"))
            check(!SYDigest.quarantined(qa.app), "a quarantined bundle → the flag is cleared")

            // The order of the chain: the sum first (nothing is unpacked from a zip that fails it).
            var ran: [String] = []
            var watched = v
            watched.tools = SYTools { tool, args in ran.append((tool as NSString).lastPathComponent); return try SYTools.live.run(tool, args) }
            _ = refusal { _ = try watched.verify(zip: zip, sha256: String(repeating: "1", count: 64), version: "0.0.3", build: 3, into: dir.appendingPathComponent("s9")) }
            check(ran.isEmpty, "a SHA mismatch runs no tool")
            _ = try watched.verify(zip: zip, sha256: sha, version: "0.0.3", build: 3, into: dir.appendingPathComponent("s10"))
            check(ran == ["ditto", "codesign", "xattr"], "the chain: sha256, ditto, plist, codesign, xattr", ran.joined(separator: ","))
        } catch {
            check(false, "the verify chain ran", "\(error)")
        }
    }

    // MARK: the signer pin

    /// Throwaway code-signing certificates in a keychain file of their own, made per run and
    /// deleted after (sy-ship's recipe): `openssl req -x509` (codeSigning, CA:false) → p12 →
    /// `security import -k <tmp> -T /usr/bin/codesign`. The keychain is never added to the search
    /// list; the login keychain and trust settings are never touched.
    struct Keychain {
        let file: URL
        let password = UUID().uuidString

        static func make(in dir: URL) throws -> Keychain {
            let k = Keychain(file: dir.appendingPathComponent("sy-pin-tests.keychain"))
            try SYProcess.run("/usr/bin/security", ["create-keychain", "-p", k.password, k.file.path], deadline: 30)
            try SYProcess.run("/usr/bin/security", ["set-keychain-settings", k.file.path], deadline: 30)
            try SYProcess.run("/usr/bin/security", ["unlock-keychain", "-p", k.password, k.file.path], deadline: 30)
            return k
        }

        /// A self-signed code-signing identity named `name`; its leaf's SHA-256 is that of `der`.
        func identity(_ name: String, in dir: URL) throws -> (SYFixture.Identity, der: Data) {
            let ssl = "/usr/bin/openssl", key = dir.appendingPathComponent("\(name).key").path
            let pem = dir.appendingPathComponent("\(name).pem").path, p12 = dir.appendingPathComponent("\(name).p12").path
            let der = dir.appendingPathComponent("\(name).der").path, pass = UUID().uuidString
            try SYProcess.run(ssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", pem, "-days", "2", "-subj", "/CN=\(name)",
                                    "-addext", "basicConstraints=critical,CA:false", "-addext", "keyUsage=critical,digitalSignature",
                                    "-addext", "extendedKeyUsage=critical,codeSigning"], deadline: 60)
            try SYProcess.run(ssl, ["pkcs12", "-export", "-inkey", key, "-in", pem, "-out", p12, "-passout", "pass:\(pass)", "-name", name], deadline: 60)
            try SYProcess.run(ssl, ["x509", "-in", pem, "-outform", "der", "-out", der], deadline: 30)
            try SYProcess.run("/usr/bin/security", ["import", p12, "-k", file.path, "-P", pass, "-T", "/usr/bin/codesign"], deadline: 30)
            try SYProcess.run("/usr/bin/security", ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, file.path], deadline: 30)
            let data = try Data(contentsOf: URL(fileURLWithPath: der))
            let sha1 = Insecure.SHA1.hash(data: data).map { String(format: "%02X", $0) }.joined()
            return (SYFixture.Identity(sha1: sha1, keychain: file), data)
        }

        func delete() {
            _ = try? SYProcess.run("/usr/bin/security", ["delete-keychain", file.path], deadline: 30)
            try? FileManager.default.removeItem(at: file)
        }
    }

    static func pinCases() {
        let dir = scratch("pin")
        let keychain: Keychain
        do { keychain = try Keychain.make(in: dir) } catch { return check(false, "a temp keychain for the throwaway certificates", "\(error)") }
        defer {
            keychain.delete()
            check(!FileManager.default.fileExists(atPath: keychain.file.path), "the temp keychain is deleted after the run")
        }
        do {
            let (a, aDER) = try keychain.identity("Switchyard Pin Test A", in: dir)
            let (b, bDER) = try keychain.identity("Switchyard Pin Test B", in: dir)
            let leafA = SYDigest.hex(SHA256.hash(data: aDER)), leafB = SYDigest.hex(SHA256.hash(data: bDER))
            print("        throwaway leaf A sha256 \(leafA), B \(leafB)")
            let zipA = try SYFixture.zip(in: dir.appendingPathComponent("a"), id: id, version: "0.0.3", identity: a)
            let zipB = try SYFixture.zip(in: dir.appendingPathComponent("b"), id: id, version: "0.0.3", identity: b)
            let zipAdhoc = try SYFixture.zip(in: dir.appendingPathComponent("adhoc"), id: id, version: "0.0.3")
            var n = 0
            func verify(_ zip: URL, running: SYSigner) throws -> SYVerifier.Verified {
                var v = SYVerifier(bundleID: id, currentBuild: 2)
                v.runningSigner = { running }
                n += 1
                return try v.verify(zip: zip, sha256: try SYDigest.sha256(of: zip), version: "0.0.3", build: 3, into: dir.appendingPathComponent("stage\(n)"))
            }

            // What the pin reads: the leaf of kSecCodeInfoCertificates, or the ad-hoc flag.
            let signedA = try verify(zipA, running: .adhoc)
            check(signedA.signer == .cert(leafA), "a bundle signed with A reads as A's leaf (SHA-256 of its DER)", "\(signedA.signer)")
            check(try verify(zipAdhoc, running: .adhoc).signer == .adhoc, "an ad-hoc bundle reads as ad hoc (kSecCodeSignatureAdhoc)")

            // Running cert-signed: the pin is on.
            let same = try verify(zipA, running: .cert(leafA))
            check(same.signer == .cert(leafA) && same.running == .cert(leafA), "pin on: running A + new A (matching cert) → accepted")
            let other = refusal { _ = try verify(zipB, running: .cert(leafA)) }
            check(other == .otherSigner(got: leafB, want: leafA) && other?.errorDescription == "update signed by a different certificate",
                  "pin on: running A + new B (a different self-signed cert) → refused (otherSigner: update signed by a different certificate)",
                  "\(String(describing: other))")
            let adhocNew = refusal { _ = try verify(zipAdhoc, running: .cert(leafA)) }
            check(adhocNew == .otherSigner(got: "ad hoc", want: leafA), "pin on: running A + new ad hoc → refused (otherSigner)", "\(String(describing: adhocNew))")

            // Running ad hoc (every release today): the pin is off, both are taken as before.
            check(try verify(zipA, running: .adhoc).signer == .cert(leafA), "pin off: running ad hoc + new cert-signed → accepted (the one-time ad hoc → cert step)")
            check(try verify(zipAdhoc, running: .adhoc).running == .adhoc, "pin off: running ad hoc + new ad hoc → accepted (as today)")
            check(try verify(zipB, running: .adhoc).signer == .cert(leafB), "pin off: running ad hoc takes any certificate")

            // The seam's default, SYSign.running(), in real processes: this CLI (linked ad hoc)
            // and a copy of it signed with A.
            check((try? SYSign.running()) == .adhoc, "SYSign.running(): this test CLI (linker-signed) is ad hoc")
            let me = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
            let copy = dir.appendingPathComponent("updater-tests-signed-A")
            try FileManager.default.copyItem(at: me, to: copy)
            try SYProcess.run("/usr/bin/codesign", ["--force", "--sign", a.sha1, "--keychain", a.keychain.path, copy.path], deadline: 60)
            let said = (try? SYProcess.run(copy.path, ["--print-running-signer"], deadline: 60)) ?? "?"
            check(said == "leaf sha256 \(leafA)", "SYSign.running(): a copy of this CLI signed with A reads A's leaf", said)
            var unread = SYVerifier(bundleID: id, currentBuild: 2)
            unread.runningSigner = { throw SYRefusal.unsigned("cannot read this app's own signature") }
            check(refusal { _ = try unread.verify(zip: zipA, sha256: try SYDigest.sha256(of: zipA), version: "0.0.3", build: 3, into: dir.appendingPathComponent("unread")) }
                  == .unsigned("cannot read this app's own signature"), "a copy that cannot read its own signer takes no update")
        } catch {
            check(false, "the pin cases ran", "\(error)")
        }
    }

    // MARK: the swap

    /// The real file ops, with a rename that can be made to fail.
    struct FailingOps: SYFileOps {
        var failRename: Int
        let count = Counter()
        final class Counter { var n = 0 }
        let real = SYLocalFileOps()
        func rename(_ from: URL, _ to: URL) throws {
            count.n += 1
            if count.n == failRename { throw SYRefusal.move("injected failure of rename \(count.n)") }
            try real.rename(from, to)
        }
        func remove(_ url: URL) throws { try real.remove(url) }
        func exists(_ url: URL) -> Bool { real.exists(url) }
        func writable(_ dir: URL) -> Bool { real.writable(dir) }
        func volume(_ url: URL) -> String? { real.volume(url) }
    }

    struct FakeVolumeOps: SYFileOps {
        var writableDirs: Bool
        var otherVolume: Bool
        let real = SYLocalFileOps()
        func rename(_ from: URL, _ to: URL) throws { try real.rename(from, to) }
        func remove(_ url: URL) throws { try real.remove(url) }
        func exists(_ url: URL) -> Bool { real.exists(url) }
        func writable(_ dir: URL) -> Bool { writableDirs }
        func volume(_ url: URL) -> String? { otherVolume && url.path.contains("staging") ? "elsewhere" : "here" }
    }

    static func swapCases() {
        let dir = scratch("swap")
        do {
            // Success: two renames.
            let apps = dir.appendingPathComponent("ok/Applications")
            let target = try SYFixture.bundle(in: apps, id: id, version: "0.0.2")
            let staging = dir.appendingPathComponent("ok/staging")
            let fresh = try SYFixture.bundle(in: staging, id: id, version: "0.0.3")
            let swap = SYSwap(target: target, bundleID: id)
            try swap.preflight(staging: staging)
            check(true, "preflight: a writable folder on the same volume")
            try swap.swap(fresh)
            check(version(of: target) == "0.0.3" && version(of: swap.aside) == "0.0.2" && swap.aside.lastPathComponent == "Switchyard.app.old"
                  && !FileManager.default.fileExists(atPath: fresh.path), "swap: current → Switchyard.app.old, staged → current")
            let gone = swap.sweep(staging: [staging])
            check(gone == [swap.aside.path, staging.path] && !FileManager.default.fileExists(atPath: swap.aside.path)
                  && !FileManager.default.fileExists(atPath: staging.path) && version(of: target) == "0.0.3",
                  "sweep: the aside and the staging folder go; the new app stays", gone.joined(separator: ","))

            // Rollback: the second rename fails.
            let rApps = dir.appendingPathComponent("rollback/Applications")
            let rTarget = try SYFixture.bundle(in: rApps, id: id, version: "0.0.2")
            let rInode = inode(rTarget)
            let rStaging = dir.appendingPathComponent("rollback/staging")
            let rFresh = try SYFixture.bundle(in: rStaging, id: id, version: "0.0.3")
            let ops = FailingOps(failRename: 2)
            let rSwap = SYSwap(target: rTarget, bundleID: id, ops: ops)
            let r = refusal { try rSwap.swap(rFresh) }
            check(r == .move("injected failure of rename 2"), "rollback: the second rename's failure is reported", "\(String(describing: r))")
            check(ops.count.n == 3, "rollback: the first rename is undone (a third rename)", "\(ops.count.n) renames")
            check(version(of: rTarget) == "0.0.2" && inode(rTarget) == rInode
                  && (try? SYProcess.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", rTarget.path], deadline: 60)) != nil,
                  "rollback: the original (the same inode) is back in place, whole and validly signed")
            check(!FileManager.default.fileExists(atPath: rSwap.aside.path) && version(of: rFresh) == "0.0.3",
                  "rollback: nothing lost (no aside left, the staged app still there)")

            // The first rename fails: nothing moved.
            let fApps = dir.appendingPathComponent("first/Applications")
            let fTarget = try SYFixture.bundle(in: fApps, id: id, version: "0.0.2")
            let fFresh = try SYFixture.bundle(in: dir.appendingPathComponent("first/staging"), id: id, version: "0.0.3")
            let fOps = FailingOps(failRename: 1)
            _ = refusal { try SYSwap(target: fTarget, bundleID: id, ops: fOps).swap(fFresh) }
            check(version(of: fTarget) == "0.0.2" && version(of: fFresh) == "0.0.3" && fOps.count.n == 1, "the first rename fails: nothing moved")

            // An aside that is not this app is never deleted, and blocks the swap.
            let lApps = dir.appendingPathComponent("leftover/Applications")
            let lTarget = try SYFixture.bundle(in: lApps, id: id, version: "0.0.2")
            _ = try SYFixture.bundle(in: lApps, id: "com.example.other", version: "1.0.0", name: "Switchyard.app.old", sign: false)
            let lFresh = try SYFixture.bundle(in: dir.appendingPathComponent("leftover/staging"), id: id, version: "0.0.3")
            let lSwap = SYSwap(target: lTarget, bundleID: id)
            check(refusal { try lSwap.swap(lFresh) } == .leftover("Switchyard.app.old") && version(of: lTarget) == "0.0.2"
                  && version(of: lSwap.aside) == "1.0.0", "a foreign Switchyard.app.old: kept, and the swap refused")

            // Copper's preflight.
            let s = dir.appendingPathComponent("pre/staging")
            try FileManager.default.createDirectory(at: s, withIntermediateDirectories: true)
            let t = dir.appendingPathComponent("pre/Applications/Switchyard.app")
            check(refusal { try SYSwap(target: t, bundleID: id, ops: FakeVolumeOps(writableDirs: false, otherVolume: false)).preflight(staging: s) }
                  == .readOnly(t.deletingLastPathComponent().path), "preflight: a read-only folder → refused")
            check(SYRefusal.readOnly("/Applications").errorDescription == "Update needs admin rights; run `brew upgrade --greedy --cask switchyard`",
                  "… worded: Update needs admin rights; run `brew upgrade --greedy --cask switchyard`")
            // EACCES for real: a folder this user cannot write (chmod 555), swap refused before
            // any rename; then the same with the bundle itself read-only (a brew copy owned by
            // another account).
            let eApps = dir.appendingPathComponent("eacces/Applications")
            let eTarget = try SYFixture.bundle(in: eApps, id: id, version: "0.0.2")
            let eFresh = try SYFixture.bundle(in: dir.appendingPathComponent("eacces/staging"), id: id, version: "0.0.3")
            let eOps = FailingOps(failRename: 99)
            chmod(eApps.path, 0o555)
            let e1 = refusal { try SYSwap(target: eTarget, bundleID: id, ops: eOps).swap(eFresh) }
            chmod(eApps.path, 0o755)
            check(e1 == .readOnly(eApps.path) && eOps.count.n == 0 && version(of: eTarget) == "0.0.2" && version(of: eFresh) == "0.0.3",
                  "EACCES (read-only folder): refused before touching anything (0 renames)", "\(String(describing: e1)), \(eOps.count.n) renames")
            chmod(eTarget.path, 0o555)
            let e2 = refusal { try SYSwap(target: eTarget, bundleID: id, ops: eOps).swap(eFresh) }
            chmod(eTarget.path, 0o755)
            check(e2 == .readOnly(eApps.path) && eOps.count.n == 0 && version(of: eTarget) == "0.0.2",
                  "EACCES (read-only bundle): refused before touching anything (0 renames)", "\(String(describing: e2))")
            // And the rename itself answering EACCES maps to the same refusal, nothing moved.
            chmod(eApps.path, 0o555)
            let e3 = refusal { try SYLocalFileOps().rename(eTarget, eApps.appendingPathComponent("Switchyard.app.old")) }
            chmod(eApps.path, 0o755)
            check(e3 == .readOnly(eApps.path) && version(of: eTarget) == "0.0.2", "rename(2) EACCES → the admin-rights refusal", "\(String(describing: e3))")
            check(refusal { try SYSwap(target: t, bundleID: id, ops: FakeVolumeOps(writableDirs: true, otherVolume: true)).preflight(staging: s) }
                  == .otherVolume, "preflight: staging on another volume → refused")
        } catch {
            check(false, "the swap cases ran", "\(error)")
        }
    }
}
#endif
