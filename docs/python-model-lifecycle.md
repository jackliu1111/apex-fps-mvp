# 模型服务：批量、调参、身份校验与任务生命周期

对应 Issue #6、#7、#10、#11。共享 `ModelService.execute(operation, request)` 继续使用 PRD #3 中已经确认的逻辑服务操作测试边界，HTTP 与 IPC 调用同一实现。纯音频范围和双入口职责遵循 accepted ADR 0001、0002；枪声候选不代表本人开枪、命中或击杀。

## 顺序批量与引擎复用

`analyze` 接受单份 `{media_id}` 或非空 `{media_ids: [...]}`。提交前所有录像必须明确确认检测音轨。实例同时只保留一个活动分析、预览或导出任务；忙碌时在读取媒体记录或完整哈希之前返回 `409 task_busy`，不另行排队或启动并行推理。任务启动时再次原子核对活动位置，防止并发提交。任务及结果写入数据目录，关闭浏览器页面不会停止任务。

批量按提交顺序执行，各录像拥有自己的 `result_id`、完整预测和音轨快照。任务保存 `kind: analysis`、`media_ids`、`current_media_id`、`current_index`、`batch_progress`，以及顺序排列的 `results: [{media_id, status, result_id, error, elapsed_s, timings}]`。各结果还保存 `analysis: {elapsed_s, timings}`，后续录像和调参不会覆盖先前录像耗时。顶层 `task.timings` 显示最近一份录像的阶段耗时，完整逐份记录读 `results`。每份失败独立记录，后续录像仍可处理；全部失败时任务失败，至少一份成功时任务完成并保留各项错误。单份分析继续提供 `media_id` 和 `result_id`，兼容已有调用方。

`get_config` 提供 `active_task_id`、`latest_task_id` 和 `latest_analysis_task_id`。轻量 `state.json` 只保存这三个引用与 schema，不包含分数或全部历史；所有任务更新最近任务，分析任务另外更新最近分析引用。任务启动和引用保存处于同一锁内，终态清除活动引用，重启保留最近引用并将遗留任务收敛为中断失败。新的浏览器会话可以查询这些引用及其 `get_task.media_ids`，恢复当前任务与录像队列，不依赖已经关闭标签页的 sessionStorage。

旧版目录没有 `state.json` 时，从有效的 32 位任务 JSON 的 `started_at` 和 `task_id` 恢复最近引用；旧任务缺少 `kind` 时按分析任务处理。仅保存最近任务与最近分析两个引用，不加载原始分数或建立全部历史列表。启动恢复后活动引用仍为空，遗留运行任务继续使用中断失败规则，不自动续算。

分析媒体日志保存于 `tasks/logs/{task_id}/{result_id}.log`。`get_task.media_log` 指向当前或最近录像的日志，各 `task.results[i].media_log` 保留各自路径。失败和取消追加阶段、错误类型和说明；清理音频及预测半成品时保留这些任务级诊断。媒体错误的原始 stderr 因此不会跟未完成的结果目录一起删除。

`get_task.media_log_tail` 返回至多 8 KiB UTF-8 日志尾部，`media_log_truncated` 标记截断。文件读取在任务状态锁外进行，不从请求接受任意日志路径；文件被移除或不可读时正文为空，状态与原始错误仍正常返回。

每个结果的 `prediction.runtime` 保存 `engine_instance_id`、`process_id`、`inference_index`、`model_reused` 和 `reported_by`。真实 BEATs 引擎还报告 `load_count`；`reported_by: engine` 来自实际常驻引擎，`host` 表示受控外部协议夹具的宿主记录。连续录像和后续任务沿用同一引擎，模型配置变化后终止旧进程并重建；取消也结束当前引擎，后续任务可重新启动。耗时变化不作为复用证明。

## 调参和版本

`recompute_candidates` 接受 `{result_id, candidate_version, parameters}`。参数可部分更新，允许 `threshold`、`merge_gap_s`、`before_s`、`after_s`；阈值须在 0–1 内，其余数值为有限非负秒数，布尔值、NaN、Infinity 和未知字段均返回 `invalid_parameters`。

重算直接读取已保存 NPZ，保持 `prediction`、原始分数及预测元数据不变，不启动模型或重复推理。先按事件结束至下一事件开始的间隔分组，再加前后留白；留白重叠不再次合并，持续交火不强制拆分。每次重算生成新的候选版本和候选标识，并重新建立全选的 `selection`。旧版本返回 `409 stale_candidates`，旧预览在读取时被拒绝。无候选也能继续调参。强身份核对和候选处理在任务状态锁外执行，落盘前再次核对版本，避免并发重算覆盖新版本。

