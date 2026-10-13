# FilmCraft 与 LosslessCut：AI 连续草稿接入源码笔记

历史研究记录：保留本次调查时的事实、判断与验证范围；其中的优先方向和待验证项不自动代表当前状态。当前原型接入情况见 [FilmCraft 原型说明](../../integrations/filmcraft/README.md)，最新交互范围见 [AI 识别与选片方案](ai-recognition-workspace.md)。

日期：2026-10-13。范围固定为 FilmCraft **v0.7.2** 与 LosslessCut **v3.69.0**。本文只记录官方文档、公开源码和只读版本核查；**不包含运行、播放、导出、性能或媒体兼容性实测结论**。本轮本机 `/Applications/FilmCraft.app/Contents/Info.plist` 显示 0.7.2；LosslessCut 的 `app.asar/package.json` 显示 3.69.0。版本号相同不代替发行包与源码的逐字节核验。

## 本次比较对应的需求

AI 事件保留在独立证据层；一键把候选按原片顺序排列、去掉空隙与重叠重复，形成单一连续剪辑轨道。例如原片的两段 20 秒和 30 秒组成约 50 秒草稿。保存 AI 原始草稿，再复制供人工删段、调边界、从原片补段，复核后导出。此范围来自本轮产品讨论，不把旧方案中的“分别导出独立片段”当作新需求。

## 与核心需求直接相关的对照

