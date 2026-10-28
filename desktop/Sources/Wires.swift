import AppKit

/// The wires between windows on the desktop, drawn on a transparent layer over each screen. Clicks go straight through
/// it, so the desktop beneath stays usable; it sits above other apps' windows and below the PGA windows. (In the
/// workbench the wires between cards are drawn by the workbench; this layer then shows only a wire being pulled.)
final class Wires {
    static let shared = Wires()
    fileprivate var layers: [NSWindow] = []
    var temp: (from: NSPoint, to: NSPoint, color: NSColor)?
    private var sig = ""

    func setup() {
        rebuild()
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { _ in self.rebuild() }
        // windows move by their own means (dragged by the head, resized, restored): redraw whenever any of them has moved
        Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { _ in
            let s = AppDelegate.shared.floats.map { "\($0.panel.frame)\($0.panel.isVisible)\($0.docked)" }.joined()
            if s != self.sig { self.sig = s; self.redraw() }
        }
    }

    private func rebuild() {
        layers.forEach { $0.orderOut(nil) }
        layers = NSScreen.screens.map { s in
            let w = NSWindow(contentRect: s.frame, styleMask: .borderless, backing: .buffered, defer: false)
            w.isOpaque = false; w.backgroundColor = .clear; w.hasShadow = false
            w.ignoresMouseEvents = true
            w.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue - 1)
            w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            w.isReleasedWhenClosed = false
            w.contentView = WireView(frame: NSRect(origin: .zero, size: s.frame.size))
            w.setFrame(s.frame, display: false)
            w.orderFrontRegardless()
            return w
        }
    }

    func redraw() { layers.forEach { $0.contentView?.needsDisplay = true } }

    /// Pulling a wire from a dot: let go on another window to wire the two, or on empty space to pick a node for it.
    static func drag(from f: FloatWindow, side: Side) {
        let start = f.dotPoint(side)
        shared.temp = (start, NSEvent.mouseLocation, f.kind.color); shared.redraw()
        if f.docked { shared.layers.forEach { $0.orderFrontRegardless() } }        // over the workbench window while pulling
        var p = NSEvent.mouseLocation
        while let e = NSApp.nextEvent(matching: [.leftMouseDragged, .leftMouseUp], until: .distantFuture, inMode: .eventTracking, dequeue: true) {
            p = e.screenPoint; shared.temp?.to = p; shared.redraw()
            if e.type == .leftMouseUp { break }
        }
        shared.temp = nil; shared.redraw()
        let app = AppDelegate.shared!
        if let t = app.float(at: p), t !== f {
            if side == .right { app.link(f, into: t) } else { app.link(t, into: f) }
        } else if hypot(p.x - start.x, p.y - start.y) > 30, app.float(at: p) == nil {
            app.showMenu(for: side == .left ? f : nil, from: side == .right ? f : nil, at: p)
        }
    }
}

final class WireView: NSView {
    override func draw(_ r: NSRect) {
        guard let w = window, let app = AppDelegate.shared else { return }
        let o = w.frame.origin, local = { (p: NSPoint) in NSPoint(x: p.x - o.x, y: p.y - o.y) }
        func curve(_ a: NSPoint, _ b: NSPoint, _ c: NSColor, dashed: Bool) {
            let p = NSBezierPath(), k = max(50, abs(b.x - a.x) / 2)
            p.move(to: local(a)); p.curve(to: local(b), controlPoint1: local(NSPoint(x: a.x + k, y: a.y)), controlPoint2: local(NSPoint(x: b.x - k, y: b.y)))
            p.lineWidth = 2.2; p.lineCapStyle = .round
            if dashed { p.setLineDash([6, 5], count: 2, phase: 0) }
            c.withAlphaComponent(0.85).setStroke(); p.stroke()
            for q in [a, b] { let d = NSBezierPath(ovalIn: NSRect(x: local(q).x - 3.5, y: local(q).y - 3.5, width: 7, height: 7)); c.setFill(); d.fill() }
        }
        for t in app.floats where t.panel.isVisible && !t.docked {
            for id in t.inputs { if let s = app.float(id: id), s.panel.isVisible, !s.docked { curve(s.dotPoint(.right), t.dotPoint(.left), s.kind.color, dashed: false) } }
        }
        if let g = Wires.shared.temp { curve(g.from, g.to, g.color, dashed: true) }
    }
}

extension NSEvent {
    /// Where a mouse event happened, in screen coordinates.
    var screenPoint: NSPoint { window.map { $0.convertPoint(toScreen: locationInWindow) } ?? locationInWindow }
}
