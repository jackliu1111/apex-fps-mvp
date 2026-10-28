export const CANDIDATE_PADDING_SECONDS = 5;
export const CANDIDATE_GAP_SECONDS = 5;

// Operates only on automatic candidates, never on human decisions or export snapshots.
export function mergeCandidateRanges(candidates) {
  const merged = [];
  for (const candidate of [...candidates].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = merged.at(-1);
    if (last && candidate.start - last.end <= CANDIDATE_GAP_SECONDS) {
      last.end = Math.max(last.end, candidate.end);
      last.provisional = !!(last.provisional || candidate.provisional);
    } else merged.push({ ...candidate });
  }
  return merged;
}
