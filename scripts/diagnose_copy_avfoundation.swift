// Bounded native decode comparison. Does not start a player, infer or mutate media.
import Foundation
import AVFoundation
import CoreMedia
import CoreVideo
import CryptoKit
import Darwin

func seconds(_ time: CMTime) -> Any {
    let value = CMTimeGetSeconds(time)
    return value.isFinite ? value : NSNull()
}

func rawTime(_ time: CMTime) -> [String: Any] {
    ["seconds": seconds(time), "value": time.value, "timescale": time.timescale,
     "flags": time.flags.rawValue]
}

func fourCC(_ number: UInt32) -> String {
    String(bytes: [24, 16, 8, 0].map { UInt8((number >> $0) & 255) }, encoding: .ascii) ?? "unknown"
}

func errorDetails(_ error: Error?) -> Any {
    guard let error = error as NSError? else { return NSNull() }
    var details: [String: Any] = ["domain": error.domain, "code": error.code,
                                "description": error.localizedDescription,
                                "user_info_description": String(describing: error.userInfo)]
    if let underlying = error.userInfo[NSUnderlyingErrorKey] as? Error {
        details["underlying_error"] = errorDetails(underlying)
    }
    return details
}

func imageHash(_ image: CVPixelBuffer) throws -> [String: Any] {
    let format = CVPixelBufferGetPixelFormatType(image)
    guard format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
          CVPixelBufferGetPlaneCount(image) == 2 else {
        throw NSError(domain: "NativeDecodeDiagnostic", code: 3,
                      userInfo: [NSLocalizedDescriptionKey: "Unexpected native pixel format \(fourCC(format))"])
    }
    let locked = CVPixelBufferLockBaseAddress(image, .readOnly)
    guard locked == kCVReturnSuccess else {
        throw NSError(domain: "NativeDecodeDiagnostic", code: 4,
                      userInfo: [NSLocalizedDescriptionKey: "CVPixelBuffer lock failed: \(locked)"])
    }
    defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
    var combined = SHA256()
    var planes: [[String: Any]] = []
    for plane in 0..<2 {
        let width = CVPixelBufferGetWidthOfPlane(image, plane)
        let height = CVPixelBufferGetHeightOfPlane(image, plane)
        let stride = CVPixelBufferGetBytesPerRowOfPlane(image, plane)
        let rowBytes = width * (plane == 0 ? 1 : 2)
        guard rowBytes <= stride, let base = CVPixelBufferGetBaseAddressOfPlane(image, plane) else {
            throw NSError(domain: "NativeDecodeDiagnostic", code: 5,
                          userInfo: [NSLocalizedDescriptionKey: "Invalid native plane storage"])
        }
        var planeHash = SHA256()
        for row in 0..<height {
            let bytes = Data(bytes: base.advanced(by: row * stride), count: rowBytes)
            combined.update(data: bytes)
            planeHash.update(data: bytes)
        }
        planes.append(["plane": plane, "width": width, "height": height,
                       "active_row_bytes": rowBytes, "bytes_per_row": stride,
                       "sha256": planeHash.finalize().map { String(format: "%02x", $0) }.joined()])
    }
    var color: [String: String] = [:]
    for key in [kCVImageBufferColorPrimariesKey, kCVImageBufferTransferFunctionKey,
                kCVImageBufferYCbCrMatrixKey, kCVImageBufferGammaLevelKey,
                kCVImageBufferCGColorSpaceKey] {
        if let value = CVBufferCopyAttachment(image, key, nil) {
            color[key as String] = String(describing: value)
        }
    }
    let clean = CVImageBufferGetCleanRect(image)
    return ["sha256": combined.finalize().map { String(format: "%02x", $0) }.joined(),
            "pixel_format": format, "pixel_format_fourcc": fourCC(format),
            "width": CVPixelBufferGetWidth(image), "height": CVPixelBufferGetHeight(image),
            "clean_rect": [clean.origin.x, clean.origin.y, clean.width, clean.height],
            "color_attachments": color, "planes": planes]
}

