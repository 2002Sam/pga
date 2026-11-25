import Foundation

/// One lightweight record per conversation. Unread completions are never evicted by a display limit.
struct PetItem: Codable {
    var key: String
    var kind: String
    var title: String
    var sub: String
    var body: String
    var manager: Bool
    var project: String? = nil
    var read: Bool = false
    var eventID: String? = nil
}
struct PetInbox {
    private(set) var items: [PetItem] = []
    var latestUnread: PetItem? { items.first { !$0.read } }
    var unread: Int { items.filter { !$0.read }.count }
    init(_ saved: [PetItem] = []) { for item in saved.reversed() { put(item) } }
    mutating func put(_ source: PetItem) {
        var item = source
        if let id = item.eventID, let old = items.first(where: { $0.key == item.key && $0.eventID == id }) {
            item.read = item.read || old.read
        }
        item.title = String(item.title.prefix(160)); item.sub = String(item.sub.prefix(160)); item.body = String(item.body.prefix(260))
        items.removeAll { $0.key == item.key }; items.insert(item, at: 0); trim()
    }
    mutating func markRead(_ keys: [String]) {
        let set = Set(keys)
        for i in items.indices where set.contains(items[i].key) { items[i].read = true }
        trim()
    }
    mutating func markAllRead() { markRead(items.map(\.key)) }
    private mutating func trim() {
        var readCount = 0
        items = items.filter { item in
            if !item.read { return true }
            readCount += 1; return readCount <= 50
        }
    }
}
