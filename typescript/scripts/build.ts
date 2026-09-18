import { join } from "node:path";
import { mkdir } from "node:fs/promises";
if (!Bun.semver.satisfies(Bun.version, ">=1.3.13"))
  throw new Error(
    "打包需要 Bun >= 1.3.13；1.3.12 存在 macOS 可执行文件签名缺陷。请升级 Bun 后重试。",
  );
await import("./build-web");
const root = join(import.meta.dir, "..");
const target =
  process.argv[2] ||
  `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const targets = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-windows-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
] as const;
function supported(value: string): value is (typeof targets)[number] {
  return targets.some((t) => t === value);
}
if (!supported(target)) throw new Error(`不支持的目标平台：${target}`);
const directory = join(root, "dist", target.replace("bun-", ""));
await mkdir(directory, { recursive: true });
const result = await Bun.build({
  entrypoints: [join(root, "src/main.ts")],
  compile: {
    target,
    outfile: join(
      directory,
      "apex-highlight" + (target.includes("windows") ? ".exe" : ""),
    ),
  },
  minify: true,
  define: { APEX_COMPILED: "true", "process.env.NODE_ENV": '"production"' },
});
if (!result.success) throw new Error(result.logs.join("\n"));
// macOS rejects an unsigned/invalid ARM64 Mach-O. Ad-hoc signing needs no developer account.
if (target.startsWith("bun-darwin-")) {
  if (process.platform !== "darwin")
    throw new Error("macOS 发布包请在 Mac 上构建，以完成系统要求的临时签名");
  const sign = Bun.spawn(
    [
      "/usr/bin/codesign",
      "--force",
      "--sign",
      "-",
      join(directory, "apex-highlight"),
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await sign.exited) !== 0) throw new Error("macOS 临时签名失败");
}
console.log(`主程序已生成：${directory}`);
