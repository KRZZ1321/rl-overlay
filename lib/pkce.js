'use strict';
const crypto = require('node:crypto');
// PKCE pour l'OAuth Discord via Supabase. verifier aléatoire, challenge = S256.
function makePkce() {
  const verifier = crypto.randomBytes(32).toString('base64url'); // 43 chars
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
// Parse l'URL de la requête loopback (/cb?code=...&state=...). null si pas de code.
function parseCallback(reqUrl) {
  const i = String(reqUrl || '').indexOf('?');
  if (i < 0) return null;
  const p = new URLSearchParams(reqUrl.slice(i + 1));
  const code = p.get('code');
  if (!code) return null;
  return { code, state: p.get('state') };
}
module.exports = { makePkce, parseCallback };
