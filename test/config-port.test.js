// test/config-port.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseConfigImport } = require('../lib/config-port');

test('JSON valide avec overlay -> ok', () => {
  const r = parseConfigImport(JSON.stringify({ username: 'x', overlay: { theme: 2 } }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.config.overlay.theme, 2);
});

test('JSON invalide -> erreur invalid-json', () => {
  assert.deepStrictEqual(parseConfigImport('{not json'), { ok: false, error: 'invalid-json' });
});

test('tableau -> not-an-object', () => {
  assert.deepStrictEqual(parseConfigImport('[]'), { ok: false, error: 'not-an-object' });
});

test('objet sans overlay -> missing-overlay', () => {
  assert.deepStrictEqual(parseConfigImport('{"username":"x"}'), { ok: false, error: 'missing-overlay' });
});
