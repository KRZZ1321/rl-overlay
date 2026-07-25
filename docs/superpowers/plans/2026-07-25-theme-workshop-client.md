# Theme Workshop — Client (Hub) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Workshop" tab to the Hub letting users browse, preview, publish, like, and 1-click-apply community color themes, backed by the deployed Supabase project.

**Architecture:** No new runtime dependency — talk to Supabase over raw `fetch` (REST + Edge Functions), same style as `tracker.js`. A thin main-process module `workshop-net.js` owns all network calls + the Discord OAuth (PKCE) loopback flow; pure logic (sort/filter/view-model, cache (de)serialization, PKCE, callback parsing) lives in tested `lib/` modules. The Hub renderer gets a Workshop tab that renders live theme previews with the existing `themegen`, and applies a chosen theme through the existing `customThemes` IPC. Session (Discord) persists in `userData`.

**Tech Stack:** Electron (main `fetch`, `BrowserWindow`, `shell.openExternal`, `http` loopback server, `crypto`), Node.js CommonJS + `node:test`, existing `lib/themegen.js`, raw Supabase REST/Functions.

## Global Constraints

- NO new npm dependency. Use global `fetch`, node `http`, node `crypto`.
- Supabase project URL: `https://kdrycvlxbynemxweyypg.supabase.co` (config, not hardcoded in many places — single module).
- Supabase anon key is PUBLIC and ships in the client (safe; RLS enforces access). Never ship service_role.
- Endpoints (already deployed + verified): `GET /rest/v1/themes?status=eq.live`, `POST /rest/v1/likes`, `DELETE /rest/v1/likes`, `POST /functions/v1/publish`, `POST /functions/v1/install`, `GET /auth/v1/authorize?provider=discord`, `POST /auth/v1/token`.
- Theme shape `{ name, aA, aB, bg, txt }`; server columns are `a_a,a_b,bg,txt` (map on read). Tags from `shared/theme-rules.json`.
- Apply must reuse the existing `customThemes` add IPC and respect the 20-slot cap.
- Pure logic in `lib/` with `node:test`; keep files focused. French comments, existing conventions.
- OAuth: PKCE code flow. Loopback redirect `http://127.0.0.1:<port>/cb`. This URL MUST be added to the project's Auth `uri_allow_list` (ops step, documented — not code).

---

### Task 1: Workshop config + REST URL builders (pure, tested)

**Files:**
- Create: `lib/workshop-config.js`
- Test: `test/workshop-config.test.js`

**Interfaces:**
- Produces: `SUPABASE_URL`, `ANON_KEY`, `restUrl(path, query)`, `fnUrl(name)`, `authHeaders(token?)`.

- [ ] **Step 1: Write the failing test**

`test/workshop-config.test.js`:
```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/workshop-config.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`lib/workshop-config.js`:
```js
'use strict';
// Config Supabase du Workshop. anon key = PUBLIQUE (RLS protège). Aucun secret.
const SUPABASE_URL = 'https://kdrycvlxbynemxweyypg.supabase.co';
const ANON_KEY = 'PASTE_ANON_KEY_HERE'; // clé anon publique du projet (voir /tmp/prod_anon)

function restUrl(path, query) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  return `${SUPABASE_URL}/rest/v1/${path}${qs}`;
}
function fnUrl(name) { return `${SUPABASE_URL}/functions/v1/${name}`; }
function authHeaders(token) {
  return { apikey: ANON_KEY, Authorization: 'Bearer ' + (token || ANON_KEY) };
}
module.exports = { SUPABASE_URL, ANON_KEY, restUrl, fnUrl, authHeaders };
```
NOTE (ops): replace `PASTE_ANON_KEY_HERE` with the real anon key from `/tmp/prod_anon` (public, safe to commit).

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/workshop-config.test.js`
Expected: PASS (4 tests). (URLSearchParams encodes `,` as `%2C`.)

- [ ] **Step 5: Commit**

```bash
git add lib/workshop-config.js test/workshop-config.test.js
git commit -m "feat: workshop supabase config + url builders"
```

---

### Task 2: Gallery view-model + cache (pure, tested)

**Files:**
- Create: `lib/workshop.js`
- Test: `test/workshop.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `mapRow(row) -> { id, name, author, aA, aB, bg, txt, tags, installs, likes }` (maps DB `a_a/a_b` → `aA/aB`)
  - `sortThemes(list, mode) -> list` (mode: 'popular'|'liked'|'recent')
  - `filterThemes(list, { tag, q }) -> list`
  - `serializeCache(list) -> string`, `parseCache(str) -> list` (safe, returns [] on bad input)

- [ ] **Step 1: Write the failing test**

`test/workshop.test.js`:
```js
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
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test test/workshop.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

