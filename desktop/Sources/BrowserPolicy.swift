import Foundation

/// Web pages get an ordinary web view, never the app's native bridge or file scheme.
enum BrowserPolicy {
    static func pageURL(_ value: String) -> URL? {
        guard let url = URL(string: value), ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
              let host = url.host, !host.isEmpty, url.user == nil, url.password == nil else { return nil }
        return url
    }

    static func isReadingPDF(_ url: URL) -> Bool {
        if url.pathExtension.lowercased() == "pdf" { return true }
        let host = url.host?.lowercased() ?? ""
        let paperSite = ["arxiv.org", "openreview.net"].contains { host == $0 || host.hasSuffix("." + $0) }
        let path = url.path.lowercased()
        return paperSite && (path == "/pdf" || path.hasPrefix("/pdf/"))
    }

    static func isAppPage(_ url: URL?, server: String) -> Bool {
        guard let url, let origin = URL(string: server) else { return false }
        let port: (URL) -> Int? = { $0.port ?? ($0.scheme == "https" ? 443 : $0.scheme == "http" ? 80 : nil) }
        return url.scheme == origin.scheme && url.host == origin.host && port(url) == port(origin)
    }
}
