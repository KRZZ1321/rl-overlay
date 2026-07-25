// Récupération du MMR via l'API JSON PUBLIQUE du Tracker Network.
// AUCUNE injection, aucune lecture mémoire du jeu : on charge une fois la page
// profil publique dans un Chromium caché (pose les cookies Cloudflare), puis on
// interroge l'API JSON depuis le contexte de la page (rapide, ~300 ms).
// C'est exactement ce que fait le site lui-même -> aucun risque de ban.

const { BrowserWindow } = require('electron');

// metadata.name de l'API  ->  clé interne utilisée par l'overlay.
const NAME2KEY = {
  'Ranked Duel 1v1':    'ranked-duel',
  'Ranked Doubles 2v2': 'ranked-doubles',
  'Ranked Standard 3v3':'ranked-standard',
  'Hoops':              'hoops',
  'Rumble':             'rumble',
  'Dropshot':           'dropshot',
  'Snowday':            'snowday',
  'Heatseeker':         'heatseeker',
  'Ranked 4v4 Quads':   'quads',
  'Casual':             'casual'
};

const API_BASE = 'https://api.tracker.gg/api/v2/rocket-league/standard/profile';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

let hiddenWin = null;
let primed = false; // page chargée + Cloudflare passé pour la fenêtre courante

function getHiddenWindow() {
  if (hiddenWin && !hiddenWin.isDestroyed()) return hiddenWin;
  hiddenWin = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: { offscreen: false, backgroundThrottling: false }
  });
  hiddenWin.webContents.setUserAgent(UA);
  primed = false;
  return hiddenWin;
}

function apiUrl(plat, username) {
  return `${API_BASE}/${plat}/${encodeURIComponent(username)}`;
}

// Charge la page profil pour établir la session navigateur (cookies Cloudflare),
// puis attend que l'API réponde 200 (au lieu d'une attente fixe de 8 s).
async function primeWindow(w, plat, username) {
  const pageUrl = `https://rocketleague.tracker.network/rocket-league/profile/${plat}/${encodeURIComponent(username)}/overview`;
  await w.loadURL(pageUrl);
  const url = apiUrl(plat, username);
  const start = Date.now();
  while (Date.now() - start < 12000) {
    let status = 0;
    try {
      status = await w.webContents.executeJavaScript(
        `fetch(${JSON.stringify(url)},{headers:{Accept:'application/json'}}).then(r=>r.status).catch(()=>0)`
      );
    } catch { status = 0; }
    if (status === 200) { primed = true; return; }
    await new Promise((r) => setTimeout(r, 600));
  }
  primed = true; // on tentera quand même le fetch ensuite
}

// Un seul fetch API depuis le contexte de la page -> {ratings, goals, saves}.
async function fetchOnce(w, plat, username) {
  const url = apiUrl(plat, username);
  const script = `(async () => {
    const r = await fetch(${JSON.stringify(url)}, { headers: { Accept: 'application/json' } });
    if (r.status !== 200) return { __status: r.status };
    const j = await r.json();
    const map = ${JSON.stringify(NAME2KEY)};
    const ratings = {};
    const meta = {}; // par playlist : tier, div, streak (signé : + win, - loss)
    let goals = null, saves = null;
    for (const s of (j.data && j.data.segments) || []) {
      if (s.type === 'playlist') {
        const key = map[s.metadata && s.metadata.name];
        if (!key || !s.stats) continue;
        if (s.stats.rating) ratings[key] = s.stats.rating.value;
        const tier = s.stats.tier && s.stats.tier.metadata && s.stats.tier.metadata.name;
        const div = s.stats.division && s.stats.division.metadata && s.stats.division.metadata.name;
        const icon = (s.stats.tier && s.stats.tier.metadata && s.stats.tier.metadata.iconUrl) || null;
        const ws = s.stats.winStreak;
        let streak = 0;
        if (ws) streak = (ws.metadata && ws.metadata.type === 'loss') ? -ws.value : ws.value;
        meta[key] = { tier: tier || null, div: div || null, icon, streak };
      } else if (s.type === 'overview') {
        if (s.stats && s.stats.goals) goals = s.stats.goals.value;
        if (s.stats && s.stats.saves) saves = s.stats.saves.value;
      }
    }
    return { ratings, meta, goals, saves };
  })()`;
  return await w.webContents.executeJavaScript(script);
}

async function fetchStats(platform, username, force) {
  const plat = (platform || 'epic').toLowerCase();
  const w = getHiddenWindow();

  // force (refresh de fin de match) : on recharge la page pour des données 100%
  // fraîches (session Cloudflare renouvelée), au lieu de risquer une réponse en
  // cache. Les polls normaux gardent le cache navigateur -> pas de martèlement.
  if (force) primed = false;
  if (!primed) await primeWindow(w, plat, username);

  let res = await fetchOnce(w, plat, username);
  // Cookies Cloudflare expirés (403/challenge) -> on recharge la page et on retente.
  if (res && res.__status) {
    primed = false;
    await primeWindow(w, plat, username);
    res = await fetchOnce(w, plat, username);
  }
  if (!res || res.__status) throw new Error('API tracker status ' + (res && res.__status));
  return res;
}

// Ferme la fenêtre Chromium cachée pour libérer RAM/GPU quand l'overlay n'est
// pas affiché (pas en jeu). Recréée + re-primée au prochain fetchStats.
function closeHidden() {
  if (hiddenWin && !hiddenWin.isDestroyed()) hiddenWin.destroy();
  hiddenWin = null;
  primed = false;
}

module.exports = { fetchStats, closeHidden };
