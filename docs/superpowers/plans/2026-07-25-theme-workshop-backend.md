# Theme Workshop — Backend Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Supabase backend for the community Theme Workshop — schema, row-level security, count triggers, and validated publish/install endpoints — with a shared theme-validation library.

**Architecture:** Supabase (Postgres + Auth + Edge Functions) lives in a new `supabase/` directory managed by the Supabase CLI. A single dependency-free data file (`shared/theme-rules.json`) is the source of truth for the allowed tag list and blocked-name substrings; both the Node client library and the Deno Edge Functions read it. Counts (likes, installs) are never written by clients — a trigger recomputes `themes.likes`, and an idempotent Edge Function increments `themes.installs`. This plan produces a testable backend on its own; the Hub client is a separate follow-up plan.

**Tech Stack:** Supabase CLI, Postgres (SQL migrations), Deno (Edge Functions, TypeScript), Node.js CommonJS + `node:test` (shared validation lib), Discord OAuth.

## Global Constraints

- Node/runtime: shared lib is CommonJS, dependency-free, `--release 17`-era Node (matches existing `lib/`). Tests via `node --test`.
- Repo is PUBLIC: only the Supabase **anon** key may ship in client code. No service-role key in the repo or client. Security rests on RLS, not secrecy.
- Theme shape: `{ name, aA, aB, bg, txt }` — 4 colors are `#rrggbb` hex, `name` ≤ 24 chars.
- Tags come only from the fixed list in `shared/theme-rules.json` (no free-text tags).
- Rate limit: max 10 published themes per user per rolling 24h, enforced server-side.
- Install count is idempotent per `(theme_id, user_id, day)`.
- Follow existing repo conventions: pure logic in `lib/`, French comments, `node:test`.

---

### Task 1: Shared theme-validation library (pure, tested)

**Files:**
- Create: `shared/theme-rules.json`
- Create: `lib/theme-validate.js`
- Test: `test/theme-validate.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `validateTheme(input) -> { ok: true, value: {name,aA,aB,bg,txt,tags} } | { ok: false, error: string }`
  - `ALLOWED_TAGS: string[]` (re-exported from JSON)
  - `isNameClean(name) -> boolean`

- [ ] **Step 1: Create the shared rules data file**

`shared/theme-rules.json`:
```json
{
  "allowedTags": ["Sombre", "Clair", "Néon", "Pastel", "Mono", "Vif", "Chill", "Agressif"],
  "blockedNameSubstrings": ["fuck", "shit", "nigg", "fag", "rape", "cunt", "kys"],
  "maxNameLength": 24,
  "maxTags": 3
}
```

- [ ] **Step 2: Write the failing test**

`test/theme-validate.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const { validateTheme, isNameClean, ALLOWED_TAGS } = require('../lib/theme-validate');

test('validateTheme accepte un thème correct', () => {
  const r = validateTheme({ name: 'Sunset', aA: '#ff8a3d', aB: '#ffc24d', bg: '#0a0b0e', txt: '#f5f6f8', tags: ['Sombre', 'Vif'] });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.value.tags, ['Sombre', 'Vif']);
  assert.strictEqual(r.value.aA, '#ff8a3d');
});

test('validateTheme rejette un hex invalide', () => {
  const r = validateTheme({ name: 'X', aA: 'red', aB: '#ffc24d', bg: '#0a0b0e', txt: '#f5f6f8', tags: [] });
  assert.strictEqual(r.ok, false);
});

test('validateTheme rejette un nom trop long', () => {
  const r = validateTheme({ name: 'x'.repeat(25), aA: '#ff8a3d', aB: '#ffc24d', bg: '#0a0b0e', txt: '#f5f6f8', tags: [] });
  assert.strictEqual(r.ok, false);
});

test('validateTheme rejette un nom grossier', () => {
  const r = validateTheme({ name: 'shitTheme', aA: '#ff8a3d', aB: '#ffc24d', bg: '#0a0b0e', txt: '#f5f6f8', tags: [] });
  assert.strictEqual(r.ok, false);
});