func readCase(name: String, path: String, start: Double, length: Double) async throws -> [String: Any] {
    let began = ProcessInfo.processInfo.systemUptime
    let asset = AVURLAsset(url: URL(fileURLWithPath: path))
    let videos = try await asset.loadTracks(withMediaType: .video)
    guard let track = videos.first else {
        throw NSError(domain: "NativeDecodeDiagnostic", code: 2,
                      userInfo: [NSLocalizedDescriptionKey: "No video track: \(path)"])
    }
    let assetDuration = try await asset.load(.duration)
    let trackRange = try await track.load(.timeRange)
    let size = try await track.load(.naturalSize)
    let rate = try await track.load(.nominalFrameRate)
    let descriptions = try await track.load(.formatDescriptions)
    let audioTracks = try await asset.loadTracks(withMediaType: .audio)
    var audioRanges: [[String: Any]] = []
    for audio in audioTracks {
        let range = try await audio.load(.timeRange)
        audioRanges.append(["track_id": audio.trackID, "start": rawTime(range.start),
                            "duration": rawTime(range.duration)])
    }
    let reader = try AVAssetReader(asset: asset)
    reader.timeRange = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 600000),
                                  duration: CMTime(seconds: length, preferredTimescale: 600000))
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    ])
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else {
        throw NSError(domain: "NativeDecodeDiagnostic", code: 6,
                      userInfo: [NSLocalizedDescriptionKey: "AVAssetReader cannot add NV12 output"])
    }
    reader.add(output)
    guard reader.startReading() else { throw reader.error ?? NSError(domain: "NativeDecodeDiagnostic", code: 7) }
    print("native reader \(name): start=\(start) duration=\(length)")
    fflush(stdout)
    var frames: [[String: Any]] = []
    var missingImages = 0
    var invalidPTS = 0
    var nonIncreasingPTS = 0
    var outsideRange = 0
    var previousPTS: Double?
    var safetyStop: String? = nil
    let end = start + length
    while let sample = output.copyNextSampleBuffer() {
        try autoreleasepool {
            let pts = CMSampleBufferGetPresentationTimeStamp(sample)
            let ptsSeconds = CMTimeGetSeconds(pts)
            if !ptsSeconds.isFinite { invalidPTS += 1 }
            if ptsSeconds.isFinite, let previous = previousPTS, ptsSeconds <= previous { nonIncreasingPTS += 1 }
            if ptsSeconds.isFinite { previousPTS = ptsSeconds }
            if ptsSeconds.isFinite && (ptsSeconds < start - 0.000001 || ptsSeconds >= end + 0.000001) { outsideRange += 1 }
            guard let image = CMSampleBufferGetImageBuffer(sample) else { missingImages += 1; return }
            let attachmentArray = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as NSArray?
            let sampleAttachments = attachmentArray?.firstObject as? NSDictionary
            let doNotDisplay = sampleAttachments?[kCMSampleAttachmentKey_DoNotDisplay as String] as? Bool ?? false
            var frame = try imageHash(image)
            frame["index"] = frames.count
            frame["pts"] = rawTime(pts)
            frame["dts"] = rawTime(CMSampleBufferGetDecodeTimeStamp(sample))
            frame["duration"] = rawTime(CMSampleBufferGetDuration(sample))
            frame["do_not_display"] = doNotDisplay
            frames.append(frame)
            // Reader timeRange is the input bound. These guards additionally prevent accidental full-file reads.
            if ptsSeconds.isFinite && ptsSeconds >= end { safetyStop = "sample reached requested end" }
            if frames.count >= 5000 { safetyStop = "maximum bounded frame count exceeded" }
        }
        if safetyStop != nil { reader.cancelReading(); break }
    }
    let entry: [String: Any] = [
        "name": name, "path": path, "requested_start_s": start, "requested_duration_s": length,
        "requested_end_s": end, "asset_duration": rawTime(assetDuration),
        "video_track_id": track.trackID, "video_track_start": rawTime(trackRange.start),
        "video_track_duration": rawTime(trackRange.duration), "nominal_frame_rate": rate,
        "natural_size": [size.width, size.height],
        "codec_fourcc": descriptions.map { fourCC(CMFormatDescriptionGetMediaSubType($0)) },
        "format_extensions": descriptions.map { String(describing: CMFormatDescriptionGetExtensions($0)) },
        "audio_track_ranges": audioRanges, "reader_status": reader.status.rawValue,
        "reader_status_name": reader.status == .completed ? "completed" : String(describing: reader.status),
        "reader_error": errorDetails(reader.error), "safety_stop": safetyStop as Any? ?? NSNull(),
        "frame_count": frames.count, "missing_image_sample_count": missingImages,
        "invalid_pts_count": invalidPTS, "non_increasing_pts_count": nonIncreasingPTS,
        "out_of_range_sample_count": outsideRange, "do_not_display_frame_count": frames.filter { $0["do_not_display"] as? Bool == true }.count,
        "elapsed_s": ProcessInfo.processInfo.systemUptime - began, "frames": frames
    ]
    print("native reader \(name): status=\(reader.status.rawValue) frames=\(frames.count)")
    fflush(stdout)
    return entry
}

