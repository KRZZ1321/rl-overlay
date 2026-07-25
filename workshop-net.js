'use strict';
// Réseau Workshop (raw fetch, aucune dépendance). Auth Discord via PKCE + loopback.
const http = require('node:http');
const { shell } = require('electron');
const { makePkce, parseCallback } = require('./lib/pkce');
const { restUrl, fnUrl, authHeaders, SUPABASE_URL, ANON_KEY } = require('./lib/workshop-config');
const { mapRow } = require('./lib/workshop');

let session = null; // { access_token, refresh_token, user }

function setSession(s) { session = s || null; }
function getUser() { return session ? session.user : null; }
function token() { return session ? session.access_token : null; }

async function listThemes() {
  const url = restUrl('themes', {
    select: 'id,name,a_a,a_b,bg,txt,tags,installs,likes,created_at,profiles(discord_name)',
    status: 'eq.live',
  });
  const r = await fetch(url, { headers: authHeaders() });
  if (!r.ok) throw new Error('list ' + r.status);
  const rows = await r.json();
  return rows.map((row) => mapRow({ ...row, author: row.profiles && row.profiles.discord_name }));
}

async function publishTheme(t) {
  const r = await fetch(fnUrl('publish'), {
    method: 'POST',
    headers: { ...authHeaders(token()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: t.name, aA: t.aA, aB: t.aB, bg: t.bg, txt: t.txt, tags: t.tags || [] }),
  });
  const j = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, id: j.id } : { ok: false, error: j.error || ('http ' + r.status) };
}

async function likeTheme(id, liked) {
  const u = getUser();
  if (!u) return { ok: false, error: 'auth' };
  if (liked) {
    const r = await fetch(restUrl('likes'), {
      method: 'POST',
      headers: { ...authHeaders(token()), 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates' },
      body: JSON.stringify({ theme_id: id, user_id: u.id }),
    });
    return { ok: r.ok };
  }
  const r = await fetch(restUrl('likes', { theme_id: 'eq.' + id, user_id: 'eq.' + u.id }), {
    method: 'DELETE', headers: authHeaders(token()),
  });
  return { ok: r.ok };
}

async function installTheme(id) {
  const r = await fetch(fnUrl('install'), {
    method: 'POST',
    headers: { ...authHeaders(token()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme_id: id }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, installs: j.installs };
}

// OAuth Discord (PKCE) : un serveur loopback local capte le ?code, l'échange contre
// une session. redirect_to doit être dans uri_allow_list du projet (http://127.0.0.1:*).
function loginDiscord() {
  return new Promise((resolve) => {
    const { verifier, challenge } = makePkce();
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { server.close(); } catch {} resolve(v); };
    const server = http.createServer(async (req, res) => {
      const cb = parseCallback(req.url);
      if (!cb) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body style="font-family:sans-serif;background:#0a0b0e;color:#f5f6f8"><h2>Connecté ✓ Tu peux fermer cet onglet.</h2></body></html>');
      try {
        const tr = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
          method: 'POST',
          headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ auth_code: cb.code, code_verifier: verifier }),
        });
        const s = await tr.json();
        if (s.access_token) { setSession({ access_token: s.access_token, refresh_token: s.refresh_token, user: s.user }); finish({ ok: true, user: s.user }); }
        else finish({ ok: false, error: 'token' });
      } catch (e) { finish({ ok: false, error: e.message }); }
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirect = `http://127.0.0.1:${port}/cb`;
      const url = `${SUPABASE_URL}/auth/v1/authorize?provider=discord`
        + `&redirect_to=${encodeURIComponent(redirect)}`
        + `&code_challenge=${challenge}&code_challenge_method=s256`;
      shell.openExternal(url);
    });
    setTimeout(() => finish({ ok: false, error: 'timeout' }), 180000);
  });
}

module.exports = { listThemes, publishTheme, likeTheme, installTheme, loginDiscord, getUser, setSession, _tok: token };
