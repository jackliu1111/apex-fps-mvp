# 桌面与双入口验证记录

更新日期：2026-10-07，Asia/Shanghai。环境：本机 macOS 27.0.1 arm64；Electron 40.10.6、electron-builder 26.15.3、PyInstaller 6.22.3、模型环境 Python 3.12.14。此记录不声明 Windows 或无开发环境机器已验收。

## 已运行的公共边界检查

| 检查 | 实际证据与范围 |
|---|---|
| Python NDJSON | `tests/test_model_ipc.py`：请求关联、常驻会话、畸形/未知操作及错误、独立启动、UTF-8 中文路径、guardian 退出码、非 UTF-8 locale 下中文 engine 错误保留；6 项通过 |
| Node IPC/资源协议 | `node --test desktop/test/*.test.cjs`：Python 常驻请求、崩溃可见、父进程参数、启动超时、超大消息即时失败且后续请求可用、真实预览 Range/stale 校验、外部协议拒绝；7 项通过 |
| 同场景 HTTP/IPC | `tests/test_model_dual_contract.py`：两入口执行相同媒体/可控模型夹具的批量分析、复用记录、分数、重算、旧版本拒绝、修改选择、预览、独立复制及实际范围、完整音视频解码、分析取消后新任务、未知标识、无候选/空选择、非法范围/未知候选/源变更、80 秒长交火与留白重叠；9 项通过 |
| 真实 Electron 隔离窗口 | `desktop/test/electron-smoke.cjs`：真实 Electron 的 sandbox preload、React 宿主/共享页面、Python IPC、静态资源白名单；已通过，GUI启动需要本机权限 |
| 原生冻结运行目录 | `desktop/test/frozen-smoke.cjs`：使用随包 Python、模型权重/上游代码、媒体工具完成真实 BEATs 分析、1 个预览与全部选中独立复制输出的音视频完整解码；已通过本机 20 秒样本 |
| 打包 preload/资源 | `APEX_PACKAGED_APP=... electron desktop/test/electron-smoke.cjs` 从最终 `.app` 的 asar 读取共享 UI/preload，调用随包 Python；`request` 可用，`task_not_found` / 404 跨隔离上下文保留；已通过 |
| 本机 `.app` | electron-builder 已生成未签名 Mac arm64 `.app`，约 1.2 GiB；最终真实主进程已通过公开 DOM/preload 的真实模型闭环、双启动、异常退出和清理审计。CDP仅作本机测试仪器；未声明人工同步或干净机器验收 |

双入口用同一控制预测；其精确分数相等用于检查传输语义，不能当成真实模型识别质量。上述 9 个共同场景还包含精确5秒合组、预览/导出取消、第二段导出失败与已完成文件保留、两入口真实进程异常退出后恢复。公共媒体选择/分页与故障矩阵仍同时参考既有 HTTP、核心与 IPC 测试；不把共同场景数量当作逐条 T01–T15 或平台验收的自动证明。

## 共享页面的真实 renderer 验证

[公开界面操作脚本](../scripts/verify_model_review_ui.cjs) 用真实 Electron 的隔离 preload 与核心 IPC 验证批量结果恢复、任务记录丢失后恢复操作、导出文件真实播放、任务/结果源录像标识。原四个行为及本轮新上下文恢复、候选/请求时长、失败媒体原文日志，均按实际 renderer 的失败 → 最小修复 → 通过运行，不能用内部 helper 的通过替代 UI。

保留四份截图：[恢复第二份结果](../outputs/issue-service-validation/ui-restore-result.png)、[任务丢失后恢复](../outputs/issue-service-validation/ui-missing-task.png)、[导出文件播放](../outputs/issue-service-validation/ui-export-playback.png)、[录像与结果标识](../outputs/issue-service-validation/ui-result-source.png)。这些是控制预测/媒体夹具的自动化截图，未评价真实枪声识别质量、人工音画同步或完整干净平台体验。

当前完整ad-hoc签名 `.app` 的源码/asar SHA 检查记录为 [package-hashes.json](../outputs/desktop-archive-adhoc/package-hashes.json)，六个 Python 模块、四个共享静态文件和七个桌面运行文件全部与当前源码相等。最低版本与签名修复只修改打包配置，核心、UI与主进程行为沿用既有实测头；签名后的完整移动目录闭环见下文。

