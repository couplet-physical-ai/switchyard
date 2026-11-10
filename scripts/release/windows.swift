// List the on-screen windows of an app by owner name, without Screen Recording permission
// (names may be hidden; owner, bounds, layer and on-screen state are not).
//   swift scripts/release/windows.swift Switchyard     exit 0 = at least one on-screen window
import CoreGraphics
import Foundation

let owner = CommandLine.arguments.dropFirst().first ?? "Switchyard"
let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
var found = 0
for w in info where (w[kCGWindowOwnerName as String] as? String) == owner {
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let layer = w[kCGWindowLayer as String] as? Int ?? -1
    let pid = w[kCGWindowOwnerPID as String] as? Int ?? -1
    let name = w[kCGWindowName as String] as? String ?? "(name hidden)"
    print("window pid=\(pid) layer=\(layer) \(b["Width"] ?? "?")x\(b["Height"] ?? "?") at \(b["X"] ?? "?"),\(b["Y"] ?? "?") \(name)")
    if layer == 0 { found += 1 }
}
print("\(owner): \(found) on-screen window(s)")
exit(found > 0 ? 0 : 1)
