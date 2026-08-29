/**
 * lineup.js — the **exact** optimal starting lineup.
 *
 * Contract: ARCHITECTURE.md §6.
 *
 *   optimizeLineup(players, slots, ptsOf, options)
 *     -> { assignments: [{ slot, slotIndex, player|null, pts, slotDef }], total, benched, filled }
 *   slotsFromCounts(counts) -> slots
 *
 * ---------------------------------------------------------------------------
 * Why not greedy
 * ---------------------------------------------------------------------------
 * Filling dedicated slots first and then flexing the leftovers is optimal only when the
 * slot eligibility sets are *laminar* (nested or disjoint). Overlapping flex definitions
 * break it. The canonical counterexample, which lives in the test file:
 *
 *   slots   W/T (WR,TE) and R/W (RB,WR)
 *   players WR 20, TE 10, RB 9
 *
 *   greedy  W/T <- WR 20, R/W <- RB 9   = 29
 *   optimal W/T <- TE 10, R/W <- WR 20  = 30
 *
 * So the assignment is solved exactly, with the Hungarian algorithm (Jonker-Volgenant
 * shortest-augmenting-path form, O(n^2 m)) over a rectangular cost matrix of
 * slots x (players + one "leave it empty" column per slot). Maximization is done by
 * negating points. Rosters are tiny (<= 25 players, <= 14 slots), so exactness is free.
 *
 * ---------------------------------------------------------------------------
 * Negative players and empty slots  (the `allowNegative` option)
 * ---------------------------------------------------------------------------
 * In this league a bad D/ST or K genuinely scores below zero: both the points-allowed and
 * yards-allowed tier stacks bottom out negative, and a kicker can miss. So the solver has
 * to answer a question a pure max-weight matching does not: is starting a -3 D/ST better
 * than starting nobody?
 *
 * An unfilled slot contributes exactly 0. Taken literally, that means you should never
 * start a negative player — 0 > -3. That is the right model of the *scoreboard*, but not
 * of the *rules*: real platforms want a body in every startable slot, and a projection of
 * -3 is a mean, not an outcome — the player still carries upside the empty slot does not.
 *
 * Both readings are therefore implemented, and the choice is explicit:
 *
 *   allowNegative: true  (DEFAULT) — every slot that *can* be filled *is* filled. Formally:
 *       maximize the number of filled slots first, then maximize points among all
 *       maximum-cardinality lineups. A negative player is therefore started only when the
 *       alternative for that slot is leaving it empty; it can never displace a better
 *       option, and it never bumps a positive player out of the lineup.
 *
 *   allowNegative: false — a player projected below zero is never started. The slot is
 *       left empty and contributes 0. Non-negative players still fill every slot they can.
 *
 * Both modes are exact optima of their own objective, not heuristics.
 *
 * ---------------------------------------------------------------------------
 * Notes for callers
 * ---------------------------------------------------------------------------
 * - `ptsOf(player)` is called exactly once per distinct player, before the solve. A
 *   non-finite return is treated as 0.
 * - Players are deduped by `id` (first occurrence wins); players with no `id` are deduped
 *   by object identity. Dropped duplicates appear in neither `assignments` nor `benched`.
 * - `benched` preserves the input order of the deduped roster.
 * - The solver is deterministic: identical input always produces an identical result. Ties
 *   between equally-optimal lineups are broken by the algorithm, not by chance.
 * - Slot descriptors are treated as immutable. Eligibility sets are memoized per descriptor
 *   object; replacing `slot.eligible` with a new array is picked up, mutating the existing
 *   array in place is not.
 * - No Date/Math.random anywhere, no module-level side effects, no dependencies.
 */

// ---------------------------------------------------------------------------
// Position vocabulary
// ---------------------------------------------------------------------------

const BASE_POS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DST']);

/** Single-letter shorthands used inside slash-separated slot keys ("W/R/T"). */
const LETTER_POS = { Q: 'QB', R: 'RB', W: 'WR', T: 'TE', K: 'K', D: 'DST' };

/** Roster spots that are not part of a starting lineup. */
const SKIP_SLOTS = new Set([
  'BN', 'BE', 'BENCH', 'IR', 'IL', 'TAXI', 'TX', 'RES', 'RESERVE', 'NA', 'DNP', 'PS',
]);

/**
 * Flex aliases. Keys are compacted (uppercase, punctuation stripped).
 * `WRT` is WR/TE per the league vocabulary; the Yahoo-style `W/R/T` (WR/RB/TE) is
 * resolved by slash-splitting before the alias table is consulted, so both work.
 */
