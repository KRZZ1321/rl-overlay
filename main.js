const { app, BrowserWindow, ipcMain, globalShortcut, screen, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { fetchStats, closeHidden } = require('./tracker');
const { DiscordRPC } = require('./discord-rpc');
const { loadHistory, saveHistory } = require('./lib/history-store');
const { recordSample } = require('./lib/history');
const { buildViewModel } = require('./lib/viewmodel');
const { isNewer, pickAsset, repoSlug, compareVersions } = require('./lib/updater');
const { startLogWatcher, defaultLogPath } = require('./rllog');
const { startStatsApi } = require('./statsapi');
const { enableStatsApi, findRocketLeague } = require('./lib/rlinstall');
const { matchModel, resultFromScores } = require('./lib/statsmodel');
const { createAggregator } = require('./lib/matchagg');
const mmrcalib = require('./lib/mmrcalib');
const themegen = require('./lib/themegen');

// Nb total de thèmes (built-in + customs) et payload d'application du thème courant :
// built-in -> { theme: idx } (classe body.tN) ; custom -> { themeVars } (vars inline).
function themeCount() { return THEME_COUNT + ((loadConfig().overlay.customThemes || []).length); }
function themePayload() {
  const o = loadConfig().overlay;
  const tot = THEME_COUNT + ((o.customThemes || []).length);
  const idx = (((o.theme || 0) % tot) + tot) % tot;
  if (idx < THEME_COUNT) return { theme: idx };
  const c = (o.customThemes || [])[idx - THEME_COUNT];
  return c ? { themeVars: themegen.deriveTheme(c), themeName: c.name } : { theme: 0 };
}
const { startObsServer } = require('./obsserver');
const OBS_PORT = 49200;
const OBS_URL = 'http://127.0.0.1:' + OBS_PORT + '/';
const { makeEntry, appendMatch, summarize, attachMmr } = require('./lib/matchlog');
const { normalizeOverlayFlag } = require('./lib/settings-flags');
const { sparkline } = require('./lib/sparkline');

// Nom du process de Rocket League (sans .exe) tel que renvoyé par Get-Process.
const RL_PROCESS = 'RocketLeague';

// Les fichiers modifiables vont dans userData (écriture autorisée même quand
// l'app est packagée en .exe). __dirname serait en lecture seule (asar).
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const SESSION_PATH = path.join(app.getPath('userData'), 'session.json');
const HISTORY_PATH = path.join(app.getPath('userData'), 'history.json');

const DEFAULT_CONFIG = {
  platform: 'epic',
  username: '',
  playlist: 'ranked-doubles',
  pollSeconds: 15,
  overlay: { anchor: 'bottom-right', marginX: 320, marginY: 50, x: 20, y: 20, clickThrough: true, theme: 0, layout: 5, tutoSeen: false, lastSeenVersion: null, mmrGlow: true, showMusic: true, overlayScale: 100, overlayOpacity: 100, font: 'default', mmrSize: 100, showStreak: true, showDelta: true, customThemes: [] },
  // Discord Rich Presence : affiche MMR/rang live sur ton profil Discord.
  // clientId = "Application ID" d'une app creee sur discord.com/developers
  // (1 min, voir README). Vide = desactive. largeImageKey = cle d'un asset
  // uploade sur l'app (optionnel) ; sinon pas d'image.
  discord: { enabled: true, clientId: '', largeImageKey: '', showProfileButton: true }
};

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, ''); // retire un BOM éventuel
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// L'app est-elle configurée ? (pseudo renseigné)
function isConfigured() {
  const c = loadConfig();
  return c.username && c.username.trim() && c.username !== 'TON_PSEUDO_ICI';
}

// Date du jour (YYYY-MM-DD) en local : sert de clé de "session du jour".
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Etat de session du JOUR, remis à zéro au changement de date.
// total : compteur W/L/streak GLOBAL (tous modes confondus).
// mmr   : dernier MMR + MMR de départ vus pour chaque mode (sert à détecter W/L
//         et à afficher le delta de la playlist sélectionnée).
function freshSession() {
  return { date: today(), total: { wins: 0, losses: 0, streak: 0 }, mmr: {}, goalsBase: null, savesBase: null };
}

