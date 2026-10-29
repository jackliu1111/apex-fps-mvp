# Apex Local Cut

**从 Apex Legends 长录像中找到交战候选，自己决定留下哪些片段。**

![阶段：初版](https://img.shields.io/badge/status-MVP-orange)
![处理位置：浏览器本机](https://img.shields.io/badge/processing-browser_local-blue)
[![使用文档](https://img.shields.io/badge/docs-使用指南-blue)](model_web_ui/browser.prototype/README.md)

Apex Local Cut 根据录像中的声音查找枪声候选，让你边分析边观看原片，调整选片范围，再分别导出视频。媒体处理和模型推理在浏览器本机完成，录像不上传。

> 自动找到的是**待复核的枪声片段**，不等于本人开枪、命中、击杀或已经确认的精彩时刻。

[在线体验](#在线体验) · [快速开始](#快速开始) · [如何选片](#如何选片) · [使用限制](#使用限制) · [开发与验证](#开发与验证)

## 在线体验

**[打开 Apex Local Cut 在线演示](https://140.143.223.69:8443/)**

使用桌面 Chrome 打开，点击「导入录像」选择自己的本地文件。页面与模型资源从服务器加载，录像分析、复核和导出在浏览器本机执行，导入录像不上传。

这是测试部署，当前没有配置内置演示录像，请直接导入自己的录像。首次使用需要加载模型资源；在线版本可能与仓库最新代码存在差异。

2026-10-29 已从服务器外部验证 HTTPS、页面与模型加载、一分钟真实录像分析、复核页面及人工选片导出；本次样本在默认阈值下没有自动候选，因此该检查不代表识别质量保证。详细结果见[公网验证记录](docs/public-demo-validation.md)。

## 为什么使用它

- **不用等整段分析完再开始看。** 候选逐步出现，分析期间可以复核已有片段，也可以定位到尚未分析的原片位置。
- **看着原片调整切点。** 双时间轴分别展示原片与候选范围，结合参考画面、音频波形和播放位置裁剪片段，支持数字精调、排除与恢复、撤销与重做。
- **保留你的选择。** 重新调整筛选规则时保留人工决定；人工决定与波形仅在当前页面会话内保留，刷新或关闭后需重新导入。
- **按确认的范围导出。** 提交时固定本批选片和输出设置，后续修改用于下一批。默认逐片段输出 MP4，也可选择 WebM。
- **多份录像分别处理。** 支持批量导入、顺序分析，单份录像失败不阻塞其他录像。

## 快速开始

当前提供源码运行方式，**运行库和模型资产需要单独准备，不包含在 Git 仓库中**。首次使用请先阅读[资产准备说明](model_web_ui/browser.prototype/README.md#开发阶段重建资产)和 [EfficientAT 模型重建说明](model_web_ui/browser.prototype/README.md#efficientat-mn04_as-重建)。这些仍是开发者流程，尚未提供一键安装包。

### 1. 准备运行环境

- 支持 WebCodecs 的桌面 Chrome；媒体解码、编码和目录选择能力以实际浏览器为准。
- Python 3.9 或更新版本，用于启动本地静态服务。
- 已准备好的浏览器运行库与模型资产目录。默认分析模型为 EfficientAT，也可选择 BEATs。

Python 只提供页面和静态资产，日常运行不执行 Python 推理或转码，也不需要 Electron 或 npm 依赖。

### 2. 获取源码并启动

```sh
git clone https://github.com/jackliu1111/apex-fps-mvp.git
cd apex-fps-mvp

# 将路径替换为已准备好的资产目录。
python3 model_web_ui/browser.prototype/serve.py \
  --assets /absolute/path/to/assets
```

打开 **<http://127.0.0.1:8792>**，点击「导入录像」，选择本地 Apex 录像开始分析。请通过本地服务访问页面，不要直接双击 HTML 文件。

已有开发环境若沿用服务默认资产目录 `/private/tmp/apex-browser-prototype-20261026/assets`，可省略 `--assets`；其他机器不能假定该目录存在。

### 3. 可选：配置一分钟交战样本

已有真实交战 MP4 样本时，可在启动命令中增加 `--sample`：

```sh
python3 model_web_ui/browser.prototype/serve.py \
  --assets /absolute/path/to/assets \
  --sample /absolute/path/to/apex-combat-60s.mp4
```

进入页面后使用试用入口体验分析、复核和导出。未配置样本也可直接导入自己的录像。样本文件不随仓库分发，来源与制作方式见[真实交战样本说明](docs/real-combat-sample.md)。样本仅用于体验流程，不代表模型整体准确率。

## 如何选片

| 步骤 | 操作 | 结果 |
| --- | --- | --- |
| **导入** | 一次选择一份或多份本地录像 | 文件分别准备，就绪后排队分析 |
| **复核** | 打开已出现的候选，播放原片查看前后内容 | 无需等待整份录像分析结束 |
| **调整** | 保留或排除候选、添加人工范围、裁剪起止时间 | 结合双时间轴确定最终选片，可撤销与重做 |
| **导出** | 确认范围和格式，提交本批选片 | 本批设置固定；导出等待分析释放资源后执行 |
| **保存** | 下载已生成的片段，或为大批次选择输出目录 | 每段分别显示结果，部分失败保留已完成成片 |

小批次提供下载链接，大批次写入你选择的目录。**出现下载链接表示成片已生成，仍需要你下载保存；目录输出在文件写入完成后才显示已保存。**详细操作、快捷键和会话边界见[使用指南](model_web_ui/browser.prototype/README.md#操作流程)。

## 使用限制

- **识别范围：** 根据枪声寻找候选，不能区分声音一定来自本人、队友或敌人；最终保留哪些内容由你决定。
- **浏览器与格式：** 支持情况取决于浏览器和媒体编解码器。当前建议使用桌面 Chrome，不承诺所有录像格式、浏览器或移动设备都可用。
- **导出质量：** MP4（H.264 + AAC）和 WebM（VP8 + Opus）均重新编码，默认沿用原片分辨率与帧率，并非无损截取。声音和切点需人工复核。
- **会话范围：** 分析、选片、波形和导出批次仅在当前页面内保留。刷新或关闭后工作区清空，需重新导入并分析；请先完成导出并保存成片。存在进行中的任务、未提交选片或尚未确认保存的下载结果时，页面会请求浏览器提示离开，但不能保证拦截浏览器或系统强制关闭。
- **性能边界：** 长录像处理时间受解码、存储和设备性能影响。当前通过 WASM CPU 推理，尚未接入 WebGPU；已有测量与未验证范围见[验收记录](docs/parallel-analysis-review-validation.md)。

准备模型、生成媒体或导出大文件时，单文件达到 **100 MiB** 或单任务累计达到 **1 GiB** 的生成物应直接写入已确认挂载、可写且空间充足的外接卷。默认使用 `/Volumes/EXTERNALUSB/codex-artifacts/<项目名>/<任务名>/`；使用外接资产期间需保持挂载。模型、权重和大媒体文件不提交 Git。

## 开发与验证

当前应用位于 `model_web_ui/browser.prototype/`，目录名称沿用历史命名，其中是当前有效实现。

```text
model_web_ui/browser.prototype/   浏览器应用、本地静态服务与模型导出工具
  tests/                         逻辑测试、浏览器交互与真实媒体回归
  evidence/                      实验和验收证据
scripts/                         样本制作工具与模型转换依赖
docs/                           设计、研究、验收与历史归档说明
CONTEXT.md                       产品术语与语义边界
```

运行逻辑测试（需要 Node.js）：

```sh
node --test model_web_ui/browser.prototype/tests/*.test.mjs
```

真实浏览器验证需要另行准备 Playwright、Chrome、模型资产及相关样本，配置与命令见[浏览器工作区说明](model_web_ui/browser.prototype/README.md)。测试记录只说明对应场景的验证结果，不代表模型识别质量或所有设备上的性能保证。

| 想了解什么 | 阅读入口 |
| --- | --- |
| 详细操作、资产准备、运行与测试 | [浏览器工作区说明](model_web_ui/browser.prototype/README.md) |
| 候选、人工决定和导出批次的含义 | [产品术语](CONTEXT.md) |
| 分析与复核如何独立推进 | [并行分析与复核设计](docs/design/parallel-analysis-review.md) |
| 已测流程、性能与限制 | [验收记录](docs/parallel-analysis-review-validation.md) |
| 真实演示样本的来源与制作 | [样本说明](docs/real-combat-sample.md) |
| 旧 Python / Electron 实现 | [历史归档](docs/archive-python-electron.md) |

当前仓库未附项目级许可证文件；第三方运行库和模型有各自的许可证与来源说明，请分别查阅。当前也未配置 GitHub Actions 状态徽章，页首徽章仅说明项目阶段、处理位置和文档入口。
