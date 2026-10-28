import AppKit

/// The kinds of window, and what can be added from the right-click menu: recent conversations, skills, documents and
/// world-tree topics, fetched from the PGA server and kept for a couple of minutes.
enum Kind: String {
    case conv, note, file, skill, doc, topic

    var label: String { ["conv": "对话", "note": "笔记", "file": "文件", "skill": "技能", "doc": "资料", "topic": "世界树主题"][rawValue]! }
    var color: NSColor {
        let hex: [String: UInt32] = ["conv": 0x8fb4ff, "note": 0xa1a1aa, "file": 0x5fc9c0, "skill": 0xe9b35f, "doc": 0x7fcf9f, "topic": 0xd6a75c]
        let v = hex[rawValue]!
        return NSColor(srgbRed: CGFloat(v >> 16 & 0xff) / 255, green: CGFloat(v >> 8 & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }
    var size: NSSize { self == .conv ? NSSize(width: 420, height: 580) : NSSize(width: 260, height: self == .note ? 200 : 170) }
}

struct Item { let title: String; let sub: String; let data: [String: String] }

final class Catalog {
    static let shared = Catalog()
    var chats: [Item] = [], skills: [Item] = [], docs: [Item] = [], topics: [Item] = []
    private var at = Date.distantPast

    private func get(_ path: String, _ done: @escaping (Any?) -> Void) {
        let cfg = AppDelegate.shared.config
        guard let url = URL(string: cfg.server + path.replacingOccurrences(of: "{uid}", with: cfg.uid)) else { return done(nil) }
        URLSession.shared.dataTask(with: url) { d, _, _ in
            let j = d.flatMap { try? JSONSerialization.jsonObject(with: $0) }
            DispatchQueue.main.async { done(j) }
        }.resume()
    }

    func refresh(force: Bool = false) {
        guard force || Date().timeIntervalSince(at) > 120 else { return }
        at = Date()
        get("/v1/users/{uid}/chats?limit=40") { j in
            self.chats = (j as? [[String: Any]] ?? []).map { c in
                let t = c["title"] as? String ?? "新对话"
                return Item(title: t, sub: c["agent"] as? String ?? "", data: ["key": c["key"] as? String ?? "", "title": t])
            }
        }
        get("/v1/users/{uid}/forest") { j in
            let ks = (j as? [String: Any])?["knowledge"] as? [[String: Any]] ?? []
            func item(_ k: [String: Any]) -> Item {
                let t = k["title"] as? String ?? "", g = (k["gist"] as? String) ?? (k["brief"] as? String) ?? ""
                return Item(title: t, sub: g, data: ["title": t, "text": g, "ref": k["id"] as? String ?? ""])
            }
            self.docs = ks.filter { !["user", "world"].contains($0["system"] as? String ?? "") && ($0["kind"] as? String) != "skill" }.map(item)
            let mine = ks.filter { ($0["kind"] as? String) == "skill" }.map(item)
            self.get("/v1/users/{uid}/canvas-palette") { j in
                let ps = ((j as? [String: Any])?["skills"] as? [[String: Any]] ?? []).map { s -> Item in
                    let n = s["name"] as? String ?? "", src = (s["source"] as? String) == "hermes" ? "Hermes" : "Claude Code"
                    return Item(title: n, sub: "\(src) · \(s["description"] as? String ?? "")", data: ["title": n, "path": s["path"] as? String ?? "", "text": s["description"] as? String ?? ""])
                }
                self.skills = mine + ps
            }
        }
        get("/v1/users/{uid}/world") { j in
            let ns = (j as? [String: Any])?["nodes"] as? [[String: Any]] ?? []
            self.topics = ns.filter { ($0["kind"] as? String) == "topic" && ($0["hidden"] as? Bool) != true }
                .sorted { ($0["depth"] as? Int ?? 9) < ($1["depth"] as? Int ?? 9) }.prefix(60).map { n in
                    let t = n["title"] as? String ?? "", s = n["summary"] as? String ?? ""
                    return Item(title: t, sub: s, data: ["title": t, "text": String(s.prefix(1200)), "ref": n["id"] as? String ?? ""])
                }
        }
    }

    /// A skill's full text (SKILL.md), read through the server.
    func skillBody(_ path: String, _ done: @escaping (String) -> Void) {
        let enc = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path
        get("/v1/users/{uid}/canvas-skill?path=\(enc)") { j in done(((j as? [String: Any])?["text"] as? String) ?? "") }
    }
}
