const $=id=>document.getElementById(id), video=$('video');
const initial=[[4,8],[18.2,20.1],[20.5,22.4],[23,24.6],[36,42],[51,56.5]];
let ranges=structuredClone(initial), excluded=[], active=-1, view=[0,60], predView=[0,60], position=19, ready=false, drag=null, past=[],future=[],peaks=[];
const time=t=>`${String(Math.floor(t/60)).padStart(2,'0')}:${(t%60).toFixed(1).padStart(4,'0')}`;
const percent=(t,v=view)=>(t-v[0])/(v[1]-v[0])*100;
const state=()=>structuredClone({ranges,excluded,active,view});
const restore=s=>{({ranges,excluded,active,view}=structuredClone(s));draw();};
const commit=before=>{if(JSON.stringify(before)===JSON.stringify(state()))return;past.push(before);future=[];draw();};
const say=text=>$('status').textContent=text;
function ticks(id,v){$(id).replaceChildren();for(let i=0;i<5;i++){const s=document.createElement('span');s.textContent=time(v[0]+(v[1]-v[0])*i/4);$(id).append(s);}}
function draw(){
 renderEvidence();
 $('clock').textContent=`${time(position)} / 01:00`;
 $('scope').textContent=view[0]===0&&view[1]===60?'全片':`局部 · ${time(view[0])} – ${time(view[1])}`;
 $('exit').hidden=active<0;$('range').hidden=active<0;
 $('head').hidden=position<view[0]||position>view[1];$('head').style.left=`${percent(position)}%`;
 for(const [id,n,min,max]of [['head',position,view[0],view[1]],['left',active<0?0:ranges[active][0],0,active<0?60:ranges[active][1]-.1],['right',active<0?60:ranges[active][1],active<0?0:ranges[active][0]+.1,60]]){for(const [k,v]of [['now',n],['min',min],['max',max],['text',time(n)]])$(id).setAttribute(`aria-value${k}`,v);}
 if(active>=0){const [a,b]=ranges[active];$('range').style.left=`${percent(a)}%`;$('range').style.width=`${percent(b)-percent(a)}%`;$('edit-info').textContent=`片段 ${active+1}　起点 ${time(a)}　终点 ${time(b)}　时长 ${(b-a).toFixed(1)} 秒`;}
 else $('edit-info').textContent='拖动播放头浏览原片';
 ticks('ticks',view);$('delete').disabled=active<0||excluded.includes(active);$('undo').disabled=!past.length;$('redo').disabled=!future.length;
 $('prediction-summary').textContent=`${ranges.length-excluded.length} 段保留 · ${excluded.length} 段已排除`;
 document.querySelectorAll('#pred-axis button').forEach((b,i)=>{const [a,end]=ranges[i],lo=Math.max(a,predView[0]),hi=Math.min(end,predView[1]);b.hidden=hi<=lo||(excluded.includes(i)&&!$('show-excluded').checked);b.className=excluded.includes(i)?'excluded':'';b.style.left=`${percent(lo,predView)}%`;b.style.width=`${(hi-lo)/(predView[1]-predView[0])*100}%`;b.setAttribute('aria-pressed',String(active===i));b.setAttribute('aria-label',`${excluded.includes(i)?'恢复已排除':'选择预测'}片段 ${i+1}，${time(a)} 至 ${time(end)}`);b.title=`片段 ${i+1} · ${time(a)}–${time(end)}${excluded.includes(i)?' · 点击恢复':''}${JSON.stringify(ranges[i])!==JSON.stringify(initial[i])?' · 已调整，原预测 '+time(initial[i][0])+'–'+time(initial[i][1]):''}`;});
}
function seek(t){position=Math.max(0,Math.min(60,t));if(ready)video.currentTime=position;draw();}
function select(i){if(excluded.includes(i)){const before=state();excluded=excluded.filter(n=>n!==i);commit(before);say(`已恢复片段 ${i+1}`);return;}active=i;video.pause();const [a,b]=ranges[i];view=[Math.max(0,a-3),Math.min(60,b+3)];seek(a);say(`片段 ${i+1} · 可拖动左右边界；Del 排除选中区间。`);}
ranges.forEach((r,i)=>{const b=document.createElement('button');b.textContent=String(i+1);b.onclick=()=>select(i);$('pred-axis').append(b);});
function pointerTime(e,element,bounds){const rect=element.getBoundingClientRect();return Math.max(bounds[0],Math.min(bounds[1],bounds[0]+(e.clientX-rect.left)/rect.width*(bounds[1]-bounds[0])));}
function change(kind,t){if(kind==='head'){seek(t);return;}const idx=kind==='left'?0:1,other=ranges[active][1-idx];t=Math.round(Math.max(0,Math.min(60,t))*10)/10;ranges[active][idx]=idx===0?Math.min(other-.1,t):Math.max(other+.1,t);seek(ranges[active][idx]);}
for(const id of ['head','left','right']){const el=$(id);el.onpointerdown=e=>{e.preventDefault();e.stopPropagation();el.focus();video.pause();drag={id,before:state()};el.setPointerCapture(e.pointerId);};el.onpointermove=e=>{if(drag?.id===id)change(id,pointerTime(e,$('play-axis'),view));};el.onpointerup=e=>{if(drag?.id!==id)return;change(id,pointerTime(e,$('play-axis'),view));const before=drag.before;drag=null;el.releasePointerCapture(e.pointerId);if(id!=='head')commit(before);};el.onpointercancel=()=>{if(drag){const before=drag.before;drag=null;restore(before);}};el.onkeydown=e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();const before=state();video.pause();change(id,(id==='head'?position:ranges[active][id==='left'?0:1])+(e.key==='ArrowLeft'?-1:1)*(e.shiftKey?1:.1));if(id!=='head')commit(before);};}
$('play-axis').onclick=e=>{if(e.target===$('play-axis')){document.querySelector('.player').focus({preventScroll:true});video.pause();seek(pointerTime(e,$('play-axis'),view));}};
$('delete').onclick=()=>{if(active<0||drag)return;const before=state(),id=active;excluded.push(id);active=-1;commit(before);document.querySelector('.predictions').focus({preventScroll:true});say(`已排除片段 ${id+1}。原片和其他区间时间不变，可撤销。`);};
$('undo').onclick=()=>{if(!past.length||drag)return;future.push(state());restore(past.pop());say('已撤销上一次选片修改。');};$('redo').onclick=()=>{if(!future.length||drag)return;past.push(state());restore(future.pop());say('已重做选片修改。');};
$('exit').onclick=()=>{active=-1;view=[0,60];draw();say('已退出区间编辑。');};
document.onkeydown=e=>{if(e.target.matches('input,textarea,select,[contenteditable]')||!e.target.closest('.player,.predictions'))return;if(e.key==='Escape'){e.preventDefault();if(drag){const before=drag.before;drag=null;restore(before);}else $('exit').click();return;}if(drag)return;if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();$(e.shiftKey?'redo':'undo').click();}else if(['Delete','Backspace'].includes(e.key)){e.preventDefault();$('delete').click();}else if(e.code==='Space'&&!e.target.matches('button')){e.preventDefault();$('play').click();}};
$('reset').onclick=()=>{video.pause();ranges=structuredClone(initial);excluded=[];active=-1;view=[0,60];predView=[0,60];past=[];future=[];seek(19);renderPrediction();say('已恢复示例。');};
$('show-excluded').onchange=draw;
function renderPrediction(){
 ticks('pred-ticks',predView);$('pred-window').textContent=`${time(predView[0])} – ${time(predView[1])}`;
 $('zoom-in').disabled=predView[1]-predView[0]<=6;$('zoom-out').disabled=predView[1]-predView[0]>=60;$('pan-left').disabled=predView[0]<=0;$('pan-right').disabled=predView[1]>=60;
 draw();
}
let evidenceKey='';
function renderEvidence(){
 const key=JSON.stringify([view,$('filmstrip').clientWidth,peaks.length]);if(key===evidenceKey)return;evidenceKey=key;
 $('filmstrip').replaceChildren();const count=Math.max(3,Math.floor($('filmstrip').clientWidth/100));for(let i=0;i<count;i++){const t=view[0]+i/count*(view[1]-view[0]),sample=Math.min(55,Math.floor(t/5)*5),img=document.createElement('img');img.src=`media/frame-${sample}.jpg`;img.alt=`采样画面 ${time(sample)}`;$('filmstrip').append(img);}
 const canvas=$('waveform'),w=canvas.clientWidth,h=48,ratio=devicePixelRatio||1;canvas.width=w*ratio;canvas.height=h*ratio;const ctx=canvas.getContext('2d');ctx.scale(ratio,ratio);ctx.fillStyle='#b4b4b4';for(let x=0;x<w;x+=2){const start=Math.floor((view[0]+x/w*(view[1]-view[0]))*10),end=Math.ceil((view[0]+(x+2)/w*(view[1]-view[0]))*10);const peak=Math.max(0,...peaks.slice(start,end)),height=peak*44;ctx.fillRect(x,(h-height)/2,1,height);}
}
function zoom(factor){const span=Math.max(6,Math.min(60,(predView[1]-predView[0])*factor));const anchor=active>=0?(ranges[active][0]+ranges[active][1])/2:position;const left=Math.max(0,Math.min(60-span,anchor-span/2));predView=[left,left+span];renderPrediction();}
$('zoom-in').onclick=()=>zoom(.5);$('zoom-out').onclick=()=>zoom(2);$('fit-all').onclick=()=>{predView=[0,60];renderPrediction();};for(const [id,dir]of [['pan-left',-1],['pan-right',1]])$(id).onclick=()=>{const span=predView[1]-predView[0],left=Math.max(0,Math.min(60-span,predView[0]+dir*span/2));predView=[left,left+span];renderPrediction();};
for(const id of ['filmstrip','waveform']){const el=$(id);el.onpointermove=e=>{if(e.pointerType==='touch'||drag)return;const t=pointerTime(e,el,view),sample=Math.min(55,Math.floor(t/5)*5);$('hover-image').src=`media/frame-${sample}.jpg`;$('hover-time').textContent=`指向 ${time(t)} · 附近采样 ${time(sample)}`;$('hover-preview').hidden=false;};el.onpointerleave=()=>$('hover-preview').hidden=true;el.onclick=e=>{document.querySelector('.player').focus({preventScroll:true});video.pause();seek(pointerTime(e,el,view));};}
$('play').onclick=async()=>{try{video.paused?await video.play():video.pause();}catch{say('样本暂时无法播放。');}};video.onplay=()=>$('play').textContent='暂停';video.onpause=()=>$('play').textContent='播放';video.ontimeupdate=()=>{if(!ready)return;position=video.currentTime;if(!video.paused&&(position>view[1]||position<view[0]))view=[0,60];draw();};video.onloadedmetadata=()=>{ready=true;seek(19);};
new ResizeObserver(renderEvidence).observe($('filmstrip'));draw();renderPrediction();
fetch('media/waveform.json').then(r=>r.json()).then(data=>{peaks=data.peaks;renderEvidence();}).catch(()=>say('音频波形暂时不可用，仍可播放与裁剪。'));
(async()=>{try{const res=await fetch('/demo/recording.mp4');if(!res.ok||Number(res.headers.get('content-length'))>64*1024*1024)throw Error();const url=URL.createObjectURL(await res.blob());video.src=url;$('play').disabled=false;addEventListener('pagehide',()=>URL.revokeObjectURL(url),{once:true});}catch{say('样本不可用；仍可体验区间选择与拖动。');}})();
