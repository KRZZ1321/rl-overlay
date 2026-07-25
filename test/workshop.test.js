const { test } = require('node:test');
const assert = require('node:assert');
const w = require('../lib/workshop');

const rows = [
  { id: '1', name: 'A', a_a: '#111111', a_b: '#222222', bg: '#000000', txt: '#ffffff', tags: ['Sombre'], installs: 5, likes: 2, created_at: '2026-07-01', author: 'x' },
  { id: '2', name: 'B', a_a: '#aaaaaa', a_b: '#bbbbbb', bg: '#ffffff', txt: '#000000', tags: ['Clair'], installs: 1, likes: 9, created_at: '2026-07-10', author: 'y' },
];

test('mapRow mappe a_a/a_b -> aA/aB', () => {
  const m = w.mapRow(rows[0]);
  assert.strictEqual(m.aA, '#111111');
  assert.strictEqual(m.aB, '#222222');
  assert.strictEqual(m.installs, 5);
});
test('sortThemes popular = installs desc', () => {
  const s = w.sortThemes(rows.map(w.mapRow), 'popular');
  assert.deepStrictEqual(s.map((t) => t.id), ['1', '2']);
});
test('sortThemes liked = likes desc', () => {
  const s = w.sortThemes(rows.map(w.mapRow), 'liked');
  assert.deepStrictEqual(s.map((t) => t.id), ['2', '1']);
});
test('sortThemes recent = created desc', () => {
  const s = w.sortThemes(rows.map(w.mapRow), 'recent');
  assert.deepStrictEqual(s.map((t) => t.id), ['2', '1']);
});
test('filterThemes par tag et recherche', () => {
  const list = rows.map(w.mapRow);
  assert.strictEqual(w.filterThemes(list, { tag: 'Clair' }).length, 1);
  assert.strictEqual(w.filterThemes(list, { q: 'a' })[0].name, 'A');
});
test('cache round-trip + robustesse', () => {
  const list = rows.map(w.mapRow);
  assert.deepStrictEqual(w.parseCache(w.serializeCache(list)), list);
  assert.deepStrictEqual(w.parseCache('not json'), []);
  assert.deepStrictEqual(w.parseCache(null), []);
});
