# Apex 终端集锦助手

> 当前项目用于 Apex Legends 录像自动剪辑，面向复盘与高亮片段整理，减少手动筛选时间并节省硬盘空间。伤害剪辑基于 OCR 识别累计伤害数字。
>
> 当前剪辑速度过慢：按当前使用反馈，一段 20 分钟的 4K / 60 FPS 录像需要约 5 分钟处理，严重不符合项目快速整理录像的定位，后续计划重构与优化。

后续计划：

- [ ] 新增基于重新训练的 Apex 专用音频分析模型的剪辑方案。
- [ ] 增加基于 AI 的分析模式，用于用户精准预测与模型训练数据标注。

## version0 封存

本次快照保留重构前的 Python、Go/CGO 和 TypeScript 实现。基于图像定位与 OCR 的伤害识别在长录像中效率不足，后续将重构架构；本版本用于历史对照与回退，不代表性能或跨平台验收完成。范围、已知问题和验证边界见 [封存说明](docs/archive-version0.md)。

## TypeScript 本地网页版

TypeScript 实现位于 [`typescript/`](typescript/README.md)：解压后双击程序，在浏览器中批量分析、播放候选并导出，视频留在本机。发布包自带媒体工具；音频模式无需额外语言环境，伤害模式需要另行配置 Python/PaddleOCR，见 [OCR 环境说明](typescript/docs/paddleocr-debug.md)。开发机可使用 Bun 1.3.13 或更新版本运行 `bun run package bun-windows-x64` 交叉打包 Windows；验证范围见 [TypeScript 验证记录](typescript/VALIDATION.md)。

以下为保留的 Python 终端版文档。

提供音频高能片段和伤害增长片段两种模式，按时间顺序导出集锦。伤害模式读取右上角累计伤害数字，不区分伤害来源，也不判断击杀或观战。

## Python 开发版

本分支 `dev/main` 维护 Python 实现，包含终端交互、音频检测、伤害识别、曲线报告、编号预览和集锦导出。视频处理调用 FFmpeg；Windows 和 macOS 发布包分别在对应系统构建，并携带 Python 运行环境及媒体工具。

源码启动：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e .
.venv/bin/apex-highlight
```

运行前准备 `bin/ffmpeg` 和 `bin/ffprobe`，或将它们加入系统 PATH；打包还需要 ffplay，详见 [媒体工具说明](docs/media-tools.md)。Windows 源码环境使用 `.venv\Scripts\python.exe` 和 `.venv\Scripts\apex-highlight.exe`。

## 伤害集锦

终端菜单选择“伤害增长片段”，分析完成后会生成带编号的预览视频，并显示完整路径。用本地播放器查看，再回到终端勾选要保留的编号；正式视频没有编号。

结果页选择 **查看伤害数字轴**，可核对识别效果：横轴为源录像秒数，纵轴为累计伤害原始读数。阶梯线包含尚未确认的短暂读数；`+` 只标记已确认增长，`?` 表示整列时间内都无法识别，`~` 表示同列混有可读与未知帧（可读值保留为 `•` 点），`R` 表示下降/重置，`#` 表示候选裁剪范围。未知区间不按零处理，也不跨区间连线；长录像概览会压缩到终端宽度，请通过“设置时间范围”放大检查。

支持“下一次增长 / 上一次增长”定位到增长附近，以及分页查看精确到毫秒的读数变化与增长量。没有候选片段时仍可查看时间轴。已有结果可通过“已有结果 → clips.json → C 曲线”进入；旧版结果需保留同一次分析的 `events.json`。新结果把读数及增长事件同时保存在 `clips.json` 中。

命令行查看指定范围（仅查看，不重新分析或导出）：

```bash
.venv/bin/apex-highlight damage-axis "伤害分析/clips.json" --start 30 --end 45
```

