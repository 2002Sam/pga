import AppKit
import CryptoKit
import UserNotifications

/// Reminders: when an agent has finished answering (or failed, or waits for your approval), the companion shows a completion (Toasts) and
/// the Dock icon (and the menu-bar icon) shows a red badge with how many conversations have news you have not looked at.
/// A click on the card opens that conversation; a click on the Dock icon while it has a badge opens that category's
/// manager in a small window of its own (an approval opens the conversation that asks). Looking at a conversation clears it: its window, its
/// category's manager, or its page in front of you on 完整版's stage.
/// The server is asked every few seconds what its agents are doing (GET /v1/agents/live); nothing on the server changes.
/// What has not been looked at yet is kept in alerts.json, so the badge outlives a restart.
final class Alerts: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Alerts()

    struct Unread: Codable {
        var key: String
        var project: String?
        var title: String
        var text: String
        var kind: String            // done | failed | approval
        var at: Double
    }
    private(set) var unread: [Unread] = []           // one per conversation, the newest last
    private let tracker = AlertTracker(since: Date().timeIntervalSince1970)
    private var timer: Timer?
    private var polling = false
    private var cats: (names: [String], of: [String: String], at: Date) = ([], [:], .distantPast)
    private var baseIcon: NSImage?
    var enabled: Bool { AppDelegate.shared.config.alerts ?? true }

    func start() {
        unread = Store.read("alerts.json", as: [Unread].self) ?? []
        baseIcon = AppDelegate.shared.status.button?.image
        UNUserNotificationCenter.current().delegate = self          // for notifications an older version left in Notification Center
        badge()
        if enabled { Toasts.shared.restore() }
        timer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: true) { [weak self] _ in self?.poll() }
    }

    // ------------------------------------------------ what the agents are doing
    private func poll() {
        let cfg = AppDelegate.shared.config
        guard !polling, !cfg.uid.isEmpty, let url = URL(string: cfg.server + "/v1/agents/live") else { return }
        polling = true
        var req = URLRequest(url: url); req.timeoutInterval = 4
        URLSession.shared.dataTask(with: req) { data, _, _ in
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) }
            DispatchQueue.main.async {
                self.polling = false
                guard json != nil else { return }                       // the server is down: nothing is known, nothing is lost
                let events = self.tracker.feed(LiveRun.parse(json, uid: cfg.uid))
                if self.enabled { events.forEach(self.handle) }
                self.clearSeen()
            }
        }.resume()
    }

    private func handle(_ e: AlertEvent) {
        categories { names, of in
            let project = self.project(of: e.key, names: names, of: of)
            self.inFront(e.key, project: project) { seen in
                self.title(of: e.key, project: project) { title, last in
                    // what it did: the opening of its answer, where the conclusion is — the saved answer, if it is this run's
                    // (the live list keeps only the end of what an agent said, and the answer may not be saved yet)
                    var text = e.kind == .approval ? (e.run.approval?.details ?? "") : (e.kind == .failed ? (e.run.error ?? "") : "")
                    let tail = e.run.answerTail, end = String(tail.filter { !$0.isWhitespace }.suffix(40))
                    if text.isEmpty, !last.isEmpty, end.isEmpty || last.filter({ !$0.isWhitespace }).hasSuffix(end) { text = Alerts.brief(last) }
                    if text.isEmpty { text = Alerts.brief(tail) }
                    if text.isEmpty { text = Alerts.brief(last) }
                    text = String(text.prefix(260))
                    let u = Unread(key: e.key, project: project, title: title, text: text, kind: e.kind.rawValue, at: Date().timeIntervalSince1970)
                    if !seen { self.unread.removeAll { $0.key == e.key }; self.unread.append(u); self.save() }
                    self.post(u, agent:e.run.agent, read:seen, eventID:e.run.id + ":" + (e.approvalId ?? e.kind.rawValue))
                }
            }
        }
    }

    // ------------------------------------------------ the popup
    /// The companion inbox uses one native panel and opens the selected conversation.
    /// macOS notification permissions do not hide this app-owned panel.
    private func post(_ u: Unread, agent: String, read: Bool, eventID: String) {
        let sub = [u.project, agent.isEmpty ? nil : agent].compactMap { $0 }.joined(separator: " · ")
        let it = Toasts.Item(key: u.key, kind: u.kind, title: u.title, sub: sub, body: u.text,
                             manager: u.project != nil && !u.key.hasPrefix("chat:pm-"), project:u.project, read:read, eventID:eventID)
        Toasts.shared.show(it)
    }

    func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        let info = r.notification.request.content.userInfo
        let key = info["key"] as? String ?? "", project = info["project"] as? String ?? "", kind = info["kind"] as? String ?? "done"
        DispatchQueue.main.async {
            let u = self.unread.first { $0.key == key } ?? Unread(key: key, project: project.isEmpty ? nil : project, title: "", text: "", kind: kind, at: 0)
            self.openConversation(u)
            done()
        }
    }

    /// Pet/notification clicks focus the exact conversation in the main stage.
    /// Only acknowledge the reminder after navigation succeeds.
    func openConversation(_ u: Unread, completion: ((Bool) -> Void)? = nil) {
        let app = AppDelegate.shared!
        app.showFull()
        app.fullApp?.openConversation(key:u.key,project:u.project) { opened in
            if opened { self.markRead(key:u.key) }
            completion?(opened)
        }
    }
    /// All Dock and menu reminders open directly in the main stage instead of spawning a floating window.
    func open(_ u: Unread) {
        openConversation(u)
    }
    /// The Dock icon clicked while it has a badge: the newest.
    func openLatest() -> Bool {
        guard let u = unread.last else { return false }
        open(u); return true
    }

    /// A few lines of an answer as plain text: no markdown marks, no code, no tables, the lines run together.
    static func brief(_ s: String) -> String {
        var out: [String] = [], code = false
        for raw in s.components(separatedBy: "\n") {
            var l = raw.trimmingCharacters(in: .whitespaces)
            if l.hasPrefix("```") { code.toggle(); continue }
            if code || l.isEmpty || l.hasPrefix("|") || l.hasPrefix("---") || l.hasPrefix("→ ") { continue }
            l = l.replacingOccurrences(of: #"^(#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)"#, with: "", options: .regularExpression)
            l = l.replacingOccurrences(of: #"\*\*|__|`"#, with: "", options: .regularExpression)
            l = l.replacingOccurrences(of: #"\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
            if !l.isEmpty { out.append(l) }
            if out.joined().count > 300 { break }
        }
        return out.joined(separator: " ")
    }

    // ------------------------------------------------ read
    func markRead(key: String) {
        Toasts.shared.dismiss(keys: [key])
        guard unread.contains(where: { $0.key == key }) else { return }
        unread.removeAll { $0.key == key }; save()
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["pga:" + key])
    }
    func markRead(project: String) {
        let gone = unread.filter { $0.project == project && $0.kind != "approval" }.map(\.key)
        guard !gone.isEmpty else { return }
        unread.removeAll { gone.contains($0.key) }; save()
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: gone.map { "pga:" + $0 })
        Toasts.shared.dismiss(keys: gone)
    }
    @objc func markAllRead() {
        let gone = unread.map(\.key); unread = []; save()
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: gone.map { "pga:" + $0 })
        Toasts.shared.dismissAll()
    }
    private func save() { Store.write("alerts.json", unread); badge() }

    /// The red badge on the Dock icon, and a red dot on the menu-bar icon.
    func badge() {
        let n = unread.count
        NSApp.dockTile.badgeLabel = n > 0 ? (n > 99 ? "99+" : "\(n)") : nil
        guard let button = AppDelegate.shared.status?.button, let base = baseIcon else { return }
        button.toolTip = n > 0 ? "PGA · \(n) 个对话有新消息" : "PGA · 个人多智能体工作台"
        guard n > 0 else { button.image = base; return }
        let img = NSImage(size: base.size, flipped: false) { r in
            base.draw(in: r)
            let d = r.width * 0.42
            let dot = NSBezierPath(ovalIn: NSRect(x: r.maxX - d, y: r.maxY - d, width: d, height: d))
            NSColor.systemRed.setFill(); dot.fill()
            return true
        }
        button.image = img
    }

    /// Whatever you are looking at now is read: a conversation's window, a category's manager, a page on 完整版's stage.
    private func clearSeen() {
        guard !unread.isEmpty, NSApp.isActive, let w = NSApp.keyWindow else { return }
        if let f = AppDelegate.shared.floats.first(where: { $0.panel === w }), let k = f.key { markRead(key: k) }
        if let m = AppDelegate.shared.managers.values.first(where: { $0.panel === w }) { markRead(project: m.project) }
        if let full = AppDelegate.shared.fullApp, full.window === w {
            let managers = Dictionary(Set(unread.compactMap(\.project)).map { (Alerts.managerKey($0), $0) }) { a, _ in a }
            stageSeen(full, unread.map(\.key) + managers.keys) { seen in
                for k in seen { if let p = managers[k] { self.markRead(project: p) } else { self.markRead(key: k) } }
            }
        }
    }

    /// Is this conversation in front of you right now (so a reminder would only interrupt)? Its window, its category's
    /// 管理员小窗 (whose document shows each task as it ends), or its page on 完整版's stage.
    private func inFront(_ key: String, project: String?, _ done: @escaping (Bool) -> Void) {
        guard NSApp.isActive, let w = NSApp.keyWindow else { return done(false) }
        if AppDelegate.shared.floats.contains(where: { $0.panel === w && $0.key == key }) { return done(true) }
        if let p = project, AppDelegate.shared.managers[p]?.panel === w { return done(true) }
        if let full = AppDelegate.shared.fullApp, full.window === w { stageSeen(full, [key]) { done($0.contains(key)) }; return }
        done(false)
    }
    /// Which of these conversations is the page in front of you on 完整版's stage (the stage's own stSeen: focused and wholly in view).
    private func stageSeen(_ full: FullWindow, _ keys: [String], _ done: @escaping ([String]) -> Void) {
        guard let data = try? JSONSerialization.data(withJSONObject: keys), let ks = String(data: data, encoding: .utf8) else { return done([]) }
        let js = "(() => { try { const ks = \(ks); return ST.nodes.filter((n) => n.type === 'win' && n.key && ks.includes(n.key) && stSeen(n)).map((n) => n.key); } catch (e) { return []; } })()"
        full.web.evaluateJavaScript(js) { r, _ in done(r as? [String] ?? []) }
    }

    // ------------------------------------------------ which category, what it is called
    /// A category's manager conversation: "chat:pm-" and the first 20 hex digits of the name's SHA-1 (pga.project_context.manager_key).
    static func managerKey(_ name: String) -> String {
        "chat:pm-" + Insecure.SHA1.hash(data: Data(name.utf8)).map { String(format: "%02x", $0) }.joined().prefix(20)
    }
    private func project(of key: String, names: [String], of: [String: String]) -> String? {
        if key.hasPrefix("chat:pm-") { return names.first { Alerts.managerKey($0) == key } }
        return of[key]
    }
    /// The categories known now, for the menus (asked again in the background when they are old).
    var categoryNames: [String] {
        if Date().timeIntervalSince(cats.at) > 30 { categories { _, _ in } }
        return cats.names
    }
    /// The categories and which conversation is in which (GET conversation-projects), kept for half a minute.
    func categories(_ done: @escaping ([String], [String: String]) -> Void) {
        if Date().timeIntervalSince(cats.at) < 30 { return done(cats.names, cats.of) }
        get("/v1/users/{uid}/conversation-projects") { j in
            if let d = j as? [String: Any] {
                self.cats = (d["names"] as? [String] ?? [], d["of"] as? [String: String] ?? [:], Date())
            }
            done(self.cats.names, self.cats.of)
        }
    }
    private var titleCache: [String:String] = [:]
    private var titleAt = Date.distantPast
    private var titleWaiting: [(String, (String,String)->Void)] = []
    /// Titles only: the live event already has a bounded reply excerpt.
    private func title(of key: String, project: String?, _ done: @escaping (String, String) -> Void) {
        if key.hasPrefix("chat:pm-") { return done("\(project ?? "分类") · 管理员", "") }
        if Date().timeIntervalSince(titleAt) < 15, let title = titleCache[key] { return done(title, "") }
        titleWaiting.append((key,done))
        guard titleWaiting.count == 1 else { return }
        get("/v1/users/{uid}/chats?limit=100") { json in
            if let rows = json as? [[String:Any]] {
                self.titleCache = Dictionary(rows.compactMap { row -> (String,String)? in
                    guard let key = row["key"] as? String else { return nil }
                    return (key, String((row["title"] as? String ?? "对话").prefix(160)))
                }, uniquingKeysWith: { _,new in new })
                self.titleAt = Date()
            }
            let waiting = self.titleWaiting; self.titleWaiting = []
            for (key,callback) in waiting {
                callback(self.titleCache[key] ?? Catalog.shared.chats.first(where: { $0.data["key"] == key })?.title ?? "对话", "")
            }
        }
    }
    private func get(_ path: String, _ done: @escaping (Any?) -> Void) {
        let cfg = AppDelegate.shared.config
        guard let url = URL(string: cfg.server + path.replacingOccurrences(of: "{uid}", with: cfg.uid)) else { return done(nil) }
        var request = URLRequest(url:url); request.timeoutInterval = 8
        URLSession.shared.dataTask(with: request) { d, _, _ in
            let j = d.flatMap { try? JSONSerialization.jsonObject(with: $0) }
            DispatchQueue.main.async { done(j) }
        }.resume()
    }

    // ------------------------------------------------ menus: the Dock's and the menu bar's
    /// "未读提醒" at the top of a menu: each conversation with news (a click opens its manager), and "全部标为已读".
    func addItems(to m: NSMenu) {
        guard !unread.isEmpty else { return }
        let h = NSMenuItem(title: "未读提醒（\(unread.count)）", action: nil, keyEquivalent: ""); h.isEnabled = false; m.addItem(h)
        for u in unread.reversed().prefix(10) {
            let mark = u.kind == "done" ? "✓" : u.kind == "failed" ? "✗" : "⏸"
            let i = ActionItem("\(mark) \(String(u.title.prefix(36)))\(u.project.map { " — \($0)" } ?? "")") { self.open(u) }
            i.toolTip = u.text; m.addItem(i)
        }
        m.addItem(ActionItem("全部标为已读", symbol: "checkmark.circle") { self.markAllRead() })
        m.addItem(.separator())
    }
}
