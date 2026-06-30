# Design — Update "Finition & Confort"

Date : 2026-06-30
Statut : design validé (brainstorming). Aucune monétisation dans cette update.
Base : v1.2.9. Axes retenus par l'utilisateur : finir le « moitié-fait » + polish confort.

## 0. Contexte et cadrage

Audit du code (pas du doc freemium, qui décrit l'état v1.1.x) : la plupart du
catalogue d'idées est déjà livré (OBS source, éditeur de thème, Stats API live,
historique + sparkline, live MMR, installer per-user, écran Diagnostic dans
Réglages, auto-détection du log OneDrive dans `rllog.js`).

Restent quatre trous réels, tous côté UI/câblage, faible risque :

1. **i18n** : `lib/i18n.js` + tests existent mais ne sont jamais câblés ; le Hub est
   `lang="fr"` en dur, aucun `data-i18n`. L'anglais ne marche pas.
2. **Goals** : `lib/goals.js` est câblé dans `lib/viewmodel.js` (via `goalsCfg`,
   lu depuis `cfg.goals` en `main.js:333`) mais aucune UI ne permet de définir les
   objectifs. Le dashboard n'affiche que `goals[0]`.
3. **Police + taille du MMR** : absents de la page Réglages.
4. **Toggles d'éléments manquants + export/import de la config.**

Hors scope (déjà fait ou écarté) : écran santé/Diagnostic (déjà dans Réglages),
auto-détection log OneDrive (déjà dans `rllog.js`), remap des raccourcis (écarté
par l'utilisateur), monétisation (`entitlement.js` reste `isPremium() === true`).

## 1. Mécanismes existants réutilisés

- **Réglages** : surcouche `#settings` dans `hub.html`, lignes `.srow` écrites à la
  main. On garde ce style (pas le générateur-schéma évoqué au §3 du doc freemium —
  YAGNI pour ce lot).
- **Persistance** : `CONFIG_PATH = userData/config.json`, `saveConfig(cfg)`
  (`main.js:67`). Push live d'un réglage : IPC `set-overlay-flag(key, value)`
  (`main.js:572`) qui écrit `cfg.overlay[key]` puis `saveConfig`.
- **viewmodel** : `evaluateGoals(goalsCfg, ctx)` renvoie déjà un tableau
  `{label, type, target, value, pct, done}`.

## 2. Sous-projet i18n (FR/EN)

### Objectif
Anglais réel sur le Hub et l'overlay in-game, choix de langue auto au 1er lancement
puis togglable. OBS exclu de ce lot (libellés minimaux, ajoutable plus tard).

### Données
- `lib/i18n.js` expose les dictionnaires `fr` et `en` (clé → libellé) et un
  sélecteur `t(lang, key)` (ou table par langue). On complète les dictionnaires
  avec toutes les clés des libellés actuellement en dur dans `hub.html` et
  `index.html`.
- Langue stockée dans `cfg.overlay.lang` (`'fr'` | `'en'`).

### Détection initiale
Au premier lancement (clé absente), `main.js` calcule la langue depuis
`app.getLocale()` : si la locale commence par `en` → `'en'`, sinon `'fr'`. Écrit
dans `cfg.overlay.lang` via `saveConfig`. Les lancements suivants respectent la
valeur stockée (et le choix manuel).

### UI
- Nouvelle ligne `.srow` dans `#settings` : toggle/segmenté FR ⇄ EN, câblé sur
  `set-overlay-flag('lang', value)`.

### Renderer
- Marquer chaque libellé traduisible par `data-i18n="clé"` dans `hub.html` et
  `index.html`.
- Fonction `applyLang(lang)` : parcourt `[data-i18n]`, remplace le texte par
  `dict[lang][clé]`, met à jour `document.documentElement.lang`. Appelée au load et
  à chaque réception d'un changement de `lang` (même canal que les autres flags
  poussés au renderer).
- Les libellés générés en JS (ex. cartes dashboard, tooltips) passent par `t(lang, …)`.

### Tests
- Détection langue : `en-US` → `en`, `fr-FR` → `fr`, locale inconnue → `fr`.
- Dictionnaires : toute clé présente en `fr` existe en `en` et inversement
  (pas de clé orpheline).

## 3. Sous-projet UI Goals

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

## 4. Sous-projet Police + taille du MMR

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

## 5. Sous-projet Toggles d'éléments + export/import config

### Toggles manquants
État actuel des toggles : halo MMR, musique, série, ±MMR. À ajouter : **peak**,
**boost**, **défi du jour**, **momentum-10**.
- Une `.srow` par élément dans `#settings`, câblée `set-overlay-flag('show<Elem>', bool)`.
- Renderer (`index.html`) : classe `hide-<elem>` sur le stage qui masque le bloc
  correspondant (CSS), pilotée par la valeur du flag.
- Le bouton « Réinitialiser les réglages » existant doit inclure ces nouveaux flags
  dans son reset (`reset-overlay-settings`, `main.js:519`).

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

## 6. Ordre de livraison conseillé

1. **Police + taille MMR** et **toggles d'éléments** (plus petits, mécanisme
   `set-overlay-flag` déjà là, impact perçu immédiat).
2. **Export / import config** (robustesse, isolé).
3. **UI Goals** (nouvelle surcouche + refonte du widget).
4. **i18n** (le plus transverse : touche tous les libellés ; à faire en dernier
   pour traduire d'un coup tout ce qui précède).

Chaque sous-projet est indépendant et livrable seul.

## 7. Risques / notes

- **Auto-update public** : toute release est poussée à tous les utilisateurs.
  Tester hors-ligne puis en jeu (runClient via skill `run-rl-overlay`) avant tout
  tag/release.
- i18n : risque d'oublier des libellés générés en JS ; le test « pas de clé
  orpheline » et une relecture visuelle des deux langues couvrent ce risque.
- Aucune migration de `config.json` requise : tous les nouveaux champs ont un
  défaut (flags `true`, `lang` détectée, `goals` → défauts, `font`/`mmrSize`
  → valeurs de base).
