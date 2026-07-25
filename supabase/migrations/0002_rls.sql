alter table public.profiles enable row level security;
alter table public.themes enable row level security;
alter table public.likes enable row level security;
alter table public.installs enable row level security;
alter table public.reports enable row level security;
alter table public.entitlements enable row level security;

-- profiles : lecture publique, écriture de son propre profil
create policy profiles_read on public.profiles for select using (true);
create policy profiles_self_update on public.profiles for update using (auth.uid() = id);

-- themes : lecture des thèmes 'live' ; insertion par l'auteur ; suppression par l'auteur.
-- Pas d'UPDATE client (status/compteurs gérés serveur/trigger/edge fn).
create policy themes_read_live on public.themes for select using (status = 'live');
create policy themes_insert_own on public.themes for insert
  with check (auth.uid() = author_id and is_premium = false and status = 'live');
create policy themes_delete_own on public.themes for delete using (auth.uid() = author_id);

-- likes : un user gère uniquement ses propres likes
create policy likes_read on public.likes for select using (true);
create policy likes_insert_self on public.likes for insert with check (auth.uid() = user_id);
create policy likes_delete_self on public.likes for delete using (auth.uid() = user_id);

-- reports : tout user authentifié peut signaler
create policy reports_insert on public.reports for insert with check (auth.uid() = reporter_id);

-- installs & entitlements : aucune policy client (écriture via edge function service-role /
-- lecture non exposée). RLS activé => tout accès anon/authenticated est refusé par défaut.

-- Privilèges table (RLS filtre les LIGNES, mais Postgres exige aussi les GRANT
-- table sinon 42501 permission denied). installs/entitlements : pas de grant
-- (service_role uniquement, qui bypass RLS).
grant usage on schema public to anon, authenticated;
grant select on public.profiles to anon, authenticated;
grant update on public.profiles to authenticated;
grant select on public.themes to anon, authenticated;
grant insert, delete on public.themes to authenticated;
grant select on public.likes to anon, authenticated;
grant insert, delete on public.likes to authenticated;
grant insert on public.reports to authenticated;

-- service_role (Edge Functions) : accès complet à toutes les tables workshop, comme
-- le défaut Supabase en prod. service_role a bypassrls mais PAS les GRANT table par
-- défaut sur des tables créées ici -> on les donne explicitement.
grant select, insert, update, delete on
  public.profiles, public.themes, public.likes, public.installs, public.reports, public.entitlements
  to service_role;
