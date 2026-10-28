# Design System: Apex Local Cut (本地选片工作区)

## 1. Visual Theme & Atmosphere
A dual-surface desktop video review workbench and esports utility tool inspired by ALGS (Apex Legends Global Series) broadcast graphics and professional non-linear editors (DaVinci Resolve, Final Cut Pro).
- **Task & Queue Views (`#analysis-page`, `#exports-section`):** Utilitarian tactical dark charcoal surfaces (`#131411` ground, `#20201d` panels) with crisp `1px` structural borders, `3px` warm coral top/left status accents, angled corner notches on primary action buttons, and high-contrast typography.
- **Clip Review Studio (`#review-page`):** A distraction-free, true-black darkroom environment (`#000000` ground, `#111111` studio decks) where the `16:9` game footage (`clamp(360px, 46vh, 440px)` tall) holds the primary visual focus. Chrome recedes into flat dark gray steps with zero glow, zero glassmorphism, and zero decorative gradients.

## 2. Color Palette & Roles
- **Darkroom Ground (`#000000`):** Pure black background used in the clip review workspace so game footage colors and HUD elements pop without interference.
- **Tactical Obsidian & Charcoal (`#131411` & `#20201d`):** Deep obsidian ground and warm charcoal panel containers used for the analysis queue and export batch panels.
- **Studio Panel Surface (`#111111`) & Recessed Well (`#0e0e0c` / `#080808`):** Flat dark gray container surfaces for the video player deck, transport bar, and timeline docks.
- **Structural Hairline (`#262626` & `#33332f`):** Subtle `1px` solid dividers separating panels, headers, and queue rows without drop shadows.
- **Primary Ivory Ink (`#f5f5f5` & `#f4f1e9`):** High-contrast off-white for headings, active navigation, and primary figures.
- **Secondary Muted Grey (`#b4b4b4`) & Faint Meta (`#949494`):** Used for timestamps, axis ticks, and technical notes (maintaining `>= 4.5:1` contrast).
- **Selection Signal Lime (`#c6f24e`):** High-visibility chartreuse/lime accent used on the review timeline for the active clip trim handles, active selection overlay border, selected prediction interval, and completed progress indicators.
- **Tactical Crimson (`#b02a24`) & Warm Coral (`#f08773`):** Used for primary chamfered action buttons (`导入录像`, `提交选片导出`), active queue indicators, and brand badge.
- **Semantic Alert Coral (`#ff8b91`) & Warning Amber (`#e5b65e`):** Used for exclude hover states, failed export states, or missing source file notices.

## 3. Typography Rules
- **Font Stack:** Clean neo-grotesk and Chinese system UI sans-serif (`"Inter"`, `-apple-system`, `"PingFang SC"`, `"Microsoft YaHei"`), paired with strict tabular numerals (`font-variant-numeric: tabular-nums`) on all timecodes, durations, and byte counts.
- **Hierarchy:** Compact utility scale — Queue Title `30px` bold; Review Studio Subheader Title `18px` semibold; Section Heading `13px–16px` semibold; Body & Controls `13px–14px`; Axis Ticks & Technical Meta `12px`.

## 4. Component Stylings
- **Primary Chamfered Buttons (`#import-files`, `#export`):** `34px–38px` height, sharp `0px` corners with an `8px–9px` 45-degree clipped bottom-right corner notch (`clip-path: polygon(0 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%)`) in Tactical Crimson (`#b02a24`) with white text.
- **Studio Panels & Disclosures:** Flat surfaces (`4px` card radius, `3px` control radius) separated by `1px` structural hairlines; precision editors and batch lists fold into flush bottom `<details>` rows.
- **Timeline Trim Handles:** `22px` wide vertical grab bars in Selection Signal Lime (`#c6f24e`) with a `2px` dark center grip line, framing a translucent selection window (`rgba(198, 242, 78, 0.06)`) over the uncropped source keyframe filmstrip and waveform.

## 5. Layout Principles
- Single-column aligned edges (`1120px` max width in Review Studio, `1280px` shell container).
- Video-first proportion: the `16:9` video canvas (`clamp(360px, 46vh, 440px)`) dominates the upper viewport, with the compact context subheader above it and the source timeline, prediction timeline, and export bar stacked directly beneath it within a single desktop screen.
