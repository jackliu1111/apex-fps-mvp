"""Standalone Python HTTP adapter for the shared audio-model service."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import argparse
import hmac
from importlib.resources import files
import json
from pathlib import Path
import re
import secrets
import shutil
from urllib.parse import parse_qs, urlsplit
from model_service import ModelService, ServiceError


def create_server(service, *, port=8769, token):
    class Handler(BaseHTTPRequestHandler):
        def authorize(self, *, require_token=True, resource_token=None):
            host = f'127.0.0.1:{self.server.server_port}'
            if self.headers.get('Host') != host:
                raise ServiceError('invalid_host', '只允许回环地址访问', 403)
            origin = self.headers.get('Origin')
            if origin is not None and origin != f'http://{host}':
                raise ServiceError('invalid_origin', '请求来源不受允许', 403)
            actual = self.headers.get('X-Apex-Token') or resource_token or ''
            if require_token and not hmac.compare_digest(actual.encode('utf-8'), token.encode('utf-8')):
                raise ServiceError('unauthorized', '请使用启动日志中的完整访问地址', 401)

        def do_GET(self):
            try:
                url = urlsplit(self.path)
                assets = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'),
                          '/transport.js': ('transport.js', 'text/javascript'),
                          '/style.css': ('style.css', 'text/css')}
                asset = assets.get(url.path)
                query = parse_qs(url.query)
                artifact_content = re.fullmatch(r'/api/artifacts/([0-9a-f]{32})/content', url.path)
                query_tokens = query.get('token', [])
                resource_token = query_tokens[0] if artifact_content and len(query_tokens) == 1 else None
                self.authorize(require_token=asset is None, resource_token=resource_token)
                if asset:
                    return self.send_blob(files('model_web_ui').joinpath(asset[0]).read_bytes(), asset[1])
                if url.path == '/api/config':
                    result = service.execute('get_config', {})
                elif url.path == '/api/browse':
                    result = service.execute('browse', {'path': query.get('path', [None])[0]})
                elif url.path.startswith('/api/media/'):
                    result = service.execute('get_media', {'media_id': url.path.removeprefix('/api/media/')})
                elif url.path.startswith('/api/tasks/'):
                    result = service.execute('get_task', {'task_id': url.path.removeprefix('/api/tasks/')})
                elif url.path.startswith('/api/results/'):
                    result = service.execute('get_result', {'result_id': url.path.removeprefix('/api/results/')})
                elif url.path.startswith('/api/scores/'):
                    result = service.execute('read_scores', {
                        'prediction_id': url.path.removeprefix('/api/scores/'),
                        'start_s': query.get('start_s', [None])[0],
                        'end_s': query.get('end_s', [None])[0]})
                elif artifact_content:
                    artifact = service.execute('get_artifact', {'artifact_id': artifact_content.group(1)})
                    return self.send_file(artifact)
                elif url.path.startswith('/api/artifacts/'):
                    result = service.execute('get_artifact', {'artifact_id': url.path.removeprefix('/api/artifacts/')})
                else:
                    raise ServiceError('not_found', '操作不存在', 404)
            except ServiceError as exc:
                return self.send_json({'error': {'code': exc.code, 'message': str(exc)}}, exc.status)
            self.send_json(result)

        def do_POST(self):
            try:
                self.authorize()
                operation = {'/api/probe': 'probe_media', '/api/confirm-audio': 'confirm_audio',
                             '/api/analyze': 'analyze',
                             '/api/recompute-candidates': 'recompute_candidates',
                             '/api/update-selection': 'update_selection',
                             '/api/preview': 'request_preview', '/api/export': 'export',
                             '/api/cancel': 'cancel_task'}.get(urlsplit(self.path).path)
                if operation is None:
                    raise ServiceError('not_found', '操作不存在', 404)
                try:
                    length = int(self.headers.get('Content-Length', '0'))
                    if length > 65536:
                        raise ServiceError('request_too_large', '只接受本地路径和配置，不接受媒体上传', 413)
                    if length <= 0 or self.headers.get('Transfer-Encoding'):
                        raise ValueError('invalid length')
                    request = json.loads(self.rfile.read(length))
                except (ValueError, UnicodeDecodeError) as exc:
                    raise ServiceError('invalid_request', '请求必须包含有效 JSON 对象', 400) from exc
                result = service.execute(operation, request)
            except ServiceError as exc:
                return self.send_json({'error': {'code': exc.code, 'message': str(exc)}}, exc.status)
            self.send_json(result, 202 if operation in ('analyze', 'request_preview', 'export') else 200)

        def send_json(self, result, status=200):
            data = json.dumps(result, ensure_ascii=False, allow_nan=False).encode('utf-8')
            self.send_blob(data, 'application/json', status)

        def send_file(self, artifact):
            try:
                stream = Path(artifact['path']).open('rb')
            except OSError as exc:
                raise ServiceError('artifact_not_found', '文件不存在或不可读，请重新生成', 404) from exc
            with stream:
                size = Path(artifact['path']).stat().st_size
                start, end, status = 0, size - 1, 200
                requested = self.headers.get('Range')
                if requested is not None:
                    match = re.fullmatch(r'bytes=(\d*)-(\d*)', requested)
                    valid = bool(match and any(match.groups()) and size)
                    if valid:
                        first, last = match.groups()
                        if first:
                            start = int(first)
                            end = min(int(last), size - 1) if last else size - 1
                            valid = start < size and start <= end
                        else:
                            suffix = int(last)
                            valid = suffix > 0
                            start = max(0, size - suffix)
                        status = 206
                    if not valid:
                        self.send_response(416)
                        self.send_header('Content-Range', f'bytes */{size}')
                        self.send_header('Content-Length', '0')
                        self.send_header('Accept-Ranges', 'bytes')
                        self.send_header('Cache-Control', 'no-store')
                        self.end_headers()
                        return
                length = max(0, end - start + 1)
                self.send_response(status)
                self.send_header('Content-Type', artifact.get('content_type', 'application/octet-stream'))
                self.send_header('Content-Length', str(length))
                self.send_header('Accept-Ranges', 'bytes')
                if status == 206:
                    self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Referrer-Policy', 'no-referrer')
                self.end_headers()
                stream.seek(start)
                try:
                    while length:
                        chunk = stream.read(min(length, 65536))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        length -= len(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    # Players routinely cancel a range when the user seeks.
                    pass

        def send_blob(self, data, content_type, status=200):
            self.send_response(status)
            self.send_header('Content-Type', content_type + '; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    return ThreadingHTTPServer(('127.0.0.1', port), Handler)


def main():
    parser = argparse.ArgumentParser(description='Apex 本地枪声服务：录像选择、真实模型分析与候选')
    parser.add_argument('--port', type=int, default=8769)
    parser.add_argument('--data-dir', type=Path, default=Path('outputs/python-web'))
    parser.add_argument('--model-workspace', type=Path)
    parser.add_argument('--checkpoint', type=Path)
    parser.add_argument('--engine-python', help='模型进程使用的 Python；默认使用服务的 Python 环境')
    parser.add_argument('--ffmpeg', default=shutil.which('ffmpeg'))
    parser.add_argument('--ffprobe', default=shutil.which('ffprobe'))
    args = parser.parse_args()
    for name in ('ffmpeg', 'ffprobe'):
        path = getattr(args, name)
        resolved = shutil.which(path) if path else None
        if not resolved:
            parser.error(f'缺少媒体工具 {name}，请通过 --{name} 指定可执行文件')
        setattr(args, name, resolved)
    if not 0 <= args.port <= 65535:
        parser.error('端口须为 0–65535')
    service = ModelService(data_dir=args.data_dir, ffmpeg=args.ffmpeg, ffprobe=args.ffprobe,
                           model_workspace=args.model_workspace, checkpoint=args.checkpoint,
                           engine_python=args.engine_python)
    token = secrets.token_urlsafe(32)
    server = create_server(service, port=args.port, token=token)
    print(f'Python Web: http://127.0.0.1:{server.server_port}/#token={token}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        service.close()


if __name__ == '__main__':
    main()
