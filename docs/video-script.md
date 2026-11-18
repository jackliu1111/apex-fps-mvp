# Apex Local Cut 演示视频录制说明

2026-11-18 更新：演示以当前正式界面录制，替换早期双时间轴版本。演示不是模型准确率或性能基准。

## 演示流程

1. 打开录像工作区，通过本地文件输入导入已有的一分钟真实 Apex 战斗录像。
2. 等待真实 EfficientSED 分析产生候选，进入片段复核。
3. 在当前单行时间轴查看枪声、语音、音乐、冲击／碎裂四组声音；脚步预测过多，因此不参与展示。
4. 选择真实候选，播放原片，通过“设为起点／终点”调整范围，切换声音图层并试听选片。
5. 提交 WebM 导出，展示任务完成状态。

录屏使用真实媒体解码、模型推理与导出。自动化将目录选择器替换为浏览器本地 OPFS 目录，字幕会说明这一点；没有录制原生系统文件夹选择器，也不将 OPFS 描述为用户可见的普通文件夹。视频不包含录音、配音或背景音乐。实际时长和编码参数以产物检测结果为准。

## 生成方式

先启动当前 checkout 的静态服务，使用项目已有 `site/assets`，无需配置 demo 媒体服务：

```bash
python3 model_web_ui/browser.prototype/serve.py --port 8793
```

在另一个终端设置本地样本路径并录制：

```bash
DEMO_VIDEO_PATH=/absolute/path/to/apex-recording.mp4 node scripts/record_demo_video.cjs
```

- 需要本地 `playwright-core`、Google Chrome 与 `ffmpeg`。
- `REVIEW_URL` 可覆盖本地预览地址，默认 `http://127.0.0.1:8793/`。
- `DEMO_RAW_DIR` 可覆盖原始录屏目录，默认 `/private/tmp/apex-readme-demo-20261118`。
- 录制前核对服务返回的是目标 checkout；导入媒体仅通过浏览器本地文件输入，不上传到服务。
- 分辨率为 1440×900；Playwright 录屏帧率以实际输出为准，不声称 60fps。
- 录屏包含实际分析和导出等待时间，不加速以暗示性能。
- 原始录屏、临时浏览器数据与压制产物须按大文件规则预估空间；达到阈值时设置外接盘目录，不静默回退。

## 交付资产

- `docs/assets/demo-walkthrough.mp4`：H.264 完整流程视频，README 链接播放。
- `docs/assets/demo-preview.gif`：800px 宽、10fps、12 秒循环预览。
- `docs/assets/demo-poster.jpg`：视频封面。
- `site/demo-walkthrough.mp4`：与 README 视频同步的站点副本。

README 的英文和中文版本同时更新产物参数。历史验收数字不作为本轮录屏证据。

## 本轮产物检测

完整视频为 38.08 秒、1440×900、25fps、H.264、3,110,083 字节；GIF 为 1,855,887 字节；封面为 192,372 字节。完整 MP4 已通过 ffmpeg 全片解码，抽查复核与导出完成画面。录制过程中未捕获页面脚本异常，界面显示 1/1 段已保存到 OPFS 演示目录。
