# 初版收敛与实验归档

日期：2026-10-28。

本次保留已经接入实际使用流程的浏览器分析、完整原片播放、选片复核、自动保存与独立导出；从当前代码树移除隔离诊断、未采用的读取实验和早期模拟页面。`model_web_ui/browser.prototype/` 虽沿用历史目录名，其中工作区已是实际实现，不能按 `prototype` 名称整体删除。Python／Electron 入口和回归检查仍保留。

## 保留的实现

- 两种实际可选的音频模型：EfficientAT 与 BEATs，以及开发阶段生成它们所需的 `export_efficientat.py`、`export_model.py` 和运行库下载脚本。
- 顺序音频解码、渐进候选、独立分析与复核、人工决定保护、固定导出批次、IndexedDB 恢复和最终 4 MiB 共享读取调度。
- 公开接口测试、浏览器交互与真实媒体回归工具。合成媒体仍用于确定性的音轨、取消和失败场景检查，用户体验样本使用真实交战录像。
- 实验说明、结论、JSON 数值报告和截图。清理不删除用户原录像、已有模型、外接盘媒体产物或其他工作区。

## 移除的实验代码与结论

| 实验 | 移除的代码 | 保留的结论与证据 |
| --- | --- | --- |
| 外接盘 MKV 读取诊断、稀疏跳读及 Cluster 并发 | `diagnostics/` 中读取、运行库补丁、包差分与计时脚本和网页，`sparse-audio.prototype.js` | 稀疏读取减少交付字节但该素材耗时更长；Cluster 2/4/8 并发无收益，未作为生产策略。见 [原型验证记录](../model_web_ui/browser.prototype/CAPTURE.md)、[音频供应调研](audio-supply-research.md)及对应 `evidence/` 报告。 |
| 独立音频提取与分析 | `diagnostics/` 中 standalone-audio 页面、提取与时间轴对照脚本 | 已有 MKA 分析约 12–14 秒；先完整提取再分析约 225–226 秒，未改善首次等待；M4A 时间语义改变模型输入。见 [独立音频实验](independent-audio-experiment.md)。 |
| 1/2/4 MiB 读取块调优 | `diagnostics/verify-player-read-quantum.cjs` | 最终采用 4 MiB；保留生产读取模块、真实媒体回归和全部比较报告。见 [最终验收](parallel-analysis-review-validation.md)。 |
| 早期模型部署与任务状态模拟 | `docs/design/model-service.prototype.html` | 只模拟状态和耗时，不运行模型或输出真实视频；保留 [方案原型说明](design/model-service.prototype.md)。 |
| 暂缓的 QuickLook 卡顿调查 | `scripts/diagnose_copy_avfoundation.swift`、`scripts/diagnose_model_copy_playback.cjs`、`scripts/diagnose_model_native_playback.swift` | 其他播放器正常；已有检查未复现 QuickLook 问题，未确认修复。见 [调查记录](copy-stutter-investigation.md)。 |

`diagnostics/README.md` 保留为历史方法说明，当前不再提供诊断网页入口。实验失败、未验证范围和计时边界随结论保留，不把实验移除解释为问题已修复。

## 查看历史代码

清理前的完整代码固定在提交 `6e2a81ac94f38fea345fbb614573a8d82a297bf2`。历史报告中的命令和诊断 URL 仅适用于该版本；当前启动入口见 [浏览器工作区说明](../model_web_ui/browser.prototype/README.md)。

只读检查某个已移除脚本：

```sh
git show 6e2a81ac94f38fea345fbb614573a8d82a297bf2:model_web_ui/browser.prototype/diagnostics/demux.mjs
```

确需复现实验时，在独立目录检出该提交，按历史报告恢复固定版本依赖和媒体条件。不得把旧实验代码重新覆盖进当前工作区；下载、转换和导出前重新核实外接挂载、空间及输出路径，历史本机存储例外不适用于新产物。

## 本轮合入前验证

- 浏览器逻辑回归 46 / 46 通过；桌面与移交 CLI 回归 12 / 12 通过。
- Python 3.12 及已有推理环境运行 108 项检查，98 项通过、10 项跳过；跳过为 1 项需显式开启的真实 BEATs 和 9 项需 PowerShell 的目标环境检查。本轮没有重新验收 Windows 或真实 BEATs。
- `verify-review-browser.cjs`、`verify-review-fixes.cjs`、`verify-range-interaction.cjs` 全部通过：覆盖保存恢复、素材去重和重关联、分析中固定导出、输入焦点、单文件失败隔离、目录选择取消、部分导出失败、双手柄鼠标与键盘操作。
- [一分钟真实样本](real-combat-sample.md)完成浏览器真实分析、完整来源播放和 7 秒范围导出；1440 / 768 / 390 宽度无横向溢出，页面无 JavaScript 错误。
- 页面沿用现有设计；样本入口文案修改后，样式检查为 0 FAIL。时间格式补零与空值破折号保留；空队列检查的留白警告来自恢复中的瞬间，完成恢复和导入后的页面已另行检查。
- `git diff --check`、生产模块引用与文档链接检查通过，未把视频、模型或大型生成物纳入本次提交。

最初调用系统 Python 3.9 时因环境缺少推理测试依赖导致失败；随后改用项目已有 Python 3.12 环境，上述完整回归通过，没有为此改动业务实现。
