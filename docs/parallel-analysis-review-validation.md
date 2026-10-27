# 并行分析与复核验证记录

2026-10-27（北京时间）。规格见 [并行交互方案](design/parallel-analysis-review.md)。本记录区分已验证能力与仍未通过的场景；不是整个方案完成的声明。

## 环境和证据来源

使用同一份外接盘 MKV，视频时长 2639.45 秒，约 44 分钟；Chrome `156.0.8078.48`，无头模式，真实 WebCodecs 解码与 EfficientAT WASM 推理。原录像没有复制进仓库。旧路径固定在 `86f7ef7c536493282a66265996223dc372293126`，新路径使用本轮集成中的浏览器模块。

以下 JSON 是当时运行脚本产生的原始结果副本，未重写测量数值。旧脚本没有记录新模块的完整提交或内容哈希，不能将这些过程证据视为最终提交的完整验收。新的复现脚本会记录实际 HTTP 返回模块的 SHA-256。

## 已完成的测量与边界

| 场景 | 观测结果 | 支持的结论 |
| --- | --- | --- |
| 旧路径完整分析，两轮 | 212.120、211.397 秒；均为 527 窗口、28 个候选 | 本机、同一原录像的分析基线 |
| 旧路径生成 5 秒片段再显示首画面 | 05:00 首次 2017ms；35:00 首次 2002ms；05:00 再次 1321ms | 对照使用原有片段转换路径，包含对应范围转换等待 |
| 新按需播放器进入 05:00 | 406ms | 单轮进入复核的首画面等待；计时不含此前素材信息探测 |
| 新播放器定位 35:00 / 05:00 / 35:00 | 596 / 429 / 753ms | 这组位置访问均无需先转换整段视频；不能据此推断所有格式、存储或首开情况 |
| 新播放器快速连跳 | 最终 target/position/actual 均为 2100 秒 | 最后目标最终决定画面 |
| 新播放器单独连续播放 10 秒 | 画面持续推进，报告累计最大帧滞后约 8.33ms；暂停后位置保持 | 此短时、单独播放场景通过；不等于整片播放或并发场景通过 |
| 实际 IndexedDB 写入后关闭存储、刷新并恢复 | 裁边、排除、复核位置与提交快照恢复；运行中状态恢复为 interrupted；同名不同内容 ID 不同 | 浏览器真实持久化和恢复路径通过本组场景；不代表浏览器清站点数据后仍可恢复 |
| 合成双音轨真实视频导出 | 请求 3 秒，读回 2.98 秒、64861 字节；第二音轨读回约 440.87Hz；取消未留下新残片 | 提交后的范围和音轨修改未改变已有批次；实际编码、目录流关闭与取消清理通过。目录是测试 OPFS，不是用户选择的外接盘 |
| 分析与播放并发，两轮 | 完整分析 211.188、212.081 秒；均为 527 窗口、28 个候选 | 分析总耗时没有在本组测量中明显增加，但并发播放器存在失败，见下节 |

证据：[旧路径](../model_web_ui/browser.prototype/evidence/grill-baseline-20261027.json)、[按需播放器](../model_web_ui/browser.prototype/evidence/grill-player-20261027.json)、[IndexedDB 恢复](../model_web_ui/browser.prototype/evidence/grill-storage-20261027.json)。[真实画面截图](../model_web_ui/browser.prototype/evidence/grill-player-real-20261027.png)只证明抓取时画面存在，不能证明连续播放。导出证据见 [真实编码与 OPFS 测试](../model_web_ui/browser.prototype/evidence/grill-export-20261027.json)。

## 尚未通过：并发播放画面停滞

[修复前并发报告](../model_web_ui/browser.prototype/evidence/grill-concurrent-before-fix-20261027.json)每轮在分析过程中采样 40 秒播放状态，并在约第 13 和第 26 秒跳转。播放器虽继续报告 `playing` 且没有错误，其 `actual` 画面时间曾停止在 308.833、2104.183、909.133 等位置，播放时钟 `position` 继续前进。

按每秒采样判断，两轮分别有 16、20 个播放状态的画面滞后达到 0.5 秒，最大采样滞后分别约 7.86、8.59 秒；播放器累计指标记录的最大滞后约 8.86、9.59 秒。因此这组证据说明**并发分析完成，但连续播放验收失败**。分析耗时接近基线不能掩盖画面停滞，`error === null` 也不能作为播放通过条件。

此问题需要修复后重新运行相同并发场景，并保存独立的修复后报告。真实声画感知、长时间后台切换、多格式覆盖和完整两页界面操作仍需分别验收。当前不声明“整体等待无回退”或“全部产品规则已完成”。

## 复现脚本

入口：[verify-review-media.cjs](../model_web_ui/browser.prototype/tests/verify-review-media.cjs)。脚本通过一个独立的文件输入取得浏览器 `File`，不触发产品导入按钮，因此接入自动分析的新界面不会意外启动第二条分析流水线。它直接调用公开播放器、分析队列和工作区接口；两页 UI 交互须另行验证。

