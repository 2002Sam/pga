import Foundation
import JavaScriptCore
@main struct PetNavigationTests {
    static func main() {
        let js = JSContext()!
        let key = "chat:test'\"\\\n中文"
        let script = PetNavigation.script(key:key,project:nil)
        assert(js.evaluateScript(script)?.toBool() == false,"Cold stage must not acknowledge the click")
        js.evaluateScript("""
          var S={uid:'test'}, opened=[];
          function stOpenCompleted(key, project){opened.push({key,project});return true;}
        """)
        assert(js.evaluateScript(script)?.toBool() == true)
        assert(js.evaluateScript("opened[0].key")?.toString() == key,"Keys must remain data")
        let manager = PetNavigation.script(key:"chat:pm-test",project:"PGA")
        assert(js.evaluateScript(manager)?.toBool() == true)
        assert(js.evaluateScript("opened[1].project")?.toString() == "PGA")
        js.evaluateScript("S.uid=''")
        assert(js.evaluateScript(script)?.toBool() == false,"Wait for account initialization")
        print("PASS: Main-stage navigation, cold start, project forwarding and escaped keys")
    }
}
