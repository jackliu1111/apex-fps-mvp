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

## 打包

从项目根目录在 macOS 执行：

```sh
bash go/scripts/build_release.sh darwin arm64
bash go/scripts/build_release.sh windows amd64
```

Windows 本机构建时，带上 `bin/windows-amd64/` 并执行：

```powershell
.\go\scripts\build_windows.ps1 -Architecture amd64
```

发布包：

```text
dist/go/apex-highlight-macos-arm64.zip
dist/go/apex-highlight-windows-amd64.zip
```

每个包均包含主程序、`bin/` 内的三个媒体工具、许可证和构建信息。macOS 使用者无需 Homebrew，Windows 使用者无需单独安装 FFmpeg；两边都无需 Go 或 Python。完整解压使用，不能只移动主程序。

原 Python 打包脚本也已补上 ffplay，并将 Windows 工具目录与 Mac 工具隔离；本次实际生成和验收的是 Go 发布包，未重新构建 Python 发布包。

`bin/`、`build/`、`dist/` 均被 Git 忽略。仅克隆代码不会带上媒体工具；使用已生成 ZIP，或另行复制工具目录。

## 验证边界

macOS 动态依赖检查覆盖三个媒体工具，均仅依赖系统库，不依赖 `/opt/homebrew`。macOS 打包脚本在限制 PATH 的环境检查程序帮助、doctor 和三个媒体工具启动。

Windows 主程序交叉编译，媒体工具使用原生 Windows x64 构建；Mac 上的 PE 架构及导入表检查不能代替 Windows 实机运行。正式使用前在 Windows 解压运行 `apex-highlight.exe doctor`，再完成分析、按 P 预览和导出。当前输出落盘使用硬链接，请选择支持硬链接的输出目录（如 NTFS），不要直接导出到 exFAT/FAT32。

主程序尚未完成开发者签名、公证或 Windows 安全软件验收。

本次 macOS 额外从中文及空格路径解压 ZIP，在不包含 Homebrew 的 PATH 下完成真实录像伤害分析、剪辑导出和成片完整解码。ffplay 已在允许访问桌面的进程中开启播放并正常自动退出（包含音频）；沙箱内因显示服务隔离无法创建窗口。证据位于 `work/bundled-media-validation/summary.json` 和 `verification.log`。
