# 独立音频提取与分析实验

日期：2026-10-27。范围：同一份 44 分钟 Apex MKV，比较“先提取 AAC，再使用现有浏览器模型分析”与原路径，暂不改变主页面的默认输入流程。

**已有独立音频时，检测只需约 12–14 秒；从现有 MKV 先提取再分析，首次总时间没有缩短。** FFmpeg streamcopy 提取仍需约 213 秒，串行加上检测约 226 秒。结构性收益来自以后直接读取约 65 MB 音频文件，或录制时已经具备独立音频。对于已有大 MKV，把提取完成设置为检测的前置条件还会推迟首个候选。

这是单素材、单机器的诊断结果。没有清理操作系统缓存，也没有隔离所有其他应用。基准读盘任务互不重叠。旧产品基线为 Chrome 155，本轮为 Codex 内置浏览器 Chromium 156；已补跑同一诊断入口的原 MKV 对照，耗时 209.061 秒。浏览器内重复使用相同的 `sequentialAudio`、EfficientAT 前处理及推理 Worker。诊断页面减少了列表渲染，本次有同环境对照，但不是多机器、多素材的统计性能保证。[实验环境](../model_web_ui/browser.prototype/evidence/audio-experiment-environment-20261027.json)

## 测量条件与结果

原文件为 `/Volumes/EXTERNALUSB/共享/2026-10-11 08-43-38.mkv`，30,258,792,852 字节。有效视频时长为 2639.449666666 秒；选中 AAC 音轨为 48 kHz、双声道。使用同一 EfficientAT mn04_as 模型，模型输入仍为 32 kHz、10 秒窗口、5 秒步长，阈值 0.2。模型 SHA-256 为 `f4291a6d768ce431694b852fa5d0c5d60171ce9ad8a1dbad28bfc144b322ba03`。

| 路径 | 实测阶段耗时 | 首个可复核候选 | 验证结果 |
| --- | ---: | ---: | --- |
| 历史原 MKV 产品分析，Chrome 155 | 208.538 秒 | 12.425 秒 | 历史 527 窗口、28 候选 |
| 本轮原 MKV，同一 Chromium 156 诊断入口 | 209.061 秒 | 12.313 秒 | 与历史结果逐项相同；也是 MKA 的同环境对照 |
| FFmpeg 从 MKV streamcopy 到 MKA | 212.813 秒 | 不进行检测 | 123,723 个 AAC 包，64,476,602 字节负载 |
| FFmpeg 指定 4 MiB 输入块，再从 MKV 提取 MKA | 213.070 秒 | 不进行检测 | 与上一份 MKA 的音频包、PTS、duration 摘要一致 |
| 原版 Mediabunny，Node 范围读取并写 MKA | 211.227 秒 | 不进行检测 | 内容和原始 PTS 一致；封装元数据限制见下文 |
| 已有 FFmpeg MKA，限定原分析域，新模型会话 | 13.135 秒 | 0.900 秒 | 527 个窗口边界、分数及 28 个候选与历史基线逐项相同 |
| 同一 FFmpeg MKA，同分析域，复用模型会话 | 12.258 秒 | 0.695 秒 | 同上 |
| 已有 FFmpeg MKA，使用自然音轨时长，新模型会话 | 12.523 秒 | 0.911 秒 | 527 个窗口分数、28 个候选相同；末窗终点多 21.333 ms |
| Mediabunny 生成的 MKA，新模型会话 | 13.888 秒 | 0.900 秒 | 与本轮原 MKV 的保存分数、窗口边界及候选逐项相同 |
| 已有 M4A，使用自然音轨时长，新模型会话 | 12.392 秒 | 0.881 秒 | 527 个窗口分数均发生变化；25 个候选，未通过等价性检查 |

数据：[历史对照及逐项比较](../model_web_ui/browser.prototype/evidence/audio-compare-historical-matched-20261027.json)、[FFmpeg 默认提取](../model_web_ui/browser.prototype/evidence/audio-extract-ffmpeg-mka-20261027.json)、[4 MiB 提取](../model_web_ui/browser.prototype/evidence/audio-extract-ffmpeg-4m-20261027.json)、[MKA 同分析域两轮](../model_web_ui/browser.prototype/evidence/audio-analysis-ffmpeg-mka-matched-20261027.json)、[MKA 自然时长](../model_web_ui/browser.prototype/evidence/audio-analysis-ffmpeg-mka-natural-20261027.json)、[M4A 自然时长](../model_web_ui/browser.prototype/evidence/audio-analysis-m4a-natural-20261027.json)。

