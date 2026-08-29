import test from 'node:test';
import assert from 'node:assert/strict';

import { optimizeLineup, slotsFromCounts, SLOT_ALIASES } from '../app/js/lineup.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const pts = (p) => p.pts;

let _uid = 0;
function mk(pos, ptsVal, id) {
  _uid += 1;
  return { id: id === undefined ? `p${_uid}` : id, name: `${pos}${_uid}`, pos, pts: ptsVal };
}

function slot(id, eligible) {
  return { id, eligible };
}

/** Deterministic LCG. No Math.random — random tests must be reproducible. */
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Independent reference implementation: exhaustive search over every injective
 * slot -> (player | empty) assignment. Objective mirrors the solver's documented
 * contract: maximize filled slots first, then points.
 *
 * Deliberately does NOT share any code with lineup.js — eligibility is a plain
 * `includes` on exact position strings, so the cross-check is genuinely independent.
 */
function brute(players, slots, ptsOf, allowNegative) {
  const n = slots.length;
  const used = new Array(players.length).fill(false);
  let bestFilled = -1;
  let bestTotal = -Infinity;

  const rec = (i, filled, total) => {
    if (i === n) {
      if (filled > bestFilled || (filled === bestFilled && total > bestTotal + 1e-12)) {
        bestFilled = filled;
        bestTotal = total;
      }
      return;
    }
    rec(i + 1, filled, total); // leave slot i empty
    const el = slots[i].eligible;
    for (let k = 0; k < players.length; k++) {
      if (used[k]) continue;
      if (!el.includes(players[k].pos)) continue;
      const v = ptsOf(players[k]);
      if (!allowNegative && v < 0) continue;
      used[k] = true;
      rec(i + 1, filled + 1, total + v);
      used[k] = false;
    }
  };
  rec(0, 0, 0);
  return { filled: bestFilled, total: bestTotal };
}

/** The greedy the contract warns about: dedicated slots first, then flex, best-first. */
function greedy(players, slots, ptsOf) {
  const pool = players.slice().sort((a, b) => ptsOf(b) - ptsOf(a));
  const taken = new Set();
  const order = slots
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.eligible.length - b.s.eligible.length) || (a.i - b.i));
  let total = 0;
  for (const { s } of order) {
    for (const p of pool) {
      if (taken.has(p)) continue;
      if (!s.eligible.includes(p.pos)) continue;
      taken.add(p);
      total += ptsOf(p);
      break;
    }
  }
  return total;
}

/** Structural invariants every result must satisfy. */
function checkShape(res, slots, roster) {
  assert.equal(res.assignments.length, slots.length);
  const seen = new Set();
  let sum = 0;
  let filled = 0;
  res.assignments.forEach((a, i) => {
    assert.equal(a.slotIndex, i);
    assert.equal(typeof a.slot, 'string');
    assert.equal(typeof a.pts, 'number');
    if (a.player === null) {
      assert.equal(a.pts, 0);
    } else {
      assert.ok(!seen.has(a.player), 'player started twice');
      seen.add(a.player);
      const el = res.assignments[i].slotDef.eligible;
      if (Array.isArray(el)) assert.ok(el.includes(a.player.pos), `${a.player.pos} not eligible for ${a.slot}`);
      sum += a.pts;
      filled += 1;
    }
  });
  assert.ok(Math.abs(sum - res.total) < 1e-9, 'total != sum of assignments');
  assert.equal(res.filled, filled);
  for (const b of res.benched) assert.ok(!seen.has(b), 'benched player is also started');
  if (roster) assert.equal(seen.size + res.benched.length, roster.length);
}

// ---------------------------------------------------------------------------
// 1. The greedy-breaker. This is the reason the module exists.
// ---------------------------------------------------------------------------

test('non-laminar flex: W/T + R/W with WR 20, TE 10, RB 9 -> 30, not greedy 29', () => {
  const slots = [slot('WRT', ['WR', 'TE']), slot('RBWR', ['RB', 'WR'])];
  const wr = mk('WR', 20);
  const te = mk('TE', 10);
  const rb = mk('RB', 9);
  const roster = [wr, te, rb];

  // Greedy strands the R/W slot with the RB.
  assert.equal(greedy(roster, slots, pts), 29);

  const res = optimizeLineup(roster, slots, pts);
  checkShape(res, slots, roster);
  assert.equal(res.total, 30);
  assert.equal(res.assignments[0].player, te, 'W/T must take the TE');
  assert.equal(res.assignments[1].player, wr, 'R/W must take the WR');
  assert.deepEqual(res.benched, [rb]);

  // Same answer whatever order the roster arrives in.
  for (const order of [[te, rb, wr], [rb, wr, te], [wr, rb, te]]) {
    assert.equal(optimizeLineup(order, slots, pts).total, 30);
  }
  // ...and whatever order the slots are declared in.
  assert.equal(optimizeLineup(roster, [slots[1], slots[0]], pts).total, 30);
});