test('validateTheme rejette un tag hors liste', () => {
  const r = validateTheme({ name: 'X', aA: '#ff8a3d', aB: '#ffc24d', bg: '#0a0b0e', txt: '#f5f6f8', tags: ['Piraté'] });
  assert.strictEqual(r.ok, false);
});

test('validateTheme rejette plus de maxTags', () => {
  const r = validateTheme({ name: 'X', aA: '#ff8a3d', aB: '#ffc24d', bg: '#0a0b0e', txt: '#f5f6f8', tags: ['Sombre', 'Clair', 'Vif', 'Mono'] });
  assert.strictEqual(r.ok, false);
});

test('isNameClean insensible à la casse', () => {
  assert.strictEqual(isNameClean('FucK'), false);
  assert.strictEqual(isNameClean('Aurora'), true);
});

test('ALLOWED_TAGS exposé', () => {
  assert.ok(ALLOWED_TAGS.includes('Néon'));
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/theme-validate.test.js`
Expected: FAIL — "Cannot find module '../lib/theme-validate'".

- [ ] **Step 4: Write minimal implementation**

`lib/theme-validate.js`:
```js
'use strict';
// Validation pure d'un thème communautaire (pas d'I/O). Réutilisée par le client
// (feedback instantané) ; les Edge Functions revalident côté serveur (source de
// confiance). Règles data (tags, mots bloqués) = shared/theme-rules.json.
const RULES = require('../shared/theme-rules.json');
const HEX = /^#[0-9a-fA-F]{6}$/;
const ALLOWED_TAGS = RULES.allowedTags.slice();

function isNameClean(name) {
  const low = String(name || '').toLowerCase();
  return !RULES.blockedNameSubstrings.some((w) => low.includes(w));
}

function validateTheme(input) {
  const i = input || {};
  const name = String(i.name || '').trim();
  if (!name || name.length > RULES.maxNameLength) return { ok: false, error: 'name' };
  if (!isNameClean(name)) return { ok: false, error: 'name-blocked' };
  for (const k of ['aA', 'aB', 'bg', 'txt']) {
    if (!HEX.test(String(i[k] || ''))) return { ok: false, error: 'color:' + k };
  }
  const tags = Array.isArray(i.tags) ? i.tags : [];
  if (tags.length > RULES.maxTags) return { ok: false, error: 'tags-count' };
  if (!tags.every((t) => ALLOWED_TAGS.includes(t))) return { ok: false, error: 'tags-invalid' };
  return { ok: true, value: {
    name, tags: tags.slice(),
    aA: i.aA.toLowerCase(), aB: i.aB.toLowerCase(), bg: i.bg.toLowerCase(), txt: i.txt.toLowerCase(),
  } };
}

module.exports = { validateTheme, isNameClean, ALLOWED_TAGS };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test test/theme-validate.test.js`
Expected: PASS — 8 tests.

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `node --test test/`
Expected: PASS — existing 149 tests + 8 new.

- [ ] **Step 7: Commit**

```bash
git add shared/theme-rules.json lib/theme-validate.js test/theme-validate.test.js
git commit -m "feat: shared theme-validation lib (hex/name/tags) + rules data"
```

---

### Task 2: Supabase project scaffolding

**Files:**
- Create: `supabase/config.toml` (generated by CLI)
- Create: `supabase/.gitignore` (generated)
- Modify: `.gitignore` (ignore local Supabase artifacts + env)
- Create: `docs/supabase-setup.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `supabase/` project the later tasks add migrations and functions to; local stack reachable via `supabase start`.

- [ ] **Step 1: Initialize the Supabase project**

Run from repo root (requires Supabase CLI installed):
```bash
supabase init
```
Expected: creates `supabase/config.toml` and `supabase/.gitignore`.

- [ ] **Step 2: Ignore local secrets/artifacts**

Append to repo `.gitignore`:
```
# Supabase local
supabase/.branches
supabase/.temp
.env
.env.local
```

- [ ] **Step 3: Write the setup doc**

`docs/supabase-setup.md`:
```markdown
# Supabase — setup Theme Workshop

## Local
1. Install CLI: https://supabase.com/docs/guides/cli
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
- **service_role key**: NEVER commit / never ship. Server-only.
```

- [ ] **Step 4: Verify the local stack boots**

Run: `supabase start`
Expected: prints API URL, DB URL, Studio URL, anon key without error.

- [ ] **Step 5: Commit**

```bash
git add supabase/config.toml supabase/.gitignore .gitignore docs/supabase-setup.md
git commit -m "chore: scaffold Supabase project + setup doc"
```

---

### Task 3: Schema migration (tables, constraints, indexes)

**Files:**
- Create: `supabase/migrations/0001_schema.sql`

**Interfaces:**
- Consumes: Supabase `auth.users` (built-in).
- Produces: tables `profiles`, `themes`, `likes`, `installs`, `reports`, `entitlements` with the columns and constraints the RLS/trigger/function tasks depend on.

- [ ] **Step 1: Write the schema migration**

`supabase/migrations/0001_schema.sql`:
```sql
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
  day date not null default current_date,
  primary key (theme_id, user_id, day)
);

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
create function public.handle_new_user() returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, discord_name, avatar_url)
  values (new.id, new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'avatar_url')
  on conflict (id) do nothing;
  return new;
end; $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
```

- [ ] **Step 2: Apply migrations locally**

Run: `supabase db reset`
Expected: applies `0001_schema.sql` with no error ("Applying migration 0001_schema.sql...").

- [ ] **Step 3: Verify tables exist**

Run:
```bash
psql "$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '"')" -c "\dt public.*"
```
Expected: lists `profiles, themes, likes, installs, reports, entitlements`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0001_schema.sql
git commit -m "feat: workshop schema (themes/likes/installs/reports/entitlements)"
```

---

### Task 4: Row-level security policies

**Files:**
- Create: `supabase/migrations/0002_rls.sql`

**Interfaces:**
- Consumes: tables from Task 3.
- Produces: enforced access — public read of live themes, author-only writes, self-only likes/reports, no client write to counts or `status`.

- [ ] **Step 1: Write the RLS migration**

`supabase/migrations/0002_rls.sql`:
```sql
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
```

- [ ] **Step 2: Apply and verify default-deny on installs**

Run: `supabase db reset`
Then, using the anon key, attempt a direct insert into `themes.installs` (should fail):
```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/installs" \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
  -H "Content-Type: application/json" \
  -d '{"theme_id":"00000000-0000-0000-0000-000000000000"}'
```
Expected: HTTP 401/403 (RLS blocks) — not 201.

- [ ] **Step 3: Verify public read of live themes works**

```bash
curl -s "$SUPABASE_URL/rest/v1/themes?select=id,name&status=eq.live" -H "apikey: $ANON"
```
Expected: HTTP 200, JSON array (empty is fine).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0002_rls.sql
git commit -m "feat: RLS policies (public read live, author-only writes, self likes)"
```

---

### Task 5: Likes-count trigger

**Files:**
- Create: `supabase/migrations/0003_likes_trigger.sql`

**Interfaces:**
- Consumes: `likes`, `themes` from Task 3.
- Produces: `themes.likes` stays equal to `count(*)` of matching `likes` rows automatically.

- [ ] **Step 1: Write the trigger migration**

`supabase/migrations/0003_likes_trigger.sql`:
```sql
create function public.recount_likes() returns trigger language plpgsql security definer as $$
declare tid uuid;
begin
  tid := coalesce(new.theme_id, old.theme_id);
  update public.themes set likes = (select count(*) from public.likes where theme_id = tid)
  where id = tid;
  return null;
end; $$;

create trigger likes_after_change
  after insert or delete on public.likes
  for each row execute function public.recount_likes();
```

- [ ] **Step 2: Apply and test the count**

Run: `supabase db reset`
Then in Studio SQL editor (or psql), seed a profile + theme, insert a like, assert count:
```sql
insert into auth.users (id) values ('11111111-1111-1111-1111-111111111111');
insert into public.profiles (id, discord_name) values ('11111111-1111-1111-1111-111111111111','tester');
insert into public.themes (id, author_id, name, a_a, a_b, bg, txt)
  values ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','T','#ff8a3d','#ffc24d','#0a0b0e','#f5f6f8');
insert into public.likes (theme_id, user_id) values ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111');
select likes from public.themes where id='22222222-2222-2222-2222-222222222222';
```
Expected: `likes = 1`. Deleting the like → `likes = 0`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0003_likes_trigger.sql
git commit -m "feat: trigger recomputes themes.likes on like insert/delete"
```

---

### Task 6: `publish` Edge Function (server-side validation + rate limit)

**Files:**
- Create: `supabase/functions/_shared/validate.ts`
- Create: `supabase/functions/publish/index.ts`

**Interfaces:**
- Consumes: `shared/theme-rules.json` (copied/read at build), authed user JWT, `themes` table.
- Produces: `POST /functions/v1/publish` body `{name,aA,aB,bg,txt,tags}` → `201 {id}` or `4xx {error}`. Enforces the same rules as `lib/theme-validate.js` plus the 10/24h rate limit.

- [ ] **Step 1: Write the shared Deno validator (mirrors the Node lib rules)**

`supabase/functions/_shared/validate.ts`:
```ts
import rules from "../../../shared/theme-rules.json" with { type: "json" };
const HEX = /^#[0-9a-fA-F]{6}$/;
export const ALLOWED_TAGS: string[] = rules.allowedTags;

export function validateTheme(i: any):
  | { ok: true; value: { name: string; a_a: string; a_b: string; bg: string; txt: string; tags: string[] } }
  | { ok: false; error: string } {
  const name = String(i?.name ?? "").trim();
  if (!name || name.length > rules.maxNameLength) return { ok: false, error: "name" };
  const low = name.toLowerCase();
  if (rules.blockedNameSubstrings.some((w: string) => low.includes(w))) return { ok: false, error: "name-blocked" };
  for (const [k, key] of [["aA", "a_a"], ["aB", "a_b"], ["bg", "bg"], ["txt", "txt"]] as const) {
    if (!HEX.test(String(i?.[k] ?? ""))) return { ok: false, error: "color:" + k };
  }
  const tags = Array.isArray(i?.tags) ? i.tags : [];
  if (tags.length > rules.maxTags) return { ok: false, error: "tags-count" };
  if (!tags.every((t: string) => ALLOWED_TAGS.includes(t))) return { ok: false, error: "tags-invalid" };
  return { ok: true, value: {
    name, tags,
    a_a: String(i.aA).toLowerCase(), a_b: String(i.aB).toLowerCase(),
    bg: String(i.bg).toLowerCase(), txt: String(i.txt).toLowerCase(),
  } };
}
```

- [ ] **Step 2: Write the publish function**

`supabase/functions/publish/index.ts`:
```ts
import { createClient } from "jsr:@supabase/supabase-js@2";
import { validateTheme } from "../_shared/validate.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const auth = req.headers.get("Authorization") ?? "";
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: auth } } },
  );
  const { data: userRes } = await supa.auth.getUser();
  const user = userRes?.user;
  if (!user) return json({ error: "auth" }, 401);

  const v = validateTheme(await req.json().catch(() => ({})));
  if (!v.ok) return json({ error: v.error }, 400);

  // Rate limit : 10 thèmes / 24h / user
  const since = new Date(Date.now() - 86400_000).toISOString();
  const { count } = await supa.from("themes").select("id", { count: "exact", head: true })
    .eq("author_id", user.id).gte("created_at", since);
  if ((count ?? 0) >= 10) return json({ error: "rate-limit" }, 429);

  const { data, error } = await supa.from("themes")
    .insert({ author_id: user.id, ...v.value }).select("id").single();
  if (error) return json({ error: "insert" }, 400);
  return json({ id: data.id }, 201);
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
```

- [ ] **Step 3: Serve functions locally**

Run: `supabase functions serve publish --no-verify-jwt`
Expected: "Serving functions on http://localhost:54321/functions/v1/publish".

- [ ] **Step 4: Test rejection of a bad theme (no auth path via unit of validator)**

With the local stack, call with an invalid hex and a valid JWT (obtain a test JWT via `supabase` Studio or a signed-in session). Minimal check — invalid color:
```bash
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:54321/functions/v1/publish \
  -H "Authorization: Bearer $USER_JWT" -H "Content-Type: application/json" \
  -d '{"name":"Bad","aA":"red","aB":"#ffc24d","bg":"#0a0b0e","txt":"#f5f6f8","tags":[]}'
