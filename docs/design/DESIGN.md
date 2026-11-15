# Design System: Apex Local Cut (本地选片工作区)

## 1. Visual Theme & Atmosphere
A unified **Dark Tactical Broadcast & Precision NLE Studio Workbench** engineered for FPS combat audio analysis and frame-accurate local video cutting, inspired by professional non-linear editors (DaVinci Resolve Cut Page, Frame.io) and Apex Legends tactical broadcast telemetry.
- **Task & Queue Views (`#analysis-page`, `#exports-section`):** Deep obsidian slate canvas (`#0b0e14` with subtle radial tactical amber and telemetry cyan ambient lighting) paired with gunmetal workbench cards (`#121721`, `10px` radius), dark frosted-glass sticky navigation (`rgba(11, 14, 20, 0.86)` with `backdrop-filter: blur(16px)`), crisp `1px` tactical hairlines (`#232c3d`), and high-visibility Apex Signal Amber-Orange actions (`#f97316 → #ea580c`).
- **Clip Review Studio (`#review-page`):** A dark cinema NLE workbench pairing an unobstructed `16:9` `.player-stage` (`#05070b`) and a docked below-canvas `.player-controls` bar (which transitions to an auto-hiding floating glass bar in `:fullscreen`) over two precision `64px` recessed instrument timeline tracks (`#080b10` with subtle `16px × 16px` grid lines).

## 2. Color Palette & Roles
- **Obsidian Canvas Ground (`#0b0e14`):** Low-glare dark studio backdrop that maximizes perceived contrast on `16:9` gameplay footage and audio waveform peaks.
- **Gunmetal Workbench Surface (`#121721`), Recessed Wells (`#0d1119`), & Elevated Surface (`#181f2c`):** Layered dark slate surfaces with subtle top specular highlights (`inset 0 1px 0 rgba(255, 255, 255, 0.04)`) and deep elevation shadows.
- **Recessed Instrument Track Well (`#080b10`):** Precision sunken timeline bed featuring subtle grid subdivisions and inner shadow (`inset 0 2px 6px rgba(0, 0, 0, 0.65)`) for the `64px`-tall source and prediction tracks.
- **Unobstructed Video Stage (`#05070b`):** Pure dark cinema stage housing `#source-canvas` and the top-left frosted `#player-status` badge while keeping `.player-controls` docked cleanly below the video frame in normal view.
- **Structural Hairlines (`#232c3d` & `#313d52`):** Crisp `1px` technical borders separating cards, headers, segmented HUD transport zones, and queue rows.
- **Primary Crisp Alabaster Ink (`#f1f5f9`):** High-contrast cool white for headings, timecodes, active navigation, and primary figures.
- **Secondary Tactical Slate (`#94a3b8`) & Muted Meta (`#64748b`):** Used for timestamps, axis ticks, and technical notes.
- **Apex Signal Amber-Orange (`#f97316`, `#ea580c`, `#fb923c`):** Primary brand and active edit accent used for primary action buttons (`+ 导入录像`, `提交选片导出`, `选择输出目录`), active navigation indicators, active selection windows, playhead needles, and tactile trim handles.
- **Telemetry Cyan (`#38bdf8`), Ready Emerald (`#10b981`), & Alert Rose (`#f43f5e`):** Telemetry Cyan highlights automatic gunshot candidate blocks and audio waveform energy; Emerald marks completed analysis/export states and selected export badges; Rose marks exclude/delete actions and error states.

## 3. Typography Rules
- **Font Stack:** Clean geometric/neo-grotesk UI sans-serif (`"Inter"`, `-apple-system`, `"PingFang SC"`, `"Microsoft YaHei"`), paired with monospace tabular numerals (`"JetBrains Mono"`, `"SFMono-Regular"`, `font-variant-numeric: tabular-nums`) on all timecodes, durations, and byte counts.
- **Hierarchy:** Queue & Export Title `26px` bold (`letter-spacing: -0.025em`); Review Studio Subheader Title `18px` bold; Section Heading `13px–16px` semibold; Body & Controls `13px`; Axis Ticks & Technical Meta `11px–12px`.

## 4. Component Stylings & Direct Manipulation
- **Primary Tactical Buttons (`#import-files`, `#export`, `#choose-directory`):** `36px–38px` height, `6px` precision radius, signal amber-orange gradient fill (`linear-gradient(180deg, #f97316 0%, #ea580c 100%)`), dark-shadowed white text, and subtle top inner specular highlight.
- **Direct NLE Quick Controls (`.axis-head-actions`, `.prediction-tools-left`):** Always-visible one-click `[ 设为起点` (`I`), `设为终点 ]` (`O`), and `适配片段` buttons on the source axis header, plus a direct `加入导出 / 已加入导出` (`K`) toggle pill and `+ 手动片段` (`N`) action on the overview toolbar—eliminating the need to open disclosure drawers for core editing actions.
- **Dual-Color Semantic Timeline & Tactile Handles:** Overview candidate blocks render in Telemetry Cyan (`#38bdf8`) while the active editing selection window and `18px`-wide precision grip handles render in Signal Amber-Orange (`#f97316`), updating `#range-start`, `#range-end`, and `#range-label` in real time during handle drags.

## 5. Layout Principles
- Single-column aligned edges (`1120px` max width in Review Studio, `1280px` shell container).
- Strict dual-timeline geometry: `.source-axis` and `.prediction-shared-axis` maintain identical horizontal margins (`16px` panel padding + `12px` axis margin) and exact `64px` track heights beneath the `16:9` video stage.