test('non-laminar flex survives slotsFromCounts', () => {
  const slots = slotsFromCounts({ WRT: 1, RBWR: 1 });
  assert.deepEqual(slots.map((s) => s.id), ['WRT', 'RBWR']);
  assert.deepEqual(slots[0].eligible, ['WR', 'TE']);
  assert.deepEqual(slots[1].eligible, ['RB', 'WR']);
  const roster = [mk('WR', 20), mk('TE', 10), mk('RB', 9)];
  assert.equal(optimizeLineup(roster, slots, pts).total, 30);
});

test('three-deep chain of overlapping flexes', () => {
  // QB/RB, RB/WR, WR/TE with one player of each position: only one perfect matching.
  const slots = [slot('A', ['QB', 'RB']), slot('B', ['RB', 'WR']), slot('C', ['WR', 'TE'])];
  const qb = mk('QB', 1);
  const rb = mk('RB', 30);
  const wr = mk('WR', 2);
  const te = mk('TE', 3);
  const res = optimizeLineup([qb, rb, wr, te], slots, pts);
  checkShape(res, slots, [qb, rb, wr, te]);
  // Taking the RB in slot B (its "natural" flex) caps the lineup at 34. Pushing it up to
  // slot A frees WR->B and TE->C for 35.
  assert.equal(res.total, 35);
  assert.equal(res.assignments[0].player, rb);
  assert.equal(res.assignments[1].player, wr);
  assert.equal(res.assignments[2].player, te);
  assert.deepEqual(res.benched, [qb]);
  assert.equal(brute([qb, rb, wr, te], slots, pts, true).total, 35);
});

// ---------------------------------------------------------------------------
// 2. Brute-force cross-check — the most important test in the file.
// ---------------------------------------------------------------------------

test('exact solver matches exhaustive search on 200 random rosters (both modes)', () => {
  const rand = rng(20260829);
  const POSSETS = [
    ['QB'], ['RB'], ['WR'], ['TE'], ['K'], ['DST'],
    ['RB', 'WR', 'TE'], ['WR', 'TE'], ['RB', 'WR'], ['QB', 'RB', 'WR', 'TE'],
    ['TE', 'K'], ['QB', 'TE'],
  ];
  const POSES = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];

  let compared = 0;
  for (let caseNo = 0; caseNo < 200; caseNo++) {
    const nP = 1 + Math.floor(rand() * 6);   // 1..6 players
    const nS = 1 + Math.floor(rand() * 4);   // 1..4 slots

    const roster = [];
    for (let i = 0; i < nP; i++) {
      const pos = POSES[Math.floor(rand() * POSES.length)];
      // ~25% negative, occasional exact zero, otherwise 0..30 at one decimal
      const r = rand();
      let v;
      if (r < 0.25) v = -Math.round(rand() * 80) / 10;
      else if (r < 0.32) v = 0;
      else v = Math.round(rand() * 300) / 10;
      roster.push({ id: `c${caseNo}_${i}`, pos, pts: v });
    }
    const slots = [];
    for (let i = 0; i < nS; i++) {
      slots.push({ id: `s${i}`, eligible: POSSETS[Math.floor(rand() * POSSETS.length)] });
    }

    for (const allowNegative of [true, false]) {
      const exact = optimizeLineup(roster, slots, pts, { allowNegative });
      const ref = brute(roster, slots, pts, allowNegative);
      checkShape(exact, slots, roster);
      assert.equal(
        exact.filled, ref.filled,
        `case ${caseNo} allowNegative=${allowNegative}: filled ${exact.filled} != ${ref.filled}\n` +
        JSON.stringify({ roster, slots }),
      );
      assert.ok(
        Math.abs(exact.total - ref.total) < 1e-9,
        `case ${caseNo} allowNegative=${allowNegative}: total ${exact.total} != ${ref.total}\n` +
        JSON.stringify({ roster, slots }),
      );
      compared++;
    }
  }
  assert.equal(compared, 400);
});

