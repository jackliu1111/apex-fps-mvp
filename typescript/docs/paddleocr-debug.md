# PaddleOCR 数字识别与逐关键帧调试

2026-09-17：新伤害分析保留图标多尺度定位，数字读取改为本地 PaddleOCR `TextRecognition` / `PP-OCRv5_mobile_rec`。历史任务仍可查看、预览和导出。数字模板只保留在旧检测器和历史测试中，新关键帧分析不调用它。

## 运行环境

使用 Python 3.13 的独立环境。PaddleOCR/PaddlePaddle 不编入 Bun 可执行文件。

在 `typescript/` 中执行：

```sh
python3.13 -m venv .venv-ocr
.venv-ocr/bin/python -m pip install -r requirements-ocr.txt
bun run dev
```

Windows PowerShell：

```powershell
py -3.13 -m venv .venv-ocr
.venv-ocr\Scripts\python.exe -m pip install -r requirements-ocr.txt
bun run dev
```

开发版自动查找本目录的 `.venv-ocr`；也可设置 `APEX_OCR_PYTHON` 为安装好依赖的 Python 绝对路径。编译版可使用该变量或可执行文件旁的 `ocr-runtime` 虚拟环境。缺少运行环境会明确失败，不回退到数字模板；音频分析不需要 OCR 环境。

首次使用需下载模型，默认缓存到开发目录 `.paddleocr-cache/`，后续复用本地模型。可通过 `APEX_OCR_MODEL_DIR` 指定已下载的推理模型目录，其中包含 `inference.yml`、`inference.json`、`inference.pdiparams`。模型初始化失败会使任务失败，并保留日志。视频及裁剪图仅在本机处理。

| 环境变量 | 默认值 / 用途 |
| --- | --- |
| `APEX_OCR_PYTHON` | 本地 `.venv-ocr` 或可执行文件旁 `ocr-runtime` 中的 Python |
| `APEX_OCR_MODEL` | `PP-OCRv5_mobile_rec` |
| `APEX_OCR_MODEL_DIR` | 可选，本地模型目录 |
| `APEX_OCR_CACHE_DIR` | 可选，模型缓存目录 |
| `APEX_OCR_MIN_SCORE` | `0`；保持候选召回，不额外按置信度拒绝。可设为 0–1 之间的值用于实验 |

官方依据：[独立文本识别模块](https://www.paddleocr.ai/main/en/version3.x/module_usage/text_recognition.html)、[PaddlePaddle 安装说明](https://www.paddlepaddle.org.cn/documentation/docs/en/install/index_en.html)。

## 数据流与边界

实际关键帧 → 图标定位候选 → 原分辨率数字区域裁剪 → PaddleOCR → 原始文本、置信度与整数 → 相邻关键帧增长窗口。

- 每个视频只启动一个 Python 识别进程、加载一次模型。首次定位可能验证多个候选区域，每次尝试分别留档；成功锁定后使用局部图标定位。
- 数字区域沿用图标右侧的比例范围，再根据白色文本组之间的较大空白收紧右边界，避免将 HUD 的斜边读成 `/`。这里只确定裁剪几何，不做数字分类；OCR 输入是原始 RGB 裁剪，没有二值化或模板尺寸归一化。
- `*.input.png` 就是传给 `model.predict()` 的文件。PaddleOCR 内部仍会执行模型所需的预处理。
- 只接受去除首尾空白后的 1–5 位 ASCII 数字。不抽取混合文本中的数字，不将 O 替换成 0，不在多个读数中取最大值。无法解析的结果记作未知；完整原文和分数仍保留。
- 模型运行错误使任务失败，不能被当成正常的未知读数。失败前已保存的原图、裁剪和错误 JSON 留在本地。取消会终止 OCR 子进程。
- 为保存每个处理帧的完整标框原图，目前全程供给完整分辨率关键帧，禁用首次定位后的 FFmpeg 局部供帧切换。并非保存视频每秒所有帧；未解码的非关键帧不会保存。
- 保存全图、PNG 编码、进程通信都会增加耗时与磁盘占用；当前 `hud_ms` 包含模型初始化、定位、OCR 和调试保存，不代表纯推理耗时。旧报告的局部供帧性能不能直接套用。

## 调试文件

正常任务默认保存到：

```text
~/.apex-highlight/typescript/jobs/<任务ID>/ocr-debug/<分析ID>/
  frames.jsonl
  engine.log
  _paddle_worker.py
  000001_0.015000s_try01.frame.png
  000001_0.015000s_try01.input.png
  000001_0.015000s_try01.json
```

使用 `--data-dir` 时位于对应任务目录。日志会显示绝对路径，结果的 `stats.ocr_debug_dir` 也会记录路径。

- `frame.png`：完整分辨率原图，红框为实际 OCR 裁剪边界；左上角标记时间、状态、最终数值和分数。
- `input.png`：没有红框或文字污染的实际 OCR 输入。
- 同名 JSON：时间、候选序号、图标定位、裁剪坐标、模型、原始文本、置信度、解析状态、读数、耗时和文件路径。矩形坐标为左上角 `(x,y)` 与 `width,height`，右、下边界不包含在裁剪内。
- `frames.jsonl`：每个实际处理关键帧一行，包含所有候选尝试和最终选中记录。可读到数字 0 时保存为 `0`，未知保存为 `null`。
- 未定位到图标的帧保存 `try00.frame.png` 和 JSON，状态为 `no_region`，没有虚构裁剪图。
- `engine.log`：模型加载与运行日志。已保存的证据在取消或失败后保留，不自动清理。

## 验证

```sh
bun run check
bun test ./tests
.venv-ocr/bin/python tests/paddle_worker_test.py
bun run verify
```

TypeScript 单元测试通过注入识别器验证管线，不把它当作真实模型效果证据。Python 测试检查保存 PNG 与传入识别器的像素一致、红框坐标、未知与错误留档。真实模型与视频验证记录见 `work/paddleocr-20260917/`；准确率需要更多人工标注样本评估。Windows 实机与新版便携包尚未验证。

2026-09-17 本机 macOS ARM64 验证结果：

- `bun run check` 通过；`bun test ./tests`：50 项通过，997 个断言；Python 图片与解析测试：3 项通过。
- 真实 PaddleOCR 裁剪样本读出 `64、103、117、160`，其中旧模板将 `64` 读成 `84`。这是少量样本观察，不是总体准确率结论。
- 57.968 秒的 3840×2160 录像实际处理 14 个关键帧，13 帧有整数读数，1 帧在 29.182 秒读成 `160/`，按非纯数字保留为未知；得到 1 个增长候选。14 个裁剪 PNG 均与重新解码原帧对应区域逐像素一致，标框图均保留 3840×2160 尺寸，并经过目视检查。
- 该次分析总耗时 8.45 秒，包含本地模型初始化和调试保存；调试目录约 156.3 MiB。不与历史局部供帧测试作同等准确率的速度比较。
- 完整本机服务检查 11 项通过，覆盖两个视频分析、预览、导出、取消、历史任务恢复等。完整流程中验证了 `64→103` 的增长为 `39`。

证据：[逐像素核验与统计](../work/paddleocr-20260917/validation.json)、[真实录像结果](../work/paddleocr-20260917/real-video-analysis.json)、[11 项完整流程记录](../work/paddleocr-20260917/verify-local/verification.json)。证据位于本机工作目录，不随源码或便携包分发。
