# 纯网页处理链路 · 可丢弃原型

问题：不安装本地助手，轻量 EfficientAT 能否快速找到交火候选？保留 BEATs 基线作对照。

这是功能／状态原型，不是三个视觉方案，也不是生产重构。它沿用本项目已确认音轨、真实模型分数、5/5/5 候选的业务流程。因为需要真实 WASM 模型和 WebCodecs，使用静态 HTTP 页面，而非双击 HTML 的模拟演示。原型不接入现有 Python 业务服务，不改动其协议或入口。

## 本机启动

在仓库根目录运行一个命令：

```sh
python3 model_web_ui/browser.prototype/serve.py
```

打开 <http://127.0.0.1:8792>，使用支持 WebCodecs 的桌面 Chrome。页面有浏览器能力指示。

上述前台命令需要终端进程保持运行。需要独立后台预览时执行 `python3 model_web_ui/browser.prototype/serve.py --background`；启动时打印 PID 和日志路径。重启电脑后仍需重新启动。只启动一个实例。

模型加载会分别显示连接、已读取 MiB、WASM 初始化和当前窗口推理。模型读取连续 30 秒没有数据会报告错误并允许重试；这个限制不作用于模型初始化和推理耗时。

此命令只提供静态文件，**不处理录像、不执行推理、没有上传接口**。最终可以把页面与 assets 放到 HTTPS 静态站点；网站用户不需要 Python、FFmpeg、Electron 或本地助手。本轮没有部署公网网站。

当前资产路径是 `/private/tmp/apex-browser-prototype-20261026/assets`。这是用户在外接盘创建目录阻塞后明确批准的本机存储例外。临时目录可能被系统清理；换目录后使用 `--assets /绝对路径`。模型和运行库不进入 Git。

## 如何体验

1. 导入一份或多份本地录像；也可点击“生成 12 秒合成样本”。合成视频含脉冲和 440 Hz 两条音轨，不是实际枪声素材。
2. 每份录像必须明确选择游戏音轨。更换音轨会清除该文件的旧分数和候选。
3. 默认选择 EfficientAT mn04_as，也可切回 BEATs。切换模型会清空旧识别结果。音轨只建立一次顺序解码迭代器，按 5 秒块混音／重采样，再拼成 10 秒窗口、5 秒步长；EfficientAT 转成 32 kHz 单声道，Worker 内 JS FFT / Mel 前处理，再用 ONNX Runtime WASM 执行模型。BEATs 保留 16 kHz 路线。
4. EfficientAT 按两个枪声类的窗口概率筛选，事件间隔 ≤5 秒合并，前后各留 5 秒；它是窗口级粗定位，0.2 阈值未经质量校准。BEATs 仍按重叠窗口取均值、3 帧中值平滑，再生成 5/5/5 候选。候选逐窗出现；未来事件已不能延长的候选标为“可复核”，分析期间可勾选、修改起止、移除、添加手动范围或预览，后续结果保留这些操作。“处理中”候选不可编辑或导出。分析结束后可调阈值重算（主动替换手动修改），再批量导出。
5. 预览与导出都在浏览器内转成最高 720p 的 VP8 + Opus WebM，只包含选中的音轨。点击下载链接才保存文件。
6. “原型状态与证据”可查看状态和日志。“验证浏览器模型与 Python 基准”使用固定合成噪声，比较当前模型完整输出（EfficientAT 527 类、BEATs 250×447 帧分数）。

可随时取消活动任务。推理 Worker 会终止；重试重新加载模型并从该文件开头分析，重置该未完成文件的候选与编辑。取消后已确定候选可继续复核，未结束候选保持“未完成”；重算也不会将它们误标为完整。已完成文件和下载链接保留。项目仅在页面内存中，刷新清空，不写 IndexedDB / OPFS / localStorage。

## 开发阶段重建资产

以下仅是开发者转换和打包步骤，不是网站用户的安装步骤。Python 需要既有模型环境和 ONNX 1.19.1、ONNX Runtime 1.23.2；本次依赖位于 `/private/tmp/apex-browser-prototype-20261026/deps`。