export const SLOT_ALIASES = {
  FLEX: ['RB', 'WR', 'TE'],
  RBWRTE: ['RB', 'WR', 'TE'],
  WRRBTE: ['RB', 'WR', 'TE'],

  WRT: ['WR', 'TE'],
  WT: ['WR', 'TE'],
  RECFLEX: ['WR', 'TE'],
  TEWR: ['WR', 'TE'],

  RBWR: ['RB', 'WR'],
  RW: ['RB', 'WR'],
  WRRB: ['RB', 'WR'],

  SUPERFLEX: ['QB', 'RB', 'WR', 'TE'],
  OP: ['QB', 'RB', 'WR', 'TE'],
  SFLEX: ['QB', 'RB', 'WR', 'TE'],
  QBRBWRTE: ['QB', 'RB', 'WR', 'TE'],

  IDPFLEX: ['DL', 'LB', 'DB'],
  DP: ['DL', 'LB', 'DB'],
  DFLEX: ['DL', 'LB', 'DB'],
};
// Shared reference data — frozen so a consumer cannot corrupt it for everyone else.
// slotsFromCounts always hands out copies.
for (const k of Object.keys(SLOT_ALIASES)) Object.freeze(SLOT_ALIASES[k]);
Object.freeze(SLOT_ALIASES);

/** Canonical starting-lineup display order. Unknown ids sort last, in input order. */
const SLOT_RANK = {
  QB: 0, RB: 1, WR: 2, TE: 3,
  WRT: 4, WT: 4, RECFLEX: 4, TEWR: 4,
  RBWR: 5, RW: 5, WRRB: 5,
  FLEX: 6, RBWRTE: 6, WRRBTE: 6,
  SUPERFLEX: 7, OP: 7, SFLEX: 7, QBRBWRTE: 7,
  K: 8, DST: 9,
  DL: 20, EDGE: 21, LB: 22, CB: 23, S: 24, DB: 25,
  IDPFLEX: 26, DP: 26, DFLEX: 26,
};

/** Uppercase, drop everything that is not a letter or digit. */
function compact(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 97 && c <= 122) out += String.fromCharCode(c - 32);
    else if ((c >= 65 && c <= 90) || (c >= 48 && c <= 57)) out += s[i];
  }
  return out;
}

/** Normalize a position label. Handles "D/ST", "def", "PK", stray punctuation. */
function canonPos(x) {
  if (typeof x !== 'string') return '';
  const s = compact(x);
  if (s === 'DST' || s === 'DEF' || s === 'D' || s === 'DEFENSE' || s === 'DEFST') return 'DST';
  if (s === 'PK') return 'K';
  return s;
}

/**
 * Resolve a slot key ("QB", "FLEX", "W/R/T", "SUPER_FLEX", "DL", "BN") to a descriptor.
 * Returns null for bench/IR spots, which are not part of a starting lineup.
 */
function slotFromKey(key) {
  const raw = String(key).trim();
  const c = compact(raw);
  if (!c) return null;
  if (SKIP_SLOTS.has(c)) return null;

  // 1. A plain position ("QB", "D/ST", "def").
  const cp = canonPos(c);
  if (BASE_POS.has(cp)) return { id: cp, eligible: [cp] };

  // 2. An explicit slash list ("W/R/T", "WR/TE", "QB/RB/WR/TE"). Checked before the alias
  //    table so W/R/T reads as WR/RB/TE rather than colliding with the WRT alias.
  if (raw.indexOf('/') >= 0) {
    const parts = raw.split('/');
    const el = [];
    let ok = parts.length > 1;
    for (let i = 0; i < parts.length; i++) {
      const t = compact(parts[i]);
      const r = (t.length === 1 && LETTER_POS[t]) ? LETTER_POS[t] : canonPos(t);
      if (!r) { ok = false; break; }
      if (el.indexOf(r) < 0) el.push(r);
    }
    if (ok) return { id: c, eligible: el };
  }

  // 3. A named flex.
  const alias = SLOT_ALIASES[c];
  if (alias) return { id: c, eligible: alias.slice() };

  // 4. Passthrough — IDP spots (DL, LB, DB, EDGE, ...) and anything else become a
  //    single-position slot named after themselves.
  const id = cp || c;
  return { id, eligible: [id] };
}

// Slot descriptors resolved from bare strings. Tiny fixed vocabulary in practice; capped
// so a caller feeding arbitrary strings cannot grow it without bound.
const _strSlots = new Map();

function resolveSlot(s) {
  if (typeof s === 'string') {
    let d = _strSlots.get(s);
    if (d === undefined) {
      d = slotFromKey(s) || { id: compact(s) || 'SLOT', eligible: [] };
      if (_strSlots.size > 256) _strSlots.clear();
      _strSlots.set(s, d);
    }
    return d;
  }
  if (s !== null && typeof s === 'object') return s;
  return { id: 'SLOT', eligible: [] };
}

