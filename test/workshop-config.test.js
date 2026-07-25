const { test } = require('node:test');
const assert = require('node:assert');
const cfg = require('../lib/workshop-config');

test('restUrl construit une URL REST avec query', () => {
  assert.strictEqual(
    cfg.restUrl('themes', { status: 'eq.live', select: 'id,name' }),
    cfg.SUPABASE_URL + '/rest/v1/themes?status=eq.live&select=id%2Cname'
  );
});
test('fnUrl construit une URL de fonction', () => {
  assert.strictEqual(cfg.fnUrl('publish'), cfg.SUPABASE_URL + '/functions/v1/publish');
});
test('authHeaders inclut apikey et Bearer', () => {
  const h = cfg.authHeaders('tok123');
  assert.strictEqual(h.apikey, cfg.ANON_KEY);
  assert.strictEqual(h.Authorization, 'Bearer tok123');
});
test('authHeaders sans token -> Bearer anon', () => {
  const h = cfg.authHeaders();
  assert.strictEqual(h.Authorization, 'Bearer ' + cfg.ANON_KEY);
});
