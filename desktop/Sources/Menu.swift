import AppKit

/// A menu item that runs a closure.
final class ActionItem: NSMenuItem {
    private let run: () -> Void
    init(_ title: String, symbol: String? = nil, _ run: @escaping () -> Void) {
        self.run = run
        super.init(title: title, action: #selector(fire), keyEquivalent: "")
        target = self
        if let symbol { image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) }
    }
    required init(coder: NSCoder) { fatalError() }
    @objc private func fire() { run() }
}

extension AppDelegate {
    /// Every node there is, from a right-click on a window (`into`: what is picked is wired into it), from a wire pulled
    /// out of a window's right dot and let go on empty space (`from`: it is wired into what is picked — a conversation),
    /// or from empty space in the workbench (neither). `at`: where a wire was let go or the workbench clicked — new windows go there;
    /// without it (a right-click on a window) they go beside the window.
    func showMenu(for into: FloatWindow? = nil, from: FloatWindow? = nil, at drop: NSPoint? = nil) {
        let point = drop ?? NSEvent.mouseLocation
        Catalog.shared.refresh()
        let m = NSMenu(), cat = Catalog.shared
        m.autoenablesItems = false
        let place = { (k: Kind) -> NSRect in self.frameFor(k, near: into ?? from, at: drop, left: into != nil) }
        let open = { (k: Kind, data: [String: String]) in
            let f = self.openNode(k, data: data, frame: place(k))
            if let into { self.link(f, into: into) }
            if let from { self.link(from, into: f) }
        }
        if let w = into ?? from {
            let h = NSMenuItem(title: into != nil ? "连进「\(w.title.isEmpty ? w.kind.label : String(w.title.prefix(24)))」" : "从「\(String(w.title.prefix(24)))」接出去",
                               action: nil, keyEquivalent: ""); h.isEnabled = false; m.addItem(h)
        }
        m.addItem(ActionItem("新对话窗口", symbol: "plus.bubble") { open(.conv, [:]) })
        let chats = NSMenuItem(title: "对话", action: nil, keyEquivalent: ""); chats.image = NSImage(systemSymbolName: "bubble.left.and.bubble.right", accessibilityDescription: nil)
        let cm = NSMenu()
        for c in cat.chats.prefix(30) where c.data["key"] != (into ?? from)?.key {
            cm.addItem(ActionItem(String(c.title.prefix(48))) {
                if let ex = self.floats.first(where: { $0.key == c.data["key"] }) {      // already open: wire that one
                    if let into { self.link(ex, into: into) }; if let from { self.link(from, into: ex) }; ex.show(focus: false)
                } else { open(.conv, c.data) }
            })
        }
        if cm.items.isEmpty { cm.addItem(withTitle: "（正在读取…）", action: nil, keyEquivalent: "") }
        chats.submenu = cm; m.addItem(chats)
        if from == nil {                                  // what a conversation can read: notes, files, skills, documents, topics
            m.addItem(.separator())
            m.addItem(ActionItem("笔记", symbol: "note.text") { let f = self.openNode(.note, data: [:], frame: place(.note)); if let into { self.link(f, into: into) }; f.show(focus: true) })
            m.addItem(ActionItem("文件…", symbol: "doc") {
                let o = NSOpenPanel(); o.allowsMultipleSelection = true; o.canChooseDirectories = true
                guard o.runModal() == .OK else { return }
                for u in o.urls { open(.file, ["path": u.path, "title": u.lastPathComponent]) }
            })
            for (title, symbol, kind, items) in [("技能", "sparkles", Kind.skill, cat.skills), ("资料", "books.vertical", Kind.doc, cat.docs), ("世界树主题", "tree", Kind.topic, cat.topics)] {
                let it = NSMenuItem(title: title, action: nil, keyEquivalent: ""); it.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
                let sm = NSMenu()
                for x in items.prefix(60) {
                    let i = ActionItem(String(x.title.prefix(48))) {
                        if kind == .skill, let p = x.data["path"], !p.isEmpty {
                            cat.skillBody(p) { body in var d = x.data; d["body"] = body; open(.skill, d) }
                        } else { open(kind, x.data) }
                    }
                    i.toolTip = String(x.sub.prefix(300)); sm.addItem(i)
                }
                if sm.items.isEmpty { sm.addItem(withTitle: "（没有，或正在读取…）", action: nil, keyEquivalent: "") }
                it.submenu = sm; m.addItem(it)
            }
        }
        if let w = into ?? from {                         // its wires: cut one
            let ins = w.inputs.compactMap { float(id: $0) }, outs = floats.filter { $0.inputs.contains(w.id) }
            if !ins.isEmpty || !outs.isEmpty {
                m.addItem(.separator())
                for s in ins { m.addItem(ActionItem("断开 ← \(s.title.isEmpty ? s.kind.label : String(s.title.prefix(30)))", symbol: "scissors") { self.unlink(s, from: w) }) }
                for t in outs { m.addItem(ActionItem("断开 → \(t.title.isEmpty ? t.kind.label : String(t.title.prefix(30)))", symbol: "scissors") { self.unlink(w, from: t) }) }
            }
        }
        m.addItem(.separator())
        m.addItem(ActionItem(inBench ? "分开到桌面（⌥⇧Space）" : "收进工作台（⌥⇧Space）", symbol: "rectangle.3.group") { self.toggleMode() })
        m.addItem(ActionItem("所有对话…", symbol: "list.bullet") { self.showHome() })
        if let w = into { m.addItem(ActionItem("关闭这个窗口", symbol: "xmark") { w.panel.performClose(nil) }) }
        m.popUp(positioning: nil, at: point, in: nil)
    }

    /// Where a new window goes: an input to the left of the window it feeds (stacked), anything else where you pointed.
    /// In the coordinates of where windows live now: the screen, or the workbench.
    func frameFor(_ k: Kind, near w: FloatWindow?, at point: NSPoint?, left: Bool) -> NSRect {
        var sz = k.size, space: NSRect
        if inBench, let b = bench { space = b.area.bounds; sz.height = Swift.min(sz.height, space.height - 40) }
        else {
            let at: NSPoint = point ?? NSEvent.mouseLocation
            let screen: NSScreen = w?.panel.screen ?? NSScreen.screens.first(where: { NSMouseInRect(at, $0.frame, false) }) ?? NSScreen.main!
            space = screen.visibleFrame
        }
        if var p = point {
            if inBench, let b = bench { p = b.area.convert(b.window.convertPoint(fromScreen: p), from: nil) }
            return NSRect(x: p.x - (left ? sz.width : 0), y: p.y - sz.height / 2, width: sz.width, height: sz.height)
        }
        guard let w else { return defaultFrame(k) }
        let f = w.frame, n = CGFloat(w.inputs.count)
        var x: CGFloat = f.minX - sz.width - 56
        if x < space.minX { x = f.maxX + 56 }
        let want: CGFloat = f.maxY - FloatWindow.headerH - sz.height - n * sz.height * 0.55
        let y: CGFloat = Swift.max(space.minY, Swift.min(space.maxY - sz.height, want))
        return NSRect(x: x, y: y, width: sz.width, height: sz.height)
    }
}