function loadSession() {
  let s;
  try { s = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8')); } catch { s = null; }
  // Nouveau jour ou format obsolète -> on repart à zéro.
  if (!s || !s.total || !s.mmr || s.date !== today()) s = freshSession();
  return s;
}

function saveSession(s) {
  fs.writeFileSync(SESSION_PATH, JSON.stringify(s, null, 2));
}

// Référence MMR (dernier vu + départ) pour un mode donné aujourd'hui.
function mmrRef(pl) {
  if (session.date !== today()) session = freshSession();
  if (!session.mmr[pl]) session.mmr[pl] = { last: null, start: null };
  return session.mmr[pl];
}

let win;
let session;
let history; // état du store d'historique persistant (playlist sélectionnée)
let sessionStart = 0; // début de la session de jeu en cours (pour le chrono HUD), indépendant de Discord
let hubWin = null;   // fenêtre Hub plein écran (lazy : null tant que fermée)
let lastVm = null;   // dernier view-model complet (poussé au Hub à l'ouverture)
let clickThrough = true;

// --- Discord Rich Presence ---
let rpc = null;
let presenceStart = 0; // timestamp de debut de session de jeu (pour le chrono)

function profileUrl(cfg) {
  return `https://rocketleague.tracker.network/rocket-league/profile/${cfg.platform}/${encodeURIComponent(cfg.username)}/overview`;
}

// (Re)connecte le RPC selon la config. Idempotent.
function ensureRpc() {
  const cfg = loadConfig();
  if (!cfg.discord || !cfg.discord.enabled || !cfg.discord.clientId) {
    if (rpc) { rpc.close(); rpc = null; }
    return;
  }
  if (rpc && rpc.clientId !== cfg.discord.clientId) { rpc.close(); rpc = null; }
  if (!rpc) { rpc = new DiscordRPC(cfg.discord.clientId); rpc.onFrame = (j) => logFocus(`RPC frame ${j.slice(0, 300)}`); rpc.connect(); logFocus(`RPC create clientId=${cfg.discord.clientId}`); }
}

// Construit et pousse l'activite Discord a partir des donnees d'un poll.
function updatePresence(data) {
  ensureRpc();
  if (!rpc) return;
  const cfg = loadConfig();
  if (!presenceStart) presenceStart = Date.now();

  const parts = [];
  if (data.playlist) parts.push(data.playlist);
  if (data.mmr != null) parts.push(`${data.mmr} MMR`);
  const details = parts.join(' • ') || 'Rocket League';

  let state = '';
  if (data.rankTier) state = data.rankDiv ? `${data.rankTier} • ${data.rankDiv}` : data.rankTier;
  const wl = `${data.wins ?? 0}V ${data.losses ?? 0}D`;
  const streak = data.streak ? `  (${data.streak > 0 ? '🔥' : '❄'}${Math.abs(data.streak)})` : '';
  state = state ? `${state}  —  ${wl}${streak}` : `${wl}${streak}`;

  const activity = {
    details,
    state,
    timestamps: { start: presenceStart },
    instance: false
  };
  if (cfg.discord.largeImageKey) {
    activity.assets = { large_image: cfg.discord.largeImageKey, large_text: 'RL Overlay' };
  }
  if (cfg.discord.showProfileButton && cfg.username) {
    activity.buttons = [{ label: 'Profil Tracker', url: profileUrl(cfg) }];
  }
  rpc.setActivity(activity);
  logFocus(`RPC push connected=${rpc.connected} details="${details}" state="${state}"`);
}

function clearPresence() {
  presenceStart = 0;
  if (rpc) rpc.clear();
}

function createWindow() {
  const cfg = loadConfig();
  clickThrough = cfg.overlay.clickThrough;

  // Fenêtre élargie : laisse la place aux formes qui encadrent la jauge de boost.
  // Les formes "carte" restent ancrées en haut-gauche (margin du .panel) -> même
  // position à l'écran qu'avant. Les formes "Boost/Colonne" utilisent tout l'espace.
  const W = 300, H = 260;
  // Par défaut on ancre l'overlay en bas à droite, près de la jauge de boost.
  const work = screen.getPrimaryDisplay().workAreaSize;
  const mx = cfg.overlay.marginX ?? 28;
  const my = cfg.overlay.marginY ?? 96; // remonté pour ne pas masquer le boost
  let posX = work.width - W - mx;
  let posY = work.height - H - my;
  if (cfg.overlay.anchor === 'free') { posX = cfg.overlay.x ?? posX; posY = cfg.overlay.y ?? posY; }

  win = new BrowserWindow({
    width: W,
    height: H,
    x: posX,
    y: posY,
    show: false, // caché tant que Rocket League n'est pas au premier plan
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  });

  // Toujours au-dessus, même par-dessus un jeu en plein écran fenêtré.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(clickThrough, { forward: true });
  // Applique le thème mémorisé dès que la page est prête.
  win.webContents.on('did-finish-load', () => {
    const o = loadConfig().overlay;
    sendUpdate({ ...themePayload(), layout: o.layout || 0,
      mmrGlow: o.mmrGlow !== false, showMusic: o.showMusic !== false,
      overlayScale: o.overlayScale ?? 100, overlayOpacity: o.overlayOpacity ?? 100,
      font: o.font || 'default', mmrSize: o.mmrSize ?? 100,
      showStreak: o.showStreak !== false, showDelta: o.showDelta !== false });
  });
  win.loadFile('index.html');
}

const THEME_COUNT = 15;
const LAYOUT_COUNT = 9; // Minimal/Compact/Compétitif/Dashboard/Badge/Premium + Split Wing/Cyber/Marquee

// Passe au thème suivant, persiste, et notifie le renderer (avec toast).
function cycleTheme() {
  const cfg = loadConfig();
  const next = (((cfg.overlay.theme || 0) + 1) % themeCount());
  cfg.overlay.theme = next;
  saveConfig(cfg);
  sendUpdate({ ...themePayload(), themeToast: true }); // built-in (classe) ou custom (vars)
  pushHub(); // recolore le Hub en direct s'il est ouvert
}

// Passe à la forme (layout) suivante, persiste, et notifie le renderer.
function cycleLayout() {
  const cfg = loadConfig();
  const next = (((cfg.overlay.layout || 0) + 1) % LAYOUT_COUNT);
  cfg.overlay.layout = next;
  saveConfig(cfg);
  sendUpdate({ layout: next, layoutToast: true });
}

// Buts / saves du JOUR = total carrière actuel - référence prise en début de
// journée. Ces compteurs sont communs à toutes les playlists (pas de reset au
// changement de playlist), et repartent à zéro au changement de date.
function dayDelta(field, current) {
  const baseKey = field + 'Base';
  if (current == null) return session[baseKey] != null ? 0 : 0;
  if (session[baseKey] == null) session[baseKey] = current; // 1ère mesure du jour
  return Math.max(0, current - session[baseKey]);
}

// Détecte un changement de MMR sur un mode et met à jour le TOTAL global du jour.
function applyMmr(pl, mmr) {
  if (mmr == null) return;
  const ref = mmrRef(pl);
  if (ref.start == null) ref.start = mmr;
  if (ref.last != null && mmr !== ref.last) {
    const t = session.total;
    if (mmr > ref.last) { t.wins += 1; t.streak = t.streak >= 0 ? t.streak + 1 : 1; }
    else { t.losses += 1; t.streak = t.streak <= 0 ? t.streak - 1 : -1; }
  }
  ref.last = mmr;
}

// Garde-fou : un seul poll à la fois (sinon des chargements concurrents sur la
// fenêtre cachée se chevauchent et un ancien poll réimpose une sélection périmée).
let polling = false;

// Boucle de poll : on récupère TOUS les MMR + stats carrière.
// W/L = total du jour (tous modes). On affiche le MMR de la playlist choisie.
async function poll(force) {
  if (polling) return;
  if (!overlayVisible && !force) return; // pas en jeu = pas de scraping (perf) ; force = déclenché par le log (fin de match)
  polling = true;
  try {
    const cfg = loadConfig();
    let stats;
    try {
      stats = await fetchStats(cfg.platform, cfg.username);
    } catch (e) {
      sendUpdate({ error: 'MMR introuvable (Tracker bloqué ?)' });
      return;
    }

    const ratings = (stats && stats.ratings) || {};
    // Met à jour le total à partir de TOUS les modes (1v1...casual)
    for (const pl in ratings) applyMmr(pl, ratings[pl]);

    // On relit la playlist sélectionnée MAINTENANT (pas au début du poll) pour
    // toujours afficher le dernier choix, même si l'utilisateur a switché pendant
    // le chargement.
    const sel = loadConfig().playlist;
    const ref = mmrRef(sel);
    const mmr = ratings[sel] != null ? ratings[sel] : ref.last;
    if (mmr == null) return;

    // Enregistre le MMR de la playlist suivie dans l'historique persistant.
    // Un échec disque ne doit jamais faire échouer le poll.
    try {
      if (!history || history.playlist !== sel) history = loadHistory(HISTORY_PATH, sel);
      const recorded = recordSample(history, mmr, Date.now(), today());
      history = recorded.state;
      saveHistory(HISTORY_PATH, history);
    } catch (e) {
      logFocus && logFocus('history write ERREUR: ' + e.message);
    }
    checkForUpdate(); // une seule fois, en fond, jamais bloquant

    const goals = dayDelta('goals', stats.goals);
    const saves = dayDelta('saves', stats.saves);
    saveSession(session);

    // Rang + winstreak réelle (in-game) du mode sélectionné, fournis par l'API.
    const m = (stats && stats.meta && stats.meta[sel]) || {};
    const rankup = detectRankUp(sel, m); // montée de rang/division -> anim

    // View-model HUD (métriques dérivées) — source unique, renderer = affichage.
    const cfgNow = loadConfig();
    const vm = buildViewModel({
      mmr, startMmr: ref.start,
      events: history ? history.events : [],
      gameStreak: m.streak ?? null,
      session: session.total,
      sessionStart, now: Date.now(),
      state: history || null,
      rank: { tier: m.tier || null, division: m.div || null, playlist: shortPlaylist(sel) },
      dayKey: today(),
      goalsCfg: Array.isArray(cfgNow.goals) ? cfgNow.goals : null
    });
    lastVm = vm;

    const payload = {
      mmr, playlist: shortPlaylist(sel),
      startMmr: ref.start, goals, saves,
      rankTier: m.tier || null, rankDiv: m.div || null, rankIcon: m.icon || null,
      gameStreak: m.streak ?? null, rankup,
      promotion: vm.promotion, momentum: vm.momentum,
      boost: vm.boost, hot: vm.hot, sessionMs: vm.timeMs,
      ...session.total
    };
    sendUpdate(payload);
    pushHub(); // met à jour le Hub s'il est ouvert
    updatePresence(payload); // miroir sur Discord
  } finally {
    polling = false;
  }
}

// Ordre complet des rangs RL pour calculer une montée (tier inclut I/II/III).
const TIERS = [
  'Bronze I','Bronze II','Bronze III','Silver I','Silver II','Silver III',
  'Gold I','Gold II','Gold III','Platinum I','Platinum II','Platinum III',
  'Diamond I','Diamond II','Diamond III','Champion I','Champion II','Champion III',
  'Grand Champion I','Grand Champion II','Grand Champion III','Supersonic Legend'
];
const DIVS = ['Division I','Division II','Division III','Division IV'];

function rankScore(tier, div) {
  const ti = TIERS.indexOf(tier);
  if (ti < 0) return -1;
  return ti * 4 + Math.max(0, DIVS.indexOf(div));
}
function tierGroup(tier) { return tier.replace(/\s+I{1,3}$/, ''); }

// Baseline du dernier rang vu par mode (mémoire). 1ère mesure = pas d'anim ;
// au redémarrage on repart de l'état courant -> aucune fausse animation.
const rankBaseline = {};
function detectRankUp(pl, m) {
  if (!m || !m.tier) return undefined;
  const score = rankScore(m.tier, m.div);
  if (score < 0) return undefined;
  const prev = rankBaseline[pl];
  rankBaseline[pl] = { score, tier: m.tier };
  if (!prev || score <= prev.score) return undefined; // 1ère vue ou pas de montée
  const kind = TIERS.indexOf(m.tier) > TIERS.indexOf(prev.tier) ? 'tier' : 'div';
  return { kind, tier: m.tier, div: m.div || null, group: tierGroup(m.tier), icon: m.icon || null };
}

function shortPlaylist(pl) {
  const map = { 'ranked-duel': '1v1', 'duel': '1v1', 'ranked-doubles': '2v2', 'doubles': '2v2', 'ranked-standard': '3v3', 'standard': '3v3' };
  return map[(pl || '').toLowerCase()] || '2v2';
}

function sendUpdate(data) {
  if (win && !win.isDestroyed()) win.webContents.send('update', data);
}

// --- Hub plein écran (lazy, lecture seule) ---
let showKeysOnce = false; // arme l'affichage de la page touches au prochain push Hub
let showNewsOnce = false; // arme l'affichage de la page Nouveautés (1er lancement après update)

function pushHub() {
  if (hubWin && !hubWin.isDestroyed() && lastVm) {
    const o = loadConfig().overlay;
    const tp = themePayload();
    const payload = { ...lastVm, _theme: tp.theme, _themeVars: tp.themeVars || null,
      _customThemes: o.customThemes || [], _themeIndex: o.theme || 0,
      _mmrGlow: o.mmrGlow !== false, _showMusic: o.showMusic !== false,
      _overlayScale: o.overlayScale ?? 100, _overlayOpacity: o.overlayOpacity ?? 100,
      _font: o.font || 'default', _mmrSize: o.mmrSize ?? 100,
      _showStreak: o.showStreak !== false, _showDelta: o.showDelta !== false,
      _live: (lastLive && lastLive.inMatch) ? lastLive : null,
      _mmrLive: lastLiveMmr };
    if (showKeysOnce) { payload._showKeys = true; showKeysOnce = false; }
    if (showNewsOnce) { payload._showNews = true; showNewsOnce = false; }
    hubWin.webContents.send('hub-update', payload);
  }
}

function openHub() {
  if (hubWin && !hubWin.isDestroyed()) { hubWin.focus(); return; }
  const work = screen.getPrimaryDisplay().workAreaSize;
  hubWin = new BrowserWindow({
    width: Math.min(1100, work.width - 80),
    height: Math.min(720, work.height - 80),
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: '#0a0b0e', // = token --bg, évite le flash blanc
    resizable: true,
    skipTaskbar: false,
    alwaysOnTop: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'hub-preload.js'),
      contextIsolation: true
    }
  });
  hubWin.center();
  setOverlayVisible(false); // cache l'overlay tant que le Hub est ouvert
  let canAutoClose = false; // ignore le blur transitoire pendant l'apparition
  hubWin.once('ready-to-show', () => {
    hubWin.show(); hubWin.focus();
    setTimeout(() => { canAutoClose = true; }, 500);
  });
  // Pousse le dernier view-model connu dès que la page est prête (jamais de vide).
  hubWin.webContents.on('did-finish-load', () => pushHub());
  // Auto-fermeture quand l'utilisateur ne regarde plus le Hub (alt-tab/clic ailleurs).
  // Changer de page DANS le Hub ne déclenche pas de blur (même fenêtre) -> le Hub
  // reste ouvert ; ne se ferme que si on quitte la fenêtre. Évite l'overlay bloqué
  // caché quand le Hub reste ouvert en arrière-plan.
  hubWin.on('blur', () => { if (canAutoClose) closeHub(); });
  hubWin.on('closed', () => {
    hubWin = null;
    if (forceShow) setOverlayVisible(true); // restaure si affichage forcé ; sinon le watcher recale
    maybeAutoApplyUpdate(); // Hub fermé : si update prêt et hors-jeu, on applique
  });
  hubWin.loadFile('hub.html');
}