先在要测的工作区启动静态服务，复用已有模型与运行库。脚本不下载资产，不复制原视频。`player`、`concurrent`、`storage` 写小型 JSON，`player` 可选写一张 PNG；`export` 生成 12 秒双音轨合成样本和约 3 秒测试成片，在内存与唯一临时 OPFS 目录中检查，结束后删除该测试目录。目标报告必须是新文件，已有文件不会被覆盖。

```sh
python3 model_web_ui/browser.prototype/serve.py --assets /absolute/path/to/existing/assets --port 8792
```

在另一终端设置环境后选择一种模式：

```sh
# 指向实际安装的 playwright 包；若 require('playwright') 已可用，可省略。
export PLAYWRIGHT_MODULE=/absolute/path/to/node_modules/playwright
export CHROME_EXECUTABLE=/absolute/path/to/chrome
export REVIEW_BASE_URL=http://127.0.0.1:8792/
export MEDIA_PATH=/absolute/path/to/original-recording.mkv

RESULT_PATH=/absolute/path/to/new-player-report.json \
  SCREENSHOT_PATH=/absolute/path/to/new-player-frame.png \
  node model_web_ui/browser.prototype/tests/verify-review-media.cjs player

RESULT_PATH=/absolute/path/to/new-concurrent-report.json \
  node model_web_ui/browser.prototype/tests/verify-review-media.cjs concurrent

RESULT_PATH=/absolute/path/to/new-storage-report.json \
  node model_web_ui/browser.prototype/tests/verify-review-media.cjs storage

RESULT_PATH=/absolute/path/to/new-export-report.json \
  node model_web_ui/browser.prototype/tests/verify-review-media.cjs export
```

- `player`：首画面、三次定位、快速连跳、10 秒连续播放和暂停。播放时画面必须落后时钟小于 0.5 秒；时钟推进时画面时间不能持续冻结。
- `concurrent`：两次完整分析；每次同时播放采样 40 秒，并在第 13、26 秒跳转。相同帧滞后与冻结检查会将上述旧失败判为失败；失败时也保存已有结果。长录像运行可能需要数分钟，不要与另一个分析性能测试同时运行。
- `storage`：使用小型合成文件身份，在唯一测试数据库中写入决定、位置和批次，刷新后检查恢复；不需要 `MEDIA_PATH`，不会读取原录像。
- `export`：真实 WebCodecs 合成双音轨样本，验证提交范围与声音快照、440Hz 音频读回、目录流写入关闭和取消残片清理；不需要 `MEDIA_PATH`。OPFS 测试只证明 FileSystemDirectoryHandle 写入契约，不能冒充用户已通过目录选择器保存到外接盘。
- 长于 2120 秒的素材使用 05:00、35:00、15:00 定位点；短素材使用其时长的 10%、50%、30%。性能比较必须使用同一原录像和相同运行参数，不能把不同素材结果直接横比。

复现旧路径时，在独立目录恢复基线的静态源文件，并使用另一个端口。模型资产仍复用已有外部目录。以下示例只导出小型静态源码；替换目标路径且不要覆盖已有目录：

```sh
mkdir /absolute/path/to/new-baseline-source
# 在仓库根目录执行：
git archive 86f7ef7c536493282a66265996223dc372293126 \
  model_web_ui/browser.prototype | \
  tar -x -C /absolute/path/to/new-baseline-source
python3 /absolute/path/to/new-baseline-source/model_web_ui/browser.prototype/serve.py \
  --assets /absolute/path/to/existing/assets --port 8793

REVIEW_BASE_URL=http://127.0.0.1:8793/ \
  RESULT_PATH=/absolute/path/to/new-baseline-report.json \
  node model_web_ui/browser.prototype/tests/verify-review-media.cjs legacy-baseline
```

旧基线模式只适用于该版本的 `prototypeApi`，先进行三次片段预览，再做两轮完整分析。每轮固定使用第一条音轨，与现有基线证据一致；与新自动音源策略比较时，必须核实两边实际选择的音轨一致。

## 读取与状态的解释

`decoderPasses: 1` 代表分析使用一个连续解码迭代器，不证明容器解析器或操作系统对每个物理字节只读取一次。上述报告没有分别计数初始化、分析、预览和导出的全部源字节；不从解码次数推导物理 I/O 结论。播放器按需回读与分析扫描是两个任务，音频缓存也未在本组测试中实现或验收。

生成文件、可下载链接、选片已保存与视频已保存到用户目录是不同状态。本组 storage 证据仅确认 IndexedDB 中的工作记录成功写入和恢复；export 证据另行确认临时 OPFS 测试目录中的视频流成功关闭并读回。测试没有覆盖用户选择的外接目录或最终文件长期留存。
