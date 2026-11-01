# 轨道一：音量、选片试听、全局快捷键、波形寻道、滚轮手势与标号对账验收

日期：2026-10-30。对应[前端优化双轨拆解说明书](ui-interaction-split-20261030.md) 的 2.2、2.3、2.4 与 2.5 轨道一全部优化。当前工作区本地实现与 Chrome 自动化验收完成，尚未部署。

## 已实现行为

- 播放器首次播放时建立 Web Audio GainNode，解码声音全部经该节点输出。默认音量为 50%，滑块范围 0–100%，调整采用 15 ms 线性过渡。静音保留原音量；再次点击或按 M 恢复。静音时把滑块调为非零会取消静音。音量与静音在当前页面会话内跨录像保留，不改变导出音轨或导出音量。
- 「试听选片」与 Shift+Space 对当前活动、稳定且未排除的选片生效，不要求勾选纳入导出。从片段起点重新播放，播放头在终点停靠并暂停。音频读取范围与每个已排程音频节点的时长均在终点截断，停止不依赖动画帧是否及时执行。暂停、手动寻道、切换录像与普通播放取消试听限制。连续请求和迟到的解码 / 音频恢复结果由修订号隔离。
- 快捷键统一监听 window，复核页点击空白、列表或按钮后仍可使用 Space、Shift+Space、M、[ / ]、Delete / Backspace、Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z 和左右方向键。方向键移动 0.1 秒，Shift 为 1 秒；播放中先取得暂停时的实际位置，再微调。聚焦裁边手柄时仍调整切点；原片轴内 Escape、Home / End 保持原有行为。
- 输入框、下拉框、音量滑块、可编辑内容、输入法组合事件、弹窗与其他页面不接管快捷键；保留浏览器修饰键组合。长按不反复切换播放 / 静音、连续排除或跨过多个候选。
- 波形点击按当前预测视野换算原片时间，完整与缩放视野均可定位。按用户要求，波形与候选继续叠加在同一条 64 px 时间轴中，不分行。点击候选按钮仍选择或恢复片段；点击候选按钮之外的波形区域直接寻道，不改选片、人工决定或波形证据。
- **时间轴滚轮平滑手势**：时间轴区域（预测轴与原片轴）支持鼠标滚轮与触摸板双指捏合（pinch-to-zoom）以鼠标指针所在时间点为中心平滑缩放视野；支持横向滑动或 Shift+滚轮平移视野窗口（pan），阻止默认页面滚动。
- **列表与时间轴标号完全对账**：候选列表每项首部增加等宽醒目徽章 `[1]`、`[2]`...，与时间轴方块编号严格 1:1 镜像对齐；已排除项徽章显示 `已排除`。
- **主行动按钮（CTA）色彩纠偏**：「提交选片导出」从危险深红色（`#b02a24`）调整为正向高对比度的肯定色（高亮白底黑字、hover 纯白），与破坏性的「重置人工选片」形成明显安全区隔。
- **轻量浮动 Toast 替换硬推挤状态栏**：复核页中的状态提示栏采用 `position: fixed` 右下角浮层展示，自动在 3.5 秒（错误 6 秒）后淡出，消除顶部 `#status` 频繁插入造成的页面垂直累积布局偏移（Zero CLS）。
- 播放与试听按钮保持在一组；窄屏下音量、时间与候选导航有独立换行。已检查 1440 / 768 / 390 px 的实际渲染。

本次继续使用 review-workspace.mjs 保存复核状态，没有改动分析或导出调度状态转换。

## 验证

