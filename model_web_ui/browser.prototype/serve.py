"""Local static host. No inference, media processing, or upload API."""
import argparse
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent

# The browser page imports these before it can render; analysis additionally
# needs the ONNX Runtime files and the manifest/weights of the chosen model.
VENDOR_ASSETS = (
    'vendor/mediabunny.mjs',
    'vendor/ort.wasm.min.mjs',
    'vendor/ort-wasm-simd-threaded.mjs',
    'vendor/ort-wasm-simd-threaded.wasm',
)
MODEL_ASSETS = {
    'EfficientAT 默认模型': ('efficientat/model.json', 'efficientat/mn04.onnx', 'efficientat/frontend.json'),
    'BEATs 可选模型': ('model.json', 'beats.onnx'),
}


def missing_assets(assets):
    """Return (group, relative path) pairs the static host needs but cannot serve."""
    missing = [('浏览器运行库', name) for name in VENDOR_ASSETS if not (assets / name).is_file()]
    for model, names in MODEL_ASSETS.items():
        missing.extend((model, name) for name in names if not (assets / name).is_file())
    return missing


def report_assets(assets, stream):
    """Explain missing assets at startup instead of leaving only an HTTP 404 in the page."""
    missing = missing_assets(assets)
    if not missing:
        print('资产检查：浏览器运行库与模型资产齐全', file=stream)
        return missing
    print('资产检查：以下文件缺失，页面仍可打开，但对应分析会报「模型清单无法读取（HTTP 404）」：', file=stream)
    for group, name in missing:
        print(f'  - {assets / name}（{group}）', file=stream)
    print('  请按 model_web_ui/browser.prototype/README.md「开发阶段重建资产」重建模型资产，'
          '或用 --assets 指向完整资产目录；默认 /private/tmp 路径可能被系统清理。', file=stream)
    return missing


class StaticHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if urlsplit(self.path).path == '/demo/manifest.json':
            sample = self.server.sample
            if sample is None or not sample.is_file():
                self.send_error(404, 'Real sample is not configured or is unavailable')
                return
            stat = sample.stat()
            data = json.dumps({'name': sample.name, 'bytes': stat.st_size,
                               'lastModified': stat.st_mtime_ns // 1_000_000}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()

    def translate_path(self, path):
        path = unquote(urlsplit(path).path)
        if path == '/demo/recording.mp4':
            return str(self.server.sample or ROOT / '__missing__')
        root = self.server.assets if path.startswith('/assets/') else ROOT
        relative = path[len('/assets/'):] if path.startswith('/assets/') else path.lstrip('/')
        candidate = (root / (relative or 'index.html')).resolve()
        return str(candidate if candidate.is_relative_to(root) else ROOT / '__missing__')

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; media-src 'self' blob:; img-src 'self' blob: data:; style-src 'self'; connect-src 'self'; object-src 'none'")
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets', type=Path, default=Path('/private/tmp/apex-browser-prototype-20261026/assets'))
    parser.add_argument('--port', type=int, default=8792)
    parser.add_argument('--sample', type=Path, help='Local one-minute combat MP4, served read-only as the demo (under 100 MiB)')
    parser.add_argument('--background', action='store_true', help='Detach the static preview server from this terminal session')
    args = parser.parse_args()
    if args.sample:
        args.sample = args.sample.resolve()
        if not args.sample.is_file() or args.sample.suffix.lower() != '.mp4':
            parser.error('--sample must point to an existing MP4 file')
        if not 0 < args.sample.stat().st_size < 100 * 1048576:
            parser.error('--sample must be nonempty and smaller than 100 MiB; import larger recordings in the browser')
    if args.background:
        log = args.assets.resolve().parent / 'preview-server.log'
        with log.open('ab', buffering=0) as stream:
            child = subprocess.Popen([sys.executable, '-u', str(Path(__file__).resolve()),
                '--assets', str(args.assets.resolve()), '--port', str(args.port),
                *(['--sample', str(args.sample)] if args.sample else [])],
                stdin=subprocess.DEVNULL, stdout=stream, stderr=stream, start_new_session=True)
        time.sleep(0.5)
        if child.poll() is not None:
            raise SystemExit(f'Preview server failed to start; inspect {log}')
        print(f'Background static preview PID: {child.pid}\nhttp://127.0.0.1:{args.port}\nLog: {log}')
        raise SystemExit(0)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), StaticHandler)
    server.assets = args.assets.resolve()
    server.sample = args.sample
    print(f'Apex Local Cut: http://127.0.0.1:{args.port}', flush=True)
    print(f'Static assets: {server.assets}', flush=True)
    report_assets(server.assets, sys.stderr)
    server.serve_forever()
