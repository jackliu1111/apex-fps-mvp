# 桌面软件体积优化讨论

历史研究记录：保留本次调查时的事实、判断与验证范围；其中的优先方向和待验证项不自动代表当前状态。当前原型接入情况见 [FilmCraft 原型说明](../../integrations/filmcraft/README.md)，最新交互范围见 [AI 识别与选片方案](ai-recognition-workspace.md)。

日期：2026-10-13。状态：访谈中，尚未选择替代架构。

用户希望减少软件占用，提出使用 Windows/macOS 自身媒体能力，以及减少随包 Python 的可能性。本轮核查源码、现有构建输入和官方能力资料；未构建新发行包，也未验证原生媒体或非 Python 推理替代方案。现有 [ADR 0002](../adr/0002-shared-python-engine-dual-hosts.md) 继续有效。

## 先区分优化指标

- 下载体积：首次获取的软件包及后续必需下载量。
- 安装占用：完整功能准备好后的程序、运行库和模型文件总量；首次启动下载依赖不会自动降低这一指标。
- 运行资源：内存、启动时间、分析与导出耗时，需要另行测量，不能从安装体积推断。

这些是测量口径，不新增产品领域术语；现有候选片段、请求导出范围、实际导出范围等术语继续使用根目录 [CONTEXT.md](../../CONTEXT.md)。

## 当前可核实的事实

[构建脚本](../../scripts/build_model_desktop.py) 用 PyInstaller onedir 收集 Python、torch、torchaudio、soundfile、SciPy 等，复制上游模型代码与选定权重，并加入显式指定的 FFmpeg/ffprobe。媒体程序路径是必填参数，不能假定本机 `bin/` 就是历史发行包的输入。[Electron 配置](../../desktop/package.json) 再将这些资源随桌面应用分发。

以下为本次读取普通文件长度得到的未压缩输入大小，1 MiB = 1,048,576 字节；不是已发布包占比，也不能与压缩 ZIP 大小直接相减：

| 当前文件 | 字节数 | MiB |
| --- | ---: | ---: |
| `bin/ffmpeg` | 20,527,448 | 19.576 |
| `bin/ffprobe` | 20,452,120 | 19.505 |
| Mac 上述两者合计 | 40,979,568 | 39.081 |
| `bin/windows-amd64/bin/ffmpeg.exe` | 102,856,192 | 98.091 |
| `bin/windows-amd64/bin/ffprobe.exe` | 102,652,416 | 97.897 |
| Windows 上述两者合计 | 205,508,608 | 195.988 |
| 邻接模型工作区 `apex-voice-detect/checkpoints/BEATs_strong_1.pt` | 364,091,999 | 347.225 |

模型权重是脚本默认选择的文件，但可被 `--checkpoint` 覆盖。前一轮在仓库内未找到 `dist/model-desktop`、`desktop/resources` 或 `build/model-desktop`；2026-10-13 后续已找到 Downloads 中的应用包，实测见下方“Python 运行目录裁剪”。[桌面验收文档](../desktop-validation.md) 的 634,257,382 字节 ZIP 是历史记录，未在本轮重新验证。当前模型桌面包不使用 ffplay，不能把本地 ffplay 大小计入可节省量。

### 媒体职责

- [model_service.py](../../model_service.py)：探测视频与多音轨、读取轨道原点，按指定音轨提取 16 kHz 单声道 PCM 音频，保存音频到视频的时间偏移。
- [model_review.py](../../model_review.py)：生成 H264/AAC 预览、按关键帧快速复制选中片段，并通过源与成片的编码包匹配测量实际导出范围。
- 当前正式导出只开放 `copy`；预览重编码不等于支持精确重编码成片导出。
- 实际预览播放由界面的 HTML video 完成；仅更换播放器不能替代上述完整媒体流程。

### Python 职责

Python 同时承载任务管理、持久化、媒体编排、候选规则、HTTP/IPC 和模型推理。[推理 worker](../../model_inference.py) 依赖 torch/torchaudio 等，并复用外部模型代码。迁移模型运行时不能自动消除其他 Python 业务代码；仅替换解释器也不能省去推理库和权重。

## 可行方向与验证边界

