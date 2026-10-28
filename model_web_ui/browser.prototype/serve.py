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
    server.serve_forever()
