# 12 · 取消离开后继续复核并在刷新后复读成片

**What to build:** 覆盖真实离开对话框的取消路径和刷新后重新从目录读回成片。

**设计分支**　L1、L2、L3 · [端到端回归测试设计](../../../docs/design/end-to-end-regression.md)

**Blocked by:** None (can start immediately)

**执行条件**　有真实用户手势的浏览器会话、可重新打开的测试目录。

**Status:** completed

## 验收标准

- [x] 有未导出人工修改时刷新，取消真实离开提示，再次操作按钮，仍作用于原录像、原片段。
- [x] 所有成片已保存且无待处理工作时刷新，不出现离开提示，刷新后重新取得目录中的文件并验证可读。
- [x] 接受刷新后复用已有会话清空及监听权限恢复断言；磁盘读取发生在新会话中。

## 本地验证

基线 `c76b16d`，`node model_web_ui/browser.prototype/tests/verify-session-lifecycle.cjs` 在端口 9222、macOS Chrome 158.0.8127.37 通过。文件框导入 apex-combat-60s.mp4，真实模型就绪后由用户按钮创建 5 秒人工片段。取消真实 beforeunload 对话框后，连续两次按钮操作分别取消、恢复同一录像及片段的导出勾选。提交并保存后无对话框刷新，重新获取 OPFS 目录和成片，读取全部 11985337 字节，刷新前后 SHA-256 均为 `94a5f97b474e215ac7355f3fa643b6eeb96e78cf4e16e33aae644606a0af872b`。重新导入并产生人工决定，接受离开提示后验证录像、批次清空，监听目录恢复 watching，成片仍可按同一摘要读回。系统目录选择器由 OPFS 句柄替代。
