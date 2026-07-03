'use strict';
// Valide une config.json importée avant écriture. Pur.
function parseConfigImport(jsonString) {
  let data;
  try { data = JSON.parse(jsonString); }
  catch { return { ok: false, error: 'invalid-json' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'not-an-object' };
  }
  if (!data.overlay || typeof data.overlay !== 'object') {
    return { ok: false, error: 'missing-overlay' };
  }
  return { ok: true, config: data };
}
module.exports = { parseConfigImport };