function closeHub() {
  if (hubWin && !hubWin.isDestroyed()) hubWin.close();
}

function toggleHub() {
  if (hubWin && !hubWin.isDestroyed()) closeHub();
  else openHub();
}

// Change la playlist AFFICHÉE (1v1 / 2v2 / 3v3) et persiste le choix.
// Le total W/L est global, seul le MMR affiché change.
function switchPlaylist(pl) {
  const cfg = loadConfig();
  if (cfg.playlist === pl) return;
  cfg.playlist = pl;
  saveConfig(cfg);
  const ref = mmrRef(pl);
  sendUpdate({ playlist: shortPlaylist(pl), mmr: ref.last, startMmr: ref.start, ...session.total });
  poll(); // récupère tout de suite le MMR à jour
}

// Remet à zéro le total W/L/streak du jour (les références MMR restent, pour ne
// pas compter de faux match au prochain poll).
function resetCurrent() {
  const cfg = loadConfig();
  session.total = { wins: 0, losses: 0, streak: 0 };
  saveSession(session);
  const ref = mmrRef(cfg.playlist);
  sendUpdate({ mmr: ref.last, playlist: shortPlaylist(cfg.playlist), startMmr: ref.start, ...session.total });
}

// IPC : reset de session, déclenché par un raccourci.
ipcMain.handle('reset-session', () => resetCurrent());
ipcMain.handle('hub-close', () => closeHub());

