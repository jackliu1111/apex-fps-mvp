# 后台标签页目录发现与原片升格验证记录（Ticket #62）

日期：2026-11-26。对应 [ADR 0009](../adr/0009-recording-library-auto-intake.md)（待验证项 1、2）、[ADR 0010](../adr/0010-split-library-review-workspace.md)（决策 5）与 Ticket #62。

## 浏览器后台限速行为分析

玩家在全屏游玩 Apex Legends 时，本地选片工作区标签页处于 `document.visibilityState === 'hidden'`。桌面 Chromium（Chrome / Edge）对后台标签页的定时轮询施加两级限速：

1. **短后台阶段（< 5 分钟）**：`setInterval` 被限频至最低 1 秒；若目录监听依赖默认的 2 秒间隔 + 连续 2 次无变化确认，普通情况下约 4–6 秒可确认落盘。
2. **深度后台 / 密集定时限速阶段（≥ 5 分钟，无音频播放/采集时）**：Chromium Intensive Wake Up Throttling 可将 `setInterval` 限频至每分钟 1 次。仅依赖固定轮询次数（`stablePollsRequired = 2`）时，文件首次发现后还需额外等待 1–2 个完整的 60 秒后台周期（最坏 120–180 秒）才能进入容器探针与原片升格。
3. **只读目录权限恢复边界**：刷新或重启浏览器后，File System Access API 的 `FileSystemDirectoryHandle` 可保存在独立 IndexedDB（`apex-watch-dir-v1`）中，但浏览器策略可能将 `queryPermission({ mode: 'read' })` 返回为 `'granted'`（同浏览器会话/已记住站点授权）或 `'prompt'`（重启后需要用户手势重新确认）。

## 缓解与实现设计

1. **三层后台目录发现与稳定性探测**
   - **音频线程心跳驱动（`site/workspace-engine-bridge.mjs`）**：开启「对局监听」期间，`AudioWorkletProcessor` 运行在不受后台标签页定时器限速影响的独立音频线程中，约每 100 ms 上报能量包络帧。`workspace-engine-bridge.mjs` 按 `heartbeatPollIntervalMs`（默认 2000 ms）节流，在收到新包络帧且已开启录像监听目录时自动触发 `autoIntake.pollNow()`；同时 Chrome 对正在采集音频的页面也会豁免深度休眠，使对局期间的目录发现完全不受 60 秒后台限速影响。
   - **墙钟稳定时长兜底（`site/directory-watcher.mjs`、`site/auto-intake-service.mjs`）**：为 `createDirectoryWatcher` 新增向后兼容的 `stableDurationMs` 参数（默认 `pollIntervalMs * stablePollsRequired`，即 4000 ms），并在发现、文件增长、`pendingFinalization`（OBS MKV/MP4 未写尾）或大小复核变化时重置 `stableSince`。当后台定时器被拉长（例如间隔 15–60 秒）且文件在相邻两次扫描间大小与 `lastModified` 均未变化、持续时间 `>= stableDurationMs` 时，第二次扫描即可直接进入 `probing` → `ready`，省去额外 1 个完整后台限速周期；若文件仍在写入增长，则继续安全等待。
   - **切回前台即时轮询（`site/background-readiness-controller.mjs`、`site/app.js`）**：监听 `document` 的 `visibilitychange` 事件，标签页切回 `'visible'` 时立即触发一次 `engineBridge.pollWatchDirectory()`，避免等待下一次定时轮询。

2. **句柄持久化与一次点击恢复（`site/watch-dir-store.mjs`、`site/global-topbar-controls.mjs`）**
   - 使用独立 IndexedDB `apex-watch-dir-v1`（对象库 `handles`，键 `watch-directory`）仅保存只读录像监听目录句柄，绝不读写历史 `apex-review-v1`，也不持久化会话原录像或导出批次。
   - 页面启动时调用 `queryPermission({ mode: 'read' })`：`'granted'` 时零点击静默恢复目录监听；`'prompt'` 时在全局顶栏显示「恢复监听 / Restore Watch」一次点击恢复入口（同时保持 `1440..851px` 顶栏 54 px 单行不换行、无水平溢出）。

