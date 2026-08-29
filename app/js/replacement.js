/**
 * replacement.js — endogenous replacement level and value over replacement.
 *
 * Contract: docs/ARCHITECTURE.md section 6 ("Replacement level is computed, not typed").
 *
 *   computeReplacement(pool, league, ptsOf) -> { QB, RB, WR, TE, K, DST }
 *   replacementDetail(pool, league, ptsOf)  -> { <pos>: {starters, flexShare, rankUsed, ...} }
 *   vor(player, replacement, ptsOf)         -> number
 *   vorCurve(pool, replacement, ptsOf)      -> { <pos>: [ {id, pts, vor, rank, drop}, ... ] }
 *
 * ---------------------------------------------------------------------------
 * Why this module exists
 * ---------------------------------------------------------------------------
 * The prototype asked the user to TYPE a replacement value per position. That single input
 * dominated every downstream number — VOR, trade verdicts, draft board — and it was a guess.
 * Replacement level is not an opinion. It is an observable property of a league:
 *
 *     replacement[pos] = the projection of the best player at `pos` you could add for free
 *
 * Two ways to observe it, in order of preference:
 *
 * 1. FREE AGENT (primary, used when `league.rostered` covers enough of the league).
 *    Literally the best unrostered player at the position — the guy you would stream this
 *    week. No modeling, no assumption about flex behavior: the waiver wire is the answer.
 *
 * 2. RANK BASELINE (fallback, used when rosters are unknown or only a couple are loaded).
 *    Count how many players at the position start league-wide, then take the next one:
 *
 *        starters[pos] = teams x dedicatedSlots[pos]  +  flexShare[pos]
 *        replacement[pos] = pts(positionRanking[pos][ starters[pos] ])   // 0-indexed
 *
 *    `flexShare` is measured, NOT assumed. Strip the dedicated starters off every
 *    flex-eligible position, pool what is left, take the top `teams x flexSlots`, and count
 *    what they actually are. Under full PPR that block fills with slot receivers; under
 *    standard it fills with two-down backs. The share therefore moves with the scoring
 *    config, which is the whole point of scoring in the browser (contract section 2).
 *
 * Both are derived from `ptsOf`, so changing PPR from 1.0 to 0.5 re-derives replacement
 * level, VOR and every verdict built on them without a rebuild.
 *
 * ---------------------------------------------------------------------------
 * Notes for callers
 * ---------------------------------------------------------------------------
 * - `ptsOf(player)` is called exactly once per deduped player. Non-finite returns are 0.
 *   Omit it and `player.pts` is read instead.
 * - Players are deduped by `id` (first occurrence wins); id-less players dedupe by identity.
 *   A player with no resolvable position has no defined replacement level and is dropped.
 * - Output is a function of the SET of players, not their input order: ties break by id.
 * - `league.rostered` may be a Set, an array, or anything with `.has`. Ids are compared as
 *   strings, so a Set of numbers matches string ids and vice versa.
 * - The free-agent method is only trusted when the rostered set actually covers the league
 *   (default: half of `teams x rosterSize`, measured by ids that MATCH the pool, so a
 *   mismatched id space degrades to the rank baseline instead of silently reporting the
 *   overall best player as replacement level). Force it with `league.method`.
 * - `league.override` ({QB: 250}) still wins. Correct by default, not mandatory.
 * - Every detail row is flagged `inferred: true` and carries a `note` — contract section 10
 *   requires replacement level to be labeled as inferred in the UI.
 * - No Date.now(), no Math.random(), no top-level side effects, no dependencies.
 */

/* ------------------------------------------------------------------ vocabulary */

/** Canonical positions, always present in every returned map. */
export const POSITIONS = Object.freeze(['QB', 'RB', 'WR', 'TE', 'K', 'DST']);

/** The user's league (contract section 6 worked example). Used when `league` is partial. */
export const DEFAULT_LEAGUE = Object.freeze({
  teams: 12,
  slots: Object.freeze({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BEN: 7 }),
});

const POS_RANK = { QB: 0, RB: 1, WR: 2, TE: 3, K: 4, DST: 5 };

