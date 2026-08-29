/**
 * projections.js — turn the data pack into usable projections.
 *
 * Contract: docs/ARCHITECTURE.md sections 3 (components), 5 (pack schema), 6 (interfaces),
 * 7 (projection model), 10 (honesty rules).
 *
 * Exports
 *   loadPack(pack)                          -> indexed view {players, byId, byPos, byTeam,
 *                                              schedule, teams, meta, weeks, ...}
 *   weeklyMu(player, week, pack)            -> component means for that week, or null on a bye
 *   projectFast(player, opts)               -> closed-form projection (list rendering)
 *   project(player, opts)                   -> exact projection (sim engine when wired in)
 *   restOfSeason(player, opts)              -> project() over fromWeek..end of regular season
 *   seasonTotal(player, opts)               -> project() over the whole regular season
 *   historicalPPG(player, cfg, pack)        -> what he ACTUALLY averaged under THIS scoring
 *   unpackLog(player, pack)                 -> packed log rows -> component objects
 *   weeklyProjection(player, week, opts)    -> one week, with its own distribution
 *   quantileOf(projection, p)               -> any quantile of a returned projection
 *   useSim(engine) / simEngine()            -> wire in sim.js (see "The sim engine" below)
 *   COMPONENT_CHANNEL, EVENT_COMPONENTS     -> the composition vocabulary, for tests/UI
 *
 * ---------------------------------------------------------------------------
 * What a weekly projection is
 * ---------------------------------------------------------------------------
 * The pack ships `player.mu`: component means PER GAME PLAYED, already reconciled to the
 * team's season-long budget. A single week is not the season average, though — the schedule
 * moves it. Composition (contract section 7, steps 1 and 5):
 *
 *     weeklyMu[c] = mu[c]  x  teamFactors[team][week].<channel(c)>  x  dvp[opponent][pos]
 *
 * `teamFactors` carries the market-implied scoring environment for that specific game (it is
 * built from the posted Vegas line), split into a `pass`, a `rush` and a `td` channel. Every
 * component is assigned to exactly one channel by COMPONENT_CHANNEL below. Receiving
 * components ride the `pass` channel because receiving volume is pass volume; touchdowns and
 * two-point conversions ride `td` because scoring is not the same thing as volume — the whole
 * point of contract section 7 step 4.
 *
 * Kickers and D/ST are not composed. The pack already emits per-week lines for them
 * (`kWeeks`, `dstWeeks`) with the roof and the opponent baked in, so they are used directly.
 * `dvp` for K and DST is 1.0 in this pack anyway.
 *
 * A player whose team has no game that week is on bye: `weeklyMu` returns null, and every
 * projection counts the week as zero rather than pretending he played. Bye overlap is
 * therefore structural, which is what contract section 8 step 2 requires.
 *
 * ---------------------------------------------------------------------------
 * What a projection's uncertainty is
 * ---------------------------------------------------------------------------
 * Contract section 10: every projection shows its uncertainty. A weekly variance is built
 * from two genuinely different sources rather than one fudged coefficient:
 *
 *   1. VOLUME / EFFICIENCY.  `player.cv` is the pack's usage coefficient of variation. It
 *      scales the non-scoring part of the line (yards, receptions, attempts):
 *          var_volume = (cv * nonEventPoints)^2
 *
 *   2. SCORING EVENTS.  Touchdowns, two-point conversions, interceptions, fumbles and the
 *      long-play bonuses are counting events, so each contributes its own Poisson variance
 *      at its own point value:
 *          var_events = SUM over event components of  (points per event)^2 * lambda
 *
 *      This is why a touchdown-dependent back is volatile and a volume slot receiver is not,
 *      and in full PPR that distinction is most of the edge (contract section 9).
 *
 *   3. AVAILABILITY.  `player.avail` is P(plays). A week is a mixture: he plays and scores
 *      ~ that distribution, or he does not and scores 0.
 *          mean = a*m,   var = a*s^2 + a*(1-a)*m^2
 *
 * Kickers use the event model for every component (every kicking stat is a counting event).
 * D/ST adds the two tier stacks, which are step functions of continuous quantities — so
 * their mean and variance are INTEGRATED against a normal rather than evaluated at the mean.
 * `tierPoints(E[x]) != E[tierPoints(x)]` and in this league the two stacks together swing
 * 8-10 points, so evaluating at the mean is a real error, not a rounding one.
 *
 * Quantiles come from a lognormal matched to (mean, sd), which keeps them non-negative and
 * right-skewed the way weekly fantasy scores actually are; it collapses to the normal as the
 * coefficient of variation shrinks, so a season total is normal in all but name. A range
 * containing exactly one game keeps its point mass at zero from the availability mixture, so
 * an injury-prone player's weekly p10 is 0 — which is the honest answer.
 *
 * ---------------------------------------------------------------------------
 * Inferred parameters (contract section 10 requires these be labeled)
 * ---------------------------------------------------------------------------
 * Every projection carries an `inferred` array naming the assumptions that are not sourced:
 *   - `meanUncertainty` — multi-week totals add (u * mean)^2 to the variance for the fact
 *     that the season-long mean is itself uncertain (role change, trade, scheme). Without it
 *     a season band is absurdly tight, because week-to-week independence is not the only
 *     risk. Default 0.18 for offense, 0.12 for K/DST. Set `opts.meanUncertainty = 0` to drop it.
 *   - `dstTierRho` — assumed correlation between the points-allowed and yards-allowed tier
 *     stacks, which are obviously not independent. Default 0.7.
 *   - independence of weeks within a player, and normality inside the tier integration.
 *
 * ---------------------------------------------------------------------------
 * The sim engine
 * ---------------------------------------------------------------------------
 * `project()` is the exact path and `projectFast()` is the closed form. When a Monte Carlo
 * engine is wired in, `project()` delegates to it; otherwise the two agree exactly.
 *
 * The engine is INJECTED, never imported: this module has no dependency on `sim.js`, so it
 * cannot break when that file is absent, half-written, or changes shape. The app wires it up:
 *
 *     import * as sim from './sim.js';
 *     useSim(sim);                       // or: project(p, { sim, ... })
 *
 * The adapter calls `engine.simSeason(spec)` (falling back to `engine.simulate`, or the
 * engine itself if it is a function) with
 *     { player, weeks, cfg, pack, view, weeklyMu, iters, seed, quantiles }
 * and accepts either a result object carrying `mean`/`sd` (or `p10`/`p50`/`p90`), or an array
 * of season-total samples. Anything else — a throw, a NaN, a wrong shape — falls back to the
 * closed form and is reported in `result.note`. A sim that cannot be trusted is not used.
 *
 * ---------------------------------------------------------------------------
 * Notes for callers
 * ---------------------------------------------------------------------------
 * - Every function is pure. Nothing in the pack is ever mutated, and no result aliases a
 *   pack object: `weeklyMu` always returns a fresh object, even for K and D/ST.
 * - `pack` may be the raw `window.TD_PACK` or a view from `loadPack()`. Views are cached per
 *   pack object, so passing the raw pack repeatedly costs nothing after the first call.
 * - No Math.random(), no Date.now(), no top-level side effects, no dependencies beyond
 *   `scoring.js`.
 */

import { scoreLine, DEFAULT_SCORING } from './scoring.js';

/* ------------------------------------------------------------------ vocabulary */

/**
 * Which team-week factor channel each component rides.
 *
 *   'pass' — pass-game volume, including every receiving component
 *   'rush' — rush-game volume
 *   'td'   — scoring plays: touchdowns and two-point conversions
 *   'vol'  — a player-specific blend of pass and rush, by his own opportunity mix
 *   'none' — unscaled (special-teams touchdowns have nothing to do with the offense)
 */
