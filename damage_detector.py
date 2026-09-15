"""Local damage-counter recognition; no network or model runtime."""
import json
import math
from pathlib import Path
import numpy as np
from media_runtime import media_process
from apex_highlight import Clip

METHODS = ('white_180', 'gray_otsu', 'white_otsu')

from damage_templates import TEMPLATES, ICON_TEMPLATES
BANKS = {m: {n: np.unpackbits(np.frombuffer(bytes.fromhex(TEMPLATES[f'{m}_{n}']), dtype=np.uint8))[:600].reshape(30,20).astype(bool)
             for n in range(10)} for m in METHODS}
ICONS = [np.frombuffer(bytes.fromhex(s),np.uint8).reshape(19,32).astype(float) for s in ICON_TEMPLATES]

def icon_score(frame):
    strip=frame[20:58:2,:106:2].mean(2)
    windows=np.lib.stride_tricks.sliding_window_view(strip,(19,32))[0]
    centered=windows-windows.mean((1,2),keepdims=True)
    denom=np.sqrt((centered**2).sum((1,2)))
    scores=[]
    for icon in ICONS:
        t=icon-icon.mean()
        scores.append(np.max((centered*t).sum((1,2))/np.maximum(denom*np.sqrt((t*t).sum()),1e-9)))
    return float(max(scores))

def read_counter(frame):
    if icon_score(frame)<.6:return None
    votes={classify(frame,m,BANKS[m]) for m in METHODS}-{None}
    return next(iter(votes)) if len(votes)==1 else None

def boxmean(a, size=15):
    pad=size//2
    b=np.pad(a,((pad,pad),(pad,pad)),mode='reflect')
    s=np.pad(b,((1,0),(1,0))).cumsum(0).cumsum(1)
    return (s[size:,size:]-s[:-size,size:]-s[size:,:-size]+s[:-size,:-size])/(size*size)

def otsu(a):
    h=np.bincount(a.astype(np.uint8).ravel(),minlength=256).astype(float)
    p=h/h.sum();w=p.cumsum();mu=(p*np.arange(256)).cumsum()
    score=(mu[-1]*w-mu)**2/np.maximum(w*(1-w),1e-10)
    return int(np.argmax(score))

def binary(frame,method):
    rgb=frame[24:55,0:160].astype(float)
    low=rgb.min(2);gray=rgb.mean(2);chroma=rgb.max(2)-low
    if method.startswith('white_') and method.split('_')[1].isdigit():
        return (low>int(method.split('_')[1]))&(chroma<75)
    if method=='gray_otsu':return gray>otsu(gray)
    if method=='white_otsu':return (low>max(140,otsu(low)))&(chroma<75)
    if method=='adaptive':return (gray>boxmean(gray)+12)&(low>140)&(chroma<75)
    raise ValueError(method)

def normalize(m):
    # Discard isolated first/last rows before resizing the glyph. Four pixels
    # is calibrated at the fixed 4K ROI scale, not a cross-resolution constant.
    ys=np.flatnonzero(m.sum(1)>=4)
    if not len(ys):return None
    m=m[ys[0]:ys[-1]+1]
    ys,xs=np.where(m)
    if len(xs)<8:return None
    m=m[ys.min():ys.max()+1,xs.min():xs.max()+1]
    return m[np.linspace(0,len(m)-1,30).astype(int)[:,None],
             np.linspace(0,m.shape[1]-1,20).astype(int)[None,:]]

def glyphs(f,method):
    full=binary(f,method)
    def split(m,wide=False):
        cols=np.flatnonzero(m.sum(0)>2)
        if not len(cols):return []
        runs=np.split(cols,np.where(np.diff(cols)>1)[0]+1)
        out=[]
        for run in reversed(runs) if wide else runs:
            if wide and run[0]==0:break
            if not wide and run[0]==0:continue
            if not 6<=len(run)<=21:
                if wide:break
                return []
            g=normalize(m[:,run[0]:run[-1]+1])
            if g is None:return []
            out.append(g)
        return list(reversed(out)) if wide else out
    expanded=split(full,True)
    if 4<=len(expanded)<=5:return expanded
    normal=split(full[:,80:])
    return normal if 1<=len(normal)<=3 else []


