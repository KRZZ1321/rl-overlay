'use strict';

// Lecture SEULE du log Rocket League pour rendre l'overlay quasi temps réel,
// sans injection ni BakkesMod (anticheat-safe). On tail Launch.log et on émet :
//   - matchStart(playlistId, playlistKey|null) : entrée en file/résa d'un match
//   - matchEnd() : écran de fin de match (WinnerMenu/EndGameMenu)
// Aucune écriture, aucun contact avec le process RL.

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_REL = path.join('My Games', 'Rocket League', 'TAGame', 'Logs', 'Launch.log');

// Candidats ordonnés pour le Launch.log. Documents peut être redirigé vers
// OneDrive (perso "OneDrive" ou pro "OneDrive - Société", exposé via %OneDrive%).
// Pure (pas d'I/O) -> testable. home/oneDrive injectables.
function logPathCandidates(home, oneDrive) {
  const out = [];
  if (home) out.push(path.join(home, 'Documents', LOG_REL));
  if (oneDrive) out.push(path.join(oneDrive, 'Documents', LOG_REL));
  if (home) out.push(path.join(home, 'OneDrive', 'Documents', LOG_REL));
  return [...new Set(out)]; // dédup
}

// Renvoie le 1er candidat qui existe, sinon le 1er candidat (Documents standard).
function defaultLogPath() {
  const cands = logPathCandidates(os.homedir(), process.env.OneDrive);
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch {} }
  return cands[0];
}

// Patterns vérifiés sur un vrai Launch.log.
const RE_PLAYLIST_START = /for playlists (\d+)/;            // Matchmaking: StartMatchmaking ... for playlists 11
const RE_RESERVATION    = /Reservation=\(.*?Playlist=(\d+)/; // Party: HandleServerReserved (Reservation=(...Playlist=11...))
const RE_MMR            = /Post-divide PartyLeaderMMR:\s*([\d.]+)/; // MMR interne (échelle ~21-31)
const RE_TIER           = /PartyLeaderTier=\((\d+)\)/;              // tier de rang exact
// Fin de match : les packages GFX_WinnerMenu/EndGameMenu sont préchargés AU JOIN
// de chaque map (donc inutilisables comme signal de fin). La vraie fin est le
// LoadMap qui quitte le serveur : retour menu ou transition vers le match suivant.
// L'ip:port avant la map distingue un vrai serveur online du freeplay/replay local.
const RE_MAP_SERVER = /LoadMap: \d+\.\d+\.\d+\.\d+:\d+\//;                 // join d'un serveur online
const RE_MAP_EXIT   = /LoadMap: (?:MENU_Main_p|JoinGameTransition)/;       // on quitte la map courante

// id de playlist RL -> clé interne suivie par l'overlay (modes classés seulement ;
// les autres ids ne forcent pas la playlist affichée).
const PLAYLIST_IDS = { 10: 'ranked-duel', 11: 'ranked-doubles', 13: 'ranked-standard' };

// Parse pure d'une ligne -> appelle emit.matchStart(id, mmrInterne, tier) / emit.matchEnd.
// `st` porte le dernier MMR interne + tier vus (écrits juste avant le StartMatchmaking)
// et `inMatch` (on est sur un serveur online) pour dater la fin au LoadMap de sortie.
function parseLine(line, emit, st) {
  st = st || {};
  let m;
  if ((m = line.match(RE_MMR))) { st.mmr = parseFloat(m[1]); return; }
  if ((m = line.match(RE_TIER))) { st.tier = parseInt(m[1], 10); return; }
  m = line.match(RE_PLAYLIST_START) || line.match(RE_RESERVATION);
  if (m) { emit.matchStart(parseInt(m[1], 10), st.mmr, st.tier); st.mmr = undefined; st.tier = undefined; return; }
  if (RE_MAP_SERVER.test(line)) { st.inMatch = true; return; }
  if (RE_MAP_EXIT.test(line) && st.inMatch) { st.inMatch = false; emit.matchEnd(); }
}

// Surveille le log et émet les événements. Renvoie { stop }.
function startLogWatcher(opts = {}) {
  const logPath = opts.logPath || defaultLogPath();
  const onMatchStart = opts.onMatchStart || (() => {});
  const onMatchEnd = opts.onMatchEnd || (() => {});
  const intervalMs = opts.intervalMs || 1000;
  const log = opts.log || (() => {});

  let pos = 0;        // curseur octets lus
  let started = false; // false tant qu'on n'a pas calé le curseur sur la fin
  let buf = '';        // ligne partielle entre deux lectures
  let lastEnd = 0;     // anti-rebond matchEnd
  const st = {};       // MMR interne + tier en attente (lignes avant le StartMatchmaking)

  const emit = {
    matchStart: (id, mmr, tier) => { onMatchStart(id, PLAYLIST_IDS[id] || null, mmr, tier); },
    matchEnd: () => {
      const now = Date.now();
      if (now - lastEnd < 5000) return; // WinnerMenu + EndGameMenu chargent ensemble
      lastEnd = now;
      onMatchEnd();
    },
  };

  function tick() {
    // NB : ne pas nommer ce paramètre `st` (masquerait l'état de parse ci-dessus,
    // parseLine recevrait l'objet fs.Stats et perdrait MMR/tier/inMatch à chaque tick).
    fs.stat(logPath, (err, fst) => {
      if (err) return;                         // log absent -> on retente au prochain tick
      if (!started) { pos = fst.size; started = true; return; } // démarre à la fin (pas d'historique)
      if (fst.size < pos) { pos = 0; buf = ''; } // rotation/troncature (redémarrage du jeu)
      if (fst.size <= pos) return;
      const end = fst.size;
      const stream = fs.createReadStream(logPath, { start: pos, end: end - 1, encoding: 'utf8' });
      let data = '';
      stream.on('data', (d) => { data += d; });
      stream.on('end', () => {
        pos = end;
        buf += data;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();                     // garde la dernière (potentiellement partielle)
        for (const line of lines) {
          try { parseLine(line, emit, st); } catch (e) { log('rllog parse: ' + e.message); }
        }
      });
      stream.on('error', (e) => log('rllog read: ' + e.message));
    });
  }

  const timer = setInterval(tick, intervalMs);
  tick();
  return { stop: () => clearInterval(timer) };
}

module.exports = { startLogWatcher, parseLine, defaultLogPath, logPathCandidates, PLAYLIST_IDS };
