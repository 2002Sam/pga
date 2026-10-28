import AppKit
import WebKit

/// The web side of every window. The new interface (ui/, built into the app) is served under pga://app/ by the app itself,
/// and its API calls (pga://app/v1/…) are passed on to the PGA server — one origin, so no CORS and no change to the
/// server. All windows share one WebKit store.
protocol WebOwner: AnyObject {
    func message(_ body: [String: Any])
}

final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var owner: WebOwner?
    init(_ owner: WebOwner) { self.owner = owner }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        if let body = m.body as? [String: Any] { owner?.message(body) }
    }
}

enum Web {
    static let scheme = SchemeHandler()

    static func make(owner: WebOwner, page: [String: Any]) -> DropWebView {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        cfg.setURLSchemeHandler(scheme, forURLScheme: "pga")
        let uc = WKUserContentController()
        var boot = page; boot["uid"] = AppDelegate.shared.config.uid
        let json = (try? JSONSerialization.data(withJSONObject: boot)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        uc.addUserScript(WKUserScript(source: """
        window.PGA_NATIVE = \(json);
        addEventListener("error", (e) => webkit.messageHandlers.pga.postMessage({ kind: "log", text: "error: " + e.message + " @" + e.filename + ":" + e.lineno }));
        addEventListener("unhandledrejection", (e) => webkit.messageHandlers.pga.postMessage({ kind: "log", text: "rejection: " + (e.reason && e.reason.message || e.reason) }));
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        uc.add(WeakHandler(owner), name: "pga")
        cfg.userContentController = uc
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        let web = DropWebView(frame: .zero, configuration: cfg)
        web.setValue(false, forKey: "drawsBackground")
        web.allowsBackForwardNavigationGestures = false
        return web
    }

    /// The browser version's own pages (served by the PGA server), with bridge.js added: the full conversation page in a
    /// window (`float`), or the whole app (完整版). They keep their storage in this app's WebKit store, so the account
    /// is put there before they load.
    static let bridge: String = {
        guard let u = Bundle.main.url(forResource: "bridge", withExtension: "js"), let s = try? String(contentsOf: u, encoding: .utf8) else { return "" }
        return s
    }()
    static func makeFull(owner: WebOwner, float: Bool) -> DropWebView {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        let uc = WKUserContentController(), uid = AppDelegate.shared.config.uid
        uc.addUserScript(WKUserScript(source: """
        try { if ("\(uid)") localStorage.setItem("pga_uid", "\(uid)"); } catch (e) {}
        window.PGA_NATIVE = { float: \(float), uid: "\(uid)" };
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        uc.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        uc.add(WeakHandler(owner), name: "pga")
        cfg.userContentController = uc
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        cfg.mediaTypesRequiringUserActionForPlayback = []
        let web = DropWebView(frame: .zero, configuration: cfg)
        web.takesPaths = float
        return web
    }
    /// "rgb(r, g, b)" / "rgba(r, g, b, a)" from a page's computed style.
    static func color(_ css: String) -> NSColor? {
        let n = css.components(separatedBy: CharacterSet(charactersIn: "0123456789.").inverted).compactMap(Double.init)
        guard n.count >= 3 else { return nil }
        return NSColor(srgbRed: n[0] / 255, green: n[1] / 255, blue: n[2] / 255, alpha: 1)
    }
    static func full(_ query: [String: String]) -> URL {
        var c = URLComponents(string: AppDelegate.shared.config.server + "/")!
        c.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        return c.url!
    }

    static func page(_ query: [String: String]) -> URL {
        var c = URLComponents(string: "pga://app/index.html")!
        c.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        return c.url!
    }

    /// Hands something to the page: window.pgaNative[fn](arg)
    static func call(_ web: WKWebView, _ fn: String, _ arg: Any) {
        guard let data = try? JSONSerialization.data(withJSONObject: [arg]), let s = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.pgaNative && window.pgaNative.\(fn) && window.pgaNative.\(fn)(...\(s))")
    }
}

/// pga://app/… : the interface's files from the app bundle (or from config.ui while developing), and /v1/… passed on.
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    private var live: [ObjectIdentifier: URLSessionDataTask] = [:]
    private let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 3600                  // an answer can take many minutes: the ask request waits for it
        c.timeoutIntervalForResource = 4 * 3600
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: c)
    }()

    var root: URL {
        if let dev = AppDelegate.shared.config.ui, !dev.isEmpty { return URL(fileURLWithPath: (dev as NSString).expandingTildeInPath) }
        return Bundle.main.resourceURL!.appendingPathComponent("ui")
    }

    func webView(_ w: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        if url.path.hasPrefix("/v1/") { proxy(task, url) } else { file(task, url) }
    }

    func webView(_ w: WKWebView, stop task: WKURLSchemeTask) {
        live.removeValue(forKey: ObjectIdentifier(task))?.cancel()
    }

