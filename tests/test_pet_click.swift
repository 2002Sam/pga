import AppKit
// Isolated dependencies: no real inbox, preferences, server, or conversation is touched.
enum Store {
    static var data: [String:Data] = [:]
    static func read<T:Decodable>(_ name:String,as:T.Type)->T? { data[name].flatMap {try? JSONDecoder().decode(T.self,from:$0)} }
    static func write<T:Encodable>(_ name:String,_ value:T) {data[name]=try! JSONEncoder().encode(value)}
}
final class Alerts {
    static let shared = Alerts()
    struct Unread {var key:String;var project:String?;var title:String;var text:String;var kind:String;var at:Double}
    var unread:[Unread]=[];var enabled=true;var opened:[String]=[];var succeeds=true
    func openConversation(_ u:Unread,completion:((Bool)->Void)?=nil){
        opened.append(u.key)
        if succeeds { Toasts.shared.dismiss(keys:[u.key]) }
        completion?(succeeds)
    }
}
@main struct Test {
    static func main(){
        _ = NSApplication.shared
        let pet=Toasts.shared
        let older=PetItem(key:"chat:older",kind:"done",title:"Older",sub:"Test",body:"Body",manager:false,eventID:"run1")
        let latest=PetItem(key:"chat:latest",kind:"done",title:"Latest",sub:"Test",body:"Body",manager:false,eventID:"run2")
        pet.show(older);pet.show(latest)
        func saved()->[PetItem]{Store.read("pet-inbox.json",as:[PetItem].self)!}
        _ = pet.perform(NSSelectorFromString("toggle"))
        assert(Alerts.shared.opened == ["chat:latest"],"Cat click goes straight to latest unread")
        assert(saved().first(where:{$0.key==latest.key})!.read)
        assert(!saved().first(where:{$0.key==older.key})!.read,"Other messages stay unread")
        pet.show(latest)
        assert(saved().first(where:{$0.key==latest.key})!.read,"Duplicate doesn't become new")
        Alerts.shared.succeeds=false
        _ = pet.perform(NSSelectorFromString("toggle"))
        assert(!saved().first(where:{$0.key==older.key})!.read,"Failed navigation keeps unread")
        Alerts.shared.succeeds=true
        _ = pet.perform(NSSelectorFromString("toggle"))
        assert(saved().allSatisfy(\.read))
        let count=Alerts.shared.opened.count
        _ = pet.perform(NSSelectorFromString("toggle"))
        assert(Alerts.shared.opened.count == count,"No unread: cat opens history, not a read conversation")
        pet.restore()
        assert(saved().allSatisfy(\.read),"Restored history remains read")
        print("PASS: Actual pet click action, newest unread selection, acknowledgement, retry and restoration")
    }
}
