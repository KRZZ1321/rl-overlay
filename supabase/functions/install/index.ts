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