```
Expected: `400`.

- [ ] **Step 5: Test a valid publish returns 201 + id**

```bash
curl -s -X POST http://localhost:54321/functions/v1/publish \
  -H "Authorization: Bearer $USER_JWT" -H "Content-Type: application/json" \
  -d '{"name":"Sunset","aA":"#ff8a3d","aB":"#ffc24d","bg":"#0a0b0e","txt":"#f5f6f8","tags":["Sombre"]}'
```
Expected: `{"id":"..."}` with HTTP 201.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/_shared/validate.ts supabase/functions/publish/index.ts
git commit -m "feat: publish edge function (server validation + 10/24h rate limit)"
```

---

### Task 7: `install` Edge Function (idempotent count)

**Files:**
- Create: `supabase/functions/install/index.ts`

**Interfaces:**
- Consumes: authed-or-anon caller, `installs` + `themes` tables.
- Produces: `POST /functions/v1/install` body `{theme_id}` → `200 {installs}`. Idempotent per `(theme_id, user_id, day)`; only increments `themes.installs` on a genuinely new row.

- [ ] **Step 1: Add an increment RPC (avoids read-modify-write races)**

Append to a new migration `supabase/migrations/0004_install_rpc.sql`:
```sql
create function public.bump_install(p_theme uuid) returns integer
language sql security definer as $$
  update public.themes set installs = installs + 1 where id = p_theme and status = 'live'
  returning installs;
$$;
```

