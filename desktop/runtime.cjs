const fs = require('node:fs');
const path = require('node:path');
function runtime(app) {
  const repo = path.resolve(__dirname, '..');
  if (!app.isPackaged) return {
    command: process.env.APEX_PYTHON || 'python3',
    args: [path.join(repo, 'model_ipc.py')],
    ffmpeg: process.env.APEX_FFMPEG || 'ffmpeg', ffprobe: process.env.APEX_FFPROBE || 'ffprobe',
    modelWorkspace: process.env.APEX_MODEL_WORKSPACE, checkpoint: process.env.APEX_CHECKPOINT,
    uiDir: path.join(repo, 'model_web_ui'), hostDir: __dirname,
  };
  const root = path.join(process.resourcesPath, 'runtime');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const resource = name => {
    const value = manifest[name];
    if (typeof value !== 'string' || path.isAbsolute(value) || value.split(/[\\/]/).includes('..'))
      throw new Error(`无效发行资源：${name}`);
    const result = path.join(root, value);
    if (!fs.existsSync(result)) throw new Error(`发行资源缺失：${name}`);
    return result;
  };
  return { command: resource('service'), args: [], ffmpeg: resource('ffmpeg'), ffprobe: resource('ffprobe'),
    modelWorkspace: resource('model_workspace'), checkpoint: resource('checkpoint'),
    uiDir: path.join(__dirname, 'ui'), hostDir: __dirname };
}
module.exports = { runtime };
