// The device token at rest (fx-kc; README "Security"): the module side of
// `native.later({op: "tokenGet" | "tokenSet" | "tokenForget"})`, one dispatch line each in
// Updater.swift.
//
// Why. Exact reads every `secret.keep` name synchronously before boot, on the main thread. An
// ad-hoc build is a new code identity each time, and with no Team ID a Keychain item's partition
// is the CDHash of the build that made it, so the next build's boot sat windowless in
// SecItemCopyMatching behind the item's prompt (0.1.2), and an "any application" access list
// does not help (the partition still prompts; fx-kc probe on the Mac mini, 2026-11-11). So the
// app keeps the token itself, in one file only this user can read:
//
//   ~/Library/Application Support/<bundle id>/token     mode 0600, its folder 0700
//
// written atomically (a 0600 temp file in the same folder, fsync, rename). A launch that finds
// no file reads the item older builds kept (Exact's attributes: a generic password, service the
// bundle id, account `switchyard.token`), once, off the main thread, with the window already
// up: macOS may ask once whether Switchyard may read it. When the read succeeds the token goes
// to the file and the item is deleted; after that the Keychain is never read again. Under the
// agent the file is in the drive's scratch data folder and the Keychain is never touched.
//
// Every op answers through `later` from a queue of its own; nothing here blocks the main thread,
// and no line logged or answered holds the token (only `tokenGet`'s `token` field does). The
// pure parts run in tools/updater-tests.sh with KeychainTests.swift (Foundation + Security, no
// Exact).

import Foundation
import Security

/// The account Exact used for `secret.keep switchyard.token`.
let syTokenAccount = "switchyard.token"

/// What `tokenGet` answers: `ready` (with `token`), `none`, `denied` or `error` (with `detail`).
struct SYTokenAnswer: Equatable {
    var status: String
    var token = ""
    var detail = ""
    /// Where a ready token came from: `file`, or `keychain` (moved to the file by this read).
    var source = ""
    /// The old Keychain item may still be there (its delete failed): Settings says so.
    var keychainLeft = false

    static let noToken = SYTokenAnswer(status: "none")
    static func ready(_ token: String, from source: String, detail: String = "") -> SYTokenAnswer {
        SYTokenAnswer(status: "ready", token: token, detail: detail, source: source)
    }

    var json: [String: Any] {
        var out: [String: Any] = ["status": status]
        if status == "ready" { out["token"] = token; out["source"] = source }
        if !detail.isEmpty { out["detail"] = detail }
        out["keychainLeft"] = keychainLeft
        return out
    }
}

/// A Keychain status as the app words it: the person said no (or could not be asked), or the
/// read failed.
enum SYKeychainStatus {
    static func of(_ status: OSStatus) -> SYTokenAnswer {
        switch status {
        case errSecSuccess: return .noToken
        case errSecItemNotFound: return .noToken
        // Deny, Cancel, or no way to ask (a locked keychain with no UI): the same remedy.
        case errSecAuthFailed, errSecUserCanceled, errSecInteractionNotAllowed, errSecNoAccessForItem,
             -60005 /* errAuthorizationDenied */, -60006 /* errAuthorizationCanceled */, -60008 /* errAuthorizationInternal: the prompt went away */:
            return SYTokenAnswer(status: "denied", detail: message(status))
        default:
            return SYTokenAnswer(status: "error", detail: message(status))
        }
    }

    static func message(_ status: OSStatus) -> String {
        let text = (SecCopyErrorMessageString(status, nil) as String?) ?? ""
        return text.isEmpty ? "OSStatus \(status)" : "\(text) (OSStatus \(status))"
    }
}

/// The item older builds kept, behind a seam: the real Keychain, or a test's.
protocol SYLegacyToken: AnyObject {
    /// The item's value, or the status that kept it (errSecItemNotFound: none). May wait on
    /// macOS's prompt; never called on the main thread.
    func read() -> (OSStatus, String?)
    /// errSecSuccess or errSecItemNotFound when it is gone.
    func delete() -> OSStatus
}

