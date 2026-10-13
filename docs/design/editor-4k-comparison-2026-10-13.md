# FilmCraft 与 LosslessCut：4K 实测与改造取舍

历史研究记录：保留本次调查时的事实、判断与验证范围；其中的优先方向和待验证项不自动代表当前状态。当前原型接入情况见 [FilmCraft 原型说明](../../integrations/filmcraft/README.md)，最新交互范围见 [AI 识别与选片方案](ai-recognition-workspace.md)。

本机证据说明：本文中的 `outputs/` 路径均相对于仓库根目录，是当时本机验证记录或生成产物；该目录已被 Git 忽略，不随源码提交，也不是 GitHub 下载入口。

日期：2026-10-13，Asia/Shanghai。版本：FilmCraft 0.7.2、LosslessCut 3.69.0。完成已安装应用的真实导入、选段编辑、工程保存和导出测试；AI 接入成本另按官方源码判断。本轮没有改动产品实现。

后续优先级补充：用户进一步明确游戏切片以快捷为首要目标。已追加[FilmCraft 关键帧快速导出核查与实测](filmcraft-fast-export-2026-10-13.md)：本版原生 Quick Export 即使对齐关键帧仍重编码；若优先使用现成快剪能力，LosslessCut 更合适。下文保留连续草稿工作流优先时的原始比较和实测数据。

再补充：用户随后接受为本地存档后台压缩，要求保持 4K60 并实测 H.265。[三档激战实测](filmcraft-hevc-quality-2026-10-13.md)已完成：20 秒输出分别为 50.8／88.3／125.8 MB，耗时约 23–26 秒，建议 50 Mbps 为高画质默认候选、35 Mbps 为省空间选项。这使 FilmCraft 的连续草稿流程仍可作为候选；不改变其缺少原生复制导出的结论。

## 结论

针对已确认的“AI 生成连续草稿 → 保留原始草稿 → 在副本上人工删改补段 → 导出成片”，**FilmCraft 更适合作为优先验证的编辑器底座**。其连续序列与关联音轨已经实际通过编辑、保存、重开测试。主要代价是渲染编码等待时间与 alpha 阶段的媒体/平台成熟度。

**LosslessCut 的优势是快速复制剪切与保留原编码内容。** 本例导出约 1.88 秒，但三个请求区间共 30 秒，实际合并文件为 38.066 秒；起点向前扩展不是理论上的小误差，最长一段提前 3.9 秒。它也能人工改段、补段和合并导出，但仍采用原片时间轴；若保留连续成片轨道这一需求，需要扩展编辑和播放模型。

该结论只支持原型底座选择，不是全平台发行验收。没有用一次成功运行证明 FilmCraft 在所有 4K 素材上稳定，也没有把两条不同导出路线按“同等质量速度排名”比较。

## 素材、机器与比较方法

- 本轮机器实际读取为 **Apple M4、24 GiB、10 个逻辑 CPU，macOS 27.0.1**。历史报告中的机器与耗时没有用于本次结果。
- 原片：`<样片目录>/2026-08-09 15-31-44.mkv`（本机样片，原片未入库），**3840×2160、60 fps、H.264、496.650 秒、6,864,213,507 字节**。单路 AAC 48 kHz 双声道，视频起点 0，音频起点 −0.021 秒。
- 旧报告中的 21 分钟 9 月原片当前不在原路径。其 BEATs 缓存属于另一份素材，未套用。本轮采用相同固定区间测试媒体和编辑能力，不评估识别质量。
- 三个请求区间：**33.4–43.4、308.4–318.4、443.4–453.4 秒**，总长 30 秒，按源时间顺序拼接。
- 两款导出顺序执行，使用隔离配置/数据目录。LosslessCut 的计时来自有效的 export-start / export-complete 事件；FilmCraft 来自实际后台任务的完成统计。验证解码另行执行，不计入导出时间。不是清空缓存后的冷启动基准，也不是机器独占实验。

依据：测试清单（`outputs/editor-comparison-20261013/manifest.json`）、机器信息（`outputs/editor-comparison-20261013/evidence/machine.json`）、源媒体探测（`outputs/editor-comparison-20261013/evidence/source-probe.json`）、统一结果（`outputs/editor-comparison-20261013/comparison-summary.json`）。

## 实测结果

