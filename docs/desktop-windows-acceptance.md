# Windows x64：原生构建与验收交接

2026-10-07，Asia/Shanghai。对应 [Issue #18](https://github.com/jackliu1111/apex-fps-mvp/issues/18)。用户本轮选择先在 Mac 做准备；当前没有 Windows 原生模型桌面包、Windows PowerShell 5.1 运行记录或干净 Windows 目标机记录。下面的 Windows 命令是可移交的执行流程，不能计为已经执行。

本轮新增 `scripts/build_model_desktop_windows.ps1` 和 `scripts/verify_model_desktop_windows.ps1`，没有修改既有桌面代码、Mac 验收器或旧 OCR 的 `build_windows.py/bat`。构建包装器调用已有 `build_model_desktop.py` 的原生 `win-x64` 分支。验收器使用 OS PowerShell、.NET 和随包核心／媒体工具，目标机不另装 Python、Node 或 Bun；真实 GUI 与人工内容／同步复核单列。

## 已完成的 Mac 准备证据

官方 [PowerShell 7.6.6 发行](https://github.com/PowerShell/PowerShell/releases/tag/v7.6.6) 的 macOS-arm64 归档仅解压到工作区 `build/windows-validation-tools/`，未全局安装。归档 SHA-256 `6df833d094ebac1c1a74340d7b3437f4aaf5e03ce640484a1c4359f3ce8b3db1` 同时与发行页及官方 `hashes.sha256` 核对，记录为 `outputs/windows-preparation-validation/powershell-tool.json`。

公开 CLI 的九个 slice 分别经过真实 red → 最小实现 → green：非 Windows 平台拒绝、不完整包诊断、非 x64 媒体拒绝、安装资源路径逃逸拒绝、正确 PE 元数据只作检查、Mac 随包核心 stdio、坏 JSON 诊断保存、构建器拒绝跨编译、请求等待上限配置。日志为 `outputs/windows-preparation-validation/windows-01..09-{red,green}.log` 和 `windows-final.log`。PE 输入是已知头字段的文件夹具，不是可运行 Windows 包。

`-MacProtocolCheck` 使用已验证 macos27 归档的移动副本、独立中文临时数据目录，通过真正的冻结核心执行 `get_config`，保留 UTF-8 路径，模型状态仍为 `not_loaded`，正常 EOF 后核心退出码为 0。记录为 `mac-protocol-evidence.json`。没有启动 Electron、模型推理或媒体处理，也没有访问应用现有用户数据目录。该模式只证明 **Mac PS7/stdIO 机制**；正常 Windows 模式仍先检查 Windows 平台，不能借此取得 Windows 验收通过。

脚本采用 5.1 可用语法／cmdlet，未使用 `$IsWindows`、`??`、三元表达式或 PS7 的 `ProcessStartInfo.ArgumentList`；本机解析器是 PS7，不能替代 PS5.1 或 Windows/.NET 原生执行。Windows 分支的构建、DLL 加载、CIM 进程观察、签名读取、模型／媒体闭环与实际清理仍待目标机运行。

只读检查发现现有 Actions 是 Go CGO／TypeScript 工作流。历史 TypeScript [Windows job](https://github.com/jackliu1111/apex-fps-mvp/actions/runs/35318874461) 曾执行构建，但原生 portable 验证失败、上传跳过；它不包含 Python 模型桌面包。本机没有 `gh` 或已发现的 Windows VM／远程执行入口。本轮未 dispatch、推送、发布或上传私人录像／权重。

## 架构和系统版本依据

- 当前 Electron 锁定版本 40.10.6 的 [平台说明](https://github.com/electron/electron/blob/v40.10.6/README.md#platform-support) 要求 Windows 10 或更新；[Python 3.12 文档](https://docs.python.org/3.12/using/windows.html) 的基线是 Windows 8.1 或更新。取 Electron 的 Windows 10 基线，仍不足以声明整包的最低可运行版本；PyTorch／媒体 DLL 与具体 Windows build 必须真实加载验证。
- 使用 64 位 OS PowerShell 5.1 和 Windows x64。包装器读取 [Win32_Processor.Architecture](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-processor)：9 为 x64，12 为 ARM64；不把 Windows ARM64 上的 x64 进程模拟写成此次原生 x64 目标。
- `-InspectOnly` 检查应用和推理／媒体目录的 PE 头。依据 [Microsoft PE 格式](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format)，机器类型须为 `0x8664`，可选头须为 PE32+ `0x020b`。这只是静态身份，不能证明 DLL 导入成功、系统 API 可用或最低 OS 可运行；安装器／卸载器的架构也不被误当成推理运行时架构。
- Mac 当前模型环境使用 Python 3.12、torch／torchaudio 2.8.0。Windows 构建环境应使用对应的原生 x64 依赖；[官方旧版本安装页](https://pytorch.org/get-started/previous-versions/#v280) 提供 Linux／Windows 的 2.8.0 CPU wheels。不能复制 Mac 虚拟环境或用 Bun 交叉产物替代 Python/PyTorch 原生包。

## 在 Windows 构建机执行

构建机可以拥有 Python 3.12 x64、Node/npm 和联网安装能力；这些不是目标普通用户的运行依赖。准备同一模型工作区、原始权重、实际 Windows `ffmpeg.exe`／`ffprobe.exe`，以及所用媒体发行包的许可证／源码／构建来源材料。在原生环境核对 torch、torchaudio、NumPy、SciPy、soundfile 和 PyInstaller；先运行 `npm ci --prefix desktop`。保持 CPU wheels 的 torch／torchaudio 版本配对，完整冻结推理仍须实际复验。

```powershell
.\scripts\build_model_desktop_windows.ps1 `
  -PythonExecutable 'C:\构建环境\Scripts\python.exe' `
  -ModelWorkspace 'C:\模型\apex-voice-detect' `
  -FFmpeg 'C:\媒体工具\bin\ffmpeg.exe' `
  -FFprobe 'C:\媒体工具\bin\ffprobe.exe' `
  -MediaLicenseDirectory 'C:\媒体工具\发行来源' `
  -OutputDirectory 'C:\验收记录\native-build'
```

可用 `-Checkpoint` 指定权重；`-StageOnly` 只冻结资源，不能计为安装包完成。包装器拒绝非 Windows／非 x64／32 位 PowerShell；把子 Python 的 UTF-8 模式打开，保存 `build.log`、构建器 SHA 和实际 manifest。完整构建沿用 NSIS／portable 配置，产物在 `dist/model-desktop/`。记录具体文件 SHA、构建环境、签名及安装行为；`native_windows_build: true` 也不代表普通用户／干净机器验收完成。

## 在普通用户目标机执行

先在目标机按实际安装器交互安装或解压完整包，记录是否要求提权、签名／系统提示和安装位置。保持验收终端不提权。将证据目录放在可写用户目录；实际产品仍把自己的运行数据写到用户目录。断网必须由目标机实际状态与操作者记录证明，隐藏 PATH 只能证明工具定位的一部分。

使用 OS 自带 64 位 Windows PowerShell 5.1。下面示例从已有 PowerShell 窗口调用；一份录像对应一个明确的容器音轨索引，索引 1 仅为示例，须先由操作者确认游戏音轨。多份使用 `-Source @('路径1','路径2') -AudioStream @(1,2)`，两数组一一对应。

```powershell
.\scripts\verify_model_desktop_windows.ps1 `
  -PackageDirectory 'C:\用户软件\Apex Model Review' `
  -Source 'D:\用户录像\真实游戏录像.mkv' -AudioStream 1 `
  -OutputDirectory 'C:\验收记录\普通用户 闭环' `
  -RequestTimeoutSeconds 600 -TaskTimeoutSeconds 3600
```

默认入口只在 Windows x64／非提权会话执行。它先检查资源相对安装目录、完整性和 PE 架构，核对权重 SHA、记录媒体版本和签名，然后从绝对安装路径启动随包核心；子进程 PATH 只保留 System32。数据写独立的 `core-data`，不覆盖 GUI 原有用户数据。提交批量、再提交暖任务；保存逐份真实引擎与阶段耗时，重算验证原预测不变，全选所有候选，预览首段并分别导出所有候选。通过 `get_artifact` 取得注册产物，再分别媒体探测与全量音视频解码；无候选时保留真实空结果与覆盖限制。

输出包含 `operations.ndjson`、各阶段 JSON、核心 stderr、工具版本及逐文件 probe／decode 日志、注册产物 metadata 和待人工复核清单。正常 EOF 后等待核心退出，并按先前记录的 PID／创建时间检查后代是否仍存活；失败诊断及已经完成的媒体保留。请求和任务等待上限可调，不是发行等待时间承诺。没有 `-Source` 时只检查静态包及核心配置，状态为 `native_core_probe_passed`，不能计为真实录像闭环。

`-InspectOnly` 可单独运行静态文件检查；输出 `status: inspected`、`native_execution: not_run`、`native_windows_acceptance: false`。实际 Windows 分支的自动通过状态为 `native_core_workflow_passed`，范围仍只限核心／媒体。所有模式保持 `native_windows_acceptance: false`、人工复核 required、clean-machine not_evaluated；Issue #18 的完成必须另有下面的真实 GUI／目标机记录。

## GUI 与人工记录

在同一实际安装包上双击应用，保存包 SHA、OS build／CPU／内存、普通账号和安装路径。记录人名、时间及证据路径，逐项执行：

1. 普通用户断网、中文／空格来源和输出路径；移到另一安装位置后重新启动。重复启动只有一个实际窗口／核心。
2. 明确选定实际游戏音轨，批量与后续任务；界面状态、逐份结果及任务日志可见。首尾／持续交火与 5/5/5 候选范围按素材实际内容检查。
3. 修改每段范围，播放预览及独立成片；全部选中得到各自文件，保留请求／实测边界、原录像时间映射及感知音画同步记录。自动解码成功不替代这些观察。
4. 分析／预览／导出期间取消、正常退出及异常入口／核心退出；记录公开任务错误与中断说明、已完成文件保留、半成品清理和退出 PID。再次启动后能发现已有结果并提交新任务。
5. 对最低 OS build、安装／签名行为、等待时间和资源预算记录实际结果或明确待评估项。目标机无开发环境不是本机 PATH 限制的推论。

此清单当前全部是目标机待执行项。Mac PS7、源码审查、PE 头夹具、历史 Windows TypeScript job 和本机 Mac 成片均不能关闭 #18，也不代替 #16 的真实 1080p／多轨／不同原点与人工验收。
