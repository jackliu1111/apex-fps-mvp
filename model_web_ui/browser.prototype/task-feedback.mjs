// Presentation only: counts come from recorded results, never from progress.
export function batchSummary(batch) {
  const results = batch.clipResults || [];
  const completed = results.filter((result) => result.status === 'completed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  if (!results.length) return { text: `${batch.clips.length} 段 · 完成明细未记录`, failed: 0 };
  return { text: `已完成 ${completed} / ${batch.clips.length} 段${failed ? ` · ${failed} 段失败` : ''}`, failed };
}

export function justCompleted(previous, next) {
  return !!previous && !['complete', 'completed'].includes(previous) && ['complete', 'completed'].includes(next);
}

// One motif at two scales: incoming frames settle around a selected segment.
// Decorative only; actual analysis progress remains on the labelled progress bar.
export function createFrameSignal() {
  const signal = document.createElement('span');
  signal.className = 'frame-signal';
  signal.setAttribute('aria-hidden', 'true');
  signal.innerHTML = `<svg viewBox="0 0 144 64" focusable="false">
    <g class="signal-frame signal-left"><path d="M10 18h34v30H10z"/><path class="signal-detail" d="M17 25h20M17 32h12M17 40h16"/></g>
    <g class="signal-frame signal-right"><path d="M100 18h34v30h-34z"/><path class="signal-detail" d="M107 25h20M107 32h12M107 40h16"/></g>
    <g class="signal-frame signal-center"><path d="M49 12h46v42H49z"/><path class="signal-play" d="m67 24 13 9-13 9z"/></g>
    <path class="signal-brackets" d="M56 6H43v14m45-14h13v14M43 46v14h13m45-14v14H88"/>
  </svg>`;
  return signal;
}

export function taskFeedback(node, kind) {
  if (!node.getClientRects().length || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // No persistent fill or layout movement; repeated progress renders do not replay it.
  node.getAnimations().forEach((animation) => animation.cancel());
  node.animate(kind === 'added'
    ? [{ opacity: .35, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }]
    : [{ backgroundColor: getComputedStyle(node).getPropertyValue('--task-highlight').trim() || '#302522', transform: 'translateX(3px)' }, { backgroundColor: getComputedStyle(node).backgroundColor, transform: 'translateX(0)' }],
  { duration: kind === 'added' ? 200 : 320, easing: 'cubic-bezier(.2,0,0,1)' });
}
