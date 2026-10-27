# 浏览器端小音频模型候选

调研日期：2026-10-27。目标是快速验证 Apex 枪声候选的产品体验，不在本轮训练、下载权重或实现新推理后端。

## 结论

下一步优先验证 **EfficientAT `mn04_as` 与 `mn10_as` 两档现成预训练权重**。它们所属路线已经使用 Transformer-to-CNN 知识蒸馏，不必先自行蒸馏或剪枝。先回答“小模型是否能找回用户关心的交战片段”，再决定压缩与训练投入。论文和作者代码支持这一技术路线，但不代表已经在本项目浏览器中跑通。[作者仓库](https://github.com/fschmid56/EfficientAT)、[蒸馏论文](https://arxiv.org/abs/2211.04772)

现有本机基准：21 分 34 秒 4K 录像，BEATs 浏览器 WASM 单线程完整分析 539.749 秒，推理 502.823 秒；模型约 356 MiB。记录见 `../model_web_ui/browser.prototype/CAPTURE.md`。新模型需要以同一录像和相同候选质量口径比较，不能从参数量推算实际提速。

## 候选

| 候选 | 已核实事实 | 本项目定位 |
| --- | --- | --- |
| EfficientAT `mn04_as` | 作者表：0.983M 参数、AudioSet mAP 43.2；MobileNetV3 系列 | 首个轻量实验 |
| EfficientAT `mn10_as` | 作者表：4.88M 参数、AudioSet mAP 47.1 | 同路线精度对照 |
| YAMNet | MobileNetV1、521 类，16 kHz 单声道输入，返回随时间排列的分类 scores | 成熟的轻量备选；TensorFlow 原生路线，沿用 ONNX 需另做转换 |
| CED-Tiny | 5.5M 参数、AudioSet AS-2M mAP 48.1；16 kHz、64 维 Mel；作者提供 ONNX 导出及推理入口 | 后续储备，首轮不扩大模型矩阵 |

EfficientAT 数值来源：[作者模型表](https://github.com/fschmid56/EfficientAT#pre-trained-models)。YAMNet 来源：[TensorFlow 官方教程](https://www.tensorflow.org/hub/tutorials/yamnet)。CED 来源：[作者仓库](https://github.com/RicherMans/CED)。这些通用 AudioSet 指标不是 Apex 枪声召回率，也不能直接比较本项目使用的强标注 BEATs 版本。

本轮未下载或 HEAD 核验上述权重，**实际下载体积、转换后 ONNX 大小均未确认**。参数数量不能当作最终交付包大小。代码仓库分别标注 EfficientAT MIT、TensorFlow models Apache-2.0、CED GPL-3.0；具体分发权重的单独许可仍需在选定下载版本时核对，不能仅用代码许可证替代权重许可结论。[EfficientAT LICENSE](https://github.com/fschmid56/EfficientAT/blob/main/LICENSE)、[TensorFlow models LICENSE](https://github.com/tensorflow/models/blob/master/LICENSE)、[CED LICENSE](https://github.com/RicherMans/CED/blob/main/LICENSE)

## 接入时必须保留的语义区别

EfficientAT 是音频标签模型，作者提供滑窗推理例子；它的默认前端是 32 kHz / 128 Mel，输出应关联明确窗口的起止时间。官方类别表含 `Gunshot, gunfire` 和 `Machine gun`；类别索引必须从对应模型清单读取，不能复用 BEATs 索引。[滑窗推理源码](https://github.com/fschmid56/EfficientAT/blob/main/windowed_inference.py)、[类别清单](https://github.com/fschmid56/EfficientAT/blob/main/metadata/class_labels_indices.csv)

当前原型 `app.js` 的音频窗口固定 16 kHz / 10 秒，候选生成使用 0.04 秒帧步长。**不能把小模型的窗口标签冒充为 BEATs 的逐帧分数**。最小改动是给每个结果显式附带 `start`、`end`、枪声分数，候选合并消费时间区间；沿用文件选择、人工复核和导出流程。滑窗长度和步长属于需要验证的参数，过短输入可能偏离预训练分布。

ONNX 集成难度的判断仅是工程推断：普通 MobileNet CNN 值得优先尝试，但特征提取、池化与算子导出仍需实际验证；YAMNet 要跨 TensorFlow 转换；CED 虽有官方 ONNX 入口，也不等于 ONNX Runtime Web 已验证。先建立 Python 与浏览器同输入数值对照，再做速度结论。

## 最小实验

1. 从已有录像准备固定的短评测集，人工标注交战时间区间，同时包含远处枪声、技能、音乐、语音和安静负样本。BEATs 当前候选可以辅助查找，但不能作为唯一真值。
2. 先用 `mn04_as` 跑通前端和推理，再以 `mn10_as` 作质量对照。使用模型各自的前处理，并独立调阈值，不照搬 BEATs 的 0.2。
3. 记录需要人工复核的候选总时长、交战片段召回、误报片段，以及浏览器冷启动、完整分析、内存、实际模型下载体积。指标和验收目标由产品需求确定，不承诺未经实测的加速倍数。
4. 小样本质量可接受后，再在已有 21 分 34 秒录像上完整测一次；首轮保留 WASM 单线程，减少后端差异。

## 蒸馏、量化、剪枝顺序

建议顺序：**现成蒸馏小模型 → 真实数据评估／微调 → 有必要时任务蒸馏 → 测量量化收益 → 最后考虑结构化剪枝**。这是本项目的工程取舍，不是通用优劣排名。

现成模型若主要问题是 Apex 声音域差异，优先积累人工纠正样本；BEATs 可提供软标签，但教师自身误报和漏报需要人工修正。仅删去其他类别输出通常无法显著削减主干计算。剪枝需配套微调和实际运行时测量，参数中零值增多并不自动得到网页加速。因此首轮不把自训练或剪枝作为前置依赖。