## 实际打包主进程审计

[scripts/verify_model_desktop_main.cjs](../scripts/verify_model_desktop_main.cjs) 直接启动 `.app/Contents/MacOS/Apex Model Review`，通过临时仅回环 CDP 测试端口操作真正窗口的公开 DOM 和有限 preload。业务调用仍走主进程 IPC/常驻 Python；测试端口不是产品 HTTP 服务。`PATH=/nonexistent` 隐藏开发工具，模型、媒体二进制从安装资源定位。

本轮先验证了真实 BEATs 的探测/明确音轨确认、候选重算、范围保存、预览播放、独立复制导出播放和随包媒体工具的完整音视频解码。第二次启动以 0 退出，第一主进程的 core PID 不变。模型推理和 FFmpeg 预览中分别强制终止实际主进程，登记 core/guardian/target PID，清理后再检查所有 PID 均不存在；未完成预览文件删除、完成结果保留。240 秒重复源片段只用于生命周期夹具，不作为代表性长录像。

实际进程证据在 `outputs/desktop-main-audit/audit.json`。这一审计发现前态错误：主进程意外死亡被归为 `cancelled/task_cancelled`。其记录保存在 `audit-before-interruption-fix.json`，不能当作异常终态语义通过。后端修复后已重打最终包：实际模型和媒体作业中主进程 SIGKILL 均得到 `failed/service_interrupted`；PID 全部消失、媒体半成品删除、完成结果保留，并能重新启动。正常退出仍沿用用户取消语义。

同一最终包还通过 [真实多音轨批量脚本](../scripts/verify_model_desktop_batch.cjs)：两份包含两条音轨的真实源片段衍生文件，都先展示未勾选的音轨，用户明确确认 #1 后才可分析；实际同一引擎的推理指数为 1、2，复用标记 false、true。第二份源是请求12秒快速复制夹具，随包 ffprobe 独立测得实际视频时长 12.066667 秒，界面使用实际时长。阈值1重算后候选/选择为空、完整预测引用保留、导出按钮禁用，公开IPC导出返回 `empty_selection`。这是后处理和UI场景，不是无枪声质量评估。

最终记录与真实 `.app` 截图：[审计 JSON](../outputs/desktop-main-audit/audit.json)、[批量审计](../outputs/desktop-main-audit/batch-audit.json)、[预览](../outputs/desktop-main-audit/packaged-real-preview.png)、[成片播放](../outputs/desktop-main-audit/packaged-real-export.png)、[无候选](../outputs/desktop-main-audit/packaged-real-multitrack-empty.png)。本轮未再跑旧500×447分数一致性，因为模型适配/权重未变化；故障状态与UI新头已单独实测。

[Core-only 崩溃脚本](../scripts/verify_model_desktop_core_crash.cjs) 在真实推理 target 启动后只终止 Python core：Electron main 存活，core/guardian/target PID 全部退出，重启把遗留任务标记 `failed/service_interrupted`。旧包的实际 renderer 请求先在5秒上界内超时（RED）；主进程同步 `showErrorBox` 改为不等待的异步 `showMessageBox` 后，重新打包，同一真实条件下 renderer 在5秒上界内收到 plain `worker_unavailable` / 503（GREEN）。此前观察不是可以转交人工确认的API挂起，现已修复。脚本没有观测原生弹框或人工确认；提示内容、modal交互和人工确认仍单列人工 gate。记录见 [core-crash-audit.json](../outputs/desktop-main-audit/core-crash-audit.json)、[RED](../outputs/desktop-main-audit/core-crash-response-red.log)、[GREEN](../outputs/desktop-main-audit/core-crash-response-green.log)。

## TDD 证据

测试使用已确认的逻辑操作/HTTP/IPC seam，真实核心与实际媒体；仅模型、媒体阻塞/失败等系统进程边界使用受控夹具。