| 项目 | LosslessCut | FilmCraft |
| --- | --- | --- |
| 本轮导出模式 | 关键帧剪切，原视频/音频复制，Merge & Separate | H.264 4K60，50 Mbps，AAC；显式启用硬件编码 |
| 三段导出耗时 | **1.882 秒**，包含分段与合并 | **45.014 秒**；再请求 GPU 渲染为 **45.514 秒** |
| 输出视频帧数 | 2280 | 1800 |
| 合并文件时长 | **38.066 秒** | **30.016 秒**，其中视频恰为 30.000 秒 |
| 合并文件大小 | **655.7 MB** | **188.7 MB** |
| 连续成片坐标 | 原生仍为原片坐标；选段列表及跳段播放 | 实际生成 0–30 秒的连续视频轨道及关联音轨 |
| 修改测试 | 删中段、缩短首段、补入 5 秒，列表合计 24 秒 | 同样操作后画面/音频范围均为 24 秒、1440 帧 |
| 保存重开 | 分段/标签可保存；单独目录保存时需处理源路径，详见下文 | 原始 30 秒草稿不变，24 秒副本保存重开保持一致 |
| 基础应用安装占用 | 363.828 MiB | 146.704 MiB |

FilmCraft 硬件计数实际增加 1 个编码会话、1800 帧，拒绝计数为 0；不是仅凭请求 `auto` 就认定用了硬件。第二次请求 GPU 渲染没有在本样本上体现加速，不能外推为所有效果或媒体都无收益。50 Mbps 是本轮固定测试设置，FilmCraft 文件更小不代表无损压缩优势。LosslessCut 保留原编码且输出更长，两者的大小和耗时都不是同画质、同时长条件下的编码器对比。

依据：LosslessCut 事件计时（`outputs/editor-comparison-20261013/evidence/losslesscut-export-timed.json`）、FilmCraft 两次完成任务（`outputs/editor-comparison-20261013/evidence/filmcraft-gpu-jobs-final.json`）、实际硬件计数（`outputs/editor-comparison-20261013/evidence/filmcraft-postexport-perf.json`）、安装占用（`outputs/editor-comparison-20261013/evidence/app-footprint.json`）。安装占用只加总普通文件，不含模型、推理运行时、缓存和素材；FilmCraft 为 universal，LosslessCut 为 arm64。

## 切点、画面与音频验证

LosslessCut 三个独立片的视频包均与原片局部区间连续对应：

| 请求源区间（秒） | 实际源视频覆盖（秒） | 起点提前 |
| --- | --- | --- |
| 33.400–43.400 | 29.817–43.399 | 3.583 秒 |
| 308.400–318.400 | 304.500–318.399 | 3.900 秒 |
| 443.400–453.400 | 442.883–453.399 | 0.517 秒 |

这些是源视频包呈现时间的覆盖范围，不是整段音频范围或人工可见切点的逐帧判定。合并后 11 个关键帧包的原始哈希不同；统一 Annex B 并去掉 SPS/PPS 参数集后，2280 个包与三个独立片的拼接顺序完全相同。该检查证明视频编码内容顺序，不能据此宣称所有拼接时间戳逐字相同。

FilmCraft 硬件编码输出抽查了三段各自的首帧、中间帧、末帧，共 9 个位置；源片与成片位置对应。源 MKV 的毫秒时间戳量化曾使抽样工具误取下一帧，更正结果保留了每张图实际 PTS。缩略图对比只用于定位内容，不作为全片画质评分。

**6 个文件全部通过完整音画解码**：LosslessCut 合并片及三个独立片，FilmCraft 两个导出。FilmCraft 三个段内音频窗口最佳波形相关性为 0.9724–0.9997，最佳位移为 0 至 −0.125 ms；LosslessCut 独立片也有对应的段内波形证据。未进行人工听辨和感知音画同步验收，也未用这些窗口代替拼接点全部音频检查。

依据：更正后的完整验证记录（`outputs/editor-comparison-20261013/evidence/validation-followup/summary-corrected.json`）、九组画面对照，左原片/右成片（`outputs/editor-comparison-20261013/evidence/validation-followup/filmcraft-contact-sheet-source-left-output-right.png`）。更正前记录保留用于追溯，不应使用其中旧的末帧抽样评价画质。

## 编辑、复核与持久化

FilmCraft 使用原生编辑命令完成：删除第二段及关联音频 → 第一段缩短 1 秒 → 从原片 57.4–62.4 秒补入 5 秒。结果依次为 9 秒、5 秒、10 秒，画面和音频拥有相同边界与关联标识。保存副本、重开原始草稿、重开副本后结果保持一致；原始草稿文件的 SHA-256 未变化。见往返结果（`outputs/editor-comparison-20261013/evidence/filmcraft-edit-roundtrip-summary.json`）和实际界面（`outputs/editor-comparison-20261013/evidence/filmcraft-edited-draft.png`）。本轮验证的是另存为工程副本，源码中的同工程复制序列路径另见[源码笔记](editor-comparison-source-notes.md)。

