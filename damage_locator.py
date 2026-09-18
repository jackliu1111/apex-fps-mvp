"""Multi-scale HUD anchor matching, using NumPy only.

Coordinates are pixels in the decoded video, not fractions of the screen.
The 64 x 38 anchors exclude the changing digits. Supported anchor scale is
0.25..2 times the source 4K HUD; screen aspect ratio is unrestricted.
"""
from dataclasses import dataclass
import math

import numpy as np

from damage_templates import LOCATION_ICONS

ICONS = [np.frombuffer(bytes.fromhex(s), np.uint8).reshape(38, 64).astype(np.float32)
         for s in LOCATION_ICONS]


def resize(a, height, width):
    """Bilinear resize, with pixel-center coordinates (also used for crops)."""
    yy = np.clip((np.arange(height) + .5) * a.shape[0] / height - .5, 0, a.shape[0]-1)
    xx = np.clip((np.arange(width) + .5) * a.shape[1] / width - .5, 0, a.shape[1]-1)
    return sample(a, yy, xx)


def sample(a, yy, xx):
    y0, x0 = yy.astype(int), xx.astype(int)
    y1, x1 = np.minimum(y0+1, a.shape[0]-1), np.minimum(x0+1, a.shape[1]-1)
    wy, wx = yy-y0, xx-x0
    if a.ndim == 3:
        wy, wx = wy[:, None, None], wx[None, :, None]
    else:
        wy, wx = wy[:, None], wx[None, :]
    return ((a[y0[:, None], x0] * (1-wx) + a[y0[:, None], x1] * wx) * (1-wy)
            + (a[y1[:, None], x0] * (1-wx) + a[y1[:, None], x1] * wx) * wy).astype(np.float32)


class Matcher:
    """Normalized cross correlation; FFT and integral images avoid window copies."""
    def __init__(self, gray):
        self.gray = gray.astype(np.float32)
        self.fft = np.fft.rfft2(self.gray)
        self.sums = [np.pad(a.astype(np.float64), ((1, 0), (1, 0))).cumsum(0).cumsum(1)
                     for a in (self.gray, self.gray**2)]

    def scores(self, template):
        h, w = template.shape
        if h > self.gray.shape[0] or w > self.gray.shape[1]:
            return np.empty((0, 0))
        t = template-template.mean()
        energy = float((t*t).sum())
        sums = [s[h:, w:]-s[:-h, w:]-s[h:, :-w]+s[:-h, :-w] for s in self.sums]
        variance = np.maximum(sums[1]-sums[0]**2/(h*w), 0)
        corr = np.fft.irfft2(self.fft * np.conj(np.fft.rfft2(t, s=self.gray.shape)),
                             s=self.gray.shape)[:variance.shape[0], :variance.shape[1]]
        return np.where(variance > h*w*4, corr/np.maximum(np.sqrt(variance*energy), 1e-6), 0)


@dataclass(frozen=True)
class Anchor:
    x: float
    y: float
    scale: float
    score: float

    def as_dict(self):
        return {k: round(float(v), 4) for k, v in vars(self).items()}


def search(gray, scales, origin=(0, 0), peaks=1):
    matcher = Matcher(gray)
    hits = []
    seen = set()
    for scale in scales:
        w, h = round(64*scale), round(38*scale)
        if w < 8 or h < 5 or (w, h) in seen:
            continue
        seen.add((w, h))
        for icon in ICONS:
            scores = matcher.scores(resize(icon, h, w))
            if not scores.size:
                continue
            for _ in range(peaks):
                y, x = np.unravel_index(np.argmax(scores), scores.shape)
                hits.append(Anchor(x+origin[0], y+origin[1], w/64, float(scores[y, x])))
                scores[max(0, y-h):y+h+1, max(0, x-w):x+w+1] = -1
    return sorted(hits, key=lambda hit: hit.score, reverse=True)


class HudLocator:
    MIN_SCORE = .72

    def __init__(self, fps):
        self.anchor = None
        self.next_search = 0
        self.retry_frames = max(1, round(fps))
        self.searches = 0
        self.located_frames = 0

    def _refine(self, frame, anchor, radius, vary_scale=True):
        s = anchor.scale
        x0, y0 = max(0, math.floor(anchor.x-radius)), max(0, math.floor(anchor.y-radius))
        x1 = min(frame.shape[1], math.ceil(anchor.x+64*s+radius))
        y1 = min(frame.shape[0], math.ceil(anchor.y+38*s+radius))
        gray = frame[y0:y1, x0:x1].mean(2)
        scales = s*np.linspace(.85, 1.15, 13) if vary_scale else [s]
        hits = search(gray, [v for v in scales if .25 <= v <= 2.], (x0, y0))
        return hits[0] if hits else None

    def locate(self, frame, index):
        if self.anchor is not None:
            # Digits change width, shifting the icon even with a stationary HUD.
            hit = self._refine(frame, self.anchor, max(12, 64*self.anchor.scale), False)
            if hit and hit.score >= self.MIN_SCORE:
                self.anchor = hit
                self.located_frames += 1
                return hit
            self.anchor = None
        if index < self.next_search:
            return None
        self.next_search = index+self.retry_frames
        self.searches += 1
        ratio = min(1., 960/max(frame.shape[:2]))
        h, w = round(frame.shape[0]*ratio), round(frame.shape[1]*ratio)
        # Resize RGB first so global search never creates full-frame float RGB.
        gray = resize(frame, h, w).mean(2)
        scales = sorted(set(np.geomspace(.25, 2., 29).tolist()+[1/3, .5, 2/3, 1., 1.5, 2.]))
        candidates = search(gray, [s*ratio for s in scales], peaks=2)
        distinct = []
        for candidate in candidates:
            if not any(abs(candidate.x-h.x)+abs(candidate.y-h.y) < 24*h.scale
                       for h in distinct):
                distinct.append(candidate)
            if len(distinct) == 6:
                break
        refined = []
        for candidate in distinct:
            if candidate.score < .5:
                break
            native = Anchor(candidate.x/ratio, candidate.y/ratio,
                            candidate.scale/ratio, candidate.score)
            hit = self._refine(frame, native, max(6, 4/ratio))
            if hit and hit.score >= self.MIN_SCORE:
                refined.append(hit)
        if not refined:
            return None
        refined.sort(key=lambda hit: hit.score, reverse=True)
        best = refined[0]
        # Reject two similarly strong anchors in separate places.
        if any(abs(h.x-best.x)+abs(h.y-best.y) > 64*best.scale and
               best.score-h.score < .05 for h in refined[1:]):
            return None
        self.anchor = best
        self.located_frames += 1
        return best


def digit_band(frame, anchor):
    """Normalize the strip immediately right of the icon to source HUD pixels."""
    # Allow up to five digits; do not resize each number string to a fixed width.
    yy = anchor.y + (np.arange(31)+4+.5)*anchor.scale-.5
    xx = anchor.x + (np.arange(120)+64+.5)*anchor.scale-.5
    if yy[0] < 0 or yy[-1] > frame.shape[0]-1 or xx[0] < 0:
        return None
    # A HUD near the screen edge can have less than five digits of free space.
    xx = xx[xx <= frame.shape[1]-1]
    if len(xx) < 6:
        return None
    return sample(frame, yy, xx).clip(0, 255).astype(np.uint8)
