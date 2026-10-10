/* Bounded real-recording native UI audit. Explicit source/track; never copies the recording. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {start:launchNative,stop,runtimeProcesses,awaitGone,manifest,executable,processes}=require('./verify_model_desktop_main.cjs');
const source=process.env.APEX_SAMPLE;
const rawTrack=process.env.APEX_SAMPLE_AUDIO_STREAM;
assert.ok(source,'APEX_SAMPLE must explicitly identify the real recording');
assert.ok(rawTrack!==undefined&&rawTrack!=='','APEX_SAMPLE_AUDIO_STREAM must explicitly identify the audio stream');
const audioStream=Number(rawTrack);assert.ok(Number.isInteger(audioStream)&&audioStream>=0);
const requestLimit=Number(process.env.APEX_UI_REQUEST_TIMEOUT_MS||180000);
const analysisLimit=Number(process.env.APEX_UI_ANALYSIS_TIMEOUT_MS||600000);
const totalLimit=Number(process.env.APEX_UI_TOTAL_TIMEOUT_MS||1200000);
const reviewLimit=Number(process.env.APEX_UI_REVIEW_SECONDS||8);
for(const value of[requestLimit,analysisLimit,totalLimit,reviewLimit])assert.ok(Number.isFinite(value)&&value>0);
const root=path.resolve(__dirname,'..');
const output=process.env.APEX_VALIDATION_DIR||path.join(root,'outputs/native-recording-validation',new Date().toISOString().replaceAll(':','-'));
fs.mkdirSync(output,{recursive:true});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class RecordingCdp{
 constructor(socket){this.socket=socket;this.next=10000;this.pending=new Map();socket.addEventListener('message',event=>{const value=JSON.parse(event.data),pending=this.pending.get(value.id);if(pending){clearTimeout(pending.timer);this.pending.delete(value.id);value.error?pending.reject(Error(JSON.stringify(value.error))):pending.resolve(value.result);}});socket.addEventListener('close',()=>{for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(Error('actual renderer closed'));}this.pending.clear();});}
 command(method,params={}){const id=++this.next;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(`bounded CDP request timeout ${requestLimit}ms: ${method}`));},requestLimit);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
 async evaluate(expression){const value=await this.command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(value.exceptionDetails)throw Error(value.exceptionDetails.exception?.description||JSON.stringify(value.exceptionDetails));return value.result.value;}
 async until(expression,limit=requestLimit){const end=Date.now()+limit;while(Date.now()<end){if(await this.evaluate(expression))return;await pause(250);}throw Error(`bounded UI timeout ${limit}ms: ${expression}; notice=`+await this.evaluate("document.querySelector('#notice')?.textContent"));}
 async screenshot(name){const {data}=await this.command('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(data,'base64'));}
 close(){this.socket.close();}
}
async function external(command,args,limit=requestLimit){return new Promise((resolve,reject)=>{const child=spawn(command,args,{env:{...process.env,PATH:'/nonexistent'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('bounded decode/system command timeout'));},limit);child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr});});});}
async function main(){
 assert.equal(processes().filter(entry=>entry.command.startsWith(executable)).length,0,'do not disturb an existing native app');
 const stat=fs.statSync(source);assert.ok(stat.isFile());
 const report={scope:'one real-recording native app analysis plus a bounded review of one candidate; not all-candidate export, clean-machine or human sync acceptance',input:{path:path.resolve(source),size_bytes:stat.size,audio_stream:audioStream,source_copied:false},limits:{request_ms:requestLimit,analysis_ms:analysisLimit,total_ms:totalLimit,review_seconds:reviewLimit},hardware:{uid:process.getuid(),user:os.userInfo().username,platform:process.platform,architecture:process.arch,cpu_model:os.cpus()[0]?.model,logical_cpus:os.cpus().length,memory_bytes:os.totalmem()},manifest,started_at:new Date().toISOString()};
 let host,completed=false;const began=Date.now();
 const watchdog=setTimeout(()=>{console.error('total native recording timeout');if(host){host.cdp.close();host.app.kill('SIGTERM');setTimeout(()=>host?.app.kill('SIGKILL'),5000);}process.exitCode=1;},totalLimit);
 const save=()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
 try{
  host=await launchNative();host.cdp=new RecordingCdp(host.cdp.socket);
  const evaluate=code=>host.cdp.evaluate(code);
  const request=async(operation,payload)=>{const value=await evaluate(`window.apex.request(${JSON.stringify(operation)},${JSON.stringify(payload)})`);if(value.error)throw Object.assign(Error(value.error.message),value.error);return value.result;};
  const currentTask=async()=>{const log=await evaluate("document.querySelector('#task-log').textContent"),id=/^任务 ([0-9a-f]{32})/.exec(log)?.[1];assert.ok(id);return request('get_task',{task_id:id});};
  report.config=await request('get_config',{});save();console.log('actual packaged real-recording window ready');
  await evaluate("while(document.querySelector('#recordings button[aria-label^=移除]'))document.querySelector('#recordings button[aria-label^=移除]').click();");
  await evaluate(`document.querySelector('#source').value=${JSON.stringify(source)};document.querySelector('#probe-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
  await host.cdp.until("document.querySelectorAll('#recordings li').length===1&&!document.querySelector('#probe').disabled");
  assert.equal(await evaluate("document.querySelectorAll('#tracks input:checked').length"),0,'explicit track confirmation is required');
  const selected=await evaluate(`!!document.querySelector('#tracks input[value="${audioStream}"]')`);assert.ok(selected,'declared audio stream must exist');
  await evaluate(`document.querySelector('#tracks input[value="${audioStream}"]').click();document.querySelector('#confirm').click();`);
  await host.cdp.until(`document.querySelector('#selection').textContent.includes('已保存音轨 #${audioStream}')&&!document.querySelector('#analyze').disabled`);
  report.probed_video_text=await evaluate("document.querySelector('#video-info').textContent");save();console.log('real source probed, explicitly selected track '+audioStream);
  await evaluate("document.querySelector('#analyze').click()");
  await host.cdp.until("document.querySelectorAll('#result-list li').length===1&&!document.querySelector('#analyze').disabled",analysisLimit);
  report.analysis=await currentTask();assert.equal(report.analysis.status,'completed',JSON.stringify(report.analysis));
  const result=await request('get_result',{result_id:report.analysis.result_id});report.result=result;
  assert.equal(result.prediction.model.name,'BEATs_strong_1');assert.equal(result.media.selected_audio.stream_index,audioStream);
  assert.deepEqual(Object.fromEntries(['threshold','merge_gap_s','before_s','after_s'].map(key=>[key,result.parameters[key]])),{threshold:0.2,merge_gap_s:5,before_s:5,after_s:5});
  assert.equal(result.media.source.path,path.resolve(source));assert.ok(result.candidates.length,'this limited UI case needs one candidate; empty result must be reported explicitly');
  save();console.log('real native analysis complete: '+result.candidates.length+' candidates');
  await evaluate("document.querySelector('#select-none').click()");
  const chosen=result.candidates[0],start=chosen.start_s,end=Math.min(chosen.end_s,start+reviewLimit);
  assert.ok(start<end);
  await evaluate(`const row=document.querySelector('#candidates tr');row.querySelector('input[type=checkbox]').click();const inputs=row.querySelectorAll('input[type=number]');inputs[0].value=${JSON.stringify(String(start))};inputs[1].value=${JSON.stringify(String(end))};inputs.forEach(input=>input.dispatchEvent(new Event('input',{bubbles:true})));document.querySelector('#save-selection').click();`);
  await host.cdp.until("document.querySelector('#selection-summary').textContent.includes('已保存')&&!document.querySelector('#probe').disabled");
  const reviewed=await request('get_result',{result_id:result.result_id});report.review={candidate_id:chosen.candidate_id,automatic_range:{start_s:chosen.start_s,end_s:chosen.end_s},requested_range:{start_s:start,end_s:end},selection:reviewed.selection,limited_to_one:true};
  assert.equal(reviewed.selection.filter(item=>item.selected).length,1);assert.equal(reviewed.prediction_id,result.prediction_id);save();
  await evaluate("document.querySelector('#candidates button').click()");
  await host.cdp.until("!document.querySelector('#preview').hidden&&document.querySelector('#preview-video').readyState>=2&&!document.querySelector('#probe').disabled");
  report.preview=await currentTask();assert.equal(report.preview.status,'completed',JSON.stringify(report.preview));
  const previewFile=await request('get_artifact',{artifact_id:report.preview.preview_id});
  await evaluate("document.querySelector('#preview-video').muted=true;document.querySelector('#preview-video').play()");
  await host.cdp.until("!document.querySelector('#preview-video').paused&&document.querySelector('#preview-video').currentTime>0");
  await evaluate("document.querySelector('#preview').scrollIntoView({block:'center'})");await pause(200);await host.cdp.screenshot('real-recording-preview');save();console.log('bounded one-candidate native preview playing');
  await evaluate(`document.querySelector('#output-dir').value=${JSON.stringify(path.join(output,'独立成片'))};document.querySelector('#export-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
  await host.cdp.until("!document.querySelector('#exports').hidden&&document.querySelector('#export-list').textContent.includes('.mp4')&&!document.querySelector('#probe').disabled");
  report.export=await currentTask();assert.equal(report.export.status,'completed',JSON.stringify(report.export));assert.equal(report.export.exports.length,1);save();
  await evaluate("Array.from(document.querySelectorAll('#export-list button')).find(button=>button.textContent==='播放成片').click()");
  await host.cdp.until("document.querySelector('#preview-video').readyState>=2&&!document.querySelector('#preview-video').paused");
  await evaluate("document.querySelector('#exports').scrollIntoView({block:'center'})");await pause(200);await host.cdp.screenshot('real-recording-export');
  report.rendered={source:await evaluate("document.querySelector('#result-source').textContent"),model:await evaluate("document.querySelector('#model-version').textContent"),preview:await evaluate("document.querySelector('#preview-info').textContent"),export:await evaluate("document.querySelector('#export-list').textContent")};
  report.decodes=[];for(const artifact of[previewFile,...report.export.exports]){const decode=await external(report.config.ffmpeg,['-nostdin','-v','error','-xerror','-i',artifact.path,'-map','0:v','-map','0:a','-f','null','-']);assert.equal(decode.code,0,decode.stderr);report.decodes.push({path:artifact.path,...decode});}
  report.status='passed';report.elapsed_s=(Date.now()-began)/1000;report.completed_at=new Date().toISOString();save();
  const tracked=runtimeProcesses(host.app.pid);await stop(host);host=null;await awaitGone(tracked);completed=true;
  console.log('PASS bounded real-recording native UI '+report.elapsed_s.toFixed(3)+'s; one reviewed candidate only, no human sync claim');
 }catch(error){report.status='failed';report.error={message:error.message,code:error.code};report.elapsed_s=(Date.now()-began)/1000;save();throw error;}
 finally{clearTimeout(watchdog);if(host)await stop(host);if(!completed)process.exitCode=1;}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
