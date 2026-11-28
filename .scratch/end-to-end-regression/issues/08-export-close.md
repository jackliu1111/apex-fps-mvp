# 08 · 文件关闭成功后导出面板才报保存

**What to build:** 将正式导出面板、写入流关闭结果和成片读回关联到同一个文件。

**设计分支**　E2 · [端到端回归测试设计](../../../docs/design/end-to-end-regression.md)

**Blocked by:** None (can start immediately)

**执行条件**　可控制关闭返回的写入流、可读回的浏览器目录，以及已知范围和帧率的素材。

**Status:** completed

## 验收标准

- [x] 从产品页提交一个片段，挂起关闭操作，面板已保存数保持 0，等待期间没有提前发布已保存。
- [x] 放行关闭成功，面板显示已保存 1 个；重新打开该输出并解码，片长与提交范围之差在输出格式的帧精度内。

## 本地验证

基线 `05358c9`，macOS Chrome、OPFS、12 fps VP8/Opus。以本票 worktree 的 serve.py 在端口 18908 启动，运行 `REVIEW_URL=http://127.0.0.1:18908 node model_web_ui/browser.prototype/tests/verify-directory-export.cjs`（PLAYWRIGHT_MODULE 指向 playwright-core，CHROME_EXECUTABLE 指向本机 Chrome）。首次真实 close 已到达等待点，期间面板完成 0/1、输出 0，观察期间未发布完成 1/1。放行后完成 1/1、目录文件名与面板一致；重新取得文件，解码 0.25 秒处的 640 像素宽视频帧。提交 0–0.5 秒，读回 0.48 秒，误差小于一帧。整个专项退出 0。

审查后在 62cc6d7 基线的修复 worktree、端口 9262、Chrome 158.0.8127.37 复跑通过。覆盖真实 close Promise 成功返回前的微任务及未交付的 DOM mutation records；已完成 1/1 与输出行都首次出现在返回后。再次读回片长 0.48 秒、帧宽 640。临时负对照在放行后、真实 close 前瞬时发布 1/1 再撤回，测试捕获 closeFulfilled=false 并按预期失败。
