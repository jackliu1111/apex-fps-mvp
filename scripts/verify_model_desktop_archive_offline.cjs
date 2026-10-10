/* Minimal relocated archive closure under a per-process deny-network profile. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {WorkerClient}=require('../desktop/worker-client.cjs');
const root=path.resolve(__dirname,'..');
const evidence=path.join(root,'outputs/desktop-archive-audit');
const location=JSON.parse(fs.readFileSync(path.join(evidence,'archive-fidelity.json')));
const runtime=path.join(location.extracted_app,'Contents/Resources/runtime');
const manifest=JSON.parse(fs.readFileSync(path.join(runtime,'manifest.json')));
const profile='(version 1)(allow default)(deny network*)';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function external(command,args){return new Promise((resolve,reject)=>{const child=spawn(command,args,{env:{...process.env,PATH:'/nonexistent'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal,stdout,stderr}));});}
async function networkProof(){
  const server=net.createServer(socket=>socket.once('data',()=>socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/`;
  try{
    const control=await external('/usr/bin/curl',['-sS','--max-time','2',url]);assert.equal(control.code,0);assert.equal(control.stdout,'ok');
    const denied=await external('/usr/bin/sandbox-exec',['-p',profile,'/usr/bin/curl','-sS','--max-time','2',url]);assert.notEqual(denied.code,0);assert.notEqual(denied.stdout,'ok');
    return{profile,control,denied,scope:'loopback probe proves per-process profile; global/user-machine network configuration unchanged'};
  }finally{await new Promise(resolve=>server.close(resolve));}
}
async function main(){
  assert.notEqual(process.getuid(),0,'ordinary-user evidence must not run as root');
  const network=await networkProof();
  console.log('per-process deny-network probe passed; global network unchanged');
  const dataDir=path.join(path.dirname(location.extracted_app),'用户数据 离线核对');
  const log=fs.createWriteStream(path.join(evidence,'offline-worker.log'));
  const client=new WorkerClient({command:'/usr/bin/sandbox-exec',args:['-p',profile,path.join(runtime,manifest.service),
    '--data-dir',dataDir,'--ffmpeg',path.join(runtime,manifest.ffmpeg),'--ffprobe',path.join(runtime,manifest.ffprobe),
    '--model-workspace',path.join(runtime,manifest.model_workspace),'--checkpoint',path.join(runtime,manifest.checkpoint)],onLog:value=>log.write(value)});
  const wait=async submitted=>{for(let i=0;i<1200;i++){const task=await client.execute('get_task',submitted);if(['completed','failed','cancelled'].includes(task.status))return task;await pause(50);}throw Error('relocated offline task timeout');};
  try{
    const config=await client.execute('get_config',{});
    assert.ok(config.model_workspace.startsWith(runtime));assert.ok(config.ffmpeg.startsWith(runtime));assert.equal(config.checkpoint_available,true);
    const media=await client.execute('probe_media',{path:process.env.APEX_SAMPLE||'/Users/jackliu/payload/sample-apex.mp4'});
    assert.equal(media.audio_tracks.length,1,'the fixed evidence sample has exactly one explicitly confirmed track');
    await client.execute('confirm_audio',{media_id:media.media_id,stream_index:media.audio_tracks[0].stream_index});
    const analyzed=await wait(await client.execute('analyze',{media_id:media.media_id}));assert.equal(analyzed.status,'completed',JSON.stringify(analyzed));
    const result=await client.execute('get_result',{result_id:analyzed.result_id});assert.equal(result.prediction.model.name,'BEATs_strong_1');assert.ok(result.candidates.length);
    const ref={result_id:result.result_id,candidate_version:result.candidate_version},candidate_id=result.candidates[0].candidate_id;
    const clips=result.candidates.map(candidate=>({candidate_id:candidate.candidate_id,selected:candidate.candidate_id===candidate_id,start_s:candidate.candidate_id===candidate_id?1:candidate.start_s,end_s:candidate.candidate_id===candidate_id?4:candidate.end_s}));
    await client.execute('update_selection',{...ref,clips});
    const preview=await wait(await client.execute('request_preview',{...ref,candidate_id}));assert.equal(preview.status,'completed',JSON.stringify(preview));
    const previewFile=await client.execute('get_artifact',{artifact_id:preview.preview_id});
    const exported=await wait(await client.execute('export',{...ref,mode:'copy',output_dir:path.join(evidence,'中文 离线导出')}));assert.equal(exported.status,'completed',JSON.stringify(exported));assert.equal(exported.exports.length,1);
    for(const artifact of[previewFile,...exported.exports]){
      const decoded=await external('/usr/bin/sandbox-exec',['-p',profile,path.join(runtime,manifest.ffmpeg),'-nostdin','-v','error','-xerror','-i',artifact.path,'-map','0:v','-map','0:a','-f','null','-']);assert.equal(decoded.code,0,decoded.stderr);
    }
    const report={status:'passed',uid:process.getuid(),user:os.userInfo().username,platform:process.platform,architecture:process.arch,extracted_app:location.extracted_app,data_dir:config.data_dir,config,archive_sha256:location.archive_sha256,
      network_proof:network,child_environment:{PATH:process.env.PATH},manifest,analysis:analyzed,result,preview,export:exported,decoded_files:[previewFile.path,...exported.exports.map(item=>item.path)],
      scope:'local ordinary UID501 relocated Chinese/space directory; per-process/children deny network; real fixed20s540p BEATs + one preview/one copy/export/decode; not a clean Mac or external Windows or human sync acceptance'};
    fs.writeFileSync(path.join(evidence,'relocated-offline-closure.json'),JSON.stringify(report,null,2));
    console.log('PASS archive relocated Chinese/space path, ordinary user, deny-network real BEATs+one preview/copy/export/full decode');
  }finally{await client.close();log.end();}
}
let completed=false;
process.on('beforeExit',()=>{if(!completed){console.error('Audit did not finish; no completion evidence generated');process.exitCode=1;}});
main().then(()=>{completed=true;}).catch(error=>{completed=true;console.error(error);process.exitCode=1;});
