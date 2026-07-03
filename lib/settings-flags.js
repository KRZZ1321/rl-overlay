'use strict';
// Normalisation centrale des réglages overlay poussés depuis la page Réglages.
// Pur et testable : main.js délègue ici la validation de set-overlay-flag.

const BOOL_FLAGS = ['mmrGlow', 'showMusic', 'showStreak', 'showDelta'];
const NUM_FLAGS = { overlayScale: [50, 150], overlayOpacity: [40, 100], mmrSize: [70, 140] };
const ENUM_FLAGS = { font: ['default', 'condensed', 'mono'] };

function normalizeOverlayFlag(key, value) {
  if (BOOL_FLAGS.includes(key)) return { ok: true, value: !!value };
  if (NUM_FLAGS[key]) {
    const [min, max] = NUM_FLAGS[key];
    return { ok: true, value: Math.max(min, Math.min(max, Math.round(Number(value) || 0))) };
  }
  if (ENUM_FLAGS[key]) {
    const allowed = ENUM_FLAGS[key];
    return { ok: true, value: allowed.includes(value) ? value : allowed[0] };
  }
  return { ok: false };
}

module.exports = { BOOL_FLAGS, NUM_FLAGS, ENUM_FLAGS, normalizeOverlayFlag };
