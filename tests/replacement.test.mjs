/**
 * Tests for app/js/replacement.js — endogenous replacement level and VOR.
 *
 * Run: cd /home/user/tradedesk && node --test tests/
 *
 * The four things that have to be true, per contract section 6:
 *   1. With rosters known, replacement IS the best free agent. Verified by construction.
 *   2. The flex share is measured, not assumed: it moves when the scoring config moves.
 *      Under full PPR more WRs occupy flex than under standard. This is the central claim.
 *   3. QB compression: 12 teams x 1 QB puts replacement at QB13, so elite QB VOR is small
 *      next to elite RB/WR VOR.
 *   4. Degenerate input never throws and never lies.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeReplacement,
  replacementDetail,
  vor,
  vorCurve,
  POSITIONS,
  DEFAULT_LEAGUE,
} from '../app/js/replacement.js';

/* ------------------------------------------------------------------ helpers */

const LEAGUE_SLOTS = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BEN: 7 };

function league(over) {
  return Object.assign({ teams: 12, slots: LEAGUE_SLOTS }, over || {});
}

/** Flat pool of `n` players at `pos`, points descending from `top` by `step`. */
function ladder(pos, n, top, step) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: `${pos}${i + 1}`, name: `${pos} ${i + 1}`, pos, pts: top - step * i });
  }
  return out;
}

const byPts = (p) => p.pts;

