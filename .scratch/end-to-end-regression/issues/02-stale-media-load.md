# 02 · 旧录像晚加载完成时保留新录像

**What to build:** 验证先打开 A 再打开 B 时，A 的过期加载结果不能接管显示或按钮。

**设计分支**　B3 · [端到端回归测试设计](../../../docs/design/end-to-end-regression.md)

**Blocked by:** None (can start immediately)

**执行条件**　两份具备不同帧标识的媒体，可单独挂起 A 的加载完成回调。

**Status:** ready-for-agent

## 验收标准

- [ ] 记录 A 已开始加载并被挂起；点击 B，观察到 B 首帧后才放行 A。
- [ ] 放行后列表保持选中 B，显示过的 A 错帧和意外重载次数均为 0。选择 B 第二段并播放，显示 B 的对应画面。
- [ ] 失败证据包含 A、B 请求的发起、完成顺序、源标识和显示帧。
