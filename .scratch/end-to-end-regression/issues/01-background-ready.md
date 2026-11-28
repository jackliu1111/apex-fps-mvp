# 01 · 后台分析完成时保留前台暂停与播放

**What to build:** 分别在 B 暂停和播放时放行 A 的分析结果，验证随后操作的录像归属。

**设计分支**　B1、B2 · [端到端回归测试设计](../../../docs/design/end-to-end-regression.md)

**Blocked by:** None (can start immediately)

**执行条件**　A、B 画面带有独立源标识和帧号，A 首段从 1 秒开始，B 首段从 4 秒开始。可控制 A 的分析结果交付。

**Status:** done

## 验收标准

- [x] B 第二段暂停在 8.5 秒时放行 A。A 行显示就绪且有 3 段，B 仍选中第二段，暂停帧保留，意外重载 0 次。
- [x] 点一次「上一个」后选中 B 第一段，画面时间与 4 秒相差最多一个素材帧周期。
- [x] 另一起始状态中，B 的画面已连续播放才放行 A。事件前后均看到 B 的递增帧，无回跳或暂停，点击暂停后停住 B。两条用例可独立运行。

## 验证记录

本地 Chrome（macOS），产品基线 bcb9374，服务从本票工作树启动。分别运行
`node model_web_ui/browser.prototype/tests/verify-foreground-ready.cjs paused` 和
`node model_web_ui/browser.prototype/tests/verify-foreground-ready.cjs playing` 均通过。
两份 12 秒、12 fps 的 VP8 视频逐帧烧录源和帧号。测试在分析队列的分析结果生产者处挂起 A，放行固定三段后由正式队列交付结果。
暂停分支保留 B 的 8.5 秒帧，上一段显示 B 第 48 帧。播放分支跨越放行点显示 B 第 97–102 帧，暂停后仍为 102。两次加载请求均为 0。

审查后在 62cc6d7 基线的修复 worktree、端口 9262、Chrome 158.0.8127.37 复跑两种模式。暂停于 B 帧 102，放行后未重载，点击上一段到帧 48。播放时帧 97–99 后放行，帧 100–102 后用户点击暂停，随后连续观察三个素材帧周期，画面保持不变。日志按序包含 A 等待、放行、交付、就绪、点击、显示帧及所选录像。临时负对照在一次微任务内将播放状态改为 false 再恢复 true，断言按预期失败。
