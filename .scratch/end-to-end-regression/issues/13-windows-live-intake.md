# 13 · Windows Edge 与 OBS 验收实时覆盖和离线兜底

**What to build:** 用真实停录录像检查实时覆盖和未覆盖文件各自的接入路径。

**设计分支**　W4 · [端到端回归测试设计](../../../docs/design/end-to-end-regression.md)

**Blocked by:** None (can start immediately)

**执行条件**　实机验收。可交互 Windows 桌面、Edge、OBS、系统音频共享及可写监听目录。

**Status:** ready-for-agent

## 验收标准

- [ ] 同轮开启实时分析和自动离线分析，取得一份有实时覆盖、一份无覆盖的新停录录像。
- [ ] 匹配录像复用实时分析结果，整片离线分析启动 0 次；无覆盖录像只进入离线队列一次。逐一核对录像行、结果归属和最终状态。
- [ ] 记录 Edge 与项目版本、录制和停录顺序、文件及分析路径的可核查证据。
