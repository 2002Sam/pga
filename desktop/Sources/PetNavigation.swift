import Foundation

/// JSON encoding keeps conversation keys/project names out of executable JS syntax.
enum PetNavigation {
    static func script(key: String, project: String?) -> String {
        let payload: [String:Any] = ["key":key,"project":project ?? ""]
        let data = try! JSONSerialization.data(withJSONObject:payload)
        let json = String(data:data,encoding:.utf8)!
        return """
        (() => {
          if (typeof S === 'undefined' || !S.uid || typeof stOpenCompleted !== 'function') return null;
          const item = \(json);
          return stOpenCompleted(item.key, item.project);
        })()
        """
    }
}
