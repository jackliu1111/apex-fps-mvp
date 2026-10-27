# 如何加快向检测流水线供应音频

调研日期：2026-10-27。依据：本项目已完成的同素材实验、既有读取轨迹的离线分析，以及当前官方规范、发行说明和固定版本源码。本次调研没有重读原始 30 GB 录像，没有执行新的音频性能基准；下文提出的加速路径尚未实测。

**现有瓶颈是从混合视频文件及时取得音频，不是音频文件本身难以解码。纯浏览器内，换成同步 API 或升级库值得做隔离对照，但没有依据预期它们能消除当前约 200 秒等待。** 最确定的结构性改善仍是让分析开始时就有独立音频；对已有 MKV，需要区分存储服务能力、容器扫描访问方式和浏览器调用成本。

## 已确认的边界

同环境原 MKV 检测为 209.061 秒，其中等待音频 196.438 秒；已有独立 MKA 的完整检测约 12–14 秒。FFmpeg streamcopy 和原版 Mediabunny Node 提取分别约 213 秒、211 秒；因此先完整提取再分析的串行路径约 225–226 秒，没有改善首次总耗时。原流程已有读取与分析重叠，缓存应在供应检测的同时生成，不能把“等整个缓存写完”变成新增前置条件。[独立音频实验及原始证据](independent-audio-experiment.md)

已有稀疏读取并未证明少读就更快：浏览器 4 KiB 页读约 709 MB、173,173 次范围调用，耗时 233 秒；Cluster 并发 2/4/8 也没有收益。这些结果排除了“直接加并发”“只比较交付字节”作为当前结论，但尚未单独测出外接盘介质延迟、文件系统行为、浏览器 IPC 和 JavaScript 调度各占多少。[稀疏对照](../model_web_ui/browser.prototype/evidence/sparse-comparison-20261027.json)、[Cluster 对照](../model_web_ui/browser.prototype/evidence/cluster-comparison-20261027.json)

## 已有轨迹显示：简单扩大读取页，很难两头获益

对之前保存的完整稀疏读取轨迹做范围合并，逻辑上真正需要的范围合计 **68,005,303 字节，分布于 158,368 个不相交区间**。它包含选中音频及必要容器结构，并不等于音频压缩负载。区间间隙中位数约 186.6 KB，说明小范围分散在整个视频中。[离线范围几何证据](../model_web_ui/browser.prototype/evidence/audio-supply-range-geometry-20261027.json)

可用 [analyze-read-trace.py](../model_web_ui/browser.prototype/diagnostics/analyze-read-trace.py) 复算，脚本只读取旧 JSON，不会打开原始媒体。输入旧日志为 `/private/tmp/apex-sparse-full.json`，67,793,444 字节，SHA-256 `bb3da76cdf53df8560127ebfdd28d0b1c4e78e706eea385f2606c3826ee35481`；临时文件可能被系统清理，项目保留了汇总与脚本，未复制这份大日志。分位数使用 `(n - 1) × p` 位置的线性插值。

| 固定对齐页大小 | 覆盖这些范围需触及的唯一页数 | 覆盖字节，十进制 |
| --- | ---: | ---: |
| 4 KiB | 173,070 | 0.709 GB |
| 16 KiB | 157,697 | 2.584 GB |
| 64 KiB | 143,229 | 9.387 GB |
| 256 KiB | 103,554 | 27.146 GB |
| 1 MiB | 28,858 | 30.259 GB，即整个文件 |

从 4 KiB 改为 64 KiB，唯一页数只减少约 17%，覆盖字节却扩大约 13 倍。即便预先知道全部未来位置，把间距不超过 128 KiB 的区间合并，仍需 110,212 个区间、2.934 GB；放宽至 256 KiB，才降到 41,356 个区间，但需 16.307 GB；512 KiB 几乎变成全片读取。

这是旧轨迹的**离线几何计算，不是读取耗时，也不是可直接实现的在线算法**：实际解析时后续位置可能尚未知，内存限制还会迫使长区间拆分。它足以降低“调大缓存、合并附近请求就能大幅加速”的预期，不能据此算出最终秒数。

