# Apex 录像集锦助手

> 当前项目用于 Apex Legends 录像自动剪辑，面向复盘与高亮片段整理，减少手动筛选时间并节省硬盘空间。当前初版提供纯浏览器选片工作区，基于音频模型生成枪声候选；已有 Python / Electron 入口继续保留。
>
> 旧版伤害剪辑基于 OCR 识别累计伤害数字，长录像处理过慢（20 分钟 4K 约 5 分钟），已在 version1 重构中由音频模型方案取代：同规格 4K 录像从分析到候选约 1 分钟，实测见 [模型服务基准](docs/design/model-service.benchmark.md)。

## 当前初版：Apex Local Cut 浏览器工作区

当前界面入口是 `model_web_ui/browser.prototype/`。目录名保留历史兼容，里面的分析队列、完整录像播放、片段裁剪、固定批次导出和自动保存均为当前有效实现。默认 EfficientAT，也可选择 BEATs；媒体处理与推理在浏览器本机执行，不上传录像。

```sh
python3 model_web_ui/browser.prototype/serve.py \
  --assets /已有运行库与模型的绝对路径 \
  --sample /一分钟真实交战样本的绝对路径.mp4
```

打开 <http://127.0.0.1:8792>。导入录像或点击「试用 1 分钟真实交战」，分析过程中即可进入复核，调整边界并提交独立片段导出。`--sample` 可省略，省略后仍可导入自己的录像；样本视频不提交 Git。现有本机资产仍可使用默认路径，首次准备与详细操作见 [浏览器工作区说明](model_web_ui/browser.prototype/README.md)。真实样本来源、制作与使用见 [一分钟交战样本](docs/real-combat-sample.md)。

实验代码已经清理，研究文档、结论和小型证据继续保留；历史实现仍可从 Git 查阅。下方 Python / Electron 是保留的已有实现，与纯浏览器入口独立。

后续计划：

- [x] 基于音频分析模型的剪辑方案（version1：通用预训练 BEATs，双入口上线）。
- [ ] 基于人工标注数据重新训练 Apex 专用音频分析模型（标注与训练按 ADR 0001 延后）。
- [ ] 增加基于 AI 的分析模式，用于用户精准预测与模型训练数据标注。
- [ ] 双入口人工边界／音画复核与 Windows 实机验收（自 version1 延后，原 #16／#18）。

## version0 封存

旧版 Python 终端、Go/CGO、Bun 网页、音频能量检测和 OCR 伤害识别已从当前主线移除。历史源码可通过 `version0` 标签或 `archive/version0` 分支查看；早期模型原型保存在提交 `d9f2bbd`。恢复方式与验证边界见 [封存说明](docs/archive-version0.md)。

## Python 模型服务：批量分析、候选复核与独立导出

独立 Python Web 入口现支持选择多份本地录像、逐份确认游戏音轨、常驻 BEATs 顺序分析、调参重算、勾选与范围编辑、按需预览和逐片段快速复制导出。完整预测独立保存，分数按范围分页读取；候选按 5/5/5 默认规则生成。修改参数或范围会使相应旧引用失效，源文件与模型配置变化要求重新分析。可查询阶段、逐份耗时和错误，并取消任务；失败或取消保留已完成文件，重启标记中断任务。候选不代表本人开枪、命中或击杀。

```sh
sh scripts/start-python-model-web.sh
```

打开启动日志中的完整访问地址。分析使用已有 `apex-voice-detect` 模型工作目录、BEATs 权重及推理 Python 环境，运行时不需要 Bun、Node 或 Electron。单独探测仍可用标准库 Python；完整分析还需要 NumPy 和模型依赖。启动配置见 [Web 入口说明](docs/python-model-web.md)，模型契约见 [分析说明](docs/python-model-analysis.md)，批量、身份校验与恢复证据见 [任务生命周期](docs/python-model-lifecycle.md)，切点策略、逐文件记录与 TDD 证据见 [复核与导出](docs/python-model-review.md)。

Electron 入口复用同一界面和 Python 核心，通过受限 preload IPC 处理业务；预览和成片使用受控媒体协议。开发启动与原生构建见 [桌面入口](docs/desktop-model.md)，HTTP／IPC 契约、本机 Mac 包和真实样本记录见 [桌面验收](docs/desktop-validation.md)。真实 21 分钟 4K 来源已通过双入口分析、各 34 段独立导出、全量解码与全部分数比对，见 [4K 技术记录](docs/model-recording-4k-validation.md)。当前 Mac 测试包声明最低 macOS 27，采用本地 ad-hoc 签名，运行前后资源签名有效；另一台 Mac 的干净机验收已于 2026-10-12 通过（#17），步骤见 [移交验收](docs/desktop-mac-acceptance.md)。精确成片重编码未启用；[人工边界／音画复核](docs/model-recording-human-review.md)（4K 清单 0/74，1080p 及其他代表素材）与 Windows 实机验收（#18）按用户决定延后至下一版本。

本轮分工、各 issue 的实现／验收状态和最终回归结果见 [实现记录](docs/model-service-implementation.md)。

用户新增的一小时真实 1080p 回放已完成 HTTP 全流程与已有桌面结果对照：90,063×447 原始分数最大差 0，98 段请求／实测范围一致，双方成片完整解码通过，见 [1080p 技术记录](docs/model-recording-1080-validation.md)。用户确认其他播放器正常，macOS 文件预览中的 [卡顿调查](docs/copy-stutter-investigation.md) 按要求暂缓，不作为当前阻塞项；人工验收仍待完成。

## 开发与检查

当前代码结构：

- `model_web_ui/browser.prototype/`：当前纯浏览器工作区及其回归测试。

- `model_*.py`：共享任务核心、BEATs 推理、复核导出和 HTTP／IPC 入口。
- `model_web_ui/`：Web 与桌面共用的复核界面。
- `desktop/`：Electron 桌面宿主及原生打包配置。
- `scripts/`、`tests/`：模型服务构建、验证与回归检查。

服务的基础依赖由 `pyproject.toml` 和 `uv.lock` 管理。完整推理还需准备 `apex-voice-detect` 工作目录、BEATs 权重及 [推理依赖](scripts/requirements-audio-inference.txt)；已验证的推理环境使用 Python 3.12。仅安装本项目不会下载模型或 PyTorch。

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -e .
# 或用 uv 安装锁定的基础服务依赖
uv sync --locked --python 3.12
```

准备 PATH 中的 FFmpeg／ffprobe 后运行回归检查；HTTP 测试需要本机回环端口权限：

```sh
.venv/bin/python -m unittest discover -s tests -v
node --test model_web_ui/browser.prototype/tests/*.test.mjs
APEX_PYTHON=.venv/bin/python node --test desktop/test/*.test.cjs tests/desktop_handoff_cli.test.cjs
```

真实 BEATs 测试需显式设置 `APEX_REAL_MODEL_WORKSPACE` 和 `APEX_ENGINE_PYTHON`。PowerShell 或本地安装包缺失时，对应环境测试会标记跳过；这些检查不替代人工复核与目标系统验收。桌面启动、原生构建见 [桌面入口](docs/desktop-model.md)，媒体工具准备见 [媒体工具说明](docs/media-tools.md)。