export const COMPONENT_CHANNEL = Object.freeze({
  // passing
  patt: 'pass', pcmp: 'pass', pyd: 'pass', pint: 'pass', psack: 'pass',
  p40: 'pass', pfd: 'pass',
  // receiving rides pass volume
  tgt: 'pass', rec: 'pass', reyd: 'pass', re40: 'pass', refd: 'pass',
  // rushing
  ratt: 'rush', ryd: 'rush', r40: 'rush', rfd: 'rush',
  // scoring plays
  ptd: 'td', rtd: 'td', retd: 'td', p2p: 'td', r2p: 'td', re2p: 'td',
  // fumbles track total touches, so they follow the player's own opportunity mix
  fuml: 'vol',
  // special teams is not offense
  sttd: 'none',
});

const CH_PASS = 0, CH_RUSH = 1, CH_TD = 2, CH_VOL = 3, CH_NONE = 4;
const CHANNEL_CODE = { pass: CH_PASS, rush: CH_RUSH, td: CH_TD, vol: CH_VOL, none: CH_NONE };

/**
 * Components that are counting events rather than accumulated volume. Each carries its own
 * Poisson variance at its own point value; everything else is covered by `player.cv`.
 */
export const EVENT_COMPONENTS = Object.freeze([
  'ptd', 'rtd', 'retd', 'sttd', 'p2p', 'r2p', 're2p', 'pint', 'fuml', 'p40', 'r40', 're40',
]);

/**
 * The offensive component vocabulary (contract section 3), in a fixed order.
 *
 * Every composed line is built with EXACTLY these keys, always present, always in this
 * order. That is not cosmetic: `scoreLine` is called ~17,000 times per full-board re-derive,
 * and handing it a thousand different object shapes turns every property read in it into a
 * megamorphic dictionary lookup. One shape keeps the whole hot path monomorphic.
 */
const OFFENSE_KEYS = Object.freeze([
  'patt', 'pcmp', 'pyd', 'ptd', 'pint', 'psack', 'p2p', 'p40', 'pfd',
  'ratt', 'ryd', 'rtd', 'r2p', 'r40', 'rfd',
  'tgt', 'rec', 'reyd', 'retd', 're2p', 're40', 'refd',
  'fuml', 'sttd',
]);

/** A zeroed offensive line. The object literal pins the hidden class for every caller. */
function blankOffense() {
  return {
    patt: 0, pcmp: 0, pyd: 0, ptd: 0, pint: 0, psack: 0, p2p: 0, p40: 0, pfd: 0,
    ratt: 0, ryd: 0, rtd: 0, r2p: 0, r40: 0, rfd: 0,
    tgt: 0, rec: 0, reyd: 0, retd: 0, re2p: 0, re40: 0, refd: 0,
    fuml: 0, sttd: 0,
  };
}

/**
 * Shared scratch line for the projection loop. Safe: it is written and consumed entirely
 * inside one synchronous pass, nothing caller-supplied runs while it is live, and it never
 * escapes — every public function returns a fresh object.
 */
const _scratch = blankOffense();

/** Kicking components, with the config path that prices each. */
const FG_BUCKETS = ['0_19', '20_29', '30_39', '40_49', '50_59', '60'];

/** D/ST counting components, with the config key that prices each. */
const DST_EVENTS = [
  ['sack', 'sack'], ['dint', 'int'], ['fumrec', 'fumRec'], ['safety', 'safety'],
  ['dtd', 'td'], ['blk', 'blk'], ['sttd', 'stTd'],
];

const OFFENSE_POS = new Set(['QB', 'RB', 'WR', 'TE', 'FB', 'HB']);

/** Default multiplicative uncertainty on the season-long mean. INFERRED — see header. */
const MEAN_UNCERTAINTY_OFFENSE = 0.18;
const MEAN_UNCERTAINTY_SPECIAL = 0.12;

/** Assumed correlation between the D/ST points-allowed and yards-allowed tier stacks. INFERRED. */
const DST_TIER_RHO = 0.7;

const EMPTY_OBJ = Object.freeze({});
const EMPTY_ARR = Object.freeze([]);

/* --------------------------------------------------------------------- helpers */

function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Round away float dust without losing precision. Mirrors scoring.js. */
function round6(x) {
  if (!Number.isFinite(x)) return 0;
  if (x >= 1e15 || x <= -1e15) return x;
  return Math.round(x * 1e6) / 1e6;
}

function round4(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 1e4) / 1e4;
}

const DST_ALIASES = new Set(['DST', 'DEF', 'D/ST', 'D-ST', 'DS', 'DEFENSE', 'DEFST']);
const K_ALIASES = new Set(['K', 'PK', 'KICKER']);

/** Normalize a position string to the pack's vocabulary. '' when unusable. */
function canonPos(pos) {
  if (typeof pos !== 'string') return '';
  const p = pos.trim().toUpperCase();
  if (DST_ALIASES.has(p)) return 'DST';
  if (K_ALIASES.has(p)) return 'K';
  return p.replace(/[^A-Z0-9]/g, '');
}

/** Week keys in the pack are strings. Interning them keeps the hot loop off String(). */
const WEEK_KEY = [];
for (let w = 0; w <= 30; w++) WEEK_KEY.push(String(w));
function weekKey(w) {
  return (w >= 0 && w <= 30) ? WEEK_KEY[w] : String(w);
}

/* -------------------------------------------------------- normal / lognormal math */

/**
 * Complementary error function, Numerical Recipes rational approximation.
 * Fractional error below 1.2e-7 everywhere, which is far tighter than any input here.
 */
function erfc(x) {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const y = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196
    + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398
    + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? y : 2 - y;
}

/** Standard normal CDF. */
function normCdf(z) {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  return 0.5 * erfc(-z / Math.SQRT2);
}

// Acklam's inverse normal CDF. Relative error below 1.15e-9 over the open unit interval.
const IN_A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
  1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
const IN_B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
  6.680131188771972e+01, -1.328068155288572e+01];
const IN_C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
  -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
const IN_D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
  3.754408661907416e+00];

/** Inverse standard normal CDF. Clamped: p<=0 -> -Infinity is useless here, so it saturates. */
function invNorm(p) {
  if (!(p > 0)) return -8.2;
  if (!(p < 1)) return 8.2;
  const PLOW = 0.02425;
  let q;
  if (p < PLOW) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((IN_C[0] * q + IN_C[1]) * q + IN_C[2]) * q + IN_C[3]) * q + IN_C[4]) * q + IN_C[5])
      / ((((IN_D[0] * q + IN_D[1]) * q + IN_D[2]) * q + IN_D[3]) * q + 1);
  }
  if (p > 1 - PLOW) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((IN_C[0] * q + IN_C[1]) * q + IN_C[2]) * q + IN_C[3]) * q + IN_C[4]) * q + IN_C[5])
      / ((((IN_D[0] * q + IN_D[1]) * q + IN_D[2]) * q + IN_D[3]) * q + 1);
  }
  q = p - 0.5;
  const r = q * q;
  return (((((IN_A[0] * r + IN_A[1]) * r + IN_A[2]) * r + IN_A[3]) * r + IN_A[4]) * r + IN_A[5]) * q
    / (((((IN_B[0] * r + IN_B[1]) * r + IN_B[2]) * r + IN_B[3]) * r + IN_B[4]) * r + 1);
}

/** z for the three reported quantiles, precomputed: the hot loop must not re-derive them. */
const Z10 = invNorm(0.1);
const Z50 = 0;
const Z90 = invNorm(0.9);

