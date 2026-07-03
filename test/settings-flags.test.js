// test/settings-flags.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeOverlayFlag } = require('../lib/settings-flags');

test('bool flag -> booléen', () => {
  assert.deepStrictEqual(normalizeOverlayFlag('mmrGlow', 1), { ok: true, value: true });
  assert.deepStrictEqual(normalizeOverlayFlag('showMusic', 0), { ok: true, value: false });
});

test('num flag mmrSize clampé dans [70,140]', () => {
  assert.deepStrictEqual(normalizeOverlayFlag('mmrSize', 999), { ok: true, value: 140 });
  assert.deepStrictEqual(normalizeOverlayFlag('mmrSize', 10), { ok: true, value: 70 });
  assert.deepStrictEqual(normalizeOverlayFlag('mmrSize', 100), { ok: true, value: 100 });
});

test('num flag existant overlayScale toujours géré', () => {
  assert.deepStrictEqual(normalizeOverlayFlag('overlayScale', 200), { ok: true, value: 150 });
});

test('enum font: valeur autorisée gardée, sinon 1re autorisée', () => {
  assert.deepStrictEqual(normalizeOverlayFlag('font', 'mono'), { ok: true, value: 'mono' });
  assert.deepStrictEqual(normalizeOverlayFlag('font', 'bidon'), { ok: true, value: 'default' });
});

test('clé inconnue rejetée', () => {
  assert.deepStrictEqual(normalizeOverlayFlag('nope', 1), { ok: false });
});
