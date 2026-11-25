import AppKit
import QuartzCore
import ScreenCaptureKit
import CoreMedia
import AudioToolbox

/// Only scalar energy/beat values leave the audio queue. No recordings or transcripts.
struct PetMusicEnvelope {
    private var average: Double = 0
    private var lastBeat: Double = -10
    mutating func sample(rms: Double, at time: Double) -> (Double, Bool) {
        let energy = max(0,min(1,(20*log10(max(0.000001,rms))+55)/48))
        let beat = energy > 0.28 && energy > average+0.12 && time-lastBeat > 0.24
        average += (energy-average)*0.12
        if beat { lastBeat = time }
        return (energy,beat)
    }
}
final class PetMusic: NSObject, SCStreamOutput, SCStreamDelegate {
    var onLevel: ((Double,Bool) -> Void)?
    private(set) var enabled = false
    private var stream: SCStream?
    private var generation = 0
    private let queue = DispatchQueue(label:"pga.pet.music",qos:.utility)
    private var envelope = PetMusicEnvelope()
    private var lastDelivery: Double = 0
    private var timer: Timer?
    private var received: Double = 0
    func toggle() { enabled ? stop() : start() }
    private func start() {
        enabled = true; generation += 1; let token = generation
        queue.async { [weak self] in self?.envelope = PetMusicEnvelope(); self?.lastDelivery = 0 }
        Task { @MainActor in
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false,onScreenWindowsOnly:true)
                guard enabled && token == generation else { return }
                guard let display = content.displays.first else { throw NSError(domain:"PGA",code:1,userInfo:[NSLocalizedDescriptionKey:"没有可用的音频捕获显示器"] ) }
                let filter = SCContentFilter(display:display,excludingApplications:[],exceptingWindows:[])
                let config = SCStreamConfiguration()
                config.capturesAudio = true; config.excludesCurrentProcessAudio = true
                config.sampleRate = 48000; config.channelCount = 1
                config.width = 2; config.height = 2; config.minimumFrameInterval = CMTime(seconds:1,preferredTimescale:600)
                if #available(macOS 15.0, *) { config.captureMicrophone = false }
                let capture = SCStream(filter:filter,configuration:config,delegate:self)
                // Register only audio output: the app receives no screen images.
                try capture.addStreamOutput(self,type:.audio,sampleHandlerQueue:queue)
                stream = capture
                try await capture.startCapture()
                guard enabled && token == generation else { try? await capture.stopCapture(); return }
                received = CACurrentMediaTime()
                let silenceTimer = Timer(timeInterval:0.15,target:self,selector:#selector(checkSilence),userInfo:nil,repeats:true)
                timer = silenceTimer
                RunLoop.main.add(silenceTimer,forMode:.common)
            } catch {
                guard token == generation && enabled else { return }
                stop()
                let alert = NSAlert(); alert.messageText = "音乐响应未开启"
                alert.informativeText = "请在系统设置 → 隐私与安全性 → 屏幕与系统音频录制中允许 PGA，然后从猫猫右键菜单重试。只分析系统声音，不使用麦克风、不保存录音。\n\n" + error.localizedDescription
                alert.runModal()
            }
        }
    }
    @objc private func checkSilence() {
        guard enabled else { return }
        if CACurrentMediaTime()-received > 0.3 { onLevel?(0,false) }
    }
    func stop() {
        enabled = false; generation += 1; timer?.invalidate(); timer = nil
        let old = stream; stream = nil; onLevel?(0,false)
        if let old { Task { try? await old.stopCapture() } }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.stream === stream else { return }
            self.stop()
        }
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, CMSampleBufferDataIsReady(sampleBuffer),
              let format = sampleBuffer.formatDescription,
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
              asbd.mFormatID == kAudioFormatLinearPCM, asbd.mBitsPerChannel == 32,
              asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0,
              let block = sampleBuffer.dataBuffer else { return }
        let size = CMBlockBufferGetDataLength(block)
        guard size > 0 && size <= 1048576 && size % 4 == 0 else { return }
        var samples = [Float](repeating:0,count:size/4)
        let status = samples.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block,atOffset:0,dataLength:size,destination:$0.baseAddress!) }
        guard status == kCMBlockBufferNoErr else { return }
        let rms = sqrt(samples.reduce(0.0) { $0 + Double($1)*Double($1) } / Double(samples.count))
        guard rms.isFinite else { return }
        let now = CACurrentMediaTime()
        let (level,beat) = envelope.sample(rms:rms,at:now)
        guard beat || now-lastDelivery > 1.0/24 else { return }; lastDelivery = now
        DispatchQueue.main.async { [weak self] in
            guard let self, self.enabled, self.stream === stream else { return }
            self.received = now; self.onLevel?(level,beat)
        }
    }
}