同一份旧 Node 轨迹还保存了每次实际范围读取的耗时：214,927 次调用累计 204.845 秒，其中不超过 4 KiB 的 176,399 次调用累计 **186.266 秒，占约 91%**；这一组的中位数为 0.975 毫秒，p90 为 2.427 毫秒。这是在之前带隐式 128 KiB 合并的实验上统计出来的，不能冒充后来浏览器或无合并版本的延迟。计时包括 buffer 分配和异步文件读取完成，受 OS 缓存影响，不能分解为真实磁盘延迟、文件系统与运行时调度各占多少。不同大小的请求也不是随机分组，不能把它们的均值差直接当成页大小的因果效果。[计时实现](../model_web_ui/browser.prototype/diagnostics/demux.mjs)、[离线统计](../model_web_ui/browser.prototype/evidence/audio-supply-range-geometry-20261027.json)

这使下一轮重点更明确：**保持相同范围与顺序，先隔离单次访问成本。** 若仍串行执行这份旧轨迹中的 214,927 次读取，想在 60 秒内完成，仅每次调用的平均预算就需低于约 0.279 毫秒，且尚未留出解析和分析时间。这是工作量约束，不是优化结果预测。

另一端是完整顺序扫描。已有 FFmpeg 路径的有效吞吐为 `30,258,792,852 B / 213.070 s ≈ 142 MB/s`；这没有证明外接盘或 USB 已经达到物理极限。如果继续全扫，60 秒和 30 秒至少分别需要约 504 MB/s、1,009 MB/s 的持续有效吞吐。应先测同源顺序读与相同稀疏轨迹，不能直接断言“换 SSD 就能解决”，也不能先把整片复制到另一块盘再省略复制成本。

## 浏览器 API：哪些能做，哪些不能

