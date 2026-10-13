# FilmCraft 关键帧快速导出核查与实测

历史研究记录：保留本次调查时的事实、判断与验证范围；其中的优先方向和待验证项不自动代表当前状态。当前原型接入情况见 [FilmCraft 原型说明](../../integrations/filmcraft/README.md)，最新交互范围见 [AI 识别与选片方案](ai-recognition-workspace.md)。

本机证据说明：本文中的 `outputs/` 路径均相对于仓库根目录，是当时本机验证记录或生成产物；该目录已被 Git 忽略，不随源码提交，也不是 GitHub 下载入口。

2026-10-13，Asia/Shanghai。问题：游戏切片以快捷为优先，FilmCraft 是否能像 LosslessCut 一样按源关键帧复制导出，避免重新编码？

后续需求已明确为可以接受后台 H.265 压缩存档，见[4K60 三档激战画质实测与默认方案建议](filmcraft-hevc-quality-2026-10-13.md)。本文保留此前“是否能复制快导出”的固定版本核查；两项测试回答不同导出目标。

## 结论

**当前已安装 FilmCraft 0.7.2 没有可用的原生 stream-copy／关键帧复制导出模式。** Quick Export 仍是编码导出；起止点落在源关键帧上，也没有自动改走复制路径。官方该版本明确将 smart render 列为未实现，完整视频导出调用链为渲染 → 编码 → 封装。[官方缺口 G13](https://github.com/storytold/filmcraft/blob/v0.7.2/docs/gaps.md#L219-L228)、[完整源码核查范围和链接](editor-comparison-source-notes.md#补充核查filmcraft-是否有关键帧快速复制导出)。

用户本轮把“尽快完成切片与导出”明确为首要目标，因此上一轮优先 FilmCraft 的建议需要加上条件：它适合连续草稿编辑，但其原生导出不是游戏快剪路线。**如果优先使用现成、已测的快剪能力，LosslessCut 更符合当前优先级。** 若仍选 FilmCraft，就需要另行实现并验收复制导出模块；不是打开一个已有选项即可。

## 原生关键帧对齐实测

复用上一轮相同本机和素材：Apple M4／24 GiB，4K60 H.264 + AAC，源文件 `<样片目录>/2026-08-09 15-31-44.mkv`（本机样片，原片未入库）。读取源视频包确认 **38.150 秒与 50.650 秒均为关键帧**，在 FilmCraft 中建立一个无特效、原尺寸、原帧率、关联音轨的 **12.5 秒**草稿。

调用原生 **Quick Export**，选择 **Match Source – Adaptive High Bitrate**，显式启用硬件编码。实际设置解析显示 H.264、3840×2160、60 fps、AAC，目标约 99.53 Mbps；未传入虚构的 copy 开关。原生格式/预设注册表中也没有复制模式。运行时设置（`outputs/filmcraft-fast-export-20261013/evidence/export-resolve.json`）、输出格式注册表（`outputs/filmcraft-fast-export-20261013/evidence/export-formats.json`）。设置解析记录是在原 30 秒序列上读取，随后 12.5 秒实测使用同一预设；具体实测操作见 setup 记录。

| 项目 | 实际结果 |
| --- | --- |
| 源区间 | 38.150–50.650 秒，起止均为源关键帧 |
| 视频时长／帧数 | 12.500 秒／750 帧 |
| Quick Export 耗时 | **14.233 秒** |
| 硬件编码计数变化 | **新增 1 个编码会话、750 个编码帧、0 次拒绝** |
| 输出大小 | 155,770,676 字节 |
| 完整音画解码 | 通过 |

这项测试直接表明：该调用在符合关键帧边界的样本上仍编码了全部输出帧。14.233 秒为应用任务报告耗时，不含事后解码验证；单次本机测试不构成跨设备性能保证。

证据：原生结果摘要（`outputs/filmcraft-fast-export-20261013/native-summary.json`）、关键帧列表（`outputs/filmcraft-fast-export-20261013/evidence/source-keyframes.json`）、真实序列（`outputs/filmcraft-fast-export-20261013/evidence/native-keyframe-sequence.json`）、设置与调用过程（`outputs/filmcraft-fast-export-20261013/evidence/native-keyframe-setup.json`）、输出验证（`outputs/filmcraft-fast-export-20261013/native/keyframe-quick-validation.json`）、成片（`outputs/filmcraft-fast-export-20261013/native/keyframe-quick.mp4`）。

## 名称容易造成的误解

- **Quick Export**：用预设快捷开始同一条编码导出流程，减少操作步骤，不代表复制原码流。
- **关键帧间隔／keyframeDistance**：控制新编码视频的 GOP，不是按原录像关键帧切出片段。
- **硬件编码、GPU 渲染**：分别加速编码和画面合成，仍会生成新编码的视频。
- **Render previews**：本版用于预览播放的缓存，不是最终导出免编码的通道。

以上均按固定版本完整导出源文件和实际设置核对，来源详见[源码补充](editor-comparison-source-notes.md#补充核查filmcraft-是否有关键帧快速复制导出)。负结论不推断未来版本或二次开发能力。

## 外接 FFmpeg 实验：速度可见，范围未通过

为了评估新增快导出按钮的方向，另写了一个输出目录内的临时验证脚本，读取真实 `.fcproj` 的活动序列、源时间与关联音轨，使用外部 FFmpeg 分段复制、拼接。它仅接受当前单源 H.264/AAC、单视频轨及关联音轨、恒等效果、相同尺寸/帧率的工程；复杂效果、变速、混音、裁切等不进入该路径。**它不是 FilmCraft 原生功能，也未接入产品按钮。**

| 初次实验 | 准备耗时 | 复制＋拼接耗时 | 实际容器时长 |
| --- | --- | --- | --- |
| 12.5 秒单段草稿 → MP4 | 0.345 秒 | 0.355 秒 | 约 16.704 秒 |
| 30 秒三段草稿 → MP4 | 共用准备 1.318 秒 | 1.452 秒 | 约 50.622 秒 |
| 30 秒三段草稿 → MKV | 同上 | 2.601 秒 | 约 50.646 秒 |

**这些不是可用快导出的验收成绩，也不能作为相同范围的速度对照。** 12.5 秒请求计划从 38.150 秒关键帧开始，实际包对应却从 33.983 秒开始，带入前一组画面；实际视频覆盖到 50.666 秒。随后仅做输入 seek 向后偏移 1 帧、2 帧的两次小范围复核，仍未解决；已停止调参并保留失败结果。

外部输出均完整解码通过，源视频包连续对应，合并后规范化包一致。这只能证明复制路线和内容顺序，不能证明切点满足计划。首轮脚本的 `validation_passed` 只覆盖这些检查，后补的同范围判定已明确为失败；复测将计划关键帧与实测起点一致也纳入通过条件。实验总摘要（`outputs/filmcraft-fast-export-20261013/external-experiment-summary.json`）、首次同范围判定（`outputs/filmcraft-fast-export-20261013/external-keyframe-mp4/same-range-assessment.json`）。

这说明外接路线值得单独实现和验证，但本轮不把它交付为可靠快导出器，更不能用它宣称 FilmCraft 已支持该能力。这个实验也不否定上一轮 LosslessCut 应用的有效测试：它对相同三个原始请求区间实际完成约 **1.882 秒**，输出 **38.066 秒**，范围另有逐段验证。[上一轮实测](editor-4k-comparison-2026-10-13.md)。

## “所需格式”的速度边界

保留原来的 H.264/AAC 编码，在兼容的 MP4、MKV 等容器间重新封装，是免重编码可以解决的情形。若目标是换成 H.265、改变分辨率、裁切为竖屏或把字幕烧入画面，就需要处理并重新编码视频，不能只靠关键帧复制获得任意输出规格。[FFmpeg streamcopy 与 transcoding](https://ffmpeg.org/ffmpeg.html#Streamcopy)。

本轮以原尺寸、原编码 MP4/MKV 为测试目标，尚未确定用户最终所需的全部输出规格。后续若保留 FilmCraft，产品上应区分“保留原画质的快剪导出”和“改变画面/编码的标准导出”，并在草稿复核时明确实际快剪范围；具体集成方式仍待设计确认。

本次专用 FilmCraft 实例已正常退出；原录像和输入工程未修改，验证只读源文件。测试产物与原始/失败证据均保存在 `outputs/filmcraft-fast-export-20261013/`。
