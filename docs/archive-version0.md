# version0：重构前封存

封存日期：2026-09-18。主线删减日期：2026-10-13。

## 当前主线与历史恢复

当前主线仅保留纯浏览器选片初版。此前音频模型的 Python Web／Electron 双入口已于 2026-10-28 [单独归档](archive-python-electron.md)。更早的 Python 终端、Go/CGO、Bun 网页、RMS 音频能量检测、OCR／模板伤害识别，以及对应测试、素材、打包脚本和发布 workflow 已在 version0 清理时删除。以下范围与检查均描述历史快照，不表示这些实现仍存在于当前主线。

- 旧实现：`version0` 标签或 `archive/version0` 分支。
- 依赖旧 TypeScript 导出器的早期模型原型：提交 `d9f2bbd`；当前主线也已移除其启动与执行脚本，保留设计和基准记录。
- 本地忽略的录像、输出、依赖环境、构建缓存和历史发布包未随源码删减删除。

可在独立目录解开历史源码，不覆盖当前工作树：

```sh
mkdir -p /tmp/apex-version0-source
git archive version0 | tar -x -C /tmp/apex-version0-source
mkdir -p /tmp/apex-model-prototype-source
git archive d9f2bbd | tar -x -C /tmp/apex-model-prototype-source
```

模型与媒体二进制仍须另外准备；历史代码恢复不代表其环境或发布流程已重新验收。

## 封存原因与范围

封存时基于图像定位和数字识别的伤害分析方案处理长录像效率不足，需要重新设计架构。本快照保留现状，供后续重构对照和回退，不在封存过程中改变识别策略。

- 根目录：Python 终端实现、伤害定位与曲线、测试和打包脚本。
- `go/`：Go/CGO 实现、原生媒体工具构建脚本与验证资料。
- `typescript/`：Bun 本地网页应用、关键帧 PaddleOCR 分析、预览、导出、测试和历史方案资料。
- 历史 interval/template 实现仍被回归测试和文档引用，作为基线保留。
- 本地 agent 技能、依赖环境、模型缓存、构建缓存、发布包、用户录像和运行中间产物不纳入 Git 快照。忽略目录中的实测原始证据保留在本机，不随 tag 分发。

## 已知问题与验证边界

- 图像识别性能不满足下一阶段架构目标；关键帧采样也可能漏掉区间内的变化，单帧 OCR 误读可能产生错误候选。
- TypeScript 发布 CI 的完整验证包含 PaddleOCR，但现有 workflow 尚未配置 Python/OCR 依赖和模型；不能把它视作可用的自动发布流程。
- 同一运行会话内，已经完成的预览缓存不会在每次复用时重新检查源录像；源录像变更后应重新分析。
- TypeScript 源文件身份校验使用路径、大小和修改时间，不能发现三者不变的内容替换。
- 既有验证报告是各自日期和实现阶段的记录，不代表当前所有平台重新验收通过。Windows 交叉编译不等于 Windows 实机验证。
- 此 tag 是源码封存，不是完整离线运行包；FFmpeg、Bun、Python/PaddleOCR 与模型按各实现文档准备。

## 2026-09-18 封存前检查

- Python：`.venv/bin/python -m unittest discover -s tests`，44 项通过。
- TypeScript：使用项目已有 Bun 1.3.13，类型检查和全部 52 项测试通过（1000 个断言）。媒体测试需要本机回环端口权限，在沙箱外执行。
- OCR worker：3 项测试通过，使用模拟识别器，不构成真实模型准确率验证。
- Go/CGO、真实长录像与跨平台发布包未在本轮重新验收。

`version0` 标签用于标识本轮封存；后续重构应使用独立分支，保留此基线不变。
