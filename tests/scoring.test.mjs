import test from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreLine,
  explainLine,
  tierPoints,
  cloneScoring,
  PRESETS,
  DEFAULT_SCORING,
} from '../app/js/scoring.js';

/* ------------------------------------------------------------------ utils */

const { fullPPR, halfPPR, standard, superflexPPR, tePremium } = PRESETS;

/** Sum of the explain line items, for cross-checking against scoreLine. */
const explainTotal = (line, cfg, pos) =>
  explainLine(line, cfg, pos).reduce((s, it) => s + it.points, 0);

/** Assert scoreLine and explainLine agree (items are display-rounded, hence the tolerance). */
function assertConsistent(line, cfg, pos) {
  const total = scoreLine(line, cfg, pos);
  const sum = explainTotal(line, cfg, pos);
  assert.ok(
    Math.abs(sum - total) < 1e-6,
    `explainLine sum ${sum} != scoreLine ${total} for pos=${pos}`,
  );
}

/** Collect dotted paths where two plain objects differ. */
function diffPaths(a, b, prefix = '', out = []) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    const pa = prefix ? `${prefix}.${k}` : k;
    const va = a?.[k];
    const vb = b?.[k];
    if (va && vb && typeof va === 'object' && typeof vb === 'object' && !Array.isArray(va)) {
      diffPaths(va, vb, pa, out);
    } else if (JSON.stringify(va) !== JSON.stringify(vb)) {
      out.push(pa);
    }
  }
  return out;
}

/* ------------------------------------------------- 1. full-PPR WR baseline */

// 8 rec, 12 tgt, 110 receiving yards, 1 receiving TD.
const WR_LINE = { rec: 8, tgt: 12, reyd: 110, retd: 1 };

test('full PPR WR: 8 rec + 110 yd + 1 TD = 25.0', () => {
  // 8 * 1.0 + 110 * 0.1 + 6 = 8 + 11 + 6
  assert.equal(scoreLine(WR_LINE, fullPPR, 'WR'), 25.0);
});

test('full PPR WR score is exact, not float dust', () => {
  // 110 * 0.1 is 11.000000000000002 in IEEE754; the engine must not leak that.
  assert.equal(Object.is(scoreLine(WR_LINE, fullPPR, 'WR'), 25), true);
});

test('targets are not scored', () => {
  const noTgt = { rec: 8, reyd: 110, retd: 1 };
  assert.equal(scoreLine(noTgt, fullPPR, 'WR'), scoreLine(WR_LINE, fullPPR, 'WR'));
});

test('DEFAULT_SCORING is the user league (full PPR, id full-ppr)', () => {
  assert.equal(DEFAULT_SCORING, PRESETS.fullPPR);
  assert.equal(DEFAULT_SCORING.id, 'full-ppr');
  assert.equal(DEFAULT_SCORING.rec.rec, 1.0);
  assert.equal(DEFAULT_SCORING.pass.yd, 0.04);
  assert.equal(DEFAULT_SCORING.pass.td, 4);
  assert.equal(DEFAULT_SCORING.pass.int, -2);
  assert.equal(DEFAULT_SCORING.rush.yd, 0.1);
  assert.equal(DEFAULT_SCORING.rush.td, 6);
  assert.equal(DEFAULT_SCORING.rec.td, 6);
  assert.equal(DEFAULT_SCORING.misc.fumLost, -2);
  assert.equal(DEFAULT_SCORING.k.miss, -1);
  assert.equal(DEFAULT_SCORING.k.xp, 1);
  assert.equal(DEFAULT_SCORING.rec.recBonusByPos.TE, 0);
  // No bonuses anywhere in this league.
  for (const b of ['b40', 'b300', 'b400']) assert.equal(DEFAULT_SCORING.pass[b], 0);
  for (const b of ['b40', 'b100', 'b200']) assert.equal(DEFAULT_SCORING.rush[b], 0);
  for (const b of ['b40', 'b100', 'b200']) assert.equal(DEFAULT_SCORING.rec[b], 0);
});

test('cfg defaults to the user league when omitted', () => {
  assert.equal(scoreLine(WR_LINE, undefined, 'WR'), 25.0);
});

