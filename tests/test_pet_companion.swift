import AppKit
import QuartzCore

@main
struct PetCompanionTests {
    final class Receiver: NSObject {
        var clicks = 0
        @objc func clicked(_ sender: Any?) { clicks += 1 }
    }
    static func main() {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ message: String) {
            precondition(condition(),message); checks += 1
        }
        var drag = PetDragGesture(pointer:NSPoint(x:100,y:100),windowOrigin:NSPoint(x:500,y:300))
        check(drag.update(NSPoint(x:102,y:102)) == nil,"Click jitter must not move the window")
        check(drag.update(NSPoint(x:103,y:104)) == NSPoint(x:503,y:304),"Five-point threshold and original pointer offset")
        check(drag.update(NSPoint(x:100,y:100)) == NSPoint(x:500,y:300),"Return to start remains a drag")
        check(drag.dragged,"Dragging must never become a click again")
        check(drag.update(NSPoint(x:-100,y:200)) == NSPoint(x:300,y:400),"Global coordinates support other displays")

        var pointer = PetPointerInteraction()
        let size = CGSize(width:156,height:104)
        var response = pointer.observe(CGPoint(x:80,y:70),size:size,at:1,pressed:false)
        check(response.near && !response.newPet,"Approach looks at the pointer without petting")
        response = pointer.observe(CGPoint(x:105,y:70),size:size,at:1.1,pressed:false)
        check(!response.newPet,"One pass is not a head stroke")
        response = pointer.observe(CGPoint(x:80,y:70),size:size,at:1.2,pressed:false)
        check(response.newPet && response.petted,"Back-and-forth over the head triggers affection")
        response = pointer.observe(CGPoint(x:105,y:70),size:size,at:1.3,pressed:false)
        response = pointer.observe(CGPoint(x:80,y:70),size:size,at:1.4,pressed:false)
        check(!response.newPet,"Petting cooldown prevents repeated effects")
        response = pointer.observe(CGPoint(x:500,y:500),size:size,at:4,pressed:false)
        check(!response.near && !response.petted && response.x == 0,"Moving away returns to idle")
        var held = PetPointerInteraction()
        for (i,x) in [80,110,80,110].enumerated() {
            check(!held.observe(CGPoint(x:x,y:70),size:size,at:Double(i)*0.1+1,pressed:true).newPet,"Button-held motion must not be stroking")
        }
        var lower = PetPointerInteraction()
        for (i,x) in [80,110,80,110].enumerated() {
            check(!lower.observe(CGPoint(x:x,y:20),size:size,at:Double(i)*0.1+1,pressed:false).newPet,"Broom movement does not pet the head")
        }
        check(abs(PetPointerInteraction.dragAngle(delta:10000,elapsed:0)) <= 0.12,"Fast drag tilt is bounded")
        check(PetPointerInteraction.dragAngle(delta:10,elapsed:0.1) < 0 && PetPointerInteraction.dragAngle(delta:-10,elapsed:0.1) > 0,"Tilt follows drag direction")

