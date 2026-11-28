# 10 · 监听权限拒绝、恢复与目录基线

**What to build:** 刷新后从拒绝授权走到成功恢复，核对侧栏、实时分析开关和恢复后的目录发现。

**设计分支**　W1 · [端到端回归测试设计](../../../docs/design/end-to-end-regression.md)

**Blocked by:** None (can start immediately)

**执行条件**　可控制授权结果的浏览器目录，目录中已有一份历史文件。原生权限按实际浏览器另记。

**Status:** done

## 验收标准

- [x] 刷新进入需恢复状态，第一次拒绝后仍提示恢复，实时分析不可开启。
- [x] 通过恢复按钮授权成功后显示监听中，历史文件没有作为新录像接入，新落盘文件正常接入。

## 本地验证

在本票 worktree 的产品页执行 `node model_web_ui/browser.prototype/tests/verify-watch-permission.cjs`，macOS Chrome 158.0.8127.37，端口 9210，通过。侧栏选择含 3 秒历史 WebM 的 OPFS 目录；刷新后从 IndexedDB 取回句柄，控制浏览器权限先拒绝再允许，两次请求均为 read。拒绝后恢复入口可用、实时按钮禁用；恢复后写入 4 秒 WebM，侧栏仅出现 arrival.webm 一行。系统原生授权框未参与此专项。