/* ------------------------------------------------------------------ 2. QB */

const QB_LINE = { pyd: 300, ptd: 2, pint: 1, ryd: 20 };

test('full PPR QB: 300 pyd + 2 ptd - 1 int + 20 ryd = 20.0', () => {
  // 300 * 0.04 + 2 * 4 - 2 + 20 * 0.1 = 12 + 8 - 2 + 2
  assert.equal(scoreLine(QB_LINE, fullPPR, 'QB'), 20.0);
});

test('superflex preset differs from full PPR only in passing TD value', () => {
  assert.deepEqual(diffPaths(fullPPR, superflexPPR).sort(), ['id', 'name', 'note', 'pass.td']);
  // Same QB line, 6-point pass TDs: 12 + 12 - 2 + 2 = 24
  assert.equal(scoreLine(QB_LINE, superflexPPR, 'QB'), 24.0);
});

test('QB rushing scores at the rushing rate, not the passing rate', () => {
  assert.equal(scoreLine({ ryd: 20, rtd: 1 }, fullPPR, 'QB'), 8.0);
});

/* ---------------------------------------- 3. same WR line, other PPR levels */

test('standard and half PPR change only the reception weight', () => {
  assert.deepEqual(diffPaths(fullPPR, halfPPR).sort(), ['id', 'name', 'note', 'rec.rec']);
  assert.deepEqual(diffPaths(fullPPR, standard).sort(), ['id', 'name', 'note', 'rec.rec']);
  assert.equal(halfPPR.rec.rec, 0.5);
  assert.equal(standard.rec.rec, 0);
});

test('same WR line: full 25.0 / half 21.0 / standard 17.0', () => {
  const full = scoreLine(WR_LINE, fullPPR, 'WR');
  const half = scoreLine(WR_LINE, halfPPR, 'WR');
  const std = scoreLine(WR_LINE, standard, 'WR');
  assert.equal(full, 25.0);
  assert.equal(half, 21.0);
  assert.equal(std, 17.0);
  // The whole delta is receptions x weight delta, nothing else.
  assert.equal(full - half, 8 * (1.0 - 0.5));
  assert.equal(full - std, 8 * (1.0 - 0.0));
});

test('a zero-reception line scores identically under all three PPR levels', () => {
  const line = { ryd: 95, rtd: 1 };
  assert.equal(scoreLine(line, fullPPR, 'RB'), 15.5);
  assert.equal(scoreLine(line, halfPPR, 'RB'), 15.5);
  assert.equal(scoreLine(line, standard, 'RB'), 15.5);
});

/* ----------------------------------------------------------------- 4. DST */

const DST_LINE = { sack: 3, dint: 2, fumrec: 1, dtd: 1, ptsAllowed: 10, ydsAllowed: 250 };

test('DST: 3 sk + 2 int + 1 fr + 1 td, 10 PA, 250 YA = 20', () => {
  // 3*1 + 2*2 + 1*2 + 1*6 = 15, + PA tier 7-13 (3) + YA tier 200-299 (2)
  assert.equal(scoreLine(DST_LINE, fullPPR, 'DST'), 20);
});

test('DST scoring is identical across every preset (only offense differs)', () => {
  for (const p of [fullPPR, halfPPR, standard, superflexPPR, tePremium]) {
    assert.equal(scoreLine(DST_LINE, p, 'DST'), 20, `preset ${p.id}`);
  }
});

test('DST position aliases all route to defense scoring', () => {
  for (const alias of ['DST', 'dst', 'DEF', 'D/ST', ' d/st ']) {
    assert.equal(scoreLine(DST_LINE, fullPPR, alias), 20, `alias ${alias}`);
  }
});

test('DST safety and blocked kick score', () => {
  const line = { safety: 1, blk: 1, ptsAllowed: 24, ydsAllowed: 320 };
  // 2 + 2 + PA 22-27 (0) + YA 300-349 (0)
  assert.equal(scoreLine(line, fullPPR, 'DST'), 4);
});

test('DST return TD scores off the dst.stTd rate', () => {
  const line = { sttd: 1, ptsAllowed: 24, ydsAllowed: 320 };
  assert.equal(scoreLine(line, fullPPR, 'DST'), 6);
});