/**
 * Quantile of a distribution matched to (mean, sd).
 *
 * Lognormal when the mean is positive: non-negative, right-skewed like a real weekly score,
 * and it degenerates to the normal as sd/mean shrinks, so a season total is normal in effect.
 * Falls back to the normal when the mean is <= 0 (a QB can post a negative week).
 */
function matchedQuantile(mean, sd, p) {
  return matchedZ(mean, sd, invNorm(p));
}

/** Same, from a z-score that is already known. */
function matchedZ(mean, sd, z) {
  if (!(sd > 0)) return mean;
  if (!(mean > 0)) return mean + sd * z;
  const cv2 = (sd / mean) * (sd / mean);
  const sigma2 = Math.log1p(cv2);
  const sigma = Math.sqrt(sigma2);
  const mu = Math.log(mean) - 0.5 * sigma2;
  const v = Math.exp(mu + sigma * z);
  return Number.isFinite(v) ? v : mean + sd * z;
}

/* ------------------------------------------------------------------- loadPack */

// One view per pack object. WeakMap, so a discarded pack is collectable and nothing here
// keeps a reference alive. Purely a cache: loadPack is idempotent.
const _views = new WeakMap();

/**
 * Build an indexed, read-only view over a data pack.
 *
 * Nothing is copied except the index structures themselves — `players` holds the very same
 * player objects the pack holds, and the pack is never modified.
 *
 * @param {Object} pack `window.TD_PACK`, or a view (returned unchanged).
 * @returns {{
 *   pack: Object, players: Array, byId: Map, byPos: Map, byTeam: Map,
 *   schedule: Object, teams: Object, meta: Object, weeks: Array<number>,
 *   logKeys: Array<string>, dvp: Object, teamFactors: Object, teamBase: Object,
 *   firstWeek: number, lastWeek: number, isView: true,
 *   gameFor(team, week): Object|null, byeOf(team): number, factorsFor(team, week): Object|null
 * }}
 */
export function loadPack(pack) {
  if (pack && pack.isView === true) return pack;
  if (pack === null || typeof pack !== 'object') return emptyView();

  const hit = _views.get(pack);
  if (hit) return hit;

  const players = Array.isArray(pack.players) ? pack.players.slice() : [];
  const schedule = (pack.schedule && typeof pack.schedule === 'object') ? pack.schedule : EMPTY_OBJ;
  const teams = (pack.teams && typeof pack.teams === 'object') ? pack.teams : EMPTY_OBJ;
  const meta = (pack.meta && typeof pack.meta === 'object') ? pack.meta : EMPTY_OBJ;

  const byId = new Map();
  const byPos = new Map();
  const byTeam = new Map();

  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (p === null || typeof p !== 'object') continue;
    if (p.id !== undefined && p.id !== null && p.id !== '' && !byId.has(String(p.id))) {
      byId.set(String(p.id), p);
    }
    const pos = canonPos(p.pos);
    if (pos) {
      let l = byPos.get(pos);
      if (!l) { l = []; byPos.set(pos, l); }
      l.push(p);
    }
    const team = typeof p.team === 'string' ? p.team : '';
    if (team) {
      let l = byTeam.get(team);
      if (!l) { l = []; byTeam.set(team, l); }
      l.push(p);
    }
  }

  // team -> week -> game. The schedule omits the bye week entirely, so a miss IS the bye.
  const games = new Map();
  let firstWeek = Infinity;
  let lastWeek = 0;
  for (const team of Object.keys(schedule)) {
    const list = schedule[team];
    if (!Array.isArray(list)) continue;
    const m = new Map();
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      if (!g || typeof g !== 'object') continue;
      const w = Math.trunc(num(g.w));
      if (!(w > 0)) continue;
      if (!m.has(w)) m.set(w, g);
      if (w < firstWeek) firstWeek = w;
      if (w > lastWeek) lastWeek = w;
    }
    games.set(team, m);
  }
  if (!Number.isFinite(firstWeek)) firstWeek = 1;
  if (lastWeek <= 0) lastWeek = Math.max(1, Math.trunc(num(meta.regSeasonWeeks)) || 18);

  const regWeeks = Math.trunc(num(meta.regSeasonWeeks));
  if (regWeeks > lastWeek) lastWeek = regWeeks;

  const weeks = [];
  for (let w = firstWeek; w <= lastWeek; w++) weeks.push(w);

  const view = {
    isView: true,
    pack,
    players,
    byId,
    byPos,
    byTeam,
    schedule,
    teams,
    meta,
    weeks,
    firstWeek,
    lastWeek,
    logKeys: Array.isArray(pack.logKeys) ? pack.logKeys : [],
    dstKeys: Array.isArray(pack.dstKeys) ? pack.dstKeys : [],
    dvp: (pack.dvp && typeof pack.dvp === 'object') ? pack.dvp : EMPTY_OBJ,
    teamFactors: (pack.teamFactors && typeof pack.teamFactors === 'object') ? pack.teamFactors : EMPTY_OBJ,
    teamBase: (pack.teamBase && typeof pack.teamBase === 'object') ? pack.teamBase : EMPTY_OBJ,
    coef: (pack.coef && typeof pack.coef === 'object') ? pack.coef : EMPTY_OBJ,
    _games: games,

    /** The game a team plays in `week`, or null when it is their bye. */
    gameFor(team, week) {
      const m = games.get(team);
      if (!m) return null;
      const g = m.get(Math.trunc(num(week)));
      return g === undefined ? null : g;
    },

    /** Bye week for a team, 0 when unknown. */
    byeOf(team) {
      const t = teams[team];
      return t && typeof t === 'object' ? Math.trunc(num(t.bye)) : 0;
    },

    /** teamFactors[team][week], or null. */
    factorsFor(team, week) {
      const t = view.teamFactors[team];
      if (!t || typeof t !== 'object') return null;
      const f = t[weekKey(Math.trunc(num(week)))];
      return (f && typeof f === 'object') ? f : null;
    },
  };

  _views.set(pack, view);
  return view;
}

function emptyView() {
  const weeks = [];
  for (let w = 1; w <= 18; w++) weeks.push(w);
  return {
    isView: true,
    pack: null,
    players: [],
    byId: new Map(),
    byPos: new Map(),
    byTeam: new Map(),
    schedule: EMPTY_OBJ,
    teams: EMPTY_OBJ,
    meta: EMPTY_OBJ,
    weeks,
    firstWeek: 1,
    lastWeek: 18,
    logKeys: [],
    dstKeys: [],
    dvp: EMPTY_OBJ,
    teamFactors: EMPTY_OBJ,
    teamBase: EMPTY_OBJ,
    coef: EMPTY_OBJ,
    _games: new Map(),
    gameFor() { return null; },
    byeOf() { return 0; },
    factorsFor() { return null; },
  };
}

/* --------------------------------------------------------------- the mu "plan" */

/**
 * Per-player composition plan: the component keys, their base means, and the channel each
 * rides, precomputed once. Cached on the player object's `mu` identity, so a pack rebuild or
 * a swapped-in `mu` invalidates it. Nothing on the player is written.
 */
const _plans = new WeakMap();

function planFor(player) {
  const mu = player.mu;
  if (!mu || typeof mu !== 'object') return null;
  const hit = _plans.get(player);
  if (hit !== undefined && hit.ref === mu) return hit.plan;

  const keys = Object.keys(mu);
  const n = keys.length;
  const vals = new Float64Array(n);
  const chan = new Uint8Array(n);
  // Components outside the canonical offensive vocabulary. None exist in the shipped pack,
  // but a future one must not silently corrupt the shared scratch line's shape.
  const extra = [];

  for (let i = 0; i < n; i++) {
    const k = keys[i];
    vals[i] = num(mu[k]);
    const c = CHANNEL_CODE[COMPONENT_CHANNEL[k]];
    chan[i] = c === undefined ? CH_NONE : c;
    if (OFFENSE_KEYS.indexOf(k) < 0) extra.push(k);
  }
  const passOpp = num(mu.patt) + num(mu.tgt);
  const rushOpp = num(mu.ratt);
  const denom = passOpp + rushOpp;
  const passWeight = denom > 0 ? passOpp / denom : 0.5;

  const plan = { keys, vals, chan, passWeight, n, extra };
  _plans.set(player, { ref: mu, plan });
  return plan;
}

