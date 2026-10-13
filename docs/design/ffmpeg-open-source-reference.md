# FFmpeg 开源项目集成与分发参考

历史研究记录：保留本次调查时的事实、判断与验证范围；其中的优先方向和待验证项不自动代表当前状态。当前原型接入情况见 [FilmCraft 原型说明](../../integrations/filmcraft/README.md)，最新交互范围见 [AI 识别与选片方案](ai-recognition-workspace.md)。

日期：2026-10-13。状态：源码与官方文档调研，未选定替代架构。

关联讨论：[桌面软件体积优化](runtime-footprint.md)。本轮沿用已确认约束：优先完整功能准备好后的安装总占用；用户无需自行安装 Python/FFmpeg；保持识别结果和现有使用能力；允许评估界面框架替换。

本次查看官方仓库、构建脚本、调用代码和官方文档，没有下载或拆解这些项目的发行包，没有运行它们，也没有为 Apex 构建替代发行包。因此能确认集成与分发方式，不能给出 Apex 可节省多少 MiB 的结论。GitHub star 数为本日 API 快照，只用于筛选有代表性的项目，不作为体积或质量的证明。

## 结论

这些项目提供两类主要参考：LosslessCut 随应用携带 FFmpeg/ffprobe，仍通过命令行子进程使用；OBS、HandBrake 等通过 FFmpeg 库 API 集成媒体能力。Shotcut 同时使用媒体库和随包命令行工具。它们不支持“知名桌面项目普遍依赖 Windows/macOS 自带媒体解析器，因此不需要分发 FFmpeg”这一推断。

对 Apex 最值得先验证的是 LosslessCut 的 Windows/Linux 分发方式：**保留 `ffmpeg`/`ffprobe` 调用接口，让二者共用一套随包媒体动态库**。第二步才是按当前产品能力配置 FFmpeg 构建。直接迁移到库 API 或两个系统媒体框架，需要同时迁移媒体行为，成本更高；是否值得取决于实际体积收益。以上为针对本项目约束的工程判断，不是这些项目已经替 Apex 验证的结果。

**后续实测修正（2026-10-13）**：在 Downloads 找到当前 Apex Mac 应用后，已确认其两个媒体工具本来就通过 `@rpath` 共用随包 FFmpeg 动态库；因此这个 Mac 产物不能再次把“改为共享库”计为新增收益。前期仓库 `bin/` 中较大的独立文件不是该包的媒体输入。现阶段应优先依据 [安装体积实测与预算](losslesscut-ai-integration.md) 评估模型、推理库和应用底座；Windows 仍需其真实包核查。

## 项目对照

