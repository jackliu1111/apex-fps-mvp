# Python / Electron 双入口归档

2026-10-28，用户确认 `main` 只保留当前纯浏览器初版。此前共享 Python 核心、Python Web 与 Electron 双入口的源码、界面、构建工具、专属回归和验收文档移出主分支，完整版本保存在 [archive/python-electron-20261028](https://github.com/jackliu1111/apex-fps-mvp/tree/archive/python-electron-20261028)。归档固定提交为 [`69b637cddde2ab4cfe8663e55e2bd295199c8133`](https://github.com/jackliu1111/apex-fps-mvp/tree/69b637cddde2ab4cfe8663e55e2bd295199c8133)。

当前入口、运行条件和检查命令以 [项目说明](../README.md) 与 [浏览器工作区说明](../model_web_ui/browser.prototype/README.md) 为准。浏览器仍可选择 EfficientAT 或 BEATs；浏览器所需模型资产导出器继续保留。移除旧 Python 分析服务不等于移除浏览器的 BEATs 模型，也不把旧服务的性能或验收结论转为浏览器保证。

## 归档内容

| 范围 | 固定历史入口 |
| --- | --- |
| 共享 Python 分析、任务、身份、复核导出核心，HTTP / NDJSON IPC | [服务方案](https://github.com/jackliu1111/apex-fps-mvp/blob/69b637cddde2ab4cfe8663e55e2bd295199c8133/docs/design/model-service.md)、[双宿主 ADR 0002](https://github.com/jackliu1111/apex-fps-mvp/blob/69b637cddde2ab4cfe8663e55e2bd295199c8133/docs/adr/0002-shared-python-engine-dual-hosts.md)、[Python Web 使用](https://github.com/jackliu1111/apex-fps-mvp/blob/69b637cddde2ab4cfe8663e55e2bd295199c8133/docs/python-model-web.md) |
| 旧 Web 界面、Electron 宿主、Python 打包配置、安装与移交脚本 | [桌面入口](https://github.com/jackliu1111/apex-fps-mvp/blob/69b637cddde2ab4cfe8663e55e2bd295199c8133/docs/desktop-model.md)、[移交工具](https://github.com/jackliu1111/apex-fps-mvp/tree/69b637cddde2ab4cfe8663e55e2bd295199c8133/handoff/desktop-verify-kit) |
| 旧服务、桌面与传输契约专属测试，平台验证及媒体工具准备 | [实现与验收状态](https://github.com/jackliu1111/apex-fps-mvp/blob/69b637cddde2ab4cfe8663e55e2bd295199c8133/docs/model-service-implementation.md)、[契约审计](https://github.com/jackliu1111/apex-fps-mvp/blob/69b637cddde2ab4cfe8663e55e2bd295199c8133/docs/model-service-contract-audit.md)、[桌面验证](https://github.com/jackliu1111/apex-fps-mvp/blob/69b637cddde2ab4cfe8663e55e2bd295199c8133/docs/desktop-validation.md) |
| 早期部署原型、FFmpeg 导出基准和画面规则研究 | [部署原型结论](https://github.com/jackliu1111/apex-fps-mvp/blob/69b637cddde2ab4cfe8663e55e2bd295199c8133/docs/design/model-service.prototype.md)、[服务基准](https://github.com/jackliu1111/apex-fps-mvp/blob/69b637cddde2ab4cfe8663e55e2bd295199c8133/docs/design/model-service.benchmark.md)、[画面规则研究](https://github.com/jackliu1111/apex-fps-mvp/blob/69b637cddde2ab4cfe8663e55e2bd295199c8133/docs/design/firing-montage.md) |

## 保留的历史结论与边界

旧实现已完成批量分析、完整预测持久化、候选重算、人工范围编辑、预览及独立快速复制导出，并通过限定场景的 HTTP / IPC 契约对照。真实 21 分钟 4K 录像的两入口各 34 段导出通过完整解码及分数对照；一小时 1080p 录像的 HTTP 与已有桌面结果也有 98 段对照记录。这些是旧实现与当时环境的技术结果，不能推导候选代表本人开枪、命中或击杀。详见 [4K 记录](https://github.com/jackliu1111/apex-fps-mvp/blob/69b637cddde2ab4cfe8663e55e2bd295199c8133/docs/model-recording-4k-validation.md) 与 [1080p 记录](https://github.com/jackliu1111/apex-fps-mvp/blob/69b637cddde2ab4cfe8663e55e2bd295199c8133/docs/model-recording-1080-validation.md)。

归档时的 [项目说明](https://github.com/jackliu1111/apex-fps-mvp/blob/69b637cddde2ab4cfe8663e55e2bd295199c8133/README.md)记录 Mac 干净机移交已完成，但包采用本地 ad-hoc 签名，不能视作 Developer ID / 公证发行验收；Windows 实机验收及逐片人工切点、感知音画同步复核仍有未完成项。归档不把这些状态改为通过，也没有重建或重新验收旧安装包。详见 [Mac 移交记录](https://github.com/jackliu1111/apex-fps-mvp/blob/69b637cddde2ab4cfe8663e55e2bd295199c8133/docs/desktop-mac-acceptance.md)、[Windows 交接](https://github.com/jackliu1111/apex-fps-mvp/blob/69b637cddde2ab4cfe8663e55e2bd295199c8133/docs/desktop-windows-acceptance.md) 和 [人工复核清单](https://github.com/jackliu1111/apex-fps-mvp/blob/69b637cddde2ab4cfe8663e55e2bd295199c8133/docs/model-recording-human-review.md)。

早期画面规则路线因弹药变化不完整覆盖射击而暂停；部署原型与 FFmpeg 基准仅适用于各自阶段。当前浏览器的顺序解码、稀疏读取、Cluster 并发、独立音频等研究文档和结论继续留在主分支，见 [初版清理记录](initial-release-cleanup.md)。QuickLook 兼容性问题仍按 [历史调查结论](copy-stutter-investigation.md) 暂缓，未宣称修复。

## 查看与恢复

仅查看历史文件不需要切换当前分支：

```sh
git show archive/python-electron-20261028:README.md
git show archive/python-electron-20261028:docs/desktop-model.md
```

需要继续旧实现时，从归档分支创建独立开发分支或工作区。模型、用户原录像、旧安装包、忽略目录中的运行证据和依赖环境没有纳入本次归档，也未删除或移动；按历史说明另行准备。任何新增的大型模型、构建包或媒体产物仍须遵守当前外接存储规则，历史本机输出路径不构成新的本机存储许可。