// Eligibility sets, memoized per descriptor object (keyed on the identity of its
// `eligible` array so a swapped-in array invalidates the memo).
const _eligMemo = new WeakMap();

/** null means "any position is eligible"; an empty Set means "nothing is eligible". */
function eligibleSetFor(def) {
  const el = def.eligible;
  const hit = _eligMemo.get(def);
  if (hit !== undefined && hit.ref === el) return hit.set;

  let set;
  if (!Array.isArray(el)) {
    set = null; // missing eligibility list => universal slot
  } else {
    set = new Set();
    for (let i = 0; i < el.length; i++) {
      const raw = el[i];
      if (raw === '*' || raw === 'ANY' || raw === 'any') { set = null; break; }
      const c = canonPos(raw);
      if (c) set.add(c);
    }
  }
  _eligMemo.set(def, { ref: el, set });
  return set;
}

/**
 * Build an ordered slot array from a per-slot count map.
 *
 *   slotsFromCounts({ QB:1, RB:2, WR:2, TE:1, FLEX:1, K:1, DST:1 })
 *
 * Understands the flex aliases (FLEX, WRT, RBWR, SUPERFLEX/OP and friends), slash lists
 * ("W/R/T", "WR/TE"), and passes unknown keys through as single-position slots so IDP
 * formats ({ DL:2, LB:3, DB:3 }) work without special-casing. Bench/IR spots are skipped.
 * Slots come back in canonical starting-lineup order, not object-key order.
 */
export function slotsFromCounts(counts) {
  const out = [];
  if (counts === null || typeof counts !== 'object') return out;

  const keys = Object.keys(counts);
  const rows = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const raw = counts[k];
    const n = typeof raw === 'number' ? Math.floor(raw) : Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    const def = slotFromKey(k);
    if (def === null) continue;
    const rank = Object.prototype.hasOwnProperty.call(SLOT_RANK, def.id) ? SLOT_RANK[def.id] : 900;
    rows.push({ def, n, rank, idx: i });
  }
  rows.sort((a, b) => (a.rank - b.rank) || (a.idx - b.idx));

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    for (let j = 0; j < r.n; j++) out.push({ id: r.def.id, eligible: r.def.eligible.slice() });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hungarian algorithm (JV shortest augmenting path), rectangular, n rows <= m cols.
// ---------------------------------------------------------------------------

// Grow-only scratch buffers. Reused across calls to keep a season-long Monte Carlo out of
// the allocator. Safe: every buffer is fully initialized over its used prefix on entry, and
// nothing user-supplied runs while they are live (ptsOf is called before the solve).
let _cost = new Float64Array(0);
let _u = new Float64Array(0);
let _v = new Float64Array(0);
let _p = new Int32Array(0);
let _way = new Int32Array(0);
let _minv = new Float64Array(0);
let _used = new Uint8Array(0);
let _row = new Int32Array(0);

function ensureScratch(n, m) {
  if (_cost.length < n * m) _cost = new Float64Array(n * m);
  if (_u.length < n + 1) _u = new Float64Array(n + 1);
  if (_row.length < n) _row = new Int32Array(n);
  if (_v.length < m + 1) {
    _v = new Float64Array(m + 1);
    _p = new Int32Array(m + 1);
    _way = new Int32Array(m + 1);
    _minv = new Float64Array(m + 1);
    _used = new Uint8Array(m + 1);
  }
}

/**
 * Minimum-cost perfect matching of all n rows into distinct columns of an n x m cost
 * matrix stored row-major in `_cost` (requires n <= m). Writes row -> column into `_row`.
 */
