"""Persistent NDJSON desktop adapter for the shared Python model service."""
import json
import sys
import os
from contextlib import redirect_stdout
from model_service import ModelService, ServiceError
from model_runtime import parent_alive

OPERATIONS = frozenset({
    'get_config', 'browse', 'probe_media', 'confirm_audio', 'get_media',
    'analyze', 'get_task', 'get_result', 'read_scores', 'recompute_candidates',
    'update_selection', 'request_preview', 'get_artifact', 'export', 'cancel_task',
})
MAX_REQUEST_BYTES = 65536


def attached_parent_alive(parent_pid):
    return (os.name == 'nt' or os.getppid() == parent_pid) and parent_alive(parent_pid)


def serve(service, source, sink, *, parent_pid=None):
    def send(message):
        sink.write(json.dumps(message, ensure_ascii=False, allow_nan=False) + '\n')
        sink.flush()
    send({'type': 'ready', 'schema_version': 1})
    try:
        for line in source:
            identifier = None
            try:
                if len(line.encode('utf-8')) > MAX_REQUEST_BYTES:
                    raise ServiceError('request_too_large', '只接受本地路径和配置，不接受媒体上传', 413)
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ServiceError('invalid_request', '请求必须是 JSON 对象', 400)
                identifier = request.get('id')
                if not isinstance(identifier, str) or not identifier or len(identifier) > 128:
                    identifier = None
                    raise ServiceError('invalid_request', '请求须包含有效标识', 400)
                if not isinstance(request.get('payload'), dict):
                    raise ServiceError('invalid_request', '请求内容必须是 JSON 对象', 400)
                operation = request.get('operation')
                if not isinstance(operation, str) or operation not in OPERATIONS:
                    raise ServiceError('not_found', '操作不存在', 404)
                with redirect_stdout(sys.stderr):
                    result = service.execute(operation, request['payload'])
                send({'type': 'response', 'id': identifier, 'result': result})
            except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                send({'type': 'response', 'id': identifier,
                      'error': {'code': 'invalid_request', 'message': '请求必须包含有效 JSON 对象', 'status': 400}})
            except ServiceError as exc:
                send({'type': 'response', 'id': identifier,
                      'error': {'code': exc.code, 'message': str(exc), 'status': exc.status}})
    finally:
        service.close(interrupted=bool(parent_pid and not attached_parent_alive(parent_pid)))


def main():
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    if len(sys.argv) > 1 and sys.argv[1] == '--process-guardian':
        from model_runtime import guardian_main
        return guardian_main(sys.argv[2:])
    if len(sys.argv) > 1 and sys.argv[1] == '--inference-worker':
        from model_inference import main as inference_main
        return inference_main()
    import argparse
    import shutil
    import os
    import signal
    import threading
    import time
    from pathlib import Path
    parser = argparse.ArgumentParser(description='Apex 桌面常驻任务进程（NDJSON）')
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--ffmpeg', required=True)
    parser.add_argument('--ffprobe', required=True)
    parser.add_argument('--model-workspace', type=Path)
    parser.add_argument('--checkpoint', type=Path)
    parser.add_argument('--engine-python')
    parser.add_argument('--parent-pid', type=int)
    args = parser.parse_args()
    for name in ('ffmpeg', 'ffprobe'):
        value = shutil.which(getattr(args, name))
        if value is None:
            parser.error(f'缺少媒体工具 {name}')
        setattr(args, name, value)
    service = ModelService(data_dir=args.data_dir, ffmpeg=args.ffmpeg, ffprobe=args.ffprobe,
                           model_workspace=args.model_workspace, checkpoint=args.checkpoint,
                           engine_python=args.engine_python,
                           model_command=[sys.executable, '--inference-worker'] if getattr(sys, 'frozen', False)
                           and args.model_workspace else None)
    if args.parent_pid:
        def watch_parent():
            while True:
                time.sleep(0.25)
                alive = attached_parent_alive(args.parent_pid)
                if not alive:
                    service.close(interrupted=True)
                    os._exit(0)
        threading.Thread(target=watch_parent, daemon=True).start()
    def stop(signum, frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    serve(service, sys.stdin, sys.stdout, parent_pid=args.parent_pid)


if __name__ == '__main__':
    raise SystemExit(main())
