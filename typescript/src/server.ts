import {
  basename,
  dirname,
  extname,
  join,
  resolve,
  parse,
  sep,
} from "node:path";
import { homedir } from "node:os";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { assets } from "../.generated/assets";
import { Jobs } from "./jobs";
import { doctor, renderClip, verifySource } from "./media";
import { type Analysis, validateSettings } from "./shared";

export const videoExtensions = new Set([
  ".mp4",
  ".mkv",
  ".mov",
  ".webm",
  ".avi",
  ".m4v",
  ".ts",
]);
export function cleanPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    throw new Error("请输入有效的文件或目录路径");
  let path = value.trim();
  if (
    (path.startsWith('"') && path.endsWith('"')) ||
    (path.startsWith("'") && path.endsWith("'"))
  )
    path = path.slice(1, -1);
  if (path === "~") path = homedir();
  else if (path.startsWith("~/") || path.startsWith("~\\"))
    path = join(homedir(), path.slice(2));
  return resolve(path);
}
export function rangeResponse(
  file: Bun.BunFile,
  header: string | null,
): Response {
  const headers: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
  };
  if (!header)
    return new Response(file, {
      headers: { ...headers, "Content-Length": String(file.size) },
    });
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  const invalid = () =>
    new Response(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${file.size}` },
    });
  if (!match || (!match[1] && !match[2])) return invalid();
  let start: number, end: number;
  if (!match[1]) {
    const length = Number(match[2]);
    if (!length) return invalid();
    start = Math.max(0, file.size - length);
    end = file.size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), file.size - 1) : file.size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= file.size ||
    end < start
  )
    return invalid();
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: {
      ...headers,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${file.size}`,
    },
  });
}
function authorized(actual: string | null, token: string): boolean {
  if (!actual || actual.length !== token.length) return false;
  const a = Buffer.from(actual),
    b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function startServer(options: {
  toolsDir: string;
  dataDir: string;
  outputDir: string;
  port: number;
  open: boolean;
}) {
  const jobs = new Jobs(join(options.dataDir, "jobs"), options.toolsDir);
  await jobs.load();
  const token =
    crypto.randomUUID().replaceAll("-", "") +
    crypto.randomUUID().replaceAll("-", "");
  const previews = new Map<
    string,
    {
      status: string;
      path: string;
      error?: string;
      controller?: AbortController;
    }
  >();
  let toolInfo: unknown, toolError: string | undefined;
  try {
    toolInfo = await doctor(options.toolsDir);
  } catch (e) {
    toolError = e instanceof Error ? e.message : String(e);
  }
  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    for (const p of previews.values()) p.controller?.abort();
    await jobs.close();
    server.stop(true);
  }
  function findAnalysis(id: string): Analysis {
    for (const job of jobs.items.values()) {
      const found = job.analyses.find((a) => a.id === id);
      if (found) return found;
    }
    throw new Error("分析结果不存在，请重新分析");
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    idleTimeout: 60,
    maxRequestBodySize: 1_000_000,
    async fetch(request) {
      const url = new URL(request.url),
        expectedHost = `127.0.0.1:${server.port}`;
      if (request.headers.get("host") !== expectedHost)
        return new Response("Invalid host", { status: 403 });
      const origin = request.headers.get("origin");
      if (origin && origin !== `http://${expectedHost}`)
        return new Response("Invalid origin", { status: 403 });
      const staticAsset = assets[url.pathname as keyof typeof assets];
      if (request.method === "GET" && staticAsset)
        return new Response(staticAsset.body, {
          headers: {
            "Content-Type": staticAsset.type,
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy":
              "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'",
          },
        });
      const accessToken =
        request.headers.get("x-apex-token") ||
        (url.pathname.startsWith("/media/")
          ? url.searchParams.get("token")
          : null);
      if (!authorized(accessToken, token))
        return Response.json(
          { error: "请从程序打开的页面访问" },
          { status: 401 },
        );
      try {
        if (request.method === "GET" && url.pathname === "/api/config")
          return Response.json({
            home: homedir(),
            outputDir: options.outputDir,
            tools: toolInfo,
            toolError,
          });
        if (request.method === "GET" && url.pathname === "/api/browse") {
          const input = url.searchParams.get("path") || homedir(),
            canonical = await realpath(cleanPath(input)),
            info = await stat(canonical);
          if (info.isFile()) {
            if (!videoExtensions.has(extname(canonical).toLowerCase()))
              throw new Error("请选择支持的视频文件");
            return Response.json({
              parent: dirname(canonical),
              file: {
                path: canonical,
                name: basename(canonical),
                size: info.size,
              },
            });
          }
          const entries = await readdir(canonical, { withFileTypes: true });
          const relevant = entries.filter(
            (e) =>
              !e.name.startsWith(".") &&
              (e.isDirectory() ||
                videoExtensions.has(extname(e.name).toLowerCase())),
          );
          const items = (
            await Promise.all(
              relevant.slice(0, 1500).map(async (e) => {
                try {
                  const p = join(canonical, e.name),
                    s = await stat(p);
                  return {
                    path: p,
                    name: e.name,
                    directory: s.isDirectory(),
                    size: s.size,
                  };
                } catch {
                  return null;
                }
              }),
            )
          )
            .filter(Boolean)
            .sort(
              (a, b) =>
                Number(b!.directory) - Number(a!.directory) ||
                a!.name.localeCompare(b!.name, "zh-CN", { numeric: true }),
            );
          const roots =
            process.platform === "win32"
              ? (
                  await Promise.all(
                    "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map(async (d) => {
                      const p = `${d}:\\`;
                      try {
                        await stat(p);
                        return p;
                      } catch {
                        return null;
                      }
                    }),
                  )
                ).filter(Boolean)
              : [homedir(), "/Volumes", "/"];
          return Response.json({
            path: canonical,
            parent: dirname(canonical),
            items,
            roots,
            truncated: relevant.length > 1500,
          });
        }
        if (request.method === "GET" && url.pathname === "/api/jobs")
          return Response.json(jobs.list());
        const jobMatch = /^\/api\/jobs\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (request.method === "GET" && jobMatch) {
          const job = jobs.items.get(jobMatch[1]);
          return job
            ? Response.json(job)
            : new Response("Not found", { status: 404 });
        }
        if (request.method === "POST" && url.pathname === "/api/analyze") {
          const body = await request.json();
          validateSettings(body.settings);
          if (
            !Array.isArray(body.sources) ||
            !body.sources.length ||
            body.sources.length > 100
          )
            throw new Error("请选择 1–100 个录像");
          const sources = [
            ...new Set<string>(
              await Promise.all(
                body.sources.map(async (p: unknown) => {
                  const path = await realpath(cleanPath(p)),
                    s = await stat(path);
                  if (
                    !s.isFile() ||
                    !videoExtensions.has(extname(path).toLowerCase())
                  )
                    throw new Error("输入必须是支持的视频文件");
                  return path;
                }),
              ),
            ),
          ];
          const outputDir = cleanPath(body.outputDir || options.outputDir);
          return Response.json(
            await jobs.start({
              kind: "analyze",
              sources,
              settings: body.settings,
              outputDir,
            }),
          );
        }
        if (request.method === "POST" && url.pathname === "/api/cancel") {
          const body = await request.json();
          await jobs.cancel(body.id);
          return Response.json({ ok: true });
        }
        if (request.method === "POST" && url.pathname === "/api/export") {
          const body = await request.json();
          if (
            !Array.isArray(body.selections) ||
            !body.selections.length ||
            body.selections.length > 100
          )
            throw new Error("请选择片段");
          const selections = body.selections.map((s: any) => {
            const analysis = findAnalysis(s.analysisId);
            if (
              !Array.isArray(s.indices) ||
              s.indices.some(
                (i: unknown) =>
                  !Number.isInteger(i) ||
                  Number(i) < 0 ||
                  Number(i) >= analysis.clips.length,
              )
            )
              throw new Error("候选编号无效");
            return { analysis, indices: s.indices as number[] };
          });
          if (!selections.some((s: any) => s.indices.length))
            throw new Error("请选择片段");
          return Response.json(
            await jobs.start({
              kind: "export",
              selections,
              outputDir: cleanPath(body.outputDir || options.outputDir),
            }),
          );
        }
        if (request.method === "POST" && url.pathname === "/api/preview") {
          const body = await request.json(),
            analysis = findAnalysis(body.analysisId),
            index = body.index;
          if (!Number.isInteger(index) || !analysis.clips[index])
            throw new Error("候选片段不存在");
          const id = `${analysis.id}_${index}`,
            path = join(options.dataDir, "previews", `${id}.mp4`);
          let preview = previews.get(id);
          if (!preview || preview.status === "failed") {
            if (
              [...previews.values()].filter((p) => p.status === "running")
                .length >= 2
            )
              throw new Error("正在准备预览，请稍后重试");
            preview = {
              status: "running",
              path,
              controller: new AbortController(),
            };
            previews.set(id, preview);
            const state = preview;
            void (async () => {
              try {
                await verifySource(
                  analysis.source,
                  state.controller!.signal,
                );
                if (!(await Bun.file(path).exists()))
                  await renderClip(
                    analysis.source.path,
                    analysis.clips[index],
                    analysis.media,
                    path,
                    options.toolsDir,
                    state.controller!.signal,
                    true,
                  );
                state.status = "completed";
              } catch (e) {
                state.status = "failed";
                state.error = e instanceof Error ? e.message : String(e);
              } finally {
                state.controller = undefined;
              }
            })();
          }
          return Response.json({
            id,
            status: preview.status,
            error: preview.error,
            url: `/media/${id}.mp4?token=${token}`,
          });
        }
        if (request.method === "GET" && url.pathname.startsWith("/media/")) {
          const id = /^\/media\/([a-f0-9-]{36}_\d+)\.mp4$/.exec(
              url.pathname,
            )?.[1],
            p = id ? previews.get(id) : undefined;
          if (!p || p.status !== "completed")
            return new Response("Not found", { status: 404 });
          const file = Bun.file(p.path);
          if (!(await file.exists()))
            return new Response("Not found", { status: 404 });
          return rangeResponse(file, request.headers.get("range"));
        }
        if (request.method === "POST" && url.pathname === "/api/open-output") {
          const { id } = await request.json(),
            job = jobs.items.get(id);
          if (!job?.exports.length) throw new Error("尚未导出文件");
          openExternal(job.outputDir, false);
          return Response.json({ ok: true });
        }
        if (request.method === "POST" && url.pathname === "/api/shutdown") {
          setTimeout(() => void shutdown(), 50);
          return Response.json({ ok: true });
        }
        return new Response("Not found", { status: 404 });
      } catch (e) {
        return Response.json(
          { error: e instanceof Error ? e.message : String(e) },
          { status: 400 },
        );
      }
    },
  });
  const url = `http://127.0.0.1:${server.port}/#token=${token}`;
  console.log(`Apex Highlight 已启动：${url}`);
  if (options.open) openExternal(url, true);
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  return { server, jobs, url, shutdown };
}
function openExternal(target: string, isURL: boolean) {
  const command =
    process.platform === "darwin"
      ? ["/usr/bin/open", target]
      : process.platform === "win32"
        ? isURL
          ? ["rundll32.exe", "url.dll,FileProtocolHandler", target]
          : ["explorer.exe", target]
        : ["xdg-open", target];
  try {
    const p = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });
    void p.exited;
  } catch {
    console.error("无法自动打开，请手动访问上方地址。");
  }
}
