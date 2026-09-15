# Go 迁移验证 — 2026-09-14

环境：macOS arm64，Go 1.24.3；真实样本使用项目 `bin/` 的 FFmpeg / ffprobe。分支 `go-core`，仓库尚无首次提交，原暂存及工作区内容未清理。

## 已执行

- `go test ./...`：纯 Go 算法及 CLI 测试通过。
- `APEX_MEDIA_TEST=1 go test ./... -count=1`：实际媒体集成测试通过，包含有/无音轨、音频/伤害分析、precise/fast 剪辑、成片探测、中文/空格/单引号路径、覆盖保护、非法区间、进程错误及清理。
- `go vet ./...`：通过。
- `CGO_ENABLED=0 go build ...`：macOS arm64 主程序构建通过；动态链接仅有 macOS 系统库，无 Python 动态库。
- `CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build ...`：Windows x64 主程序构建通过，文件识别为 `PE32+ executable (console) x86-64, for MS Windows`。
- macOS 主程序实际执行 `doctor --tools-dir bin` 成功。

## Python 对齐

固定测试材料来自当前 Python 实现，Go 测试不依赖 Python：

- 原 `tests/data/damage_hud.npz` 的 8 张 HUD 图像：未知、64、103、117、160、未知、未知、224，全部一致。
- 四位数字 1010 不被截为三位；未知/下降/短暂读数的 tracker 事件一致。
- 12 组音频数组：第一组使用原桥接测试；其余使用 NumPy `default_rng(1234)` 生成的固定 float32 数组，标准差 8、均值 -30、长度 400。阈值以绝对误差 1e-5 检查；事件和候选片段对齐。

额外使用现有 `work/damage-integration/sample.mkv`（18.517 秒，3840×2160，60 FPS，H.264/AAC）分别运行 Go 与 Python：

| 模式 | 分析帧数 | 事件 | 候选片段 | 结果 |
|---|---:|---:|---:|---|
| 伤害增长 | 556 | 3 | 2 | 完整读数变化、事件、片段及可读帧统计一致 |
| 音频 | 740 | 9 | 1 | RMS 帧数、阈值、事件与片段对齐 |

Go 按这两个伤害区间导出真实样本：MPEG-4/AAC、3840×2160、60 FPS，视频 42 帧、0.7 秒；音频 0.7 秒，两轨起点为 0。42 帧与渲染记录的 18+24 帧相符。完整 FFmpeg 解码成功，无错误输出。

证据在 `../work/go-validation/`：`damage.json`、`audio.json`、`python-damage.json`、`python-audio.json`、`comparison.json`、`render.json`、`montage.mp4`。真实录像和成片不加入 Git。

## 交付与边界

- 主程序：`../dist/go/apex-highlight`、`../dist/go/apex-highlight-windows-amd64.exe`。
- Windows EXE 不携带 Python，也没有打入 Windows 版 FFmpeg；需另配相同架构的媒体工具。提供 `scripts/build_windows.ps1` 供 Windows 构建和复制媒体工具。
- 当前机器不是 Windows，没有执行 Windows EXE 或 PowerShell 构建脚本；交叉编译成功不代表 Windows 实机验收、签名或杀毒软件验证。
- 验证覆盖既有样本和算法行为，不代表其他 HUD、低清晰度、多分辨率、VFR 或所有编码格式均适配。
- 迁移范围是独立算法/媒体核心与薄 CLI，没有迁移旧终端向导、HTML 曲线、编号预览、选片记录等交互功能。

## 2026-09-14 Go TUI

- 新增 Bubble Tea 分页 UI 与 `internal/workflow` 应用服务；核心检测算法未改动。
- `APEX_MEDIA_TEST=1 go test ./...` 通过，包含真实 FFmpeg 分析、仅导出选中区间、探测时长、取消清理及源文件变化拒绝。
- `go vet ./...`、`go test -race ./internal/...` 通过。
- UI 状态测试覆盖默认全选、取消选择后的导出、空选阻止、取消等待工作返回、窄窗口候选分页、中文/Windows/带空格路径。
- macOS PTY 启动验证设置页、Tab 模式切换、Ctrl+C 退出及 alternate screen/cursor 恢复。未完成真实长录像的人工逐段选片验收。
- macOS arm64 主程序及 Windows amd64 无 CGO 交叉编译通过；未在 Windows 实机运行，不包含 Windows 媒体工具。

## 2026-09-14 多录像选择与独立片段导出

- Go TUI 新增目录浏览、跨目录多选、串行批量分析、按录像保留勾选状态，以及统一确认后逐录像导出独立 MP4。
- `go test ./...`、`APEX_MEDIA_TEST=1 go test ./... -count=1`、`go vet ./...` 和 `go test -race ./internal/...` 通过。补充测试后再次执行真实媒体工作流测试通过。
- 媒体测试覆盖两份录像分别导出多个 MP4、按时间排序及连续编号、未选片段排除、同名目录递增、重复导出不覆盖、失败后清理当前目录，以及首段已发布后取消整个当前录像输出。验证保留其他成功录像。
- macOS 实际 PTY 全流程通过：以现有 18.517 秒 4K60 样本的两个不同目录链接作为输入，跨目录选择两份录像，得到各 2 个候选，取消第一份的首个候选后统一导出；`录像 A/` 生成 1 个 MP4，`录像 B/` 生成 2 个 MP4，无合并视频。三个输出分别为 0.4、0.3、0.4 秒，ffprobe 探测及完整 FFmpeg 解码通过。
- 终端交互验证包括目录进入、跨目录选择、录像间切换后保留勾选、导出确认、成功退出，以及 alternate screen 和光标恢复。状态测试另覆盖窄窗口、空目录、无候选、目录读取错误、过期消息、失败继续和取消等待。
- macOS arm64 与 Windows amd64 主程序已重新构建到 `../dist/go/`。Windows 仅交叉编译，未实机运行，也不包含 Windows FFmpeg。
- PTY 脚本、终端日志、结果目录和探测记录位于 `../work/go-multifile-validation/`；这是同一真实样本以两条路径执行的工作流验证，不代表检测泛化或不同录像内容的精度验收。

本机验证使用 `GOCACHE=/tmp/apex-go-cache GOMODCACHE=/tmp/apex-go-mod`，避免写入不可写的默认用户缓存目录。