## 身份和持久化引用

探测保存解析后的绝对路径、文件大小、纳秒修改时间和完整 SHA-256，策略名为 `sha256-size-mtime-ns-v1`。在 ffprobe／可选包扫描前后分别取完整身份，两者一致才保存媒体记录，避免将旧媒体信息绑定到探测期间替换的新文件；身份读取过程中变化或探测前后不一致均返回 `409 source_changed`，不发布媒体 ID。每次分析接受前、各录像抽取前和结果发布前重新核对；候选重算、预览、预览缓存访问及导出调用同一身份校验。源文件丢失或内容、大小、修改时间改变时要求重新探测和分析。测试包含保持大小与修改时间不变、只替换内容的场景，仍会被完整哈希拒绝。

已有结果同时核对保存的音轨映射与当前媒体记录，并核对模型工作目录、权重、加载脚本、适配器和前处理版本。音轨、模型/权重或前处理改变时返回 `409 analysis_configuration_changed`，要求新分析。模型配置在推理期间改变时也不发布成功结果。后处理参数和请求导出范围不进入预测失效条件。

`prediction.configuration` 保存配置身份，`prediction.cache_key` 覆盖源身份、路径、选定音轨、模型/权重、加载器、适配器、前处理和 schema 版本。当前每次新分析产生独立预测；实现没有把跨任务推理缓存复用作为完成声明。后处理复用的是已经持久化的原始预测。

完整哈希会读取整个源录像和模型文件，有额外 I/O 成本；长录像的性能需要单独记录。身份是核对时点的文件快照，用户仍应避免在处理中同时改写录像。后台哈希每 8 MiB 检查取消信号。

实例默认使用各自的数据目录。目录 `.service.lock` 使用 OS 互斥锁；其他进程打开相同目录时返回 `409 data_dir_locked`。为兼容已有核心只读查看行为，同一进程可以再打开只读实例，`get_config.data_dir_read_only` 为 true，提交修改仍被拒绝。持有者停止后释放锁。

## 取消、停止和中断恢复

`cancel_task {task_id}` 首先返回 `status: cancelling`，状态查询仍可响应。媒体操作和常驻引擎收到取消信号后结束、等待并清理当前半成品，之后才保存 `cancelled` 和 `task_cancelled`。已完成的分析或导出文件及记录保留。看到终态时活动任务位置已经释放，可立即提交下一任务。再次取消终态任务直接返回该任务，不创建新任务。

服务停止调用同一取消路径，结束媒体与模型子进程。已停止的核心实例仅允许读结果与产物，提交修改返回 `503 service_stopping`，不能通过已释放目录的旧实例继续写入。`model_runtime` 的独立 guardian 启动目标进程并观察核心 PID；即使核心被 SIGKILL，guardian 也会结束并等待目标进程。POSIX 使用独立进程组，先 TERM 后升级 KILL；受限宿主若拒绝组信号则退回子进程信号。Windows 实现使用进程句柄检查父进程并通过 `taskkill /T` 清理进程树，尚未在 Windows 实机验收。

IPC 宿主的正常退出与异常死亡不同：宿主仍活时的 EOF／正常退出收敛为 cancelled；真正父进程死亡会由 EOF 分支和 parent watcher 共同检测，传入 `close(interrupted=True)`，清理后保存 failed/service_interrupted，并保留完成产物。停止操作串行化，防止两条清理路径竞态。模型消息管道显式采用 UTF-8，非 UTF-8 locale 下仍保留中文模型错误原因。

重启后，持久化的 `running` 或 `cancelling` 任务变为 `failed`，错误为 `service_interrupted`；没有自动断点续算。没有完成结果记录的当前分析目录以及任务 `pending_paths` 中的未完成文件会清理，已有完整结果继续可读。预览与导出沿用该任务生命周期。

## TDD 与验证

验证于 2026-10-06（Asia/Shanghai）执行。`tests/test_model_tasks.py` 使用公开核心操作、真实 FFmpeg/ffprobe 媒体和外部 NDJSON 模型夹具，不 mock 内部协作者。20 项场景通过，其中十九个新增能力分别经过实际 red → 最小实现 → green；调参间隔、留白与旧版本的补充边界在已有实现上直接通过，没有为已满足行为增加生产代码。

