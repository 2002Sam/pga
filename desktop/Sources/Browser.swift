import AppKit
import WebKit

/// A real top-level web view positioned inside the file workspace's page slot.
/// Only the active page is attached. Two unedited pages stay warm; hiding the viewer
/// releases their renderers after 30 seconds. Pages with form edits stay intact.
final class EmbeddedBrowser {
    weak var host: DropWebView?
    private var pages: [String: BrowserPage] = [:]
    private var active: String?
    private var visible = Set<String>()
    private var layingOut = false
    private var clock = 0
    private var releaseWork: DispatchWorkItem?

    private var wheelMonitor: Any?
    private var rightGesture = BrowserRightGesture()
    private var capturedRightDown: NSEvent?
    private var capturedRightPageID: String?
    private var swallowRightUp = false
    private var replayEventNumbers = Set<Int>()
    private var notificationTokens: [NSObjectProtocol] = []
    private weak var observedWindow: NSWindow?
    private struct ForwardedPointer {
        let pageID: String
        let gesture: String
        let sequence: Int
        var clientX: Double
        var clientY: Double
        var controlKey: Bool
        var metaKey: Bool
        var shiftKey: Bool
    }
    private var pointerSequence = 0
    private var forwardedPointer: ForwardedPointer?
    private var swallowMiddleUp = false