test('a dominant DST game is worth 8-10 on tiers alone (contract section 9)', () => {
  const shutout = { ptsAllowed: 0, ydsAllowed: 80 };
  assert.equal(scoreLine(shutout, fullPPR, 'DST'), 10); // 5 + 5
  const blowup = { ptsAllowed: 48, ydsAllowed: 560 };
  assert.equal(scoreLine(blowup, fullPPR, 'DST'), -12); // -5 + -7
});

/* -------------------------------------------------- 5. DST tier boundaries */

test('points-allowed tier boundaries (YA held at 250 = +2)', () => {
  const at = (pa) => scoreLine({ ptsAllowed: pa, ydsAllowed: 250 }, fullPPR, 'DST');
  assert.equal(at(0), 7);    // tier max 0  -> 5
  assert.equal(at(6), 6);    // tier max 6  -> 4
  assert.equal(at(7), 5);    // tier max 13 -> 3
  assert.equal(at(13), 5);   // still tier max 13
  assert.equal(at(14), 3);   // tier max 17 -> 1
  assert.equal(at(17), 3);
  assert.equal(at(18), 2);   // tier max 21 -> 0
  assert.equal(at(21), 2);
  assert.equal(at(27), 2);   // tier max 27 -> 0
  assert.equal(at(28), 1);   // tier max 34 -> -1
  assert.equal(at(34), 1);
  assert.equal(at(35), -1);  // tier max 45 -> -3
  assert.equal(at(45), -1);
  assert.equal(at(46), -3);  // catch-all -> -5
  assert.equal(at(70), -3);
});

test('yards-allowed tier boundaries (PA held at 10 = +3)', () => {
  const at = (ya) => scoreLine({ ptsAllowed: 10, ydsAllowed: ya }, fullPPR, 'DST');
  assert.equal(at(99), 8);    // tier max 99  -> 5
  assert.equal(at(100), 6);   // tier max 199 -> 3
  assert.equal(at(199), 6);
  assert.equal(at(200), 5);   // tier max 299 -> 2
  assert.equal(at(299), 5);
  assert.equal(at(300), 3);   // tier max 349 -> 0
  assert.equal(at(549), -3);  // tier max 549 -> -6
  assert.equal(at(550), -4);  // catch-all    -> -7
});

test('impossible and extreme tier inputs are handled, never NaN', () => {
  const pa = DEFAULT_SCORING.dst.paTiers;
  const ya = DEFAULT_SCORING.dst.yaTiers;
  assert.equal(tierPoints(pa, -3), 5);            // negative points allowed -> first tier
  assert.equal(tierPoints(pa, -1e12), 5);
  assert.equal(tierPoints(pa, 1e12), -5);         // above every max -> last tier
  assert.equal(tierPoints(pa, Infinity), -5);
  assert.equal(tierPoints(pa, -Infinity), 5);
  assert.equal(tierPoints(pa, NaN), 5);           // NaN coerced to 0
  assert.equal(tierPoints(pa, undefined), 5);     // missing key -> 0 -> shutout tier
  assert.equal(tierPoints(ya, 1e12), -7);
  assert.equal(tierPoints([], 10), 0);
  assert.equal(tierPoints(null, 10), 0);
  assert.equal(tierPoints(undefined, 10), 0);
  const extreme = scoreLine({ ptsAllowed: 1e12, ydsAllowed: -50 }, fullPPR, 'DST');
  assert.equal(Number.isFinite(extreme), true);
  assert.equal(extreme, 0); // -5 + 5
});

test('tier lookup takes the FIRST tier whose max >= value even with duplicate payouts', () => {
  // Payouts 0 appear twice (max 21 and max 27); the 21 bucket must win at 21.
  const hits = explainLine({ ptsAllowed: 21, ydsAllowed: 320 }, fullPPR, 'DST');
  const paItem = hits.find((h) => h.label === 'Points allowed');
  assert.equal(paItem.points, 0);
  assert.match(paItem.detail, /tier 18-21/);
});

/* -------------------------------------------------------------- 6. Kicker */

