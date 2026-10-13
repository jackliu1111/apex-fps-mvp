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

## 当前模型服务与桌面包

当前 Python Web 和 Electron 入口使用 FFmpeg／ffprobe，模型主线不需要 ffplay。Web 可用 `--ffmpeg`／`--ffprobe` 显式指定路径；桌面开发模式使用 `APEX_FFMPEG`／`APEX_FFPROBE`。未显式指定时的配置与查找行为见 [Web 入口](python-model-web.md) 和 [桌面入口](desktop-model.md)。

桌面包在目标平台的推理环境中构建：

```sh
python scripts/build_model_desktop.py \
  --model-workspace /path/to/apex-voice-detect \
  --ffmpeg /path/to/native/ffmpeg --ffprobe /path/to/native/ffprobe \
  --media-license-dir /path/to/media-license-source-and-build-provenance
```

`bin/`、`build/`、`dist/` 均被 Git 忽略；克隆代码不会带上媒体工具。上表记录的是历史准备情况，构建时应核对实际工具、平台架构和许可证材料。

旧终端包的 `build_macos.py`／`build_windows.py`／`build_windows.bat` 已随 version0 功能移除；历史构建和验证文档从 [封存源码](archive-version0.md) 查阅。当前桌面验证范围见 [桌面验收](desktop-validation.md)，Windows 实机与人工边界复核仍需独立完成。
