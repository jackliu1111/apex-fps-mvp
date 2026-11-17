// Shared multi-resolution pyramid geometry for progressive audio peaks and 5-group prediction scores.
export const PYRAMID_FACTOR = 2;
export const PYRAMID_MIN_TOP_BUCKETS = 16;

/** Compute power-of-two Zoom Level descriptors down to a compact top level. */
export function buildLevelDescriptors(baseLength, baseStep, minTopBuckets = PYRAMID_MIN_TOP_BUCKETS) {
  const levels = [];
  let length = baseLength;
  let stride = 1;
  let level = 0;
  while (length > minTopBuckets) {
    level++;
    stride *= PYRAMID_FACTOR;
    length = Math.ceil(length / PYRAMID_FACTOR);
    levels.push({ level, stride, step: baseStep * stride, length });
  }
  return levels;
}

/** Select the coarsest pyramid level whose bucket duration does not exceed secondsPerColumn. */
export function selectPyramidLevel(levels, baseStep, baseLength, secondsPerColumn) {
  let chosen = { level: 0, stride: 1, step: baseStep, length: baseLength };
  if (!(secondsPerColumn > baseStep) || !Array.isArray(levels) || !levels.length) {
    return chosen;
  }
  for (const item of levels) {
    if (item.step <= secondsPerColumn) {
      chosen = { level: item.level, stride: item.stride, step: item.step, length: item.length };
    } else {
      break;
    }
  }
  return chosen;
}

/** Propagate incremental updates from [startIndex, endIndex) upward through pyramid levels. */
export function propagatePyramidRange(levelCount, startIndex, endIndex, updateLevel) {
  let start = startIndex;
  let end = endIndex;
  for (let idx = 0; idx < levelCount && end > start; idx++) {
    start >>>= 1;
    end = (end + 1) >>> 1;
    updateLevel(idx, start, end);
  }
}

/** Visit an exact [first, last) range across pyramid levels in O(log(last - first)) without boundary smear. */
export function visitPyramidRange(levelCount, first, last, visit) {
  if (!(last > first)) return;
  if (!levelCount || last - first <= 4) {
    for (let i = first; i < last; i++) visit(-1, i);
    return;
  }
  let l = first;
  let r = last;
  let lvlIdx = -1;
  while (l < r && lvlIdx + 1 < levelCount) {
    if (l & 1) visit(lvlIdx, l++);
    if (r & 1) visit(lvlIdx, --r);
    l >>>= 1;
    r >>>= 1;
    lvlIdx++;
  }
  for (let i = l; i < r; i++) visit(lvlIdx, i);
}