// IPC : diagnostic (page Réglages > Diagnostic). Aide le SAV (maj, log RL introuvable…).
ipcMain.handle('get-diagnostics', () => {
  const o = loadConfig().overlay || {};
  const logPath = o.logPath || defaultLogPath();
  let lastError = null;
  try { lastError = (lastVm && lastVm.error) || null; } catch {}
  return {
    version: app.getVersion(),
    userData: app.getPath('userData'),
    logPath,
    logFound: (() => { try { return fs.existsSync(logPath); } catch { return false; } })(),
    inGame: overlayVisible,
    hasStats: !!(lastVm && lastVm.mmr != null),
    updateStaged,
    isPackaged: app.isPackaged,
    installDir: path.dirname(app.getPath('exe')),
    installWritable: (() => {
      try { const d = path.dirname(app.getPath('exe')); const t = path.join(d, '.wtest' + Date.now()); fs.writeFileSync(t, 'x'); fs.unlinkSync(t); return true; } catch { return false; }
    })(),
  };
});
ipcMain.handle('get-matches', () => ({
  today: summarize(matches, today()),
  all: summarize(matches),
  recent: matches.slice(-12).reverse(),
  spark: sparkline(matches.slice(-30).map((m) => m.mmr).filter((n) => n != null)),
}));
// Remet les réglages d'affichage à leurs valeurs par défaut.
const OVERLAY_SETTING_DEFAULTS = { mmrGlow: true, showMusic: true, showStreak: true, showDelta: true, overlayScale: 100, overlayOpacity: 100, font: 'default', mmrSize: 100 };
ipcMain.handle('reset-overlay-settings', () => {
  const cfg = loadConfig();
  Object.assign(cfg.overlay, OVERLAY_SETTING_DEFAULTS);
  saveConfig(cfg);
  sendUpdate({ ...OVERLAY_SETTING_DEFAULTS }); // applique en direct sur l'overlay
  pushHub();                                    // resynchronise la page Réglages
  return true;
});
ipcMain.handle('open-logs-folder', () => { shell.openPath(app.getPath('userData')); return true; });
ipcMain.handle('force-update-check', () => { updateChecked = false; checkForUpdate(); return true; });
// Active la Stats API officielle (écrit DefaultStatsAPI.ini). À appeler au setup
// et via un bouton Réglages. Renvoie le détail (ok / need-admin / install-not-found).
ipcMain.handle('enable-stats-api', () => enableStatsApi());
// Copie l'URL de la source OBS dans le presse-papier.
ipcMain.handle('copy-obs-url', () => { clipboard.writeText(OBS_URL); return OBS_URL; });

// --- Éditeur de thèmes custom ---
// Enregistre (ou remplace par nom) un thème {name,aA,aB,bg,txt}, l'applique.
ipcMain.handle('save-custom-theme', (_e, t) => {
  if (!t || !t.name) return { ok: false };
  const cfg = loadConfig();
  const list = cfg.overlay.customThemes || [];
  const clean = { name: String(t.name).slice(0, 30), aA: t.aA, aB: t.aB, bg: t.bg, txt: t.txt };
  const i = list.findIndex((c) => c.name === clean.name);
  if (i >= 0) list[i] = clean; else list.push(clean);
  cfg.overlay.customThemes = list.slice(0, 20);
  const pos = cfg.overlay.customThemes.findIndex((c) => c.name === clean.name);
  cfg.overlay.theme = THEME_COUNT + pos; // applique ce custom
  saveConfig(cfg);
  sendUpdate({ ...themePayload() }); pushHub();
  return { ok: true };
});
ipcMain.handle('delete-custom-theme', (_e, name) => {
  const cfg = loadConfig();
  cfg.overlay.customThemes = (cfg.overlay.customThemes || []).filter((c) => c.name !== name);
  if ((cfg.overlay.theme || 0) >= THEME_COUNT + cfg.overlay.customThemes.length) cfg.overlay.theme = 0;
  saveConfig(cfg);
  sendUpdate({ ...themePayload() }); pushHub();
  return { ok: true };
});
ipcMain.handle('apply-theme', (_e, index) => {
  const cfg = loadConfig();
  const tot = THEME_COUNT + (cfg.overlay.customThemes || []).length;
  cfg.overlay.theme = (((Number(index) || 0) % tot) + tot) % tot;
  saveConfig(cfg);
  sendUpdate({ ...themePayload() }); pushHub();
  return { ok: true };
});

// IPC : réglage overlay depuis la page Réglages du Hub.
// Validation déléguée au module pur lib/settings-flags (bool/num/enum, testé).
ipcMain.handle('set-overlay-flag', (_e, key, value) => {
  const r = normalizeOverlayFlag(key, value);
  if (!r.ok) return false;
  const cfg = loadConfig();
  cfg.overlay[key] = r.value;
  saveConfig(cfg);
  sendUpdate({ [key]: r.value }); // applique en direct sur l'overlay
  pushHub();                      // garde la page Réglages en phase
  return true;
});

ipcMain.handle('get-setup-theme', () => (loadConfig().overlay.theme || 0));

// IPC : enregistre plateforme + pseudo. Sert au 1er lancement ET à la
// reconfiguration (Ctrl+Alt+P) si on s'est trompé de pseudo.
ipcMain.handle('save-setup', (_e, data) => {
  const cfg = loadConfig();
  const newUser = (data.username || '').trim();
  const changed = cfg.username !== newUser || cfg.platform !== (data.platform || 'epic').toLowerCase();
  cfg.platform = (data.platform || 'epic').toLowerCase();
  cfg.username = newUser;
  if (data.theme != null) {
    const t = parseInt(data.theme, 10);
    if (!Number.isNaN(t)) cfg.overlay.theme = ((t % THEME_COUNT) + THEME_COUNT) % THEME_COUNT;
  }
  saveConfig(cfg);
  // Nouveau joueur -> on repart sur une session vierge (MMR/stats différents).
  if (changed) { session = freshSession(); saveSession(session); }

  const firstRun = !overlayStarted && !cfg.overlay.tutoSeen;
  if (!overlayStarted) startOverlay(); // 1er lancement (NE force PAS la visibilité du HUD)
  else poll();                          // reconfiguration : on rafraîchit
  if (setupWin && !setupWin.isDestroyed()) setupWin.close();
  if (firstRun) {
    cfg.overlay.tutoSeen = true; saveConfig(cfg); // page touches : auto une seule fois
    showKeysOnce = true;
    // Active la Stats API officielle (stats live) dès le 1er lancement, best-effort.
    try { const r = enableStatsApi(); logFocus('setup: enableStatsApi ' + JSON.stringify(r)); } catch (e) { logFocus('setup enableStatsApi: ' + e.message); }
    openHub(); // pushHub() est appelé au did-finish-load du Hub -> envoie _showKeys
  }
  return true;
});

let setupWin = null;
let overlayStarted = false;

// Fenêtre de configuration affichée au tout premier lancement.
function createSetupWindow() {
  setupWin = new BrowserWindow({
    width: 470, height: 660,
    resizable: false, frame: true, title: 'RL Overlay — Configuration',
    backgroundColor: '#0c1120',
    webPreferences: { preload: path.join(__dirname, 'setup-preload.js'), contextIsolation: true }
  });
  setupWin.setMenuBarVisibility(false);
  setupWin.loadFile('setup.html');
}

// Déplace l'overlay de (dx,dy) px et mémorise la position absolue.
function nudge(dx, dy) {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  const nx = x + dx, ny = y + dy;
  win.setPosition(nx, ny);
  const cfg = loadConfig();
  cfg.overlay.anchor = 'free'; // on passe en position absolue mémorisée
  cfg.overlay.x = nx; cfg.overlay.y = ny;
  saveConfig(cfg);
}