// FGs of 25, 45 and 55 yards made, one 40-49 miss, 3 PATs.
const K_LINE = { fgm_20_29: 1, fgm_40_49: 1, fgm_50_59: 1, fgx_40_49: 1, xpm: 3 };

test('kicker: 25/45/55 made, one 40-49 miss, 3 PATs = 14', () => {
  // 3 + 4 + 5 - 1 + 3
  assert.equal(scoreLine(K_LINE, fullPPR, 'K'), 14);
});

test('kicker distance buckets pay 3/3/3/4/5/6', () => {
  const one = (b) => scoreLine({ ['fgm_' + b]: 1 }, fullPPR, 'K');
  assert.equal(one('0_19'), 3);
  assert.equal(one('20_29'), 3);
  assert.equal(one('30_39'), 3);
  assert.equal(one('40_49'), 4);
  assert.equal(one('50_59'), 5);
  assert.equal(one('60'), 6);
});

test('kicker misses cost 1 regardless of distance; missed PAT costs 1', () => {
  assert.equal(scoreLine({ fgx_0_19: 1 }, fullPPR, 'K'), -1);
  assert.equal(scoreLine({ fgx_60: 1 }, fullPPR, 'K'), -1);
  assert.equal(scoreLine({ fgx_30_39: 2, fgx_50_59: 1 }, fullPPR, 'K'), -3);
  assert.equal(scoreLine({ xpx: 1 }, fullPPR, 'K'), -1);
  assert.equal(scoreLine({ xpm: 4, xpx: 1 }, fullPPR, 'K'), 3);
});

test('kicker aliases route to kicking scoring', () => {
  for (const alias of ['K', 'k', 'PK', ' Kicker ']) {
    assert.equal(scoreLine(K_LINE, fullPPR, alias), 14, `alias ${alias}`);
  }
});

test('kicking keys are inert for offensive positions and vice versa', () => {
  assert.equal(scoreLine(K_LINE, fullPPR, 'WR'), 0);
  assert.equal(scoreLine(WR_LINE, fullPPR, 'K'), 0);
  assert.equal(scoreLine(DST_LINE, fullPPR, 'WR'), 0);
});

/* ---------------------------------------------------------- 7. TE premium */

test('TE premium adds 0.5 per reception for TE only', () => {
  // Base line is 25.0; 8 receptions x 0.5 = +4.
  assert.equal(scoreLine(WR_LINE, tePremium, 'TE'), 29.0);
  assert.equal(scoreLine(WR_LINE, tePremium, 'WR'), 25.0);
  assert.equal(scoreLine(WR_LINE, tePremium, 'RB'), 25.0);
  assert.equal(scoreLine(WR_LINE, tePremium, 'QB'), 25.0);
  assert.equal(scoreLine(WR_LINE, tePremium, undefined), 25.0);
});

test('TE premium preset differs from full PPR only in recBonusByPos.TE', () => {
  assert.deepEqual(
    diffPaths(fullPPR, tePremium).sort(),
    ['id', 'name', 'note', 'rec.recBonusByPos.TE'],
  );
});

test('the base full-PPR league gives TEs no premium', () => {
  assert.equal(scoreLine(WR_LINE, fullPPR, 'TE'), 25.0);
});

test('a pass-catching RB premium can be configured the same way', () => {
  const cfg = cloneScoring(fullPPR);
  cfg.rec.recBonusByPos = { TE: 0.5, RB: 0.25 };
  assert.equal(scoreLine({ rec: 8 }, cfg, 'RB'), 8 * 1.25);
  assert.equal(scoreLine({ rec: 8 }, cfg, 'TE'), 8 * 1.5);
  assert.equal(scoreLine({ rec: 8 }, cfg, 'WR'), 8);
});

test('the premium is a separate explain line item so its cost is visible', () => {
  const items = explainLine(WR_LINE, tePremium, 'TE');
  const rec = items.find((i) => i.label === 'Receptions');
  const prem = items.find((i) => i.label === 'TE reception premium');
  assert.equal(rec.points, 8);
  assert.equal(prem.points, 4);
  assertConsistent(WR_LINE, tePremium, 'TE');
});

/* -------------------------------- 8. missing keys, unknown keys, never NaN */

