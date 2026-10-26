"""Static-only prototype host. No inference, media processing, or upload API."""
import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent


class StaticHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        path = unquote(urlsplit(path).path)
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
    parser.add_argument('--background', action='store_true', help='Detach the static preview server from this terminal session')
    args = parser.parse_args()
    if args.background:
        log = args.assets.resolve().parent / 'preview-server.log'
        with log.open('ab', buffering=0) as stream:
            child = subprocess.Popen([sys.executable, '-u', str(Path(__file__).resolve()),
                '--assets', str(args.assets.resolve()), '--port', str(args.port)],
                stdin=subprocess.DEVNULL, stdout=stream, stderr=stream, start_new_session=True)
        time.sleep(0.5)
        if child.poll() is not None:
            raise SystemExit(f'Preview server failed to start; inspect {log}')
        print(f'Background static preview PID: {child.pid}\nhttp://127.0.0.1:{args.port}\nLog: {log}')
        raise SystemExit(0)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), StaticHandler)
    server.assets = args.assets.resolve()
    print(f'Pure-browser prototype: http://127.0.0.1:{args.port}', flush=True)
    print(f'Static assets: {server.assets}', flush=True)
    server.serve_forever()
