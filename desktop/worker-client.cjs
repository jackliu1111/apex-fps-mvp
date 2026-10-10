const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { randomUUID } = require('node:crypto');

/** Public desktop command transport. stdout is exclusively NDJSON. */
class WorkerClient {
  constructor({ command, args, onLog = () => {}, onFailure = () => {}, readyTimeoutMs = 30000 }) {
    this.pending = new Map();
    this.process = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      detached: process.platform !== 'win32' });
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.ready.catch(() => {});
    let readinessTimeout;
    const failed = (cause) => {
      clearTimeout(readinessTimeout);
      if (this.failure) return;
      this.failure = Object.assign(new Error('Python 任务进程已停止，请重启应用'), { code: 'worker_unavailable', cause });
      this.rejectReady(this.failure);
      for (const pending of this.pending.values()) pending.reject(this.failure);
      this.pending.clear();
      if (!this.closing) onFailure(this.failure);
    };
    this.process.on('error', failed);
    this.process.on('exit', (code, signal) => failed({ code, signal }));
    this.process.stdin.on('error', failed);
    createInterface({ input: this.process.stdout }).on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch (error) { failed(error); this.process.kill(); return; }
      if (message.type === 'ready') { clearTimeout(readinessTimeout); this.resolveReady(); }
      if (message.type === 'response') {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          if (message.error) pending.reject(Object.assign(new Error(message.error.message), message.error));
          else pending.resolve(message.result);
        }
      }
    });
    this.process.stderr.on('data', data => onLog(data.toString()));
    readinessTimeout = setTimeout(() => { failed(new Error('Python worker readiness timeout')); this.terminate(); }, readyTimeoutMs);
  }
  async execute(operation, payload = {}) {
    await this.ready;
    if (this.failure) throw this.failure;
    const id = randomUUID();
    const message = JSON.stringify({ id, operation, payload }) + '\n';
    if (Buffer.byteLength(message, 'utf8') > 65536) throw Object.assign(new Error('请求超过 64 KiB'), { code: 'request_too_large', status: 413 });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(message);
    });
  }
  terminate() {
    if (!this.process.pid) return;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(this.process.pid), '/T', '/F'], { windowsHide: true });
      else process.kill(-this.process.pid, 'SIGKILL');
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  async close() {
    this.closing = true;
    if (!this.process.stdin.destroyed) this.process.stdin.end();
    if (this.process.exitCode === null && this.process.signalCode === null) {
      const timeout = setTimeout(() => this.terminate(), 3000);
      await new Promise(resolve => this.process.once('exit', resolve));
      clearTimeout(timeout);
    }
  }
}
module.exports = { WorkerClient };
