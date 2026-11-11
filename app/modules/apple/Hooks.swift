// The test hooks (README "Test hooks"), env only, in every build, release included: what a
// fresh-install proof needs from a copy with no agent channel and no Screen Recording grant.
//
//   SWITCHYARD_TOKEN_FILE=<path>   the device token, read once at launch from a 0600 file. The
//                                  data module takes it once (`native.call({op:"tokenFile"})`),
//                                  through the switchyard:// link's path (parseLink, then
//                                  connectTokenFile: the Keychain and the stored server), with
//                                  no confirm sheet, and says how the connect went
//                                  (`native.call({op:"tokenFileResult"})`).
//   SWITCHYARD_SNAPSHOT=<png>[:s]  the main window drawn to a PNG s seconds (default 8) after
//                                  launch, the way the agent's `screenshot` draws it.
//
// Lines go to stderr and ~/Library/Logs/Switchyard/switchyard.log (SYHookLog). The pure parts
// are HooksCore.swift (tested by tools/updater-tests.sh); this file is the module side.

import Foundation
import IOSurface
import QuartzCore
#if canImport(AppKit)
import AppKit
#endif

final class SYHooks {
    static let shared = SYHooks()

    private let lock = NSLock()
    private var started = false
    private weak var context: ExactModuleContext?
    /// The token file's answer until the data module takes it; then nil (it is handed over once).
    private var pending: (server: String, token: String)?
    private var tokenFile = "none"

    /// Once per process, on the main thread (the module's init).
    func start(_ context: ExactModuleContext) {
        let first = lock.withLock { () -> Bool in
            defer { started = true }
            if self.context == nil { self.context = context }
            return !started
        }
        guard first else { return }
        let env = ProcessInfo.processInfo.environment
        if let path = env[SYTokenFile.env] {
            switch SYTokenFile.read(path) {
            case .success(let token):
                let server = (env["SWITCHYARD_SERVER"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                lock.withLock { pending = (server, token); tokenFile = "ready" }
                SYHookLog.line("token-file: read \(path); connecting to \(server.isEmpty ? "the built-in or stored server" : server)")
            case .failure(let why):
                lock.withLock { tokenFile = "failed" }
                SYHookLog.line("token-file: failed \(why)")
            }
        }
        if let raw = env[SYSnapshotArg.env] {
            switch SYSnapshotArg.parse(raw) {
            case .success(let arg):
                SYHookLog.line("snapshot: \(arg.path) in \(arg.seconds) s")
                DispatchQueue.main.asyncAfter(deadline: .now() + arg.seconds) { [self] in snapshot(arg, attempt: 0) }
            case .failure(let why):
                SYHookLog.line("snapshot: failed \(why)")
            }
        }
    }

    // MARK: the token file

    /// `{has, server, token}` the first time; `{has: false, state}` after (and with no file).
    func takeToken() -> [String: Any] {
        lock.withLock {
            guard let p = pending else { return ["has": false, "state": tokenFile] }
            pending = nil
            tokenFile = "taken"
            return ["has": true, "server": p.server, "token": p.token, "state": "ready"]
        }
    }

    /// What the data module says of the connect it made with the token (never the token).
    func report(_ request: [String: Any]) -> [String: Any] {
        let ok = request["ok"] as? Bool ?? false
        let server = SYTokenFile.trim(request["server"] as? String ?? "")
        let reason = SYTokenFile.trim(request["reason"] as? String ?? "")
        lock.withLock { tokenFile = ok ? "connected" : "failed" }
        SYHookLog.line(ok ? "token-file: connected \(server)" : "token-file: failed \(reason.isEmpty ? "?" : reason)")
        return ["ok": true]
    }

    // MARK: the snapshot

    private func snapshot(_ arg: SYSnapshotArg, attempt: Int) {
        #if canImport(AppKit)
        guard let view = mainView(), view.bounds.width >= 1, view.bounds.height >= 1 else {
            if attempt < 5 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [self] in snapshot(arg, attempt: attempt + 1) }
            } else {
                SYHookLog.line("snapshot: failed no window to draw after \(Int(arg.seconds) + attempt) s")
            }
            return
        }
        switch SYSnapshot.png(of: view) {
        case .failure(let why): SYHookLog.line("snapshot: failed \(why)")
        case .success(let (png, w, h)):
            do {
                let url = URL(fileURLWithPath: arg.path)
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try png.write(to: url, options: .atomic)
                SYHookLog.line("snapshot: \(arg.path) \(w)x\(h)")
            } catch {
                SYHookLog.line("snapshot: failed write \(arg.path): \(error.localizedDescription)")
            }
        }
        #else
        SYHookLog.line("snapshot: failed this platform has no window to draw")
        #endif
    }

