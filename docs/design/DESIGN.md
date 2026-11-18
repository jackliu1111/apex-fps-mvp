# Design System: Apex Local Cut (本地选片工作区)

## 1. Visual Theme & Atmosphere
A **Monochrome Pure-White Rounded Workbench & LosslessCut-Inspired Minimal NLE** engineered for FPS combat audio analysis and frame-accurate local video cutting, pairing clean pure-white and neutral gray surfaces with crisp ink-black controls and an airy light-blue active timeline selection.
- **Task & Queue Views (`#analysis-page`, `#exports-section`):** Soft alabaster ground (`#f7f8fa`) paired with crisp pure-white rounded workbench cards (`#ffffff`, `16px` radius), frosted-white sticky navigation (`rgba(255, 255, 255, 0.88)` with `backdrop-filter: blur(16px)`), neutral pill navigation tabs (`#f3f4f6` active pill), hairline borders (`#e5e7eb`), and clean ink-black primary CTAs (`#18181b`).
- **Single-Screen Clip Review Workbench (`#review-page`):** A single unified pure-white rounded workbench card (`.review-workbench`) engineered for **zero vertical scrolling** at standard desktop viewports (`1440×900` and `1280×800`), consisting of:
  1. Compact single-row review header (`#back-analysis`, title, `#review-progress`, `#new-candidates`, `#source-select`).
  2. Clean rounded `16:9` `.player-stage` (`#141619`, `12px` radius) housing only the video canvas and translucent `#player-status` badge—keeping the transport dock below in crisp pure-white light surfaces so gameplay is framed cleanly without a heavy black block. (Fullscreen mode switches `.player-dock` to a centered auto-hiding dark frosted-glass capsule.)
  3. Light-surface **Global Scrub Bar** (`#player-overview-bar`, `18px`, `#f3f4f6` well) docked between `.player-stage` and `.player-controls` (housing peak-preserving full-source waveform & gunshot distribution `#player-overview-distribution`, full-source playback progress, cool-gray candidate micro-markers with translucent sky-blue active highlight `rgba(59, 130, 246, 0.24)` / `#3b82f6`, ink-slate viewport zoom frame `#prediction-source-window`, and crisp `#18181b` ink playhead needle).
  4. Unified single-row `.timeline-toolbar`, compact `.waveform-group-bar` 4-group visibility toggles (`#waveform-group-toggles`), and single `68px` zoomable **Main Timeline** (`#source-axis`, `#f5f6f8` light recessed well) overlaying progressive opaque neutral audio waveform (`#prediction-wave`, `--wave-bar: #7b8391`), non-softmax 4-group foreground layers (`>= 0.2` threshold cutoff, `<= 80ms` Q7 presentation-only gap bridging, `4px` minimum top-edge gunshot visibility floor), subtle neutral-mist candidate interval blocks (`#overview-markers`), airy sky-blue selection window (`rgba(59, 130, 246, 0.12)` + `#60a5fa` top / `1px` bottom rails and `18px`-hit-target trim handles `#selection-left` / `#selection-right`), and crisp `#18181b` playhead needle (`#source-head`). Permanent filmstrip tiles stay hidden (`#source-filmstrip[hidden]`) so waveform peaks stay crisp; hovering the track opens `#source-hover` with the timestamp, closest reference keyframe (when available), and all 4 raw group scores.
  5. Single-row bottom `.selection-actions` export summary & submission bar (`#fafafa`).

Footsteps are excluded from display because their frequent predictions overwhelm the timeline. The four display groups are gunshot, speech, music, and impact; this does not remove raw classes from the independent model experiment. Waveform bars use the smoothing and amplitude rules in [EfficientSED evaluation](efficientsed-evaluation.md#已确认规则与最终视觉参数).

## 2. Color Palette & Roles
- **Alabaster Ground (`#f7f8fa`) & Pure-White Workbench (`#ffffff`):** Clean neutral canvas lifting `16px`-rounded pure-white cards via subtle `1px` hairlines (`#e5e7eb`) and minimal ambient shadow (`rgba(0, 0, 0, 0.04)`), without background gradients or heavy chromatic fills.
- **Neutral Gray Wells (`#f3f4f6`, `#f5f6f8`) & Hairlines (`#e5e7eb`, `#d1d5db`):** Recessed timeline bed (`68px` tall) and secondary pill containers keeping the opaque neutral waveform (`--wave-bar: #7b8391`) razor-sharp across unanalyzed (blank), neutral below-threshold, and active layered states.
- **4-Group Non-Softmax Waveform Layers (Presentation Only):**
  - `Gunshot` (`top` outer edge downward, `>= 4 CSS px` low-amplitude floor): `#dc3b26` (`alpha: 0.96`; overview `0.92`)
  - `Speech` (`bottom` upward, `> 100°` clear of selection sky-blue): `#4e9c46` (`alpha: 0.64`)
  - `Music` (`bottom` upward): `#8868c8` (`alpha: 0.58`)
  - `Impact` (`bottom` upward): `#cf922c` (`alpha: 0.62`)
- **Ink Charcoal (`#18181b`, `#2c2c31`):** Reserved for primary action pills (`+ 导入录像`, `提交选片导出`, `选择输出目录`, `播放/暂停`), brand badge, and crisp playhead needles (`#source-head`, `#prediction-playhead`).
- **Airy Sky Blue (`rgba(59, 130, 246, 0.12)`, `#60a5fa`, `#2563eb`):** Reserved deliberately for the active clip selection window, trim handles, and active selection readout—keeping the overall UI monochrome and quiet while making the trimmed range effortless to spot.
- **Muted Status Semantics (`#16a34a` / `#ecfdf5`, `#dc2626` / `#fef2f2`, `#b45309`):** Kept-for-export and completed states use gentle green; exclude hover and failures use restrained red.

## 3. Typography Rules
- **Font Stack:** Clean geometric/neo-grotesk UI sans-serif (`"Inter"`, `-apple-system`, `"PingFang SC"`, `"Microsoft YaHei"`), paired with cross-platform tabular monospace (`"Menlo"`, `"Monaco"`, `"Consolas"`, `"Courier New"`, `monospace`, `font-variant-numeric: tabular-nums`) on timecodes and axis ticks.
- **Hierarchy:** Queue & Export Title `26px` semibold (`letter-spacing: -0.025em`); Review Subheader Title `17px` semibold; Body & Primary Controls `13px–14px`; Toolbar Chips & Axis Ticks `11.5px–12.5px`.

## 4. Direct Manipulation & Shortcuts
- **Zero-Drawer Core Loop:** All review decisions (`I` set start, `O` set end, `K` toggle keep for export, `N` add 5s manual clip, `Del` exclude, `Ctrl/Cmd+Z` undo, `Space` play/pause, `Shift+Space` audition clip, `[`/`]` step candidates, wheel zoom/pan, `Esc`/Fit All) execute directly via toolbar controls, track handles, and global shortcuts without opening secondary drawers.
- **Candidate Auto-Zoom:** Clicking any candidate block in `#overview-markers` or stepping with `[`/`]` smoothly zooms the single main track to ~3x clip neighborhood while highlighting that window on the player scrub bar.

## 5. Layout Principles
- Single-column unified workbench (`1280px` shell container) with strict vertical viewport budgeting on `#review-page` (`scrollHeight <= innerHeight` at `1440×900` and `1280×800`).
- Zero overlay of bottom game HUD in normal player view (`.player-dock` stays cleanly below `.player-stage` on pure white, transitioning to a centered auto-hiding dark frosted-glass capsule in fullscreen).