LosslessCut 也完成相同范围修改，界面合计 24 秒，并观察到播放从第一选段跳到第二选段，显示真实游戏画面。其原生导出的 `.llc` 只写 `mediaFileName` 的文件名；本轮工程在独立输出目录、原片在 Downloads，直接重开时提示同目录找不到源文件。保留原生文件并另生成含相对路径的测试副本后，可恢复 24 秒选段及原有标签。此问题可由接入层处理，不能据此说它无法保存工程。见原生保存文件（`outputs/editor-comparison-20261013/losslesscut/edit-reviewed.llc`）、路径与界面证据（`outputs/editor-comparison-20261013/evidence/losslesscut-edit-roundtrip-summary.json`）。

FilmCraft 的一次 12 秒、默认半分辨率预览采样记录到 shown=636、dropped=51，dropRate≈7.42%，音频缓冲 underruns=0。它不是全程流畅度验收；LosslessCut 没有取得同口径掉帧统计，因此不据此给两者播放性能排序。播放统计（`outputs/editor-comparison-20261013/evidence/filmcraft-playback-12s.json`）。

## 对改造成本的影响

| 方面 | LosslessCut 的取舍 | FilmCraft 的取舍 |
| --- | --- | --- |
| 已有 AI 引擎接入 | Electron/JS 与现有宿主更接近；可把候选映射为选段 | 现有 Python 引擎仍可复用；需要接 Rust 宿主/命令和任务生命周期 |
| 连续草稿轨道 | 需要补成片坐标、编辑重排、播放头及原片映射 | 核心序列/轨道模型已有，本轮编辑往返通过 |
| 人工复核 | 原片选段直观，复制剪切快；最终范围会受关键帧影响 | 连续成片编辑更自然；样本切点对应，但渲染编码有等待成本 |
| 原始结果和副本保护 | 需要自定义 AI 关联、版本与保存路径规则 | 工程副本机制可复用；AI 原稿只读策略、缓存和身份关联仍需增加 |
| 后续编辑能力 | 官方定位以选段和无损媒体操作为主 | 通用序列编辑能力更丰富，但功能存在不等于本项目媒体验收通过 |
| 维护风险 | 需要维护新增轨道和上游的衔接；HTTP 接口为实验性 | Rust 接入投入较大；官方仍标为 alpha，真实媒体和部分平台测试不足 |

这张表是基于接口/实现与本轮结果的工程判断，详细一手来源见[源码研究笔记](editor-comparison-source-notes.md)。导出路线的官方说明：[FilmCraft 架构](https://github.com/storytold/filmcraft/blob/v0.7.2/docs/architecture.md#6-export-jobs-filmcraft-export)、[LosslessCut 切点限制](https://github.com/mifi/lossless-cut/blob/v3.69.0/docs/troubleshooting.md#cutting-times-are-not-accurate)。FilmCraft 的 alpha 边界见[官方状态](https://github.com/storytold/filmcraft/blob/v0.7.2/README.md#status)。

建议优先用 FilmCraft 验证完整的 AI 草稿交互，保留现有模型和结果缓存；将 4K 导出等待作为独立产品取舍。若“接近复制文件速度地批量抽片”成为首要目标，LosslessCut 更符合该目标。无需因基础应用体积更小就承诺整合包更小到某个数值，也不应在本轮前提下承诺 FilmCraft 具备 LosslessCut 式无损快剪。

## 交付与范围

- FilmCraft 4K60 成片（`outputs/editor-comparison-20261013/filmcraft/three-clips-4k60-hardware.mp4`）
- LosslessCut 合并成片（`outputs/editor-comparison-20261013/losslesscut/2026-08-09 15-31-44-cut-merged-1791863063236.mp4`）
- FilmCraft 原始草稿（`outputs/editor-comparison-20261013/filmcraft/ai-original.fcproj`）与24 秒编辑副本（`outputs/editor-comparison-20261013/filmcraft/edit-copy.fcproj`）
- LosslessCut 原始草稿（`outputs/editor-comparison-20261013/losslesscut/ai-original.llc`）与补好源路径的 24 秒副本（`outputs/editor-comparison-20261013/losslesscut/edit-reviewed-linked.llc`）

本轮只有一份 Mac 上的 4K H.264、单路双声道素材；未覆盖多音轨选择、HEVC、HDR、Windows、全部长录像导出、真实 BEATs 结果接入及最终按钮。原录像大小与修改时间前后未变，未对整个源文件重做内容哈希。两个专用测试实例均正常退出，18089/19876 测试端口已关闭，测试工程与输出保留。清理确认（`outputs/editor-comparison-20261013/evidence/cleanup-ports.json`）。
