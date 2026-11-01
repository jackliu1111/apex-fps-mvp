# ADR 0006 本地实现验证

日期：2026-10-30。工作区：`/Users/jackliu/apex-fps-mvp`。未提交、未部署。

## 实现范围

- 视频成片只有目录保存路径，首次选目录，当前页面后续批次沿用。没有完整成片 Blob、视频下载链接或下载缓存淘汰。
- 未取得目录、权限拒绝、目录不可访问时保留批次，用户点击重新选择后继续未完成片段。来源、范围、声音、格式保持提交快照；逐文件记录实际保存目录。
- 写入流关闭成功即已保存；取消等待关闭结果，保留成果。保存后的读回或编码收尾错误独立呈现。
- 未完成文件尝试删除；失败时同时保留原始错误、清理错误和遗留位置。重试成功不抹掉历次清理警告。
- 256 KiB 分块，待写编码数据限 64 MiB；此限制不是浏览器全进程内存保证。最多 128 项磁盘复用索引的淘汰不删除文件。
- 仅等待目录、排队、运行中的导出触发离页保护；未提交人工选片仍独立保护。

## TDD 与自动化证据

公开测试边界已由用户确认：导出器、队列、浏览器操作。每轮行为修复先观察对应失败，再做最小实现。

主要失败→通过证据包括：小片段未选目录、队列接受未保存结果、权限失效恢复、目录查询异常/取消竞态、关闭成功时取消、保存后读回/编码收尾失败、写入缓冲溢出、清理失败覆盖原错误、跨重试丢失清理位置、终态批次误触发离页提示、保存文案及清理警告不显示。

真实浏览器还复现了固定版本 Mediabunny 不等待部分 `writer.write()` Promise 导致额外未处理异常。当前仅在单次导出的 stream writer 上观察拒绝，保留原 Promise 的失败语义；未改 vendor 或全局对象。`verify-directory-errors.cjs` 验证调用方仍收到错误、半成品被清理且页面无未处理异常。

最终完整 Node 回归：80 项通过、0 项失败；其中导出器 17 项、导出队列 15 项。`git diff --check` 通过。

Node 回归命令：

```sh
node --test model_web_ui/browser.prototype/tests/*.test.mjs
```

浏览器验证使用已有 Chrome/Playwright，单独启动当前 checkout 的 `serve.py`，地址为 `http://127.0.0.1:18806`；原 18796 端口实际服务另一个工作区，未作为本轮证据。

```sh
PLAYWRIGHT_MODULE=/private/tmp/apex-public-check/node_modules/playwright \
CHROME_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
REVIEW_URL=http://127.0.0.1:18806 \
node model_web_ui/browser.prototype/tests/verify-directory-export.cjs
```

同样环境运行 `verify-directory-errors.cjs`、`verify-source-export.cjs`、`verify-session-lifecycle.cjs`。现有 `verify-review-media.cjs` 的 export 模式也已迁移目录保存并通过。

## 实际媒体读回

| 输入 | 输出与结果 |
| --- | --- |
| 3840×2160 / 60 fps 合成样本 | MP4 / H.264 + AAC，57 帧，130799 字节；尺寸、帧数与时间戳通过 |
| 1920×1080 / 29.97 fps 合成样本 | MP4 / H.264 + AAC，29 帧，25948 字节；时间戳通过 |
| 640×360 可变帧率样本 | MP4 / H.264 + AAC，26 帧，7467 字节；时间戳通过 |
| 真实战斗录像的 5 秒片段 | 11933898 字节；保存、读回、离页保护及刷新会话清空通过 |

## 原生目录与真实磁盘验收

2026-10-30 在这台 Mac 的 Chrome 无痕窗口完成。实际页面记录 UA 为 `Chrome/156.0.0.0`；运行地址为 `http://127.0.0.1:18807`，服务当前 checkout。通过原生 macOS 目录窗口及 Chrome 的「允许此网站修改文件」提示操作，没有替换 `showDirectoryPicker()`、权限结果或磁盘写入。浏览器的原生界面由 CUA 操作，磁盘文件由独立进程用 SHA-256 和 ffprobe 复核。

独立验收页复用生产 `createBrowserConverter` / `createExportQueue`，仅包装目录句柄以暂停某一步，稳定控制取消与权限撤销的时机。暂停点是首块原生写入前、调用原生 close 前、原生 close 成功后返回前，以及第二段查询权限前；这些暂停不模拟操作成功或失败。短小合成源为 460386 字节，三段范围分别是 0–2、3–5、6–8 秒。