- 常驻请求先因 `model_ipc` 缺失失败，增加最小 NDJSON 适配后通过。
- 畸形消息先以 `JSONDecodeError` 中断会话，增加逐请求错误封套后通过。
- 独立中文路径测试先因缺少 main 入口失败，增加启动配置后通过；随后以 `PYTHONIOENCODING=ascii` 与原始 UTF-8 中文请求再现失败，显式 UTF-8 stdio 后通过。
- 桌面请求先因 client 模块缺失失败；Python 崩溃与启动无 ready 两个场景先发生挂起，增加错误收敛和启动超时后通过。
- 超大完整 NDJSON 封套先出现 `hung`，client 写入前校验完整封套后得到 `request_too_large`，下一请求可用。
- 协议外部 scheme 先返回 200、与预期 404 不符，增加 scheme/credentials 校验后通过。
- 真实隔离 renderer 中的任务丢失恢复先因 contextBridge 丢失 Error 自定义 `code` 失败；有限 preload 增加 plain `request` 封套，由 renderer 重建错误后通过。
- 公开 IPC 连接受控外部模型进程，在 `LC_ALL=C/PYTHONUTF8=0` 且协议 stdout UTF-8 的条件下，中文模型错误先被 ASCII decoder 错误替换；worker `Popen` 显式 `encoding=utf-8` 后原错误保留。
- 本机实际主进程 SIGKILL 的前态记录虽已清理进程/文件，却错误记为用户取消；公开 IPC 父进程场景 red 后，核心关闭增加中断原因，最终原生包的推理/媒体两条路径均通过 `failed/service_interrupted` 断言。
- 只杀真实core而main存活时，原生同步错误通知先阻塞Node循环，公开renderer IPC超过5秒无回应（RED）；改异步通知后同一最终包条件返回 `worker_unavailable`（GREEN）。没有用dialog mock或内部调用计数代替真实观察。
- guardian launcher 执行退出码 7 的外部进程先错误返回 0，`raise SystemExit(main())` 后正确返回 7。最终冻结包已实测该退出码；FFmpeg 受控失败后预览/导出均返回 `media_failed` 并删除半成品，记录见 `frozen-failure.json`。
- 公开 `.app/Contents/Info.plist` 原声明13.0，实际248个 Mach-O 的最高 macOS minimum 为27.0，静态验收先失败（[RED](../outputs/desktop-archive-audit/minimum-os-red.json)）。`desktop/build-native.cjs` 在 beforePack 扫描 staged 原生资源与 Electron、排除 SDK/iOS字段，并设置最高minimum与13.0基线的最大值。重新打包后独立公共边界检查为声明27.0/最高原生要求27.0（[GREEN](../outputs/desktop-archive-audit/minimum-os-green.json)）。未用内部helper mock代替包检查，也不据静态扫描宣称最低版本机器已运行。
- 当前本机原型的公开 `codesign --verify --deep --strict` 先因资源seal缺失失败（[RED](../outputs/desktop-signing-validation/codesign-red.json)）。最小配置 `mac.identity="-"`、`hardenedRuntime=false` 让electron-builder完整ad-hoc签名，实际新包相同检查通过（[GREEN](../outputs/desktop-signing-validation/codesign-green.json)）。随后只读安装副本完成真实模型/预览/全部独立成片闭环后资源seal仍通过、全部安装条目未变；没有模拟codesign helper，也没有把 `spctl` 的开发者信任拒绝改写成通过。

资源 Range 和双入口完整流程是已有行为的集成回归检查，不伪称每项都在适配层出现过新功能 red。

## 真实样本与包证据

此前素材 `/Users/jackliu/payload/sample-apex.mp4`，时长 20 秒、960×540。该样本不是 1080p/4K 长录像，也没有独立误报/漏报标签；本次新增真实4K证据见下节。冻结目录的历史记录在 `build/model-desktop/mac-arm64/frozen-real-smoke/`：任务、结果、预览、逐文件导出和解码产物。权重 SHA-256 为 `db13a79ae90a0cfd0f9911a6a1d8cdb89324322bee642dcfe32de022123b8b54`；模型 BEATs Strong，CPU 4 threads。测得一次冻结流程抽音频约 0.51 秒、模型加载约 8.21 秒、推理约 0.36 秒、后处理约 0.06 秒；数据只描述本机该次样本，不推广到其他机器或录像。

