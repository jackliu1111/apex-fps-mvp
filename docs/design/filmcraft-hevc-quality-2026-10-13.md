# FilmCraft：4K60 激战片段 H.265 档位实测

历史研究记录：保留本次调查时的事实、判断与验证范围；其中的优先方向和待验证项不自动代表当前状态。当前原型接入情况见 [FilmCraft 原型说明](../../integrations/filmcraft/README.md)，最新交互范围见 [AI 识别与选片方案](ai-recognition-workspace.md)。

本机证据说明：本文中的 `outputs/` 路径均相对于仓库根目录，是当时本机验证记录或生成产物；该目录已被 Git 忽略，不随源码提交，也不是 GitHub 下载入口。

2026-10-13，Asia/Shanghai。用户接受后台压缩，希望在保留 4K60 的前提下，根据画质、文件大小和等待时间确定本地存档默认方案。本轮为已安装 FilmCraft 0.7.2 的真实原生导出，未修改产品默认设置。

后续接入决定：用户明确先完善 AI 功能形态，导出沿用 **FilmCraft 自身默认设置**。下方 50 Mbps 是本次画质实验的建议，未被选作接入原型的默认参数；保留实测结果供后续需要时参考。[最新接入范围](auto-highlight-editing.md)。

## 建议默认方案

**本轮建议：H.265／MP4、3840×2160、60 fps、目标 50 Mbps、VBR 1 pass、上限 75 Mbps、硬件编码，作为高画质本地存档默认档。** 35 Mbps 保留为“省空间”选项，20 Mbps 不作为保真优先默认值。

依据是本片段 50 Mbps 保留了更多草叶、岩石和交战瞬间细节；相对原区间编码数据仍减少约 **68.5%**，且三档导出等待处于同一量级。35 Mbps 比 50 Mbps 再小约 29.8%，但最差瞬间的细节损失更明显。该建议限于当前 4K60、SDR、8-bit 游戏录像和本机 FilmCraft 路径；属于有损压缩的取舍，**不承诺无损或所有场景都看不出差别**。

## 测试条件

- 本机：Apple M4、24 GiB，macOS 27.0.1；FFmpeg 7.1.1 用于独立验证。
- 原片：`<样片目录>/2026-08-09 15-31-44.mkv`（本机样片，原片未入库），H.264、3840×2160、60 fps、8-bit 4:2:0、Rec.709，AAC 48 kHz 双声道。
- 固定区间：**440.000–460.000 秒，即 7:20–7:40，20 秒／1200 帧**。画面含快速转向、近距离射击、烟雾、草地和岩石纹理；不复用其他录像的模型推理时间段。
- FilmCraft 新建独立数据目录与测试工程；单段 V1＋关联 A1，原尺寸、原速度、无额外效果。三档完全相同的范围、音频和画面设置。
- 统一采用 HEVC Main 8-bit、VBR 1 pass、VideoToolbox 硬件编码、MP4、AAC 320 kbps；目标码率 20／35／50 Mbps，上限分别为 30／52.5／75 Mbps，输出 GOP 120 帧。`adaptiveBitrate=null`，GPU 合成保持 off。
- 顺序为 **35 → 20 → 50 Mbps**，一次一档，导出时没有并行运行评分或截图解码。耗时采用应用任务结果，不含后续质量分析；不是清缓存冷启动、机器独占或多轮统计基准。

每档导出前读取实际生效设置；导出后硬件编码计数分别增加 **1 会话／1200 帧／0 拒绝**。环境与范围（`outputs/filmcraft-hevc-quality-20261013/manifest.json`）、35 Mbps 设置示例（`outputs/filmcraft-hevc-quality-20261013/evidence/resolve-35mbps.json`）、真实任务计时（`outputs/filmcraft-hevc-quality-20261013/evidence/benchmark-results.json`）、硬件计数（`outputs/filmcraft-hevc-quality-20261013/evidence/hardware-deltas.json`）。

## 文件大小与耗时

