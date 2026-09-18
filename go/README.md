# Apex Highlight — Go / CGO 单程序版

每个平台只交付一个主程序。FFmpeg 7.1.1、ffprobe、ffplay 和 SDL 2.32.6 静态链接在其中；用户不需要安装 Python、Go、FFmpeg，也不需要保留 `bin/`。

## 使用

macOS Apple Silicon：

```sh
./dist/cgo/darwin-arm64/apex-highlight tui
```

Windows：

```powershell
.\apex-highlight.exe tui
```

无参数且在交互终端运行时，自动进入 TUI。首次启动可按系统提示手动批准主程序；同一文件被用于所有媒体工作。此版本不做 Developer ID 签名、公证或 Authenticode 签名。系统策略、更新后的文件仍可能触发检查，单文件结构不代表通过了所有系统安全策略。

- 设置 → 分析 → 选片 → 导出；音频/伤害检测算法沿用 Go 版本。
- 候选列表按 `P` 打开内置播放器，关闭窗口返回；无需外部 ffplay。
- 方向键移动，空格选择，`A` 全选/清空；按界面提示返回和导出。
- TUI 将勾选片段分别导出为 `outputs/<录像名>/clip_001.mp4` 等文件；同名目录添加后缀。
- CLI `render` 将提供的区间按输入顺序合并为一个文件。现有文件不会被覆盖。
- 不再接受非空 `--tools-dir`，也不会回退查找系统 PATH。

CLI 示例（将 `apex-highlight` 替换为主程序路径）：

```sh
apex-highlight doctor
apex-highlight probe '录像.mkv'
apex-highlight analyze --mode audio --output audio.json '录像.mkv'
apex-highlight analyze --mode damage --output damage.json '录像.mkv'
apex-highlight render --source '录像.mkv' --intervals damage.json --output montage.mp4 --mode precise
```

## 构建

在仓库根目录运行。构建需要 Python 3.12+、Go（版本见 go.mod）、C 编译器、make、pkg-config、nm、ar。运行产物不需要这些工具。

### macOS

安装 Xcode Command Line Tools、Go、Python 和 pkg-config 后：

```sh
python3 go/scripts/build_native.py --test --package
```

默认从已校验的官方源码构建 FFmpeg、SDL。目标架构使用当前宿主架构，当前支持 arm64 和 amd64。产物位于 `dist/cgo/darwin-<架构>/`，ZIP 位于 `dist/cgo/`。编译目标设置为 macOS 11.0；最低版本运行兼容性仍需在对应系统实测。

### Windows x64

安装 Go 和 MSYS2，在 **UCRT64** 终端安装构建依赖：

```sh
pacman -S --needed make diffutils tar xz mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-python mingw-w64-ucrt-x86_64-pkgconf
python go/scripts/build_native.py --test --package
```

也可在配置好依赖后从 PowerShell 执行 `./go/scripts/build_windows.ps1`；默认 MSYS2 路径为 `C:\msys64`。Windows 产物位于 `dist/cgo/windows-amd64/`。

两平台使用同一个构建入口；CI 定义在 `.github/workflows/go-cgo.yml`。CGO 需要目标 C 工具链和 SDK，本分支不再使用纯 Go 的 macOS→Windows 交叉构建。

### 缓存、源码和重新链接

- 第一次编译在 `build/cgo/` 解压源码并构建，后续复用对象文件。
- FFmpeg 固定 7.1.1，SDL 固定 2.32.6；源码下载校验 SHA-256。
- `go/native/<平台-架构>/` 存放静态库；`internal/native/link_<平台>_<架构>.go` 是本机生成的链接配置，均不提交。
- `build/go-modcache/`、`build/go-cache/` 为 Go 依赖和编译缓存。
- 更新或修改静态库源码后运行 `--rebuild-native`；已解压的源码改动会保留。
- `--sdl-prefix DIR` 可用于开发，必须包含 `lib/libSDL2.a`。正式打包使用默认源码构建，以便记录一致的来源和最低系统版本。
- 包含原始 FFmpeg/SDL 源码、应用源码、构建脚本及许可证，支持更换 LGPL 库后重新链接。FFmpeg 未启用 GPL/nonfree 部分。

## 实现结构

`internal/native.Command()` 始终定位当前可执行文件，以内部工作参数启动它。子进程通过 CGO 进入静态链接的 C 函数；不释放、下载或查找其他可执行文件。

FFmpeg 的三个 CLI 入口不是稳定的公共库 API，因此固定源码版本。构建时对各入口及其工具层全局符号加前缀，共享一份 libav* / SDL 静态库。Windows 的工具层禁用再次解析完整 OS 命令行，直接使用 Go 传入的 UTF-8 参数。

工作进程隔离了上游工具的全局状态、信号处理和 `exit()`；取消会终止并回收工作进程。ffplay 在启动线程进入 C，满足 macOS Cocoa 的主线程要求。它是**单个可执行文件、多个工作进程**的实现。

`highlight` 保留原有音频/HUD 分析、precise/fast 剪辑、帧边界、错误传播和覆盖保护；`workflow` 管理批次、持久化与导出；`tui` 管理界面与选片。

## 验证

`--test` 执行现有算法测试、真实媒体集成测试、工作进程取消、中文路径和 SDL 无窗口音频播放，再执行 `go vet`。

`--package` 额外执行 `verify_native.py`：审计动态库，将主程序单独复制到临时目录，清空 PATH，运行探测、两种分析、两种导出、完整成片解码及内置音频播放，再生成 ZIP。报告写入包内 `build-info.json`。

该自动检查不覆盖真实 GUI 播放体验或下载文件首次运行的系统提示。Windows 实际构建/运行与 macOS GUI 验证结果见 `CGO_VALIDATION.md`；旧外部工具版的记录保留在 `VALIDATION.md`。
