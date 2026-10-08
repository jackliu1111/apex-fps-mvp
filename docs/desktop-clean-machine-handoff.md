# 无开发环境桌面验收入口

Mac 移交入口位于 [handoff/desktop-verify-kit](../handoff/desktop-verify-kit/README.md)，包含 OS shell launcher、只依赖内置模块的控制器、Mac OS 收集脚本和人工记录表。目标不需要安装系统 Node、Python、Bun 或 FFmpeg；测试控制器由已安装 `.app` 内的 Electron 运行，媒体解码使用包内工具。应用的日常使用仍由 Finder／实际桌面界面完成。

**先在 Finder 完成第一次打开与安装提示观察，记录原始 quarantine、提示、人工动作与结果，再运行 Kit。** CLI 运行能力不能替代安装信任 gate。当前包为本地 ad-hoc 测试包，严格资源 seal 通过并不等于 Developer ID／公证或下载后自动获信任。目标机器、真实断网及人工同步由操作者填写；Kit 不改网络、不删 quarantine、不改 HOME／全局环境或安装权限。

## 真实载体与公开 CLI 边界

Electron 官方定义 `ELECTRON_RUN_AS_NODE` 将进程作为 Node 运行；当 `runAsNode` fuse 关闭时该变量被忽略。fuse 的默认值为启用，但需要按具体交付包验证，不能仅按文档默认推断。见 [环境变量](https://www.electronjs.org/docs/latest/api/environment-variables) 与 [fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)。本 Kit 不翻转 fuse，也不以系统 Node 作为静默回退。

稳定的新 ad-hoc Mac 包已完成一次 CLI-only 能力探针：Electron **40.10.6**／内置 Node **24.15.0**，`exec_path` 确为 `.app/Contents/MacOS/Apex Model Review`，所需 `node:assert/fs/path/os/child_process` 可载入，工具权威退出 0。证据为 [node-carrier-probe.json](../outputs/desktop-handoff-kit/node-carrier-probe.json)，未请求 GUI 或模型。

公开测试入口是 [run-mac.command](../handoff/desktop-verify-kit/run-mac.command)：`--help`、缺少必填参数、非法音轨，以及带中文／空格路径的外部载体派发按实际 Red → 最小实现 → Green 运行。外部载体夹具只验证 CLI 传参，不当作 Electron／模型验收。预算参数也从未知选项失败得到 Green；开发机 Node 测试只服务开发验证，不随目标入口引入系统 Node 依赖。

真正包内 Node 的 `--preflight` 会进入原有应用进程门、输入检查和公开 `codesign --verify --deep --strict`。原门把同一应用执行文件的 controller 自身误认作已有实例，真实 CLI 先以 `1 !== 0` 失败；仅在 Kit 复制件排除 `p.pid === process.pid` 后同 CLI 成功。其他匹配进程仍拒绝且不终止。证据为 [RED](../outputs/desktop-handoff-kit/preflight-self-red.log)、[GREEN](../outputs/desktop-handoff-kit/preflight-self-green.log) 与 [preflight 报告](../outputs/desktop-handoff-kit/preflight-self-green/relocated-electron-closure.json)。一个实际同执行文件的短驻 CLI PID 已验证被保护，见 [记录](../outputs/desktop-handoff-kit/preflight-existing-process.json)；这是 CLI 进程保护证据，没有新增真实 GUI 或模型工作负载。

默认预算为单阶段 **1200 秒**、总计 **7200 秒**；公开参数 `--stage-timeout-s`、`--total-timeout-s` 必须为有限正数并适合运行时计时器。采用 1200 秒是因为已测 4K 的准备加 34 段复制超过 600 秒；预算不是其他设备等待上限承诺。[实际预检](../outputs/desktop-handoff-kit/preflight-budget-green/relocated-electron-closure.json) 记录两项值，NaN／负数分别在 CLI 参数门拒绝，见 [stage](../outputs/desktop-handoff-kit/preflight-invalid-stage.log)／[total](../outputs/desktop-handoff-kit/preflight-invalid-total.log)。

## 复制件与已验证范围

Kit 控制器源自 [最终移位验收控制器](../scripts/verify_model_desktop_relocated.cjs)，仅在复制件增加 preflight、自身 PID 排除、用户配置的总／阶段预算、真实尺寸／时长记录及明确 user-provided recording scope。原开发机脚本和历史 20 秒闭环记录未改为长录像或干净机器通过；生产桌面代码没有为 Kit 修改。

GUI 子进程会清除 `ELECTRON_RUN_AS_NODE` 和开发运行变量，使用 pipe CDP 操作实际窗口，不借助产品 HTTP 服务或第三方 Node 模块。默认全选对应分别输出，包内媒体工具解码每份产物，再正常关闭并核对本次已捕获 PID／完整资源 seal。Kit 的 GUI／模型分支未用包内 Node 再跑完整负载；此准备与 preflight 不能代替目标机器实际执行。

具体安装／机器／断网／退出收集要素见 [Mac 人工验收](desktop-mac-acceptance.md)。Kit 内 `collect-mac.sh` 是对应 OS 收集脚本的副本；它不改变应用状态，退出前必须真实采到非空 PID，不能用事后空列表补造退出前观察。

Windows 原生入口由 Windows 验收脚本独立提供。Mac 的 `.app`、`ps`／`codesign`／UID 调用不适用于 Windows；NSIS 安装器与 portable stub 也不自动等于可用的已安装 Electron Node 载体。当前 Mac CLI 成功不声明 Windows 安装或干净机器通过。
