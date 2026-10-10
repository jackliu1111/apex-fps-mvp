# Electron 桌面模型入口

桌面源码位于 `desktop/`，与 Python Web 共用 `model_web_ui/`、共享 Python 任务核心和结果契约。桌面业务通过有限 preload → Electron 主进程 → 常驻 Python NDJSON 进程执行，不启动 HTTP 服务，不依赖 Bun。

React 管理桌面宿主的加载和错误展示，并挂载共享页面。共享页面的复核业务仍使用现有 DOM 脚本；这不是完整的 React 组件迁移。算法、候选分组、版本和媒体操作只存在于 Python 核心。

## 开发启动

```sh
npm ci --prefix desktop
node desktop/node_modules/electron/install.js
APEX_PYTHON=/path/to/inference-python \
APEX_MODEL_WORKSPACE=/path/to/apex-voice-detect \
APEX_FFMPEG=/path/to/ffmpeg APEX_FFPROBE=/path/to/ffprobe \
npm --prefix desktop start
```

开发模式显式读取 `APEX_PYTHON`、`APEX_MODEL_WORKSPACE`、`APEX_CHECKPOINT`、`APEX_FFMPEG`、`APEX_FFPROBE`。打包模式通过安装目录的 `runtime/manifest.json` 定位资源；运行数据写入 Electron 用户数据目录下 `model-data/`，与 Web 默认数据目录独立。

窗口使用 `contextIsolation`、sandbox 和禁用 Node 集成。preload 仅提供有限 `request(operation, payload)`（plain 结果/错误封套）、兼容的 `execute(operation, payload)`、受控 `artifactUrl(id)`、本机文件选择和已登记文件的目录显示。主进程检查调用窗口及操作白名单；任意文件路径不能作为媒体协议地址。`apex://ui/` 只提供白名单静态资源，`apex://artifact/<id>` 每次向核心验证登记产物及当前候选/范围，支持 GET、HEAD 和单个字节范围请求。

NDJSON 使用 UTF-8；消息包含请求标识，日志写 stderr/用户日志文件。Node 对完整请求封套限制 64 KiB，Python 保持对应请求边界。共享 renderer 使用 plain 错误封套在自身上下文重建 `code/status`，避免 contextBridge 丢失 Error 自定义属性。启动超时、Python 异常退出和待处理请求的失败会报告 `worker_unavailable`。单实例锁让重复启动唤起已有窗口。正常退出关闭 stdin、等待核心清理，超时后终止进程；核心 guardian 在父进程消失时清理媒体/模型进程组。Windows 源码路径已实现，但未用真实 Windows 机器验收。

## 原生资源与本机包

在对应平台的推理 Python 环境中安装 PyInstaller；已有环境不能修改时，可使用项目内的 `pip --target build/desktop-build-deps` 和 `PYTHONPATH`。分别在 Mac arm64 与 Windows x64 构建，不交叉编译 Python 原生依赖。

```sh
python scripts/build_model_desktop.py \
  --model-workspace /path/to/apex-voice-detect \
  --ffmpeg /path/to/native/ffmpeg --ffprobe /path/to/native/ffprobe \
  --media-license-dir /path/to/media-license-source-and-build-provenance
```

`--stage-only` 只生成运行资源。脚本用 PyInstaller onedir 收集 Python、PyTorch、音频依赖与媒体二进制的动态依赖，再保存权重、上游模型代码、类别配置、版本及源代码 SHA-256。Python 运行目录放在 Electron `extraResources` 中，保留真实文件执行、动态库、符号链接与权限；资源不塞入 JavaScript asar。

当前本机验证包为 `dist/model-desktop-adhoc/mac-arm64/Apex Model Review.app`，使用完整本地ad-hoc资源签名；没有Developer ID或公证，Gatekeeper评估仍拒绝，不能称为正式发行包。此前未签名原型保留在 `dist/model-desktop/`。本机包包含Homebrew媒体工具及动态依赖，记录版本、路径、SHA-256和formula；尚未确认对外分发所需许可/源码材料。当前包声明最低 macOS **27.0**：旧包的公开 `Info.plist` 声明13.0，但248个实际 Mach-O 的 macOS load-command 最高下限为27.0，构成真实验收失败。`desktop/build-native.cjs` 在打包时扫描 staged 原生资源及 Electron，仅取 macOS 的 minimum（不取 SDK/iOS），与基线13.0取最大值，设置最终 plist。重新打包后的公开边界检查为27.0/27.0，见 [RED](../outputs/desktop-archive-audit/minimum-os-red.json) 与 [GREEN](../outputs/desktop-archive-audit/minimum-os-green.json)。这只保证声明不低于静态依赖要求，不承诺13.0可运行，也不替代最低版本真机验收。

最终本机 `.app` 已由公开 DOM/preload 运行真实模型闭环、双轨批量/模型复用、重复启动和主进程异常退出清理；临时回环 CDP 端口仅用于测试，不是业务 HTTP 服务。具体结果与当前源码/包 SHA 见验证记录。直接 core 崩溃的 main 存活/子进程清理/重启已实测；core崩溃后原生同步通知导致的renderer IPC挂起已修复，真实接口在5秒上界内返回worker_unavailable；原生通知的可见内容与人工确认仍未验收。