同环境原 MKV 耗时 **209.061 秒**，主流程等待音频 **196.438 秒**，前处理加推理 **12.176 秒**，交付源字节 **30,259,417,896**。其 527 个窗口的两个目标类别分数、窗口边界及 28 个候选，与同域 MKA 两轮及历史原页面结果逐项相同。MKA 的加速不是浏览器版本或简化页面造成的假象。[本轮原 MKV](../model_web_ui/browser.prototype/evidence/audio-analysis-original-mkv-20261027.json)、[同环境逐项比较](../model_web_ui/browser.prototype/evidence/audio-compare-same-browser-matched-20261027.json)、[历史基线复核](../model_web_ui/browser.prototype/evidence/audio-compare-original-refresh-20261027.json)

原版 Mediabunny 的 Node 完整提取为 **211.227 秒**，包括封装、写入和关闭，但不含模块加载和报告落盘。API 交付 **30,259,417,896 字节 / 5,960 次范围读取**，累计读取等待 **201.008 秒**；写入 **127 次**，累计等待 **15.382 秒**，最大写入块 1 MiB，输出 **65,689,632 字节**。读写可重叠，分项不能相加。它也没有取得首次提取的明显优势，且说明压缩缓存写入并非零成本。Node `fs.read` 不代表浏览器 `File/Blob` 提取速度；三次提取不清 OS 缓存，不能据这几个单次数字宣称某一路径稳定快 1%。[Mediabunny 提取报告](../model_web_ui/browser.prototype/evidence/audio-extract-mediabunny-20261027.json)

### 首次总成本必须包含提取

默认提取与第一轮限定分析域检测的阶段时间相加为：

```text
首次串行成本 ≈ 212.813 秒提取 + 13.142 秒检测及导入清理 + 0.016 秒清单读取 = 225.972 秒
首次候选等待 ≈ 212.813 秒提取 + 0.900 秒检测 = 213.713 秒
后续已有音频检测 ≈ 12–14 秒
```

这是已测阶段的拼接估算，不是一次连续自动导入操作的独立墙钟测量；没有计入用户选择文件的间隔。检测表中的 `totalMs` 不含文件元数据导入与清理，完整诊断耗时另存 `elapsedIncludingImportAndCleanupMs`：MKA 两轮分别为 13.142 和 12.300 秒。FFmpeg 时间包括进程启动、解封装、封装、写入及正常退出，不包含 `fsync` 持久化等待。

因此，“音频文件分析只需十几秒”不能转述成“现有 MKV 首次分析十几秒”。本次完成提取后才开始分析的方案，还把首个候选从历史约 12 秒推迟到约 214 秒。

Mediabunny 的对应阶段合计为 211.227 秒提取 + 13.920 秒分析及导入清理 + 0.008 秒清单读取 = **225.155 秒**，同样没有改善首次总成本。[提取产物完整分析](../model_web_ui/browser.prototype/evidence/audio-analysis-mediabunny-mka-20261027.json)、[数值逐项比较](../model_web_ui/browser.prototype/evidence/audio-compare-mediabunny-20261027.json)

## 结构性瓶颈在哪里

FFmpeg 4 MiB 实验记录输入读取 **30,258,792,852 字节、0 次 seek**，完整提取仍为 213.070 秒。提高输入块上限没有带来可见收益；这里的 `-pkt_size` 不是音频压缩包大小，也不能由它推断操作系统每次物理 I/O 的大小。此路径最终依然遍历了整个高码率视频容器。[FFmpeg 提取日志](../model_web_ui/browser.prototype/evidence/audio-extract-ffmpeg-4m-20261027.json)

独立 MKA 分析期间，浏览器交付约 **65.608 MB** 源数据；限定分析域第一轮主流程等待音频仅 **0.033 秒**，特征前处理加推理累计 **12.811 秒**，模型调用往返 **13.063 秒**。自然时长一轮同样只等待音频约 **0.031 秒**。与历史主流程等待音频约 195.507 秒相比，容器访问已经不再挡住模型。读取、解码和模型运行有重叠，各分项不可直接相加。[同分析域分析报告](../model_web_ui/browser.prototype/evidence/audio-analysis-ffmpeg-mka-matched-20261027.json)