/* ------------------------------------------------------------------- weeklyMu */

/**
 * Component means for one player in one specific week.
 *
 * Offense composes the season-long per-game means against the team's week factors and the
 * opponent's defense-vs-position multiplier. Kickers and D/ST read their per-week line
 * straight out of the pack (`kWeeks` / `dstWeeks`), which already carries the roof and the
 * opponent.
 *
 * @param {Object} player
 * @param {number} week
 * @param {Object} pack raw pack or a `loadPack()` view
 * @returns {Object|null} a FRESH component object, or null when the player has no game that
 *   week (bye, unknown team, week outside the schedule, or missing per-week data).
 */
export function weeklyMu(player, week, pack) {
  if (player === null || typeof player !== 'object') return null;
  const view = loadPack(pack);
  const w = Math.trunc(num(week));
  if (!(w > 0)) return null;

  const pos = canonPos(player.pos);
  const team = typeof player.team === 'string' ? player.team : '';

  // A team with no scheduled game in `w` is on bye. This is also how an unrostered player
  // (team "FA") and an out-of-range week come back null, which is the honest answer for both.
  const game = view.gameFor(team, w);
  if (game === null) return null;

  if (pos === 'K') {
    const src = player.kWeeks;
    if (!src || typeof src !== 'object') return null;
    const line = src[weekKey(w)];
    if (!line || typeof line !== 'object') return null;
    return copyLine(line);
  }

  if (pos === 'DST') {
    const src = player.dstWeeks;
    if (!src || typeof src !== 'object') return null;
    const line = src[weekKey(w)];
    if (!line || typeof line !== 'object') return null;
    return copyLine(line);
  }

  const plan = planFor(player);
  if (plan === null) return null;

  const out = blankOffense();
  writeComposed(plan, view.teamFactors[team], view.dvp, game, w, pos, out);
  return out;
}

function copyLine(line) {
  const out = {};
  for (const k of Object.keys(line)) out[k] = num(line[k]);
  return out;
}

/**
 * The composition itself. Writes into `out`; allocates nothing.
 * `tf` is `teamFactors[team]` (the whole team's map), hoisted out of the caller's week loop.
 */
function writeComposed(plan, tf, dvp, game, w, pos, out) {
  const f = (tf && typeof tf === 'object') ? tf[weekKey(w)] : null;
  const has = f !== null && f !== undefined && typeof f === 'object';
  const fp = has ? num2(f.pass, 1) : 1;
  const fr = has ? num2(f.rush, 1) : 1;
  const ft = has ? num2(f.td, 1) : 1;
  const fv = plan.passWeight * fp + (1 - plan.passWeight) * fr;

  const dvpTeam = dvp[game.opp];
  const d = (dvpTeam && typeof dvpTeam === 'object') ? num2(dvpTeam[pos], 1) : 1;

  const { keys, vals, chan, n } = plan;
  for (let i = 0; i < n; i++) {
    const c = chan[i];
    const ch = c === CH_PASS ? fp : c === CH_RUSH ? fr : c === CH_TD ? ft : c === CH_VOL ? fv : 1;
    out[keys[i]] = vals[i] * ch * d;
  }
  return out;
}

/** Finite number or a fallback. Used for multipliers, where 0 and NaN are both wrong. */
function num2(v, fallback) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* --------------------------------------------------- weekly points + variance */

/**
 * Points and variance for one composed line, GIVEN the player is on the field.
 * Returns {mean, varc} in points.
 */
function lineMoments(line, cfg, pos, cv) {
  if (pos === 'DST') return dstMoments(line, cfg);
  if (pos === 'K') return kickerMoments(line, cfg);

  const mean = scoreLine(line, cfg, pos);

  // Split the score into counting events (own Poisson variance) and volume (cv-scaled).
  const pass = cfg.pass || EMPTY_OBJ;
  const rush = cfg.rush || EMPTY_OBJ;
  const rec = cfg.rec || EMPTY_OBJ;
  const misc = cfg.misc || EMPTY_OBJ;

  let eventPts = 0;
  let eventVar = 0;

  eventVar += accEvent(line.ptd, num(pass.td));
  eventPts += num(line.ptd) * num(pass.td);
  eventVar += accEvent(line.pint, num(pass.int));
  eventPts += num(line.pint) * num(pass.int);
  eventVar += accEvent(line.p2p, num(pass.twoPt));
  eventPts += num(line.p2p) * num(pass.twoPt);
  eventVar += accEvent(line.p40, num(pass.b40));
  eventPts += num(line.p40) * num(pass.b40);

  eventVar += accEvent(line.rtd, num(rush.td));
  eventPts += num(line.rtd) * num(rush.td);
  eventVar += accEvent(line.r2p, num(rush.twoPt));
  eventPts += num(line.r2p) * num(rush.twoPt);
  eventVar += accEvent(line.r40, num(rush.b40));
  eventPts += num(line.r40) * num(rush.b40);

  eventVar += accEvent(line.retd, num(rec.td));
  eventPts += num(line.retd) * num(rec.td);
  eventVar += accEvent(line.re2p, num(rec.twoPt));
  eventPts += num(line.re2p) * num(rec.twoPt);
  eventVar += accEvent(line.re40, num(rec.b40));
  eventPts += num(line.re40) * num(rec.b40);

  eventVar += accEvent(line.fuml, num(misc.fumLost));
  eventPts += num(line.fuml) * num(misc.fumLost);
  eventVar += accEvent(line.sttd, num(misc.stTd));
  eventPts += num(line.sttd) * num(misc.stTd);

  const volPts = mean - eventPts;
  const volSd = cv * volPts;
  return { mean, varc: volSd * volSd + eventVar };
}

/** Poisson variance contribution of a counting event: (points per event)^2 * lambda. */
function accEvent(lambda, w) {
  const l = num(lambda);
  if (l <= 0 || w === 0) return 0;
  return w * w * l;
}

function kickerMoments(line, cfg) {
  const k = cfg.k || EMPTY_OBJ;
  const fg = k.fg || EMPTY_OBJ;
  const miss = num(k.miss);
  let mean = 0;
  let varc = 0;
  for (let i = 0; i < FG_BUCKETS.length; i++) {
    const b = FG_BUCKETS[i];
    const made = num(line['fgm_' + b]);
    const wMade = num(fg[b]);
    mean += made * wMade;
    varc += accEvent(made, wMade);
    const missed = num(line['fgx_' + b]);
    mean += missed * miss;
    varc += accEvent(missed, miss);
  }
  mean += num(line.xpm) * num(k.xp);
  varc += accEvent(line.xpm, num(k.xp));
  mean += num(line.xpx) * num(k.xpMiss);
  varc += accEvent(line.xpx, num(k.xpMiss));
  return { mean: round6(mean), varc };
}

/**
 * Mean and variance of one D/ST week.
 *
 * The counting stats are Poisson. The two tier stacks are step functions of a continuous
 * quantity, so they are INTEGRATED against a normal centred on the projected points/yards
 * allowed with the pack's `dstSd`. Evaluating a step function at its argument's mean is
 * simply the wrong number, and in this league the two stacks swing 8-10 points.
 */
