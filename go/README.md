# Go 终端 UI 与检测剪辑核心

独立 Go module，Go 1.24+，检测核心仅使用标准库；终端层使用 Bubble Tea v1、Bubbles 和 Lip Gloss。运行及构建均不需要 Python、NumPy、pip 或 C 编译器；分析和剪辑仍使用外部 FFmpeg / ffprobe。

## 边界

`highlight` 包包含：

- 音频 PCM → RMS → 高能量事件 → 候选片段。
- RGB HUD 裁剪 → 数字模板识别 → 已确认的伤害增长事件 → 候选片段。
- 录像探测、音频/视频解码、按调用方给出的区间裁剪和拼接。

`cmd/apex-highlight` 负责入口装配、命令行参数和 JSON 文件；交互入口调用 `internal/tui`。核心不包含取消任务业务、任务队列、选片状态、交互菜单、编号预览、HTML 报告或桌面框架。调用方决定用哪些区间，再调用 `Render`；没有“导出选择”对象。底层接收 `context.Context` 是进程生命周期机制，不引入任务管理。

Go TUI 提供文件浏览多选、批量分析、按录像勾选片段和独立片段导出。Python 目录保持原样，Go 界面不是旧版交互向导的逐项复制。JSON 是 Go CLI 的独立输出格式，不保证兼容旧 `highlight_service` 的结果与导出流程。`render` 的输入是明确给出的源录像和区间，不做旧结果的录像哈希绑定；调用方应保证二者对应。

## 终端界面

```sh
# 在 go/ 目录中执行
 go run ./cmd/apex-highlight
 go run ./cmd/apex-highlight tui --tools-dir ../bin --output-dir ../outputs
```

无参数且 stdin/stdout 都是终端时打开全屏 UI；管道中无参数仍输出帮助。显式 `tui` 在非终端环境报错。

- 文件选择页：默认浏览当前工作目录。输入目录后跳转；输入录像路径后打开所在目录并勾选该文件。支持中文、空格、外层引号、相对路径和 `~`。
- `Tab` 切换路径框/列表。路径框 `Enter` 跳转；列表 `↑↓` 移动、`→` 进入目录、`←` 返回上级、空格勾选、`A` 全选/清空当前目录的录像、`Enter` 进入目录、`N` 下一步、`S` 查看已选。跨目录保留选择，按首次勾选顺序处理。已选页支持空格移除、`A` 清空全部、`Esc` 返回。
- 浏览器显示目录和 MP4、MKV、MOV、AVI、WEBM、M4V、TS 文件；扩展名筛选不代表编码一定支持，分析时由 ffprobe 检查。仅浏览当前层，不递归扫描。
- 分析确认页：查看所选完整路径和输出根目录，`Tab` 切换伤害/音频模式，`Enter` 开始串行分析。单个失败后继续后续录像；显示已完成文件数和批次耗时，不显示估算百分比。
- 录像结果页：`Enter` 进入当前录像的候选片段；`↑↓` 移动、空格勾选、`A` 全选/清空，`Enter` 或 `Esc` 返回。每份录像独立保留勾选状态，候选默认全选。`P` 使用 ffplay 预览当前片段，关闭播放器后返回选片；ffplay 需位于程序旁的 `bin/` 或系统 PATH，不会自动安装。录像结果页 `E` 统一导出。
- 导出确认页：展示每份录像的片段数和预计目录，`Tab` 切换 precise/fast（默认 precise），`Enter` 开始。若确认后有其他程序占用了目录名，实际导出仍会递增名称，最终路径以完成页为准。
- 完成页：显示成功目录、片段数和失败原因；`↑↓` 滚动查看，`Enter` 返回选片，`N` 重新选择录像，`Q` 退出。重复导出创建新目录。
- 分析/导出中 `Esc` 取消整个批次，等待当前媒体进程退出后返回已有结果；`Ctrl+C` 清理后退出。保留先前完成的结果，取消时不再启动后续录像。单份录像导出失败或取消时删除该次新建目录，其他录像结果保留。

默认输出根目录为 `outputs/`，可用 `tui --output-dir` 指定。分析成功生成 `.analysis/apex-*/analysis.json`；所选片段按开始时间排序，分别保存为 MP4，不合并：

```text
outputs/
├── 录像文件名/
│   ├── clip_001.mp4
│   └── clip_002.mp4
├── 录像文件名_2/          # 同名录像或重复导出
│   └── clip_001.mp4
└── .analysis/
    └── apex-…/
        └── analysis.json
```

