# 模型清单 404 修复对照（2026-11-01）

复现环境：默认 EfficientAT 模型，`--assets` 指向缺少模型文件的本地资产目录；页面在同一浏览器视口（1440×1100）导入同一段 2 秒合成 WebM 录像并开始分析。

- 基线：`d542167`（修复前）。分析失败，队列只显示 `模型清单无法读取（HTTP 404）`，没有缺失路径和恢复线索。见 [before.png](before.png)。
- 修复后：同一场景下错误信息包含请求路径与检查建议。见 [after.png](after.png)。
- 服务启动时直接列出缺失文件，而不是等浏览器报 404。见 [startup-missing-assets.txt](startup-missing-assets.txt)。

截图由 Chrome 无头模式加载真实页面、通过真实文件输入与分析队列取得；合成录像仅用于稳定复现，不代表模型识别质量。

根因：默认资产目录 `/private/tmp/apex-browser-prototype-20261026/assets` 位于系统临时空间，模型清单、权重和 ONNX Runtime 文件被系统清理，静态服务按文件不存在返回 404。另外，用于补回运行库的 `download_runtime.py` 使用了 Python 3.11 才有的 `hashlib.file_digest`，在系统 Python 3.9 上会在下载第一个文件后报错，无法完成恢复；本次一并改为 3.9 兼容。本次修改不下载或提交模型权重；恢复方式见 `model_web_ui/browser.prototype/README.md` 的「故障排查」与「开发阶段重建资产」。