```sh
env PYTHONDONTWRITEBYTECODE=1 \
  PYTHONPATH=/private/tmp/apex-browser-prototype-20261026/deps \
  /Users/jackliu/apex-voice-detect/.venv-pretrainedsed/bin/python \
  model_web_ui/browser.prototype/export_model.py \
  --workspace /Users/jackliu/apex-voice-detect \
  --output /private/tmp/apex-browser-prototype-20261026/assets

/Users/jackliu/apex-voice-detect/.venv-pretrainedsed/bin/python \
  model_web_ui/browser.prototype/download_runtime.py \
  --assets /private/tmp/apex-browser-prototype-20261026/assets
```

其他环境须替换绝对路径。资产输出预计约 370 MiB；重建前遵守用户的大文件存储规则，不把本次例外当成永久许可。

导出器将 Kaldi fbank 改写为固定窗口的实数 DFT 矩阵计算，并将 496→250 的 adaptive average pooling 表达成等价固定矩阵。仅支持 `[1,160000]` 波形输入和 `[1,250,447]` 概率输出，短音频补零；该 BEATs 导出器不做量化或蒸馏。`model.json` 包含参数、类别、模型哈希和 Python 对照误差；vendor 清单包含来源、版本、字节数与 SHA-256。

## 范围与限制

- 当前通过 WASM CPU 运行；未接 WebGPU，也没有性能目标。
- 不读取整份视频进内存；但单段导出和待下载成片仍保留在内存。长片、大批量、存储配额与页面后台生命周期未验收。
- 音频重采样和多声道混音由浏览器完成，尚未证明与 FFmpeg 全链路数值一致。模型合成基准对照不能替代真实录像验证。
- 原型只保存两个枪声类的时间分数，不实现正式服务完整 447 类预测存档、模型版本失效、重启恢复与文件身份校验。
- 格式支持取决于浏览器与 Mediabunny；不支持的解码／编码会显示失败。WebM 重编码与现有快速复制导出不同，不保留原视频质量；声画边界仍需人工复核。
- 界面、音轨试听与操作偏好尚待用户评价。候选不代表本人开枪、命中或击杀。

实测范围、结论及已知时间边界问题见 [CAPTURE.md](CAPTURE.md)。

页面底部“运行合成耗时测试”可重复测量：固定 10 秒音频冷／热各 3 次，重新创建 Worker 作为冷会话；随后测 12 秒合成视频的两窗口分析和 5 秒合成片段导出。只自动确认新生成样本的第一音轨，不分析用户已导入的其他录像。结果可下载 JSON；本机资源读取速度不等于公网下载速度。

