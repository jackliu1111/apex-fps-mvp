# CGO 单程序实现验证 — 2026-09-15

分支：`feature/go-with-CGO`。基于当前 `dev/main` 创建，恢复 `go-core` 的 Go 源码；原有未提交 Python 改动未覆盖。

## 已实现

- FFmpeg 7.1.1 的 ffmpeg、ffprobe、ffplay 三个 C 入口及 libav*、SDL 2.32.6 静态链接到 Go 主程序。
- 媒体任务仅启动当前可执行文件的工作模式；取消会回收该进程。无媒体工具 PATH 回退、无自解压可执行文件。
- 保留原 Go 版媒体参数、精确/快速剪辑、输出保护和 TUI 的 P 预览入口。
- 同一 Python 构建脚本处理 macOS 和 Windows/MSYS2；GitHub Actions 在两个目标系统原生构建、测试、审计与打包。
- ZIP 只含一个运行程序，其余为说明、构建报告、许可证和重新构建的源码材料。

## 本机已完成

环境：macOS arm64；FFmpeg 与 SDL 都从源码编译，运行不依赖 Homebrew 动态库。

1. `python3 go/scripts/build_native.py --test --package` 成功。
2. `APEX_MEDIA_TEST=1 go test ./... -count=1`：5 个包通过，包括音频/HUD 与 Python 固定样本对齐、真实媒体分析、精确/快速导出、有/无音轨、中文/空格/单引号路径、取消、错误传播、拒绝覆盖、工作流回滚、SDL 无窗口音频播放。
3. `go vet ./...` 通过。
4. `verify_native.py` 将**只有主程序**的副本置于新目录，清空 PATH 并隔离临时目录，完成 doctor、探测、两种分析、两种剪辑、成片完整解码和内置音频播放。未产生新的可执行文件或第三方动态库。
5. `otool -L` 只列出 `/usr/lib/` 和 `/System/Library/` 依赖；`codesign --verify --strict` 验证构建生成的临时签名通过。这不代表 Developer ID 签名或公证。
6. 对现有 `work/damage-integration/sample.mkv`（18.517 秒）比较旧 `dist/go/macos-arm64` 与新 CGO 版：audio / damage 的完整分析 JSON 相同。audio 为 9 个事件、1 个候选；damage 为 3 个事件、2 个候选。
7. 新主程序的 ffplay 工作模式在真实 GUI 环境运行现有录像 15 秒，退出码为 0。桌面自动化工具无法选择该裸可执行程序，并限制访问 Ghostty，因此没有完成画面截图或 TUI 整条菜单流程的人工验收。

详细本地记录：`work/cgo-validation/standalone.json`、`work/cgo-validation/real-recording-parity.json`，以及 `build/cgo/final-build-output.log`。发布包内的 `build-info.json` 保存该包的自动验证结果。

Apple 链接器仍报告一条 `__common` 段对齐调整警告；构建、运行与上述测试未出现失败。尚未在较旧 macOS 上验证。

## 尚未验证

- Windows 原生编译和运行：构建入口与 CI 已写入工作区，尚未在 Windows 或远程 CI 执行；不能将 macOS 结果视为 Windows 发布验收。
- 用户实际下载、首次手动批准后的 Gatekeeper / SmartScreen 行为，以及企业策略或 Smart App Control 场景。
- Intel Mac、最低系统版本、广泛输入编码格式、长录像压力测试。

“一个程序需要信任”在本次实现中指一个自带可执行文件；媒体工作有独立进程，但进程映像都是同一文件。它不承诺系统永远不再检查更新后的主程序。