**Worker + FileReaderSync 可以读取用户选中的 File/Blob，适合作为调用开销诊断。** W3C 明确允许 Dedicated/Shared Worker 同步读取；但规范算法仍从 Blob 取得流并等待完成，不承诺直接磁盘句柄、免 IPC 或更少物理 I/O。它可能减少应用层异步调度，是否影响这份素材必须实测。[W3C File API：FileReaderSync](https://w3c.github.io/FileAPI/#FileReaderSync)

**FileSystemSyncAccessHandle 不能直接同步读取用户选中的外接 MKV。** WHATWG 当前规范把成功条件限定于 bucket file system；Chrome 官方将它限定于 OPFS 内文件。用户经文件选择器获得的外接文件句柄不因此变成 OPFS 文件。把原 MKV 复制到 OPFS 后再测，测到的是“复制 + 更换存储位置 + 新 API”，必须计入复制成本，且原视频大于 30 GB，不能作为本项目默认方案。[WHATWG createSyncAccessHandle](https://fs.spec.whatwg.org/#api-filesystemfilehandle-createsyncaccesshandle)、[Chrome OPFS 与 SQLite 说明](https://developer.chrome.com/blog/sqlite-wasm-in-the-browser-backed-by-the-origin-private-file-system)

OPFS 比较适合保存已经得到的约 65 MB 音频缓存；这改善复用，不消除第一次从原 MKV 找到这些音频的成本。其存储位置由浏览器管理，也不能假设遵守用户要求的外接盘路径。

**Blob.stream 的分块计数不等于文件范围请求数。** 持续流可以反复交付 64 KiB 左右的数据块，期间并没有每块都重新调用 File.slice。必须分别记录解封装逻辑请求、实际 slice/readAsArrayBuffer 调用、ReadableStream 交付块、API 字节、底层系统调用；最后一项也不等于真实设备 I/O。现有原版浏览器的 414,596 次 `onread` 属于流交付回调，不能和稀疏路径的 173,173 次 File.slice().arrayBuffer() 直接当作同口径请求数比较。[原 MKV 报告](../model_web_ui/browser.prototype/evidence/audio-analysis-original-mkv-20261027.json)、[BlobSource 官方源码](https://github.com/Vanilagy/mediabunny/blob/v1.62.1/src/source.ts#L596)

## Mediabunny 更新是否已有现成修复

截至调研时，直接核验官方 GitHub release 和 npm latest 均为 **1.62.1**，2026-10-22 发布；项目实验固定版本为 1.25.0。搜索结果缓存里的 1.61.6 不是当前最新版本。[1.62.1 release](https://github.com/Vanilagy/mediabunny/releases/tag/v1.62.1)、[npm latest 元数据](https://registry.npmjs.org/mediabunny/latest)

1.62.0 修复了多种 Matroska SeekHead、Cue、异常时间戳和重复扫描问题，1.62.1 改进倒向 packet lookup；这支持做升级回归对照，但不能说明本素材受到这些问题影响。[1.62.0 发行说明](https://github.com/Vanilagy/mediabunny/releases/tag/v1.62.0)、[1.62.1 发行说明](https://github.com/Vanilagy/mediabunny/releases/tag/v1.62.1)

核对 1.62.1 的关键路径后：`readCluster()` 仍用 `requestSlice(dataStartPos, size)` 读取整个 Cluster，未看到选择音轨就跳过其中视频负载的实现。`BlobSource` 默认仍保留持续的 Blob 流 reader。新版提供 `useStreamReader: false` 以改用 arrayBuffer，官方把它定位为较慢、较稳定的回退；1.25.0 不能直接使用这个新选项。升级不能替代选择音轨的稀疏解析实验。[Matroska readCluster 源码](https://github.com/Vanilagy/mediabunny/blob/v1.62.1/src/matroska/matroska-demuxer.ts#L668)、[BlobSource 选项及实现](https://github.com/Vanilagy/mediabunny/blob/v1.62.1/src/source.ts#L489)

本地 HTTP Range 也不是独立的提速能力：新版 `UrlSource` 会增加请求、网络缓冲及调度层；如果服务端仍原样供应相同大 MKV，而客户端仍按整个 Cluster 请求，结构性工作量不变。服务端必须正确支持 Range/206，否则库可能退化为完整下载。只有本地 helper 在原生端完成解析、批量读取、只向浏览器交付音频，才改变浏览器侧工作量；其真实磁盘访问和首次总时间仍要测。[UrlSource 源码](https://github.com/Vanilagy/mediabunny/blob/v1.62.1/src/source.ts#L676)

## 原生工具：选择音轨不等于跳过视频读取

FFmpeg 9.0.2 的 Matroska 解析器在 `ebml_read_binary()` 内通过 `avio_read()` 读入整个 Block，随后才进入 `matroska_parse_block()`，其中才检查 `st->discard >= AVDISCARD_ALL`。因此 `-map 0:a:0` 选择输出音轨、`-discard:v all` 丢弃视频轨道，都不能据此推导会跳过磁盘上的视频负载。后者可以作小型负对照，但不应当成已找到的优化。`-skip_frame` 属于解码阶段，当前 streamcopy 已经不解码视频。[读取 Block](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/libavformat/matroskadec.c#L1087)、[解析后处理 Block](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/libavformat/matroskadec.c#L4448)、[discard 检查](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/libavformat/matroskadec.c#L4310)

MKVToolNix 的 `release-103.0` 提取器也先 `read_next_cluster()`，再在处理 SimpleBlock 时按 TrackNum 查找对应提取器；Cluster 加载调用默认的完整数据读取。没有找到它提供“只取 AAC、跳过视频 payload”的现成路径。这里是源码判断，未安装或实测 mkvextract，不能断言它与 FFmpeg 耗时相同。[提取器](https://codeberg.org/mbunkus/mkvtoolnix/src/tag/release-103.0/src/extract/tracks.cpp#L487)、[Cluster reader](https://codeberg.org/mbunkus/mkvtoolnix/src/tag/release-103.0/src/common/kax_file.cpp#L161)

mkvextract 手册的 fast scan 指利用元数据快速定位元素，不能理解成抽取整条音轨只访问音频字节。它提取 AAC 的常规输出是 ADTS AAC；把扩展名改为 `.mka` 并不会成为 Matroska。单独输出 `timestamps_v2` 也需另外处理 CodecDelay、起点及间断，比较包内容时须先去掉 ADTS 头。[mkvextract 官方手册](https://mkvtoolnix.download/doc/mkvextract.html)

自定义原生读取器仍有实验价值，但先比较 Node 的 `readSync` 与相同范围的异步 `fs.read`，确认运行时开销值得继续消除，再考虑 `pread` 或有界 `mmap`。`pread` 允许指定文件偏移；`mmap` 仍需由内核把文件页读入内存，均没有绕开外接存储访问。不要同时替换解析器、读取粒度和运行时，否则无法解释收益来源。[POSIX read/pread](https://pubs.opengroup.org/onlinepubs/9799919799/functions/read.html)、[Apple 文件映射机制说明](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemAdvancedPT/MappingFilesIntoMemory/MappingFilesIntoMemory.html)（Apple 文档较旧，只用于机制说明，不用于预测当前硬件性能。）

## 新录制路径：让位置索引或独立音频在分析前就存在

**优先验证 OBS 原生录制并正常结束的 Hybrid MP4/MOV。** MP4/MOV 的 sample table 可以根据 `stsc`、`stco/co64`、`stsz` 获得音频样本对应的 chunk 及文件偏移，再结合时间表安排读取。即使 `moov` 位于末尾，也可依据顶层 box 长度跳过媒体数据，读取索引后才计划所需音频范围。Matroska Cues 只索引部分 Cluster，规范甚至允许有视频时省略音轨引用，不能把它当成每个 AAC 包的偏移目录。[Apple sample table 说明](https://developer.apple.com/documentation/quicktime-file-format/using_sample_atoms)、[Matroska Cues 规范](https://www.matroska.org/technical/cues.html)

OBS Hybrid MP4 从 30.2 支持、Hybrid MOV 从 32.0 支持，两者支持 AAC。录制期间它们使用碎片结构，正常结束时追加完整 `moov` 并改写少量头部，官方称之为 soft-remux，无需重新搬运整份视频。这为提前规划音频读取创造条件，是由结构推导的实验方向，尚无本项目速度数据。[OBS 格式支持](https://obsproject.com/kb/hybrid-mp4)、[OBS soft-remux 技术说明](https://obsproject.com/blog/obs-studio-hybrid-mp4)

完整索引仍不保证音频连续：音频 chunk 数量、视频交错方式、当前 reader 是否合并读取都要测。尚未结束或异常终止的 Hybrid 文件可能没有完整索引，不属于这条路径。也不能把已有 MKV 全片 remux 为 MP4 的成本省略——那仍需访问原文件并写出视频，和直接录制成该格式是不同的工作。

**录制时额外写一份独立音频，是更强的结构改善。** 已有约 65 MB 音频文件能让本项目完整检测回到 12–14 秒，说明这一输入条件的收益已有实测。录制端仍需确保两路起止、暂停、丢包、AAC priming 与时间偏移一致；不能只依据文件时长判断对齐。

OBS 常规多音轨录制是在同一文件里存多个音轨，不等于同时生成独立音频。Output API 支持 audio-only、encoded 输出与音频 encoder，因此可通过插件或可控录制端实现额外输出，但这属于需要开发验证的能力，不是已确认的标准界面开关。[OBS 多音轨指南](https://obsproject.com/kb/multiple-audio-track-recording-guide)、[OBS Output API](https://docs.obsproject.com/reference-outputs)

## 体验方案：边提取、边推理、同步保存音频缓存

2026-10-27 补充讨论。状态：方案记录，尚未实现或验证新增缓存分支的端到端性能。

**目标是让用户尽早开始复核，同时在首次处理结束后留下可复用的独立音频。** 提取器每取得一小批音频，就交给模型流水线处理，并分批保存缓存；用户无需等待整份音频提取结束才看到候选。

```text
原始 MKV → 持续提取 AAC 音频包及时间信息
                         │
                         ├→ 解码、预处理、模型推理 → 渐进显示候选 → 用户复核
                         │
                         └→ 分批写入音频缓存 → 完成校验 → 后续直接复用

原始视频 ───────────────────────────────────→ 候选预览与导出
```

### 时间预期及已有能力

当前原 MKV 流程已经存在音频读取与检测重叠，实测约 209 秒完成、约 12.3 秒出现首个可复核候选。本方案是在已有渐进流程上补充持久化与复核体验，不能把“边读取边推理”重新计为新增提速成果。[前次实测](independent-audio-experiment.md)

| 路径 | 首个可复核候选 | 全部完成 | 证据性质 |
| --- | --- | --- | --- |
| 当前直接分析 MKV | 约 12.3 秒 | 约 209 秒 | 已实测 |
| 先完整提取音频，再分析 | 约 214 秒 | 约 225–227 秒 | 根据提取约 213 秒和独立音频分析约 12–14 秒估算，并非连续端到端实测 |
| 边提取、边推理、同时保存缓存 | 目标是尽早出现，尽量保持当前水平 | 目标是保持约 209–213 秒的量级，允许少量收尾；实际待测 | 本方案预期 |

若模型处理能跟上音频供应，且缓存写入没有明显拖慢提取，大部分分析可以在提取期间完成，此时总耗时接近“提取耗时 + 最后一批分析及缓存收尾”。**213 秒不是严格上限。** 同盘读写竞争、调度、缓冲积压和最终校验都可能增加时间，不能宣称并行后总时间必然等于各阶段独立耗时的最大值。

### 用户看到的过程

1. 导入后持续显示已完成分析的时间位置，例如“已分析至 08:30 / 44:00”；分析进度以已处理时间轴为准，不能用读入视频字节比例代替。
2. 第一批候选产生后立即允许预览、勾选、命名和复核，后续候选继续加入列表，并明确标示整片尚未分析完成。
3. 分析边界附近的事件标记为“正在补全”，等待必要的后续音频确定结束位置；已经稳定的候选保持稳定，用户编辑不能被后续刷新覆盖。
4. 分别表达“分析完成”和“音频缓存已保存”。缓存仍在收尾时，已完成的候选保持可用；只有缓存完成校验后，才将其标为可供下次复用。

用户复核前面片段时，后台继续处理后续录像。如果复核时间覆盖了剩余分析时间，用户停下来等待的时间就可能减少，即使机器完成全部处理仍需三分多钟。应衡量“导入到开始有效复核”和“导入到完成选片”的时间，不能只看进度条到达 100% 的时间。

### 实现边界

- 在提取器取得音频包的位置分发数据，检测和缓存消费同一批带时间信息的音频，避免分别扫描两遍原视频。检测分支仍需执行解码和前处理，模型不直接消费 AAC 压缩包。
- 使用有界批次与背压，避免任一分支变慢时无限堆积数据。批次大小和缓存写入方式需要实测；若可选缓存写入失败，应明确告知缓存不可用，并尽量让检测继续。
- 检测器直接消费提取器交付的数据，不以反复打开尚未完成的音频文件作为默认接入方式；未完成文件的可读性及索引完整性不能直接假定。
- 缓存优先保留压缩音频包，保存解码配置、原始 PTS、选轨、CodecDelay/丢弃采样、时间间断与视频时间映射，以及素材身份和缓存格式版本。保留原视频供预览和导出。
- 取消或异常中断留下的缓存不得标为完整可复用；本阶段不默认承诺断点续传。

独立音频缓存已有约 12–14 秒重跑完整检测的实测依据；已有分数则可进一步免去检测。这个时间不包含首次从 MKV 提取音频的成本。

### 验证标准

同素材比较“现有渐进检测”与“渐进检测加缓存”，记录首批可复核候选时间、全部分析完成时间、缓存可复用时间、峰值内存和候选交互响应。核对音频包、时间轴、分数及候选的一致性，并检查候选追加时用户编辑能否保留。

体验目标是首批结果尽早可用、完整检测没有明显回退、缓存能正确复用；具体耗时容差由基准波动确定。该方案不以首次总耗时下降 20% 为必要条件：其收益包括更早复核和第二次使用效率，应与下面的首次分析加速实验分别评价。

本轮只生成小型文档和 JSON。后续实验若输出达到用户规定的大文件阈值，须直接写入经确认已挂载、可写且空间足够的外接卷；不能默认把 30 GB 原视频复制到 OPFS 或本机临时目录。

## 下一轮最小验证矩阵

以下是实验设计与决策门槛，不是已实现功能或速度承诺。所有实盘基准串行运行，保持同一卷、同一素材、同一选轨和时间轴；明确冷暖缓存条件，至少交错重复三次，记录中位数与波动。

| 实验 | 固定内容与唯一变化 | 回答的问题 | 继续投入条件 |
| --- | --- | --- | --- |
| 固定轨迹读取对照，第一优先 | 从既有轨迹选开头、中部、末尾的代表性范围，固定 offset/length/顺序、并发 1 和 checksum 消费；Node 内只切换 readSync/异步 read，另在同一 Worker 内只切换 Blob.arrayBuffer/FileReaderSync | 小请求成本在运行时接口还是更低的访问层 | 记录调用数、字节、耗时分位数与 CPU；先出现稳定差距，再扩大范围；不能把轨迹回放误当完整 MKV 提取 |
| 独立顺序读控制组 | 同一源文件，跳过解封装和模型，用有界大块顺序读取并消费字节 | 移除解封装后是否能明显超过当前约 142 MB/s | 若吞吐接近原路径，说明仅移除解封装未取得明显收益；再比较读取实现或存储路径，不能据此确定全扫描上限或设备饱和 |
| 同版本流与 arrayBuffer 对照 | 使用同一库版本的原始整 Cluster 路径，切换源后端；不要同时升级模型、解析器或调整预取 | 保留流 reader 是否比重建范围读取更适合此环境 | 若只有交付块数下降，耗时没有下降，立即结束此方向 |
| Mediabunny 版本对照 | 1.25.0 与 1.62.1 各跑原版路径；另先在小 MKA 做回归，不移植稀疏补丁混测 | 本素材是否触发旧版解析问题 | 选轨、包内容、PTS/解码样本、527 个窗口分数和候选都能解释；速度收益高于重复波动 |
| 原生解析/批量供应 | 让 native helper 扫描/读取并持续输出带 PTS 的 AAC 批次，浏览器消费，不逐包 HTTP RPC，不等整份缓存结束 | 真正移除浏览器细粒度调用能改善多少 | 计入进程启动、读盘、传输、解码、可选缓存写入，完整检测明显优于原流程 |
| 新录像格式对照 | 相同录制编码设置，分别原生录制 MKV 与正常结束的 Hybrid MP4；先做短录制，统计音频 chunk 数、字节、首块与完整提取时间 | 提前拥有音频位置索引能否改善真实读取模式 | 短样本通过后再测长录制；不要使用事后转封装时间代替原生录制路径，也不凭不同内容的分数判断等价 |

建议把“值得产品化”的初始工程门槛设为：在当前素材中完整检测中位耗时至少下降 20%，首个可复核候选不晚于现有约 12.3 秒，结果通过等价性检查，峰值内存保持可控。20% 是投入决策标准，不是性能预测；若仅微基准快而完整流水线不快，应停止该方向。后续还需多种设备、容器和录制方式验证。

时间轴等价性不能只比较 AAC 哈希。已有 M4A 实验在音频包相同的情况下仍出现全部窗口分数变化；CodecDelay、edit list、priming、末尾填充和解码窗口必须一起验证。原版、缓存版和新库的行为差异应明确记录，不能为提高速度悄悄改变分析域。[时间轴与 M4A 对照](independent-audio-experiment.md)

## 投入顺序

1. 现有 MKV 首次分析：先做固定轨迹的同步/异步读取对照，加一个纯顺序读取控制组。它们决定是否继续 Worker 或原生 reader，避免把未定位的约 200 秒等待都归到 JavaScript。
2. 新录像首次分析：先验证无需自研录制插件的 Hybrid MP4；若能控制录制端，独立音频输出的结构收益更确定。
3. 重复使用：沿现有渐进流程生成音频缓存，同时保留分数和项目状态；缓存写入的首轮代价单独计量。
4. 后置：库升级作为兼容与正确性回归；原生 helper 只在访问层测试证明有收益后推进。继续加 Cluster 并发、固定大页、全片复制后漏算成本，均不作为当前重点。
