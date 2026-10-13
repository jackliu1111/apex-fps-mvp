# 以 LosslessCut 承载 AI 游戏选段的讨论

历史研究记录：保留本次调查时的事实、判断与验证范围；其中的优先方向和待验证项不自动代表当前状态。当前原型接入情况见 [FilmCraft 原型说明](../../integrations/filmcraft/README.md)，最新交互范围见 [AI 识别与选片方案](ai-recognition-workspace.md)。

本机证据说明：本文中的 `outputs/` 路径均相对于仓库根目录，是当时本机验证记录或生成产物；该目录已被 Git 忽略，不随源码提交，也不是 GitHub 下载入口。

日期：2026-10-13。状态：已确认优先验证定制 LosslessCut 加现有本地 AI 引擎；先做体积预算判断，尚未 fork、迁移或运行接入验证。

## 已确认的产品目标

用户确认在一个软件里完成“导入游戏录像 → AI 找候选片段 → 人工调整 → 快速导出”，本阶段不做卡点、特效和多轨混剪。继续保留本地离线、用户无需自行安装依赖、现有识别结果和功能不缩水的约束。体积优化仍需测量，但本次讨论新增了复用成熟剪辑能力、减少重复开发的目标。

现有 [ADR 0001](../adr/0001-audio-model-first.md)、[ADR 0002](../adr/0002-shared-python-engine-dual-hosts.md) 和 [CONTEXT.md](../../CONTEXT.md) 继续有效。本文件不是替换架构的已接受 ADR；“枪声候选”仍不代表击杀或已确认高光。

## 初步判断

