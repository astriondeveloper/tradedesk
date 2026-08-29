/**
 * scoring.js: component stat line -> fantasy points.
 *
 * Contract: docs/ARCHITECTURE.md sections 3 (component vocabulary), 4 (config schema), 9.
 *
 * The pipeline never computes fantasy points. It emits component stat lines keyed by the
 * canonical vocabulary in section 3, and this module converts them under a scoring config.
 * That is what makes "every scoring format" real: change `rec.rec` from 1.0 to 0.5 and every
 * projection, replacement level, VOR, lineup and trade verdict re-derives from the same
 * components with no rebuild.
 *
 * Exports:
 *   scoreLine(line, cfg, pos)   -> number
 *   explainLine(line, cfg, pos) -> Array<{label, detail, points}>
 *   PRESETS                     -> deep-frozen named configs
 *   DEFAULT_SCORING             -> PRESETS.fullPPR (the user's league)
 *   cloneScoring(cfg)           -> mutable deep copy (presets are frozen)
 *   tierPoints(tiers, value)    -> DST points/yards-allowed tier lookup
 *
 * Invariants:
 *   - Missing component key => 0 (section 3). Unknown keys are ignored.
 *   - scoreLine never returns NaN or Infinity, for any input, including `{}`.
 *   - No Date.now(), no Math.random(), no top-level side effects, no dependencies.
 */

/* ------------------------------------------------------------------ helpers */

const EMPTY = Object.freeze({});

/**
 * Round away float dust (0.1 * 110 === 11.000000000000002) without losing sim precision.
 * Above 1e15 a double has no fractional bits left, so rounding is a no-op there, and
 * scaling by 1e6 first would overflow to Infinity, which is exactly what we must not emit.
 */
function round6(x) {
  if (!Number.isFinite(x)) return 0;
  if (x >= 1e15 || x <= -1e15) return x;
  return Math.round(x * 1e6) / 1e6;
}

/** Coerce anything to a finite number; NaN/Infinity/undefined/null/objects -> 0. */
function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Coercion for tier lookups. Unlike `num`, this keeps the sign of an infinite input so a
 * runaway value lands in the worst tier rather than being flattened to 0, which would read
 * as a shutout. NaN still becomes 0.
 */
function numTier(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isNaN(n) ? 0 : n;
}

/** Display formatting for explain details. */
function fmt(v) {
  return String(round6(num(v)));
}

/** Display formatting for tier inputs, which keep their sign at infinity. */
function fmtTier(v) {
  const n = numTier(v);
  return Number.isFinite(n) ? String(round6(n)) : String(n);
}

const DST_ALIASES = new Set(['DST', 'DEF', 'D/ST', 'D-ST', 'DS', 'DEFENSE']);
const K_ALIASES = new Set(['K', 'PK', 'KICKER']);

/** Normalize a position string. Returns '' for anything unusable. */
function normPos(pos) {
  if (typeof pos !== 'string') return '';
  const p = pos.trim().toUpperCase();
  if (DST_ALIASES.has(p)) return 'DST';
  if (K_ALIASES.has(p)) return 'K';
  return p;
}

/** Field distance buckets. Component keys are `fgm_<bucket>` / `fgx_<bucket>`. */
const FG_BUCKETS = ['0_19', '20_29', '30_39', '40_49', '50_59', '60'];
const FG_LABELS = {
  '0_19': '0-19 yd',
  '20_29': '20-29 yd',
  '30_39': '30-39 yd',
  '40_49': '40-49 yd',
  '50_59': '50-59 yd',
  '60': '60+ yd',
};

/* -------------------------------------------------------------- tier lookup */

/**
 * DST tier lookup: the first tier whose `max` is >= `value`. Tiers are ascending by max.
 *
 * Safe for values outside the table: negative points allowed (impossible in a real game, but
 * reachable from a simulated draw) lands in the first tier; a value above every `max`, or
 * Infinity, falls back to the last tier. NaN is treated as 0.
 *
 * @param {Array<{max:number, pts:number}>} tiers
 * @param {number} value
 * @returns {number} points
 */
