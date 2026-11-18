(function () {
  const TRACK_PX_PER_SEC = 84;
  const WAVE_PATTERN = [
    16, 22, 28, 74, 94, 86, 48, 24, 18, 20, 24, 30,
    26, 34, 82, 98, 90, 68, 32, 20, 18, 22, 28, 36,
    44, 84, 96, 78, 42, 26, 20, 24
  ];

  const state = {
    lang: 'zh',
    duration: 14.12,
    currentTime: 0,
    playing: true,
    hasRealVideo: true,
    auditionEnd: null,
    objectUrl: null,
    isDraggingReel: false,
    lastFrameTs: performance.now(),
    clips: [
      { id: 1, start: 1.0, end: 4.2, score: 0.92, keep: true, labelZh: 'G7 侦察枪近距连射', labelEn: 'G7 Scout Burst' },
      { id: 2, start: 5.2, end: 9.1, score: 0.96, keep: true, labelZh: '红甲交火 · 连续枪声候选', labelEn: 'Close Combat Volley' },
      { id: 3, start: 10.4, end: 13.2, score: 0.78, keep: false, labelZh: '换弹与远处零星枪声', labelEn: 'Distant Gunfire' }
    ]
  };

  const els = {
    video: document.getElementById('hud-video'),
    canvas: document.getElementById('hud-sim-canvas'),
    viewport: document.getElementById('hud-viewport'),
    filename: document.getElementById('hud-filename'),
    sourceBadge: document.getElementById('hud-source-badge'),
    candidatePill: document.getElementById('hud-candidate-pill'),
    playBtn: document.getElementById('hud-play-btn'),
    muteBtn: document.getElementById('hud-mute-btn'),
    auditionBtn: document.getElementById('hud-audition-btn'),
    timecode: document.getElementById('hud-timecode'),
    meterFill: document.getElementById('hud-meter-fill'),
    scoreVal: document.getElementById('hud-score-val'),
    clipsList: document.getElementById('hud-clips-list'),
    clipCount: document.getElementById('hud-clip-count'),
    reelViewport: document.getElementById('game-reel-viewport'),
    reelTrack: document.getElementById('game-reel-track'),
    reelRuler: document.getElementById('reel-ruler'),
    reelFilmstrip: document.getElementById('reel-filmstrip'),
    reelCandidates: document.getElementById('reel-candidates'),
    reelWaveform: document.getElementById('reel-waveform'),
    loadVideoBtn: document.getElementById('hero-load-video'),
    fileInput: document.getElementById('local-video-input'),
    langToggle: document.getElementById('lang-toggle'),
    walkVideo: document.getElementById('walkthrough-video'),
    walkSteps: document.querySelectorAll('.walk-step')
  };

  const I18N = {
    zh: {
      page_title: 'Apex Local Cut · 像素动漫风本地游戏录像快剪入口',
      brand_tag: 'LOCAL EDITION',
      nav_preview: '实机与游戏轴',
      nav_walkthrough: '工作台演示',
      nav_compare: '本地 vs 云端',
      nav_features: '核心优势',
      nav_lab: '模型实验室',
      nav_cta: '▶ 打开选片工作台',
      hero_badge: 'PIXEL ANIME SHOWCASE · 100% 浏览器本地推理 · 零上传',
      hero_title: '导入整局 Apex 录像，<br>自动定位<span class="accent-pink">交火片段</span>并<span class="accent-blue">快速切出成片</span>',
      hero_desc: '无需上传几十 GB 的原视频 · 浏览器本地识别交火音频 · 时间轴预览微调后直接导出到本地文件夹',
      hero_primary_cta: '▶ 立即进入选片工作台',
      hero_try_local: '📁 拖入/选择你的本地录像预览',
      hero_secondary_cta: '🎬 观看 38s 全流程实录',
      format_local: '✓ 录像全程留在本机',
      format_theme: '✦ 快捷键帧级微调 (I / O / Space)',
      hud_source_demo: 'SIMULATION MODE',
      hud_source_real: 'REAL APEX FOOTAGE',
      hud_status: '● EfficientSED 40ms 步距',
      hud_view_badge: '当前视角 · 实机原片',
      hud_audition_btn: '🎧 试听当前候选',
      hud_score_label: '枪声预测分数',
      hud_clips_title: '枪声候选片段',
      hud_clips_note: '自动围绕枪声候选事件前后保留区间，点击卡片立即跳转复核，勾选决定是否加入导出批次：',
      hud_drop_hint: '💡 支持把你电脑里的任意 .mp4 / .mkv / .mov 拖进左侧播放器实时预览，或直接进入正式工作区完整分析',
      hud_open_full: '▶ 进入完整工作区开始剪辑 →',
      reel_title: '滚动游戏录像轴 · 关键帧抽样 + 枪声预测声波联动',
      layer_gunshot: '枪声候选',
      layer_select: '选片范围',
      layer_wave: '原片声波',
      reel_hint: '（点击或拖拽时间轴任意位置可寻道）',
      hud_keep: '✓ 保留选片',
      hud_skip: '× 排除片段',
      walk_title: '真实工作台全流程：从拖入长录像到成片落盘',
      walk_sub: '从拖入本地录屏、试听微调切点到批量导出成片，全程在浏览器本地完成',
      click_to_jump: '点击跳转演示 ↗',
      wstep1_title: '导入整场录像，后台边扫边出候选',
      wstep1_desc: '支持一次拖入多场 MP4 / MKV / MOV 录像自动排队。无需确认音轨，模型在后台流式解码并逐步浮现枪声候选片段。',
      wstep2_title: '点击候选自动放大 3 倍邻域，双轴精调切点',
      wstep2_desc: '点击任意候选区间，时间轴平滑聚焦至该片段约 3 倍视野；拖动左右手柄或按 I / O 键精确微调，按 Shift+Space 单独试听选片。',
      wstep3_title: '锁定导出批次，流式直写本地文件夹',
      wstep3_desc: '无需等待整场分析结束即可提前提交导出批次。通过浏览器原生目录授权，独立成片逐个直接写入你的硬盘目录。',
      comp_title: '吸收 FragCut 的快剪直觉，同时解决本地大文件痛点',
      comp_sub: '云端剪辑工具适合在线直播链接，而针对本机录制的几十 GB 高码率原盘，纯本地架构拥有天然优势',
      comp_cloud_tag: '传统云端 AI 剪辑站',
      comp_cloud_title: '上传等待久 · 切点黑盒难微调',
      comp_cloud_1: '❌ 动辄 10GB~30GB 的本地录屏需耗费数十分钟上传云端',
      comp_cloud_2: '❌ 免费额度受限，长对局或高频录屏受时长与排队限制',
      comp_cloud_3: '❌ 自动切片往往掐头去尾，缺少原片全局声波与上下文对照',
      comp_cloud_4: '❌ 生成十几个片段后需要逐个点击下载，文件管理繁琐',
      comp_local_tag: 'APEX LOCAL CUT · 本机工作台',
      comp_local_title: '零上传秒开 · 声画双轴自由掌控',
      comp_local_1: '✅ 0 字节上传：流式分块读取本地硬盘原片，几秒内直接开始分析',
      comp_local_2: '✅ 边扫边看：首个枪声候选出现即可进入复核，分析与选片并行推进',
      comp_local_3: '✅ 5 组声音图层 + 原片抽样帧：枪声、人声、脚步、音乐分层可视，0.1s 级裁边',
      comp_local_4: '✅ 原生目录直写：一次授权输出文件夹，批量成片自动落盘保存',
      features_title: '专为 FPS 玩家与创作者打磨的选片细节',
      feat1_title: '零上传，流式读取超大原录像',
      feat1_desc: '采用按需分块解复用与 WebCodecs 硬件加速解码，不把整份视频读入内存，几小时的 1080p/4K 录像也能稳定处理。',
      feat2_title: 'EfficientSED 40ms 逐帧枪声检测',
      feat2_desc: '围绕枪声候选事件自动保留前后 5 秒缓冲并连锁合并相邻交火；同时提供 EfficientAT 与 BEATs 模型切换与实验室对比。',
      feat3_title: '勾选与排除解耦，调参不丢进度',
      feat3_desc: '人工裁边、保留勾选与显式排除独立记录（支持 Ctrl/Cmd+Z 撤销重做）。即使重新调整检测阈值，你的手动决定也完好无损。',
      feat4_title: '保留原画规格，批量直写本地目录',
      feat4_desc: '默认沿用原视频分辨率与帧率导出 MP4（H.264 + AAC）或 WebM；中途取消导出也会完整保留已写入磁盘的成片。',
      cta_title: '准备好从下一场 Apex 录像里挑出精彩交火了吗？',
      cta_desc: '无需注册账号、无需安装客户端、无需上传视频，点击下方按钮立即进入浅色选片工作台。',
      cta_button: '▶ 立即进入选片工作台',
      cta_lab: '🔬 打开模型实验室',
      footer_disclaimer: '· 基于游戏音频自动识别交火区间，导出前请预览确认。',
      footer_workspace: '选片工作台',
      footer_lab: '模型实验室'
    },
    en: {
      page_title: 'Apex Local Cut · Pixel-Anime Local Gameplay Clipping Portal',
      brand_tag: 'LOCAL EDITION',
      nav_preview: 'Live HUD & Reel',
      nav_walkthrough: 'Walkthrough',
      nav_compare: 'Local vs Cloud',
      nav_features: 'Core Features',
      nav_lab: 'Model Lab',
      nav_cta: '▶ Open Workspace',
      hero_badge: 'PIXEL ANIME SHOWCASE · 100% ON-DEVICE INFERENCE · ZERO UPLOAD',
      hero_title: 'Import Full Apex Matches,<br>Auto-Locate <span class="accent-pink">Combat Clips</span> &amp; <span class="accent-blue">Export Fast</span>',
      hero_desc: 'No multi-GB cloud uploads · On-device combat audio detection · Trim on the timeline and save clips straight to disk',
      hero_primary_cta: '▶ Launch Clipping Workspace',
      hero_try_local: '📁 Preview Your Local Recording',
      hero_secondary_cta: '🎬 Watch 38s Full Walkthrough',
      format_local: '✓ Footage Stays on Device',
      format_theme: '✦ Keyboard Quick Trim (I / O / Space)',
      hud_source_demo: 'SIMULATION MODE',
      hud_source_real: 'REAL APEX FOOTAGE',
      hud_status: '● EfficientSED 40ms Step',
      hud_view_badge: 'Current View · Real Source',
      hud_audition_btn: '🎧 Audition Candidate',
      hud_score_label: 'Gunshot Score',
      hud_clips_title: 'Candidate Clips',
      hud_clips_note: 'Automatically padded around gunshot candidate events. Click a slot to seek, or toggle Keep/Skip for export:',
      hud_drop_hint: '💡 Drag any local .mp4 / .mkv / .mov onto the player to preview live, or launch the full workspace below',
      hud_open_full: '▶ Open Full Workspace →',
      reel_title: 'Scrolling Game Axis · Keyframe Filmstrip + Gunshot Prediction Wave',
      layer_gunshot: 'Gunshot Peak',
      layer_select: 'Selected Range',
      layer_wave: 'Source Waveform',
      reel_hint: '(Click or drag anywhere on the reel to scrub)',
      hud_keep: '✓ KEEP CLIP',
      hud_skip: '× EXCLUDED',
      walk_title: 'Real Workbench Walkthrough: From Import to Disk Export',
      walk_sub: 'From dropping local recordings to fine-tuning cut points and batch exporting—everything runs locally in your browser',
      click_to_jump: 'Jump to scene ↗',
      wstep1_title: 'Drop Full Match Recordings, Review While Analyzing',
      wstep1_desc: 'Queue multiple MP4 / MKV / MOV files at once. Gunshot candidates appear progressively as the model scans in the background.',
      wstep2_title: 'Auto-Zoom 3x Neighborhood & Trim on Dual Timeline',
      wstep2_desc: 'Click any candidate to zoom into a 3x context window. Drag handles or press I / O to fine-tune, and Shift+Space to audition.',
      wstep3_title: 'Lock Batch & Stream Directly to Local Folder',
      wstep3_desc: 'Submit export batches before analysis finishes. Standalone clips write straight to your chosen disk folder via native directory access.',
      comp_title: 'FragCut-Style Speed, Built for Multi-GB Local Recordings',
      comp_sub: 'Cloud clippers work well for short stream links, while on-device processing wins for massive raw gameplay files',
      comp_cloud_tag: 'Cloud AI Clippers',
      comp_cloud_title: 'Slow Uploads · Rigid Black-Box Cuts',
      comp_cloud_1: '❌ Uploading 10GB–30GB local recordings takes tens of minutes',
      comp_cloud_2: '❌ Strict free-tier quotas and server queue wait times',
      comp_cloud_3: '❌ Auto-cuts often clip too early or late without full waveform context',
      comp_cloud_4: '❌ Tedious one-by-one browser downloads for a dozen clips',
      comp_local_tag: 'APEX LOCAL CUT · ON-DEVICE',
      comp_local_title: 'Zero Upload · Full Timeline Control',
      comp_local_1: '✅ 0 Bytes Uploaded: Stream local files directly in seconds',
      comp_local_2: '✅ Review Immediately: Inspect early candidates while analysis runs',
      comp_local_3: '✅ 5 Audio Layers + Filmstrip: Gunshot, speech, footsteps & 0.1s trim',
      comp_local_4: '✅ Direct Folder Write: Batch save standalone clips straight to disk',
      features_title: 'Engineered for FPS Players & Creators',
      feat1_title: 'Zero Upload, Chunked Local Streaming',
      feat1_desc: 'Demuxes and decodes on demand via WebCodecs without loading entire multi-gigabyte files into memory.',
      feat2_title: 'EfficientSED 40ms Frame-Level Detection',
      feat2_desc: 'Pads 5s before/after gunshot events and chains nearby combat; switch between EfficientSED, EfficientAT, and BEATs.',
      feat3_title: 'Decoupled Keep & Exclude Decisions',
      feat3_desc: 'Manual trims, keep checkboxes, and exclusions persist across threshold recomputation with 100-step undo/redo.',
      feat4_title: 'Original Resolution Direct Folder Export',
      feat4_desc: 'Exports MP4 (H.264 + AAC) or WebM at native resolution and frame rate; cancelling keeps already-saved clips intact.',
      cta_title: 'Ready to cut your next Apex Legends recording?',
      cta_desc: 'No account, no installer, no cloud upload. Open the light clipping workspace right in your browser.',
      cta_button: '▶ Open Clipping Workspace',
      cta_lab: '🔬 Open Model Lab',
      footer_disclaimer: '· Combat segments are detected from game audio—preview before exporting.',
      footer_workspace: 'Workspace',
      footer_lab: 'Model Lab'
    }
  };

  function formatTime(sec) {
    const clamped = Math.max(0, sec);
    const mins = Math.floor(clamped / 60);
    const rem = clamped % 60;
    const mStr = String(mins).padStart(2, '0');
    const sStr = rem.toFixed(1).padStart(4, '0');
    return `${mStr}:${sStr}`;
  }

  function buildReel() {
    if (!els.reelTrack) return;
    const vpWidth = els.reelViewport ? els.reelViewport.clientWidth : 1100;
    const totalWidth = Math.max(vpWidth + 460, Math.round(state.duration * 116));
    els.reelTrack.style.width = `${totalWidth}px`;

    if (els.reelFilmstrip) {
      els.reelFilmstrip.style.backgroundSize = `${totalWidth}px 100%`;
    }

    els.reelRuler.innerHTML = '';
    const stepSec = state.duration > 60 ? 10 : 2;
    for (let t = 0; t <= state.duration; t += stepSec) {
      const tick = document.createElement('div');
      tick.className = 'reel-tick';
      tick.style.left = `${(t / state.duration) * 100}%`;
      tick.textContent = formatTime(t);
      els.reelRuler.appendChild(tick);
    }

    els.reelCandidates.innerHTML = '';
    state.clips.forEach((clip) => {
      const block = document.createElement('div');
      block.className = 'reel-candidate-block' + (clip.keep ? '' : ' is-excluded');
      block.dataset.clipId = String(clip.id);
      const leftPct = (clip.start / state.duration) * 100;
      const widthPct = Math.max(3, ((clip.end - clip.start) / state.duration) * 100);
      block.style.left = `${leftPct}%`;
      block.style.width = `${widthPct}%`;
      const badge = document.createElement('span');
      badge.textContent = `#0${clip.id} · ${clip.score.toFixed(2)}`;
      block.appendChild(badge);
      els.reelCandidates.appendChild(block);
    });

    els.reelWaveform.innerHTML = '';
    const barCount = Math.max(64, Math.round(totalWidth / 9));
    for (let i = 0; i < barCount; i++) {
      const t = (i / barCount) * state.duration;
      const base = WAVE_PATTERN[i % WAVE_PATTERN.length];
      const inClip = state.clips.find((c) => t >= c.start && t <= c.end);
      const pct = inClip ? Math.min(98, Math.max(58, base + 24)) : Math.min(40, base);
      const bar = document.createElement('div');
      bar.className = 'reel-bar' + (inClip && pct >= 70 ? ' is-hot' : pct >= 42 ? ' is-mid' : '');
      bar.style.height = `${pct}%`;
      els.reelWaveform.appendChild(bar);
    }
  }

  function renderClipsList() {
    if (!els.clipsList) return;
    const dict = I18N[state.lang];
    els.clipsList.innerHTML = '';
    if (els.clipCount) {
      const keepCount = state.clips.filter((c) => c.keep).length;
      els.clipCount.textContent = `${keepCount}/${state.clips.length} KEEP`;
    }

    state.clips.forEach((clip) => {
      const item = document.createElement('div');
      item.className = 'hud-clip-item';
      item.dataset.clipId = String(clip.id);

      const meta = document.createElement('div');
      meta.className = 'hud-clip-meta';

      const title = document.createElement('span');
      title.className = 'hud-clip-title';
      title.textContent = `#0${clip.id} · ${formatTime(clip.start)} – ${formatTime(clip.end)}`;

      const sub = document.createElement('span');
      sub.className = 'hud-clip-sub';
      const label = state.lang === 'zh' ? clip.labelZh : clip.labelEn;
      sub.textContent = `${label} · SCORE ${clip.score.toFixed(2)}`;

      meta.appendChild(title);
      meta.appendChild(sub);

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'hud-clip-tag ' + (clip.keep ? 'hud-clip-tag--keep' : 'hud-clip-tag--skip');
      toggleBtn.textContent = clip.keep ? dict.hud_keep : dict.hud_skip;
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clip.keep = !clip.keep;
        renderClipsList();
        buildReel();
      });

      item.appendChild(meta);
      item.appendChild(toggleBtn);
      item.addEventListener('click', () => {
        state.auditionEnd = null;
        seekTo(clip.start + 0.05);
      });
      els.clipsList.appendChild(item);
    });
  }

  function seekTo(sec) {
    const target = Math.max(0, Math.min(state.duration - 0.05, sec));
    state.currentTime = target;
    if (state.hasRealVideo && els.video && els.video.readyState >= 1) {
      els.video.currentTime = target;
    }
  }

  function recomputeDefaultClips(duration) {
    const d = Math.max(6, duration);
    state.clips = [
      { id: 1, start: +(d * 0.07).toFixed(1), end: +(d * 0.30).toFixed(1), score: 0.92, keep: true, labelZh: 'G7 侦察枪近距连射', labelEn: 'G7 Scout Burst' },
      { id: 2, start: +(d * 0.37).toFixed(1), end: +(d * 0.64).toFixed(1), score: 0.96, keep: true, labelZh: '红甲交火 · 连续枪声候选', labelEn: 'Close Combat Volley' },
      { id: 3, start: +(d * 0.74).toFixed(1), end: +(d * 0.93).toFixed(1), score: 0.78, keep: false, labelZh: '换弹与远处零星枪声', labelEn: 'Distant Gunfire' }
    ];
  }

  function loadVideoSrc(url, name, isBuiltIn) {
    if (state.objectUrl && state.objectUrl !== url) {
      URL.revokeObjectURL(state.objectUrl);
      state.objectUrl = null;
    }
    if (!isBuiltIn) {
      state.objectUrl = url;
    }

    els.video.src = url;
    els.video.classList.add('is-active');
    if (els.canvas) els.canvas.classList.add('is-hidden');
    state.hasRealVideo = true;

    if (els.filename) els.filename.textContent = name;
    if (els.sourceBadge) {
      els.sourceBadge.textContent = I18N[state.lang].hud_source_real;
    }

    els.video.addEventListener('loadedmetadata', function onMeta() {
      els.video.removeEventListener('loadedmetadata', onMeta);
      if (Number.isFinite(els.video.duration) && els.video.duration > 0) {
        state.duration = els.video.duration;
        recomputeDefaultClips(state.duration);
        renderClipsList();
        buildReel();
      }
      if (state.playing) {
        els.video.play().catch(() => {});
      }
    });
  }

  async function tryLoadServerDemo() {
    if (els.video && els.video.readyState >= 1 && Number.isFinite(els.video.duration) && els.video.duration > 0) {
      state.duration = els.video.duration;
      recomputeDefaultClips(state.duration);
      renderClipsList();
      buildReel();
    } else if (els.video) {
      els.video.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(els.video.duration) && els.video.duration > 0) {
          state.duration = els.video.duration;
          recomputeDefaultClips(state.duration);
          renderClipsList();
          buildReel();
        }
      }, { once: true });
    }

    try {
      const res = await fetch('/demo/manifest.json', { cache: 'no-store' });
      if (!res.ok) return;
      const manifest = await res.json();
      loadVideoSrc('/demo/recording.mp4', manifest.name || 'demo_recording.mp4', true);
    } catch {
      // Built-in demo-apex-clip.mp4 is already loaded
    }
  }

  function tick(ts) {
    const dt = Math.min(0.1, (ts - state.lastFrameTs) / 1000);
    state.lastFrameTs = ts;

    if (state.hasRealVideo && els.video && els.video.readyState >= 2) {
      state.currentTime = els.video.currentTime;
      if (els.video.duration) state.duration = els.video.duration;
      if (state.auditionEnd !== null && state.currentTime >= state.auditionEnd) {
        state.auditionEnd = null;
        els.video.pause();
        state.playing = false;
        if (els.playBtn) els.playBtn.textContent = '▶';
      }
    } else if (state.playing) {
      state.currentTime = (state.currentTime + dt) % state.duration;
    }

    if (els.timecode) {
      els.timecode.textContent = `${formatTime(state.currentTime)} / ${formatTime(state.duration)}`;
    }

    // Scroll game timeline reel smoothly while keeping track flush within viewport bounds
    if (els.reelViewport && els.reelTrack) {
      const vpWidth = els.reelViewport.clientWidth;
      const trackWidth = Math.max(vpWidth + 320, els.reelTrack.clientWidth || 1280);
      const px = (state.currentTime / state.duration) * trackWidth;
      const minTranslate = vpWidth - trackWidth;
      const translateX = Math.max(minTranslate, Math.min(0, vpWidth * 0.5 - px));
      const headPx = px + translateX;
      els.reelTrack.style.transform = `translate3d(${translateX.toFixed(1)}px, 0, 0)`;
      const playheadEl = els.reelViewport.querySelector('.game-reel-playhead');
      if (playheadEl) {
        playheadEl.style.left = `${headPx.toFixed(1)}px`;
      }
    }

    // Active candidate highlight & gunshot score meter
    const activeClip = state.clips.find((c) => state.currentTime >= c.start && state.currentTime <= c.end);
    if (els.candidatePill) {
      els.candidatePill.textContent = activeClip ? `CANDIDATE #0${activeClip.id}` : 'SCANNING AUDIO';
      els.candidatePill.classList.toggle('is-hot', Boolean(activeClip));
    }

    const baseWave = 0.18 + 0.12 * Math.sin(state.currentTime * 5.5);
    const liveScore = activeClip
      ? Math.min(0.99, activeClip.score - 0.05 + 0.05 * Math.abs(Math.sin(state.currentTime * 11)))
      : Math.max(0.06, baseWave);

    if (els.meterFill) els.meterFill.style.width = `${Math.round(liveScore * 100)}%`;
    if (els.scoreVal) els.scoreVal.textContent = liveScore.toFixed(2);

    document.querySelectorAll('.hud-clip-item').forEach((el) => {
      const isPlaying = activeClip && Number(el.dataset.clipId) === activeClip.id;
      el.classList.toggle('is-playing', Boolean(isPlaying));
    });
    document.querySelectorAll('.reel-candidate-block').forEach((el) => {
      const isActive = activeClip && Number(el.dataset.clipId) === activeClip.id;
      el.classList.toggle('is-active', Boolean(isActive));
    });

    requestAnimationFrame(tick);
  }

  function scrubFromClientX(clientX) {
    if (!els.reelViewport || !els.reelTrack) return;
    const rect = els.reelViewport.getBoundingClientRect();
    const vpWidth = els.reelViewport.clientWidth;
    const trackWidth = els.reelTrack.clientWidth || 1280;
    const currentPx = (state.currentTime / state.duration) * trackWidth;
    const minTranslate = vpWidth - trackWidth;
    const translateX = Math.max(minTranslate, Math.min(0, vpWidth * 0.5 - currentPx));
    const localX = clientX - rect.left;
    const targetPx = Math.max(0, Math.min(trackWidth, localX - translateX));
    state.auditionEnd = null;
    seekTo((targetPx / trackWidth) * state.duration);
  }

  function bindEvents() {
    if (els.playBtn) {
      els.playBtn.addEventListener('click', () => {
        state.auditionEnd = null;
        state.playing = !state.playing;
        els.playBtn.textContent = state.playing ? '❚❚' : '▶';
        if (state.hasRealVideo && els.video) {
          if (state.playing) els.video.play().catch(() => {});
          else els.video.pause();
        }
      });
    }

    if (els.muteBtn && els.video) {
      els.muteBtn.addEventListener('click', () => {
        els.video.muted = !els.video.muted;
        els.muteBtn.textContent = els.video.muted ? '🔇' : '🔊';
      });
    }

    if (els.auditionBtn) {
      els.auditionBtn.addEventListener('click', () => {
        const active = state.clips.find((c) => state.currentTime >= c.start && state.currentTime <= c.end) || state.clips[0];
        if (!active) return;
        state.auditionEnd = active.end;
        seekTo(active.start);
        state.playing = true;
        if (els.playBtn) els.playBtn.textContent = '❚❚';
        if (state.hasRealVideo && els.video) els.video.play().catch(() => {});
      });
    }

    if (els.reelViewport) {
      els.reelViewport.addEventListener('pointerdown', (e) => {
        state.isDraggingReel = true;
        scrubFromClientX(e.clientX);
      });
      window.addEventListener('pointermove', (e) => {
        if (!state.isDraggingReel) return;
        scrubFromClientX(e.clientX);
      });
      window.addEventListener('pointerup', () => {
        state.isDraggingReel = false;
      });
    }

    if (els.loadVideoBtn && els.fileInput) {
      els.loadVideoBtn.addEventListener('click', () => els.fileInput.click());
      els.fileInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) {
          const url = URL.createObjectURL(file);
          loadVideoSrc(url, file.name, false);
        }
      });
    }

    if (els.viewport) {
      els.viewport.addEventListener('dragover', (e) => {
        e.preventDefault();
        els.viewport.classList.add('is-dragover');
      });
      els.viewport.addEventListener('dragleave', () => {
        els.viewport.classList.remove('is-dragover');
      });
      els.viewport.addEventListener('drop', (e) => {
        e.preventDefault();
        els.viewport.classList.remove('is-dragover');
        const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) {
          const url = URL.createObjectURL(file);
          loadVideoSrc(url, file.name, false);
        }
      });
    }

    if (els.walkSteps && els.walkVideo) {
      els.walkSteps.forEach((step) => {
        step.addEventListener('click', () => {
          els.walkSteps.forEach((s) => s.classList.remove('is-active'));
          step.classList.add('is-active');
          const sec = Number(step.dataset.seek || 0);
          els.walkVideo.currentTime = sec;
          els.walkVideo.play().catch(() => {});
        });
      });
    }

    if (els.langToggle) {
      els.langToggle.addEventListener('click', () => {
        applyLang(state.lang === 'zh' ? 'en' : 'zh');
      });
    }
  }

  function applyLang(lang) {
    state.lang = lang;
    const dict = I18N[lang];
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (dict[key]) el.textContent = dict[key];
    });
    document.querySelectorAll('[data-i18n-html]').forEach((el) => {
      const key = el.getAttribute('data-i18n-html');
      if (dict[key]) el.innerHTML = dict[key];
    });
    if (els.sourceBadge) {
      els.sourceBadge.textContent = state.hasRealVideo ? dict.hud_source_real : dict.hud_source_demo;
    }
    if (els.langToggle) {
      els.langToggle.textContent = lang === 'zh' ? 'EN' : '中文';
    }
    renderClipsList();
  }

  renderClipsList();
  buildReel();
  bindEvents();
  tryLoadServerDemo();
  requestAnimationFrame(tick);
})();
