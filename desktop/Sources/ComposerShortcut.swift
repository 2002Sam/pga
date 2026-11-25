import AppKit
import WebKit

/// Modifier-only shortcuts arrive as flagsChanged events in an AppKit window.
final class ComposerShortcut {
    private var monitor: Any?
    private var armed = false

    init(web: WKWebView) {
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.flagsChanged, .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self, weak web] event in
            guard let self, let web else { return event }
            guard let window = web.window, window.isKeyWindow,
                  let responder = window.firstResponder as? NSView else {
                self.armed = false
                return event
            }
            let flags = event.modifierFlags.intersection([.control, .shift, .command, .option, .function])
            let browser = (web as? DropWebView)?.embeddedBrowser
            let page = browser?.stagePageForResponder(responder)
            let escape = event.type == .keyDown && event.keyCode == 53 && flags.isEmpty && page != nil
            guard (event.type == .flagsChanged || escape),
                  page != nil || responder === web || responder.isDescendant(of: web) else {
                self.armed = false
                return event
            }
            let modifierKey = [56, 59, 60, 62].contains(Int(event.keyCode))
            let toggle = self.armed && modifierKey && (flags == .control || flags == .shift)
            self.armed = modifierKey && flags == [.control, .shift]
            if (toggle || escape), let page {
                window.makeFirstResponder(web)
                browser?.emit(["id": page.id, "event": "leavePage"], from: page)
                if escape { return nil }
            } else if toggle {
                web.evaluateJavaScript("window.stToggleComposerFocus?.()", completionHandler: nil)
            }
            return event
        }
    }

    deinit { if let monitor { NSEvent.removeMonitor(monitor) } }
}