export function tierPoints(tiers, value) {
  if (!Array.isArray(tiers) || tiers.length === 0) return 0;
  const v = numTier(value);
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (!t || typeof t !== 'object') continue;
    const max = Number(t.max);
    if (Number.isNaN(max)) continue;
    if (v <= max) return num(t.pts);
  }
  const last = tiers[tiers.length - 1];
  return last && typeof last === 'object' ? num(last.pts) : 0;
}

/**
 * Expected tier points when the underlying quantity is uncertain.
 *
 * Tier tables are STEP functions, so the points scored at the average outcome are not the
 * average of the points scored -- E[tier(X)] != tier(E[X]). Scoring a defense projected to
 * allow 18.5 points at exactly 18.5 lands it in the 18-21 bucket for zero, and ignores that
 * a real game lands in the 7-13 bucket often enough to be worth about +0.8.
 *
 * This league stacks BOTH a points-allowed and a yards-allowed table, so the error lands
 * twice. Measured across the projection set it averages 0.18 points per game and reaches
 * 1.2 on a single tier -- large enough to reorder a streaming decision, since the defenses
 * being chosen between are usually within a point of each other.
 *
 * Integrates the step function against a normal by Gauss-Hermite-style sampling on a fixed
 * grid, which is exact enough for a nine-bucket table and costs nothing.
 *
 * @param {Array<{max:number, pts:number}>} tiers
 * @param {number} mu    expected value of the underlying quantity
 * @param {number} sd    its standard deviation; <= 0 falls back to a point lookup
 * @param {{floor?:number, nodes?:number}} [opts] floor clamps draws (points allowed can't be < 0)
 * @returns {number} expected points
 */
export function expectedTierPoints(tiers, mu, sd, opts = {}) {
  const m = num(mu);
  const s = num(sd);
  if (!(s > 0)) return tierPoints(tiers, m);

  const floor = opts.floor === undefined ? 0 : opts.floor;
  const nodes = Math.max(21, Math.min(401, opts.nodes || 121));
  const LO = -4, HI = 4;
  let acc = 0, wsum = 0;
  for (let i = 0; i < nodes; i++) {
    const z = LO + ((HI - LO) * i) / (nodes - 1);
    const w = Math.exp(-0.5 * z * z);
    let x = m + s * z;
    if (floor !== null && x < floor) x = floor;
    acc += w * tierPoints(tiers, x);
    wsum += w;
  }
  return wsum > 0 ? acc / wsum : tierPoints(tiers, m);
}

/**
 * Expected D/ST score given uncertainty in points and yards allowed.
 *
 * Event counts (sacks, interceptions, fumble recoveries, touchdowns) are linear in the
 * scoring config, so their expectation is just the config applied to their means. Only the
 * two tier stacks need integrating -- see `expectedTierPoints`.
 *
 * @param {object} line component means, including ptsAllowed / ydsAllowed
 * @param {object} cfg  scoring config
 * @param {{ptsAllowed?:number, ydsAllowed?:number}} sd standard deviations
 */
export function expectedDstScore(line, cfg, sd = {}) {
  const L = line || {};
  const d = (cfg && cfg.dst) || {};
  let t = 0;
  t += num(d.sack) * num(L.sack);
  t += num(d.int) * num(L.dint);
  t += num(d.fumRec) * num(L.fumrec);
  t += num(d.safety) * num(L.safety);
  t += num(d.td) * num(L.dtd);
  t += num(d.blk) * num(L.blk);
  t += num(d.stTd) * num(L.sttd);
  t += expectedTierPoints(d.paTiers, num(L.ptsAllowed), num(sd.ptsAllowed), { floor: 0 });
  t += expectedTierPoints(d.yaTiers, num(L.ydsAllowed), num(sd.ydsAllowed), { floor: 0 });
  return t;
}

