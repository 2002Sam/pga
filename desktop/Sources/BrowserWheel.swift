import Foundation

/// Converts AppKit wheel events into the DOM-shaped payload used by the stage.
/// Kept independent of WebKit so direction, eligibility, and mouse-wheel units
/// can be verified without launching the desktop app.
enum BrowserWheelBridge {
    static func zoomLevel(current: Double, deltaY: Double, precise: Bool,
                          controlKey: Bool, metaKey: Bool, shiftKey: Bool,
                          rightButton: Bool, stageWheel: Bool) -> Double? {
        guard stageWheel, controlKey, !metaKey, !shiftKey, !rightButton else { return nil }
        let unit = precise ? 1.0 : 32.0
        // Convert AppKit's direction to DOM/WebKit's deltaY sign. A negative
        // DOM deltaY (wheel up) zooms in, so positive AppKit deltaY zooms in.
        let domDeltaY = -deltaY * unit
        return min(2.5, max(0.6, current * pow(1.0015, -domDeltaY)))
    }

    static func monitorResult<Event>(_ event: Event, handler: (Event) -> Event?) -> Event? {
        handler(event)
    }

    static func payload(deltaX: Double, deltaY: Double, precise: Bool,
                        shiftKey: Bool, rightButton: Bool,
                        controlKey: Bool, metaKey: Bool,
                        stageWheel: Bool) -> [String: Any]? {
        guard stageWheel, (shiftKey || rightButton), !controlKey, !metaKey else { return nil }
        let unit = precise ? 1.0 : 32.0
        return ["deltaX": -deltaX * unit,
                // WebKit exposes the opposite sign from AppKit on both axes.
                "deltaY": -deltaY * unit,
                "deltaMode": 0,
                "shiftKey": shiftKey,
                "rightButton": rightButton,
                "ctrlKey": controlKey,
                "metaKey": metaKey]
    }
}

/// Pure coordinate and payload helpers for forwarding native overlay gestures
/// to the stage document. AppKit points are converted to the host's CSS pixels.
enum BrowserPointerBridge {
    static func clientPoint(x: Double, y: Double, boundsWidth: Double, boundsHeight: Double,
                            viewportWidth: Double, isFlipped: Bool) -> (x: Double, y: Double)? {
        guard [x, y, boundsWidth, boundsHeight, viewportWidth].allSatisfy(\.isFinite),
              boundsWidth > 0, boundsHeight > 0, viewportWidth > 0 else { return nil }
        let scale = boundsWidth / viewportWidth
        guard scale.isFinite, scale > 0 else { return nil }
        return (x / scale, (isFlipped ? y : boundsHeight - y) / scale)
    }

    static func payload(id: String, gesture: String, phase: String, sequence: Int,
                        clientX: Double, clientY: Double,
                        controlKey: Bool, metaKey: Bool, shiftKey: Bool) -> [String: Any]? {
        guard !id.isEmpty, ["right", "middle"].contains(gesture),
              ["down", "move", "up", "cancel"].contains(phase), sequence > 0,
              clientX.isFinite, clientY.isFinite else { return nil }
        return ["id": id, "gesture": gesture, "phase": phase, "sequence": sequence,
                "clientX": clientX, "clientY": clientY, "ctrlKey": controlKey,
                "metaKey": metaKey, "shiftKey": shiftKey]
    }
}

struct BrowserRightGesture {
    static func isShortClick(from down: TimeInterval, to up: TimeInterval) -> Bool {
        (0..<0.5).contains(up - down)
    }
    private(set) var pending = false
    private(set) var consumed = false

    mutating func begin(stageWheel: Bool) -> Bool {
        guard stageWheel, !pending else { return false }
        pending = true; consumed = false
        return true
    }
    mutating func wheelForwarded() { if pending { consumed = true } }
    /// nil means there was no captured right-click; true means replay down/up;
    /// false means a forwarded wheel consumed the gesture.
    mutating func end() -> Bool? {
        guard pending else { return nil }
        let replay = !consumed
        pending = false; consumed = false
        return replay
    }
    mutating func cancel() { pending = false; consumed = false }
}