```bash
.venv/bin/apex-highlight analyze "录像.mkv" --mode damage --output-dir "伤害分析"
.venv/bin/apex-highlight export "伤害分析/clips.json" --clips 1,3
# 无人值守：生成预览并导出全部候选
.venv/bin/apex-highlight run "录像.mkv" --mode damage
# 重新生成预览，可用于已有分析结果
.venv/bin/apex-highlight preview "伤害分析/clips.json" --overwrite
```

发布包将 `.venv/bin/apex-highlight` 换成 `./apex-highlight`。未指定 `--mode` 时仍使用原音频模式。

伤害模式完全本地运行，不下载模型。默认 30 FPS 采样；数字连续两帧一致才确认。首次有效数字只建立基线；读不到数字或计数下降后重新建立基线，因此可能漏掉首次伤害或短暂更新。只在已确认计数增加时产生候选，不把空白当成零，也不使用音量阈值作为前置条件。

事件间隔不超过 0.3 秒合并，首尾分别留 0.1、0.2 秒，可用 `--damage-fps`、`--damage-gap-s`、`--damage-before-s`、`--damage-after-s` 修改。终端报告可读帧数及识别限制；`events.json` 保存读数变化与增长证据。

伤害区域通过图标的多尺度模板匹配定位，不再限制视频为 16:9，也不依赖固定屏幕坐标。先在整帧缩略图中搜索，再在原图上细化位置和尺寸；后续逐帧在附近跟踪，跟踪失败后最多每秒重新搜索一次。根据图标尺寸换算右侧数字区域，恢复到参考 HUD 尺寸后分割数字、匹配 0–9 模板。图标随数字宽度移动时会重新定位；不同位置出现相近高分候选时拒绝首次定位。无需下载模型或增加运行依赖。

适用于现有模板对应的 HUD 样式及等比例缩放，包含改变分辨率、HUD 平移、完整 HUD 保留的裁剪/黑边画面。搜索范围为参考 4K 图标尺寸的 0.25–2 倍，粗搜索中图标须至少约 8×5 像素；不是任意 HUD 尺寸保证。不支持横纵不同比例的拉伸、旋转或更换图标样式；遮挡及低清晰度可能拒识。低分辨率放大不能恢复丢失的笔画，真实多位高伤害仍需更多样本验证。`clips.json` 的 `damage_stats.localization` 保存定位帧数、全图搜索次数及抽样位置/尺寸/分数。新流程需要解码完整视频帧，耗时与分辨率有关。宁可拒识，不保证找出所有伤害。

编号预览为 720p；正式伤害集锦保留原尺寸，按视频标称帧率对齐切点，以 MPEG-4 Part 2 / AAC 输出 MP4。不同于原模式的 stream copy，会重新编码。中间片段使用 PCM 音频，最后统一编码 AAC；`selection.json` 记录实际渲染区间、帧数和编码信息。采样时刻不等于游戏实际命中时刻。

## macOS 测试发布包

解压 `apex-highlight-macos-arm64.zip`，在终端进入解压后的 `apex-highlight` 目录：

```bash
./apex-highlight
```

只适用于 Apple Silicon / arm64。包内含 Python、NumPy、FFmpeg 和 ffprobe，不需要安装 Homebrew 或 Python。保留整个目录（含 `_internal`、`bin`），不能只复制可执行文件。

这是本机架构的测试发布包，无开发者签名或公证（Mach-O 使用构建工具的临时签名）。实际测试系统和范围见 `VALIDATION.txt` / 项目 `VALIDATION.md`；未在独立干净 Mac 或旧版 macOS 验收，不能保证这些环境可运行。系统可能对下载的未公证程序要求手动批准。

## 菜单

无参数启动进入分步终端界面：简洁品牌区、步骤导航和统一快捷键；候选列表使用反显焦点和勾选标记。主菜单依次提供一键集锦、高级剪辑、已有结果、运行环境；操作提示位于选项下方，按 `Q` 退出。

