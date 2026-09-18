import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { doctor, locateTools } from "./media";
import { runWorker } from "./worker";
import { startServer } from "./server";

const args = process.argv.slice(2);
function option(name: string) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  if (!args[i + 1] || args[i + 1].startsWith("--"))
    throw new Error(`${name} 缺少参数`);
  return args[i + 1];
}
try {
  if (args.includes("--worker")) await runWorker(option("--worker")!);
  else if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Apex Highlight — 本地录像选片\n\n直接运行：打开浏览器界面\n  doctor                  检查配套媒体工具\n  --tools-dir <目录>       指定 FFmpeg / ffprobe 目录\n  --data-dir <目录>        保存任务、预览缓存\n  --output-dir <目录>      默认视频输出目录\n  --port <端口>            默认自动选择空闲端口\n  --no-open               启动后不自动打开浏览器\n\n所有视频在本机处理。伤害模式需要本地 PaddleOCR 环境，可用 APEX_OCR_PYTHON 指定 Python。",
    );
  } else {
    const toolsDir = locateTools(option("--tools-dir"));
    if (args.includes("doctor"))
      console.log(JSON.stringify(await doctor(toolsDir), null, 2));
    else {
      const dataDir = resolve(
        option("--data-dir") ||
          join(homedir(), ".apex-highlight", "typescript"),
      );
      const outputDir = resolve(
        option("--output-dir") ||
          join(
            homedir(),
            process.platform === "win32" ? "Videos" : "Movies",
            "ApexHighlight",
          ),
      );
      const port = Number(option("--port") || 0);
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error("端口须为 0–65535 的整数");
      await startServer({
        toolsDir,
        dataDir,
        outputDir,
        port,
        open: !args.includes("--no-open"),
      });
    }
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