## 当前本机ad-hoc ZIP验证包与完整移动目录闭环

[Apex-Model-Review-0.1.0-mac-arm64-macos27-adhoc-local.zip](../dist/model-desktop/Apex-Model-Review-0.1.0-mac-arm64-macos27-adhoc-local.zip) 为634,257,382字节，完整SHA-256：

```text
4caaf868f3638c3cf7403794b6b9927eb464f536268defefb706d5fdf5e14886
```

旧原型的 `codesign --verify --deep --strict` 先因资源seal缺失失败（[公开RED](../outputs/desktop-signing-validation/codesign-red.json)），这与没有开发者信任的ad-hoc包不同。最小修复是 `desktop/package.json` 的 `mac.identity="-"`、`hardenedRuntime=false`，由electron-builder完整签名，无用户证书私钥、未公证或发布。新 `.app` 的相同公共检查通过（[GREEN](../outputs/desktop-signing-validation/codesign-green.json)），`spctl`仍拒绝且如实保留；未删除quarantine或修改系统保护来取得通过。

[新归档记录](../outputs/desktop-archive-adhoc/archive-fidelity.json) 核对13,631条目、12,488普通文件、31符号链接、248可执行文件，SHA/目标/全部模式无差异。解包位置为 `/private/tmp/apex-adhoc-20261007/中文 移动安装目录`，[静态minimum](../outputs/desktop-signing-validation/minimum-os-green.json) 仍为27.0/27.0，[核心/UI/运行文件hash](../outputs/desktop-archive-adhoc/package-hashes.json) 均与当前源码相等。可重复归档命令：

```sh
/usr/bin/ditto -c -k --sequesterRsrc --keepParent \
  'dist/model-desktop-adhoc/mac-arm64/Apex Model Review.app' \
  'dist/model-desktop/Apex-Model-Review-0.1.0-mac-arm64-macos27-adhoc-local.zip'
/usr/bin/ditto -x -k \
  'dist/model-desktop/Apex-Model-Review-0.1.0-mac-arm64-macos27-adhoc-local.zip' \
  '/private/tmp/apex-adhoc-20261007/中文 移动安装目录'
```

[完整Electron移动目录记录](../outputs/desktop-relocated-host-validation/2026-10-07-adhoc/relocated-electron-closure.json) 使用普通UID501/jackliu，正式用户数据目录，HOME不改，PATH隐藏开发工具、移除开发运行变量。只对自己的解包安装副本去掉写权限，保留执行位。实际DOM/preload以默认0.2和5/5/5秒分析20秒540p真实样本，全部1个默认候选选中，预览/独立copy导出播放，两份媒体完整解码；重复启动退出0且core不变。真实 `window.close()` 正常退出0，19个实际观察PID全部消失（24毫秒），没有强制结束。13,631安装条目前后不变，完整资源seal在流程前后均通过，没有模型缓存或 `__pycache__` 写入安装包。总流程55.186秒，工具会话44929权威退出0；常规主机网络环境，不能称为断网或干净Mac验收。

完整Electron的外层 `sandbox-exec` 试验未通过：本机Unix单实例socket受限，允许该IPC后Chromium自己的Seatbelt仍初始化失败，GPU最终fatal。实际PID49791对应用户提供的11:24:35崩溃报告，[失败/清理记录](../outputs/desktop-offline-host-validation/2026-10-07/offline-electron-closure.json) 保留，全部观察进程已退出；不加 `--no-sandbox`，已停止该隔离方案。早先pipe的Target响应只证明调试传输，不能当作完整界面禁网成功。

另一台Mac的完整离线/安装/人工验收使用 [移交清单](desktop-mac-acceptance.md) 和 [系统命令证据脚本](../scripts/verify_model_desktop_mac_handoff.sh)。目标不需要Node、Python或Bun；工具不改网络/系统信任，不删除quarantine。清单明确记录目标机来源、真实离线、全部独立输出/完整解码、人工同步/切点和正常退出的实际PID。此工具准备完成不等于目标机已验收。

## 历史未签名 ZIP 验证包

此前未签名验证物为 [Apex-Model-Review-0.1.0-mac-arm64-macos27-local.zip](../dist/model-desktop/Apex-Model-Review-0.1.0-mac-arm64-macos27-local.zip)，大小 **634,497,603 字节**。完整 SHA-256：

```text
70846348cc939521da52234e55120104b55a3a1fbb27633434916a94ac796aab
```

使用 macOS 原生 `ditto` 生成和解包，命令可重复：

```sh
/usr/bin/ditto -c -k --sequesterRsrc --keepParent \
  'dist/model-desktop/mac-arm64/Apex Model Review.app' \
  'dist/model-desktop/Apex-Model-Review-0.1.0-mac-arm64-macos27-local.zip'
mkdir -p '/private/tmp/apex-macos27-w92j4zv2/中文 移动安装目录'
/usr/bin/ditto -x -k \
  'dist/model-desktop/Apex-Model-Review-0.1.0-mac-arm64-macos27-local.zip' \
  '/private/tmp/apex-macos27-w92j4zv2/中文 移动安装目录'
```