// Affiche l'overlay seulement quand Rocket League est la fenêtre au premier plan.
// Un process PowerShell persistant rapporte le nom du process focus chaque
// seconde (P/Invoke GetForegroundWindow). Pas de module natif requis.
let focusProc = null;
let overlayVisible = false;
let forceShow = false; // affichage piloté par le focus RL ; Ctrl+Alt+H force on/off

// Dernier titre Spotify "Artiste - Titre" vu (null = pas de musique / pausé).
let lastSpotify = null;

// Reçoit le titre brut de la fenêtre Spotify. Un vrai morceau contient " - "
// (Artiste - Titre) ; "Spotify" seul = pausé/arrêté -> null. On ne pousse au
// renderer qu'en jeu (overlay visible) et seulement si la valeur a changé.
function handleSpotify(title) {
  const np = title && title.includes(' - ') ? title : null;
  if (np === lastSpotify) return;
  lastSpotify = np;
  if (overlayVisible) sendUpdate({ spotify: np });
}

// Log debug dans userData/overlay.log (sert à diagnostiquer "visible partout").
function logFocus(msg) {
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'overlay.log'),
      `[${new Date().toISOString()}] ${msg}\n`
    );
  } catch {}
}

// ---- Auto-update (check au boot, staging en fond, swap auto hors-jeu) ----
let updateChecked = false;
let updateStaged = false; // un update est téléchargé et prêt à être appliqué

function extractZip(zip, dest) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`], { stdio: 'ignore' });
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('unzip exit ' + c))));
    p.on('error', reject);
  });
}

// Suppression best-effort : ne JAMAIS throw (un fichier verrouillé par EAC /
// antivirus ne doit pas casser l'update — sinon ENOTEMPTY bloque tout staging).
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { logFocus('rmrf ' + p + ': ' + e.message); } }

async function downloadAndStage(url, version) {
  const dir = path.join(app.getPath('userData'), 'update');
  fs.mkdirSync(dir, { recursive: true });
  // Nettoyage best-effort des restes (anciens staged*/zip). Si un reste est
  // verrouillé, on continue quand même : on stage dans un dossier suffixé par
  // version (nom neuf), donc aucune dépendance à la suppression de l'ancien.
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('staged') || name.endsWith('.zip')) rmrf(path.join(dir, name));
  }
  const zipPath = path.join(dir, `RL-Overlay-${version}.zip`);
  const res = await fetch(url, { headers: { 'User-Agent': 'rl-overlay' } });
  if (!res.ok) throw new Error('download ' + res.status);
  fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  const stagedDir = path.join(dir, 'staged-' + version);
  rmrf(stagedDir);
  await extractZip(zipPath, stagedDir);
  if (!fs.existsSync(path.join(stagedDir, 'RL Overlay.exe'))) {
    rmrf(stagedDir); rmrf(zipPath);
    throw new Error('staged exe manquant');
  }
  fs.writeFileSync(path.join(dir, 'apply-update.ps1'), APPLY_UPDATE_PS);
  fs.writeFileSync(path.join(dir, 'pending.json'), JSON.stringify({ version, stagedDir }));
  logFocus('update stagé: ' + version);
}

async function checkForUpdate() {
  if (updateChecked || !app.isPackaged) return;
  updateChecked = true;
  try {
    const pkg = require('./package.json');
    const slug = repoSlug(pkg);
    if (!slug) return;
    const res = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'rl-overlay' }
    });
    if (!res.ok) return;
    const rel = await res.json();
    if (!isNewer(rel.tag_name, pkg.version)) return;
    const asset = pickAsset(rel, 'RL-Overlay-win-x64.zip');
    if (!asset) return;
    await downloadAndStage(asset.browser_download_url, rel.tag_name.replace(/^v/i, ''));
    updateStaged = true;
    maybeAutoApplyUpdate(); // applique tout de suite si on est hors-jeu
  } catch (e) {
    logFocus('checkForUpdate: ' + e.message);
  }
}

// Applique un update prêt SEULEMENT hors-jeu (overlay caché) et hors Hub :
// l'app se ferme et le helper relance la nouvelle version. En jeu, on attend
// que l'utilisateur quitte la partie (rappel depuis setOverlayVisible).
function maybeAutoApplyUpdate() {
  if (!updateStaged) return;
  if (overlayVisible) return;                      // en partie -> on attend
  if (hubWin && !hubWin.isDestroyed()) return;     // Hub ouvert -> on attend sa fermeture
  if (applyPendingUpdate()) { updateStaged = false; app.quit(); }
}

function setOverlayVisible(v) {
  if (forceShow) v = true;
  if (hubWin && !hubWin.isDestroyed()) v = false; // Hub ouvert -> overlay caché (prime sur forceShow)
  if (!win || win.isDestroyed() || v === overlayVisible) return;
  overlayVisible = v;
  if (v) {
    win.showInactive();          // montre SANS voler le focus au jeu
    if (!sessionStart) sessionStart = Date.now(); // démarre le chrono de session
    sendUpdate({ appear: true }); // anim d'apparition côté renderer
    sendUpdate({ spotify: lastSpotify }); // recale la ligne musique à l'affichage
    startPolling();              // reprend le scraping (et refresh immédiat)
  } else {
    win.hide();
    sessionStart = 0; // hors jeu : on arrête le chrono
    stopPolling();        // stoppe poll + ferme la fenêtre Chromium = ~0 perf
    clearPresence();      // hors jeu : on retire l'activité Discord
    maybeAutoApplyUpdate(); // on vient de quitter le jeu -> bon moment pour appliquer un update prêt
  }
}

// Poll actif seulement quand l'overlay est affiché (= en jeu). Hors-jeu : aucun
// scraping, fenêtre Chromium fermée -> CPU/GPU/RAM quasi nuls.
let pollTimer = null;

function pollMs() {
  return Math.max(5, loadConfig().pollSeconds || 15) * 1000;
}

function startPolling() {
  if (pollTimer) return;
  poll(); // refresh immédiat à l'affichage
  pollTimer = setInterval(poll, pollMs());
}

// Presets de fréquence de poll (s). Plus haut = moins de requêtes (utile si
// réseau instable / packet loss). Cycle + persiste + relance l'intervalle.
const POLL_PRESETS = [10, 15, 30, 60];
function cyclePollRate() {
  const cfg = loadConfig();
  const idx = POLL_PRESETS.indexOf(cfg.pollSeconds || 15);
  const rate = POLL_PRESETS[(idx + 1) % POLL_PRESETS.length];
  cfg.pollSeconds = rate;
  saveConfig(cfg);
  if (pollTimer) { clearInterval(pollTimer); pollTimer = setInterval(poll, rate * 1000); }
  sendUpdate({ toast: '⏱ poll ' + rate + 's' });
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  try { closeHidden(); } catch {}
}

function startFocusWatcher() {
  if (process.platform !== 'win32') { setOverlayVisible(true); return; }

  const ps = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$sig = @'
using System;
using System.Runtime.InteropServices;
public class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
}
'@
Add-Type -TypeDefinition $sig
while ($true) {
  $h = [FG]::GetForegroundWindow()
  $procId = 0
  [void][FG]::GetWindowThreadProcessId($h, [ref]$procId)
  $name = ''
  try { $name = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch {}
  Write-Output "FOCUS|$name"
  # Titre de la fenetre Spotify = "Artiste - Titre". Pause/arret -> "Spotify".
  $sp = ''
  try { $sp = (Get-Process Spotify -ErrorAction Stop | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 1 -ExpandProperty MainWindowTitle) } catch {}
  Write-Output "SPOTIFY|$sp"
  Start-Sleep -Milliseconds 1000
}`;

  try {
    focusProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
  } catch (e) {
    logFocus('spawn powershell ERREUR: ' + e.message + ' -> overlay reste caché');
    return; // PAS de fallback "visible partout"
  }
  logFocus('watcher démarré pid=' + (focusProc.pid || '?'));

  let buf = '';
  focusProc.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop(); // garde la ligne partielle
    for (const line of lines) {
      const raw = line.trim();
      if (!raw) continue;
      if (raw.startsWith('SPOTIFY|')) { handleSpotify(raw.slice(8)); continue; }
      const name = raw.startsWith('FOCUS|') ? raw.slice(6) : raw;
      if (!name) continue;
      const match = name.toLowerCase() === RL_PROCESS.toLowerCase();
      if (match !== overlayVisible) logFocus(`focus=${name} -> ${match ? 'AFFICHE' : 'cache'}`);
      setOverlayVisible(match);
    }
  });
  focusProc.stderr.on('data', (d) => logFocus('stderr: ' + d.toString().trim()));
  // Si le watcher meurt : NE PAS forcer visible (sinon overlay partout).
  // On cache par sécurité et on retente dans 3 s.
  focusProc.on('exit', (code) => {
    logFocus('watcher exit code=' + code + ' -> cache + retry 3s');
    focusProc = null;
    setOverlayVisible(false);
    setTimeout(() => { if (!focusProc) startFocusWatcher(); }, 3000);
  });
}

