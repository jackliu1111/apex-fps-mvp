# 模型服务实现与验收状态

2026-10-06（Asia/Shanghai），当前状态更新于 2026-10-07。本轮在已有 #4/#5 工作树基础上，按 PRD #3 已确认的公开逻辑操作／HTTP／IPC 边界实施；三个代理分别负责共享任务核心、Web 适配和界面、桌面／IPC，根代理负责复核、媒体导出及集成。新增行为按实际 failing test → 最小实现 → passing test 推进，审查阶段再优化和修复集成问题。

| Issue | 当前可审查结果 | 验收边界 |
|---|---|---|
| #6 | 多录像顺序分析、独立音轨／预测、逐份耗时、常驻模型复用 | 真实 20 秒样本连续三次推理同引擎、load_count=1；不是长录像性能承诺 |
| #7 | 调阈值／间隔／留白只重算候选，新版本重新预选、旧引用拒绝 | 原始预测保持独立，不触发新的真实推理 |
| #8/#9 | 勾选／范围编辑、按需预览与 seek、独立快速复制、逐文件实测边界和播放 | 精确成片重编码未启用；实际范围使用可追溯源视频包时间，人工同步另验收 |
| #10/#11 | 完整 SHA-256、配置失效、目录互斥、取消／半成品清理、中断恢复、guardian | 本机生命周期场景通过；Windows 进程语义未实机验收 |
| #12–#15 | 共享界面、有限 preload、UTF-8 NDJSON、受控媒体协议、单实例与退出清理代码、同场景 HTTP／IPC | 已有契约、真实冻结模型和实际 renderer 证据；这些不自动代表全部产品验收或目标平台验收完成 |
| #16 | 真实 4K 双入口通过；一小时 1080p 新 HTTP 完整流程对照已有 native，90,063×447 原始分数最大差 0、98 段请求／实测范围一致、双方成片完整解码通过 | 不同真实原点／多轨、人工切点／同步与目标机器仍待验收；已有 native 记录不冒称本轮再次 GUI 复验；用户确认其他播放器正常，QuickLook 调查暂缓且不作为当前阻塞 |
| #17 | 原生 Mac arm64 ad-hoc 签名 ZIP；最低 OS 27、资源签名修复、中文移动只读安装下完整界面／全部选中导出／正常退出通过 | 用户安排另一台 Mac 做最终验收；本机正常网络测试不替代真实断网、干净环境、人工及安装信任 |
| #18 | 原生构建包装器、OS PowerShell 验收工具与移交说明；Mac PS7 公开 CLI 9 项 red→green、真实随包核心 stdio 检查通过 | 按用户“先用 Mac”安排准备；尚未构建／运行 Windows 包，PS5.1、DLL、GUI 和干净 Windows 实机仍未验收 |

## 最终验证

- 逐项审计后完整 Python 回归 **142 项通过，无跳过**，包括真实 BEATs。日志：`outputs/issue-service-validation/python-final-audit.log`。
- 桌面 Node IPC／媒体协议 **7 项通过**；需要明确配置带 NumPy 的 Python，日志：`node-audited-head.log`。
- HTTP／IPC 的 9 项流程和 13 项边界共同场景通过，覆盖实际音轨抽取、分页、配置重推理、执行中源变化、模型单独崩溃、版本、缓存、排序／重复导出、取消、失败和异常退出恢复。逐项证据见 [契约审计](model-service-contract-audit.md)，不能仅从测试数量推定覆盖。
- 实际 Electron renderer 的 **7 个界面场景通过**：批量第二份结果刷新保留、缺失旧任务恢复控件、成片实际播放、任务／结果源录像标识、关闭页面后新会话发现原活动任务、逐段自动／请求时长、实际媒体诊断正文。每项保存实际 red/green 和 PNG，最终日志为 `ui-final-*.log`；见 `scripts/verify_model_review_ui.cjs`。普通 Chrome 的 CUA 检查不可用，未用它声称人工验证。
- 正式 Python HTTP 页面在真实 BEATs 分析时关闭，新的独立浏览器会话恢复同一任务，并完成调参、范围编辑、预览定位、独立导出及两份媒体完整解码。报告为 `outputs/issue16-ui-validation/50ada4c8/report.json`，耗时 6.387 秒，仅描述当前 20 秒样本；人工同步仍待复核。
- 最终冻结模型完成真实样本分析、按需预览和独立复制；所有输出全量音视频解码。冻结 guardian 保留退出码，受控媒体失败清理通过。
- 源码 HTTP 与最终冻结 IPC 对 500 帧、447 类、网格和候选比对，最大分数差 **0.0**，容差 `rtol=0, atol=1e-6`；不是模型识别准确率证据。
- 当前 `.app` 的六个 Python 模块、四个共享 UI 文件和七个桌面入口文件与源码 SHA-256 全部一致；资源签名修复后的记录为 `outputs/desktop-archive-adhoc/package-hashes.json`。Python wheel 包含全部新增核心模块、两个入口及静态页面资源。
- Mac ZIP 解压至中文／空格移动目录后，13,610 个条目的文件 SHA-256、符号链接和权限无差异。当前用户 `jackliu`（UID 501）以隐藏开发工具的 `PATH`、进程及子进程 `deny network*` 策略运行包内 IPC 核心，完成真实 BEATs、单段预览／独立导出及两份媒体全量解码。回环对照请求成功、同策略请求失败，未改全机网络。记录见 `outputs/desktop-archive-audit/archive-fidelity.json` 和 `relocated-offline-closure.json`；显式临时数据目录仅用于隔离此检查，不将核心检查当作完整 Electron 干净机器验收。