| Slice | 实际 Red | Green 行为 |
|---|---|---|
| 1 | 批量请求缺少单 `media_id` 被拒绝 | 两份已确认录像按序产生独立结果 |
| 2 | 没有候选重算操作 | 不可启动模型的实例也能复用预测调参 |
| 3 | 同大小同时间内容替换仍能重用候选 | SHA-256 核对拒绝旧来源 |
| 4 | 修改检测音轨后仍能重用旧候选 | 音轨变化要求新分析 |
| 5 | 修改权重仍能重用旧预测 | 配置身份失效 |
| 6 | 取消操作不存在 | cancelling → 清理 → cancelled，并可发起新任务 |
| 7 | 第二进程可以打开同一数据目录 | 目录互斥拒绝第二 writer |
| 8 | 重启后遗留任务仍为 running | 中断失败收敛并保留已完成结果 |
| 9 | 结果没有可观察的引擎复用记录 | 批量及后续任务报告同一引擎的第 1/2/3 次推理 |
| 10 | 核心被 SIGKILL 后外部模型 PID 仍存活 | guardian 清理目标，PID 消失 |
| 11 | 批量结果缺少每份录像耗时 | 任务各项及独立结果保留各自阶段耗时 |
| 12 | 停止并释放目录的旧实例仍可修改音轨 | 停止完成后仅保留读取，修改被明确拒绝 |
| 13 | 忙碌时重复提交仍读取已变化源并返回 source_changed | 在全源 I/O 前返回 task_busy，状态查询可响应 |
| 14 | 新连接无法发现活动／最近任务 | 轻量配置引用可发现活动任务，重启保留最近分析和媒体任务 |
| 15 | 分析失败没有可读取媒体日志引用 | 任务级日志保留外部 FFmpeg stderr，并关联逐份分析记录 |
| 16 | 实际 IPC parent 被 SIGKILL 后误写为用户取消 | EOF／parent watcher 标明服务中断失败，完成结果保留且模型 PID 消失 |
| 17 | 查询任务没有日志正文 | 有界尾部显示真实外部工具错误，文件丢失也不破坏失败状态查询 |
| 18 | 探测期间替换文件仍将旧 metadata 与新 SHA 绑定 | 探测前后身份一致才发布媒体 ID，变化返回 source_changed |
| 19 | 旧版有已完成任务但无 state.json，重启无法发现 | 从有效旧任务恢复最近两引用，缺 kind 的旧分析仍可发现 |

```sh
../apex-voice-detect/.venv-pretrainedsed/bin/python -m unittest discover \
  -s tests -p test_model_tasks.py -v
```

原有 `test_model_analysis.py` 12 个确定性场景也通过；未配置真实模型环境时，真实 BEATs 场景明确跳过。HTTP 场景需要允许回环地址绑定。每轮日志及最终 `tasks-19-green.log` 保存在本地忽略目录 `outputs/issue-service-validation/`，不进入 Git；最后身份变更后的 HTTP 探测 14 项定向回归记录为 `probe-invariant-web-regression.log`。非 UTF-8 locale 的中文模型错误另有真实 IPC red/green，见 `ipc-utf8-red/green.log`。

## 真实 BEATs 复用证据

2026-10-06 在 Mac arm64、Python 3.12 的已有模型环境，对 `/Users/jackliu/payload/sample-apex.mp4` 这份 20 秒、960×540、H.264/AAC 实际 Apex 录屏进行了两份独立媒体记录的顺序批量，再提交一次后续任务。三次预测都来自真实 BEATs Strong，引擎报告如下：

| 次序 | engine_instance_id | inference_index | model_reused | load_count | reported_by |
|---|---|---|---|---|---|
| 批量第一份 | `a1de7965ee2947ff9887bbc8562f065a` | 1 | false | 1 | engine |
| 批量第二份 | 同上 | 2 | true | 1 | engine |
| 后续任务 | 同上 | 3 | true | 1 | engine |

三次均生成一段候选；随后调整前留白，预测元数据和同一 `inference_index: 3` 完全保留，没有第四次推理。该证据直接来自引擎输出，不是从耗时推断复用，也没有用夹具冒充真实模型。

该轮逐份分析耗时为 2.825、0.729、0.729 秒；模型加载分别为 1.490 秒、接近零、接近零，推理为 0.380、0.371、0.376 秒。逐份总耗时还包含引擎进程启动、依赖导入、身份校验及保存前处理，不能只加列出的阶段来代替总耗时。

