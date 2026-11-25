import AppKit
import QuartzCore

/// Global coordinates keep the pointer offset stable while its window moves.
struct PetDragGesture {
    let pointer: NSPoint
    let windowOrigin: NSPoint
    private(set) var dragged = false

    mutating func update(_ point: NSPoint) -> NSPoint? {
        let dx = point.x - pointer.x, dy = point.y - pointer.y
        if dx * dx + dy * dy >= 25 { dragged = true }
        return dragged ? NSPoint(x:windowOrigin.x + dx,y:windowOrigin.y + dy) : nil
    }
}

/// Pointer interpretation is independent of animation and never consumes a click.
/// A stroke requires a deliberate back-and-forth across the head, with a cooldown.
struct PetPointerInteraction {
    struct Response {
        var near: Bool
        var x: CGFloat
        var y: CGFloat
        var petted: Bool
        var newPet: Bool
    }
    private var last: CGPoint?
    private var lastAt: Double = 0
    private var distance: CGFloat = 0
    private var direction: CGFloat = 0
    private var reversals = 0
    private var happyUntil: Double = 0
    private var nextPet: Double = 0

    mutating func resetStroke() { last = nil; distance = 0; direction = 0; reversals = 0 }
    mutating func pet(at now: Double) -> Bool {
        guard now >= nextPet else { return false }
        happyUntil = now + 1.35; nextPet = now + 2.4; resetStroke(); return true
    }
    mutating func observe(_ point: CGPoint, size: CGSize, at now: Double, pressed: Bool) -> Response {
        let area = CGRect(origin:.zero,size:size)
        let near = area.insetBy(dx:-100,dy:-80).contains(point)
        let head = CGRect(x:size.width*0.39,y:size.height*0.46,width:size.width*0.47,height:size.height*0.47)
        var newPet = false
        if !pressed && head.contains(point) {
            if let previous = last, now-lastAt < 0.4 {
                let dx = point.x-previous.x, dy = point.y-previous.y
                if abs(dx) >= 2 && abs(dy) < 20 {
                    let nextDirection: CGFloat = dx > 0 ? 1 : -1
                    if direction != 0 && direction != nextDirection { reversals += 1 }
                    direction = nextDirection; distance += min(abs(dx),30)
                    if distance >= 30 && reversals >= 1 { newPet = pet(at:now) }
                }
            } else { resetStroke() }
            last = point; lastAt = now
        } else { resetStroke() }
        let x = max(-1,min(1,(point.x-size.width*0.62)/90))
        let y = max(-1,min(1,(point.y-size.height*0.66)/70))
        return Response(near:near,x:near ? x : 0,y:near ? y : 0,petted:now < happyUntil,newPet:newPet)
    }
    static func dragAngle(delta: CGFloat, elapsed: Double) -> CGFloat {
        max(-0.12,min(0.12,-delta / max(1.0/120,elapsed)*0.0001))
    }
}

/// A small joint rig reuses the original illustration for head turns and paw scratches.
/// No frame timer, image regeneration, or inbox redraw is required for idle motion.
final class PetCompanionView: NSControl {
    var onInteraction: ((Bool) -> Void)?
    var onHover: ((Bool) -> Void)?
    var onShowInbox: (() -> Void)?
    var onToggleMusic: (() -> Void)?
    var musicEnabled: (() -> Bool)?
    private let musicRig = CALayer()
    private let musicGlow = CAGradientLayer()
    private var gesture: PetDragGesture?
    private let artwork = CALayer()
    private var face = CALayer()
    private let gaze = CALayer()
    private var pupils: [(layer: CALayer, travel: CGFloat)] = []
    private let affection = CAShapeLayer()
    private let reduceMotion: Bool
    private var pointer = PetPointerInteraction()
    private var pointerTimer: Timer?
    private var idleJoints: [(CALayer,String,CAAnimation)] = []
    private var engaged = false, hovering = false
    private var lastAim = CGPoint(x:99,y:99)
    private var lastDragPoint: NSPoint?
    private var lastDragTime: Double = 0