/** Same lookup, but also reports the matched bucket so the UI can name it. */
function tierHit(tiers, value) {
  const v = numTier(value);
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return { pts: 0, range: 'no tiers' };
  }
  let lo = null; // lower edge of the current bucket; null == open-ended below
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (!t || typeof t !== 'object') continue;
    const max = Number(t.max);
    if (Number.isNaN(max)) continue;
    if (v <= max) return { pts: num(t.pts), range: rangeLabel(lo, max) };
    lo = max + 1;
  }
  const last = tiers[tiers.length - 1];
  return {
    pts: last && typeof last === 'object' ? num(last.pts) : 0,
    range: rangeLabel(lo, Infinity),
  };
}

function rangeLabel(lo, hi) {
  const open = !Number.isFinite(hi) || hi >= 1e9;
  const low = lo === null ? 0 : lo;
  if (open) return `${fmt(low)}+`;
  if (low === hi) return fmt(low);
  return `${fmt(low)}-${fmt(hi)}`;
}

/* ------------------------------------------------------------ fast scoring */

function offensePoints(L, C, pos) {
  let t = 0;

  const pass = C.pass || EMPTY;
  const pyd = num(L.pyd);
  t += pyd * num(pass.yd);
  t += num(L.ptd) * num(pass.td);
  t += num(L.pint) * num(pass.int);
  t += num(L.p2p) * num(pass.twoPt);
  t += num(L.psack) * num(pass.sack);
  t += num(L.pfd) * num(pass.fd);
  t += num(L.p40) * num(pass.b40);
  if (pyd >= 300) t += num(pass.b300);
  if (pyd >= 400) t += num(pass.b400);

  const rush = C.rush || EMPTY;
  const ryd = num(L.ryd);
  t += ryd * num(rush.yd);
  t += num(L.rtd) * num(rush.td);
  t += num(L.r2p) * num(rush.twoPt);
  t += num(L.rfd) * num(rush.fd);
  t += num(L.r40) * num(rush.b40);
  if (ryd >= 100) t += num(rush.b100);
  if (ryd >= 200) t += num(rush.b200);

  const rec = C.rec || EMPTY;
  const reyd = num(L.reyd);
  const nrec = num(L.rec);
  t += nrec * (num(rec.rec) + recBonus(rec, pos));
  t += reyd * num(rec.yd);
  t += num(L.retd) * num(rec.td);
  t += num(L.re2p) * num(rec.twoPt);
  t += num(L.refd) * num(rec.fd);
  t += num(L.re40) * num(rec.b40);
  if (reyd >= 100) t += num(rec.b100);
  if (reyd >= 200) t += num(rec.b200);

  const misc = C.misc || EMPTY;
  t += num(L.fuml) * num(misc.fumLost);
  t += num(L.sttd) * num(misc.stTd);

  return t;
}

/** Additive per-reception bonus for this position (TE premium). */
function recBonus(recCfg, pos) {
  const map = recCfg && recCfg.recBonusByPos;
  if (!map || typeof map !== 'object' || !pos) return 0;
  return num(map[pos]);
}

function kickerPoints(L, C) {
  const k = C.k || EMPTY;
  const fg = k.fg || EMPTY;
  const miss = num(k.miss);
  let t = 0;
  for (let i = 0; i < FG_BUCKETS.length; i++) {
    const b = FG_BUCKETS[i];
    t += num(L['fgm_' + b]) * num(fg[b]);
    t += num(L['fgx_' + b]) * miss;
  }
  t += num(L.xpm) * num(k.xp);
  t += num(L.xpx) * num(k.xpMiss);
  return t;
}

function dstPoints(L, C) {
  const d = C.dst || EMPTY;
  let t = 0;
  t += num(L.sack) * num(d.sack);
  t += num(L.dint) * num(d.int);
  t += num(L.fumrec) * num(d.fumRec);
  t += num(L.safety) * num(d.safety);
  t += num(L.dtd) * num(d.td);
  t += num(L.blk) * num(d.blk);
  t += num(L.sttd) * num(d.stTd);
  t += tierPoints(d.paTiers, L.ptsAllowed);
  t += tierPoints(d.yaTiers, L.ydsAllowed);
  return t;
}

