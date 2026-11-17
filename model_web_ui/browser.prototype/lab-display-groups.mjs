// Presentation only. Never overwrite the model's original class scores.
export const DISPLAY_GROUPS = [
  { name: '枪声', color: '#e87743', labels: ['Gunshot, gunfire', 'Machine gun'] },
  { name: '语音', color: '#568bc8', labels: ['Speech', 'Human voice', 'Male speech, man speaking', 'Female speech, woman speaking', 'Child speech, kid speaking', 'Conversation', 'Narration, monologue', 'Speech synthesizer', 'Whispering', 'Shout', 'Children shouting', 'Hubbub, speech noise, speech babble'] },
  { name: '音乐', color: '#9574c5', labels: ['Music'] },
  { name: '脚步', color: '#54a58b', labels: ['Walk, footsteps', 'Run'] },
  { name: '冲击／碎裂', color: '#c4a044', labels: ['Glass shatter', 'Generic impact sounds', 'Breaking'] },
];

export function createDisplayGrouping(classes) {
  const indices = DISPLAY_GROUPS.map(group => group.labels.map(name => classes.indexOf(name)).filter(id => id >= 0));
  return scores => Float32Array.from(indices, ids => ids.reduce((maximum, id) => Math.max(maximum, scores[id]), 0));
}