    #if canImport(AppKit)
    /// The session's root view (what the agent's `screenshot` draws), else the main window's content.
    private func mainView() -> NSView? {
        if let v = lock.withLock({ context?.sessionView }) as? NSView, v.window != nil { return v }
        let windows = NSApp.windows.filter { $0.isVisible && $0.contentView != nil }
        return (NSApp.mainWindow ?? NSApp.keyWindow ?? windows.first)?.contentView
    }
    #endif
}

#if canImport(AppKit)
/// The view as the agent's `screenshot` (no `window`) draws it: Exact's `Capture.picture` is
/// `bitmapImageRepForCachingDisplay` + `cacheDisplay` into sRGB, and so is this. Exact's capture
/// is `package`, out of an app module's reach, so this adds the one thing it would otherwise
/// miss: a 2D canvas that animates is replayed on the GPU into an IOSurface its layer shows,
/// which `cacheDisplay` does not draw, so for the capture each such layer shows a CGImage copy
/// of its IOSurface, put back before the transaction commits. No window server picture
/// (CGWindowListCreateImage, screencapture): nothing here needs Screen Recording.
enum SYSnapshot {
    static func png(of view: NSView) -> Result<(Data, Int, Int), SYHookRefusal> {
        view.layoutSubtreeIfNeeded()
        view.displayIfNeeded()
        CATransaction.flush()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let undo = surfacesAsImages(in: view.layer)
        defer {
            undo()
            CATransaction.commit()
        }
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)?.retagging(with: .sRGB) else {
            return .failure(SYHookRefusal("no bitmap for a \(Int(view.bounds.width))x\(Int(view.bounds.height)) view"))
        }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { return .failure(SYHookRefusal("no PNG")) }
        return .success((png, rep.pixelsWide, rep.pixelsHigh))
    }

    /// Each layer under `root` whose contents is an IOSurface shows a CGImage of it; the closure
    /// puts the IOSurfaces back.
    static func surfacesAsImages(in root: CALayer?) -> () -> Void {
        guard let root else { return {} }
        var undo: [(CALayer, Any)] = []
        func walk(_ layer: CALayer) {
            if let c = layer.contents, CFGetTypeID(c as CFTypeRef) == IOSurfaceGetTypeID() {
                let surface = unsafeBitCast(c as AnyObject, to: IOSurfaceRef.self)
                if let image = image(of: surface) {
                    undo.append((layer, c))
                    layer.contents = image
                }
            }
            layer.sublayers?.forEach(walk)
        }
        walk(root)
        return { for (layer, c) in undo.reversed() { layer.contents = c } }
    }

    /// A copy of a BGRA IOSurface (premultiplied, the 2D canvas's GPU replay) as a CGImage in
    /// the surface's own colour space.
    static func image(of surface: IOSurfaceRef) -> CGImage? {
        guard IOSurfaceGetPixelFormat(surface) == 0x4247_5241 else { return nil } // 'BGRA'
        IOSurfaceLock(surface, .readOnly, nil)
        defer { IOSurfaceUnlock(surface, .readOnly, nil) }
        let w = IOSurfaceGetWidth(surface), h = IOSurfaceGetHeight(surface), row = IOSurfaceGetBytesPerRow(surface)
        guard w > 0, h > 0 else { return nil }
        let bytes = Data(bytes: IOSurfaceGetBaseAddress(surface), count: row * h)
        guard let provider = CGDataProvider(data: bytes as CFData) else { return nil }
        var space = CGColorSpace(name: CGColorSpace.sRGB)!
        if let tag = IOSurfaceCopyValue(surface, kIOSurfaceColorSpace), let named = CGColorSpace(propertyListPlist: tag) { space = named }
        return CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: row, space: space,
                       bitmapInfo: CGBitmapInfo(rawValue: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue),
                       provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }
}
#endif