3. **后台静默提示与切回切换规则（`site/ready-notifier.mjs`、`site/background-readiness-controller.mjs`）**
   - 新录像就绪（`ready` 或 `conformed-coarse`）时，不抢占窗口焦点，更新标签页标题计数 `(N) <原标题>`、动态 SVG 图标角标，并仅在用户显式勾选顶栏弹出层内的静默系统通知开关后才请求权限并发送 `silent: true` 的浏览器系统通知。
   - 后台期间就绪的录像在玩家切回页面（`visibilitychange -> 'visible'`）时，右侧自动切到最新就绪录像并定位到首个可复核候选，清空其「新」标记与未读计数，且完整保留前一份录像的人工复核决定（ADR 0004）。
   - 玩家停留在页面前台时，新就绪录像不切换右侧当前录像，在录像库栏保持「新」标记，并在右上角弹出非阻塞可点击轻提示 `#ready-toast`（「立即查看 / Open now」直达首个候选，或手动关闭）。

## 自动化验证记录

| 验证项 | 执行方式 | 结果 |
| --- | --- | --- |
| 句柄持久化、独立 DB 隔离、静默恢复与一次点击恢复 | `model_web_ui/browser.prototype/tests/background-readiness.test.mjs`（Slice 1） | 通过（隔离 `apex-watch-dir-v1`，缺省/受阻 IndexedDB 安全降级，`'granted'` 零点击恢复，`'prompt'` 一次点击恢复与拒绝重试） |
| 标题 `(N)`、动态 SVG 图标角标与可选静默系统通知 | `background-readiness.test.mjs`（Slice 2） | 通过（不自动弹权限请求、不调用 `window.focus()`、语言切换同步标题、已读后恢复原标题与原图标） |
| 后台切回切换至最新就绪录像首候选 vs 前台不打断 + 轻提示直达 | `background-readiness.test.mjs`（Slice 3 & Slice 5 E2E） | 通过（验证 ADR 0004 保留前录像人工裁边/排除/手动选片；验证 0 候选录像安全切换；验证前台不打断与点击轻提示直达） |
| 后台限速下的墙钟稳定兜底与 AudioWorklet 心跳发现 | `background-readiness.test.mjs`（Slice 4） | 通过（模拟 15 s 后台定时限速下第二次扫描直接探针就绪、增长中文件不提前探针；模拟 10 分钟定时冻结下由 AudioWorklet 包络帧按 2 s 节流稳定驱动轮询） |
| 顶栏恢复入口与全量单元回归 | `node --test model_web_ui/browser.prototype/tests/*.test.mjs` | 全量通过（含 `directory-watcher.test.mjs`、`auto-intake-service.test.mjs`、`single-workspace-e2e.test.mjs`、`split-workspace.test.mjs`、`workspace-ux.test.mjs` 等全部用例） |
| 真实 Chrome 浏览器端到端脚本 | `model_web_ui/browser.prototype/tests/verify-background-readiness.cjs` | 已编写并通过 `node --check` 语法校验；当前受限沙箱环境无法绑定本地测试端口，需在宿主机终端按下方命令运行真实 Chrome 验收（包含真实双标签页后台 `visibilityState === 'hidden'`、真实 OPFS 目录句柄持久化重载自动恢复与 `1440..851px` 54 px 顶栏校验） |

## 宿主机 Chrome 复跑命令

```sh
# 1. 全量 Node 单元测试
node --test model_web_ui/browser.prototype/tests/*.test.mjs

# 2. 启动本地静态服务后运行 Playwright 真实 Chrome 验证
python3 model_web_ui/browser.prototype/serve.py --port 18762 &
SERVER_PID=$!
PLAYWRIGHT_MODULE=/Users/jackliu/apex-fps-mvp/node_modules/playwright-core \
CHROME_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
REVIEW_URL=http://127.0.0.1:18762/ \
node model_web_ui/browser.prototype/tests/verify-background-readiness.cjs
kill $SERVER_PID
```