/// Exact's own item (vendor/ibex/crates/ibex2/src/secrets/darwin_keychain.mm `query_for`): a
/// generic password, service the app's identity (the bundle id), account the secret's name,
/// plus the access group a provisioned build names. The same query finds what Exact wrote.
final class SYKeychainItem: SYLegacyToken {
    let service: String
    init(service: String) { self.service = service }

    /// Exact's `app_identity()`: the bundle id, else the executable's name.
    static func appIdentity(_ bundle: Bundle = .main) -> String {
        if let id = bundle.bundleIdentifier, !id.isEmpty { return id }
        return URL(fileURLWithPath: CommandLine.arguments.first ?? "ibex2").lastPathComponent
    }

    var query: [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: syTokenAccount,
        ]
        let info = Bundle.main.infoDictionary ?? [:]
        if let group = info["ExactKeychainAccessGroup"] as? String, !group.isEmpty,
           (info["ExactAppIdentifier"] as? String) == service {
            q[kSecAttrAccessGroup as String] = group
            q[kSecUseDataProtectionKeychain as String] = true
        }
        return q
    }

    func read() -> (OSStatus, String?) {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        guard status == errSecSuccess else { return (status, nil) }
        guard let data = out as? Data, let text = String(data: data, encoding: .utf8) else { return (errSecDecode, nil) }
        return (status, text)
    }

    func delete() -> OSStatus { SecItemDelete(query as CFDictionary) }
}

/// The token file: `<dir>/token`, mode 0600, `dir` 0700.
struct SYTokenFileStore {
    let dir: URL
    var url: URL { dir.appendingPathComponent("token", isDirectory: false) }

    /// The real app's: ~/Library/Application Support/<bundle id>.
    static func app(_ id: String) -> SYTokenFileStore? {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        return SYTokenFileStore(dir: support.appendingPathComponent(id, isDirectory: true))
    }

    /// The token, nil when there is no file; refused (never naming the contents) unless the file
    /// is this user's regular file, mode 0600, at most 4 KiB of UTF-8 (SYTokenFile's checks).
    func read() -> Result<String?, SYHookRefusal> {
        var st = stat()
        if lstat(url.path, &st) != 0 {
            let e = errno
            return e == ENOENT ? .success(nil) : .failure(SYHookRefusal("cannot stat \(url.path): \(String(cString: strerror(e)))"))
        }
        guard st.st_mode & S_IFMT == S_IFREG else { return .failure(SYHookRefusal("\(url.path) is not a regular file")) }
        switch SYTokenFile.read(url.path) {
        case .success(let token): return .success(token)
        case .failure(let why): return .failure(why)
        }
    }

    /// Keep `token` (trimmed): the folder made 0700 (or tightened to it), then a 0600 temp file
    /// beside the token, written, synced and renamed over it, so a reader sees the old token or
    /// the new one, never part of one.
    func write(_ raw: String) -> Result<Void, SYHookRefusal> {
        let token = SYTokenFile.trim(raw)
        guard !token.isEmpty else { return .failure(SYHookRefusal("no token to keep")) }
        let bytes = Array(token.utf8)
        guard bytes.count <= SYTokenFile.maxBytes else { return .failure(SYHookRefusal("a token is at most \(SYTokenFile.maxBytes) bytes")) }
        return put(bytes, at: url)
    }

    // The two marks beside the token, each a 0600 file of one line:
    /// `migrated`: the old Keychain item was dealt with (moved, absent, replaced or forgotten);
    /// once it is there the Keychain is never read again, whatever else happens.
    var migratedURL: URL { dir.appendingPathComponent("migrated", isDirectory: false) }
    /// `keychain-left`: deleting the old item failed (another build owns it), so it may still be
    /// there; Settings says so until a delete succeeds.
    var leftURL: URL { dir.appendingPathComponent("keychain-left", isDirectory: false) }
    var migrated: Bool { FileManager.default.fileExists(atPath: migratedURL.path) }
    var left: Bool { FileManager.default.fileExists(atPath: leftURL.path) }
    @discardableResult func markMigrated() -> Result<Void, SYHookRefusal> { migrated ? .success(()) : put(Array("migrated=1\n".utf8), at: migratedURL) }
    @discardableResult func markLeft(_ on: Bool) -> Result<Void, SYHookRefusal> {
        if on { return left ? .success(()) : put(Array("keychain-left=1\n".utf8), at: leftURL) }
        if unlink(leftURL.path) == 0 || errno == ENOENT { return .success(()) }
        return .failure(SYHookRefusal("cannot delete \(leftURL.path): \(String(cString: strerror(errno)))"))
    }