    private func file(_ task: WKURLSchemeTask, _ url: URL) {
        var path = url.path; if path == "/" || path.isEmpty { path = "/index.html" }
        var f = root.appendingPathComponent(String(path.dropFirst()))
        if !FileManager.default.fileExists(atPath: f.path), f.pathExtension.isEmpty { f = root.appendingPathComponent("index.html") }
        guard f.standardizedFileURL.path.hasPrefix(root.standardizedFileURL.path), let data = try? Data(contentsOf: f) else {
            task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: [:])!); task.didFinish(); return
        }
        let types = ["html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8", "svg": "image/svg+xml",
                     "png": "image/png", "json": "application/json", "woff2": "font/woff2"]
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                        headerFields: ["Content-Type": types[f.pathExtension] ?? "application/octet-stream", "Cache-Control": "no-cache"])!)
        task.didReceive(data); task.didFinish()
    }

    private func proxy(_ task: WKURLSchemeTask, _ url: URL) {
        var c = URLComponents(string: AppDelegate.shared.config.server)!
        c.path = url.path; c.percentEncodedQuery = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery
        var req = URLRequest(url: c.url!)
        req.httpMethod = task.request.httpMethod ?? "GET"
        req.allHTTPHeaderFields = task.request.allHTTPHeaderFields
        req.httpBody = task.request.httpBody ?? task.request.httpBodyStream.map { s in
            var d = Data(); s.open(); defer { s.close() }
            var buf = [UInt8](repeating: 0, count: 65536)
            while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; d.append(buf, count: n) }
            return d
        }
        let id = ObjectIdentifier(task)
        let dt = session.dataTask(with: req) { [weak self] data, resp, err in
            DispatchQueue.main.async {
                guard let self, self.live.removeValue(forKey: id) != nil else { return }      // stopped meanwhile: nothing more for it
                if let err { Log.write("proxy failed \(url.path): \(err.localizedDescription)"); task.didFailWithError(err); return }
                let h = resp as? HTTPURLResponse
                var headers = (h?.allHeaderFields as? [String: String]) ?? [:]; for k in ["Content-Encoding", "Content-Length", "Transfer-Encoding"] { headers.removeValue(forKey: k) }   // URLSession has already unpacked the body
                task.didReceive(HTTPURLResponse(url: url, statusCode: h?.statusCode ?? 502, httpVersion: "HTTP/1.1", headerFields: headers)!)
                task.didReceive(data ?? Data()); task.didFinish()
            }
        }
        live[id] = dt; dt.resume()
    }
}

/// A web view that takes files dropped from Finder as paths (the agents run on this Mac and read them where they are).
final class DropWebView: WKWebView {
    var takesPaths = true                                   // false: drops go to the page itself (the whole app has its own)
    override func acceptsFirstMouse(for e: NSEvent?) -> Bool { true }        // a click on a window in the background acts at once
    private func paths(_ s: NSDraggingInfo) -> [String] {
        guard takesPaths else { return [] }
        return (s.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []).map(\.path)
    }
    override func draggingEntered(_ s: NSDraggingInfo) -> NSDragOperation {
        if !paths(s).isEmpty { Web.call(self, "dragging", true); return .copy }
        return super.draggingEntered(s)
    }
    override func draggingUpdated(_ s: NSDraggingInfo) -> NSDragOperation { paths(s).isEmpty ? super.draggingUpdated(s) : .copy }
    override func draggingExited(_ s: NSDraggingInfo?) { Web.call(self, "dragging", false); super.draggingExited(s) }
    override func performDragOperation(_ s: NSDraggingInfo) -> Bool {
        let p = paths(s); if p.isEmpty { return super.performDragOperation(s) }
        Web.call(self, "dragging", false); Web.call(self, "dropped", p); return true
    }
}

/// Browser chores WebKit leaves to its host: alerts, file pickers, links out of PGA, the microphone for voice input.
class WebChrome: NSObject, WKNavigationDelegate, WKUIDelegate {
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let server = URL(string: AppDelegate.shared.config.server)
        if let url = a.request.url, !["pga", "about", "blob", "data"].contains(url.scheme ?? ""), url.host != server?.host || url.port != server?.port {
            NSWorkspace.shared.open(url); decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }

    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
        if let url = a.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = m; a.runModal(); completionHandler()
    }

    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = m; a.addButton(withTitle: "好"); a.addButton(withTitle: "取消")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let o = NSOpenPanel(); o.allowsMultipleSelection = p.allowsMultipleSelection; o.canChooseDirectories = p.allowsDirectories
        completionHandler(o.runModal() == .OK ? o.urls : nil)
    }

    func webView(_ w: WKWebView, requestMediaCapturePermissionFor o: WKSecurityOrigin, initiatedByFrame f: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(o.protocol == "pga" ? .grant : .prompt)
    }
}