// --- Live via log RL (lecture seule, anticheat-safe) ---
let logWatcher = null;
let matchBurst = []; // timers de la rafale de refresh post-match

// Journal des matchs (matches.json) : base de futurs graphes. Enregistré quand le
// MMR change après une fin de match détectée.
let matches = [];
function matchesPath() { return path.join(app.getPath('userData'), 'matches.json'); }
function loadMatches() { try { matches = JSON.parse(fs.readFileSync(matchesPath(), 'utf8')) || []; } catch { matches = []; } }
function saveMatches() { try { fs.writeFileSync(matchesPath(), JSON.stringify(matches)); } catch (e) { logFocus('saveMatches: ' + e.message); } }

function clearMatchBurst() { matchBurst.forEach(clearTimeout); matchBurst = []; }

// Fin de match détectée -> on re-poll le tracker jusqu'à ce que le MMR de la
// playlist suivie CHANGE (le tracker.network a son propre délai après un match,
// de quelques secondes à ~2 min). On logge chaque essai pour diagnostiquer
// "en retard" vs "jamais". S'arrête au 1er changement ou après ~3 min.
function refreshAfterMatch() {
  clearMatchBurst();
  const sel = loadConfig().playlist;
  const before = mmrRef(sel).last;
  let tries = 0;
  const tick = async () => {
    tries++;
    await poll(true);
    const now = mmrRef(sel).last;
    logFocus(`post-match refresh #${tries}: mmr ${before} -> ${now}`);
    if (now !== before && now != null) {
      // Complète l'entrée Stats API du même match si elle existe (sinon append).
      if (before != null) { matches = attachMmr(matches, sel, before, now); saveMatches(); logFocus(`match enregistré: ${sel} ${before}->${now}`); }
      logFocus('post-match: maj MMR détectée');
      return;
    }
    if (tries < 18) matchBurst.push(setTimeout(tick, 10000)); // ~3 min de fenêtre
    else logFocus('post-match: MMR inchangé après ' + tries + ' essais (tracker lag ou même MMR)');
  };
  matchBurst.push(setTimeout(tick, 1500));
}

// --- Stats API officielle RL (TCP 49123, live in-match) ---
// Phase 1 (découverte) : on capture le schéma réel des frames (types d'events +
// 1re frame brute) dans overlay.log, pour ensuite mapper l'affichage sur de vraies
// données plutôt que de deviner. EAC-safe (lecture seule du socket).
let statsApi = null;
let lastLive = null;          // dernier modèle de match en direct (Stats API)
let lastLiveSent = 0, lastLiveSig = '';
let matchAgg = null;          // agrégateur du match en cours (récap boost/sol-air/…)
function startStatsApiWatcher() {
  if (statsApi) return;
  statsApi = startStatsApi({
    log: logFocus,
    onEvent: (v) => {
      const ev = v && v.Event;
      if (ev === 'UpdateState') {
        const cfg = loadConfig();
        const model = matchModel(v.Data, { username: cfg.username });
        // Échantillonne pour le récap (hors replay de but).
        if (model.me && !model.replay) { if (!matchAgg) matchAgg = createAggregator(); matchAgg.sample(model.me); }
        // throttle ~4/s + n'émet que si ça a changé (l'API débite jusqu'à 120 Hz)
        const sig = model.me ? `${model.me.goals}.${model.me.saves}.${model.me.shots}.${model.me.assists}.${model.me.boost}.${model.teamScore}.${model.oppScore}.${model.time}` : 'none';
        const now = Date.now();
        if (now - lastLiveSent >= 250 && sig !== lastLiveSig) {
          lastLiveSent = now; lastLiveSig = sig; lastLive = model;
          pushHub(); // le payload Hub embarque _live
        }
      } else if (ev === 'MatchEnded') {
        // Fin de match : enregistre dans l'historique depuis le dernier état live
        // (résultat via score des équipes ; stats du joueur local).
        if (lastLive && lastLive.me) {
          const r = resultFromScores(lastLive.teamScore, lastLive.oppScore);
          const me = lastLive.me;
          const recap = matchAgg ? matchAgg.finalize() : null;
          matches = appendMatch(matches, makeEntry(loadConfig().playlist, null, null, today(), Date.now(), {
            result: r, teamScore: lastLive.teamScore, oppScore: lastLive.oppScore,
            goals: me.goals, saves: me.saves, shots: me.shots, assists: me.assists, score: me.score,
            demos: me.demos, source: 'statsapi',
            ...(recap ? { avgBoost: recap.avgBoost, boostZeroPct: recap.boostZeroPct, boostFullPct: recap.boostFullPct,
              airPct: recap.airPct, groundPct: recap.groundPct, touches: recap.touches } : {}),
          }));
          saveMatches();
          logFocus(`statsapi: match enregistré ${r} ${lastLive.teamScore}-${lastLive.oppScore} (buts ${me.goals}${recap ? ', boost moy ' + recap.avgBoost : ''})`);
        }
        lastLive = null; lastLiveSig = ''; matchAgg = null; pushHub();
        // Signal de fin le plus précoce (instantané, avant le LoadMap de sortie du
        // log RL) -> lance la rafale de refresh MMR tout de suite.
        logFocus('statsapi: match end -> refresh MMR');
        refreshAfterMatch();
      } else if (ev === 'Initialized' || ev === 'MatchCreated' || ev === 'MatchDestroyed') {
        lastLive = null; lastLiveSig = ''; matchAgg = null; pushHub(); // nouveau match / reset -> état propre
      }
    },
  });
}