操作按独立页面展开：**任务设置 → 分析进度 → 查看与选择 → 导出完成**。页面切换清理上一页显示；退出恢复启动前的终端内容。结果页将候选明细与勾选合并，列表随终端高度伸缩，并显示已选数量和总时长。音频曲线用浏览器打开，编号预览和成片用默认播放器打开；日志、检测说明和输出目录统一放入“更多”。

选片方式提供「音频片段」和「伤害增长片段」：前者按音频能量寻找候选并保留较长前后片段，后者按累计伤害增长寻找短片段；都不保证已经确认击杀或命中。

`Esc` 返回上一级：任务设置保留路径与已确认参数；曲线明细返回曲线，曲线返回结果页；菜单页按 `Q` 退出，路径输入时可正常输入字母 q。导出确认取消后返回候选列表并保留当前勾选与焦点；打开预览、曲线和更多操作也保留选择。选择仅在当前结果页会话中保留，退出应用或重新打开结果时默认全选。完成页可播放成片、打开输出目录或返回结果页。处理过程中 `Ctrl+C` 终止任务并退出。

菜单使用方向键选择、回车确认。候选列表默认全选：`↑↓` 移动，`PgUp/PgDn` 翻页，空格勾选，`A` 全选/全不选，`E` 导出，`P` 打开编号预览（已有预览时显示），`C` 查看曲线（有曲线时显示），`M` 更多。空选时按 E 会提示先勾选。支持中文、空格路径；拖入路径时可用引号包裹。默认每次创建独立任务目录；无效路径在输入框内提示，可直接修改。高级参数使用可返回的列表，数值范围在输入时校验。Ctrl+C 终止当前任务和 FFmpeg，未完成成片会清理。

## 显式命令（不提问）

```bash
./apex-highlight run "录像.mkv"
./apex-highlight analyze "录像.mkv" --output-dir "分析结果"
./apex-highlight inspect "分析结果/clips.json"
./apex-highlight export "分析结果/clips.json" --clips 1,3
./apex-highlight export "分析结果/clips.json" --source "搬迁后的录像.mkv" --output "集锦.mkv" --overwrite
./apex-highlight doctor
```

`run` 分析并导出所有候选；`analyze` 只分析。编号从 1 开始，省略 `--clips` 为全部，重复编号去重，按源时间排序。无候选时保留 JSON 并跳过导出。非交互环境无参数显示帮助。各命令 `--help` 查看参数。

已有成片、分析 JSON 或 selection.json 默认禁止覆盖；命令需显式 `--overwrite`，菜单会询问。源录像及分析元数据不允许作为成片目标（包含符号链接和硬链接）。

## 结果与参数

- 候选分析先显示音频 RMS 能量曲线、检测阈值和带起止秒数的裁剪时间轴，再显示明细表格。
- 每次分析生成离线 `analysis.html`：全片曲线叠加绿色裁剪范围，点击候选编号查看局部曲线；局部时间轴标明精确起止时间，区分事件聚类范围和前后缓冲。用浏览器打开即可，无需联网。
- `clips.json` 内保存有界采样的 `audio_curve`，保留各采样区间的能量极值。`inspect` 和菜单打开已有结果也显示曲线；旧 JSON 未保存曲线时会提示重新分析。
- `events.json`、`clips.json` 保留原字段，增加 `format_version: 1`、`analysis_id`、源文件大小/时间/SHA-256 和日志路径。
- `clips.json` 始终是完整候选；导出成功后 `selection.json` 保存选中编号、对应分析 ID、源录像与成片路径。
- 每次分析/导出生成独立 `run-*.log`，FFmpeg 错误写入该日志。
- 源录像移动后用 `--source` 指向相同内容即可；大小或 SHA-256 不匹配需重新分析。校验会读取整份源文件，显示状态与耗时；导出不会重新解码音频。旧结果缺少源文件信息时仅允许查看。

