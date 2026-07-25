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
