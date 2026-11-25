import AppKit
import WebKit

/// 管理员小窗: one category's manager page on its own in a small window, not the whole of PGA. It opens from a reminder
/// (or from the Dock icon while it has a badge, or from the menus). 📌 keeps it above every other window and on every
/// desktop space; unpinned it is an ordinary window. A conversation opened from it (a task's "查看处理对话", a title in the
/// list) floats out beside it. Where each category's window was, and whether it was pinned, is kept in managers.json.
final class ManagerWindow: WebChrome, NSWindowDelegate, WebOwner {
    struct Saved: Codable { var x: Double, y: Double, w: Double, h: Double, pinned: Bool }
    let project: String
    private(set) var key: String
    let panel: FloatPanel
    let header = Header()
    var web: DropWebView!
    var pinned: Bool

    init(project: String) {
        self.project = project
        key = Alerts.managerKey(project)
        let saved = Store.read("managers.json", as: [String: Saved].self) ?? [:], s = saved[project]
        pinned = s?.pinned ?? saved["*"]?.pinned ?? false                // a new one: as the last one was left
        let rect = s.map { NSRect(x: $0.x, y: $0.y, width: $0.w, height: $0.h) } ?? ManagerWindow.firstFrame()
        panel = FloatPanel(contentRect: rect, styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        super.init()
        panel.rightDragMovesWindow = true
        panel.title = "\(project) · 管理员"
        panel.titleVisibility = .hidden; panel.titlebarAppearsTransparent = true
        for b in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { panel.standardWindowButton(b)?.isHidden = true }
        panel.hidesOnDeactivate = false; panel.isReleasedWhenClosed = false
        panel.minSize = NSSize(width: 340, height: 300)
        panel.backgroundColor = NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(white: 0.12, alpha: 1) : NSColor(white: 0.98, alpha: 1) }
        panel.delegate = self

        header.title.stringValue = "\(project) · 管理员"
        header.pin.target = self; header.pin.action = #selector(togglePin)
        header.close.target = self; header.close.action = #selector(closeIt)
        header.bench.isHidden = false
        header.bench.title = "打开完整页面"
        header.bench.toolTip = "在完整版的台面上打开这个管理员"
        header.bench.target = self; header.bench.action = #selector(onStage)

        web = Web.makeFull(owner: self, float: true, extra: ["manager": project])
        web.navigationDelegate = self; web.uiDelegate = self
        let content = NSView(frame: NSRect(origin: .zero, size: rect.size)), h = FloatWindow.headerH
        header.frame = NSRect(x: 0, y: rect.height - h, width: rect.width, height: h); header.autoresizingMask = [.width, .minYMargin]
        web.frame = NSRect(x: 0, y: 0, width: rect.width, height: rect.height - h); web.autoresizingMask = [.width, .height]
        content.addSubview(web); content.addSubview(header)
        panel.contentView = content
        applyPin()
        load()
        confirmKey()
    }

    /// The first time: at the top right of the screen you are on, the size of a narrow page.
    static func firstFrame() -> NSRect {
        let s = (NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main!).visibleFrame
        let n = CGFloat(AppDelegate.shared.managers.count % 6) * 26, w: CGFloat = 500, h = min(720, s.height - 48)
        return NSRect(x: s.maxX - w - 20 - n, y: s.maxY - h - 20 - n, width: w, height: h)
    }