// --- Source OBS (serveur local 127.0.0.1:49200) ---
let obsServer = null;
function obsState() {
  const vm = lastVm || {};
  return {
    rank: vm.rank || null,
    mmr: vm.mmr != null ? vm.mmr : null,
    mmrLive: lastLiveMmr,
    session: summarize(matches, today()),
    live: (lastLive && lastLive.inMatch) ? lastLive : null,
    ...themePayload(), // theme (built-in) ou themeVars (custom)
    layout: (loadConfig().overlay.layout || 0) % LAYOUT_COUNT, // forme choisie
    rankIcon: vm.rankIcon || (vm.rank && vm.rank.icon) || null,
  };
}
function startObsServerOnce() {
  if (obsServer) return;
  obsServer = startObsServer({ port: OBS_PORT, getState: obsState, log: logFocus });
}

// MMR "live exact" dérivé du log : MMR interne (PartyLeaderMMR) converti en MMR
// affiché via une calibration linéaire par playlist (apprise des paires
// interne↔tracker). Mis à jour à chaque mise en file = instantané (avant tracker).
let lastLiveMmr = null;
function calibrateAndPushLiveMmr(key, internal, tier) {
  if (!Number.isFinite(internal)) return;
  const cfg = loadConfig();
  cfg.overlay.mmrCalibPairs = cfg.overlay.mmrCalibPairs || {};
  const tracker = mmrRef(key).last;
  if (Number.isFinite(tracker)) {
    cfg.overlay.mmrCalibPairs[key] = mmrcalib.addPair(cfg.overlay.mmrCalibPairs[key], internal, tracker);
    saveConfig(cfg);
  }
  const calib = mmrcalib.fit(cfg.overlay.mmrCalibPairs[key]);
  const live = mmrcalib.apply(internal, calib);
  if (calib) {
    const resid = mmrcalib.maxResidual(cfg.overlay.mmrCalibPairs[key], calib);
    logFocus(`mmrcalib ${key}: int=${internal} tracker=${tracker} -> live=${live} (pente ${calib.slope.toFixed(2)} off ${calib.offset.toFixed(1)} n${calib.n} resid ${resid != null ? resid.toFixed(1) : '?'})`);
  }
  lastLiveMmr = (live != null) ? { playlist: key, mmr: live, tier, internal, assumed: !(calib && calib.confirmed) } : null;
  sendUpdate({ mmrLive: lastLiveMmr });
  pushHub();
}

function startMatchLogWatcher() {
  if (logWatcher) return;
  logWatcher = startLogWatcher({
    logPath: loadConfig().overlay.logPath || undefined,
    log: logFocus,
    onMatchStart: (id, key, internal, tier) => {
      clearMatchBurst(); // nouveau match -> annule la rafale précédente
      logFocus(`log: match start playlist=${id}${key ? ' (' + key + ')' : ''} mmrInt=${internal} tier=${tier}`);
      if (key) switchPlaylist(key); // suit la playlist réellement jouée
      if (key) calibrateAndPushLiveMmr(key, internal, tier);
    },
    onMatchEnd: () => { logFocus('log: match end -> refresh MMR'); refreshAfterMatch(); },
  });
}

// Démarre l'overlay + le polling + les raccourcis. Idempotent (les raccourcis
// ne sont enregistrés qu'une fois).
function startOverlay() {
  if (overlayStarted) return;
  overlayStarted = true;
  createWindow();
  // Le polling démarre/s'arrête avec la visibilité (startFocusWatcher ->
  // setOverlayVisible -> startPolling). Aucun scraping tant que pas en jeu.
  startFocusWatcher();
  startMatchLogWatcher();
  startStatsApiWatcher();
  startObsServerOnce();

  globalShortcut.register('CommandOrControl+Alt+R', () => resetCurrent());

  // Ctrl+Alt+Espace : ouvre/ferme le Hub plein écran (lazy).
  globalShortcut.register('CommandOrControl+Alt+Space', () => toggleHub());

  // Ctrl+Alt+W : prévisualise l'animation de victoire (test du rendu).
  globalShortcut.register('CommandOrControl+Alt+W', () => sendUpdate({ celebrate: true }));

  // Ctrl+Alt+E : déclenche l'easter egg (son de défaite) à la demande.
  globalShortcut.register('CommandOrControl+Alt+E', () => sendUpdate({ playLoss: true }));

  // Ctrl+Alt+T : cycle les thèmes (couleurs) de l'overlay.
  globalShortcut.register('CommandOrControl+Alt+T', () => cycleTheme());

  // Ctrl+Alt+F : cycle les formes/dispositions (layouts) de l'overlay.
  globalShortcut.register('CommandOrControl+Alt+F', () => cycleLayout());

  // Ctrl+Alt+S : cycle la fréquence de poll (10/15/30/60s).
  globalShortcut.register('CommandOrControl+Alt+S', () => cyclePollRate());

  // Ctrl+Alt+G : preview de l'anim rank up (défile les rangs à chaque appui).
  let dbgRank = 0;
  // [group, tier name, N de l'icône s4-N]
  const DBG_GROUPS = [
    ['Bronze','Bronze I',1], ['Silver','Silver I',4], ['Gold','Gold I',7],
    ['Platinum','Platinum I',10], ['Diamond','Diamond I',13], ['Champion','Champion I',16],
    ['Grand Champion','Grand Champion I',19], ['Supersonic Legend','Supersonic Legend',22]
  ];
  globalShortcut.register('CommandOrControl+Alt+G', () => {
    const [g, tier, n] = DBG_GROUPS[dbgRank++ % DBG_GROUPS.length];
    const icon = `https://trackercdn.com/cdn/tracker.gg/rocket-league/ranks/s4-${n}.png`;
    sendUpdate({ rankup: { kind: 'tier', tier, div: 'Division I', group: g, icon } });
  });

  // Ctrl+Alt+H : bascule l'affichage forcé (secours si la détection RL échoue).
  // Quand on le réactive, le watcher (1×/s) recale la visibilité tout seul.
  globalShortcut.register('CommandOrControl+Alt+H', () => {
    forceShow = !forceShow;
    logFocus('forceShow=' + forceShow + ' (hotkey)');
    if (forceShow) setOverlayVisible(true);
  });

  // Déplacement de l'overlay aux flèches (12 px par appui), position sauvegardée.
  globalShortcut.register('CommandOrControl+Alt+Up', () => nudge(0, -12));
  globalShortcut.register('CommandOrControl+Alt+Down', () => nudge(0, 12));
  globalShortcut.register('CommandOrControl+Alt+Left', () => nudge(-12, 0));
  globalShortcut.register('CommandOrControl+Alt+Right', () => nudge(12, 0));

  // Ctrl+Alt+D : active/désactive la présence Discord (persiste).
  globalShortcut.register('CommandOrControl+Alt+D', () => {
    const cfg = loadConfig();
    cfg.discord = cfg.discord || { enabled: false, clientId: '', largeImageKey: '', showProfileButton: true };
    cfg.discord.enabled = !cfg.discord.enabled;
    saveConfig(cfg);
    if (!cfg.discord.enabled) { clearPresence(); if (rpc) { rpc.close(); rpc = null; } }
    else { ensureRpc(); poll(); }
    const msg = !cfg.discord.clientId
      ? '⚠ Discord : ajoute clientId dans config.json'
      : (cfg.discord.enabled ? '✅ Discord activé' : '⛔ Discord désactivé');
    sendUpdate({ toast: msg });
  });

  // Ctrl+Alt+P : rouvre l'écran de config pour corriger plateforme / pseudo.
  globalShortcut.register('CommandOrControl+Alt+P', () => {
    if (!setupWin || setupWin.isDestroyed()) createSetupWindow();
    else setupWin.focus();
  });

  // Ctrl+Alt+1/2/3 : playlist affichée. Touches nues évitées (quick chats en jeu).
  globalShortcut.register('CommandOrControl+Alt+1', () => switchPlaylist('ranked-duel'));
  globalShortcut.register('CommandOrControl+Alt+2', () => switchPlaylist('ranked-doubles'));
  globalShortcut.register('CommandOrControl+Alt+3', () => switchPlaylist('ranked-standard'));
}

