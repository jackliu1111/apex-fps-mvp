# 浏览器本地游戏声音时间轴：模型调查（2026-11-17）

调查范围：公开论文、作者仓库、作者发布的权重和运行时文档；没有下载大权重、运行模型或测量浏览器速度。下文的推荐是下一轮验证顺序，不代表 Apex 准确率已经验证。

## 结论

**优先试 EfficientSED 的现成强标签小模型，而不是先训练一个新模型。** 它解决“什么时候发生”的问题，同时公开了小至 release 页面显示 3.43 MB 的 checkpoint。推荐先导出 `fmn04+tf-104_strong`，再试 `fmn10+tf-256_advanced-kd-weak-strong`；后者约 5M 参数，可作质量档。若只需要粗粒度片段标签，CED-Tiny 的官方小体积 ONNX 值得与现有 mn04 并排测试。[EfficientSED 发布资产](https://github.com/theMoro/EfficientSED/releases/expanded_assets/v0.0.1)、[CED-Tiny 文件](https://huggingface.co/mispeech/ced-tiny/tree/main)

项目现状由本次任务提供：mn04 ONNX 约 3.79 MiB、10 秒窗口/5 秒步进、输入 `[1,1,128,1000]`；BEATs_strong_1 约 356 MiB、每 10 秒输出 `[1,250,447]`；当前 CPU WASM 单线程。此处没有重新测量这些本地事实。

## 1. 可部署的强标签候选

EfficientSED 论文首次提交于 **2025-03-14**，公开资产时间为 **2025-04-02**。模型把 MobileNet 的全局池化和分类头换成逐帧结构，输出每 10 秒 250 帧，步距 40 ms、447 个训练类别。实验在训练/评测交集的 **407 类**上计算 PSDS1；不能将这个分数与 527 类 clipwise mAP 混排。[论文](https://arxiv.org/html/2503.11373v1)、[发布资产时间](https://github.com/theMoro/EfficientSED/releases/expanded_assets/v0.0.1)

| 官方 checkpoint | PSDS1 ×100 | 发布页面显示体积 | 定位 |
|---|---:|---:|---|
| fmn04_strong | 39.52 | 3.43 MB | 最简单的小型帧级基线 |
| fmn04+tf-104_strong | 40.10 | 3.64 MB | 首个浏览器导出候选 |
| fmn04+hybrid-104_strong | 41.37 | 4.14 MB | 同小体积区间的质量候选 |
| fmn06+tf-160_strong | 41.78 | 7.63 MB | 中间档 |
| fmn06+hybrid-160_strong | 42.54 | 8.8 MB | 中间档，导出复杂度待验证 |
| fmn10_strong | 42.28 | 14.8 MB | 较大纯 CNN |
| fmn10+tf-256_strong | 43.86 | 19.4 MB | 常规训练 |
| fmn10+tf-256_advanced-kd-weak-strong | 45.25 | 19.4 MB | 约 5M 参数，优先质量档 |

分数是**对应配置的平均表现，不是各下载 checkpoint 单独实测值**；体积是 GitHub 实际资产页面的显示值，单位保留原样，未转成精确 bytes，也不是 ONNX 成品大小。[分数和说明](https://github.com/theMoro/EfficientSED#model-checkpoints)、[资产](https://github.com/theMoro/EfficientSED/releases/expanded_assets/v0.0.1)

40 ms 是输出采样步距，不是边界误差承诺；模型仍利用上下文。论文吞吐测试为 RTX 3090、batch 64、FP16，不能推导浏览器单线程速度。约 5M 的质量档与约 90M 的大 Transformer 比较时，论文 PSDS1 为 45.25 对 45.4–46.5；这是任务相关的规模收益，不是 Apex 实测。[实验设置与结果](https://arxiv.org/html/2503.11373v1)

工程判断：先测试纯 CNN/TF 版本；HYBRID 的双向 minGRU/parallel scan 可能需要额外导出适配，Mamba 版本则依赖专门实现。作者提供的是 PyTorch 研究实现，未在本调查中确认作者维护的浏览器 ONNX。可公开下载不等于已能在 ORT Web 跑通。[实现与安装说明](https://github.com/theMoro/EfficientSED)

## 2. 粗粒度 tagging：MN、DyMN 和 CED

MN 论文首发 **2022-11-09**（ICASSP 2023），DyMN 首发 **2023-10-24**，CED 首发 **2023-08-23**（ICASSP 2024）。它们不是 2026 新模型，但仍有实用的小模型/权重发布。[MN 日期](https://arxiv.org/abs/2211.04772)、[DyMN 日期](https://arxiv.org/abs/2310.15648)、[CED 日期](https://arxiv.org/abs/2308.11957)

| 模型 | 参数 M | AS-2M 训练后评测 mAP ×100 | FP32 参数净载荷估算 MiB |
|---|---:|---:|---:|
| mn04_as | 0.983 | 43.2 | 3.75 |
| mn05_as | 1.43 | 44.3 | 5.46 |
| mn10_as | 4.88 | 47.1 | 18.62 |
| mn20_as | 17.91 | 47.8 | 68.32 |
| dymn04_as | 1.97 | 45.0 | 7.51 |
| dymn10_as | 10.57 | 47.7 | 40.32 |
| dymn20_as | 40.02 | 49.1 | 152.66 |
| CED-Tiny | 5.5 | 48.1 | 20.98 |
| CED-Mini | 9.6 | 49.0 | 36.62 |
| CED-Small | 22 | 49.6 | 83.92 |
| CED-Base | 86 | 50.0 | 328.06 |

参数和分数来自各自作者表，最后一列统一按 `参数数×4/1048576` 计算，**不是文件大小、峰值内存或量化大小**。[EfficientAT 表](https://github.com/fschmid56/EfficientAT#pre-trained-models)、[CED 表](https://github.com/RicherMans/CED)

比较限制：EfficientAT 仓库给的是最佳发布模型，论文给多次平均；不同研究实际可下载的 AudioSet 音频集合、教师蒸馏和训练配置存在差异，因此跨仓库数字只能用于选候选，不能视为同一测试的精确排名。尤其 **48.1 mAP 不等于 48.1% 的游戏事件识别准确率**。[EfficientAT 指标注释](https://github.com/fschmid56/EfficientAT)、[AudioSet 数据分发](https://research.google.com/audioset/download.html)

**CED 的实际体积比只按 FP32 估算更有吸引力。** 作者 Hugging Face 文件页：Tiny `model.onnx` **6.68 MB**、`model.safetensors` **22 MB**；Mini 分别为 **10.9 MB / 38.8 MB**（保留网页单位）。官方导出脚本提供 opset 12、动态时间维，以及仅 MatMul 的 QInt8 动态量化。这里未检查现成 ONNX 图，不能仅凭体积断言其完整精度配置；也未发现与该文件绑定的量化后 48.1/49.0 复测，不能把 FP32 论文分数直接贴到压缩模型上。[Tiny 文件](https://huggingface.co/mispeech/ced-tiny/tree/main)、[Mini 文件](https://huggingface.co/mispeech/ced-mini/tree/main)、[导出代码](https://github.com/RicherMans/CED/blob/main/export_onnx.py)

CED 使用 16 kHz/64 mel，与当前 128 mel 输入不同；替换时要重新实现并验证前处理。作者所说 Tiny 在单 x86 CPU 上可能快于 MobileNet，不是浏览器 WASM 基准。它仍是整段分类器，换上 CED 并不会自动把 5 秒刷新粒度变成真实事件起止点。[作者使用说明](https://github.com/RicherMans/CED)

## 3. 更新的研究与上限：为什么不直接选“最新”

- **SAT，Interspeech 2024**：面向流式 tagging，2 秒延迟时 Tiny 43.3 mAP、Base 45.1；适合未来边录边分析，但仍不是强标签逐帧检测。其评测输入协议不同，不能与 10 秒 CED 分数直接比较。[作者仓库](https://github.com/RicherMans/SAT)
- **SSLAM，ICLR 2025**：公开 AS2M checkpoint，报告 50.2 mAP；主要意义是混合声源表征。仍需另外解决时间定位和大模型运行成本，不是目前小文件浏览器时间轴的首选。arXiv 版本日期 2025-06-13 晚于会议，不应把此日期误当首次发布日。[会议论文](https://proceedings.iclr.cc/paper_files/paper/2025/hash/38d800138804d1904be33b5bfe229030-Abstract-Conference.html)、[代码/权重](https://github.com/ta012/SSLAM)、[arXiv](https://arxiv.org/abs/2506.12222)
- **EAT，IJCAI 2024，2025-05-03 更新 HF 集成**：官方现有 Base 88M / 48.9 mAP，Large 309M / 49.5；Large FP32 参数净载荷估算约 1.15 GiB。名称中的 efficient 主要指预训练效率，不能解释成浏览器推理轻量。[作者模型表与更新日期](https://github.com/cwx-worst-one/EAT)
- **Boundary-Aware / EPN，2026-01-07**：BEATs 加边界训练与事件提议，在 AudioSet Strong 的全文设置中报告 PSDS1 49.6（对比 46.5）；骨干约 90M，加 4.1M 参数头。论文明确当前不支持实时推理。本调查未在论文中找到可直接下载的作者 checkpoint/部署包，列为研究上限，不是已经可替换的浏览器模型。[原论文](https://arxiv.org/html/2601.04178v1)
- **较新的公开发布者报告 Melati**：本次能访问的作者模型卡声称同一 17,141 条评测集上，单 EAT-Large 蒸馏模型 51.24 mAP、六模型 ensemble 52.19（1.20B 参数）。它是发布者自报，未独立复现，首次发布日期未成功核实；不能据搜索抓取时间宣称“2026 最新 SOTA”。其实现仍为 10 秒标签窗口，非逐帧 SED；不适合当前小体积目标。[发布者卡与协议](https://huggingface.co/Scicom-intl/Melati-AudioSet-Ensemble)

检索截止日为 2026-11-17；“本次找到的最新可核实资料”不等于穷尽全部论文。对只出现在排行榜、搜索摘要或转载中的 2026 模型，没有把其数字纳入正式比较。

特别注意：EPN 文中将全文实验描述为全部 447 类，EfficientSED 明确区分 447 个训练输出与 407 类评测交集；本报告保留各论文原口径，不把跨论文 PSDS1 排成严格同协议榜单。

## 4. 下一轮最低成本验证

1. 导出 fmn04+TF104 与 fmn10+TF256 advanced KD；保留 mn04 和 BEATs 作同源对照，记录实际 ONNX bytes、输入/输出、标签顺序及前处理一致性。
2. 在同一浏览器、同一 10 秒声音样本测 WASM 单线程的冷启动、热推理 p50/p95、长音频总耗时、峰值内存；不能用 GPU 论文吞吐或 MACs 排名替代。
3. 先验收 TF/CNN 运算是否能在现有 ORT Web 运行，再比较可选 WebGPU。WebGPU 是运行后端选择，具体图和算子支持仍须实测。[ORT WebGPU 官方说明](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)
4. 人工标注实际 Apex 的枪声、爆炸、脚步、语音和背景噪声片段，分别观察漏检、误检、重叠事件、起止偏差。447/527 标签集合必须重新映射，不能复用列索引。
5. 若帧级小模型达标，再把连续概率聚合成适合视觉的颜色块；显示粒度可以是 100–250 ms，但不要宣称该粒度就是识别精度。若只有 tagging 达标，应把 UI 明确称为“片段声音提示”。

以上步骤是建议的验收计划，本次仅完成文献和公开产物调查。
