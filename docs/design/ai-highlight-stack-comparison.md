# AI 游戏选段：编辑器底座与同类产品技术栈

历史研究记录：保留本次调查时的事实、判断与验证范围；其中的优先方向和待验证项不自动代表当前状态。当前原型接入情况见 [FilmCraft 原型说明](../../integrations/filmcraft/README.md)，最新交互范围见 [AI 识别与选片方案](ai-recognition-workspace.md)。

日期：2026-10-13。状态：方案研究，未迁移代码、未启动应用、未执行媒体兼容性或集成验收。本文综合官方源码、官方产品说明和本仓库已有证据；产品宣传中的 AI 能力不作为模型精度或本地运行证明。

## 当前判断

在“导入已有游戏录像 → 本地 AI 找候选 → 人工调整 → 快速导出”的范围内，**若接受 GPL 发行条件，LosslessCut 是当前较低风险的编辑器接入方向；FilmCraft 更适合作为轻量原生架构的研究对照，尚不宜仅凭体积和 MCP 支持就替换当前底座。** 这是针对本项目资产、媒体需求及上游公开状态的工程判断，不是两款软件故障率的实测排名。

当前 Python 服务、桌面进程通信、候选版本和导出范围记录已有实现，继续使用现有软件的迁移成本最低。LosslessCut 的价值是复用剪辑产品能力；FilmCraft 的价值是轻量原生界面和清晰命令架构。两者都不能替我们解决游戏高光识别质量，也不会自动消除 Python、PyTorch 和模型占用。[当前服务实现](../../model_service.py)、[桌面工作进程客户端](../../desktop/worker-client.cjs)、[现有 ADR](../adr/0002-shared-python-engine-dual-hosts.md)

## 稳定性与接入复杂度

| 维度 | LosslessCut | FilmCraft | 对本项目的含义 |
| --- | --- | --- | --- |
| 产品与媒体路线 | 片段选择、保留音轨和快速复制剪切是主要工作流；FFmpeg 负责媒体处理 | 通用多轨非线性编辑器；Rust 媒体实现与系统硬件路径结合 | 目标是少量调整后快速剪出原始片段，LosslessCut 更直接 |
| 稳定性证据 | 有持续发行与具体媒体问题处理文档，但仍存在格式、关键帧、播放及特定版本问题 | 官方 v0.7.2 明确为 alpha，说明真实素材测试有限，Windows/Linux 少于 macOS | 更倾向 LosslessCut，但两者都要在真实游戏录屏上验收，不能用 Star 或功能数量代替稳定性 |
| 候选注入 | CSV 支持起止时间和名称；`.llc` 还支持标签与选中状态 | 命令可放置、移动、修剪片段；工程、媒体及序列可读取 | 两者都能接入候选；LosslessCut 的候选列表与本项目更接近，FilmCraft 的通用命令面更丰富 |
| 现有 AI 复用 | 与现有 Electron/JS 宿主技术相近，可保留 Python 服务及结构化通信 | Python 仍可作为独立进程，不必改写模型；但 Rust 界面、宿主通信和发行适配需要新增工作 | 技术栈相近不等于直接粘贴；候选、项目及生命周期仍需映射 |
| 后台任务 | 需要接入现有分析任务进度、取消、恢复和错误显示 | 本身已有导出后台任务、进度和取消；仍需接入外部 AI 服务 | 不能说 FilmCraft 没有任务框架，也不能把导出任务支持当成 BEATs 分析已经集成 |
| 工程往返 | `.llc` 的 tags 可承载候选身份，但复核与完整预测仍需外部记录 | `.fcproj` 为有版本的 JSON，支持迁移；需明确候选身份映射与时间单位 | 用户移动片段不能覆盖原预测；重算候选不能悄悄覆盖人工修改 |
| 快速复制导出 | 无损剪切是明确能力，受关键帧约束；Smart Cut 为实验性 | 已确认渲染编码导出能力；本轮未核实与 FFmpeg stream-copy 等价的用户快剪契约 | FilmCraft 能导出视频，不等于已经满足免全段重编码的快速导出要求 |
| 自动化接口 | HTTP API 明确标为实验性，可能变化 | CLI、TCP JSON 控制与 MCP 走共同命令系统 | FilmCraft 更利于外部 Agent 编排；该优势与内置枪声推理是两个维度 |
| 安装体积 | 前轮本机基础应用为 363.828 MiB | 前轮本机 universal 应用为 146.704 MiB | 相差约 217 MiB；加同一 AI 运行目录后仍要整体测量 |