    init(host: DropWebView) {
        self.host = host
        observeHostWindow()
        // WKWebView's internal scroll view consumes wheel events before the
        // WKWebView subclass sees them. A local monitor lets the native reading
        // overlay hand only stage-owned modified wheels back to its host.
        wheelMonitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .rightMouseDown, .rightMouseDragged, .rightMouseUp,
                                                                    .otherMouseDown, .otherMouseDragged, .otherMouseUp]) { [weak self] event in
            guard let self else { return event }
            return BrowserWheelBridge.monitorResult(event) { self.monitorWheelOrRightClick($0) }
        }
    }
    deinit {
        releaseWork?.cancel()
        if let wheelMonitor { NSEvent.removeMonitor(wheelMonitor) }
        notificationTokens.forEach(NotificationCenter.default.removeObserver)
    }

    private func forwardStageWheel(_ event: NSEvent) -> NSEvent? {
        guard let host, let (id, page) = stagePage(at: event) else { return event }
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let rightButton = (NSEvent.pressedMouseButtons & (1 << 1)) != 0
        guard var payload = BrowserWheelBridge.payload(
            deltaX: event.scrollingDeltaX, deltaY: event.scrollingDeltaY,
            precise: event.hasPreciseScrollingDeltas,
            shiftKey: modifiers.contains(.shift), rightButton: rightButton,
            controlKey: modifiers.contains(.control), metaKey: modifiers.contains(.command),
            stageWheel: page.stageWheel
        ) else { return event }
        payload["id"] = id
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return event }
        host.evaluateJavaScript("window.stNativeWheel && window.stNativeWheel(\(json));", completionHandler: nil)
        return nil
    }

    private func zoomStagePage(_ event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let rightButton = (NSEvent.pressedMouseButtons & (1 << 1)) != 0
        guard let (_, page) = stagePage(at: event), let web = page.web,
              let zoom = BrowserWheelBridge.zoomLevel(current: Double(web.pageZoom),
                deltaY: event.scrollingDeltaY, precise: event.hasPreciseScrollingDeltas,
                controlKey: modifiers.contains(.control), metaKey: modifiers.contains(.command),
                shiftKey: modifiers.contains(.shift), rightButton: rightButton,
                stageWheel: page.stageWheel) else { return false }
        web.pageZoom = CGFloat(zoom)
        return true
    }

    private func stagePage(at event: NSEvent) -> (String, BrowserPage)? {
        guard let host, let window = host.window, event.window === window,
              let hit = window.contentView?.hitTest(event.locationInWindow) else { return nil }
        return visible.compactMap { id -> (String, BrowserPage)? in
            guard let page = pages[id], page.stageWheel,
                  let web = page.web, !web.isHidden, let clip = page.clipView,
                  clip.window === window, web.window === window else { return nil }
            let local = clip.convert(event.locationInWindow, from: nil)
            guard clip.bounds.contains(local), hit === web || hit.isDescendant(of: web) else { return nil }
            return (id, page)
        }.first
    }

    private func stagePointerPage(at event: NSEvent) -> (String, BrowserPage)? {
        guard let host, let window = host.window, event.window === window,
              let hit = window.contentView?.hitTest(event.locationInWindow) else { return nil }
        return visible.compactMap { id -> (String, BrowserPage)? in
            guard let page = pages[id], page.stagePointer,
                  let web = page.web, !web.isHidden, let clip = page.clipView,
                  clip.window === window, web.window === window else { return nil }
            let local = clip.convert(event.locationInWindow, from: nil)
            guard clip.bounds.contains(local), hit === web || hit.isDescendant(of: web) else { return nil }
            return (id, page)
        }.first
    }

    private func pointerPoint(_ event: NSEvent, page: BrowserPage) -> (x: Double, y: Double)? {
        guard let host, let window = host.window, page.viewportWidth > 0 else { return nil }
        let screenPoint = event.window?.convertPoint(toScreen: event.locationInWindow) ?? NSEvent.mouseLocation
        let hostWindowPoint = window.convertPoint(fromScreen: screenPoint)
        let point = host.convert(hostWindowPoint, from: nil)
        return BrowserPointerBridge.clientPoint(x: Double(point.x), y: Double(point.y),
            boundsWidth: Double(host.bounds.width), boundsHeight: Double(host.bounds.height),
            viewportWidth: page.viewportWidth, isFlipped: host.isFlipped)
    }

    private func emitPointer(_ state: ForwardedPointer, phase: String,
                             point: (x: Double, y: Double)? = nil) {
        guard let host, pages[state.pageID] != nil else { return }
        let p = point ?? (state.clientX, state.clientY)
        guard let body = BrowserPointerBridge.payload(id: state.pageID, gesture: state.gesture,
            phase: phase, sequence: state.sequence, clientX: p.x, clientY: p.y,
            controlKey: state.controlKey, metaKey: state.metaKey, shiftKey: state.shiftKey),
            let bytes = try? JSONSerialization.data(withJSONObject: body),
            let json = String(data: bytes, encoding: .utf8) else { return }
        host.evaluateJavaScript("window.stNativePointer && window.stNativePointer(\(json));", completionHandler: nil)
    }

    private func beginForwardedPointer(_ event: NSEvent, gesture: String) -> Bool {
        guard forwardedPointer == nil, let (id, page) = stagePointerPage(at: event),
              let point = pointerPoint(event, page: page) else { return false }
        pointerSequence = pointerSequence == Int.max ? 1 : pointerSequence + 1
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let state = ForwardedPointer(pageID: id, gesture: gesture, sequence: pointerSequence,
            clientX: point.x, clientY: point.y, controlKey: flags.contains(.control),
            metaKey: flags.contains(.command), shiftKey: flags.contains(.shift))
        forwardedPointer = state
        emitPointer(state, phase: "down", point: point)
        return true
    }

    private func continueForwardedPointer(_ event: NSEvent, phase: String) -> Bool {
        guard var state = forwardedPointer,
              let page = pages[state.pageID], let point = pointerPoint(event, page: page) else { return false }
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        state.clientX = point.x; state.clientY = point.y
        state.controlKey = flags.contains(.control); state.metaKey = flags.contains(.command); state.shiftKey = flags.contains(.shift)
        forwardedPointer = state
        emitPointer(state, phase: phase, point: point)
        if phase == "up" || phase == "cancel" { forwardedPointer = nil }
        return true
    }

    private func cancelForwardedPointer(pageID: String? = nil) {
        guard let state = forwardedPointer, pageID == nil || pageID == state.pageID else { return }
        emitPointer(state, phase: "cancel")
        forwardedPointer = nil
        if state.gesture == "right" { swallowRightUp = true }
        if state.gesture == "middle" { swallowMiddleUp = true }
    }

    private func monitorWheelOrRightClick(_ event: NSEvent) -> NSEvent? {
        if (event.type == .rightMouseDown || event.type == .rightMouseUp),
           replayEventNumbers.remove(event.eventNumber) != nil { return event }
        if event.type == .rightMouseDragged, forwardedPointer?.gesture == "right" {
            _ = continueForwardedPointer(event, phase: "move"); return nil
        }
        if event.type == .rightMouseDragged, let down = capturedRightDown {
            if !rightGesture.consumed, abs(event.locationInWindow.x - down.locationInWindow.x) >= 6,
               stagePointerPage(at: down)?.0 == capturedRightPageID,
               beginForwardedPointer(down, gesture: "right") {
                rightGesture.cancel()
                capturedRightDown = nil
                capturedRightPageID = nil
                _ = continueForwardedPointer(event, phase: "move")
            }
            return nil
        }
        if event.type == .otherMouseDragged, event.buttonNumber == 2, forwardedPointer?.gesture == "middle" {
            _ = continueForwardedPointer(event, phase: "move"); return nil
        }
        if event.type == .rightMouseUp, forwardedPointer?.gesture == "right" {
            _ = continueForwardedPointer(event, phase: "up"); return nil
        }
        if event.type == .otherMouseUp, event.buttonNumber == 2 {
            if forwardedPointer?.gesture == "middle" { _ = continueForwardedPointer(event, phase: "up"); return nil }
            if swallowMiddleUp { swallowMiddleUp = false; return nil }
            return event
        }
        if event.type == .otherMouseDown {
            swallowMiddleUp = false
            if event.modifierFlags.intersection(.deviceIndependentFlagsMask).contains(.command) { return event }
            if event.buttonNumber == 2, beginForwardedPointer(event, gesture: "middle") { return nil }
            return event
        }
        if event.type == .rightMouseDown {
            // A fresh gesture supersedes any release marker left by focus loss.
            swallowRightUp = false
            if capturedRightDown != nil { rightGesture.cancel(); capturedRightDown = nil; capturedRightPageID = nil }
            let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            if modifiers.contains(.command) { return event }
            guard let (pageID, _) = stagePage(at: event) else { return event }
            rightGesture.cancel()
            guard rightGesture.begin(stageWheel: true) else { return event }
            capturedRightDown = event
            capturedRightPageID = pageID
            return nil
        }
        if event.type == .scrollWheel {
            if zoomStagePage(event) { rightGesture.wheelForwarded(); return nil }
            let result = forwardStageWheel(event)
            if result == nil { rightGesture.wheelForwarded() }
            return result
        }
        guard event.type == .rightMouseUp else { return event }
        guard let replay = rightGesture.end() else {
            if swallowRightUp { swallowRightUp = false; return nil }
            return event
        }
        let down = capturedRightDown, pageID = capturedRightPageID
        capturedRightDown = nil; capturedRightPageID = nil
        guard replay, let down, BrowserRightGesture.isShortClick(from: down.timestamp, to: event.timestamp),
              let pageID, isStagePageVisible(pageID, in: event.window),
              stagePage(at: down)?.0 == pageID else { return nil }
        // Queue both originals in order. Synchronous dispatch of mouse-down can
        // enter AppKit's menu tracking loop before it has a chance to receive up.
        replayEventNumbers.insert(down.eventNumber); replayEventNumbers.insert(event.eventNumber)
        DispatchQueue.main.async { [weak self] in
            guard let self, self.isStagePageVisible(pageID, in: down.window),
                  self.stagePage(at: down)?.0 == pageID else { return }
            NSApp.postEvent(down, atStart: false); NSApp.postEvent(event, atStart: false)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                self.replayEventNumbers.remove(down.eventNumber); self.replayEventNumbers.remove(event.eventNumber)
            }
        }
        return nil
    }

    private func observeHostWindow() {
        guard let window = host?.window, observedWindow !== window else { return }
        cancelRightClick()
        notificationTokens.forEach(NotificationCenter.default.removeObserver)
        notificationTokens.removeAll(); observedWindow = window
        let windowToken = NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: window, queue: .main) { [weak self] _ in self?.cancelRightClick() }
        let closeToken = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in self?.cancelRightClick() }
        let appToken = NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: NSApp, queue: .main) { [weak self] _ in self?.cancelRightClick() }
        notificationTokens.append(windowToken); notificationTokens.append(closeToken); notificationTokens.append(appToken)
    }

    private func cancelRightClick() {
        cancelForwardedPointer()
        if capturedRightDown != nil { swallowRightUp = true }
        rightGesture.cancel(); capturedRightDown = nil; capturedRightPageID = nil
    }

    private func isStagePageVisible(_ id: String, in eventWindow: NSWindow?) -> Bool {
        guard let host, let page = pages[id], visible.contains(id), page.stageWheel,
              let web = page.web, !web.isHidden, let clip = page.clipView,
              let window = host.window, eventWindow === window,
              clip.window === window, web.window === window else { return false }
        return true
    }

    func stagePageForResponder(_ responder: NSView) -> BrowserPage? {
        visible.compactMap { pages[$0] }.first { page in
            guard page.stagePointer, let web = page.web else { return false }
            return responder === web || responder.isDescendant(of: web)
        }
    }

    func handle(_ body: [String: Any]) {
        guard let op = body["op"] as? String else { return }
        if op == "hide" { hide(); return }
        if op == "dispose" { closeAll(); return }
        if op == "layout" {
            let items = (body["items"] as? [[String: Any]] ?? []).prefix(12)
            let next = Set(items.compactMap { $0["id"] as? String })
            for id in visible.subtracting(next) { pages[id]?.detach() }
            visible = next; layingOut = true
            for item in items { var item = item; item["op"] = "show"; handle(item) }
            layingOut = false
            if items.isEmpty { hide() }
            return
        }
        guard let id = body["id"] as? String, !id.isEmpty, id.count < 8192 else { return }
        if op == "close" {
            cancelForwardedPointer(pageID: id)
            if active == id { active = nil }
            visible.remove(id)
            pages.removeValue(forKey: id)?.dispose(); return
        }
        if op == "show" {
            guard let host, let value = body["url"] as? String, let url = BrowserPolicy.pageURL(value),
                  let box = body["rect"] as? [String: Double], let vw = body["viewportWidth"] as? Double, vw > 0,
                  let x = box["x"], let y = box["y"], let width = box["width"], let height = box["height"],
                  [x, y, width, height, vw].allSatisfy({ $0.isFinite }), width > 0, height > 0 else { hide(); return }
            observeHostWindow()
            releaseWork?.cancel(); releaseWork = nil
            if !layingOut {
                for old in visible where old != id { pages[old]?.detach() }
                visible = [id]
            }
            active = id
            let page: BrowserPage
            if let old = pages[id] { page = old }
            else {
                page = BrowserPage(id: id, url: url, owner: self); pages[id] = page
            }
            trim(except: id)
            clock += 1; page.used = clock
            page.readingMode = body["reading"] as? Bool ?? false
            page.stageWheel = body["stageWheel"] as? Bool ?? false
            page.stagePointer = body["stagePointer"] as? Bool ?? false
            page.markDigits = page.stagePointer ? body["markDigits"] as? String ?? "" : ""
            page.viewportWidth = vw
            if let theme = body["theme"] as? [String: Any] { page.readingTheme = theme }
            let scale = host.bounds.width / vw
            let rect = NSRect(x: x * scale, y: host.isFlipped ? y * scale : host.bounds.height - (y + height) * scale,
                              width: width * scale, height: height * scale)
            var clip = rect.intersection(host.bounds)
            if let box = body["clip"] as? [String: Double], let cx = box["x"], let cy = box["y"], let cw = box["width"], let ch = box["height"],
               [cx, cy, cw, ch].allSatisfy({ $0.isFinite }), cw > 0, ch > 0 {
                clip = NSRect(x: cx * scale, y: host.isFlipped ? cy * scale : host.bounds.height - (cy + ch) * scale,
                              width: cw * scale, height: ch * scale).intersection(clip)
            }
            guard !clip.isEmpty else { page.detach(); visible.remove(id); return }
            page.attach(to: host, rect: rect, clip: clip)
            page.state(); return
        }
        guard let page = pages[id] else { return }
        switch op {
        case "navigate": if let text = body["url"] as? String, let url = BrowserPolicy.pageURL(text) { page.navigate(url) }
        case "back": page.web?.goBack()
        case "forward": page.web?.goForward()
        case "reload": page.reload()
        case "stop": page.web?.stopLoading(); page.state()
        case "locate": if let anchor = body["anchor"] as? String, anchor.count <= 80 { page.readCommand("locate", value: anchor) }
        case "readScroll": if let ratio = body["ratio"] as? Double, ratio.isFinite { page.readCommand("scroll", value: min(1, max(0, ratio))) }
        case "readOffset": if let top = body["top"] as? Double, top.isFinite { page.readCommand("offset", value: max(0, min(1_000_000, top))) }
        case "readTheme": if let theme = body["theme"] as? [String: Any] { page.readingTheme = theme; page.readCommand("theme", value: theme) }
        case "readTranslations":
            if let target = body["target"] as? String, ["en", "zh-CN"].contains(target),
               let blocks = body["blocks"] as? [[String: Any]], blocks.count <= 6,
               blocks.allSatisfy({ (($0["id"] as? String)?.count ?? 0) > 0 && (($0["id"] as? String)?.count ?? 100) <= 20 && (($0["text"] as? String)?.count ?? 20000) <= 16000 && (($0["source"] as? String)?.count ?? 4000) <= 3000 }) {
                page.readCommand("translations", value: ["target": target, "blocks": blocks])
            }
        case "readClearTranslations": page.readCommand("clearTranslations")
        case "read": page.readCommand("start")
        default: break
        }
    }

    private func trim(except id: String) {
        let warm = pages.values.filter { $0.web != nil && !$0.edited && $0.id != id && !visible.contains($0.id) }.sorted { $0.used > $1.used }
        // A newly created page has not allocated its renderer yet.
        for page in warm.dropFirst(1) { page.suspend() }
    }
    func hide() {
        for id in visible { pages[id]?.detach() }; visible.removeAll(); active = nil
        guard releaseWork == nil else { return }
        let task = DispatchWorkItem { [weak self] in
            guard let self, self.active == nil else { return }
            self.pages.values.filter { !$0.edited }.forEach { $0.suspend() }; self.releaseWork = nil
        }
        releaseWork = task; DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: task)
    }
    func closeAll() {
        cancelForwardedPointer()
        releaseWork?.cancel(); releaseWork = nil; active = nil; visible.removeAll()
        pages.values.forEach { $0.dispose() }; pages.removeAll()
    }
    func emit(_ data: [String: Any], from page: BrowserPage) {
        guard pages[page.id] === page, let host,
              let bytes = try? JSONSerialization.data(withJSONObject: data), let json = String(data: bytes, encoding: .utf8) else { return }
        if data["action"] != nil || ["selection", "markDigit"].contains(data["event"] as? String ?? "") { host.window?.makeFirstResponder(host) }
        host.evaluateJavaScript("window.pgaBrowserState && window.pgaBrowserState(\(json))", completionHandler: nil)
    }
}

