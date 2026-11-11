// Native unit tests of the token at rest (Keychain.swift, fx-kc): the 0600 file, its 0700
// folder, the atomic write, the one-time move from the old Keychain item (a stand-in item, so
// no test touches the real Keychain or prompts), and how Keychain statuses are worded. Behind
// SWITCHYARD_UPDATER_TESTS like UpdaterTests.swift; HooksTests.swift's hooks() runs them.

#if SWITCHYARD_UPDATER_TESTS
import Foundation
import Security

/// The old item, in memory: a status to answer, a value, and what was asked of it.
final class SYFakeLegacy: SYLegacyToken, @unchecked Sendable {
    var status: OSStatus
    var value: String?
    var reads = 0, deletes = 0
    /// Holds a read until signalled (a prompt that waits).
    var gate: DispatchSemaphore?
    init(_ status: OSStatus, _ value: String? = nil) { self.status = status; self.value = value }
    func read() -> (OSStatus, String?) {
        reads += 1
        gate?.wait()
        return (status, status == errSecSuccess ? value : nil)
    }
    func delete() -> OSStatus {
        deletes += 1
        let had = value != nil
        value = nil
        status = errSecItemNotFound
        return had ? errSecSuccess : errSecItemNotFound
    }
}

extension SYUpdaterTests {
    static func tokenAtRest() {
        let root = scratch("token")
        var n = 0
        func store(_ legacy: SYLegacyToken?, agent: Bool = false, folderMode: mode_t? = nil) -> (SYTokenStore, SYTokenFileStore) {
            n += 1
            let dir = root.appendingPathComponent("app\(n)", isDirectory: true)
            if let m = folderMode {
                try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                chmod(dir.path, m)
            }
            let f = SYTokenFileStore(dir: dir)
            let s = SYTokenStore(file: f, legacy: legacy, agent: agent)
            s.log = { _ in }
            return (s, f)
        }
        func get(_ s: SYTokenStore, _ req: [String: Any] = [:]) -> SYTokenAnswer? {
            let done = DispatchSemaphore(value: 0)
            var out: SYTokenAnswer?
            s.get(req) { out = $0; done.signal() }
            return done.wait(timeout: .now() + 5) == .success ? out : nil
        }
        func op(_ f: (@escaping ([String: Any]) -> Void) -> Void) -> [String: Any]? {
            let done = DispatchSemaphore(value: 0)
            var out: [String: Any]?
            f { out = $0; done.signal() }
            return done.wait(timeout: .now() + 5) == .success ? out : nil
        }
        func mode(_ path: String) -> mode_t { var st = stat(); return lstat(path, &st) == 0 ? st.st_mode & 0o7777 : 0 }
        func contents(_ f: SYTokenFileStore) -> String? { try? String(contentsOf: f.url, encoding: .utf8) }
        func leftovers(_ f: SYTokenFileStore) -> [String] { ((try? FileManager.default.contentsOfDirectory(atPath: f.dir.path)) ?? []).filter { $0 != "token" } }
        /// Waits for the move's delete, which follows its answer.
        func settle() { usleep(50_000) }

        // A fresh install: no file, no item.
        do {
            let legacy = SYFakeLegacy(errSecItemNotFound)
            let (s, f) = store(legacy)
            check(get(s) == .noToken, "token: a fresh install (no file, no item) → none")
            check(legacy.reads == 1 && !FileManager.default.fileExists(atPath: f.url.path), "token: a fresh install asks the item once and writes nothing")
        }

        // The move: the old item read once, written to the file (0600, folder 0700), then deleted.
        do {
            let legacy = SYFakeLegacy(errSecSuccess, "syd_OLDitem0123456789")
            var read: [String] = []
            let (s, f) = store(legacy, folderMode: 0o755)
            s.onRead = { read.append($0) }
            let a = get(s)
            check(a == .ready("syd_OLDitem0123456789", from: "keychain"), "token: an old item → ready, from the Keychain", "\(String(describing: a))")
            settle()
            check(contents(f) == "syd_OLDitem0123456789", "token: the old item's token is now the file's")
            check(mode(f.url.path) == 0o600, "token: the file is 0600", SYTokenFile.octal(mode(f.url.path)))
            check(mode(f.dir.path) == 0o700, "token: its folder (Exact's, 0755) is tightened to 0700", SYTokenFile.octal(mode(f.dir.path)))
            check(legacy.deletes == 1 && legacy.value == nil, "token: the Keychain item is deleted after the move")
            check(leftovers(f).isEmpty, "token: no temp file is left beside it", leftovers(f).joined(separator: " "))
            check(read == ["syd_OLDitem0123456789"], "token: the read is handed to the kept-answer scrub")
            // The next launch: the file, and the Keychain is never asked again.
            let next = SYTokenStore(file: f, legacy: legacy, agent: false)
            next.log = { _ in }
            check(get(next) == .ready("syd_OLDitem0123456789", from: "file") && legacy.reads == 1, "token: the next launch reads the file only, never the Keychain")
        }

        // Denied (Deny, Cancel, no UI) and other failures: nothing written, nothing deleted.
        for (status, want) in [(errSecAuthFailed, "denied"), (errSecUserCanceled, "denied"), (errSecInteractionNotAllowed, "denied"), (OSStatus(-60008), "denied"), (OSStatus(-60005), "denied"), (errSecMissingEntitlement, "error"), (errSecDecode, "error")] {
            let legacy = SYFakeLegacy(status, "syd_OLDitem0123456789")
            let (s, f) = store(legacy)
            let a = get(s)
            check(a?.status == want && a?.token == "" && !(a?.detail.isEmpty ?? true), "token: Keychain \(status) → \(want), with why", "\(String(describing: a))")
            check(!FileManager.default.fileExists(atPath: f.url.path) && legacy.deletes == 0, "token: Keychain \(status) → no file, the item kept")
            check(!(a?.json.description.contains("syd_OLD") ?? true), "token: a \(want) answer never holds the token")
        }

        // Save: atomic, 0600, trimmed; replaces; forget removes the file and the item.
        do {
            let legacy = SYFakeLegacy(errSecSuccess, "syd_OLDitem0123456789")
            let (s, f) = store(legacy, folderMode: 0o755)
            check(op { s.set(["token": "syd_NEWtoken012345\n"], done: $0) }?["ok"] as? Bool == true, "token: set → ok")
            check(contents(f) == "syd_NEWtoken012345" && mode(f.url.path) == 0o600 && mode(f.dir.path) == 0o700, "token: set writes the trimmed token, 0600 in a 0700 folder")
            check(get(s) == .ready("syd_NEWtoken012345", from: "file") && legacy.reads == 0, "token: with a file, the old item is never read")
            check(op { s.set(["token": "syd_THIRDtoken0123"], done: $0) }?["ok"] as? Bool == true && contents(f) == "syd_THIRDtoken0123", "token: set again replaces it")
            check(leftovers(f).isEmpty, "token: sets leave no temp file")
            let blank = op { s.set(["token": "  \n"], done: $0) }
            check(blank?["ok"] as? Bool == false && contents(f) == "syd_THIRDtoken0123", "token: a blank set is refused and keeps the file")
            check(op { s.forget([:], done: $0) }?["ok"] as? Bool == true, "token: forget → ok")
            check(!FileManager.default.fileExists(atPath: f.url.path) && legacy.deletes == 1, "token: forget removes the file and the old item")
            check(get(s) == .noToken, "token: after forget → none")
        }

        // A save while the prompt waits wins; the item still goes.
        do {
            let legacy = SYFakeLegacy(errSecSuccess, "syd_OLDitem0123456789")
            legacy.gate = DispatchSemaphore(value: 0)
            let (s, f) = store(legacy)
            let done = DispatchSemaphore(value: 0)
            var a: SYTokenAnswer?
            s.get([:]) { a = $0; done.signal() }
            usleep(50_000)
            let saved = op { s.set(["token": "syd_TYPEDwhileWaiting1"], done: $0) }
            check(saved?["ok"] as? Bool == true, "token: a save is not held behind a waiting prompt")
            legacy.gate?.signal()
            _ = done.wait(timeout: .now() + 5)
            settle()
            check(a == .ready("syd_TYPEDwhileWaiting1", from: "file"), "token: the token saved while the prompt waited wins", "\(String(describing: a))")
            check(contents(f) == "syd_TYPEDwhileWaiting1" && legacy.deletes == 1, "token: the file keeps the saved token; the item is deleted")
        }

        // A file this app would not have written: refused, naming the mode, never the token.
        do {
            let legacy = SYFakeLegacy(errSecSuccess, "syd_OLDitem0123456789")
            let (s, f) = store(legacy)
            try? FileManager.default.createDirectory(at: f.dir, withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: f.url.path, contents: Data("syd_WIDEfile01234567".utf8))
            chmod(f.url.path, 0o644)
            let a = get(s)
            check(a?.status == "error" && a?.detail.contains("not 0600") == true && !(a?.detail.contains("syd_WIDE") ?? true), "token: a 0644 file → error naming the mode, not the token", "\(String(describing: a))")
            check(legacy.reads == 0, "token: a refused file never falls back to the Keychain")
            check(op { s.set(["token": "syd_FIXEDfile0123456"], done: $0) }?["ok"] as? Bool == true && mode(f.url.path) == 0o600, "token: a save replaces it with a 0600 file")
        }

        // The agent: no Keychain; its hook answers denied.
        do {
            let (s, f) = store(nil, agent: true)
            check(get(s) == .noToken, "token: under the agent with no file → none (no Keychain)")
            check(get(s, ["simulate": "denied"])?.status == "denied", "token: the agent's hook simulate=denied → denied")
            let (real, _) = store(SYFakeLegacy(errSecItemNotFound), agent: false)
            check(get(real, ["simulate": "denied"]) == .noToken, "token: the hook does nothing outside the agent")
            _ = f
        }

        // Wording.
        check(SYKeychainStatus.of(errSecItemNotFound) == .noToken, "token: errSecItemNotFound → none")
        check(SYKeychainStatus.of(errSecAuthFailed).status == "denied", "token: errSecAuthFailed (Deny) → denied")
        check(SYKeychainStatus.of(errSecAuthFailed).detail.contains("-25293"), "token: the detail names the OSStatus")
        check(SYTokenAnswer.ready("t0k", from: "file").json["token"] as? String == "t0k" && SYTokenAnswer(status: "denied", detail: "x").json["token"] == nil, "token: only a ready answer carries the token")
    }
}
#endif
