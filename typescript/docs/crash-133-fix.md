# 关键帧分析退出 133：管道积压修复

2026-09-17，本机 macOS ARM64。

## 根因与证据

FFmpeg 生产 4K RGB 帧快于 HUD 定位、PaddleOCR 和 PNG 留档。原 `Bun.spawn(..., stdout: "pipe")` 在异步消费者等待时继续积压输出。积压数据交给 JavaScript 时，会形成数 GB 的单个 ArrayBuffer，触发运行时断言和 SIGTRAP（退出码 133）。这不是视频某一帧必然损坏，也不是普通的 OCR 识别异常。

使用 Bun 1.3.12 官方 profile 包的 DWARF 符号还原本机崩溃堆栈，崩溃附近机器码与正在运行的二进制一致：

```text
JSC::ArrayBuffer::createFromBytes              ArrayBuffer.cpp:263
Bun__makeTypedArrayWithBytesNoCopy             ZigGlobalObject.cpp:1289
ArrayBuffer.toJSUnchecked                     array_buffer.zig:240
ArrayBuffer.toJS                              array_buffer.zig:281
FileInternalReadableStreamSourcePrototype__drainFromJS
```

- 原录像在 Bun 1.3.12 和 1.3.13 上均复现 133，此次都在第 76 帧之后。
- 禁用 FTL JIT 后仍复现 133；不采用禁用 JIT 的绕行方案。
- 不含 OCR 的最小复现：350 张 3840×2160 RGB 帧，共 8,709,120,000 字节，消费者每次等待 6 秒，原通道退出 133。
- 150 帧版本可完成，但曾一次交出 3,731,988,480 字节的数据块。
- 普通 `node:child_process` 管道在同一 Bun 上也无法解决：慢消费者测试收到约 132 MB 的单个数据块。

## 修复

`streamVideoWindow`、`streamVideoFrames` 改为让 FFmpeg 将 RGB 输出写入临时的 `127.0.0.1` TCP 接收端。接收端使用可暂停的 Socket，异步识别尚未完成时，通过 TCP 背压使 FFmpeg 等待。录像、原始像素和 OCR 均不离开本机；没有降低分辨率、改抽帧策略或跳过未知帧。

其他媒体命令仍保留原 stdout 接口。连接端口由系统分配；接入一个解码器后关闭监听，完成、取消和异常路径销毁连接。新增错误日志保留 `worker.stderr.log`，异常退出信息包含信号、退出码和 Bun 版本；任务启动日志记录运行环境。

## 验证

- 类型检查和网页构建通过。
- 52 项测试通过，1000 个断言；包含新增慢消费者限流、缺失可执行文件测试，以及已有 CFR/VFR 时间戳、逐像素一致性、取消和进程清理测试。
- 新通道完整传输同样的 8,709,120,000 字节：退出 0；最大数据块 2,047,948 字节，测试进程峰值 RSS 189,792,256 字节（约 181 MiB）。此内存数字属于合成传输测试，不代表完整 OCR 分析的内存峰值。
- 原录像 `2026-09-11 20-32-49.mkv`（3840×2160，1293.95 秒）完整复测退出 0：333 个关键帧、175 帧可读、13 个增长窗口、9 个候选片段；耗时 329.33 秒，FFmpeg 仅启动一次。处理 8,286,105,600 字节 RGB，没有降低抽帧覆盖。
- 首个候选区间（480.154–496.488 秒）通过原有 `exportSelections` 成功导出为 MP4，导出证据位于 `export-check/`。
- 成功结果新增至本机任务 `0c6a118a-2d46-414a-aa3a-410003364e13`，浏览器已打开该任务的检查与选片页面；原失败记录保留。

本次只验证了 macOS ARM64；未据此声称 Windows 实机通过。

本机证据：`typescript/work/crash-133-20260917/` 下的 `symbolicated-stack.txt`、`pipe-eager-overflow.log`、`pipe-bounded-result.json`、`tests-fixed.log` 和 `bounded.stdout.log`。调试文件不随发布包分发。
