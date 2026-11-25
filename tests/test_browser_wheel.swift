import Foundation

@main enum BrowserWheelTests {
    static func main() {
        func values(_ payload: [String: Any]?) -> (Double, Double)? {
            guard let payload,
                  let x = payload["deltaX"] as? Double,
                  let y = payload["deltaY"] as? Double else { return nil }
            return (x, y)
        }

        // Precise trackpad deltas are pixels; AppKit vertical direction is
        // inverted to match DOM WheelEvent.deltaY.
        let trackpad = values(BrowserWheelBridge.payload(deltaX: 4, deltaY: 9, precise: true,
            shiftKey: true, rightButton: false, controlKey: false, metaKey: false,
            stageWheel: true))!
        assert(trackpad.0 == -4 && trackpad.1 == -9)
        let shiftedHorizontal = values(BrowserWheelBridge.payload(deltaX: 6, deltaY: 0, precise: true,
            shiftKey: true, rightButton: false, controlKey: false, metaKey: false,
            stageWheel: true))!
        assert(shiftedHorizontal.0 == -6 && shiftedHorizontal.1 == 0,
               "Shift-wheel already mapped to AppKit deltaX must keep WebKit direction")

        // Coarse mouse-wheel units become useful DOM pixels.
        let mouse = values(BrowserWheelBridge.payload(deltaX: 0, deltaY: 1, precise: false,
            shiftKey: false, rightButton: true, controlKey: false, metaKey: false,
            stageWheel: true))!
        assert(mouse.0 == 0 && mouse.1 == -32)

        // Ordinary wheel, zoom gestures, and non-stage overlays remain untouched.
        assert(BrowserWheelBridge.payload(deltaX: 0, deltaY: 2, precise: true,
            shiftKey: false, rightButton: false, controlKey: false, metaKey: false,
            stageWheel: true) == nil)
        assert(BrowserWheelBridge.payload(deltaX: 0, deltaY: 2, precise: true,
            shiftKey: true, rightButton: false, controlKey: true, metaKey: false,
            stageWheel: true) == nil)
        assert(BrowserWheelBridge.payload(deltaX: 0, deltaY: 2, precise: true,
            shiftKey: true, rightButton: false, controlKey: false, metaKey: true,
            stageWheel: true) == nil)
        assert(BrowserWheelBridge.payload(deltaX: 0, deltaY: 2, precise: true,
            shiftKey: true, rightButton: false, controlKey: false, metaKey: false,
            stageWheel: false) == nil)

        let zoomIn = BrowserWheelBridge.zoomLevel(current: 1, deltaY: 1, precise: false,
            controlKey: true, metaKey: false, shiftKey: false, rightButton: false,
            stageWheel: true)!
        let zoomOut = BrowserWheelBridge.zoomLevel(current: 1, deltaY: -1, precise: false,
            controlKey: true, metaKey: false, shiftKey: false, rightButton: false,
            stageWheel: true)!
        assert(zoomIn > 1 && zoomOut < 1, "AppKit wheel direction must match WebKit/DOM zoom direction")
        assert(BrowserWheelBridge.zoomLevel(current: 2.49, deltaY: 100, precise: true,
            controlKey: true, metaKey: false, shiftKey: false, rightButton: false,
            stageWheel: true) == 2.5)
        assert(BrowserWheelBridge.zoomLevel(current: 0.61, deltaY: -100, precise: true,
            controlKey: true, metaKey: false, shiftKey: false, rightButton: false,
            stageWheel: true) == 0.6)
        assert(BrowserWheelBridge.zoomLevel(current: 1, deltaY: 10, precise: true,
            controlKey: false, metaKey: false, shiftKey: false, rightButton: false,
            stageWheel: true) == nil)
        assert(BrowserWheelBridge.zoomLevel(current: 1, deltaY: 10, precise: true,
            controlKey: true, metaKey: true, shiftKey: false, rightButton: false,
            stageWheel: true) == nil)
        assert(BrowserWheelBridge.zoomLevel(current: 1, deltaY: 10, precise: true,
            controlKey: true, metaKey: false, shiftKey: true, rightButton: false,
            stageWheel: true) == nil, "Shift-wheel keeps horizontal-pan priority")
        assert(BrowserWheelBridge.zoomLevel(current: 1, deltaY: 10, precise: true,
            controlKey: true, metaKey: false, shiftKey: false, rightButton: true,
            stageWheel: true) == nil, "Right-button wheel keeps its existing gesture path")
        assert(BrowserWheelBridge.zoomLevel(current: 1, deltaY: 10, precise: true,
            controlKey: true, metaKey: false, shiftKey: false, rightButton: false,
            stageWheel: false) == nil)

        var plainClick = BrowserRightGesture()
        assert(BrowserRightGesture.isShortClick(from: 1, to: 1.49))
        assert(!BrowserRightGesture.isShortClick(from: 1, to: 1.5))
        assert(plainClick.begin(stageWheel: true))
        assert(plainClick.end() == true, "right-click without wheel is replayed")
        var pannedClick = BrowserRightGesture()
        assert(pannedClick.begin(stageWheel: true))
        pannedClick.wheelForwarded()
        assert(pannedClick.end() == false, "wheel gesture suppresses context menu")
        var outsideStage = BrowserRightGesture()
        assert(!outsideStage.begin(stageWheel: false), "non-stage right-click is untouched")

        // A nil local-monitor result means consume the event; it must not fall
        // back to the original event (the previous bug in the monitor closure).
        let consumed: Int? = BrowserWheelBridge.monitorResult(7) { _ in nil }
        assert(consumed == nil)
        let passed: Int? = BrowserWheelBridge.monitorResult(7) { $0 }
        assert(passed == 7)
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let browserSource = try! String(contentsOf: root.appendingPathComponent("desktop/Sources/Browser.swift"), encoding: .utf8)
        assert(browserSource.contains("guard let self else { return event }\n            return BrowserWheelBridge.monitorResult(event)"),
               "local monitor must preserve nil as an instruction to consume")
        assert(!browserSource.contains("monitorWheelOrRightClick(event) ?? event"))
        assert(browserSource.contains("if (event.type == .rightMouseDown || event.type == .rightMouseUp),\n           replayEventNumbers.remove(event.eventNumber) != nil"),
               "scroll-wheel events must not read the mouse-only event number")
        assert(browserSource.contains("stagePage(at: down)?.0 == pageID"),
               "context replay must still hit the captured page at the original coordinates")

        let flippedPoint = BrowserPointerBridge.clientPoint(x: 200, y: 100, boundsWidth: 1200,
            boundsHeight: 800, viewportWidth: 600, isFlipped: true)!
        assert(flippedPoint.x == 100 && flippedPoint.y == 50,
               "host points scale into top-level CSS pixels with a flipped WKWebView y-axis")
        let unflippedPoint = BrowserPointerBridge.clientPoint(x: 200, y: 100, boundsWidth: 1200,
            boundsHeight: 800, viewportWidth: 600, isFlipped: false)!
        assert(unflippedPoint.x == 100 && unflippedPoint.y == 350,
               "unflipped AppKit coordinates invert y before CSS scaling")
        assert(BrowserPointerBridge.clientPoint(x: .nan, y: 0, boundsWidth: 1200,
            boundsHeight: 800, viewportWidth: 600, isFlipped: true) == nil)
        let pointer = BrowserPointerBridge.payload(id: "browser:one", gesture: "middle", phase: "move",
            sequence: 42, clientX: 100, clientY: 50, controlKey: false, metaKey: false, shiftKey: true)!
        assert(pointer["id"] as? String == "browser:one")
        assert(pointer["gesture"] as? String == "middle" && pointer["phase"] as? String == "move")
        assert(pointer["sequence"] as? Int == 42 && pointer["clientX"] as? Double == 100)
        assert(BrowserPointerBridge.payload(id: "", gesture: "middle", phase: "down", sequence: 1,
            clientX: 0, clientY: 0, controlKey: false, metaKey: false, shiftKey: false) == nil)
        assert(BrowserPointerBridge.payload(id: "x", gesture: "left", phase: "down", sequence: 1,
            clientX: 0, clientY: 0, controlKey: false, metaKey: false, shiftKey: false) == nil)

        assert(browserSource.contains(".rightMouseDragged, .rightMouseUp,") &&
               browserSource.contains(".otherMouseDown, .otherMouseDragged, .otherMouseUp"),
               "native overlay observes right and middle pointer sequences")
        assert(browserSource.contains("beginForwardedPointer(down, gesture: \"right\")") &&
               browserSource.contains("modifiers.contains(.command) { return event }") &&
               browserSource.contains("!rightGesture.consumed, abs(event.locationInWindow.x - down.locationInWindow.x) >= 6"),
               "horizontal right drag starts forwarding after the click threshold")
        assert(browserSource.contains("if event.modifierFlags.intersection(.deviceIndependentFlagsMask).contains(.command) { return event }"),
               "Command-modified middle gestures are not consumed when the host declines them")
        assert(browserSource.contains("beginForwardedPointer(event, gesture: \"middle\")"),
               "middle button starts a forwarded stage gesture")
        assert(browserSource.contains(".rightMouseDragged, forwardedPointer?.gesture == \"right\"") &&
               browserSource.contains("event.buttonNumber == 2, forwardedPointer?.gesture == \"middle\""),
               "drag events remain attached to the gesture begun on the native page")
        assert(browserSource.contains("guard let page = pages[id], page.stagePointer") &&
               browserSource.contains("page.stageWheel = body[\"stageWheel\"] as? Bool ?? false") &&
               browserSource.contains("page.stagePointer = body[\"stagePointer\"] as? Bool ?? false"),
               "native pointer forwarding is separately gated from legacy browser wheel forwarding")
        assert(browserSource.contains("continueForwardedPointer(event, phase: \"up\")"),
               "mouse release closes the forwarded sequence")
        assert(browserSource.contains("window.stNativePointer && window.stNativePointer("),
               "forwarded events are delivered to the top-level host bridge")
        assert(browserSource.contains("cancelForwardedPointer(pageID: id)") &&
               browserSource.contains("cancelForwardedPointer()"),
               "closing the underlying native page cancels its active sequence")
        assert(browserSource.contains("NSWindow.willCloseNotification") &&
               browserSource.contains("NSApplication.didResignActiveNotification"),
               "closing or deactivating the host cancels native pointer forwarding")
        print("Native reading wheel bridge eligibility and delta mapping passed")
    }
}
