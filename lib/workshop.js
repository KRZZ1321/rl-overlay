'use strict';
// Logique pure de la galerie Workshop (tri/filtre/cache). Pas d'I/O ni de réseau.
function mapRow(r) {
  r = r || {};
  return {
    id: r.id, name: r.name || '', author: r.author || (r.profiles && r.profiles.discord_name) || '',
    aA: r.a_a, aB: r.a_b, bg: r.bg, txt: r.txt,
    tags: Array.isArray(r.tags) ? r.tags : [],
    installs: r.installs | 0, likes: r.likes | 0,
    createdAt: r.created_at || null,
  };
}
function sortThemes(list, mode) {
  const a = (list || []).slice();
  if (mode === 'liked') a.sort((x, y) => y.likes - x.likes);
  else if (mode === 'recent') a.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
  else a.sort((x, y) => y.installs - x.installs); // popular par défaut
  return a;
}
function filterThemes(list, opts) {
  const o = opts || {};
  const q = (o.q || '').toLowerCase().trim();
  return (list || []).filter((t) => {
    if (o.tag && !(t.tags || []).includes(o.tag)) return false;
    if (q && !String(t.name).toLowerCase().includes(q)) return false;
    return true;
  });
}
function serializeCache(list) { return JSON.stringify(list || []); }
function parseCache(str) {
  try { const v = JSON.parse(str); return Array.isArray(v) ? v : []; } catch { return []; }
}
module.exports = { mapRow, sortThemes, filterThemes, serializeCache, parseCache };
