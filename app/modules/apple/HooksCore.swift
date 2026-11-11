// The test hooks' pure logic (README "Test hooks"): reading SWITCHYARD_TOKEN_FILE and parsing
// SWITCHYARD_SNAPSHOT. Foundation only, no Exact and no AppKit, so tools/updater-tests.sh
// compiles it into its CLI with HooksTests.swift. Hooks.swift is the module side.

import Foundation

/// Why a hook did nothing: one line, logged as `<hook>: failed <reason>`. Never holds a token.
struct SYHookRefusal: Error, Equatable, CustomStringConvertible {
    let reason: String
    init(_ reason: String) { self.reason = reason }
    var description: String { reason }
}

/// SWITCHYARD_TOKEN_FILE=<path>: a device token in a file only its owner may read or write.
enum SYTokenFile {
    static let env = "SWITCHYARD_TOKEN_FILE"
    /// A device token is short; anything bigger is not one.
    static let maxBytes = 4096

    /// The token in `path`, trimmed: refused unless the path is absolute, the file is a regular
    /// file (a symlink to one is followed), owned by `uid`, mode exactly 0600, at most 4 KiB, UTF-8
    /// and not empty once trimmed. The reasons name the path and the mode, never the contents.
    static func read(_ path: String, uid: uid_t = getuid()) -> Result<String, SYHookRefusal> {
        guard !path.isEmpty else { return .failure(SYHookRefusal("\(env) is empty")) }
        guard path.hasPrefix("/") else { return .failure(SYHookRefusal("\(path) is not an absolute path")) }
        var st = stat()
        guard stat(path, &st) == 0 else {
            let e = errno
            return .failure(SYHookRefusal(e == ENOENT ? "no such file \(path)" : "cannot stat \(path): \(String(cString: strerror(e)))"))
        }
        guard st.st_mode & S_IFMT == S_IFREG else { return .failure(SYHookRefusal("\(path) is not a regular file")) }
        let mode = st.st_mode & 0o7777
        guard mode == 0o600 else {
            return .failure(SYHookRefusal("\(path) has mode \(octal(mode)), not 0600 (chmod 600 \(path))"))
        }
        guard st.st_uid == uid else { return .failure(SYHookRefusal("\(path) is owned by uid \(st.st_uid), not this user (\(uid))")) }
        guard Int(st.st_size) <= maxBytes else { return .failure(SYHookRefusal("\(path) is \(st.st_size) bytes; a token is at most \(maxBytes)")) }
        let data: Data
        do { data = try Data(contentsOf: URL(fileURLWithPath: path)) } catch {
            return .failure(SYHookRefusal("cannot read \(path): \(error.localizedDescription)"))
        }
        guard let text = String(data: data, encoding: .utf8) else { return .failure(SYHookRefusal("\(path) is not UTF-8 text")) }
        let token = trim(text)
        guard !token.isEmpty else { return .failure(SYHookRefusal("\(path) holds no token")) }
        return .success(token)
    }

    /// Whitespace and newlines off both ends (`echo token > file` leaves a newline; CRLF too).
    static func trim(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    static func octal(_ mode: mode_t) -> String {
        let s = String(mode, radix: 8)
        return String(repeating: "0", count: max(0, 4 - s.count)) + s
    }
}

/// SWITCHYARD_SNAPSHOT=<png>[:<seconds>]: the main window, drawn to `path` `seconds` after launch.
struct SYSnapshotArg: Equatable {
    static let env = "SWITCHYARD_SNAPSHOT"
    static let defaultSeconds = 8.0
    static let maxSeconds = 3600.0
    let path: String
    let seconds: Double

    /// `/tmp/a.png` (8 s), `/tmp/a.png:10`, `/tmp/a.png:2.5`, `/tmp/a.png:` (8 s). The seconds are
    /// what follows the last colon when it is a plain number (`/tmp/a:b.png` is all path); a
    /// number that is negative, not finite or over an hour is refused. The path must be absolute.
    static func parse(_ raw: String) -> Result<SYSnapshotArg, SYHookRefusal> {
        let text = raw.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return .failure(SYHookRefusal("\(env) is empty")) }
        var path = text
        var seconds = defaultSeconds
        if let colon = text.lastIndex(of: ":") {
            let tail = String(text[text.index(after: colon)...])
            let head = String(text[..<colon])
            if tail.isEmpty {
                path = head
            } else if tail.range(of: #"^[+-]?[0-9]+(\.[0-9]*)?$|^[+-]?\.[0-9]+$"#, options: .regularExpression) != nil {
                guard let s = Double(tail), s.isFinite, s >= 0, s <= maxSeconds else {
                    return .failure(SYHookRefusal("\(tail) is not a number of seconds from 0 to \(Int(maxSeconds))"))
                }
                path = head
                seconds = s
            }
        }
        guard !path.isEmpty else { return .failure(SYHookRefusal("\(env) names no file")) }
        guard path.hasPrefix("/") else { return .failure(SYHookRefusal("\(path) is not an absolute path")) }
        guard !path.hasSuffix("/") else { return .failure(SYHookRefusal("\(path) is a directory, not a PNG's path")) }
        return .success(SYSnapshotArg(path: path, seconds: seconds))
    }
}

/// The hooks' lines: stderr and ~/Library/Logs/Switchyard/switchyard.log (made if missing), the
/// way the updater keeps update.log. Lines never carry a token.
enum SYHookLog {
    static let name = "switchyard.log"
    static let url: URL? = {
        guard let lib = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first else { return nil }
        let dir = lib.appendingPathComponent("Logs/Switchyard", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent(name)
    }()
    private static let lock = NSLock()

    static func line(_ text: String) {
        FileHandle.standardError.write(Data("[switchyard] \(text)\n".utf8))
        guard let url else { return }
        let stamp = ISO8601DateFormatter().string(from: Date())
        let data = Data("\(stamp) pid \(getpid()) \(text)\n".utf8)
        lock.lock()
        defer { lock.unlock() }
        if let h = try? FileHandle(forWritingTo: url) {
            defer { try? h.close() }
            if let end = try? h.seekToEnd(), end > 1 << 20 { try? h.truncate(atOffset: 0) }
            try? h.write(contentsOf: data)
        } else {
            try? data.write(to: url)
        }
    }
}