实际最终 `.app` 又经完整宿主检查：双启动只保留一个核心；真实双音轨与不同录像顺序分析复用同一引擎；主进程在推理／媒体作业中异常退出后，任务记录为 `failed/service_interrupted`，半成品和登记子进程清理，完成结果保留。单独终止 Python 核心曾使同步原生错误通知阻塞 IPC，实际测试先超时；改为异步通知后，存活主进程在五秒内通过真实 renderer 返回 `worker_unavailable`。最新指纹和运行记录在 `outputs/desktop-main-audit/`。原生通知的人工可见内容、感知同步及干净平台验收仍独立待办。

审计修复还保留任务级媒体诊断和最多 8 KiB 可查看正文；探测前后绑定同一源身份；旧版没有 `state.json` 的已有任务可以在重启后恢复最近引用。当前 Mac 的 T01–T15 服务技术合同已逐条记录；这不等于 #16–#18 的全部验收已经完成。

2026-10-07 用户提供的真实 4K 录像现已可用。双入口串行真实模型、冷暖复用、调参／范围编辑、全部 34 段独立导出及完整解码通过，32,348 帧和 447 类全部分数最大差值 0.0（33 页，容差 1e-6），总耗时 1966.833 秒。性能、实测边界、强身份及有限资源观测见 [4K 技术记录](model-recording-4k-validation.md)。这补齐了真实 4K 技术链路，未将报告中的人工 `required` 或缺失的 1080p／其他原点／多轨改成通过。

随后用户提供外置 USB 上蛋蛋鼠的一小时真实 1080p 回放及具体卡顿成片。已有桌面保存记录经只读核对：真实 BEATs 得到 90,063×447 预测，默认 5／5／5 参数产生 98 个候选，分析 100.424 秒、导出 465.940 秒；98 个任务／注册产物／文件关联一致。快照与范围见 `outputs/native-1080-selftest-snapshot/2026-10-07/`。根代理只读检查全部现有 98 个成片，33.756 秒内媒体探测及完整音视频解码均为 0，见 `outputs/1080-native-export-validation/report.json`，没有重跑模型或导出。它不证明双入口／GUI／人工验收，也不把用户报告的 QuickLook 卡顿记为修复。用户随后确认其他软件播放正常并要求暂不处理，[卡顿调查](copy-stutter-investigation.md) 已暂缓，诊断和对照文件保留，无需当前补充同播放器反馈。

新增 HTTP 真实冷暖分析、原参数重算、全选预览／98 段复制／99 产物完整解码及已有 native 对照最终通过，448.304 秒。全部 90,063×447 原始分数最大差 0.0，网格、融合计数、候选、98 个请求及实测范围一致；既有桌面没有重新推理。完整原始数组含视频之外约 53 帧音频尾，不能与公开视频分页范围混淆。[1080p 记录](model-recording-1080-validation.md) 保留来源、配置路径差异、UTF-8 客户端修复及各层范围；没有把 QuickLook／人工／干净机器改成通过。

本轮又在实际 `.app` 发现最低 OS 声明 13.0 低于随包原生库要求 27.0。公开 Info.plist／Mach-O 检查先失败；`beforePack` 按实际随包原生文件派生系统下限后，重打包的声明与 248 个原生文件的最大要求均为 27.0，独立检查通过。证据为 `outputs/desktop-archive-audit/minimum-os-{red,green}.json`；核心、模型和界面行为未变。该下限是静态要求，不能当作 macOS 27 最低版本实机兼容或干净平台结论。

用户优先推进 #17／#18 后，公开签名检查又发现原测试包缺少有效资源封装，`codesign --verify --deep --strict` 失败。配置明确的本地 ad-hoc 签名后，同一公开检查通过，未使用 Developer ID 凭据或改系统信任；它仍未公证，`spctl` 拒绝不改写为信任通过。新包在中文／空格只读安装副本、普通 UID 501、隐藏开发工具 PATH 且 HOME 不变时，真实 20 秒样本完成模型、默认全部 1 候选选择、预览、独立复制、播放与两份完整解码。重复启动未新增核心，真实窗口关闭正常退出，19 个实际观察 PID 消失；55.186 秒闭环后全部 13,631 安装条目及资源签名仍一致。见 `outputs/desktop-signing-validation/`、`outputs/desktop-relocated-host-validation/2026-10-07-adhoc/relocated-electron-closure.json` 与 [Mac 移交验收](desktop-mac-acceptance.md)。

