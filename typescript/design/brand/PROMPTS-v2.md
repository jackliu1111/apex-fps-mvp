# 寻血猎犬第二版生成记录

工具：内置 imagegen（未使用 CLI）。

角色参考：[J Hill 的寻血猎犬角色模型](https://x.com/artofjhill/status/1103773180479459328)。

第一轮生成用于校正角色特征；第二轮简化细节。第二轮白底母图已保存为 `bloodhound-v2-master.png`。最终交付图标由母图的黑色轮廓转为真正的 SVG 路径，白色区域转换为透明负形，再从 SVG 渲染 50、100、512 px 黑白 PNG。SVG 中没有嵌入位图。

## 第一轮提示词

```text
Use case: logo-brand.
Create ONE new, recognizably accurate monochrome icon of Bloodhound from Apex Legends, using the attached character render as the anatomical and costume reference. This is a complete redesign of a failed generic geometric gas-mask logo; reproduce this specific character's visual identity.
Reference image: the attached front-facing Bloodhound head is the subject reference only. Ignore its background, body, typography, watermarks and realistic shading.
Asset type: small 50 x 50 pixel app brand icon; generate a high-resolution square master suitable for downsampling.
Composition: front-facing isolated head, centered, fills about 88% of the square, fully visible silhouette, modest even padding. Crop below the chin, not shoulders.
Identity-critical details: a LOW WIDE layered hunter helmet with a downward V-shaped brow, a CENTRAL UPRIGHT fan-shaped feather/metal crest (5 bold simplified prongs) rather than a side feather or alpine hat; large round goggles fitted tightly below the brow with substantial rims and central bridge; a compact broad angular respirator covering the entire lower face with a narrow central VERTICAL grille (three strong slits), two distinct round side filter fittings, and the characteristic thicker curved breathing tube on the viewer's right. Helmet has short hanging attachments at its outer sides, simplified to one or two substantial shapes per side. Match the proportions in the reference: broad helmet, wide paired goggles, narrow lower mask. A minimal angular collar may frame the bottom but no bust.
Style: excellent designer-made flat stencil/vector-like emblem, solid pure BLACK ink and fully TRANSPARENT negative space/background. Use crisp intentional contour curves and bold connected masses. Real character likeness comes first; simplify mechanical textures, omit rivets and tiny stripes. No thin outlines that disappear at 50px. Main gaps should remain roughly 1.5-2px when reduced to 50px, so do not clutter the design with filigree.
Do NOT make a generic cartoon robot, skull, smiling face, surprised open mouth, regular hat, symmetric U-shaped chin rail, cute mascot, generic gas-mask soldier or anonymous tactical helmet. No grey shading, gradients, colors, shadows, 3D, paper texture, checkerboard background, opaque white areas, background plate, border, lettering, slogans, watermark, or presentation sheet. ONE icon only. Genuine alpha transparency.
```

## 第二轮最终提示词

```text
Refine the attached Bloodhound icon for actual 50 x 50 pixel use. Preserve this specific front-facing Bloodhound identity, wide downward-V helmet silhouette, central five-prong crest, goggle proportions and the asymmetric breathing hose. Make the main ink shapes and transparent gaps bolder and slightly simpler; remove micro hatching, tiny ventilation stripes, and unnecessary doubled outlines. The middle respirator must read as a mechanical box with two or three bold vertical slots, never an open mouth. Keep each side filter as a simple solid mechanical shape with one clear cutout, and keep the hose with just 3 or 4 coarse ribs. The forehead bridge should have only 2 bold cuts. Avoid tiny detached details. Remove the checkerboard completely.
OUTPUT: One centered head icon, pure solid black foreground on a perfectly flat PURE WHITE (#FFFFFF) background. Black and white only; no grey fills or shadows; only smooth antialiased edges. This white background is intentional for subsequent vector tracing, so absolutely NO checkerboard or simulated transparency. No text, no border, no frame, no mockup, no other icons. Square crop, all features fully visible with 5% clear margin. Keep the likeness and sophisticated costume silhouette of the attached Bloodhound design.
```
