const { test } = require('node:test');
const assert = require('node:assert');
const { validateTheme, isNameClean, ALLOWED_TAGS } = require('../lib/theme-validate');

test('validateTheme accepte un thème correct', () => {
  const r = validateTheme({ name: 'Sunset', aA: '#ff8a3d', aB: '#ffc24d', bg: '#0a0b0e', txt: '#f5f6f8', tags: ['Sombre', 'Vif'] });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.value.tags, ['Sombre', 'Vif']);
  assert.strictEqual(r.value.aA, '#ff8a3d');
});

test('validateTheme rejette un hex invalide', () => {
  const r = validateTheme({ name: 'X', aA: 'red', aB: '#ffc24d', bg: '#0a0b0e', txt: '#f5f6f8', tags: [] });
  assert.strictEqual(r.ok, false);
});

test('validateTheme rejette un nom trop long', () => {
  const r = validateTheme({ name: 'x'.repeat(25), aA: '#ff8a3d', aB: '#ffc24d', bg: '#0a0b0e', txt: '#f5f6f8', tags: [] });
  assert.strictEqual(r.ok, false);
});

test('validateTheme rejette un nom grossier', () => {
  const r = validateTheme({ name: 'shitTheme', aA: '#ff8a3d', aB: '#ffc24d', bg: '#0a0b0e', txt: '#f5f6f8', tags: [] });
  assert.strictEqual(r.ok, false);
});

test('validateTheme rejette un tag hors liste', () => {
  const r = validateTheme({ name: 'X', aA: '#ff8a3d', aB: '#ffc24d', bg: '#0a0b0e', txt: '#f5f6f8', tags: ['Piraté'] });
  assert.strictEqual(r.ok, false);
});

test('validateTheme rejette plus de maxTags', () => {
  const r = validateTheme({ name: 'X', aA: '#ff8a3d', aB: '#ffc24d', bg: '#0a0b0e', txt: '#f5f6f8', tags: ['Sombre', 'Clair', 'Vif', 'Mono'] });
  assert.strictEqual(r.ok, false);
});

test('isNameClean insensible à la casse', () => {
  assert.strictEqual(isNameClean('FucK'), false);
  assert.strictEqual(isNameClean('Aurora'), true);
});

test('ALLOWED_TAGS exposé', () => {
  assert.ok(ALLOWED_TAGS.includes('Néon'));
});