    /// `bytes` to `target` atomically: a 0600 temp file in the folder, synced, renamed over it.
    private func put(_ bytes: [UInt8], at target: URL) -> Result<Void, SYHookRefusal> {
        if case .failure(let why) = folder() { return .failure(why) }
        let tmp = dir.appendingPathComponent(".\(target.lastPathComponent).\(getpid()).\(UInt32.random(in: 0 ... .max))", isDirectory: false).path
        let fd = open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { return .failure(SYHookRefusal("cannot create \(tmp): \(String(cString: strerror(errno)))")) }
        var ok = fchmod(fd, 0o600) == 0
        var written = 0
        while ok && written < bytes.count {
            let n = bytes[written...].withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
            if n <= 0 { ok = false } else { written += n }
        }
        ok = ok && fsync(fd) == 0
        let why = ok ? "" : String(cString: strerror(errno))
        close(fd)
        guard ok, rename(tmp, target.path) == 0 else {
            let reason = ok ? String(cString: strerror(errno)) : why
            unlink(tmp)
            return .failure(SYHookRefusal("cannot write \(target.path): \(reason)"))
        }
        return .success(())
    }

    /// The file gone (no file: done too).
    func remove() -> Result<Void, SYHookRefusal> {
        if unlink(url.path) == 0 || errno == ENOENT { return .success(()) }
        return .failure(SYHookRefusal("cannot delete \(url.path): \(String(cString: strerror(errno)))"))
    }

    /// The folder: made 0700, or an existing one (Exact's own app folder, 0755) tightened to it.
    private func folder() -> Result<Void, SYHookRefusal> {
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        } catch {
            return .failure(SYHookRefusal("cannot make \(dir.path): \(error.localizedDescription)"))
        }
        var st = stat()
        guard lstat(dir.path, &st) == 0, st.st_mode & S_IFMT == S_IFDIR else { return .failure(SYHookRefusal("\(dir.path) is not a folder")) }
        guard st.st_uid == getuid() else { return .failure(SYHookRefusal("\(dir.path) is not this user's")) }
        if st.st_mode & 0o7777 != 0o700, chmod(dir.path, 0o700) != 0 {
            return .failure(SYHookRefusal("cannot make \(dir.path) 0700: \(String(cString: strerror(errno)))"))
        }
        return .success(())
    }
}

/// The three ops. File work runs on `files`, the Keychain's on `keychain`, so a save never waits
/// behind a read that waits on macOS's prompt.
final class SYTokenStore: @unchecked Sendable {
    let file: SYTokenFileStore
    /// The item older builds kept; nil under the agent (and in a store that has none).
    let legacy: SYLegacyToken?
    /// The agent's test hooks (tests/token.test.contract): `simulate: "denied"` answers denied;
    /// `simulate: "left"` answers as ever, saying the old item was left (Settings' note).
    let agent: Bool
    /// Told each token read, for the kept-answer scrub (SYKeptScrub with the token's value).
    var onRead: (String) -> Void = { _ in }
    var log: (String) -> Void = { SYHookLog.line($0) }
    private let files = DispatchQueue(label: "com.exowatt.switchyard.token.file", qos: .userInitiated)
    private let keychain = DispatchQueue(label: "com.exowatt.switchyard.token.keychain", qos: .userInitiated)
    /// Deletes of the old item (never a prompt) beside a read that may be waiting on one.
    private let deletes = DispatchQueue(label: "com.exowatt.switchyard.token.delete", qos: .utility)
    /// On `files`: the answers waiting for the one read of the old item in flight. A `tokenGet`
    /// asked again meanwhile (its first asker was let go) waits for that read: one prompt, not two.
    private var reading: [(SYTokenAnswer) -> Void]?

    init(file: SYTokenFileStore, legacy: SYLegacyToken?, agent: Bool) {
        self.file = file
        self.legacy = legacy
        self.agent = agent
    }