test('exact solver matches exhaustive search on flex-heavy rosters', () => {
  // Narrower generator: every slot is an overlapping flex, which is where greedy dies.
  const rand = rng(777);
  const FLEXES = [['RB', 'WR', 'TE'], ['WR', 'TE'], ['RB', 'WR'], ['QB', 'RB', 'WR', 'TE'], ['QB', 'RB']];
  const POSES = ['QB', 'RB', 'WR', 'TE'];
  let greedyLost = 0;

  for (let caseNo = 0; caseNo < 150; caseNo++) {
    const nP = 2 + Math.floor(rand() * 5);
    const nS = 2 + Math.floor(rand() * 3);
    const roster = [];
    for (let i = 0; i < nP; i++) {
      roster.push({ id: `f${caseNo}_${i}`, pos: POSES[Math.floor(rand() * 4)], pts: Math.round(rand() * 250) / 10 });
    }
    const slots = [];
    for (let i = 0; i < nS; i++) slots.push({ id: `s${i}`, eligible: FLEXES[Math.floor(rand() * FLEXES.length)] });

    const exact = optimizeLineup(roster, slots, pts);
    const ref = brute(roster, slots, pts, true);
    checkShape(exact, slots, roster);
    assert.equal(exact.filled, ref.filled);
    assert.ok(Math.abs(exact.total - ref.total) < 1e-9,
      `flex case ${caseNo}: ${exact.total} != ${ref.total}\n${JSON.stringify({ roster, slots })}`);

    const g = greedy(roster, slots, pts);
    assert.ok(g <= exact.total + 1e-9, 'greedy beat the exact solver — impossible');
    if (g < exact.total - 1e-9) greedyLost += 1;
  }
  // Sanity check that the generator actually produces cases greedy gets wrong.
  assert.ok(greedyLost > 0, 'generator produced no greedy-breaking cases');
});

// ---------------------------------------------------------------------------
// 3. Negative players and empty slots
// ---------------------------------------------------------------------------

test('allowNegative default true: a negative DST still starts rather than leaving the slot empty', () => {
  const slots = [slot('DST', ['DST'])];
  const bad = mk('DST', -3);
  const res = optimizeLineup([bad], slots, pts);
  assert.equal(res.assignments[0].player, bad);
  assert.equal(res.total, -3);
  assert.equal(res.filled, 1);
  assert.deepEqual(res.benched, []);
});

test('allowNegative false: the slot is left empty and scores 0', () => {
  const slots = [slot('DST', ['DST'])];
  const bad = mk('DST', -3);
  const res = optimizeLineup([bad], slots, pts, { allowNegative: false });
  assert.equal(res.assignments[0].player, null);
  assert.equal(res.assignments[0].pts, 0);
  assert.equal(res.total, 0);
  assert.equal(res.filled, 0);
  assert.deepEqual(res.benched, [bad]);
});

test('a negative player never displaces a positive one', () => {
  const slots = [slot('K', ['K'])];
  const bad = mk('K', -1);
  const good = mk('K', 8);
  const res = optimizeLineup([bad, good], slots, pts);
  assert.equal(res.assignments[0].player, good);
  assert.equal(res.total, 8);
  assert.deepEqual(res.benched, [bad]);
});

test('negatives fill only the slots positives cannot reach', () => {
  const slots = [slot('FLEX', ['RB', 'WR', 'TE']), slot('FLEX', ['RB', 'WR', 'TE'])];
  const wr = mk('WR', 12);
  const rb = mk('RB', -4);
  const res = optimizeLineup([wr, rb], slots, pts);
  assert.equal(res.filled, 2);
  assert.equal(res.assignments[0].player, wr);
  assert.equal(res.assignments[1].player, rb);
  assert.ok(Math.abs(res.total - 8) < 1e-9);

  const off = optimizeLineup([wr, rb], slots, pts, { allowNegative: false });
  assert.equal(off.filled, 1);
  assert.equal(off.total, 12);
  assert.deepEqual(off.benched, [rb]);
});