test('missing keys default to 0', () => {
  assert.equal(scoreLine({}, fullPPR, 'WR'), 0);
  assert.equal(scoreLine({}, fullPPR, 'QB'), 0);
  assert.equal(scoreLine({}, fullPPR, 'K'), 0);
  assert.equal(scoreLine({ rec: 3 }, fullPPR, 'WR'), 3);
});

test('a DST line with no tier keys reads as a 0/0 shutout (contract: missing key = 0)', () => {
  // Documented consequence of the missing-key rule. The pipeline always emits both tier
  // keys for a DST, so this only surfaces on hand-entered lines.
  assert.equal(scoreLine({}, fullPPR, 'DST'), 10);
});

test('unknown keys are ignored', () => {
  const line = { rec: 8, reyd: 110, retd: 1, wombat: 999, snapPct: 0.87, id: 'x', __proto__: null };
  assert.equal(scoreLine(line, fullPPR, 'WR'), 25.0);
});

test('never returns NaN or Infinity for any input', () => {
  const junk = [
    {}, null, undefined, 0, '', 'nope', [], NaN,
    { rec: NaN, reyd: Infinity, retd: -Infinity },
    { rec: 'eight', reyd: '110', retd: null, ptd: undefined },
    { rec: {}, reyd: [], retd: () => 1 },
    { pyd: 1e308, ryd: 1e308, reyd: 1e308 },
    { ptsAllowed: NaN, ydsAllowed: undefined },
    { fgm_20_29: 'x', xpm: true },
  ];
  const positions = ['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'FLEX', '', undefined, null, 7];
  for (const line of junk) {
    for (const pos of positions) {
      for (const cfg of [fullPPR, halfPPR, standard, superflexPPR, tePremium, undefined, null, {}]) {
        const v = scoreLine(line, cfg, pos);
        assert.equal(typeof v, 'number');
        assert.equal(Number.isFinite(v), true, `NaN/Inf for line=${JSON.stringify(line)} pos=${pos}`);
        const items = explainLine(line, cfg, pos);
        assert.equal(Array.isArray(items), true);
        for (const it of items) {
          assert.equal(Number.isFinite(it.points), true, `item ${it.label} not finite`);
          assert.equal(typeof it.label, 'string');
          assert.equal(typeof it.detail, 'string');
        }
      }
    }
  }
});

test('huge but finite yardage stays finite (rounding must not overflow)', () => {
  // Scaling by 1e6 to round would push 1e308 past Number.MAX_VALUE.
  const v = scoreLine({ pyd: 1e308, ryd: 1e308, reyd: 1e308 }, fullPPR, 'QB');
  assert.equal(Number.isFinite(v), true);
  assert.ok(v > 1e307);
});

test('string numerics are coerced rather than poisoning the total', () => {
  assert.equal(scoreLine({ rec: '8', reyd: '110', retd: '1' }, fullPPR, 'WR'), 25.0);
});

test('a partial config does not produce NaN', () => {
  const partial = { id: 'partial', rec: { rec: 1 } };
  assert.equal(scoreLine(WR_LINE, partial, 'WR'), 8);
});

/* ------------------------------------------------------------- explainLine */

test('explainLine itemizes the full-PPR WR line', () => {
  const items = explainLine(WR_LINE, fullPPR, 'WR');
  // `points` carries full float precision so the items still add up to scoreLine; the
  // rounded display value rides along as `pointsText`. 110 * 0.1 is 11.000000000000002 in
  // IEEE754, so this compares labels and details exactly and points with a tolerance.
  assert.deepEqual(items.map((i) => [i.label, i.detail, i.pointsText]), [
    ['Receiving yards', '110 yd x 0.1', '11'],
    ['Receptions', '8 rec x 1', '8'],
    ['Receiving TDs', '1 x 6', '6'],
  ]);
  const expected = [11, 8, 6];
  items.forEach((it, i) => assert.ok(Math.abs(it.points - expected[i]) < 1e-9, it.label));
  assert.ok(Math.abs(items.reduce((s, i) => s + i.points, 0) - 25) < 1e-9);
});

test('explainLine sorts by absolute contribution, descending', () => {
  const items = explainLine({ rec: 2, reyd: 10, retd: 1, fuml: 2 }, fullPPR, 'WR');
  const mags = items.map((i) => Math.abs(i.points));
  for (let i = 1; i < mags.length; i++) assert.ok(mags[i - 1] >= mags[i], `at ${i}`);
  // A negative is ranked by magnitude, not shoved to the end.
  assert.deepEqual(items.map((i) => [i.label, i.pointsText]), [
    ['Receiving TDs', '6'],
    ['Fumbles lost', '-4'],
    ['Receptions', '2'],
    ['Receiving yards', '1'],
  ]);
});

test('explainLine tie-breaks stably on stat-sheet order', () => {
  // Receptions (+2) and the fumble (-2) tie on magnitude; receptions were emitted first.
  const items = explainLine({ rec: 2, reyd: 10, retd: 1, fuml: 1 }, fullPPR, 'WR');
  assert.deepEqual(items.map((i) => i.label), [
    'Receiving TDs', 'Receptions', 'Fumbles lost', 'Receiving yards',
  ]);
});

test('receptions are the visible top contributor for a volume slot receiver', () => {
  // 10 catches, 60 yards: the exact profile full PPR overpays and standard ignores.
  const slot = { rec: 10, tgt: 13, reyd: 60 };
  const items = explainLine(slot, fullPPR, 'WR');
  assert.equal(items[0].label, 'Receptions');
  assert.equal(items[0].points, 10);
  assert.equal(items[0].detail, '10 rec x 1');
  assert.equal(scoreLine(slot, fullPPR, 'WR'), 16);
  assert.equal(scoreLine(slot, standard, 'WR'), 6);
});

test('explainLine itemizes the QB line', () => {
  const items = explainLine(QB_LINE, fullPPR, 'QB');
  assert.deepEqual(items.map((i) => [i.label, i.detail, i.pointsText]), [
    ['Passing yards', '300 yd x 0.04', '12'],
    ['Passing TDs', '2 x 4', '8'],
    ['Interceptions thrown', '1 x -2', '-2'],
    ['Rushing yards', '20 yd x 0.1', '2'],
  ]);
  const expected = [12, 8, -2, 2];
  items.forEach((it, i) => assert.ok(Math.abs(it.points - expected[i]) < 1e-9, it.label));
});

test('explainLine itemizes the kicker line, grouping misses', () => {
  const items = explainLine(K_LINE, fullPPR, 'K');
  const byLabel = Object.fromEntries(items.map((i) => [i.label, i]));
  assert.equal(byLabel['FG 50-59 yd'].points, 5);
  assert.equal(byLabel['FG 40-49 yd'].points, 4);
  assert.equal(byLabel['FG 20-29 yd'].points, 3);
  assert.equal(byLabel['Extra points'].points, 3);
  assert.equal(byLabel['Missed FGs'].points, -1);
  assert.equal(byLabel['Missed FGs'].detail, '1 x -1');
  assert.equal(items.length, 5);
});

test('explainLine always shows both DST tier stacks, even at zero points', () => {
  const items = explainLine({ sack: 3, ptsAllowed: 24, ydsAllowed: 320 }, fullPPR, 'DST');
  const byLabel = Object.fromEntries(items.map((i) => [i.label, i]));
  assert.equal(byLabel['Points allowed'].points, 0);
  assert.equal(byLabel['Points allowed'].detail, '24 allowed, tier 22-27');
  assert.equal(byLabel['Yards allowed'].points, 0);
  assert.equal(byLabel['Yards allowed'].detail, '320 allowed, tier 300-349');
  assert.equal(byLabel['Sacks'].points, 3);
});

test('DST tier detail names the open-ended top bucket', () => {
  const items = explainLine({ ptsAllowed: 60, ydsAllowed: 600 }, fullPPR, 'DST');
  const byLabel = Object.fromEntries(items.map((i) => [i.label, i]));
  assert.equal(byLabel['Points allowed'].detail, '60 allowed, tier 46+');
  assert.equal(byLabel['Yards allowed'].detail, '600 allowed, tier 550+');
});

test('explainLine sum equals scoreLine across a spread of lines, positions and presets', () => {
  const lines = [
    WR_LINE, QB_LINE, DST_LINE, K_LINE, {},
    { rec: 5, reyd: 44, ryd: 88, rtd: 1, fuml: 1, tgt: 7 },
    { pyd: 412, ptd: 3, pint: 2, psack: 4, p2p: 1, ryd: 61, rtd: 1, p40: 2, pfd: 18 },
    { rec: 12, reyd: 205, retd: 2, re2p: 1, re40: 1, refd: 9, sttd: 1 },
    { ryd: 143, ratt: 24, rtd: 2, r40: 1, rfd: 8, r2p: 1, rec: 4, reyd: 31 },
    { sack: 6, dint: 3, fumrec: 2, safety: 1, dtd: 1, blk: 1, sttd: 1, ptsAllowed: 3, ydsAllowed: 145 },
    { fgm_0_19: 1, fgm_30_39: 2, fgm_60: 1, fgx_50_59: 2, xpm: 5, xpx: 1 },
  ];
  for (const line of lines) {
    for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DST']) {
      for (const cfg of [fullPPR, halfPPR, standard, superflexPPR, tePremium]) {
        assertConsistent(line, cfg, pos);
      }
    }
  }
});

