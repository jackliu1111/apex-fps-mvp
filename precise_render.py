"""Frame-aligned re-encoding and numbered local previews using bundled FFmpeg."""
import math
from fractions import Fraction
from pathlib import Path
import numpy as np
from media_runtime import run_command
from apex_highlight import probe_media, concat_quote

DIGITS=['111101101101111','010110010010111','111001111100111',
        '111001111001111','101101111001001','111100111001111',
        '111100111101111','111001001001001','111101111101111','111101111001111']

def label_image(path,number):
    text=str(number);canvas=np.full((42,len(text)*24+16,3),20,np.uint8)
    for i,c in enumerate(text):
        mask=np.array(list(DIGITS[int(c)]),dtype='U1').reshape(5,3)=='1'
        pixels=mask.repeat(6,0).repeat(6,1)
        canvas[6:36,8+i*24:26+i*24][pixels]=[255,230,80]
    path.write_bytes(f'P6\n{canvas.shape[1]} {canvas.shape[0]}\n255\n'.encode()+canvas.tobytes())

def render(source,clips,output,work,progress=None,preview_ids=None):
    media=probe_media(source)
    video=next(s for s in media['streams'] if s['codec_type']=='video')
    fps=Fraction(video['r_frame_rate'])
    if fps<=0:raise ValueError('无法确定视频帧率')
    rate=float(fps)
    work.mkdir(parents=True,exist_ok=True)
    segments=[];actual=[]
    for index,c in enumerate(clips):
        first=math.ceil(c.start*rate-1e-4);last=max(first+1,math.ceil(c.end*rate-1e-4))
        start=first/rate;duration=(last-first)/rate
        segment=work/f'clip_{index:05}.nut'
        cmd=['ffmpeg','-v','error','-y','-ss',f'{start:.9f}','-i',str(source)]
        vf=f'trim=duration={duration:.9f},setpts=PTS-STARTPTS'
        if preview_ids is not None:
            label=work/f'label_{index}.ppm';label_image(label,preview_ids[index])
            cmd+=['-i',str(label)]
            vf+=',scale=-2:720'
            cmd+=['-filter_complex',f'[0:v]{vf}[v];[v][1:v]overlay=20:20:repeatlast=1[out]',
                  '-map','[out]']
        else:cmd+=['-vf',vf,'-map','0:v:0']
        cmd+=['-map','0:a:0','-af',f'atrim=duration={duration:.9f},asetpts=PTS-STARTPTS,apad=whole_dur={duration:.9f}',
              '-t',f'{duration:.9f}','-r',str(fps),'-fps_mode','cfr',
              '-c:v','mpeg4','-q:v','3','-pix_fmt','yuv420p','-c:a','pcm_s16le',str(segment)]
        run_command(cmd)
        segments.append(segment)
        actual.append({'start':start,'end':start+duration,'frames':last-first})
        if progress:progress('生成编号预览' if preview_ids is not None else '精确裁剪',index+1,len(clips))
    listing=work/'concat.txt'
    listing.write_text(''.join(f'file {concat_quote(p.resolve())}\nduration {a["end"]-a["start"]:.9f}\n' for p,a in zip(segments,actual)))
    if progress:progress('合并并编码音频',0,None)
    run_command(['ffmpeg','-v','error','-y','-f','concat','-safe','0','-i',str(listing),
                 '-map','0:v:0','-map','0:a:0','-c:v','copy','-c:a','aac','-b:a','192k',
                 '-movflags','+faststart',str(output)])
    return {'video_codec':'mpeg4','audio_codec':'aac','fps':str(fps),'rendered_intervals':actual}
