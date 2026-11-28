# Public CI recordings v1

The repository maintainer authorized one-minute audio excerpts from their shared recordings for distribution as public CI test fixtures on 2026-11-28. This permission covers the three excerpts distributed here. Each video track was generated for this test and displays a recording letter and a zero-based source frame number. No original video, filename metadata or local ALGS competition recording is included.

| File | Audio source recording | Source interval | Watch scenario role | Mean audio level |
| --- | --- | --- | --- | --- |
| A.mp4 | 2026-11-13 20-18-39.mkv | 01:00–02:00 | D, unmatched offline intake | −20.0 dB |
| B.mp4 | 2026-11-08 14-33-09.mkv | 10:00–11:00 | B, foreground review and export | −16.2 dB |
| C.mp4 | 2026-10-25 12-05-51.mkv | 04:00–05:00 | C, covered by live results | −19.1 dB |

A normal Git checkout contains the complete fixtures. From this directory run `shasum -a 256 -c SHA256SUMS` to verify v1. Each MP4 contains 1,800 H.264 frames at 320×180 and 30 fps plus 60 seconds of mono AAC audio at 24 kHz. Recording-specific tint and time-dependent brightness support pixel comparisons at low resolution.

Start the prototype server, set REVIEW_URL and CHROME_EXECUTABLE, then run from the repository root:

```sh
node model_web_ui/browser.prototype/tests/verify-real-recording-export.cjs tests/fixtures/recordings-v1 --watch
```

Chrome 158.0.8127.37 saved and reopened a 3.440-second export for B's 2.561598–6.000000 second selection. The three source-frame mean absolute errors were 0.037, 0.040 and 0.040 on a 0–255 scale. With the browser exporter deliberately shifted to start at 8 seconds while preserving the submitted duration, the saved file still measured 3.440 seconds. The three errors rose to 86.96, 80.38 and 20.69 and the frame assertion failed.