- [ ] **Step 2: Write the install function (uses service role, does the idempotency)**

`supabase/functions/install/index.ts`:
```ts
import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const { theme_id } = await req.json().catch(() => ({}));
  if (!theme_id) return json({ error: "theme_id" }, 400);

  // service role : autorisé à écrire installs (RLS bypass), on gère l'idempotence nous-mêmes
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // user optionnel (anon autorisé) -> résolu depuis le JWT si présent
  let userId: string | null = null;
  const auth = req.headers.get("Authorization");
  if (auth) {
    const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: auth } } });
    const { data } = await anon.auth.getUser();
    userId = data?.user?.id ?? null;
  }

  const { error: insErr } = await admin.from("installs")
    .insert({ theme_id, user_id: userId }); // (theme_id,user_id,day) unique
  // 23505 = déjà compté aujourd'hui -> pas de nouvel incrément
  if (insErr && insErr.code === "23505") {
    const { data } = await admin.from("themes").select("installs").eq("id", theme_id).single();
    return json({ installs: data?.installs ?? 0 }, 200);
  }
  if (insErr) return json({ error: "install" }, 400);

  const { data, error } = await admin.rpc("bump_install", { p_theme: theme_id });
  if (error) return json({ error: "bump" }, 400);
  return json({ installs: data }, 200);
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
```

