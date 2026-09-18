# Apex Highlight · TypeScript 本地网页版

**解压 → 双击程序 → 浏览器选片。视频、预览、导出均留在本机。**

技术栈：React / TypeScript 界面，Bun 本地 HTTP 服务及编译打包，TypeScript 音频与 HUD 图标定位、本地 PaddleOCR 数字识别，预编译 FFmpeg / ffprobe 解码及 H.264 / AAC 导出。Bun 运行时与网页资源编入主程序，音频功能无需额外语言环境；当前源码的伤害识别需要 Python 3.13 与 PaddleOCR，见 [OCR 安装与调试](docs/paddleocr-debug.md)。旧发布包不包含本次更改。

## 使用发布包

- Windows x64：解压 `apex-highlight-windows-x64.zip`，双击 `apex-highlight.exe`。
- macOS Apple Silicon：解压 `apex-highlight-darwin-arm64.zip`，双击 `启动.command`；也可运行 `./apex-highlight`。
- 保留整个目录及 `tools`，不要只复制主程序。浏览器需要现代 Edge / Chrome。
- 操作顺序：添加一个或多个本地录像 → 选择伤害或音频模式 → 分析 → 播放候选、勾选片段 → 导出。
- 关闭网页后任务仍继续；侧栏“退出程序”会取消任务并关闭服务。

默认任务与预览缓存保存在 `~/.apex-highlight/typescript`。默认输出在 Windows 的 `~/Videos/ApexHighlight` 或 macOS 的 `~/Movies/ApexHighlight`，网页中可修改。多录像分别建立输出文件夹，重复导出自动编号，不覆盖已有文件。

本包未做代码签名。macOS 若阻止打开，可对来源可信的解压目录移除隔离标记，然后重新启动：`xattr -dr com.apple.quarantine /你的解压目录`。验证范围见 [VALIDATION.md](VALIDATION.md)。

## 从源码开发