| H.265 目标档位 | 20 秒文件大小 | 相对原区间编码数据减少 | 应用导出耗时 | 本样本等比例每分钟大小 |
| --- | ---: | ---: | ---: | ---: |
| 20 Mbps | 50.77 MB | 87.3% | 23.796 秒 | 152 MB |
| 35 Mbps | 88.31 MB | 77.9% | 26.024 秒 | 265 MB |
| 50 Mbps | 125.84 MB | 68.5% | 22.945 秒 | 378 MB |

MB 使用十进制。大小分母为原片相同 PTS 区间的编码包：视频 399,441,916 字节、音频 490,567 字节，合计 **399.93 MB**；不含容器开销及独立复制剪切所需的前置关键帧。因此减少比例是近似存储对照，不是另一个精确 20 秒复制成片的文件大小。原区间包统计（`outputs/filmcraft-hevc-quality-20261013/evidence/source-payload-size.json`）。

三档均约耗成片时长的 1.15–1.30 倍。**本轮不能推断 50 Mbps 比 20 Mbps 更快**：单次测量且顺序、缓存和机器负载有影响；可得出的结论是提高码率没有造成明显更长等待。本段每分钟大小为线性换算，未实测整段长录像。

## 原尺寸局部观察

源片 449.000 秒与导出第 540 帧（9.000 秒）已保存实际解码时间戳，四图使用相同裁切坐标，不缩放像素。左上原片、右上 20 Mbps、左下 35 Mbps、右下 50 Mbps。

- **20 Mbps**：草叶明显变软，岩石与地面细纹被抹平；HUD 文字仍可读，但不适合作为保真优先默认档。
- **35 Mbps**：草地和岩石细节改善，仍比原片和 50 Mbps 更软；可作为空间优先的平衡档。
- **50 Mbps**：这组对照中细节最接近原片，仍有重编码损失，不能称为数学无损。

瞄准／岩石原尺寸对比（`outputs/filmcraft-hevc-quality-20261013/visuals/frame-0540-aim-comparison.png`）、草地原尺寸对比（`outputs/filmcraft-hevc-quality-20261013/visuals/frame-0540-grass-comparison.png`）、HUD 原尺寸对比（`outputs/filmcraft-hevc-quality-20261013/visuals/frame-0540-hud-comparison.png`）。这些是静帧观察；不能代替正常速度播放时的个人视觉偏好判断。

## 全帧质量分析

每档对全部 **1200 帧、原始 3840×2160 像素**计算指标，未缩小画面或抽帧。SSIM／PSNR 以 YUV 8-bit 比较；PSNR 由全部帧的平均 MSE 汇总，非直接平均每帧 dB。VMAF 统一使用本机 libvmaf 3.0.0 所带官方 `vmaf_4k_v0.6.1` 模型，并保存模型文件与哈希。

| 档位 | 4K VMAF 平均 | VMAF 最低单帧 | SSIM 平均 | PSNR | 最差 1 秒平均 VMAF |
| --- | ---: | ---: | ---: | ---: | ---: |
| 20 Mbps | 89.491 | 78.440 | 0.931454 | 36.103 dB | 86.299 |
| 35 Mbps | 95.437 | 86.841 | 0.955191 | 38.378 dB | 93.218 |
| 50 Mbps | 97.972 | 90.473 | 0.966601 | 39.861 dB | 96.438 |

三档最差一秒均为 **原片 450–451 秒／成片 10–11 秒**，不是只挑静止或画质好的帧。20、35 Mbps 最低点为成片第 631 帧（原 PTS 450.517 秒），50 Mbps 最低点为下一帧（原 PTS 450.533 秒）。第 631 帧的实际对照可见低码率下敌人轮廓、草地、护栏和石壁细纹的损失：最差窗口内瞄准细节对比（`outputs/filmcraft-hevc-quality-20261013/visuals/frame-0631-aim-comparison.png`）。

另以原像素裁出中央 3456×1836 游戏区域，排除边框和部分 HUD；三档区域 SSIM 分别为 **0.930973／0.955084／0.966616**，排序一致。这不是独立的 VMAF 模型评分，也没有用区域裁切替代全画面结果。