    /// The token: the file's; with no file, and only before the old item was ever dealt with
    /// (`migrated`), the old Keychain item's, moved to the file.
    func get(_ request: [String: Any], done: @escaping (SYTokenAnswer) -> Void) {
        if agent, request["simulate"] as? String == "denied" {
            files.async { done(SYTokenAnswer(status: "denied", detail: "denied by the test hook (agent only)")) }
            return
        }
        if agent, request["simulate"] as? String == "left" {
            return get([:]) { a in var a = a; a.keychainLeft = true; done(a) }
        }
        files.async { [self] in
            if let answer = fromFile() { return done(answer) }
            // The mark is checked before any SecItem call: after the move, never again.
            guard let legacy, !file.migrated else { return done(with(.noToken)) }
            if reading != nil { reading?.append(done); return }
            reading = [done]
            keychain.async { [self] in
                migrate(legacy) { [self] answer in
                    files.async { [self] in
                        let waiting = reading ?? []
                        reading = nil
                        waiting.forEach { $0(answer) }
                    }
                }
            }
        }
    }

    /// On `files`: the file's answer, or nil when there is no file.
    private func fromFile() -> SYTokenAnswer? {
        switch file.read() {
        case .success(let token?): onRead(token); return with(.ready(token, from: "file"))
        case .failure(let why): log("token: refused \(why.reason)"); return with(SYTokenAnswer(status: "error", detail: why.reason))
        case .success(nil): return nil
        }
    }

    private func with(_ a: SYTokenAnswer) -> SYTokenAnswer { var a = a; a.keychainLeft = file.left; return a }

    private var service: String { (legacy as? SYKeychainItem)?.service ?? "the app's id" }

    /// On `keychain`: one read of the old item (it may wait on the prompt). A success goes to the
    /// file, is marked migrated, and the item is deleted where macOS lets it; then the answer.
    private func migrate(_ legacy: SYLegacyToken, done: @escaping (SYTokenAnswer) -> Void) {
        // A read before this one may have moved it already, or a save made the file meanwhile.
        if let early: SYTokenAnswer = files.sync(execute: { fromFile() ?? (file.migrated ? with(.noToken) : nil) }) { return done(early) }
        let t0 = Date()
        let (status, value) = legacy.read()
        let ms = Int(Date().timeIntervalSince(t0) * 1000)
        let token = SYTokenFile.trim(value ?? "")
        // What the read found, with what happened while it waited, settled in one turn of `files`:
        // the answer, and whether the item is deleted now.
        let (answer, drop): (SYTokenAnswer, Bool) = files.sync {
            // A token saved while the prompt waited is the newer one: it stands, whatever the read
            // said (its save marked migrated and tried the delete).
            if let newer = fromFile() { return (newer, false) }
            // Signed out while the prompt waited (Forget token marks migrated and tries the
            // delete): what the read found is dropped, never written back.
            if file.migrated { return (with(.noToken), false) }
            guard status == errSecSuccess, !token.isEmpty else {
                if status == errSecSuccess || status == errSecItemNotFound {
                    // nothing to move: the Keychain is not asked again
                    _ = file.markMigrated()
                    return (with(.noToken), false)
                }
                // Denied or failed: not marked, so Try again (or the next launch) reads again.
                log("keychain: the old item was not read in \(ms) ms: \(SYKeychainStatus.message(status))")
                return (with(SYKeychainStatus.of(status)), false)
            }
            switch file.write(token) {
            case .success:
                _ = file.markMigrated()
                log("keychain: read the old item in \(ms) ms and moved it to \(file.url.path)")
                return (.ready(token, from: "keychain"), true)
            case .failure(let why):
                // Used for this launch; the next one reads the item again.
                log("keychain: read the old item in \(ms) ms; not moved: \(why.reason)")
                return (.ready(token, from: "keychain", detail: why.reason), false)
            }
        }
        if answer.source == "keychain" { onRead(answer.token) }
        if drop { dropLegacy(legacy) }
        var a = answer
        a.keychainLeft = files.sync { file.left }
        done(a)
    }

