import AppKit
import Carbon
import WebKit

/// The home window: every conversation, newest first; open one as a floating window, or start a new one.
final class HomeWindow: WebChrome, NSWindowDelegate, WebOwner {
    let window: NSWindow
    var web: DropWebView!

    override init() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 620), styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        super.init()
        window.title = "PGA"; window.titlebarAppearsTransparent = true; window.titleVisibility = .hidden
        window.isReleasedWhenClosed = false; window.center(); window.setFrameAutosaveName("PGAHome"); window.delegate = self
        window.minSize = NSSize(width: 420, height: 360)
        web = Web.make(owner: self, page: ["mode": "home"])
        web.navigationDelegate = self; web.uiDelegate = self
        window.contentView = web
        web.load(URLRequest(url: Web.page(["mode": "home"])))
    }

    func show() { NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil) }
    func message(_ body: [String: Any]) { AppDelegate.shared.message(body) }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    static var shared: AppDelegate!
    var config = Config()
    var floats: [FloatWindow] = []
    var home: HomeWindow?
    var status: NSStatusItem!
    var serviceUp = false, starting = false
    var hotKey: EventHotKeyRef?, hotKey2: EventHotKeyRef?
    var bench: Bench?                                    // the workbench window, while PGA is seen that way
    var inBench: Bool { config.mode == "bench" }
    private var pushT: [String: DispatchWorkItem] = [:]

    func applicationDidFinishLaunching(_ n: Notification) {
        AppDelegate.shared = self
        config = Config.load()
        mainMenu()
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        status.button?.image = NSImage(systemSymbolName: "rectangle.on.rectangle", accessibilityDescription: "PGA")
        let menu = NSMenu(); menu.delegate = self; status.menu = menu
        registerHotKey()
        Wires.shared.setup()
        check { up in
            let go = { self.restore(); self.launchArgs(); Catalog.shared.refresh(force: true) }
            if up { go() } else { self.startService(go) }
        }
    }

    // ------------------------------------------------ floating windows
    func restore() {
        for s in Store.read("floats.json", as: [SavedFloat].self) ?? [] { floats.append(FloatWindow(saved: s)) }
        if inBench { enterBench() } else { floats.forEach { $0.show(focus: false) } }
    }

    /// open -a "PGA 浮窗" --args --home | --new | --bench | --desk | --open <conversation key>
    func launchArgs() {
        let a = CommandLine.arguments
        if a.contains("--home") { showHome() }
        if a.contains("--bench") && !inBench { toggleMode() }
        if a.contains("--desk") && inBench { toggleMode() }
        if a.contains("--new") { openFloat(key: nil) }
        if let i = a.firstIndex(of: "--open"), i + 1 < a.count { openFloat(key: a[i + 1]) }
    }

    private var quitting = false
    func applicationWillTerminate(_ n: Notification) { saveFloats(); quitting = true }         // windows closing as the app quits stay open next time
    func saveFloats() { if !quitting { Store.write("floats.json", floats.map(\.saved)) } }

    /// A conversation as a window (the one already open is brought forward); nil: a new conversation.
    func openFloat(key: String?, title: String = "", focus: Bool = true) {
        if let k = key, let f = floats.first(where: { $0.key == k }) { f.show(focus: focus); if inBench { bench?.show() }; return }
        if key == nil, let f = floats.first(where: { $0.key == nil && $0.kind == .conv }) { f.show(focus: true); if inBench { bench?.show() }; return }   // one blank one is enough
        var d = ["title": title]; if let key { d["key"] = key }
        openNode(.conv, data: d, frame: defaultFrame(.conv))
    }
    func defaultFrame(_ k: Kind) -> NSRect {
        if inBench, let b = bench { return b.cascade(k, floats.filter(\.docked).count) }
        return NSRect(origin: FloatWindow.nextFrame().origin, size: k.size)
    }

    /// A node (or a conversation) as a new window at `frame` — in the coordinates of where windows live now (the
    /// screen, or the workbench).
    @discardableResult
    func openNode(_ k: Kind, data: [String: String], frame: NSRect) -> FloatWindow {
        let blank = k == .conv && data["key"] == nil
        let f = FloatWindow(saved: nil, kind: k, key: data["key"], title: data["title"] ?? "", data: data, at: inBench ? nil : frame)
        if blank { f.focusOnLoad = true }
        floats.append(f)
        if inBench, let b = bench { f.dock(in: b.area, frame: frame); b.show() }
        f.show(focus: blank || k == .note); saveFloats(); redrawWires()
        return f
    }

    func float(id: String) -> FloatWindow? { floats.first { $0.id == id } }
    /// The PGA window (or workbench card) under a point of the screen, the frontmost one.
    func float(at p: NSPoint) -> FloatWindow? {
        if inBench, let b = bench {
            for v in b.area.subviews.reversed() { if let f = floats.first(where: { $0.content === v }), NSMouseInRect(p, f.screenFrame, false) { return f } }
            return nil
        }
        let n = NSWindow.windowNumber(at: p, belowWindowWithWindowNumber: 0)
        return floats.first { $0.panel.windowNumber == n } ?? floats.first { $0.panel.isVisible && NSMouseInRect(p, $0.panel.frame, false) }
    }
    func redrawWires() { Wires.shared.redraw(); bench?.area.needsDisplay = true }

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

    // ------------------------------------------------ the two ways of seeing PGA: the workbench, or the desktop
    /// ⌥⇧Space: every window into one workbench window (an app in the Dock), or each out onto the desktop on its own.
    @objc func toggleMode() {
        config.mode = inBench ? "desk" : "bench"; Store.write("config.json", config)
        if inBench { enterBench() } else { leaveBench() }
    }
    func enterBench() {
        if bench == nil { bench = Bench() }
        let b = bench!; b.show()
        var n = 0
        for f in floats { f.dock(in: b.area, frame: f.card ?? b.cascade(f.kind, n)); if f.card == nil { n += 1 } }
        saveFloats(); redrawWires()
    }
    func leaveBench() {
        for f in floats { f.undock(); f.show(focus: false); f.applyPin() }
        bench?.window.orderOut(nil)
        saveFloats(); redrawWires()
    }

    func message(_ body: [String: Any]) {
        switch body["kind"] as? String {
        case "open": openFloat(key: body["key"] as? String, title: body["title"] as? String ?? "")
        case "new": openFloat(key: nil)
        case "home": showHome()
        case "mode": toggleMode()
        case "log": Log.write("page: \(body["text"] as? String ?? "")")
        default: break
        }
    }

    @objc func newFloat() { openFloat(key: nil) }
    @objc func showBench() { bench?.show() }
    @objc func showHome() { if home == nil { home = HomeWindow() }; home!.show() }
    @objc func showAll() { floats.forEach { $0.show(focus: false) } }
    @objc func hideAll() { floats.forEach { $0.panel.orderOut(nil) } }
    @objc func bring(_ item: NSMenuItem) { (item.representedObject as? FloatWindow)?.show(focus: true) }

    // ------------------------------------------------ ⌥Space anywhere: a new question; ⌥⇧Space: workbench ↔ desktop
    func registerHotKey() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, ev, _ in
            var hk = EventHotKeyID()
            GetEventParameter(ev, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
            let which = hk.id
            DispatchQueue.main.async { if which == 2 { AppDelegate.shared.toggleMode() } else { AppDelegate.shared.newFloat() } }
            return noErr
        }, 1, &spec, nil, nil)
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), EventHotKeyID(signature: OSType(0x5047_4144), id: 1), GetApplicationEventTarget(), 0, &hotKey)     // ⌥Space
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey | shiftKey), EventHotKeyID(signature: OSType(0x5047_4144), id: 2), GetApplicationEventTarget(), 0, &hotKey2)   // ⌥⇧Space
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
        add("新浮窗", #selector(newFloat), " ").keyEquivalentModifierMask = [.option]
        add("所有对话…", #selector(showHome), "")
        let fc = add(inBench ? "分开到桌面" : "收进工作台", #selector(toggleMode), " "); fc.keyEquivalentModifierMask = [.option, .shift]
        if inBench { add("显示工作台", #selector(showBench), "") }
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
        let t = view.addItem(withTitle: "工作台 ⇄ 桌面浮窗", action: #selector(toggleMode), keyEquivalent: " "); t.keyEquivalentModifierMask = [.option, .shift]; t.target = self
        view.addItem(withTitle: "新对话", action: #selector(newFloat), keyEquivalent: "n").target = self
        view.addItem(withTitle: "所有对话…", action: #selector(showHome), keyEquivalent: "").target = self
        viewItem.submenu = view
        NSApp.mainMenu = main
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { false }

    /// A click on the Dock icon: the workbench (in either mode — from the desktop it gathers the windows back into it).
    func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if inBench { showBench() } else { toggleMode() }
        return true
    }
    /// Right-click on the Dock icon.
    func applicationDockMenu(_ s: NSApplication) -> NSMenu? {
        let m = NSMenu()
        m.addItem(ActionItem(inBench ? "分开到桌面（每个对话一个浮窗）" : "收回工作台（一个窗口）") { self.toggleMode() })
        m.addItem(ActionItem("新对话") { self.newFloat() })
        m.addItem(ActionItem("所有对话…") { self.showHome() })
        return m
    }
}