function dstMoments(line, cfg, sdIn, rho) {
  const d = cfg.dst || EMPTY_OBJ;
  let mean = 0;
  let varc = 0;
  for (let i = 0; i < DST_EVENTS.length; i++) {
    const lam = num(line[DST_EVENTS[i][0]]);
    const w = num(d[DST_EVENTS[i][1]]);
    mean += lam * w;
    varc += accEvent(lam, w);
  }

  const sd = sdIn && typeof sdIn === 'object' ? sdIn : EMPTY_OBJ;
  const paSd = num2(sd.ptsAllowed, 0);
  const yaSd = num2(sd.ydsAllowed, 0);

  const pa = tierMoments(d.paTiers, num(line.ptsAllowed), paSd);
  const ya = tierMoments(d.yaTiers, num(line.ydsAllowed), yaSd);
  mean += pa.mean + ya.mean;

  // The two stacks measure the same defensive performance, so they are strongly correlated.
  // rho is INFERRED (see header); independence would understate the swing badly.
  const r = num2(rho, DST_TIER_RHO);
  varc += pa.varc + ya.varc + 2 * r * Math.sqrt(Math.max(0, pa.varc) * Math.max(0, ya.varc));

  return { mean: round6(mean), varc };
}

/**
 * E[f(X)] and Var[f(X)] for the tier step function f, with X ~ N(mu, sd).
 * Bucket semantics match scoring.js exactly: the first tier whose `max` is >= the value,
 * with the last tier catching anything above every edge.
 */
function tierMoments(tiers, mu, sd) {
  if (!Array.isArray(tiers) || tiers.length === 0) return { mean: 0, varc: 0 };
  if (!(sd > 0)) {
    // Degenerate: no spread, so the tier at the mean is the whole distribution.
    let pts = 0;
    for (let i = 0; i < tiers.length; i++) {
      const t = tiers[i];
      if (!t || typeof t !== 'object') continue;
      const max = Number(t.max);
      if (Number.isNaN(max)) continue;
      pts = num(t.pts);
      if (mu <= max) return { mean: pts, varc: 0 };
    }
    return { mean: pts, varc: 0 };
  }

  let m1 = 0;
  let m2 = 0;
  let cdfPrev = 0;
  let lastPts = 0;
  let any = false;

  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (!t || typeof t !== 'object') continue;
    const max = Number(t.max);
    if (Number.isNaN(max)) continue;
    const cdf = normCdf((max - mu) / sd);
    let p = cdf - cdfPrev;
    if (p < 0) p = 0;              // out-of-order edges contribute nothing
    if (cdf > cdfPrev) cdfPrev = cdf;
    const pts = num(t.pts);
    m1 += p * pts;
    m2 += p * pts * pts;
    lastPts = pts;
    any = true;
  }
  if (!any) return { mean: 0, varc: 0 };

  // scoring.js falls back to the last tier for anything above every edge.
  const tail = 1 - cdfPrev;
  if (tail > 0) {
    m1 += tail * lastPts;
    m2 += tail * lastPts * lastPts;
  }

  const varc = m2 - m1 * m1;
  return { mean: m1, varc: varc > 0 ? varc : 0 };
}

/* ------------------------------------------------------------ options plumbing */

function normalizeOpts(opts) {
  const o = (opts !== null && typeof opts === 'object') ? opts : EMPTY_OBJ;
  const cfg = (o.cfg !== null && typeof o.cfg === 'object') ? o.cfg : DEFAULT_SCORING;
  const view = loadPack(o.pack);
  return { o, cfg, view };
}

/**
 * Resolve a week range. Accepts an array of week numbers, a single number, {from,to},
 * or nothing (the whole regular season). Always returns a fresh ascending array of unique
 * positive integers.
 */
function resolveWeeks(spec, view) {
  if (Array.isArray(spec)) {
    const seen = new Set();
    const out = [];
    for (let i = 0; i < spec.length; i++) {
      const w = Math.trunc(num(spec[i]));
      if (w > 0 && !seen.has(w)) { seen.add(w); out.push(w); }
    }
    out.sort((a, b) => a - b);
    return out;
  }
  if (typeof spec === 'number' && Number.isFinite(spec)) {
    const w = Math.trunc(spec);
    return w > 0 ? [w] : [];
  }
  if (spec !== null && typeof spec === 'object') {
    const from = Math.max(1, Math.trunc(num2(spec.from, view.firstWeek)));
    const to = Math.trunc(num2(spec.to, view.lastWeek));
    const out = [];
    for (let w = from; w <= to; w++) out.push(w);
    return out;
  }
  return view.weeks.slice();
}