/** Roster spots that hold a player but never start one. They count toward roster size only. */
const BENCH_SLOTS = new Set([
  'BN', 'BE', 'BEN', 'BENCH', 'IR', 'IL', 'INJ', 'TAXI', 'TX', 'PS',
  'RES', 'RESERVE', 'NA', 'DNP',
]);

/** Single-letter shorthands inside slash-separated slot keys ("W/R/T"). */
const LETTER_POS = { Q: 'QB', R: 'RB', W: 'WR', T: 'TE', K: 'K', D: 'DST' };

/** Named flex slots. Keys are compacted (uppercase, punctuation stripped). */
const SLOT_ALIASES = {
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

/* --------------------------------------------------------------------- helpers */

function toNum(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Round away float dust without losing simulation precision. Mirrors scoring.js. */
function round6(x) {
  if (!Number.isFinite(x)) return 0;
  if (x >= 1e15 || x <= -1e15) return x;
  return Math.round(x * 1e6) / 1e6;
}

function compact(s) {
  return String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Normalize a position string to the canonical vocabulary. '' when unusable. */
function canonPos(pos) {
  if (typeof pos !== 'string') return '';
  const c = compact(pos);
  if (!c) return '';
  if (c === 'DST' || c === 'DEF' || c === 'D' || c === 'DS' || c === 'DEFENSE' || c === 'DEFST') return 'DST';
  if (c === 'K' || c === 'PK' || c === 'KICKER') return 'K';
  return c;
}

function posOrder(p) {
  return Object.prototype.hasOwnProperty.call(POS_RANK, p) ? POS_RANK[p] : 90;
}

/** Default scorer when the caller omits `ptsOf`: read `pts` off the player. */
function defaultPtsOf(p) {
  return p && typeof p === 'object' ? toNum(p.pts) : 0;
}

/* ------------------------------------------------------------- slot resolution */

/**
 * Classify one roster-slot key.
 *   { kind: 'bench' }                     BN / BE / BEN / IR / TAXI ...
 *   { kind: 'pos',  pos: 'RB' }           a dedicated single-position slot
 *   { kind: 'flex', eligible: [...] }     a multi-position slot
 */
function classifySlot(key) {
  const raw = String(key).trim();
  const c = compact(raw);
  if (!c) return null;
  if (BENCH_SLOTS.has(c)) return { kind: 'bench' };

  // A plain position ("QB", "D/ST", "def").
  const cp = canonPos(c);
  if (Object.prototype.hasOwnProperty.call(POS_RANK, cp)) return { kind: 'pos', pos: cp };

  // An explicit slash list ("W/R/T", "WR/TE"). Checked before the alias table so W/R/T
  // reads as WR/RB/TE rather than colliding with the WRT (WR/TE) alias.
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
    if (ok) return el.length === 1 ? { kind: 'pos', pos: el[0] } : { kind: 'flex', eligible: el };
  }

  // A named flex.
  const alias = SLOT_ALIASES[c];
  if (alias) return { kind: 'flex', eligible: alias.slice() };

  // Passthrough: IDP spots (DL, LB, DB, EDGE, ...) and anything else become a dedicated
  // slot for a position named after themselves.
  return { kind: 'pos', pos: cp || c };
}

/**
 * Normalize the league descriptor.
 * @returns {{teams, dedicated: Map<string,number>, flexGroups: Array, rosterSize: number,
 *            startersPerTeam: number, method: string, coverageFloor: number, override: Object}}
 */
function normalizeLeague(league) {
  const L = (league !== null && typeof league === 'object') ? league : {};

  let teams = Number(L.teams);
  if (!Number.isFinite(teams) || teams < 1) teams = DEFAULT_LEAGUE.teams;
  teams = Math.floor(teams);

  const slots = (L.slots !== null && typeof L.slots === 'object') ? L.slots : DEFAULT_LEAGUE.slots;

  const dedicated = new Map();   // pos -> slots per team
  const groupByKey = new Map();  // eligibility signature -> {eligible, perTeam}
  let benchPerTeam = 0;
  let startersPerTeam = 0;

  for (const key of Object.keys(slots)) {
    const raw = slots[key];
    const n = typeof raw === 'number' ? Math.floor(raw) : Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    const def = classifySlot(key);
    if (def === null) continue;
    if (def.kind === 'bench') { benchPerTeam += n; continue; }
    startersPerTeam += n;
    if (def.kind === 'pos') {
      dedicated.set(def.pos, (dedicated.get(def.pos) || 0) + n);
    } else {
      // Merge identical eligibility sets so two FLEX keys spelled differently are one group.
      const sig = def.eligible.slice().sort().join('|');
      const hit = groupByKey.get(sig);
      if (hit) hit.perTeam += n;
      else groupByKey.set(sig, { eligible: def.eligible.slice(), perTeam: n });
    }
  }

  // Narrowest eligibility first. That ordering is exact when the eligibility sets are
  // laminar (nested or disjoint), which every mainstream roster format is, and is a close
  // approximation otherwise. Exactness matters for an actual weekly lineup, and lineup.js
  // solves that with Hungarian matching; here we only need the SHARE of a flex block.
  const flexGroups = Array.from(groupByKey.values()).sort(
    (a, b) => (a.eligible.length - b.eligible.length)
      || (b.perTeam - a.perTeam)
      || (a.eligible.join('|') < b.eligible.join('|') ? -1 : 1),
  );

  let coverageFloor = Number(L.rosterCoverage);
  if (!Number.isFinite(coverageFloor) || coverageFloor < 0) coverageFloor = 0.5;

  const method = typeof L.method === 'string' ? L.method : 'auto';
  const override = (L.override !== null && typeof L.override === 'object') ? L.override : null;

  return {
    teams,
    dedicated,
    flexGroups,
    startersPerTeam,
    rosterSize: startersPerTeam + benchPerTeam,
    method,
    coverageFloor,
    override,
  };
}

/* ----------------------------------------------------------------- pool shaping */

/**
 * Score, dedupe and group the pool.
 * @returns {{entries: Array, byPos: Map<string, Array>}}
 */
function shapePool(pool, ptsOf) {
  const score = typeof ptsOf === 'function' ? ptsOf : defaultPtsOf;
  const entries = [];
  if (!Array.isArray(pool)) return { entries, byPos: new Map() };

  const seenId = new Set();
  const seenObj = new Set();

  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    if (p === null || typeof p !== 'object') continue;

    const hasId = p.id !== undefined && p.id !== null && p.id !== '';
    const id = hasId ? String(p.id) : null;
    if (id !== null) {
      if (seenId.has(id)) continue;
      seenId.add(id);
    } else {
      if (seenObj.has(p)) continue;
      seenObj.add(p);
    }

    const pos = canonPos(p.pos);
    if (!pos) continue; // no position => no defined replacement level

    entries.push({ player: p, id, pos, pts: toNum(score(p)), idx: i });
  }

  const byPos = new Map();
  for (const e of entries) {
    let list = byPos.get(e.pos);
    if (!list) { list = []; byPos.set(e.pos, list); }
    list.push(e);
  }
  // Points descending. Ties break on id, then input order, so the ranking is a function of
  // the set of players rather than the order they happened to arrive in.
  for (const list of byPos.values()) list.sort(cmpEntry);

  return { entries, byPos };
}

function cmpEntry(a, b) {
  if (b.pts !== a.pts) return b.pts - a.pts;
  const ai = a.id === null ? '' : a.id;
  const bi = b.id === null ? '' : b.id;
  if (ai !== bi) return ai < bi ? -1 : 1;
  return a.idx - b.idx;
}

/** Cross-position comparison for the flex draw: points, then position order, then id. */
function cmpFlex(a, b) {
  if (b.pts !== a.pts) return b.pts - a.pts;
  const pa = posOrder(a.pos);
  const pb = posOrder(b.pos);
  if (pa !== pb) return pa - pb;
  return cmpEntry(a, b);
}

/* --------------------------------------------------------------- rostered sets */

/**
 * Build a Set of String(id) from whatever the caller has on hand: a Set or array of ids, a
 * Map keyed by id, an array of player objects, or a plain {id: true} map. Ids normalize to
 * strings so a Set of numbers matches string ids and vice versa.
 */
function rosteredSet(rostered) {
  if (rostered === null || rostered === undefined) return null;
  const out = new Set();

  if (typeof rostered === 'string') { out.add(rostered); return out; }
  if (rostered instanceof Map) {
    for (const k of rostered.keys()) if (k !== null && k !== undefined) out.add(String(k));
    return out;
  }
  if (typeof rostered[Symbol.iterator] === 'function') {
    for (const v of rostered) {
      if (v === null || v === undefined) continue;
      // Tolerate a collection of player objects rather than bare ids.
      if (typeof v === 'object') {
        if (v.id !== null && v.id !== undefined && v.id !== '') out.add(String(v.id));
        continue;
      }
      out.add(String(v));
    }
    return out;
  }
  if (typeof rostered === 'object') {
    for (const k of Object.keys(rostered)) if (rostered[k]) out.add(String(k));
    return out;
  }
  return null;
}

/* --------------------------------------------------------------- the flex draw */

/**
 * Measure, empirically, how a league's flex slots fill.
 *
 * Dedicated starters are removed first (a cursor per position). Then each flex group draws
 * its league-wide capacity from the best remaining players across its eligible positions.
 * What comes out is a COUNT per position, not a guess: under full PPR the block fills with
 * receivers, under standard with backs, because `ptsOf` says so.
 *
 * @returns {{share: Map<string,number>, capacity: Map<string,number>}}
 */
function drawFlex(byPos, dedicatedTotal, flexGroups) {
  const cursor = new Map();
  for (const [pos, list] of byPos) {
    cursor.set(pos, Math.min(dedicatedTotal.get(pos) || 0, list.length));
  }

  const share = new Map();
  const capacity = new Map();

  for (const g of flexGroups) {
    for (const pos of g.eligible) {
      capacity.set(pos, (capacity.get(pos) || 0) + g.capacity);
    }
    let taken = 0;
    while (taken < g.capacity) {
      let best = null;
      let bestPos = null;
      for (const pos of g.eligible) {
        const list = byPos.get(pos);
        if (!list) continue;
        const i = cursor.get(pos) || 0;
        if (i >= list.length) continue;
        const cand = list[i];
        if (best === null || cmpFlex(cand, best) < 0) { best = cand; bestPos = pos; }
      }
      if (best === null) break; // every eligible position exhausted
      cursor.set(bestPos, (cursor.get(bestPos) || 0) + 1);
      share.set(bestPos, (share.get(bestPos) || 0) + 1);
      taken++;
    }
  }

  return { share, capacity };
}

/* ------------------------------------------------------------------ the answer */

/**
 * Replacement level per position, with the intermediate values that produced it.
 *
 * Every row carries the rank-baseline arithmetic (`dedicated`, `flexShare`, `starters`)
 * even when the free-agent method supplied the answer, so the UI can show both and the
 * user can see when the waiver wire disagrees with the theory.
 *
 * @param {Array<Object>} pool   Every player in the projection universe: {id, pos, ...}.
 * @param {Object} league        {teams, slots, rostered?, method?, override?, rosterCoverage?}
 * @param {function(Object):number} ptsOf
 * @returns {Object<string, Object>} keyed by position
 */
export function replacementDetail(pool, league, ptsOf) {
  const cfg = normalizeLeague(league);
  const { entries, byPos } = shapePool(pool, ptsOf);

  // League-wide dedicated starter counts.
  const dedicatedTotal = new Map();
  for (const [pos, perTeam] of cfg.dedicated) dedicatedTotal.set(pos, perTeam * cfg.teams);

  const flexGroups = cfg.flexGroups.map((g) => ({ eligible: g.eligible, capacity: g.perTeam * cfg.teams }));
  const { share: flexShare, capacity: flexCapacity } = drawFlex(byPos, dedicatedTotal, flexGroups);

  // --- roster coverage: is the free-agent pool real, or do we only know two teams?
  const roster = rosteredSet(league && typeof league === 'object' ? league.rostered : null);
  let matched = 0;
  if (roster) {
    for (const e of entries) if (e.id !== null && roster.has(e.id)) matched++;
  }
  const expected = Math.max(1, Math.min(cfg.teams * cfg.rosterSize || cfg.teams, entries.length || 1));
  const coverage = roster ? matched / expected : null;

  let useFA;
  if (cfg.method === 'freeAgent' || cfg.method === 'fa') useFA = !!roster;
  else if (cfg.method === 'rank') useFA = false;
  else useFA = !!roster && coverage >= cfg.coverageFloor;

  // Positions worth reporting: the canonical six, plus anything the pool or the roster
  // format actually contains (IDP spots, FB, ...).
  const extra = new Set();
  for (const pos of byPos.keys()) extra.add(pos);
  for (const pos of dedicatedTotal.keys()) extra.add(pos);
  for (const pos of flexCapacity.keys()) extra.add(pos);
  for (const pos of POSITIONS) extra.delete(pos);
  const positions = POSITIONS.concat(Array.from(extra).sort());

  const out = {};
  for (const pos of positions) {
    out[pos] = describePosition({
      pos,
      list: byPos.get(pos) || [],
      dedicated: dedicatedTotal.get(pos) || 0,
      flexShare: flexShare.get(pos) || 0,
      flexCapacity: flexCapacity.get(pos) || 0,
      roster,
      useFA,
      coverage,
      override: cfg.override,
    });
  }
  return out;
}

function describePosition(a) {
  const { pos, list, dedicated, flexShare, flexCapacity, roster, useFA, coverage } = a;
  const starters = dedicated + flexShare;
  const count = list.length;

  const row = {
    pos,
    method: 'empty',
    pts: 0,
    rankUsed: -1,
    playerAtRank: null,
    starters,
    dedicated,
    flexShare,
    flexCapacity,
    count,
    freeAgents: null,
    rankPts: 0,
    freeAgentPts: null,
    clamped: false,
    rosterCoverage: coverage,
    inferred: true,
    note: '',
  };

  // --- rank baseline, always computed so the UI can show its work.
  let rankIdx = -1;
  if (count > 0) {
    rankIdx = starters < count ? starters : count - 1;
    row.rankPts = round6(list[rankIdx].pts);
    if (starters >= count) row.clamped = true;
  }

  // --- free-agent baseline, when rosters are known.
  let faIdx = -1;
  if (roster) {
    let free = 0;
    for (let i = 0; i < count; i++) {
      const e = list[i];
      const rostered = e.id !== null && roster.has(e.id);
      if (!rostered) {
        free++;
        if (faIdx < 0) faIdx = i;
      }
    }
    row.freeAgents = free;
    if (faIdx >= 0) row.freeAgentPts = round6(list[faIdx].pts);
  }

  // --- user override wins, but is labeled.
  const ov = a.override && Object.prototype.hasOwnProperty.call(a.override, pos)
    ? Number(a.override[pos]) : NaN;
  if (Number.isFinite(ov)) {
    row.method = 'override';
    row.pts = round6(ov);
    row.note = `Manual override: ${row.pts}. Computed baseline was `
      + `${useFA && faIdx >= 0 ? row.freeAgentPts : row.rankPts}.`;
    if (faIdx >= 0) { row.rankUsed = faIdx; row.playerAtRank = list[faIdx].player; }
    else if (rankIdx >= 0) { row.rankUsed = rankIdx; row.playerAtRank = list[rankIdx].player; }
    return row;
  }

  if (count === 0) {
    row.note = `No ${pos} in the pool; replacement level is 0 and every ${pos} VOR is its raw projection.`;
    return row;
  }

  if (useFA && faIdx >= 0) {
    row.method = 'freeAgent';
    row.rankUsed = faIdx;
    row.playerAtRank = list[faIdx].player;
    row.pts = row.freeAgentPts;
    row.note = `Best unrostered ${pos} is ${pos}${faIdx + 1} of ${count} `
      + `(${row.freeAgents} free agents). That is the player you would stream.`;
    return row;
  }

  row.rankUsed = rankIdx;
  row.playerAtRank = list[rankIdx].player;
  row.pts = row.rankPts;

  if (row.clamped) {
    row.method = 'tail';
    row.note = `Only ${count} ${pos} in the pool but ${starters} start league-wide `
      + `(${dedicated} dedicated + ${flexShare} flex); every ${pos} starts somewhere, so the `
      + `worst one is used as the floor. Replacement level is optimistic here.`;
  } else {
    row.method = 'rank';
    row.note = `${starters} ${pos} start league-wide (${dedicated} dedicated + ${flexShare} `
      + `of ${flexCapacity} flex spots, measured under this scoring). Replacement is `
      + `${pos}${starters + 1}, the first ${pos} not startable anywhere.`;
  }

  if (roster) {
    row.note += useFA
      ? ` No unrostered ${pos} available, so the rank baseline is used.`
      : ` Rosters cover only ${Math.round((coverage || 0) * 100)}% of the league, too few to `
        + 'trust the free-agent pool.';
  }
  return row;
}

/**
 * Replacement level per position.
 *
 * @param {Array<Object>} pool
 * @param {Object} league  {teams, slots, rostered?}
 * @param {function(Object):number} ptsOf
 * @returns {{QB:number, RB:number, WR:number, TE:number, K:number, DST:number}}
 */
export function computeReplacement(pool, league, ptsOf) {
  const detail = replacementDetail(pool, league, ptsOf);
  const out = {};
  for (const pos of Object.keys(detail)) out[pos] = detail[pos].pts;
  return out;
}

/* ------------------------------------------------------------------------ VOR */

/**
 * Value over replacement for one player.
 *
 * @param {Object} player
 * @param {Object|number} replacement  Map from computeReplacement, or a flat number.
 * @param {function(Object):number} ptsOf
 * @returns {number} points above the replacement level at the player's position.
 */
export function vor(player, replacement, ptsOf) {
  if (player === null || typeof player !== 'object') return 0;
  const score = typeof ptsOf === 'function' ? ptsOf : defaultPtsOf;
  const pts = toNum(score(player));

  let base = 0;
  if (typeof replacement === 'number') {
    base = toNum(replacement);
  } else if (replacement !== null && typeof replacement === 'object') {
    const pos = canonPos(player.pos);
    // Unknown position, or a position with no computed baseline: replacement 0, so VOR is
    // the raw projection. Never silently borrows another position's baseline.
    base = pos ? toNum(replacement[pos]) : 0;
  }

  return round6(pts - base);
}

/**
 * Per-position VOR curves, sorted best first — the input to tier detection and to any
 * positional-scarcity chart.
 *
 * Each entry carries `drop`, the VOR gap to the next player at the position. A cliff in
 * `drop` is a tier break; a long flat run is a position you can wait on.
 *
 * @param {Array<Object>} pool
 * @param {Object|number} replacement
 * @param {function(Object):number} ptsOf
 * @returns {Object<string, Array<{id, name, pos, player, pts, vor, rank, drop}>>}
 */
export function vorCurve(pool, replacement, ptsOf) {
  const { byPos } = shapePool(pool, ptsOf);

  const extra = new Set(byPos.keys());
  for (const pos of POSITIONS) extra.delete(pos);
  const positions = POSITIONS.concat(Array.from(extra).sort());

  const flat = typeof replacement === 'number' ? toNum(replacement) : null;

  const out = {};
  for (const pos of positions) {
    const list = byPos.get(pos) || [];
    const base = flat !== null
      ? flat
      : (replacement !== null && typeof replacement === 'object' ? toNum(replacement[pos]) : 0);

    const rows = new Array(list.length);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      rows[i] = {
        id: e.id,
        name: typeof e.player.name === 'string' ? e.player.name : null,
        pos,
        player: e.player,
        pts: round6(e.pts),
        vor: round6(e.pts - base),
        rank: i + 1,
        drop: 0,
      };
    }
    for (let i = 0; i < rows.length - 1; i++) rows[i].drop = round6(rows[i].vor - rows[i + 1].vor);
    out[pos] = rows;
  }
  return out;
}