上游参考：[ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/)、[Mediabunny](https://mediabunny.dev/guide/converting-media-files)。运行库许可证与静态资产一同下载。


## EfficientAT mn04_as 重建

本轮选用作者现成的 Transformer-to-CNN 蒸馏权重，未自行训练、量化或剪枝。源码固定为 `a425fdce92572e602a1d5634799bd9f1f2efa806`。模型计算图 3,972,280 字节；前处理常量、基准数据与来源信息位于 assets/efficientat。沿用用户批准的原型本机存储。

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/fschmid56/EfficientAT.git /private/tmp/apex-browser-prototype-20261026/EfficientAT
git -C /private/tmp/apex-browser-prototype-20261026/EfficientAT sparse-checkout set models helpers metadata
git -C /private/tmp/apex-browser-prototype-20261026/EfficientAT fetch --depth 1 origin a425fdce92572e602a1d5634799bd9f1f2efa806
git -C /private/tmp/apex-browser-prototype-20261026/EfficientAT checkout a425fdce92572e602a1d5634799bd9f1f2efa806
curl -fL https://github.com/fschmid56/EfficientAT/releases/download/v0.0.1/mn04_as_mAP_432.pt -o /private/tmp/apex-browser-prototype-20261026/mn04_as_mAP_432.pt

# 既有 Python 为 torch/torchaudio 2.8.0；只在隔离 deps 中补充开发依赖。
/Users/jackliu/apex-voice-detect/.venv-pretrainedsed/bin/python -m pip install --no-deps --no-cache-dir --target /private/tmp/apex-browser-prototype-20261026/deps torchvision==0.23.0 pillow==11.3.0
PYTHONPATH=/private/tmp/apex-browser-prototype-20261026/deps /Users/jackliu/apex-voice-detect/.venv-pretrainedsed/bin/python model_web_ui/browser.prototype/export_efficientat.py --source /private/tmp/apex-browser-prototype-20261026/EfficientAT --checkpoint /private/tmp/apex-browser-prototype-20261026/mn04_as_mAP_432.pt --output /private/tmp/apex-browser-prototype-20261026/assets/efficientat
```

不要覆盖已存在的 checkout 或重新安装无关依赖。上面的下载权重 SHA-256 应为 `899a8c6217063f6941793102a2780b3dd788ab11fce468d9cf5f0577c453321c`。导出器严格加载全部权重，检查 ONNX，并对照原 PyTorch；前处理固定为作者 eval 的 32 kHz / 128 Mel / 1024 FFT / 800 Hann / 320 hop。前端数值与分类分数都需验证，不能只验证 CNN。

作者仓库 MIT 许可证复制在 `assets/efficientat/EfficientAT-LICENSE`，具体 checkpoint 来源与哈希在 model.json；本轮仅本机实验，未发布第三方模型。原始权重仍保留，不提交 Git。

## 渐进候选与顺序解码（2026-10-27）

`stream-audio.js` 维护单次 `AudioBufferSink.buffers()`、约 5 秒源音频块及 40 ms 重采样边界上下文；解码包先按原采样率和时间戳拼接为连续多声道块，再交由单个 AudioBufferSource 混音／重采样；每个 5 秒单声道块只渲染一次，相邻窗口复用同一采样值。推理期间最多预读一个窗口，失败／取消后等待该读操作收敛并关闭迭代器。时间戳缺口按静音保留，末窗补零。指标只统计应用管理的缓冲，不包含浏览器内部解码队列、模型与预览内存。

EfficientAT 使用下一窗口起点作为未来事件边界；BEATs 仅发布已完成重叠平均的帧，并为中值平滑保留一帧余量。只有后续事件起点严格晚于当前事件结束 + 5 秒，才将候选定为可复核；文件正常结束时收尾。已确定候选有稳定来源键，编辑对象不被替换，移除记录防止重新出现。批量导出仍在分析结束或取消后进行，只输出已确定范围。

页面“对照当前录像的新旧解码”顺序读取整轨，核对全部重叠区逐采样相等；首两窗、中间窗、末窗与旧随机解码及模型输出比较，首两窗另与连续 20 秒渲染对照。该操作不更改候选。解码策略变化并不保证与旧随机解码分数相等，已记录阈值附近候选变化；见 CAPTURE 最新节。

耗时面板显示首个可复核候选时间。解码与推理并行，因此分项累计不能相加成完整分析耗时。当前仍为单文件顺序队列，无多文件并行、持久化或公网部署。


### 阶段计时口径（timingVersion 2）

实验跳读入口见页面底部“读取方式实验”，默认关闭：本次 44 分钟实测减少字节但更慢（233.18 秒 vs 208.54 秒）。首次试验需先运行 `python3 model_web_ui/browser.prototype/diagnostics/build_sparse_runtime.py`，它校验固定原版 SHA-256 后生成独立 `mediabunny-sparse.mjs`，不覆盖原库。实验路径仅用于分析，预览／导出仍用原 Input；失败会显示错误，不自动更换算法。结构一致性验证命令为 `node model_web_ui/browser.prototype/diagnostics/sparse-parity.mjs`。这不是通用 MKV 实现或默认性能优化，完整结论见 CAPTURE。

报告新增 `source.importMs`（文件对象交给读取器到轨道／时长就绪）与细分阶段。`sourceDecodeWaitMs` 是等待 `AudioBufferSink` 交付源音频包的累计墙钟时间，合并了文件访问、解封装、解码与浏览器调度，不是纯磁盘 I/O 或解码 CPU 时间。`pcmAssemblyMs` 为原采样网格拼接，`resampleMs` 为 OfflineAudioContext 的混音／重采样与完成等待，`windowAssemblyMs` 为相邻块拼成推理窗口。

`audioSetupMs`、`audioWaitMs`、`inferenceRoundTripMs`、`postprocessAndRenderMs`、`progressUiMs` 是主流程上依次计时的区间，可用于分析等待来源；前两组内部阶段与 Worker 的 `frontendMs`、`inferenceMs` 则可能重叠，不能全部相加。`postprocessAndRenderMs` 含分数整理、候选合并与同步 DOM 更新，不含浏览器异步绘制。`totalMs` 沿用原口径：逐文件分析开始至最后候选发布，不含文件选择、导入、模型清单查询、人工操作、导出及迭代器最终清理。两轮复测不主动清理操作系统文件缓存；“冷”仅表示新 Worker／模型会话。