`readBytes` 是 Mediabunny `BlobSource.onread` 交付的字节数，不是块设备物理读盘量。`readCalls` 是流数据交付块的回调次数，不能与之前逐次 `File.slice().arrayBuffer()` 范围请求数直接比较。第一份同分析域报告未保存这条文字备注，口径仍相同。

这个实验支持两个有限结论：大容器到音频的供应路径主导原流程；一旦音频可直接访问，现有流水线转为主要受前处理和推理约束。4 MiB FFmpeg 一轮的 CPU 时间约 4.529 秒，而 wall 约 213 秒；按交付字节除以 wall 得到约 142 MB/s，仅为这一完整读取路径的有效速率，不是独立物理盘吞吐测试。没有进一步分离 USB 介质、ExFAT、操作系统缓存、浏览器交付和解封装各自的时间占比。

## 必须保留时间轴契约

### MKA：内容一致，尾包时长仍需明确

FFmpeg MKA 中有 123,723 个 AAC 包，负载总计 64,476,602 字节，负载 SHA-256 为 `fff9e835ab41b5f0dac2a18d4b929740555f0bb22b4b7da4450481c5fe43ca28`。默认与 4 MiB 两次产物的包摘要一致。无 AAC 解码、无重新编码。[默认 MKA 包报告](../model_web_ui/browser.prototype/evidence/audio-packets-ffmpeg-mka-20261027.json)、[4 MiB MKA 包报告](../model_web_ui/browser.prototype/evidence/audio-packets-ffmpeg-4m-20261027.json)

本轮原素材读取中同步计算内容和 PTS 强哈希，并记录每包 24 字节时间轴。原素材、两份 FFmpeg MKA 和 Mediabunny MKA 的 PTS+类型+长度+内容 SHA-256 均为 `5c084b32d23a671f923156e9868efe80b033718d3d611d5bed498b91c846c4ab`，123,723 个包在固定 Mediabunny 1.25.0 读取、尚未应用 CodecDelay 的原始 PTS 口径下逐项相同；不等于跨播放器呈现时间完全相同。FFmpeg 与 Mediabunny 重封装后，分别有 6,452 / 8,333 个包的推导 duration 与原素材不同：固定库会用同 Cluster 下一包的 PTS 推导 duration，Cluster 尾包处理不同。因此不宣称全部包元数据完全相同。[逐包时间轴比较](../model_web_ui/browser.prototype/evidence/audio-packet-timeline-comparison-20261027.json)、[Mediabunny 产物包报告](../model_web_ui/browser.prototype/evidence/audio-packets-mediabunny-20261027.json)

原分析域结束于 2639.402 秒；FFmpeg 重封装为 MKA 后，Mediabunny 将自然音轨结束解释为 2639.423333333 秒。诊断入口允许显式限定分析域为 `2639.402`，并同时保存自然时长和实际分析时长，避免默默裁剪。

限定分析域两轮各解码 123,722 个 PCM 缓冲；FFmpeg MKA 自然时长一轮解码完整 **123,723 个**。该 FFmpeg MKA 自然时长一轮仍保持全部 527 个窗口分数及 28 个候选相同，仅最后一个窗口的 `end` 增加 0.021333333 秒。因而不能把限定分析域的严格一致，写成所有容器时长字段完全一致；也不能把少解码末包当作性能方案。

### M4A：压缩内容相同，不等于模型输入相同

M4A 是从已有 MKA 再次 streamcopy 得到，二次重封装耗时 1.941 秒；该数字不是从 30 GB 原 MKV 提取 M4A 的耗时。[MKA 到 M4A 的记录](../model_web_ui/browser.prototype/evidence/audio-remux-mka-to-m4a-20261027.json)

M4A 保留全部 123,723 包和相同的 AAC 负载 SHA-256，但 Mediabunny 首包时间戳从 MKA 的 `0` 变为 M4A 的 `-0.021` 秒，包的后续节奏也不同。FFprobe 中原 MKV/MKA 为 `1/1000` 时间基准、首包 skip-samples 为 1024；M4A 为 `1/48000` 时间基准、skip-samples 为 1008，后续首几个时间戳为 `0.000333`、`0.021500` 等。FFprobe 与 Mediabunny 对 MKA 的首包时间戳呈现也不同，说明必须明确采用哪个时间坐标和如何处理编码延迟。[包时间轴](../model_web_ui/browser.prototype/evidence/audio-packets-m4a-20261027.json)、[FFprobe 首包记录](../model_web_ui/browser.prototype/evidence/audio-ffprobe-timestamp-head-20261027.json)

