// Single source of truth for the Apex Local Cut brand mark.
//
// Mascot: an original "scout bot" — rounded-square head, side sensor pods,
// floating antenna beacon, and a full-face display showing two dot eyes over
// an audio-waveform mouth (a nod to the app's audio-driven highlight detection).
// The display is an evenodd hole with solid features inside, so the welcome
// emblem can light the screen from behind while the header badge / favicon
// just show their background through it.
//
// To swap the mascot: edit the constants below, then run
//   node scripts/sync-brand-icon.mjs
// which rewrites every static copy in site/index.html and site/landing.html.
// `brand-icon.test.mjs` fails if the HTML drifts from this module.

export const BRAND_ICON_VIEWBOX = '60 0 1080 1080';

const HEAD = 'M400 320H580V220H620V320H800A200 200 0 0 1 1000 520V540H1060A30 30 0 0 1 1090 570V690A30 30 0 0 1 1060 720H1000V780A200 200 0 0 1 800 980H400A200 200 0 0 1 200 780V720H140A30 30 0 0 1 110 690V570A30 30 0 0 1 140 540H200V520A200 200 0 0 1 400 320Z';
const BEACON = 'M550 150A50 50 0 1 0 650 150A50 50 0 1 0 550 150Z';
const SCREEN = 'M360 450H840A90 90 0 0 1 930 540V710A90 90 0 0 1 840 800H360A90 90 0 0 1 270 710V540A90 90 0 0 1 360 450Z';
const EYES = 'M395 565A55 55 0 1 0 505 565A55 55 0 1 0 395 565ZM695 565A55 55 0 1 0 805 565A55 55 0 1 0 695 565Z';
const WAVEFORM_MOUTH = 'M480 675H480A18 18 0 0 1 498 693V707A18 18 0 0 1 480 725H480A18 18 0 0 1 462 707V693A18 18 0 0 1 480 675ZM540 650H540A18 18 0 0 1 558 668V732A18 18 0 0 1 540 750H540A18 18 0 0 1 522 732V668A18 18 0 0 1 540 650ZM600 630H600A18 18 0 0 1 618 648V752A18 18 0 0 1 600 770H600A18 18 0 0 1 582 752V648A18 18 0 0 1 600 630ZM660 650H660A18 18 0 0 1 678 668V732A18 18 0 0 1 660 750H660A18 18 0 0 1 642 732V668A18 18 0 0 1 660 650ZM720 675H720A18 18 0 0 1 738 693V707A18 18 0 0 1 720 725H720A18 18 0 0 1 702 707V693A18 18 0 0 1 720 675Z';

export const BRAND_ICON_PATH = [HEAD, BEACON, SCREEN, EYES, WAVEFORM_MOUTH].join('');

// Glow shapes rendered *behind* the display hole in the welcome emblem (class "brand-lens").
export const BRAND_ICON_GLOW = [
  { tag: 'rect', attrs: { x: 270, y: 450, width: 660, height: 350, rx: 90 } },
];

/** Raw favicon SVG markup: dark rounded tile + white mascot + optional overlay (e.g. count badge). */
export function buildFaviconSvg(overlay = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">`
    + `<rect width="32" height="32" rx="8" fill="#18181b"/>`
    + `<svg x="3.5" y="3.5" width="25" height="25" viewBox="${BRAND_ICON_VIEWBOX}">`
    + `<path fill="#ffffff" fill-rule="evenodd" d="${BRAND_ICON_PATH}"/>`
    + `</svg>`
    + overlay
    + `</svg>`;
}

export function svgToDataUrl(svg) {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
