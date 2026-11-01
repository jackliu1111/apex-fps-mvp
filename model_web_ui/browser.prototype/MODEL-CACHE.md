# 浏览器模型缓存

模型首次加载时下载 ONNX 文件，按模型清单的 `bytes` 和 `sha256` 校验后，保存到浏览器 Cache Storage 的 `apex-models-v1` 缓存。后续刷新页面或重新打开同一站点，优先读取并校验本地缓存，无需再次传输模型文件。模型清单与 EfficientAT 前处理常量仍通过网络读取，因此这不是完整离线模式。

缓存键包含模型 URL 和清单 SHA-256。更新服务器模型时必须同步更新 `model.json` 中的 `sha256`、`bytes` 和其他模型参数；新版本不会误用旧模型。下载中断或校验失败的文件不会写入缓存；缓存损坏时重新下载。旧版本缓存由浏览器存储管理或用户清理站点数据回收。

此缓存与普通 HTTP 缓存独立，不需要放开页面服务的 `Cache-Control: no-store`。需要 HTTPS 或 localhost 等可信环境以及浏览器的 Cache Storage 支持。缓存属于当前浏览器、用户配置及站点来源；更换浏览器、域名、协议或端口，清理站点数据，或浏览器回收存储后可能需要重新下载。缓存不可用或写入失败不阻止本次分析。每次新建推理会话仍需要初始化 WASM 引擎。

页面状态分别显示下载进度、读取本地缓存、文件校验、缓存保存结果和引擎初始化。

验证命令：

```sh
node --test model_web_ui/browser.prototype/tests/model-cache.test.mjs model_web_ui/browser.prototype/tests/browser-analysis.test.mjs
```

测试覆盖缓存复用、版本变化、损坏缓存、下载失败、不匹配文件以及存储拒绝/配额不足。部署验收时应在同一浏览器中首次运行后刷新再次运行，确认网络面板不再传输 ONNX 文件，而页面显示读取本地模型缓存。