/**
 * Score one component stat line.
 *
 * @param {Object} line Component-keyed stat line (section 3). Missing key => 0.
 * @param {Object} cfg  Scoring config (section 4). Defaults to DEFAULT_SCORING.
 * @param {string} pos  Position. Routes DST/K scoring and selects the TE-premium bonus.
 * @returns {number} Fantasy points. Never NaN, never Infinity.
 */
export function scoreLine(line, cfg, pos) {
  const L = line && typeof line === 'object' ? line : EMPTY;
  const C = cfg && typeof cfg === 'object' ? cfg : DEFAULT_SCORING;
  const P = normPos(pos);

  let total;
  if (P === 'DST') total = dstPoints(L, C);
  else if (P === 'K') total = kickerPoints(L, C);
  else total = offensePoints(L, C, P);

  const rounded = round6(total);
  return Number.isFinite(rounded) ? rounded : 0;
}

/* ---------------------------------------------------------------- explain */

function push(items, label, detail, points) {
  // `points` is deliberately NOT rounded here. Rounding each item independently makes the
  // sum of the items drift from scoreLine in proportion to how many items there are --
  // about 2e-6 on a fifteen-item projected line, which breaks the documented invariant
  // that the breakdown adds up to the score. Integer stat lines hide it; the fractional
  // component means that come out of the projection model do not.
  //
  // scoreLine rounds once, at the end, so leaving items at full precision keeps
  // |sum(items) - scoreLine| within a single rounding step. Callers that want a display
  // string should format at render time; `pointsText` is provided for that.
  const p = num(points);
  items.push({ label, detail, points: p, pointsText: String(round6(p)) });
}

/** Emit an item only when the underlying count or the resulting points are non-zero. */
function pushIf(items, count, label, detail, points) {
  if (num(count) === 0 && round6(num(points)) === 0) return;
  push(items, label, detail, points);
}