- [ ] **Step 3: Apply migration + serve**

Run: `supabase db reset && supabase functions serve install`
Expected: no error; function served.

- [ ] **Step 4: Test first install increments, second (same day) does not**

With a seeded live theme id `$T` and anon call:
```bash
curl -s -X POST http://localhost:54321/functions/v1/install -H "Content-Type: application/json" -d "{\"theme_id\":\"$T\"}"
curl -s -X POST http://localhost:54321/functions/v1/install -H "Content-Type: application/json" -d "{\"theme_id\":\"$T\"}"
```
Expected: first → `{"installs":1}`, second → `{"installs":1}` (unchanged, idempotent for anon same-day).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0004_install_rpc.sql supabase/functions/install/index.ts
git commit -m "feat: install edge function (idempotent per user/day) + bump rpc"
```

---

### Task 8: Discord auth wiring + end-to-end smoke doc

**Files:**
- Modify: `supabase/config.toml` (enable Discord provider block for local)
- Modify: `docs/supabase-setup.md` (add smoke-test section)

**Interfaces:**
- Consumes: everything above.
- Produces: a documented, reproducible path to sign in with Discord and exercise publish → browse → like → install end to end.

- [ ] **Step 1: Enable Discord in local config**

In `supabase/config.toml`, under `[auth.external.discord]`:
```toml
[auth.external.discord]
enabled = true
client_id = "env(DISCORD_CLIENT_ID)"
secret = "env(DISCORD_SECRET)"
redirect_uri = "http://localhost:54321/auth/v1/callback"
```

- [ ] **Step 2: Document the end-to-end smoke test**

Append to `docs/supabase-setup.md`:
```markdown
## Smoke test (local)
1. `supabase start && supabase db reset`
2. `supabase functions serve` (publish + install)
3. Sign in with Discord via a test client to obtain a user JWT.
4. POST /functions/v1/publish with a valid theme → 201 {id}.
5. GET /rest/v1/themes?status=eq.live → the theme appears.
6. Insert a like via /rest/v1/likes (as the user) → trigger sets themes.likes=1.
7. POST /functions/v1/install {theme_id} twice → installs increments once.
8. Insert a report → visible in Studio; set status='removed' → theme leaves the list.
```

- [ ] **Step 3: Verify the documented flow once, manually**

Follow the smoke test steps 1–8 against the local stack.
Expected: each step matches its stated outcome (theme visible, likes=1, installs stable on repeat, removed theme disappears).

- [ ] **Step 4: Commit**

```bash
git add supabase/config.toml docs/supabase-setup.md
git commit -m "docs: Discord auth config + end-to-end workshop smoke test"
```

---

## Self-Review

**Spec coverage (§ of `2026-07-25-theme-workshop-design.md`):**
- §2 data model → Task 3 (all six tables, constraints, indexes). ✓
- §3 auth/RLS → Task 4 (policies) + Task 8 (Discord). ✓
- §3 likes count → Task 5 trigger. ✓
- §3 install idempotency → Task 7 (unique key + edge fn). ✓
- §3 name filter + rate limit → Task 1 (rules) + Task 6 (server enforcement). ✓
- §3 "no secret in repo" → Global Constraints + Task 2 gitignore/doc. ✓
- §5 premium hooks → Task 3 (`is_premium`, `price_cents`, `entitlements`). ✓
- §7 success criteria → Task 8 smoke test covers publish/browse/like/install/remove. ✓
- Client (§4) is intentionally OUT of scope → separate plan `2026-07-25-theme-workshop-client.md` (to be written next).

**Placeholder scan:** no TBD/TODO; every code step shows full content. ✓

**Type consistency:** theme columns `a_a/a_b/bg/txt` used consistently in schema (Task 3), RLS (Task 4), and both edge validators (Task 6 maps client `aA/aB` → `a_a/a_b`). `validateTheme` return shape consistent between `lib/theme-validate.js` (Task 1) and Deno `validate.ts` (Task 6, DB-column keys). `bump_install(p_theme)` defined in Task 7 migration and called in Task 7 function. ✓