// Helper de swap : attend que TOUS les process de l'app libèrent l'exe, miroir
// du staged sur l'install (avec retries), relance. robocopy /MIR : 0-7 = succès.
// On ne purge staged/pending qu'après succès -> sinon l'ancienne version survit.
// Le code de sortie est loggué dans update/apply.log (diagnostic des échecs de
// swap : exe verrouillé = >0 transitoire, dossier protégé = 8/16 access denied).
const APPLY_UPDATE_PS = `param([int]$ParentPid,[string]$Staged,[string]$Install,[string]$Exe)
try { Wait-Process -Id $ParentPid -Timeout 30 -ErrorAction SilentlyContinue } catch {}
$name = [System.IO.Path]::GetFileNameWithoutExtension($Exe)
for ($i = 0; $i -lt 25; $i++) {
  if (-not (Get-Process -Name $name -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 400
}
Start-Sleep -Milliseconds 500
$upd = Split-Path $Staged
$ok = $false
for ($r = 0; $r -lt 4; $r++) {
  robocopy $Staged $Install /MIR /XF "Uninstall *.exe" /NFL /NDL /NJH /NJS /NC /NS | Out-Null
  if ($LASTEXITCODE -lt 8) { $ok = $true; break }
  Start-Sleep -Milliseconds 1000
}
("swap r=$r exit=$LASTEXITCODE ok=$ok at " + (Get-Date -Format o)) | Out-File -FilePath (Join-Path $upd 'apply.log') -Append -Encoding utf8
if ($ok) {
  Remove-Item -Recurse -Force $Staged -ErrorAction SilentlyContinue
  Remove-Item -Force (Join-Path $upd 'pending.json') -ErrorAction SilentlyContinue
}
Start-Process -FilePath $Exe
`;

// Si un update est stagé, lance le helper détaché et signale qu'il faut quitter.
function applyPendingUpdate() {
  try {
    if (!app.isPackaged) return false; // en dev, l'install = node_modules/electron
    const dir = path.join(app.getPath('userData'), 'update');
    const pendingPath = path.join(dir, 'pending.json');
    if (!fs.existsSync(pendingPath)) return false;
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
    const { stagedDir, version } = pending;
    const helper = path.join(dir, 'apply-update.ps1');
    const dropPending = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
    // Pending corrompu / staged absent -> on purge et on démarre normalement.
    if (!fs.existsSync(helper) || !stagedDir || !fs.existsSync(stagedDir)) { dropPending(); return false; }
    // Déjà à jour (pending <= version installée) -> rien à appliquer. Évite de
    // ré-appliquer en boucle un pending de la version courante.
    if (version && compareVersions(version, app.getVersion()) <= 0) { dropPending(); return false; }
    // Garde-fou anti-boucle : si le swap a déjà échoué 2 fois, on abandonne ce
    // pending (install probablement protégé / exe verrouillé) plutôt que de
    // relancer indéfiniment. L'updater retentera au prochain check.
    const attempts = (pending.attempts || 0) + 1;
    if (attempts > 2) { logFocus('applyPendingUpdate: abandon après ' + (attempts - 1) + ' essais'); dropPending(); return false; }
    try { fs.writeFileSync(pendingPath, JSON.stringify({ ...pending, attempts })); } catch {}
    const exe = app.getPath('exe');
    const installDir = path.dirname(exe);
    // L'install est-elle writable ? (Program Files -> non sans admin)
    let writable = true;
    try { const t = path.join(installDir, '.wtest' + Date.now()); fs.writeFileSync(t, 'x'); fs.unlinkSync(t); } catch { writable = false; }
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', helper,
      '-ParentPid', String(process.pid), '-Staged', stagedDir, '-Install', installDir, '-Exe', exe];
    let child;
    if (writable) {
      child = spawn('powershell.exe', args, { detached: true, stdio: 'ignore' });
    } else {
      // Install protégée (Program Files) : relance le helper ÉLEVÉ (UAC) pour
      // que robocopy puisse écrire. Sinon le swap échouerait en boucle.
      const argList = args.map((a) => "'" + String(a).replace(/'/g, "''") + "'").join(',');
      child = spawn('powershell.exe', ['-NoProfile', '-Command',
        `Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList ${argList}`], { detached: true, stdio: 'ignore' });
    }
    child.unref();
    logFocus(`applyPendingUpdate: helper lancé (${writable ? 'normal' : 'élevé UAC'}), quit pour swap`);
    return true;
  } catch (e) {
    logFocus('applyPendingUpdate error: ' + e.message);
    return false;
  }
}

// Empêche les doublons d'overlay : une seule instance peut tourner.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.whenReady().then(() => {
  // Avant tout : si un update est prêt, on le pose et on quitte (l'helper relance).
  if (applyPendingUpdate()) { app.quit(); return; }
  // Lancement auto au démarrage de Windows (overlay toujours dispo en fond).
  if (process.platform === 'win32' && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true });
  }
  session = loadSession();
  loadMatches();
  // 1er lancement (pas de pseudo) -> écran de config, sinon overlay direct.
  if (isConfigured()) startOverlay();
  else createSetupWindow();
  maybeShowPatchNotes();
  // Vérifie/télécharge l'update AU BOOT, sans dépendre d'être en jeu. L'update
  // se stage en fond (pending.json) et s'applique au prochain lancement. Avant,
  // checkForUpdate n'était appelé que depuis poll() (donc seulement RL au 1er
  // plan) -> qui ne lance jamais le jeu ne recevait jamais l'update.
  checkForUpdate();
});

// Affiche la page Nouveautés UNIQUEMENT au 1er lancement après un update :
// on compare la version vue la dernière fois (overlay.lastSeenVersion) à la
// version courante. Différentes -> on arme la page et on ouvre le Hub.
// 1er install (lastSeenVersion null) -> on enregistre seulement, pas d'affichage
// (la page touches via tutoSeen gère le 1er install). Hors config -> on attend.
function maybeShowPatchNotes() {
  const cfg = loadConfig();
  if (!isConfigured()) return; // setup en cours : on verra à la prochaine ouverture
  const cur = app.getVersion();
  const seen = cfg.overlay.lastSeenVersion;
  if (seen && seen !== cur) {
    showNewsOnce = true;
    openHub(); // pushHub() au did-finish-load envoie _showNews
  }
  if (seen !== cur) { cfg.overlay.lastSeenVersion = cur; saveConfig(cfg); }
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  clearMatchBurst();
  if (logWatcher) { try { logWatcher.stop(); } catch {} }
  if (statsApi) { try { statsApi.stop(); } catch {} }
  if (obsServer) { try { obsServer.stop(); } catch {} }
  if (focusProc) { try { focusProc.kill(); } catch {} }
  if (rpc) { try { rpc.close(); } catch {} }
});
app.on('window-all-closed', () => app.quit());
