import AppKit
import Carbon
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    static var shared: AppDelegate!
    var config = Config()
    var floats: [FloatWindow] = []
    var status: NSStatusItem!
    var serviceUp = false, starting = false
    var hotKey: EventHotKeyRef?
    var fullApp: FullWindow?                             // 完整版: the whole browser version in a window
    var managers: [String: ManagerWindow] = [:]          // 管理员小窗: a category's manager on its own, by category
    private var pushT: [String: DispatchWorkItem] = [:]

    func applicationDidFinishLaunching(_ n: Notification) {
        AppDelegate.shared = self
        config = Config.load()
        mainMenu()
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let iconURL = Bundle.main.url(forResource: "PGA-status", withExtension: "png"),
           let icon = NSImage(contentsOf: iconURL) {
            icon.size = NSSize(width: 22, height: 22)
            icon.isTemplate = false
            status.button?.image = icon
        } else {
            status.button?.image = NSImage(systemSymbolName: "rectangle.on.rectangle", accessibilityDescription: "PGA")
        }
        status.button?.toolTip = "PGA · 个人多智能体工作台"
        let menu = NSMenu(); menu.delegate = self; status.menu = menu
        registerHotKey()
        Wires.shared.setup()
        Alerts.shared.start()
        check { up in
            let go = {
                let args = CommandLine.arguments
                let compact = self.config.chat == "light"
                Store.write("floats.json", [SavedFloat]())
                if args.count <= 1 {
                    if compact { self.showHome() } else { self.showFull() }
                }
                self.launchArgs()
                Catalog.shared.refresh(force: true)
            }
            if up { go() } else { self.startService(go) }
        }
    }

    // ------------------------------------------------ floating windows
    func restore(visible: Bool) {
        for s in Store.read("floats.json", as: [SavedFloat].self) ?? [] { floats.append(FloatWindow(saved: s)) }
        if visible { floats.forEach { $0.show(focus: false) } }
    }

    /// open -a "PGA 浮窗" --args --home | --new | --full | --open <conversation key>
    func launchArgs() {
        let a = CommandLine.arguments
        if a.contains("--home") { showHome() }
        if a.contains("--full") { showFull() }
        if a.contains("--new") { openFloat(key: nil) }
        if let i = a.firstIndex(of: "--open"), i + 1 < a.count { openFloat(key: a[i + 1]) }
    }

    private var quitting = false
    func applicationWillTerminate(_ n: Notification) { saveFloats(); quitting = true }         // windows closing as the app quits stay open next time
    func saveFloats() { if !quitting { Store.write("floats.json", floats.map(\.saved)) } }

    /// A conversation as a window (the one already open is brought forward); nil: a new conversation. `near`: beside that
    /// window (a 管理员小窗); `jump`: at that input of yours ({run, find}).
    func openFloat(key: String?, title: String = "", focus: Bool = true, near: NSRect? = nil, jump: [String: String]? = nil) {
        if let key { Alerts.shared.markRead(key: key) }
        if let k = key, let f = floats.first(where: { $0.key == k }) {
            f.show(focus: focus); if let jump { f.jump(jump) }; return
        }
        if key == nil, let f = floats.first(where: { $0.key == nil && $0.kind == .conv }) { f.show(focus: true); return }   // one blank one is enough
        var d = ["title": title]; if let key { d["key"] = key }
        let f = openNode(.conv, data: d, frame: near.map { beside($0) } ?? defaultFrame(.conv))
        if let jump { f.jump(jump) }
        if near != nil { NSApp.activate(ignoringOtherApps: true); f.panel.makeKey() }
    }
    /// A conversation's window beside another window: to its left if the screen has room there, else to its right.
    func beside(_ r: NSRect) -> NSRect {
        let s = (NSScreen.screens.first { $0.frame.intersects(r) } ?? NSScreen.main!).visibleFrame, sz = Kind.conv.size
        let h = min(sz.height, s.height - 20), x = r.minX - sz.width - 12 >= s.minX ? r.minX - sz.width - 12 : min(r.maxX + 12, s.maxX - sz.width)
        return NSRect(x: x, y: max(s.minY, r.maxY - h), width: sz.width, height: h)
    }

    /// 管理员小窗: the category's manager in a small window of its own (the one already open is brought forward).
    func openManager(_ project: String) {
        let m = managers[project] ?? ManagerWindow(project: project)
        managers[project] = m; m.show()
        UserDefaults.standard.set(project, forKey: "managerProject." + config.uid)
    }
    /// Every category, each to open its manager in a small window.
    func managerMenu() -> NSMenuItem {
        let it = NSMenuItem(title: "管理员小窗", action: nil, keyEquivalent: ""); it.image = NSImage(systemSymbolName: "person.crop.rectangle", accessibilityDescription: nil)
        let sm = NSMenu(), counts = Dictionary(grouping: Alerts.shared.unread.compactMap(\.project)) { $0 }.mapValues(\.count)
        for p in Alerts.shared.categoryNames {
            let i = ActionItem(counts[p].map { "\(p)（\($0) 条新消息）" } ?? p) { self.openManager(p) }
            if managers[p] != nil { i.state = .on }
            sm.addItem(i)
        }
        if sm.items.isEmpty { sm.addItem(withTitle: "（正在读取…）", action: nil, keyEquivalent: "") }
        it.submenu = sm; return it
    }
    @objc func toggleAlerts() {
        config.alerts = !Alerts.shared.enabled; Store.write("config.json", config)
        if !Alerts.shared.enabled { Alerts.shared.markAllRead() } else { Toasts.shared.restore() }
    }
    func defaultFrame(_ k: Kind) -> NSRect {
        return NSRect(origin: FloatWindow.nextFrame().origin, size: k.size)
    }

    /// A node (or a conversation) as a new window at `frame` — in the coordinates of where windows live now (the
    /// screen, or the workbench).
    @discardableResult
    func openNode(_ k: Kind, data: [String: String], frame: NSRect) -> FloatWindow {
        let blank = k == .conv && data["key"] == nil
        let f = FloatWindow(saved: nil, kind: k, key: data["key"], title: data["title"] ?? "", data: data, at: frame)
        if blank { f.focusOnLoad = true }
        floats.append(f)
        f.show(focus: blank || k == .note); saveFloats(); redrawWires()
        return f
    }

    func float(id: String) -> FloatWindow? { floats.first { $0.id == id } }
    /// The PGA window (or workbench card) under a point of the screen, the frontmost one.
    func float(at p: NSPoint) -> FloatWindow? {
        let n = NSWindow.windowNumber(at: p, belowWindowWithWindowNumber: 0)
        return floats.first { $0.panel.windowNumber == n } ?? floats.first { $0.panel.isVisible && NSMouseInRect(p, $0.panel.frame, false) }
    }
    func redrawWires() { Wires.shared.redraw() }

    /// A wire: what `src` holds goes into the conversation `dst`. Only a conversation reads what is wired into it.
    func link(_ src: FloatWindow, into dst: FloatWindow) {
        guard src !== dst else { return }
        guard dst.kind == .conv else { NSSound.beep(); return }
        if !dst.inputs.contains(src.id) { dst.inputs.append(src.id) }
        dst.inputs.removeAll { $0 == dst.id }
        saveFloats(); pushInputs(to: dst); redrawWires()
    }
    func unlink(_ src: FloatWindow, from dst: FloatWindow) {
        dst.inputs.removeAll { $0 == src.id }; saveFloats(); pushInputs(to: dst); redrawWires()
    }

    /// Tells a conversation's page what is wired into it; the page hands it to its agents (PUT /chat-context).
    func pushInputs(to t: FloatWindow) {
        guard t.kind == .conv else { return }
        Web.call(t.web, "inputs", t.inputs.compactMap { float(id: $0)?.asInput })
    }
    /// A window's content changed (a note typed into, a file picked, a conversation got its key): those it feeds are told.
    func changed(_ f: FloatWindow) {
        saveFloats()
        for t in floats where t.inputs.contains(f.id) {
            pushT[t.id]?.cancel()
            let w = DispatchWorkItem { [weak self] in self?.pushInputs(to: t) }
            pushT[t.id] = w; DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: w)
        }
    }

    func closed(_ f: FloatWindow) {
        floats.removeAll { $0 === f }
        for t in floats where t.inputs.contains(f.id) { t.inputs.removeAll { $0 == f.id }; pushInputs(to: t) }
        saveFloats(); redrawWires()
    }

    func message(_ body: [String: Any]) {
        switch body["kind"] as? String {
        case "open":
            let run = body["run"] as? String ?? "", find = body["find"] as? String ?? ""
            openFloat(key: body["key"] as? String, title: body["title"] as? String ?? "", jump: run.isEmpty && find.isEmpty ? nil : ["run": run, "find": find])        case "new": openFloat(key: nil)
        case "tidyProjectChats":
            guard let project = body["project"] as? String, !project.isEmpty,
                  let data = try? JSONEncoder().encode([project]),
                  let args = String(data: data, encoding: .utf8) else { return }
            showFull()
            fullApp?.whenReady("window.pmTidyOnStage(...\(args))")
        case "tomorrowPlan":
            showFull()
            if let data = try? JSONEncoder().encode([body["text"] as? String ?? ""]),
               let args = String(data: data, encoding: .utf8) {
                fullApp?.whenReady("openTomorrowPlan(...\(args)).catch(e => toast(e.message))")
            }
        case "home": showHome()
        case "log": Log.write("page: \(body["text"] as? String ?? "")")
        default: break
        }
    }

    @objc func newFloat() { openFloat(key: nil) }
    @objc func showFull() { if fullApp == nil { fullApp = FullWindow() }; fullApp!.show() }
    @objc func showHome() {
        Alerts.shared.categories { names, _ in
            let last = UserDefaults.standard.string(forKey: "managerProject." + self.config.uid)
            let project = last.flatMap { names.isEmpty || names.contains($0) ? $0 : nil }
            let selected = project ?? names.first ?? "PGA"
            self.fullApp?.window.orderOut(nil)
            self.hideAll()
            for (name, manager) in self.managers where name != selected { manager.panel.orderOut(nil) }
            self.openManager(selected)
        }
    }
    @objc func showAll() { floats.forEach { $0.show(focus: false) } }
    @objc func hideAll() { floats.forEach { $0.panel.orderOut(nil) } }
    @objc func bring(_ item: NSMenuItem) { (item.representedObject as? FloatWindow)?.show(focus: true) }

    // ------------------------------------------------ ⌥Space anywhere: bring PGA workbench forward
    func registerHotKey() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, ev, _ in
            DispatchQueue.main.async { AppDelegate.shared.showFull() }
            return noErr
        }, 1, &spec, nil, nil)
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), EventHotKeyID(signature: OSType(0x5047_4144), id: 1), GetApplicationEventTarget(), 0, &hotKey)     // ⌥Space
    }

    // ------------------------------------------------ the PGA service (it needs Docker for its database)
    func check(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: URL(string: config.server + "/v1/version")!); req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { _, r, _ in
            let up = (r as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { self.serviceUp = up; done(up) }
        }.resume()
    }

    @objc func startServiceItem() { startService {} }
    func startService(_ then: @escaping () -> Void) {
        guard !starting else { return }; starting = true
        DispatchQueue.global().async {
            Shell.run("""
            docker info >/dev/null 2>&1 || open -a Docker
            for i in {1..90}; do docker info >/dev/null 2>&1 && break; sleep 2; done
            docker start pga-postgres-1 >/dev/null 2>&1
            for i in {1..30}; do docker exec pga-postgres-1 pg_isready -q && break; sleep 1; done
            launchctl kickstart -k gui/$(id -u)/local.pga.agent
            """)
            func wait(_ n: Int) {
                self.check { up in
                    if up || n == 0 { self.starting = false; then() } else { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { wait(n - 1) } }
                }
            }
            DispatchQueue.main.async { wait(60) }
        }
    }

    // ------------------------------------------------ the menu bar
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        check { _ in }                                   // fresh for the next time it opens
        @discardableResult func add(_ t: String, _ a: Selector?, _ k: String) -> NSMenuItem {
            let i = NSMenuItem(title: t, action: a, keyEquivalent: k); i.target = self; menu.addItem(i); return i
        }
        menu.addItem(Toasts.shared.visibilityMenuItem())
        Alerts.shared.addItems(to: menu)
        menu.addItem(managerMenu())
        add("简略界面（管理员）", #selector(showHome), "")
        add("完整版 PGA（网页端全部功能）", #selector(showFull), " ").keyEquivalentModifierMask = [.option]
        if !floats.isEmpty {
            menu.addItem(.separator())
            for f in floats {
                let i = add(f.title.isEmpty ? "新对话" : String(f.title.prefix(40)), #selector(bring(_:)), ""); i.representedObject = f
                i.image = NSImage(systemSymbolName: f.pinned ? "pin.fill" : "rectangle", accessibilityDescription: nil)
            }
            add("全部显示", #selector(showAll), ""); add("全部收起", #selector(hideAll), "")
        }
        menu.addItem(.separator())
        if starting { add("正在启动 PGA 服务…", nil, "") }
        else if serviceUp { add("PGA 服务运行中", nil, "") }
        else { add("PGA 服务没在运行 — 点这里启动", #selector(startServiceItem), "") }
        add("账号 \(config.uid.prefix(8))", nil, "")
        add("会话完成提醒（魔女猫和 Dock 红点）", #selector(toggleAlerts), "").state = Alerts.shared.enabled ? .on : .off
        menu.addItem(.separator())
        let q = NSMenuItem(title: "退出 PGA 浮窗", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"); menu.addItem(q)
    }

    /// An Edit menu, so ⌘C/⌘V and friends reach the text fields of the home window too.
    func mainMenu() {
        let main = NSMenu(), appItem = NSMenuItem(), editItem = NSMenuItem()
        main.addItem(appItem); main.addItem(editItem)
        let app = NSMenu(); app.addItem(withTitle: "退出", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"); appItem.submenu = app
        let edit = NSMenu(title: "编辑")
        edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSResponder.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "视图")
        view.addItem(withTitle: "简略界面（管理员）", action: #selector(showHome), keyEquivalent: "").target = self
        view.addItem(withTitle: "完整版 PGA（网页端全部功能）", action: #selector(showFull), keyEquivalent: "0").target = self
        viewItem.submenu = view
        NSApp.mainMenu = main
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { false }

    /// A click on the Dock icon: while it has a red badge, the manager of the newest news in its small window; else 完整版,
    /// the whole PGA (the workbench and the floating windows are a click away in its menus).
    func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if !Alerts.shared.openLatest() {
            if config.chat == "light" { showHome() } else { showFull() }
        }
        return true
    }
    /// Right-click on the Dock icon.
    func applicationDockMenu(_ s: NSApplication) -> NSMenu? {
        let m = NSMenu()
        m.addItem(Toasts.shared.visibilityMenuItem())
        Alerts.shared.addItems(to: m)
        m.addItem(managerMenu())
        m.addItem(ActionItem("完整版 PGA（网页端全部功能）") { self.showFull() })
        m.addItem(ActionItem("简略界面（管理员）") { self.showHome() })
        return m
    }
}
