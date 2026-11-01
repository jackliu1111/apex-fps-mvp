# Design System: Apex Local Cut (本地选片工作区)

## 1. Visual Theme & Atmosphere
A unified **Descript Studio Pro (B1)** desktop video review and timeline editing workbench inspired by modern document-and-canvas editors (Descript) and precision linear workspaces.
- **Task & Queue Views (`#analysis-page`, `#exports-section`):** Bright cloud-white studio canvas (`#f1f3f9` / `#eceff8 → #f5f6fb` gradient ground) with elevated pure-white cards (`#ffffff`, `16px` radius), frosted-glass sticky navigation (`rgba(255, 255, 255, 0.88)` with `backdrop-filter: blur(16px)`), crisp `1px` slate hairlines (`#e2e5f0`), and electric indigo-violet pill actions (`#6366f1 → #4f46e5`).
- **Clip Review Studio (`#review-page`):** A tactile, high-contrast studio canvas pairing a recessed dot-matrix timeline well (`#eaecf5` with radial dot grid `#cbd5e1`) and a floating deep-obsidian `16:9` video stage (`#090b10` frame, `clamp(280px, 38vh, 380px)` tall) so game footage colors and HUD elements pop cleanly while timeline editing feels lightweight and approachable.

## 2. Color Palette & Roles
- **Studio Canvas Ground (`#f1f3f9`):** Cool cloud-slate background used across the workspace to provide clear visual separation from elevated white cards.
- **Elevated Card Surface (`#ffffff`) & Tinted Wells (`#f7f8fc` / `#eef2ff`):** Pure white card containers with subtle multi-layered elevation shadows, paired with cool slate recessed wells for headers, empty drop zones, and disclosure drawers.
- **Recessed Dot-Matrix Track Well (`#eaecf5`):** Tactile sunken timeline bed featuring a `12px × 12px` radial dot-matrix grid (`#cbd5e1`) and inner shadow (`inset 0 2px 5px rgba(15, 23, 42, 0.05)`) for the `64px`-tall source and prediction tracks.
- **Floating Video Stage (`#090b10`):** Deep obsidian cinema frame housing the `<canvas>` video viewport and the frosted top-left `#player-status` pill badge.
- **Structural Hairlines (`#e2e5f0` & `#c7cce0`):** Crisp `1px` slate borders separating cards, headers, segmented HUD transport zones, and queue rows.
- **Primary Slate Ink (`#0f172a`):** High-contrast deep slate for headings, timecodes, active navigation, and primary figures.
- **Secondary Muted Slate (`#475569`) & Faint Meta (`#64748b`):** Used for timestamps, axis ticks, and technical notes (maintaining `>= 4.5:1` contrast on light surfaces).
- **Electric Indigo & Violet (`#6366f1`, `#4f46e5`, `#8b5cf6`):** Primary brand and selection accent used for primary pill buttons (`+ 导入录像`, `提交选片导出`, `选择输出目录`), active navigation indicators, 3D jelly timeline clips, and tactile trim handles.
- **Semantic Emerald (`#10b981`), Warning Amber (`#d97706`), & Alert Rose (`#e11d48`):** Used for completed analysis/export states, provisional/warning notices, and exclude/error states.

## 3. Typography Rules
- **Font Stack:** Clean neo-grotesk and Chinese system UI sans-serif (`"Inter"`, `-apple-system`, `"PingFang SC"`, `"Microsoft YaHei"`), paired with strict tabular numerals (`font-variant-numeric: tabular-nums`) on all timecodes, durations, and byte counts.
- **Hierarchy:** Queue & Export Title `28px` bold (`letter-spacing: -0.03em`); Review Studio Subheader Title `18px` bold; Section Heading `13px–16px` semibold; Body & Controls `13px–14px`; Axis Ticks & Technical Meta `12px`.

## 4. Component Stylings
- **Primary Pill Buttons (`#import-files`, `#export`, `#choose-directory`):** `36px–38px` height, full pill radius (`999px`), indigo-to-violet gradient fill (`linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)`), white text, and subtle top inner specular highlight.
- **3-Zone Segmented Transport HUD (`.transport`):** Unified `12px`-radius light control bar divided into playback actions, tabular timecode pill, and volume/preview controls.
- **3D Jelly Timeline Clips & Tactile Handles:** Active selection windows and candidate markers use translucent indigo-violet gradients with top specular highlights (`inset 0 1px 0 rgba(255, 255, 255, 0.85)`), paired with `22px`-wide indigo pill grab handles (`8px` radius) and a `2px` white center grip line. The playhead uses an `#e11d48` vertical needle and a `12px` teardrop cap.

## 5. Layout Principles
- Single-column aligned edges (`1120px` max width in Review Studio, `1280px` shell container).
- Strict dual-timeline geometry: `.source-axis` and `.prediction-shared-axis` maintain identical horizontal margins (`16px` panel padding + `12px` axis margin) and exact `64px` track heights beneath the `16:9` floating video stage.
