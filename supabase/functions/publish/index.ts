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