    /// On `keychain`: delete the old item. macOS lets only the build that made an item delete it
    /// (another identity gets -25244, errSecInvalidOwnerEdit, at once, with no prompt), so an
    /// older build's item usually stays: that is remembered (`keychain-left`, for Settings) and
    /// logged once; a delete that works clears it.
    private func dropLegacy(_ legacy: SYLegacyToken) {
        let gone = legacy.delete()
        let ok = gone == errSecSuccess || gone == errSecItemNotFound
        let was: Bool = files.sync { let was = file.left; _ = file.markLeft(!ok); return was }
        if ok {
            if gone == errSecSuccess || was { log("keychain: deleted the old item (service \"\(service)\", account \"\(syTokenAccount)\")") }
        } else if !was {
            log("keychain: old item left (owned by an earlier build); not read again (\(SYKeychainStatus.message(gone)); delete \"\(syTokenAccount)\" under \"\(service)\" in Keychain Access)")
        }
    }

    /// Keep `token` in the file. Before the old item was dealt with, it goes too (a delete, never
    /// a read, on `deletes`, so never behind a read that waits on the prompt), and the Keychain is
    /// not read again. Answers `{ok, keychainLeft}` or `{ok: false, detail}`, after that delete.
    func set(_ request: [String: Any], done: @escaping ([String: Any]) -> Void) {
        let token = request["token"] as? String ?? ""
        files.async { [self] in
            if case .failure(let why) = file.write(token) {
                log("token: not saved: \(why.reason)")
                return done(["ok": false, "detail": why.reason, "keychainLeft": file.left])
            }
            let first = legacy != nil && !file.migrated
            if first { _ = file.markMigrated() }
            guard first, let legacy else { return done(["ok": true, "keychainLeft": file.left]) }
            deletes.async { [self] in
                dropLegacy(legacy)
                done(["ok": true, "keychainLeft": files.sync { file.left }])
            }
        }
    }

    /// Sign out: the file gone, and a delete of the old item tried (never a read); `migrated`
    /// stays, so a delete that fails never makes the app read the Keychain again.
    func forget(_ request: [String: Any], done: @escaping ([String: Any]) -> Void) {
        files.async { [self] in
            let removed = file.remove()
            if legacy != nil { _ = file.markMigrated() }
            let finish = { [self] in
                let left = files.sync { file.left }
                if case .failure(let why) = removed { return done(["ok": false, "detail": why.reason, "keychainLeft": left]) }
                done(["ok": true, "keychainLeft": left])
            }
            guard let legacy else { return finish() }
            deletes.async { [self] in dropLegacy(legacy); finish() }
        }
    }
}

#if !SWITCHYARD_UPDATER_TESTS
/// The module's store, made at the first op: the real file and item, or under the agent the
/// drive's scratch data folder and no Keychain at all.
enum SYToken {
    private static let lock = NSLock()
    private static var made: SYTokenStore?

    static func store(_ context: ExactModuleContext) -> SYTokenStore {
        lock.withLock {
            if let made { return made }
            let id = SYKeychainItem.appIdentity()
            // As Exact's own stores: under the agent a scratch store and no Keychain, unless the
            // drive asks for the platform's (EXACT_STORE=real).
            let scratch = context.agent && ProcessInfo.processInfo.environment["EXACT_STORE"] != "real"
            let file = scratch ? SYTokenFileStore(dir: context.data) : (SYTokenFileStore.app(id) ?? SYTokenFileStore(dir: context.data))
            let s = SYTokenStore(file: file, legacy: scratch ? nil : SYKeychainItem(service: id), agent: context.agent)
            // The kept-answer scrub (f3ab409) with the stored token's value, as loadToken's
            // native.call once did: older builds' kept answers holding it are deleted.
            s.onRead = { token in _ = SYHooks.shared.scrub(["token": token]) }
            made = s
            return s
        }
    }

    static func get(_ request: [String: Any], _ context: ExactModuleContext, reply: ExactReply) {
        store(context).get(request) { reply.send($0.json) }
    }
    static func set(_ request: [String: Any], _ context: ExactModuleContext, reply: ExactReply) {
        store(context).set(request) { reply.send($0) }
    }
    static func forget(_ request: [String: Any], _ context: ExactModuleContext, reply: ExactReply) {
        store(context).forget(request) { reply.send($0) }
    }
}
#endif