/** P(the player is on the field). `avail` is the pack's per-week play probability. */
function playProbOf(player, o) {
  if (o.playProb !== undefined) return clamp01(num2(o.playProb, 1));
  let a = clamp01(num2(player.avail, 1));
  // `act` is P(he has a role at all) and is already folded into the team-volume
  // reconciliation, so it is OFF by default. Opt in for a deep-bench discount.
  if (o.useAct === true) a *= clamp01(num2(player.act, 1));
  return a;
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function meanUncertaintyOf(pos, o) {
  if (o.meanUncertainty !== undefined) {
    const u = num2(o.meanUncertainty, 0);
    return u > 0 ? u : 0;
  }
  return (pos === 'K' || pos === 'DST') ? MEAN_UNCERTAINTY_SPECIAL : MEAN_UNCERTAINTY_OFFENSE;
}

/* ---------------------------------------------------------------- projectFast */

/**
 * Closed-form projection. This is the list-rendering path: it must stay fast enough that the
 * whole board re-derives while the user drags a scoring slider (1000 players well under 50ms).
 *
 * @param {Object} player
 * @param {{weeks?, cfg?, pack?, playProb?, useAct?, meanUncertainty?, perWeek?, dstTierRho?}} opts
 * @returns {{mean, sd, p10, p50, p90, games, byes, weeks, perWeek, method, pos, id, name,
 *            team, dist, inferred, note}}
 */
export function projectFast(player, opts) {
  const { o, cfg, view } = normalizeOpts(opts);
  return closedForm(player, o, cfg, view, resolveWeeks(o.weeks, view));
}

function closedForm(player, o, cfg, view, weeks) {
  const pos = canonPos(player && player.pos);
  const wantPerWeek = o.perWeek !== false;
  const perWeek = wantPerWeek ? [] : null;

  const res = {
    id: player && player.id !== undefined ? player.id : null,
    name: player && typeof player.name === 'string' ? player.name : null,
    pos,
    team: player && typeof player.team === 'string' ? player.team : null,
    mean: 0, sd: 0, p10: 0, p50: 0, p90: 0,
    games: 0,
    byes: [],
    weeks,
    perWeek,
    method: 'closed-form',
    dist: null,
    inferred: [],
    note: '',
  };

  if (player === null || typeof player !== 'object') {
    res.note = 'No player supplied.';
    return res;
  }

  const cv = Math.max(0, num2(player.cv, 0.42));
  const a = playProbOf(player, o);
  const rho = num2(o.dstTierRho, DST_TIER_RHO);

  const isK = pos === 'K';
  const isDst = pos === 'DST';
  const plan = (isK || isDst) ? null : planFor(player);

  if (!isK && !isDst && plan === null) {
    res.note = `${res.name || 'This player'} has no component means in the pack, so there is `
      + 'nothing to project. Enter a manual projection rather than trusting a zero.';
    return res;
  }
  if (isK && (!player.kWeeks || typeof player.kWeeks !== 'object')) {
    res.note = 'No per-week kicking line in the pack for this kicker.';
    return res;
  }
  if (isDst && (!player.dstWeeks || typeof player.dstWeeks !== 'object')) {
    res.note = 'No per-week defensive line in the pack for this D/ST.';
    return res;
  }

  const team = typeof player.team === 'string' ? player.team : '';
  const teamGames = view._games.get(team);
  if (!teamGames) {
    res.note = `No 2026 schedule for team "${team || '?'}", so no week can be projected. `
      + 'Assign the player to a team or enter a manual projection.';
    if (wantPerWeek) for (let i = 0; i < weeks.length; i++) perWeek.push(byeRow(weeks[i]));
    res.byes = weeks.slice();
    return res;
  }

  let scratch = null;
  if (plan !== null) {
    // Reset the shared line so nothing survives from the previous player, then let
    // writeComposed overwrite only the keys this player actually has.
    scratch = plan.extra.length === 0 ? _scratch : blankOffense();
    for (let i = 0; i < OFFENSE_KEYS.length; i++) scratch[OFFENSE_KEYS[i]] = 0;
    for (let i = 0; i < plan.extra.length; i++) scratch[plan.extra[i]] = 0;
  }
  const dstSd = isDst ? player.dstSd : null;
  const tf = view.teamFactors[team];
  const dvp = view.dvp;
  const kWeeks = isK ? player.kWeeks : null;
  const dstWeeks = isDst ? player.dstWeeks : null;
  const tri = wantPerWeek ? [0, 0, 0] : null;
  const probRounded = round4(a);

  let total = 0;
  let varTot = 0;
  let games = 0;
  let lastMean = 0;
  let lastVar = 0;

  for (let i = 0; i < weeks.length; i++) {
    const w = weeks[i];
    const game = teamGames.get(w);
    if (game === undefined) {
      res.byes.push(w);
      if (wantPerWeek) perWeek.push(byeRow(w));
      continue;
    }

    let line;
    if (isK) {
      line = kWeeks[weekKey(w)];
    } else if (isDst) {
      line = dstWeeks[weekKey(w)];
    } else {
      writeComposed(plan, tf, dvp, game, w, pos, scratch);
      line = scratch;
    }
    if (!line || typeof line !== 'object') {
      // Team has a game but the player has no line for it. Not a bye — say so.
      res.byes.push(w);
      if (wantPerWeek) perWeek.push(byeRow(w, game, 'no line in pack for this week'));
      continue;
    }

    const mo = isDst ? dstMoments(line, cfg, dstSd, rho) : lineMoments(line, cfg, pos, cv);
    const m = mo.mean;
    const v = mo.varc;

    // Availability mixture for the week: plays with probability a, else scores 0.
    const wMean = a * m;
    const wVar = a * v + a * (1 - a) * m * m;

    total += wMean;
    varTot += wVar;
    games++;
    lastMean = m;
    lastVar = v;

    if (wantPerWeek) {
      mixTriInto(tri, a, m, v > 0 ? Math.sqrt(v) : 0);
      perWeek.push({
        week: w,
        opp: typeof game.opp === 'string' ? game.opp : null,
        home: game.home === true,
        roof: typeof game.roof === 'string' ? game.roof : null,
        implied: num2(game.implied, null),
        src: typeof game.src === 'string' ? game.src : null,
        bye: false,
        playProb: probRounded,
        mean: round6(wMean),
        sd: round6(wVar > 0 ? Math.sqrt(wVar) : 0),
        p10: round6(tri[0]),
        p50: round6(tri[1]),
        p90: round6(tri[2]),
        muPoints: round6(m),
      });
    }
  }

  res.games = games;

  if (games === 0) {
    res.note = res.note || 'Every requested week is a bye or has no data for this player.';
    res.dist = { kind: 'point', mean: 0, sd: 0 };
    return res;
  }

  const inferred = [];
  const u = meanUncertaintyOf(pos, o);
  if (games > 1 && u > 0) {
    // The season-long mean is itself uncertain (role change, trade, scheme). Week-to-week
    // independence alone gives an absurdly tight season band. INFERRED, and labeled.
    varTot += (u * total) * (u * total);
    inferred.push(`meanUncertainty=${u} applied to a ${games}-game total (season-long role risk, inferred)`);
  }
  if (games > 1) inferred.push('weeks treated as independent (no game-script correlation across weeks)');
  if (isDst) inferred.push(`dstTierRho=${rho} between the points-allowed and yards-allowed stacks (inferred)`);
  if (a < 1) inferred.push(`availability ${round4(a)} from the pack's injury prior`);
  res.inferred = inferred;

  const sd = Math.sqrt(Math.max(0, varTot));
  res.mean = round6(total);
  res.sd = round6(sd);

  if (games === 1) {
    // One game keeps its point mass at zero: an injury-prone player's weekly floor IS zero.
    const s = lastVar > 0 ? Math.sqrt(lastVar) : 0;
    const tri3 = mixTriInto([0, 0, 0], a, lastMean, s);
    res.dist = { kind: 'mixture', a, m: lastMean, s, mean: total, sd };
    res.p10 = round6(tri3[0]);
    res.p50 = round6(tri3[1]);
    res.p90 = round6(tri3[2]);
  } else {
    res.dist = { kind: 'lognormal', mean: total, sd };
    res.p10 = round6(matchedZ(total, sd, Z10));
    res.p50 = round6(matchedZ(total, sd, Z50));
    res.p90 = round6(matchedZ(total, sd, Z90));
  }
  return res;
}


function byeRow(w, game, why) {
  return {
    week: w,
    opp: game && typeof game.opp === 'string' ? game.opp : null,
    home: game ? game.home === true : null,
    roof: game && typeof game.roof === 'string' ? game.roof : null,
    implied: game ? num2(game.implied, null) : null,
    src: game && typeof game.src === 'string' ? game.src : null,
    bye: true,
    playProb: 0,
    mean: 0, sd: 0, p10: 0, p50: 0, p90: 0, muPoints: 0,
    note: why || 'bye',
  };
}

/** Quantile of the availability mixture: zero with probability 1-a, else the play branch. */
function mixQuantile(p, a, m, s) {
  if (a >= 1) return matchedQuantile(m, s, p);
  if (a <= 0) return 0;
  const off = 1 - a;
  if (p <= off) return 0;
  return matchedQuantile(m, s, (p - off) / a);
}

const TRI_P = [0.1, 0.5, 0.9];
const TRI_Z = [Z10, Z50, Z90];

/**
 * p10/p50/p90 of the availability mixture, written into `out`.
 * Shares the matched-lognormal parameters across the three, which the per-week hot loop
 * needs: three independent `matchedQuantile` calls would redo log/log1p/sqrt every time.
 */
function mixTriInto(out, a, m, s) {
  if (a <= 0) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
  const off = a >= 1 ? 0 : 1 - a;
  const lognormal = s > 0 && m > 0;
  let sigma = 0;
  let mu = 0;
  if (lognormal) {
    const cv = s / m;
    const sigma2 = Math.log1p(cv * cv);
    sigma = Math.sqrt(sigma2);
    mu = Math.log(m) - 0.5 * sigma2;
  }
  for (let i = 0; i < 3; i++) {
    const p = TRI_P[i];
    if (p <= off) { out[i] = 0; continue; }
    const z = off === 0 ? TRI_Z[i] : invNorm((p - off) / a);
    if (!(s > 0)) { out[i] = m; continue; }
    if (!lognormal) { out[i] = m + s * z; continue; }
    const v = Math.exp(mu + sigma * z);
    out[i] = Number.isFinite(v) ? v : m + s * z;
  }
  return out;
}

/* -------------------------------------------------------------------- project */

// Injected simulation engine. See "The sim engine" in the header: this module never imports
// sim.js, so it cannot break when that file is missing or mid-rewrite.
let _sim = null;

/** Wire in a simulation engine for `project()`. Pass null to unwire. Returns the engine. */
export function useSim(engine) {
  _sim = (engine !== null && typeof engine === 'object') || typeof engine === 'function' ? engine : null;
  return _sim;
}

/** The currently wired simulation engine, or null. */
export function simEngine() {
  return _sim;
}

function resolveEngine(o) {
  const e = o.sim !== undefined ? o.sim : _sim;
  if (e === null || e === undefined || e === false) return null;
  if (typeof e === 'function') return e;
  if (typeof e !== 'object') return null;
  if (typeof e.simSeason === 'function') return e.simSeason.bind(e);
  if (typeof e.simulate === 'function') return e.simulate.bind(e);
  return null;
}

/**
 * The exact projection.
 *
 * Delegates to a wired-in Monte Carlo engine when one is available and its answer validates;
 * otherwise it is exactly `projectFast`. Either way the return shape is identical, so callers
 * never branch on which path ran — read `result.method` if they care.
 *
 * @param {Object} player
 * @param {{weeks?, cfg?, pack?, sim?, iters?, seed?, ...projectFast opts}} opts
 * @returns {Object} same shape as projectFast
 */
export function project(player, opts) {
  const { o, cfg, view } = normalizeOpts(opts);
  const weeks = resolveWeeks(o.weeks, view);
  const base = closedForm(player, o, cfg, view, weeks);

  const run = resolveEngine(o);
  if (run === null || base.games === 0) return base;

  let raw;
  try {
    raw = run({
      player,
      weeks,
      cfg,
      pack: view.pack,
      view,
      weeklyMu: (pl, w) => weeklyMu(pl, w, view),
      iters: Math.max(1, Math.trunc(num2(o.iters, 4000))),
      seed: o.seed !== undefined ? o.seed : 1,
      quantiles: [0.1, 0.5, 0.9],
    });
  } catch (err) {
    base.note = appendNote(base.note, `Simulation engine threw (${describeErr(err)}); `
      + 'the closed-form projection is shown instead.');
    return base;
  }

  const merged = adoptSim(raw, base);
  if (merged === null) {
    base.note = appendNote(base.note, 'Simulation engine returned an unusable result; '
      + 'the closed-form projection is shown instead.');
    return base;
  }
  return merged;
}

function describeErr(err) {
  if (err === null || err === undefined) return 'unknown error';
  const m = err && err.message;
  return typeof m === 'string' && m ? m : String(err);
}

function appendNote(note, add) {
  return note ? `${note} ${add}` : add;
}

/**
 * Validate and adopt a simulation result. Accepts an array of season-total samples, or an
 * object carrying mean/sd (or the three quantiles). Anything that fails validation is
 * rejected outright — a projection that might be nonsense is worse than the closed form.
 */
function adoptSim(raw, base) {
  if (Array.isArray(raw)) {
    const stats = fromSamples(raw);
    if (stats === null) return null;
    return applyStats(base, stats, 'sim');
  }
  if (raw === null || typeof raw !== 'object') return null;

  if (Array.isArray(raw.samples)) {
    const stats = fromSamples(raw.samples);
    if (stats !== null) {
      const out = applyStats(base, stats, 'sim');
      if (Array.isArray(raw.perWeek) && base.perWeek) out.perWeek = raw.perWeek;
      return out;
    }
  }

  const mean = Number(raw.mean);
  const sd = Number(raw.sd);
  const p10 = Number(raw.p10);
  const p50 = Number(raw.p50);
  const p90 = Number(raw.p90);
  const haveQ = Number.isFinite(p10) && Number.isFinite(p50) && Number.isFinite(p90);
  if (!Number.isFinite(mean) && !haveQ) return null;

  const m = Number.isFinite(mean) ? mean : p50;
  let s = Number.isFinite(sd) ? sd : NaN;
  if (!Number.isFinite(s)) {
    // Recover a spread from the 10/90 band: p90 - p10 spans 2 * 1.2816 sigma.
    s = haveQ ? Math.max(0, (p90 - p10) / (2 * 1.2815515655446004)) : base.sd;
  }
  const stats = {
    mean: m,
    sd: Math.max(0, s),
    p10: haveQ ? p10 : matchedQuantile(m, Math.max(0, s), 0.1),
    p50: haveQ ? p50 : matchedQuantile(m, Math.max(0, s), 0.5),
    p90: haveQ ? p90 : matchedQuantile(m, Math.max(0, s), 0.9),
  };
  if (!Number.isFinite(stats.mean)) return null;
  const out = applyStats(base, stats, 'sim');
  if (Array.isArray(raw.perWeek) && base.perWeek) out.perWeek = raw.perWeek;
  return out;
}

function fromSamples(samples) {
  const vals = [];
  for (let i = 0; i < samples.length; i++) {
    const v = Number(samples[i]);
    if (Number.isFinite(v)) vals.push(v);
  }
  if (vals.length < 2) return null;
  vals.sort((a, b) => a - b);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) sum += vals[i];
  const mean = sum / vals.length;
  let ss = 0;
  for (let i = 0; i < vals.length; i++) { const d = vals[i] - mean; ss += d * d; }
  const sd = Math.sqrt(ss / (vals.length - 1));
  return { mean, sd, p10: pctl(vals, 0.1), p50: pctl(vals, 0.5), p90: pctl(vals, 0.9) };
}

