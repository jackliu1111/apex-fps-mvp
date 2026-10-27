# 外置盘 MKV 读取诊断

这是隔离诊断入口，不改主页面的媒体读取或分析算法。只读用户选择的本地文件，不上传、不生成媒体副本。依赖现有静态服务器及固定版本 Mediabunny 1.25.0。

浏览器打开 `http://127.0.0.1:8792/diagnostics/`，选择同一份录像：

- 短对照：前 20 秒，比较 BlobSource、音频解码、StreamSource 范围读取、关闭预读、64 MiB 缓存及默认配置复测。
- 全片读取：提取前 2640 秒压缩音频包，不解码、不运行模型。
- 首窗等待对照：消费前 20 秒 PCM，分别使用本次录像的 2639.45 秒结束边界和开放结束边界。仅针对本次素材，不能作为任意文件的通用测试。

各轮新建 Input，系统缓存不清除。先后次序影响耗时，必须同时比较读取字节数，不能把热缓存效果当作代码优化。下载的 JSON 包含读取区间和请求区间。`reads` 为库交付给解封装器的源字节；不是操作系统块设备的物理 I/O 统计。Blob 流拉取耗时可重叠，不能与其他阶段相加。压缩包 FNV32 仅为轻量对照校验，不是强完整性证明；Node 对照另保留 SHA-256。

Node 使用同一版解封装器与 `StreamSource` 的 fileSystem 预读配置，读取实现是 `fs.read`，不代表浏览器 WebCodecs 性能。复现命令：

```sh
node model_web_ui/browser.prototype/diagnostics/demux.mjs \
  '/Volumes/EXTERNALUSB/共享/2026-10-11 08-43-38.mkv' \
  20 fileSystem 8 /private/tmp/apex-demux-baseline.json
```

已实跑返回 `RED: audio extraction reads >100x encoded audio bytes`，退出码 2 表示读取放大超阈值，其他异常也会非零退出。该阈值用于本次高码率混合 MKV 的诊断，不是所有容器的通用性能标准。原始输出见 `../evidence/read-diagnostic-node-*-20261027.json`。

诊断访问了库内部 `_read` 以记录逻辑范围，只在这个独立入口使用；正式代码不依赖此内部接口。没有修改第三方库。Node `openAsBlob` 在当前环境报告的文件大小与 `stat` 不一致，因此未用于计时，使用 `stat` 验证大小的范围读取器。

## Cluster 有限并发实验（2026-10-27）

独立实验入口，不改变主页面默认分析路径。先生成并列运行库：

```sh
python3 model_web_ui/browser.prototype/diagnostics/build_concurrent_runtime.py
node model_web_ui/browser.prototype/diagnostics/cluster-parity.mjs
node model_web_ui/browser.prototype/diagnostics/cluster-benchmark.mjs \
  '/Volumes/EXTERNALUSB/共享/2026-10-11 08-43-38.mkv' \
  2640 1,4,original,8,2,4,original /private/tmp/apex-cluster-full.json
```

浏览器入口 `/diagnostics/cluster-browser.html`，选择同一素材，输入顺序（例如 `original,4,original,4`）及提取秒数，点击开始并下载报告。Node 范围读取和 Chrome File/Blob 读取分别测量，不能混为端到端模型分析。

`cluster-prefetch.js` 通过已知长度的 Segment 子元素头定位接续 Cluster，不假设 Cues 完整覆盖。每个任务有独立页缓存和扫描状态，仅提前准备 Timestamp 和所选轨道的 SimpleBlock / BlockGroup；随后原库串行遍历这些元素并交付压缩包。每任务最多保留 2 MiB 元素，最多 1/2/4/8 个任务。遇到无法处理的元素边界或保留量超限，当前 Cluster 返回原 sparse 扫描；未知下一 Cluster 长度时停止向前调度。原库负责未知长度当前 Cluster 的结束边界解析。

`maxRetainedBytes` 仅计任务持有的目标元素副本，不是进程峰值。还存在每任务最多 128 × 4 KiB 页缓存、边界页缓存、上游 8 MiB 缓存、当前被消费元素和原库包数据。seek 会先结清旧任务，close 会等待在途读取退出；不创建文件随片长增长的全量索引或 PCM 缓存。完整文件任务退出后 `fallback` 可包含取消预取任务，不能把它直接视为容器解析失败数。

Node 同时比较音频内容 SHA-256 和包含每个包时间戳、duration、类型、长度及内容的顺序 SHA-256。浏览器以内容及元数据 FNV32 作轻量交叉检查，强校验以 Node 为准。未清系统缓存，各轮顺序写入报告；热缓存不能当成代码加速。只保存统计摘要，不保存逐请求 trace 或媒体副本。

本轮完成的 Node 全片顺序实际为 `1,4,original,8,2`；额外重复轮主动停止。结果为 209.992 / 328.489 / 208.087 / 351.936 / 300.638 秒。Chrome 单次 4 并发全片为 330.860 秒。没有性能收益，不接入主分析。完整口径、缓存限制和证据见 CAPTURE 最后一节。


## 独立音频提取与分析实验（2026-10-27）

浏览器入口：`http://127.0.0.1:8792/diagnostics/standalone-audio.html`。选择原 MKV 或独立 MKA/M4A，用现有 `sequentialAudio` 和 EfficientAT Worker 完成 10 秒窗口、5 秒步长的分析。页面默认时间轴仅对应本次 44 分钟录像；其他素材须修改原视频起点、时长和映射偏移。限定音频时长 `2639.402` 用于与历史有效分析域逐项对照，留空则消费读回的自然时长。每轮新建 Input；同一次点击的后续轮复用模型，不清系统缓存。

本地提取与验证入口：

- `ffmpeg-extract.py SOURCE OUTPUT REPORT`：AAC streamcopy 到 MKA/M4A，记录进程启动至正常退出；`--input-packet-bytes 4194304` 仅改变原生文件输入缓冲。无解码、无重新编码，不覆盖输出。
- `extract-audio.mjs SOURCE OUTPUT_MKA REPORT [TRACK_INDEX] [TIMELINE]`：固定原版 Mediabunny，Node `fs.read` 范围读取，1 MiB 有界写入 MKA；记录源内容、PTS 与元数据 SHA-256。不是浏览器提取耗时。
- `inspect-audio-packets.mjs AUDIO REPORT [TRACK_INDEX] [TIMELINE]`：检查选中音轨的包内容、时间戳、duration、轨道数；可保存每包 24 字节的紧凑时间轴，供原素材与输出差分。
- `compare-audio-results.py BASELINE CANDIDATE... --output NEW_REPORT`：支持主页面或本诊断 JSON，比较全部保存的两类分数、窗口边界和候选；默认零容差。差异退出码 2；自然时长尾界差异和 M4A 行为差异需要解释，不应掩盖。

`BlobSource.onread` 的 `readCalls` 是交付流块数量，不是 File.slice 请求数或系统调用数。各计时阶段可重叠；首次顺序成本必须另加提取成本。报告下载与完整 JSON 展示在分析结束后完成。媒体产物使用已验证的外接卷目录，命令前须自行确认真实挂载、权限和空间，不向仓库写大媒体。

结论、全部实测数字、时间戳限制和可复制命令见 [独立音频实验报告](../../../docs/independent-audio-experiment.md)。本轮不修改主页面默认分析，不把 FFmpeg 变成产品后端；未验证缓存恢复、预览和导出。
