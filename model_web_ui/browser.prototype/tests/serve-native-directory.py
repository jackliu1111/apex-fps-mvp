"""Local-only native directory acceptance host; records test evidence, never media uploads."""
import argparse
import importlib.util
import json
from pathlib import Path
from http.server import ThreadingHTTPServer
from urllib.parse import urlsplit

base = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('prototype_server', base / 'serve.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Handler(module.StaticHandler):
    def do_GET(self):
        if urlsplit(self.path).path == '/tests/native-state.json':
            data = self.server.evidence.read_bytes() if self.server.evidence.exists() else b'{}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers(); self.wfile.write(data)
            return
        super().do_GET()

    def do_POST(self):
        if self.path != '/tests/native-state.json':
            self.send_error(404); return
        if self.headers.get('Origin') != f'http://127.0.0.1:{self.server.server_port}':
            self.send_error(403); return
        size = int(self.headers.get('Content-Length', 0))
        if not 0 < size <= 1024 * 1024:
            self.send_error(413); return
        try:
            record = json.loads(self.rfile.read(size))
            data = json.dumps(record, ensure_ascii=False, indent=2).encode()
        except (ValueError, UnicodeError):
            self.send_error(400); return
        self.server.evidence.write_bytes(data)
        self.send_response(204); self.end_headers()

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--port', type=int, default=18807)
    args = parser.parse_args()
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.assets = args.assets.resolve()
    server.sample = None
    server.evidence = args.evidence.resolve()
    print(f'Native acceptance: http://127.0.0.1:{args.port}/tests/native-directory-acceptance.html', flush=True)
    print(f'Evidence: {server.evidence}', flush=True)
    server.serve_forever()
