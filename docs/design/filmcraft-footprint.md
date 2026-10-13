# FilmCraft 安装体积与技术栈对照

历史研究记录：保留本次调查时的事实、判断与验证范围；其中的优先方向和待验证项不自动代表当前状态。当前原型接入情况见 [FilmCraft 原型说明](../../integrations/filmcraft/README.md)，最新交互范围见 [AI 识别与选片方案](ai-recognition-workspace.md)。

本机证据说明：本文中的 `outputs/` 路径均相对于仓库根目录，是当时本机验证记录或生成产物；该目录已被 Git 忽略，不随源码提交，也不是 GitHub 下载入口。

日期：2026-10-13。针对“同样是编辑软件，为什么 FilmCraft 更小”的补充调查。只读取本机已安装应用和上游源码；未启动、修改应用，未验证真实录屏的编辑或导出效果。

## 同口径实测

普通文件逻辑长度 `st_size` 求和，不跟随符号链接；不包括用户录像、模型后续下载、缓存、预览或导出文件。

| 本机应用 | 版本/架构 | 文件总字节数 | MiB |
| --- | --- | ---: | ---: |
| `/Applications/FilmCraft.app` | 0.7.2，Intel + Apple Silicon universal | 153,830,177 | 146.704 |
| `/Applications/LosslessCut.app` | 3.69.0，arm64 | 381,501,495 | 363.828 |
| `$HOME/Downloads/Apex Model Review.app` | 0.1.0，arm64 | 1,196,351,550 | 1,140.930 |

FilmCraft 的本地 DMG 是 73,270,207 字节（69.876 MiB），和 [v0.7.2 官方发行元数据](https://github.com/storytold/filmcraft/releases/tag/v0.7.2) 的下载大小相同；这不是安装后大小，也未通过哈希核验认定本地与发行文件内容相同。

FilmCraft 应用只有 9 个普通文件，主程序占 153,070,656 字节（145.980 MiB），其他主要是图标和许可信息。主程序内的 arm64 段为 73,837,632 字节（70.417 MiB），x86_64 段为 79,203,536 字节（75.534 MiB）。这些是二进制段长度；未制作或签名新的单架构应用，不能当成新发行包实测。

证据：FilmCraft 本地记录（`outputs/losslesscut-size-gate/filmcraft-local.json`）、LosslessCut 记录（`outputs/losslesscut-size-gate/losslesscut.json`）、Apex 记录（`outputs/losslesscut-size-gate/apex-current.json`）。

## 为什么更小

1. **原生 Rust 界面，不携带 Electron。** v0.7.2 的桌面程序使用 egui/eframe 和 wgpu，并调用原生系统窗口接口。本地包没有 Electron Framework；动态依赖检查只显示 macOS 系统库和框架。对照本机 LosslessCut，`Contents/Frameworks` 为 220.496 MiB。该数是其整个框架目录，不等于仅浏览器可执行代码。[桌面依赖](https://github.com/storytold/filmcraft/blob/v0.7.2/apps/filmcraft/Cargo.toml)
2. **媒体实现采用自身 Rust 代码和系统加速。** 项目源码列出独立的容器、编解码模块；README 声明 FFmpeg 仅作为外部测试参照。本机包没有独立 FFmpeg/ffprobe 或 libav 动态库。平台模块提供 macOS VideoToolbox、Windows Media Foundation 等硬件路径，并在支持的情形下由 HybridDecoder 回退 Rust 软件解码。本机确实链接 VideoToolbox；链接 AudioToolbox 本身不能证明具体的音频编解码调用路径。[工作区依赖](https://github.com/storytold/filmcraft/blob/v0.7.2/Cargo.toml)、[平台模块](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/platform/README.md)、[项目说明](https://github.com/storytold/filmcraft/blob/v0.7.2/README.md#formats-and-codecs)
3. **没有本项目的本地模型负担。** FilmCraft 的 AI agent 控制通道是应用操作接口，不等于内置 BEATs 枪声识别。其桌面默认 feature 为空，语音识别及神经语音为可选功能，源码注明相关模型下载。本次本地包未发现独立 Python/PyTorch/模型目录；不能用基础安装大小代替启用可选模型后完整占用。[可选功能声明](https://github.com/storytold/filmcraft/blob/v0.7.2/apps/filmcraft/Cargo.toml)
4. **编译时整合与优化。** Rust 发布配置启用 thin LTO、单 codegen unit；多数代码集中在本机程序中。具体优化各节省多少未测量，不能笼统归因为“Rust 天生更小”或“静态链接必然更小”。[发布配置](https://github.com/storytold/filmcraft/blob/v0.7.2/Cargo.toml)

## 对本项目预算的影响

FilmCraft 比当前完整 LosslessCut 底座少 **217.124 MiB**。这说明 1.1–1.3 GB 是“LosslessCut + 当前 AI 栈”的条件预算，不是所有 AI 剪辑器的不可突破下限。

如果原样使用本机 universal FilmCraft，再加上前文假设裁剪成功后的现有 AI 运行目录（746.562 MiB，仍保留该引擎所需媒体依赖），相加约 **893.266 MiB，即 0.937 GB**。这是容量预算，不是已制作的软件：未计接入代码和签名变化，裁剪、集成及行为一致性均未完成验证。计算记录（`outputs/losslesscut-size-gate/filmcraft-budget.json`）

要进一步变小，需分别评估仅目标架构发行、推理运行时、模型表示，以及是否能复用 FilmCraft 媒体能力。不能因为它自带媒体处理，就直接删除现有 AI 核心仍调用的 FFmpeg。

## 候选底座边界

官方 v0.7.2 README 将其标为 alpha，并说明真实素材以及 Windows/Linux 测试仍有限。本项目所需的 4K 游戏长录屏、多音轨、时间原点映射、快速复制剪切和实际导出范围记录，尚未在 FilmCraft 上验证；原生编辑能力或演示界面不能代替这些证明。[官方状态说明](https://github.com/storytold/filmcraft/blob/v0.7.2/README.md#status)

主代码声明为 `MIT OR Apache-2.0`，第三方资源和品牌另有条款。这个许可事实与 LosslessCut 的 GPL-2.0-only 不同，但不等于已经完成整个依赖、编解码及发行方案的许可审查。[许可证声明](https://github.com/storytold/filmcraft/blob/v0.7.2/README.md#license-and-credits)

目前仅将 FilmCraft 加入体积与架构对照；没有选择它替换 LosslessCut 或当前项目，也没有开始迁移。

进一步的稳定性、AI 接入成本及同类自动高光产品技术栈，见 [AI 游戏选段技术栈比较](ai-highlight-stack-comparison.md)。底座更小与媒体流程更成熟、AI 模型更易集成是不同维度，应分别判断。
