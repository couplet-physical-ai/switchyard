// Native unit tests of the updater's logic (UpdaterCore.swift). The app's build compiles every
// Swift file in modules/apple, so all of this is behind SWITCHYARD_UPDATER_TESTS:
// tools/updater-tests.sh compiles UpdaterCore.swift + this file with `-D SWITCHYARD_UPDATER_TESTS`
// into a CLI on a Mac and runs it; it exits nonzero when a case fails.

#if SWITCHYARD_UPDATER_TESTS
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
        let started = Date()
        print("== versions"); versions()
        print("== latest.json"); latestJSON()
        print("== SHA256SUMS and the releases API"); sumsAndAPI()
        print("== hosts"); hosts()
        print("== the verify chain"); verifyChain()
        print("== the swap"); swapCases()
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
        {"version":"0.1.1","url":"https://github.com/couplet-physical-ai/switchyard/releases/download/v0.1.1/Switchyard-0.1.1-arm64.zip","sha256":"\(sha)","notes":"- faster yard","published":"2026-11-10T23:59:00Z"}
        """
        do {
            let r = try SYFeed.parseLatest(Data(good.utf8), bundleID: id)
            check(r.version == "0.1.1" && r.sha256 == sha && r.url.lastPathComponent == "Switchyard-0.1.1-arm64.zip"
                  && r.notes == "- faster yard" && r.published == "2026-11-10T23:59:00Z" && r.source == "latest.json", "the schema parses")
        } catch { check(false, "the schema parses", "\(error)") }
        let extra = """
        {"version":"v0.1.2","build":1002,"url":"https://github.com/x/y/releases/download/v0.1.2/Switchyard-0.1.2-arm64.zip","dmg":"https://github.com/x/y/z.dmg","sha256":"\(sha.uppercased())","notes":"","published":"","minimumSystemVersion":"14.0","bundleId":"\(id)","commit":"abc"}
        """
        let r2 = try? SYFeed.parseLatest(Data(extra.utf8), bundleID: id)
        check(r2?.version == "0.1.2" && r2?.sha256 == sha && r2?.minimumSystemVersion == "14.0", "sy-ship's extra fields are accepted, the v and hex case normalised")
        let noSha = #"{"version":"0.1.1","url":"https://github.com/a/b/c.zip","notes":""}"#
        check(refusal { _ = try SYFeed.parseLatest(Data(noSha.utf8), bundleID: id) } == .feed("has no sha256 for the zip"), "no sha256 → refused")
        let shortSha = #"{"version":"0.1.1","url":"https://github.com/a/b/c.zip","sha256":"abc"}"#
        check(refusal { _ = try SYFeed.parseLatest(Data(shortSha.utf8), bundleID: id) } == .feed("has no sha256 for the zip"), "a short sha256 → refused")
        let noVersion = #"{"version":"latest","url":"https://github.com/a/b/c.zip","sha256":"\#(sha)"}"#
        check(refusal { _ = try SYFeed.parseLatest(Data(noVersion.utf8), bundleID: id) } == .feed("names no version"), "a non-version → refused")
        let other = #"{"version":"0.1.1","url":"https://github.com/a/b/c.zip","sha256":"\#(sha)","bundleId":"com.example.other"}"#
        check(refusal { _ = try SYFeed.parseLatest(Data(other.utf8), bundleID: id) } == .wrongApp("com.example.other"), "another app's bundleId → refused")
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
    }

    // MARK: hosts

    static func hosts() {
        let p = SYHostPolicy()
        for u in ["https://github.com/couplet-physical-ai/switchyard/releases/download/v0.1.1/Switchyard-0.1.1-arm64.zip",
                  "https://objects.githubusercontent.com/github-production-release-asset/x", "https://release-assets.githubusercontent.com/x"] {
            check(p.refuseAsset(URL(string: u)!) == nil, "allowed: \(URL(string: u)!.host!)")
        }
        let refused: [(String, SYRefusal)] = [
            ("http://github.com/a.zip", .insecure("http://github.com/a.zip")),
            ("https://example.com/Switchyard-0.1.1-arm64.zip", .host("example.com")),
            ("https://github.com.example.com/a.zip", .host("github.com.example.com")),
            ("https://objects.githubusercontent.com.example.com/a.zip", .host("objects.githubusercontent.com.example.com")),
            ("https://api.github.com/repos/o/r/releases", .host("api.github.com")),
            ("http://127.0.0.1:8123/Switchyard-0.0.3-arm64.zip", .insecure("http://127.0.0.1:8123/Switchyard-0.0.3-arm64.zip")),
        ]
        for (u, why) in refused { check(p.refuseAsset(URL(string: u)!) == why, "refused asset: \(u)", "\(String(describing: p.refuseAsset(URL(string: u)!)))") }
        check(p.refuseFeed(URL(string: "http://github.com/o/r/releases/latest/download/latest.json")!) == .insecure("http://github.com/o/r/releases/latest/download/latest.json"), "a non-https feed → refused")
        check(p.refuseFeed(URL(string: "https://api.github.com/repos/o/r/releases")!) == nil, "the API may serve the feed")
        check(p.refuseHop(URL(string: "https://api.github.com/x")!, api: true) == nil && p.refuseHop(URL(string: "https://api.github.com/x")!, api: false) != nil,
              "a redirect hop to api.github.com only on the API request")
        check(p.refuseHop(URL(string: "https://example.com/x")!, api: true) == .host("example.com"), "a redirect hop off GitHub → refused")
        // The env-only test feed.
        check(SYHostPolicy.testFeedBase("http://127.0.0.1:8123") != nil, "test feed: http://127.0.0.1 is accepted")
        check(SYHostPolicy.testFeedBase("http://localhost:8123") == nil && SYHostPolicy.testFeedBase("http://example.com") == nil
              && SYHostPolicy.testFeedBase("file:///tmp/feed") == nil && SYHostPolicy.testFeedBase("") == nil, "test feed: other http, file: and empty → refused")
        let t = SYHostPolicy(testFeed: SYHostPolicy.testFeedBase("http://127.0.0.1:8123"))
        check(t.refuseAsset(URL(string: "http://127.0.0.1:8123/Switchyard-0.0.3-arm64.zip")!) == nil, "test feed: its own origin may serve the zip")
        check(t.refuseAsset(URL(string: "http://127.0.0.1:9999/a.zip")!) != nil && t.refuseAsset(URL(string: "https://example.com/a.zip")!) != nil,
              "test feed: another port or host → still refused")
    }

    // MARK: the verify chain (real ditto, codesign, xattr)

    static func verifyChain() {
        let dir = scratch("verify")
        do {
            let zip = try SYFixture.zip(in: dir.appendingPathComponent("good"), id: id, version: "0.0.3")
            let sha = try SYDigest.sha256(of: zip)
            let v = SYVerifier(bundleID: id, current: "0.0.2")
            let app = try v.verify(zip: zip, sha256: sha, version: "0.0.3", into: dir.appendingPathComponent("stage-good"))
            check(version(of: app) == "0.0.3" && !SYDigest.quarantined(app), "a good zip passes every check")

            check(refusal { _ = try v.verify(zip: zip, sha256: String(repeating: "0", count: 64), version: "0.0.3", into: dir.appendingPathComponent("s1")) }
                  == .hash(got: sha, want: String(repeating: "0", count: 64)), "SHA mismatch → refused")

            // A corrupt zip (its sha matches the feed: the bytes are just not a zip), with an
            // installed copy beside it that must stay as it was.
            let installed = try SYFixture.bundle(in: dir.appendingPathComponent("Applications"), id: id, version: "0.0.2")
            let inode = self.inode(installed)
            let corrupt = dir.appendingPathComponent("corrupt.zip")
            var junk = Data("PK\u{3}\u{4}".utf8); junk.append(Data((0..<4096).map { UInt8(truncatingIfNeeded: $0 &* 31) }))
            try junk.write(to: corrupt)
            let r = refusal {
                let staged = try v.verify(zip: corrupt, sha256: try SYDigest.sha256(of: corrupt), version: "0.0.3", into: dir.appendingPathComponent("s2"))
                try SYSwap(target: installed, bundleID: id).swap(staged)
            }
            check(r == .archive("does not unpack"), "a corrupt zip → refused", "\(String(describing: r))")
            check(version(of: installed) == "0.0.2" && self.inode(installed) == inode
                  && (try? SYProcess.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", installed.path], deadline: 60)) != nil
                  && !FileManager.default.fileExists(atPath: installed.path + ".old"),
                  "… and the installed app is untouched (same inode, version, valid signature, no aside)")

            let otherZip = try SYFixture.zip(in: dir.appendingPathComponent("other"), id: "com.example.impostor", version: "0.0.3")
            check(refusal { _ = try v.verify(zip: otherZip, sha256: try SYDigest.sha256(of: otherZip), version: "0.0.3", into: dir.appendingPathComponent("s3")) }
                  == .wrongApp("com.example.impostor"), "a wrong bundle id → refused")

            let sameZip = try SYFixture.zip(in: dir.appendingPathComponent("same"), id: id, version: "0.0.2")
            check(refusal { _ = try v.verify(zip: sameZip, sha256: try SYDigest.sha256(of: sameZip), version: "0.0.2", into: dir.appendingPathComponent("s4")) }
                  == .notNewer("0.0.2", current: "0.0.2"), "a version not newer → refused")
            let olderZip = try SYFixture.zip(in: dir.appendingPathComponent("older"), id: id, version: "0.0.1")
            check(refusal { _ = try v.verify(zip: olderZip, sha256: try SYDigest.sha256(of: olderZip), version: "0.0.1", into: dir.appendingPathComponent("s5")) }
                  == .notNewer("0.0.1", current: "0.0.2"), "an older version → refused")
            check(refusal { _ = try v.verify(zip: zip, sha256: sha, version: "0.0.4", into: dir.appendingPathComponent("s6")) }
                  == .versionMismatch(got: "0.0.3", want: "0.0.4"), "a bundle version that is not the feed's → refused")

            // Signed, then changed: the strict check fails.
            let tamperDir = dir.appendingPathComponent("tamper")
            let tampered = try SYFixture.bundle(in: tamperDir.appendingPathComponent("src"), id: id, version: "0.0.3")
            try Data([0x00, 0x01]).write(to: tampered.appendingPathComponent("Contents/MacOS/Switchyard"))
            let tz = tamperDir.appendingPathComponent("t.zip")
            try SYProcess.run("/usr/bin/ditto", ["-c", "-k", "--keepParent", tampered.path, tz.path], deadline: 60)
            let tr = refusal { _ = try v.verify(zip: tz, sha256: try SYDigest.sha256(of: tz), version: "0.0.3", into: dir.appendingPathComponent("s7")) }
            if case .unsigned? = tr { check(true, "a bundle changed after signing → refused (codesign --verify --deep --strict)") }
            else { check(false, "a bundle changed after signing → refused", "\(String(describing: tr))") }

            // Quarantined in the zip: cleared, and checked gone.
            let qDir = dir.appendingPathComponent("quarantine")
            let q = try SYFixture.bundle(in: qDir.appendingPathComponent("src"), id: id, version: "0.0.3")
            try SYProcess.run("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;Safari;", q.path], deadline: 30)
            let qz = qDir.appendingPathComponent("q.zip")
            try SYProcess.run("/usr/bin/ditto", ["-c", "-k", "--keepParent", q.path, qz.path], deadline: 60)
            let qa = try v.verify(zip: qz, sha256: try SYDigest.sha256(of: qz), version: "0.0.3", into: dir.appendingPathComponent("s8"))
            check(!SYDigest.quarantined(qa), "a quarantined bundle → the flag is cleared")

            // The order of the chain: the sum first (nothing is unpacked from a zip that fails it).
            var ran: [String] = []
            var watched = v
            watched.tools = SYTools { tool, args in ran.append((tool as NSString).lastPathComponent); return try SYTools.live.run(tool, args) }
            _ = refusal { _ = try watched.verify(zip: zip, sha256: String(repeating: "1", count: 64), version: "0.0.3", into: dir.appendingPathComponent("s9")) }
            check(ran.isEmpty, "a SHA mismatch runs no tool")
            _ = try watched.verify(zip: zip, sha256: sha, version: "0.0.3", into: dir.appendingPathComponent("s10"))
            check(ran == ["ditto", "codesign", "xattr"], "the chain: sha256, ditto, plist, codesign, xattr", ran.joined(separator: ","))
        } catch {
            check(false, "the verify chain ran", "\(error)")
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
            check(refusal { try SYSwap(target: t, bundleID: id, ops: FakeVolumeOps(writableDirs: true, otherVolume: true)).preflight(staging: s) }
                  == .otherVolume, "preflight: staging on another volume → refused")
        } catch {
            check(false, "the swap cases ran", "\(error)")
        }
    }
}
#endif
