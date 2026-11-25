import Foundation

/// What the server says its agents are doing (GET /v1/agents/live), boiled down to what a reminder needs. A finished
/// run stays in that list for about 40 s, so a poll every few seconds sees every one of them.
struct LiveRun {
    let id: String
    let key: String                  // the conversation (chat:…, chat:pm-… for a category's manager)
    let agent: String
    let started: Double
    let finished: Double?
    let ok: Bool?
    let error: String?
    let text: String
    let approval: (id: String, details: String)?
    var running: Bool { finished == nil }

    /// The rows of /v1/agents/live that serve one of `uid`'s conversations (their tag is "<uid>:<conversation key>").
    static func parse(_ json: Any?, uid: String) -> [LiveRun] {
        guard let rows = json as? [[String: Any]], !uid.isEmpty else { return [] }
        let prefix = uid + ":"
        return rows.compactMap { r in
            guard let id = r["id"] as? String, let tag = (r["tags"] as? [String: Any])?["conversation"] as? String,
                  tag.hasPrefix(prefix), tag.count > prefix.count else { return nil }
            var approval: (String, String)? = nil
            if let a = r["approval"] as? [String: Any], let aid = a["id"] as? String {
                approval = (aid, LiveRun.describe(a["details"]))
            }
            return LiveRun(id: id, key: String(tag.dropFirst(prefix.count)), agent: r["agent"] as? String ?? "",
                           started: (r["started"] as? NSNumber)?.doubleValue ?? 0, finished: (r["finished"] as? NSNumber)?.doubleValue,
                           ok: r["ok"] as? Bool, error: r["error"] as? String, text: r["text"] as? String ?? "", approval: approval)
        }
    }

    /// What an approval asks for, in a line: the tool and its command or file, else whatever it holds.
    static func describe(_ d: Any?) -> String {
        guard let d else { return "" }
        if let s = d as? String { return s }
        if let m = d as? [String: Any] {
            let tool = (m["tool"] ?? m["name"]) as? String ?? ""
            let input = m["input"] as? [String: Any] ?? m
            let what = ["command", "file_path", "path", "url", "description", "summary"].lazy.compactMap { input[$0] as? String }.first ?? ""
            let s = [tool, what].filter { !$0.isEmpty }.joined(separator: "：")
            if !s.isEmpty { return s }
        }
        guard let data = try? JSONSerialization.data(withJSONObject: d), let s = String(data: data, encoding: .utf8) else { return "" }
        return s
    }

    /// The last words an agent said, without the lines that only report its tools ("→ Bash …").
    var answerTail: String {
        let lines = text.components(separatedBy: "\n")
        let i = lines.lastIndex { $0.hasPrefix("→ ") }.map { $0 + 1 } ?? 0
        var said = lines[i...].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        if said.isEmpty { said = lines.filter { !$0.hasPrefix("→ ") }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines) }
        return said
    }
}

/// One thing worth telling you about: a conversation whose agents have all stopped (done or failed), or an agent waiting
/// for your approval.
struct AlertEvent {
    enum Kind: String { case done, failed, approval }
    let kind: Kind
    let key: String
    let run: LiveRun
    var approvalId: String? { kind == .approval ? run.approval?.id : nil }
}

/// Turns successive snapshots into events. A conversation is told about once all its runs have finished — an answer
/// made of several runs (council, convoy, a retry by the next agent) is one reminder, for the last of them. Runs that
/// finished before `since` (before the app started) are old news.
final class AlertTracker {
    let since: Double
    private var handled = Set<String>()        // finished runs already accounted for
    private var handledOrder: [String] = []
    private var askedOrder: [String] = []
    private var asked = Set<String>()          // approvals already told about

    init(since: Double) { self.since = since }

    func feed(_ runs: [LiveRun]) -> [AlertEvent] {
        var out: [AlertEvent] = []
        var byKey: [String: [LiveRun]] = [:], order: [String] = []
        for r in runs {
            if byKey[r.key] == nil { order.append(r.key) }
            byKey[r.key, default: []].append(r)
        }
        for key in order {
            let rs = byKey[key]!
            for r in rs where r.running {
                if let a = r.approval, !asked.contains(a.id) { asked.insert(a.id); askedOrder.append(a.id); out.append(AlertEvent(kind: .approval, key: key, run: r)) }
            }
            if rs.contains(where: \.running) { continue }                       // still at work: wait for the last of them
            let fresh = rs.filter { !handled.contains($0.id) }
            guard !fresh.isEmpty else { continue }
            fresh.forEach { handled.insert($0.id); handledOrder.append($0.id) }
            guard let last = fresh.max(by: { ($0.finished ?? 0) < ($1.finished ?? 0) }), (last.finished ?? 0) >= since else { continue }
            out.append(AlertEvent(kind: last.ok == false ? .failed : .done, key: key, run: last))
        }
        // Empty/transient snapshots must not resurrect an acknowledged event.
        // Keep a bounded recent history independently of what this poll contains.
        if handledOrder.count > 4096 {
            let expired = handledOrder.count-4096
            handledOrder.prefix(expired).forEach { handled.remove($0) }; handledOrder.removeFirst(expired)
        }
        if askedOrder.count > 4096 {
            let expired = askedOrder.count-4096
            askedOrder.prefix(expired).forEach { asked.remove($0) }; askedOrder.removeFirst(expired)
        }
        return out
    }
}
