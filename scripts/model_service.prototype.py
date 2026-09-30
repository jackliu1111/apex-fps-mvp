#!/usr/bin/env python3
"""Throwaway localhost benchmark. Uses existing BEATs runner and media renderer.
Run with apex-voice-detect/.venv-pretrainedsed/bin/python; not a packaged app.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import platform
import re
import shutil
import subprocess
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
JOBS = {}
POOL = ThreadPoolExecutor(max_workers=1)
LOCK = threading.Lock()
ENGINE = {}

PAGE = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Apex 本地服务实测</title><style>body{font:15px/1.7 system-ui;background:#f4f6f2;color:#172421;max-width:1080px;margin:auto;padding:28px}h1{font-size:26px}section{background:white;border:1px solid #dce3de;border-radius:12px;padding:20px;margin:18px 0}button{font:inherit;background:#187456;color:white;border:0;border-radius:6px;padding:10px 16px;cursor:pointer;margin:4px}table{width:100%;border-collapse:collapse}td,th{text-align:left;border-bottom:1px solid #dce3de;padding:8px}small{color:#68716d}video{width:100%;max-height:400px;background:#111}pre{white-space:pre-wrap}a{color:#187456}</style><h1>Apex 本地模型服务 · 真实实测</h1><p>浏览器提交任务 → 本地抽音频 → 常驻 BEATs CPU 推理 → 候选合并 → 真实视频预览 / 导出。</p><small>这是临时性能验证服务。使用已有 Python 环境和系统 FFmpeg，尚未验证独立安装包。识别质量不在本次评估范围。</small><section><button id="cold">完整链路：推理 + 导出</button><button id="warm">模型常驻：再跑一次分析</button><p id="note">完整链路导出前三段候选：720p 预览、原尺寸快速复制；另对第一段运行现有 4K 精确导出器。</p></section><div id="jobs"></div><script>
async function start(profile){let r=await fetch('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile})});if(!r.ok){document.getElementById('note').textContent=await r.text();return}await update()}
document.getElementById('cold').onclick=()=>start('full');document.getElementById('warm').onclick=()=>start('analyze');
let rendered='';async function update(){const data=await(await fetch('/api/jobs')).json();const signature=JSON.stringify(data);if(signature===rendered)return;rendered=signature;document.getElementById('jobs').innerHTML=data.map(j=>`<section><h2>${j.profile==='full'?'完整链路':'常驻模型分析'} · ${j.status}</h2><p>${j.stage} ${j.progress||''}</p><p>模型缓存：${j.model_cache_hit===undefined?'尚未调用':j.model_cache_hit?'命中':'首次加载'}；任务耗时：${(j.elapsed||0).toFixed(2)} 秒</p><table><tr><th>阶段</th><th>秒</th></tr>${Object.entries(j.timings||{}).map(([k,v])=>`<tr><td>${k}</td><td>${v.toFixed(3)}</td></tr>`).join('')}</table>${j.result?`<p>完整音频 ${j.result.audio_duration.toFixed(2)} 秒 · ${j.result.windows} 窗口 · ${j.result.events} 条枪声候选 · ${j.result.clips} 段合并片段 · 推理 RTF ${j.result.rtf.toFixed(4)}</p>`:''}${j.error?`<pre>${j.error}</pre>`:''}${j.artifacts?Object.entries(j.artifacts).map(([k,v])=>`<p><a href="/${v}" target="_blank">${k}</a></p>`).join(''):''}${j.artifacts&&j.artifacts['720p 预览']?`<video controls preload="metadata" src="/${j.artifacts['720p 预览']}"></video>`:''}</section>`).join('')}
update();setInterval(update,1500);
</script></html>'''

def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)+'\n')

def union(intervals, gap=0):
    out=[]
    for start,end in sorted(intervals):
        if out and start-out[-1][1]<=gap: out[-1][1]=max(out[-1][1],end)
        else: out.append([start,end])
    return out


def stage(job,name,fn):
    job['stage']=name
    started=time.perf_counter()
    result=fn()
    job['timings'][name]=time.perf_counter()-started
    return result


def command(args,log):
    with log.open('ab') as out:
        subprocess.run([str(x) for x in args],stdout=out,stderr=out,check=True)


class ProgressLog:
    def __init__(self,path,job): self.file=path.open('w');self.job=job;self.pending=''
    def write(self,text):
        self.file.write(text);self.file.flush();self.pending+=text
        while '\n' in self.pending:
            line,self.pending=self.pending.split('\n',1)
            if line.startswith('Processed '):self.job['progress']=line
    def flush(self): self.file.flush()


def get_runner(job):
    if 'runner' not in ENGINE:
        started=time.perf_counter()
        spec=importlib.util.spec_from_file_location('benchmark_beats_runner',CONFIG.model_workspace/'scripts/infer_apex_audio.py')
        runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
        job['timings']['导入推理模块']=time.perf_counter()-started
        original=runner.load_model
        def load(checkpoint,device):
            current=ENGINE['active_job']
            if 'model' not in ENGINE:
                current['model_cache_hit']=False
                ENGINE['model']=stage(current,'加载模型',lambda:original(checkpoint,device))
            else:current['model_cache_hit']=True;current['timings']['加载模型']=0.0
            current['stage']='模型推理'
            return ENGINE['model']
        runner.load_model=load;ENGINE['runner']=runner
    ENGINE['active_job']=job
    return ENGINE['runner']


def execute(job):
    start=time.perf_counter();job['status']='running';job['started']=start
    folder=CONFIG.output/job['id'];folder.mkdir(parents=True)
    log=folder/'process.log'
    try:
        source=CONFIG.source
        original_stat=source.stat()
        probe=stage(job,'探测录像',lambda:json.loads(subprocess.check_output([CONFIG.ffprobe,'-v','error','-show_format','-show_streams','-of','json',str(source)])))
        video=next(s for s in probe['streams'] if s['codec_type']=='video');audio=next(s for s in probe['streams'] if s['codec_type']=='audio')
        write_json(folder/'source_probe.json',probe)
        wav=folder/'audio.wav'
        stage(job,'抽取音频',lambda:command([CONFIG.ffmpeg,'-nostdin','-v','error','-xerror','-n','-i',source,'-map',f"0:{audio['index']}",'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',wav],log))
        runner=get_runner(job)
        args=argparse.Namespace(audio_file=wav,output_dir=folder/'inference',checkpoint=CONFIG.model_workspace/'checkpoints/BEATs_strong_1.pt',device='cpu',batch_size=1,num_threads=4,thresholds=[0.1,0.2,0.5],median_frames=3,max_windows=None)
        inference_start=time.perf_counter()
        output=ProgressLog(folder/'inference.log',job)
        with redirect_stdout(output):summary=runner.run(args)
        output.file.close()
        job['timings']['推理任务总计（含加载与写入）']=time.perf_counter()-inference_start
        job['timings']['模型推理循环']=summary['inference_seconds']
        def merge():
            events=[e for e in json.loads((folder/'inference/events.json').read_text()) if e['threshold']==0.2 and e['event_label'] in ['Gunshot, gunfire','Machine gun']]
            clusters=union(union([(e['onset'],e['offset']) for e in events]),4)
            clips=union([(max(0,a-5),min(summary['duration_seconds'],b+8)) for a,b in clusters])
            # Audio zero-point from selected stream start, relative to video PTS.
            shift=float(audio.get('start_time',0))-float(video.get('start_time',0))
            mapped=[{'index':i+1,'audio_start':a,'audio_end':b,'start':max(0,a+shift),'end':min(float(probe['format']['duration']),b+shift)} for i,(a,b) in enumerate(clips)]
            result={'parameters':{'threshold':0.2,'gap_s':4,'before_s':5,'after_s':8},'timeline_shift_s':shift,'alignment':'container timestamps; perceptual AV alignment not assessed','events':len(events),'clips':mapped}
            write_json(folder/'clips.json',result)
            return result
        merged=stage(job,'合并候选',merge)
        job['result']={'audio_duration':summary['duration_seconds'],'windows':summary['processed_windows'],'events':merged['events'],'clips':len(merged['clips']),'rtf':summary['inference_real_time_factor']}
        artifacts={'候选与时间映射':str((folder/'clips.json').relative_to(CONFIG.output)),'模型输出记录':str((folder/'inference/summary.json').relative_to(CONFIG.output))}
        if job['profile']=='full':
            selected=merged['clips'][:3]
            if not selected:raise ValueError('No candidates for export smoke')
            selection={'source':str(source),'clips':selected,'requested_duration':sum(c['end']-c['start'] for c in selected)}
            write_json(folder/'selection.json',selection)
            def fast_export():
                parts=[]
                for c in selected:
                    path=folder/f"fast-{c['index']}.mp4";parts.append(path)
                    command([CONFIG.ffmpeg,'-nostdin','-v','error','-n','-ss',str(c['start']),'-i',source,'-t',str(c['end']-c['start']),'-map','0:v:0','-map',f"0:{audio['index']}",'-c','copy','-avoid_negative_ts','make_zero',path],log)
                concat=folder/'fast-concat.txt';concat.write_text(''.join(f"file '{p.name}'\n" for p in parts))
                dest=folder/'highlight-fast.mp4'
                command([CONFIG.ffmpeg,'-nostdin','-v','error','-n','-f','concat','-safe','1','-i',concat,'-c','copy','-movflags','+faststart',dest],log)
                for p in parts:p.unlink()
            stage(job,'原尺寸快速导出（三段拼接）',fast_export)
            # Existing media renderer used unchanged for preview and precise 4K export.
            request={'source':str(source),'toolsDir':str(Path(CONFIG.ffmpeg).parent),'outputDir':str(folder),'clips':selected}
            write_json(folder/'render-request.json',request)
            def render(profile):command([CONFIG.bun,str(ROOT/'scripts/model_render.prototype.ts'),str(folder/'render-request.json'),profile],log)
            stage(job,'720p 精确预览（三段拼接）',lambda:render('preview'))
            stage(job,'现有 4K 精确导出（第一段）',lambda:render('precise'))
            validation={}
            for name in ['highlight-fast.mp4','highlight-preview.mp4','highlight-precise.mp4']:
                path=folder/name
                data=json.loads(subprocess.check_output([CONFIG.ffprobe,'-v','error','-show_format','-show_streams','-of','json',str(path)]))
                validation[name]={'size_bytes':path.stat().st_size,'duration_seconds':float(data['format']['duration']),'streams':[{'type':s['codec_type'],'codec':s['codec_name'],'width':s.get('width'),'height':s.get('height'),'start_time':s.get('start_time')} for s in data['streams']]}
            def verify():
                for name in validation:command([CONFIG.ffmpeg,'-nostdin','-v','error','-xerror','-i',folder/name,'-map','0:v:0','-map','0:a:0','-f','null','-'],folder/'decode-validation.log')
            stage(job,'导出文件全量解码验证',verify)
            validation['requested']=selection
            validation['quality_assessed']=False
            validation['precise_frame_and_perceptual_alignment_assessed']=False
            write_json(folder/'export-validation.json',validation)
            artifacts.update({'原尺寸快速集锦':str((folder/'highlight-fast.mp4').relative_to(CONFIG.output)),'720p 预览':str((folder/'highlight-preview.mp4').relative_to(CONFIG.output)),'4K 精确导出样本':str((folder/'highlight-precise.mp4').relative_to(CONFIG.output)),'导出验证':str((folder/'export-validation.json').relative_to(CONFIG.output))})
        final_stat=source.stat()
        if (original_stat.st_size,original_stat.st_mtime_ns)!=(final_stat.st_size,final_stat.st_mtime_ns):raise ValueError('Source changed during job')
        job['artifacts']=artifacts;job['status']='complete';job['stage']='已完成';job['progress']=''
    except Exception as exc:
        import traceback
        job['status']='failed';job['error']=traceback.format_exc();job['stage']='失败';print(str(exc),flush=True)
    finally:
        job['elapsed']=time.perf_counter()-start
        job.pop('started',None)
        write_json(folder/'benchmark.json',job)
        print(json.dumps({'id':job['id'],'status':job['status'],'elapsed':job['elapsed'],'timings':job['timings']},ensure_ascii=False),flush=True)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(CONFIG.output),**kwargs)
    def do_GET(self):
        if self.path=='/':self.send_blob(PAGE.encode(),'text/html; charset=utf-8')
        elif self.path=='/api/jobs':
            jobs=[]
            for value in JOBS.values():
                copy=value.copy()
                if 'started' in copy:copy['elapsed']=time.perf_counter()-copy['started']
                jobs.append(copy)
            self.send_blob(json.dumps(jobs,ensure_ascii=False).encode(),'application/json')
        else:super().do_GET()
    def send_blob(self,data,content_type,status=200):
        self.send_response(status);self.send_header('Content-Type',content_type);self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data)
    def do_POST(self):
        if self.path!='/api/jobs':return self.send_blob(b'not found','text/plain',404)
        # Prototype only accepts same-origin browser requests; source is CLI-fixed.
        origin=self.headers.get('Origin')
        if origin and origin!=f'http://127.0.0.1:{CONFIG.port}':return self.send_blob(b'origin rejected','text/plain',403)
        request=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
        if request.get('profile') not in ['full','analyze']:return self.send_blob(b'unknown profile','text/plain',400)
        with LOCK:
            if any(j['status'] in ['queued','running'] for j in JOBS.values()):return self.send_blob(b'task already running','text/plain',409)
            job={'id':datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:6],'profile':request['profile'],'status':'queued','stage':'排队','timings':{},'environment':{'platform':platform.platform(),'model':'BEATs_strong_1','device':'cpu','threads':4,'source':str(CONFIG.source)}}
            JOBS[job['id']]=job;POOL.submit(execute,job)
        self.send_blob(json.dumps({'id':job['id']}).encode(),'application/json',202)
    def log_message(self,*args):pass


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--model-workspace',type=Path,default=Path('/Users/jackliu/game/apex-voice-detect'))
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--port',type=int,default=8769)
    CONFIG=parser.parse_args()
    CONFIG.ffmpeg=shutil.which('ffmpeg');CONFIG.ffprobe=shutil.which('ffprobe');CONFIG.bun=shutil.which('bun')
    CONFIG.output=CONFIG.output.resolve();CONFIG.source=CONFIG.source.resolve();CONFIG.output.mkdir(parents=True,exist_ok=True)
    if not all([CONFIG.ffmpeg,CONFIG.ffprobe,CONFIG.bun]):raise RuntimeError('Need existing ffmpeg, ffprobe and bun')
    server=ThreadingHTTPServer(('127.0.0.1',CONFIG.port),Handler)
    print(f'Prototype benchmark: http://127.0.0.1:{CONFIG.port}; outputs: {CONFIG.output}',flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:server.server_close();POOL.shutdown(wait=False)