默认：16 kHz 单声道、25 ms RMS 帧、96 百分位阈值、200 ms 事件桥接、4 秒聚类间隔、最少 4 个事件、前 5 秒/后 8 秒缓冲、60 秒建议最大长度（只提示，不截断）。

音频进度按实际解码样本数显示；裁剪按完成片段数；源文件校验、探测、检测、合并显示状态和耗时。

快速导出使用 FFmpeg stream copy，保留源编码、分辨率与帧率。**切点受关键帧限制，可能包含候选边界之外的少量画面**。默认 MP4，不兼容的源编码可使用 `--output 集锦.mkv`。当前无时间编辑或批处理；编号视频预览见伤害集锦说明。

## 源码运行与构建

### Windows 打包

在 Windows 上安装 Python 3.10 或更高版本（包含 `py` 启动器），准备解压好的 Windows FFmpeg 发行包，其中需要有 `ffmpeg.exe`、`ffprobe.exe` 和 `ffplay.exe`。推荐传入完整发行包目录，以便一并复制许可证；若使用 shared 版本，相关 DLL 必须与这两个 EXE 放在同一个 `bin` 目录。

在项目根目录的 PowerShell 中运行：

```powershell
.\scripts\build_windows.bat --ffmpeg-dir "C:\tools\ffmpeg"
```

也可将 Windows 发行包放入项目 `bin/windows-amd64/`（三个工具在其 `bin/` 子目录）后运行 `.\scripts\build_windows.bat`。脚本创建独立的 `build/venv-windows` 环境、安装构建依赖（首次需要联网），使用 PyInstaller 目录模式打包，并在限制 PATH 的环境中检查发布程序的 `--help` 和 `doctor`。重复执行会覆盖 Windows 构建目录及同名 ZIP。

产物为 `dist/apex-highlight-windows-<架构>.zip`，解压后运行 `apex-highlight.exe`；命令行示例为 `.\apex-highlight.exe doctor`。必须保留 `_internal` 和 `bin` 等整个目录。已有构建环境可直接执行 `python scripts/build_windows.py --ffmpeg-dir "C:\tools\ffmpeg"`。

Windows 包需要在 Windows 本机构建，不能直接在 macOS 上生成。脚本记录依赖版本、媒体工具版本和 SHA-256 到 `build-info.json`；FFmpeg 的许可证及源码提供要求以所选发行包为准，对外分发时需保留对应材料。当前脚本尚未在 Windows 实机验收；自动检查只覆盖启动和工具发现，不代表真实录像处理或交互菜单已通过验证。

### macOS 构建

```bash
uv venv .venv --python 3.14
uv pip install --python .venv/bin/python -e '.[build,test]'
.venv/bin/apex-highlight
# 旧入口仍支持原参数，并调用同一业务接口
.venv/bin/python apex_highlight.py gameplay.mkv --output-dir outputs/new-task --analyze-only
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python scripts/build_macos.py
```

源码运行优先使用项目 `bin/`，否则查系统 PATH；发布包只使用随包工具，避免意外依赖本机安装。`requirements-lock.txt` 记录本次构建环境精确版本。

构建需 Xcode Command Line Tools。脚本下载并校验 FFmpeg 7.1.1 官方源码，禁用外部自动依赖和网络功能，静态链接 FFmpeg 自有库，再用 PyInstaller 目录模式打包当前架构。媒体工具只依赖 macOS 系统库。`licenses/` 包含 FFmpeg 原始源码、LGPL 文本、构建参数以及 Python/依赖许可证；`build-info.json` 和 `dependency-audit.json` 记录构建环境与动态库审计。

参考：[FFmpeg 官方发行源码](https://ffmpeg.org/releases/)、[PyInstaller 构建说明](https://pyinstaller.org/en/stable/usage.html)。

已准备的跨平台媒体工具及 Python 发布包构建方式见 [媒体工具说明](docs/media-tools.md)。
