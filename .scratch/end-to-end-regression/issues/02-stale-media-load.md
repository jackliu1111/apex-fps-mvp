# 02 · 旧录像晚加载完成时保留新录像

**What to build:** 验证先打开 A 再打开 B 时，A 的过期加载结果不能接管显示或按钮。

**设计分支**　B3 · [端到端回归测试设计](../../../docs/design/end-to-end-regression.md)

**Blocked by:** None (can start immediately)

**执行条件**　两份具备不同帧标识的媒体，可单独挂起 A 的加载完成回调。

**Status:** done

## 验收标准

- [x] 记录 A 已开始加载并被挂起；点击 B，观察到 B 首帧后才放行 A。
- [x] 放行后列表保持选中 B，显示过的 A 错帧和意外重载次数均为 0。选择 B 第二段并播放，显示 B 的对应画面。
- [x] 失败证据包含 A、B 请求的发起、完成顺序、源标识和显示帧。

## 验证记录

- 基线 `bcb9374`，共用 01 的 A/B 12 秒、12 fps 带帧号素材。macOS Chrome 158.0.8127.37；02 工作树本地端口 18902。
- 运行 `node model_web_ui/browser.prototype/tests/verify-stale-media-load.cjs`。A 媒体解码能力检查完成后挂起返回值 → 请求 B → 显示 B 帧 0 → B 加载完成 → 放行 A → A 加载完成。全程仅两次请求，B 首帧后 A 错帧与列表丢选均为 0。
- 点击 B 第二段并播放，画面依次解码 B 96、97、98，选中 `auto:second`。临时移除加载版本守卫后同一测试无法显示第二段的 B 帧 96；恢复守卫后重跑通过。
