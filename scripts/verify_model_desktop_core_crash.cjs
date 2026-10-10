/* Bounded actual-core-only death audit. Never mocks or fabricates native dialogs. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {start,stop,request,runtimeProcesses,awaitGone,output,pause,processes,executable,manifest}=require('./verify_model_desktop_main.cjs');
async function main(){
  assert.equal(processes().filter(entry=>entry.command.startsWith(executable)).length,0,'do not disturb an existing actual app');
  let host;
  const report={scope:'real packaged main/core/renderer; native dialog visibility and acknowledgement remain human-only unless observed; bounded waits',manifest};
  try{
    host=await start();console.log('core-only audit: actual packaged main ready');
    const media=await request(host.cdp,'probe_media',{path:path.join(output,'循环媒体夹具 240秒.mp4')});
    await request(host.cdp,'confirm_audio',{media_id:media.media_id,stream_index:1});
    const submitted=await request(host.cdp,'analyze',{media_id:media.media_id});
    let tracked=[];
    for(let i=0;i<300;i++){
      tracked=runtimeProcesses(host.app.pid);
      if(tracked.some(entry=>entry.command.includes('--inference-worker')&&!entry.command.includes('--process-guardian')))break;
      await pause(30);
    }
    assert.ok(tracked.some(entry=>entry.command.includes('--inference-worker')&&!entry.command.includes('--process-guardian')),'real inference target must start');
    const core=tracked.find(entry=>entry.parent===host.app.pid);
    assert.ok(core);
    const running=await request(host.cdp,'get_task',submitted);assert.equal(running.status,'running');
    process.kill(core.pid,'SIGKILL');
    report.main_pid=host.app.pid;report.task_id=submitted.task_id;report.tracked=tracked;
    report.cleanup=await awaitGone(tracked);
    report.main_alive_after_core_death=processes().some(entry=>entry.pid===host.app.pid);
    assert.equal(report.main_alive_after_core_death,true);
    console.log('core-only audit: main alive, Python/core/guardian/target all gone');
    const response=await Promise.race([
      host.cdp.evaluate("window.apex.request('get_config',{})").then(value=>({kind:'response',value}),error=>({kind:'evaluation-error',message:error.message})),
      pause(5000).then(()=>({kind:'timeout',limit_ms:5000})),
    ]);
    report.renderer_request_after_core_death=response;
    report.native_dialog_observed=false;
    report.native_dialog_acknowledged=false;
    report.api_expectation='plain worker_unavailable error must return within 5 seconds';
    if(response.kind!=='response')fs.writeFileSync(path.join(output,'core-crash-red.json'),JSON.stringify(report,null,2));
    assert.equal(response.kind,'response','actual core death must promptly return an IPC error, even while showing an error notification');
    if(response.kind==='response'){
      assert.equal(response.value.error?.code,'worker_unavailable');
      assert.equal(response.value.error?.status,503);
      report.renderer_worker_unavailable='passed';
      console.log('core-only audit: actual renderer received worker_unavailable');
    }
    await stop(host);host=null;
    host=await start();
    const recovered=await request(host.cdp,'get_task',submitted);
    assert.equal(recovered.status,'failed');assert.equal(recovered.error.code,'service_interrupted');
    report.restart={status:recovered.status,error:recovered.error};
    const trackedRestart=runtimeProcesses(host.app.pid);await stop(host);host=null;await awaitGone(trackedRestart);
    report.status='passed for direct core death, prompt worker_unavailable, main survival, process cleanup and restart; native dialog human review remains unverified';
    fs.writeFileSync(path.join(output,'core-crash-audit.json'),JSON.stringify(report,null,2));
    console.log('PASS bounded actual-core SIGKILL audit; native dialog human observation unverified');
  }finally{if(host)await stop(host);}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