| 需求 | FilmCraft v0.7.2 | LosslessCut v3.69.0 |
| --- | --- | --- |
| 原片时间与成片时间分离 | `TrackItem.start` 为 sequence ticks，`source_in` 为媒体首帧时间；`timeline.place` 分别接收成片位置与源范围。[数据模型](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/project/src/lib.rs#L511-L521)、[放置实现](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/commands.rs#L794-L854) | 时间轴位置、鼠标定位、缩略图和播放头按原片 `fileDurationNonZero` 计算。选段保持源 start/end，未提供累计选段时长的成片坐标。[时间轴](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/renderer/src/Timeline.tsx#L160-L176)、[鼠标定位](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/renderer/src/Timeline.tsx#L250-L256) |
| 顺序连续编辑 | `timeline.place`、`timeline.trim` regular/ripple、`edit.rippleDelete`、插入式放置已有命令。[place](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/commands.rs#L2479-L2490)、[trim](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/commands.rs#L2539-L2556)、[rippleDelete](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/commands.rs#L1612) | 能在原片时轴拆分、删选段、改边界，并在右侧列表调整合并顺序；这不是成片时轴的删段后前移或连续轨道编辑。[官方工作流](https://github.com/mifi/lossless-cut/blob/v3.69.0/docs/index.md#usage-typical-workflow) |
| 草稿预览 | 有序列、Program/Source monitor 与播放控制；命令按序列读帧，真实长录屏的连贯播放待实测。[控制协议](https://github.com/storytold/filmcraft/blob/v0.7.2/docs/control-protocol.md)、[序列检查与读帧](https://github.com/storytold/filmcraft/blob/v0.7.2/docs/agents.md#tools) | 已有选段顺序播放：到段末后 `seekAbs(nextSelectedSegment.start)` 跳至下一源区间。不能据此称为无缝、精确到导出边界的成片预览。[播放代码](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/renderer/src/App.tsx#L670-L711) |
| 保存草稿副本 | `.fcproj` 存序列/轨道/片段/标记；有 `file.save`、`file.saveAs`、`file.saveCopy`。另有项目项 `edit.duplicate`，适用于序列类型，详见下节。[保存](https://github.com/storytold/filmcraft/blob/v0.7.2/docs/project-files.md#commands)、[复制](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/commands.rs#L1645-L1658) | `.llc` V2 存单源选段 start/end/name/tags/selected；可保存不同项目文件，但原生项目不是 FilmCraft 式多序列草稿结构。[项目类型](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/renderer/src/types.ts#L23-L53) |
| AI 事件显示与追溯 | 可复用 source/program 标记，但原生 Marker 没有模型版本、候选版本、分数、审核状态字段。[marker 命令](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/commands.rs#L2286-L2307)、[Marker 结构](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/project/src/lib.rs#L479-L487) | 标记/选段和字符串 tags 可携带名称、关联 ID；未提供本项目所需独立 AI 分数轨或候选版本关系。[标记说明](https://github.com/mifi/lossless-cut/blob/v3.69.0/docs/index.md#markers)、[项目类型](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/renderer/src/types.ts#L23-L53) |
| 单文件导出 | 有序列渲染编码导出，格式、尺寸、帧率、范围和硬编码策略可配置；该路径不能等同 FFmpeg stream-copy。[导出命令](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/commands.rs#L1551-L1559) | `Merge cuts` 可把选段合成单文件，列表顺序决定合并顺序；无损切点仍有关键帧限制。[官方工作流](https://github.com/mifi/lossless-cut/blob/v3.69.0/docs/index.md#usage-typical-workflow)、[精度限制](https://github.com/mifi/lossless-cut/blob/v3.69.0/docs/troubleshooting.md) |

以上是接口和数据模型的匹配关系，不是稳定性排名。FilmCraft 官方将 v0.7.2 标为 alpha，真实素材与 Windows/Linux 测试仍有限；LosslessCut 官方明确其定位介于线性与非线性编辑器之间，复杂工作流需要拆成多个操作。[FilmCraft 状态](https://github.com/storytold/filmcraft/blob/v0.7.2/README.md#status)、[LosslessCut FAQ](https://github.com/mifi/lossless-cut/blob/v3.69.0/docs/index.md#faq)。

## FilmCraft：启动与用户数据隔离

桌面程序语法为 `filmcraft [options] [project.fcproj | media files...]`。**桌面程序没有 `--project` 参数**；`--project` 属于独立 `filmcraft-cli` 的选项。桌面可用位置参数打开工程，或启动后执行 `file.open {path}`。[桌面参数](https://github.com/storytold/filmcraft/blob/v0.7.2/apps/filmcraft/src/args.rs#L6-L26)、[CLI 用法](https://github.com/storytold/filmcraft/blob/v0.7.2/docs/agents.md#2b-command-line-interface)。

```text
/Applications/FilmCraft.app/Contents/MacOS/FilmCraft \
  --control 9876 --empty --no-recover \
  --data-dir /absolute/path/to/isolated-filmcraft-data
```

- `--control <port>`：启用回环地址 JSON-lines 服务，也支持 `FILMCRAFT_CONTROL_PORT`。
- `--data-dir <dir>` / `FILMCRAFT_DATA_DIR`：指定自动保存、恢复与日志数据目录；项目文档说明偏好设置等持久化也使用该数据目录。
- `--empty`：覆盖启动偏好，打开空项目；`--no-recover`：不提示恢复先前未保存工作。
- 可选 `--control-input-only`：仅接收控制通道的 widget 输入，要求已启用 control；它不等于只读模式。

来源：[参数解析与测试](https://github.com/storytold/filmcraft/blob/v0.7.2/apps/filmcraft/src/args.rs#L63-L117)、[数据目录](https://github.com/storytold/filmcraft/blob/v0.7.2/docs/project-files.md#crash-recovery)、[控制通道输入](https://github.com/storytold/filmcraft/blob/v0.7.2/docs/control-protocol.md#desktop-control-channel)。没有在本文中运行上述命令。

控制通道每行一个 JSON 对象、每行一份回复：

```json
{"id":1,"method":"engine.execute","params":{"command":"sequence.inspect","params":{}}}
```

`engine.commands` 可查询实际命令注册表，`ui.inspect` 查询界面/播放状态，`ui.playback` 接收 `action: play|stop|toggle`。应用与 CLI/MCP 共用命令系统，但 UI 专属能力必须由桌面端执行。[协议](https://github.com/storytold/filmcraft/blob/v0.7.2/docs/control-protocol.md#desktop-control-channel)。

## FilmCraft：最小创建、剪辑、保存链路

下表是放入 `engine.execute` 的 `command` 与 `params`。ID 必须使用前序真实返回值；路径使用本轮测试目录。所有候选源时间必须来自同一输入录像，不能借用另一份录像的旧缓存。

| command | params 示例与返回 |
| --- | --- |
| `file.newProject` | `{ "name": "AI review" }`。创建空项目，重置当前会话历史；不要在包含用户未保存工作的会话中调用。[实现](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/commands.rs#L1092-L1105) |
| `file.newSequence` | `{ "name": "AI draft", "width":3840, "height":2160, "fps":60, "sampleRate":48000, "video":1, "audio":1, "mix":"Stereo" }` → `{ "sequence": id }`，新序列自动成为活动序列。[参数](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/commands.rs#L1125-L1131)、[设置与返回](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/commands.rs#L1144-L1205) |
| `file.import` | `{ "paths":["/absolute/source.mkv"] }` → `{ "items":[id], "errors":[] }`，某些输入还有 sequences/documents/ingest。必须核对 errors，而非只看调用返回成功。[注册](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/commands.rs#L1284)、[结果](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/commands.rs#L1370-L1384) |
| `timeline.place` | `{ "item": sourceId, "track":"V1", "audioTrack":"A1", "seconds":0, "sourceIn":sourceStartTicks, "duration":lengthTicks, "insert":false, "video":true, "audio":true }` → `{ "clips":[ids] }`。下一段用累计成片位置，例如 `seconds:20`。[schema](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/commands.rs#L2479-L2490) |
| `sequence.inspect` | `{}`：核对轨道、片段 start/end/sourceIn/sourceOut、帧数、声画 link 与总 durationFrames。[文档](https://github.com/storytold/filmcraft/blob/v0.7.2/docs/agents.md#tools)、[输出实现](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/commands.rs#L4144-L4155) |
| `file.save` | `{ "path":"/absolute/ai-draft.fcproj" }`。其他保存语义见下节。[文档](https://github.com/storytold/filmcraft/blob/v0.7.2/docs/project-files.md#commands) |

时间单位为每秒 **254,016,000,000 ticks**。`timeline.place` 的目标位置可用 `time` ticks / `seconds` / `frame`，但 `sourceIn` 和 `duration` 接受整数 ticks。放置起点和终点分别吸附序列的最近帧，因此适配层应依据放置后的实际帧边界继续排列，不能假设任意浮点秒数总能无误差相加。[时间说明](https://github.com/storytold/filmcraft/blob/v0.7.2/docs/control-protocol.md#mcp)、[range 与吸附代码](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/commands.rs#L844-L854)。

`timeline.place {items:[...]}` 支持项目项首尾相接且形成一个 undo step，但该模式禁止同时传 `sourceIn` 或 `duration`；同一长录像的不同候选范围不能直接塞进这个批量参数。可以逐段放置，或先生成合适的子剪辑；“一键生成整个 AI 草稿且一次撤销”仍需要选择正确的组合/事务边界。[批量放置实现](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/commands.rs#L857-L891)。

## FilmCraft：草稿复制与 AI 关联边界

- `file.saveAs {path}` 写出并切换当前项目路径；`file.saveCopy {path}` 写副本但保留当前路径和 dirty 状态。两者均是完整项目文件操作。[保存文档](https://github.com/storytold/filmcraft/blob/v0.7.2/docs/project-files.md#commands)。
- 没有在已核查命令注册表中发现独立的 `sequence.duplicate`；可先 `project.select {items:[sequenceId]}`，再 `edit.duplicate {}`。它克隆所选项目项的 `ItemKind`，返回新 `items`，之后用 `sequence.open {item:newId}` 打开副本。`ItemKind::Sequence` 为 `Arc<Sequence>`，修改时写时分离；因此有复制序列的代码路径。[选择](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/commands.rs#L3121-L3125)、[复制](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/commands.rs#L1645-L1658)、[打开](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/commands.rs#L1912-L1922)、[序列结构](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/project/src/lib.rs#L265-L270)。
- 复制实现只传 name、label 和 kind 给 `add_item`，而 `add_item` 将新条目的 `metadata` 初始化为空。因此不能假定挂在项目项 metadata 上的 AI 关联信息自动传到草稿副本。复制后的内部片段 ID、项目 item ID 与 AI 关联映射应单独读回验收。[复制](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/commands.rs#L1645-L1658)、[新条目](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/project/src/lib.rs#L1366-L1370)。
- `markers.add` 可选择 `target: "source"` 或 `"program"`，参数包含时间、名称、comment、颜色和 durationFrames。原始 Marker 只有 id/start/duration/name/comment/kind/color；不能把一条普通 marker 自动解释为稳定的 AI 证据对象。[命令](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/commands.rs#L2286-L2307)、[结构](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/project/src/lib.rs#L479-L487)。

需求映射上的新增工作包括：完整预测独立保存，源文件/音轨/时间原点校验，候选去重与排列，AI 事件与剪辑片段关系，草稿版本与人工副本关系，重复分析的冲突处理，人工补段的来源记录，以及切换序列后的 AI 显示规则。上述字段和行为没有由通用 marker/clip API 自动提供；这是根据已核查数据结构作出的接入范围判断，未声称已实现。

## FilmCraft：4K60 导出 schema 与硬编码证据

`file.exportMedia` 的最小 H.264 示例：

```json
{
  "path": "/absolute/output/review.mp4",
  "format": "h264",
  "width": 3840,
  "height": 2160,
  "fps": 60,
  "bitrateKbps": 50000,
  "bitrateMode": "vbr1Pass",
  "hardwareEncoding": "auto",
  "audio": true,
  "range": "entire",
  "wait": false
}
```

50000 kbps 是用于固定比较条件的示例值，不是源码给出的画质建议。已注册字段包括 `format`、`audioCodec`、width/height/fps、bitrateKbps、`bitrateMode: cbr|vbr1Pass|vbr2Pass|crf`、crf、`hardwareEncoding: off|auto`、`sequence`、`range: entire|inOut|workArea|custom`、startSeconds/endSeconds、wait；完整 schema 以该版本注册行为准。[导出注册](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/commands.rs#L1551-L1559)。

- H.264 `hardwareEncoding` **默认 off**；auto 表示设备与设置允许时尝试硬件，否则使用软件。macOS 采用 VideoToolbox；单纯请求 auto 不能证明已使用硬编码。[策略枚举](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/export/src/settings.rs#L64-L77)、[默认字段](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/export/src/lib.rs#L372-L380)。
- `gpuRendering` 是另一项设置，支持 off/auto、默认 off，控制 GPU 合成；不要和硬件编码混为一项。尽管上述注册字符串没完整列出它，解析器实际接受该顶层参数。[解析](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/export_tools.rs#L253-L278)、[默认](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/export/src/lib.rs#L577-L580)。
- 可在导出前后读取 `perf.stats`，比较 `export.hardware` 的 frames/sessions/declined，分别反映硬编码帧、创建的硬编码会话、被硬编码拒绝而回落的请求；累计计数应取差值。[计数实现](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/export/src/lib.rs#L781-L812)。
- `wait:false` 返回任务后用 `jobs.list` 查进度，用 `jobs.cancel {job}` 取消；`wait:true` 会等待完成。导出结果的 `offlineMedia` 应为空；可访问的输出路径本身不证明内容正确。[导出进度、取消与 offlineMedia](https://github.com/storytold/filmcraft/blob/v0.7.2/docs/agents.md#long-exports-progress-and-cancellation)。

本项目还需在实际导出上检查时长、尺寸、帧率、音轨、完整解码、切点及音画同步；这些属于另行实测，不由源码支持范围替代。

## LosslessCut：外部接入与完成信号

| 操作 | v3.69.0 已核查行为 |
| --- | --- |
| 启用 HTTP | `--http-api` 默认 8080，可传端口；只绑定 `127.0.0.1`，文档将接口标为实验性。[CLI](https://github.com/mifi/lossless-cut/blob/v3.69.0/docs/cli.md#L41-L46)、[启动](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/main/index.ts#L360-L365)、[监听](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/main/httpServer.ts#L49-L57) |
| 配置隔离 | `--config-dir` 改变 electron-store 配置目录，不能据此声称整个 Electron 用户数据已隔离；日志仍使用 `userData/app.log`。[配置](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/main/configStore.ts#L200-L206)、[日志](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/main/logger.ts#L29-L33) |
| 单实例 | 默认 `allowMultipleInstances:false`；实例锁判断先于 `--settings-json` 覆盖应用。不能假定本次用 settings-json 打开多实例就会绕过已有实例。[实例锁](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/main/index.ts#L268-L299)、[设置覆盖](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/main/index.ts#L348-L357) |
| 打开 `.llc` | CLI 位置参数或 `POST /api/action/openFiles`，HTTP 正文为路径数组。项目加载按工程目录解析 `mediaFileName`，官方保存器写的是媒体 basename；工程移到别处须核对原片路径关联。[API](https://github.com/mifi/lossless-cut/blob/v3.69.0/docs/api.md#L30-L49)、[加载](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/renderer/src/App.tsx#L1396-L1427)、[保存](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/renderer/src/edlStore.ts#L77-L87) |
| 打开 CSV | `openFiles` 可识别 CSV；须先打开媒体，导入候选会追加到当前选段。CSV 解析除 Start/End/Name 外还支持 tags 列，较概括文档中的三列说明更广；仍不等于完整 AI 结果协议。[识别](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/renderer/src/util.ts#L355-L360)、[追加](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/renderer/src/App.tsx#L1664-L1670)、[CSV 解析](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/renderer/src/edlFormats.ts#L48-L98) |
| 导出动作 | `POST /api/action/export`。默认 `exportConfirmEnabled:true` 时可能仅打开确认界面。[默认](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/main/configStore.ts#L95-L103)、[确认分支](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/renderer/src/App.tsx#L1111-L1120) |
| 完成信号 | 先发 `POST /api/await-event/export-complete` 建立监听，再触发导出。成功事件含 `paths`，合并模式返回合并成片路径；`export-start.path` 是输入媒体，不是输出。[事件文档](https://github.com/mifi/lossless-cut/blob/v3.69.0/docs/api.md#L53-L69)、[完成事件](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/renderer/src/App.tsx#L1064-L1079) |

**HTTP 200 不代表导出成功或已完成。** action 包装调用 `fn()` 时未等待它返回的 Promise；renderer 捕获错误后仍发送 action 回复，HTTP action 路由只结束空响应。没有任务 ID、持久化状态或历史完成查询端点，事件按名称即时订阅且不缓存。[action 包装](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/renderer/src/App.tsx#L2126-L2131)、[异常回复](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/renderer/src/App.tsx#L2140-L2151)、[路由](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/main/httpServer.ts#L28-L43)、[事件订阅](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/main/index.ts#L83-L108)。

完成监听还需超时：无有效选轨、无效区间或当前忙等提前返回分支，可能不会发出 `export-complete`。因此测试/接入应同时核对应用状态、完成事件、输出文件及媒体内容，不把一次 API 应答等同于完成。[前置检查](https://github.com/mifi/lossless-cut/blob/v3.69.0/src/renderer/src/App.tsx#L926-L951)。

## 尚未由本笔记证明的事项

1. 本机 4K60 长录屏导入耗时、顺序播放卡顿、帧丢失、音画同步与内存峰值。
2. FilmCraft 原片时间原点、多音轨选择与现有 AI 服务输出的对应关系。
3. 复制序列后修改、保存、重开对原始草稿的隔离，以及 AI 关联字段的完整往返。
4. 两种编辑器在相同素材与选段上的导出时长、质量、实际切点和音画连续性。
5. FilmCraft 的编码导出能否满足用户期待的等待时间；不能用 LosslessCut 的快速复制耗时推断。

这些条目是本轮待测范围，不是已发现的产品故障；测试结果应放在独立实测记录中。

## 补充核查：FilmCraft 是否有关键帧快速复制导出

2026-10-13，针对用户进一步明确的“游戏切片优先尽快导出”，固定核查已安装版本所对应的 **v0.7.2**。结论是：**在本次核查的原生导出命令、设置和完整视频导出调用链中，没有可调用的 stream-copy / passthrough / remux / smart-render 视频快剪出口。** 对 H.264/HEVC 等编码视频，既有导出会渲染并重新编码，不能通过“切点恰好在关键帧”自动切换为 LosslessCut 式编码包复制。官方该版本的缺口文档也将 **smart render** 列为未实现。[官方缺口 G13](https://github.com/storytold/filmcraft/blob/v0.7.2/docs/gaps.md#L219-L228)、[格式分派](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/export/src/job.rs#L187-L213)。

### 已读取范围与调用链

本轮只读获取 `crates/export/src/` 下全部 **13 个生产 `.rs` 文件**（合计 6,567 行，排除测试文件）：aac_out、audio_out、deflate、job、lib、mxf_out、pace、pcm、pipeline、presets、raster、settings、still；同时读取 engine 的 commands、export_tools、previews、media_pool，以及相关官方缺口和项目文档。未安装、更新或启动应用。源码范围可复核于 [export 源码目录](https://github.com/storytold/filmcraft/tree/v0.7.2/crates/export/src)。负结论限定于此固定版本和原生公开导出链路，不推断未来版本、外部工具或二次开发能力。

1. `file.exportMedia` 解析设置后调用 `spawn_export`；`export.quick` 选择预设后也调用同一个 `spawn_export`。[普通导出](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/export_tools.rs#L531-L556)、[Quick Export](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/export_tools.rs#L892-L910)。
2. `spawn_export` 建立原分辨率媒体 provider，再进入 `filmcraft_export::export`；主导出函数对编码视频创建 `Exporter` 并逐批执行。[引擎入口](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/export_tools.rs#L462-L505)、[导出分派](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/export/src/lib.rs#L1832-L1845)。
3. `Exporter` 按指定设置选择视频编码器并创建 `Pipeline`；逐帧管线返回 RGBA/HDR 像素，CPU/GPU 合成路径都不直接返回原录像压缩包。[编码器选择与初始化](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/export/src/job.rs#L207-L248)、[逐帧渲染](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/export/src/pipeline.rs#L211-L245)。
4. 每批渲染帧传入 `self.venc.encode`，编码器产生的新 packets 才写入封装器。这是重新编码后封装；源码存在 muxer 并不等于提供原流 remux 模式。[encode/mux 顺序](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/export/src/job.rs#L590-L649)。

### 容易混淆的“快”与“无损”

| 名称或参数 | 本版本实际行为 | 能否证明原视频快速复制 |
| --- | --- | --- |
| `keyframeDistance` / keyint | 设置新编码视频的关键帧间隔（GOP）；默认约两秒，传给输出编码器。不是选取源关键帧复制，也不是任意切点无损拼接。[字段](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/export/src/lib.rs#L386-L387)、[编码参数](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/export/src/job.rs#L238-L247) | 否 |
| Quick Export / `export.quick` | 以最近使用/指定预设快捷启动同一个编码导出任务。[实现](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/export_tools.rs#L892-L910) | 否 |
| `hardwareEncoding:auto` | 尝试硬件视频编码；不支持时回落软件。输入仍为渲染后的帧，输出仍是新编码视频。[策略](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/export/src/settings.rs#L64-L77)、[编码调用](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/export/src/job.rs#L637-L647) | 否 |
| `gpuRendering:auto` | 加速像素合成，失败时回落 CPU；与硬件编码是不同阶段。[管线](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/export/src/pipeline.rs#L211-L245) | 否 |
| Render previews | 提前渲染 ProRes 422 `.mov` 缓存，播放优先解码预览替代实时合成。标准导出入口仍读取 `full_res_provider`，本次读取的 ExportSettings/命令未提供 `usePreviews` 或复制预览压缩包的出口。[预览用途](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/previews.rs#L1-L24)、[导出 provider](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/export_tools.rs#L477-L490)、[provider 实现](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/media_pool.rs#L345-L363) | 否 |
| 源分辨率/帧率一致，未加特效 | 这些条件不会在已核查的导出入口触发 packet-copy 分支；仍创建编码器和逐帧管线。[初始化](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/export/src/job.rs#L207-L248) | 否 |
| lossless 字样 | 源码中有关 FLAC 音频、EXR 等无损格式或压缩方式的描述，不构成 H.264/HEVC 原编码包快剪能力。[格式枚举](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/export/src/lib.rs#L63-L134) | 否 |

### 对实测参数的约束

没有对应的原生 copy 参数可提供给本轮测试；应把 FilmCraft 测试明确标为重编码路径。不要因为传入 `mode:"copy"` 后动作没有报错，就认定该选项生效：顶层覆盖参数由解析器逐项读取；相反，`format:"copy"` 会因未知格式被拒绝，`settings` 内未知字段也会被明确拒绝。[设置解析](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/export_tools.rs#L198-L223)。可通过 `export.resolve` 读回实际设置、输出帧数与 GOP 参数，再结合 `perf.stats` 和成片检查识别实际走的路径。[resolve 输出](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/export_tools.rs#L916-L935)。

若后续选择 FilmCraft 作为连续草稿界面，同时保留“按源关键帧尽快切片”，接入现有 FFmpeg 复制导出器属于新增产品实现，不能算作 FilmCraft v0.7.2 已具备的能力。本轮源证据不替代两款应用在相同素材上的实际用时与输出检查。

## 补充核查：4K60 H.265 档位参数（FilmCraft v0.7.2 / macOS）

2026-10-13，用户已接受后台压缩，本节仅核实参数语义；不运行应用或媒体任务，实际画质、成片大小和耗时由独立实测记录承担。

| 项目 | 源码确认的行为 |
| --- | --- |
| HEVC 路径 | `format:"hevc"` 本身就选择硬件 HEVC；与 H.264 的硬编码 opt-in 不同，`hardwareEncoding` 的 off/auto 不提供 HEVC 软件模式。没有内置 HEVC 软件编码器；配置或硬件会话不可用时失败，不回落软件。[macOS 工厂](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/platform/src/hardware_encode.rs#L1-L37) |
| 可用码率模式 | HEVC 支持 `bitrateMode:"cbr"` 或 `"vbr1Pass"`。`"vbr2Pass"` 和 `"crf"` 均由校验器明确拒绝；不能套用 x265 CRF 档位。[校验](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/export/src/lib.rs#L634-L648) |
| 目标与上限 | 顶层 `bitrateKbps` 为目标视频 kbps；`maxBitrateKbps` 为 VBR 上限。不指定有效上限时默认目标的 1.5 倍；CBR 的解析上限等于目标。[覆盖参数](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/export_tools.rs#L234-L243)、[解析](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/export/src/settings.rs#L458-L467) |
| adaptiveBitrate | 完整设置中的 `adaptiveBitrate` 是每像素每帧比特数，解析为 `width × height × fps × bpp / 1000`，会替代基础 bitrateKbps。**传入顶层 `bitrateKbps` 会主动清空 adaptiveBitrate**，适合固定码率档位比较；若使用完整 settings，可明确设 `adaptiveBitrate:null`。[字段](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/export/src/lib.rs#L381-L387)、[清空逻辑](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/export_tools.rs#L234-L238) |
| 实际限流方式 | VBR 向 VideoToolbox 设置平均码率及一秒窗口上限；CBR 优先设置系统 ConstantBitRate，失败时用平均码率和相同码率的一秒上限。DataRateLimits 设置结果未作为硬错误处理，因此请求上限不是逐帧或整段实际码率保证。[VideoToolbox 设置](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/platform/src/videotoolbox_encode.rs#L551-L570) |
| 位深和 profile | 此 **macOS 实现**只有 HEVC Main，输入为 NV12 8-bit 4:2:0，固定选 `kVTProfileLevel_HEVC_Main_AutoLevel`；没有 Main10 用户参数。不能因硬件自身支持 10-bit 就推断 FilmCraft 此版本可导出。[像素输入与 profile](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/platform/src/videotoolbox_encode.rs#L1-L19)、[VtProfile](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/platform/src/videotoolbox_encode.rs#L63-L78)、[会话 profile](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/platform/src/videotoolbox_encode.rs#L518-L530) |
| HDR 与平台区别 | macOS VideoToolbox 工厂拒绝 HDR signal；导出摘要另行指出 HEVC Main10 HDR 只在支持的已注册编码器（例如 NVENC）上成立。本轮 Mac 测试不能写成跨平台 HEVC 10-bit 能力结论。[macOS 限制](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/platform/src/hardware_encode.rs#L33-L46)、[摘要分支](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/export/src/settings.rs#L600-L608) |
| `quality` | 0–100 的 quality 字段针对 Motion-JPEG/JPEG，并非 HEVC 质量因子；不要用它创建 H.265 质量档。[字段](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/export/src/lib.rs#L317-L320) |
| GOP 与 B 帧 | `keyframeDistance` 控制输出 GOP 间隔；macOS 会话关闭帧重排（无 B 帧），并尝试关闭 open GOP。保持同样 GOP/模式才能把码率档位放在同一条件下比较；源码里的 1080p 画质观察不能外推为本轮 4K60 激战结果。[配置](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/platform/src/videotoolbox_encode.rs#L531-L549) |
| Maximum Depth | `renderAtMaxDepth` 注释说明合成始终使用 32-bit float，此字段仅为预设往返保留，不会开启 HEVC 10-bit。[字段](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/export/src/lib.rs#L388-L392) |

### 在计时前读回有效设置

用与真实导出相同的参数先调用 `export.resolve`。例如以下是 **40 Mbps 目标、60 Mbps 上限的参数示例，不是最佳画质推荐**：

```json
{
  "format": "hevc",
  "width": 3840,
  "height": 2160,
  "fps": 60,
  "bitrateMode": "vbr1Pass",
  "bitrateKbps": 40000,
  "maxBitrateKbps": 60000,
  "keyframeDistance": 120,
  "gpuRendering": "auto",
  "audio": true,
  "range": "entire",
  "path": "/absolute/output/hevc-example.mp4"
}
```

读回应保存 `settings.format`、`settings.bitrateMode`、`settings.adaptiveBitrate`、`output.width/height/fps`、`output.targetKbps/maxKbps/keyframeDistance`、`range` 与输出 `frames`；`file.exportMedia` 使用同一设置解析器。随后独立测量文件的真实 profile、pix_fmt、码率、帧数和时长，不能把 resolve 的预估值写成输出实测。[resolve](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/export_tools.rs#L916-L935)、[普通导出解析](https://github.com/storytold/filmcraft/blob/v0.7.2/crates/engine/src/export_tools.rs#L531-L544)。

### libvmaf 的 4K 模型与 60 fps 解释范围

本节 Netflix 官方源码固定到 2026-10-13 查询的提交 `0b9462873f9b36ccb3770587dbbf43aef4c786ec`；FFmpeg 引用官方滤镜说明。没有在本子任务中加载模型或运行视频评分。

- 经典 4K 模型文件是 `model/vmaf_4k_v0.6.1.json`，内置注册名为 `vmaf_4k_v0.6.1`。模型训练/观看假设是 **4K TV、距屏幕 1.5 倍屏高**，并非针对所有显示条件或 4K60 激战游戏的专项准确性保证。[Netflix 模型说明](https://github.com/Netflix/vmaf/blob/0b9462873f9b36ccb3770587dbbf43aef4c786ec/resource/doc/models_v0.md#L32-L40)、[内置注册](https://github.com/Netflix/vmaf/blob/0b9462873f9b36ccb3770587dbbf43aef4c786ec/libvmaf/src/model.c#L98-L109)。
- FFmpeg 的 libvmaf 文档默认模型为 `vmaf_v0.6.1`；4K 比较应明确指定 `model=version=vmaf_4k_v0.6.1`，或用 `model=path=...` 指定官方 JSON。是否内置该注册名取决于本机 libvmaf 的版本/构建，官方上游存在不等于本机已可用。[FFmpeg libvmaf 参数](https://ffmpeg.org/ffmpeg-filters.html#libvmaf)。
- 当前 Netflix v1 还有约 50/60 fps 校准的 HFR 模型，4K/1.5H 名称为 `vmaf_v1.0.16_hfr_1d5h_2160`。官方说明 v0 在高帧率下有低估质量的问题，新 HFR 模型也仍未完整捕捉高帧率感知效果。若本轮使用 v0 4K，应将其作为同片段、同模型的相对档位比较，不能把某个绝对分数阈值写成“无损”。不同代际/观看模型得分应分别列出。[HFR 说明](https://github.com/Netflix/vmaf/blob/0b9462873f9b36ccb3770587dbbf43aef4c786ec/resource/doc/models_v1.md#L54-L60)、[HFR 注册名](https://github.com/Netflix/vmaf/blob/0b9462873f9b36ccb3770587dbbf43aef4c786ec/libvmaf/src/model.c#L143-L149)。
- FFmpeg 输入顺序是**失真成片在前、参考原片在后**。官方示例使用 `settb=AVTB,setpts=PTS-STARTPTS` 对齐时间基准；这不能修复错剪一帧、缺帧、错位或两路不同结束时间。评分前应核对同源范围与相同帧序列，避免 framesync 重复末帧影响汇总。[libvmaf 示例](https://ffmpeg.org/ffmpeg-filters.html#libvmaf)、[多输入帧同步](https://ffmpeg.org/ffmpeg-filters.html#Options-for-filters-with-several-inputs-framesync)。
- `pool` 支持 mean/min/harmonic_mean；P5 等百分位应由逐帧 JSON 结果另算，不能假造为 `pool=perc5`。平均分之外应查看低分帧与快速转向、枪口火焰、烟雾、HUD 小字。对于已经压缩过的游戏录屏，全参考评分衡量的是**相对该录屏新增的损失**，不代表相对游戏原始渲染画面的质量；这是全参考比较方式带来的解释边界。[FFmpeg 汇总参数](https://ffmpeg.org/ffmpeg-filters.html#libvmaf)。