func comparison(_ source: [String: Any], _ clip: [String: Any], offset: Double) -> [String: Any] {
    let sourceFrames = source["frames"] as! [[String: Any]]
    let clipFrames = clip["frames"] as! [[String: Any]]
    var matched = 0
    var unmatched: [[String: Any]] = []
    var hashMismatches: [[String: Any]] = []
    var colorMismatches = 0
    var maximumPTSDelta = 0.0
    var sourceIndexes: [Int] = []
    for frame in clipFrames {
        guard let pts = (frame["pts"] as? [String: Any])?["seconds"] as? Double else { continue }
        let expected = pts + offset
        let nearest = sourceFrames.enumerated().min {
            abs((($0.element["pts"] as! [String: Any])["seconds"] as? Double ?? -1e20) - expected)
            < abs((($1.element["pts"] as! [String: Any])["seconds"] as? Double ?? -1e20) - expected)
        }
        guard let (index, candidate) = nearest,
              let candidatePTS = (candidate["pts"] as? [String: Any])?["seconds"] as? Double,
              abs(candidatePTS - expected) < 0.000001 else {
            unmatched.append(["clip_index": frame["index"]!, "clip_pts_s": pts, "expected_source_pts_s": expected]); continue
        }
        sourceIndexes.append(index)
        maximumPTSDelta = max(maximumPTSDelta, abs(candidatePTS - expected))
        if frame["sha256"] as? String == candidate["sha256"] as? String { matched += 1 }
        else { hashMismatches.append(["clip_index": frame["index"]!, "source_index": index,
                                     "clip_pts_s": pts, "source_pts_s": candidatePTS,
                                     "clip_sha256": frame["sha256"]!, "source_sha256": candidate["sha256"]!]) }
        if (frame["color_attachments"] as? [String: String]) != (candidate["color_attachments"] as? [String: String]) { colorMismatches += 1 }
    }
    return ["expected_source_offset_s": offset, "pts_match_tolerance_s": 0.000001,
            "matched_pixel_hash_frames": matched, "unmatched_pts_frames": unmatched,
            "pixel_hash_mismatch_frames": hashMismatches, "color_attachment_mismatch_count": colorMismatches,
            "maximum_relative_pts_delta_s": maximumPTSDelta,
            "matched_source_indexes": sourceIndexes,
            "scope": "same AVAssetReader NV12 format, active plane pixels excluding stride padding; no FFmpeg/native color-conversion hash claim"]
}

@main struct Diagnostic {
    static func main() async {
        let env = ProcessInfo.processInfo.environment
        guard let source = env["APEX_SOURCE_VIDEO"], let clip = env["APEX_CLIP_VIDEO"],
              let destination = env["APEX_NATIVE_READER_REPORT"] else {
            fputs("APEX_SOURCE_VIDEO, APEX_CLIP_VIDEO and APEX_NATIVE_READER_REPORT are required\n", stderr)
            exit(2)
        }
        let start = Double(env["APEX_NATIVE_SOURCE_START"] ?? "135")
        let duration = Double(env["APEX_NATIVE_RANGE_DURATION"] ?? "16.05")
        guard let start = start, start.isFinite, start >= 0,
              let duration = duration, duration.isFinite, duration > 0, duration <= 60 else {
            fputs("native source start must be finite/nonnegative; range duration must be finite in (0,60]\n", stderr)
            exit(2)
        }
        let began = ProcessInfo.processInfo.systemUptime
        var report: [String: Any] = [
            "scope": "bounded offline AVAssetReader uncompressed native decode, not QuickLook rendering or human playback/sync acceptance",
            "pixel_hash_scope": "all active NV12 plane pixels, excludes bytesPerRow padding", "pid": getpid(),
            "os": ProcessInfo.processInfo.operatingSystemVersionString, "cases": []
        ]
        var status = "failed"
        do {
            let sourceResult = try await readCase(name: "source", path: source, start: start, length: duration)
            report["cases"] = [sourceResult]
            let clipResult = try await readCase(name: "clip", path: clip, start: 0, length: duration)
            report["cases"] = [sourceResult, clipResult]
            report["comparison"] = comparison(sourceResult, clipResult, offset: start)
            status = sourceResult["reader_status_name"] as? String == "completed" && clipResult["reader_status_name"] as? String == "completed" ? "completed" : "failed"
        } catch { report["error"] = errorDetails(error) }
        report["status"] = status
        report["elapsed_s"] = ProcessInfo.processInfo.systemUptime - began
        do {
            let url = URL(fileURLWithPath: destination)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: url)
            print("native reader report: \(destination) status=\(status)")
        } catch { fputs("Cannot save native reader report: \(error)\n", stderr); exit(1) }
        if status != "completed" { exit(1) }
    }
}
