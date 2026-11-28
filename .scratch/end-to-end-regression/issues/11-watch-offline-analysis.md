# 11 · 监听录像遵守自动离线分析开关

**What to build:** 串联文件从写入到完成、侧栏接入以及离线队列的开关行为。

**设计分支**　W2、W3 · [端到端回归测试设计](../../../docs/design/end-to-end-regression.md)

**Blocked by:** None (can start immediately)

**执行条件**　可分阶段写入的浏览器目录，保留历史文件；新录像无实时覆盖。

**Status:** completed

## 验收标准

- [x] 关闭自动离线分析时，录像未写完不入库，写完只出现一行未分析；通过页面手动开始后才分析。
- [x] 开启时重新接入一份新录像，重复扫描也只入队一次，最终就绪。两种设置均不重新接入历史文件。

## 本地验证

基线 `c76b16d`，在端口 9221 运行 `node model_web_ui/browser.prototype/tests/verify-watch-offline.cjs`，macOS Chrome 158.0.8127.37，两种开关设置均通过。分别在独立浏览器目录写入历史 3 秒 WebM，并让新文件经历 16 字节的未完成容器、6 秒的完整 WebM。未完成时扫描四轮，记录仍未入库；关闭开关后从「未分析」按钮启动；开启后暂停队列观察到「排队」，再恢复真实模型。多次扫描后每个目录只接入一次，两次实验中队列均只有一条 arrival.webm 的 complete 记录。