最终构建脚本记录六个核心 Python 模块 SHA-256，已核对当前源码与最终打包 manifest 全部相等。本轮 `model_service.py` 为 `9f3c0a4c472c437da449d0b0d9a0e4b6e0c51a9a415aed7cbc9959dacc884070`，`model_review.py` 为 `b919cad6d52c7930eeb4b86aa57add6afac75b32bb005aedca54eb2a436279f2`，`model_ipc.py` 为 `e20763a06630437dd4c8ed92b42d47f23081f5ad02353d0aca11c97c8f442807`；其余模块和所有静态/宿主文件见 hash 记录。

同一真实20秒样本还通过源码 HTTP 与最终冻结 IPC 的公开 `read_scores` 比对：500 帧、447 类，类别与时间网格相等，概率最大差值为 0.0，容差明确为 `rtol=0, atol=1e-6`；候选范围一致。记录在 `source-http-frozen-ipc-parity.json`，不是识别质量证据。运行资源约 905 MiB（本机原型），媒体二进制依赖经 PyInstaller 改为包内 `@rpath`；未用干净机器验证全部库，也未宣称 Homebrew 工具许可材料已满足公开分发。

真实验证脚本支持 `APEX_SAMPLE`、`APEX_SAMPLE_AUDIO_STREAM` 和 `APEX_VALIDATION_DIR`。多音轨素材必须明确选择音轨，不能默认第一轨为游戏声音。真实4K的本机有限界面闭环、全部选片双入口验证、人工预览同步与切点、独立1080p素材及平台退出证据分别记录，不能相互代替。

Issue #17/#18 的干净平台验收保持未完成。Windows x64 尚无机器/原生包证据；Mac 的本机开发环境检查不替代干净机器上的完整宿主断网、移动安装及人工闭环。签名、公证与最低版本真机运行仍待验收；本机移动目录／核心禁网证据见下文。

## 提供的真实4K：当前打包应用的有限界面验收

[专用脚本](../scripts/verify_model_desktop_recording.cjs) 使用显式 `APEX_SAMPLE=/Users/jackliu/Downloads/2026-09-11 20-32-49.mkv` 与 `APEX_SAMPLE_AUDIO_STREAM=1`，从签名修复前的实际最低版本27.0 `.app` 的 DOM/preload 运行。直接读取16,823,282,156字节源文件，不复制源录像；随包媒体工具探测为3840×2160 H264、1293.949秒，音轨 #1 AAC48k stereo。测试数据实际写入正式 Electron 用户目录 `/Users/jackliu/Library/Application Support/apex-model-desktop/model-data`；验收导出/报告写入独立 `outputs/native-recording-validation/2026-10-07_4k_macos27`，与旧移动目录的CLI临时数据覆盖分开。新ad-hoc包没有重复此重任务；核心/UI/模型头未变，签名后另以20秒真实样本全部默认候选复验。

硬件为 Apple M6、12逻辑核、16GiB，UID501/jackliu。BEATs Strong 以默认阈值0.2、合并/前后留白5/5/5秒完成32,348帧和34个候选；抽音频5.504秒、模型加载1.607秒、推理33.248秒、后处理8.530秒。原自动首候选165–179.88秒；界面仅选该候选并保存165–173秒，执行预览/播放、快速复制独立成片/播放。导出记录实际范围163.1–173.033秒，预览与成片均由随包FFmpeg完整音视频解码，两个退出码为0。总流程217.899秒，仅复核/导出一个候选；完整原始结果、参数、硬件、资源与阶段记录见 [report.json](../outputs/native-recording-validation/2026-10-07_4k_macos27/report.json)，截图见 [预览](../outputs/native-recording-validation/2026-10-07_4k_macos27/real-recording-preview.png) 与 [独立成片播放](../outputs/native-recording-validation/2026-10-07_4k_macos27/real-recording-export.png)。

工具会话71193权威退出码为0，原脚本实际执行 `await stop(host)`、`await awaitGone(tracked)` 后才输出最终PASS。其局部 controller/完整tracked PID数组未持久化，因此明确未记录；后补空列表不作为原始完整PID观测。[process-cleanup.json](../outputs/native-recording-validation/2026-10-07_4k_macos27/process-cleanup.json) 补充实际公开结果里的模型PID82442已消失，独立只读扫描本次 `.app` executable/runtime 前缀及专用controller无匹配，已知PID的 `awaitGone` 返回18毫秒、remaining为空。报告中的提前passed字段单独不足以证明退出，退出结论依据上述权威终态、原脚本PASS顺序和独立清理检查。

