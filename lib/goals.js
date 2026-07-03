'use strict';

const DEFAULT_GOALS = [
  { label: 'Atteindre Diamond', type: 'reachMmr', target: 1110 },
  { label: 'Winrate 60%',       type: 'winrate',  target: 60 },
  { label: '+100 MMR / semaine', type: 'mmrWeek', target: 100 },
  { label: '10 victoires / jour', type: 'winsDay', target: 10 }
];

function goalValue(type, ctx) {
  switch (type) {
    case 'reachMmr': return ctx.mmr != null ? ctx.mmr : 0;
    case 'winrate':  return ctx.winratePct || 0;
    case 'mmrWeek':  return ctx.mmrWeek || 0;
    case 'winsDay':  return ctx.winsToday || 0;
    default:         return 0;
  }
}

// Évalue chaque objectif contre le contexte courant. Pur.
function evaluateGoals(goals, ctx = {}) {
  const list = Array.isArray(goals) && goals.length ? goals : DEFAULT_GOALS;
  return list.map((g) => {
    const value = goalValue(g.type, ctx);
    const pct = Math.max(0, Math.min(100, Math.round((value / g.target) * 100)));
    return { label: g.label, type: g.type, target: g.target, value, pct, done: value >= g.target };
  });
}

// --- Normalisation des objectifs saisis dans l'UI (page Objectifs du Hub) ---
const GOAL_TYPES = ['reachMmr', 'winrate', 'mmrWeek', 'winsDay'];
const TARGET_BOUNDS = {
  reachMmr: [0, 3000],
  winrate: [0, 100],
  mmrWeek: [0, 2000],
  winsDay: [0, 100],
};

function defaultGoalLabel(type, target) {
  switch (type) {
    case 'reachMmr': return `Atteindre ${target} MMR`;
    case 'winrate':  return `Winrate ${target}%`;
    case 'mmrWeek':  return `+${target} MMR / semaine`;
    case 'winsDay':  return `${target} victoires / jour`;
    default:         return '';
  }
}

// Types invalides filtrés, cibles clampées, max 4, label auto si vide. Pur.
function normalizeGoals(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((g) => g && GOAL_TYPES.includes(g.type))
    .slice(0, 4)
    .map((g) => {
      const [min, max] = TARGET_BOUNDS[g.type];
      const target = Math.max(min, Math.min(max, Math.round(Number(g.target) || 0)));
      const label = (typeof g.label === 'string' && g.label.trim())
        ? g.label.trim()
        : defaultGoalLabel(g.type, target);
      return { label, type: g.type, target };
    });
}

module.exports = { DEFAULT_GOALS, evaluateGoals, normalizeGoals, defaultGoalLabel, GOAL_TYPES };
