# 纯浏览器选片工作区

分析队列与片段复核独立推进。媒体解析、播放、模型推理和选片状态处理均在浏览器执行，静态服务不接收录像上传，也不调用 Python 分析服务。实现依据见 [并行分析与复核方案](../../docs/design/parallel-analysis-review.md) 与 [本地任务清单](../../docs/design/parallel-analysis-review.tasks.md)。

## 启动

```sh
python3 model_web_ui/browser.prototype/serve.py
```

打开 <http://127.0.0.1:8792>，使用支持 WebCodecs 的桌面 Chrome。需要独立后台预览时使用 `--background`。现有运行库与模型位于 `/private/tmp/apex-browser-prototype-20261026/assets`，可通过 `--assets /绝对路径` 指定；这批已有资产来自此前获准的本机存储例外，不代表重建大型资产可以继续写本机。

## 操作流程

1. **分析页导入录像**：文件独立准备，就绪后自动排队分析；不需要确认音轨。准备失败、停止或重试只影响该文件。模型在高级设置中选择，按每个任务固定。
2. **随时进入复核**：分析继续，后台切换到下一份录像不会切走正在看的原片。播放器按位置解码完整录像，支持未分析区域和连续播放；离开复核页只暂停播放器，返回保持暂停。
3. **调整选片**：普通稳定候选默认选中，尚在补全的候选不可编辑或导出。点击候选定位原片，在全片概览和局部范围条中调整请求范围，或从当前位置添加手动范围。候选不代表本人开枪、命中或击杀。
4. **调整筛选**：已有预测分数直接用于重算，不重复推理。裁边、明确保留和排除持续保留；与人工范围重叠的补充建议默认不选，完全重复的排除结果隐藏。重置人工选片是独立操作。
5. **自动保存**：人工决定、选片、复核位置、缩放和批次记录保存在当前来源的 IndexedDB。界面仅在事务提交后显示已保存；失败保留草稿并提供重试。刷新后先恢复记录，再按需关联原录像；不会恢复浏览器分析进程。页面和当前录像的导航元数据单独保存在 localStorage，失败会明确提示。

合成样本包含脉冲与 440 Hz 两条音轨，用于验证流程，不是枪声质量评估。检测优先使用原片默认且可解码的音轨，必要时回退到其他可解码音轨；这个规则不识别哪条是游戏声音。预览和导出始终使用原片默认声音，与检测回退独立。自动准备不逐条扫描整片音轨。

## 保存与身份边界

原录像、模型分数数组和视频缓存不会写入项目存储。素材关联使用名称、大小、修改时间以及首/中/尾各至多 64 KiB 的哈希采样；这防止仅按同名误关联，但不是整文件完整性校验。原文件缺失时保留所有人工决定，错误文件不覆盖原记录。浏览器清除站点数据、隐私模式结束或系统配额策略仍可能清除本地存储，应按实际保存状态操作。

页面保留高级分析计时与 JSON 报告。原先的片段转码预览、音轨确认和全局忙碌锁已由独立任务流程替代。播放器画面、请求范围和实际导出范围是不同对象，不承诺逐帧精确切点。

## 浏览器流程验证

先启动静态服务，然后指定本地已有 Playwright 与 Chrome：

```sh
PLAYWRIGHT_MODULE=/path/to/playwright CHROME_EXECUTABLE=/path/to/chrome \
  REVIEW_URL=http://127.0.0.1:8792 \
  node model_web_ui/browser.prototype/tests/verify-review-browser.cjs
```

该检查使用真实 WebCodecs 与 EfficientAT：验证自动分析、完整原片复核、重复导入去重、人工裁边、离页暂停与返回、IndexedDB 刷新恢复及原片待关联。长录像播放和资源竞争证据由任务清单单独记录，合成样本不替代性能验收。

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
- 分析内存中只保留两个枪声类的时间分数，不实现正式服务完整 447 类预测存档或分析断点续算。人工复核记录可独立恢复。
- 格式支持取决于浏览器与 Mediabunny；不支持的解码／编码会显示失败。WebM 重编码与现有快速复制导出不同，不保留原视频质量；声画边界仍需人工复核。
- 候选不代表本人开枪、命中或击杀；分析自动音轨策略与默认声音保留规则见上文。

实测范围、结论及已知时间边界问题见 [CAPTURE.md](CAPTURE.md)。

此前原型的合成耗时记录覆盖：固定 10 秒音频冷／热各 3 次，重新创建 Worker 作为冷会话；随后测 12 秒合成视频的两窗口分析和 5 秒合成片段导出。只自动确认新生成样本的第一音轨，不分析用户已导入的其他录像。结果可下载 JSON；本机资源读取速度不等于公网下载速度。

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

实验跳读入口见历史原型的“读取方式实验”，默认关闭：本次 44 分钟实测减少字节但更慢（233.18 秒 vs 208.54 秒）。首次试验需先运行 `python3 model_web_ui/browser.prototype/diagnostics/build_sparse_runtime.py`，它校验固定原版 SHA-256 后生成独立 `mediabunny-sparse.mjs`，不覆盖原库。实验路径仅用于分析，预览／导出仍用原 Input；失败会显示错误，不自动更换算法。结构一致性验证命令为 `node model_web_ui/browser.prototype/diagnostics/sparse-parity.mjs`。这不是通用 MKV 实现或默认性能优化，完整结论见 CAPTURE。

报告新增 `source.importMs`（文件对象交给读取器到轨道／时长就绪）与细分阶段。`sourceDecodeWaitMs` 是等待 `AudioBufferSink` 交付源音频包的累计墙钟时间，合并了文件访问、解封装、解码与浏览器调度，不是纯磁盘 I/O 或解码 CPU 时间。`pcmAssemblyMs` 为原采样网格拼接，`resampleMs` 为 OfflineAudioContext 的混音／重采样与完成等待，`windowAssemblyMs` 为相邻块拼成推理窗口。

`audioSetupMs`、`audioWaitMs`、`inferenceRoundTripMs`、`postprocessAndRenderMs`、`progressUiMs` 是主流程上依次计时的区间，可用于分析等待来源；前两组内部阶段与 Worker 的 `frontendMs`、`inferenceMs` 则可能重叠，不能全部相加。`postprocessAndRenderMs` 含分数整理、候选合并与同步 DOM 更新，不含浏览器异步绘制。`totalMs` 沿用原口径：逐文件分析开始至最后候选发布，不含文件选择、导入、模型清单查询、人工操作、导出及迭代器最终清理。两轮复测不主动清理操作系统文件缓存；“冷”仅表示新 Worker／模型会话。
