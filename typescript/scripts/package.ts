import { join, resolve, basename } from "node:path";
import { chmod, copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync, zipSync, type Zippable } from "fflate";
import manifest from "./media-manifest.json";

const root = resolve(import.meta.dir, "..");
const target =
  process.argv[2] ||
  `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const platform = target.replace(/^bun-/, ""),
  mediaPlatform = platform.replace("windows-", "win32-");
const windows = platform.startsWith("windows-"),
  executable = `apex-highlight${windows ? ".exe" : ""}`;
if (
  ![
    "darwin-arm64",
    "darwin-x64",
    "windows-x64",
    "linux-x64",
    "linux-arm64",
  ].includes(platform)
)
  throw new Error(`不支持的平台：${target}`);
const cache = join(root, "work", "downloads"),
  directory = join(root, "dist", platform),
  toolsDir = join(directory, "tools");
const licenses = join(directory, "licenses");
await mkdir(cache, { recursive: true });
await mkdir(toolsDir, { recursive: true });
await mkdir(licenses, { recursive: true });

async function asset(name: string) {
  const entry = manifest.assets[name as keyof typeof manifest.assets];
  if (!entry) throw new Error(`没有媒体工具清单：${name}`);
  const file = join(cache, name);
  const valid = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex") === entry.sha256;
  if (await Bun.file(file).exists()) {
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
    if (valid(bytes)) return bytes;
  }
  console.log(`下载 ${name}`);
  const response = await fetch(entry.url, {
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok)
    throw new Error(`下载失败 ${response.status}: ${entry.url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!valid(bytes)) throw new Error(`SHA-256 校验失败：${name}`);
  await Bun.write(file, bytes);
  return bytes;
}
for (const name of ["ffmpeg", "ffprobe"]) {
  const path = join(toolsDir, name + (windows ? ".exe" : ""));
  await Bun.write(path, gunzipSync(await asset(`${name}-${mediaPlatform}.gz`)));
  if (!windows) await chmod(path, 0o755);
}
for (const suffix of ["LICENSE", "README"])
  await Bun.write(
    join(licenses, `FFmpeg.${suffix}.txt`),
    await asset(`${mediaPlatform}.${suffix}`),
  );
const build = Bun.spawn(
  [process.execPath, join(import.meta.dir, "build.ts"), target],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
if ((await build.exited) !== 0) throw new Error("主程序构建失败");
await copyFile(
  join(root, "licenses/Bun-1.3.13-LICENSE.md"),
  join(licenses, "Bun-LICENSE.md"),
);
for (const dependency of [
  "react",
  "react-dom",
  "scheduler",
  "lucide-react",
  "fflate",
  "fft.js",
]) {
  const folder = join(root, "node_modules", dependency),
    candidates = (await readdir(folder)).filter((name) =>
      /^licen[cs]e/i.test(name),
    );
  // fft.js publishes its MIT license at the bottom of README.md.
  if (!candidates.length && dependency === "fft.js")
    candidates.push("README.md");
  for (const name of candidates)
    await copyFile(
      join(folder, name),
      join(licenses, `${dependency}-${name}.txt`),
    );
}
await Bun.write(
  join(licenses, "SOURCES.txt"),
  `Media binaries: ${manifest.release}\nMac ARM64 upstream: https://www.osxexperts.net/\nMac x64 upstream: https://evermeet.cx/ffmpeg/\nWindows upstream: https://www.gyan.dev/ffmpeg/builds/\nFFmpeg source: https://ffmpeg.org/download.html#get-sources\nFFmpeg build configuration: run tools/ffmpeg -version\n\nBun runtime: https://github.com/oven-sh/bun (MIT; bundled dependencies retain their own licenses)\nRuntime license: https://github.com/oven-sh/bun/blob/bun-v${Bun.version}/LICENSE.md\n`,
);
const readme = `Apex Highlight — TypeScript 本地网页版\n\n${windows ? "双击 apex-highlight.exe" : "双击 启动.command，或在终端运行 ./apex-highlight"}，浏览器会自动打开。\n音频功能无需额外语言环境。伤害模式需要本地 PaddleOCR 环境，设置 APEX_OCR_PYTHON 指向已安装依赖的 Python；详见 docs/paddleocr-debug.md。保留整个目录及 tools 文件夹。\n在网页中选择本机录像 → 分析 → 播放/勾选候选 → 导出。处理过程不上传视频。\n关闭网页不会停止程序；使用侧栏“退出程序”结束后台任务。\n\n任务和预览缓存：用户目录/.apex-highlight/typescript\n默认导出：用户目录/${windows ? "Videos" : "Movies"}/ApexHighlight，也可在网页修改。\n运行 ${executable} doctor 可检查配套媒体工具；--help 查看启动参数。\n\n伤害图标使用现有 HUD 模板定位，数字使用 PaddleOCR；逐关键帧调试图保存在任务目录，未知读数不作为零；请人工复核候选。\n本包未做商业签名。请参阅项目 README.md 和 VALIDATION.md 了解实测范围。\n`;
await Bun.write(join(directory, "使用说明.txt"), readme);
await copyFile(join(root, "README.md"), join(directory, "README.md"));
await mkdir(join(directory, "docs"), { recursive: true });
await copyFile(join(root, "docs/paddleocr-debug.md"), join(directory, "docs/paddleocr-debug.md"));
await copyFile(join(root, "requirements-ocr.txt"), join(directory, "requirements-ocr.txt"));
if (await Bun.file(join(root, "VALIDATION.md")).exists())
  await copyFile(join(root, "VALIDATION.md"), join(directory, "VALIDATION.md"));
if (!windows) {
  const launcher = join(directory, "启动.command");
  await Bun.write(
    launcher,
    '#!/bin/sh\ncd -- "$(dirname -- "$0")" || exit 1\nexec ./apex-highlight "$@"\n',
  );
  await chmod(launcher, 0o755);
}
await Bun.write(
  join(directory, "build-info.json"),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      target,
      bun: Bun.version,
      mediaRelease: manifest.release,
    },
    null,
    2,
  ) + "\n",
);
await createArchive(directory);

async function createArchive(folder: string) {
  const entries: Zippable = {},
    prefix = `apex-highlight-${platform}`;
  async function walk(path: string, relative: string) {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const name = relative + item.name,
        file = join(path, item.name);
      if (item.isDirectory()) await walk(file, name + "/");
      else {
        const executableFile =
          !windows &&
          (item.name === executable ||
            item.name.endsWith(".command") ||
            relative.endsWith("/tools/"));
        entries[name] = [
          new Uint8Array(await Bun.file(file).arrayBuffer()),
          {
            level: 6,
            os: 3,
            attrs: (executableFile ? 0o100755 : 0o100644) << 16,
          },
        ];
      }
    }
  }
  await walk(folder, prefix + "/");
  const zip = join(root, "dist", prefix + ".zip");
  await Bun.write(zip, zipSync(entries));
  const sha = createHash("sha256")
    .update(new Uint8Array(await Bun.file(zip).arrayBuffer()))
    .digest("hex");
  await Bun.write(zip + ".sha256", `${sha}  ${basename(zip)}\n`);
  console.log(`便携包已生成：${zip}`);
}
