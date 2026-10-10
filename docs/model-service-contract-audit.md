# PRD 服务契约证据审计

审计日期：2026-10-06；真实 4K 与 1080p 证据补充于 2026-10-07（Asia/Shanghai）。本文件逐条核对 [PRD #3](https://github.com/jackliu1111/apex-fps-mvp/issues/3) 的 T01–T15／F01–F17，以及 #6–#11、#15 的可观察验收。10 月 6 日已通过公开 GitHub REST API 重新读取 #3、#6–#11、#15；#3 更新时间为 `2026-10-03T11:15:38Z`，子项更新时间为当天 11:43–11:44 UTC，与 `outputs/issue-service-validation/issues.md` 的正文一致。本轮未修改或关闭远端 Issue。

“已有证据”只表示下列具体输入和动作已经被测试或运行记录观察到。下列共同场景、正式 HTTP 页面及 renderer 记录已补齐本轮发现的服务契约缺口；在所列范围内，T01–T15 的技术合同成立。该判断逐条依据输入、动作、错误、文件和运行记录，不由测试总数推导。最终包的宿主生命周期与版本对应由独立桌面记录补充，T16–T18 的素材、人工复核及目标平台条件仍单列。

## 证据来源及边界

| 证据 | 可以证明的范围 | 不能替代的证据 |
|---|---|---|
| `tests/test_model_web.py`、`test_model_analysis.py` | 真实 HTTP、FFmpeg/ffprobe、已知双音轨及 +0.25 秒映射；受控预测与明确启用的真实 BEATs 场景 | 所有错误都已通过 IPC、人工同步、发行包 |
| `tests/test_model_tasks.py`、`test_model_review.py` | 公开核心操作；版本、身份、目录锁、逐份记录、真实媒体、PID 存活及故障清理 | 所有场景都通过两个传输入口或最终安装包 |
| `tests/test_model_dual_contract.py` | 同一组行为分别通过实际 HTTP 与 NDJSON `serve` 执行；受控外部模型及媒体故障，外部文件解码 | 未包含的输入矩阵、真实模型质量、实际 Electron 主进程生命周期 |
| `tests/test_model_contract_edges.py`、`outputs/contract-edge-validation/contract-edges.log` | 同一输入经两入口验证实际轨选择、1100 帧分页、执行中来源变化、配置切换、模型死亡、重复提交、非法参数、旧版本、局部缓存、空选择、排序／重复导出及不兼容错误；13 项共同场景实际合跑通过，22.544 秒，无跳过 | 外部模型／媒体夹具用于合同机制，不能计为真实模型效果或目标平台验收 |
| `tests/test_model_ipc.py`、`desktop/test/*.test.cjs` | 实际 stdio 入口、Node 请求关联、错误传播、受控资源协议与 Range | 全部产品故障和干净目标平台 |
| `scripts/verify_model_review_ui.cjs` 及 `ui-final-*.log/png` | 实际公共控件、刷新、错误恢复、播放、源标识；关闭后新窗口恢复活动任务、逐段自动／请求时长、失败诊断正文均已运行通过 | 人工媒体内容／同步；隔离 renderer 不替代正式宿主进程死亡 |
| `outputs/issue16-ui-validation/50ada4c8/report.json` | 正式 Python HTTP 页面、独立新 partition：关闭后重开恢复同 task `438df490f3f14673b55373bac3463431`，真实 BEATs 到复核／独立导出的完整流程 6.387 秒；500 帧，预览和成片均全量解码 | 该样本仍为 960×540；报告的 human_sync_review 为 required，clean_machine 为 not_evaluated |
| `outputs/issue16-validation/*/report.json`、`score-pages.jsonl` | 20 秒 960×540 实际 Apex 样本，两入口真实 BEATs、447 类／500 帧分数、媒体全量解码、冷暖引擎记录 | 1080p／4K、不同真实音轨、人工同步和准确率 |
| `outputs/issue16-4k-validation/2026-10-06_23-58-12-3dded084/report.json`、两入口 `evidence.json`／任务／解码日志及 `score-pages.jsonl` | 3840×2160、1293.949 秒真实录屏，明确音轨 #1；真实 BEATs 冷暖引擎；32348×447 全部分数与时间网格经 33 页比较，差异为 0；各入口 34 个独立导出及一份预览，共 70 个文件全量音视频解码成功 | 此次输入只有一条音轨且音视频原点均为 0；不能替代真实 1080p、不同真实原点／多轨、人工同步／识别质量或干净平台 |
| `outputs/issue16-1080-http-validation/2026-10-07_13-19-34-2bb39223/report.json`、`http/evidence.json`，及 `outputs/native-1080-selftest-snapshot/2026-10-07/` | 1920×1080、约 1 小时真实源：新 HTTP 冷暖流程与既有 native result／export 记录对照；90063×447 完整公开 NPZ 产物的类别、网格、window_counts 与全部概率一致，max_abs=0；98 候选及 98 输出请求／实际范围／模式一致。新 HTTP 的一份预览及 98 导出共 99 个文件完整解码为 0，原 native 98 成片另有完整解码报告 | native 使用既有任务和公开 scores_path 产物，没有再次运行桌面服务或分页／GUI；不等于人工同步、不同真实原点／多轨或干净平台验收。用户确认其他播放器正常，QuickLook 调查已暂缓，不作为当前阻塞 |
| `outputs/issue16-4k-validation/resource-observation.jsonl` 与该轮报告的 `child_resource_observation` | 指定验收 runner 后代的两段 15 秒间隔采样、实际硬件及已回收子进程资源记录；采样包括一次 IPC 暖推理尾部 | 没有采到冷启动／加载峰值；RSS 包含共享页，回收子进程 max_rss 不是完整阶段或全机峰值，不能当发行预算 |
| `build/model-desktop/mac-arm64/frozen-real-smoke/` | 本机冻结 Python 的真实样本与媒体；已记录 guardian 退出码和媒体失败 | 最新源码自动进入旧包、干净机器、Windows |
| `outputs/desktop-main-audit/{audit,batch-audit,core-crash-audit,final-package-hashes}.json` | 真正 `.app` 主进程／preload／窗口的处理、单实例、异常退出、双轨批量及 core-only 故障；最终六个核心输入 SHA、四个 UI 和七个桌面文件均与当前源码匹配 | 本机开发环境的进程／文件观察不等于原生弹框人工确认、人工同步或干净目标平台 |

## T01–T15 映射

| 场景／功能 | 当前具体证据 | 完成判断与边界 |
|---|---|---|
| T01／F01–F03：路径、媒体、多音轨／无音轨 | 新共同 `test_media_selection_contract_uses_the_explicit_audio_track_through_both_entries`：首轨 .75 秒实际 19 帧、+0.25 映射；第二轨 1 秒实际 25 帧、0 映射；两入口均拒绝未确认、空／缺失／目录路径、无音轨、损坏媒体、非法流索引。HTTP／实际 stdio 另有中文、空格和 locale 场景 | 已补齐原共同输入矩阵和真实抽取轨的独立长度断言；不把麦克风／游戏标题视为自动判断真值 |
| T02／F04–F06：首次、连续任务、重复提交 | 核心逐份 ID／轨快照；实际 BEATs 同引擎 index 1/2/3、load_count=1。新共同 `test_active_analysis_rejects_duplicate_submission_without_blocking_status_queries` 在 gated 活动分析期间，两个入口均返回 task_busy／409，get_task 不足 1 秒；没有第二活动任务 | 合同场景已通过；大素材处理等待与资源预算归代表素材性能验收，不能推广小样本耗时 |
| T03／F07：4.96、5、5.04 秒间隔 | 双入口 `test_grouping_boundaries_overlap_and_long_fire_match_through_both_entries` 使用 4.96／5.04／7 秒；`test_exact_five_second_event_gap_merges_before_padding_in_both_entries` 使用恰好 5 秒，核对字面范围 | 这些确定性分组规则已有两入口证据；不表示模型事件时间达到 40 ms 准确率 |
| T04／F07：首尾、长交火、留白重叠 | 同一双入口 80 秒夹具，首段从 0 开始、末段到 80、30–79.75 秒交火不拆，7 秒间隔组留白重叠但分别保留；输出范围用已知规格核对 | 契约行为已有证据；代表性真实录屏边界属于 T16/T17 |
| T05／F06/F08/F14：调参与配置变更 | 核心 gap=6/before=1/after=2 字面范围；真实 BEATs 保留 prediction/index=3。共同 audio 变化观察 19→25 帧、新 prediction/cache key、同引擎复用；weight／loader 变化观察不同 prediction/cache key/engine、各 index=1/reused=false。新增 `test_parameters_reject_invalid_types_and_old_version_previews_through_both_entries` 覆盖四参数 None/bool/string/list/dict/NaN/±Inf/negative/threshold>1，422 拒绝，0/1 等合法边界可重算 | 合同场景已通过；fixture 的配置重建证明机制，不表示任意新模型质量已验证 |
| T06／F08–F10：旧选择／预览 | 双入口完整流程拒绝旧 selection；新增共同参数场景先生成预览，再创建新候选版本，即使自动范围数值相同，旧 preview 仍返回 stale_preview／409；HTTP／Node 另有旧范围内容访问拒绝 | 合同场景已通过，未按列表位置误映射旧引用 |
| T07／F09–F10：单段修改、非法范围、未知候选 | 新共同 `test_range_edit_invalidates_only_its_preview_and_retains_the_other_candidate_cache` 修改 first：first 旧缓存 409、second 可读并复用同 ID、first replacement 新 ID；原始预测／自动候选保留，双入口非法范围／未知候选不部分写入。最终 renderer 的自动时长 7.336 秒不变，请求修改后时长为 3.400 秒 | 合同场景和时长显示已通过；精确内容和感知同步仍待人工 |
| T08／F05/F09/F11：无候选／全不选 | 双入口无枪声仍保存 600 帧／空候选；新增 `test_deselecting_all_existing_candidates_rejects_export_without_creating_output` 从两个已有候选全部 deselect，empty_selection、没有输出目录或新任务；界面提供选中数量／总时长与空选择禁用状态 | 两种不同状态的服务合同已通过，没有伪造成功文件 |
| T09／F11/F13：独立、顺序、重复导出 | 新共同 `test_exports_follow_request_time_and_repeat_without_overwriting_and_reject_unsupported_modes` 将两个请求范围顺序反排，导出按请求时间排序为 001/002；同请求重复导出路径无交集，旧 artifact 字节不变且可解码；media_id/task_id 分目录 | 合同场景已通过；两个文件而非拼接，旧输出未覆盖 |
| T10／F11–F12：实测切点／不兼容 | H.264/AAC 和 H.264/ALAC 真实媒体实测 2.0–3.7、14.0–15.7，以完整源／输出包 hash 及 PTS 对应。新共同导出场景两个入口均拒绝 precise mode 和 FFV1/PCM，422 且无输出；真实样本完整解码，renderer 可播放成片 | 合同场景已通过。运行时允许 HEVC/AV1/MPEG-4/MP3 由工具决定成功，但不据此宣称这些组合全部已验收；不兼容不静默重编码 |
| T11／F13–F14：执行期间源变化 | 核心同大小同时间替换被 SHA-256 拒绝。新增三项共同场景在外部 gate 同步后修改来源：推理失败 source_changed 且没有 result；预览无注册产物、清 pending/partial；第二导出 failed/source_changed，无 path/actual，第一完成 artifact 可公开读取并全量音视频解码。另有公开 probe 场景在已取得原 1 秒 metadata 后换为 2 秒媒体，现 source_changed、不发布 media_id | 原执行中三个时点及输入探测 snapshot 缺口已补，连同提交前／旧缓存拒绝形成明确证据；依据当前核对时点策略，不表示允许任意并发改写素材 |
| T12／F05/F13/F15：取消／媒体失败 | 双入口分析 cancelling→cancelled→新任务；预览取消后 PID 消失／partial 删除；第二导出失败／取消保存完成首文件并解码。任务级抽音频失败日志保留，get_task 提供 8 KiB 尾部，实际 renderer 显示外部工具 `controlled audio decoder failure`（ui-final-failure-log.log） | 服务／界面合同已通过；当前 final-head 原生包故障记录由桌面验收独立关联 |
| T13／F05/F15：核心、入口故障、恢复 | 两入口 core SIGKILL 后恢复中断失败；只杀 model target 后核心仍可查询失败并重建。实际 `.app` 单实例通过，main 在推理／媒体期间 SIGKILL 后清理登记 PID、保留完成结果并记录 service_interrupted。最终 core-only 故障中 main 存活，全部 target 退出；异步通知修复后真实 renderer 在 5 秒内收到 worker_unavailable／503，重启读到中断失败 | 合同机制和实际宿主故障已有独立证据；原生弹框是否可见及人工确认未被脚本观察，不把该人工部分写为通过 |
| T14／F16：预测／范围／错误一致 | 新共同 `test_full_prediction_is_identical_across_entries_when_read_in_bounded_pages`：44 秒 1100 帧分别读取 1000+100，核对 39.96／40.0 边界、活动分数、最后 44 秒并比较两页全部数组。原共同范围／错误场景及真实 500×447 max_abs=0 继续提供独立证据。10 月 7 日真实 4K 两入口的 32348×447 分数经 33 页逐页比较，分数及映射时间网格最大差异均为 0，atol=1e-6/rtol=0；重算候选、请求及实际输出范围一致。同日新 HTTP 与既有 native 的 1080p 完整 90063×447 NPZ 产物对照也为 max_abs=0，包括视频结束后的 53 帧音频尾部；98 个请求／实际范围／模式一致 | 原多页缺口已补；1100 帧是受控预测，540p／4K／1080p 是实际 BEATs。1080p 此轮是产物比较，不是再次桌面分页；一致性不能推导模型识别准确率或感知流畅性 |
| T15／F17：独立启动、页面关闭、服务停止、安全 | HTTP `python -S` 隐藏其他运行时独立启动；令牌／Host／Origin、资源 token、离线页面有真实场景；正常服务停止清理。正式 HTTP page 在独立新 partition 关闭／重开后恢复同 task，继续真实 BEATs／预览／独立导出，报告 `outputs/issue16-ui-validation/50ada4c8/report.json`，6.387 秒；旧无 state.json 目录也能发现最近结果 | 合同场景已通过；这是实际关闭后重开，不再用 reload 替代。540p 样本仍不构成 T16–T18 |

## 子项验收的当前结论

| Issue | 当前服务契约完成依据 | 独立验收边界 |
|---|---|---|
| [#6](https://github.com/jackliu1111/apex-fps-mvp/issues/6) | 顺序批量、独立实际音轨、两入口 task_busy 和及时查询；真实冷暖引擎 index／load_count；正式 HTTP 新会话及旧目录恢复均有证据 | 首次／后续复用机制成立，不推导长 4K 等待上限 |
| [#7](https://github.com/jackliu1111/apex-fps-mvp/issues/7) | 四参数合法／非法共同矩阵，兼容后处理不重推理，新版本与重新预选，旧选择及同范围旧版本预览均拒绝；实际 UI 提示／每段时长 | 阈值是开发基线，识别质量不在这些合同证明内 |
| [#8](https://github.com/jackliu1111/apex-fps-mvp/issues/8) | 版本化选择、合法／非法范围、仅对应段失效，另一缓存保留且复用，按需预览、Range、无候选／全不选均已观察 | 实际内容／感知同步属于 #16 的人工验收 |
| [#9](https://github.com/jackliu1111/apex-fps-mvp/issues/9) | 两入口按请求时间独立输出、重复不覆盖、完整源包实测范围、失败／取消部分保留、实际成片播放；unsupported copy/precise 均明确拒绝 | 只声明已测 H.264/AAC、H.264/ALAC 及拒绝策略，不能把运行允许的整个 codec 列表写为已实测；精确导出未启用 |
| [#10](https://github.com/jackliu1111/apex-fps-mvp/issues/10) | 强身份策略、配置与 cache key、目录互斥；共同音轨／权重／loader 变化后新推理及需要的引擎重建；三阶段执行中来源变化均拒旧产物 | 任意模型升级的识别质量和真实大素材性能不属于这些合同夹具证明 |
| [#11](https://github.com/jackliu1111/apex-fps-mvp/issues/11) | 三类任务取消、媒体失败、完成文件保留、core／parent／engine-only crash 恢复；正式 HTTP 新会话；真实 renderer 可见任务级日志正文；实际 `.app` 退出／故障及 PID 记录已关联 | 不替代原生通知人工可见性、感知同步或干净机器验收 |
| [#15](https://github.com/jackliu1111/apex-fps-mvp/issues/15) | T01–T15 上表逐条输入／动作／结果对应；原共同流程加十三项共同 edge 场景及正式 HTTP／renderer 证据，真实分数／范围明确分层 | 当前 Mac 服务技术合同完成；真实代表素材／人工及目标平台 #16–#18 仍未完成，不由合同测试关闭整个产品 PRD |

## 本轮审计已经推动的真实修复

1. 新页面失去 sessionStorage 后无法发现服务活动任务。公开 `get_config` 场景先因缺少 active_task_id 失败；新增 `state.json` 轻量引用后通过。最近任务和最近分析分别保留，重启不传输全部分数。
2. 失败抽音频诊断与结果目录一起删除。外部 FFmpeg 失败场景先无法取得 media_log；任务级 `tasks/logs/{task_id}/{result_id}.log` 后保留真实 stderr，逐份任务记录关联日志。
3. 未计划宿主死亡被误报为用户取消。真正的 IPC parent SIGKILL 场景先得到 cancelled/task_cancelled；宿主死亡检查及 interrupted cleanup 后得到 failed/service_interrupted，完成产物保留且模型 PID 消失。正常 EOF／退出仍走取消语义。
4. Locale C 中模型中文错误被 ASCII 解码异常覆盖。真实 stdio 场景先丢失中文原因；model worker 管道显式 UTF-8 后保留原始 model_load_failed 说明。
5. 失败诊断仅有文件路径，界面不能直接查看。公开 get_task 场景先缺 media_log_tail；新增锁外读取的至多 8 KiB UTF-8 尾部及截断标记后，末尾错误可见。移除临时日志文件后，原失败任务和错误仍可查询，正文为空。
6. 输入探测结束后才取 source hash，可能把旧 metadata 绑定到新文件。外部 ffprobe 捕获原 1 秒／64×64 信息后暂停，同路径换为实际 2 秒／96×64 文件，先错误返回 media_id；探测前后身份绑定后返回 source_changed／409，没有媒体记录返回。身份读取过程中的变化亦使用来源错误，不误报媒体工具缺失。
7. 旧版已有结果目录没有 state.json，新会话无法发现其最近结果。公开操作完成分析和预览后模拟该旧版布局，并去掉旧分析 kind，重启先得到两个最新引用均 None；现在从有效任务时间／ID 恢复最近任务和最近分析，仍不生成活动任务或全历史列表。只读核对真实 Native 数据目录 `/Users/jackliu/Library/Application Support/apex-model-desktop/model-data` 确有五个任务且没有 state.json，未修改它。

对应日志为 `tasks-14/15/16/17/18/19-red/green.log`、`ipc-utf8-red/green.log`。最后 probe 变更后的已有 HTTP 输入场景定向回归见 `probe-invariant-web-regression.log`。十三项共同 edge 场景实际合跑日志为 [contract-edges.log](../outputs/contract-edge-validation/contract-edges.log)，覆盖上表新增组合，逐项首跑 green，没有为制造 red 修改已通过生产行为。它们使用公开逻辑操作及外部 gate／PID／媒体，不建立内部 helper 测试。

实际 renderer 最终七个记录为 `outputs/issue-service-validation/ui-final-{restore-result,missing-task,export-playback,result-source,reopen-active,candidate-duration,failure-log}.log`，均实际通过。它们依次证明已复核第二份恢复、缺失引用不锁控件、真实成片播放、来源标识、新独立会话恢复、逐段时长与失败诊断。正式 HTTP 页面记录另见 [report.json](../outputs/issue16-ui-validation/50ada4c8/report.json)，不再将该路径列为未执行。

最终包已经重新冻结。2026-10-06 收尾只读复核：当前六个核心 `.py` 的 SHA-256 全部等于安装资源 manifest 的构建输入 hash；直接读取最终 `app.asar` 后，四个共享 UI 和七个桌面文件均与 manifest／当前源码逐字节 hash 匹配。最终记录为 [final-package-hashes.json](../outputs/desktop-main-audit/final-package-hashes.json)，没有沿用旧指纹声明新头一致。

实际主流程／批量审计曾使用通知修复前的 `main.cjs`；核心及共享 UI hash 相同。最终 `core-crash-audit.json` 对应当前异步通知主进程 hash，并覆盖该修复的真实失败请求与存活行为。两层记录保留各自 manifest，不把早期失败记录或未观察的 dialog 当作通过。

收尾完整 Python 日志 [python-final-audit.log](../outputs/issue-service-validation/python-final-audit.log) 明确为 142 项通过、无跳过。七份 `ui-final-*.log`、正式 HTTP 重开报告、共同边界日志与实际 `.app` 三份审计均已逐项核对。本轮没有重跑这些已通过测试，也没有再发现所列服务合同范围内可在当前机器继续修复的明确行为缺陷。

## 真实素材与外部验收边界

2026-10-06 较早的只读检查中，历史文档列出的确切路径 `/Users/jackliu/Downloads/2026-09-11 20-32-49.mkv` 尚不存在；当时可追溯真实素材只有 20 秒 960×540 样本。该判断是当时的素材状态，已被随后提供的文件与新运行证据更新，没有进行无界 home／Downloads／Movies 扫描。

2026-10-06 23:58:12 开始、10 月 7 日完成的 [4K 报告](../outputs/issue16-4k-validation/2026-10-06_23-58-12-3dded084/report.json) 为 `technical_status: passed`，runner 最终输出同一结果。来源为上述路径，16,823,282,156 字节，SHA-256 为 `5b74ec8fbebf5be1873e694568cc19d3cc13b095b6ecd6e47cb4277060cab758`，策略为 `sha256-size-mtime-ns-v1`。本次媒体为 H.264/AAC、3840×2160、视频范围 0–1293.949 秒；明确确认容器音轨 #1，音视频原点和偏移均为 0。

实际 HTTP 和 NDJSON IPC 使用独立数据目录，各自完成真实 BEATs 冷／暖分析、5/5/5 候选重算及范围编辑。每个入口均有 32348 帧、447 类、34 个候选；33 个公开分数页覆盖全部 32348 帧，分数与实际映射网格最大差异均为 0，绝对容差 1e-6、相对容差 0。各入口全部选择 34 段，每段首尾各缩小 0.04 秒，独立导出 34 个文件，并预览一段；两份 `evidence.json` 的 70 个完整音视频解码记录均返回 0，输出文件与日志均存在。没有将一份预览写为全部候选均已预览。

冷暖复用直接由各自实际引擎报告：HTTP 的 `0f2322bc27c74e6db1cab250ee3221d0` 和 IPC 的 `b31e55c9adf04872b2ca6da289ece96a` 分别保持相同 PID／引擎，索引从 1 增为 2，`model_reused` 从 false 变为 true，`load_count` 均为 1，`reported_by` 均为 engine。逐份分析与媒体阶段耗时见 [生命周期文档](python-model-lifecycle.md#2026-10-07-真实-4k-双入口技术证据)。完整双入口、哈希、预览／导出／解码及分页比较流程耗时 1966.833 秒，不能把它写成单次推理耗时。

[资源观察](../outputs/issue16-4k-validation/resource-observation.jsonl) 记录 Apple M6、16 GiB、12 个逻辑 CPU，只采样验收 runner 的后代。首段捕获 HTTP 导出；第二段仅一次 IPC 暖推理尾部及后续媒体阶段，未捕获冷启动／加载峰值。该暖尾样本的 IPC 子树 RSS 合计 621168 KiB、CPU 合计 196.4%，模型 RSS 583712 KiB；报告的已回收子进程 max_rss 为 991592448 字节。两类数值的范围不同，均不是全机峰值或发布预算；RSS 包含共享页，可能并行的轻量打包也不在本观察范围内。日志中首个零 PID 样本由解释器大小写匹配错误导致，随后 correction 已明确，不能视为验收 runner 曾退出。

该 4K 报告的分辨率覆盖为 `4k: true`、`1080p: false`，只描述该轮输入；随后已有真实 1080p 录屏与下述技术对照，不再将 1080p 素材列为缺失。报告仍保留 `manual_review: required`、`issue16_complete: false` 和 `clean_machine_acceptance: not_evaluated`。不同真实原点／多轨素材、内容／切点与感知同步人工复核、干净 Mac／原生 Windows 仍是明确验收条件。

## 2026-10-07 真实 1080p HTTP 与既有 native 产物对照

[新 HTTP 报告](../outputs/issue16-1080-http-validation/2026-10-07_13-19-34-2bb39223/report.json) 为 `status: passed`，权威运行退出 0，全流程 448.303803 秒。来源为用户已提供的 1,821,157,547 字节 H.264/AAC 真实录像，1920×1080、视频 3600.366313 秒，源身份 SHA-256 为 `58861bac9ee7ad084811e66913d70bc6e081dc9bc339ac7faa89e2cac3d804c4`。HTTP 与 native 保存的 source 身份及明确音轨 #1 映射完全一致；该源只有一条音轨，两个原点和偏移均为 0。

native 对照引用为正式用户目录的 result／analysis task `234fec535eef423a9ab9b7dfb0ee3735` 与已完成 export task `3063efa43c1a4ee0a197ac57a92051da`，见 [限定匿名快照](../outputs/native-1080-selftest-snapshot/2026-10-07/snapshot.json)。原 98 个选择全部保留默认候选范围，revision=1，98 个 copy 成片与注册记录、USB exports.json 一致。原 native 98 份成片的独立 probe／完整音视频解码 [报告](../outputs/1080-native-export-validation/report.json) 为 passed。这些是既有 native 操作的记录，本轮没有重启桌面模型任务或再次经 IPC 读取全部分数页。

新 HTTP 完成真实 BEATs 冷／暖分析、按原 5/5/5 参数重算、全选且不缩小范围、预览首段和独立导出全部 98 段。重算保留完整 prediction 并更换候选版本；候选、选择及 98 份导出的 requested_range／actual_range／mode 与 native 精确相同。[HTTP evidence](../outputs/issue16-1080-http-validation/2026-10-07_13-19-34-2bb39223/http/evidence.json) 的 99 个新文件均通过 probe 和完整音视频解码，返回码全部为 0。

本轮读取服务公开 `scores_path` 指向的两个完整 NPZ 产物，比较全部 90063×447 概率，最大差异为 0，atol=1e-6／rtol=0；类别、frame_onsets、frame_offsets 和 window_counts 精确相同。音频有效范围到 3602.5173125 秒，因此包含公开视频时间范围外的 53 个尾帧；没有把只允许查询视频范围的 `read_scores` 分页写成这 53 帧的证据。该产物比较读取完整矩阵，不沿用 4K 的逐页读取或资源采样声明。模型／适配器／loader SHA 与预处理语义一致，安装目录和工作区路径不同被明确记录，不要求 path-sensitive configuration／cache key 字典相等。

HTTP 引擎 `a337495ae84d424681202fdbaf37c83b`／PID 88832 的索引为 1→2、复用 false→true、load_count=1，均 reported_by=engine。冷／暖逐份分析分别 100.401291／96.675475 秒，导出 182.045464 秒，详细阶段见 [生命周期文档](python-model-lifecycle.md#2026-10-07-真实-1080p-http-与既有-native-产物对照)。这不是用户 native 再次冷暖运行，也不能推导性能预算。

此证据补充 1080p 来源及跨入口产物／范围一致性，不构成完整 GUI／人工同步验收。该次报告中的 `quicklook_stutter: unresolved` 保留为历史观察；2026-10-07 用户随后确认其他播放器正常，要求暂缓 macOS 预览／QuickLook 调查。该项不再作为当前阻塞，也未宣称已修复。报告保留 `manual_review: required`、`issue16_complete: false`、`clean_machine: not_evaluated`；不同真实原点／多轨、人工内容／切点与感知同步、另一台干净 Mac 及原生 Windows 仍待验收。
