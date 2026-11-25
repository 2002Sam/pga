import Foundation

@main struct MusicTests {
    static func main() {
        var envelope = PetMusicEnvelope()
        var clock = 0.0
        func feed(_ rms: Double) -> (Double, Bool) {
            clock += 0.02
            return envelope.sample(rms:rms,at:clock)
        }
        for _ in 0..<100 { let sample = feed(0); precondition(sample.0 == 0 && !sample.1) }
        let kickRMS = sqrt((0..<480).map { pow(0.6*sin(Double($0)*2*Double.pi/48),2) }.reduce(0,+)/480)
        precondition(feed(kickRMS).1, "An audible onset should trigger a beat")
        for _ in 0..<10 { precondition(!feed(kickRMS).1, "One onset must not retrigger each audio buffer") }
        for _ in 0..<100 { _ = feed(kickRMS) }
        precondition(!feed(kickRMS).1, "A sustained tone must settle instead of bouncing forever")
        for _ in 0..<100 { _ = feed(0) }
        precondition(feed(kickRMS).1, "A new onset after silence should respond")
        let music = PetMusic()
        precondition(!music.enabled, "Capture is off until explicitly enabled")
        var cleared = false
        music.onLevel = { cleared = $0 == 0 && !$1 }
        music.stop()
        precondition(cleared && !music.enabled, "Stopping resets the visual state without requesting capture")
        print("PASS: silence, synthetic tone onset, refractory period, sustained tone, restart, default-off and stop")
    }
}
