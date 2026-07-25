# Supabase — setup Theme Workshop

## Local
1. Install CLI: https://supabase.com/docs/guides/cli (ou tarball GitHub releases).
2. `supabase start` (Docker) → local Postgres + Studio at http://localhost:54323
3. `supabase db reset` → applies all migrations in `supabase/migrations/`
4. `supabase functions serve` → runs Edge Functions locally

## Prod (free tier)
1. Create project at supabase.com → note the Project URL + anon key (public).
2. `supabase link --project-ref <ref>`
3. `supabase db push` → applies migrations.
4. `supabase functions deploy publish install`
5. Auth → Providers → enable **Discord**, set client id/secret + redirect URL.

## Keys
- **anon key**: public, ships in the Hub client. Safe (RLS enforces access).
- **service_role key**: NEVER commit / never ship. Server-only (utilisé par les Edge
  Functions publish/install via l'injection d'env de la plateforme).

## Discord OAuth
Le login Discord n'est PAS activé par défaut dans `supabase/config.toml`
(`[auth.external.discord] enabled = false`) car l'activer sans credentials casse
`supabase start`. Pour l'activer :

- **Local** : créer une app Discord (https://discord.com/developers/applications),
  redirect URI `http://localhost:54321/auth/v1/callback`, puis exporter
  `DISCORD_CLIENT_ID` / `DISCORD_SECRET` et passer `enabled = true` dans config.toml.
- **Prod** : Dashboard Supabase → Auth → Providers → Discord (client id/secret +
  redirect `https://<ref>.supabase.co/auth/v1/callback`).

## Smoke test (local) — VALIDÉ 2026-07-25
Reproduit end-to-end sur le stack local (sans Discord réel, JWT user forgé avec le
JWT secret local pour simuler `authenticated`) :

1. `supabase start && supabase db reset`
2. `supabase functions serve` (publish + install)
3. Créer un user (Admin API `POST /auth/v1/admin/users`, service_role) → le trigger
   `handle_new_user` remplit `profiles` (discord_name depuis `full_name`).
4. `POST /functions/v1/publish` avec un hex invalide → **400** ; avec un thème valide → **201 {id}**.
5. `GET /rest/v1/themes?status=eq.live` (clé anon) → le thème apparaît (installs=0, likes=0).
6. `POST /rest/v1/likes` (JWT user) → trigger `recount_likes` met `themes.likes = 1`.
7. `POST /functions/v1/install {theme_id}` deux fois → **installs=1 puis 1** (idempotent /user/jour ;
   anon dédupliqué via index `nulls not distinct`).
8. Passer un thème `status='removed'` (Studio) → il quitte la galerie.

Résultat observé : étape 6+7 → `installs=1, likes=1`. Tout conforme.