        _ = NSApplication.shared
        guard let image = NSImage(contentsOfFile:"docs/media/pga-witch-cat-broom.png") else { fatalError("Run from the repository root") }
        func descendants(_ layer: CALayer) -> [CALayer] {
            [layer] + (layer.sublayers ?? []).flatMap(descendants)
        }
        let cat = PetCompanionView(frame:NSRect(x:0,y:0,width:130,height:92),image:image,reduceMotion:false,reaction:"tap")
        let layers = descendants(cat.layer!)
        check(layers.contains { $0.name == "petMeteorNight" && $0.mask != nil },"Night sky has soft transparent edges")
        check(layers.filter { $0.name == "petGoldenMeteor" && $0.animation(forKey:"petMeteorFlight") != nil }.count == 5,"Five staggered golden meteors animate behind the cat")
        check(layers.filter { $0.name == "petNightStar" }.count == 48,"Layered star field remains visible")
        check(layers.filter { $0.name == "petEyelid" && $0.animation(forKey:"petBlink") != nil }.count == 2,"Both eyes still blink")
        check(layers.contains { $0.name == "petHead" && $0.animation(forKey:"petHeadTurn") != nil },"Head turns independently of the body")
        check(layers.contains { $0.name == "petScratchPaw" && $0.animation(forKey:"petScratch") != nil },"Paw has its own scratching motion")
        let screen = NSRect(x:-1440,y:0,width:1440,height:900)
        let closed = NSRect(x:-800,y:40,width:156,height:120)
        let opened = PetLayout.frame(previous:closed,screen:screen,expanded:true)
        let closedAgain = PetLayout.frame(previous:opened,screen:screen,expanded:false)
        check(opened.midX == closed.midX && closedAgain.midX == closed.midX,"Opening and collapsing preserve the cat center")
        check(PetLayout.cat(in:opened.width).midX == opened.width/2,"Cat is centered below the inbox")
        let edge = PetLayout.frame(previous:NSRect(x:-156,y:40,width:156,height:120),screen:screen,expanded:true)
        check(screen.contains(edge),"Expanded inbox stays on screen at the right edge")
        let reduced = PetCompanionView(frame:cat.frame,image:image,reduceMotion:true,reaction:"done")
        check(descendants(reduced.layer!).allSatisfy { ($0.animationKeys() ?? []).isEmpty },"Reduce Motion disables every animation, including reactions")
        cat.observePointer(CGPoint(x:50,y:60),at:10)
        let gaze = layers.first { $0.name == "petGaze" }!
        let leftGaze = gaze.transform
        cat.observePointer(CGPoint(x:180,y:60),at:10.1)
        check(!CATransform3DEqualToTransform(leftGaze,gaze.transform),"Head responds to different pointer directions")
        let pupils = layers.filter { $0.name == "petPupil" }
        check(pupils.count == 2,"Both eyes have independent pupils")
        check(pupils.allSatisfy { $0.transform.m41 > 0 },"Both pupils look right inside the head")
        cat.observePointer(CGPoint(x:-20,y:60),at:10.2)
        check(pupils.allSatisfy { $0.transform.m41 < 0 },"Both pupils move left, not just the head")
        cat.observePointer(CGPoint(x:80,y:150),at:10.3)
        check(pupils.allSatisfy { $0.transform.m42 > 0 },"Pupils look upward")
        cat.observePointer(CGPoint(x:80,y:-30),at:10.4)
        check(pupils.allSatisfy { $0.transform.m42 < 0 },"Pupils look downward")
        check(pupils.allSatisfy { $0.superlayer?.name == "petEyeSocket" && $0.superlayer?.mask != nil },"Eye openings clip pupils throughout their movement")
        let head = layers.first { $0.name == "petHead" }!
        check(head.animation(forKey:"petHeadTurn") == nil,"Pointer response temporarily takes over the idle head motion")
        cat.observePointer(CGPoint(x:500,y:500),at:13)
        check(head.animation(forKey:"petHeadTurn") != nil,"Idle motion resumes after the pointer leaves")
        check(pupils.allSatisfy { CATransform3DEqualToTransform($0.transform,CATransform3DIdentity) },"Pupils recenter after the pointer leaves")
        let faceChildren = head.sublayers ?? []
        check(faceChildren.lastIndex(where: { $0.name == "petEyeSocket" })! < faceChildren.firstIndex(where: { $0.name == "petEyelid" })!,"Blinking and petting eyelids cover the moving eyes")
        cat.petHead()
        check(head.animation(forKey:"petHeadTilt") != nil,"Explicit head petting tilts the neck joint")
        cat.observePointer(CGPoint(x:150,y:60),at:CACurrentMediaTime()+0.2)
        check(head.animation(forKey:"petHeadTilt") != nil,"Pointer aiming cannot overwrite the petting tilt")
        let stroked = PetCompanionView(frame:cat.frame,image:image,reduceMotion:false,reaction:nil)
        stroked.observePointer(CGPoint(x:70,y:65),at:20)
        stroked.observePointer(CGPoint(x:100,y:65),at:20.1)
        stroked.observePointer(CGPoint(x:70,y:65),at:20.2)
        check(descendants(stroked.layer!).contains { $0.name == "petHead" && $0.animation(forKey:"petHeadTilt") != nil },"Mouse strokes trigger the same head tilt as the menu")
        check(layers.first { $0.name == "petAffection" }?.animation(forKey:"petHeart") != nil,"Head petting displays a heart")
        check(layers.filter { $0.name == "petEyelid" && $0.animation(forKey:"petContented") != nil }.count == 2,"Petting closes both eyes")
        reduced.observePointer(CGPoint(x:50,y:60),at:10); reduced.petHead()
        check(descendants(reduced.layer!).allSatisfy { ($0.animationKeys() ?? []).isEmpty },"Reduce Motion also disables mouse effects")
        check(!cat.mouseDownCanMoveWindow,"No implicit background drag")

