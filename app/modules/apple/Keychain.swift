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

    static let noToken = SYTokenAnswer(status: "none")
    static func ready(_ token: String, from source: String, detail: String = "") -> SYTokenAnswer {
        SYTokenAnswer(status: "ready", token: token, detail: detail, source: source)
    }

    var json: [String: Any] {
        var out: [String: Any] = ["status": status]
        if status == "ready" { out["token"] = token; out["source"] = source }
        if !detail.isEmpty { out["detail"] = detail }
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
        if case .failure(let why) = folder() { return .failure(why) }
        let tmp = dir.appendingPathComponent(".token.\(getpid()).\(UInt32.random(in: 0 ... .max))", isDirectory: false).path
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
        guard ok, rename(tmp, url.path) == 0 else {
            let reason = ok ? String(cString: strerror(errno)) : why
            unlink(tmp)
            return .failure(SYHookRefusal("cannot write \(url.path): \(reason)"))
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
    /// The agent's test hook: `simulate: "denied"` answers denied (tests/token.test.contract).
    let agent: Bool
    /// Told each token read, for the kept-answer scrub (SYKeptScrub with the token's value).
    var onRead: (String) -> Void = { _ in }
    var log: (String) -> Void = { SYHookLog.line($0) }
    private let files = DispatchQueue(label: "com.exowatt.switchyard.token.file", qos: .userInitiated)
    private let keychain = DispatchQueue(label: "com.exowatt.switchyard.token.keychain", qos: .userInitiated)

    init(file: SYTokenFileStore, legacy: SYLegacyToken?, agent: Bool) {
        self.file = file
        self.legacy = legacy
        self.agent = agent
    }

    /// The token: the file's; with no file, the old Keychain item's, moved to the file.
    func get(_ request: [String: Any], done: @escaping (SYTokenAnswer) -> Void) {
        if agent, request["simulate"] as? String == "denied" {
            files.async { done(SYTokenAnswer(status: "denied", detail: "denied by the test hook (agent only)")) }
            return
        }
        files.async { [self] in
            switch file.read() {
            case .success(let token?): onRead(token); return done(.ready(token, from: "file"))
            case .failure(let why): log("token: refused \(why.reason)"); return done(SYTokenAnswer(status: "error", detail: why.reason))
            case .success(nil): break
            }
            guard let legacy else { return done(.noToken) }
            keychain.async { [self] in migrate(legacy, done: done) }
        }
    }

    /// On `keychain`: one read of the old item (it may wait on the prompt); a success goes to the
    /// file, answers, then deletes the item.
    private func migrate(_ legacy: SYLegacyToken, done: @escaping (SYTokenAnswer) -> Void) {
        // A read before this one may have moved it already, or a save made the file meanwhile.
        if case .success(let token?) = files.sync(execute: { file.read() }) { onRead(token); return done(.ready(token, from: "file")) }
        let t0 = Date()
        let (status, value) = legacy.read()
        let ms = Int(Date().timeIntervalSince(t0) * 1000)
        guard status == errSecSuccess, let raw = value else {
            if status != errSecItemNotFound { log("token: the Keychain item was not read in \(ms) ms: \(SYKeychainStatus.message(status))") }
            return done(SYKeychainStatus.of(status))
        }
        let token = SYTokenFile.trim(raw)
        guard !token.isEmpty else { return done(.noToken) }
        // A token saved while the prompt waited is the newer one: it stays, and the item still goes.
        let answer: SYTokenAnswer = files.sync {
            if case .success(let newer?) = file.read() { return .ready(newer, from: "file") }
            switch file.write(token) {
            case .success:
                log("token: read the Keychain item in \(ms) ms and moved it to \(file.url.path)")
                return .ready(token, from: "keychain")
            case .failure(let why):
                // Used for this launch; the next one reads the item again.
                log("token: read the Keychain item in \(ms) ms; not moved: \(why.reason)")
                return .ready(token, from: "keychain", detail: why.reason)
            }
        }
        onRead(answer.token)
        done(answer)
        guard answer.detail.isEmpty else { return }
        let gone = legacy.delete()
        log(gone == errSecSuccess || gone == errSecItemNotFound
            ? "token: deleted the Keychain item; the token lives only in \(file.url.path)"
            : "token: the Keychain item stays (\(SYKeychainStatus.message(gone)))")
    }

    /// Keep `token` in the file. Answers `{ok}` or `{ok: false, detail}`.
    func set(_ request: [String: Any], done: @escaping ([String: Any]) -> Void) {
        let token = request["token"] as? String ?? ""
        files.async { [self] in
            switch file.write(token) {
            case .success: done(["ok": true])
            case .failure(let why): log("token: not saved: \(why.reason)"); done(["ok": false, "detail": why.reason])
            }
        }
    }

    /// The file gone, and the old item with it (else the next launch would move it back).
    func forget(_ request: [String: Any], done: @escaping ([String: Any]) -> Void) {
        files.async { [self] in
            let removed = file.remove()
            guard let legacy else {
                if case .failure(let why) = removed { return done(["ok": false, "detail": why.reason]) }
                return done(["ok": true])
            }
            keychain.async {
                let gone = legacy.delete()
                if case .failure(let why) = removed { return done(["ok": false, "detail": why.reason]) }
                if gone != errSecSuccess && gone != errSecItemNotFound { return done(["ok": false, "detail": SYKeychainStatus.message(gone)]) }
                done(["ok": true])
            }
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
            let file = context.agent ? SYTokenFileStore(dir: context.data) : (SYTokenFileStore.app(id) ?? SYTokenFileStore(dir: context.data))
            let s = SYTokenStore(file: file, legacy: context.agent ? nil : SYKeychainItem(service: id), agent: context.agent)
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
