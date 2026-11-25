import AppKit
import WebKit

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
        _ = downMonitor                                      // from the start: it must have seen the press the page reports
        window.title = "PGA 完整版"; window.titleVisibility = .hidden; window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(white: 0.08, alpha: 1)
        window.isReleasedWhenClosed = false; window.center(); window.setFrameAutosaveName("PGAFull"); window.delegate = self
        web = Web.makeFull(owner: self, float: false)
        web.navigationDelegate = self; web.uiDelegate = self
        let root = NSView(frame: window.contentView?.bounds ?? NSRect(x: 0, y: 0, width: 1440, height: 900))
        web.frame = root.bounds; web.autoresizingMask = [.width, .height]
        root.addSubview(web); window.contentView = root
        web.load(URLRequest(url: Web.full([:])))
    }
    func show() { NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil) }

    /// A cold main window can still be loading its account/stage. Retry without
    /// reloading it, so existing tabs and drafts are retained.
    func openConversation(key: String, project: String?, completion: @escaping (Bool) -> Void) {
        let script = PetNavigation.script(key:key,project:project)
        func attempt(_ remaining: Int) {
            web.callAsyncJavaScript("return " + script, arguments: [:], in: nil, in: .page) { result in
                if case .success(let value) = result, let opened = value as? Bool { completion(opened); return }
                guard remaining > 0 else {
                    Log.write("Pet navigation did not become ready: \(result)")
                    completion(false); return
                }
                DispatchQueue.main.asyncAfter(deadline:.now()+0.3) { attempt(remaining-1) }
            }
        }
        attempt(60)
    }

    /// Runs a script on the page once it is there (a page just opened gets a moment to draw its stage first).
    private var ready = false, waiting: [String] = []
    func whenReady(_ js: String) { if ready { web.evaluateJavaScript(js) } else { waiting.append(js) } }
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            self.ready = true
            self.waiting.forEach { self.web.evaluateJavaScript($0) }; self.waiting = []
        }
    }

    /// Moving the window from the page. The system moves it (performDrag), so it behaves like any Mac window: pulled to the
    /// top edge it shows the white box and fills the screen when let go, to the sides it tiles, and it snaps with the
    /// Option key. (Moving it by hand with setFrameOrigin, as before, is invisible to the system: no tiling at all.)
    /// The page says "drag" a moment after the button went down, so the press itself is kept as it passes.
    private var moving: Timer?
    private var lastDown: NSEvent?
    private lazy var downMonitor: Any? = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] e in
        if e.window === self?.window { self?.lastDown = e }
        return e
    }
    func drag() {
        _ = downMonitor
        if NSEvent.pressedMouseButtons & 1 != 0, let e = lastDown ?? NSApp.currentEvent, ProcessInfo.processInfo.systemUptime - e.timestamp < 1.5 {
            window.performDrag(with: e); return
        }
        moving?.invalidate()                                  // no press to hand over: follow the pointer by hand, as a fallback
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
        default: AppDelegate.shared.message(body)
        }
    }
}