| 验证 | 结果 |
| --- | --- |
| 全部 Node 测试 | 89 / 89 通过；包含新增的 GainNode 路由、音量记忆、音频终点截断、DOM mock 滚轮兼容及异步竞争用例 |
| verify-review-playback.cjs | 真实 Chrome 中，音量与静音、会话记忆、试听按钮和快捷键、3.1 秒终点停靠、焦点与防滚动、输入保护、全局导航、撤销重做、裁边手柄、全片与局部波形寻道、滚轮缩放、列表徽章对账、CTA肯定色与 fixed 浮层均通过 |
| 原生 Web Audio 增益检查 | 保留实际浏览器音频图，仅观察新建的 GainNode；播放中拖动音量使实际 gain.value 改变，静音为 0，恢复为先前音量，期间保持播放 |
| 已有真实 Apex MP4 | 39,116,353 字节，通过产品文件输入只读导入；完整运行新增浏览器验收，试听、原生音量节点、快捷键、波形定位及三个尺寸全部通过，页面脚本异常为 0 |
| 播放中方向键精度 | 合成媒体与真实录像均等待播放位置领先保存位置至少 80 ms，观察原生 pause() 返回位置；ArrowRight 停靠在该位置加 0.1 秒，而非使用滞后的工作区时间 |
| verify-selection-timeline.cjs | 原有真实解码、寻道、原子裁边、不可变证据、取消拖动、撤销恢复、缩放、真实目录导出与三个宽度回归通过 |
| verify-clip-selection.cjs | ADR 0007 的 DOM / 焦点保留、全不选 / 全选、排除 / 恢复、撤销重做及固定批次导出通过；回读成片 83,094 / 58,175 字节 |
| 1440 / 768 / 390 px | 控件可见，无水平溢出，浏览器页面脚本异常为 0 |
| 语法与空白检查 | app.js / source-player.mjs / selection-timeline.mjs 语法检查与 git diff --check 通过 |

自动验收使用独立 Chrome 上下文，没有操作用户现有标签。默认合成录像为 12 秒、412,623 字节，实际经过浏览器解码、分析和播放，固定候选 2–3.1 秒及 8–10 秒便于精确断言。音频图与调度验证不等于对扬声器、耳机或主观听感的验收。

两种媒体播放中均观察到原生 gain.value 随滑块变为约 0.69，静音后为 0，按 M 恢复为约 0.69。测试保留原生节点和连接，不用假音频节点替代播放器。

截图目录：`/Users/jackliu/.codex/visualizations/2026/10/30/01a18b0e-55b7-7db3-a064-ab54857c0de8/review-playback/single-row/`。`playback-{1440,768,390}.png` 为播放栏与原片轴，`waveform-{1440,768,390}.png` 为波形与候选行；`real-media/` 子目录保存对应的六张真实 Apex 截图。已按单行叠加布局重新运行合成媒体与真实 Apex 两套完整验收：时间轴、波形和候选标记同为 64 px 高且位于同一行，均通过；该目录保存对应的 12 张小型截图。未生成或复制大媒体文件，无外接盘依赖。

## 复跑

```sh
python3 model_web_ui/browser.prototype/serve.py \
  --assets /private/tmp/apex-browser-prototype-20261026/assets \
  --port 18810

node --test model_web_ui/browser.prototype/tests/*.test.mjs

PLAYWRIGHT_MODULE=/private/tmp/apex-public-check/node_modules/playwright \
CHROME_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
REVIEW_URL=http://127.0.0.1:18810/ \
node model_web_ui/browser.prototype/tests/verify-review-playback.cjs
```

另外两个浏览器脚本使用同样的环境变量替换脚本名。18810 是本次从 `/Users/jackliu/apex-fps-mvp/model_web_ui/browser.prototype/serve.py` 启动的独立本地服务；端口和已有资产目录需要在复跑时重新确认。

为新增验收设置 `REVIEW_MEDIA_PATH='/Users/jackliu/.codex/artifacts/apex-fps-mvp/real-combat-sample-20261028/apex-combat-60s.mp4'` 可重复真实录像检查；省略时在浏览器内生成上述小型合成录像。`REVIEW_SCREENSHOT_DIR` 可指定已有的截图输出目录。