/* ---------------------------------------------------------- bonus plumbing */

test('yardage bonuses are thresholds and stack cumulatively', () => {
  const cfg = cloneScoring(fullPPR);
  cfg.pass.b300 = 3;
  cfg.pass.b400 = 5;
  cfg.rush.b100 = 3;
  cfg.rush.b200 = 5;
  cfg.rec.b100 = 3;
  cfg.rec.b200 = 5;

  assert.equal(scoreLine({ pyd: 299 }, cfg, 'QB'), 11.96);
  assert.equal(scoreLine({ pyd: 300 }, cfg, 'QB'), 15);        // 12 + 3
  assert.equal(scoreLine({ pyd: 400 }, cfg, 'QB'), 24);        // 16 + 3 + 5
  assert.equal(scoreLine({ ryd: 99 }, cfg, 'RB'), 9.9);
  assert.equal(scoreLine({ ryd: 100 }, cfg, 'RB'), 13);        // 10 + 3
  assert.equal(scoreLine({ ryd: 200 }, cfg, 'RB'), 28);        // 20 + 3 + 5
  assert.equal(scoreLine({ reyd: 100 }, cfg, 'WR'), 13);
  assert.equal(scoreLine({ reyd: 200 }, cfg, 'WR'), 28);
});

test('b40 bonuses are per-play counts on p40/r40/re40', () => {
  const cfg = cloneScoring(fullPPR);
  cfg.pass.b40 = 1;
  cfg.rush.b40 = 2;
  cfg.rec.b40 = 2;
  assert.equal(scoreLine({ p40: 3 }, cfg, 'QB'), 3);
  assert.equal(scoreLine({ r40: 2 }, cfg, 'RB'), 4);
  assert.equal(scoreLine({ re40: 2 }, cfg, 'WR'), 4);
});