本地固定 Mediabunny 1.25.0 的 Matroska 读取器没有解析/应用 `CodecDelay`、`DiscardPadding`，包 PTS 直接取 Block 时间戳；MP4 读取器则应用 edit list 偏移（运行库对应位置为 10938、8504 行）。FFprobe 对原 MKV 与 FFmpeg MKA 都给出首 PTS `-0.021`、skip 1024，与 Mediabunny 的 `0` 起点不同。原路径已经存在跨容器的编码延迟语义差异，而不只是新缓存文件需要增加一个偏移。Matroska 标准明确要求扣除 CodecDelay；FFmpeg 的 streamcopy 不承诺各容器读回时间语义完全相同。[Matroska CodecDelay](https://www.matroska.org/technical/elements.html#CodecDelay)、[FFmpeg streamcopy](https://www.ffmpeg.org/ffmpeg.html#Streamcopy)

额外只读每份文件头 256 KiB，确认原 MKV 与 FFmpeg MKA 都保存 `CodecDelay=21,333,333 ns`，而当前 Mediabunny muxer 输出为 **0**。因此 Mediabunny 产物即使通过现有浏览器数值对照，也不构成跨播放器的完整元数据保真缓存；产品实现必须另存并正确处理源延迟。它的自然结束点也仍为 2639.402 秒，不能沿用 FFmpeg MKA 的“完整自然尾包消费”结论。[文件头与时间轴证据](../model_web_ui/browser.prototype/evidence/audio-packet-timeline-comparison-20261027.json)

实测 M4A 的全部 527 个窗口保存的两个目标类别分数均与 MKA 不同，最大绝对差 **0.16992223262786865**，候选变为 25 个、合计 1525 秒（原结果 28 个、1510 秒）。当前 PCM 拼接按逐包 PTS 放置采样，编码延迟处理和逐包时间栅格都能改变输入；本轮没有隔离两者各自贡献。**当前这条 MKA → M4A 路径不能直接替换 MKA 或原 MKV 的分析输入。** 25 与 28 的数量差只证明行为改变，不说明识别质量变好或变差，也不是有损编码的结果。另建时间语义实验应对照同一时间域的 PCM，并在修正行为时提升前处理版本，不能只添加固定 21 ms 偏移宣称等价。

## 下一步实现取舍

1. **允许已有独立音频与原视频配对。** 音频承担检测，原视频承担预览及导出。保存素材身份、源音轨标识、时间偏移、时长约定及容器/解码版本；存在时间戳间断时应保存分段映射。上线前另验首尾及跨间断的音画同步。
2. **已有 MKV 优先验证边分析边写压缩音频缓存。** 提取包流同时供解码和有界缓存写入，保留渐进候选；不要先等待全片提取完成。缓存成功后重复分析可直接消费音频文件。写入开销、背压、取消及失败恢复尚需实测，本轮没有实现或宣称这条路径已加速首次处理。
3. **继续优化首次 MKV 访问时，以端到端耗时和首候选为准。** 4 MiB 输入块实验已经没有收益，不宜仅根据读取量或配置值判断加速。容器内音频分布和获取成本仍是需要解决的部分。
4. **模型优化的价值取决于使用路径。** 对现有 MKV 的首次分析，减少约 12 秒模型工作仍被容器读取遮蔽；已有音频时，它已经成为主要成本，可以再考虑特征复用等实验。此次未修改模型采样率、模型权重或检测阈值。

本轮只验证候选生成数值与流程效率，不评价 Apex 检出质量，也不验收预览、导出、编辑恢复、长期缓存或完整产品界面。

## 复现

本节是历史实验方法：2026-10-28 已从当前代码树移除隔离诊断入口，保留本文和全部小型证据。以下命令与 URL 需在清理前提交 `6e2a81ac94f38fea345fbb614573a8d82a297bf2` 的独立工作区运行，查看方式见 [初版收敛记录](initial-release-cleanup.md)。当前产品不提供 `standalone-audio.html`。

从仓库根目录运行。先确认 `/Volumes/EXTERNALUSB` 为真实已挂载、可写且空间足够的外接卷，再新建独立输出目录。脚本拒绝覆盖已有媒体或报告。以下路径中的 `REPLAY-NEW` 必须使用尚未存在的新任务目录；不要向已有实验目录重复写同名文件。

```sh
python3 model_web_ui/browser.prototype/diagnostics/ffmpeg-extract.py \
  '/Volumes/EXTERNALUSB/共享/2026-10-11 08-43-38.mkv' \
  '/Volumes/EXTERNALUSB/codex-artifacts/apex-fps-mvp/REPLAY-NEW/audio.mka' \
  '/Volumes/EXTERNALUSB/codex-artifacts/apex-fps-mvp/REPLAY-NEW/extract.json'
```

4 MiB 对照使用另一组新输出路径，并加 `--input-packet-bytes 4194304`。原版 Mediabunny 的 Node 提取入口为：

```sh
node model_web_ui/browser.prototype/diagnostics/extract-audio.mjs \
  '/Volumes/EXTERNALUSB/共享/2026-10-11 08-43-38.mkv' \
  '/Volumes/EXTERNALUSB/codex-artifacts/apex-fps-mvp/REPLAY-NEW/audio-mb.mka' \
  '/Volumes/EXTERNALUSB/codex-artifacts/apex-fps-mvp/REPLAY-NEW/extract-mb.json' 0
```

需保留固定版本的运行库 `/private/tmp/apex-browser-prototype-20261026/assets/vendor/mediabunny.mjs`。包内容及时间戳校验：

```sh
node model_web_ui/browser.prototype/diagnostics/inspect-audio-packets.mjs \
  '/Volumes/EXTERNALUSB/codex-artifacts/apex-fps-mvp/REPLAY-NEW/audio.mka' \
  '/Volumes/EXTERNALUSB/codex-artifacts/apex-fps-mvp/REPLAY-NEW/packets.json' 0
```

运行现有静态服务，浏览器打开 `http://127.0.0.1:8792/diagnostics/standalone-audio.html`：

- 检查页面显示的浏览器版本，选择 MKV 或 MKA 文件。
- 音轨序号 `0`，原视频起点 `0`，原视频有效时长 `2639.449666666`，映射偏移 `0`，阈值 `0.2`。
- 严格对照填“分析音频时长”`2639.402`；自然时长对照留空。每次报告保存该选择。
- 连续轮次 `2`：首轮新建 Worker/模型会话，第二轮复用模型；每轮新建 Input。新会话不代表冷磁盘缓存。
- 完成后下载 JSON，或展开完整报告读取。分析期间不渲染整份分数。不要同时执行其他提取实验。

逐项比较报告，不只比较候选数量：

```sh
python3 model_web_ui/browser.prototype/diagnostics/compare-audio-results.py \
  BASELINE.json AUDIO-ANALYSIS.json --output NEW-COMPARISON.json
```

脚本默认零容差，并报告窗口边界、分数、候选状态、模型 SHA 和可用的参数差异。自然时长 MKA 的末窗终点不同应如实报告；M4A 预期不会通过本轮等价性检查。历史报告未记录的参数会列为未验证，不能凭新报告补写为历史事实。

## 产物位置

媒体与紧凑包时间轴保存在已确认挂载的 USB/ExFAT 外接卷：

`/Volumes/EXTERNALUSB/codex-artifacts/apex-fps-mvp/independent-audio-20261027-1914/`

| 文件 | 字节数 | 用途 |
| --- | ---: | --- |
| `ffmpeg-copyts.mka` | 65,363,521 | 默认 streamcopy 音频 |
| `ffmpeg-4m.mka` | 65,363,521 | 4 MiB 输入块对照 |
| `ffmpeg-from-mka.m4a` | 64,973,268 | 时间轴差异对照 |
| `mediabunny.mka` | 65,689,632 | 当前固定库的提取写盘对照，保真范围见上文 |

仓库仅保存实验文档和小型 JSON 证据，诊断代码已按上述历史提交归档；原录像未复制、未修改，没有生成整段 PCM 文件。复测和使用上述媒体依赖 `/Volumes/EXTERNALUSB` 挂载。4 份压缩媒体合计 **261,389,942 字节**，4 份包时间轴各 2,969,352 字节，数据总计 **273,267,350 字节**；计入 ExFAT 上 macOS 自动生成的 32 KiB 元数据，目录文件合计 **273,300,118 字节（约 260.64 MiB）**。实际绝对路径和 SHA-256 见 [产物 manifest](../model_web_ui/browser.prototype/evidence/audio-experiment-manifest-20261027.json)，关键数字见 [机器可读摘要](../model_web_ui/browser.prototype/evidence/audio-experiment-summary-20261027.json)。
