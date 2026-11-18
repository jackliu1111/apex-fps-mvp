# EfficientSED 本地实验页

独立入口 `model-lab.html`。正式选片工作区的模型与行为不变。

## 本次实验

- 指定录像：`/Volumes/外置固态/Mac迁移-20261020/Downloads/2026-08-09 15-31-44.mkv`。
- 实验资产根目录：`/Volumes/外置固态/apex-model-lab-20261117`。
- 模型：`fmn10+tf-256_advanced-kd-weak-strong.pt`，上游 commit `e3449bfd1f4922b81d82410ed842653f462bfca8`。
- checkpoint SHA-256：`7d5326a485b742b323b33dd2bcb366606b614b2a5deaa5e452ef34ddedb9797c`。
- 导出 ONNX：19,866,461 bytes；SHA-256 `81337d5f324b609490ebd9430432142d3ab7bb1377a3ad70d3c0f3da7ba09001`。

## 启动及使用

```sh
python3 model_web_ui/browser.prototype/serve.py --model-lab --port 8798 \
  --assets '/Volumes/外置固态/apex-model-lab-20261117/assets'
```

桌面 Chrome 打开 `http://127.0.0.1:8798/model-lab.html`，依次选择录像、外置盘的结果目录，然后开始分析。可选择前 60 秒或完整录像。目录授权只针对所选目录，页面没有推理 API、上传或结果写入 HTTP 服务。

每次建立独立实验目录，包含 `run.json`、`scores/*.f32`、`statistics.json`。只有成功关闭的文件才登记进 run.json；中止保留已写完整块，失败写入直接报错，不改写到其他磁盘。没有续传、清理策略、浏览器结果缓存或索引数据库。

“打开已有实验”选择具体实验子目录后，从分数重建色带与统计；重新选择同一原录像可试听。阈值/温度变更即时修改视觉，点击“重算统计并保存”才重算和覆盖该实验的统计文件；原始分数不变。

## 数值与时间语义

- 原音频按浏览器默认可解码音轨处理，混为 mono 16 kHz；一次解码、10 秒窗、5 秒步进。沿用既有顺序解码器。
- JS FFT 前处理单独匹配上游 eval：512 FFT、400 nonperiodic Hann、160 hop、preemphasis、reflect padding、128 Kaldi mel、`log(max(power,1e-7))`、`(x+4.5)/5`。与 BEATs / EfficientAT 前处理不相同。
- ONNX 接收 `[1,1,128,1000]` Mel，输出 `[1,250,447]` sigmoid 概率。前处理在 Worker 中运行；不量化，不使用 WebGPU。
- 每个原录像时间步只保存一次：重叠窗口的 sigmoid 分数先取平均，待没有后续窗口贡献后写盘。文件为 little-endian Float32 `[frame,class]`。末帧覆盖只计算实际剩余音频时长。
- 保存值未做平滑、阈值或跨类 softmax；447 类完整保留。run.json 记录类别顺序、模型哈希、音轨、音频相对视频偏移、有效时长、分数块范围与计时。
- 默认色带与帧检查器仅展示五组：枪声、语音、音乐、脚步、冲击／碎裂。映射见 `lab-display-groups.mjs`，按每帧组内最大 sigmoid 分数聚合，不相加；宽泛的游戏声音、背景噪声、机械声等不参与视觉面积分配，但全类别统计和磁盘分数仍保留。
- 色带为分组后的概览时间桶平均值（每桶至少 0.2 秒、最多 5000 桶），阈值后 `softmax(p/T)` 仅决定颜色面积。桶内平均会淡化短峰值；点击查看保存的 40 ms 帧，悬停查看该组原始标签分数。色带不是声音占比或定位精度承诺。
- 统计从完整逐帧分数计算，含覆盖秒数/比例、均值、峰值与位置、10 桶分数分布、连续超阈值段数、所有超阈值类别对共现时间。连续段未做平滑和间隙合并；统计口径随文件保存。表格只显示前 50 类，JSON 包含全部类别。
- 预测覆盖不是人工确认的真实声音频率；没有标注真值前不能报告 Apex 准确率或召回率。

## 重新导出

开发环境本次为 Python 3.10.17；torch 2.14.1、torchaudio 2.11.1、torchvision 0.29.2、onnx 1.23.2、onnxruntime 1.23.2、numpy 2.2.6、einops 0.8.2、rotary-embedding-torch 0.9.2。此为实际使用版本记录，不代表所有平台安装组合均已验证。

```sh
env PYTHONDONTWRITEBYTECODE=1 \
  TMPDIR='/Volumes/外置固态/apex-model-lab-20261117/tmp' \
  /tmp/apex-export-venv/bin/python model_web_ui/browser.prototype/export_efficientsed.py \
  --source '/Volumes/外置固态/apex-model-lab-20261117/EfficientSED' \
  --checkpoint '/Volumes/外置固态/apex-model-lab-20261117/assets/efficientsed/checkpoint.pt' \
  --output '/Volumes/外置固态/apex-model-lab-20261117/assets/efficientsed' \
  --waveform '/Volumes/外置固态/apex-model-lab-20261117/assets/efficientsed/apex-reference.f32'
```

参考波形来自原录像 120–130 秒、FFmpeg mono 16 kHz f32le。导出严格加载全部 checkpoint 权重；上游未选择的 CUDA Mamba import 用构造即报错的占位类隔离，不修改所选 TF 网络。原始模型代码与 MIT LICENSE 位于外置资产目录；不提交权重到 Git。

## 自动化验收

```sh
node --test model_web_ui/browser.prototype/tests/lab-scores.test.mjs

env PLAYWRIGHT_MODULE=/path/to/playwright-core \
  LAB_SOURCE='/Volumes/外置固态/Mac迁移-20261020/Downloads/2026-08-09 15-31-44.mkv' \
  LAB_OUTPUT='/Volumes/外置固态/apex-model-lab-20261117/results/new-test' \
  node model_web_ui/browser.prototype/tests/verify-model-lab.cjs
```

测试使用真实 Chrome、真实录像、真实 JS 前处理与 WASM 模型。仅将目录选择器边界替换为 Chrome 原生 OPFS；测试 Chrome 的 profile 位于外置盘，结果再通过 File System Access 读回复制到可检查目录。**这是计算与文件内容验收，不是系统原生目录选择窗口验收。** 本次 CUA 系统窗口不可用；正式页面的目录选择/授权仍待用户实际验证。

报告与截图见外置 `results/final-browser-test/`。本次没有把人工试听或已知真值质量评估描述为完成，也没有把 Node 前处理检查代替浏览器推理。