对于上述选段与快速剪切范围，LosslessCut 是值得优先验证的剪辑底座。它已有片段列表、时间线、预览、选轨、边界调整、项目保存和剪切导出等能力；我们可将研发重点放在 AI 候选质量和分析体验。该判断不适用于需要复杂特效、字幕合成或多轨混剪的完整成片编辑器。[官方功能说明](https://github.com/mifi/lossless-cut/blob/70f2663a7a7c995903701acd2f616d057f4fdc2f/README.md)、[官方功能边界](https://github.com/mifi/lossless-cut/blob/70f2663a7a7c995903701acd2f616d057f4fdc2f/docs/index.md)

LosslessCut 本身使用 Electron、FFmpeg；添加本地 Python 推理运行时和模型后，不能保证安装占用比现产品更小。主要可预期收益是减少剪辑功能和交互的重复建设，实际维护成本仍需验证。[FFmpeg 分发研究](ffmpeg-open-source-reference.md)

## 已核实的接入能力

核查上游版本：`70f2663a7a7c995903701acd2f616d057f4fdc2f`。证据为官方文档和源码，未启动 LosslessCut 或验证真实工程往返。

| 接口 | 已确认的能力 | 不能据此推断的能力 |
| --- | --- | --- |
| CSV 片段导入 | 每行开始秒数、结束秒数、标签 | 不保留完整预测、候选版本和证据关联 |
| `.llc` 项目 | JSON5；V2 片段支持 start/end/name/tags/selected；tags 为字符串映射 | 存得下候选 ID/分数字符串，不等于已有 AI 分数或审核交互 |
| CLI/HTTP API | 可打开项目、触发导出；导出完成事件返回输出路径 | HTTP API 为实验性接口；输出路径不等于实际导出范围和审核回写 |

依据：[片段导入文档](https://github.com/mifi/lossless-cut/blob/70f2663a7a7c995903701acd2f616d057f4fdc2f/docs/index.md)、[项目类型](https://github.com/mifi/lossless-cut/blob/70f2663a7a7c995903701acd2f616d057f4fdc2f/src/renderer/src/types.ts#L23-L53)、[保存字段](https://github.com/mifi/lossless-cut/blob/70f2663a7a7c995903701acd2f616d057f4fdc2f/src/renderer/src/segments.ts#L40-L44)、[API 文档](https://github.com/mifi/lossless-cut/blob/70f2663a7a7c995903701acd2f616d057f4fdc2f/docs/api.md)。

本轮没有找到可作为稳定承诺的官方插件扩展契约；不能将内置 AI 描述为安装现成插件即可。

## 建议的职责边界

| 部分 | 拟承担职责 |
| --- | --- |
| LosslessCut 剪辑界面 | 打开与播放视频、选轨、候选复核、调整区间、项目保存与导出 |
| 现有 AI 引擎 | 模型加载、前处理与推理、原始预测、候选规则、缓存与分析记录 |
| 接入模块 | 分析任务启动/取消/进度、音轨与时间原点映射、候选身份/版本映射、人工修订关联、导出验证与结果回写 |

不将同一产品的剪辑规则同时维护在两套界面中。原始模型预测独立保存；用户移动片段边界不能反过来覆盖预测。共享同一套媒体资源是否可行，需要在具体构建中验证，而非简单删除现有 FFmpeg。

## 验证顺序与未解决边界

用户进一步要求先从文件大小判断瘦身后是否仍过大，因此下方接入验证之前增加体积门槛；实测及情景预算见下一节。接受优先验证方向不等于接受其最终安装体积。

1. 从现有真实分析结果生成 `.llc` 或 CSV，打开原录像，检查候选位置、标签、多音轨与时间偏移。这个步骤只验证数据接入，不承诺最终产品需要用户切换软件。
2. 人工调整和保存后验证片段身份、版本、选择状态与边界能否正确往返；保留独立的完整预测记录。项目路径和源文件位置改变也需处理，避免依赖项目文件总放在原视频旁。
3. 完成预览和独立片段导出，验证请求范围与实际导出范围。LosslessCut 无损剪切也受关键帧约束，Smart Cut 为实验性能力；不能以返回文件路径代替本项目的实际源范围测量。[上游精度说明](https://github.com/mifi/lossless-cut/blob/70f2663a7a7c995903701acd2f616d057f4fdc2f/docs/troubleshooting.md#L16-L25)、[现有测量逻辑](../../model_review.py)
4. 接入闭环符合现有契约后，再评估在定制版本内增加 AI 入口和分析任务界面，随包携带 AI 引擎，并分别验证 Windows/macOS 的免配置离线流程、整体体积和维护成本。

长期定制需要跟进上游变更；实验性接口需通过适配层隔离。许可证与发行模式的讨论见下节，尚未发布修改版。

## 许可证与发行模式

2026-10-13 核查上游 [package.json](https://github.com/mifi/lossless-cut/blob/master/package.json) 声明为 `GPL-2.0-only`，与仓库的 [GPL v2 文本](https://github.com/mifi/lossless-cut/blob/70f2663a7a7c995903701acd2f616d057f4fdc2f/LICENSE) 一致。GPL 允许修改和二次开发，也允许收费分发；其重要条件是分发基于 GPL 程序的修改版时，遵守相同许可及完整对应源码的提供要求，不能把修改后的 LosslessCut 默认作为闭源产品交付。

仅自己或同一组织内部修改使用，一般不要求向公众发布源码。对外分发的源码义务不等于一律必须公开上传 GitHub；接收方的源码获取及再分发权需要保留，具体提供方式须符合 GPL v2 第 3 条。[GNU 官方私有修改说明](https://www.gnu.org/licenses/gpl-faq.en.html#GPLRequireSourcePostedPublic)

现有 AI 引擎是否构成独立作品，要结合代码来源、通信方式、交互紧密程度和分发关系判断；仅使用子进程、HTTP 或 IPC 不能直接得出“不受 GPL 影响”的结论。[GNU 官方组合与聚合说明](https://www.gnu.org/licenses/gpl-faq.en.html#MereAggregation)

以上是对公开许可条文的一般说明，不是对尚未确定的整合产品作法律结论。**发行目标待确认**：用户是否接受 GPL 方式提供修改版源码，还是必须保留闭源发行能力？若闭源是硬要求，应重新评估深度 fork，考虑独立工具互操作、其他许可底座或权利人另行授权的可行性；这些路径都不能未经核查就认定满足许可。

## 本轮决策

- **Q6 [已确认]**：聚焦单软件内的 AI 选段、人工调整与快速导出。
- **Q7 [已确认]**：以定制 LosslessCut 加现有本地 AI 引擎为优先验证方向，并接受跟进上游的维护成本；通过验证后再决定正式迁移。
- **体积门槛 [用户要求优先核实，数值上限待定]**：先判断保留当前模型/能力时，瘦身后的完整安装占用是否可接受，再继续接入验证。

其他选择为仅导出候选文件供上游软件打开，或继续自研界面并借鉴部分实现。尚未把方向性讨论视为 fork、代码迁移或替代现有发行版的授权。

## 安装体积实测与情景预算（2026-10-13）

读取本机 `/Applications/LosslessCut.app`（3.69.0、arm64）和 `$HOME/Downloads/Apex Model Review.app`（0.1.0、arm64）。普通文件按 `st_size` 加总，不跟随符号链接；下表不是 DMG/ZIP 下载体积，也不包括用户录像、分析缓存、临时预览或导出文件。没有修改或启动这两个应用。

| 项目 | 字节数 | MiB | 证据类型 |
| --- | ---: | ---: | --- |
| 当前 Apex 完整应用 | 1,196,351,550 | 1,140.930 | 实测 |
| 当前 Apex 随包 runtime | 916,193,154 | 873.750 | 实测；包含 Python、模型、媒体库及模型资料 |
| LosslessCut 完整应用 | 381,501,495 | 363.828 | 实测 |
| 现有模型权重 | 364,091,999 | 347.225 | 实测 |
| 现有 `torch/lib` | 240,609,021 | 229.463 | 实测；不能视为不可裁剪的理论下限 |
| LosslessCut + 原权重 | 745,593,494 | 711.053 | 相加预算，尚未包含 AI 推理运行时 |
| LosslessCut + 原权重 + 现有 `torch/lib` | 986,202,515 | 940.516 | 相加预算，尚未包含全部 Python/音频依赖 |

来源：LosslessCut 测量（`outputs/losslesscut-size-gate/losslesscut.json`）、Apex 测量（`outputs/losslesscut-size-gate/apex-current.json`）、可复核计算（`outputs/losslesscut-size-gate/budget.json`）。不将不同应用内的文件重复计算；整合预算使用 LosslessCut 加现有 runtime，而不是把两个完整应用相加。

### 已识别裁剪项的情景测算

沿用 [运行目录裁剪讨论](runtime-footprint.md) 的候选清单：头文件、工具和模型训练/测试资料合计 **87.253 MiB**。若另行改变加载入口并成功去掉 SciPy，其当前目录为 **39.934 MiB**。以下是假设这两组候选都能安全移除时的算术预算，未生成或验证瘦身发行包；SciPy 相关其他内容、共享依赖和签名变化可能使最终值不同。

| 情景 | 预算 MiB | 十进制 GB |
| --- | ---: | ---: |
| 现有 Apex 减去两组候选 | 1,013.742 | 1.063 |
| LosslessCut + 未裁剪的现有 runtime | 1,237.578 | 1.298 |
| LosslessCut + 减去两组候选后的 runtime | 1,110.390 | 1.164 |

LosslessCut 整合情景尚未去掉重复媒体资源，也未计入新增接入代码。它是容量规划依据，不是最终包大小或已实现收益。Windows 没有本轮对应完整包实测，不能套用 Mac 数字。

### 对前期媒体假设的修正

本次检查实际 Apex 应用，发现两个媒体可执行文件合计仅 **0.646 MiB**，通过 `@rpath` 共用应用内 `libav*`、`libsw*` 和编解码依赖；因此这个 Mac 发行包已经采用共享库分发。前期仓库 `bin/` 的 39.081 MiB 两个工具是另一组构建输入，不能当作当前发行包的组成或可重复获得的节省。LosslessCut 本机媒体程序合计 **70.977 MiB**，也不能因此直接推断其功能或质量优劣。

**判断**：保留现成 LosslessCut 和原始权重时，两项就约 711 MiB，故完整安装低于 500 MiB 不可能靠删除开发/测试文件达成。保持当前推理栈、只做目前识别的常规裁剪，应按约 1.1–1.3 GB 量级评估整合方案，而不是几百 MB。若要求明显低于这一量级，需要另行评估更轻的推理运行时、模型表示或底座裁剪，并验证既有功能与识别结果；本轮没有接受这些更大改造。

用户随后提出 FilmCraft。其本机安装体积及原生 Rust 架构见 [FilmCraft 对照](filmcraft-footprint.md)：它为更轻底座提供了实测参照，上述约 1.2 GB 预算不能泛化为所有编辑器架构的下限。