完整任务、原始预测及结果保存在本地忽略目录 `outputs/issue-service-validation/real-engine-c6733561/`；摘要为 `real-engine-reuse.json`，输出为 `real-engine-reuse.log`，可复现脚本为 `real-engine-proof.py`。样本路径及产物不随源码提交；这份 10 月 6 日小样本证据不覆盖 1080p/4K 或模型识别质量，随后真实 4K 与 1080p 证据另列于下文。

## 可复用的 Issue #16 素材验收

`scripts/validate_model_recordings.py` 使用真正的 HTTP 和 NDJSON IPC 入口，分别启动独立服务与数据目录。每个 `--source` 都须按相同顺序提供对应的 `--audio-stream` 容器流索引；脚本校验该流存在，再明确确认，不默认第一轨包含游戏声音。

```sh
../apex-voice-detect/.venv-pretrainedsed/bin/python scripts/validate_model_recordings.py \
  --source /path/to/1080p-gameplay.mkv --audio-stream 2 \
  --source /path/to/4k-gameplay.mp4 --audio-stream 1 \
  --model-workspace ../apex-voice-detect \
  --engine-python ../apex-voice-detect/.venv-pretrainedsed/bin/python \
  --output-dir outputs/issue16-validation
```

例子中的音轨索引仅为命令形式示例，使用者必须先确认自己素材的游戏音轨。`--checkpoint`、`--service-python`、`--ffmpeg`、`--ffprobe` 可显式配置。默认每份录像预览首个候选，`--preview-limit N` 或 `--preview-all` 可增加预览；全部选中的候选始终分别快速复制导出并全量解码。默认首尾各缩小 0.04 秒，用于验证独立请求范围编辑；`--trim-s 0` 保留自动范围。重算沿用分析的 5/5/5 参数值并创建新版本，原始预测保持不变。

脚本保存探测、音轨确认、批量与后续暖任务、原始分析、候选重算、选择、预览、导出、每个文件的 ffprobe 和全量音视频解码记录，以及媒体工具版本、平台和子进程资源观测。批量各录像的阶段耗时和实际引擎复用记录独立保留。原始完整 NPZ 由服务持久化，脚本经公共 `read_scores` 接口逐页比较，不拼接全长矩阵；分数和真实映射时间网格使用绝对容差 `1e-6`、相对容差 `0`，比较类别顺序、原始/重算候选、请求范围及实测复制范围。音轨落在视频时间轴之外的帧不在公共查看范围内，报告明确记录比较帧数和范围，不把该比较写成不可观察部分的证明。

每次运行产生独立的报告目录。成功表示自动流程与双入口比较通过；`manual_review.status` 始终为 `required`，`issue16_complete` 始终为 false。预览及成片内容、请求与实际边界、原录像时间映射、感知音画同步、实际 Electron 播放仍需人工复核。干净机器验收始终标为 `not_evaluated`，不会由脚本伪造确认。缺少 1080p/4K 素材时，分辨率覆盖字段明确为 false。

2026-10-06 的 20 秒、960×540 实际 Apex 样本使用明确音轨 #1 跑通两个入口：447 类、500 帧的全部公开分数差异为 0，类别、映射网格、候选、请求和实际导出范围一致。两个入口各产生一份预览和一份独立导出，四个文件均通过媒体探测与全量音视频解码。初始报告为本地忽略目录 `outputs/issue16-validation/2026-10-06_15-16-15-cea3de58/report.json`，退出清理补充后的复验为 `2026-10-06_15-20-56-9b020f90/report.json`。同一实际样本作为两份独立媒体记录的重复 `--source` 场景也通过，报告为 `2026-10-06_15-17-32-f7b854f6/report.json`；它验证多输入参数及顺序处理，不代表两种素材或不同音轨已获人工验收。

上述新增脚本调用的生产能力已由先前公开边界 TDD 实现，本次只记录真实入口的已有行为。该脚本没有增加内部 helper 测试，也没有为了得到人工 red 改动已通过的核心行为。

## 2026-10-07 真实 4K 双入口技术证据

新提供的 `/Users/jackliu/Downloads/2026-09-11 20-32-49.mkv` 已于 2026-10-06 23:58:12 开始验收，并于 10 月 7 日完成。此前该路径不存在的记录仅表示较早检查时的素材状态。[本次报告](../outputs/issue16-4k-validation/2026-10-06_23-58-12-3dded084/report.json) 为 `technical_status: passed`，保存各入口探测、确认、任务、分析、重算、选择、预览、导出和解码证据，没有重跑或改动生产实现来记录此结果。

