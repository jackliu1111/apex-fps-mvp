# Mac mini 开发环境

项目位于 `~/apex-fps-mvp`，音频模型工作目录位于 `~/apex-voice-detect`。开发分支为 `codex/mac-mini-dev`。

当前前端的音频模式仍为 RMS；BEATs 模型服务是独立的原型，不代表正式接入已完成。

## 启动

在项目根目录执行，两个服务分别在不同终端运行：

```sh
./scripts/start-frontend.sh
./scripts/start-model-service.sh ~/payload/sample-apex.mp4
```

前端使用 8787 端口，模型原型使用 8769 端口，都仅监听 Mac mini 的 127.0.0.1。前端应使用启动日志中包含访问令牌的完整地址。

## 依赖与路径

Bun 1.3.13、Python 3.12、FFmpeg/ffprobe。模型环境为 `~/apex-voice-detect/.venv-pretrainedsed`，推理依赖见 `scripts/requirements-audio-inference.txt`。模型代码和两份权重独立保存，不提交到主项目仓库。

默认模型工作目录是项目的相邻目录；可通过 `APEX_MODEL_WORKSPACE` 或模型服务的 `--model-workspace` 参数覆盖。可通过 `APEX_ENGINE_PYTHON` 指定另一推理环境。当前原型固定使用 CPU。

替换样本路径即可处理其他本地录像，模型服务输出默认位于 `outputs/model-service/`。

## 迁移验证

迁移包保留在 `~/payload`。实际目标机验证报告为 `~/payload/destination-validation.json`，完整分析和视频导出记录位于报告的 output 路径。验证使用一段 20 秒真实录像，覆盖模型加载、推理、候选整理、快速导出、预览、精确导出和全量解码；识别准确率及完整长录像性能仍需另测。
