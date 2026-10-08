# Python Web：真实模型分析与 5/5/5 枪声候选

对应 [Issue #5](https://github.com/jackliu1111/apex-fps-mvp/issues/5)，基于 #4 的录像探测与音轨确认。父项为 [PRD #3](https://github.com/jackliu1111/apex-fps-mvp/issues/3)，遵循 accepted ADR 0001、0002。当前交付一份已确认音轨录像的后台分析、状态查询、完整预测保存及候选／分数展示。

## 运行与公开边界

从项目根目录运行 `sh scripts/start-python-model-web.sh`，打开日志中的完整访问地址。该脚本默认使用相邻 `apex-voice-detect/.venv-pretrainedsed/bin/python` 和工作目录；可通过 `APEX_MODEL_WORKSPACE`、`APEX_ENGINE_PYTHON` 覆盖，并透传 `--checkpoint`、`--ffmpeg`、`--ffprobe`、`--data-dir`、`--port` 等服务选项。旧 `start-model-service.sh` 仍用于历史性能原型。

完整分析需要已准备的本地权重、模型工作目录的 `scripts/infer_apex_audio.py` 与 `PretrainedSED` 代码，以及 `scripts/requirements-audio-inference.txt` 对应的模型环境。服务端需要 NumPy；可用项目 Python 启动 HTTP 服务，并通过 `--engine-python` 指定独立模型环境。无需 Electron、Bun 或 Node；单独探测路径仍可在标准库 Python 中运行。

沿用用户于 2026-10-03 在 PRD 确认的“逻辑服务操作”测试边界。本次测试公开的 `analyze`、`get_task`、`get_result`、`read_scores`，通过 HTTP 或 `ModelService.execute` 观察任务与结果；不建立内部函数测试边界。具体 HTTP 映射见 [入口说明](python-model-web.md)。

`analyze` 需要已确认音轨，返回 `202 {"task_id":"..."}`。共享核心从接受请求时起保留活动任务位置，忙碌时拒绝新执行请求：HTTP 409、`task_busy`，不排队。核心边界与 HTTP 入口共用此语义，后续 IPC 可直接复用。

任务状态为 `running`、`completed` 或 `failed`。阶段区分 `extracting_audio`、`model_loading`、`inference`、`postprocessing`；查询返回当前阶段进度、总耗时、已完成阶段耗时、最近 200 条阶段日志和结果引用。完整模型诊断另存于 `{data_dir}/model-worker.log`，FFmpeg 日志在对应结果目录的 `media.log`。后台线程执行媒体操作；独立常驻模型进程通过结构化 NDJSON 交换消息，模型诊断写 stderr。状态查询不会等待模型加载或推理。

未确认音轨返回 `audio_not_confirmed`；未知任务／结果返回 404 `task_not_found`／`result_not_found`；非法分数查看范围返回 `invalid_range`。后台失败写入任务终态，分别使用 `model_load_failed`、`model_inference_failed`、`media_failed`，不附成功结果。

## 模型、时间和候选契约

- 实际基线为 `BEATs_strong_1`，CPU、4 threads，447 类，类别顺序来自上游 AudioSet Strong 配置。保存权重 SHA-256、加载脚本与适配器 SHA-256、前处理版本和实际依赖版本。
- FFmpeg 只抽取已确认的容器流索引，转为 16 kHz 单声道 PCM。模型输入 160,000 samples（10 秒），窗口步长 80,000 samples（5 秒）。前处理版本为 `beats-16k-mono-10s-5s-mean-v1`。
- 单窗 sigmoid 概率转为 `[250,447]`；重叠窗口在相同 40 ms 网格上取概率算术平均。原始结果保存为 float32 的“时间 × 类别”矩阵，不保存阈值化后的替代分数。
- 有效帧数为真实音频采样数除以 640 的向上取整；最后一帧终点截到实际采样数。尾窗零填充可能影响模型分数，但填充时间不进入有效预测。保存真实采样数、窗口数、尾窗填充数及每帧窗口覆盖次数。
- 原始 NPZ 使用音频相对时间，元数据保留已确认的音／视频原点与偏移。公开分数、事件与候选使用 `audio_relative_s + audio_to_video_offset_s` 映射到原录像视频时间轴；事件与候选裁到视频有效范围。
- 候选事件来自 `Gunshot, gunfire` 和 `Machine gun`：分别对原始类分数应用 3 帧中值平滑（reflect 边界），严格 `>0.2` 判定；对两类的有效时间活动取并集，得到统一事件序列并保存涉及的类别。0.2 是开发基线，未经过 Apex 质量／阈值优化评估。
- 按上一事件结束到下一事件开始的间隔 `≤5` 秒分组，再前后各留 5 秒，最后裁界。不强制拆持续交火，不因不同组的留白重叠再次合并。候选有独立版本及标识，并关联来源事件。

页面展示阶段、耗时、模型／权重／前处理版本、候选编号／起止／时长，以及原始两类分数曲线与逐帧表格。明确显示“枪声候选不代表本人开枪、命中或击杀”；无候选仍保留完整预测并给出提示。

## 保存和范围读取

```text
{data_dir}/
  media/{media_id}.json
  tasks/{task_id}.json
  model-worker.log
  results/{result_id}/
    audio.wav
    media.log
    scores.npz
    prediction.json
    result.json
```

每次分析使用新 ID 与独立目录，保存后通过原子替换更新 JSON；不改源录像、不覆盖已有分析。`scores.npz` 包含完整 `probabilities`、`class_names`、`frame_onsets`、`frame_offsets`、`window_counts`；`prediction.json` 独立保存模型和时间元数据，`result.json` 保存关联预测的事件与候选。任务查询和结果查询不携带完整分数。

分数读取要求 `0 ≤ start_s < end_s ≤ video_duration_s`，拒绝 NaN、Infinity 和缺失／非数值范围。返回与查看范围相交的原始帧及其真实时间，每页最多 1000 帧，类别顺序与原始结果相同。`next_start_s` 非空时用它继续读取同一结束范围；空值表示已读完。分页不会丢弃持久化帧，也不做显示采样。当前 NPZ 在服务内读取时会解压数组，超长录像的内存与范围读取性能仍需后续评估。

正常完成的任务、结果和原始分数可在重启后继续通过公开操作读取。刷新当前浏览器标签页从 sessionStorage 恢复任务引用；重启服务会换令牌，需使用新的完整启动地址。改变录像路径时清除当前页面的旧结果展示。

## TDD 记录（2026-10-05，Asia/Shanghai）

每轮按一个行为先写测试、实际运行检查失败，再实现对应路径。未一次写完全部测试或一次补完全部实现；没有对内部协作者打补丁，受控模型输出由外部模型进程协议夹具提供。

| 顺序 | Red 的可观察失败 | Green 的行为 |
|---|---|---|
| 1 | 分析路由返回 404，无法给出音轨确认错误 | 未确认音轨被明确拒绝 |
| 2 | 已确认录像提交时连接中断，缺少后台任务 | 可查询的模型配置失败任务，返回 202 |
| 3 | 缺少模型进程配置与结果操作 | 完整分数持久化、跨类别事件并集、+0.25 秒映射和重启读取 |
| 4 | 忙碌时仍接受第二个任务 | 409 task_busy；受控等待期间查询可响应 |
| 5 | 真实模型进程尚未实现，任务失败 | 本地 BEATs 实际运行，19 帧／447 类与 0.75 秒有效长度 |
| 6 | 非法范围导致异常或返回无约束分数 | 核心与 HTTP 返回 invalid_range |
| 7 | 没有分页引用、单次返回全部帧 | 1000 帧一页，第二页恢复剩余帧 |
| 8 | 非有限模型分数仍发布成功结果 | 模型分数无效时失败，不发布候选 |
| 9 | 列表类型任务 ID 触发 TypeError | 畸形与未知 ID 返回统一 404 契约错误 |

恰好 5 秒分组、4.96／5.04／7 秒间隔、首尾裁界、留白重叠、近 50 秒持续交火、无枪声候选、加载／执行错误等补充场景在已有最小实现上直接通过，没有为这些已满足的行为添加额外生产代码。

`tests/test_model_analysis.py` 有 13 个分析场景，其中真实 BEATs 场景需显式设置本地环境；未设置时该一项跳过，不能把受控分数夹具当成真实模型验收。

```sh
APEX_REAL_MODEL_WORKSPACE=/path/to/apex-voice-detect \
APEX_ENGINE_PYTHON=/path/to/apex-voice-detect/.venv-pretrainedsed/bin/python \
python -m unittest discover -s tests -v
```

测试 Python 需安装项目测试依赖；媒体兼容场景使用真实 FFmpeg／ffprobe，HTTP 场景需要允许回环绑定。最终完整 Python 回归 **71 项通过，无跳过**；真实模型使用独立已有环境，未安装或替换上游模型依赖。JS 打包语法检查、启动脚本语法检查及 Python wheel 构建通过；wheel 已核对含常驻模型进程、共享核心和全部静态资源。

## 真实录像证据

当前 Mac arm64 的本地 20 秒、960×540、30 FPS H.264/AAC Apex 样本，通过正式启动器和浏览器执行探测 → 确认音轨 → 真实分析 → 分数／候选查看。最终任务 `d00250513d344a81be5fb93dedeeec2f` 正常完成：

| 项目 | 观测值 |
|---|---|
| 总耗时 | 2.344 秒，包含模型进程启动／依赖导入和结果保存 |
| 抽音频 / 模型加载 / 推理 / 后处理 | 0.039 / 1.450 / 0.365 / 0.004 秒 |
| 覆盖 | 320,000 samples，3 个窗口，500 × 447 帧分数，无时间网格缺口 |
| 时间轴 | 0–20 秒，音／视频原点均为 0，所有分数有限 |
| 事件与候选 | 2 条事件、1 段候选；候选 0–11.080 秒 |
| 权重 SHA-256 | db13a79ae90a0cfd0f9911a6a1d8cdb89324322bee642dcfe32de022123b8b54 |

本地忽略目录中的证据：[摘要](../outputs/issue5-validation/summary.json)、[任务](../outputs/issue5-validation/tasks/d00250513d344a81be5fb93dedeeec2f.json)、[预测元数据](../outputs/issue5-validation/results/d00250513d344a81be5fb93dedeeec2f/prediction.json)、[完整分数](../outputs/issue5-validation/results/d00250513d344a81be5fb93dedeeec2f/scores.npz)、[结果](../outputs/issue5-validation/results/d00250513d344a81be5fb93dedeeec2f/result.json)、[页面截图](../outputs/issue5-validation/browser-result.png)、[完整回归日志](../outputs/issue5-validation/regression.log)。这些产物不进入 Git。

浏览器已检查音轨确认前分析按钮禁用、真实任务进度／完成状态、候选与分数、刷新恢复；窄屏文档宽度与视口一致，没有页面横向溢出。

本次历史记录满足 #5 的模型分析与候选展示范围，不构成识别质量、长录像／1080p／4K 性能、感知同步、Electron 一致性或安装包验收。2026-10-06 后续实现已接入批量顺序、调参、源媒体身份、取消及中断恢复，见 [生命周期与新增 TDD 记录](python-model-lifecycle.md)；候选选择、预览及独立导出通过同一共享任务核心实现，后续验收应按相应记录核对，不能沿用本文的 #5 范围作完整闭环证明。
