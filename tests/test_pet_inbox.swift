import Foundation
@main enum PetInboxTests {
    static func main() {
        var inbox = PetInbox()
        for i in 0..<80 { inbox.put(PetItem(key:"c\(i)",kind:"done",title:"Chat \(i)",sub:"Codex",body:String(repeating:"x",count:1000),manager:false)) }
        assert(inbox.items.count == 80 && inbox.unread == 80)
        assert(inbox.items.allSatisfy { $0.body.count == 260 })
        inbox.markRead(["c1"]); assert(inbox.unread == 79 && inbox.items.count == 80)
        inbox.put(PetItem(key:"c1",kind:"failed",title:"Retry",sub:"Claude",body:"offline",manager:false))
        assert(inbox.items.count == 80 && inbox.unread == 80 && inbox.items.first?.key == "c1")
        inbox.markAllRead(); assert(inbox.items.count == 50 && inbox.unread == 0)
        let restored = PetInbox(inbox.items)
        assert(restored.items.map(\.key) == inbox.items.map(\.key))
        let tracker = AlertTracker(since:10)
        func run(_ id: String, _ key: String, _ finished: Double?, _ ok: Bool = true) -> LiveRun {
            LiveRun(id:id,key:key,agent:"codex",started:10,finished:finished,ok:ok,error:nil,text:"done",approval:nil)
        }
        let batch = (0..<8).map { run("r\($0)","k\($0)",20) }
        assert(tracker.feed(batch).count == 8)
        assert(tracker.feed(batch).isEmpty)
        assert(tracker.feed([run("a","shared",20),run("b","shared",nil)]).isEmpty)
        assert(tracker.feed([run("a","shared",20),run("b","shared",21,false)]).first?.kind == .failed)
        assert(tracker.feed([run("old","old",1)]).isEmpty)
        _ = tracker.feed([])
        assert(tracker.feed(batch).isEmpty, "A temporary empty snapshot must not replay read completions")
        var events = PetInbox()
        let notice = PetItem(key:"chat:new",kind:"done",title:"New",sub:"Codex",body:"Done",manager:false,eventID:"run-1:done")
        events.put(notice); assert(events.latestUnread?.key == notice.key)
        events.markRead([notice.key]); events.put(notice)
        assert(events.unread == 0 && events.latestUnread == nil,"Same event stays read")
        let saved = try! JSONEncoder().encode(events.items)
        events = PetInbox(try! JSONDecoder().decode([PetItem].self,from:saved))
        events.put(notice); assert(events.unread == 0,"Read state survives restart and duplicate delivery")
        var next = notice; next.eventID = "run-2:done"; events.put(next)
        assert(events.unread == 1,"A genuinely new reply in the same conversation is unread")
        var alreadySeen = notice; alreadySeen.key = "chat:seen"; alreadySeen.read = true
        events.put(alreadySeen); assert(events.unread == 1,"A completion already in front of the user stays read")
        print("Pet inbox: retention, deduplication, bounded summaries, read history and restoration passed")
    }
}
