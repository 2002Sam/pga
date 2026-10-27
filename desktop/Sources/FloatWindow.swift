import AppKit
import WebKit

/// A floating window: one conversation, above every other app's windows and on every desktop space, which does not
/// take the focus from the app you are in (a non-activating panel) — click Finder beneath it and go on working there;
/// click into its composer and you type into it. Only its own rectangle is taken, so everything around it is the desktop.
final class FloatPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    /// ⌘C ⌘V ⌘X ⌘A ⌘Z ⇧⌘Z ⌘W, which an app without its own menu bar would otherwise not get.
    override func performKeyEquivalent(with e: NSEvent) -> Bool {
        let mods = e.modifierFlags.intersection(.deviceIndependentFlagsMask), key = e.charactersIgnoringModifiers ?? ""
        if mods == .command || mods == [.command, .shift] {
            if mods == .command, key == "w" { performClose(nil); return true }
            if super.performKeyEquivalent(with: e) { return true }
            let sel: Selector? = mods == [.command, .shift] ? (key.lowercased() == "z" ? Selector(("redo:")) : nil)
                : ["x": #selector(NSText.cut(_:)), "c": #selector(NSText.copy(_:)), "v": #selector(NSText.paste(_:)),
                   "a": #selector(NSResponder.selectAll(_:)), "z": Selector(("undo:"))][key]
            if let sel, NSApp.sendAction(sel, to: nil, from: self) { return true }
        }
        return super.performKeyEquivalent(with: e)
    }
}

/// The strip at the top: the window moves by it; its title, 置顶, close.
final class Header: NSView {
    let title = NSTextField(labelWithString: "PGA")
    let pin = NSButton()
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with e: NSEvent) { window?.performDrag(with: e) }

    init() {
        super.init(frame: .zero)
        title.font = .systemFont(ofSize: 12, weight: .medium); title.textColor = .secondaryLabelColor
        title.lineBreakMode = .byTruncatingTail; title.cell?.truncatesLastVisibleLine = true
        pin.bezelStyle = .inline; pin.isBordered = false;
        pin.image = NSImage(systemSymbolName: "pin.fill", accessibilityDescription: "置顶"); pin.toolTip = "置顶：在所有窗口之上（点一下取消）"
        pin.contentTintColor = .secondaryLabelColor
        for v in [title, pin] { v.translatesAutoresizingMaskIntoConstraints = false; addSubview(v) }
        NSLayoutConstraint.activate([
            title.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 30),
            title.centerYAnchor.constraint(equalTo: centerYAnchor),
            title.trailingAnchor.constraint(lessThanOrEqualTo: pin.leadingAnchor, constant: -8),
            pin.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            pin.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
}

final class FloatWindow: WebChrome, NSWindowDelegate, WebOwner {
    static let headerH: CGFloat = 28
    let id: String
    var key: String?
    var title: String
    var pinned: Bool
    var focusOnLoad = false
    let panel: FloatPanel
    let header: Header
    var web: DropWebView!

    init(saved: SavedFloat?, key: String? = nil, title: String = "", at frame: NSRect? = nil) {
        id = saved?.id ?? UUID().uuidString
        self.key = saved?.key ?? key
        self.title = saved?.title ?? title
        pinned = saved?.pinned ?? true
        let rect = saved.map { NSRect(x: $0.x, y: $0.y, width: $0.w, height: $0.h) } ?? frame ?? FloatWindow.nextFrame()
        panel = FloatPanel(contentRect: rect, styleMask: [.titled, .closable, .resizable, .nonactivatingPanel, .fullSizeContentView],
                           backing: .buffered, defer: false)
        header = Header()
        super.init()
        header.pin.target = self; header.pin.action = #selector(togglePin(_:))
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        panel.minSize = NSSize(width: 300, height: 200)
        panel.backgroundColor = NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(white: 0.12, alpha: 1) : NSColor(white: 0.98, alpha: 1) }
        panel.delegate = self
        applyPin()

        let content = NSView(frame: NSRect(origin: .zero, size: rect.size))
        web = Web.make(owner: self, page: ["mode": "float", "key": self.key ?? ""])
        web.navigationDelegate = self; web.uiDelegate = self
        header.frame = NSRect(x: 0, y: rect.height - FloatWindow.headerH, width: rect.width, height: FloatWindow.headerH)
        header.autoresizingMask = [.width, .minYMargin]
        web.frame = NSRect(x: 0, y: 0, width: rect.width, height: rect.height - FloatWindow.headerH)
        web.autoresizingMask = [.width, .height]
        content.addSubview(web); content.addSubview(header)
        panel.contentView = content
        header.title.stringValue = self.title.isEmpty ? "新对话" : self.title
        var q = ["mode": "float"]; if let k = self.key { q["key"] = k }
        web.load(URLRequest(url: Web.page(q)))
    }

    static func nextFrame() -> NSRect {                // new ones cascade down from the top right of the screen you are on
        let s = (NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main!).visibleFrame
        let n = CGFloat(AppDelegate.shared.floats.count % 8) * 28
        return NSRect(x: s.maxX - 440 - 24 - n, y: s.maxY - 580 - 24 - n, width: 420, height: 580)
    }

    func show(focus: Bool) {
        panel.orderFrontRegardless()
        if focus { panel.makeKey(); Web.call(web, "focus", true) }
    }

    @objc func togglePin(_ sender: Any?) { pinned.toggle(); applyPin(); AppDelegate.shared.saveFloats() }
    func applyPin() {
        panel.level = pinned ? .floating : .normal
        header.pin.image = NSImage(systemSymbolName: pinned ? "pin.fill" : "pin.slash", accessibilityDescription: "置顶")
        header.pin.contentTintColor = pinned ? .controlAccentColor : .tertiaryLabelColor
    }

    var saved: SavedFloat {
        let f = panel.frame
        return SavedFloat(id: id, key: key, param: "c", title: title, x: f.minX, y: f.minY, w: f.width, h: f.height, pinned: pinned)
    }

    // the page tells which conversation it shows (a new one has its key from the first message) and what it is called
    func message(_ body: [String: Any]) {
        switch body["kind"] as? String {
        case "state":
            let k = body["key"] as? String, t = body["title"] as? String ?? ""
            if k != key || t != title { key = (k?.isEmpty ?? true) ? nil : k; title = t; header.title.stringValue = t.isEmpty ? "新对话" : t; AppDelegate.shared.saveFloats() }
        default: AppDelegate.shared.message(body)
        }
    }

    func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { Log.write("float load failed: \(e.localizedDescription)") }
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { Log.write("float load failed: \(e.localizedDescription)") }
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { if focusOnLoad { focusOnLoad = false; Web.call(web, "focus", true) } }

    func windowDidMove(_ n: Notification) { AppDelegate.shared.saveFloats() }
    func windowDidEndLiveResize(_ n: Notification) { AppDelegate.shared.saveFloats() }
    func windowWillClose(_ n: Notification) { AppDelegate.shared.closed(self) }
}
