# Apex Local Cut

在浏览器本机分析 Apex Legends 录像中的枪声候选，边分析边复核，调整选片范围后分别导出。录像不上传。当前 `main` 只保留这套纯浏览器初版，默认使用 EfficientAT，也可选择 BEATs。

## 启动

准备已有的浏览器运行库和模型资产，用 Python 标准库启动本地静态服务：

```sh
python3 model_web_ui/browser.prototype/serve.py
```

打开 <http://127.0.0.1:8792>，使用支持 WebCodecs 的桌面 Chrome。默认资产目录为 `/private/tmp/apex-browser-prototype-20261026/assets`；这是当前机器已有的资产位置。其他机器须准备资产并通过 `--assets /资产目录的绝对路径` 指定。

启用当前一分钟真实交战样本：

```sh
python3 model_web_ui/browser.prototype/serve.py \
  --sample '/Users/jackliu/.codex/artifacts/apex-fps-mvp/real-combat-sample-20261028/apex-combat-60s.mp4'
```

样本参数可省略，也可直接导入自己的录像。样本来自实际对局，60 秒、1080p、37.30 MiB；视频没有提交到 Git，来源和重建命令见 [样本说明](docs/real-combat-sample.md)。首次准备运行资产与模型转换见 [浏览器工作区说明](model_web_ui/browser.prototype/README.md)。

Python 在这里仅提供静态文件，不执行推理或转码；日常运行不需要安装 Python 推理环境、Electron 或 npm 依赖。大于 100 MiB 的单文件或单任务累计达到 1 GiB 的生成物，按项目存储规则直接写入已确认挂载的外接卷。

## 初版功能

- 多份本地录像独立准备、顺序分析，逐步显示候选；单份失败不阻塞其他录像。
- 分析和复核独立推进，支持播放、定位完整原录像，包括尚未分析的部分。
- 保留或排除候选、添加人工范围、双手柄裁剪和数字精调；重新筛选保留人工决定。
- 提交时固定导出范围与规格，默认逐片段生成 MP4（H.264 + AAC），可选择 WebM；沿用原片分辨率与帧率，小批次下载，大批次流式写入所选目录。
- IndexedDB 保存人工选片、复核位置和批次记录；刷新后可重新关联原录像。

候选不等于本人开枪、命中或击杀。刷新不会恢复浏览器分析进程；格式支持取决于浏览器和解码器，输出采用重编码，音画与切点仍应人工复核。真实长录像和并发流程的已测范围见 [验收记录](docs/parallel-analysis-review-validation.md)。

## 代码与检查

```text
model_web_ui/browser.prototype/   浏览器应用、静态服务、模型资产生成工具
  tests/                         当前逻辑、浏览器交互与真实媒体回归
  evidence/                      小型实验与验收记录
scripts/                         真实样本生成、模型转换开发依赖
  create_browser_combat_sample.py
  requirements-browser-export.txt
docs/                            当前设计、研究结论及历史归档入口
CONTEXT.md                       产品术语
```

`browser.prototype` 沿用历史路径，里面是当前有效产品实现。静态运行不依赖已经归档的 Python 模型服务。模型导出脚本属于开发工具，第三方模型源码、权重和生成资产单独准备，不提交 Git。

无需安装 npm 依赖即可运行逻辑检查：

```sh
node --test model_web_ui/browser.prototype/tests/*.test.mjs
```

启动页面后，使用已有 Playwright 与 Chrome 检查真实浏览器流程：

```sh
PLAYWRIGHT_MODULE=/已有/playwright/模块路径 \
CHROME_EXECUTABLE=/已有/chrome/可执行文件路径 \
REVIEW_URL=http://127.0.0.1:8792 \
node model_web_ui/browser.prototype/tests/verify-review-browser.cjs
```

同样的环境变量适用于 `verify-review-fixes.cjs` 与 `verify-range-interaction.cjs`。样本制作还需要 FFmpeg / ffprobe；模型资产转换依赖另见 `scripts/requirements-browser-export.txt`。

## 历史与后续

旧 Python 分析服务、旧 Web 界面、Electron 桌面宿主及专属构建测试已归档到 [archive/python-electron-20261028](https://github.com/jackliu1111/apex-fps-mvp/tree/archive/python-electron-20261028)，不属于当前主分支。原始说明和验收边界可从 [归档入口](docs/archive-python-electron.md) 查阅；更早的 OCR、Go / Bun 等实现见 [version0 封存说明](docs/archive-version0.md)。

浏览器读取、模型和独立音频研究结论继续保留，索引见 [初版收敛记录](docs/initial-release-cleanup.md)。下一阶段再扩充人工标注样本、评估识别质量，以及验证更多浏览器、媒体格式和长时间使用场景。
