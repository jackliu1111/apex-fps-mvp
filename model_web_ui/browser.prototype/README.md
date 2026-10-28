# 纯浏览器选片工作区

当前主分支只保留这套纯浏览器初版。旧 Python / Electron 实现已转入 [历史归档](../../docs/archive-python-electron.md)。

分析队列与片段复核独立推进。媒体解析、播放、模型推理和选片状态处理均在浏览器执行，静态服务不接收录像上传，也不调用 Python 分析服务。实现依据见 [并行分析与复核方案](../../docs/design/parallel-analysis-review.md) 与 [本地任务清单](../../docs/design/parallel-analysis-review.tasks.md)，真实录像、性能代价及双轴审查见[最新验收记录](../../docs/parallel-analysis-review-validation.md)。

## 启动

```sh
python3 model_web_ui/browser.prototype/serve.py --sample /一分钟交战样本的绝对路径.mp4
```

打开 <http://127.0.0.1:8792>，使用支持 WebCodecs 的桌面 Chrome。需要独立后台预览时使用 `--background`。现有运行库与模型位于 `/private/tmp/apex-browser-prototype-20261026/assets`，可通过 `--assets /绝对路径` 指定；这批已有资产来自此前获准的本机存储例外，不代表重建大型资产可以继续写本机。

样本配置、来源与可复现的制作命令见 [一分钟真实交战样本](../../docs/real-combat-sample.md)。`--sample` 可省略，仍可导入自己的录像；没有配置时，试用按钮会明确提示缺少样本。样本仅在点击时从本地静态服务读取，不上传原录像。

## 操作流程

1. **分析页导入录像**：点击「导入录像」或将文件拖入队列区域，可一次导入多份。文件独立准备，就绪后自动排队分析；队列显示实际分析进度，不需要确认音轨。准备失败、停止或重试只影响该文件。模型在「分析设置与运行记录」中选择，按每个任务固定。导入按钮也支持键盘操作。
2. **随时进入复核**：分析继续，后台切换到下一份录像不会切走正在看的原片。播放器按位置解码完整录像，支持未分析区域和连续播放；离开复核页只暂停播放器，返回保持暂停。
3. **调整选片**：普通稳定候选默认选中，尚在补全的候选不可编辑或导出。点击候选定位原片，全片概览用于移动播放位置；局部裁剪条在同一刻度上拖动左右边界，越过另一端时停在边界前，保持另一端与播放位置不变。也可用数字输入精调，或将当前位置设为起点／终点；不合法的当前位置操作会禁用。可从当前位置添加手动范围。列表提供批量保留／排除当前稳定片段，跳过未收尾候选；重复添加相同人工范围会选中已有范围。候选不代表本人开枪、命中或击杀。
4. **调整筛选**：展开候选列表下方的「筛选与选片规则」，用已有预测分数重算，不重复推理。裁边、明确保留和排除持续保留；与人工范围重叠的补充建议默认不选，完全重复的排除结果隐藏。重置人工选片是独立操作；局部视野的起止控制位于「局部视野与切点说明」。
5. **提前提交导出**：范围确定的选片可在分析完成前提交，本批原片、范围、声音和输出设置立即固定。导出等待分析释放资源后串行执行，继续修改用于下一批。小批次生成下载链接；预计超过 64 MiB 时，点击提交先固定批次，再选择输出目录，按位置流式写入；取消目录选择只取消该批。大批次请选择已挂载且空间充足的外接盘目录，浏览器不能自行验证挂载身份。只有写入流成功关闭才显示已保存；下载链接只代表成片已生成。每段分别显示完成、失败、取消或未开始，部分失败保留已完成成片。
6. **自动保存**：人工决定、选片、复核位置、缩放和批次记录保存在当前来源的 IndexedDB。界面仅在事务提交后显示已保存；失败保留草稿并提供重试。刷新后先恢复记录，再按需关联原录像；不会恢复浏览器分析进程。页面和当前录像的导航元数据单独保存在 localStorage，失败会明确提示。

