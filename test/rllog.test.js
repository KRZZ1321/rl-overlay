// test/rllog.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseLine, PLAYLIST_IDS, logPathCandidates } = require('../rllog');
const path = require('path');

// Collecteur d'événements pour parseLine.
function collect(lines) {
  const events = [];
  const st = {};
  const emit = {
    matchStart: (id, mmr, tier) => events.push({ type: 'start', id, mmr, tier }),
    matchEnd: () => events.push({ type: 'end' }),
  };
  for (const l of lines) parseLine(l, emit, st);
  return events;
}

test('détecte le début de match via StartMatchmaking + playlist id', () => {
  const e = collect(['[3201.84] Matchmaking: StartMatchmaking at 2026-06-29 in EU9 for playlists 11 on game server ']);
  assert.strictEqual(e.length, 1);
  assert.strictEqual(e[0].type, 'start');
  assert.strictEqual(e[0].id, 11);
});

test('détecte le début via HandleServerReserved (Reservation Playlist=)', () => {
  const e = collect(['[3206.25] Party: HandleServerReserved (Reservation=(ServerName="EU9-x",Playlist=13,Region="EU"))']);
  assert.strictEqual(e[0].type, 'start');
  assert.strictEqual(e[0].id, 13);
});

test('capture MMR interne + tier (lignes avant StartMatchmaking)', () => {
  const e = collect([
    '[0038.25] Matchmaking: Pre-divide PartyLeaderMMR: 21.1114',
    '[0038.25] Matchmaking: Post-divide PartyLeaderMMR: 21.1114',
    '[0038.25] Matchmaking: PartyLeaderTier=(11)',
    '[0038.25] Matchmaking: StartMatchmaking at 2026-06-29 for playlists 10 on game server ',
  ]);
  assert.strictEqual(e.length, 1);
  assert.strictEqual(e[0].id, 10);
  assert.ok(Math.abs(e[0].mmr - 21.1114) < 1e-6);
  assert.strictEqual(e[0].tier, 11);
});

// Les packages GFX_WinnerMenu/EndGameMenu sont préchargés AU JOIN de chaque map
// (vérifié sur Launch.log réel) : ils ne signalent PAS la fin. La vraie fin est
// le LoadMap qui quitte le serveur (retour menu ou transition vers le suivant).
test('le préchargement WinnerMenu/EndGameMenu au join n\'émet PAS de fin', () => {
  const e = collect([
    '[0075.16] Log: LoadMap: 15.237.0.9:8132/UF_Night_P?Name=Bob?game=TAGame.GameInfo_Soccar_TA',
    '[0075.52] Log: Fully load package: ..\\..\\TAGame\\CookedPCConsole\\GFX_EndGameMenu_SF.upk',
    '[0075.57] Log: Fully load package: ..\\..\\TAGame\\CookedPCConsole\\GFX_WinnerMenu_SF.upk',
  ]);
  assert.deepStrictEqual(e, []);
});

test('détecte la fin de match via retour menu (LoadMap MENU_Main_p)', () => {
  const e = collect([
    '[0075.16] Log: LoadMap: 15.237.0.9:8132/UF_Night_P?Name=Bob?game=TAGame.GameInfo_Soccar_TA',
    '[0619.22] Log: LoadMap: MENU_Main_p?closed?Name=Bob',
  ]);
  assert.deepStrictEqual(e, [{ type: 'end' }]);
});

test('détecte la fin via transition vers le match suivant (chaînage)', () => {
  const e = collect([
    '[0494.08] Log: LoadMap: 13.38.191.29:7820/Beach_Night_GRS_P?Name=Bob?game=TAGame.GameInfo_Soccar_TA',
    '[0987.96] Log: LoadMap: JoinGameTransition?Name=Bob?game=TAGame.GameInfo_Transition_TA',
    '[0988.45] Log: LoadMap: 15.237.31.231:7802/UF_Day_P?Name=Bob?game=TAGame.GameInfo_Soccar_TA',
    '[1436.34] Log: LoadMap: MENU_Main_p?closed?Name=Bob',
  ]);
  assert.deepStrictEqual(e, [{ type: 'end' }, { type: 'end' }]);
});

test('pas de fin hors match : menu au boot, transition avant le 1er match', () => {
  const e = collect([
    '[0014.02] Log: LoadMap: MENU_Main_p',
    '[0074.72] Log: LoadMap: JoinGameTransition?game=TAGame.GameInfo_Transition_TA',
  ]);
  assert.deepStrictEqual(e, []);
});

test('freeplay et replay (pas de serveur ip) ne comptent pas comme match', () => {
  const e = collect([
    '[6518.75] Log: LoadMap: Labs_Utopia_P?Game=TAGame.GameInfo_Soccar_TA?GameTags=Freeplay?Name=Bob',
    '[4212.52] Log: LoadMap: cs_p?Game=TAGame.GameInfo_Replay_TA?Replay=x.replay?Name=Bob',
    '[4379.47] Log: LoadMap: MENU_Main_p?closed?Name=Bob',
  ]);
  assert.deepStrictEqual(e, []);
});

test('ignore les lignes sans intérêt', () => {
  const e = collect([
    '[3201.84] Matchmaking: SecondsSearching=(1) bIgnoreSkill=(False)',
    '\tFunction TAGame.ProductAsset_GoalExplosion_TA:GetExplosionFXActorForPRI',
    '[1731.30] Matchmaking: Post-divide PartyLeaderMMR: 31.3883',
  ]);
  assert.deepStrictEqual(e, []);
});

test('candidats chemin log : Documents + OneDrive (%OneDrive%) + OneDrive local, dédupliqués', () => {
  const c = logPathCandidates('C:\\Users\\bob', 'C:\\Users\\bob\\OneDrive');
  const rel = path.join('My Games', 'Rocket League', 'TAGame', 'Logs', 'Launch.log');
  assert.strictEqual(c[0], path.join('C:\\Users\\bob', 'Documents', rel));
  assert.strictEqual(c[1], path.join('C:\\Users\\bob\\OneDrive', 'Documents', rel));
  assert.ok(c.length === 2 || c.length === 3); // 3e (home/OneDrive) peut dédupliquer avec le 2e
  assert.strictEqual(new Set(c).size, c.length); // pas de doublon
});

test('candidats sans OneDrive = juste Documents', () => {
  const c = logPathCandidates('C:\\Users\\bob', undefined);
  assert.deepStrictEqual(c, [path.join('C:\\Users\\bob', 'Documents', 'My Games', 'Rocket League', 'TAGame', 'Logs', 'Launch.log'),
    path.join('C:\\Users\\bob', 'OneDrive', 'Documents', 'My Games', 'Rocket League', 'TAGame', 'Logs', 'Launch.log')]);
});

test('map des ids de playlist classées', () => {
  assert.strictEqual(PLAYLIST_IDS[10], 'ranked-duel');
  assert.strictEqual(PLAYLIST_IDS[11], 'ranked-doubles');
  assert.strictEqual(PLAYLIST_IDS[13], 'ranked-standard');
  assert.strictEqual(PLAYLIST_IDS[1], undefined); // casual non suivi
});
