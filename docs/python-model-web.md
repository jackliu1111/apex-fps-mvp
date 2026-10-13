# Python Web：本地录像、音轨与模型分析

对应 Issue #4–#11，父项为 [PRD #3](https://github.com/jackliu1111/apex-fps-mvp/issues/3)。现已接入逐份录像／音轨确认、顺序批量分析、调参、候选勾选／范围编辑、按需预览、独立快速导出、取消和中断恢复。模型契约见 [分析说明](python-model-analysis.md)，批量、强身份核对与恢复见 [任务生命周期](python-model-lifecycle.md)，预览与实测导出范围见 [复核与导出](python-model-review.md)。

遵循 [纯音频范围](adr/0001-audio-model-first.md) 与 [共享 Python 核心、双入口](adr/0002-shared-python-engine-dual-hosts.md) 的 accepted 决定；术语沿用 [CONTEXT.md](../CONTEXT.md)。不会运行截图、HUD/OCR 或图像识别，也不会修改既有伤害和 RMS 模式。

## 启动与使用

录像探测仅需 Python 3.10+ 标准库和本机 FFmpeg/ffprobe；该路径不加载模型。完整分析要求服务环境有 NumPy、模型进程环境有 `scripts/requirements-audio-inference.txt` 的依赖，并已准备模型代码与本地权重，不需要 Electron、Bun 或 Node。

在项目根目录启动，例如当前 Mac 的 Python 3.12：

```sh
../apex-voice-detect/.venv-pretrainedsed/bin/python model_web.py \
  --model-workspace ../apex-voice-detect \
  --checkpoint ../apex-voice-detect/checkpoints/BEATs_strong_1.pt \
  --ffmpeg /opt/homebrew/bin/ffmpeg \
  --ffprobe /opt/homebrew/bin/ffprobe \
  --data-dir outputs/python-web \
  --port 8769
```

Python 可执行文件和媒体工具路径按本机环境替换。媒体工具参数省略时从 PATH 查找；找不到可执行文件会拒绝启动。`--model-workspace` 与 `--checkpoint` 可省略，页面将显示未配置；只给工作目录时，默认权重为其 `checkpoints/BEATs_strong_1.pt`。权重存在只表示文件可见，不表示权重、推理依赖或模型质量已经通过验证。首次分析在后台加载模型，加载失败写入任务终态。服务也可使用项目 Python 环境，并通过 `--engine-python` 指定独立推理环境。

启动打印 `Python Web: http://127.0.0.1:8769/#token=...`。使用该完整地址打开页面，令牌由页面保存在当前标签页的 sessionStorage 中，并从地址栏移除。

1. 粘贴完整本地录像路径，或使用“浏览本机目录”选择文件。
2. 点击“探测录像”，查看视频尺寸、编码、有效时长，以及音轨标题、语言、编码、声道、采样率和起点。
3. 明确选择包含游戏声音的音轨，点击“确认音轨”。所有音轨，包括单音轨录像，都需要明确确认；默认没有选择。
4. 刷新当前标签页会读取上次媒体记录；新一次探测创建新的媒体 ID，并重新要求确认音轨。
5. 继续加入其他录像，逐份确认音轨；开始分析列表中的录像，查看当前录像、阶段、进度、耗时和日志。任务与结果在刷新后可恢复，关闭页面不取消任务。
6. 在各录像结果间切换，调整阈值、间隔或留白重算候选；新版本重新预选并提示复核。编辑请求范围和勾选状态并保存，不改原始预测和自动候选。
7. 请求单段预览并定位播放；选择输出目录，将所选片段各自快速复制导出。查看逐文件状态、路径、请求／实测范围并播放成片。复制可能从前一个关键帧开始，不代表精确切点。
8. 活动分析、预览或导出可取消，清理完成后显示 cancelled。按 Ctrl+C 停止服务会清理相关子进程；异常中断后重启将遗留活动任务标为失败，已完成结果保留。

页面只发送路径与音轨索引，录像和音频不上传。ffprobe 的输入协议限定为本地 `file,pipe`，防止本地播放列表引入网络媒体。按 Ctrl+C 停止服务。当前入口使用 `model_web.py`；旧性能原型启动器已移除，历史复现见 [封存说明](archive-version0.md)。

安装项目包后也可运行 `apex-model-web`；标准源码启动不要求先安装整个项目。