试用入口加载约一分钟的真实 Apex 交战录像，用于体验真实画面、声音、候选与导出。单个片段不能代表模型整体准确率。脉冲与 440 Hz 双音轨合成媒体仅用于自动回归测试，不再作为产品演示。检测优先使用原片默认且可解码的音轨，必要时回退到其他可解码音轨；这个规则不识别哪条是游戏声音。预览和导出始终使用原片默认声音，与检测回退独立。自动准备不逐条扫描整片音轨。

## 保存与身份边界

原录像、模型分数数组和视频缓存不会写入项目存储。素材关联使用名称、大小、修改时间以及首/中/尾各至多 64 KiB 的哈希采样；这防止仅按同名误关联，但不是整文件完整性校验。原文件缺失时保留所有人工决定，错误文件不覆盖原记录。浏览器清除站点数据、隐私模式结束或系统配额策略仍可能清除本地存储，应按实际保存状态操作。

同一页面会话中，素材身份、请求范围、声音及编码设置一致的有效成片会复用。下载缓存共用一个 URL，由导出队列统一管理；淘汰时所有引用它的批次都会显示不可用。目录成片只在相同目录、原文件仍可读取且大小和修改时间一致时复用；复用索引最多保留 128 个成片。刷新后只恢复历史结果，不恢复 URL 或目录授权，也不声称磁盘文件仍可访问。缓存预算和默认编码设置统一定义在 `export-policy.mjs`。

新提交的导出默认沿用原视频分辨率与帧时间，不再限制为 720p，也不强制转换成固定帧率；可变帧率保留原节奏。默认输出 MP4（H.264 + AAC），提交按钮旁可改选 WebM（VP8 + Opus）；两者均重新编码，不等于无损。默认视频码率按像素数估算（每像素 0.15 bit × 60 的预算系数，最低 2 Mbps；该系数不会改变输出帧率），并用于提交前的容量估算；实际下载缓存仍有 64 MiB 硬限制。大批次选择目录流式写入。不支持原规格的浏览器明确报错，不自动降低尺寸、帧率或改换格式。MP4 使用普通容器、尾部元数据与按位置分块写入，不为 Fast Start 缓存全部媒体；默认 AAC 192 kbps，WebM 沿用 Opus 96 kbps。

`tests/verify-source-export.cjs` 使用真实浏览器编码短小的合成样本，读回验证 MP4 的 H.264 + AAC 编码，以及 3840×2160 / 60 fps、1920×1080 / 29.97 fps 及可变帧率的尺寸、帧数和逐帧时间戳。使用与下方浏览器验证相同的环境变量运行；该检查不代表长时间 4K 游戏实录的吞吐或画质验收。

页面保留高级分析计时与 JSON 报告。原先的片段转码预览、音轨确认和全局忙碌锁已由独立任务流程替代。播放器画面、请求范围和实际导出范围是不同对象，不承诺逐帧精确切点。

## 浏览器流程验证

先启动静态服务，然后指定本地已有 Playwright 与 Chrome：

```sh
PLAYWRIGHT_MODULE=/path/to/playwright CHROME_EXECUTABLE=/path/to/chrome \
  REVIEW_URL=http://127.0.0.1:8792 \
  node model_web_ui/browser.prototype/tests/verify-review-browser.cjs
```

同样的环境变量也可运行 `tests/verify-review-fixes.cjs`，覆盖单文件身份读取失败／慢读取、目录选择竞态与取消、批量选择，以及实际 WebCodecs 输出中的目录配额失败和逐片段状态恢复。故障只注入浏览器文件读取与目录接口边界，测试使用小型合成媒体；临时目录在验证后删除。