根代理在两份公开 `prediction.scores_path` 产物上进行独立读取，未再运行模型/媒体或renderer分页请求。[source-native-artifact-parity.json](../outputs/native-recording-validation/2026-10-07_4k_macos27/source-native-artifact-parity.json) 的32,348×447概率最大绝对差为0，`rtol=0, atol=1e-6`；类别、时间网格、窗口计数、默认参数与34个自动候选全部相等。此为源码HTTP/实际原生界面的产物级比对，不代表识别质量、人类同步复核或干净平台。全部候选的HTTP/IPC真实导出与70份解码另由总验证记录报告，本节不把一个原生候选推广为全部原生导出。

## 当前ad-hoc签包：中文移动目录完整Electron复验

当前 `.app` 为 `dist/model-desktop-adhoc/mac-arm64/Apex Model Review.app`，ZIP为 [Apex-Model-Review-0.1.0-mac-arm64-macos27-adhoc-local.zip](../dist/model-desktop/Apex-Model-Review-0.1.0-mac-arm64-macos27-adhoc-local.zip)，634,257,382字节，完整SHA-256：

```text
4caaf868f3638c3cf7403794b6b9927eb464f536268defefb706d5fdf5e14886
```

解包到 `/private/tmp/apex-adhoc-20261007/中文 移动安装目录`；[归档fidelity](../outputs/desktop-archive-adhoc/archive-fidelity.json) 的13,631条目、12,488文件SHA、31符号链接、248可执行文件及全部模式无差异。[新包minimum](../outputs/desktop-signing-validation/minimum-os-green.json) 为27.0/27.0；六个核心模块、四个UI文件、七个桌面运行文件hash仍与源码一致。可重复归档/解包命令见 [桌面说明](desktop-model.md)。

[实际移动目录脚本](../scripts/verify_model_desktop_relocated.cjs) 通过继承的remote-debugging-pipe控制真正DOM/preload；没有增加业务HTTP服务或关闭产品renderer sandbox。仅自己的安装测试副本去掉写权限、保留执行位，HOME不改、正式用户数据目录不改，PATH隐藏开发命令并移除开发运行变量。普通UID501/jackliu从中文、空格源路径读取20秒540p真实样本，明确确认音轨 #1，默认阈值0.2和5/5/5秒产生1个候选，全部选中并保存；预览播放、1个独立copy成片播放、两份媒体完整音视频解码均通过。本次自然候选数为1，不伪造多个候选。

[完整报告](../outputs/desktop-relocated-host-validation/2026-10-07-adhoc/relocated-electron-closure.json) 保存原始完整结果、模型/硬件/阶段、资源配置、逐文件解码和两张真实截图：[预览](../outputs/desktop-relocated-host-validation/2026-10-07-adhoc/relocated-preview.png)、[成片播放](../outputs/desktop-relocated-host-validation/2026-10-07-adhoc/relocated-export.png)。总流程55.186秒：抽音频0.206秒、加载1.806秒、推理0.483秒、后处理0.007秒。重复启动PID58505退出0且core58480不变；真实 `window.close()` 触发正常退出，main58410退出0、signal=null，无强杀。保存19个实际观察PID，`awaitGone` 24毫秒、remaining为空；工具会话44929权威退出0。与此前未保存完整列表的4K脚本分别记录，不把本次列表补成旧脚本曾捕获。

13,631安装条目的path/mode/size/mtime/链接目标前后相同，完整资源seal在闭环前后均通过，模型缓存/`__pycache__`没有写入安装目录。此为开发主机、常规网络条件下的完整移动目录闭环；不宣称断网、干净Mac或人工同步验收。

完整宿主的外层 `sandbox-exec` 验收方案已停止。第一次profile阻断本机单实例Unix socket；允许AF_UNIX后，Chromium自己的Seatbelt初始化仍被拒绝，GPU进程反复失败并fatal，实际mainPID49791对应用户提供的11:24:35崩溃。保存 [失败/清理报告](../outputs/desktop-offline-host-validation/2026-10-07/offline-electron-closure.json)，没有运行模型，所有实际观察PID已消失。早先 `Target.getTargets` 的pipe响应不等于renderer加载通过。没有添加 `--no-sandbox`、修改用户网络或继续重试该profile；另一台Mac上真实完整断网由人工验收。

