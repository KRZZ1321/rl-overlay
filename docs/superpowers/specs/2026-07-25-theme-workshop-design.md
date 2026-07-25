# Design — Theme Workshop communautaire + fondation backend

Date : 2026-07-25
Statut : validé, prêt pour plan d'implémentation
Portée : fondation backend (Supabase) + Workshop communautaire client (MVP gratuit).
Le Store premium / validation de licence = hooks de schéma ici, spec séparé en Phase 2.

## 0. Contexte & objectif directeur

RL Overlay = overlay Electron pour Rocket League, anticheat-safe (tracker.gg public +
Launch.log read-only + Stats API locale). Repo **public** (KRZZ1321/rl-overlay), zip
portable Windows, auto-update maison (GitHub Releases).

Objectif produit des prochaines semaines : **croissance + monétisation**. Le Theme
Workshop sert les deux : moteur de bouche-à-oreille (croissance) et vitrine du futur Store
premium (monétisation). Décision utilisateur : on met en place une vraie DB.

État existant réutilisé :
- Un thème = `{ name, aA, aB, bg, txt }` (4 couleurs hex + nom).
- `lib/themegen.js` : `deriveTheme()` pur, UMD (require côté main + `window.themegen` côté
  Hub). Dérive tous les tokens CSS depuis les 4 couleurs. **Réutilisé tel quel** pour les
  previews client (aucune image serveur à générer).
- `config.overlay.customThemes = [{name,aA,aB,bg,txt}]` (cap 20), IPC add/remove déjà là.
- Index thème : `0..14` = built-in ; `15..` = customThemes.

## 1. Roadmap (priorisation du backlog — contexte de ce spec)

Ordre validé :

- **Phase 0 — Backend commun (pivot).** Un service Supabase unique : catalogue de thèmes
  (Workshop), auth Discord, compteurs likes/installs, modération. Réservé dès le schéma :
  validation de licence premium.
- **Phase 1 — Theme Workshop (croissance).** Objet de CE spec. Parcourir / publier / liker
  / appliquer des thèmes communautaires.
- **Phase 2 — Monétisation (premium).** Spec séparé, réutilise Supabase : Store officiel
  (packs thèmes/effets), intégration OBS premium, licence validée serveur (SKU dans
  `entitlements`), paiement via processeur externe (Stripe/Gumroad).
- **Phase 3 — Confort/croissance secondaire (parallélisable).** Drag & drop placement,
  onboarding auto, robustesse tracker.gg, i18n EN (élargit l'audience), stats long terme.
- **Relégué (YAGNI)** : macOS, signature code SmartScreen, multi-compte switch, marketplace
  auteurs-vendeurs.

Ce spec = Phase 0 + Phase 1.

## 2. Modèle de données (Postgres / Supabase)

- **`profiles`** — `id` uuid (= auth uid Discord), `discord_name` text, `avatar_url` text,
  `created_at` timestamptz, `is_banned` bool default false.
- **`themes`** — `id` uuid pk, `author_id` uuid → profiles, `name` text (≤ 24 car., filtré),
  `aA` `aB` `bg` `txt` text (hex `#rrggbb` validés), `tags` text[] (valeurs depuis liste
  fixe), `installs` int default 0, `likes` int default 0 (dénormalisé via trigger),
  `is_premium` bool default false (hook Store — inerte en MVP), `price_cents` int null,
  `status` text default 'live' (`live` | `removed`), `created_at` timestamptz.
- **`likes`** — `theme_id` uuid → themes, `user_id` uuid → profiles, `created_at`.
  **Contrainte unique `(theme_id, user_id)`** → 1 like/user.
- **`installs`** — `theme_id` uuid → themes, `user_id` uuid null → profiles, `day` date.
  **Unique `(theme_id, user_id, day)`** → 1 install compté / user / thème / jour
  (anti-inflation).
- **`reports`** — `id`, `theme_id` → themes, `reporter_id` → profiles, `reason` text,
  `created_at`. File de modération.
- **`entitlements`** (Phase 2, réservé, inerte en MVP) — `user_id` → profiles, `sku` text,
  `source` text, `granted_at` timestamptz.

Tags = liste fixe (chips, pas de texte libre) : `Sombre`, `Clair`, `Néon`, `Pastel`,
`Mono`, `Vif`, + par équipe/rang à préciser à l'impl. Élimine la surface de modération texte.

## 3. Backend — API & sécurité

- **Auth** : Supabase Auth, provider **Discord** (OAuth). Login requis seulement pour
  publier / liker / signaler. Parcourir = clé anon publique (lecture via RLS).
- **RLS (policies)** :
  - `themes` : SELECT ouvert où `status='live'`. INSERT réservé à `auth.uid() = author_id`.
    UPDATE/DELETE : auteur uniquement (hors champ `status`, réservé admin).
  - `likes` : INSERT/DELETE par `auth.uid() = user_id` seulement.
  - `reports` : INSERT par tout user authentifié.
  - `profiles` : SELECT public (nom/avatar), UPDATE self.
- **Compteur likes** : trigger Postgres sur insert/delete `likes` → recalcule
  `themes.likes`. Pas de write direct client sur `themes.likes`.
- **Compteur installs** : **Edge Function `POST /install`** (idempotente par
  `(theme_id, user_id|anon, day)`) → insert `installs` + incrément `themes.installs`.
  Empêche le client d'incrémenter arbitrairement.
- **Validation publication** : Edge Function `POST /publish` (ou trigger) :
  - hex `aA/aB/bg/txt` conformes `#[0-9a-f]{6}`,
  - `name` longueur ≤ 24 + **filtre grossièretés** (liste de rejet),
  - `tags` ⊂ liste fixe,
  - **rate-limit** : max 10 publications / jour / user (compte serveur).
- **Modération** : bouton signaler client → `reports`. Admin (toi) passe `status='removed'`
  via dashboard Supabase. `is_banned` sur `profiles` bloque un auteur récidiviste.
- **Aucun secret dans l'app** : seule la clé **anon** publique est embarquée (conçue pour ça
  par Supabase ; la sécurité repose sur RLS, pas sur le secret) → compatible repo public.

