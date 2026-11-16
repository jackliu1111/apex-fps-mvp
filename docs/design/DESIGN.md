# Design System: Apex Local Cut (本地选片工作区)

## 1. Visual Theme & Atmosphere
A unified **Dark Tactical Broadcast & LosslessCut-Inspired Minimal NLE Workbench** engineered for FPS combat audio analysis and frame-accurate local video cutting, pairing LosslessCut's single-screen zero-clutter mental model with Apex Legends tactical telemetry.
- **Task & Queue Views (`#analysis-page`, `#exports-section`):** Deep obsidian slate canvas (`#0b0e14`) paired with gunmetal workbench cards (`#121721`, `10px` radius), dark frosted-glass sticky navigation (`rgba(11, 14, 20, 0.88)` with `backdrop-filter: blur(16px)`), crisp `1px` tactical hairlines (`#222b3a`), and high-visibility Apex Signal Amber-Orange actions (`#f97316 → #ea580c`). Redundant debug settings, JSON timing logs, workflow guides, and static specification drawers are removed; the 1-minute real combat demo (`#demo`, `.empty-demo-btn`) lives directly inline in the queue header and empty drop zone.
- **Single-Screen Clip Review Workbench (`#review-page`):** A single unified workbench card (`.review-workbench`) engineered for **zero vertical scrolling** at standard desktop viewports (`1440×900` and `1280×800`), consisting of:
  1. Compact single-row review header (`#back-analysis`, title, `#review-progress`, `#new-candidates`, `#source-select`).
  2. Dominant unobstructed `16:9` `.player-stage` (`#05070b`) with top-left frosted `#player-status` badge.
  3. Player-integrated **Global Scrub Bar** (`#player-overview-bar`, `18px`) docked between `.player-stage` and `.player-controls` (housing full-source playback progress, Telemetry Cyan/Amber candidate micro-markers, and a slate-white local viewport zoom frame `#prediction-source-window`).
  4. Unified single-row `.timeline-toolbar` + single `68px` zoomable **Main Timeline** (`#source-axis`, `#080b10` recessed well) overlaying progressive audio waveform (`#prediction-wave`), candidate interval blocks (`#overview-markers`), active Amber selection window with `18px`-hit-target trim handles (`#selection-left` / `#selection-right`), and playhead needle (`#source-head`). Permanent filmstrip tiles stay hidden (`#source-filmstrip[hidden]`) so waveform peaks stay crisp; hovering the track opens `#source-hover` with the closest reference keyframe and timestamp.
  5. Single-row bottom `.selection-actions` export summary & submission bar.

## 2. Color Palette & Roles
- **Obsidian Canvas Ground (`#0b0e14`):** Low-glare dark studio backdrop maximizing contrast on `16:9` gameplay footage and audio waveform peaks.
- **Gunmetal Workbench Surface (`#121721`), Recessed Wells (`#0d1119`), & Elevated Surface (`#181f2c`):** Layered dark slate surfaces with crisp `1px` hairlines (`#222b3a` / `#323e52`).
- **Recessed Instrument Track Well (`#080b10`):** Sunken timeline bed (`68px` tall) housing the progressive waveform (`--wave-bar: #7c93b0`), candidate overlays, and active trim handles.
- **Apex Signal Amber-Orange (`#f97316`, `#ea580c`, `#fb923c`):** Reserved for human intent & active editing (primary CTAs `+ 导入录像`, `提交选片导出`, `选择输出目录`, active clip selection overlay, trim handles, playhead, and active overview marker).
- **Telemetry Cyan (`#38bdf8`), Ready Emerald (`#10b981`), Alert Rose (`#f43f5e`), & Slate-White (`#e2e8f0`):** Telemetry Cyan highlights automatic gunshot candidates and secondary sample triggers; Emerald marks `✓ 已选导出` and completed analysis/export states; Rose marks `排除` and error states; Slate-White outlines the player scrub bar's local zoom viewport window (`#prediction-source-window`).

## 3. Typography Rules
- **Font Stack:** Clean geometric/neo-grotesk UI sans-serif (`"Inter"`, `-apple-system`, `"PingFang SC"`, `"Microsoft YaHei"`), paired with cross-platform tabular monospace (`"Menlo"`, `"Monaco"`, `"Consolas"`, `"Courier New"`, `monospace`, `font-variant-numeric: tabular-nums`) on timecodes and axis ticks.
- **Hierarchy:** Queue & Export Title `26px` bold (`letter-spacing: -0.025em`); Review Subheader Title `17px` bold; Body & Primary Controls `13px–14px`; Toolbar Chips & Axis Ticks `11.5px–12.5px`.

## 4. Direct Manipulation & Shortcuts
- **Zero-Drawer Core Loop:** All review decisions (`I` set start, `O` set end, `K` toggle keep for export, `N` add 5s manual clip, `Del` exclude, `Ctrl/Cmd+Z` undo, `Space` play/pause, `Shift+Space` audition clip, `[`/`]` step candidates, wheel zoom/pan, `Esc`/Fit All) execute directly via toolbar controls, track handles, and global shortcuts without opening secondary drawers.
- **Candidate Auto-Zoom:** Clicking any candidate block in `#overview-markers` or stepping with `[`/`]` smoothly zooms the single main track to ~3x clip neighborhood while highlighting that window on the player scrub bar.

## 5. Layout Principles
- Single-column unified workbench (`1280px` shell container) with strict vertical viewport budgeting on `#review-page` (`scrollHeight <= innerHeight` at `1440×900` and `1280×800`).
- Zero overlay of bottom game HUD in normal player view (`.player-dock` stays docked below `.player-stage`, transitioning to a centered auto-hiding frosted-glass capsule in fullscreen).