/** Linear-interpolated percentile of a sorted array. */
function pctl(sorted, p) {
  const n = sorted.length;
  if (n === 0) return 0;
  const idx = (n - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function applyStats(base, stats, method) {
  const out = {};
  for (const k of Object.keys(base)) out[k] = base[k];
  out.mean = round6(stats.mean);
  out.sd = round6(Math.max(0, stats.sd));
  out.p10 = round6(stats.p10);
  out.p50 = round6(stats.p50);
  out.p90 = round6(stats.p90);
  out.method = method;
  out.dist = { kind: 'empirical', mean: out.mean, sd: out.sd, p10: out.p10, p50: out.p50, p90: out.p90 };
  out.closedForm = { mean: base.mean, sd: base.sd, p10: base.p10, p50: base.p50, p90: base.p90 };
  return out;
}

/**
 * Any quantile of a projection returned by `project` / `projectFast`.
 * Uses the same distribution the projection reported, so it is consistent with p10/p50/p90.
 */
export function quantileOf(projection, p) {
  if (projection === null || typeof projection !== 'object') return 0;
  const q = num(p);
  const d = projection.dist;
  if (!d || typeof d !== 'object') return round6(num(projection.mean));
  if (d.kind === 'mixture') return round6(mixQuantile(q, num(d.a), num(d.m), num(d.s)));
  if (d.kind === 'point') return round6(num(d.mean));
  if (d.kind === 'empirical') {
    // Only the three reported points are known; match a lognormal to mean/sd for the rest.
    if (q === 0.1) return round6(num(d.p10));
    if (q === 0.5) return round6(num(d.p50));
    if (q === 0.9) return round6(num(d.p90));
  }
  return round6(matchedQuantile(num(d.mean), num(d.sd), q));
}

/* ------------------------------------------------------ convenience projections */

/**
 * One week, as its own projection. Same shape as `project`, over a single week, so it keeps
 * the availability point mass at zero (a weekly floor of 0 is the honest floor).
 */
export function weeklyProjection(player, week, opts) {
  const o = (opts !== null && typeof opts === 'object') ? opts : EMPTY_OBJ;
  const merged = {};
  for (const k of Object.keys(o)) merged[k] = o[k];
  merged.weeks = [Math.trunc(num(week))];
  return project(player, merged);
}

/**
 * Rest-of-season projection: `fromWeek` through the end of the regular season.
 *
 * `fromWeek` defaults to the pack's current week (week 1 in a preseason pack). Weeks already
 * played are never included: this is what remains, which is the only thing a trade can change.
 */
export function restOfSeason(player, opts) {
  const o = (opts !== null && typeof opts === 'object') ? opts : EMPTY_OBJ;
  const view = loadPack(o.pack);
  const from = Math.max(1, Math.trunc(num2(o.fromWeek, defaultFromWeek(view))));
  const merged = {};
  for (const k of Object.keys(o)) merged[k] = o[k];
  merged.weeks = { from, to: view.lastWeek };
  const res = project(player, merged);
  res.fromWeek = from;
  return res;
}

/** The pack's "now": explicit `currentWeek`, else week 1 while the season has not started. */
function defaultFromWeek(view) {
  const meta = view.meta || EMPTY_OBJ;
  const cw = Math.trunc(num(meta.currentWeek));
  if (cw > 0) return cw;
  return view.firstWeek;
}

/** Full regular-season projection, week 1 through the last scheduled week. */
export function seasonTotal(player, opts) {
  const o = (opts !== null && typeof opts === 'object') ? opts : EMPTY_OBJ;
  const view = loadPack(o.pack);
  const merged = {};
  for (const k of Object.keys(o)) merged[k] = o[k];
  merged.weeks = { from: view.firstWeek, to: view.lastWeek };
  return project(player, merged);
}

/* ------------------------------------------------------------------- history */

const K_SCORING_COMPONENTS = ['fgm_0_19', 'fgm_20_29', 'fgm_30_39', 'fgm_40_49',
  'fgm_50_59', 'fgm_60', 'xpm'];
const DST_SCORING_COMPONENTS = ['sack', 'dint', 'fumrec', 'safety', 'dtd', 'blk', 'ptsAllowed'];

/**
 * Unpack a player's packed log rows into component objects.
 *
 * `log` rows are `[season, week, opp, ...values in pack.logKeys order]` (contract section 5).
 * Returns a fresh array of fresh objects; the pack is not touched.
 *
 * @returns {Array<{season:number, week:number, opp:string|null, line:Object}>}
 */
export function unpackLog(player, pack) {
  const view = loadPack(pack);
  const keys = view.logKeys;
  const rows = (player !== null && typeof player === 'object' && Array.isArray(player.log))
    ? player.log : EMPTY_ARR;
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!Array.isArray(r)) continue;
    const line = {};
    for (let k = 0; k < keys.length; k++) line[keys[k]] = num(r[k + 3]);
    out.push({
      season: Math.trunc(num(r[0])),
      week: Math.trunc(num(r[1])),
      opp: typeof r[2] === 'string' ? r[2] : null,
      line,
    });
  }
  return out;
}