| 场景 | 原生操作及实际结果 |
| --- | --- |
| 首次选择目录时取消 | 系统窗口取消，真实 `AbortError`，没有取得目录或生成文件 |
| 正常保存三段 | 原生选择并授权 Directory-A；三段逐一关闭成功，磁盘存在三个有效 WebM |
| 写入阶段取消 | 首块写入暂停时取消；原生 abort / remove 成功，没有遗留半成品，后两段未开始；释放暂停点也不会重新写入 |
| 关闭流程中取消 | 已进入关闭流程后取消，界面等待关闭结果；释放暂停后真实 close 成功，最终为已保存，通知序列未提前发布 cancelled |
| 原生关闭成功后取消 | 文件已真实关闭，延迟返回期间取消；最终仍保存该文件，独立媒体检查通过 |
| 片段之间撤销授权 | 第一段保存 A 后，通过 Chrome 地址栏「此页面可修改文件 → 撤消访问权限」撤销；真实查询返回 `prompt`，队列进入 `awaiting-destination`，保留第一段，后两段不开始 |
| 恢复时取消目录窗口 | 继续保持等待目录，已保存成果和剩余片段不变 |
| 恢复时拒绝目录授权 | 选择 B 后在 Chrome 提示中点「不允许」，选择器返回 `AbortError`，继续等待，没有新增写入 |
| 重新选择 B 并允许 | 只将剩余两段保存到 B，第一段仍在 A，没有重复导出；第一段恢复前后 SHA-256 相同 |

保留成果的 SHA-256 为 `7eac279c71716f684d44a94e7da33dc125700fff872e4379650b4d15f234fd0c`。验收页共生成 8 个 WebM、456710 字节；全部可由 ffprobe 读回为 VP8 + Opus，容器时长均为 2.000 秒。Mediabunny 已完成的浏览器读回检查报告 1.980 秒；两种时长口径分别记录，未将它们当成相同数值。关闭期间取消的文件跳过浏览器附加检查，但独立 ffprobe 仍验证成功。

正式产品页也另跑了完整操作：通过原生文件窗口导入一份上述 WebM，添加约 1.917 秒人工选片，采用默认 MP4；首次提交时取消目录窗口，页面显示「等待输出目录」且保留批次；选择 A 授权后已保存。随后真实撤销 Chrome 目录权限，再提交一批，页面显示权限不可用并等待；点击「选择目录并继续」，选择 B 授权后保存成功。最终页面显示两个已保存批次，分别记录 A、B，后续默认目录为 B。这一条产品路径没有注入暂停点。两个实际 MP4 均为 75654 字节、H.264 + AAC，ffprobe 容器时长均为 1.984 秒。

独立核验 **36 项全部通过**。结构化报告、逐文件大小/编码/时长/哈希与保存目录见[原生验收报告](evidence/adr6-native-directory-20261030.json)；原始队列事件见[最终快照](evidence/adr6-native-directory-20261030/native-state.json)、[撤销授权后的快照](evidence/adr6-native-directory-20261030/permission-revoked-state.json)及[恢复前文件哈希](evidence/adr6-native-directory-20261030/saved-before-reselection.json)。产品页的原生操作与最终画面由本轮 CUA 观察；结构化报告对这两个产品 MP4 独立验证磁盘结果，没有将它们混入验收页的事件日志。

实际媒体保留于 `/private/tmp/adr6-native-20261030/Directory-A`（7 个、418603 字节）和 `/private/tmp/adr6-native-20261030/Directory-B`（3 个、189415 字节），共 **10 个、608018 字节**。这些是小型测试文件，不需要外接卷；临时目录可能被系统清理，仓库中的小型证据独立保留。新增工具语法检查及最终 `git diff --check` 通过；本轮复跑完整 Node 回归仍为 **80 / 80 通过**。本轮为验收补全，没有新增生产代码修复。

### 重跑原生验收

每次使用新的两个空目录；下例中的 `NEW-RUN` 须改成新的运行名称，端口须未占用。资产使用本机已有目录，不下载新模型。

```sh
mkdir -p /private/tmp/adr6-native-NEW-RUN/Directory-A /private/tmp/adr6-native-NEW-RUN/Directory-B
PYTHONDONTWRITEBYTECODE=1 python3 model_web_ui/browser.prototype/tests/serve-native-directory.py \
  --assets /private/tmp/apex-browser-prototype-20261026/assets \
  --evidence /private/tmp/adr6-native-NEW-RUN/native-state.json \
  --port 18807
```

打开 `http://127.0.0.1:18807/tests/native-directory-acceptance.html`。生成小样本后先取消一次选择，再选 A 并授权；依次运行正常三段、首块写入暂停、关闭前暂停、关闭后暂停和第二段权限检查暂停。三个取消用例在暂停时点「取消当前批次」，随后释放暂停点；权限用例在暂停时从 Chrome 地址栏撤销目录授权，再释放，确认等待。先取消重新选择，再选择 B 拒绝授权，最后重新选择 B 并允许；点击检查已保存文件及保存证据。原生系统窗口必须实际交互，不能用 OPFS 替代这一轮验收。

正式产品路径打开同源根页面 `/`，通过原生窗口导入一个短媒体、添加人工选片并提交，依次重复取消目录、授权 A、撤销授权后再次提交、选择 B 恢复。独立检查磁盘文件的数量、格式和哈希，同时确认页面逐批次显示原保存位置。

## 证据边界

前一节 4K60、29.97fps、可变帧率和真实录像的自动化测试使用 OPFS，系统目录选择器由测试替代；本次追加的原生验收使用用户可见磁盘目录和真实权限提示，两类证据分别保留。权限失效验证的是 Chrome 撤销目录授权后返回 `prompt`，没有修改操作系统 ACL 或拔掉外接卷。Edge、外接卷拔插、大文件、长时吞吐、逐帧画质及移动端仍未验收。测试媒体均低于用户的大文件阈值，无新增模型下载或大型产物，尚未提交或部署。
