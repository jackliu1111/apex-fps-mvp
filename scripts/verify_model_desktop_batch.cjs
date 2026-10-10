/* Actual packaged main/renderer multi-track, batch and empty-result public behavior. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {start,stop,request,currentTask,runtimeProcesses,awaitGone,runtime,manifest,output,pause,processes,executable}=require('./verify_model_desktop_main.cjs');
async function main(){
  assert.equal(processes().filter(entry=>entry.command.startsWith(executable)).length,0,'an existing actual app must not be disturbed');
  const folder=path.join(output,'多音轨 批量');fs.mkdirSync(folder,{recursive:true});
  const source=process.env.APEX_SAMPLE||'/Users/jackliu/payload/sample-apex.mp4';
  const first=path.join(folder,'第一份 双音轨游戏录像.mp4'),second=path.join(folder,'第二份 12秒双音轨.mp4');
  const tool=path.join(runtime,manifest.ffmpeg);
  const full=spawnSync(tool,['-nostdin','-v','error','-y','-i',source,'-f','lavfi','-i','sine=frequency=880:sample_rate=16000:duration=20',
    '-map','0:v:0','-map','0:a:0','-map','1:a:0','-c:v','copy','-c:a:0','copy','-c:a:1','aac','-t','20',
    '-metadata:s:a:0','title=游戏声音','-metadata:s:a:0','language=zho','-metadata:s:a:1','title=麦克风夹具','-metadata:s:a:1','language=eng',first]);
  assert.equal(full.status,0,full.stderr.toString());
  const trim=spawnSync(tool,['-nostdin','-v','error','-y','-i',first,'-t','12','-map','0','-c','copy',second]);
  assert.equal(trim.status,0,trim.stderr.toString());
  const inspected=spawnSync(path.join(runtime,manifest.ffprobe),['-v','error','-show_entries','stream=codec_type,duration','-of','json',second],{encoding:'utf8'});
  assert.equal(inspected.status,0,inspected.stderr);
  const externalVideoDuration=Number(JSON.parse(inspected.stdout).streams.find(stream=>stream.codec_type==='video').duration);
  assert.ok(externalVideoDuration>11&&externalVideoDuration<13,'copy fixture should remain a distinct shorter recording');
  let host;
  try{
    host=await start();
    await host.cdp.evaluate("while(document.querySelector('#recordings button[aria-label^=移除]'))document.querySelector('#recordings button[aria-label^=移除]').click();");
    await host.cdp.evaluate(`document.querySelector('#source').value=${JSON.stringify(first+'\n'+second)};document.querySelector('#probe-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
    await host.cdp.until("document.querySelectorAll('#recordings li').length===2&&!document.querySelector('#probe').disabled");
    assert.equal(await host.cdp.evaluate("document.querySelector('#analyze').disabled"),true,'batch must not start before explicit audio confirmation');
    for(let index=0;index<2;index++){
      await host.cdp.evaluate(`document.querySelectorAll('#recordings li')[${index}].querySelector('button').click()`);
      assert.equal(await host.cdp.evaluate("document.querySelectorAll('#tracks input').length"),2);
      assert.match(await host.cdp.evaluate("document.querySelector('#tracks').textContent"),/音轨 #1.*zho.*2 声道.*48000 Hz.*音轨 #2.*eng.*1 声道.*16000 Hz/s);
      assert.equal(await host.cdp.evaluate("document.querySelectorAll('#tracks input:checked').length"),0);
      await host.cdp.evaluate("document.querySelector('#tracks input[value=\"1\"]').click();document.querySelector('#confirm').click();");
      await host.cdp.until("document.querySelector('#selection').textContent.includes('已保存音轨 #1')&&!document.querySelector('#probe').disabled");
    }
    await host.cdp.evaluate("document.querySelector('#analyze').click()");
    await host.cdp.until("document.querySelectorAll('#result-list button').length===2&&!document.querySelector('#analyze').disabled",60000);
    const task=await currentTask(host.cdp);assert.equal(task.status,'completed');assert.equal(task.results.length,2);
    const results=[];for(const item of task.results)results.push(await request(host.cdp,'get_result',{result_id:item.result_id}));
    assert.deepEqual(results.map(result=>result.media.selected_audio.stream_index),[1,1]);
    assert.deepEqual(results.map(result=>result.prediction.runtime.model_reused),[false,true]);
    assert.deepEqual(results.map(result=>result.prediction.runtime.inference_index),[1,2]);
    assert.equal(results[0].prediction.runtime.engine_instance_id,results[1].prediction.runtime.engine_instance_id);
    await host.cdp.evaluate("document.querySelectorAll('#result-list button')[1].click()");
    await host.cdp.until(`document.querySelector('#result-source').textContent===${JSON.stringify(second)}&&!document.querySelector('#probe').disabled`);
    assert.equal(Number(await host.cdp.evaluate("document.querySelector('#score-end').value")),externalVideoDuration);
    await host.cdp.evaluate("document.querySelector('#threshold').value='1';document.querySelector('#parameters-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));");
    await host.cdp.until("document.querySelector('#result-summary').textContent.includes('没有枪声候选')&&!document.querySelector('#probe').disabled");
    assert.equal(await host.cdp.evaluate("document.querySelectorAll('#candidates input[type=checkbox]').length"),0);
    assert.equal(await host.cdp.evaluate("document.querySelector('#export').disabled"),true);
    const empty=await request(host.cdp,'get_result',{result_id:results[1].result_id});
    assert.equal(empty.prediction_id,results[1].prediction_id);assert.deepEqual(empty.selection,[]);
    const rejected=await host.cdp.evaluate(`window.apex.request('export',{result_id:${JSON.stringify(empty.result_id)},candidate_version:${JSON.stringify(empty.candidate_version)},output_dir:${JSON.stringify(path.join(folder,'empty-output'))}})`);
    assert.equal(rejected.error.code,'empty_selection');
    await host.cdp.evaluate("document.querySelector('#result').scrollIntoView({block:'start'})");await pause(150);await host.cdp.screenshot('packaged-real-multitrack-empty');
    const report={scope:'actual packaged Electron with real BEATs on controlled two-track 20s/requested12s-copy derivatives of the 540p sample; exact second duration independently measured by ffprobe; threshold1 empty result is a postprocessing scenario, not quality evidence',manifest,external_second_video_duration_s:externalVideoDuration,batch:task,
      results:results.map(result=>({result_id:result.result_id,source:result.media.source.path,audio_tracks:result.media.audio_tracks,selection:result.media.selected_audio,runtime:result.prediction.runtime})),empty_result:{result_id:empty.result_id,prediction_id:empty.prediction_id,candidates:empty.candidates,selection:empty.selection,error:rejected.error},status:'passed'};
    fs.writeFileSync(path.join(output,'batch-audit.json'),JSON.stringify(report,null,2));
    const tracked=runtimeProcesses(host.app.pid);await stop(host);host=null;await awaitGone(tracked);
    console.log('PASS actual packaged multi-track confirmation/batch real-model reuse/measured shorter result/empty-candidates and empty-export error');
  }finally{if(host)await stop(host);}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
