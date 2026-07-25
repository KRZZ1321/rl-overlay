-- Profils (miroir de auth.users, alimenté au 1er login via trigger)
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  discord_name text,
  avatar_url text,
  is_banned boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.themes (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles on delete cascade,
  name text not null check (char_length(name) between 1 and 24),
  a_a text not null check (a_a ~ '^#[0-9a-f]{6}$'),
  a_b text not null check (a_b ~ '^#[0-9a-f]{6}$'),
  bg  text not null check (bg  ~ '^#[0-9a-f]{6}$'),
  txt text not null check (txt ~ '^#[0-9a-f]{6}$'),
  tags text[] not null default '{}',
  installs integer not null default 0,
  likes integer not null default 0,
  is_premium boolean not null default false,   -- hook Store Phase 2 (inerte)
  price_cents integer,
  status text not null default 'live' check (status in ('live','removed')),
  created_at timestamptz not null default now()
);
create index themes_status_installs_idx on public.themes (status, installs desc);
create index themes_status_likes_idx on public.themes (status, likes desc);
create index themes_status_created_idx on public.themes (status, created_at desc);

create table public.likes (
  theme_id uuid not null references public.themes on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (theme_id, user_id)
);

create table public.installs (
  theme_id uuid not null references public.themes on delete cascade,
  user_id uuid references public.profiles on delete set null,
  day date not null default current_date
);
-- Idempotence 1 install / user / thème / jour. Index unique (pas PK : user_id est
-- nullable pour l'anon). NULLS NOT DISTINCT (PG15+) => tous les anon d'un même
-- thème/jour collapsent sur une seule ligne (pas d'inflation anonyme).
create unique index installs_uniq on public.installs (theme_id, user_id, day) nulls not distinct;

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  theme_id uuid not null references public.themes on delete cascade,
  reporter_id uuid not null references public.profiles on delete cascade,
  reason text,
  created_at timestamptz not null default now()
);

-- Phase 2 (réservé, inerte en MVP)
create table public.entitlements (
  user_id uuid not null references public.profiles on delete cascade,
  sku text not null,
  source text,
  granted_at timestamptz not null default now(),
  primary key (user_id, sku)
);

-- Alimente profiles au 1er login (métadonnées Discord)
create function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, discord_name, avatar_url)
  values (new.id, new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'avatar_url')
  on conflict (id) do nothing;
  return new;
end; $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