        // Unshown, standalone test window: no running PGA window is touched.
        let window = NSWindow(contentRect:NSRect(x:400,y:300,width:130,height:92),styleMask:.borderless,backing:.buffered,defer:false)
        window.contentView = cat
        let receiver = Receiver()
        cat.target = receiver; cat.action = #selector(Receiver.clicked(_:))
        var interactions: [Bool] = []
        cat.onInteraction = { interactions.append($0) }
        func event(_ type: NSEvent.EventType, _ point: NSPoint) -> NSEvent {
            NSEvent.mouseEvent(with:type,location:point,modifierFlags:[],timestamp:0,windowNumber:window.windowNumber,context:nil,eventNumber:0,clickCount:1,pressure:1)!
        }
        cat.mouseDown(with:event(.leftMouseDown,NSPoint(x:50,y:45)))
        cat.mouseUp(with:event(.leftMouseUp,NSPoint(x:51,y:46)))
        check(receiver.clicks == 1,"Click opens the existing action once")
        let origin = window.frame.origin
        cat.mouseDown(with:event(.leftMouseDown,NSPoint(x:50,y:45)))
        cat.mouseDragged(with:event(.leftMouseDragged,NSPoint(x:70,y:55)))
        check(window.frame.origin == NSPoint(x:origin.x+20,y:origin.y+10),"Dragging the control actually moves its native window")
        cat.mouseUp(with:event(.leftMouseUp,NSPoint(x:50,y:45)))
        check(layers.first { $0.name == "petArtwork" }?.animation(forKey:"petDragSettle") != nil,"Drag release settles the artwork without moving the window")
        check(receiver.clicks == 1,"Drag release does not open the inbox")
        cat.mouseDown(with:event(.leftMouseDown,NSPoint(x:50,y:45)))
        cat.mouseUp(with:event(.leftMouseUp,NSPoint(x:60,y:45)))
        check(receiver.clicks == 1,"Coalesced movement at mouse-up is not a click")
        check(interactions == [true,false,true,false,true,false],"Interaction pauses and resumes the inbox timeout")
        check(cat.accessibilityPerformPress(),"Accessibility activation succeeds")
        check(receiver.clicks == 2,"Accessibility retains the list action")
        let menu = cat.menu(for:event(.rightMouseDown,NSPoint(x:50,y:45)))!
        check(menu.items.map(\.title) == ["摸摸头","查看会话列表","","音乐响应（系统声音）"],"Right-click exposes music control alongside existing actions")
        var musicOn = false
        cat.onToggleMusic = { musicOn.toggle() }; cat.musicEnabled = { musicOn }
        let musicMenu = cat.menu(for:event(.rightMouseDown,NSPoint(x:50,y:45)))!
        musicMenu.performActionForItem(at:3)
        check(musicOn && cat.menu(for:event(.rightMouseDown,.zero))!.items[3].state == .on,"Music toggle reflects active state")
        let rig = layers.first { $0.name == "petMusicRig" }!
        let glow = layers.first { $0.name == "petMusicGlow" }!
        cat.respondToMusic(level:0.8,beat:true)
        check(rig.animation(forKey:"petMusicBeat") != nil && glow.opacity > 0,"Beat produces motion and golden glow")
        cat.respondToMusic(level:0,beat:false)
        check(rig.animation(forKey:"petMusicBeat") == nil && glow.animation(forKey:"petMusicFlash") == nil && glow.opacity == 0,"Silence or disabling clears music effects")
        reduced.respondToMusic(level:0.8,beat:true)
        check(descendants(reduced.layer!).allSatisfy { ($0.animationKeys() ?? []).isEmpty },"Reduce Motion uses a static music glow")
        var openedHistory = false; cat.onShowInbox = { openedHistory = true }
        menu.performActionForItem(at:1)
        check(openedHistory && receiver.clicks == 2,"History menu does not activate unread navigation")
        print("PASS: \(checks) native pet checks (gesture, NSWindow movement, click suppression, CA layers, Reduce Motion, accessibility)")
    }
}