目录名去掉源文件最后一个扩展名；已有同名文件或目录时添加 `_2`、`_3` 等后缀。只导出勾选的片段，从 001 连续编号，超过三位自然扩展；无候选/空选录像不创建视频目录。当前使用默认检测参数，高级参数仍通过 `analyze` CLI 设置。Go CLI 的 `render` 仍按原接口将给定区间合成一个文件。

### 架构与边界

```text
cmd/apex-highlight          入口装配：终端检测、CLI 参数
        ↓
internal/tui                页面状态、键盘、视图、异步命令
        ↓ Backend 接口
internal/workflow           分析持久化、导出选择、输出目录
        ↓
highlight                   检测算法与媒体处理 → FFmpeg / ffprobe
```

依赖单向流动：`highlight` 不导入 UI 或应用服务。UI 的 Update 处理状态转换，耗时工作在 `tea.Cmd` 中执行，通过结果消息回到 UI；每个批次使用独立 context，取消后等待当前工作返回，不启动后续录像。批次只在当前 UI 会话中串行执行，没有后台常驻服务。

工作流的单文件 `Analyze` 返回 `Session`，`ExportClips` 接收该会话、勾选状态和剪辑模式，返回 `ExportResult{Directory, Files}`。底层 `Render` 每次接收一个区间完成独立片段导出。

应用服务保留分析时的源路径、大小和修改时间，导出前检查变化；这不是内容哈希校验。当前会话只在内存中保留选片状态，不支持重开结果、带编号预览、自动播放或旧 Python 结果导入。`analysis.json` 可交给 Go CLI 的 `render` 命令处理。原始错误会在界面中压缩成单行显示，完整诊断可使用 CLI。

