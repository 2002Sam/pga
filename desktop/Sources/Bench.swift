import AppKit
import WebKit

/// 工作台, the first of the two ways of seeing PGA: one ordinary window, like the browser version's stage — every
/// conversation in a list on the left, and on the right the conversations and nodes as cards, wired to each other.
/// (The other way: each of them a window of its own, floating over the desktop.) ⌥⇧Space switches.
final class BenchArea: NSView {
    override var isFlipped: Bool { false }
    override func draw(_ r: NSRect) {
        NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(white: 0.09, alpha: 1) : NSColor(white: 0.95, alpha: 1) }.setFill()
        r.fill()
        NSColor.tertiaryLabelColor.withAlphaComponent(0.35).setFill()          // a dotted ground
        var x = (r.minX / 22).rounded(.down) * 22
        while x < r.maxX { var y = (r.minY / 22).rounded(.down) * 22; while y < r.maxY { NSRect(x: x, y: y, width: 1.4, height: 1.4).fill(); y += 22 }; x += 22 }
        guard let app = AppDelegate.shared, let w = window else { return }       // the wires between cards, under them
        let local = { (p: NSPoint) in self.convert(w.convertPoint(fromScreen: p), from: nil) }
        for t in app.floats where t.docked {
            for id in t.inputs {
                guard let s = app.float(id: id), s.docked else { continue }
                let a = local(s.dotPoint(.right)), b = local(t.dotPoint(.left)), k = max(50, abs(b.x - a.x) / 2), c = s.kind.color
                let p = NSBezierPath(); p.move(to: a); p.curve(to: b, controlPoint1: NSPoint(x: a.x + k, y: a.y), controlPoint2: NSPoint(x: b.x - k, y: b.y))
                p.lineWidth = 2.2; p.lineCapStyle = .round; c.withAlphaComponent(0.85).setStroke(); p.stroke()
            }
        }
    }
    override func rightMouseDown(with e: NSEvent) { AppDelegate.shared.showMenu(at: NSEvent.mouseLocation) }
}

final class Bench: WebChrome, NSWindowDelegate, WebOwner {
    static let listW: CGFloat = 270
    let window: NSWindow
    let area: BenchArea
    var list: DropWebView!

    override init() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 840), styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        let full = window.contentView?.bounds.size ?? NSSize(width: 1320, height: 840), top: CGFloat = 28
        area = BenchArea(frame: NSRect(x: Bench.listW, y: 0, width: full.width - Bench.listW, height: full.height))
        super.init()
        window.title = "PGA 工作台"; window.titleVisibility = .hidden; window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false; window.center(); window.delegate = self
        window.minSize = NSSize(width: 760, height: 480)
        let root = NSView(frame: NSRect(origin: .zero, size: full))
        list = Web.make(owner: self, page: ["mode": "home", "docked": true])
        list.navigationDelegate = self; list.uiDelegate = self
        list.frame = NSRect(x: 0, y: 0, width: Bench.listW, height: full.height - top); list.autoresizingMask = [.height]
        area.autoresizingMask = [.width, .height]
        area.wantsLayer = true; area.layer?.masksToBounds = true          // the cards and the ground stay inside it
        root.addSubview(list); root.addSubview(area)
        window.contentView = root
        list.load(URLRequest(url: Web.page(["mode": "home", "docked": "1"])))
        window.setFrameAutosaveName("PGABench")
        // in the title bar: a new conversation, and the way out to the desktop
        let bar = NSStackView(); bar.orientation = .horizontal; bar.spacing = 6; bar.edgeInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 10)
        bar.addArrangedSubview(NSButton(title: "＋ 新对话", target: AppDelegate.shared, action: #selector(AppDelegate.newFloat)))
        bar.addArrangedSubview(NSButton(title: "完整版", target: AppDelegate.shared, action: #selector(AppDelegate.showFull)))
        bar.addArrangedSubview(NSButton(title: "分开到桌面 ⌥⇧Space", target: AppDelegate.shared, action: #selector(AppDelegate.toggleMode)))
        for case let b as NSButton in bar.arrangedSubviews { b.bezelStyle = .accessoryBarAction; b.controlSize = .small; b.font = .systemFont(ofSize: 12) }
        let acc = NSTitlebarAccessoryViewController(); acc.view = bar; acc.layoutAttribute = .trailing
        bar.frame.size = NSSize(width: 320, height: top)
        window.addTitlebarAccessoryViewController(acc)
    }

    /// Where the n-th card goes when it has never been in the workbench: cascading from the top left.
    func cascade(_ k: Kind, _ n: Int) -> NSRect {
        let b = area.bounds, sz = NSSize(width: k.size.width, height: min(k.size.height, b.height - 40)), d = CGFloat(n % 10) * 30
        return NSRect(x: 20 + d, y: b.maxY - sz.height - 20 - d, width: sz.width, height: sz.height)
    }

    func show() { NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil) }
    func message(_ body: [String: Any]) {
        if body["kind"] as? String == "menu" { AppDelegate.shared.showMenu(at: NSEvent.mouseLocation) } else { AppDelegate.shared.message(body) }
    }
    func windowShouldClose(_ s: NSWindow) -> Bool { window.orderOut(nil); return false }   // hidden, cards and all (the Dock icon brings it back)
}

/// 完整版: the whole browser version (stage, world tree, notes, graph, settings, agents) in a window of its own.
final class FullWindow: WebChrome, NSWindowDelegate, WebOwner {
    let window: NSWindow
    var web: DropWebView!

    override init() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        super.init()
        // no title bar at all: the page fills the window, the window's buttons sit on it at the top left; the window
        // moves by the empty top edge of the page (bridge.js tells where), and a double-click there zooms it
        window.title = "PGA 完整版"; window.titleVisibility = .hidden; window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(white: 0.08, alpha: 1)
        window.isReleasedWhenClosed = false; window.center(); window.setFrameAutosaveName("PGAFull"); window.delegate = self
        web = Web.makeFull(owner: self, float: false)
        web.navigationDelegate = self; web.uiDelegate = self
        window.contentView = web
        web.load(URLRequest(url: Web.full([:])))
    }
    func show() { NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil) }

    /// Moving the window from the page: it follows the pointer while the button is held.
    private var moving: Timer?
    func drag() {
        moving?.invalidate()
        let start = NSEvent.mouseLocation, o = window.frame.origin
        moving = Timer.scheduledTimer(withTimeInterval: 1.0 / 120, repeats: true) { [weak self] t in
            guard let self, NSEvent.pressedMouseButtons & 1 != 0 else { t.invalidate(); return }
            let p = NSEvent.mouseLocation
            self.window.setFrameOrigin(NSPoint(x: o.x + p.x - start.x, y: o.y + p.y - start.y))
        }
    }

    func message(_ body: [String: Any]) {
        switch body["kind"] as? String {
        case "bg": if let c = body["color"] as? String { window.backgroundColor = Web.color(c) ?? window.backgroundColor }
        case "drag": drag()
        case "zoom": window.zoom(nil)
        default: break
        }
    }
}
