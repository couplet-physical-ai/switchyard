// Native unit tests of the test hooks' logic (HooksCore.swift): the token file's checks and
// trimming, and SWITCHYARD_SNAPSHOT's parsing. Behind SWITCHYARD_UPDATER_TESTS like
// UpdaterTests.swift; tools/updater-tests.sh compiles both and runs these after the updater's.

#if SWITCHYARD_UPDATER_TESTS
import Foundation

extension SYUpdaterTests {
    static func hooks() {
        let dir = scratch("hooks")
        func file(_ name: String, _ text: String, mode: mode_t) -> String {
            let p = dir.appendingPathComponent(name).path
            FileManager.default.createFile(atPath: p, contents: Data(text.utf8))
            chmod(p, mode)
            return p
        }
        func token(_ r: Result<String, SYHookRefusal>) -> String? { if case .success(let t) = r { return t }; return nil }
        func why(_ r: Result<String, SYHookRefusal>) -> String { if case .failure(let w) = r { return w.reason }; return "" }

        // The mode check.
        let ok = file("ok", "syd_abc123", mode: 0o600)
        check(token(SYTokenFile.read(ok)) == "syd_abc123", "token file 0600 → read")
        for mode: mode_t in [0o644, 0o640, 0o604, 0o400, 0o700, 0o660, 0o666] {
            let p = file("m\(String(mode, radix: 8))", "syd_abc123", mode: mode)
            let r = SYTokenFile.read(p)
            check(token(r) == nil && why(r) == "\(p) has mode \(SYTokenFile.octal(mode)), not 0600 (chmod 600 \(p))",
                  "token file \(SYTokenFile.octal(mode)) → refused, naming the mode", why(r))
        }
        let setuid = file("setuid", "syd_abc123", mode: 0o600)
        chmod(setuid, 0o4600)
        check(token(SYTokenFile.read(setuid)) == nil, "token file 4600 (a special bit) → refused")
        check(SYTokenFile.read(ok, uid: getuid() + 1).map { _ in "" } == .failure(SYHookRefusal("\(ok) is owned by uid \(getuid()), not this user (\(getuid() + 1))")),
              "token file owned by another user → refused")
        // A refusal never carries the token.
        let leaky = file("leaky", "syd_secret_value", mode: 0o644)
        check(!why(SYTokenFile.read(leaky)).contains("syd_secret_value"), "a refusal never names the token")

        // Trimming.
        check(token(SYTokenFile.read(file("nl", "syd_abc123\n", mode: 0o600))) == "syd_abc123", "a trailing newline is trimmed")
        check(token(SYTokenFile.read(file("crlf", "  \tsyd_abc123\r\n\n", mode: 0o600))) == "syd_abc123", "spaces, tabs and CRLF are trimmed")
        check(SYTokenFile.trim("\n syd_a b \n") == "syd_a b", "trim keeps inner spaces (parseLink refuses them later)")
        let blank = SYTokenFile.read(file("blank", " \n\n", mode: 0o600))
        check(token(blank) == nil && why(blank).hasSuffix("holds no token"), "a file of whitespace → refused", why(blank))
        let empty = SYTokenFile.read(file("empty", "", mode: 0o600))
        check(token(empty) == nil && why(empty).hasSuffix("holds no token"), "an empty file → refused", why(empty))

        // A missing file, and other things that are not a token file.
        let missing = dir.appendingPathComponent("nope").path
        check(SYTokenFile.read(missing).map { _ in "" } == .failure(SYHookRefusal("no such file \(missing)")), "a missing file → refused (no such file)")
        check(why(SYTokenFile.read("")) == "SWITCHYARD_TOKEN_FILE is empty", "an empty SWITCHYARD_TOKEN_FILE → refused")
        check(why(SYTokenFile.read("relative/token")) == "relative/token is not an absolute path", "a relative path → refused")
        let sub = dir.appendingPathComponent("adir")
        try? FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true)
        chmod(sub.path, 0o600)
        check(why(SYTokenFile.read(sub.path)) == "\(sub.path) is not a regular file", "a directory → refused")
        chmod(sub.path, 0o700)
        let big = file("big", String(repeating: "a", count: SYTokenFile.maxBytes + 1), mode: 0o600)
        check(token(SYTokenFile.read(big)) == nil && why(SYTokenFile.read(big)).contains("at most 4096"), "over 4 KiB → refused")
        let link = dir.appendingPathComponent("link").path
        try? FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: ok)
        check(token(SYTokenFile.read(link)) == "syd_abc123", "a symlink to a 0600 file is followed")
        let bin = dir.appendingPathComponent("bin").path
        FileManager.default.createFile(atPath: bin, contents: Data([0xff, 0xfe, 0x00, 0xc3]))
        chmod(bin, 0o600)
        check(why(SYTokenFile.read(bin)) == "\(bin) is not UTF-8 text", "bytes that are not UTF-8 → refused")

        // SWITCHYARD_SNAPSHOT=<png>[:<seconds>]
        func arg(_ raw: String) -> SYSnapshotArg? { if case .success(let a) = SYSnapshotArg.parse(raw) { return a }; return nil }
        func refused(_ raw: String) -> String { if case .failure(let w) = SYSnapshotArg.parse(raw) { return w.reason }; return "" }
        check(arg("/tmp/a.png") == SYSnapshotArg(path: "/tmp/a.png", seconds: 8), "snapshot: a path alone waits 8 s")
        check(arg("/tmp/a.png:10") == SYSnapshotArg(path: "/tmp/a.png", seconds: 10), "snapshot: path:10")
        check(arg("/tmp/a.png:2.5") == SYSnapshotArg(path: "/tmp/a.png", seconds: 2.5), "snapshot: path:2.5 (fractional seconds)")
        check(arg("/tmp/a.png:0") == SYSnapshotArg(path: "/tmp/a.png", seconds: 0), "snapshot: path:0 (at once)")
        check(arg("/tmp/a.png:") == SYSnapshotArg(path: "/tmp/a.png", seconds: 8), "snapshot: a bare colon waits 8 s")
        check(arg(" /tmp/a.png:3 ") == SYSnapshotArg(path: "/tmp/a.png", seconds: 3), "snapshot: surrounding spaces are trimmed")
        check(arg("/tmp/a:b.png") == SYSnapshotArg(path: "/tmp/a:b.png", seconds: 8), "snapshot: a colon inside the path is path")
        check(arg("/tmp/a:b.png:4") == SYSnapshotArg(path: "/tmp/a:b.png", seconds: 4), "snapshot: the seconds follow the last colon")
        check(arg("/tmp/x y/a.png:1") == SYSnapshotArg(path: "/tmp/x y/a.png", seconds: 1), "snapshot: spaces inside the path")
        check(refused("") == "SWITCHYARD_SNAPSHOT is empty", "snapshot: empty → refused")
        check(refused(":5") == "SWITCHYARD_SNAPSHOT names no file", "snapshot: seconds with no path → refused")
        check(refused("a.png:5") == "a.png is not an absolute path", "snapshot: a relative path → refused")
        check(refused("/tmp/a.png:-1") == "-1 is not a number of seconds from 0 to 3600", "snapshot: negative seconds → refused")
        check(refused("/tmp/a.png:7200") == "7200 is not a number of seconds from 0 to 3600", "snapshot: over an hour → refused")
        check(refused("/tmp/dir/") == "/tmp/dir/ is a directory, not a PNG's path", "snapshot: a directory → refused")
        check(arg("/tmp/a.png:1e3") == SYSnapshotArg(path: "/tmp/a.png:1e3", seconds: 8), "snapshot: a tail that is not a plain number is path")
        // The kept-answer scrub (SYKeptScrub): a seeded store, the token-holding entries gone.
        let kv = dir.appendingPathComponent("kv", isDirectory: true)
        let kept = kv.appendingPathComponent("exact.kept", isDirectory: true)
        let state = kv.appendingPathComponent("exact.state", isDirectory: true)
        let other = kv.appendingPathComponent("app.scope", isDirectory: true)
        for d in [kept, state, other] { try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true) }
        func put(_ d: URL, _ name: String, _ text: String) -> String { let p = d.appendingPathComponent(name).path; FileManager.default.createFile(atPath: p, contents: Data(text.utf8)); return p }
        let byPrefix = put(kept, "orxww", #"{"a":["syd_FAKEtoken0123456789"],"v":{"token":"syd_FAKEtoken0123456789","has":true}}"#)
        let bySys = put(kept, "mnxw43q", #"{"a":["https://x","sys_ServiceToken_abcdef"],"v":{"ok":true}}"#)
        let byValue = put(kept, "mzswkza", #"{"a":["https://x","plainOpaqueToken42"],"v":{"ok":true}}"#)
        let clean = put(kept, "ovygi", #"{"a":["https://x","1a2b3c4"],"v":{"ok":true,"label":"syd_ is a prefix"}}"#)
        let stateTok = put(state, "c2vydmvy", #""syd_FAKEtoken0123456789""#)
        let notOurs = put(other, "x", "syd_FAKEtoken0123456789")
        let n = SYKeptScrub.scrub(roots: [kv], token: "plainOpaqueToken42")
        let gone = { (p: String) in !FileManager.default.fileExists(atPath: p) }
        check(n == 4, "scrub: four token-holding entries removed", "\(n)")
        check(gone(byPrefix) && gone(bySys), "scrub: syd_/sys_ tokens in kept answers → removed")
        check(gone(byValue), "scrub: the stored token's value (no prefix) → removed")
        check(gone(stateTok), "scrub: a persisted state holding a token → removed")
        check(!gone(clean), "scrub: a clean kept answer (a bare 'syd_' word, a token version) stays")
        check(!gone(notOurs), "scrub: a scope that is not exact.* is not touched")
        check(SYKeptScrub.scrub(roots: [kv], token: nil) == 0, "scrub: a second pass finds nothing")
        check(SYKeptScrub.scrub(roots: [dir.appendingPathComponent("missing")], token: "x") == 0, "scrub: a missing store → nothing, no error")
        check(!SYKeptScrub.holds(Data("short".utf8), token: "short"), "scrub: a stored token under 8 characters is not matched by value")
    }
}
#endif
