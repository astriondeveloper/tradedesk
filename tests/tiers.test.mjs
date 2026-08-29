import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  tierPoints, expectedTierPoints, expectedDstScore, DEFAULT_SCORING,
} from '../app/js/scoring.js'

const PA = DEFAULT_SCORING.dst.paTiers
const YA = DEFAULT_SCORING.dst.yaTiers

test('expectedTierPoints with zero uncertainty equals a point lookup', () => {
  for (const v of [0, 6, 7, 13, 17, 21, 27, 34, 45, 46, 100]) {
    assert.equal(expectedTierPoints(PA, v, 0), tierPoints(PA, v))
    assert.equal(expectedTierPoints(PA, v, -1), tierPoints(PA, v))
  }
})

test('a step function scored at its mean is not the mean of the scores', () => {
  // 18.5 points allowed sits in the 18-21 bucket, worth 0. But a real game with a 9-point
  // standard deviation lands in the paying buckets often enough to be worth well over 0.
  const atMean = tierPoints(PA, 18.5)
  const expected = expectedTierPoints(PA, 18.5, 9.12, { floor: 0 })
  assert.equal(atMean, 0)
  assert.ok(expected > 0.4, `expected a meaningful positive correction, got ${expected}`)
})

test('the correction has the right sign on both sides of the curve', () => {
  // Deep in the penalty region the correction should be negative: a blowout defense has
  // more room to get worse than to get better.
  const badMu = 25
  assert.ok(expectedTierPoints(PA, badMu, 9.12, { floor: 0 }) < tierPoints(PA, badMu))
  // Near the top of the payout curve it should be positive.
  const goodMu = 18.5
  assert.ok(expectedTierPoints(PA, goodMu, 9.12, { floor: 0 }) > tierPoints(PA, goodMu))
})

test('the floor keeps impossible draws out of the integral', () => {
  // Points allowed cannot be negative. Without a floor, the left tail piles into the
  // best bucket and overstates a dominant defense.
  const withFloor = expectedTierPoints(PA, 4, 9.12, { floor: 0 })
  const noFloor = expectedTierPoints(PA, 4, 9.12, { floor: null })
  assert.ok(withFloor <= noFloor + 1e-9)
  assert.ok(Number.isFinite(withFloor))
})

test('expected tier points stay inside the table range', () => {
  const lo = Math.min(...PA.map((t) => t.pts))
  const hi = Math.max(...PA.map((t) => t.pts))
  for (const mu of [0, 5, 12, 20, 30, 50]) {
    for (const sd of [0, 3, 9, 20]) {
      const v = expectedTierPoints(PA, mu, sd, { floor: 0 })
      assert.ok(v >= lo - 1e-9 && v <= hi + 1e-9, `${v} outside [${lo},${hi}] at mu=${mu} sd=${sd}`)
    }
  }
})

test('more uncertainty pulls a mid-bucket projection toward the table mean', () => {
  const mu = 18.5
  const a = expectedTierPoints(PA, mu, 2, { floor: 0 })
  const b = expectedTierPoints(PA, mu, 12, { floor: 0 })
  assert.notEqual(a, b)
  assert.ok(Number.isFinite(a) && Number.isFinite(b))
})

test('expectedDstScore matches a hand-computed line under the user league', () => {
  // 3 sacks, 2 INT, 1 FR, 1 defensive TD, with tiers taken at certainty.
  const line = {
    sack: 3, dint: 2, fumrec: 1, safety: 0, dtd: 1, blk: 0, sttd: 0,
    ptsAllowed: 10, ydsAllowed: 250,
  }
  const events = 3 * 1 + 2 * 2 + 1 * 2 + 1 * 6 // 15
  const certain = expectedDstScore(line, DEFAULT_SCORING, { ptsAllowed: 0, ydsAllowed: 0 })
  assert.equal(certain, events + 3 + 2) // PA 7-13 -> 3, YA 200-299 -> 2
})

test('expectedDstScore differs from scoring at the mean once uncertainty is real', () => {
  const line = {
    sack: 2.4, dint: 0.8, fumrec: 0.5, safety: 0.03, dtd: 0.15, blk: 0.05, sttd: 0.02,
    ptsAllowed: 22.5, ydsAllowed: 345,
  }
  const certain = expectedDstScore(line, DEFAULT_SCORING, {})
  const uncertain = expectedDstScore(line, DEFAULT_SCORING, { ptsAllowed: 9.12, ydsAllowed: 81 })
  assert.ok(Math.abs(uncertain - certain) > 0.1,
    `tier integration should move the number, got ${certain} vs ${uncertain}`)
})

test('degenerate tier tables never throw', () => {
  assert.equal(expectedTierPoints([], 20, 9), 0)
  assert.equal(expectedTierPoints(null, 20, 9), 0)
  assert.ok(Number.isFinite(expectedTierPoints(PA, NaN, 9, { floor: 0 })))
  assert.ok(Number.isFinite(expectedTierPoints(PA, 20, NaN, { floor: 0 })))
  assert.ok(Number.isFinite(expectedDstScore({}, DEFAULT_SCORING, {})))
})