来源为 16,823,282,156 字节、3840×2160 的 H.264/AAC 实际录屏，视频范围 0–1293.949 秒。两入口保存相同完整 SHA-256 `5b74ec8fbebf5be1873e694568cc19d3cc13b095b6ecd6e47cb4277060cab758`，身份策略为 `sha256-size-mtime-ns-v1`。本次明确确认容器音轨 #1；该素材只有一条音轨，视频原点、音轨原点及偏移均为 0，不能算作不同真实原点或多音轨录屏验收。

HTTP 与 NDJSON IPC 使用独立数据目录，各自产生 32348×447 原始预测和 34 个 5/5/5 候选。公开 `read_scores` 经 [33 页记录](../outputs/issue16-4k-validation/2026-10-06_23-58-12-3dded084/score-pages.jsonl) 比较全部 32348 帧，类别顺序、分数及真实映射时间网格一致，分数与时间最大差异均为 0，绝对容差 1e-6、相对容差 0；完整 NPZ 仍由各服务保存。重算保持预测，生成新版本后选中全部 34 段、首尾各缩小 0.04 秒，总请求范围 552.880 秒。每个入口预览一段，并独立导出全部 34 段；两份 `evidence.json` 共 70 个文件均通过 ffprobe 与完整音视频解码，解码返回码全部为 0，日志及输出文件均存在。

冷暖复用直接由真实引擎报告。HTTP 的引擎为 `0f2322bc27c74e6db1cab250ee3221d0`／PID 66823，IPC 为 `b31e55c9adf04872b2ca6da289ece96a`／PID 71580；每个入口的冷暖记录分别为 `inference_index: 1/2`、`model_reused: false/true`，相同引擎的 `load_count: 1`，全部 `reported_by: engine`。

| 入口／次序 | 逐份分析总耗时（秒） | 抽取音频 | 加载模型 | 推理 | 后处理 |
|---|---:|---:|---:|---:|---:|
| HTTP 冷 | 57.761 | 5.276 | 1.608 | 33.343 | 8.380 |
| HTTP 暖 | 56.284 | 5.484 | 0.000005 | 34.073 | 8.227 |
| IPC 冷 | 58.014 | 5.340 | 1.676 | 33.335 | 8.434 |
| IPC 暖 | 56.764 | 5.350 | 0.000074 | 34.396 | 8.473 |

总耗时来自各 `results[i]`／`result.analysis`，包括未单列的进程启动、身份核对、保存等工作，不能用阶段相加代替。HTTP 导出准备／导出阶段分别为 29.989／596.168 秒，IPC 为 30.034／626.646 秒；导出过程中仍核对完整来源身份。本次全部双入口、冷暖分析、哈希、预览、导出、全量解码及分页比较耗时 1966.833 秒，约 32 分 47 秒。这是一台现有开发机器处理一份素材的观察，没有据此设定长录像等待上限或发行性能预算。

[资源观察](../outputs/issue16-4k-validation/resource-observation.jsonl) 的硬件为 Apple M6、16 GiB、12 个逻辑 CPU，采样间隔 15 秒，每段不足 5 分钟，只定位该验收 runner 的后代。首段捕获 HTTP 导出，第二段只捕获一次 IPC 暖推理尾部（第 235/258 个窗口）及后续媒体阶段，未采到冷启动／加载峰值。暖尾样本的 IPC 子树 RSS 合计为 621168 KiB（约 606.6 MiB）、CPU 合计为 196.4%，其中模型 RSS 为 583712 KiB；RSS 包含共享页。这不是独占机器基准，可能同时存在的轻量打包任务被排除在观察树外。首个零 PID 样本是解释器大小写匹配错误，日志中的 correction 已说明，不能作为 runner 退出证据。

报告另保存已回收子进程的 `max_rss: 991592448 bytes`，以及 user/system CPU 3403.125／341.207 秒；其范围为回收子进程资源记录，和上述时间点采样不同。两者均不是全机／完整阶段峰值，也不能直接当成安装包资源预算。

