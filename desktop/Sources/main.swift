import AppKit

// PGA 浮窗: an app in the Dock (and the menu bar) whose conversations live in one workbench window or float above
// every other window.
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
