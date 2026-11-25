import AppKit
import QuartzCore

/// A single native companion, with a small speech bubble and a scrollable completion inbox.
/// No WebView, per-conversation window or retained conversation transcript.
final class Toasts: NSObject {
    static let shared = Toasts()
    typealias Item = PetItem
    private var inbox = PetInbox()
    private var panel: NSPanel?
    private var expanded = false
    private var page = 0
    private var timer: DispatchWorkItem?
    private var petImage: NSImage?
    private var reaction: String?
    private var companion: PetCompanionView?
    private var reducedMotion: Bool?
    private var openingKey: String?
    private let music = PetMusic()

    private(set) var hidden = UserDefaults.standard.bool(forKey: "petHidden")

    func toggleVisibility() {
        hidden.toggle()
        UserDefaults.standard.set(hidden, forKey: "petHidden")
        expanded = false; reaction = nil; timer?.cancel()
        render()
    }

    func visibilityMenuItem() -> NSMenuItem {
        ActionItem(hidden ? "显示桌面猫猫" : "隐藏桌面猫猫") { self.toggleVisibility() }
    }

    override init() {
        super.init()
        music.onLevel = { [weak self] level, beat in self?.companion?.respondToMusic(level:level,beat:beat) }
        NSWorkspace.shared.notificationCenter.addObserver(self,selector:#selector(motionChanged),name:NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,object:nil)
    }
    @objc private func motionChanged() { if panel != nil && Alerts.shared.enabled { render() } }
    func restore() {
        inbox = PetInbox(Store.read("pet-inbox.json", as: [Item].self) ?? [])
        // Migrate pending reminders from the old cards as well.
        for u in Alerts.shared.unread where !inbox.items.contains(where: { $0.key == u.key }) {
            inbox.put(Item(key:u.key, kind:u.kind, title:u.title, sub:u.project ?? "", body:u.text,
                           manager:u.project != nil, project:u.project))
        }
        render()
    }
    func show(_ item: Item) {
        inbox.put(item)
        if inbox.items.first?.read == true { save(); render(); return }
        expanded = true; page = 0; reaction = item.kind == "done" ? "done" : "attention"; save(); render(); arm()
    }
    /// Reading a conversation clears its badge, but its completion stays in the companion's recent list.
    func dismiss(keys: [String]) {
        guard inbox.items.contains(where: { keys.contains($0.key) && !$0.read }) else { return }
        inbox.markRead(keys); save(); render()
    }
    func dismissAll() {
        inbox.markAllRead(); save(); timer?.cancel(); expanded = false
        if Alerts.shared.enabled { render() } else { music.stop(); panel?.orderOut(nil) }
    }
    private func save() { Store.write("pet-inbox.json", inbox.items) }
    private func arm() {
        timer?.cancel()
        guard expanded && !hidden else { return }
        let work = DispatchWorkItem { [weak self] in self?.collapse() }
        timer = work; DispatchQueue.main.asyncAfter(deadline:.now() + 18, execute:work)
    }
    @objc private func turnPage(_ sender: NSButton) { page += sender.tag; render(); arm() }
    @objc private func toggle() {
        if let item = inbox.latestUnread { open(item); return }
        expanded.toggle(); reaction = "tap"; render(); arm()
    }
    @objc private func collapse() { timer?.cancel(); expanded = false; render() }
    @objc private func openItem(_ sender: NSButton) {
        guard inbox.items.indices.contains(sender.tag) else { return }
        open(inbox.items[sender.tag])
    }
    private func open(_ item: Item) {
        guard openingKey == nil else { return }
        openingKey = item.key; timer?.cancel()
        let u = Alerts.Unread(key:item.key, project:item.project, title:item.title, text:item.body, kind:item.kind, at:0)
        Alerts.shared.openConversation(u) { [weak self] opened in
            guard let self else { return }
            self.openingKey = nil
            if opened { self.expanded = false; self.render() }
            self.arm()
        }
    }
    private func render() {
        guard !hidden else {
            timer?.cancel(); music.stop(); panel?.orderOut(nil)
            return
        }
        if panel == nil {
            let p = NSPanel(contentRect:.zero, styleMask:[.borderless,.nonactivatingPanel], backing:.buffered, defer:false)
            p.title = "PGA 魔女猫"; p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = false; p.level = .statusBar
            p.isReleasedWhenClosed = false; p.hidesOnDeactivate = false; p.isMovableByWindowBackground = false
            p.collectionBehavior = [.canJoinAllSpaces,.fullScreenAuxiliary,.ignoresCycle]
            panel = p
            if let url = Bundle.main.url(forResource:"PGA-pet", withExtension:"png") { petImage = NSImage(contentsOf:url) }
            if petImage == nil { petImage = NSImage(named:NSImage.applicationIconName) }
        }
        guard let p = panel, let screen = p.screen ?? NSScreen.main ?? NSScreen.screens.first else { return }
        p.setFrame(PetLayout.frame(previous:p.frame,screen:screen.visibleFrame,expanded:expanded),display:false)
        let width = p.frame.width, height = p.frame.height
        let root = NSView(frame:NSRect(x:0,y:0,width:width,height:height))
        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let cat: PetCompanionView
        if let previous = companion, reducedMotion == reduce {
            cat = previous; cat.removeFromSuperview(); cat.frame = PetLayout.cat(in:width)
            cat.react(reaction,reduceMotion:reduce)
        } else {
            cat = PetCompanionView(frame:PetLayout.cat(in:width),image:petImage,reduceMotion:reduce,reaction:reaction)
            companion = cat; reducedMotion = reduce
        }
        reaction = nil
        cat.onHide = { [weak self] in self?.toggleVisibility() }
        cat.onToggleMusic = { [weak self] in self?.music.toggle() }
        cat.musicEnabled = { [weak self] in self?.music.enabled ?? false }
        cat.target = self; cat.action = #selector(toggle)
        cat.onInteraction = { [weak self] active in if active { self?.timer?.cancel() } else { self?.arm() } }
        cat.onHover = { [weak self] inside in if inside { self?.timer?.cancel() } else { self?.arm() } }
        cat.onShowInbox = { [weak self] in
            guard let self else { return }; self.expanded = true; self.render(); self.arm()
        }
        cat.setAccessibilityLabel("PGA 魔女猫，\(inbox.unread) 个未读会话，\(inbox.unread > 0 ? "点击在主界面打开最新消息" : expanded ? "点击收起会话列表" : "点击查看会话列表")")
        cat.toolTip = inbox.unread > 0 ? "点击在主界面打开最新消息 · 拖动猫咪移动" : "点击查看最近会话 · 拖动猫咪移动"
        cat.toolTip = (cat.toolTip ?? "") + " · 头顶来回轻扫可摸头 · 右键更多"
        root.addSubview(cat)
        let count = NSButton(title:inbox.unread > 0 ? "\(inbox.unread) 条新消息" : inbox.items.isEmpty ? "PGA" : "查看最近会话",target:self,action:#selector(toggle))
        count.isBordered = false; count.font = .systemFont(ofSize:10,weight:.medium)
        count.contentTintColor = .secondaryLabelColor; count.toolTip = cat.toolTip
        count.alignment = .center; count.frame = NSRect(x:0,y:104,width:width,height:16); root.addSubview(count)
        if expanded {
            let pages = max(1,Int(ceil(Double(inbox.items.count)/20)))
            page = max(0,min(page,pages-1))
            let bubbleFrame = NSRect(x:10,y:130,width:width-20,height:310)
            let shadow = NSView(frame:bubbleFrame); shadow.wantsLayer = true
            shadow.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
            shadow.layer?.cornerRadius = 22; shadow.layer?.shadowColor = NSColor.black.cgColor
            shadow.layer?.shadowOpacity = 0.14; shadow.layer?.shadowRadius = 8
            shadow.layer?.shadowOffset = NSSize(width:0,height:-2)
            root.addSubview(shadow)
            let bubble = PetInboxView(frame:bubbleFrame,items:inbox.items,unread:inbox.unread,page:page,
                                      target:self,open:#selector(openItem(_:)),close:#selector(collapse),turn:#selector(turnPage(_:)))
            bubble.onHover = { [weak self] inside in if inside { self?.timer?.cancel() } else { self?.arm() } }
            root.addSubview(bubble)
        }
        p.contentView = root; p.orderFrontRegardless()
    }
}