## 共享逻辑操作与 HTTP 映射

`ModelService.execute(operation, request)` 是公开的共享核心边界。HTTP 层负责访问校验、请求适配和返回结构；`model_web_ui/transport.js` 将界面的逻辑操作映射为 HTTP 或 Electron preload IPC。桌面入口复用同一核心，见 [桌面入口](desktop-model.md)。

| 逻辑操作 | HTTP | 请求 |
|---|---|---|
| `get_config` | `GET /api/config` | 无 |
| `browse` | `GET /api/browse?path=...` | `path` 为本机目录，可省略并使用用户主目录 |
| `probe_media` | `POST /api/probe` | `{"path":"/本机/中文 录像.mkv"}` |
| `confirm_audio` | `POST /api/confirm-audio` | `{"media_id":"...","stream_index":2}` |
| `get_media` | `GET /api/media/{media_id}` | 媒体记录 ID |
| `analyze` | `POST /api/analyze` | `{"media_id":"..."}` 或 `{"media_ids":["...","..."]}`；全部音轨须已确认，返回 202 和 task_id |
| `get_task` | `GET /api/tasks/{task_id}` | 任务状态与结果引用；忙碌时新分析返回 409 task_busy |
| `get_result` | `GET /api/results/{result_id}` | 模型／时间元数据、事件、候选和预测引用 |
| `read_scores` | `GET /api/scores/{prediction_id}?start_s=0&end_s=20` | 原录像时间范围；每页最多 1000 帧，用 next_start_s 继续读取 |
| `recompute_candidates` | `POST /api/recompute-candidates` | result_id、candidate_version、parameters；返回新版本结果 |
| `update_selection` | `POST /api/update-selection` | result_id、candidate_version、clips；每项含 candidate_id 及可选 selected／start_s／end_s |
| `request_preview` | `POST /api/preview` | result_id、candidate_version、candidate_id；返回 202 和 task_id，完成任务提供 preview_id |
| `get_artifact` | `GET /api/artifacts/{artifact_id}` | 已注册预览或成片的元数据；旧预览、变化素材被拒绝 |
| 媒体读取 | `GET /api/artifacts/{artifact_id}/content` | 支持单 byte Range 和 206；可使用仅此路径有效的 token 查询参数供 video 播放 |
| `export` | `POST /api/export` | result_id、candidate_version、output_dir、可选 mode: copy；返回 202 和 task_id，任务含逐文件 exports |
| `cancel_task` | `POST /api/cancel` | task_id；先返回 cancelling，结束与清理后才能查询到 cancelled |

所有逻辑 API 都需要 `X-Apex-Token`；只有注册媒体内容路由额外接受 token 查询参数，不可用它调用分析或修改操作。默认仅绑定 `127.0.0.1`，Host 必须等于实际回环地址与端口；提供 Origin 时必须是同一来源。没有 Origin 的受控脚本调用仍须有正确 Host 和令牌。页面静态资源可以无令牌读取，但也受 Host／Origin 限制；没有开放 CORS。响应使用 no-store、no-referrer 和只允许本机资源的 CSP。POST 限制为 64 KiB JSON 请求，不接受媒体上传。

## 媒体记录与时间契约

结果 `schema_version` 为 1。时间以有限浮点秒数表示，候选流程使用的视频相对时间零点为所选视频流的 `start_time_s`。媒体记录包含：

- `media_id`：32 位十六进制标识；每次探测生成新记录。
- `source.path`：解析后的绝对本机路径。
- `duration_s`：所选视频流的有效时长，而非带原点偏移的容器总时长。
- `video`：流索引、编码、尺寸和视频时间原点；排除封面图流，使用第一个普通视频流。
- `audio_tracks`：可识别编码、正声道数与正采样率的音轨；`stream_index` 是容器流索引，不是列表位置。未命名音轨使用空标题、缺省语言使用 `und`。
- `selected_audio`：探测时为 `null`；确认后保存所选流和下列映射。

例如音频原点为 3.25 秒、视频原点为 3.00 秒：

```json
{
  "stream_index": 1,
  "video_origin_s": 3.0,
  "audio_origin_s": 3.25,
  "audio_to_video_offset_s": 0.25
}
```