test('all-negative roster: cardinality first picks the least-bad set', () => {
  const slots = [slot('DST', ['DST'])];
  const a = mk('DST', -7);
  const b = mk('DST', -1);
  const c = mk('DST', -4);
  const res = optimizeLineup([a, b, c], slots, pts);
  assert.equal(res.assignments[0].player, b);
  assert.equal(res.total, -1);
});

test('zero-point players are started rather than benched (0 == empty, filling is the tiebreak)', () => {
  const slots = [slot('K', ['K'])];
  const z = mk('K', 0);
  for (const opts of [undefined, { allowNegative: false }]) {
    const res = optimizeLineup([z], slots, pts, opts);
    assert.equal(res.assignments[0].player, z);
    assert.equal(res.total, 0);
    assert.equal(res.filled, 1);
  }
});

// ---------------------------------------------------------------------------
// 4. Degenerate shapes
// ---------------------------------------------------------------------------

test('zero slots: everyone is benched, total 0', () => {
  const roster = [mk('QB', 25), mk('RB', 18)];
  const res = optimizeLineup(roster, [], pts);
  assert.deepEqual(res.assignments, []);
  assert.equal(res.total, 0);
  assert.equal(res.filled, 0);
  assert.deepEqual(res.benched, roster);
});

test('empty roster: every slot is empty, total 0', () => {
  const slots = slotsFromCounts({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 });
  const res = optimizeLineup([], slots, pts);
  assert.equal(res.assignments.length, 9);
  assert.ok(res.assignments.every((a) => a.player === null && a.pts === 0));
  assert.equal(res.total, 0);
  assert.equal(res.filled, 0);
  assert.deepEqual(res.benched, []);
});

test('fewer players than slots: fills what it can, leaves the rest empty', () => {
  const slots = slotsFromCounts({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 });
  const qb = mk('QB', 22);
  const rb = mk('RB', 14);
  const roster = [qb, rb];
  const res = optimizeLineup(roster, slots, pts);
  checkShape(res, slots, roster);
  assert.equal(res.filled, 2);
  assert.equal(res.total, 36);
  assert.equal(res.assignments.filter((a) => a.player === null).length, 7);
  assert.deepEqual(res.benched, []);
});

test('more slots than eligible players at a position', () => {
  const slots = [slot('RB', ['RB']), slot('RB', ['RB']), slot('RB', ['RB'])];
  const rb = mk('RB', 11);
  const wr = mk('WR', 30);
  const res = optimizeLineup([rb, wr], slots, pts);
  checkShape(res, slots, [rb, wr]);
  assert.equal(res.filled, 1);
  assert.equal(res.total, 11);
  assert.deepEqual(res.benched, [wr], 'an ineligible WR stays benched no matter how big');
});

test('no eligible player anywhere leaves the whole lineup empty', () => {
  const slots = [slot('K', ['K']), slot('DST', ['DST'])];
  const roster = [mk('WR', 40), mk('RB', 35)];
  const res = optimizeLineup(roster, slots, pts);
  assert.equal(res.total, 0);
  assert.equal(res.filled, 0);
  assert.deepEqual(res.benched, roster);
});

test('slot with an empty eligible list accepts nobody; missing eligible accepts anybody', () => {
  const roster = [mk('WR', 12)];
  assert.equal(optimizeLineup(roster, [slot('X', [])], pts).filled, 0);
  assert.equal(optimizeLineup(roster, [{ id: 'ANY' }], pts).total, 12);
  assert.equal(optimizeLineup(roster, [slot('ANY', ['*'])], pts).total, 12);
});

test('null/undefined entries in the roster are ignored', () => {
  const wr = mk('WR', 9);
  const res = optimizeLineup([null, wr, undefined], [slot('WR', ['WR'])], pts);
  assert.equal(res.total, 9);
  assert.deepEqual(res.benched, []);
});

test('non-array inputs degrade safely; a non-function ptsOf throws', () => {
  assert.deepEqual(optimizeLineup(null, null, pts), { assignments: [], total: 0, benched: [], filled: 0 });
  assert.equal(optimizeLineup(undefined, [slot('QB', ['QB'])], pts).total, 0);
  assert.throws(() => optimizeLineup([], [], null), TypeError);
});

test('non-finite ptsOf results are treated as 0', () => {
  const slots = [slot('QB', ['QB'])];
  const q = { id: 'q', pos: 'QB' };
  const res = optimizeLineup([q], slots, () => NaN);
  assert.equal(res.total, 0);
  assert.equal(res.assignments[0].player, q);
  assert.equal(optimizeLineup([q], slots, () => undefined).total, 0);
});

