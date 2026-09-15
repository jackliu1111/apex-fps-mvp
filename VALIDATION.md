# 验证记录 — 2026-09-11

## 伤害模式接入后的验证

- 当前测试总数 22，全部通过。新增真实 HUD 图像读取（包括 2、103、160 和非伤害背景）、四位数字不截断的合成测试、首次/断读/下降基线、合并缓冲、伤害服务数据格式、预览与正式选择记录隔离及覆盖保护。
- 原 496.65 秒 4K60 录像完成伤害分析、编号预览及正式导出：7 段候选，11 次确认增长，合计 2.933 秒。结果位于 `outputs/damage-full-validation/`。
- 正式视频 MPEG-4 Part 2 / AAC，3840×2160、60 FPS；ffprobe 实际解码统计 176 帧，与 selection.json 渲染帧数一致。视频 2.933333 秒，音频 2.933000 秒，两轨从零开始。此项验证媒体时间线，不代表游戏命中时刻被精确识别。
- 720p 编号预览已抽帧检查，编号可见；正式视频不烧录编号。终端显示预览完整路径。
- 已重建 macOS arm64 发布包。用重建后的可执行程序运行真实录像截取样本，成功产生 2 段候选、编号预览、正式视频及独立的 preview.json / selection.json。
- 伤害数模板现包含 0–9，使用二值化、轮廓清理、多阈值一致性及伤害图标检查。其他分辨率的 ROI 适配已实现，但真实多分辨率及四位高伤害样本尚未验收；HUD 遮挡/重排、低清晰度和频繁断读可能漏选。首次读数与断读恢复仅建立基线。
- 日志和媒体探测结果保存在 `work/damage-integration/`；原音频流程验证记录保留如下。

## 范围

在当前 Apple Silicon arm64、macOS 26.6.2（25G83）机器上实现、构建和验证。Python 3.14.0，FFmpeg 7.1.1；完整版本见发布包 build-info.json。

**完成的是本机隔离验证，没有独立干净 Mac、其他 Mac 架构、旧版 macOS、Windows、开发者签名或公证验收。**

## 已通过

1. `python -m unittest discover -s tests -v`：14 项测试。包含原有 3 项检测测试，以及新流程的源文件校验、搬迁、编号顺序、不可变候选列表、旧格式、空候选、硬链接保护、冲突拒绝、失败/中断清理、工具缺失与日志验证。真实 FFmpeg 解码在进度回调触发 KeyboardInterrupt 后退出，按解码采样数更新进度。
2. 原 496.65 秒游戏录像使用原默认参数重新分析，新旧候选 `clips` 与 `config` 完全相同。回归证据：`build/原始结果 回归/clips.json`，原基线 `outputs/clips.json`。
3. 从真实 4K60 H.264/AAC 游戏录像按 70 秒目标长度做 stream-copy 截取；受关键帧影响，样本实际 73.016 秒。用 0.2 秒前后缓冲、1 秒聚类间隔、最少 2 个事件得到 8 个候选。传入 `--clips 3,1`，selection.json 保存 `[1,3]`，完整 clips.json 未改变。成片保留 H.264/AAC、3840×2160、60 fps。
4. 真实 PTY 菜单验证：打开已有结果、默认全选、取消第 1 段、确认导出，selection.json 为 `[2,3,4,5,6,7,8]`；全不选可返回菜单且不写新结果；Ctrl+C 退出码 130。源码与解压后的可执行程序都完成交互验证。
5. 解压发布包到含中文和空格的新目录，以 `PATH=/nonexistent`、独立 HOME 和精简环境运行。通过 doctor、非交互帮助、analyze、指定片段 export、默认 run、inspect；生成成片并用随包 FFmpeg 完整解码，退出码 0 且错误输出为空。
6. 隔离包验证：中文/空格素材与输出目录、静音录像无候选并跳过成片、无 overwrite 的文件冲突、非法编号、源录像覆盖拒绝、旧格式只读、损坏文件错误及磁盘日志。临时移走随包 ffprobe 后 doctor 失败，没有回退到本机工具。
7. 旧 `apex_highlight.py --analyze-only` 与安装后的 `apex-highlight` 命令入口可运行。
8. 审计 71 个 Mach-O 文件，未发现 Homebrew 或外部 Python 绝对动态库依赖；FFmpeg/ffprobe 只链接 macOS 系统库。发布包包含 FFmpeg 完整源码、校验值、构建配置与依赖许可证。

## 导出修正与限制

原 MKV 中间片段在多段 stream-copy 合并中产生重复时间戳警告。改为 NUT 中间容器后，本次选段成片及默认一键成片的完整解码均无错误输出。检测算法不变。

快速裁剪仍受关键帧限制，实际成片长度不一定等于 JSON 候选时长之和；未实现逐帧精确裁剪。没有对所有编码/容器组合、超长录像、磁盘满或跨机器场景做完整兼容性验收。现有测试不能视作生产发布验收。

## 可复查证据与复跑

- 自动测试：`tests/test_detector.py`、`tests/test_workflow.py`
- 终端验证：`scripts/verify_terminal.py`，日志 `build/终端 验收/pty.log`
- 最终二进制隔离验证：`scripts/verify_release.py`，日志 `build/isolated-1789098454426224000/verification.log`
- 构建：`scripts/build_macos.py`，日志 `build/package.log`
- 发布包：`dependency-audit.json`、`build-info.json`、`licenses/`

验证脚本使用本工作区 `build/验收 素材/真实游戏 短录像.mkv`，真实录像及测试成片不随发布包分发。
