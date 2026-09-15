Apex 录像片段工具

完整解压后使用，保留程序旁的 bin 和 licenses 文件夹。
本包包含 ffmpeg、ffprobe、ffplay，无需安装 Go、Python 或 Homebrew。

Windows x64：双击 apex-highlight.exe，或在 PowerShell 中执行：
  .\apex-highlight.exe
  .\apex-highlight.exe doctor

macOS Apple Silicon：在终端进入本目录后执行：
  ./apex-highlight
  ./apex-highlight doctor

操作：选择录像 → N 下一步 → 开始分析 → 进入录像查看候选片段。
方向键移动，空格勾选，P 预览，关闭播放窗口返回选片。
返回录像结果页按 E 导出，输出默认保存在当前目录的 outputs 内。
程序目录和输出目录需可写。Windows 输出建议选择 NTFS 磁盘。

也可以指定输出目录：
  Windows: .\apex-highlight.exe tui --output-dir "C:\apex-output"
  macOS:   ./apex-highlight tui --output-dir "$HOME/Movies/apex-output"

本次 Windows 包由 macOS 交叉构建，尚未在 Windows 实机验收。
主程序未完成开发者签名或 macOS 公证。