    init(frame: NSRect, image: NSImage?, reduceMotion: Bool, reaction: String?) {
        self.reduceMotion = reduceMotion
        super.init(frame:frame)
        wantsLayer = true
        guard let layer else { return }
        layer.masksToBounds = true
        addMeteorNight(to:layer, reduceMotion:reduceMotion)
        let size = image?.size ?? NSSize(width:1536,height:1024)
        let scale = min(bounds.width / max(1,size.width),bounds.height / max(1,size.height))
        artwork.frame = NSRect(x:(bounds.width-size.width*scale)/2,y:(bounds.height-size.height*scale)/2,width:size.width*scale,height:size.height*scale)
        artwork.contentsGravity = .resizeAspect
        artwork.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
        musicGlow.name = "petMusicGlow"; musicGlow.type = .radial; musicGlow.frame = bounds
        musicGlow.colors = [NSColor(srgbRed:1,green:0.7,blue:0.18,alpha:0.8).cgColor,NSColor.clear.cgColor]
        musicGlow.startPoint = CGPoint(x:0.5,y:0.5); musicGlow.endPoint = CGPoint(x:1,y:1)
        musicGlow.opacity = 0; layer.addSublayer(musicGlow)
        musicRig.name = "petMusicRig"; musicRig.frame = bounds; layer.addSublayer(musicRig)
        musicRig.addSublayer(artwork)
        let body = CALayer()
        body.frame = artwork.bounds; body.contents = image
        body.contentsGravity = .resizeAspect
        body.contentsScale = artwork.contentsScale
        artwork.addSublayer(body)
        face = artwork
        // Coordinates follow the supplied 1536 × 1024 witch-cat illustration.
        // Skip facial overlays for the application-icon fallback.
        if image != nil && abs(size.width / max(1,size.height) - 1.5) < 0.02 {
            if face === artwork { addJoints(image:image, body:body, reduceMotion:reduceMotion) }
            addEyes()
            addEyelid(points:[CGPoint(x:750,y:449),CGPoint(x:833,y:415),CGPoint(x:934,y:431),CGPoint(x:930,y:486),CGPoint(x:875,y:526),CGPoint(x:811,y:511),CGPoint(x:774,y:482)], reduceMotion:reduceMotion)
            addEyelid(points:[CGPoint(x:1001,y:410),CGPoint(x:1044,y:353),CGPoint(x:1113,y:329),CGPoint(x:1130,y:387),CGPoint(x:1118,y:430),CGPoint(x:1079,y:454),CGPoint(x:1035,y:446)], reduceMotion:reduceMotion)
        }
        installMouseResponses()
        react(reaction, reduceMotion:reduceMotion)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds,cursor:.openHand) }

    deinit { pointerTimer?.invalidate() }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        pointerTimer?.invalidate(); pointerTimer = nil
        if window == nil {
            if gesture != nil { settleDrag(); onInteraction?(false) }
            gesture = nil; lastDragPoint = nil; pointer.resetStroke()
            if hovering { hovering = false; onHover?(false) }
            return
        }
        guard !reduceMotion else { return }
        // Reading pointer position requires no global event tap or input permission.
        // The timer owns no view/window, and only updates layers when the aim changes.
        let timer = Timer(timeInterval:0.10,repeats:true) { [weak self] _ in self?.samplePointer() }
        timer.tolerance = 0.025
        RunLoop.main.add(timer,forMode:.common); pointerTimer = timer
    }
    private func samplePointer() {
        guard let window, window.isVisible, !isHiddenOrHasHiddenAncestor, gesture == nil else { return }
        let p = convert(window.convertPoint(fromScreen:NSEvent.mouseLocation),from:nil)
        observePointer(p,at:CACurrentMediaTime(),pressed:NSEvent.pressedMouseButtons != 0)
    }
    /// Also used by native event tests; points are in this view's coordinates.
    func observePointer(_ point: CGPoint, at now: Double, pressed: Bool = false) {
        guard !reduceMotion, gesture == nil else { return }
        let inside = bounds.contains(point)
        if inside != hovering { hovering = inside; onHover?(inside) }
        let response = pointer.observe(point,size:bounds.size,at:now,pressed:pressed)
        setEngaged(response.near || response.petted)
        if response.newPet { showAffection() }
        let aim = CGPoint(x:response.petted ? 0 : response.x,y:response.petted ? -0.3 : response.y)
        if abs(aim.x-lastAim.x) > 0.015 || abs(aim.y-lastAim.y) > 0.015 {
            lastAim = aim
            CATransaction.begin(); CATransaction.setAnimationDuration(0.16)
            var transform = CATransform3DMakeRotation(-aim.x*0.065 + aim.y*0.018,0,0,1)
            transform = CATransform3DScale(transform,1-abs(aim.x)*0.025,1,1)
            transform = CATransform3DTranslate(transform,aim.x*1.5,aim.y*1.2,0)
            gaze.transform = transform
            // Move within each fixed eye opening, independently of head rotation.
            for pupil in pupils {
                pupil.layer.transform = CATransform3DMakeTranslation(
                    aim.x*pupil.travel / 1536 * artwork.bounds.width,
                    aim.y*20 / 1024 * artwork.bounds.height,0)
            }
            CATransaction.commit()
        }
    }
    private func setEngaged(_ active: Bool) {
        guard active != engaged, !reduceMotion else { return }
        engaged = active
        let now = CACurrentMediaTime()
        for (joint,key,animation) in idleJoints {
            if active { joint.removeAnimation(forKey:key) }
            else {
                let resumed = animation.copy() as! CAAnimation
                resumed.beginTime = now; joint.add(resumed,forKey:key)
            }
        }
    }
    private func installMouseResponses() {
        artwork.name = "petArtwork"
        for joint in artwork.sublayers ?? [] {
            for key in ["petHeadTurn","petHeadLook","petScratch"] {
                if let animation = joint.animation(forKey:key) { idleJoints.append((joint,key,animation)) }
            }
        }
        if face !== artwork {
            gaze.name = "petGaze"; gaze.bounds = artwork.bounds
            gaze.anchorPoint = face.anchorPoint; gaze.position = face.position
            artwork.insertSublayer(gaze,below:face)
            face.removeFromSuperlayer(); gaze.addSublayer(face)
        }
        // One reusable heart, so repeated petting cannot accumulate particles.
        affection.name = "petAffection"; affection.bounds = CGRect(x:0,y:0,width:12,height:12)
        affection.position = CGPoint(x:bounds.width*0.31,y:bounds.height*0.73)
        let heart = CGMutablePath(); heart.move(to:CGPoint(x:6,y:1))
        heart.addCurve(to:CGPoint(x:0.8,y:8),control1:CGPoint(x:4,y:4),control2:CGPoint(x:-1,y:5))
        heart.addCurve(to:CGPoint(x:6,y:9),control1:CGPoint(x:1,y:12),control2:CGPoint(x:5,y:12))
        heart.addCurve(to:CGPoint(x:11.2,y:8),control1:CGPoint(x:7,y:12),control2:CGPoint(x:11,y:12))
        heart.addCurve(to:CGPoint(x:6,y:1),control1:CGPoint(x:13,y:5),control2:CGPoint(x:8,y:4))
        heart.closeSubpath(); affection.path = heart
        affection.fillColor = NSColor(srgbRed:0.94,green:0.43,blue:0.53,alpha:1).cgColor
        affection.opacity = 0; layer?.addSublayer(affection)
    }
    @objc func petHead() {
        guard !reduceMotion, pointer.pet(at:CACurrentMediaTime()) else { return }
        setEngaged(true); showAffection()
    }
    private func showAffection() {
        guard !reduceMotion else { return }
        // The neck joint tilts independently of pointer aiming and the body.
        // Use the same timeline as the closed eyes and heart, then return to neutral.
        let tilt = CAKeyframeAnimation(keyPath:"transform.rotation.z")
        let current = (face.presentation()?.value(forKeyPath:"transform.rotation.z") as? NSNumber)?.doubleValue ?? 0
        tilt.values = [current,0.14,0.16,0.14,0]
        tilt.keyTimes = [0,0.22,0.43,0.72,1]
        tilt.duration = 1.35
        tilt.timingFunctions = Array(repeating:CAMediaTimingFunction(name:.easeInEaseOut),count:4)
        face.add(tilt,forKey:"petHeadTilt")
        for lid in face.sublayers ?? [] where lid.name == "petEyelid" {
            let close = CAKeyframeAnimation(keyPath:"opacity")
            close.values = [0,1,1,0]; close.keyTimes = [0,0.12,0.8,1]; close.duration = 1.35
            lid.add(close,forKey:"petContented")
        }
        let opacity = CAKeyframeAnimation(keyPath:"opacity")
        opacity.values = [0,0.9,0.9,0]; opacity.keyTimes = [0,0.15,0.65,1]
        let rise = CABasicAnimation(keyPath:"transform.translation.y"); rise.fromValue = 0; rise.toValue = 12
        let scale = CAKeyframeAnimation(keyPath:"transform.scale"); scale.values = [0.7,1.1,1]
        let group = CAAnimationGroup(); group.animations = [opacity,rise,scale]; group.duration = 1.35
        affection.add(group,forKey:"petHeart")
    }
    var onHide: (() -> Void)?
    @objc private func hideCompanion() { onHide?() }
    override func menu(for event: NSEvent) -> NSMenu? {
        let menu = NSMenu(); menu.autoenablesItems = false
        let pet = NSMenuItem(title:"摸摸头",action:#selector(petHead),keyEquivalent:"")
        pet.target = self; pet.isEnabled = !reduceMotion; menu.addItem(pet)
        let inbox = NSMenuItem(title:"查看会话列表",action:#selector(showInbox),keyEquivalent:"")
        inbox.target = self; menu.addItem(inbox)
        let music = NSMenuItem(title:"音乐响应（系统声音）",action:#selector(toggleMusic),keyEquivalent:"")
        music.target = self; music.state = musicEnabled?() == true ? .on : .off
        music.isEnabled = onToggleMusic != nil; menu.addItem(.separator()); menu.addItem(music)
        menu.addItem(.separator())
        let hide = NSMenuItem(title:"隐藏桌面猫猫",action:#selector(hideCompanion),keyEquivalent:"")
        hide.target = self; menu.addItem(hide)
        return menu
    }
    @objc private func toggleMusic() { onToggleMusic?() }
    func respondToMusic(level: Double, beat: Bool) {
        let energy = max(0,min(1,level))
        CATransaction.begin(); CATransaction.setAnimationDuration(0.12)
        CATransaction.setDisableActions(reduceMotion)
        musicGlow.opacity = Float(energy * (reduceMotion ? 0.12 : 0.55))
        if !reduceMotion && gesture == nil { musicRig.setValue(energy*2,forKeyPath:"transform.translation.y") }
        if energy == 0 { musicRig.transform = CATransform3DIdentity; musicRig.removeAnimation(forKey:"petMusicBeat"); musicGlow.removeAnimation(forKey:"petMusicFlash") }
        CATransaction.commit()
        guard beat, !reduceMotion, gesture == nil else { return }
        let bounce = CAKeyframeAnimation(keyPath:"transform.translation.y")
        bounce.values = [energy*2,energy*2+4,energy*2]; bounce.keyTimes = [0,0.3,1]
        bounce.duration = 0.28; musicRig.add(bounce,forKey:"petMusicBeat")
        let flash = CABasicAnimation(keyPath:"opacity"); flash.fromValue = 0.85; flash.toValue = musicGlow.opacity
        flash.duration = 0.3; musicGlow.add(flash,forKey:"petMusicFlash")
    }
    @objc private func showInbox() { onShowInbox?() }
    private func dragFeedback(_ point: NSPoint, at now: Double) {
        guard !reduceMotion else { return }
        setEngaged(true); pointer.resetStroke()
        affection.removeAnimation(forKey:"petHeart")
        let previous = lastDragPoint ?? gesture?.pointer ?? point
        let angle = PetPointerInteraction.dragAngle(delta:point.x-previous.x,elapsed:now-lastDragTime)
        lastDragPoint = point; lastDragTime = now
        CATransaction.begin(); CATransaction.setAnimationDuration(0.10)
        artwork.setValue(angle,forKeyPath:"transform.rotation.z")
        CATransaction.commit()
    }
    private func settleDrag() {
        lastDragPoint = nil
        guard !reduceMotion else { return }
        let angle = (artwork.presentation()?.value(forKeyPath:"transform.rotation.z") as? NSNumber)?.doubleValue
            ?? (artwork.value(forKeyPath:"transform.rotation.z") as? NSNumber)?.doubleValue ?? 0
        CATransaction.begin(); CATransaction.setDisableActions(true)
        artwork.setValue(0,forKeyPath:"transform.rotation.z"); CATransaction.commit()
        let settle = CASpringAnimation(keyPath:"transform.rotation.z")
        settle.fromValue = angle; settle.toValue = 0; settle.mass = 1; settle.stiffness = 180; settle.damping = 19
        settle.duration = 0.5; artwork.add(settle,forKey:"petDragSettle")
    }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        gesture = PetDragGesture(pointer:window.convertPoint(toScreen:event.locationInWindow),windowOrigin:window.frame.origin)
        musicRig.removeAnimation(forKey:"petMusicBeat")
        CATransaction.begin(); CATransaction.setDisableActions(true)
        musicRig.transform = CATransform3DIdentity
        CATransaction.commit()
        lastDragPoint = gesture?.pointer; lastDragTime = CACurrentMediaTime()
        onInteraction?(true)
    }
    override func mouseDragged(with event: NSEvent) {
        guard let window else { return }
        if let origin = gesture?.update(window.convertPoint(toScreen:event.locationInWindow)) {
            dragFeedback(window.convertPoint(toScreen:event.locationInWindow),at:CACurrentMediaTime())
            NSCursor.closedHand.set()
            window.setFrameOrigin(origin)
        }
    }
    override func mouseUp(with event: NSEvent) {
        guard var completed = gesture else { return }
        // A coalesced mouse-up can carry the first movement past the threshold.
        if let window, let origin = completed.update(window.convertPoint(toScreen:event.locationInWindow)) {
            window.setFrameOrigin(origin)
        }
        gesture = nil
        if completed.dragged { settleDrag() }
        NSCursor.openHand.set()
        onInteraction?(false)
        if !completed.dragged && bounds.contains(convert(event.locationInWindow,from:nil)) {
            sendAction(action,to:target)
        }
    }
    override func accessibilityPerformPress() -> Bool { sendAction(action,to:target) }

    func react(_ reaction: String?, reduceMotion: Bool) {
        guard !reduceMotion, let reaction else { return }
        let animation = CAKeyframeAnimation(keyPath:reaction == "tap" ? "transform.scale" : "transform.translation.y")
        animation.values = reaction == "tap" ? [1,0.95,1.025,1] : [0,7,0,3,0]
        animation.duration = reaction == "tap" ? 0.32 : 0.75
        artwork.add(animation,forKey:"petReaction")
    }
    private func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
        CGPoint(x:x / 1536 * artwork.bounds.width,y:(1-y / 1024) * artwork.bounds.height)
    }
    private func outline(_ points: [(CGFloat,CGFloat)]) -> CGPath {
        let path = CGMutablePath()
        for (i,p) in points.enumerated() {
            if i == 0 { path.move(to:point(p.0,p.1)) } else { path.addLine(to:point(p.0,p.1)) }
        }
        path.closeSubpath(); return path
    }
    private func addJoints(image: NSImage?, body: CALayer, reduceMotion: Bool) {
        // The hat and face turn together about the neck; the broom/body stay still.
        // Include the transparent margin around the entire hat. A tight polygon
        // leaves stationary outline fragments behind when the joint turns.
        let headPath = outline([(0,0),(1536,0),(1536,558),(1090,558),(1030,547),
            (970,552),(910,552),(855,553),(810,561),(770,572),(725,565),
            (680,553),(610,556),(550,550),(500,541),(0,520)])
        let pawPath = outline([(978,583),(1014,601),(1045,636),(1073,654),
            (1114,674),(1128,696),(1124,718),(1110,735),(1080,740),
            (1050,730),(1027,710),(1003,684),(978,651),(965,616)])
        let cutout = CGMutablePath(); cutout.addRect(artwork.bounds)
        cutout.addPath(headPath); cutout.addPath(pawPath)
        let mask = CAShapeLayer(); mask.frame = artwork.bounds; mask.path = cutout; mask.fillRule = .evenOdd
        body.mask = mask
        func joint(_ name: String, _ path: CGPath, pivot: CGPoint) -> CALayer {
            let joint = CALayer(); joint.name = name; joint.bounds = artwork.bounds
            joint.anchorPoint = CGPoint(x:pivot.x / artwork.bounds.width,y:pivot.y / artwork.bounds.height)
            joint.position = pivot; joint.contents = image; joint.contentsGravity = .resizeAspect
            joint.contentsScale = artwork.contentsScale
            let mask = CAShapeLayer(); mask.frame = artwork.bounds; mask.path = path
            joint.mask = mask; artwork.addSublayer(joint); return joint
        }
        let neck = CAShapeLayer()
        let neckPath = CGMutablePath()
        neckPath.addEllipse(in:CGRect(x:point(840,560).x,y:point(840,560).y,width:140 / 1536 * artwork.bounds.width,height:32 / 1024 * artwork.bounds.height))
        neck.path = neckPath
        neck.fillColor = NSColor(srgbRed:0.24,green:0.19,blue:0.20,alpha:1).cgColor
        artwork.addSublayer(neck)
        // The original paw occludes this short piece of broom. Keep the shaft
        // continuous when that paw lifts, clipped strictly to the vacated joint.
        let shaft = CAShapeLayer(), shaftPath = CGMutablePath()
        shaftPath.move(to:point(990,748)); shaftPath.addLine(to:point(1180,696))
        shaft.path = shaftPath; shaft.strokeColor = NSColor(srgbRed:0.34,green:0.20,blue:0.15,alpha:1).cgColor
        shaft.lineWidth = 38 / 1536 * artwork.bounds.width; shaft.lineCap = .round
        let shaftMask = CAShapeLayer(); shaftMask.path = pawPath; shaft.mask = shaftMask
        artwork.addSublayer(shaft)
        let grain = CAShapeLayer(); grain.path = shaftPath
        grain.strokeColor = NSColor(srgbRed:0.69,green:0.43,blue:0.27,alpha:1).cgColor
        grain.lineWidth = 27 / 1536 * artwork.bounds.width; grain.lineCap = .round
        shaft.addSublayer(grain)
        face = joint("petHead",headPath,pivot:point(950,552))
        let paw = joint("petScratchPaw",pawPath,pivot:point(987,600))
        guard !reduceMotion else { return }
        // A shared 18-second clock: glance left/right, rest, then three cheek scratches.
        let times: [NSNumber] = [0,0.12,0.17,0.23,0.29,0.35,0.54,0.59,0.61,0.63,0.65,0.67,0.69,0.71,0.74,0.79,1]
        let start = CACurrentMediaTime()
        func loop(_ layer: CALayer, _ key: String, _ values: [Double], _ name: String) {
            let a = CAKeyframeAnimation(keyPath:key); a.values = values; a.keyTimes = times
            a.duration = 18; a.beginTime = start; a.repeatCount = .infinity
            a.timingFunctions = Array(repeating:CAMediaTimingFunction(name:.easeInEaseOut),count:times.count-1)
            layer.add(a,forKey:name)
        }
        loop(face,"transform.rotation.z",[0,0,0.075,0.075,-0.055,0,0,-0.07,-0.085,-0.06,-0.085,-0.06,-0.085,-0.06,-0.07,0,0],"petHeadTurn")
        loop(face,"transform.scale.x",[1,1,0.94,0.94,1.025,1,1,0.98,0.98,0.98,0.98,0.98,0.98,0.98,0.98,1,1],"petHeadLook")
        loop(paw,"transform.rotation.z",[0,0,0,0,0,0,0,1.75,1.5,1.82,1.5,1.82,1.5,1.82,1.75,0,0],"petScratch")
    }
    private func addEyes() {
        // Replace only the eye interiors: the original outer eyelids, lashes and
        // face stay intact. Covering the baked-in pupils prevents a double gaze.
        for index in 0..<2 {
            let left = index == 0
            let opening = CGMutablePath()
            if left {
                opening.move(to:point(765,450))
                opening.addQuadCurve(to:point(934,438),control:point(850,419))
                opening.addCurve(to:point(869,511),control1:point(939,488),control2:point(907,515))
                opening.addCurve(to:point(765,450),control1:point(819,520),control2:point(782,491))
            } else {
                opening.move(to:point(1007,409))
                opening.addQuadCurve(to:point(1111,340),control:point(1050,363))
                opening.addCurve(to:point(1085,444),control1:point(1131,390),control2:point(1112,431))
                opening.addCurve(to:point(1007,409),control1:point(1058,461),control2:point(1027,443))
            }
            opening.closeSubpath()
            let eye = CALayer(); eye.name = "petEyeSocket"; eye.frame = artwork.bounds
            let mask = CAShapeLayer(); mask.frame = eye.bounds; mask.path = opening; eye.mask = mask
            face.addSublayer(eye)
            let iris = CAGradientLayer(); iris.name = "petIris"; iris.frame = opening.boundingBoxOfPath
            iris.colors = [NSColor(srgbRed:1,green:0.84,blue:0.58,alpha:1).cgColor,
                           NSColor(srgbRed:0.94,green:0.66,blue:0.36,alpha:1).cgColor]
            iris.startPoint = CGPoint(x:0.5,y:0); iris.endPoint = CGPoint(x:0.5,y:1)
            eye.addSublayer(iris)
            let pupil = CAShapeLayer(); pupil.name = "petPupil"; pupil.frame = artwork.bounds
            let center = left ? point(852,445) : point(1053,383)
            let width: CGFloat = (left ? 106 : 78) / 1536 * artwork.bounds.width
            let height: CGFloat = 111 / 1024 * artwork.bounds.height
            let oval = CGPath(ellipseIn:CGRect(x:center.x-width/2,y:center.y-height/2,width:width,height:height),transform:nil)
            pupil.path = oval; pupil.fillColor = NSColor(srgbRed:0.16,green:0.12,blue:0.12,alpha:1).cgColor
            let pupilMask = CAShapeLayer(); pupilMask.frame = pupil.bounds; pupilMask.path = oval; pupil.mask = pupilMask
            // Fine diagonal lines echo the original hand-drawn dark pupils.
            let grain = CAShapeLayer(), lines = CGMutablePath()
            for i in -8...8 {
                let x = center.x + CGFloat(i)*width/12
                lines.move(to:CGPoint(x:x-width*0.35,y:center.y+height/2))
                lines.addLine(to:CGPoint(x:x+width*0.35,y:center.y-height/2))
            }
            grain.path = lines; grain.strokeColor = NSColor(srgbRed:0.42,green:0.29,blue:0.23,alpha:0.65).cgColor
            grain.lineWidth = max(0.2,artwork.bounds.width/1536*2.5)
            pupil.addSublayer(grain); eye.addSublayer(pupil)
            pupils.append((pupil,left ? 32 : 23))
        }
    }
    private func addEyelid(points: [CGPoint], reduceMotion: Bool) {
        guard !reduceMotion else { return }
        let path = CGMutablePath()
        for (index,point) in points.enumerated() {
            let p = CGPoint(x:point.x / 1536 * artwork.bounds.width,y:(1-point.y / 1024) * artwork.bounds.height)
            if index == 0 { path.move(to:p) } else { path.addLine(to:p) }
        }
        path.closeSubpath()
        let lid = CAShapeLayer()
        lid.name = "petEyelid"
        lid.frame = artwork.bounds
        lid.path = path
        lid.fillColor = NSColor(srgbRed:0.28,green:0.225,blue:0.235,alpha:1).cgColor
        // A curved lash makes a held closed-eye expression legible at desktop size.
        let smile = CAShapeLayer(), curve = CGMutablePath()
        let left = (points.first?.x ?? 0) < 950
        curve.move(to:left ? point(777,461) : point(1018,396))
        curve.addQuadCurve(to:left ? point(918,453) : point(1112,369),
                           control:left ? point(849,508) : point(1073,435))
        smile.path = curve; smile.fillColor = nil
        smile.strokeColor = NSColor(srgbRed:0.11,green:0.085,blue:0.10,alpha:1).cgColor
        smile.lineWidth = 9 / 1536 * artwork.bounds.width; smile.lineCap = .round
        lid.addSublayer(smile)
        lid.opacity = 0
        face.addSublayer(lid)
        let blink = CAKeyframeAnimation(keyPath:"opacity")
        blink.values = [0,0,1,1,0,0,1,0,0]
        blink.keyTimes = [0,0.66,0.675,0.69,0.71,0.745,0.76,0.78,1]
        blink.duration = 6.4
        blink.repeatCount = .infinity
        lid.add(blink,forKey:"petBlink")
    }
    private func addMeteorNight(to parent: CALayer, reduceMotion: Bool) {
        func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
            NSColor(srgbRed:r,green:g,blue:b,alpha:a).cgColor
        }
        let sky = CAGradientLayer(); sky.name = "petMeteorNight"; sky.frame = bounds
        sky.colors = [color(0.055,0.065,0.16,0.82),color(0.16,0.095,0.28,0.76),color(0.045,0.095,0.20,0.70)]
        sky.startPoint = CGPoint(x:0.2,y:1); sky.endPoint = CGPoint(x:0.85,y:0)
        parent.addSublayer(sky)
        // A broad falloff reaches transparency inside the view, before any clipping.
        // Apply it to the whole sky so stars and meteor trails fade out with the haze.
        let mask = CAGradientLayer(); mask.type = .radial; mask.frame = bounds
        mask.colors = [color(1,1,1,0.94),color(1,1,1,0.88),color(1,1,1,0.65),
                       color(1,1,1,0.34),color(1,1,1,0.09),color(1,1,1,0)]
        mask.locations = [0,0.2,0.4,0.6,0.8,1]
        mask.startPoint = CGPoint(x:0.5,y:0.5); mask.endPoint = CGPoint(x:0.97,y:0.97)
        sky.mask = mask
        for (i, palette) in [[color(0.4,0.16,0.72,0.6),color(0.2,0.08,0.5,0)],
                              [color(1,0.6,0.15,0.32),color(0.6,0.25,0.03,0)]].enumerated() {
            let haze = CAGradientLayer(); haze.type = .radial; haze.frame = bounds
            haze.colors = palette; haze.startPoint = CGPoint(x:i == 0 ? 0.2 : 0.85,y:i == 0 ? 0.7 : 0.25)
            haze.endPoint = CGPoint(x:1,y:1); sky.addSublayer(haze)
        }
        let gold = color(1,0.73,0.25), whiteGold = color(1,0.95,0.7)
        for i in 0..<48 {
            let star = CALayer(); star.name = "petNightStar"
            let radius: CGFloat = i % 9 == 0 ? 1.35 : 0.55
            star.frame = CGRect(x:CGFloat((i*47+11)%131)/131*bounds.width,
                                y:CGFloat((i*31+19)%97)/97*bounds.height,width:radius*2,height:radius*2)
            star.cornerRadius = radius; star.backgroundColor = i%3 == 0 ? gold : whiteGold
            star.opacity = Float(0.35+Double(i%5)*0.13)
            if i%9 == 0 { star.shadowColor = gold; star.shadowOpacity = 0.9; star.shadowRadius = 4; star.shadowOffset = .zero }
            sky.addSublayer(star)
            if !reduceMotion {
                let twinkle = CAKeyframeAnimation(keyPath:"opacity")
                twinkle.values = [0.25,0.9,0.4,0.25]; twinkle.duration = 2.4+Double(i%7)*0.6
                twinkle.timeOffset = Double(i)*0.37; twinkle.repeatCount = .infinity
                star.add(twinkle,forKey:"petStarlight")
            }
        }
        // Staggered compositor-only streaks: a white-hot head, amber wake and gold dust.
        // Model positions also compose a still night when Reduce Motion is enabled.
        for i in 0..<5 {
            let meteor = CALayer(); meteor.name = "petGoldenMeteor"
            let length: CGFloat = i == 0 ? 82 : CGFloat(36+i*8)
            meteor.bounds = CGRect(x:0,y:0,width:length,height:12)
            meteor.anchorPoint = CGPoint(x:0,y:0.5)
            meteor.position = CGPoint(x:bounds.width*CGFloat([0.08,0.65,0.3,0.9,0.5][i]),y:bounds.height*CGFloat([0.78,0.88,0.2,0.45,0.55][i]))
            meteor.setAffineTransform(CGAffineTransform(rotationAngle:0.42))
            let tail = CAGradientLayer(); tail.frame = CGRect(x:0,y:5,width:length,height:i == 0 ? 2 : 1)
            tail.colors = [whiteGold,gold,color(1,0.48,0.08,0)]; tail.locations = [0,0.18,1]
            tail.startPoint = CGPoint(x:0,y:0.5); tail.endPoint = CGPoint(x:1,y:0.5)
            tail.shadowColor = gold; tail.shadowOpacity = 0.9; tail.shadowRadius = 4; tail.shadowOffset = .zero
            meteor.addSublayer(tail)
            let head = CALayer(); head.frame = CGRect(x:-1,y:4,width:3,height:3); head.cornerRadius = 1.5
            head.backgroundColor = whiteGold; head.shadowColor = gold; head.shadowOpacity = 1; head.shadowRadius = 5; head.shadowOffset = .zero
            meteor.addSublayer(head)
            for j in 0..<7 {
                let dust = CALayer(); dust.frame = CGRect(x:CGFloat(j)*7+6,y:CGFloat((j*7+i)%9),width:1,height:1)
                dust.cornerRadius = 0.5; dust.backgroundColor = gold; dust.opacity = Float(0.65-Double(j)*0.08)
                meteor.addSublayer(dust)
            }
            sky.addSublayer(meteor)
            if reduceMotion { meteor.opacity = i < 2 ? 0.65 : 0; continue }
            let duration = 4.8+Double(i)*0.77
            let start = CGPoint(x:bounds.width+length,y:bounds.height+CGFloat(i*11)-15)
            let end = CGPoint(x:-length,y:start.y-(bounds.width+2*length)*0.447)
            let flight = CAKeyframeAnimation(keyPath:"position")
            flight.values = [NSValue(point:start),NSValue(point:end),NSValue(point:end)]
            flight.keyTimes = [0,0.48,1]
            let glow = CAKeyframeAnimation(keyPath:"opacity")
            glow.values = [0,1,1,0,0]; glow.keyTimes = [0,0.06,0.34,0.48,1]
            let shower = CAAnimationGroup(); shower.animations = [flight,glow]
            shower.duration = duration; shower.timeOffset = Double(i)*1.13+0.8
            shower.repeatCount = .infinity; shower.timingFunction = CAMediaTimingFunction(name:.linear)
            meteor.add(shower,forKey:"petMeteorFlight")
        }
    }
}