试图用 `sandbox-exec` 强制整个 Electron 禁网时，Chromium 自身隔离初始化被拒绝，PID 49791 触发 GPU fatal／SIGTRAP，即用户提供的崩溃报告。相关测试已停止并清理，没有关闭产品的 renderer sandbox 或修改全机网络；正常新签包另行验证通过。归因见 `outputs/desktop-offline-host-validation/2026-10-07/user-crash-correlation.json`。这一失败不能记为完整宿主离线成功，最终由用户安排另一台 Mac 验收。

#18 已准备 [Windows 执行说明](desktop-windows-acceptance.md)、`build_model_desktop_windows.ps1` 和 `verify_model_desktop_windows.ps1`。工作区内的官方 Mac PowerShell 7.6.6 对公开平台拒绝、包结构／PE 身份／路径约束、诊断、超时配置与真实 Mac 冻结核心 stdio 等 9 项逐条 red→green，最终 9／9、4.762 秒，见 `outputs/windows-preparation-validation/windows-final.log`。正确头字段夹具不是可运行 Windows 包，PS7 解析也不是 PS5.1 证明；所有准备记录保留 `native_windows_acceptance=false`，没有 dispatch、跨编译或上传录像来代替 Windows 原生验收。

另一台 Mac 的 [无开发环境验收工具](desktop-clean-machine-handoff.md) 已打包为 `dist/handoff/Apex-Desktop-Verify-Kit-Mac-2026-10-07.zip`（SHA-256：`8c38e547a5829c3c6633bcbdd78a53e0a30435c2de1480e749476f012b10f227`）。它使用应用包内的 Electron／Node 作为控制器载体，不需系统 Node／Python／Bun；实际包内载体探针和零 GUI 预检已通过，公开 CLI 5 项通过，五个解压文件的 SHA 和权限一致。原进程门把载体自身误判为已有应用，公开 CLI 先失败后仅排除自身 PID 修正；其他同执行文件 PID 仍拒绝且不被终止。OS 采证器把自身 awk argv 误当应用的问题也经过两条公开 CLI red→green 修复。工具完整 GUI／模型分支在包内 Node 载体下尚未于另一机执行，真正机器来源、断网、Finder 首开和人工同步仍由操作者记录。

真实 4K 的正式 HTTP 页面关闭后新会话恢复、首候选编辑／预览／独立导出／播放通过（204.737 秒）；当前实际 Mac 包的默认候选、单段复核／播放／两媒体解码也通过（217.899 秒）。源码与实际桌面公开预测产物的全部 32,348×447 分数及自动范围一致，最大差值 0.0。两次验收进程均权威退出 0；清理记录保留实际 PID 观测范围和未记录项，另行检查整个 native app 路径无残留。完整证据和范围见 [4K 技术记录](model-recording-4k-validation.md)，[人工清单](../outputs/issue16-4k-validation/2026-10-06_23-58-12-3dded084/human-review.md) 保留原 runner 的 70 项，并单列后来界面复验的 4 项；74 个实际文件均待审核，未声明人工通过。

## 使用与复验

启动 Python Web：

```sh
sh scripts/start-python-model-web.sh
```

当前 Mac 本机测试包：`dist/model-desktop-adhoc/mac-arm64/Apex Model Review.app`，归档为 `dist/model-desktop/Apex-Model-Review-0.1.0-mac-arm64-macos27-adhoc-local.zip`（SHA-256：`4caaf868f3638c3cf7403794b6b9927eb464f536268defefb706d5fdf5e14886`）。该包声明最低 macOS 27，采用本地 ad-hoc 签名而未公证；新归档完整性及源码指纹见 `outputs/desktop-archive-adhoc/`。旧包保留为修复前的历史证据。开发与原生构建步骤见 [桌面入口](desktop-model.md)。HTTP 操作见 [Web 文档](python-model-web.md)，核心任务、身份和真实复用证据见 [生命周期](python-model-lifecycle.md)，媒体边界和逐文件记录见 [复核／导出](python-model-review.md)。

真实素材复验使用 `scripts/validate_model_recordings.py`，每份录像都必须明确指定音轨索引；它会记录技术链路并始终保留人工复核待办。4K 和新增 HTTP／已有 native 的 1080p 对照均有具体技术记录，此前 540p 证据仍保留。其他原点／多轨、人工媒体复核与目标平台机器仍需补齐 #16–#18，当前不能关闭产品 PRD 或声称全平台交付完成；QuickLook 兼容性调查按用户要求暂缓，不计入当前阻塞。

本轮未发布发行包、推送代码或关闭 GitHub Issues。生成的模型、媒体与包证据在忽略目录，源码和文档保留在当前工作树供审查。