该检查使用真实 WebCodecs 与 EfficientAT：验证自动分析、完整原片复核、重复导入去重、人工裁边、候选更新期间的输入焦点、提前提交固定批次并实际导出、离页暂停与返回、IndexedDB 刷新恢复，以及拒绝错误同名原片后成功重新关联。长录像播放、资源竞争、最终 4 MiB 读取调优和已修复审查问题见[最新验收记录](../../docs/parallel-analysis-review-validation.md)，合成样本不替代性能验收。

## 开发阶段重建资产

以下仅是开发者转换和打包步骤，不是网站用户的安装步骤。开发依赖单独列于 [`scripts/requirements-browser-export.txt`](../../scripts/requirements-browser-export.txt)，不再通过旧 Python 服务的 `pyproject.toml` 安装。两个导出器是保留的资产构建工具，主界面仍支持 EfficientAT 和 BEATs。Python 需要既有模型环境和 ONNX 1.19.1、ONNX Runtime 1.23.2；下面只读取此前已有的 `/private/tmp/apex-browser-prototype-20261026/deps`，其他环境须替换为自己的依赖位置。

BEATs 单文件约 356 MiB，模型、运行库及开发临时空间至少按 1 GiB 预留。先用 `diskutil info /Volumes/EXTERNALUSB` 确认它是真实已挂载的外接卷，再用 `df -h /Volumes/EXTERNALUSB` 检查空间，并确认目录可写及所需权限、符号链接受支持。挂载不可用时停止重建，不能在本机创建同名目录。以下 `NEW-TASK` 必须改成新的任务名，避免覆盖已有资产。

```sh
APEX_BUILD_ROOT=/Volumes/EXTERNALUSB/codex-artifacts/apex-fps-mvp/browser-assets-NEW-TASK
mkdir -p "$APEX_BUILD_ROOT/tmp"

env PYTHONDONTWRITEBYTECODE=1 TMPDIR="$APEX_BUILD_ROOT/tmp" \
  PYTHONPATH=/private/tmp/apex-browser-prototype-20261026/deps \
  /Users/jackliu/apex-voice-detect/.venv-pretrainedsed/bin/python \
  model_web_ui/browser.prototype/export_model.py \
  --workspace /Users/jackliu/apex-voice-detect \
  --output "$APEX_BUILD_ROOT/assets"

/Users/jackliu/apex-voice-detect/.venv-pretrainedsed/bin/python \
  model_web_ui/browser.prototype/download_runtime.py \
  --assets "$APEX_BUILD_ROOT/assets"
```

重建后用 `python3 model_web_ui/browser.prototype/serve.py --assets "$APEX_BUILD_ROOT/assets"` 指向新资产；使用期间需要该外接卷保持挂载。新生成模型、运行库、权重与缓存均不提交 Git。

导出器将 Kaldi fbank 改写为固定窗口的实数 DFT 矩阵计算，并将 496→250 的 adaptive average pooling 表达成等价固定矩阵。仅支持 `[1,160000]` 波形输入和 `[1,250,447]` 概率输出，短音频补零；该 BEATs 导出器不做量化或蒸馏。`model.json` 包含参数、类别、模型哈希和 Python 对照误差；vendor 清单包含来源、版本、字节数与 SHA-256。

## 范围与限制

- 当前通过 WASM CPU 运行，未接 WebGPU；并发等待与吞吐以验收记录中的真实测量及其覆盖范围为准。
- 不读取整份视频进内存。可下载成片的总缓存最多 64 MiB，过期链接明确标记不可用；大批次需选择目录直接写入。流式目录输出已设容量边界，任意浏览器、配额和长时间后台生命周期仍不在验收保证内。
- 音频重采样和多声道混音由浏览器完成，尚未证明与 FFmpeg 全链路数值一致。模型合成基准对照不能替代真实录像验证。
- 分析内存中只保留两个枪声类的时间分数，不实现已归档 Python 服务的完整 447 类预测存档或分析断点续算。人工复核记录可独立恢复。
- 格式支持取决于浏览器与 Mediabunny；不支持的解码／编码会显示失败。MP4 和 WebM 重编码均不保证原视频质量；声音沿用原片默认音轨，声画边界仍需人工复核。
- 候选不代表本人开枪、命中或击杀；分析自动音轨策略与默认声音保留规则见上文。