## 4. Client — onglet Workshop dans le Hub

Nouvel onglet **Workshop** (à côté de Réglages/Insights), 3 sous-vues :

- **Parcourir** : grille de tuiles triable (**Populaires** = installs, **Aimés** = likes,
  **Récents** = created_at), filtres par tags, recherche par nom. Pagination/scroll infini.
- **Publier** : réutilise l'**éditeur de couleurs existant** (te-aA/aB/bg/txt + nom) →
  bouton **Publier** (login Discord si pas connecté). Choix des tags via chips.
- **Mes thèmes** : publications de l'user (installs/likes reçus), retrait possible.

Détails :
- **Preview** : chaque tuile rend un **mini-overlay live** via `themegen.deriveTheme()`
  (déjà chargé côté Hub) avec les couleurs du thème. Zéro image serveur.
- **Appliquer** : 1 clic → ajoute à `config.overlay.customThemes` (IPC existant) + appelle
  `POST /install`. Respecte le cap 20 (message si plein ; premium illimité en Phase 2).
- **Liker** : cœur toggle (login requis), maj optimiste + insert/delete `likes`.
- **Offline** : cache local (fichier userData) du dernier index galerie + des thèmes
  installés → Workshop consultable hors-ligne, resync au réseau retrouvé. Un échec réseau
  n'ouvre jamais d'erreur bloquante (dégrade en cache).
- **Transport** : `@supabase/supabase-js` avec clé anon. Session Discord persistée par
  Supabase Auth côté client.

## 5. Forward-compat premium (hooks seulement en MVP)

- `themes.is_premium` + `themes.price_cents` + table `entitlements` existent dès le MVP mais
  **inertes** (aucun thème premium, aucun gating).
- Phase 2 réutilise cette base : onglet **Store** (packs officiels `is_premium=true`),
  validation licence serveur (SKU → `entitlements`), déblocage OBS premium + cosmétiques.
- `entitlement.js` (déjà présent, `isPremium()` → true partout) devient le point de
  branchement : en Phase 2 il interrogera `entitlements` au lieu de renvoyer true.

## 6. Risques & mitigations

- **Clé anon publique** : normale ; risque = RLS mal configuré. → policies revues et testées
  (un user ne peut écrire que ses propres likes/thèmes ; `status` non modifiable client).
- **Free tier Supabase** (≈ 500 Mo DB / 50k MAU) : large au démarrage ; surveiller, prévoir
  purge des `installs` anciens si volumineux.
- **Modération réactive** : dépend de l'admin ; acceptable vu contenu minuscule (couleurs +
  nom court filtré). Pré-modération écartée (goulot solo dev).
- **Discord obligatoire pour publier/voter** : exclut les non-Discord ; acceptable (public
  RL vit sur Discord). Parcourir reste libre.
- **Triche compteurs** : installs idempotents/jour + 1 like/user (contrainte unique) rendent
  l'inflation coûteuse.

## 7. Critères de succès (MVP)

- Un user peut se connecter Discord, publier un thème (nom + 4 couleurs + tags), le voir
  apparaître en galerie < 5 s.
- Un autre user parcourt, preview live, applique en 1 clic → thème dans son overlay.
- Likes et installs s'incrémentent correctement et résistent au double-comptage.
- Un thème signalé peut être retiré par l'admin et disparaît de la galerie.
- Le Hub reste utilisable hors-ligne (cache) sans erreur bloquante.
- Aucun secret backend dans le repo public ; RLS empêche toute écriture non autorisée.
