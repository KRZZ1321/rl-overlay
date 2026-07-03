# Finition & Confort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter à RL Overlay trois finitions confort — choix de police + taille du MMR, export/import de la config, et une UI pour définir les objectifs — sans toucher à la monétisation ni à l'i18n.

**Architecture:** On réutilise les mécanismes existants : réglages persistés dans `config.json` (userData) via `saveConfig`, poussés au renderer par `sendUpdate` (overlay) et `pushHub` (Hub), contrôlés depuis la surcouche `#settings` de `hub.html`. La logique validable (normalisation des flags, parsing d'import, normalisation des objectifs) est extraite dans de petits modules purs `lib/*` testés via `node --test`. Le câblage Electron (IPC, preload, DOM) est vérifié manuellement en jeu.

**Tech Stack:** Electron 31, Node built-in test runner (`node --test`), preload `contextBridge`, pas de nouvelle dépendance.

## Global Constraints

- Runner de test : `node --test` (modules `node:test` + `node:assert`). Aucune dépendance de test ajoutée.
- Pas de nouvelle dépendance npm.
- Config : `CONFIG_PATH = app.getPath('userData')/config.json`, lue par `loadConfig()`, écrite par `saveConfig(cfg)` (`main.js`).
- Push réglage → overlay : `sendUpdate({ [key]: value })`. Push réglage → Hub : `pushHub()`.
- `entitlement.js` reste inchangé (`isPremium() === true`). Zéro paywall.
- Textes UI en français.
- Pas de migration de config : tout nouveau champ a un défaut (`font: 'default'`, `mmrSize: 100`, `goals` absent → `DEFAULT_GOALS`).
- Toute release passe en auto-update public : tester hors-ligne puis en jeu (skill `run-rl-overlay`) avant tout tag.

---

## Task 1: Module de normalisation des flags overlay

Extrait la validation de `set-overlay-flag` (aujourd'hui en dur dans `main.js`) dans un module pur, et y ajoute le support de `mmrSize` (numérique) et `font` (énuméré). Rend la validation testable.

**Files:**
- Create: `lib/settings-flags.js`
- Test: `test/settings-flags.test.js`

**Interfaces:**
- Consumes: rien.
- Produces: `normalizeOverlayFlag(key, value) -> { ok: true, value } | { ok: false }`. Constantes `BOOL_FLAGS` (array), `NUM_FLAGS` (objet `key -> [min, max]`), `ENUM_FLAGS` (objet `key -> [valeurs autorisées]`).

- [ ] **Step 1: Write the failing test**

```js
// test/settings-flags.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeOverlayFlag } = require('../lib/settings-flags');

test('bool flag -> booléen', () => {
  assert.deepStrictEqual(normalizeOverlayFlag('mmrGlow', 1), { ok: true, value: true });
  assert.deepStrictEqual(normalizeOverlayFlag('showMusic', 0), { ok: true, value: false });
});

test('num flag mmrSize clampé dans [70,140]', () => {
  assert.deepStrictEqual(normalizeOverlayFlag('mmrSize', 999), { ok: true, value: 140 });
  assert.deepStrictEqual(normalizeOverlayFlag('mmrSize', 10), { ok: true, value: 70 });
  assert.deepStrictEqual(normalizeOverlayFlag('mmrSize', 100), { ok: true, value: 100 });
});

test('num flag existant overlayScale toujours géré', () => {
  assert.deepStrictEqual(normalizeOverlayFlag('overlayScale', 200), { ok: true, value: 150 });
});

test('enum font: valeur autorisée gardée, sinon 1re autorisée', () => {
  assert.deepStrictEqual(normalizeOverlayFlag('font', 'mono'), { ok: true, value: 'mono' });
  assert.deepStrictEqual(normalizeOverlayFlag('font', 'bidon'), { ok: true, value: 'default' });
});

test('clé inconnue rejetée', () => {
  assert.deepStrictEqual(normalizeOverlayFlag('nope', 1), { ok: false });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/settings-flags.test.js`
Expected: FAIL — `Cannot find module '../lib/settings-flags'`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/settings-flags.js
'use strict';
// Normalisation centrale des réglages overlay poussés depuis la page Réglages.
// Pur et testable : main.js délègue ici la validation de set-overlay-flag.

const BOOL_FLAGS = ['mmrGlow', 'showMusic', 'showStreak', 'showDelta'];
const NUM_FLAGS = { overlayScale: [50, 150], overlayOpacity: [40, 100], mmrSize: [70, 140] };
const ENUM_FLAGS = { font: ['default', 'condensed', 'mono'] };

function normalizeOverlayFlag(key, value) {
  if (BOOL_FLAGS.includes(key)) return { ok: true, value: !!value };
  if (NUM_FLAGS[key]) {
    const [min, max] = NUM_FLAGS[key];
    return { ok: true, value: Math.max(min, Math.min(max, Math.round(Number(value) || 0))) };
  }
  if (ENUM_FLAGS[key]) {
    const allowed = ENUM_FLAGS[key];
    return { ok: true, value: allowed.includes(value) ? value : allowed[0] };
  }
  return { ok: false };
}

module.exports = { BOOL_FLAGS, NUM_FLAGS, ENUM_FLAGS, normalizeOverlayFlag };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/settings-flags.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/settings-flags.js test/settings-flags.test.js
git commit -m "feat: pure overlay-flag normalizer (+mmrSize, +font enum)"
```

---

## Task 2: Câbler police + taille du MMR de bout en bout

Branche `font` et `mmrSize` : défauts config, validation via Task 1, push overlay + Hub, application CSS dans le renderer, et contrôles dans la page Réglages. Vérification manuelle en jeu.

**Files:**
- Modify: `main.js` (handler `set-overlay-flag` ~572-588 ; défauts overlay ~50 ; payload `did-finish-load` ~217-220 ; vm `pushHub` ~403-404 ; `OVERLAY_SETTING_DEFAULTS` ~518)
- Modify: `index.html` (body font-family ~14 ; `:root` var ~18-20 ; bloc d'application des updates ~812-815 ; 9 déclarations `font-size` du MMR)
- Modify: `theme-v2.css` (`.f5 .big` ~38)
- Modify: `hub.html` (2 `.srow` dans `#settings` ~462 ; bind contrôles ~801 ; sync dans `paint` ~600)

**Interfaces:**
- Consumes: `normalizeOverlayFlag` (Task 1).
- Produces: flags config `overlay.font` (`'default'|'condensed'|'mono'`), `overlay.mmrSize` (int 70-140). Vars CSS `--ui-font`, `--mmrScale`. Champs vm `_font`, `_mmrSize`.

- [ ] **Step 1: Remplacer le handler `set-overlay-flag` par le module pur**

Dans `main.js`, supprimer les deux lignes locales (≈570-571) :

```js
const BOOL_FLAGS = ['mmrGlow', 'showMusic', 'showStreak', 'showDelta'];
const NUM_FLAGS = { overlayScale: [50, 150], overlayOpacity: [40, 100] };
```

et remplacer le corps du handler (≈572-588) par :

```js
const { normalizeOverlayFlag } = require('./lib/settings-flags');
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
```

(Placer le `require` en haut du fichier avec les autres `require` plutôt qu'inline si tu préfères ; l'essentiel est qu'il soit importé une fois.)

- [ ] **Step 2: Ajouter les défauts**

Dans `main.js` ligne ≈50, à l'intérieur de l'objet `overlay: { ... }`, ajouter après `overlayOpacity: 100,` :

```js
font: 'default', mmrSize: 100,
```

Dans `OVERLAY_SETTING_DEFAULTS` (≈518), ajouter les mêmes :

```js
const OVERLAY_SETTING_DEFAULTS = { mmrGlow: true, showMusic: true, showStreak: true, showDelta: true, overlayScale: 100, overlayOpacity: 100, font: 'default', mmrSize: 100 };
```

- [ ] **Step 3: Pousser les valeurs au renderer au chargement + au Hub**

Dans le `sendUpdate` du `did-finish-load` (≈217-220), ajouter dans l'objet :

```js
font: o.font || 'default', mmrSize: o.mmrSize ?? 100,
```

Dans le viewmodel de `pushHub` (≈403-404, à côté de `_overlayScale`/`_overlayOpacity`), ajouter :

```js
_font: o.font || 'default', _mmrSize: o.mmrSize ?? 100,
```

- [ ] **Step 4: Appliquer la police et l'échelle MMR dans `index.html`**

Body font-family (≈14) : remplacer

```css
    font-family: 'Segoe UI', 'Roboto', Arial, sans-serif;
```

par

```css
    font-family: var(--ui-font, 'Segoe UI', 'Roboto', Arial, sans-serif);
```

Ajouter une variable d'échelle par défaut sur `#stage` (≈19, sur la règle existante `#stage { ... }`, ajouter la déclaration) :

```css
  #stage { --mmrScale: 1; position: relative; transform: scale(var(--ovScale, 1)); transform-origin: top left;
    opacity: var(--ovOpacity, 1); transition: opacity .25s ease, transform .25s ease; }
```

Dans le bloc d'application des updates (après ≈815), ajouter :

```js
    if (d.font !== undefined) {
      const FONTS = {
        default: "'Segoe UI','Roboto',Arial,sans-serif",
        condensed: "'Segoe UI Semibold','Arial Narrow','Segoe UI',sans-serif",
        mono: "'Consolas','SFMono-Regular',ui-monospace,monospace"
      };
      document.documentElement.style.setProperty('--ui-font', FONTS[d.font] || FONTS.default);
    }
    if (d.mmrSize !== undefined) {
      document.documentElement.style.setProperty('--mmrScale', (d.mmrSize / 100).toFixed(3));
    }
```

- [ ] **Step 5: Convertir les 9 tailles de MMR de `index.html` en `calc`**

Remplacer chaque déclaration (gauche → droite). Le multiplicateur lit `--mmrScale` posé sur `:root` par le JS (qui retombe sur celui de `#stage` = 1) :

```css
  .f0 .mmr { font-size: calc(38px * var(--mmrScale, 1)); }
  .f1 .mid .mmr { font-size: calc(30px * var(--mmrScale, 1)); }
  .f2 .mmrrow .mmr { font-size: calc(33px * var(--mmrScale, 1)); }
  .f3 .head .mmr { font-size: calc(30px * var(--mmrScale, 1)); margin-left: auto; }
  .f4 .top .mmr { font-size: calc(24px * var(--mmrScale, 1)); }
  .fbadge .bmmr { font-size: calc(25px * var(--mmrScale, 1)); font-weight: 300; line-height: 1.05; color: var(--txt); }
  .layout-wing .row-top .mmr { font-size: calc(26px * var(--mmrScale, 1)); font-weight: 900; color: var(--txt); }
  .layout-cyber .huge-mmr { margin: 0; font-size: calc(48px * var(--mmrScale, 1)); font-weight: 800; color: var(--txt); line-height: 1; letter-spacing: -1px;
```

(Pour `.layout-cyber .huge-mmr` et `.fbadge .bmmr` et `.layout-wing .row-top .mmr`, ne changer que la valeur `font-size`, garder le reste de la règle intact.)

Et `.f-marquee .mmr` (≈241) : remplacer `font-size: 42px;` par `font-size: calc(42px * var(--mmrScale, 1));` (garder le reste de la règle).

- [ ] **Step 6: Convertir la taille MMR de la form Premium (défaut) dans `theme-v2.css`**

`theme-v2.css` ligne ≈38, remplacer

```css
.f5 .big { font-size: 46px; font-weight: 300; line-height: 1;
```

par

```css
.f5 .big { font-size: calc(46px * var(--mmrScale, 1)); font-weight: 300; line-height: 1;
```

(garder la suite de la règle).

- [ ] **Step 7: Ajouter les contrôles dans la page Réglages (`hub.html`)**

Dans `#settings`, juste après la `.srow` « Opacité de l'overlay » (≈462), ajouter :

```html
    <div class="srow">
      <div class="stext">
        <div class="stitle">Police</div>
        <div class="sdesc">Style de texte de l'overlay en jeu.</div>
      </div>
      <select class="slider" id="sel-font" style="flex:0 0 160px">
        <option value="default">Défaut</option>
        <option value="condensed">Condensée</option>
        <option value="mono">Mono</option>
      </select>
    </div>
    <div class="srow">
      <div class="stext">
        <div class="stitle">Taille du MMR</div>
        <div class="sdesc">Agrandit ou réduit uniquement le nombre de MMR.</div>
      </div>
      <input type="range" class="slider" id="sl-mmrsize" min="70" max="140" step="5" />
      <span class="sval" id="sv-mmrsize">—</span>
    </div>
```

- [ ] **Step 8: Brancher les contrôles JS (`hub.html`)**

Après `bindSlider('sl-opacity', 'sv-opacity', 'overlayOpacity', '%');` (≈802), ajouter :

```js
  bindSlider('sl-mmrsize', 'sv-mmrsize', 'mmrSize', '%');
  const selFont = document.getElementById('sel-font');
  if (selFont) selFont.addEventListener('change', () => window.hub.setFlag('font', selFont.value));
```

Dans `paint(vm)`, à côté des `syncSlider(...)` existants (≈599-600), ajouter :

```js
    syncSlider('sl-mmrsize', 'sv-mmrsize', vm._mmrSize, '%');
    if (selFont && vm._font && document.activeElement !== selFont) selFont.value = vm._font;
```

(Déclarer `selFont` avant `paint` si l'ordre l'exige : remonter la const `selFont` au-dessus de `window.hub.onUpdate(paint)`. Sinon, récupérer `document.getElementById('sel-font')` directement dans `paint`.)

- [ ] **Step 9: Vérifier les tests existants + lancer le jeu**

Run: `node --test`
Expected: PASS (toute la suite, dont `settings-flags.test.js`).

Puis test manuel (skill `run-rl-overlay`) : ouvrir le Hub → Réglages, changer Police et Taille du MMR, vérifier que l'overlay réagit en direct et que les valeurs persistent après redémarrage. Tester « Réinitialiser les réglages » : police revient à Défaut, taille à 100 %.

- [ ] **Step 10: Commit**

```bash
git add main.js index.html theme-v2.css hub.html
git commit -m "feat: réglages police + taille du MMR (live, persistés, reset)"
```

---

## Task 3: Validateur d'import de config (pur)

Module pur qui parse et valide une chaîne JSON de config importée, avant écriture. Testable.

**Files:**
- Create: `lib/config-port.js`
- Test: `test/config-port.test.js`

**Interfaces:**
- Consumes: rien.
- Produces: `parseConfigImport(jsonString) -> { ok: true, config } | { ok: false, error }` où `error ∈ {'invalid-json','not-an-object','missing-overlay'}`.

- [ ] **Step 1: Write the failing test**

```js
// test/config-port.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { parseConfigImport } = require('../lib/config-port');

test('JSON valide avec overlay -> ok', () => {
  const r = parseConfigImport(JSON.stringify({ username: 'x', overlay: { theme: 2 } }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.config.overlay.theme, 2);
});

test('JSON invalide -> erreur invalid-json', () => {
  assert.deepStrictEqual(parseConfigImport('{not json'), { ok: false, error: 'invalid-json' });
});

test('tableau -> not-an-object', () => {
  assert.deepStrictEqual(parseConfigImport('[]'), { ok: false, error: 'not-an-object' });
});

test('objet sans overlay -> missing-overlay', () => {
  assert.deepStrictEqual(parseConfigImport('{"username":"x"}'), { ok: false, error: 'missing-overlay' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config-port.test.js`
Expected: FAIL — `Cannot find module '../lib/config-port'`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/config-port.js
'use strict';
// Valide une config.json importée avant écriture. Pur.
function parseConfigImport(jsonString) {
  let data;
  try { data = JSON.parse(jsonString); }
  catch { return { ok: false, error: 'invalid-json' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'not-an-object' };
  }
  if (!data.overlay || typeof data.overlay !== 'object') {
    return { ok: false, error: 'missing-overlay' };
  }
  return { ok: true, config: data };
}
module.exports = { parseConfigImport };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/config-port.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/config-port.js test/config-port.test.js
git commit -m "feat: pure config import validator"
```

---

## Task 4: Câbler export / import de la config

Ajoute deux IPC (dialogues fichier), les expose au Hub via preload, et ajoute deux boutons dans la page Réglages. Vérification manuelle.

**Files:**
- Modify: `main.js` (nouveaux handlers `export-config`, `import-config` ; s'assurer que `dialog` est importé d'`electron`)
- Modify: `hub-preload.js` (exposer `exportConfig`, `importConfig`)
- Modify: `hub.html` (2 boutons dans `#settings` + handlers)

**Interfaces:**
- Consumes: `parseConfigImport` (Task 3), `loadConfig`/`saveConfig`/`CONFIG_PATH` (main.js).
- Produces: IPC `export-config -> { ok, canceled? }`, `import-config -> { ok, error? }`. Bridge `window.hub.exportConfig()`, `window.hub.importConfig()`.

- [ ] **Step 1: Vérifier l'import de `dialog`**

Dans `main.js`, confirmer que `dialog` figure dans le `require('electron')` du haut (à côté de `app`, `BrowserWindow`, `ipcMain`, `shell`, `clipboard`). S'il manque, l'ajouter à la déstructuration.

- [ ] **Step 2: Ajouter les handlers IPC**

Dans `main.js`, près des autres `ipcMain.handle` de la page Réglages (après `copy-obs-url`, ≈533), ajouter :

```js
const { parseConfigImport } = require('./lib/config-port');

ipcMain.handle('export-config', async () => {
  const r = await dialog.showSaveDialog({
    title: 'Exporter la configuration',
    defaultPath: 'rl-overlay-config.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.copyFileSync(CONFIG_PATH, r.filePath);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('import-config', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Importer une configuration',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
  let raw;
  try { raw = fs.readFileSync(r.filePaths[0], 'utf8'); }
  catch (e) { return { ok: false, error: 'read-failed' }; }
  const parsed = parseConfigImport(raw.replace(/^﻿/, ''));
  if (!parsed.ok) return { ok: false, error: parsed.error };
  saveConfig(parsed.config);
  // Re-applique partout.
  const o = loadConfig().overlay;
  sendUpdate({ ...themePayload(), layout: o.layout || 0,
    mmrGlow: o.mmrGlow !== false, showMusic: o.showMusic !== false,
    overlayScale: o.overlayScale ?? 100, overlayOpacity: o.overlayOpacity ?? 100,
    showStreak: o.showStreak !== false, showDelta: o.showDelta !== false,
    font: o.font || 'default', mmrSize: o.mmrSize ?? 100 });
  pushHub();
  poll();
  return { ok: true };
});
```

(Si `fs`, `themePayload`, `poll`, `sendUpdate` ne sont pas dans la portée — ils le sont au niveau module de `main.js` ; vérifier rapidement les noms exacts en cas de doute.)

- [ ] **Step 3: Exposer via preload**

Dans `hub-preload.js`, ajouter au bridge `hub` :

```js
  exportConfig: () => ipcRenderer.invoke('export-config'),
  importConfig: () => ipcRenderer.invoke('import-config'),
```

- [ ] **Step 4: Ajouter les boutons dans la page Réglages**

Dans `hub.html`, juste avant la `.srow` « Réinitialiser les réglages » (≈487), ajouter :

```html
    <div class="srow">
      <div class="stext">
        <div class="stitle">Sauvegarde de la config</div>
        <div class="sdesc">Exporte tes réglages dans un fichier, ou réimporte une sauvegarde.</div>
      </div>
      <button class="dbtn" id="export-cfg">Exporter</button>
      <button class="dbtn" id="import-cfg">Importer</button>
    </div>
```

- [ ] **Step 5: Brancher les boutons JS**

Dans `hub.html`, près des autres handlers de boutons Réglages (après `copy-obs`, ≈764), ajouter :

```js
  document.getElementById('export-cfg').addEventListener('click', async () => {
    const b = document.getElementById('export-cfg'); const old = b.textContent;
    let r = {}; try { r = await window.hub.exportConfig(); } catch {}
    b.textContent = r.ok ? '✓ Exporté' : r.canceled ? old : '⚠ Échec';
    setTimeout(() => { b.textContent = old; }, 2000);
  });
  document.getElementById('import-cfg').addEventListener('click', async () => {
    const b = document.getElementById('import-cfg'); const old = b.textContent;
    let r = {}; try { r = await window.hub.importConfig(); } catch {}
    b.textContent = r.ok ? '✓ Importé' : r.canceled ? old : '⚠ Fichier invalide';
    setTimeout(() => { b.textContent = old; }, 2500);
  });
```

- [ ] **Step 6: Vérifier + tester manuellement**

Run: `node --test`
Expected: PASS (toute la suite).

Manuel (`run-rl-overlay`) : Réglages → Exporter (choisir un chemin), vérifier le fichier créé. Modifier un réglage, puis Importer le fichier exporté → l'ancien réglage revient. Importer un fichier `.json` corrompu → message « Fichier invalide », config intacte.

- [ ] **Step 7: Commit**

```bash
git add main.js hub-preload.js hub.html
git commit -m "feat: export / import de la configuration (Réglages)"
```

---

## Task 5: Normalisation des objectifs (pur)

Ajoute à `lib/goals.js` la validation/normalisation d'une liste d'objectifs saisie par l'utilisateur (types autorisés, bornes de cible, label auto). Testable. Le moteur d'évaluation existant n'est pas modifié.

**Files:**
- Modify: `lib/goals.js`
- Test: `test/goals.test.js` (ajouter des cas ; ne pas casser l'existant)

**Interfaces:**
- Consumes: rien.
- Produces: `normalizeGoals(list) -> Array<{label, type, target}>` (max 4, types invalides filtrés, cibles clampées, label par défaut si vide). `GOAL_TYPES` (array). `defaultGoalLabel(type, target) -> string`.

- [ ] **Step 1: Write the failing test**

Ajouter à la fin de `test/goals.test.js` :

```js
const { normalizeGoals, GOAL_TYPES, defaultGoalLabel } = require('../lib/goals');

test('GOAL_TYPES expose les 4 types du moteur', () => {
  assert.deepStrictEqual([...GOAL_TYPES].sort(), ['mmrWeek', 'reachMmr', 'winrate', 'winsDay']);
});

test('normalizeGoals filtre les types inconnus', () => {
  const out = normalizeGoals([{ type: 'bogus', target: 5 }, { type: 'winsDay', target: 5 }]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].type, 'winsDay');
});

test('normalizeGoals clampe la cible selon le type', () => {
  assert.strictEqual(normalizeGoals([{ type: 'winrate', target: 999 }])[0].target, 100);
  assert.strictEqual(normalizeGoals([{ type: 'winrate', target: -5 }])[0].target, 0);
});

test('normalizeGoals limite à 4 objectifs', () => {
  const five = Array.from({ length: 5 }, () => ({ type: 'winsDay', target: 3 }));
  assert.strictEqual(normalizeGoals(five).length, 4);
});

test('normalizeGoals génère un label par défaut si absent', () => {
  assert.strictEqual(normalizeGoals([{ type: 'reachMmr', target: 1110 }])[0].label, 'Atteindre 1110 MMR');
});

test('normalizeGoals garde un label fourni', () => {
  assert.strictEqual(normalizeGoals([{ type: 'winsDay', target: 5, label: 'Mon objectif' }])[0].label, 'Mon objectif');
});

test('normalizeGoals sur non-tableau -> []', () => {
  assert.deepStrictEqual(normalizeGoals(null), []);
});

test('defaultGoalLabel couvre les 4 types', () => {
  assert.strictEqual(defaultGoalLabel('winrate', 60), 'Winrate 60%');
  assert.strictEqual(defaultGoalLabel('mmrWeek', 100), '+100 MMR / semaine');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/goals.test.js`
Expected: FAIL — `normalizeGoals is not a function` (ou import `undefined`).

- [ ] **Step 3: Write minimal implementation**

Dans `lib/goals.js`, ajouter avant `module.exports` :

```js
const GOAL_TYPES = ['reachMmr', 'winrate', 'mmrWeek', 'winsDay'];
const TARGET_BOUNDS = {
  reachMmr: [0, 3000],
  winrate: [0, 100],
  mmrWeek: [0, 2000],
  winsDay: [0, 100],
};

function defaultGoalLabel(type, target) {
  switch (type) {
    case 'reachMmr': return `Atteindre ${target} MMR`;
    case 'winrate':  return `Winrate ${target}%`;
    case 'mmrWeek':  return `+${target} MMR / semaine`;
    case 'winsDay':  return `${target} victoires / jour`;
    default:         return '';
  }
}

function normalizeGoals(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((g) => g && GOAL_TYPES.includes(g.type))
    .slice(0, 4)
    .map((g) => {
      const [min, max] = TARGET_BOUNDS[g.type];
      const target = Math.max(min, Math.min(max, Math.round(Number(g.target) || 0)));
      const label = (typeof g.label === 'string' && g.label.trim())
        ? g.label.trim()
        : defaultGoalLabel(g.type, target);
      return { label, type: g.type, target };
    });
}
```

Et mettre à jour l'export :

```js
module.exports = { DEFAULT_GOALS, evaluateGoals, normalizeGoals, defaultGoalLabel, GOAL_TYPES };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/goals.test.js`
Expected: PASS (anciens + nouveaux tests).

- [ ] **Step 5: Commit**

```bash
git add lib/goals.js test/goals.test.js
git commit -m "feat: normalizeGoals (types/bornes/label) for goals UI"
```

---

## Task 6: UI Goals (gestionnaire + affichage multi-objectifs)

Ajoute la surcouche `#goals` dans le Hub (gestionnaire de 1 à 4 objectifs), les IPC de lecture/écriture, et transforme le widget « Objectif » du dashboard pour afficher tous les objectifs. Vérification manuelle.

**Files:**
- Modify: `main.js` (handlers `get-goals`, `save-goals`)
- Modify: `hub-preload.js` (exposer `getGoals`, `saveGoals`)
- Modify: `hub.html` (bouton `#goals-toggle` ≈375 ; surcouche `#goals` + CSS ; logique gestionnaire ; widget dashboard ≈368 + render ≈664-666 ; ouverture/fermeture + Échap/clic-fond)

**Interfaces:**
- Consumes: `normalizeGoals`, `GOAL_TYPES`, `defaultGoalLabel`, `evaluateGoals` (Task 5 + existant) ; `vm.goals` déjà produit par `pushHub` via `viewmodel` (chaque entrée `{label, type, target, value, pct, done}`).
- Produces: IPC `get-goals -> Array<{label,type,target}>`, `save-goals(list) -> Array<{label,type,target}>` (normalisé). Bridge `window.hub.getGoals()`, `window.hub.saveGoals(list)`.

- [ ] **Step 1: Ajouter les IPC dans `main.js`**

Près des autres handlers Réglages (après `import-config` de Task 4), ajouter :

```js
const { normalizeGoals } = require('./lib/goals');

ipcMain.handle('get-goals', () => (loadConfig().goals || []));
ipcMain.handle('save-goals', (_e, list) => {
  const cfg = loadConfig();
  cfg.goals = normalizeGoals(list);
  saveConfig(cfg);
  pushHub(); // rafraîchit le widget Objectif du dashboard
  poll();    // recalcule le viewmodel
  return cfg.goals;
});
```

(Vérifier que `main.js:333` lit déjà `cfgNow.goals` pour passer `goalsCfg` au viewmodel — c'est le cas ; rien d'autre à changer côté évaluation.)

- [ ] **Step 2: Exposer via preload**

Dans `hub-preload.js`, ajouter au bridge `hub` :

```js
  getGoals: () => ipcRenderer.invoke('get-goals'),
  saveGoals: (list) => ipcRenderer.invoke('save-goals', list),
```

- [ ] **Step 3: Ajouter le bouton d'ouverture**

Dans `hub.html`, dans la rangée d'icônes (≈375, à côté de `history-toggle`), ajouter :

```html
  <button id="goals-toggle" title="Objectifs">🎯</button>
```

- [ ] **Step 4: Ajouter la surcouche `#goals` (markup + CSS)**

Dans `hub.html`, après la surcouche `#settings` (après `</div>` de `#settings`, ≈494), ajouter le markup :

```html
  <div id="goals">
    <span class="gclose" id="goals-close">✕ Fermer (Échap)</span>
    <h2>Objectifs</h2>
    <div class="gsub">Définis jusqu'à 4 objectifs suivis sur le dashboard.</div>
    <div id="goals-list"></div>
    <button class="dbtn" id="goal-add">+ Ajouter un objectif</button>
    <div class="grow" style="margin-top:18px">
      <button class="dbtn" id="goals-save">Enregistrer</button>
      <span id="goals-status" class="sdesc"></span>
    </div>
  </div>
```

Dans le `<style>`, en réutilisant le pattern de `#settings` (≈208-215), ajouter :

```css
  #goals { position: fixed; inset: 0; z-index: 70;
    background: var(--bg); padding: 56px 40px; overflow-y: auto;
    opacity: 0; visibility: hidden; transform: scale(.985);
    transition: opacity .2s ease, transform .22s cubic-bezier(.22,1,.36,1), visibility 0s linear .22s; }
  body.show-goals #goals { opacity: 1; visibility: visible; transform: none;
    transition: opacity .2s ease, transform .22s cubic-bezier(.22,1,.36,1), visibility 0s; }
  #goals h2 { font-size: 20px; font-weight: 800; letter-spacing: -.3px; margin-bottom: 2px; }
  #goals .gsub { color: var(--muted); font-size: 13px; margin-bottom: 22px; }
  #goals .gclose { position: absolute; top: 24px; right: 28px; font-size: 13px; color: var(--muted); cursor: pointer; }
  #goals .gclose:hover { color: var(--txt); }
  #goals .grow { display: flex; align-items: center; gap: 12px; max-width: 560px; }
  .goal-item { display: flex; align-items: center; gap: 10px; max-width: 560px; padding: 8px 0; border-bottom: 1px solid var(--line); }
  .goal-item select, .goal-item input { background: var(--card); color: var(--txt); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
  .goal-item select { flex: 1; }
  .goal-item input.gtarget { flex: 0 0 90px; }
  .goal-item .gdel { flex: 0 0 auto; background: var(--card); color: var(--muted); border: 1px solid var(--line); border-radius: 6px; padding: 6px 9px; cursor: pointer; }
  .goal-item .gdel:hover { color: var(--loss); border-color: var(--loss); }
```

- [ ] **Step 5: Ajouter la logique du gestionnaire (`hub.html` script)**

Dans le script de `hub.html`, ajouter (par ex. après le bloc Réglages, près de `bindSlider(...)`) :

```js
  // --- Page Objectifs ---
  const GOAL_TYPE_LABELS = {
    reachMmr: 'Atteindre un MMR',
    winrate: 'Winrate (%)',
    mmrWeek: 'MMR gagné / semaine',
    winsDay: 'Victoires / jour'
  };
  const goalsListEl = document.getElementById('goals-list');

  function addGoalRow(goal) {
    const g = goal || { type: 'reachMmr', target: 1110 };
    const row = document.createElement('div');
    row.className = 'goal-item';
    const opts = Object.keys(GOAL_TYPE_LABELS)
      .map((t) => `<option value="${t}"${t === g.type ? ' selected' : ''}>${GOAL_TYPE_LABELS[t]}</option>`).join('');
    row.innerHTML =
      `<select class="gtype">${opts}</select>` +
      `<input class="gtarget" type="number" value="${g.target}" />` +
      `<button class="gdel" title="Supprimer">✕</button>`;
    row.querySelector('.gdel').addEventListener('click', () => { row.remove(); refreshAddState(); });
    goalsListEl.appendChild(row);
    refreshAddState();
  }

  function refreshAddState() {
    const addBtn = document.getElementById('goal-add');
    if (addBtn) addBtn.disabled = goalsListEl.children.length >= 4;
  }

  function readGoalRows() {
    return [...goalsListEl.querySelectorAll('.goal-item')].map((row) => ({
      type: row.querySelector('.gtype').value,
      target: parseInt(row.querySelector('.gtarget').value, 10) || 0
    }));
  }

  async function openGoals() {
    goalsListEl.innerHTML = '';
    let list = [];
    try { list = await window.hub.getGoals(); } catch {}
    if (!list || list.length === 0) list = [{ type: 'reachMmr', target: 1110 }];
    list.forEach(addGoalRow);
    document.body.classList.add('show-goals');
  }

  document.getElementById('goals-toggle').addEventListener('click', openGoals);
  document.getElementById('goals-close').addEventListener('click', () => document.body.classList.remove('show-goals'));
  document.getElementById('goals').addEventListener('click', (e) => { if (e.target.id === 'goals') document.body.classList.remove('show-goals'); });
  document.getElementById('goal-add').addEventListener('click', () => addGoalRow());
  document.getElementById('goals-save').addEventListener('click', async () => {
    const status = document.getElementById('goals-status');
    let saved = [];
    try { saved = await window.hub.saveGoals(readGoalRows()); } catch {}
    if (status) { status.textContent = `✓ ${saved.length} objectif(s) enregistré(s)`; setTimeout(() => { status.textContent = ''; }, 2000); }
  });
```

- [ ] **Step 6: Gérer Échap pour `#goals`**

Repérer le handler clavier global qui gère Échap pour `#keys`/`#news`/`#settings` (rechercher `keysOn()` / `settingsOn()` près de ≈715-717). Ajouter `goalsOn` et la fermeture Échap, sur le même modèle. Exemple :

```js
  const goalsOn = () => document.body.classList.contains('show-goals');
```

et dans le listener `keydown` Échap existant, ajouter une branche qui retire `show-goals` si `goalsOn()`.

- [ ] **Step 7: Afficher tous les objectifs sur le dashboard**

Dans `hub.html`, remplacer le widget « Objectif » (≈368) :

```html
      <section class="card widget"><div class="label">Objectif</div><div class="big" data-f="goalLabel">—</div><div class="bar"><i data-f="goalBar"></i></div></section>
```

par :

```html
      <section class="card widget"><div class="label">Objectifs</div><div id="goalsWidget" class="goals-widget"><div class="label">—</div></div></section>
```

Ajouter le CSS :

```css
  .goals-widget .gw { margin-bottom: 8px; }
  .goals-widget .gw:last-child { margin-bottom: 0; }
  .goals-widget .gw-lbl { font-size: 12px; color: var(--txt); display: flex; justify-content: space-between; gap: 8px; }
  .goals-widget .gw-lbl .gw-done { color: var(--good); }
  .goals-widget .gw-bar { height: 5px; border-radius: 3px; background: #15171d; overflow: hidden; margin-top: 3px; }
  .goals-widget .gw-bar > i { display: block; height: 100%; width: 0%; border-radius: 3px; background: var(--accent); }
```

Dans `paint(vm)`, remplacer le bloc actuel (≈664-666) :

```js
    const g0 = (vm.goals && vm.goals[0]) || null;
    txt('goalLabel', g0 ? g0.label : '—');
    const gb = $('goalBar'); if (gb) gb.style.width = (g0 ? g0.pct : 0) + '%';
```

par :

```js
    const gw = document.getElementById('goalsWidget');
    if (gw) {
      const gs = vm.goals || [];
      gw.innerHTML = gs.length
        ? gs.map((g) => `<div class="gw"><div class="gw-lbl"><span>${g.label}</span>` +
            `<span class="${g.done ? 'gw-done' : ''}">${g.done ? '✓' : g.pct + '%'}</span></div>` +
            `<div class="gw-bar"><i style="width:${g.pct}%"></i></div></div>`).join('')
        : '<div class="label">Aucun objectif</div>';
    }
```

- [ ] **Step 8: Vérifier + tester manuellement**

Run: `node --test`
Expected: PASS (toute la suite).

Manuel (`run-rl-overlay`) : Hub → 🎯 Objectifs, ajouter/éditer/supprimer (max 4 → bouton Ajouter grisé), Enregistrer. Vérifier que le widget « Objectifs » du dashboard liste tous les objectifs avec leur barre/pct, et que l'état « ✓ » apparaît quand un objectif est atteint. Rouvrir le Hub : les objectifs persistent. Vider tous les objectifs et enregistrer → le moteur retombe sur les objectifs par défaut au prochain calcul.

- [ ] **Step 9: Commit**

```bash
git add main.js hub-preload.js hub.html
git commit -m "feat: UI objectifs (gestionnaire 1-4) + widget multi-objectifs"
```

---

## Self-Review Notes

- **Spec coverage :** §2 Goals → Tasks 5-6. §3 Police + taille MMR → Tasks 1-2. §4 Export/import → Tasks 3-4. Reset des réglages inclut les nouveaux flags (Task 2 Step 2). Fallback `DEFAULT_GOALS` préservé (Task 5/6). Aucun item hors-scope (i18n, toggles, remap, monétisation) n'apparaît.
- **Type consistency :** `normalizeOverlayFlag` (T1) consommé en T2 ; `parseConfigImport` (T3) en T4 ; `normalizeGoals`/`GOAL_TYPES`/`defaultGoalLabel` (T5) en T6. Vars CSS `--ui-font`/`--mmrScale`, flags `font`/`mmrSize`, IPC `export-config`/`import-config`/`get-goals`/`save-goals`, bridges `exportConfig`/`importConfig`/`getGoals`/`saveGoals` nommés identiquement partout.
- **Risque connu :** numéros de ligne `main.js`/`hub.html`/`index.html` approximatifs (« ≈ ») — l'implémenteur localise par le contenu cité, pas par la ligne. Plusieurs tâches modifient `main.js`/`hub.html` ; respecter l'ordre des tâches pour limiter les conflits.