[该原型归档逐项记录](../outputs/desktop-archive-macos27/archive-fidelity.json) 比较原 `.app` 与中文、空格移动目录解包结果的全部 **13,611** 条目：12,478 个普通文件逐个 SHA-256、31 个符号链接目标、248 个可执行文件及所有 POSIX 模式均一致，没有差异。核对脚本为 `scripts/verify_model_desktop_archive.py`。最低版本打包修复没有改变核心、UI或主进程行为；[该原型 hash](../outputs/desktop-archive-macos27/package-hashes.json) 中六个 Python 模块、四个共享静态文件及七个桌面运行文件均与当前源码相等。

旧的13.0原型 ZIP `Apex-Model-Review-0.1.0-mac-arm64-local.zip`（SHA-256 `1c93d1fb61437b71cfeb4347a9bec7498780853f4729cb0859f0ce46c7256515`）及其 [13,610条目归档记录](../outputs/desktop-archive-audit/archive-fidelity.json) 保留为历史证据；下面的移动目录核心禁网记录针对该旧包，不作为新包重复验收。

[移动目录离线核心闭环](../outputs/desktop-archive-audit/relocated-offline-closure.json) 使用实际 **UID 501 / jackliu**，账号从系统 UID 查询而非环境 `USER` 推定，`PATH=/nonexistent`。随包 Python、模型、媒体工具从 `/private/tmp/apex-archive-k6yvahsh/中文 移动安装目录/Apex Model Review.app` 定位；真实20秒960×540样本完成 BEATs 分析、1个预览、1个独立快速复制导出，两份媒体全量音视频解码。这里通过CLI显式把数据目录覆盖到临时的 `用户数据 离线核对`，不作为正式 `.app` 用户目录写入证据；正式用户目录此前实际main审计另行记录。

仅这个 Python IPC core 及其子进程使用原生 profile `(version 1)(allow default)(deny network*)`。同一可用回环端点的正常控制探针成功，套用 profile 的探针失败，随后真实模型/媒体核心闭环成功。没有改全机网络或全局配置；此证据不等于完整 Electron 断网验收，更不等于无开发环境的干净 Mac。包仍未签名、未发布，最低版本真机运行、安装信任、许可/源码分发条件和人工复核未验收。

## 提供的真实4K录像：本机有限界面闭环

2026-10-07，签名修复前的最低版本27.0 `.app` 通过 [专用原生界面脚本](../scripts/verify_model_desktop_recording.cjs) 直接读取 `/Users/jackliu/Downloads/2026-09-11 20-32-49.mkv`，不复制16.8GB源文件，明确选择音轨 #1。素材为3840×2160 H264、1293.949秒，BEATs Strong 以默认阈值0.2及5/5/5秒完成32,348帧、34个候选。通过真实 DOM/preload 复核首个候选，保存165–173秒范围，预览播放并快速复制为独立成片，再播放和完整解码两份媒体。复制实际范围为163.1–173.033秒，界面保留请求/实际范围区分。新ad-hoc包没有重复该重任务；核心/UI/模型头未变，另以20秒全部默认候选复验签名后的闭环。

[完整记录](../outputs/native-recording-validation/2026-10-07_4k_macos27/report.json) 保留原始完整结果、模型/硬件与各阶段耗时；本机 Apple M6、12逻辑核、16GiB，流程217.899秒，只复核导出一个候选。核心数据实际写入正式 `.app` 用户目录的 `model-data`，与前述CLI临时数据覆盖分开记录。[退出记录](../outputs/native-recording-validation/2026-10-07_4k_macos27/process-cleanup.json) 保存工具会话71193的权威退出码0、原脚本在等待退出后输出的PASS，以及已知模型PID82442消失和独立只读进程扫描无匹配。原脚本未持久化完整 controller/tracked PID列表，该列表明确未记录，没有把事后空列表伪作原始完整观测。

[原始产物对照](../outputs/native-recording-validation/2026-10-07_4k_macos27/source-native-artifact-parity.json) 独立读取源码 HTTP 与打包界面的公开 `scores_path`：32,348×447概率最大差0，类别、时间网格、窗口计数、默认参数及34个自动候选相等（`rtol=0, atol=1e-6`）。这是产物级读取，不宣称 renderer 再次分页读取，也不评价人工同步或误报/漏报质量。

当前主机为 Darwin arm64，在 `dist/model-desktop/` 未发现 Windows 原生桌面安装包，也没有可用 Windows x64 目标机器证据；现有 Windows 原生构建路径和NSIS/portable配置可审查，没有用Mac或Bun交叉产物代替。提供的4K素材已有本机有限闭环证据；独立1080p素材、人工音画/切点、干净Mac/Windows与发行条件仍需对应证据。

构建成功不等于发行验收。Windows 包、干净 Mac/Windows 的完整宿主断网/移动安装、最低版本真机运行和人工切点/同步复核仍按 [验证记录](desktop-validation.md) 的实际证据区分。
