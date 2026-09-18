# 寻血猎犬单色图标

## 当前版本：第二版

根据原角色模型重新设计了中央扇形饰冠、下压的宽头盔、圆形护目镜、机械呼吸面罩和右侧呼吸管。

- `bloodhound-v2.svg`：真正的矢量路径，50 × 50 默认尺寸，透明底，`currentColor` 单色填充。
- `bloodhound-v2-50-black.png` / `bloodhound-v2-50-white.png`：50 × 50 透明底图标。
- `bloodhound-v2-100-black.png` / `bloodhound-v2-100-white.png`：100 × 100，可用于 50 CSS px 的高像素密度屏幕。
- `bloodhound-v2-512-black.png` / `bloodhound-v2-512-white.png`：512 × 512 透明底大图。
- `preview-v2.html` / `preview-v2.png`：放大轮廓及 50 px 原尺寸的深浅背景、强调色预览。
- `bloodhound-v2-master.png`：imagegen 生成的白底设计母图，仅作设计来源，使用时优先选择透明底 SVG/PNG。
- `PROMPTS-v2.md`：内置 imagegen 的两轮完整提示词、参考来源和矢量化说明。

已检查浏览器预览，并确认六个导出 PNG 的尺寸、RGBA 透明通道和单色像素正确。图标保留了较多角色特征，较小的装饰在 50 px 下会合并；需要更清楚的展示可使用 64–100 px，或在界面中直接嵌入 SVG。

## 第一版（保留对照）

- `bloodhound-mark.svg`：50 × 50，透明底，单色填充；内联 SVG 时可用 CSS `color` 换色。
- `bloodhound-50-black.png` / `bloodhound-50-white.png`：50 × 50 透明底 PNG，分别为纯黑与纯白，边缘保留抗锯齿。
- `preview.html`：放大形态、50 px 实际尺寸，以及深浅背景和项目强调色的组合预览。
- `preview.png`：1000 × 760 的组合预览图片。
- 标语提案：**锁定高光，一帧不漏。**

这是按寻血猎犬形象简化绘制的角色主题概念稿。外形参考：[J Hill 的角色模型展示](https://x.com/artofjhill/status/1103773180479459328)。

在网页中与产品名并列时，图标使用 `alt=""`（内联 SVG 使用 `aria-hidden="true"`）；独立作为有意义的图像时提供名称。导入外部 SVG 的 `<img>` 不继承父元素的 `color`，换色可用内联 SVG 或 CSS mask。

打开 `preview.html` 可查看布局；若本地浏览器限制文件形式的 CSS mask，在本目录启动静态 HTTP 服务再访问。

已在浏览器中检查桌面预览，并校验两个 PNG 的尺寸、透明背景和单色像素。