依据：[LosslessCut 功能与导入](https://github.com/mifi/lossless-cut/blob/70f2663a7a7c995903701acd2f616d057f4fdc2f/docs/index.md)、[片段类型](https://github.com/mifi/lossless-cut/blob/70f2663a7a7c995903701acd2f616d057f4fdc2f/src/renderer/src/types.ts)、[HTTP API](https://github.com/mifi/lossless-cut/blob/master/docs/api.md)、[导出与预览限制](https://github.com/mifi/lossless-cut/blob/master/docs/troubleshooting.md)、[FilmCraft v0.7.2 状态](https://github.com/storytold/filmcraft/blob/v0.7.2/README.md#status)、[FilmCraft 控制协议](https://github.com/storytold/filmcraft/blob/v0.7.2/docs/control-protocol.md)、[FilmCraft 工程格式](https://github.com/storytold/filmcraft/blob/v0.7.2/docs/project-files.md)。

一个具体反例是 LosslessCut 3.69.0 发行说明列出了 Windows arm64 缺少 ffmpeg.exe，以及播放时切换文件后后台继续播放的问题。因此“更成熟”只能支持优先验证，不能推出任意版本任意平台可直接交付。[3.69.0 官方发行说明](https://github.com/mifi/lossless-cut/releases/tag/v3.69.0)

本项目的“实际导出范围”仍须独立记录。上游导出成功或返回文件路径，不是源时间覆盖范围已测量的证明。FilmCraft 的整数时间精度也不等于编码复制切点精确到任意帧。现有边界定义见 [CONTEXT.md](../../CONTEXT.md)，测量入口见 [model_review.py](../../model_review.py)。

## MCP、AI 模型和游戏事件是三层能力

- **操作编辑器**：MCP/命令接口让外部程序导入媒体、修剪、加效果和导出。它提供执行能力，不提供“这一段值得留下”的判断。
- **分析已有录像**：音频、画面、OCR 或多模态模型产出带时间的证据，再由规则生成候选。本项目属于此类；目前音频枪声候选不能直接称为击杀或已确认高光。
- **监听正在运行的游戏**：游戏事件 SDK 得到击杀、死亡等事件，并以录制时间线保存前后片段。它可能无需从视频里推断事件，但不能据此恢复旧录像里没有记录的历史事件。

FilmCraft 的共同命令系统可降低操作层接入成本；完整离线产品仍需模型分发、推理进度、取消清理、模型版本、结果缓存、候选复核与失效规则。[FilmCraft 命令与 MCP](https://github.com/storytold/filmcraft/blob/v0.7.2/docs/control-protocol.md)、[现有分析生命周期](../python-model-lifecycle.md)

## 同类产品：先分清怎样找到片段

### Eklipse：上传录像，由云端分析

Eklipse 支持上传本地 OBS、ShadowPlay 等生成的 MP4，随后生成候选高光，属于与“已有录屏找片段”直接相关的产品。官方将检测描述为结合画面事件、击杀信息、计分变化，以及音频反应、语音标记；检测、字幕和渲染在云端完成。[上传流程](https://eklipse.gg/help/what-to-do-after-logging-in/)、[AI highlights](https://eklipse.gg/features/ai-highlights/)、[云端产品说明](https://eklipse.gg/faq/)

这可以借鉴“多种信号给片段打分，再供人筛选”的分析流程。**不能拿其客户端体积与完整离线软件比较**：模型与算力主要在服务端。没有查到可靠的一手资料公开它具体的前端框架、模型名称、推理运行时或 FFmpeg 集成方式，因此这些项目保持未知；也没有本轮准确率、隐私或处理速度实测。

### Powder：本地游戏录像分析的历史技术参照

Powder 过往官方页面描述读取本地文件，在 Windows 端用音频与视觉模型寻找游戏高光，是比云端工具更贴近本项目的形态。[历史产品页](https://www.powder.gg/pro)、[团队与产品介绍](https://www.powder.gg/about-us)

其前核心开发者 Tom Mason 的个人履历记载 2021–2025 年相关工作使用 **C++、ONNX Runtime、DirectX 11、NVENC/NVDEC、Media Foundation、FFmpeg 与 CMake**。这是参与者一手自述，可信范围是其历史工作经历；它不是当前发行包的依赖清单，也没有证明当前产品所有模块都使用这些技术。尤其不能由此推断 Electron、Python、PyTorch 是否存在。[开发者履历 PDF](https://wheybags.com/assets/cv.pdf)

微软在 2025 年 Windows ML 预览公告中将 Powder 列为早期采用者；这证明当时的测试/集成合作，不证明已经全面上线使用 Windows ML。[Windows 官方公告](https://blogs.windows.com/windowsdeveloper/2025/05/19/introducing-windows-ml-the-future-of-machine-learning-development-on-windows/)

本轮访问 Powder 根站会跳转社区公告，未完整核实公告内容与当前可用状态。因此只将其作为**历史架构案例**，不推荐为已确认仍可使用的替代软件，也不根据跳转自行断言停服。

它对本项目的具体启发是：**原生桌面 + 推理运行时 + 系统/GPU媒体能力 + FFmpeg补足** 可以同时存在，不必把“系统媒体能力”和“FFmpeg”当成二选一。若未来需要进一步瘦身，可研究把现有模型转换到 ONNX Runtime 等原生推理路径；但原始结果一致、音频前处理、硬件支持、内存与完整安装占用均需单独验证，不能从 Powder 的技术名词推算我们的节省量。

### Outplayed 与 Medal：录制时记录游戏事件

Outplayed 官方说明，它在录制时使用 Overwolf 提供的实时游戏事件生成片段和书签，Supercut 可按击杀、死亡、助攻等事件及前后留白合成。当游戏事件不可用时会退回全程录制，并失去相应书签。这说明它的自动选段依赖事件数据，不应直接当作“模型理解任意旧录像”的证据。[Outplayed 使用说明](https://support.overwolf.com/support/solutions/articles/9000284659-how-to-use-outplayed)

Overwolf 原生应用 SDK 采用 HTML/JavaScript 文件与平台 API；这证明可用的平台技术栈，不足以推断 Outplayed 使用某个具体前端框架、某个模型或 FFmpeg 构建。对本项目可借鉴的是“带类型与时间的事件 → 前后留白 → 去重合并 → 人工复核”，而不是假定我们可从旧录像里获取同样的游戏事件。[Overwolf SDK](https://dev.overwolf.com/ow-native/reference/ow-sdk-introduction/)

Medal 的自动剪辑说明同样强调受支持游戏与录制时触发；开发者可以让游戏向本机 Medal 发请求触发前后片段。官方 2025 更新说明曾提及更新 Electron/Chromium，故至少该版本时期使用 Electron，不能据此断言其全部媒体、检测和推理实现。没有核实其当前完整内部技术栈与离线模型大小。[Medal 自动剪辑](https://support.medal.tv/support/solutions/articles/48001167701-what-is-automatic-event-detection-auto-clipping-)、[游戏接入](https://medal.tv/developer/auto-clipping)、[官方更新](https://medal.tv/blog/posts/medal-changelog-updates-2025)

**借鉴边界**：这些产品证明事件辅助自动剪辑的产品路线存在，但对用户已经保存的 Apex 录像，我们仍需要音频/画面分析。若以后扩展为边玩边录，才另行比较游戏事件 SDK、录制开销与游戏版本兼容性。

### 可读源码的自动选段实现

| 项目 | 已确认的实现 | 可借鉴的部分 | 不适合直接类比的部分 |
| --- | --- | --- | --- |
| [VideoHighlighter](https://github.com/Aseiel/VideoHighlighter) | Python/PySide6 主界面；另有 Tauri 2 + React + FastAPI sidecar 界面；Python 进程用 PyInstaller onedir 分发，媒体路径使用 imageio-ffmpeg；分析依赖含 PyTorch、OpenVINO、ONNX Runtime、Whisper、CLIP，并有可选 Ollama 路径 | 独立分析进程；把场景、运动、音频、关键词、对象、动作、人脸信号组合评分 | 不代表每次都加载所有模型；Windows 安装说明约 3 GB 下载且另下载模型，不能当轻量证明；导出逐片重编码且默认映射首路视频/音频，不等价于当前多音轨快剪契约 |
| [ai-video-editor](https://github.com/tailerchimchar/ai-video-editor) | FastAPI + SQLite + faster-whisper；React 19/Vite/Tailwind；音量峰值、转写关键词、Riot 数据、KDA OCR 等产生来源明确的候选；LLM 排序；FFmpeg 编码输出 | 分离候选来源、置信度、证据与人工复核；规则产生候选后再排序 | 小型 alpha 项目，非稳定底座证明；支持云端视觉模型，不能默认离线；Riot 游戏数据并不直接适用于 Apex |

VideoHighlighter 的来源：[Python 依赖](https://github.com/Aseiel/VideoHighlighter/blob/main/requirements.txt)、[Tauri 依赖](https://github.com/Aseiel/VideoHighlighter/blob/main/frontend/src-tauri/Cargo.toml)、[后台服务](https://github.com/Aseiel/VideoHighlighter/blob/main/sidecar/server.py)、[工作进程](https://github.com/Aseiel/VideoHighlighter/blob/main/sidecar/worker.py)、[导出实现](https://github.com/Aseiel/VideoHighlighter/blob/main/modules/media/video_cutter.py)、[安装说明](https://github.com/Aseiel/VideoHighlighter/blob/main/docs/INSTALL.md)。项目声明 AGPL-3.0 及商业许可路径，借用源码之前仍须核对许可；本文仅分析，不复制代码。

ai-video-editor 的来源：[后端依赖](https://github.com/tailerchimchar/ai-video-editor/blob/master/api/pyproject.toml)、[前端依赖](https://github.com/tailerchimchar/ai-video-editor/blob/master/web/package.json)、[排序实现](https://github.com/tailerchimchar/ai-video-editor/blob/master/api/src/ai_video_editor/ranker.py)。其 README 关于模型不看视频、图像不上传的概括不能覆盖当前源码：[配置默认启用视觉模型且使用 Anthropic 后端](https://github.com/tailerchimchar/ai-video-editor/blob/master/api/src/ai_video_editor/config.py)，[后端会发送 JPEG 帧](https://github.com/tailerchimchar/ai-video-editor/blob/master/api/src/ai_video_editor/vlm/backends/anthropic_backend.py)；有可选本地 Ollama 路径。这里只研究公开代码，没有使用它处理用户录像。具体来源文件与配置应在使用前再次核对，不能把“本机运行网页服务”当作“录像内容不外发”。

以上开源项目提供的是结构参考，没有为本项目的真实录屏、模型一致性、全平台分发给出已完成的证明；更换为 Tauri 也不会自动使推理库与模型变小。

## 体积与发行约束

前轮本机测量及预算分别见 [LosslessCut 接入讨论](losslesscut-ai-integration.md#安装体积实测与情景预算2026-10-13) 和 [FilmCraft 体积对照](filmcraft-footprint.md)。假设既定裁剪安全完成，FilmCraft 加现有 AI 运行目录约 0.94 GB，LosslessCut 约 1.16 GB；均为相加预算，未制作整合包。本轮未重新称量，不能据此宣布瘦身完成。

LosslessCut 的 GPL 发行前提尚未由用户确认。若必须闭源，不应继续把深度定制 LosslessCut 当默认已接受方案；同时 FilmCraft 较宽松的源码许可，也不应覆盖其媒体成熟度与发行依赖的独立核查。沿用 [既有许可分析](losslesscut-ai-integration.md#许可证与发行模式)，本轮不作新的组合程序法律结论。

## 下一步应验证的最小闭环

1. 固定同一份 1080p 长录屏、一份 4K 录屏和双音轨样本，以现有 AI 输出为共同输入；先验证媒体接入，不同时更换模型。
2. 核对源身份、音轨、时间原点、候选 ID/版本、起止边界；修改、取消选择、保存重开后仍可关联完整预测。
3. 完成独立片段快速导出，测量请求与实际范围、音视频同步和完整解码；特别确认 FilmCraft 是否需要补独立复制导出路径。
4. 接入分析进度、取消、崩溃恢复与退出清理；分别验收 Windows/macOS 原生包，测量安装后的完整占用。

在完成以上证据前，本文建议是验证顺序，不是迁移承诺或发行验收。没有为比较安装新软件、上传录像、fork 上游仓库或改写现有 ADR。