    private func load() {
        web.load(URLRequest(url: Web.full(["view": "chats", "embed": "1", "c": key, "manager": project])))
    }
    /// The key worked out here is the server's for every category that was never renamed; the server (which also registers
    /// a manager on first use) says which it is, and the page follows if it differs.
    private func confirmKey() {
        let cfg = AppDelegate.shared.config
        guard let url = URL(string: cfg.server + "/v1/users/\(cfg.uid)/project-map") else { return }
        var req = URLRequest(url: url); req.httpMethod = "POST"; req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["project": project, "shown": [String](), "refs": [[String]]()])
        URLSession.shared.dataTask(with: req) { d, _, _ in
            let k = (d.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])?["manager"] as? String
            DispatchQueue.main.async { if let k, k.hasPrefix("chat:pm-"), k != self.key { self.key = k; self.load() } }
        }.resume()
    }

    func show() {
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        Alerts.shared.markRead(project: project)
    }

    // ------------------------------------------------ 置顶
    @objc func togglePin() { pinned.toggle(); applyPin(); save() }
    func applyPin() {
        panel.level = pinned ? .floating : .normal
        panel.collectionBehavior = pinned ? [.canJoinAllSpaces, .fullScreenAuxiliary] : [.managed]
        header.pin.image = NSImage(systemSymbolName: pinned ? "pin.fill" : "pin.slash", accessibilityDescription: "置顶")
        header.pin.contentTintColor = pinned ? .controlAccentColor : .tertiaryLabelColor
        header.pin.toolTip = pinned ? "已置顶：在所有窗口之上（点一下取消）" : "置顶：让这个小窗留在所有窗口之上"
    }

    private func save() {
        var all = Store.read("managers.json", as: [String: Saved].self) ?? [:]
        let f = panel.frame
        all[project] = Saved(x: f.minX, y: f.minY, w: f.width, h: f.height, pinned: pinned)
        all["*"] = Saved(x: 0, y: 0, w: 0, h: 0, pinned: pinned)
        Store.write("managers.json", all)
    }

    @objc func closeIt() { panel.performClose(nil) }
    /// The same manager on 完整版's stage (its knowledge graph, the conversations beside it); the small window goes.
    @objc func onStage() {
        let a: AppDelegate = AppDelegate.shared, name = (try? JSONSerialization.data(withJSONObject: [project])).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        a.showFull()
        a.fullApp?.whenReady("window.mgOpen && mgOpen(...\(name))")
        closeIt()
    }

    func message(_ body: [String: Any]) {
        switch body["kind"] as? String {
        case "foldProjectChats":
            guard let folded = body["folded"] as? Bool,
                  let data = try? JSONSerialization.data(withJSONObject: [project, folded]),
                  let args = String(data: data, encoding: .utf8) else { return }
            let app: AppDelegate = AppDelegate.shared
            app.showFull()
            app.fullApp?.whenReady("if (S.view !== 'stage') show('stage'); window.stSetProjectChatsFolded(...\(args))")
        case "switchManagerProject":
            guard let name = body["project"] as? String, !name.isEmpty, name != project else { return }
            guard let app = AppDelegate.shared else { return }
            app.openManager(name)
            if let next = app.managers[name] {
                if pinned && !next.pinned { next.togglePin() }
                next.panel.setFrame(panel.frame, display: true)
                panel.orderOut(nil)
            }
        case "open":                                     // a conversation, from the manager's document or its list
            guard let k = body["key"] as? String, !k.isEmpty else { return }
            var jump: [String: String]? = nil
            let run = body["run"] as? String ?? "", find = body["find"] as? String ?? ""
            if !run.isEmpty || !find.isEmpty { jump = ["run": run, "find": find] }
            AppDelegate.shared.openFloat(key: k, title: body["title"] as? String ?? "", near: panel.frame, jump: jump)
        case "editOnStage":                              // a double-click edit branches the conversation beside the manager: that needs the stage
            guard let k = body["key"] as? String, !k.isEmpty,
                  let data = try? JSONSerialization.data(withJSONObject: [project, k, body["run"] as? String ?? "", body["find"] as? String ?? ""]),
                  let args = String(data: data, encoding: .utf8) else { return }
            let a: AppDelegate = AppDelegate.shared
            a.showFull()
            a.fullApp?.whenReady("""
            (async (p, k, r, f) => { const n = window.mgOpen && await mgOpen(p);
              for (let i = 0; n && i < 80; i++) { const w = n.el?.querySelector("iframe")?.contentWindow;
                if (w && typeof w.pdEditBranch === "function" && w.document.querySelector("#pmdoc")) { w.pdEditBranch(k, r, f); return; }
                await new Promise((s) => setTimeout(s, 250)); } })(...\(args))
            """)
        case "state", "ready", "menu", "bg", "drag", "zoom": break
        default: AppDelegate.shared.message(body)
        }
    }

    func windowDidBecomeKey(_ n: Notification) { Alerts.shared.markRead(project: project) }
    func windowDidMove(_ n: Notification) { save() }
    func windowDidEndLiveResize(_ n: Notification) { save() }
    func windowWillClose(_ n: Notification) {
        save(); AppDelegate.shared.managers.removeValue(forKey: project)
        guard let page = web else { return }
        web = nil
        page.releasePageResources()
        panel.contentView = nil
    }
}
