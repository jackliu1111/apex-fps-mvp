// Presentation only. Never overwrite the model's original class scores or influence candidate/manual decisions.
// Palette separation on the light monochrome workbench (#f5f6f8 well, opaque neutral #7b8391 waveform):
// - Selection overlay & trim handles reserve sky-blue (hue ~215deg: #60a5fa / #3b82f6 / rgba(59, 130, 246, 0.12)).
// - `speech` moves off legacy sky-blue (#568bc8) to muted sage green (#689b52, hue ~102deg) to stay clear of selection UI.
// - `gunshot` uses high-contrast vermilion-red (#dc3b26, hue ~7deg, alpha 0.96) drawn downward from the top outer waveform edge.
// - Non-gunshot groups render bottom-up inside the waveform contour as low-saturation translucent layers (~0.48-0.52 alpha).
export const DISPLAY_GROUPS = Object.freeze([
  Object.freeze({
    id: 'gunshot',
    name: '枪声',
    nameEn: 'Gunshot',
    i18nKey: 'group_gunshot',
    color: '#dc3b26',
    alpha: 0.96,
    anchor: 'top',
    labels: Object.freeze(['Gunshot, gunfire', 'Machine gun']),
  }),
  Object.freeze({
    id: 'speech',
    name: '语音',
    nameEn: 'Speech',
    i18nKey: 'group_speech',
    color: '#689b52',
    alpha: 0.52,
    anchor: 'bottom',
    labels: Object.freeze(['Speech', 'Human voice', 'Male speech, man speaking', 'Female speech, woman speaking', 'Child speech, kid speaking', 'Conversation', 'Narration, monologue', 'Speech synthesizer', 'Whispering', 'Shout', 'Children shouting', 'Hubbub, speech noise, speech babble']),
  }),
  Object.freeze({
    id: 'music',
    name: '音乐',
    nameEn: 'Music',
    i18nKey: 'group_music',
    color: '#8f70c4',
    alpha: 0.48,
    anchor: 'bottom',
    labels: Object.freeze(['Music']),
  }),
  Object.freeze({
    id: 'footsteps',
    name: '脚步',
    nameEn: 'Footsteps',
    i18nKey: 'group_footsteps',
    color: '#449d8a',
    alpha: 0.5,
    anchor: 'bottom',
    labels: Object.freeze(['Walk, footsteps', 'Run']),
  }),
  Object.freeze({
    id: 'impact',
    name: '冲击／碎裂',
    nameEn: 'Impact',
    i18nKey: 'group_impact',
    color: '#c49438',
    alpha: 0.5,
    anchor: 'bottom',
    labels: Object.freeze(['Glass shatter', 'Generic impact sounds', 'Breaking']),
  }),
]);

export function createDisplayGrouping(classes) {
  const indices = DISPLAY_GROUPS.map((group) => group.labels.map((name) => classes.indexOf(name)).filter((id) => id >= 0));
  return (scores, target = null, offset = 0) => {
    const out = target || new Float32Array(indices.length);
    for (let g = 0; g < indices.length; g++) {
      const ids = indices[g];
      let maximum = 0;
      for (let i = 0; i < ids.length; i++) {
        const value = scores[ids[i]];
        if (value > maximum) maximum = value;
      }
      out[offset + g] = maximum;
    }
    return out;
  };
}