private final class BrowserWebView: WKWebView {
    var shortcut: ((String) -> Void)?
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if let focused = window?.firstResponder as? NSView, focused !== self, !focused.isDescendant(of: self) { return false }
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if flags == .command, let key = event.charactersIgnoringModifiers?.lowercased() {
            if key == "l" { shortcut?("address"); return true }
            if key == "w" { shortcut?("close"); return true }
            if key == "r" { reload(); return true }
        }
        if flags.contains(.control), event.keyCode == 48 { shortcut?(flags.contains(.shift) ? "previous" : "next"); return true }
        return super.performKeyEquivalent(with: event)
    }
}

private final class BrowserEditSignal: NSObject, WKScriptMessageHandler {
    weak var page: BrowserPage?
    init(_ page: BrowserPage) { self.page = page }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        // The isolated content world only reports that a field changed, never its value.
        guard message.body as? String == "edited" else { return }
        page?.edited = true
    }
}

private final class BrowserReadingSignal: NSObject, WKScriptMessageHandler {
    weak var page: BrowserPage?
    init(_ page: BrowserPage) { self.page = page }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let page,
              var data = message.body as? [String: Any], let event = data["event"] as? String,
              ["document", "selection", "scroll", "pageSize", "pageSelected", "markDigit"].contains(event),
              event != "pageSelected" || page.stagePointer,
              event != "markDigit" || (page.stagePointer && (data["digit"] as? String).map { $0.count == 1 && page.markDigits.contains($0) } == true),
              event == "pageSize" ? (!page.readingMode || page.stagePointer) : page.readingMode,
              let bytes = try? JSONSerialization.data(withJSONObject: data), bytes.count <= 1_000_000 else { return }
        data["id"] = page.id
        page.owner?.emit(data, from: page)
    }
}