/**
 * What this player ACTUALLY averaged under THIS scoring config — real history, not model
 * output. Contract section 10: the app must be able to show fact next to projection.
 *
 * Every game in `player.log` is scored with `scoreLine` under `cfg`, so flipping PPR from 1.0
 * to 0.5 rewrites his history the same way it rewrites his projection.
 *
 * Honesty: `pack.logKeys` is the offensive component vocabulary only. It carries no kicking
 * and no defensive components, so a kicker's or a D/ST's real scoring history CANNOT be
 * recovered from this pack. Those come back with `covered: false` and `ppg: null` rather than
 * a fabricated zero.
 *
 * @param {Object} player
 * @param {Object} cfg scoring config; defaults to the user's league
 * @param {Object} pack raw pack or view
 * @returns {{ppg:number|null, games:number, points:number, sd:number|null, best:number|null,
 *            worst:number|null, series:Array<{season,week,opp,pts}>,
 *            bySeason:Array<{season,games,points,ppg}>, seasons:Array<number>,
 *            covered:boolean, note:string}}
 */
export function historicalPPG(player, cfg, pack) {
  const view = loadPack(pack);
  const C = (cfg !== null && typeof cfg === 'object') ? cfg : DEFAULT_SCORING;
  const pos = canonPos(player && player.pos);

  const out = {
    id: player && player.id !== undefined ? player.id : null,
    name: player && typeof player.name === 'string' ? player.name : null,
    pos,
    ppg: null,
    games: 0,
    points: 0,
    sd: null,
    best: null,
    worst: null,
    series: [],
    bySeason: [],
    seasons: [],
    covered: false,
    note: '',
  };

  if (player === null || typeof player !== 'object') {
    out.note = 'No player supplied.';
    return out;
  }

  const keys = view.logKeys;
  if (!keys.length) {
    out.note = 'This pack ships no log key order, so packed history cannot be unpacked.';
    return out;
  }

  // Does the pack's log vocabulary cover what this position actually scores?
  const need = pos === 'K' ? K_SCORING_COMPONENTS : pos === 'DST' ? DST_SCORING_COMPONENTS : null;
  if (need !== null) {
    let covered = false;
    for (let i = 0; i < need.length; i++) if (keys.indexOf(need[i]) >= 0) { covered = true; break; }
    if (!covered) {
      out.note = `The pack's log rows carry only offensive components, so a ${pos}'s real `
        + 'scoring history is not recoverable from this data. Nothing is reported rather than '
        + 'a misleading zero.';
      return out;
    }
  }

  const rows = Array.isArray(player.log) ? player.log : EMPTY_ARR;
  if (rows.length === 0) {
    out.covered = true;
    out.note = `No logged games for ${out.name || 'this player'} in ${describeSeasons(view)}. `
      + 'A rookie or a player who did not appear has no history to average.';
    return out;
  }

  const line = {};
  for (let k = 0; k < keys.length; k++) line[keys[k]] = 0;

  const series = new Array(rows.length);
  const bySeason = new Map();
  let n = 0;
  let sum = 0;
  let sumsq = 0;
  let best = -Infinity;
  let worst = Infinity;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!Array.isArray(r)) continue;
    for (let k = 0; k < keys.length; k++) line[keys[k]] = num(r[k + 3]);
    const pts = scoreLine(line, C, pos);
    const season = Math.trunc(num(r[0]));
    const week = Math.trunc(num(r[1]));
    series[n] = { season, week, opp: typeof r[2] === 'string' ? r[2] : null, pts: round6(pts) };
    n++;
    sum += pts;
    sumsq += pts * pts;
    if (pts > best) best = pts;
    if (pts < worst) worst = pts;

    let s = bySeason.get(season);
    if (!s) { s = { season, games: 0, points: 0, ppg: 0 }; bySeason.set(season, s); }
    s.games++;
    s.points += pts;
  }
  series.length = n;

  if (n === 0) {
    out.covered = true;
    out.note = 'Log rows were present but none was readable.';
    return out;
  }

  const seasons = Array.from(bySeason.keys()).sort((a, b) => a - b);
  const bySeasonArr = seasons.map((s) => {
    const row = bySeason.get(s);
    row.points = round6(row.points);
    row.ppg = round6(row.points / row.games);
    return row;
  });

  out.covered = true;
  out.games = n;
  out.points = round6(sum);
  out.ppg = round6(sum / n);
  out.sd = n > 1 ? round6(Math.sqrt(Math.max(0, (sumsq - (sum * sum) / n) / (n - 1)))) : 0;
  out.best = round6(best);
  out.worst = round6(worst);
  out.series = series;
  out.bySeason = bySeasonArr;
  out.seasons = seasons;
  out.note = `${n} games actually played across ${seasons.join(', ')}, scored under `
    + `${C.name || C.id || 'this config'}. This is real production, not a projection.`;
  return out;
}

function describeSeasons(view) {
  const ls = view.meta && view.meta.logSeasons;
  return Array.isArray(ls) && ls.length ? ls.join('-') : 'the logged seasons';
}
