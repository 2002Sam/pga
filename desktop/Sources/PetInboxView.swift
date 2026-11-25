import AppKit

/// The cat and its inbox always share one horizontal center, including after resizing.
enum PetLayout {
    static let catSize = NSSize(width:156,height:104)
    static func frame(previous: NSRect, screen: NSRect, expanded: Bool) -> NSRect {
        let size = expanded ? NSSize(width:360,height:450) : NSSize(width:156,height:120)
        let center = previous.width > 0 ? previous.midX : screen.maxX - 96
        let bottom = previous.height > 0 ? previous.minY : screen.minY + 16
        return NSRect(x:max(screen.minX,min(center-size.width/2,screen.maxX-size.width)),
                      y:max(screen.minY,min(bottom,screen.maxY-size.height)),width:size.width,height:size.height)
    }
    static func cat(in width: CGFloat) -> NSRect {
        NSRect(x:(width-catSize.width)/2,y:0,width:catSize.width,height:catSize.height)
    }
}

/// Native, compact companion inbox. Rows are single accessible buttons, with quiet
/// status icons, separate metadata, and a generous hover target.
final class PetInboxView: NSVisualEffectView {
    var onHover: ((Bool) -> Void)?
    private static func label(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular,
                              color: NSColor = .labelColor) -> NSTextField {
        let label = PetPassthroughLabel(labelWithString:text)
        label.font = .systemFont(ofSize:size,weight:weight); label.textColor = color
        label.lineBreakMode = .byTruncatingTail
        return label
    }
    init(frame: NSRect, items: [PetItem], unread: Int, page: Int, target: AnyObject,
         open: Selector, close: Selector, turn: Selector) {
        super.init(frame:frame)
        material = .popover; blendingMode = .behindWindow; state = .active; wantsLayer = true
        layer?.cornerRadius = 22; layer?.masksToBounds = true
        layer?.borderWidth = 0.5; layer?.borderColor = NSColor.labelColor.withAlphaComponent(0.12).cgColor
        let title = Self.label("会话",size:15,weight:.semibold)
        title.frame = NSRect(x:20,y:bounds.height-41,width:100,height:22); addSubview(title)
        let subtitle = Self.label(unread > 0 ? "\(unread) 条未读" : "最近完成",size:11,color:.secondaryLabelColor)
        subtitle.frame = NSRect(x:63,y:bounds.height-39,width:180,height:18); addSubview(subtitle)
        let closeButton = NSButton(image:NSImage(systemSymbolName:"xmark",accessibilityDescription:"收起会话")!,target:target,action:close)
        closeButton.isBordered = false; closeButton.contentTintColor = .secondaryLabelColor
        closeButton.frame = NSRect(x:bounds.width-45,y:bounds.height-43,width:28,height:28)
        closeButton.toolTip = "收起"; addSubview(closeButton)
        let divider = NSBox(frame:NSRect(x:18,y:bounds.height-57,width:bounds.width-36,height:1))
        divider.boxType = .separator; addSubview(divider)
        let pages = max(1,Int(ceil(Double(items.count)/20)))
        let start = page*20, end = min(items.count,start+20)
        let scroll = NSScrollView(frame:NSRect(x:10,y:40,width:bounds.width-20,height:bounds.height-106))
        scroll.drawsBackground = false; scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        let list = PetRows(frame:NSRect(x:0,y:0,width:scroll.contentSize.width,height:max(scroll.contentSize.height,CGFloat(end-start)*80)))
        for i in start..<end {
            let row = PetInboxRow(frame:NSRect(x:0,y:CGFloat(i-start)*80,width:list.bounds.width,height:76),item:items[i])
            row.tag = i; row.target = target; row.action = open; list.addSubview(row)
        }
        if items.isEmpty {
            let empty = Self.label("还没有新消息",size:14,weight:.medium)
            empty.alignment = .center; empty.frame = NSRect(x:0,y:70,width:list.bounds.width,height:24); list.addSubview(empty)
            let hint = Self.label("会话处理完成后，会出现在这里",size:12,color:.secondaryLabelColor)
            hint.alignment = .center; hint.frame = NSRect(x:0,y:101,width:list.bounds.width,height:20); list.addSubview(hint)
        }
        scroll.documentView = list; addSubview(scroll)
        let foot = Self.label(pages > 1 ? "第 \(page+1) / \(pages) 页" : "点击会话，继续交流",size:10,color:.tertiaryLabelColor)
        foot.frame = NSRect(x:20,y:14,width:bounds.width-100,height:16); addSubview(foot)
        if pages > 1 {
            for direction in [-1,1] {
                let button = NSButton(image:NSImage(systemSymbolName:direction < 0 ? "chevron.left" : "chevron.right",accessibilityDescription:direction < 0 ? "上一页" : "下一页")!,target:target,action:turn)
                button.tag = direction; button.isBordered = false
                button.frame = NSRect(x:bounds.width + (direction < 0 ? -75 : -43),y:9,width:28,height:26)
                button.isEnabled = direction < 0 ? page > 0 : page < pages-1; addSubview(button)
            }
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func updateTrackingAreas() {
        super.updateTrackingAreas(); trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect:bounds,options:[.mouseEnteredAndExited,.activeAlways,.inVisibleRect],owner:self,userInfo:nil))
    }
    override func mouseEntered(with event: NSEvent) { onHover?(true) }
    override func mouseExited(with event: NSEvent) { onHover?(false) }
}
private final class PetRows: NSView { override var isFlipped: Bool { true } }
private final class PetPassthroughLabel: NSTextField { override func hitTest(_ point: NSPoint) -> NSView? { nil } }
private final class PetInboxRow: NSButton {
    private let item: PetItem
    private var hovered = false
    override var isFlipped: Bool { true }
    init(frame: NSRect, item: PetItem) {
        self.item = item; super.init(frame:frame)
        isBordered = false; title = ""; toolTip = item.body
        setAccessibilityLabel("\(item.read ? "已读" : "未读") · \(item.kind == "done" ? "已完成" : item.kind == "failed" ? "未完成" : "等待批准") · \(item.title) · \(item.sub)，打开会话")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func updateTrackingAreas() {
        super.updateTrackingAreas(); trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect:bounds,options:[.mouseEnteredAndExited,.activeAlways,.inVisibleRect],owner:self,userInfo:nil))
    }
    override func mouseEntered(with event: NSEvent) { hovered = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovered = false; needsDisplay = true }
    override var allowsVibrancy: Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        effectiveAppearance.performAsCurrentDrawingAppearance { drawRow() }
    }
    override func resetCursorRects() { addCursorRect(bounds,cursor:.pointingHand) }
    private func drawRow() {
        let dark = effectiveAppearance.bestMatch(from:[.darkAqua,.aqua]) == .darkAqua
        let primary = dark ? NSColor(white:0.96,alpha:1) : NSColor(white:0.15,alpha:1)
        let secondary = dark ? NSColor(white:0.78,alpha:1) : NSColor(white:0.42,alpha:1)
        if hovered || isHighlighted || !item.read {
            NSColor.labelColor.withAlphaComponent(isHighlighted ? 0.10 : hovered ? 0.07 : 0.035).setFill()
            NSBezierPath(roundedRect:bounds.insetBy(dx:1,dy:1),xRadius:12,yRadius:12).fill()
        }
        let color: NSColor = item.kind == "failed" ? .systemOrange : item.kind == "done" ? secondary : .systemBlue
        let symbol = item.kind == "done" ? "checkmark.circle" : item.kind == "failed" ? "exclamationmark.circle" : "clock"
        let icon = NSImage(systemSymbolName:symbol,accessibilityDescription:nil)?.withSymbolConfiguration(.init(pointSize:16,weight:.regular))
        if let icon {
            let tinted = NSImage(size:icon.size,flipped:false) { rect in
                icon.draw(in:rect); color.setFill(); rect.fill(using:.sourceAtop); return true
            }
            tinted.draw(in:NSRect(x:12,y:15,width:18,height:18),from:.zero,operation:.sourceOver,fraction:1,respectFlipped:true,hints:nil)
        }
        func line(_ value: String, y: CGFloat, size: CGFloat, weight: NSFont.Weight, color: NSColor) {
            let style = NSMutableParagraphStyle(); style.lineBreakMode = .byTruncatingTail
            (value as NSString).draw(in:NSRect(x:41,y:y,width:bounds.width-64,height:18),withAttributes:[.font:NSFont.systemFont(ofSize:size,weight:weight),.foregroundColor:color,.paragraphStyle:style])
        }
        line(item.title,y:10,size:12,weight:item.read ? .medium : .semibold,color:primary)
        line(item.sub.isEmpty ? (item.kind == "done" ? "已完成" : item.kind == "failed" ? "需要关注" : "等待批准") : item.sub,y:30,size:10,weight:.regular,color:secondary)
        line(item.body.isEmpty ? "打开会话，查看详情" : item.body.replacingOccurrences(of:"\n",with:" "),y:48,size:11,weight:.regular,color:secondary)
        if !item.read {
            NSColor.systemBlue.setFill(); NSBezierPath(ovalIn:NSRect(x:bounds.width-15,y:17,width:5,height:5)).fill()
        }
    }
}