指标覆盖 FilmCraft 的解码、合成、颜色转换及 HEVC 编码整条导出路径带来的新增差异，不是独立编码器的同质量对照。原片本身已经过 H.264 压缩，参考目标是保留这份录屏，不能推断相对游戏原始渲染的质量。

VMAF 4K v0 的观看假设是 4K 电视、1.5 倍屏高距离，未针对 60 fps 做新版本的 HFR 校准。本轮只将其用于同素材、同模型的档位比较；**98 分不是“98% 无损”，也不单独证明视觉无损**。模型适用范围见 [Netflix 官方说明](https://github.com/Netflix/vmaf/blob/0b9462873f9b36ccb3770587dbbf43aef4c786ec/resource/doc/models_v0.md#L32-L40)、[高帧率限制](https://github.com/Netflix/vmaf/blob/0b9462873f9b36ccb3770587dbbf43aef4c786ec/resource/doc/models_v1.md#L54-L60)。

三档均核实 HEVC Main、yuv420p、Rec.709 limited range、3840×2160、60/1 fps、1200 帧、视频恰好 20.000 秒；AAC 双声道音频约 20.010 秒。使用 `-xerror` 全量音画解码均通过。源视频实际解码 PTS 为 440.000–459.983，输出为 0–19.983333；按帧编号对齐，容许源 MKV 的毫秒量化，禁用滤镜末帧重复，全部指标各有 1200 条记录。时间格与记录数证明评分管线没有增删帧，内容对应另以原片／成片截图抽样核对，不宣称逐帧内容完全相同或完成主观音画同步验收。

为排除评分首尾或低分瞬间错位，再对三档各自第 0、631、1199 帧与源目标帧前后各一帧作灰度内容匹配；**9 组 MAE 与局部 SSIM 均在偏移 0 时最佳**。这证明这些采样位置的内容对应，不能外推全片没有任何重复帧。采样对齐记录（`outputs/filmcraft-hevc-quality-20261013/content-alignment-samples/summary.json`）。

全帧验证摘要与逐帧数据入口（`outputs/filmcraft-hevc-quality-20261013/quality-evidence/summary.json`），每档子目录包含逐帧 CSV、最低分帧、全部 1 秒窗口和完整探测结果。质量计算在导出后单独运行，不计入导出耗时。

## 样片与工程

- 20 Mbps 样片（`outputs/filmcraft-hevc-quality-20261013/native/hevc-20mbps.mp4`）
- 35 Mbps 样片（`outputs/filmcraft-hevc-quality-20261013/native/hevc-35mbps.mp4`）
- 50 Mbps 样片（`outputs/filmcraft-hevc-quality-20261013/native/hevc-50mbps.mp4`）
- 20 秒测试工程（`outputs/filmcraft-hevc-quality-20261013/native/fight-440-460.fcproj`）

## 与编辑器改造的关系

FilmCraft 的 H.265 档位是重新编码后的存档方案；它仍没有原生 LosslessCut 式视频复制导出。本轮 macOS HEVC 只有硬件 CBR／VBR1Pass，不能把 x265 的 CRF 数字或 `quality` 参数当成原生 HEVC 质量档。相关结论来自固定版本源码与真实导出设置。[参数核查与官方链接](editor-comparison-source-notes.md#补充核查4k60-h265-档位参数filmcraft-v072--macos)、[此前关键帧测试](filmcraft-fast-export-2026-10-13.md)。

在用户接受后台压缩的前提下，可以继续采用“AI 原始草稿保留 → 复制后人工复核 → 一键提交后台导出”的产品流程。导出应固定提交时的草稿版本，成功校验后再显示完成，并保留原片和 AI 结果；本轮未实现或验收长任务队列、应用退出后继续运行、崩溃恢复等能力。

本次专用 FilmCraft 实例已正常退出，未修改原视频；前后文件大小和修改时间一致。本轮未执行整个原文件哈希或全长导出，也没有实施删除原片、自动替换存档或修改应用全局默认值。清理与原片状态记录（`outputs/filmcraft-hevc-quality-20261013/evidence/cleanup.json`）。
