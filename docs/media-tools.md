# 本地媒体工具与完整发布包

准备日期：2026-09-14。当前先使用已下载的工具，不引入版本锁或自动升级机制。

| 平台 | 本地工具目录 | 当前工具 |
| --- | --- | --- |
| macOS Apple Silicon | `bin/` | FFmpeg / ffprobe 7.1.1；ffplay 9.0.1 |
| Windows x64 | `bin/windows-amd64/bin/` | FFmpeg / ffprobe / ffplay 9.0.1 essentials |

Mac 的三个工具均为 arm64，Windows 的三个工具均为 x86-64。此处没有准备 Intel Mac、Windows ARM64 或 32 位 Windows 的工具。

## 来源及本地文件

- Mac ffmpeg / ffprobe：保留已有的 FFmpeg 7.1.1 自编译工具及构建材料。
- Mac ffplay：[Martin Riedl 构建站](https://ffmpeg.martin-riedl.de/)，下载入口为 `https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffplay.zip`。
- Windows：[Gyan release essentials](https://www.gyan.dev/ffmpeg/builds/)，下载入口为 `https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip`。该发行包面向 Windows 10 及以上。
- 原始 ZIP 和下载校验文件保存在 `build/media-downloads/`；解压后的 Windows 完整发行包保存在 `bin/windows-amd64/`。
- Mac 的来源、版本、许可证及原 ffmpeg 构建材料保存在 `bin/licenses/`。下载链接指向 release 通道，未来重新下载可能得到不同版本。

本次下载 SHA-256 与供应方公布值一致：

```text
ffplay-macos-arm64.zip
7063e79c64c2bf7f0fb61a7a9fb657af87f123f4b63b978a99628f0ebc97ebdf

ffmpeg-windows-amd64.zip
fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9
```

## Python 发布包构建

macOS 在项目根目录执行（先准备上文的 `bin/ffplay`）：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[build]'
.venv/bin/python scripts/build_macos.py
```

Windows 在本机 PowerShell 执行，使用 `bin/windows-amd64/` 中的工具：

```powershell
.\scripts\build_windows.bat
# 或指定完整的 FFmpeg 发行包目录
.\scripts\build_windows.bat --ffmpeg-dir "C:\tools\ffmpeg"
```

发布包位于：

```text
dist/apex-highlight-macos-arm64.zip
dist/apex-highlight-windows-<架构>.zip
```

macOS 包按本机构建架构命名；Windows 架构名由 `platform.machine()` 决定。Python 包必须在对应操作系统构建。

每个包包含主程序、Python 运行环境、依赖、`bin/` 内三个媒体工具、许可证和构建信息。使用者无需安装 Python 或 FFmpeg。完整解压使用，保留 `_internal/`、`bin/` 等全部内容。

`bin/`、`build/`、`dist/` 均被 Git 忽略。仅克隆代码不会带上媒体工具；需另行准备工具后运行或打包。

## 验证边界

打包脚本在限制 PATH 的环境检查程序帮助和 doctor；macOS 脚本还审计动态依赖，要求媒体工具只依赖系统库。

本次分支整理未重新构建 Python 发布包。既有 Python 验证范围见 [VALIDATION.md](../VALIDATION.md)。Windows 构建脚本尚未完成 Windows 实机验收；正式发布前应在目标系统解压，运行 `apex-highlight.exe doctor`，并完成真实录像分析、菜单中的预览播放和导出。

主程序尚未完成开发者签名、公证或 Windows 安全软件验收。