function hungarian(n, m) {
  const cost = _cost, u = _u, v = _v, p = _p, way = _way, minv = _minv, used = _used;
  u.fill(0, 0, n + 1);
  v.fill(0, 0, m + 1);
  p.fill(0, 0, m + 1);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    minv.fill(Infinity, 0, m + 1);
    used.fill(0, 0, m + 1);

    do {
      used[j0] = 1;
      const i0 = p[j0];
      const base = (i0 - 1) * m - 1;
      let delta = Infinity;
      let j1 = 0;
      const ui = u[i0];
      for (let j = 1; j <= m; j++) {
        if (used[j] === 0) {
          const cur = cost[base + j] - ui - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j] !== 0) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  _row.fill(-1, 0, n);
  for (let j = 1; j <= m; j++) {
    const i = p[j];
    if (i > 0) _row[i - 1] = j - 1;
  }
}

// ---------------------------------------------------------------------------
// optimizeLineup
// ---------------------------------------------------------------------------

/**
 * Exact optimal starting lineup.
 *
 * @param {Array<object>} players  roster; each needs `pos` (or `position`) and ideally `id`
 * @param {Array<object|string>} slots  ordered slot descriptors `{ id, eligible }`, or keys
 * @param {(p:object)=>number} ptsOf  points for a player; called once per distinct player
 * @param {{allowNegative?: boolean}} [options]  see the header note; default true
 * @returns {{assignments: Array<{slot: string, slotIndex: number, player: object|null,
 *            pts: number, slotDef: object}>, total: number, benched: Array<object>,
 *            filled: number}}
 */
export function optimizeLineup(players, slots, ptsOf, options) {
  if (typeof ptsOf !== 'function') {
    throw new TypeError('optimizeLineup: ptsOf must be a function');
  }
  const allowNegative = !(options && options.allowNegative === false);

  // --- slots -------------------------------------------------------------
  const rawSlots = Array.isArray(slots) ? slots : [];
  const S = rawSlots.length;
  const slotDefs = new Array(S);
  const slotSets = new Array(S);
  for (let i = 0; i < S; i++) {
    const d = resolveSlot(rawSlots[i]);
    slotDefs[i] = d;
    slotSets[i] = eligibleSetFor(d);
  }

  // --- players: dedupe, score once, normalize position --------------------
  const src = Array.isArray(players) ? players : [];
  const kept = [];
  const pts = [];
  const pos = [];
  let seenIds = null;
  let seenObjs = null;
  let absSum = 0;

  for (let i = 0; i < src.length; i++) {
    const pl = src[i];
    if (pl === null || pl === undefined) continue;
    const id = (typeof pl === 'object') ? pl.id : undefined;
    if (id !== undefined && id !== null) {
      if (seenIds === null) seenIds = new Set();
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    } else if (typeof pl === 'object') {
      if (seenObjs === null) seenObjs = new Set();
      if (seenObjs.has(pl)) continue;
      seenObjs.add(pl);
    }
    const raw = ptsOf(pl);
    const v = Number.isFinite(raw) ? raw : 0;
    kept.push(pl);
    pts.push(v);
    absSum += v < 0 ? -v : v;
    pos.push(typeof pl === 'object'
      ? canonPos(pl.pos !== undefined && pl.pos !== null ? pl.pos : pl.position)
      : '');
  }
  const P = kept.length;

  // --- trivial shapes -----------------------------------------------------
  if (S === 0) {
    return { assignments: [], total: 0, benched: kept, filled: 0 };
  }
  if (P === 0) {
    const assignments = new Array(S);
    for (let s = 0; s < S; s++) {
      assignments[s] = { slot: slotDefs[s].id, slotIndex: s, player: null, pts: 0, slotDef: slotDefs[s] };
    }
    return { assignments, total: 0, benched: [], filled: 0 };
  }

  // --- cost matrix --------------------------------------------------------
  // Columns 0..P-1 are players; columns P..P+S-1 are "leave this slot empty".
  //
  //   span  = 1 + sum |pts|            strictly exceeds any single lineup's |points|
  //   EMPTY = 2 * span                 cost of an unfilled slot. Large enough that one
  //                                    extra filled slot always beats any point swing
  //                                    (<= 2*(span-1)) achievable by filling fewer.
  //   BIG   = 3 * S * span + 1         forbidden pairing. Exceeds the span of every
  //                                    legal assignment, and a legal assignment always
  //                                    exists (all slots empty), so BIG is never chosen.
  const m = P + S;
  const span = 1 + absSum;
  const EMPTY = 2 * span;
  const BIG = 3 * S * span + 1;

  ensureScratch(S, m);
  const cost = _cost;
  for (let s = 0; s < S; s++) {
    const set = slotSets[s];
    const base = s * m;
    for (let j = 0; j < P; j++) {
      let c;
      if (set !== null && !set.has(pos[j])) c = BIG;
      else if (!allowNegative && pts[j] < 0) c = BIG;
      else c = -pts[j];
      cost[base + j] = c;
    }
    for (let j = P; j < m; j++) cost[base + j] = EMPTY;
  }

  hungarian(S, m);

  // --- read the matching back --------------------------------------------
  const assignments = new Array(S);
  const taken = new Uint8Array(P);
  let total = 0;
  let filled = 0;

  for (let s = 0; s < S; s++) {
    const col = _row[s];
    let player = null;
    let v = 0;
    if (col >= 0 && col < P) {
      const set = slotSets[s];
      const ok = (set === null || set.has(pos[col])) && (allowNegative || pts[col] >= 0);
      if (ok) {
        player = kept[col];
        v = pts[col];
        taken[col] = 1;
        total += v;
        filled++;
      }
    }
    assignments[s] = { slot: slotDefs[s].id, slotIndex: s, player, pts: v, slotDef: slotDefs[s] };
  }

  const benched = [];
  for (let j = 0; j < P; j++) if (taken[j] === 0) benched.push(kept[j]);

  return { assignments, total, benched, filled };
}
