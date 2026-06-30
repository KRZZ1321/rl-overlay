# Design — Update "Finition & Confort"

Date : 2026-06-30
Statut : design validé (brainstorming). Aucune monétisation dans cette update.
Base : v1.2.9. Axes retenus par l'utilisateur : finir le « moitié-fait » + polish confort.

## 0. Contexte et cadrage

Audit du code (pas du doc freemium, qui décrit l'état v1.1.x) : la plupart du
catalogue d'idées est déjà livré (OBS source, éditeur de thème, Stats API live,
historique + sparkline, live MMR, installer per-user, écran Diagnostic dans
Réglages, auto-détection du log OneDrive dans `rllog.js`).

Restent trois trous réels, tous côté UI/câblage, faible risque :

1. **Goals** : `lib/goals.js` est câblé dans `lib/viewmodel.js` (via `goalsCfg`,
   lu depuis `cfg.goals` en `main.js:333`) mais aucune UI ne permet de définir les
   objectifs. Le dashboard n'affiche que `goals[0]`.
2. **Police + taille du MMR** : absents de la page Réglages.
3. **Export/import de la config.**

Hors scope (déjà fait ou écarté) : écran santé/Diagnostic (déjà dans Réglages),
auto-détection log OneDrive (déjà dans `rllog.js`), remap des raccourcis (écarté),
**i18n / traduction EN (reporté)**, monétisation (`entitlement.js` reste
`isPremium() === true`, reporté).

## 1. Mécanismes existants réutilisés

- **Réglages** : surcouche `#settings` dans `hub.html`, lignes `.srow` écrites à la
  main. On garde ce style (pas le générateur-schéma évoqué au §3 du doc freemium —
  YAGNI pour ce lot).
- **Persistance** : `CONFIG_PATH = userData/config.json`, `saveConfig(cfg)`
  (`main.js:67`). Push live d'un réglage : IPC `set-overlay-flag(key, value)`
  (`main.js:572`) qui écrit `cfg.overlay[key]` puis `saveConfig`.
- **viewmodel** : `evaluateGoals(goalsCfg, ctx)` renvoie déjà un tableau
  `{label, type, target, value, pct, done}`.

## 2. Sous-projet UI Goals

### Objectif
Permettre à l'utilisateur de définir ses objectifs (le moteur les évalue déjà) et
afficher tous les objectifs actifs sur le dashboard.

### Modèle
- `cfg.goals` = tableau `{ label, type, target }`, 1 à 4 entrées.
- Types supportés par le moteur (`lib/goals.js`) : `reachMmr`, `winrate`,
  `mmrWeek`, `winsDay`. L'UI n'en propose pas d'autres.
- Si `cfg.goals` absent/vide, le moteur retombe sur `DEFAULT_GOALS` (comportement
  actuel conservé).

### UI (Hub)
- Nouvelle surcouche `#goals` (même pattern visuel que `#settings` / `#news` :
  ouverture par bouton, fermeture Échap / clic-fond).
- Bouton d'ouverture dans la barre d'icônes du Hub.
- Gestionnaire de liste : pour chaque objectif, une ligne avec
  - select **type** (4 valeurs, libellés traduits),
  - champ **cible** (nombre, validé selon le type : MMR entier, winrate 0-100, etc.),
  - **label** : auto-généré depuis type + cible (ex. « Atteindre 1110 MMR »,
    « 10 victoires / jour »), éditable optionnellement.
  - bouton supprimer.
- Bouton « Ajouter un objectif » (désactivé à 4). Enregistrement → IPC dédié
  (`save-goals`) qui écrit `cfg.goals` + `saveConfig`, puis re-pousse le viewmodel.

### Affichage dashboard
- Le widget « Objectif » (`hub.html:368`, actuellement `goals[0]` seul) devient une
  liste : une mini-barre par objectif actif (label + barre `pct`, état `done`
  visuellement distinct). Si aucun objectif personnalisé, affiche les défauts.

### Tests
- Moteur déjà couvert (`test/goals.test.js`).
- Ajouter : sérialisation round-trip `cfg.goals` (save → load), validation des
  bornes de cible par type.

## 3. Sous-projet Police + taille du MMR

### Réglages (dans `#settings`)
- **Police** : select 2-3 choix (ex. *Défaut*, *Condensée*, *Mono*). Valeur
  `cfg.overlay.font` via `set-overlay-flag('font', value)`.
- **Taille du MMR** : slider (ex. 80–140 %). Valeur `cfg.overlay.mmrSize` via
  `set-overlay-flag('mmrSize', value)`.

### Application (renderer `index.html`)
- `font` → mappe vers une `font-family` appliquée sur le stage (variable CSS
  `--ui-font` ou classe).
- `mmrSize` → variable CSS `--mmr-size` (ou `font-size` du nombre MMR).
- Pris en compte au load et à chaque push de flag.

### Tests
- Pas de logique pure nouvelle ; couvert par le smoke test du renderer. Vérif
  manuelle en jeu (rendu).

## 4. Sous-projet Export / import config

### Export / import de la config
- **Export** : bouton dans Réglages → `dialog.showSaveDialog` → écrit une copie de
  `config.json` au chemin choisi.
- **Import** : bouton → `dialog.showOpenDialog` → lit le fichier, `JSON.parse` dans
  un `try/catch` ; si invalide, message d'erreur et abandon ; si valide,
  `saveConfig(parsed)` puis rechargement des fenêtres / re-push du viewmodel.
- IPC dédiés : `export-config`, `import-config`.

### Tests
- Round-trip export → import : un `config.json` exporté puis réimporté redonne la
  même configuration.
- Import d'un JSON invalide : rejeté proprement, la config existante est intacte.

## 5. Ordre de livraison conseillé

1. **Police + taille MMR** (plus petit, mécanisme `set-overlay-flag` déjà là,
   impact perçu immédiat).
2. **Export / import config** (robustesse, isolé).
3. **UI Goals** (nouvelle surcouche + refonte du widget).

Chaque sous-projet est indépendant et livrable seul.

## 6. Risques / notes

- **Auto-update public** : toute release est poussée à tous les utilisateurs.
  Tester hors-ligne puis en jeu (runClient via skill `run-rl-overlay`) avant tout
  tag/release.
- Aucune migration de `config.json` requise : tous les nouveaux champs ont un
  défaut (flags `true`, `goals` → défauts, `font`/`mmrSize` → valeurs de base).