test('first-down, 2-pt and sack-taken settings are wired', () => {
  const cfg = cloneScoring(fullPPR);
  cfg.pass.fd = 0.5;
  cfg.rush.fd = 0.5;
  cfg.rec.fd = 0.5;
  cfg.pass.sack = -1;
  assert.equal(scoreLine({ pfd: 10, psack: 3 }, cfg, 'QB'), 2);
  assert.equal(scoreLine({ rfd: 4, refd: 2 }, cfg, 'RB'), 3);
  assert.equal(scoreLine({ p2p: 1, r2p: 1, re2p: 1 }, fullPPR, 'QB'), 6);
});

test('misc: fumbles lost and special teams TDs', () => {
  assert.equal(scoreLine({ fuml: 2 }, fullPPR, 'RB'), -4);
  assert.equal(scoreLine({ sttd: 1 }, fullPPR, 'WR'), 6);
});

/* ------------------------------------------------------- preset integrity */

test('every preset is complete: no partials, no missing blocks', () => {
  const names = ['fullPPR', 'halfPPR', 'standard', 'superflexPPR', 'tePremium'];
  assert.deepEqual(Object.keys(PRESETS).sort(), [...names].sort());
  const shape = {
    pass: ['yd', 'td', 'int', 'twoPt', 'sack', 'fd', 'b40', 'b300', 'b400'],
    rush: ['yd', 'td', 'twoPt', 'fd', 'b40', 'b100', 'b200'],
    rec: ['rec', 'yd', 'td', 'twoPt', 'fd', 'b40', 'b100', 'b200', 'recBonusByPos'],
    misc: ['fumLost', 'stTd'],
    k: ['fg', 'miss', 'xp', 'xpMiss'],
    dst: ['sack', 'int', 'fumRec', 'safety', 'td', 'blk', 'stTd', 'paTiers', 'yaTiers'],
  };
  for (const name of names) {
    const cfg = PRESETS[name];
    assert.equal(typeof cfg.id, 'string', `${name}.id`);
    assert.equal(typeof cfg.name, 'string', `${name}.name`);
    for (const [block, keys] of Object.entries(shape)) {
      assert.ok(cfg[block], `${name}.${block} missing`);
      for (const k of keys) {
        assert.ok(k in cfg[block], `${name}.${block}.${k} missing`);
      }
    }
    for (const b of ['0_19', '20_29', '30_39', '40_49', '50_59', '60']) {
      assert.equal(typeof cfg.k.fg[b], 'number', `${name}.k.fg.${b}`);
    }
    assert.equal(cfg.dst.paTiers.length, 9, `${name} paTiers`);
    assert.equal(cfg.dst.yaTiers.length, 9, `${name} yaTiers`);
    // Tiers must be ascending by max for the first-match lookup to be correct.
    for (const stack of [cfg.dst.paTiers, cfg.dst.yaTiers]) {
      for (let i = 1; i < stack.length; i++) {
        assert.ok(stack[i].max > stack[i - 1].max, `${name} tiers not ascending at ${i}`);
      }
    }
  }
});