[Mac移交清单](desktop-mac-acceptance.md) 与 [OS证据collector](../scripts/verify_model_desktop_mac_handoff.sh) 已准备，不要求目标机安装Node/Python/Bun。collector使用macOS自带命令和包内媒体工具，收集签名/quarantine/环境/完整媒体解码/退出前后PID，不改系统信任或网络。其本机preflight已退出0，记录在 `outputs/desktop-mac-handoff-local/preflight/`；仍不是目标机验收。当前ad-hoc资源签名有效，但 `spctl` 退出3并拒绝，没有Developer ID/公证，原样下载/首开安装行为仍需实际记录。

collector的真实CLI验收另外发现自身进程误匹配：无应用时 `before-quit` 先错误退出0，唯一行是自己的 `awk -v app ...`（[RED](../outputs/mac-handoff-validation/capture-no-app-red/runner.log)）；已正常退出的历史19个PID输入也先因同一误匹配让 `after-quit` 错误退出1（[RED](../outputs/mac-handoff-validation/after-quit-red/runner.log)）。最小修复先剥去ps的PID/PPID/stat字段，仅用实际命令开头的安装目录作进程根，再展开其后代；退出时仍检查捕获的实际PID。公开同CLI复验：无应用拒绝1、退出前文件为空（[GREEN](../outputs/mac-handoff-validation/capture-no-app-green/result.json)）；历史19个已退出PID与资源seal通过0、退出后文件为空（[GREEN](../outputs/mac-handoff-validation/after-quit-green/result.json)）。后者的输入明确是先前实际报告重建，不当作新的live采样或新的应用生命周期验收；本轮没有启动GUI或模型。

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

[该原型归档逐项记录](../outputs/desktop-archive-macos27/archive-fidelity.json) 比较原 `.app` 与中文、空格移动目录解包结果的全部 **13,611** 条目：12,478 个普通文件逐个 SHA-256、31 个符号链接目标、248 个可执行文件及所有 POSIX 模式均一致，没有差异。核对脚本为 `scripts/verify_model_desktop_archive.py`。

旧13.0原型 ZIP `Apex-Model-Review-0.1.0-mac-arm64-local.zip`（SHA-256 `1c93d1fb61437b71cfeb4347a9bec7498780853f4729cb0859f0ce46c7256515`）及其 [13,610条目归档记录](../outputs/desktop-archive-audit/archive-fidelity.json) 保留为历史证据；下面的移动目录核心禁网报告针对旧包，不宣称新包重复运行了该场景。

[移动目录离线核心闭环](../outputs/desktop-archive-audit/relocated-offline-closure.json) 使用实际 **UID 501 / jackliu**，账号从系统 UID 查询而非环境 `USER` 推定，`PATH=/nonexistent`。随包 Python、模型、媒体工具从 `/private/tmp/apex-archive-k6yvahsh/中文 移动安装目录/Apex Model Review.app` 定位；真实20秒960×540样本完成 BEATs 分析、1个预览、1个独立快速复制导出，两份媒体全量音视频解码。这里通过CLI显式把数据目录覆盖到临时的 `用户数据 离线核对`，不作为正式 `.app` 用户目录写入证据；正式用户目录此前实际main审计另行记录。

仅这个 Python IPC core 及其子进程使用原生 profile `(version 1)(allow default)(deny network*)`。同一可用回环端点的正常控制探针成功，套用 profile 的探针失败，随后真实模型/媒体核心闭环成功。没有改全机网络或全局配置；此证据不等于完整 Electron 断网验收，更不等于无开发环境的干净 Mac。包仍未签名、未发布，最低版本真机运行、安装信任、许可/源码分发条件和人工复核未验收。

当前主机为 Darwin arm64，在 `dist/model-desktop/` 未发现 Windows 原生桌面安装包，也没有可用 Windows x64 目标机器证据；现有 Windows 原生构建路径和NSIS/portable配置可审查，没有用Mac或Bun交叉产物代替。提供的4K录像已补上本机真实长素材证据；独立1080p素材、人工音画/切点、原生通知可见内容/确认、干净Mac/Windows、最低版本真机运行与发行条件仍需要对应外部证据。
