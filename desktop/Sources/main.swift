import AppKit

// PGA 浮窗: a menu-bar app (no Dock icon) whose conversations float above every other window.
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