本次 4K 自动技术流程已通过；该轮报告的覆盖字段为 `4k: true`、`1080p: false`，只描述该份输入。随后真实 1080p 已提供并完成下述技术对照。报告仍为 `manual_review: required`、`issue16_complete: false`、`clean_machine_acceptance: not_evaluated`；不同真实原点／多轨素材、内容／切点及感知音画同步人工复核、干净 Mac／原生 Windows 尚待验收。这些服务记录不证明模型识别质量或独立安装包的目标平台行为。

## 2026-10-07 真实 1080p HTTP 与既有 native 产物对照

用户提供的实际一小时 H.264/AAC 录像为 1920×1080、1,821,157,547 字节，视频范围 0–3600.366313 秒。源身份 SHA-256 为 `58861bac9ee7ad084811e66913d70bc6e081dc9bc339ac7faa89e2cac3d804c4`；明确音轨 #1，单轨、音视频原点及偏移均为 0。本轮 [HTTP 报告](../outputs/issue16-1080-http-validation/2026-10-07_13-19-34-2bb39223/report.json) 为 passed，权威进程退出 0，全流程 448.303803 秒。

native 基线来自既有正式用户目录中的 result／analysis task `234fec535eef423a9ab9b7dfb0ee3735`、export task `3063efa43c1a4ee0a197ac57a92051da` 及公开 prediction.scores_path，见 [限定快照](../outputs/native-1080-selftest-snapshot/2026-10-07/snapshot.json)。native 首次推理引擎为 `2b89c23cea9040179bd5a82096bac0a7`、inference_index=1、model_reused=false、load_count=1；本轮没有再启动 native 推理、全分页或 GUI 流程。原 native 98 个完整成片另有 [probe／全量解码通过报告](../outputs/1080-native-export-validation/report.json)。

新 HTTP 经共享 Adapter/run_entry 完成一份真实素材的冷分析与后续暖任务，重算沿用 threshold0.2／median3／5/5/5，保持 prediction 并换候选版本；全选 98 段，trim_s=0，不改变默认请求范围。HTTP 与 native 的源身份、音轨映射、参数、候选范围、选择以及每份 requested_range／actual_range／copy mode 一致。HTTP 的首段预览及 98 份独立导出共 99 个文件完整音视频解码均返回 0，见 [evidence.json](../outputs/issue16-1080-http-validation/2026-10-07_13-19-34-2bb39223/http/evidence.json)。

预测比较使用两个服务公开 scores_path 的完整 NPZ 产物：90063×447 概率 max_abs_difference=0、atol=1e-6、rtol=0，class_names／frame_onsets／frame_offsets／window_counts 精确相同。原始音频范围为 3602.5173125 秒，含视频结束后 53 个尾帧；这些帧由产物比较覆盖，不由限制在视频范围内的 read_scores 分页覆盖。此轮读取完整矩阵，没有声明逐页流式读取，也没有把此前 4K 资源观测移作本轮峰值。checkpoint、adapter、loader SHA 与前处理版本一致，配置资源路径不同被记录，不将路径差异当作数值漂移。

HTTP 冷暖使用相同引擎 `a337495ae84d424681202fdbaf37c83b`／PID 88832，inference_index=1→2、model_reused=false→true、load_count=1、reported_by=engine；这些实际记录证明复用，不以耗时变短代替。

| 记录／次序 | 逐份分析总耗时（秒） | 抽取音频 | 加载模型 | 推理 | 后处理 |
|---|---:|---:|---:|---:|---:|
| 既有 native 首次 | 100.424 | 1.743 | 1.648 | 81.139 | 12.997 |
| 新 HTTP 冷 | 100.401 | 1.505 | 1.592 | 81.481 | 13.029 |
| 新 HTTP 暖 | 96.675 | 1.557 | 0.000000292 | 81.268 | 12.955 |

新 HTTP 导出任务 182.045464 秒，其中准备 3.556775 秒、导出 178.485112 秒；原 native 导出记录为 465.939735 秒，准备 12.810678 秒、导出 453.124822 秒。两次运行的时点、资源位置与缓存状态不同，记录这些观察不代表固定加速比或发行预算。

1080p 技术对照已补充，manual_review 仍 required、issue16_complete=false、clean_machine=not_evaluated。该次报告保留 QuickLook unresolved 的历史观察；2026-10-07 用户随后确认其他播放器正常，要求暂缓 macOS 预览／QuickLook 调查，该项不再作为当前阻塞，也未宣称已修复。该单轨零原点素材不覆盖不同真实原点／多轨；完整 GUI／人工内容与切点、另一台干净 Mac、原生 Windows 仍待验收。