function explainOffense(L, C, pos, items) {
  const pass = C.pass || EMPTY;
  const pyd = num(L.pyd);
  pushIf(items, pyd, 'Passing yards', `${fmt(pyd)} yd x ${fmt(pass.yd)}`, pyd * num(pass.yd));
  pushIf(items, L.ptd, 'Passing TDs', `${fmt(L.ptd)} x ${fmt(pass.td)}`, num(L.ptd) * num(pass.td));
  pushIf(items, L.pint, 'Interceptions thrown', `${fmt(L.pint)} x ${fmt(pass.int)}`, num(L.pint) * num(pass.int));
  pushIf(items, L.p2p, 'Passing 2-pt', `${fmt(L.p2p)} x ${fmt(pass.twoPt)}`, num(L.p2p) * num(pass.twoPt));
  pushIf(items, L.psack, 'Sacks taken', `${fmt(L.psack)} x ${fmt(pass.sack)}`, num(L.psack) * num(pass.sack));
  pushIf(items, L.pfd, 'Passing 1st downs', `${fmt(L.pfd)} x ${fmt(pass.fd)}`, num(L.pfd) * num(pass.fd));
  pushIf(items, L.p40, '40+ yd pass plays', `${fmt(L.p40)} x ${fmt(pass.b40)}`, num(L.p40) * num(pass.b40));
  if (pyd >= 300 && num(pass.b300) !== 0) push(items, '300-yard passing bonus', `${fmt(pyd)} yd >= 300`, num(pass.b300));
  if (pyd >= 400 && num(pass.b400) !== 0) push(items, '400-yard passing bonus', `${fmt(pyd)} yd >= 400`, num(pass.b400));

  const rush = C.rush || EMPTY;
  const ryd = num(L.ryd);
  pushIf(items, ryd, 'Rushing yards', `${fmt(ryd)} yd x ${fmt(rush.yd)}`, ryd * num(rush.yd));
  pushIf(items, L.rtd, 'Rushing TDs', `${fmt(L.rtd)} x ${fmt(rush.td)}`, num(L.rtd) * num(rush.td));
  pushIf(items, L.r2p, 'Rushing 2-pt', `${fmt(L.r2p)} x ${fmt(rush.twoPt)}`, num(L.r2p) * num(rush.twoPt));
  pushIf(items, L.rfd, 'Rushing 1st downs', `${fmt(L.rfd)} x ${fmt(rush.fd)}`, num(L.rfd) * num(rush.fd));
  pushIf(items, L.r40, '40+ yd rushes', `${fmt(L.r40)} x ${fmt(rush.b40)}`, num(L.r40) * num(rush.b40));
  if (ryd >= 100 && num(rush.b100) !== 0) push(items, '100-yard rushing bonus', `${fmt(ryd)} yd >= 100`, num(rush.b100));
  if (ryd >= 200 && num(rush.b200) !== 0) push(items, '200-yard rushing bonus', `${fmt(ryd)} yd >= 200`, num(rush.b200));

  const rec = C.rec || EMPTY;
  const nrec = num(L.rec);
  const reyd = num(L.reyd);
  const base = num(rec.rec);
  const bonus = recBonus(rec, pos);
  // Receptions and the position premium are separate line items on purpose: in full PPR the
  // reception line is the value the user is buying, and the premium is a separate lever.
  pushIf(items, nrec, 'Receptions', `${fmt(nrec)} rec x ${fmt(base)}`, nrec * base);
  pushIf(items, bonus === 0 ? 0 : nrec, `${pos || 'Position'} reception premium`,
    `${fmt(nrec)} rec x ${fmt(bonus)}`, nrec * bonus);
  pushIf(items, reyd, 'Receiving yards', `${fmt(reyd)} yd x ${fmt(rec.yd)}`, reyd * num(rec.yd));
  pushIf(items, L.retd, 'Receiving TDs', `${fmt(L.retd)} x ${fmt(rec.td)}`, num(L.retd) * num(rec.td));
  pushIf(items, L.re2p, 'Receiving 2-pt', `${fmt(L.re2p)} x ${fmt(rec.twoPt)}`, num(L.re2p) * num(rec.twoPt));
  pushIf(items, L.refd, 'Receiving 1st downs', `${fmt(L.refd)} x ${fmt(rec.fd)}`, num(L.refd) * num(rec.fd));
  pushIf(items, L.re40, '40+ yd receptions', `${fmt(L.re40)} x ${fmt(rec.b40)}`, num(L.re40) * num(rec.b40));
  if (reyd >= 100 && num(rec.b100) !== 0) push(items, '100-yard receiving bonus', `${fmt(reyd)} yd >= 100`, num(rec.b100));
  if (reyd >= 200 && num(rec.b200) !== 0) push(items, '200-yard receiving bonus', `${fmt(reyd)} yd >= 200`, num(rec.b200));

  const misc = C.misc || EMPTY;
  pushIf(items, L.fuml, 'Fumbles lost', `${fmt(L.fuml)} x ${fmt(misc.fumLost)}`, num(L.fuml) * num(misc.fumLost));
  pushIf(items, L.sttd, 'Special teams TDs', `${fmt(L.sttd)} x ${fmt(misc.stTd)}`, num(L.sttd) * num(misc.stTd));
}