// ---------------------------------------------------------------------------
// 5. Dedupe
// ---------------------------------------------------------------------------

test('duplicate ids are deduped, first occurrence wins', () => {
  const slots = [slot('RB', ['RB']), slot('RB', ['RB'])];
  const a = { id: 'x', pos: 'RB', pts: 10 };
  const dupe = { id: 'x', pos: 'RB', pts: 999 };
  const b = { id: 'y', pos: 'RB', pts: 7 };
  const res = optimizeLineup([a, dupe, b], slots, pts);
  assert.equal(res.total, 17, 'the 999-point duplicate must not be startable');
  assert.equal(res.assignments[0].player, a);
  assert.equal(res.assignments[1].player, b);
  assert.deepEqual(res.benched, [], 'the dropped duplicate is not benched either');
});

test('the same object twice is deduped even without an id', () => {
  const p = { pos: 'RB', pts: 10 };
  const res = optimizeLineup([p, p], [slot('RB', ['RB']), slot('RB', ['RB'])], pts);
  assert.equal(res.total, 10);
  assert.equal(res.filled, 1);
});

test('distinct id-less players are all kept', () => {
  const res = optimizeLineup(
    [{ pos: 'RB', pts: 10 }, { pos: 'RB', pts: 7 }],
    [slot('RB', ['RB']), slot('RB', ['RB'])], pts,
  );
  assert.equal(res.total, 17);
  assert.equal(res.filled, 2);
});

test('ptsOf is called exactly once per distinct player', () => {
  const roster = [{ id: 'a', pos: 'WR', pts: 5 }, { id: 'a', pos: 'WR', pts: 5 }, { id: 'b', pos: 'WR', pts: 6 }];
  let calls = 0;
  const counting = (p) => { calls += 1; return p.pts; };
  optimizeLineup(roster, slotsFromCounts({ WR: 2, FLEX: 1 }), counting);
  assert.equal(calls, 2);
});

// ---------------------------------------------------------------------------
// 6. slotsFromCounts
// ---------------------------------------------------------------------------

