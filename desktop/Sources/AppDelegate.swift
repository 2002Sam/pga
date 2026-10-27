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
    var hotKey: EventHotKeyRef?

    func applicationDidFinishLaunching(_ n: Notification) {
        AppDelegate.shared = self
        config = Config.load()
        mainMenu()
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        status.button?.image = NSImage(systemSymbolName: "rectangle.on.rectangle", accessibilityDescription: "PGA")
        let menu = NSMenu(); menu.delegate = self; status.menu = menu
        registerHotKey()
        check { up in
            let go = { self.restore(); self.launchArgs() }
            if up { go() } else { self.startService(go) }
        }
    }

    // ------------------------------------------------ floating windows
    func restore() {
        for s in Store.read("floats.json", as: [SavedFloat].self) ?? [] { let f = FloatWindow(saved: s); floats.append(f); f.show(focus: false) }
    }

    /// open -a "PGA 浮窗" --args --home | --new | --open <conversation key>
    func launchArgs() {
        let a = CommandLine.arguments
        if a.contains("--home") { showHome() }
        if a.contains("--new") { openFloat(key: nil) }
        if let i = a.firstIndex(of: "--open"), i + 1 < a.count { openFloat(key: a[i + 1]) }
    }

    func saveFloats() { Store.write("floats.json", floats.map(\.saved)) }

    /// A conversation as a floating window (the one already open is brought forward); nil: a new conversation.
    func openFloat(key: String?, title: String = "", focus: Bool = true) {
        if let k = key, let f = floats.first(where: { $0.key == k }) { f.show(focus: focus); return }
        if key == nil, let f = floats.first(where: { $0.key == nil }) { f.show(focus: true); return }   // one blank one is enough
        let f = FloatWindow(saved: nil, key: key, title: title)
        f.focusOnLoad = focus
        floats.append(f); saveFloats(); f.show(focus: focus)
    }

    func closed(_ f: FloatWindow) { floats.removeAll { $0 === f }; saveFloats() }

    func message(_ body: [String: Any]) {
        switch body["kind"] as? String {
        case "open": openFloat(key: body["key"] as? String, title: body["title"] as? String ?? "")
        case "new": openFloat(key: nil)
        case "home": showHome()
        case "log": Log.write("page: \(body["text"] as? String ?? "")")
        default: break
        }
    }

    @objc func newFloat() { openFloat(key: nil) }
    @objc func showHome() { if home == nil { home = HomeWindow() }; home!.show() }
    @objc func showAll() { floats.forEach { $0.show(focus: false) } }
    @objc func hideAll() { floats.forEach { $0.panel.orderOut(nil) } }
    @objc func bring(_ item: NSMenuItem) { (item.representedObject as? FloatWindow)?.show(focus: true) }

    // ------------------------------------------------ ⌥Space anywhere: a new question
    func registerHotKey() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            DispatchQueue.main.async { AppDelegate.shared.newFloat() }; return noErr
        }, 1, &spec, nil, nil)
        let id = EventHotKeyID(signature: OSType(0x5047_4144), id: 1)       // 'PGAD'
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), id, GetApplicationEventTarget(), 0, &hotKey)
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
        NSApp.mainMenu = main
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { false }
}