final class BrowserPage: WebChrome {
    let id: String
    weak var owner: EmbeddedBrowser?
    var web: WKWebView?
    var used = 0
    var edited = false
    var readingMode = false
    var stageWheel = false
    var markDigits = "" { didSet { if oldValue != markDigits { readCommand("marks", value: markDigits) } } }
    var stagePointer = false
    var viewportWidth = 0.0
    var readingTheme: [String: Any] = [:]
    private let readingWorld = WKContentWorld.world(name: "PGA reading")
    fileprivate var clipView: NSView?
    private var url: URL
    private var title = "", error = ""
    private var pendingURL: URL?
    private var observations: [NSKeyValueObservation] = []
    private var stateWork: DispatchWorkItem?
    private var timeout: DispatchWorkItem?

    init(id: String, url: URL, owner: EmbeddedBrowser) { self.id = id; self.url = url; self.owner = owner; super.init() }
    deinit { stateWork?.cancel(); timeout?.cancel() }

    func attach(to host: WKWebView, rect: NSRect, clip: NSRect) {
        if web == nil {
            let config = WKWebViewConfiguration()
            config.websiteDataStore = .default()
            // No privileged PGA bridge or local-file scheme. A separate script world
            // reports only input activity so memory reclamation cannot lose form edits.
            let world = WKContentWorld.world(name: "PGA page lifecycle")
            config.userContentController.add(BrowserEditSignal(self), contentWorld: world, name: "pageEdit")
            config.userContentController.addUserScript(WKUserScript(source: """
            addEventListener('input', e => {
              if (e.isTrusted) webkit.messageHandlers.pageEdit.postMessage('edited');
            }, true);
            """, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: world))
            config.preferences.javaScriptCanOpenWindowsAutomatically = false
            if let scriptURL = Bundle.main.url(forResource: "reader", withExtension: "js"),
               let source = try? String(contentsOf: scriptURL, encoding: .utf8) {
                config.userContentController.add(BrowserReadingSignal(self), contentWorld: readingWorld, name: "reader")
                config.userContentController.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentEnd,
                                                                       forMainFrameOnly: true, in: readingWorld))
            }
            let view = BrowserWebView(frame: rect, configuration: config)
            view.navigationDelegate = self; view.uiDelegate = self
            view.allowsBackForwardNavigationGestures = true
            view.shortcut = { [weak self] action in guard let self else { return }; self.owner?.emit(["id": self.id, "action": action], from: self) }
            web = view
            observations = [view.observe(\.url, options: [.new]) { [weak self] _, _ in self?.scheduleState() },
                            view.observe(\.title, options: [.new]) { [weak self] _, _ in self?.scheduleState() },
                            view.observe(\.isLoading, options: [.new]) { [weak self] _, _ in self?.scheduleState() },
                            view.observe(\.canGoBack, options: [.new]) { [weak self] _, _ in self?.scheduleState() },
                            view.observe(\.canGoForward, options: [.new]) { [weak self] _, _ in self?.scheduleState() }]
            navigate(url)
        }
        guard let web else { return }
        // Siblings expose both web areas to accessibility. Nesting one WKWebView
        // inside another renders correctly but hides the site's AX tree.
        let container = host.superview ?? host
        let full = host.convert(rect, to: container), clipped = host.convert(clip, to: container)
        if clipView == nil { let view = NSView(); view.wantsLayer = true; view.layer?.masksToBounds = true; clipView = view }
        guard let clipView else { return }
        clipView.frame = clipped
        web.frame = NSRect(x: full.minX - clipped.minX, y: full.minY - clipped.minY, width: full.width, height: full.height)
        if web.superview !== clipView { clipView.addSubview(web) }
        if clipView.superview !== container { container.addSubview(clipView); web.setAllMediaPlaybackSuspended(false, completionHandler: nil) }
        web.isHidden = !error.isEmpty
    }
    func detach() { web?.pauseAllMediaPlayback(completionHandler: nil); web?.setAllMediaPlaybackSuspended(true, completionHandler: nil); clipView?.removeFromSuperview(); stageWheel = false; stagePointer = false }
    func suspend() {
        if pendingURL == nil, let current = web?.url, BrowserPolicy.pageURL(current.absoluteString) != nil { url = current }
        detach(); timeout?.cancel(); timeout = nil; stateWork?.cancel(); stateWork = nil
        observations.removeAll(); web?.stopLoading(); web?.navigationDelegate = nil; web?.uiDelegate = nil; web?.removeFromSuperview(); web = nil; clipView = nil
        state()
    }
    func dispose() { suspend(); owner = nil }
    func navigate(_ target: URL) {
        url = target; pendingURL = target; error = ""; web?.isHidden = false
        web?.load(URLRequest(url: target, timeoutInterval: 45))
    }
    func reload() { if error.isEmpty, web?.url != nil { web?.reload() } else { navigate(url) } }
    func readCommand(_ command: String, value: Any? = nil) {
        guard readingMode else { return }
        let values: [Any] = value.map { [$0] } ?? []
        guard let bytes = try? JSONSerialization.data(withJSONObject: values), let json = String(data: bytes, encoding: .utf8) else { return }
        web?.evaluateJavaScript("window.__pgaReading && window.__pgaReading.\(command)(...\(json))", in: nil,
                                in: readingWorld, completionHandler: nil)
    }
    private func scheduleState() {
        guard stateWork == nil else { return }
        let task = DispatchWorkItem { [weak self] in self?.stateWork = nil; self?.state() }
        stateWork = task; DispatchQueue.main.async(execute: task)
    }
    func state() {
        if pendingURL == nil, let current = web?.url, BrowserPolicy.pageURL(current.absoluteString) != nil { url = current }
        if let text = web?.title, !text.isEmpty { title = text }
        owner?.emit(["id": id, "url": url.absoluteString, "title": title, "loading": web?.isLoading ?? false,
                     "back": web?.canGoBack ?? false, "forward": web?.canGoForward ?? false, "error": error, "suspended": web == nil], from: self)
    }
    private func failed(_ message: String) {
        timeout?.cancel(); timeout = nil; error = message; web?.isHidden = true; state()
    }
    override func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = a.request.url else { decisionHandler(.cancel); return }
        let differentDocument = w.url?.absoluteString.components(separatedBy: "#").first != url.absoluteString.components(separatedBy: "#").first
        if a.navigationType == .linkActivated,
           a.targetFrame?.isMainFrame != false, BrowserPolicy.pageURL(url.absoluteString) != nil,
           (a.targetFrame == nil || (differentDocument && (!readingMode || BrowserPolicy.isReadingPDF(url)))), let owner {
            decisionHandler(.cancel)
            owner.emit(["id": id, "open": url.absoluteString], from: self)
            return
        }
        if BrowserPolicy.pageURL(url.absoluteString) != nil || (a.targetFrame?.isMainFrame == false && ["about", "blob", "data"].contains(url.scheme ?? "")) {
            decisionHandler(.allow); return
        }
        if a.navigationType == .linkActivated, ["mailto", "tel"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }
    override func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
        if a.navigationType == .linkActivated, let url = a.request.url, BrowserPolicy.pageURL(url.absoluteString) != nil { owner?.emit(["id": id, "open": url.absoluteString], from: self) }
        return nil
    }
    func webView(_ w: WKWebView, didStartProvisionalNavigation n: WKNavigation!) {
        error = ""; w.isHidden = false; timeout?.cancel()
        let task = DispatchWorkItem { [weak self, weak w] in
            guard let self, let w, w.isLoading else { return }
            w.stopLoading(); self.failed("连接超时，请重试或在外部浏览器中打开。")
        }
        timeout = task; DispatchQueue.main.asyncAfter(deadline: .now() + 45, execute: task); state()
    }
    func webView(_ w: WKWebView, didCommit n: WKNavigation!) { pendingURL = nil; edited = false; state() }
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { timeout?.cancel(); timeout = nil; pendingURL = nil; error = ""; w.isHidden = false; state(); readCommand("theme", value: readingTheme); readCommand("start"); readCommand("marks", value: markDigits) }
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { navigationFailed(e) }
    func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { navigationFailed(e) }
    private func navigationFailed(_ e: Error) {
        if (e as NSError).code == NSURLErrorCancelled { state(); return }
        failed(e.localizedDescription)
    }
    func webViewWebContentProcessDidTerminate(_ w: WKWebView) { failed("网页进程已退出，请刷新页面。") }
    override func webView(_ w: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if isPGAFileDownload(response.response.url) { decisionHandler(.download); return }
        if response.isForMainFrame && !response.canShowMIMEType { failed("此文件无法在网页中显示，请在外部浏览器中打开或下载。"); decisionHandler(.cancel) }
        else { decisionHandler(.allow) }
    }
}
