import AppKit

/// Where the desktop app keeps its own things: ~/Library/Application Support/PGA Desktop
/// - config.json: the PGA server, the account the windows open as (and, while developing, where the interface is)
/// - floats.json: the floating windows that are open, so they come back where they were
enum Store {
    static let dir: URL = {
        let d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("PGA Desktop")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()

    static func read<T: Decodable>(_ name: String, as: T.Type) -> T? {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent(name)) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    static func write<T: Encodable>(_ name: String, _ value: T) {
        let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? enc.encode(value) { try? data.write(to: dir.appendingPathComponent(name), options: .atomic) }
    }
}

struct Config: Codable {
    var server = "http://localhost:8010"
    var uid = ""
    var ui: String? = nil          // while developing: serve the interface from this folder (e.g. desktop/ui/dist) instead of the app
    var mode: String? = nil        // "bench": every window in one workbench window; "desk" (default): each on its own over the desktop
    var chat: String? = nil        // "light": conversations in the desktop app's own small page; else (default) the browser version's full page

    /// The account: the one in config.json, else the installation's owner (asked of the database once and kept).
    /// A WebKit window keeps its own storage, apart from Chrome's; without this it would start a new, empty account.
    static func load() -> Config {
        var c = Store.read("config.json", as: Config.self) ?? Config()
        if c.uid.isEmpty, let owner = Shell.run("docker exec pga-postgres-1 psql -U postgres -d pga -tAc \"select id from users where preferences->>'owner'='true' limit 1\""),
           owner.count == 36 {
            c.uid = owner
        }
        Store.write("config.json", c)
        return c
    }
}

/// A window on the desktop, as kept in floats.json: a conversation, or a node (note, file, skill, document, topic)
/// wired into one. `inputs`: the windows wired into this one (their right dot to its left dot).
struct SavedFloat: Codable {
    var id: String
    var key: String?
    var param: String
    var title: String
    var x: Double, y: Double, w: Double, h: Double
    var pinned: Bool
    var type: String?
    var data: [String: String]?
    var inputs: [String]?
    var card: [Double]?            // its place in the workbench window (x, y, w, h), when it has been there
}

enum Shell {
    /// Runs a command in a login shell (so docker and friends are on the PATH) and returns its trimmed output.
    @discardableResult
    static func run(_ command: String) -> String? {
        let p = Process(); let out = Pipe()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", command]
        p.standardOutput = out; p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// desktop.log next to the config: what the pages report (errors) and what the shell does, for when something goes wrong.
enum Log {
    static func write(_ line: String) {
        let url = Store.dir.appendingPathComponent("desktop.log")
        let stamp = ISO8601DateFormatter().string(from: Date())
        let data = Data("\(stamp) \(line)\n".utf8)
        if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(data); try? h.close() }
        else { try? data.write(to: url) }
    }
}