test('preset ids are unique and kebab-case', () => {
  const ids = Object.values(PRESETS).map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test('presets are deep-frozen so callers cannot mutate shared state', () => {
  assert.throws(() => { PRESETS.fullPPR.rec.rec = 0.5; }, TypeError);
  assert.throws(() => { PRESETS.fullPPR.dst.paTiers[0].pts = 99; }, TypeError);
  assert.throws(() => { PRESETS.fullPPR.dst.paTiers.push({ max: 1, pts: 1 }); }, TypeError);
  assert.throws(() => { PRESETS.fullPPR.k.fg['60'] = 10; }, TypeError);
  assert.throws(() => { PRESETS.newPreset = {}; }, TypeError);
  assert.equal(PRESETS.fullPPR.rec.rec, 1.0);
  assert.equal(scoreLine(WR_LINE, fullPPR, 'WR'), 25.0);
});

test('presets do not share nested tier objects', () => {
  assert.notEqual(PRESETS.fullPPR.dst.paTiers, PRESETS.halfPPR.dst.paTiers);
  assert.notEqual(PRESETS.fullPPR.rec.recBonusByPos, PRESETS.tePremium.rec.recBonusByPos);
});

test('cloneScoring returns an independent, mutable deep copy', () => {
  const c = cloneScoring(PRESETS.fullPPR);
  assert.deepEqual(c, PRESETS.fullPPR);
  assert.notEqual(c, PRESETS.fullPPR);
  assert.notEqual(c.dst.paTiers, PRESETS.fullPPR.dst.paTiers);
  c.rec.rec = 0.5;
  c.dst.paTiers[0].pts = 99;
  assert.equal(PRESETS.fullPPR.rec.rec, 1.0);
  assert.equal(PRESETS.fullPPR.dst.paTiers[0].pts, 5);
  assert.equal(scoreLine(WR_LINE, c, 'WR'), 21.0);
  assert.equal(cloneScoring().id, 'full-ppr');
});

test('scoring is pure: repeated calls on the same input give the same answer', () => {
  const a = scoreLine(WR_LINE, fullPPR, 'WR');
  for (let i = 0; i < 100; i++) assert.equal(scoreLine(WR_LINE, fullPPR, 'WR'), a);
  assert.deepEqual(WR_LINE, { rec: 8, tgt: 12, reyd: 110, retd: 1 }); // input untouched
});
