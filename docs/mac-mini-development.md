# Mac mini 开发环境

项目与模型工作目录分别为 `~/apex-fps-mvp`、`~/apex-voice-detect`。当前主线使用共享 Python 模型核心，提供 Web 和 Electron 双入口；旧 RMS 网页和独立模型原型已移除。

## Web 启动

在项目根目录执行：

```sh
sh scripts/start-python-model-web.sh
```

打开启动日志中包含访问令牌的完整地址，在界面选择本地录像并确认游戏音轨。该入口只监听本机地址，默认输出目录为 `outputs/python-web/`，无需 Bun 或 Node。

## 依赖与路径

完整推理使用 Python 3.12、FFmpeg／ffprobe、BEATs 权重和模型工作目录。已验证推理依赖见 `scripts/requirements-audio-inference.txt`；模型代码与权重独立保存，不提交到主项目仓库。

默认使用相邻 `apex-voice-detect/.venv-pretrainedsed/bin/python`。可通过 `APEX_MODEL_WORKSPACE`、`APEX_ENGINE_PYTHON` 覆盖模型目录与推理 Python；媒体工具、端口、数据目录等参数直接传给启动脚本。详细配置见 [Web 入口](python-model-web.md)。

Electron 开发启动及原生打包见 [桌面入口](desktop-model.md)。

## 历史迁移证据

早期迁移包与 `destination-validation.json` 曾保存在目标机 `~/payload`，记录了 20 秒样本的模型加载、推理、预览、快速与精确导出。这是旧原型的历史记录，不代表当前主线在目标机重新验收通过；恢复原型见 [封存说明](archive-version0.md)。当前模型主线的验证范围见 [实现记录](model-service-implementation.md)。
