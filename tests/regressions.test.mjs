/**
 * Regression tests for defects found by adversarial review.
 *
 * Each of these was a real, confirmed bug reproduced by execution against the shipped
 * modules -- not a hypothetical. They live together so the failure modes stay named:
 * a test that only says "computeReplacement works" does not stop anyone reintroducing
 * the exact coercion that silently zeroed a position's replacement level.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeReplacement, replacementDetail } from '../app/js/replacement.js'
import { optimizeLineup, slotsFromCounts } from '../app/js/lineup.js'
import { scoreLine, explainLine, PRESETS } from '../app/js/scoring.js'

const pts = (p) => p.pts

/** Descending point ladder at one position, ids like WR1..WRn. */
function ladder(pos, n, top, step) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${pos}${i + 1}`, pos, name: `${pos}${i + 1}`, pts: top - i * step,
  }))
}

const POOL = [
  ...ladder('QB', 30, 340, 5),
  ...ladder('RB', 60, 330, 3),
  ...ladder('WR', 60, 320, 3),
  ...ladder('TE', 30, 250, 5),
  ...ladder('K', 30, 140, 2),
  ...ladder('DST', 30, 130, 2),
]

test('W/R and R/W name the same flex and must give the same answer', () => {
  // 'W/R' compacts to 'WR' and was being read as a third dedicated receiver slot, so the
  // Yahoo spelling of an RB/WR flex produced a different replacement level from the
  // mirror spelling of the identical league.
  const base = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DST: 1, BEN: 7 }
  const a = computeReplacement(POOL, { teams: 12, slots: { ...base, 'W/R': 1 } }, pts)
  const b = computeReplacement(POOL, { teams: 12, slots: { ...base, 'R/W': 1 } }, pts)
  assert.deepEqual(a, b, 'W/R and R/W disagree about replacement level')

  const da = replacementDetail(POOL, { teams: 12, slots: { ...base, 'W/R': 1 } }, pts)
  assert.ok(da.WR.flexCapacity > 0, 'W/R was not recognized as a flex slot')
  assert.equal(da.WR.dedicated, 24, 'W/R leaked into the dedicated WR count')
})

test('D/ST still parses as a position, not as a D-or-ST flex', () => {
  const d = replacementDetail(POOL, {
    teams: 12, slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, 'D/ST': 1, BEN: 7 },
  }, pts)
  assert.ok(d.DST, 'D/ST did not resolve to the DST position')
  assert.equal(d.DST.dedicated, 12)
})

test('a partial pool falls back to the rank baseline instead of trusting it as the wire', () => {
  // A trade evaluation passes two rosters plus a few waiver adds. That is a small
  // fraction of a 12-team league, and the coverage guard must notice; clamping the
  // denominator to the pool size made 15% coverage read as 55% and switched on the
  // free-agent method over a pool of six quarterbacks.
  const small = [
    ...ladder('QB', 6, 340, 5), ...ladder('RB', 15, 330, 3),
    ...ladder('WR', 18, 320, 3), ...ladder('TE', 6, 250, 5),
    ...ladder('K', 3, 140, 2), ...ladder('DST', 3, 130, 2),
  ]
  const rostered = new Set(small.slice(0, 28).map((p) => p.id))
  const league = {
    teams: 12,
    slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BEN: 7 },
    rostered,
  }
  const d = replacementDetail(small, league, pts)
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    assert.notEqual(d[pos].method, 'freeAgent',
      `${pos} used the free-agent method on ${(d[pos].rosterCoverage ?? 0).toFixed(2)} coverage`)
  }
})

test('a genuinely complete pool does still use the free-agent method', () => {
  // The guard must not be so strict that the real case stops working.
  const rostered = new Set([
    ...ladder('QB', 12, 340, 5), ...ladder('RB', 40, 330, 3),
    ...ladder('WR', 46, 320, 3), ...ladder('TE', 14, 250, 5),
    ...ladder('K', 12, 140, 2), ...ladder('DST', 12, 130, 2),
  ].map((p) => p.id))
  const d = replacementDetail(POOL, {
    teams: 12,
    slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BEN: 7 },
    rostered,
  }, pts)
  assert.equal(d.WR.method, 'freeAgent', 'a full league roster should enable the free-agent method')
})

test('an empty override field is not an override of zero', () => {
  // Number(null) === 0, Number('') === 0, Number([]) === 0, Number(false) === 0. A UI that
  // stores null for a blank numeric input would otherwise set replacement to nothing and
  // make every VOR equal the raw projection -- relabelled "Manual override: 0" so it
  // looks deliberate.
  const league = { teams: 12, slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BEN: 7 } }
  const baseline = computeReplacement(POOL, league, pts)
  for (const junk of [null, '', '   ', [], false, undefined, {}, NaN, 'lots']) {
    const got = computeReplacement(POOL, { ...league, override: { QB: junk } }, pts)
    assert.equal(got.QB, baseline.QB, `override ${JSON.stringify(junk)} changed the baseline`)
  }
  // A real number, including zero written as a number, is still honored.
  assert.equal(computeReplacement(POOL, { ...league, override: { QB: 0 } }, pts).QB, 0)
  assert.equal(computeReplacement(POOL, { ...league, override: { QB: 17.5 } }, pts).QB, 17.5)
  assert.equal(computeReplacement(POOL, { ...league, override: { QB: '17.5' } }, pts).QB, 17.5)
})

test('players with no id are not assumed onto the waiver wire', () => {
  // Unknown is not the same as available. One id-less D/ST was becoming the position's
  // replacement level and zeroing every defense's VOR.
  const withAnon = [...POOL, { pos: 'DST', name: 'Anon D', pts: 129 }]
  const rostered = new Set(POOL.filter((p) => !['K', 'DST'].includes(p.pos)).map((p) => p.id))
  for (const p of ladder('DST', 12, 130, 2)) rostered.add(p.id)
  for (const p of ladder('K', 12, 140, 2)) rostered.add(p.id)
  const d = replacementDetail(withAnon, {
    teams: 12,
    slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BEN: 7 },
    rostered,
  }, pts)
  if (d.DST.method === 'freeAgent') {
    assert.notEqual(d.DST.pts, 129, 'an id-less player was treated as the best free agent')
  }
})

test('the lineup solver terminates on absurd point values', () => {
  // The sentinel arithmetic overflowed to Infinity, the augmenting-path loop compared
  // Infinity - Infinity = NaN, and the solver spun forever -- a hung tab rather than a
  // wrong answer, inside a function a season simulation calls tens of thousands of times.
  const slots = slotsFromCounts({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 })
  for (const big of [1e15, 1e100, 1e300, 9e307, Number.MAX_VALUE]) {
    const roster = [
      { id: 'a', pos: 'QB', pts: big },
      { id: 'b', pos: 'RB', pts: 1 },
      { id: 'c', pos: 'WR', pts: 2 },
    ]
    const out = optimizeLineup(roster, slots, (p) => p.pts)
    assert.ok(out && Array.isArray(out.assignments), `no result at ${big}`)
    const filled = out.assignments.filter((x) => x.player).length
    assert.equal(filled, 3, `expected all three players seated at ${big}`)
  }
})

test('the breakdown adds up to the score on fractional projected lines', () => {
  // Rounding each item independently made the sum drift from scoreLine in proportion to
  // the item count. Integer stat lines hid it; the model emits floats.
  const lines = [
    { pyd: 205.548, ptd: 0.527, pint: 0.310, ryd: 13.163, rtd: 0.341, rec: 8.361,
      reyd: 74.219, retd: 0.487, fuml: 0.093 },
    { tgt: 9.4, rec: 6.31, reyd: 78.42, retd: 0.51, ratt: 0.62, ryd: 3.11, fuml: 0.04 },
    { ratt: 17.3, ryd: 74.66, rtd: 0.63, tgt: 4.9, rec: 3.83, reyd: 29.77, retd: 0.19 },
  ]
  for (const [name, cfg] of Object.entries(PRESETS)) {
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      for (const line of lines) {
        const total = scoreLine(line, cfg, pos)
        const sum = explainLine(line, cfg, pos).reduce((s, i) => s + i.points, 0)
        assert.ok(Math.abs(sum - total) < 1e-6,
          `${name}/${pos}: items sum to ${sum} but scoreLine is ${total}`)
      }
    }
  }
})

test('explainLine still exposes a rounded display value', () => {
  const items = explainLine({ rec: 8, reyd: 110, retd: 1 }, PRESETS.fullPPR, 'WR')
  const yards = items.find((i) => i.label === 'Receiving yards')
  assert.equal(yards.pointsText, '11', 'display value should be clean')
  assert.ok(Math.abs(yards.points - 11) < 1e-9, 'raw value keeps full precision')
})
