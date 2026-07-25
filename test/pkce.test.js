const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { makePkce, parseCallback } = require('../lib/pkce');

test('makePkce: challenge = base64url(sha256(verifier))', () => {
  const { verifier, challenge } = makePkce();
  assert.ok(verifier.length >= 43);
  const expect = crypto.createHash('sha256').update(verifier).digest('base64url');
  assert.strictEqual(challenge, expect);
});
test('parseCallback extrait code + state', () => {
  const r = parseCallback('/cb?code=abc&state=xyz');
  assert.deepStrictEqual(r, { code: 'abc', state: 'xyz' });
});
test('parseCallback sur URL sans code -> null', () => {
  assert.strictEqual(parseCallback('/favicon.ico'), null);
});