`lib/workshop.js`:
```js
'use strict';
// Logique pure de la galerie Workshop (tri/filtre/cache). Pas d'I/O ni de réseau.
function mapRow(r) {
  r = r || {};
  return {
    id: r.id, name: r.name || '', author: r.author || (r.profiles && r.profiles.discord_name) || '',
    aA: r.a_a, aB: r.a_b, bg: r.bg, txt: r.txt,
    tags: Array.isArray(r.tags) ? r.tags : [],
    installs: r.installs | 0, likes: r.likes | 0,
    createdAt: r.created_at || null,
  };
}
function sortThemes(list, mode) {
  const a = (list || []).slice();
  if (mode === 'liked') a.sort((x, y) => y.likes - x.likes);
  else if (mode === 'recent') a.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
  else a.sort((x, y) => y.installs - x.installs); // popular par défaut
  return a;
}
function filterThemes(list, opts) {
  const o = opts || {};
  const q = (o.q || '').toLowerCase().trim();
  return (list || []).filter((t) => {
    if (o.tag && !(t.tags || []).includes(o.tag)) return false;
    if (q && !String(t.name).toLowerCase().includes(q)) return false;
    return true;
  });
}
function serializeCache(list) { return JSON.stringify(list || []); }
function parseCache(str) {
  try { const v = JSON.parse(str); return Array.isArray(v) ? v : []; } catch { return []; }
}
module.exports = { mapRow, sortThemes, filterThemes, serializeCache, parseCache };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/workshop.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/workshop.js test/workshop.test.js
git commit -m "feat: workshop gallery pure logic (map/sort/filter/cache)"
```

---

### Task 3: PKCE + OAuth callback parsing (pure, tested)

**Files:**
- Create: `lib/pkce.js`
- Test: `test/pkce.test.js`

**Interfaces:**
- Consumes: node `crypto`.
- Produces:
  - `makePkce() -> { verifier, challenge }` (challenge = base64url(sha256(verifier)))
  - `parseCallback(reqUrl) -> { code, state } | null` (extracts query params from the loopback callback URL)

- [ ] **Step 1: Write the failing test**

`test/pkce.test.js`:
```js
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
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test test/pkce.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

`lib/pkce.js`:
```js
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
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/pkce.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/pkce.js test/pkce.test.js
git commit -m "feat: PKCE helpers + oauth callback parsing"
```

---

### Task 4: Main-process Workshop network + OAuth loopback + IPC

**Files:**
- Create: `workshop-net.js`
- Modify: `main.js` (require + register IPC handlers, near other `ipcMain.handle` blocks)
- Modify: `hub-preload.js` (expose workshop IPC to the Hub renderer)

**Interfaces:**
- Consumes: `lib/workshop-config.js`, `lib/workshop.js`, `lib/pkce.js`, existing `addCustomTheme` path (main.js has `set-custom-theme` / customThemes handling — reuse it).
- Produces (IPC channels, all `ipcMain.handle`):
  - `workshop:list` `({ sort, tag, q }) -> { ok, themes }` (fetch REST, map/sort/filter, cache to userData)
  - `workshop:cache` `() -> { themes }` (last cached list; for offline/instant paint)
  - `workshop:login` `() -> { ok, user }` (Discord OAuth PKCE loopback; persists session)
  - `workshop:session` `() -> { user|null }`
  - `workshop:logout` `() -> { ok }`
  - `workshop:publish` `(theme) -> { ok, id?|error }`
  - `workshop:like` `({ id, liked }) -> { ok }`
  - `workshop:install` `({ id }) -> { ok, installs }` (also adds to customThemes)

- [ ] **Step 1: Write `workshop-net.js`**

`workshop-net.js`:
```js
'use strict';
// Réseau Workshop (raw fetch, aucune dépendance). Auth Discord via PKCE + loopback.
const http = require('node:http');
const { shell } = require('electron');
const { makePkce, parseCallback } = require('./lib/pkce');
const { restUrl, fnUrl, authHeaders, SUPABASE_URL, ANON_KEY } = require('./lib/workshop-config');
const { mapRow } = require('./lib/workshop');

let session = null; // { access_token, refresh_token, user }

function setSession(s) { session = s; }
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

