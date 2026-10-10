/* Read-only, bounded actual Electron playback comparison. No application core/model is started. */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {pathToFileURL}=require('node:url');
const source=process.env.APEX_SOURCE_VIDEO,clip=process.env.APEX_CLIP_VIDEO;
if(!source||!clip)throw Error('APEX_SOURCE_VIDEO and APEX_CLIP_VIDEO are required');
for(const file of[source,clip])if(!fs.statSync(file).isFile())throw Error('Missing input: '+file);
const start=Number(process.env.APEX_PLAYBACK_SOURCE_START||135),end=Number(process.env.APEX_PLAYBACK_SOURCE_END||151.05);
if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||start>=end)throw Error('Invalid source range');
const output=process.env.APEX_DIAG_DIR||path.join(__dirname,'../outputs/copy-playback-diagnosis',new Date().toISOString().replaceAll(':','-'));
fs.mkdirSync(output,{recursive:true});
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
const items=[{name:'source',path:source,url:pathToFileURL(source).href,start,end},{name:'clip',path:clip,url:pathToFileURL(clip).href,start:0,end:null}];
const html=`<!doctype html><meta charset="utf-8"><title>Local copy playback diagnostic</title><style>body{margin:0;background:#171717;color:#fff;font-family:sans-serif}video{width:960px;height:540px}p{margin:8px}</style><p id="state">Playback timing comparison</p><main id="host"></main><script>
const items=${JSON.stringify(items).replaceAll('<','\\u003c')};
window.playbackDiagnostic={status:'ready',cases:[],visibilityChanges:[],shownFallback:false};
document.addEventListener('visibilitychange',()=>window.playbackDiagnostic.visibilityChanges.push({wall_ms:performance.now(),state:document.visibilityState}));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function quality(video){const q=video.getVideoPlaybackQuality();return{creationTime:q.creationTime,totalVideoFrames:q.totalVideoFrames,droppedVideoFrames:q.droppedVideoFrames,corruptedVideoFrames:q.corruptedVideoFrames??null};}
async function wait(condition,limit,message){const until=performance.now()+limit;while(performance.now()<until){if(condition())return;await pause(25);}throw Error(message);}
async function play(item){
 const video=document.createElement('video');video.preload='auto';video.muted=true;video.playsInline=true;video.controls=true;
 document.querySelector('#host').replaceChildren(video);document.querySelector('#state').textContent=item.name+' playback';
 const result={name:item.name,path:item.path,requested_range:{start_s:item.start,end_s:item.end},events:[],frames:[],quality_samples:[],visibility_at_start:document.visibilityState,phase:'loading'};
 window.playbackDiagnostic.cases.push(result);
 const events=['loadstart','loadedmetadata','loadeddata','canplay','canplaythrough','seeking','seeked','play','playing','waiting','stalled','suspend','pause','ended','error','emptied'];
 for(const name of events)video.addEventListener(name,()=>result.events.push({event:name,wall_ms:performance.now(),currentTime:video.currentTime,phase:result.phase,readyState:video.readyState,networkState:video.networkState,error:video.error?{code:video.error.code,message:video.error.message}:null}));
 video.src=item.url;
 await wait(()=>video.readyState>=1||video.error,20000,item.name+' metadata timeout');if(video.error)throw Error(video.error.message);
 result.metadata={duration_s:video.duration,width:video.videoWidth,height:video.videoHeight};
 result.phase='seeking';video.currentTime=item.start;
 await wait(()=>!video.seeking&&video.readyState>=2||video.error,15000,item.name+' seek timeout');if(video.error)throw Error(video.error.message);
 result.quality_before=quality(video);result.seeked_time=video.currentTime;result.phase='playback';result.play_called_wall_ms=performance.now();
 let active=true,callback;
 function frame(now,data){
  result.frames.push({callback_wall_ms:now,mediaTime:data.mediaTime,presentedFrames:data.presentedFrames,presentationTime:data.presentationTime,expectedDisplayTime:data.expectedDisplayTime,processingDuration:data.processingDuration??null,width:data.width,height:data.height,currentTime:video.currentTime,readyState:video.readyState});
  if(active)callback=video.requestVideoFrameCallback(frame);
 }
 if(typeof video.requestVideoFrameCallback!=='function')throw Error('requestVideoFrameCallback unavailable');
 callback=video.requestVideoFrameCallback(frame);
 const sampler=setInterval(()=>result.quality_samples.push({wall_ms:performance.now(),currentTime:video.currentTime,quality:quality(video),paused:video.paused,readyState:video.readyState}),250);
 try{
  await video.play();
  const stop=item.end===null?video.duration:item.end;
  const until=performance.now()+Math.max(30000,(stop-item.start+8)*1000);
  let fallbackRequested=false;
  while(performance.now()<until){
   if(video.error)throw Error(video.error.message);
   if(video.ended||item.end!==null&&video.currentTime>=item.end)break;
   if(!fallbackRequested&&!result.frames.length&&performance.now()-result.play_called_wall_ms>1000){fallbackRequested=true;window.playbackDiagnostic.needVisibleFallback=true;}
   await pause(20);
  }
  if(!video.ended&&!(item.end!==null&&video.currentTime>=item.end))throw Error(item.name+' bounded playback timeout');
  result.stopped_wall_ms=performance.now();result.stopped_media_time=video.currentTime;result.ended=video.ended;result.phase='completed';video.pause();result.quality_after=quality(video);
  if(!result.frames.length)throw Error(item.name+' produced no actual video-frame callbacks');
 }finally{active=false;video.cancelVideoFrameCallback(callback);clearInterval(sampler);}
 video.removeAttribute('src');video.load();
 return result;
}
window.runPlaybackDiagnostic=async()=>{try{window.playbackDiagnostic.status='running';for(const item of items)await play(item);window.playbackDiagnostic.status='completed';}catch(error){window.playbackDiagnostic.status='failed';window.playbackDiagnostic.error=error.message;}return window.playbackDiagnostic;};
</script>`;
const htmlPath=path.join(output,'playback.html');fs.writeFileSync(htmlPath,html);
let window,done=false;const mediaMessages=[];
const report={scope:'normal-GPU Electron file playback, one source interval and one copy clip; automatic timing/counters, not human sync or full app/model test',inputs:items.map(({url,...item})=>item),environment:{uid:process.getuid(),user:os.userInfo().username,platform:process.platform,architecture:process.arch,electron:process.versions.electron,chromium:process.versions.chrome,node:process.versions.node},method:{show:false,backgroundThrottling:false,offscreen:false,rendererSandbox:true,nodeIntegration:false,contextIsolation:true,network_configuration_unchanged:true},started_at:new Date().toISOString()};
const save=()=>fs.writeFileSync(path.join(output,'playback-report.json'),JSON.stringify(report,null,2));
app.on('window-all-closed',()=>{if(!done)process.exitCode=1;app.quit();});
app.whenReady().then(async()=>{
 report.stage='creating-window';save();
 report.main_pid=process.pid;report.gpu_feature_status=app.getGPUFeatureStatus();
 window=new BrowserWindow({show:false,width:980,height:620,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 window.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith('file:'))event.preventDefault();});
 report.stage='loading-local-html';save();await window.loadFile(htmlPath);
 report.stage='optional-media-domain';save();
 try{window.webContents.debugger.attach('1.3');window.webContents.debugger.on('message',(_event,method,params)=>{if(method.startsWith('Media.'))mediaMessages.push({wall_ms:Date.now(),method,params});});await Promise.race([window.webContents.debugger.sendCommand('Media.enable'),new Promise((_,reject)=>setTimeout(()=>reject(Error('optional Media.enable timeout (2s)')),2000))]);}catch(error){report.media_domain_error=error.message;}
 report.renderer_pid=window.webContents.getOSProcessId();
 report.stage='playing';
 console.log(JSON.stringify({main_pid:report.main_pid,renderer_pid:report.renderer_pid,output,method:report.method}));
 save();
 const observer=setInterval(async()=>{try{const needed=await window.webContents.executeJavaScript('!!window.playbackDiagnostic.needVisibleFallback');if(needed&&!window.isVisible()){window.showInactive();report.method.show=true;report.method.visible_fallback='no first video frame in hidden window after 1s; shown inactive';await window.webContents.executeJavaScript('window.playbackDiagnostic.shownFallback=true');}}catch{}},200);
 const watchdog=setTimeout(()=>{report.status='failed';report.error='total playback diagnostic timeout (90s)';report.media_messages=mediaMessages;save();process.exitCode=1;done=true;window.destroy();},90000);
 try{
  report.renderer=await window.webContents.executeJavaScript('runPlaybackDiagnostic()',true);report.media_messages=mediaMessages;report.status=report.renderer.status==='completed'?'completed':'failed';report.completed_at=new Date().toISOString();save();
  console.log(JSON.stringify({status:report.status,cases:report.renderer.cases.map(c=>({name:c.name,frame_callbacks:c.frames.length,ended:c.ended,metadata:c.metadata,quality_before:c.quality_before,quality_after:c.quality_after}))}));
  if(report.status!=='completed')process.exitCode=1;
 }finally{clearInterval(observer);clearTimeout(watchdog);done=true;window.destroy();}
}).catch(error=>{report.status='failed';report.error=error.message;report.media_messages=mediaMessages;save();console.error(error);process.exitCode=1;done=true;app.quit();});