function close(actual, expected, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${actual} to be within ${eps} of ${expected}`);
}

/** Deterministic shuffle (no Math.random) for order-independence checks. */
function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = (i * 7919 + 104729) % (i + 1);
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}

/* ==========================================================================
 * 1. Free-agent method: replacement equals the best unrostered player.
 * ======================================================================== */

// A full projection universe. Points are strictly decreasing within each position, so
// "the best free agent" is unambiguous by construction.
function universe() {
  return [
    ...ladder('QB', 30, 340, 4),    // QB1 340 ... QB30 224
    ...ladder('RB', 70, 320, 3),    // RB1 320 ... RB70 113
    ...ladder('WR', 90, 310, 2),    // WR1 310 ... WR90 132
    ...ladder('TE', 40, 240, 4),    // TE1 240 ... TE40 84
    ...ladder('K', 35, 150, 1),
    ...ladder('DST', 35, 145, 1),
  ];
}

/**
 * A rostered set with a deliberate hole at each position, so the expected answer is a
 * specific named player rather than "whoever is next".
 *
 *   QB: 1-14 rostered except QB7   -> best FA is QB7   (a hole in the middle)
 *   RB: 1-55 rostered              -> best FA is RB56  (a clean cut line)
 *   WR: 1-70 rostered except WR3   -> best FA is WR3   (a stud sitting on waivers)
 *   TE: 1-13 / K: 1-12 / DST: 1-12 -> best FA is the next one down
 */
function rosteredIds() {
  const ids = [];
  for (let i = 1; i <= 14; i++) if (i !== 7) ids.push(`QB${i}`);
  for (let i = 1; i <= 55; i++) ids.push(`RB${i}`);
  for (let i = 1; i <= 70; i++) if (i !== 3) ids.push(`WR${i}`);
  for (let i = 1; i <= 13; i++) ids.push(`TE${i}`);
  for (let i = 1; i <= 12; i++) ids.push(`K${i}`);
  for (let i = 1; i <= 12; i++) ids.push(`DST${i}`);
  return ids;
}

test('free agent: replacement is the best unrostered player at each position', () => {
  const pool = universe();
  const rostered = new Set(rosteredIds());
  const rep = computeReplacement(pool, league({ rostered }), byPts);

  // Verified by construction against the holes punched above.
  close(rep.QB, 340 - 4 * 6);   // QB7
  close(rep.RB, 320 - 3 * 55);  // RB56
  close(rep.WR, 310 - 2 * 2);   // WR3
  close(rep.TE, 240 - 4 * 13);  // TE14
  close(rep.K, 150 - 12);       // K13
  close(rep.DST, 145 - 12);     // DST13

  const d = replacementDetail(pool, league({ rostered }), byPts);
  assert.equal(d.QB.method, 'freeAgent');
  assert.equal(d.QB.playerAtRank.id, 'QB7');
  assert.equal(d.QB.rankUsed, 6);            // 0-indexed position rank
  assert.equal(d.RB.playerAtRank.id, 'RB56');
  assert.equal(d.WR.playerAtRank.id, 'WR3');
  assert.equal(d.TE.playerAtRank.id, 'TE14');
  assert.equal(d.K.playerAtRank.id, 'K13');
  assert.equal(d.DST.playerAtRank.id, 'DST13');

  // Free-agent counts are reported, not just the pick.
  assert.equal(d.QB.freeAgents, 30 - 13);
  assert.equal(d.WR.freeAgents, 90 - 69);
  assert.ok(d.QB.rosterCoverage > 0.5);
});

test('free agent: a stud left on waivers beats the rank baseline, and the method says so', () => {
  const pool = universe();
  const d = replacementDetail(pool, league({ rostered: new Set(rosteredIds()) }), byPts);

  // WR3 is unrostered, so replacement level at WR is far above what the rank baseline
  // would infer. The tool must report the wire, not the theory.
  assert.equal(d.WR.method, 'freeAgent');
  assert.ok(d.WR.pts > d.WR.rankPts, `${d.WR.pts} should exceed rank baseline ${d.WR.rankPts}`);
  close(d.WR.freeAgentPts, 306);
  assert.match(d.WR.note, /unrostered/i);
  assert.equal(d.WR.inferred, true);
});

test('free agent: every rank-baseline intermediate is still reported for the UI', () => {
  const d = replacementDetail(universe(), league({ rostered: new Set(rosteredIds()) }), byPts);
  for (const pos of POSITIONS) {
    const row = d[pos];
    assert.equal(typeof row.starters, 'number');
    assert.equal(typeof row.flexShare, 'number');
    assert.equal(typeof row.dedicated, 'number');
    assert.equal(typeof row.rankPts, 'number');
    assert.equal(row.starters, row.dedicated + row.flexShare);
    assert.ok(row.note.length > 0);
  }
  assert.equal(d.QB.dedicated, 12);
  assert.equal(d.RB.dedicated, 24);
  assert.equal(d.WR.dedicated, 24);
  assert.equal(d.TE.dedicated, 12);
});

test('free agent: fallback to rank when only two rosters are loaded', () => {
  const pool = universe();
  const twoRosters = [];
  for (let i = 1; i <= 3; i++) twoRosters.push(`QB${i}`);
  for (let i = 1; i <= 8; i++) twoRosters.push(`RB${i}`);
  for (let i = 1; i <= 10; i++) twoRosters.push(`WR${i}`);
  for (let i = 1; i <= 4; i++) twoRosters.push(`TE${i}`);
  twoRosters.push('K1', 'K2', 'DST1', 'DST2'); // 31 ids ~ two 16-man rosters

  const d = replacementDetail(pool, league({ rostered: new Set(twoRosters) }), byPts);
  assert.equal(d.QB.method, 'rank');
  assert.ok(d.QB.rosterCoverage < 0.5);
  assert.match(d.QB.note, /too few/i);
  // Rank baseline, not "the best player nobody on these two teams has".
  assert.equal(d.QB.rankUsed, d.QB.starters);
  assert.equal(d.QB.playerAtRank.id, `QB${d.QB.starters + 1}`);
  assert.notEqual(d.QB.pts, d.QB.freeAgentPts);
});

test('free agent: a mismatched id space degrades to rank instead of returning the best player', () => {
  const pool = universe();
  // 200 ids that look like a full league but match nothing in the pool.
  const bogus = new Set();
  for (let i = 0; i < 200; i++) bogus.add(`sleeper-${i}`);

  const d = replacementDetail(pool, league({ rostered: bogus }), byPts);
  assert.equal(d.RB.method, 'rank');
  assert.equal(d.RB.rosterCoverage, 0);
  assert.notEqual(d.RB.playerAtRank.id, 'RB1'); // the failure mode this guard exists for
  assert.equal(d.RB.playerAtRank.id, `RB${d.RB.starters + 1}`);
});

test('free agent: method can be forced, and rostered accepts Set / array / map', () => {
  const pool = universe();
  const ids = rosteredIds();

  const asSet = computeReplacement(pool, league({ rostered: new Set(ids) }), byPts);
  const asArray = computeReplacement(pool, league({ rostered: ids }), byPts);
  const asMap = computeReplacement(pool, league({
    rostered: Object.fromEntries(ids.map((k) => [k, true])),
  }), byPts);
  const asJsMap = computeReplacement(pool, league({
    rostered: new Map(ids.map((k) => [k, { id: k }])),
  }), byPts);
  const asPlayers = computeReplacement(pool, league({
    rostered: ids.map((k) => ({ id: k, pos: 'RB' })),
  }), byPts);
  assert.deepEqual(asArray, asSet);
  assert.deepEqual(asMap, asSet);
  assert.deepEqual(asJsMap, asSet);
  assert.deepEqual(asPlayers, asSet);

  // Numeric ids in the set still match string ids in the pool.
  const numPool = [{ id: 1, pos: 'QB', pts: 300 }, { id: 2, pos: 'QB', pts: 200 }];
  const numDetail = replacementDetail(numPool, {
    teams: 1, slots: { QB: 1 }, rostered: new Set([1]), method: 'freeAgent',
  }, byPts);
  assert.equal(numDetail.QB.method, 'freeAgent');
  close(numDetail.QB.pts, 200);

  // Two rosters + an explicit force uses the wire anyway.
  const forced = replacementDetail(pool, league({
    rostered: new Set(['RB1', 'RB2']), method: 'freeAgent',
  }), byPts);
  assert.equal(forced.RB.method, 'freeAgent');
  assert.equal(forced.RB.playerAtRank.id, 'RB3');
});

test('free agent: a position with everyone rostered falls back to the rank baseline', () => {
  const pool = [
    ...ladder('QB', 20, 300, 5),
    ...ladder('RB', 60, 320, 3),
    ...ladder('WR', 60, 310, 3),
  ];
  const rostered = new Set([
    ...pool.filter((p) => p.pos === 'QB').map((p) => p.id),          // every QB is owned
    ...pool.filter((p) => p.pos === 'RB').slice(0, 50).map((p) => p.id),
    ...pool.filter((p) => p.pos === 'WR').slice(0, 40).map((p) => p.id),
  ]);
  const d = replacementDetail(pool, league({ rostered }), byPts);
  assert.equal(d.QB.freeAgents, 0);
  assert.equal(d.QB.method, 'rank');
  assert.equal(d.QB.playerAtRank.id, 'QB13');
  assert.equal(d.QB.freeAgentPts, null);
  assert.match(d.QB.note, /No unrostered QB/i);
  // Positions that do have free agents still use them.
  assert.equal(d.RB.method, 'freeAgent');
});

/* ==========================================================================
 * 2. The central claim: flex share is measured, and it moves with scoring.
 * ======================================================================== */

/**
 * A pool built so the flex block genuinely flips.
 *
 *   RB: heavy rushing volume, 20 receptions      -> PPR adds only 20
 *   WR: heavy receiving volume, up to 90 catches -> PPR adds up to 90
 *
 * In standard scoring the RB25-and-down block outscores the WR25-and-down block, so flex
 * fills with backs. Turn on full PPR and the receivers jump the line.
 */
function flexPool() {
  const out = [];
  for (let i = 0; i < 40; i++) {
    out.push({
      id: `RB${i + 1}`, pos: 'RB',
      ryd: 1200 - 20 * i, rtd: 8, rec: 20, reyd: 150, retd: 0,
    });
  }
  for (let i = 0; i < 40; i++) {
    out.push({
      id: `WR${i + 1}`, pos: 'WR',
      ryd: 0, rtd: 0, rec: 90 - 1.5 * i, reyd: 1200 - 22 * i, retd: 7,
    });
  }
  for (let i = 0; i < 20; i++) {
    out.push({
      id: `TE${i + 1}`, pos: 'TE',
      ryd: 0, rtd: 0, rec: 60 - 2 * i, reyd: 700 - 25 * i, retd: 4,
    });
  }
  return out;
}

/** Local scorer, so this test cannot be broken by another module. */
function scorerWithPPR(ppr) {
  return (p) => p.ryd * 0.1 + p.rtd * 6 + p.reyd * 0.1 + p.retd * 6 + p.rec * ppr;
}

test('flex share is empirical: full PPR puts WRs in flex where standard puts RBs', () => {
  const pool = flexPool();
  const lg = league();

  const std = replacementDetail(pool, lg, scorerWithPPR(0));
  const ppr = replacementDetail(pool, lg, scorerWithPPR(1));

  // Standard: the flex block is all running backs.
  assert.equal(std.RB.flexShare, 12);
  assert.equal(std.WR.flexShare, 0);
  assert.equal(std.TE.flexShare, 0);

  // Full PPR: receivers take half of it.
  assert.equal(ppr.WR.flexShare, 6);
  assert.equal(ppr.RB.flexShare, 6);
  assert.equal(ppr.TE.flexShare, 0);

  // The claim, stated directly.
  assert.ok(ppr.WR.flexShare > std.WR.flexShare,
    `full PPR should seat more WRs in flex (${ppr.WR.flexShare} vs ${std.WR.flexShare})`);
  assert.ok(ppr.RB.flexShare < std.RB.flexShare);

  // The block is fully allocated either way: 12 teams x 1 flex slot.
  const sum = (d) => d.QB.flexShare + d.RB.flexShare + d.WR.flexShare + d.TE.flexShare;
  assert.equal(sum(std), 12);
  assert.equal(sum(ppr), 12);
});

test('flex share propagates: starter counts and the replacement player both move', () => {
  const pool = flexPool();
  const lg = league();
  const std = replacementDetail(pool, lg, scorerWithPPR(0));
  const ppr = replacementDetail(pool, lg, scorerWithPPR(1));

  assert.equal(std.RB.starters, 36); // 24 dedicated + 12 flex
  assert.equal(std.WR.starters, 24); // 24 dedicated + 0 flex
  assert.equal(ppr.RB.starters, 30);
  assert.equal(ppr.WR.starters, 30);

  // Different scoring => a different player defines replacement level at WR.
  assert.equal(std.WR.playerAtRank.id, 'WR25');
  assert.equal(ppr.WR.playerAtRank.id, 'WR31');
  assert.equal(std.RB.playerAtRank.id, 'RB37');
  assert.equal(ppr.RB.playerAtRank.id, 'RB31');

  // Dedicated slots never move; only the measured share does.
  assert.equal(std.RB.dedicated, ppr.RB.dedicated);
  assert.equal(std.WR.flexCapacity, 12);
});

test('flex share moves the same way under the real scoring module (integration)', async (t) => {
  let scoring = null;
  try {
    scoring = await import('../app/js/scoring.js');
  } catch {
    t.skip('scoring.js not available');
    return;
  }
  const { scoreLine, PRESETS } = scoring;
  if (typeof scoreLine !== 'function' || !PRESETS || !PRESETS.fullPPR || !PRESETS.standard) {
    t.skip('scoring.js does not expose the contract surface yet');
    return;
  }

  const pool = flexPool();
  const lg = league();
  const ptsFull = (p) => scoreLine(p, PRESETS.fullPPR, p.pos);
  const ptsStd = (p) => scoreLine(p, PRESETS.standard, p.pos);

  const std = replacementDetail(pool, lg, ptsStd);
  const ppr = replacementDetail(pool, lg, ptsFull);

  assert.ok(ppr.WR.flexShare > std.WR.flexShare,
    `full PPR should seat more WRs in flex (${ppr.WR.flexShare} vs ${std.WR.flexShare})`);
  assert.equal(std.RB.flexShare, 12);
  assert.equal(ppr.WR.flexShare, 6);
  assert.equal(ppr.RB.flexShare, 6);

  // And the whole point: replacement level itself re-derives with no rebuild.
  const repStd = computeReplacement(pool, lg, ptsStd);
  const repPpr = computeReplacement(pool, lg, ptsFull);
  assert.ok(repPpr.WR > repStd.WR);
});

test('flex share respects multiple flex groups, narrowest first', () => {
  // A W/T slot alongside a FLEX slot. The W/T slot cannot take a back, so it draws from
  // WR/TE first, and only then does the open FLEX slot draw.
  const pool = [
    ...ladder('RB', 40, 300, 4),
    ...ladder('WR', 40, 290, 4),
    ...ladder('TE', 30, 200, 4),
  ];
  const d = replacementDetail(pool, {
    teams: 2, slots: { RB: 2, WR: 2, TE: 1, 'W/T': 1, FLEX: 1 },
  }, byPts);

  assert.equal(d.RB.dedicated, 4);
  assert.equal(d.WR.dedicated, 4);
  assert.equal(d.TE.dedicated, 2);
  // W/T capacity 2 + FLEX capacity 2 for WR; RB only sees the FLEX group.
  assert.equal(d.WR.flexCapacity, 4);
  assert.equal(d.RB.flexCapacity, 2);
  assert.equal(d.TE.flexCapacity, 4);
  const total = d.RB.flexShare + d.WR.flexShare + d.TE.flexShare;
  assert.equal(total, 4); // both groups fully allocated
  assert.ok(d.WR.flexShare >= 2, 'the WR/TE slot must be filled from WR or TE');
});

/* ==========================================================================
 * 3. QB compression: replacement sits at QB13, so elite QB VOR is small.
 * ======================================================================== */

function compressionPool() {
  return [
    ...ladder('QB', 30, 340, 5),    // flat: QB1 340, QB13 280
    ...ladder('RB', 60, 330, 6.3),  // steep
    ...ladder('WR', 60, 320, 5.1),  // steep
    ...ladder('TE', 30, 250, 8.7),
    ...ladder('K', 30, 140, 1.2),
    ...ladder('DST', 30, 130, 1.7),
  ];
}

test('QB compression: 12 teams x 1 QB puts replacement at QB13', () => {
  const pool = compressionPool();
  const d = replacementDetail(pool, league(), byPts);

  assert.equal(d.QB.dedicated, 12);
  assert.equal(d.QB.flexShare, 0);       // QB is not flex-eligible in this format
  assert.equal(d.QB.starters, 12);
  assert.equal(d.QB.rankUsed, 12);       // 0-indexed => the 13th QB
  assert.equal(d.QB.playerAtRank.id, 'QB13');
  assert.equal(d.QB.method, 'rank');
  close(d.QB.pts, 280);
});

test('QB compression: elite QB VOR is small next to elite RB/WR VOR', () => {
  const pool = compressionPool();
  const rep = computeReplacement(pool, league(), byPts);
  const find = (id) => pool.find((p) => p.id === id);

  const qb1 = vor(find('QB1'), rep, byPts);
  const rb1 = vor(find('RB1'), rep, byPts);
  const wr1 = vor(find('WR1'), rep, byPts);

  close(qb1, 60); // 340 - 280
  assert.ok(qb1 > 0, 'QB1 is still worth more than the streamer');
  assert.ok(rb1 > qb1, `RB1 VOR ${rb1} should beat QB1 VOR ${qb1}`);
  assert.ok(wr1 > qb1, `WR1 VOR ${wr1} should beat QB1 VOR ${qb1}`);

  // The replacement player himself is worth exactly zero, by definition.
  close(vor(find('QB13'), rep, byPts), 0);

  // And the raw-points instinct is the opposite of the VOR answer: QB1 outscores WR1
  // outright, yet is worth less. That inversion is the thing the module exists to price.
  assert.ok(find('QB1').pts > find('WR1').pts);
  assert.ok(qb1 < wr1);

  // K and DST compress hardest of all.
  const k1 = vor(find('K1'), rep, byPts);
  const dst1 = vor(find('DST1'), rep, byPts);
  assert.ok(k1 < qb1 && dst1 < qb1);
  assert.ok(k1 >= 0 && dst1 >= 0);
});

test('QB compression: superflex un-compresses it, endogenously', () => {
  const pool = compressionPool();
  const single = replacementDetail(pool, league(), byPts);
  const sf = replacementDetail(pool, {
    teams: 12,
    slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPERFLEX: 1, K: 1, DST: 1, BEN: 7 },
  }, byPts);

  // The superflex block fills with quarterbacks because they outscore the flex leftovers.
  assert.equal(sf.QB.flexShare, 12);
  assert.equal(sf.QB.starters, 24);
  assert.equal(sf.QB.playerAtRank.id, 'QB25');
  assert.ok(sf.QB.pts < single.QB.pts);

  // RB is eligible for both the FLEX and the SUPERFLEX group.
  assert.equal(sf.RB.flexCapacity, 24);
  assert.equal(single.RB.flexCapacity, 12);

  const qb1 = pool.find((p) => p.id === 'QB1');
  const vSingle = vor(qb1, computeReplacement(pool, league(), byPts), byPts);
  const vSuper = vor(qb1, computeReplacement(pool, {
    teams: 12,
    slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPERFLEX: 1, K: 1, DST: 1, BEN: 7 },
  }, byPts), byPts);
  assert.ok(vSuper > vSingle, 'QB1 is worth more when 24 QBs start instead of 12');
});

test('VOR ordering across positions is sane and matches the curve', () => {
  const pool = compressionPool();
  const rep = computeReplacement(pool, league(), byPts);
  const curve = vorCurve(pool, rep, byPts);

  for (const pos of POSITIONS) {
    const rows = curve[pos];
    assert.ok(Array.isArray(rows));
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].vor >= rows[i].vor, `${pos} curve must be sorted descending`);
      assert.equal(rows[i].rank, i + 1);
    }
    // The curve agrees with vor() player by player.
    for (const row of rows) close(row.vor, vor(row.player, rep, byPts));
    // Replacement level is where the curve crosses zero, within one player.
    const positives = rows.filter((r) => r.vor > 0).length;
    assert.ok(positives >= 1, `${pos} should have at least one player above replacement`);
  }

  // `drop` is the gap to the next player: the tier signal.
  const qb = curve.QB;
  close(qb[0].drop, qb[0].vor - qb[1].vor);
  close(qb[qb.length - 1].drop, 0);
});

/* ==========================================================================
 * 4. Degenerate input.
 * ======================================================================== */

test('degenerate: empty pool', () => {
  const rep = computeReplacement([], league(), byPts);
  assert.deepEqual(Object.keys(rep), POSITIONS.slice());
  for (const pos of POSITIONS) assert.equal(rep[pos], 0);

  const d = replacementDetail([], league(), byPts);
  for (const pos of POSITIONS) {
    assert.equal(d[pos].method, 'empty');
    assert.equal(d[pos].count, 0);
    assert.equal(d[pos].playerAtRank, null);
    assert.equal(d[pos].rankUsed, -1);
    assert.ok(d[pos].note.length > 0);
  }
  assert.deepEqual(vorCurve([], rep, byPts).QB, []);
});

test('degenerate: missing pool, league and scorer', () => {
  assert.deepEqual(computeReplacement(null, null, null), {
    QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0,
  });
  assert.deepEqual(computeReplacement(undefined, undefined, undefined), {
    QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0,
  });
  assert.deepEqual(computeReplacement('not a pool', 42, 'not a fn'), {
    QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0,
  });

  // No scorer => read `pts` off the player, which is what the pack-less UI path does.
  const pool = ladder('QB', 20, 300, 5);
  const rep = computeReplacement(pool, league());
  close(rep.QB, 300 - 5 * 12);

  // Junk entries are skipped, not fatal.
  const dirty = [null, undefined, 7, 'x', { pos: 'RB' }, ...ladder('RB', 30, 200, 2)];
  assert.doesNotThrow(() => computeReplacement(dirty, league(), byPts));
});

test('degenerate: position with fewer players than starters clamps to the tail', () => {
  const pool = [
    ...ladder('RB', 5, 200, 10),   // 5 backs, but 24+ start league-wide
    ...ladder('WR', 60, 300, 3),
    ...ladder('QB', 20, 300, 4),
  ];
  const d = replacementDetail(pool, league(), byPts);

  assert.ok(d.RB.starters > d.RB.count);
  assert.equal(d.RB.method, 'tail');
  assert.equal(d.RB.clamped, true);
  assert.equal(d.RB.rankUsed, 4);
  assert.equal(d.RB.playerAtRank.id, 'RB5');
  close(d.RB.pts, 160);
  assert.match(d.RB.note, /optimistic/i);

  // Every back is a starter somewhere, so nobody at the position is below replacement.
  const rep = computeReplacement(pool, league(), byPts);
  for (const p of pool.filter((x) => x.pos === 'RB')) {
    assert.ok(vor(p, rep, byPts) >= 0);
  }
  // Positions that are merely absent are 0, not NaN.
  assert.equal(d.K.pts, 0);
  assert.equal(d.DST.pts, 0);
});

test('degenerate: zero flex slots', () => {
  const pool = flexPool();
  const noFlex = { teams: 12, slots: { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DST: 1, BEN: 7 } };
  const zeroFlex = { teams: 12, slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 0, K: 1, DST: 1 } };

  for (const lg of [noFlex, zeroFlex]) {
    const d = replacementDetail(pool, lg, scorerWithPPR(1));
    for (const pos of POSITIONS) {
      assert.equal(d[pos].flexShare, 0);
      assert.equal(d[pos].flexCapacity, 0);
      assert.equal(d[pos].starters, d[pos].dedicated);
    }
    assert.equal(d.RB.starters, 24);
    assert.equal(d.RB.playerAtRank.id, 'RB25');
    assert.equal(d.WR.playerAtRank.id, 'WR25');
  }
});

test('degenerate: one-team league', () => {
  const pool = compressionPool();
  const d = replacementDetail(pool, { teams: 1, slots: LEAGUE_SLOTS }, byPts);

  assert.equal(d.QB.dedicated, 1);
  assert.equal(d.QB.starters, 1);
  assert.equal(d.QB.rankUsed, 1);
  assert.equal(d.QB.playerAtRank.id, 'QB2');
  assert.equal(d.RB.dedicated, 2);
  assert.equal(d.K.starters, 1);
  assert.equal(d.DST.playerAtRank.id, 'DST2');

  // Exactly one flex spot exists, so exactly one flex seat is allocated.
  const flexTotal = d.RB.flexShare + d.WR.flexShare + d.TE.flexShare;
  assert.equal(flexTotal, 1);

  // With one team, almost everyone is below replacement. That is correct, not a bug.
  const rep = computeReplacement(pool, { teams: 1, slots: LEAGUE_SLOTS }, byPts);
  assert.ok(vor(pool.find((p) => p.id === 'QB1'), rep, byPts) > 0);
  assert.ok(vor(pool.find((p) => p.id === 'QB5'), rep, byPts) < 0);
});

test('degenerate: absurd team counts fall back to the default league size', () => {
  const pool = compressionPool();
  const base = replacementDetail(pool, league({ teams: DEFAULT_LEAGUE.teams }), byPts).QB.pts;
  for (const teams of [0, -3, NaN, 'abc', null, undefined, Infinity]) {
    const d = replacementDetail(pool, { teams, slots: LEAGUE_SLOTS }, byPts);
    close(d.QB.pts, base, 1e-9);
  }
  // A fractional count floors rather than producing a fractional rank.
  const frac = replacementDetail(pool, { teams: 10.7, slots: LEAGUE_SLOTS }, byPts);
  assert.equal(frac.QB.starters, 10);
  assert.equal(Number.isInteger(frac.RB.starters), true);

  // No slots at all: nothing starts, so replacement is the best player at the position.
  const none = replacementDetail(pool, { teams: 12, slots: {} }, byPts);
  assert.equal(none.QB.starters, 0);
  assert.equal(none.QB.playerAtRank.id, 'QB1');
  // The default is the user's own league, so a partial `league` object prices the league
  // they actually play in rather than a generic twelve-team one.
  assert.equal(DEFAULT_LEAGUE.teams, 8);
});

test('degenerate: duplicate ids, missing positions, and non-finite projections', () => {
  const dup = [
    { id: 'RB1', pos: 'RB', pts: 300 },
    { id: 'RB1', pos: 'RB', pts: 999 },  // dropped: first occurrence wins
    { id: 'RB2', pos: 'RB', pts: 200 },
    { id: 'X1', pts: 500 },              // no position => no replacement level
    { id: 'X2', pos: '', pts: 500 },
  ];
  const d = replacementDetail(dup, { teams: 1, slots: { RB: 1 } }, byPts);
  assert.equal(d.RB.count, 2);
  assert.equal(d.RB.playerAtRank.id, 'RB2');
  assert.equal(Object.keys(d).join(','), POSITIONS.join(','));

  // Non-finite scores are 0, never NaN.
  const wild = ladder('WR', 20, 100, 1);
  const rep = computeReplacement(wild, league(), () => NaN);
  assert.equal(rep.WR, 0);
  const inf = computeReplacement(wild, league(), (p) => (p.id === 'WR1' ? Infinity : p.pts));
  assert.ok(Number.isFinite(inf.WR));
  assert.ok(Number.isFinite(vor({ pos: 'WR', pts: 1 }, { WR: NaN }, byPts)));
});

test('degenerate: alternate position spellings normalize', () => {
  const pool = [
    { id: 'd1', pos: 'D/ST', pts: 130 },
    { id: 'd2', pos: 'def', pts: 120 },
    { id: 'd3', pos: 'DST', pts: 110 },
    { id: 'k1', pos: 'PK', pts: 150 },
    { id: 'k2', pos: 'K', pts: 140 },
  ];
  const d = replacementDetail(pool, { teams: 2, slots: { K: 1, 'D/ST': 1 } }, byPts);
  assert.equal(d.DST.count, 3);
  assert.equal(d.DST.dedicated, 2);
  assert.equal(d.DST.playerAtRank.id, 'd3');
  assert.equal(d.K.count, 2);
  assert.equal(d.K.dedicated, 2);
  assert.equal(d.K.clamped, true);
});

test('degenerate: non-canonical positions get their own baseline, canonical six always present', () => {
  const pool = [
    ...ladder('QB', 5, 300, 5),
    ...ladder('LB', 20, 200, 4),
    ...ladder('DL', 20, 190, 4),
  ];
  const d = replacementDetail(pool, { teams: 4, slots: { QB: 1, LB: 2, DL: 2 } }, byPts);
  const keys = Object.keys(d);
  assert.deepEqual(keys.slice(0, 6), POSITIONS.slice());
  assert.ok(keys.includes('LB') && keys.includes('DL'));
  assert.equal(d.LB.dedicated, 8);
  assert.equal(d.LB.playerAtRank.id, 'LB9');
  assert.equal(d.WR.method, 'empty');
});

/* ==========================================================================
 * vor() / vorCurve() surface
 * ======================================================================== */

test('vor: basics, flat overrides, and unknown positions', () => {
  const rep = { QB: 250, RB: 120, WR: 110, TE: 90, K: 100, DST: 95 };
  close(vor({ id: 'a', pos: 'QB', pts: 310 }, rep, byPts), 60);
  close(vor({ id: 'a', pos: 'RB', pts: 100 }, rep, byPts), -20);

  // A flat number is accepted for a manual, single-value override.
  close(vor({ id: 'a', pos: 'RB', pts: 100 }, 40, byPts), 60);

  // Unknown or absent position: replacement is 0, never another position's baseline.
  close(vor({ id: 'a', pos: 'FB', pts: 75 }, rep, byPts), 75);
  close(vor({ id: 'a', pts: 75 }, rep, byPts), 75);

  // Junk in, zero out.
  assert.equal(vor(null, rep, byPts), 0);
  assert.equal(vor(undefined, rep, byPts), 0);
  assert.equal(vor({ pos: 'QB', pts: 300 }, null, byPts), 300);
  assert.equal(vor({ pos: 'QB', pts: 300 }), 300); // default scorer

  // Float dust does not leak into the UI.
  assert.equal(vor({ pos: 'RB', pts: 0.1 + 0.2 }, { RB: 0.3 }, byPts), 0);
});

test('vorCurve: shape, sorting, drops and flat replacement', () => {
  const pool = [...ladder('RB', 5, 200, 10), ...ladder('WR', 3, 150, 5)];
  const curve = vorCurve(pool, { RB: 160, WR: 140 }, byPts);

  assert.deepEqual(Object.keys(curve), POSITIONS.slice());
  assert.equal(curve.RB.length, 5);
  assert.equal(curve.TE.length, 0);

  const rb = curve.RB;
  assert.deepEqual(rb.map((r) => r.id), ['RB1', 'RB2', 'RB3', 'RB4', 'RB5']);
  assert.deepEqual(rb.map((r) => r.vor), [40, 30, 20, 10, 0]);
  assert.deepEqual(rb.map((r) => r.rank), [1, 2, 3, 4, 5]);
  assert.deepEqual(rb.map((r) => r.drop), [10, 10, 10, 10, 0]);
  assert.equal(rb[0].name, 'RB 1');
  assert.equal(rb[0].player, pool[0]);
  assert.equal(rb[0].pos, 'RB');

  // A flat number applies to every position.
  const flat = vorCurve(pool, 100, byPts);
  close(flat.RB[0].vor, 100);
  close(flat.WR[0].vor, 50);

  // Missing replacement entry => VOR is the raw projection.
  const bare = vorCurve(pool, {}, byPts);
  close(bare.RB[0].vor, 200);
});

test('vorCurve: a tier cliff shows up as a large drop', () => {
  const pool = [
    { id: 'e1', pos: 'RB', pts: 300 },
    { id: 'e2', pos: 'RB', pts: 296 },
    { id: 'e3', pos: 'RB', pts: 292 },
    { id: 'm1', pos: 'RB', pts: 210 },  // cliff
    { id: 'm2', pos: 'RB', pts: 207 },
  ];
  const rows = vorCurve(pool, { RB: 150 }, byPts).RB;
  const cliff = rows.findIndex((r) => r.drop > 50);
  assert.equal(cliff, 2);
  assert.equal(rows[cliff].id, 'e3');
});

/* ==========================================================================
 * Determinism, purity and the user override
 * ======================================================================== */

test('output is a function of the player set, not the input order', () => {
  const pool = universe();
  const lg = league({ rostered: new Set(rosteredIds()) });
  const a = computeReplacement(pool, lg, byPts);
  const b = computeReplacement(shuffle(pool), lg, byPts);
  assert.deepEqual(b, a);

  // Ties break deterministically too.
  const tied = [
    { id: 'z', pos: 'RB', pts: 100 }, { id: 'a', pos: 'RB', pts: 100 },
    { id: 'm', pos: 'RB', pts: 100 }, { id: 'b', pos: 'RB', pts: 50 },
  ];
  const d1 = replacementDetail(tied, { teams: 1, slots: { RB: 1 } }, byPts);
  const d2 = replacementDetail(shuffle(tied), { teams: 1, slots: { RB: 1 } }, byPts);
  assert.equal(d1.RB.playerAtRank.id, d2.RB.playerAtRank.id);
  assert.equal(d1.RB.playerAtRank.id, 'm'); // a, m, z sorted by id => index 1 is 'm'
});

test('ptsOf is called exactly once per deduped player and the pool is never mutated', () => {
  const pool = [...ladder('RB', 10, 200, 5), { id: 'RB1', pos: 'RB', pts: 999 }];
  const snapshot = JSON.stringify(pool);
  const calls = new Map();
  const counting = (p) => { calls.set(p.id, (calls.get(p.id) || 0) + 1); return p.pts; };

  replacementDetail(pool, league(), counting);
  assert.equal(calls.size, 10);
  for (const [, n] of calls) assert.equal(n, 1);
  assert.equal(JSON.stringify(pool), snapshot);
});

test('user override wins but is labeled, and the computed baseline is still reported', () => {
  const pool = compressionPool();
  const d = replacementDetail(pool, league({ override: { QB: 999 } }), byPts);
  assert.equal(d.QB.method, 'override');
  close(d.QB.pts, 999);
  close(d.QB.rankPts, 280);          // what the tool would have said
  assert.match(d.QB.note, /override/i);
  assert.equal(d.RB.method, 'rank'); // other positions untouched

  const rep = computeReplacement(pool, league({ override: { QB: 999 } }), byPts);
  assert.equal(rep.QB, 999);
  assert.ok(vor(pool.find((p) => p.id === 'QB1'), rep, byPts) < 0);

  // A junk override is ignored rather than poisoning the answer.
  const junk = replacementDetail(pool, league({ override: { QB: 'lots' } }), byPts);
  assert.equal(junk.QB.method, 'rank');
});

test('every detail row is flagged inferred, per the honesty rules', () => {
  const d = replacementDetail(universe(), league({ rostered: new Set(rosteredIds()) }), byPts);
  for (const pos of Object.keys(d)) {
    assert.equal(d[pos].inferred, true);
    assert.equal(d[pos].pos, pos);
    assert.ok(typeof d[pos].note === 'string' && d[pos].note.length > 0);
    assert.ok(Number.isFinite(d[pos].pts));
  }
});