`video_relative_s = audio_relative_s + audio_to_video_offset_s`。偏移可正可负；这里记录容器时间原点映射，尚未证明感知音画同步。后续抽取必须使用已确认的容器流索引，并沿用该映射。

优先读取视频流时长；没有流时长时读取视频包的 PTS 与包时长计算视频终点，使用磁盘临时文件避免大录像的包列表常驻内存。该回退会扫描录像，可能比元数据探测慢。元数据探测超时为 30 秒，包扫描为 60 秒；无法可靠确定时间戳或时长时返回错误，不猜测零点。

记录写入 `{data_dir}/media/{media_id}.json`，确认时原子更新，通过 `get_media` 读取。重启服务不会丢失已确认音轨；服务令牌每次重新生成。媒体身份现保存大小、纳秒修改时间与完整 SHA-256，分析、重算、预览和导出核对源身份、音轨与模型配置。多个服务实例应配置不同的数据目录；相同目录有跨进程互斥，重启将遗留活动任务标为中断失败。策略、额外 I/O 成本和测试证据见 [生命周期说明](python-model-lifecycle.md)。旧记录缺少完整身份时须重新探测和分析。

## 错误契约

HTTP 返回 `{"error":{"code":"...","message":"可读说明"}}`，核心抛出携带相同 code 与 status 的 `ServiceError`。

| HTTP | code | 含义 |
|---|---|---|
| 400 | `invalid_request` | JSON／字段不合法 |
| 401 | `unauthorized` | 缺失或错误令牌 |
| 403 | `invalid_host` / `invalid_origin` | 非允许地址／来源 |
| 404 | `not_found` / `media_not_found` | 未知操作或媒体记录 |
| 413 | `request_too_large` | 请求超出配置大小 |
| 422 | `invalid_path` | 无效路径、不是文件／目录 |
| 422 | `unreadable_media` | 不可读、损坏、不支持的媒体或不可靠时间信息 |
| 422 | `not_video` | 没有可用视频流 |
| 422 | `no_audio` | 没有可用音轨 |
| 422 | `invalid_audio_track` | 未明确选择、错误索引或非整数 |
| 503 | `media_tool_unavailable` | 配置的媒体工具或记录目录不可用 |

## Issue #4 验证记录

验证日期：2026-10-05（Asia/Shanghai），macOS arm64、Python 3.12。

沿用 PRD #3 中用户于 2026-10-03 确认的逻辑服务操作测试边界。每个新增行为先写测试、运行得到失败，再实现最小路径并通过；测试通过 HTTP 或核心公开操作观察结果，不 mock 内部模块。音轨、时长和偏移的预期值来自夹具规格。

`tests/test_model_web.py` 包含 14 个场景：中文／空格路径与双音轨信息、确认后重启读取、无效媒体、非法音轨／媒体标识、令牌／Host／Origin、目录浏览、显式配置、格式／路由错误、第二音轨选择、独立启动、离线资源、缺失／非有限时间戳、不可用音频流以及媒体工具丢失。

```sh
python3.12 -m unittest discover -s tests -p test_model_web.py -v
```

测试需要 PATH 中有 FFmpeg/ffprobe，并允许测试进程在回环地址绑定临时端口。确定性媒体由真实 FFmpeg 生成：1 秒视频、两个音轨，视频原点 3 秒，游戏音轨原点 3.25 秒；覆盖 +0.25 秒映射。异常元数据场景仅替换外部 ffprobe 可执行文件的响应。独立入口使用 `python -S` 并隐藏 PATH 中的其他运行时，证明探测不依赖第三方 Python 包、Bun 或 Node。

已进行浏览器复核：粘贴与目录选择、无预选时确认按钮禁用、确认游戏音轨、刷新恢复、重新探测后要求重新确认、窄屏排版。现有 `sample-apex.mp4` 的 20 秒 H.264/AAC 录像也完成了真实探测与音轨确认。截图位于本地忽略目录 `outputs/issue4-validation/confirmed-audio.jpg`，该目录不随源码提交。

完整 Python 回归 58 项通过，其中新增服务场景 14 项。Python wheel 已构建并核对启动入口与 HTML/JS/CSS 资源。浏览器 JS 经语法／打包检查，但运行直接提供源码模块，不需要 Bun 构建。

这些证据覆盖 #4 的输入准备，不构成模型识别质量、完整分析／导出、Electron 一致性、感知同步或 Windows/Mac 安装包验收。
