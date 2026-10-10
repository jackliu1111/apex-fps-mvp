# Mac 桌面验收 Kit

目标机只需要完整的 Mac `.app`、本目录、已获授权的真实录像及 macOS 自带 Terminal／shell。不要安装 Node、Python、Bun、PyTorch 或系统 FFmpeg 来补验收环境。

此 Kit 使用 `.app` 内 Electron 的 Node 运行能力承载控制器。当前新 ad-hoc 测试包已实际输出 Electron 40.10.6／Node 24.15.0；它不是开发机的系统 Node。控制器再启动真正桌面应用时会清除 `ELECTRON_RUN_AS_NODE`。自动流程通过不确认机器干净、网络断开、安装信任或人工音画同步。

## 先人工安装，再运行 Kit

1. 从实际移交 ZIP 原样解压完整 `.app`，放入普通用户拥有权限的中文／空格目录。核对发行方提供的包 SHA-256、版本与最低系统声明。
2. **先在 Finder 首次打开应用，记录系统安装／来源／隔离提示、截图和人工采取的动作。** 如果系统拒绝，记录阻塞，不用 Kit 绕过。包内 Node 的 CLI 启动不能替代下载后第一次打开的信任观察。本地 ad-hoc 签名也不等于 Developer ID／公证。
3. 正常退出所有既有 Apex Model Review 窗口，确认没有本次应用残留。建立独立、可写、位于 `.app` 外的证据目录；源录像使用绝对路径，并事先明确包含游戏声音的容器音轨索引。
4. 人工记录机器来源、实际 OS／硬件、普通用户、无开发环境状态及是否真正断网。本 Kit 不改网络，不删 quarantine，不改 HOME／系统信任或安装权限。

```sh
/bin/mkdir -p "$HOME/验收记录/Mac 模型"
/bin/sh '/Kit所在目录/run-mac.command' \
  --app "$HOME/验收资料/中文 移动目录/Apex Model Review.app" \
  --source '/真实录像完整路径.mkv' --audio-stream 1 \
  --evidence "$HOME/验收记录/Mac 模型" --preflight
```

`--preflight` 只检查当前 carrier、其他同一应用执行文件的进程、输入、完整资源 seal 及控制器预算；不启动 GUI、模型或媒体任务。输出 `preflight_passed` 不是桌面闭环或干净机器通过。错误时保留终端输出和证据，不自动重试或修改安全设置。

## 真正桌面闭环

在首次安装信任已由人工观察后，去掉 `--preflight`，使用一个新的空证据目录：

```sh
/bin/mkdir -p "$HOME/验收记录/Mac 完整闭环"
/bin/sh '/Kit所在目录/run-mac.command' \
  --app "$HOME/验收资料/中文 移动目录/Apex Model Review.app" \
  --source '/真实录像完整路径.mkv' --audio-stream 1 \
  --evidence "$HOME/验收记录/Mac 完整闭环" \
  --stage-timeout-s 1200 --total-timeout-s 7200
```

控制器操作实际 `.app` 的公开页面／有限 IPC：明确选轨、默认 0.2／5／5／5 分析、全选保存、首段按需预览、全部选中分别导出、包内媒体工具全量解码、真实播放、重复启动、正常退出及已捕获 PID 清理。报告记录真实尺寸／时长、参数、预算、文件与阶段证据。源录像不复制到 Kit。没有候选的素材不能用于确认导出能力，应保留该真实结果并另选有候选的录像。

默认预算为每阶段 1200 秒、总共 7200 秒；这是测试停止预算，不是产品等待上限承诺。两项必须是有限正数且不超出运行时计时器范围。实际完整处理可能较长；超时／失败不填通过。当前 Kit 的 GUI／模型分支尚未用包内 Node 再跑完整工作负载，目标机须实际运行并留档；既有开发机闭环和本机 preflight 不替代该记录。

## OS 与人工记录

`collect-mac.sh` 是 macOS 内置工具／包内媒体工具的证据收集入口，不安装工具、不改网络、信任或应用状态：

```sh
/bin/sh '/Kit所在目录/collect-mac.sh' '/完整应用.app' '/OS证据目录' preflight '/实际交付.zip'
/bin/sh '/Kit所在目录/collect-mac.sh' '/完整应用.app' '/OS证据目录' before-quit
# 在应用仍实际运行时采集上一步，然后正常退出。
/bin/sh '/Kit所在目录/collect-mac.sh' '/完整应用.app' '/OS证据目录' after-quit
```

OS 收集步骤与自动 Kit 要分开安排：`before-quit` 必须抓到实际运行进程，不能在 Kit 全部退出后补写退出前 PID。若自动 Kit 已正常关闭应用，使用它报告中本次捕获的 `normal_quit.tracked`／清理记录；需要独立 OS 退出采样时，按人工操作流程运行应用并收集。本 Kit 的 CLI controller 本身也使用 `.app` 执行文件，应记录其角色，不能误称 GUI。

逐文件探测／解码可用 `collect-mac.sh ... decode '/实际预览.mp4' '/实际成片001.mp4' ...`；所有选中输出均需包含。填写 [target-review.md](target-review.md) 的机器／安装／断网／内容／边界／同步／退出记录。未观看、没有音画线索或未执行的项目分别填待审核、无法判断或未运行。

## 范围

此目录目前只有 Mac 入口；Windows 不能复用 Mac 的 `.app` 路径、`ps`／`codesign`／UID 调用，也不能用 NSIS 安装器或 portable stub 冒充已安装的 Electron carrier。Windows 原生包和对应 PowerShell／控制器入口须另行验收。