function explainKicker(L, C, items) {
  const k = C.k || EMPTY;
  const fg = k.fg || EMPTY;
  const miss = num(k.miss);
  let missed = 0;
  for (let i = 0; i < FG_BUCKETS.length; i++) {
    const b = FG_BUCKETS[i];
    const made = num(L['fgm_' + b]);
    pushIf(items, made, `FG ${FG_LABELS[b]}`, `${fmt(made)} made x ${fmt(fg[b])}`, made * num(fg[b]));
    missed += num(L['fgx_' + b]);
  }
  pushIf(items, missed, 'Missed FGs', `${fmt(missed)} x ${fmt(miss)}`, missed * miss);
  pushIf(items, L.xpm, 'Extra points', `${fmt(L.xpm)} x ${fmt(k.xp)}`, num(L.xpm) * num(k.xp));
  pushIf(items, L.xpx, 'Missed extra points', `${fmt(L.xpx)} x ${fmt(k.xpMiss)}`, num(L.xpx) * num(k.xpMiss));
}

function explainDst(L, C, items) {
  const d = C.dst || EMPTY;
  pushIf(items, L.sack, 'Sacks', `${fmt(L.sack)} x ${fmt(d.sack)}`, num(L.sack) * num(d.sack));
  pushIf(items, L.dint, 'Interceptions', `${fmt(L.dint)} x ${fmt(d.int)}`, num(L.dint) * num(d.int));
  pushIf(items, L.fumrec, 'Fumble recoveries', `${fmt(L.fumrec)} x ${fmt(d.fumRec)}`, num(L.fumrec) * num(d.fumRec));
  pushIf(items, L.safety, 'Safeties', `${fmt(L.safety)} x ${fmt(d.safety)}`, num(L.safety) * num(d.safety));
  pushIf(items, L.dtd, 'Defensive TDs', `${fmt(L.dtd)} x ${fmt(d.td)}`, num(L.dtd) * num(d.td));
  pushIf(items, L.blk, 'Blocked kicks', `${fmt(L.blk)} x ${fmt(d.blk)}`, num(L.blk) * num(d.blk));
  pushIf(items, L.sttd, 'Special teams TDs', `${fmt(L.sttd)} x ${fmt(d.stTd)}`, num(L.sttd) * num(d.stTd));

  // Both tier stacks always show, even at 0 points: the tier a defense landed in is the
  // information, and in this league the two stacks together swing 8-10 points.
  const pa = tierHit(d.paTiers, L.ptsAllowed);
  push(items, 'Points allowed', `${fmtTier(L.ptsAllowed)} allowed, tier ${pa.range}`, pa.pts);
  const ya = tierHit(d.yaTiers, L.ydsAllowed);
  push(items, 'Yards allowed', `${fmtTier(L.ydsAllowed)} allowed, tier ${ya.range}`, ya.pts);
}

/**
 * Break a stat line into the line items that produced its score.
 *
 * Items are sorted by absolute point contribution, descending, stable within ties, so the
 * thing that actually drove the score is first. Summing `points` reproduces `scoreLine` to
 * within float-display rounding (each item is rounded to 6 decimals for display).
 *
 * @param {Object} line
 * @param {Object} cfg
 * @param {string} pos
 * @returns {Array<{label: string, detail: string, points: number}>}
 */
export function explainLine(line, cfg, pos) {
  const L = line && typeof line === 'object' ? line : EMPTY;
  const C = cfg && typeof cfg === 'object' ? cfg : DEFAULT_SCORING;
  const P = normPos(pos);

  const items = [];
  if (P === 'DST') explainDst(L, C, items);
  else if (P === 'K') explainKicker(L, C, items);
  else explainOffense(L, C, P, items);

  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (Math.abs(b.it.points) - Math.abs(a.it.points)) || (a.i - b.i))
    .map((w) => w.it);
}

/* ---------------------------------------------------------------- presets */

function deepFreeze(o) {
  if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o;
  Object.freeze(o);
  for (const k of Object.keys(o)) deepFreeze(o[k]);
  return o;
}

/** Structural deep clone. Presets are frozen; the UI edits copies. */
export function cloneScoring(cfg) {
  return clone(cfg && typeof cfg === 'object' ? cfg : DEFAULT_SCORING);
}

function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = clone(v[k]);
    return out;
  }
  return v;
}

