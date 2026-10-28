# 裁剪成片在 macOS 预览卡顿的调查

> 历史调查：本文针对已归档 Python / Electron 实现的快速复制成片，未验证当前浏览器重编码导出的同类行为。旧实现入口见 [归档说明](archive-python-electron.md)。本文的 `outputs/` 路径是当时忽略目录中的本机证据，不随 Git 归档分发，也不表示当前工作区仍有这些文件。

2026-10-07，Asia/Shanghai。用户提供外置 USB 上的蛋蛋鼠直播回放和导出 `001.mp4`，观察到 macOS 文件预览中部分内容卡顿。本文记录实际检查范围；目前未修改产品导出算法，也未写入用户 USB 的原片或成片。

当前状态：用户确认「当前用其他软件正常，可以先不管」，因此暂缓 macOS 预览／QuickLook 的兼容性调查，不再把对照反馈作为当前任务的阻塞项。已有诊断记录和试验媒体保留；2026-10-28 初版收敛时移除了三个一次性诊断脚本，源码可从清理前提交 `6e2a81ac94f38fea345fbb614573a8d82a297bf2` 查看，见 [清理记录](initial-release-cleanup.md)。该决定不表示 QuickLook 问题已修复。

该原片为 H.264 1920×1080、30 FPS、约一小时，AAC 48 kHz 双声道。对应分析为 `234fec535eef423a9ab9b7dfb0ee3735`，导出任务 `3063efa43c1a4ee0a197ac57a92051da` 已完成 98 段。第一段请求 136.360–150.840 秒，关键帧开始和实测范围为 135.000–151.033313 秒，成片约 16 秒。

## 当前证据

- FFmpeg 完整解码成功；不是仅检查文件存在。480 个视频包和 750 个音频包全部与原片逐包连续匹配，原始编码负载 SHA 一致，PTS／DTS 的整数时间戳均精确偏移 135 秒。
- 成片 480 个软件解码图像逐帧匹配源参考，呈现时间也保持固定偏移，没有新增重复图像。原片参考覆盖 135–151.05 秒，共 482 帧。
- 实际 AVFoundation `AVAssetReader` 同样得到原片 482 帧、成片 480 帧，成片的全部有效 NV12 像素与对应原片相同，PTS 精确偏移。没有把像素行 padding 当作图像内容。
- 成片末尾 `15.900→15.9666875` 秒存在 66.7 ms 间隔，缺失的源帧在 150.9333125 秒，位于请求终点 150.840 秒之后。该尾部差异已记录，不据此宣称整段 QuickLook 卡顿已解释或请求范围里的内容丢失。
- 正常 Chromium 和系统 `AVPlayer` 的单轮实时对照均未复现中间停顿；稳态交付约 33.3 ms／帧。AVPlayer 观测的是实际原生新 pixel buffer；没有可见 QuickLook 窗口，不能代替用户的 Finder 预览体验或人工感知同步。
- AVC extradata、色彩、像素比例一致，取样关键帧为 IDR。容器尾部媒体／呈现时长约差 33 ms；成片音频含 152 ms seek preroll。没有凭这些差异直接改成重编码或宣布根因。

原始记录为 软件帧对照（`outputs/stutter-validation/decoded-frame-comparison.json`）、时间点对照（`outputs/stutter-validation/decoded-timing-comparison.json`）、编码包对照（`outputs/source-copy-audit/source-clip-packet-comparison.json`）、容器结构（`outputs/source-copy-audit/source-clip-boxes.json`）、原生离线解码（`outputs/stutter-validation/native-avreader-summary.json`） 和 播放器对照（`outputs/copy-playback-diagnosis/2026-10-07-electron-source-copy/report.md`）。诊断任务没有进行真实模型推理。

## 可供用户直接对照的文件

1. 内置盘原版副本（`outputs/stutter-validation/user-001-original-copy.mp4`）：与用户的 USB 成片完全同字节，SHA-256 `372dd2db060b6ad7ecee7af96a024799d7e4da38c73179642a7d0501cf212b88`。用于区分当前存储／缓存路径的影响，不称为修复版。
2. CTTS 时间表重封装试验版（`outputs/stutter-validation/001-cts-mux-experiment.mp4`）：相同来源、轨和范围，仅改变 MP4 CTTS 为版本 1。视频／音频编码包序列均与原成片相同，没有重编码，完整解码通过。它是兼容性试验，产品尚未使用该参数，也尚未获得用户 QuickLook 结论。

两者的检查分别见 同字节拷贝（`outputs/stutter-validation/internal-clip-copy.json`） 与 试验记录（`outputs/stutter-validation/cts-mux-experiment-summary.json`）。当前无需用户补充 QuickLook 对照反馈。若后续恢复调查，再记录同一 macOS 文件预览中哪一份仍有问题、成片第几秒最明显、重复打开是否相同。后续生产修复须围绕实际成立的失败行为建立回归，不能把诊断工具失败或未复现当作成片正常／已修复。