当前工作区实测范围和结论见[最新验收记录](../../docs/parallel-analysis-review-validation.md)；此前模型与解码实验、时间边界问题见历史记录 [CAPTURE.md](CAPTURE.md)。

此前原型的合成耗时记录覆盖：固定 10 秒音频冷／热各 3 次，重新创建 Worker 作为冷会话；随后测 12 秒合成视频的两窗口分析和 5 秒合成片段导出。只自动确认新生成样本的第一音轨，不分析用户已导入的其他录像。结果可下载 JSON；本机资源读取速度不等于公网下载速度。

上游参考：[ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/)、[Mediabunny](https://mediabunny.dev/guide/converting-media-files)。运行库许可证与静态资产一同下载。


## EfficientAT mn04_as 重建

选用作者现成的 Transformer-to-CNN 蒸馏权重，未自行训练、量化或剪枝。源码固定为 `a425fdce92572e602a1d5634799bd9f1f2efa806`。模型计算图 3,972,280 字节；前处理常量、基准数据与来源信息位于 assets/efficientat。重建使用上节已验证挂载的新任务目录 `APEX_BUILD_ROOT`，不沿用历史原型的本机存储例外。

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/fschmid56/EfficientAT.git "$APEX_BUILD_ROOT/EfficientAT"
git -C "$APEX_BUILD_ROOT/EfficientAT" sparse-checkout set models helpers metadata
git -C "$APEX_BUILD_ROOT/EfficientAT" fetch --depth 1 origin a425fdce92572e602a1d5634799bd9f1f2efa806
git -C "$APEX_BUILD_ROOT/EfficientAT" checkout a425fdce92572e602a1d5634799bd9f1f2efa806
curl -fL https://github.com/fschmid56/EfficientAT/releases/download/v0.0.1/mn04_as_mAP_432.pt -o "$APEX_BUILD_ROOT/mn04_as_mAP_432.pt"

# 既有 Python 为 torch/torchaudio 2.8.0；只在隔离 deps 中补充开发依赖。
TMPDIR="$APEX_BUILD_ROOT/tmp" /Users/jackliu/apex-voice-detect/.venv-pretrainedsed/bin/python \
  -m pip install --no-deps --no-cache-dir --target "$APEX_BUILD_ROOT/deps" torchvision==0.23.0 pillow==11.3.0
PYTHONDONTWRITEBYTECODE=1 TMPDIR="$APEX_BUILD_ROOT/tmp" \
  PYTHONPATH="$APEX_BUILD_ROOT/deps:/private/tmp/apex-browser-prototype-20261026/deps" \
  /Users/jackliu/apex-voice-detect/.venv-pretrainedsed/bin/python \
  model_web_ui/browser.prototype/export_efficientat.py \
  --source "$APEX_BUILD_ROOT/EfficientAT" --checkpoint "$APEX_BUILD_ROOT/mn04_as_mAP_432.pt" \
  --output "$APEX_BUILD_ROOT/assets/efficientat"
```

不要覆盖已存在的 checkout 或重新安装无关依赖。上面的下载权重 SHA-256 应为 `899a8c6217063f6941793102a2780b3dd788ab11fce468d9cf5f0577c453321c`。导出器严格加载全部权重，检查 ONNX，并对照原 PyTorch；前处理固定为作者 eval 的 32 kHz / 128 Mel / 1024 FFT / 800 Hann / 320 hop。前端数值与分类分数都需验证，不能只验证 CNN。

作者仓库 MIT 许可证复制在 `assets/efficientat/EfficientAT-LICENSE`，具体 checkpoint 来源与哈希在 model.json；本轮仅本机实验，未发布第三方模型。原始权重仍保留，不提交 Git。

## 历史基础：渐进候选与顺序解码（2026-10-27）

以下保留并行工作区之前的解码研究记录。顺序解码和渐进候选算法继续复用；当时的页面入口、全局忙碌控制和不保存状态的限制已经由本文前面的当前操作流程替代。

`stream-audio.js` 维护单次 `AudioBufferSink.buffers()`、约 5 秒源音频块及 40 ms 重采样边界上下文；解码包先按原采样率和时间戳拼接为连续多声道块，再交由单个 AudioBufferSource 混音／重采样；每个 5 秒单声道块只渲染一次，相邻窗口复用同一采样值。推理期间最多预读一个窗口，失败／取消后等待该读操作收敛并关闭迭代器。时间戳缺口按静音保留，末窗补零。指标只统计应用管理的缓冲，不包含浏览器内部解码队列、模型与预览内存。

EfficientAT 使用下一窗口起点作为未来事件边界；BEATs 仅发布已完成重叠平均的帧，并为中值平滑保留一帧余量。只有后续事件起点严格晚于当前事件结束 + 5 秒，才将候选定为可复核；文件正常结束时收尾。旧阶段通过来源键和移除记录保护当前编辑；当前人工决定已经独立保存并按原录像范围关联。当前允许提前提交固定批次，实际导出执行按资源调度排队，仅包含已确定范围。

历史页面“对照当前录像的新旧解码”曾顺序读取整轨，核对全部重叠区逐采样相等；首两窗、中间窗、末窗与旧随机解码及模型输出比较，首两窗另与连续 20 秒渲染对照。该诊断不更改候选，已不作为当前主界面的入口。解码策略变化并不保证与旧随机解码分数相等，已记录阈值附近候选变化，见 CAPTURE 对应阶段。

耗时面板记录首个可复核候选时间。解码与推理并行，因此分项累计不能相加成完整分析耗时。旧阶段没有持久化；当前支持多文件独立准备、顺序分析，以及人工复核与批次记录的自动保存。分析断点续算和公网部署不在本轮实现内。


### 历史阶段计时口径（timingVersion 2）

稀疏跳读在 44 分钟实测中减少字节但更慢（233.18 秒 vs 208.54 秒），Cluster 并发和先完整提取音频的方案也未改善首次分析。因此 2026-10-28 初版收敛时已移除这些实验代码和独立诊断网页；保留的文档、证据与历史代码查看方式见 [初版收敛记录](../../docs/initial-release-cleanup.md)。实际分析继续使用已验证的顺序解码和 4 MiB 共享读取，完整实验结论见 CAPTURE。

报告新增 `source.importMs`（文件对象交给读取器到轨道／时长就绪）与细分阶段。`sourceDecodeWaitMs` 是等待 `AudioBufferSink` 交付源音频包的累计墙钟时间，合并了文件访问、解封装、解码与浏览器调度，不是纯磁盘 I/O 或解码 CPU 时间。`pcmAssemblyMs` 为原采样网格拼接，`resampleMs` 为 OfflineAudioContext 的混音／重采样与完成等待，`windowAssemblyMs` 为相邻块拼成推理窗口。

`audioSetupMs`、`audioWaitMs`、`inferenceRoundTripMs`、`postprocessAndRenderMs`、`progressUiMs` 在旧版中是主流程上依次计时的区间，可用于分析等待来源；前两组内部阶段与 Worker 的 `frontendMs`、`inferenceMs` 则可能重叠，不能全部相加。`postprocessAndRenderMs` 含分数整理、候选合并与同步 DOM 更新，不含浏览器异步绘制。旧版 `totalMs` 口径不含文件选择、导入、模型清单查询、人工操作、导出及迭代器最终清理。当前 `timingVersion: 3` 从分析入口开始，包含清单准备和最终迭代器清理，最后发布稳定尾部后结束；仍不含此前文件准备、人工复核或导出。跨版本比较需保留这一小段计时边界差异。两轮复测不主动清理操作系统文件缓存；“冷”仅表示新 Worker／模型会话。