开发机安装 [Bun](https://bun.sh/) **1.3.13 或更新版本**（CI 固定 1.3.13）；伤害模式另需 [PaddleOCR 环境](docs/paddleocr-debug.md)，音频模式不需要 Python。调试视频需要包含 libx264 / AAC 的 FFmpeg 与 ffprobe。避免使用 1.3.12，其 macOS 编译产物缺陷已在 [1.3.13 修复](https://bun.sh/blog/bun-v1.3.13#javascript-bundler)。

```sh
cd typescript
bun install --frozen-lockfile
bun run dev -- --tools-dir /你的媒体工具目录
```

也可将工具放在 `typescript/tools/darwin-arm64`（Windows 为 `win32-x64`），或加入 PATH。源码启动打印本地地址；直接运行会自动打开浏览器。程序只监听 `127.0.0.1`，随机端口，每次启动使用独立访问令牌，不提供远程服务。

## 一条命令打包 Windows

在 macOS 上也可以执行：

```sh
cd typescript
bun install --frozen-lockfile
bun run package bun-windows-x64
```

输出 `dist/apex-highlight-windows-x64.zip` 和 SHA-256 校验文件。打包脚本下载固定版本的预编译 FFmpeg / ffprobe，按仓库清单校验 SHA-256，再由 Bun 交叉编译 EXE。首次运行需要访问 GitHub 和 Bun 下载源。开发者只需 Bun，不需要 Windows 编译器或 Python。

`bun run package bun-darwin-arm64` 生成 Apple Silicon 包；也接受 `bun-darwin-x64`、`bun-linux-x64`、`bun-linux-arm64`。交叉编译成功只证明产物生成，真实运行由对应操作系统验证。GitHub Actions 为 Windows / macOS 分别运行编译、算法和完整流程检查。

```text
apex-highlight-windows-x64/
  apex-highlight.exe       # 程序、Bun 运行时和网页资源
  tools/ffmpeg.exe
  tools/ffprobe.exe
  licenses/                # 媒体工具来源、构建信息与第三方许可
  使用说明.txt
```

## 功能与边界

- **音频模式**：16 kHz 单声道、25 ms RMS、分位阈值、间隔合并与前后保留；它寻找高能量声音，候选需要人工检查。
- **伤害模式（keyframes-v1）**：全程只解码关键帧，每帧识别一次，不再进行 5 秒探测、连续双帧确认或 10 FPS 补查。相邻关键帧读数上升则选中整个区间，相等则不选；未知或下降断开增长基线。
- 使用关键帧的实际时间戳，间隔由源录像决定。基础高亮区间不足 **5 秒** 时先向前扩展，片头空间不足则向后补足；整段不足 5 秒保留可用全长。默认合并间距不超过 **5 秒** 的窗口，再加前 **1 秒**、后 **2 秒** 缓冲，合并重叠并裁剪至录像边界。
- 参数页保留合并间隔和前后缓冲。旧设置采样率被忽略。历史 `interval-v1` 和更早的 TypeScript 结果继续按原格式查看、预览和导出，不改写已有任务。
- 图标定位保持现有多尺度匹配；数字改用本地 PaddleOCR 整串识别，不再进行数字模板匹配或多读数取最大值。首次定位候选同样由 OCR 验证，每段录像独立维护定位状态。
- FFmpeg 使用 `-skip_frame nokey` 读取实际关键帧。为便于调试，当前全程保留完整分辨率供帧，每个关键帧保存标框原图、实际 OCR 输入和 JSON 结果；未定位帧也保存原图。路径见任务日志与 `stats.ocr_debug_dir`，具体结构见 [OCR 调试说明](docs/paddleocr-debug.md)。保存全图会增加耗时和磁盘占用。
- 曲线圆点表示实际关键帧读数，虚线表示相邻关键帧的线性区间估算。未知、下降以及最后关键帧之后的未观测尾段不连线。候选显示高亮窗口数，窗口净增量不视为命中次数，也不生成精确伤害事件。
- 单帧误读可能形成错误候选，关键帧之间的短暂变化或重置可能漏检。此功能不是击杀检测，也不保证找到所有伤害。关键帧很密集时，读取帧数的减少幅度也会变小。
- 进度依次显示文件校验、媒体信息、关键帧识别、候选生成。结果记录算法标识、单帧确认规则、最短窗口、关键帧数量和间隔、输出帧数、管道字节数、FFmpeg 启动次数及 HUD 耗时。音频模式沿用原流程。
- 日志和阶段记录保存在任务文件中，完成或取消后可从“最近任务”查看。旧任务没有的日志不会补造。同一浏览器地址下会记住日志显隐选择。阶段耗时是该阶段的实际经过时间，包含解码、供帧、匹配等等待与处理，不等于定位算法本身的纯计算耗时。
- 候选页显示原录像时间轴、未知区间断线、确认增长、精确读数、范围缩放，以及按需生成的浏览器 MP4 预览。
- 正式导出 H.264 / AAC MP4，保留原尺寸（奇数尺寸向下取偶数），按标称帧率对齐时间边界。可变帧率录像转恒定帧率；采样时刻不是游戏命中发生时刻。
- 每次分析保存源文件绝对路径、大小、修改时间、媒体信息、完整读数变化及候选；分析、预览和导出只检查文件元数据，不再扫描全文件计算 SHA-256。大小或修改时间变化会要求重新分析；同时保留大小和修改时间的内容替换无法检测。已有含 SHA-256 的结果仍可使用。导出中取消或失败会清理当前录像未完成的输出，已完成其他录像保留。
- 本分支新增实现位于 `typescript/`；旧 Python / Go 文件作为迁移参考保留，不参与新程序构建，旧版结果格式暂不导入。

## 验证

当前数字识别与调试保存见 [PaddleOCR 说明](docs/paddleocr-debug.md)。此前模板关键帧方案见 [历史实现与验证](docs/keyframes-v1.md)。历史 5 秒探测方案的接口见 [实现说明](docs/interval-v1.md)，macOS 功能、性能及差异画面见 [验收报告](docs/interval-v1-validation.html)（[Markdown 与原始证据](docs/interval-v1-validation.md)）。该历史方案的两组完整实测均未提速，Windows 尚未实机验证。

```sh
bun run check
bun test
bun run verify --tools-dir /你的媒体工具目录
# 验证编译后的完整包
bun run verify --binary ./dist/darwin-arm64/apex-highlight
```

完整流程检查生成确定性带声轨 HUD 视频，覆盖两种分析、多文件、中文空格路径、浏览器预览 Range 请求、选片导出、帧数和音轨、不覆盖、源文件变更拒绝、并发拒绝、取消、重启恢复与关闭。

常用启动参数：`--no-open`、`--port 端口`、`--data-dir 目录`、`--output-dir 目录`、`--tools-dir 目录`。`doctor` 检查媒体工具与编码器；`--help` 查看说明。