test('slotsFromCounts: the standard league shape', () => {
  const slots = slotsFromCounts({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 });
  assert.deepEqual(slots.map((s) => s.id), ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DST']);
  assert.deepEqual(slots[6].eligible, ['RB', 'WR', 'TE']);
  assert.deepEqual(slots[0].eligible, ['QB']);
});

test('slotsFromCounts: flex aliases', () => {
  const el = (k) => slotsFromCounts({ [k]: 1 })[0].eligible;
  assert.deepEqual(el('FLEX'), ['RB', 'WR', 'TE']);
  assert.deepEqual(el('WRT'), ['WR', 'TE']);
  assert.deepEqual(el('RBWR'), ['RB', 'WR']);
  assert.deepEqual(el('SUPERFLEX'), ['QB', 'RB', 'WR', 'TE']);
  assert.deepEqual(el('OP'), ['QB', 'RB', 'WR', 'TE']);
  assert.deepEqual(el('SUPER_FLEX'), ['QB', 'RB', 'WR', 'TE']);
  assert.deepEqual(el('REC_FLEX'), ['WR', 'TE']);
  assert.deepEqual(el('D/ST'), ['DST']);
  assert.deepEqual(el('DEF'), ['DST']);
  assert.deepEqual(el('flex'), ['RB', 'WR', 'TE']);
});

test('slotsFromCounts: slash lists split before the alias table (W/R/T is Yahoo flex)', () => {
  assert.deepEqual(slotsFromCounts({ 'W/R/T': 1 })[0].eligible, ['WR', 'RB', 'TE']);
  assert.deepEqual(slotsFromCounts({ 'WR/TE': 1 })[0].eligible, ['WR', 'TE']);
  assert.deepEqual(slotsFromCounts({ 'Q/W/R/T': 1 })[0].eligible, ['QB', 'WR', 'RB', 'TE']);
});

test('slotsFromCounts: IDP passthrough, and IDP flex aliases', () => {
  const slots = slotsFromCounts({ DL: 2, LB: 3, DB: 3 });
  assert.deepEqual(slots.map((s) => s.id), ['DL', 'DL', 'LB', 'LB', 'LB', 'DB', 'DB', 'DB']);
  assert.deepEqual(slots[0].eligible, ['DL']);
  assert.deepEqual(slotsFromCounts({ IDP_FLEX: 1 })[0].eligible, ['DL', 'LB', 'DB']);
  assert.deepEqual(slotsFromCounts({ DP: 1 })[0].eligible, ['DL', 'LB', 'DB']);
  // Anything unrecognized passes through as its own position.
  assert.deepEqual(slotsFromCounts({ EDGE: 1 })[0].eligible, ['EDGE']);
});

test('slotsFromCounts: IDP slots actually solve', () => {
  const slots = slotsFromCounts({ DL: 1, LB: 1, IDP_FLEX: 1 });
  const dl = mk('DL', 9);
  const lb1 = mk('LB', 14);
  const lb2 = mk('LB', 12);
  const res = optimizeLineup([dl, lb1, lb2], slots, pts);
  checkShape(res, slots, [dl, lb1, lb2]);
  assert.equal(res.total, 35);
});

test('slotsFromCounts: bench and IR spots are skipped, non-positive counts ignored', () => {
  const slots = slotsFromCounts({ QB: 1, BN: 7, IR: 2, TAXI: 3, RB: 0, WR: -1, TE: 1 });
  assert.deepEqual(slots.map((s) => s.id), ['QB', 'TE']);
});

test('slotsFromCounts: canonical order regardless of key order, and unknowns keep input order', () => {
  const a = slotsFromCounts({ DST: 1, FLEX: 1, QB: 1 });
  assert.deepEqual(a.map((s) => s.id), ['QB', 'FLEX', 'DST']);
  const b = slotsFromCounts({ ZZZ: 1, AAA: 1 });
  assert.deepEqual(b.map((s) => s.id), ['ZZZ', 'AAA']);
});

test('slotsFromCounts: bad input returns an empty array; each slot gets its own eligible array', () => {
  assert.deepEqual(slotsFromCounts(null), []);
  assert.deepEqual(slotsFromCounts(undefined), []);
  assert.deepEqual(slotsFromCounts('QB'), []);
  const s = slotsFromCounts({ FLEX: 2 });
  assert.notEqual(s[0].eligible, s[1].eligible);
  assert.notEqual(s[0].eligible, SLOT_ALIASES.FLEX, 'must not hand out the shared alias array');
});

test('slots may be given as bare strings', () => {
  const roster = [mk('QB', 25), mk('RB', 12), mk('WR', 18)];
  const res = optimizeLineup(roster, ['QB', 'FLEX'], pts);
  assert.equal(res.assignments[0].slot, 'QB');
  assert.equal(res.assignments[1].slot, 'FLEX');
  assert.equal(res.total, 43);
});

// ---------------------------------------------------------------------------
// 7. Position normalization
// ---------------------------------------------------------------------------

test('positions and eligibility are normalized (D/ST, def, PK, case)', () => {
  const dst = { id: 'd', pos: 'D/ST', pts: 11 };
  const k = { id: 'k', pos: 'pk', pts: 8 };
  const slots = [slot('DST', ['DEF']), slot('K', ['K'])];
  const res = optimizeLineup([dst, k], slots, pts);
  assert.equal(res.total, 19);
  assert.equal(res.assignments[0].player, dst);
  assert.equal(res.assignments[1].player, k);
});

test('`position` is accepted as a fallback for `pos`', () => {
  const wr = { id: 'w', position: 'WR', pts: 15 };
  assert.equal(optimizeLineup([wr], [slot('WR', ['WR'])], pts).total, 15);
});

// ---------------------------------------------------------------------------
// 8. Realistic full-PPR lineup, and determinism
// ---------------------------------------------------------------------------

test('realistic roster in the user league shape', () => {
  const slots = slotsFromCounts({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 });
  const roster = [
    mk('QB', 21.4), mk('QB', 17.9),
    mk('RB', 19.2), mk('RB', 13.6), mk('RB', 11.1), mk('RB', 6.4),
    mk('WR', 22.8), mk('WR', 16.5), mk('WR', 15.9), mk('WR', 9.2),
    mk('TE', 12.7), mk('TE', 5.5),
    mk('K', 7.8),
    mk('DST', -1.5), mk('DST', 6.2),
  ];
  const res = optimizeLineup(roster, slots, pts);
  checkShape(res, slots, roster);
  assert.equal(res.filled, 9);
  // QB 21.4 + RB 19.2/13.6 + WR 22.8/16.5 + TE 12.7 + FLEX 15.9(WR) + K 7.8 + DST 6.2
  assert.ok(Math.abs(res.total - 136.1) < 1e-9, `total was ${res.total}`);
  assert.equal(res.benched.length, 6);
  const ref = brute(roster, slots.map((s) => ({ id: s.id, eligible: s.eligible })), pts, true);
  assert.ok(Math.abs(res.total - ref.total) < 1e-9);
});

test('superflex prefers the QB2 over the WR3 in this scoring', () => {
  const slots = slotsFromCounts({ QB: 1, WR: 1, SUPERFLEX: 1 });
  const roster = [mk('QB', 21), mk('QB', 18), mk('WR', 20), mk('WR', 14)];
  const res = optimizeLineup(roster, slots, pts);
  assert.equal(res.total, 59);
  assert.equal(res.assignments[2].player.pos, 'QB');
});

test('identical input produces an identical result every time', () => {
  const slots = slotsFromCounts({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 });
  const rand = rng(4242);
  const POSES = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
  const roster = [];
  for (let i = 0; i < 20; i++) {
    roster.push({ id: `d${i}`, pos: POSES[Math.floor(rand() * 6)], pts: Math.round(rand() * 250) / 10 });
  }
  const first = optimizeLineup(roster, slots, pts);
  const key = (r) => r.assignments.map((a) => `${a.slot}:${a.player ? a.player.id : '-'}`).join('|');
  for (let i = 0; i < 25; i++) {
    const again = optimizeLineup(roster, slots, pts);
    assert.equal(key(again), key(first));
    assert.equal(again.total, first.total);
  }
});

test('back-to-back solves do not leak state through the shared scratch buffers', () => {
  const big = slotsFromCounts({ QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 2, SUPERFLEX: 1, K: 1, DST: 1 });
  const bigRoster = [];
  for (let i = 0; i < 24; i++) {
    bigRoster.push(mk(['QB', 'RB', 'WR', 'TE', 'K', 'DST'][i % 6], 5 + i));
  }
  const small = [slot('WRT', ['WR', 'TE']), slot('RBWR', ['RB', 'WR'])];
  const smallRoster = [mk('WR', 20), mk('TE', 10), mk('RB', 9)];

  const bigFirst = optimizeLineup(bigRoster, big, pts).total;
  for (let i = 0; i < 5; i++) {
    assert.equal(optimizeLineup(smallRoster, small, pts).total, 30);
    assert.equal(optimizeLineup(bigRoster, big, pts).total, bigFirst);
  }
});

// ---------------------------------------------------------------------------
// 9. Performance — sim.js calls this tens of thousands of times per season run.
// ---------------------------------------------------------------------------

test('10,000 solves of a full roster complete well inside the Monte Carlo budget', () => {
  const slots = slotsFromCounts({ QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 2, SUPERFLEX: 1, K: 1, DST: 1 });
  assert.equal(slots.length, 12);

  const POSES = ['QB', 'QB', 'RB', 'RB', 'RB', 'RB', 'RB', 'WR', 'WR', 'WR', 'WR', 'WR', 'WR',
    'WR', 'TE', 'TE', 'TE', 'K', 'K', 'DST', 'DST', 'DST', 'RB', 'WR', 'TE'];
  const roster = POSES.map((p, i) => ({ id: `b${i}`, pos: p, pts: 0 }));
  assert.equal(roster.length, 25);

  const rand = rng(31337);
  const N = 10000;

  // Warm up so the timing measures steady state, not the JIT.
  for (let i = 0; i < 500; i++) {
    for (const p of roster) p.pts = rand() * 30 - 2;
    optimizeLineup(roster, slots, pts);
  }

  let sink = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    for (const p of roster) p.pts = rand() * 30 - 2;
    sink += optimizeLineup(roster, slots, pts).total;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  assert.ok(Number.isFinite(sink));
  console.log(
    `  lineup bench: ${N} solves (25 players x 12 slots) in ${ms.toFixed(1)} ms ` +
    `= ${(ms * 1000 / N).toFixed(1)} us/solve, ${Math.round(N / (ms / 1000)).toLocaleString('en-US')} solves/s`,
  );
  assert.ok(ms < 3000, `10,000 solves took ${ms.toFixed(1)} ms, expected well under 3000`);
});
