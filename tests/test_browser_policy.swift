import Foundation
@main enum BrowserPolicyTests {
    static func main() {
        for value in ["https://example.com/", "http://localhost:8000/a", "https://example.com/?q=你好"] {
            assert(BrowserPolicy.pageURL(value) != nil, value)
        }
        for value in ["javascript:alert(1)", "file:///etc/passwd", "pga://app/v1/users", "data:text/html,hello", "about:blank", "https://user:secret@example.com/", "https://", "ftp://example.com/"] {
            assert(BrowserPolicy.pageURL(value) == nil, value)
        }
        assert(BrowserPolicy.isAppPage(URL(string: "http://localhost:8010/?view=stage"), server: "http://localhost:8010"))
        assert(BrowserPolicy.isAppPage(URL(string: "https://pga.example.com:443/"), server: "https://pga.example.com"))
        for value in ["http://localhost:8011/", "https://localhost:8010/", "http://localhost.evil.test:8010/", "http://127.0.0.1:8010/", "file:///tmp/index.html"] {
            assert(!BrowserPolicy.isAppPage(URL(string: value), server: "http://localhost:8010"), value)
        }
        assert(!BrowserPolicy.isAppPage(nil, server: "http://localhost:8010"))
        for value in ["https://arxiv.org/pdf/2604.10809", "https://openreview.net/pdf?id=paper", "https://example.org/paper.PDF"] {
            assert(BrowserPolicy.isReadingPDF(URL(string: value)!))
        }
        for value in ["https://arxiv.org/html/2604.10809", "https://arxiv.org.evil.test/pdf/1"] {
            assert(!BrowserPolicy.isReadingPDF(URL(string: value)!))
        }
        print("Browser URL validation and native bridge origin checks passed")
    }
}