// OAuth Discord (PKCE) : loopback local capte le ?code, échange contre une session.
function loginDiscord() {
  return new Promise((resolve) => {
    const { verifier, challenge } = makePkce();
    const server = http.createServer(async (req, res) => {
      const cb = parseCallback(req.url);
      if (!cb) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>Connecté. Tu peux fermer cet onglet.</h2>');
      try {
        const port = server.address().port;
        const tr = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
          method: 'POST',
          headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ auth_code: cb.code, code_verifier: verifier }),
        });
        const s = await tr.json();
        server.close();
        if (s.access_token) { setSession({ access_token: s.access_token, refresh_token: s.refresh_token, user: s.user }); resolve({ ok: true, user: s.user }); }
        else resolve({ ok: false, error: 'token' });
      } catch (e) { server.close(); resolve({ ok: false, error: e.message }); }
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirect = `http://127.0.0.1:${port}/cb`;
      const url = `${SUPABASE_URL}/auth/v1/authorize?provider=discord`
        + `&redirect_to=${encodeURIComponent(redirect)}`
        + `&code_challenge=${challenge}&code_challenge_method=s256`;
      shell.openExternal(url);
    });
    setTimeout(() => { try { server.close(); } catch {} resolve({ ok: false, error: 'timeout' }); }, 180000);
  });
}

module.exports = { listThemes, publishTheme, likeTheme, installTheme, loginDiscord, getUser, setSession };
```

- [ ] **Step 2: Wire IPC + persistence in `main.js`**

Add near the other `ipcMain.handle` blocks (after the `set-overlay-flag` handler):
```js
const workshop = require('./workshop-net');
const WORKSHOP_CACHE = path.join(app.getPath('userData'), 'workshop-cache.json');
const WORKSHOP_SESSION = path.join(app.getPath('userData'), 'workshop-session.json');
const wsPure = require('./lib/workshop');

// restaure la session au boot (best-effort)
try { const s = JSON.parse(fs.readFileSync(WORKSHOP_SESSION, 'utf8')); if (s && s.access_token) workshop.setSession(s); } catch {}