| 项目 | GitHub stars | 如何使用 FFmpeg | 官方分发特点 | 对 Apex 的参考价值 |
| --- | ---: | --- | --- | --- |
| [LosslessCut](https://github.com/mifi/lossless-cut) | 44,509 | Electron 应用启动 `ffmpeg`/`ffprobe` 子进程 | macOS 随包携带两个工具；Windows/Linux 随包携带工具和共享 DLL/SO | 最接近现有调用边界，适合先比较共享库与现有媒体包的完整占用 |
| [OBS Studio](https://github.com/obsproject/obs-studio) | 77,400 | 插件直接链接 FFmpeg 库；也有专用 `obs-ffmpeg-mux` 辅助进程 | Windows/macOS 构建部署逻辑会收集所需非系统动态库 | 证明库集成与进程隔离可以并存；不是把现有命令换个路径即可完成的迁移 |
| [HandBrake](https://github.com/HandBrake/HandBrake) | 24,648 | 直接调用 FFmpeg 库 API，并按需编译 | 自己构建 FFmpeg，关闭通用命令行程序；库链接形式需按平台判断 | 适合借鉴功能清单驱动的裁剪；不能直接照搬转码器的功能清单 |
| [Shotcut](https://github.com/mltframework/shotcut) | 15,407 | Qt/MLT 媒体引擎使用 FFmpeg 库，同时启动部分 FFmpeg 命令行任务 | Windows/macOS 随包提供依赖，构建中还携带 `ffmpeg`/`ffprobe`/`ffplay` | 不能把“库集成”理解为不带媒体依赖，或不再携带任何辅助程序 |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | 197,211 | 使用外部 FFmpeg/ffprobe 可执行程序 | 独立包可以携带 Python；FFmpeg/ffprobe 仍另备，可指定路径 | 是分发边界的反例：主程序小不代表完成合并、后处理所需的总安装占用小 |

stars 来源：对应仓库的 GitHub API `GET /repos/{owner}/{repo}`，2026-10-13 实时读取。

## LosslessCut：随包工具，共享库分发

核查版本：[70f2663a7a7c995903701acd2f616d057f4fdc2f](https://github.com/mifi/lossless-cut/commit/70f2663a7a7c995903701acd2f616d057f4fdc2f)。

- [package.json](https://github.com/mifi/lossless-cut/blob/70f2663a7a7c995903701acd2f616d057f4fdc2f/package.json) 的 `download-ffmpeg-*` 脚本分别准备目标平台的媒体工具。Windows x64/arm64 选择名称含 `gpl-shared` 的构建，并保留 `ffmpeg.exe`、`ffprobe.exe` 和 `*.dll`；Linux 保留两个程序和 `lib*.so*`；macOS 下载 `ffmpeg`、`ffprobe`。各平台的 `extraResources` 再把它们复制到应用资源目录。这是构建时获取、随发行包交付，不是要求终端用户先安装 FFmpeg。
- [src/main/ffmpeg.ts](https://github.com/mifi/lossless-cut/blob/70f2663a7a7c995903701acd2f616d057f4fdc2f/src/main/ffmpeg.ts#L52) 中，打包后默认从 `process.resourcesPath` 定位工具；`runFfmpegProcess` 和 `runFfprobe` 使用 `execa` 启动子进程。Linux 运行时将资源目录加入 `LD_LIBRARY_PATH`，使随包共享库可被加载；同时支持用户显式指定自定义工具目录。

可以保持命令行接口，却不必把所有媒体代码各自静态放进两个大程序。概念组织如下，实际文件名由 FFmpeg 版本和平台决定：

```text
应用资源目录/
  ffmpeg.exe
  ffprobe.exe
  avcodec-*.dll
  avformat-*.dll
  avutil-*.dll
  swresample-*.dll
  其他所需 DLL
```

**[推断，待 Apex 实测]**：如果现有两个媒体工具各自静态包含大量相同代码，共享库分发可能降低二者合计占用。必须比较“两个工具 + 全部动态库 + 所需运行时”，并核对版本、编解码器和构建选项，不能只比较两个 exe 大小，也不能据此承诺特定节省比例。LosslessCut 的资料证明它采用该组织方式，没有提供同条件静态/共享构建的体积对照。

## OBS Studio：库 API 与专用辅助程序并存

核查版本：[7d98bebe1115b12608837b622164ea5fe6d9483a](https://github.com/obsproject/obs-studio/commit/7d98bebe1115b12608837b622164ea5fe6d9483a)。

- [plugins/obs-ffmpeg/CMakeLists.txt](https://github.com/obsproject/obs-studio/blob/7d98bebe1115b12608837b622164ea5fe6d9483a/plugins/obs-ffmpeg/CMakeLists.txt) 将插件链接到 `FFmpeg::avcodec`、`avfilter`、`avformat`、`avdevice`、`avutil`、`swscale`、`swresample` 等目标，属于库集成。
- [ffmpeg-mux/CMakeLists.txt](https://github.com/obsproject/obs-studio/blob/7d98bebe1115b12608837b622164ea5fe6d9483a/plugins/obs-ffmpeg/ffmpeg-mux/CMakeLists.txt) 构建 OBS 自己的 `obs-ffmpeg-mux` 程序并链接 FFmpeg 库。它是专用辅助程序，不能直接等同于通用 `ffmpeg.exe`。
- [Windows 部署逻辑](https://github.com/obsproject/obs-studio/blob/7d98bebe1115b12608837b622164ea5fe6d9483a/cmake/windows/helpers.cmake) 收集导入的库并安装；[macOS 部署逻辑](https://github.com/obsproject/obs-studio/blob/7d98bebe1115b12608837b622164ea5fe6d9483a/cmake/macos/helpers.cmake) 的 `_bundle_dependencies` 排除系统库，将需要的非静态依赖收进应用。这说明库 API 集成仍有随应用部署依赖的工作。

**对 Apex 的判断**：可以考虑用一个专用媒体 helper 包装探测、抽音频、预览和导出，使它们共用库；但需重做当前命令参数、错误处理、时间戳和实际导出范围测量的实现与验证。OBS 的集成方式本身不证明比 Apex 现有方案更小。

## HandBrake：按产品需要编译库

核查版本：[e02567fe3808349edcd400d6e1e8960e7b43c129](https://github.com/HandBrake/HandBrake/commit/e02567fe3808349edcd400d6e1e8960e7b43c129)。

- [contrib/ffmpeg/module.defs](https://github.com/HandBrake/HandBrake/blob/e02567fe3808349edcd400d6e1e8960e7b43c129/contrib/ffmpeg/module.defs) 使用 `--disable-programs`，不构建 FFmpeg 通用命令行工具；关闭编码器、滤镜、封装器等集合后，再明确启用所需项。`--enable-small` 只用于 `size-aggressive` 构建条件，不能称为所有发布构建默认开启。
- [libhb/encavcodec.c](https://github.com/HandBrake/HandBrake/blob/e02567fe3808349edcd400d6e1e8960e7b43c129/libhb/encavcodec.c) 直接调用 `avcodec_send_frame`、`avcodec_receive_packet` 等库 API。
- [libhb/module.defs](https://github.com/HandBrake/HandBrake/blob/e02567fe3808349edcd400d6e1e8960e7b43c129/libhb/module.defs) 的 Windows/MinGW 分支把 `libavformat.a`、`libavfilter.a`、`libavcodec.a`、`libavutil.a`、`libswresample.a`、`libswscale.a` 等链接进 `hb.dll`。这一证据仅能说明该分支，不能概括成全平台同一种静态链接方案。

**对 Apex 的判断**：最值得借鉴的是把产品所需能力变成可复现的构建清单；既可以继续保留 CLI，也可以以后再迁移库 API。直接复制 HandBrake 的清单并不成立，因为它与 Apex 的输入、输出、预览和快速复制需求不同。当前没有同条件构建数据，不能推算精简量。

## Shotcut：自带库，也自带工具

核查版本：[f360166260fa5dbe93003c5756567cb4b132dbdb](https://github.com/mltframework/shotcut/commit/f360166260fa5dbe93003c5756567cb4b132dbdb)。

- [官方 README](https://github.com/mltframework/shotcut/blob/f360166260fa5dbe93003c5756567cb4b132dbdb/README.md) 列出 Qt、MLT、FFmpeg 等直接依赖；[官方 FAQ](https://www.shotcut.org/FAQ/) 说明引擎是 MLT 构建在 FFmpeg 等库之上，并说明 Windows/macOS 下载提供所需依赖，Linux 可能依赖发行版的一部分库。这不等于其官方 Linux 包完全依赖系统 FFmpeg。
- [Linux/macOS 构建脚本](https://github.com/mltframework/shotcut/blob/f360166260fa5dbe93003c5756567cb4b132dbdb/scripts/build-shotcut.sh) 配置 FFmpeg 时使用 `--disable-static --enable-shared`；macOS 打包阶段复制 `melt`、`ffmpeg`、`ffplay`、`ffprobe` 等辅助程序，并处理动态库路径。该脚本还显式生成 macOS FFmpeg 动态库。
- [Windows 构建脚本](https://github.com/mltframework/shotcut/blob/f360166260fa5dbe93003c5756567cb4b132dbdb/scripts/build-shotcut-msys2.sh) 同样构建共享 FFmpeg，并在打包中保留 `ffmpeg.exe`、`ffplay.exe`、`ffprobe.exe`。
- [src/jobs/ffmpegjob.cpp](https://github.com/mltframework/shotcut/blob/f360166260fa5dbe93003c5756567cb4b132dbdb/src/jobs/ffmpegjob.cpp#L59) 从应用目录定位 `ffmpeg` 并启动任务。因此 Shotcut 不能仅归类成“只使用库 API，完全没有 FFmpeg 命令行”。

官方维护者在 [2023 年分发说明](https://forum.shotcut.org/t/ffmpeg-portable/41094) 中明确说官网下载构建使用自己携带的 FFmpeg；本次读到的当前构建与调用代码仍与此一致。该说明针对官方提供的构建，不可泛化到所有第三方 Linux 包。

**对 Apex 的判断**：这是兼容性和可控分发的参考，不是精简体积的量化案例。Qt 界面、MLT 引擎和 FFmpeg 集成是不同决策，不能把移除 Electron 的潜在收益归给 FFmpeg 库集成。

## yt-dlp：Python 随包不意味着 FFmpeg 也随包

核查版本：[897341241f2bfb2439fe0367f4c7c9ccd29a3828](https://github.com/yt-dlp/yt-dlp/commit/897341241f2bfb2439fe0367f4c7c9ccd29a3828)。

[README 的依赖与发行说明](https://github.com/yt-dlp/yt-dlp/blob/897341241f2bfb2439fe0367f4c7c9ccd29a3828/README.md#dependencies) 将 FFmpeg/ffprobe 列为强烈推荐的外部二进制依赖，并强调需要实际程序而不是同名 Python 包；独立可执行发行包包含 Python 和标星依赖，FFmpeg 不在随包标星项中。`--ffmpeg-location` 可以指定媒体工具位置；项目另有 FFmpeg 构建渠道。

**对 Apex 的判断**：其独立 Python 部署可研究，但不能照搬“FFmpeg 由用户另备”作为本轮完整交付方案，否则不符合 Q2。即使改为 Apex 首次自动下载，Q1 仍要求把下载后的全部必需文件计入安装占用。

## 建议验证顺序

1. **完整包审计**：测量桌面框架、Python、模型运行库、权重、FFmpeg/ffprobe 及其他资源；同时识别重复副本。沿用完整安装占用口径。
2. **媒体共享库分发对照**：在同版本、同功能、同架构下比较现有媒体工具与“两个 CLI + 一套动态库”。先保留现有调用协议，降低改造范围。迁移成本相对较低，但动态库加载、签名和干净机器运行仍需验证。
3. **FFmpeg 构建清单**：从实际命令和支持契约整理 demuxer、decoder、muxer、encoder、filter、protocol；删除不需要的组件，保留当前承诺的输入兼容性。裁剪收益与测试成本均待测量。
4. **更大改造单独比较**：库 API/helper、原生系统媒体、GUI 框架、Python/推理运行时各自列收益与迁移成本。不要一次合并替换，导致无法判断节省来源和行为差异。

验收至少覆盖媒体信息和多音轨、指定音轨抽取及时间偏移、H264/AAC 预览、快速复制导出、请求与实际导出范围；还要确认识别结果和完整离线流程保持。此处定义后续评估顺序，**没有形成架构选择，也没有声称任何替代构建已通过验证**。
