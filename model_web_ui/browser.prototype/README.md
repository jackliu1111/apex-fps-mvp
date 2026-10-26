# 纯网页处理链路 · 可丢弃原型

问题：不安装本地助手，现有 BEATs 枪声模型能否与浏览器媒体处理连起来？先验证链路，不优化耗时。

这是功能／状态原型，不是三个视觉方案，也不是生产重构。它沿用本项目已确认音轨、真实模型分数、5/5/5 候选的业务流程。因为需要真实 WASM 模型和 WebCodecs，使用静态 HTTP 页面，而非双击 HTML 的模拟演示。原型不接入现有 Python 业务服务，不改动其协议或入口。

## 本机启动

在仓库根目录运行一个命令：

```sh
python3 model_web_ui/browser.prototype/serve.py
```

打开 <http://127.0.0.1:8792>，使用支持 WebCodecs 的桌面 Chrome。页面有浏览器能力指示。

此命令只提供静态文件，**不处理录像、不执行推理、没有上传接口**。最终可以把页面与 assets 放到 HTTPS 静态站点；网站用户不需要 Python、FFmpeg、Electron 或本地助手。本轮没有部署公网网站。

当前资产路径是 `/private/tmp/apex-browser-prototype-20261026/assets`。这是用户在外接盘创建目录阻塞后明确批准的本机存储例外。临时目录可能被系统清理；换目录后使用 `--assets /绝对路径`。模型和运行库不进入 Git。

## 如何体验

1. 导入一份或多份本地录像；也可点击“生成 12 秒合成样本”。合成视频含脉冲和 440 Hz 两条音轨，不是实际枪声素材。
2. 每份录像必须明确选择游戏音轨。更换音轨会清除该文件的旧分数和候选。
3. 开始分析：按 10 秒窗口、5 秒步长读取音频，浏览器 Web Audio 转成 16 kHz 单声道；Worker 内 ONNX Runtime WASM 执行前处理和 BEATs。
4. 两个枪声类的概率按重叠窗口取均值，3 帧中值平滑，再按阈值生成事件与 5/5/5 候选。可调阈值重算（会替换手动编辑）、勾选、修改起止、移除或添加手动范围。
5. 预览与导出都在浏览器内转成最高 720p 的 VP8 + Opus WebM，只包含选中的音轨。点击下载链接才保存文件。
6. “原型状态与证据”可查看状态和日志。“验证浏览器模型与 Python 基准”使用固定合成噪声，比较完整 250×447 输出。

可随时取消活动任务。推理 Worker 会终止；重试重新加载模型并从该文件开头分析。已完成文件和下载链接保留。项目仅在页面内存中，刷新清空，不写 IndexedDB / OPFS / localStorage。

## 开发阶段重建资产

以下仅是开发者转换和打包步骤，不是网站用户的安装步骤。Python 需要既有模型环境和 ONNX 1.19.1、ONNX Runtime 1.23.2；本次依赖位于 `/private/tmp/apex-browser-prototype-20261026/deps`。

```sh
env PYTHONDONTWRITEBYTECODE=1 \
  PYTHONPATH=/private/tmp/apex-browser-prototype-20261026/deps \
  /Users/jackliu/apex-voice-detect/.venv-pretrainedsed/bin/python \
  model_web_ui/browser.prototype/export_model.py \
  --workspace /Users/jackliu/apex-voice-detect \
  --output /private/tmp/apex-browser-prototype-20261026/assets

/Users/jackliu/apex-voice-detect/.venv-pretrainedsed/bin/python \
  model_web_ui/browser.prototype/download_runtime.py \
  --assets /private/tmp/apex-browser-prototype-20261026/assets
```

其他环境须替换绝对路径。资产输出预计约 370 MiB；重建前遵守用户的大文件存储规则，不把本次例外当成永久许可。

导出器将 Kaldi fbank 改写为固定窗口的实数 DFT 矩阵计算，并将 496→250 的 adaptive average pooling 表达成等价固定矩阵。仅支持 `[1,160000]` 波形输入和 `[1,250,447]` 概率输出，短音频补零；不做量化、蒸馏或模型替换。`model.json` 包含参数、类别、模型哈希和 Python 对照误差；vendor 清单包含来源、版本、字节数与 SHA-256。

## 范围与限制

- 当前通过 WASM CPU 运行；未接 WebGPU，也没有性能目标。
- 不读取整份视频进内存；但单段导出和待下载成片仍保留在内存。长片、大批量、存储配额与页面后台生命周期未验收。
- 音频重采样和多声道混音由浏览器完成，尚未证明与 FFmpeg 全链路数值一致。模型合成基准对照不能替代真实录像验证。
- 原型只保存两个枪声类的时间分数，不实现正式服务完整 447 类预测存档、模型版本失效、重启恢复与文件身份校验。
- 格式支持取决于浏览器与 Mediabunny；不支持的解码／编码会显示失败。WebM 重编码与现有快速复制导出不同，不保留原视频质量；声画边界仍需人工复核。
- 界面、音轨试听与操作偏好尚待用户评价。候选不代表本人开枪、命中或击杀。

实测范围、结论及已知时间边界问题见 [CAPTURE.md](CAPTURE.md)。

上游参考：[ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/)、[Mediabunny](https://mediabunny.dev/guide/converting-media-files)。运行库许可证与静态资产一同下载。