ipcMain.handle('workshop:list', async (_e, opts) => {
  try {
    const all = await workshop.listThemes();
    try { fs.writeFileSync(WORKSHOP_CACHE, wsPure.serializeCache(all)); } catch {}
    let list = wsPure.filterThemes(all, opts || {});
    list = wsPure.sortThemes(list, (opts && opts.sort) || 'popular');
    return { ok: true, themes: list };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('workshop:cache', () => {
  try { return { themes: wsPure.parseCache(fs.readFileSync(WORKSHOP_CACHE, 'utf8')) }; } catch { return { themes: [] }; }
});
ipcMain.handle('workshop:session', () => ({ user: workshop.getUser() }));
ipcMain.handle('workshop:login', async () => {
  const r = await workshop.loginDiscord();
  if (r.ok) { try { fs.writeFileSync(WORKSHOP_SESSION, JSON.stringify({ access_token: workshop._tok(), user: r.user })); } catch {} }
  return r;
});
ipcMain.handle('workshop:logout', () => { workshop.setSession(null); try { fs.rmSync(WORKSHOP_SESSION); } catch {} return { ok: true }; });
ipcMain.handle('workshop:publish', (_e, t) => workshop.publishTheme(t));
ipcMain.handle('workshop:like', (_e, a) => workshop.likeTheme(a.id, a.liked));
ipcMain.handle('workshop:install', async (_e, a) => {
  const res = await workshop.installTheme(a.id);
  return res;
});
```
Add a tiny accessor in `workshop-net.js` module.exports: `_tok: token`.

- [ ] **Step 3: Expose to renderer in `hub-preload.js`**

Add to the exposed `hub` object:
```js
workshop: {
  list: (o) => ipcRenderer.invoke('workshop:list', o),
  cache: () => ipcRenderer.invoke('workshop:cache'),
  session: () => ipcRenderer.invoke('workshop:session'),
  login: () => ipcRenderer.invoke('workshop:login'),
  logout: () => ipcRenderer.invoke('workshop:logout'),
  publish: (t) => ipcRenderer.invoke('workshop:publish', t),
  like: (id, liked) => ipcRenderer.invoke('workshop:like', { id, liked }),
  install: (id) => ipcRenderer.invoke('workshop:install', { id }),
},
```

- [ ] **Step 4: Syntax + boot check**

Run: `node --check main.js && node --check workshop-net.js`
Expected: both OK. (Full OAuth is GUI/network — verified manually on the user's machine, see Task 6.)

- [ ] **Step 5: Commit**

```bash
git add workshop-net.js main.js hub-preload.js
git commit -m "feat: workshop main-process net + OAuth loopback + IPC"
```

---

### Task 5: Hub Workshop tab UI (browse / publish / mine)

**Files:**
- Modify: `hub.html` (add Workshop tab button, panel markup, and its renderer JS)

**Interfaces:**
- Consumes: `window.hub.workshop.*` (Task 4), `window.themegen.deriveTheme` (already loaded in Hub).
- Produces: the visible Workshop UI. No new exports.

- [ ] **Step 1: Add tab + panel markup**

In `hub.html`, add a nav entry `data-tab="workshop"` next to the existing tabs, and a panel:
```html
<section id="tab-workshop" class="tabpanel">
  <div class="ws-bar">
    <div class="ws-sorts">
      <button class="ws-sort on" data-sort="popular">Populaires</button>
      <button class="ws-sort" data-sort="liked">Aimés</button>
      <button class="ws-sort" data-sort="recent">Récents</button>
    </div>
    <input id="ws-search" placeholder="Rechercher un thème…" />
    <button id="ws-login">Se connecter (Discord)</button>
    <button id="ws-publish-open" hidden>Publier mon thème</button>
  </div>
  <div id="ws-grid" class="ws-grid"></div>
</section>
```

- [ ] **Step 2: Add the tile renderer (live preview via themegen)**

Add this script block in `hub.html`:
```js
function wsTile(t) {
  const tk = window.themegen.deriveTheme({ aA: t.aA, aB: t.aB, bg: t.bg, txt: t.txt });
  const el = document.createElement('div');
  el.className = 'ws-tile';
  el.style.background = tk.bg; el.style.color = tk.txt; el.style.borderColor = tk.line;
  el.innerHTML =
    `<div class="ws-mmr" style="color:${tk.aA}">1234</div>` +
    `<div class="ws-name">${escapeHtml(t.name)}</div>` +
    `<div class="ws-meta"><span>⬇ ${t.installs}</span> <span class="ws-like" data-id="${t.id}">♥ ${t.likes}</span></div>` +
    `<button class="ws-apply" data-id="${t.id}">Appliquer</button>`;
  return el;
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
```
(`escapeHtml` may already exist — reuse if so; do not duplicate.)

- [ ] **Step 3: Wire load + interactions**

```js
let wsState = { sort: 'popular', tag: null, q: '' };
async function wsLoad() {
  const grid = document.getElementById('ws-grid');
  const cached = await window.hub.workshop.cache();
  if (cached.themes.length) wsRender(cached.themes);       // paint instant depuis le cache
  const r = await window.hub.workshop.list(wsState);
  if (r.ok) wsRender(r.themes);
  else if (!cached.themes.length) grid.innerHTML = '<div class="ws-empty">Hors-ligne ou aucune donnée.</div>';
}
function wsRender(themes) {
  const grid = document.getElementById('ws-grid');
  grid.innerHTML = '';
  themes.forEach((t) => grid.appendChild(wsTile(t)));
}
document.getElementById('ws-grid').addEventListener('click', async (e) => {
  const apply = e.target.closest('.ws-apply');
  if (apply) { await window.hub.workshop.install(apply.getAttribute('data-id')); /* install-count */ 
    const t = wsCurrent.find((x) => x.id === apply.getAttribute('data-id'));
    if (t) window.hub.addCustomTheme ? window.hub.addCustomTheme(t) : window.hub.setFlag && 0; // applied via existing customTheme path
    apply.textContent = 'Appliqué ✓'; return; }
  const like = e.target.closest('.ws-like');
  if (like) { const id = like.getAttribute('data-id'); const r = await window.hub.workshop.like(id, true); if (r.ok) like.textContent = '♥ +'; }
});
document.querySelectorAll('.ws-sort').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.ws-sort').forEach((x) => x.classList.remove('on')); b.classList.add('on');
  wsState.sort = b.getAttribute('data-sort'); wsLoad();
}));
document.getElementById('ws-search').addEventListener('input', (e) => { wsState.q = e.target.value; wsLoad(); });
document.getElementById('ws-login').addEventListener('click', async () => {
  const r = await window.hub.workshop.login();
  if (r.ok) { document.getElementById('ws-login').textContent = r.user.user_metadata.full_name; document.getElementById('ws-publish-open').hidden = false; }
});
```
Keep a module-scope `wsCurrent` set in `wsRender` (`wsCurrent = themes`) so apply can find the theme object.

- [ ] **Step 4: Publish flow (reuse the color editor)**

Wire `#ws-publish-open` to open the existing theme editor (the `show-theme` editor already in the Hub) with a "Publier" action that reads the 4 pickers + name + selected tag chips and calls `window.hub.workshop.publish({name,aA,aB,bg,txt,tags})`; on `{ok:true}` toast success and reload the gallery. Tag chips come from `require`? No — hardcode the same list as `shared/theme-rules.json` allowedTags in a small const in hub.html (renderer can't require app files reliably); keep in sync with the JSON.

- [ ] **Step 5: Load the tab on open + minimal CSS**

Call `wsLoad()` when the Workshop tab is activated. Add CSS for `.ws-grid` (responsive grid), `.ws-tile` (rounded card, padding), `.ws-bar` (flex row) consistent with the Hub's existing settings styling.

- [ ] **Step 6: Manual GUI verification (user machine)**

On a machine with a display: `npm start`, open Hub (Ctrl+Alt+H or the Hub key), go to Workshop tab.
Expected: gallery paints tiles with live theme colors; sort buttons reorder; search filters; "Se connecter" opens Discord in the browser and returns logged-in; publishing a theme makes it appear; Apply adds it to custom themes and it becomes selectable; like increments.

- [ ] **Step 7: Commit**

```bash
git add hub.html
git commit -m "feat: Hub Workshop tab (browse/preview/publish/like/apply)"
```

---

### Task 6: Apply → customThemes wiring + ops notes

**Files:**
- Modify: `main.js` (ensure `workshop:install` also adds the theme to `customThemes`, respecting the 20 cap)
- Modify: `docs/supabase-setup.md` (add the loopback redirect to the Auth allow-list note)

**Interfaces:**
- Consumes: existing customThemes add logic in main.js (`cfg.overlay.customThemes`, cap 20, dedupe by name).
- Produces: applying a Workshop theme persists it locally like a hand-made custom theme.

- [ ] **Step 1: Extend `workshop:install` to persist the theme**

Change the `workshop:install` handler (Task 4 Step 2) so the renderer sends the whole theme object, and main adds it to customThemes using the SAME code path as the existing add-custom-theme handler (extract that into a small `addCustomTheme(cfg, theme)` helper if not already, to avoid duplication), respecting cap 20 + dedupe by name, then saveConfig + sendUpdate so the overlay updates live.

- [ ] **Step 2: Syntax check**

Run: `node --check main.js`
Expected: OK.

- [ ] **Step 3: Document the OAuth allow-list op**

Append to `docs/supabase-setup.md`:
```markdown
## OAuth redirect (client desktop)
The Electron client uses a loopback redirect `http://127.0.0.1:<random-port>/cb`.
Add `http://127.0.0.1` (and/or a wildcard `http://127.0.0.1:*`) to Auth → URL
Configuration → Redirect URLs (uri_allow_list) so Supabase accepts the redirect.
Without it, login returns "redirect_to not allowed".
```

- [ ] **Step 4: Commit**

```bash
git add main.js docs/supabase-setup.md
git commit -m "feat: apply workshop theme -> customThemes + OAuth allow-list doc"
```

---

## Self-Review

**Spec coverage (§4/§5 of the design):**
- Browse (sortable, filter, search) → Task 2 + Task 5. ✓
- Live preview via themegen → Task 5 Step 2. ✓
- Publish (login required, color editor) → Task 4 (publish) + Task 5 Step 4. ✓
- Like (1/user) → Task 4 (like) + Task 5. ✓
- Apply → customThemes → Task 6. ✓
- Offline cache → Task 4 (cache write) + Task 5 (cache paint). ✓
- Discord login → Task 3 (PKCE) + Task 4 (loopback). ✓
- No secret in client (anon only) → Global Constraints + Task 1. ✓

**Placeholder scan:** `PASTE_ANON_KEY_HERE` is an explicit ops step with the source named (`/tmp/prod_anon`), not a silent gap. Tag list duplicated in hub.html is called out as "keep in sync." Everything else has full code.

**Type consistency:** DB `a_a/a_b` → client `aA/aB` mapped in `mapRow` (Task 2) and reversed in `publishTheme` body (Task 4). IPC channel names identical between main handlers (Task 4 Step 2), preload (Task 4 Step 3), and renderer calls (Task 5 Step 3). `loginDiscord`/`setSession`/`getUser`/`_tok` defined in Task 4 Step 1 and used in Task 4 Step 2.

**Known GUI-verification gap:** Tasks 4–6 involve Electron runtime + real OAuth + GUI; unit-testable parts are isolated into Tasks 1–3 (pure, `node:test`). Tasks 4–6 are syntax-checked here and require manual GUI verification on a machine with a display (Task 5 Step 6).