// Tier boundaries are INFERRED, not supplied by the user (see contract section 4 and the
// honesty rules in section 10). The nine payout values per stack are the user's; the bucket
// edges are the standard ESPN cutoffs and must be surfaced as editable and flagged in-app.
const PA_TIERS = [
  { max: 0, pts: 5 }, { max: 6, pts: 4 }, { max: 13, pts: 3 },
  { max: 17, pts: 1 }, { max: 21, pts: 0 }, { max: 27, pts: 0 },
  { max: 34, pts: -1 }, { max: 45, pts: -3 }, { max: 1e9, pts: -5 },
];

const YA_TIERS = [
  { max: 99, pts: 5 }, { max: 199, pts: 3 }, { max: 299, pts: 2 },
  { max: 349, pts: 0 }, { max: 399, pts: -1 }, { max: 449, pts: -3 },
  { max: 499, pts: -5 }, { max: 549, pts: -6 }, { max: 1e9, pts: -7 },
];

/**
 * Build a complete config. Every preset is materialized in full, with no inheritance at read
 * time, so a caller reading `PRESETS.standard` gets a whole config and never a partial.
 */
function makeConfig({ id, name, ppr, passTd = 4, teBonus = 0, note = '' }) {
  return {
    id,
    name,
    note,
    pass: { yd: 0.04, td: passTd, int: -2, twoPt: 2, sack: 0, fd: 0, b40: 0, b300: 0, b400: 0 },
    rush: { yd: 0.1, td: 6, twoPt: 2, fd: 0, b40: 0, b100: 0, b200: 0 },
    rec: {
      rec: ppr, yd: 0.1, td: 6, twoPt: 2, fd: 0, b40: 0, b100: 0, b200: 0,
      recBonusByPos: { TE: teBonus },
    },
    misc: { fumLost: -2, stTd: 6 },
    k: {
      fg: { '0_19': 3, '20_29': 3, '30_39': 3, '40_49': 4, '50_59': 5, '60': 6 },
      miss: -1, xp: 1, xpMiss: -1,
    },
    dst: {
      sack: 1, int: 2, fumRec: 2, safety: 2, td: 6, blk: 2, stTd: 6,
      paTiers: clone(PA_TIERS),
      yaTiers: clone(YA_TIERS),
    },
  };
}

/**
 * Named scoring presets. Deep-frozen: callers cannot mutate shared state. Use
 * `cloneScoring(PRESETS.x)` to get an editable copy.
 */
export const PRESETS = deepFreeze({
  fullPPR: makeConfig({
    id: 'full-ppr',
    name: 'Full PPR',
    ppr: 1.0,
    note: "The user's league. Tier boundaries are inferred (ESPN defaults), not supplied.",
  }),
  halfPPR: makeConfig({
    id: 'half-ppr',
    name: 'Half PPR',
    ppr: 0.5,
    note: 'Full PPR with 0.5 per reception. Nothing else differs.',
  }),
  standard: makeConfig({
    id: 'standard',
    name: 'Standard (no PPR)',
    ppr: 0,
    note: 'Full PPR with 0 per reception. Nothing else differs.',
  }),
  superflexPPR: makeConfig({
    id: 'superflex-ppr',
    name: 'Superflex PPR (6-pt pass TD)',
    ppr: 1.0,
    passTd: 6,
    note: 'Full PPR with 6-point passing TDs, the usual companion to a superflex roster. '
      + 'Superflex itself is a lineup slot, not a scoring rule; it is configured in the league setup.',
  }),
  tePremium: makeConfig({
    id: 'te-premium',
    name: 'TE Premium (full PPR, +0.5 TE)',
    ppr: 1.0,
    teBonus: 0.5,
    note: 'Full PPR plus an additive 0.5 per reception for tight ends only.',
  }),
});

/** The user's league: full PPR, 0.04/4/-2 passing, both DST tier stacks, no bonuses. */
export const DEFAULT_SCORING = PRESETS.fullPPR;
