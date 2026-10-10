// System AVFoundation timed playback output; no product core, source mutation or GUI automation.
import Foundation
import AVFoundation
import QuartzCore
import CoreVideo
import Darwin

let env = ProcessInfo.processInfo.environment
guard let source = env["APEX_SOURCE_VIDEO"], let clip = env["APEX_CLIP_VIDEO"], let folder = env["APEX_DIAG_DIR"] else {
    fputs("APEX_SOURCE_VIDEO, APEX_CLIP_VIDEO and APEX_DIAG_DIR are required\n", stderr); exit(2)
}
let sourceStart = Double(env["APEX_PLAYBACK_SOURCE_START"] ?? "135")!
let sourceEnd = Double(env["APEX_PLAYBACK_SOURCE_END"] ?? "151.05")!
let cases: [(String, String, Double, Double?)] = [("source", source, sourceStart, sourceEnd), ("clip", clip, 0, nil)]
var results: [[String: Any]] = []
let globalStart = CACurrentMediaTime()
let outputURL = URL(fileURLWithPath: folder).appendingPathComponent("native-player-report.json")
try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)

func save(_ status: String) {
    let report: [String: Any] = ["status": status, "scope": "system AVPlayer plus AVPlayerItemVideoOutput clocked CVPixelBuffer delivery; native AVFoundation control, not Finder QuickLook UI or human visual/sync acceptance", "pid": getpid(), "uid": getuid(), "os": ProcessInfo.processInfo.operatingSystemVersionString, "elapsed_s": CACurrentMediaTime() - globalStart, "cases": results]
    let data = try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
    try! data.write(to: outputURL)
}

final class PlayerCase {
    let name: String
    let path: String
    let start: Double
    let end: Double?
    let item: AVPlayerItem
    let player: AVPlayer
    let output: AVPlayerItemVideoOutput
    var timer: Timer?
    var observers: [NSObjectProtocol] = []
    var frames: [[String: Any]] = []
    var events: [[String: Any]] = []
    var clock: [[String: Any]] = []
    var began = CACurrentMediaTime()
    var playingBegan: Double?
    var seekRequested = false
    var previousState = ""
    var ended = false
    var finished = false
    var nextSample: Double = 0
    var completion: (() -> Void)?

    init(_ definition: (String, String, Double, Double?)) {
        (name, path, start, end) = definition
        item = AVPlayerItem(url: URL(fileURLWithPath: path))
        output = AVPlayerItemVideoOutput(pixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        item.add(output)
        player = AVPlayer(playerItem: item)
        player.isMuted = true
        observers.append(NotificationCenter.default.addObserver(forName: .AVPlayerItemPlaybackStalled, object: item, queue: .main) { [weak self] _ in self?.event("playbackStalled") })
        observers.append(NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in self?.ended = true; self?.event("ended") })
        observers.append(NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { [weak self] note in self?.event("failedToEnd", String(describing: note.userInfo)) })
    }

    func event(_ type: String, _ detail: String = "") {
        events.append(["event": type, "host_s": CACurrentMediaTime(), "player_time_s": safe(player.currentTime()), "detail": detail])
    }

    func safe(_ value: CMTime) -> Double { let seconds = CMTimeGetSeconds(value); return seconds.isFinite ? seconds : -1 }

    func begin(_ done: @escaping () -> Void) {
        completion = done; event("created")
        print("native \(name) starting pid=\(getpid())")
        timer = Timer(timeInterval: 1.0 / 120.0, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(timer!, forMode: .common)
    }

    func tick() {
        if finished { return }
        let now = CACurrentMediaTime()
        if now - began > 55 { finish("failed", "case timeout (55s)"); return }
        if item.status == .failed { finish("failed", item.error?.localizedDescription ?? "AVPlayerItem failed"); return }
        let state = "\(item.status.rawValue)/\(player.timeControlStatus.rawValue)/\(player.rate)"
        if state != previousState { event("state", state); previousState = state }
        if item.status == .readyToPlay && !seekRequested {
            seekRequested = true; event("seekRequested")
            player.seek(to: CMTime(seconds: start, preferredTimescale: 60000), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] accepted in
                guard let self = self, !self.finished else { return }
                self.event("seekCompleted", "\(accepted)")
                if !accepted { self.finish("failed", "seek not completed"); return }
                self.playingBegan = CACurrentMediaTime(); self.event("playRequested")
                self.output.requestNotificationOfMediaDataChange(withAdvanceInterval: 0.03)
                self.player.play()
            }
        }
        guard let playback = playingBegan else { return }
        let requested = output.itemTime(forHostTime: now)
        if output.hasNewPixelBuffer(forItemTime: requested) {
            var displayed = CMTime.invalid
            if let buffer = output.copyPixelBuffer(forItemTime: requested, itemTimeForDisplay: &displayed) {
                frames.append(["host_s": now, "item_request_s": safe(requested), "display_pts_s": safe(displayed), "player_time_s": safe(player.currentTime()), "width": CVPixelBufferGetWidth(buffer), "height": CVPixelBufferGetHeight(buffer), "pixel_format": CVPixelBufferGetPixelFormatType(buffer)])
            }
        }
        if now >= nextSample {
            clock.append(["host_s": now, "player_time_s": safe(player.currentTime()), "rate": player.rate, "time_control_status": player.timeControlStatus.rawValue, "waiting_reason": player.reasonForWaitingToPlay?.rawValue ?? "", "buffer_empty": item.isPlaybackBufferEmpty, "likely_to_keep_up": item.isPlaybackLikelyToKeepUp])
            nextSample = now + 0.25
        }
        if ended || end != nil && safe(player.currentTime()) >= end! { finish("completed", ""); return }
        if now - playback > 30 { finish("failed", "playback timeout (30s)") }
    }

    func finish(_ status: String, _ error: String) {
        if finished { return }; finished = true
        event("stopping", status); player.pause(); timer?.invalidate()
        for observer in observers { NotificationCenter.default.removeObserver(observer) }; observers.removeAll()
        let itemDuration = safe(item.duration)
        let entry: [String: Any] = ["name": name, "path": path, "status": status, "error": error, "requested_start_s": start, "requested_end_s": end as Any? ?? NSNull(), "duration_s": itemDuration, "ended": ended, "native_frames": frames, "events": events, "clock_samples": clock, "elapsed_s": CACurrentMediaTime() - began, "playback_elapsed_s": playingBegan.map { CACurrentMediaTime() - $0 } as Any? ?? NSNull(), "automatically_waits_to_minimize_stalling": player.automaticallyWaitsToMinimizeStalling, "muted": player.isMuted, "method": "120Hz main RunLoop polls AVPlayerItemVideoOutput; BGRA pixel buffers are acquired, no visible AVPlayerLayer or QuickLook UI" ]
        results.append(entry); save("running")
        print("native \(name) \(status): \(frames.count) new pixel buffers, ended=\(ended)")
        item.remove(output); player.replaceCurrentItem(with: nil)
        completion?()
    }
}

var active: PlayerCase?
var index = 0
func runNext() {
    if index == cases.count {
        let status = results.allSatisfy { $0["status"] as? String == "completed" } ? "completed" : "failed"
        save(status); print("native result: \(outputURL.path)")
        CFRunLoopStop(CFRunLoopGetMain()); return
    }
    active = PlayerCase(cases[index]); index += 1
    active!.begin { runNext() }
}
save("starting"); runNext(); CFRunLoopRun()
if results.count != cases.count || results.contains(where: { $0["status"] as? String != "completed" }) { exit(1) }
