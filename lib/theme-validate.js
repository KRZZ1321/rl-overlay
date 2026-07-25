'use strict';
// Validation pure d'un thème communautaire (pas d'I/O). Réutilisée par le client
// (feedback instantané) ; les Edge Functions revalident côté serveur (source de
// confiance). Règles data (tags, mots bloqués) = shared/theme-rules.json.
const RULES = require('../shared/theme-rules.json');
const HEX = /^#[0-9a-fA-F]{6}$/;
const ALLOWED_TAGS = RULES.allowedTags.slice();

function isNameClean(name) {
  const low = String(name || '').toLowerCase();
  return !RULES.blockedNameSubstrings.some((w) => low.includes(w));
}

function validateTheme(input) {
  const i = input || {};
  const name = String(i.name || '').trim();
  if (!name || name.length > RULES.maxNameLength) return { ok: false, error: 'name' };
  if (!isNameClean(name)) return { ok: false, error: 'name-blocked' };
  for (const k of ['aA', 'aB', 'bg', 'txt']) {
    if (!HEX.test(String(i[k] || ''))) return { ok: false, error: 'color:' + k };
  }
  const tags = Array.isArray(i.tags) ? i.tags : [];
  if (tags.length > RULES.maxTags) return { ok: false, error: 'tags-count' };
  if (!tags.every((t) => ALLOWED_TAGS.includes(t))) return { ok: false, error: 'tags-invalid' };
  return { ok: true, value: {
    name, tags: tags.slice(),
    aA: i.aA.toLowerCase(), aB: i.aB.toLowerCase(), bg: i.bg.toLowerCase(), txt: i.txt.toLowerCase(),
  } };
}

module.exports = { validateTheme, isNameClean, ALLOWED_TAGS };