def classify(f,method,bank):
    gs=glyphs(f,method)
    if not gs:return None
    digits=[]
    for g in gs:
        scores=sorted([(float((g&t).sum()/max(1,(g|t).sum())),n) for n,t in bank.items()],reverse=True)
        if scores[0][0]<.68 or scores[0][0]-scores[1][0]<.05:return None
        digits.append(scores[0][1])
    return int(''.join(map(str,digits)))

class CounterTracker:
    """Only confirmed increases; no inferred transition across unreadable HUD."""
    def __init__(self):
        self.baseline=None
        self.pending=None
        self.pending_time=None
        self.repeats=0

    def update(self, time, value):
        if value is None:
            self.baseline=None;self.pending=None;self.repeats=0
            return None
        if self.pending==value:self.repeats+=1
        else:self.pending=value;self.pending_time=time;self.repeats=1
        if self.repeats!=2:return None
        previous=self.baseline
        self.baseline=value
        if previous is not None and value>previous:
            return {'time':round(self.pending_time,6),'previous':previous,'value':value,'increase':value-previous}
        return None


def make_clips(events,duration,gap=.3,before=.1,after=.2,fps=30):
    groups=[]
    for e in events:
        t=e['time']
        if groups and t-groups[-1][-1]['time']<=gap+1e-8:groups[-1].append(e)
        else:groups.append([e])
    clips=[]
    for g in groups:
        a,b=g[0]['time'],g[-1]['time']
        c=Clip(max(0,a-before),min(duration,max(b+after,a+1/fps)),a,b,len(g),0.)
        if c.end<=c.start:continue
        if clips and c.start<=clips[-1].end+1e-8:
            clips[-1].end=max(clips[-1].end,c.end)
            clips[-1].raw_end=b;clips[-1].event_count+=len(g)
        else:clips.append(c)
    return clips


def analyze_video(source,media,*,fps=30,gap=.3,before=.1,after=.2,progress=None):
    video=next((s for s in media['streams'] if s['codec_type']=='video'),None)
    if not video:raise ValueError('录像缺少视频轨道')
    if abs(video['width']/video['height']-16/9)>.02:
        raise ValueError('伤害模式暂只支持完整 16:9 游戏画面及默认 HUD')
    command=['ffmpeg','-v','error','-i',str(source),'-an','-vf',
        f'fps={fps}:start_time=0,crop=iw*200/3840:ih*90/2160:iw*3320/3840:ih*175/2160,scale=200:90',
        '-pix_fmt','rgb24','-f','rawvideo','-']
    tracker=CounterTracker();events=[];readings=[];count=0;valid=0
    total=math.ceil(media['duration_seconds']*fps)
    with media_process(command) as process:
        while True:
            raw=process.stdout.read(200*90*3)
            if not raw:break
            if len(raw)!=200*90*3:raise RuntimeError('伤害分析的视频帧不完整')
            frame=np.frombuffer(raw,np.uint8).reshape(90,200,3)
            value=read_counter(frame);time=count/fps
            event=tracker.update(time,value)
            if value is not None:valid+=1
            if event:events.append(event)
            # Preserve unknown transitions and source-time evidence for review.
            if not readings or readings[-1]['value']!=value:
                readings.append({'time':round(time,6),'value':value})
            count+=1
            if progress and count%fps==0:progress('识别伤害数字',count,total)
    stats={'sampled_frames':count,'readable_frames':valid,'unreadable_frames':count-valid,
           'sampling_fps':fps,'timestamp_basis':'sampling_grid_from_video_start',
           'warnings':['未读出数字的画面可能是 HUD 未显示、遮挡或识别失败；空白不按零处理。']}
    if valid==0:stats['warnings'].append('没有可靠读出伤害数字，请检查 HUD 布局和录像清晰度。')
    return events,make_clips(events,media['duration_seconds'],gap,before,after,fps),readings,stats