终端框架固定在 v1 API，参考 [Bubble Tea 官方文档](https://pkg.go.dev/github.com/charmbracelet/bubbletea)。GUI 或其他调用方可直接复用核心，或新增自己的应用入口。

## 构建与运行

在本目录执行：

```sh
go test ./...
CGO_ENABLED=0 go build -trimpath -o ../dist/go/apex-highlight ./cmd/apex-highlight
../dist/go/apex-highlight doctor --tools-dir ../bin
../dist/go/apex-highlight analyze --mode damage --tools-dir ../bin --output ../outputs/go-damage.json '/path/recording.mkv'
../dist/go/apex-highlight analyze --mode audio --tools-dir ../bin --output ../outputs/go-audio.json '/path/recording.mkv'
../dist/go/apex-highlight render --tools-dir ../bin --source '/path/recording.mkv' --intervals ../outputs/go-damage.json --output ../outputs/go-montage.mp4
```

参数必须写在源文件位置参数前。省略 `--output` 时分析结果写入标准输出。`analyze --help` 列出原有检测参数。默认分析模式为 `damage`；默认剪辑模式为 `precise`。

媒体工具查找顺序：显式 `--tools-dir`（缺失即报错），否则可执行文件旁 `bin/`，最后系统 `PATH`。`--tools-dir` 应指向实际包含两个工具的目录。

`render` 处理 JSON 中全部区间，保留给定顺序；最小输入：

```json
{"clips":[{"start":1.1,"end":1.4},{"start":3.2,"end":3.6}]}
```

输出文件必须不存在，不能覆盖源录像。先写同一文件系统临时目录，成功后以硬链接原子发布；不支持硬链接的 FAT/exFAT 等文件系统会明确报错，不降级覆盖文件。支持 MP4/MKV/MOV，正常或失败后清理剪辑临时目录。

## Windows

在 Windows PowerShell 中（已安装 Go 1.24+）：

```powershell
.\scripts\build_windows.ps1 -Architecture amd64 -FFmpegDir 'C:\tools\ffmpeg'
..\dist\go\windows-amd64\apex-highlight.exe --help
..\dist\go\windows-amd64\apex-highlight.exe doctor
```

脚本生成 `../dist/go/windows-amd64/` 和对应 ZIP，包含 Go 程序、三个媒体工具、许可证及构建信息。不传 `-FFmpegDir` 时使用项目 `bin/windows-<架构>/`；自定义目录必须包含同架构的 `ffmpeg.exe`、`ffprobe.exe`、`ffplay.exe` 及所需 DLL。已有发布目录会先归档到 `build/previous-windows-*`。Windows 本机构建时会在限制 PATH 的临时目录运行程序帮助、doctor 和三个媒体工具的版本检查；预览窗口及真实录像仍需验收。

当前核心无 CGO，也可在 macOS/Linux 上交叉编译主程序：

```sh
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -o ../dist/go/apex-highlight-windows-amd64.exe ./cmd/apex-highlight
```

交叉编译得到的是主程序 EXE，不含 Windows FFmpeg，也不等于 Windows 实机验证。用户机器无需安装 Go 或 Python。以后增加 Wails 等 GUI 时，其构建和 WebView 依赖应由桌面入口单独处理。

## Go 调用示例

```go
tools, err := highlight.FindTools("/path/to/bin")
if err != nil { return err }
result, err := tools.AnalyzeDamage(ctx, source, highlight.DefaultDamageOptions())
if err != nil { return err }
// 上层决定传入哪些区间。核心只完成给定区间的媒体处理。
_, err = tools.Render(ctx, source, result.Clips, output, highlight.Precise)
return err
```

纯算法入口也可单独使用：`RMSFrames`、`DetectAudioEvents`、`AudioClips`、`ReadCounter`、`CounterTracker.Update`、`DamageClips`。这些不启动 FFmpeg。

## 行为与限制

- 伤害模板原样来自 `../damage_templates.py`，通过 `go:embed` 编入程序。模板来源见 `highlight/testdata/template_provenance.json`。
- HUD 裁剪固定归一化为 200×90 RGB24；只适配完整 16:9 画面与现有默认 HUD。保留三种二值化投票、图标门限、四/五位数字识别。
- 两次连续有效读数才确认；未知、首次有效读数、计数下降不产生增长事件。默认间隔 0.3 秒、前留 0.1 秒、后留 0.2 秒。
- 音频保留百分位阈值、严格大于比较、短空隙连接、事件聚类、缓冲合并。过长片段仅标记，不强制截断。
- `precise` 沿用 Python 的帧网格取整与 MPEG-4/AAC 重编码；可能有画质损失，按 CFR 输出，不承诺 VFR 源的逐帧精确性。`fast` 复制压缩数据，受关键帧影响，不能保证区间边界精确。
- Go 的伤害分析、剪辑允许无音轨视频；音频模式明确要求音轨。这是相对旧统一探测函数的有意改进。
- 无识别样本覆盖的 HUD/分辨率仍需验证；迁移本身不提高识别准确率，也不保证减少杀毒软件误报。

## 验证

```sh
go test ./...
go vet ./...
APEX_MEDIA_TEST=1 go test ./... -count=1
```

Windows PowerShell 启用媒体测试：`$env:APEX_MEDIA_TEST='1'; go test ./... -count=1`。测试需能从 PATH 找到 FFmpeg 和 ffprobe。

- 8 张现有 HUD 样本与 Python 预期读数一致；另测四位数字不被截成三位。
- 12 组固定音频样本与 Python 输出对齐，覆盖阈值、事件和片段；另测静音与不完整末尾 PCM。
- 伤害 tracker 的未知、下降、短暂读数及片段重叠与原实现对齐。
- 媒体集成测试实际生成录像、分析、两种模式剪辑、探测成片；覆盖中文/空格/单引号路径、拒绝覆盖、非法区间及错误传播。

`testdata` 中的预期结果在迁移时由当前 Python 实现生成，运行 Go 测试不需要 Python。具体本次执行记录见 `VALIDATION.md`。


## 已准备的完整媒体工具与 Go 发布包

项目根目录 `bin/` 已准备 macOS arm64 的 ffmpeg、ffprobe、ffplay；Windows x64 发行包在 `bin/windows-amd64/`，其中三个 EXE 位于 `bin/` 子目录。工具目录被 Git 忽略，复制源码到其他电脑时需要另带这些目录，或重新准备相应工具包。

在 macOS 上从项目根目录生成完整 Go 发布包（构建需要 Go，使用发布包不需要）：

```sh
bash go/scripts/build_release.sh darwin arm64
bash go/scripts/build_release.sh windows amd64
```

输出：`dist/go/apex-highlight-macos-arm64.zip`、`dist/go/apex-highlight-windows-amd64.zip`。保留解压后的整个目录，无需另外安装 FFmpeg 或配置 PATH。macOS 脚本只复制对应平台的工具，不会将 Windows 文件一起塞入 Mac 包。Mac 工具必须匹配目标架构，并且只能依赖系统动态库，否则构建失败。

Windows 本机构建（从项目根目录）：

```powershell
.\go\scripts\build_windows.ps1 -Architecture amd64
```

详细下载来源、目录、验证范围见 [`docs/media-tools.md`](../docs/media-tools.md)。Windows 包当前在 Mac 交叉构建，尚未执行 Windows 实机验证；macOS 主程序尚未做开发者签名及公证。
