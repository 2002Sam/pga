import AppKit
import WebKit

/// A floating window: one conversation, or a node wired into one (note, file, skill, document, world-tree topic).
/// It sits above every other app's window and on every desktop space, and it does not take the focus from the app you
/// are in (a non-activating panel) — click Finder beneath it and go on working there; click into it and you type into it.
/// Each has a dot on either side: pull a wire from one to another window. Right-click it for every node there is.
/// In the workbench (the other way of seeing PGA) the same window is a card inside one ordinary window.
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

/// The strip at the top: the window (or, in the workbench, the card) moves by it; close, what it is, its title, 置顶.
final class Header: NSView {
    let title = NSTextField(labelWithString: "PGA")
    let pin = NSButton(), close = NSButton(), bench = NSButton()
    weak var owner: FloatWindow?
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with e: NSEvent) {
        guard let o = owner, o.docked, let area = o.content.superview else { window?.performDrag(with: e); return }
        area.addSubview(o.content, positioned: .above, relativeTo: nil)            // a card held comes to the top
        let start = e.screenPoint, f0 = o.content.frame
        while let ev = NSApp.nextEvent(matching: [.leftMouseDragged, .leftMouseUp], until: .distantFuture, inMode: .eventTracking, dequeue: true) {
            let p = ev.screenPoint, b = area.bounds
            var f = f0.offsetBy(dx: p.x - start.x, dy: p.y - start.y)
            let loX: CGFloat = b.minX - f.width + 60, hiX: CGFloat = b.maxX - 60, loY: CGFloat = b.minY - f.height + 40, hiY: CGFloat = b.maxY - f.height
            f.origin.x = Swift.max(loX, Swift.min(hiX, f.origin.x)); f.origin.y = Swift.max(loY, Swift.min(hiY, f.origin.y))   // it stays reachable
            o.content.frame = f; AppDelegate.shared.redrawWires()
            if ev.type == .leftMouseUp { break }
        }
        AppDelegate.shared.saveFloats()
    }
    override func rightMouseDown(with e: NSEvent) { if let o = owner { AppDelegate.shared.showMenu(for: o) } }

    init() {
        super.init(frame: .zero)
        title.font = .systemFont(ofSize: 12, weight: .medium); title.textColor = .secondaryLabelColor
        title.lineBreakMode = .byTruncatingTail; title.cell?.truncatesLastVisibleLine = true
        for (b, sym, tip) in [(pin, "pin.fill", "置顶：在所有窗口之上（点一下取消）"), (close, "xmark", "关掉这个窗口"), (bench, "rectangle.3.group", "收回工作台：所有浮窗回到一个窗口里（⌥⇧Space）")] {
            b.bezelStyle = .inline; b.isBordered = false; b.toolTip = tip
            b.image = NSImage(systemSymbolName: sym, accessibilityDescription: tip); b.contentTintColor = .tertiaryLabelColor
        }
        bench.target = AppDelegate.shared; bench.action = #selector(AppDelegate.toggleMode)
        for v in [close, title, bench, pin] { v.translatesAutoresizingMaskIntoConstraints = false; addSubview(v) }
        NSLayoutConstraint.activate([
            close.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            close.centerYAnchor.constraint(equalTo: centerYAnchor),
            title.leadingAnchor.constraint(equalTo: close.trailingAnchor, constant: 8),
            title.centerYAnchor.constraint(equalTo: centerYAnchor),
            title.trailingAnchor.constraint(lessThanOrEqualTo: bench.leadingAnchor, constant: -8),
            bench.trailingAnchor.constraint(equalTo: pin.leadingAnchor, constant: -8),
            bench.centerYAnchor.constraint(equalTo: centerYAnchor),
            pin.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            pin.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
}

/// The corner a card in the workbench is sized by (a window on the desktop is sized by its own edges).
final class Grip: NSView {
    weak var owner: FloatWindow?
    override func resetCursorRects() { addCursorRect(bounds, cursor: .crosshair) }
    override func draw(_ r: NSRect) {
        NSColor.tertiaryLabelColor.setStroke()
        for i in 0..<3 {
            let d = CGFloat(4 + i * 4), p = NSBezierPath()
            p.move(to: NSPoint(x: bounds.maxX - d, y: 2)); p.line(to: NSPoint(x: bounds.maxX - 2, y: d)); p.lineWidth = 1.2; p.stroke()
        }
    }
    override func mouseDown(with e: NSEvent) {
        guard let o = owner else { return }
        let start = e.screenPoint, f0 = o.content.frame, least = o.panel.minSize
        while let ev = NSApp.nextEvent(matching: [.leftMouseDragged, .leftMouseUp], until: .distantFuture, inMode: .eventTracking, dequeue: true) {
            let p = ev.screenPoint, dx: CGFloat = p.x - start.x, dy: CGFloat = p.y - start.y
            let w: CGFloat = Swift.max(least.width, f0.width + dx), h: CGFloat = Swift.max(least.height, f0.height - dy)
            o.content.frame = NSRect(x: f0.minX, y: f0.maxY - h, width: w, height: h); AppDelegate.shared.redrawWires()
            if ev.type == .leftMouseUp { break }
        }
        AppDelegate.shared.saveFloats()
    }
}

enum Side { case left, right }

/// A dot on the edge of a window: the left one takes wires in, the right one gives them out. Pull from it.
final class Dot: NSView {
    let side: Side
    weak var owner: FloatWindow?
    var hot = false { didSet { needsDisplay = true } }
    init(side: Side, owner: FloatWindow) {
        self.side = side; self.owner = owner
        super.init(frame: NSRect(x: 0, y: 0, width: 16, height: 16))
        toolTip = side == .left ? "输入：从别的窗口拉一根线到这里（或从这里拉出去，放到空白处选一个节点）" : "输出：拉一根线到别的对话窗口，它就读得到这里的内容"
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }
    required init?(coder: NSCoder) { fatalError() }
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func mouseEntered(with e: NSEvent) { hot = true; NSCursor.crosshair.push() }
    override func mouseExited(with e: NSEvent) { hot = false; NSCursor.pop() }
    override func draw(_ r: NSRect) {
        let c = owner?.kind.color ?? .controlAccentColor, d: CGFloat = hot ? 13 : 9
        let rect = NSRect(x: (bounds.width - d) / 2, y: (bounds.height - d) / 2, width: d, height: d)
        let p = NSBezierPath(ovalIn: rect)
        NSColor.windowBackgroundColor.setFill(); p.fill()
        c.setStroke(); p.lineWidth = 2.5; p.stroke()
    }
    override func mouseDown(with e: NSEvent) { if let o = owner { Wires.drag(from: o, side: side) } }
}

final class FloatWindow: WebChrome, NSWindowDelegate, WebOwner {
    static let headerH: CGFloat = 28
    let id: String
    let kind: Kind
    var key: String?
    var title: String
    var pinned: Bool
    var data: [String: String]
    var inputs: [String]
    var focusOnLoad = false
    let panel: FloatPanel
    let header: Header
    var web: DropWebView!
    var dots: [Dot] = []
    let content: NSView                     // header, page, dots: in its own panel on the desktop, or a card in the workbench
    let grip = Grip()
    var docked = false
    var desk: NSRect?, card: NSRect?        // where it was in each of the two ways of seeing it

    init(saved: SavedFloat?, kind: Kind = .conv, key: String? = nil, title: String = "", data: [String: String] = [:], at frame: NSRect? = nil) {
        id = saved?.id ?? UUID().uuidString
        self.kind = saved?.type.flatMap(Kind.init(rawValue:)) ?? kind
        self.key = saved?.key ?? key
        self.title = saved?.title ?? title
        self.data = saved?.data ?? data
        inputs = saved?.inputs ?? []
        card = saved?.card.flatMap { $0.count == 4 ? NSRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) : nil }
        pinned = saved?.pinned ?? true
        let rect = saved.map { NSRect(x: $0.x, y: $0.y, width: $0.w, height: $0.h) } ?? frame ?? FloatWindow.nextFrame()
        panel = FloatPanel(contentRect: rect, styleMask: [.titled, .closable, .resizable, .nonactivatingPanel, .fullSizeContentView],
                           backing: .buffered, defer: false)
        header = Header()
        content = NSView(frame: NSRect(origin: .zero, size: rect.size))
        super.init()
        desk = rect
        header.owner = self; grip.owner = self
        header.pin.target = self; header.pin.action = #selector(togglePin(_:))
        header.close.target = self; header.close.action = #selector(closeIt(_:))
        panel.standardWindowButton(.closeButton)?.isHidden = true
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isReleasedWhenClosed = false
        panel.minSize = self.kind == .conv ? NSSize(width: 300, height: 200) : NSSize(width: 180, height: 110)
        panel.backgroundColor = NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(white: 0.12, alpha: 1) : NSColor(white: 0.98, alpha: 1) }
        panel.delegate = self
        applyPin()

        var page: [String: Any] = ["mode": self.kind == .conv ? "float" : "node", "type": self.kind.rawValue, "data": self.data]
        if let k = self.key { page["key"] = k }
        web = Web.make(owner: self, page: page)
        web.navigationDelegate = self; web.uiDelegate = self
        header.frame = NSRect(x: 0, y: rect.height - FloatWindow.headerH, width: rect.width, height: FloatWindow.headerH)
        header.autoresizingMask = [.width, .minYMargin]
        web.frame = NSRect(x: 0, y: 0, width: rect.width, height: rect.height - FloatWindow.headerH)
        web.autoresizingMask = [.width, .height]
        content.addSubview(web); content.addSubview(header)
        for side in [Side.left, .right] {                  // the dots ride on the edges, half way down
            let d = Dot(side: side, owner: self)
            d.frame.origin = NSPoint(x: side == .left ? 0 : rect.width - 16, y: (rect.height - FloatWindow.headerH) / 2 - 8)
            d.autoresizingMask = [.minYMargin, .maxYMargin, side == .left ? .maxXMargin : .minXMargin]
            content.addSubview(d); dots.append(d)
        }
        grip.frame = NSRect(x: rect.width - 16, y: 0, width: 16, height: 16); grip.autoresizingMask = [.minXMargin, .maxYMargin]; grip.isHidden = true
        content.addSubview(grip)
        panel.contentView = content
        showTitle()
        var q = ["mode": page["mode"] as! String]; if let k = self.key { q["key"] = k }
        web.load(URLRequest(url: Web.page(q)))
    }

    static func nextFrame() -> NSRect {                // new conversations cascade down from the top right of the screen you are on
        let s = (NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main!).visibleFrame
        let n = CGFloat(AppDelegate.shared.floats.count % 8) * 28
        return NSRect(x: s.maxX - 440 - 24 - n, y: s.maxY - 580 - 24 - n, width: 420, height: 580)
    }

    func showTitle() {
        let t = title.isEmpty ? (kind == .conv ? "新对话" : "") : title
        header.title.stringValue = kind == .conv ? t : (t.isEmpty ? kind.label : "\(kind.label) · \(t)")
        header.title.textColor = kind == .conv ? .secondaryLabelColor : kind.color
    }

    func show(focus: Bool) {
        if docked {
            content.superview?.addSubview(content, positioned: .above, relativeTo: nil)
            if focus { content.window?.makeFirstResponder(web); Web.call(web, "focus", true) }
            AppDelegate.shared.redrawWires(); return
        }
        panel.orderFrontRegardless()
        if focus { panel.makeKey(); Web.call(web, "focus", true) }
    }

    /// Into the workbench as a card at `frame` (in the workbench's coordinates); out of it as a window on the desktop again.
    func dock(in area: NSView, frame: NSRect) {
        if !docked { desk = panel.frame; panel.orderOut(nil) }
        panel.contentView = NSView()
        content.removeFromSuperview()
        content.frame = frame
        content.wantsLayer = true; content.layer?.cornerRadius = 10; content.layer?.masksToBounds = true
        content.layer?.borderWidth = 1; content.layer?.borderColor = NSColor.separatorColor.cgColor
        content.layer?.backgroundColor = panel.backgroundColor.cgColor
        area.addSubview(content)
        docked = true; grip.isHidden = false; header.pin.isHidden = true; header.bench.isHidden = true
    }
    func undock() {
        guard docked else { return }
        card = content.frame
        content.removeFromSuperview()
        content.layer?.cornerRadius = 0; content.layer?.borderWidth = 0
        panel.setFrame(desk ?? FloatWindow.nextFrame(), display: false)
        panel.contentView = content
        docked = false; grip.isHidden = true; header.pin.isHidden = false; header.bench.isHidden = false
    }
    /// Where it is now, in the coordinates of where it lives (the screen, or the workbench).
    var frame: NSRect { docked ? content.frame : panel.frame }
    /// Where it is now on the screen.
    var screenFrame: NSRect {
        guard docked, let w = content.window else { return panel.frame }
        return w.convertToScreen(content.convert(content.bounds, to: nil))
    }

    @objc func closeIt(_ sender: Any?) {
        if docked { content.removeFromSuperview(); AppDelegate.shared.closed(self) } else { panel.performClose(nil) }
    }

    @objc func togglePin(_ sender: Any?) { pinned.toggle(); applyPin(); AppDelegate.shared.saveFloats() }
    func applyPin() {
        panel.level = pinned ? .floating : .normal
        header.pin.image = NSImage(systemSymbolName: pinned ? "pin.fill" : "pin.slash", accessibilityDescription: "置顶")
        header.pin.contentTintColor = pinned ? .controlAccentColor : .tertiaryLabelColor
    }

    /// Where a dot is, in screen coordinates (the wires are drawn between these).
    func dotPoint(_ side: Side) -> NSPoint {
        let f = screenFrame, y = f.minY + (f.height - FloatWindow.headerH) / 2
        return NSPoint(x: side == .left ? f.minX + 8 : f.maxX - 8, y: y)
    }

    /// What this window hands to a conversation it is wired into. A conversation hands over what was asked in it — the
    /// window it goes into fetches that itself (it changes as the conversation goes on).
    var payload: String {
        let t = data["title"] ?? title, x = data["text"] ?? ""
        switch kind {
        case .conv: return ""
        case .note: return x.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : "The user's note: \(x)"
        case .file: return (data["path"] ?? "").isEmpty ? "" : "A file on this Mac (read it where it is): \(data["path"]!)"
        case .skill: return "Skill «\(t)» — follow it where it applies:\n\(String((data["body"] ?? x).prefix(8000)))"
        case .doc: return "Document «\(t)»: \(x)"
        case .topic: return "World-tree topic «\(t)»: \(x)"
        }
    }
    var asInput: [String: Any] { ["id": id, "type": kind.rawValue, "title": title.isEmpty ? (data["title"] ?? kind.label) : title, "key": key ?? "", "text": payload] }

    var saved: SavedFloat {
        let f = docked ? (desk ?? panel.frame) : panel.frame, c = docked ? content.frame : card
        return SavedFloat(id: id, key: key, param: "c", title: title, x: f.minX, y: f.minY, w: f.width, h: f.height, pinned: pinned,
                          type: kind.rawValue, data: data, inputs: inputs, card: c.map { [$0.minX, $0.minY, $0.width, $0.height] })
    }

    func message(_ body: [String: Any]) {
        switch body["kind"] as? String {
        case "state":                                    // what it shows now: a conversation's key and title, a node's content
            if let d = body["data"] as? [String: String] { data.merge(d) { $1 }; if let t = d["title"] { title = t } }
            if kind == .conv {
                let k = body["key"] as? String; key = (k?.isEmpty ?? true) ? nil : k
                title = body["title"] as? String ?? title
            }
            showTitle(); AppDelegate.shared.changed(self)
        case "menu": AppDelegate.shared.showMenu(for: self)
        case "pickFile":
            let o = NSOpenPanel(); o.canChooseDirectories = true
            if o.runModal() == .OK, let u = o.url { data["path"] = u.path; data["title"] = u.lastPathComponent; title = u.lastPathComponent; Web.call(web, "data", data); showTitle(); AppDelegate.shared.changed(self) }
        case "ready": AppDelegate.shared.pushInputs(to: self)
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