| 方向 | 可能收益 | 尚需解决 |
| --- | --- | --- |
| 裁剪现有发行资源与媒体构建 | 减少实际未使用的库、模块、模型源码与编解码能力 | 先获取完整包组成；确定保留能力后验证冻结程序、模型加载、预览及导出，不能直接删依赖 |
| 系统媒体能力 | 有机会省去部分或全部 FFmpeg/ffprobe | Mac AVFoundation 与 Windows Media Foundation 分别适配；容器、编码、选轨、时间原点、快速复制与实际范围测量逐项验证 |
| 非 Python 模型推理，如 ONNX Runtime 原生接口 | 有机会减少 Python/PyTorch 分发需求 | BEATs 导出、音频前处理、完整分数与候选一致性；其他 Python 核心仍需保留或迁移；模型文件仍需分发 |
| 复用用户 Python 或首次下载依赖 | 可能减少初始包大小 | Python 版本和第三方依赖不能假定存在；未必减少安装总占用，且改变交付体验 |

官方资料确认系统媒体框架和原生推理接口存在，不构成本项目替换成功的证据：

- [Apple AVFoundation 媒体读取与写出](https://developer.apple.com/documentation/avfoundation/media-reading-and-writing)
- [Windows Media Foundation 支持格式](https://learn.microsoft.com/en-us/windows/win32/medfound/supported-media-formats-in-media-foundation)与 [MKV 支持](https://learn.microsoft.com/en-us/windows/win32/medfound/mkv-support)；具体目标系统仍须能力探测，不能把格式列表视为所有机器的保证。
- [Python macOS 说明](https://docs.python.org/3/using/mac.html)：系统 python3 与 Apple 开发工具关联，不能作为本软件完整推理环境的分发保证。
- [Python Windows 说明](https://docs.python.org/3/using/windows.html)：提供安装与运行时分发方式，不能假定目标机已有匹配环境。
- [ONNX Runtime C++ 接口](https://onnxruntime.ai/docs/get-started/with-cpp)：提供不经 Python 调用模型的路径；本项目 BEATs 转换与效果 **[待验证]**。

## Bili23-Downloader 的可借鉴做法

2026-10-13 核查用户提供的项目，应用源码固定到 [e3d6aff32fffca88b249412b92b40448321418c4](https://github.com/ScottSloan/Bili23-Downloader/commit/e3d6aff32fffca88b249412b92b40448321418c4)。以下是源码与构建配置证据，未下载、拆解或运行它的发行包。

| 项目 | Bili23 的做法 | 对本项目的含义 |
| --- | --- | --- |
| Python | Windows 使用嵌入式 Python 和定制 PyStand 启动器；macOS 使用静态链接 Python 的加载器与随包运行目录 | 用户无需安装 Python 可以实现；Apex 的 PyInstaller onedir 也已经实现随包分发，改启动器本身不等于减少 PyTorch 或权重 |
| 媒体 | 随包放置 `bundle/ffmpeg` 或 `bundle/ffmpeg.exe`，按该产品需要精简编译 | FFmpeg 可以同样免安装随包使用；可借鉴按需构建，不必以系统媒体替代为唯一方向 |
| 界面 | Python + PySide6/Qt；运行时工程提供 Qt 模块白名单裁剪 | 与 Apex 的 Electron + Python 不同；可作为界面迁移比较对象，节省量和迁移成本尚未测量 |

PyStand 是启动和部署层，PySide6 是界面层，二者在 Bili23 中同时使用。Windows 的定制 `Bili23.exe` 携带应用源码归档，加载旁边 `runtime/` 的 Python，并从 `site-packages/` 使用第三方依赖、从 `bundle/` 调用 FFmpeg。应用源码内嵌让外部目录更整齐，但解释器、依赖和媒体程序仍然占用磁盘；这不等于把 Python 及其依赖转换成一个很小的本机程序。

精简机制需要分开评估：Windows 使用官方嵌入式 Python；Linux/macOS 的 `trim_runtime.py` 显式删除不需要的标准库、安装工具、测试和缓存，并按白名单保留 Qt 模块及平台插件。当前 Windows 发布流程下载预制 runtime 模板，不能把该 Linux/macOS 裁剪脚本当作 Windows 发布时已经执行的步骤。FFmpeg 则通过按功能编译缩小程序。静态链接和源码归档属于组织方式，不能单独证明安装总占用下降。

PyInstaller 也可以精简，并非必然打包整个开发环境。本项目当前明确要求 `--collect-all torch/torchaudio/soundfile`、`--collect-submodules scipy`，这使依赖收集范围值得审计；应比较实际所需文件和完整功能验证结果，不预设换成 PyStand 就一定更小。

依据：

- [应用发布流程](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/.github/workflows/publish.yml)：Windows 下载 runtime 模板再构建启动器；macOS 把 runtime 复制到 `.app` 的 Resources，并从该目录运行加载器。
- [Windows 启动器](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/launcher/PyStand.cpp)：加载指定随包路径下的 Python DLL。
- [应用依赖](https://github.com/ScottSloan/Bili23-Downloader/blob/e3d6aff32fffca88b249412b92b40448321418c4/pyproject.toml)：当前 GUI 为 PySide6。源码声明版本与预构建 runtime 模板版本不应混为一谈。
- [Python-Static 运行时说明](https://github.com/ScottSloan/Python-Static/blob/main/README.md)与 [裁剪脚本](https://github.com/ScottSloan/Python-Static/blob/main/scripts/trim_runtime.py)：携带专用解释器，按应用所需模块精简标准库和 Qt；这套删除清单不能直接套用到依赖不同的 Apex。
- [定制 FFmpeg 构建](https://github.com/ScottSloan/ffmpeg-build/blob/main/build.sh)：先关闭全部可选能力，再启用所需组件。这份配置没有启用 ffprobe、H264/AAC 视频预览编码、PCM s16le/WAV 输出等 Apex 当前需要的能力，不能直接替换本项目媒体程序。

Bili23 不承担本项目的 BEATs/PyTorch 推理，不能用它的体积预测 Apex。其启动器说明中的上游 PyStand 小体积示例也不是 Bili23 当前完整发行包大小。静态链接、压缩包、单个 exe 的大小均不能代替完整安装占用测量。

## Python 运行目录裁剪（2026-10-13）

用户本轮明确要求清理不需要的头文件、开发工具、测试资料，并收紧依赖收集范围。下列审计与方案已完成；打包和推理代码尚未修改，等待 grill-with-docs 的范围确认。

### 实测基线

读取 `$HOME/Downloads/Apex Model Review.app/Contents/Resources/runtime`。按普通文件逻辑长度求和，17 个符号链接不重复计入；不是压缩下载大小，也不是文件系统分配块占用。

| 范围 | 字节数 | MiB |
| --- | ---: | ---: |
| 完整 runtime | 916,193,154 | 873.750 |
| 模型权重 `BEATs_strong_1.pt` | 364,091,999 | 347.225 |
| 冻结 service + 模型权重 | 865,969,235 | 825.853 |

最后一行仍包含 service 中的 FFmpeg/ffprobe 和相关共享库，不能标成纯 Python 库加权重。manifest 没有共享库归属表，暂不把顶层动态库武断分配给 Python 或媒体工具。包中 manifest 记录的 6 个 Python 源码、7 个桌面源码、4 个 UI 文件哈希均与当前 checkout 一致，权重哈希也与 manifest 一致；这不证明构建环境或完整依赖目录一致。

以下目录互不重叠，是待裁剪验证的候选，并非已实现节省：

| 候选目录（相对 runtime） | 字节数 | MiB |
| --- | ---: | ---: |
| `apex-model-service/_internal/torch/include` | 34,500,103 | 32.902 |
| `apex-model-service/_internal/torch/bin` | 8,372,048 | 7.984 |
| `apex-model-service/_internal/torch/share/cmake` | 271,487 | 0.259 |
| `model/PretrainedSED/hf_dataset_gen` | 41,651,845 | 39.722 |
| `model/PretrainedSED/test_files` | 6,615,339 | 6.309 |
| `model/PretrainedSED/tests` | 5,776 | 0.006 |
| `model/PretrainedSED/images` | 75,144 | 0.072 |
| **候选合计** | **91,491,742** | **87.253** |

此外，`apex-model-service/_internal/scipy` 为 41,874,272 字节（39.934 MiB），其中的内部动态库已包含在该数字中。纯 Python 模块还可能在服务可执行文件的 PYZ 中，其他共享依赖也可能继续需要；不能把这个目录大小当作确定净节省量。保留当前模型及 PyTorch 时，权重和 `torch/lib`（约 229.463 MiB）仍占主要体积。

### 收集范围与依赖证据

- `scripts/build_model_desktop.py:70–71` 使用 `--collect-all torch/torchaudio/soundfile` 和 `--collect-submodules scipy`，第 78 行整体复制 `PretrainedSED`，使开发资源和训练样例进入发行资源。
- 不能按名称批量删除 `torch/testing`、`torch/distributed`、`torch/cuda` 等目录；现包 `torch/__init__.py` 存在直接导入。CPU 基线不等于这些 Python 模块可以删除。也不能统一删除 `.py`：PyInstaller 的 Torch hook 有源码收集逻辑，需保留运行时脚本化所需源码。
- manifest 的 `packages` 枚举构建环境全部 distribution；其中列出 pip、setuptools、PyInstaller，不证明发行包携带这些工具的完整可执行依赖。
- `model_inference.py:44–50` 动态执行外部 `scripts/infer_apex_audio.py`，仅调用 `load_model`。该脚本第 21 行顶层导入 `scipy.ndimage.median_filter`，实际用在本产品不调用的独立批处理平滑函数中。现状下不能直接删除 SciPy。
- 在现有 Python 3.12 / Torch 2.8.0 / Torchaudio 2.8.0 / NumPy 1.26.4 环境，阻断 SciPy 导入，并从外部脚本取出未改写的 `load_model` 函数后，实际权重加载及 10 秒零波形前向成功：447 类，logits 形状 `[1, 447, 250]`，所有值有限，未加载 SciPy。此证据仅覆盖源环境的一次模型前向，不是录屏结果一致性或冻结包验收。
- 该前向实际加载的上游文件为 `config.py`、`data_util/audioset_classes.py`、`models/{prediction_wrapper,seq_models,transformer_wrapper}.py`、`models/beats/{BEATs,BEATs_wrapper,backbone,modules}.py`。可据此建立显式复制清单，并保留必要包初始化文件、许可证及来源信息；动态路径仍需完整行为验证。

### 待确认的实施方案

1. 在打包配置中收紧 Python 数据和模块收集，显式排除经验证不需要的头文件、构建工具及测试资源；上游模型源码改为按推理需要复制。保留许可证、模型权重和运行所需动态库，生成裁剪前后文件清单与体积报告。
2. **推荐纳入本轮，待确认**：把原模型加载函数提取为本仓库专用 loader，消除独立批处理脚本附带的 SciPy 依赖。保持原始权重、类别顺序、加载方式、前处理、CPU 推理和候选规则不变；同步更新 `model_identity.py` 的 loader 身份、预测缓存键和推理元数据，确保记录指向实际使用的代码。备选是暂不调整加载入口，仅缩小 SciPy 收集闭包。
3. 沿用既有先 Mac arm64、Windows x64 分别构建验收的边界。在本机重建冻结程序，比较真实样本的完整分数、时间网格和候选范围（沿用 `rtol=0, atol=1e-6`），验证模型冷启动/复用、选轨、预览、导出、退出和脱离开发环境后的运行。Windows 未原生运行则继续标记 `[待验证]`。历史验收脚本有固定产物/样本路径，应改为接受本轮实际路径后再使用。
4. 报告实际净节省，不预设必须压到某个整数体积。裁剪必须进入可重复构建流程，不能只修改 Downloads 中的既有应用副本。

这是可回退的构建与依赖整理，不新增架构 ADR 或产品领域词汇；现有 ADR 0002 和 CONTEXT.md 继续有效。

## 已确认约束与决策树

其他成熟项目的 FFmpeg 集成与分发方式见 [开源项目参考](ffmpeg-open-source-reference.md)。该比较用于评估随包 CLI、共享媒体库、直接库 API 等路线，不表示已经选择迁移方案。

1. **Q1 [已确认，2026-10-13]**：优先减少完整功能准备好后的安装总占用；下载体积次之。运行时内存和耗时另列指标。
2. **Q2 [已确认，2026-10-13]**：保留用户无需自行安装 Python/FFmpeg、准备好后离线处理的体验。用户举出 [Bili23-Downloader](https://github.com/ScottSloan/Bili23-Downloader)，希望研究其随软件携带 Python 的分发方式，以及 FFmpeg 是否可采用类似做法。该举例不等于已经选择替换 GUI、打包器或媒体实现。
3. **Q3 [已确认，2026-10-13]**：第一阶段保持现有识别结果和使用能力，不靠更换小模型、减少格式或取消选轨/预览/导出能力降低体积。
4. **Q4 [已确认，2026-10-13]**：允许把替换 Electron 界面框架纳入评估，以实际体积收益和迁移成本决定，不预先选定 Qt。评估许可不等于已经选择或开始实施界面迁移。

5. **Q5 [本轮用户已指定方向，加载入口调整待确认]**：先清理 Python 发行资源及收紧依赖收集。已有 Mac 应用包的运行目录已实测；是否同时提取专用 loader 以移除 SciPy，是本轮剩余取舍。用户确认推荐方案即可进入实现。

后续大改造分支：系统媒体替代、界面替换、模型运行时迁移或模型压缩。本轮不以这些路线作为裁剪前提，其收益和兼容性仍需另行评估。

确认架构选择后再记录必要 ADR；本讨论文件不替代既有 accepted 决策。
