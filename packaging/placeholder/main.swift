// Switchyard placeholder app: a tiny AppKit window used to prove the release path
// (GitHub release -> Homebrew cask -> install -> launch) before the Exact client exists.
// Built by scripts/release/build-macos.sh --placeholder. Not the product.
import AppKit

let webURL = URL(string: ProcessInfo.processInfo.environment["SWITCHYARD_URL"] ?? "https://switchyard.apps.example.com")!

final class Canvas: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedWhite: 0.04, alpha: 1).setFill()
        bounds.fill()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!

    func applicationDidFinishLaunching(_ notification: Notification) {
        let frame = NSRect(x: 0, y: 0, width: 640, height: 360)
        window = NSWindow(contentRect: frame, styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Switchyard"
        window.backgroundColor = NSColor(calibratedWhite: 0.04, alpha: 1)
        let view = Canvas(frame: frame)
        let mono = NSFont.monospacedSystemFont(ofSize: 22, weight: .medium)
        let small = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        let title = NSTextField(labelWithString: "Switchyard")
        title.font = mono
        title.textColor = .white
        title.frame = NSRect(x: 40, y: 250, width: 560, height: 32)
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let sub = NSTextField(labelWithString: "placeholder build \(version) · release path check")
        sub.font = small
        sub.textColor = NSColor(calibratedWhite: 0.6, alpha: 1)
        sub.frame = NSRect(x: 40, y: 222, width: 560, height: 20)
        let status = NSTextField(labelWithString: "server: checking \(webURL.host ?? "")…")
        status.font = small
        status.textColor = NSColor(calibratedRed: 1, green: 0.66, blue: 0.2, alpha: 1)
        status.frame = NSRect(x: 40, y: 180, width: 560, height: 20)
        status.setAccessibilityIdentifier("server-status")
        let open = NSButton(title: "Open the web app", target: self, action: #selector(openWeb))
        open.frame = NSRect(x: 36, y: 120, width: 200, height: 32)
        for v in [title, sub, status, open] { view.addSubview(v) }
        window.contentView = view
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        // One request to the server's health endpoint so the release check can see the app reach it.
        var req = URLRequest(url: webURL.appendingPathComponent("api/healthz"))
        req.timeoutInterval = 10
        URLSession.shared.dataTask(with: req) { _, resp, err in
            let code = (resp as? HTTPURLResponse)?.statusCode
            let text = code.map { "server: \(self.host) answered HTTP \($0)" } ?? "server: \(self.host) unreachable (\(err?.localizedDescription ?? "no answer"))"
            DispatchQueue.main.async {
                status.stringValue = text
                self.snapshotIfAsked()
            }
            FileHandle.standardError.write((text + "\n").data(using: .utf8)!)
        }.resume()
    }

    /// `--snapshot <png>`: render this window's own content to a PNG (no Screen Recording
    /// permission needed, unlike screencapture over ssh), so the release check can look at it.
    func snapshotIfAsked() {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count, let view = window.contentView else { return }
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        if let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: args[i + 1]))
        }
    }

    var host: String { webURL.host ?? webURL.absoluteString }

    @objc func openWeb() { NSWorkspace.shared.open(webURL) }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.appearance = NSAppearance(named: .darkAqua)
app.run()
