/**
 * Trade evaluator tests.
 *
 * These assert the three claims the tool is built on, against the real projection set.
 * If any of them stops holding, the tool has stopped being worth using.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateTrade, suggestFair, playerPPG, DEFAULT_LEAGUE } from '../app/js/trade.js'
import { DEFAULT_SCORING, PRESETS } from '../app/js/scoring.js'

globalThis.window = globalThis.window || {}
await import('../app/data/pack.js')
const pack = globalThis.window.TD_PACK

const rank = (pos) => pack.players
  .filter((p) => p.pos === pos && (p.mu || p.kWeeks || p.dstWeeks))
  .sort((a, b) => playerPPG(b) - playerPPG(a))

const RB = rank('RB'), WR = rank('WR'), QB = rank('QB'), TE = rank('TE')
const K = rank('K'), DST = rank('DST')

/** A legal, realistic roster: 1 QB, 5 RB, 6 WR, 2 TE, K, D/ST. */
function roster({ rbFrom = 0, wrFrom = 0, qb = 4, te = 3 } = {}) {
  return [
    QB[qb],
    ...RB.slice(rbFrom, rbFrom + 5),
    ...WR.slice(wrFrom, wrFrom + 6),
    TE[te], TE[te + 8],
    K[0], DST[0],
  ].filter(Boolean)
}

const noSim = { sim: false }

test('a trade returns a complete verdict for both sides', () => {
  const A = roster({ rbFrom: 0, wrFrom: 20 })
  const B = roster({ rbFrom: 20, wrFrom: 0, qb: 5, te: 4 })
  const v = evaluateTrade({ rosterA: A, rosterB: B, sendA: [A[1]], sendB: [B[6]], pack, opts: noSim })

  for (const side of [v.A, v.B]) {
    assert.ok(Number.isFinite(side.starters.delta), 'starter delta must be finite')
    assert.ok(Number.isFinite(side.par.delta))
    assert.ok(Number.isFinite(side.bench.delta))
    assert.ok(side.perWeek.length === v.weeks.length)
    assert.ok(Array.isArray(side.flags))
  }
  assert.ok(v.headline.verdict)
  assert.ok(v.replacement.RB > 0 && v.replacement.WR > 0)
})

test('two RB2s for one RB1: point-summing and the real math disagree', () => {
  // The headline case. A roster already deep at back gains nothing from a second RB2,
  // because he lands on a bench where he scores zero.
  const rb1 = RB[0]
  const rb2a = RB[14]
  const rb2b = RB[18]

  const deepAtRB = [QB[4], rb1, ...RB.slice(3, 7), ...WR.slice(4, 10), TE[3], TE[11], K[0], DST[0]]
  const otherSide = [QB[5], rb2a, rb2b, ...RB.slice(30, 33), ...WR.slice(10, 16), TE[4], TE[12], K[1], DST[1]]

  const v = evaluateTrade({
    rosterA: deepAtRB, rosterB: otherSide, sendA: [rb1], sendB: [rb2a, rb2b], pack, opts: noSim,
  })

  const naive = playerPPG(rb2a) + playerPPG(rb2b) - playerPPG(rb1)
  assert.ok(naive > 0, 'setup: the two RB2s must out-total the RB1 on raw points')

  // Point-summing says the RB1 side gains. The starter math must say otherwise.
  assert.ok(v.A.starters.delta < 0,
    `side giving up the RB1 should lose starter points, got ${v.A.starters.delta}`)
  assert.ok(v.B.starters.delta > 0,
    `side giving up two RB2s should gain, got ${v.B.starters.delta}`)

  // And the tool must SAY so rather than leaving the user to notice.
  const flagged = v.A.flags.some((f) => /direction wrong/.test(f.text))
  assert.ok(flagged, 'the reversal should be flagged explicitly')
})

test('the same trade is worth different things to differently shaped rosters', () => {
  const give = RB[6]
  const get = WR[6]

  const backHeavy = [QB[4], give, ...RB.slice(1, 5), ...WR.slice(30, 35), TE[3], TE[11], K[0], DST[0]]
  const wideHeavy = [QB[5], give, ...RB.slice(40, 44), ...WR.slice(0, 5), TE[4], TE[12], K[1], DST[1]]

  const a = evaluateTrade({
    rosterA: backHeavy, rosterB: wideHeavy, sendA: [give], sendB: [get], pack, opts: noSim,
  })
  const b = evaluateTrade({
    rosterA: wideHeavy, rosterB: backHeavy, sendA: [give], sendB: [get], pack, opts: noSim,
  })

  // Same players moving, two roster shapes: the deltas must not match.
  assert.ok(Math.abs(a.A.starters.delta - b.A.starters.delta) > 5,
    `roster shape should change the valuation: ${a.A.starters.delta} vs ${b.A.starters.delta}`)
})

test('bench depth is priced as insurance, not at face value', () => {
  const A = roster({ rbFrom: 0, wrFrom: 20 })
  const B = roster({ rbFrom: 20, wrFrom: 0, qb: 5, te: 4 })
  const v = evaluateTrade({ rosterA: A, rosterB: B, sendA: [A[1]], sendB: [B[6]], pack, opts: noSim })

  assert.ok(v.A.bench.after > 0, 'a real roster has some bench value')
  const faceValue = v.A._rosters.after.reduce((s, p) => s + playerPPG(p), 0) * v.weeks.length
  assert.ok(v.A.bench.after < faceValue * 0.2,
    'bench value must be far below the face value of the players sitting on it')

  for (const d of v.A.bench.detail) {
    assert.ok(d.benchShare > 0 && d.benchShare <= 1, `bad benchShare ${d.benchShare}`)
    assert.ok(d.entryRate > 0 && d.entryRate <= 1)
    assert.ok(d.edgeOverReplacement >= 0)
  }
})

test('playoff weeks are weighted and reported separately', () => {
  const A = roster({ rbFrom: 0, wrFrom: 20 })
  const B = roster({ rbFrom: 20, wrFrom: 0, qb: 5, te: 4 })
  const v = evaluateTrade({ rosterA: A, rosterB: B, sendA: [A[1]], sendB: [B[6]], pack, opts: noSim })

  const playoffRows = v.A.perWeek.filter((w) => w.playoff)
  assert.equal(playoffRows.length, DEFAULT_LEAGUE.playoffWeeks.length)
  const summed = playoffRows.reduce((s, w) => s + w.delta, 0)
  assert.ok(Math.abs(summed - v.A.playoffDelta) < 1e-6, 'playoffDelta must be the sum of those weeks')

  // Weighting them must move the weighted ledger relative to the flat one.
  const flat = evaluateTrade({
    rosterA: A, rosterB: B, sendA: [A[1]], sendB: [B[6]], pack, opts: noSim,
    league: { playoffWeight: 1 },
  })
  if (Math.abs(v.A.playoffDelta) > 0.01) {
    assert.notEqual(v.A.weighted.delta, flat.A.weighted.delta)
  }
})

test('a bye collision is visible in the week-by-week ledger', () => {
  // Build a roster whose two startable tight ends share a bye, so one week has no TE.
  const byeGroups = new Map()
  for (const p of TE.slice(0, 40)) {
    if (!byeGroups.has(p.bye)) byeGroups.set(p.bye, [])
    byeGroups.get(p.bye).push(p)
  }
  const pair = [...byeGroups.values()].find((g) => g.length >= 2)
  assert.ok(pair, 'setup: need two tight ends sharing a bye')

  const r = [QB[4], ...RB.slice(0, 5), ...WR.slice(0, 6), pair[0], pair[1], K[0], DST[0]]
  const other = roster({ rbFrom: 20, wrFrom: 20, qb: 6, te: 6 })
  const v = evaluateTrade({ rosterA: r, rosterB: other, sendA: [], sendB: [], pack, opts: noSim })

  const byeWeek = pair[0].bye
  const row = v.A.perWeek.find((w) => w.week === byeWeek)
  assert.ok(row, `no ledger row for week ${byeWeek}`)
  const ledgerWeek = v.A._ledgers.before.perWeek.find((w) => w.week === byeWeek)
  assert.ok(ledgerWeek.empty.includes('TE') || ledgerWeek.points < v.A._ledgers.before.total / v.weeks.length,
    'a shared TE bye should leave the slot empty or visibly depress that week')
})

test('an empty trade changes nothing', () => {
  const A = roster({ rbFrom: 0, wrFrom: 20 })
  const B = roster({ rbFrom: 20, wrFrom: 0, qb: 5, te: 4 })
  const v = evaluateTrade({ rosterA: A, rosterB: B, sendA: [], sendB: [], pack, opts: noSim })
  assert.ok(Math.abs(v.A.starters.delta) < 1e-9)
  assert.ok(Math.abs(v.B.starters.delta) < 1e-9)
  assert.equal(v.headline.verdict, 'even')
})

test('degenerate inputs never throw or produce NaN', () => {
  const A = roster()
  const cases = [
    { rosterA: [], rosterB: [], sendA: [], sendB: [] },
    { rosterA: A, rosterB: [], sendA: [A[0]], sendB: [] },
    { rosterA: A, rosterB: A, sendA: [A[0]], sendB: [A[0]] },          // same player both ways
    { rosterA: A, rosterB: roster({ rbFrom: 9 }), sendA: [RB[55]], sendB: [] }, // not on the roster
    { rosterA: [...A, ...A], rosterB: roster({ rbFrom: 9 }), sendA: [], sendB: [] }, // duplicates
  ]
  for (const c of cases) {
    const v = evaluateTrade({ ...c, pack, opts: noSim })
    assert.ok(Number.isFinite(v.A.starters.delta), `NaN for ${JSON.stringify(Object.keys(c))}`)
    assert.ok(Number.isFinite(v.B.starters.delta))
    assert.ok(v.headline.verdict)
  }
})

test('the roster limit is flagged rather than silently absorbed', () => {
  const A = roster()
  const B = roster({ rbFrom: 20, wrFrom: 20, qb: 6, te: 6 })
  const v = evaluateTrade({
    rosterA: A, rosterB: B, sendA: [], sendB: B.slice(0, 6), pack, opts: noSim,
  })
  assert.ok(v.A.roster.after > v.A.roster.limit, 'setup: A should be over the limit')
  assert.ok(v.A.flags.some((f) => /roster limit/i.test(f.text)), 'over-limit must be flagged')
})

test('scoring format changes the verdict', () => {
  // A pass-catching back should be worth more in full PPR than in standard, and the
  // verdict should move with it. This is the whole point of scoring in the browser.
  const catcher = RB.filter((p) => p.mu && p.mu.rec > 3).sort((a, b) => b.mu.rec - a.mu.rec)[0]
  assert.ok(catcher, 'setup: need a pass-catching back')
  const grinder = RB.filter((p) => p.mu && p.mu.rec < 1.5 && p.mu.ratt > 10)[0]
  assert.ok(grinder, 'setup: need a between-the-tackles back')

  const A = [QB[4], catcher, ...RB.slice(25, 29), ...WR.slice(10, 16), TE[3], TE[11], K[0], DST[0]]
  const B = [QB[5], grinder, ...RB.slice(29, 33), ...WR.slice(16, 22), TE[4], TE[12], K[1], DST[1]]

  const full = evaluateTrade({
    rosterA: A, rosterB: B, sendA: [catcher], sendB: [grinder], pack,
    cfg: PRESETS.fullPPR, opts: noSim,
  })
  const std = evaluateTrade({
    rosterA: A, rosterB: B, sendA: [catcher], sendB: [grinder], pack,
    cfg: PRESETS.standard, opts: noSim,
  })
  assert.notEqual(full.A.starters.delta.toFixed(2), std.A.starters.delta.toFixed(2))
  // Giving up the receiver hurts more under full PPR than under standard.
  assert.ok(full.A.starters.delta < std.A.starters.delta + 1e-6,
    `full PPR should punish losing the pass-catcher more: ${full.A.starters.delta} vs ${std.A.starters.delta}`)
})

test('suggestFair searches the other roster for a real sweetener', () => {
  const A = roster({ rbFrom: 0, wrFrom: 20 })
  const B = roster({ rbFrom: 20, wrFrom: 0, qb: 5, te: 4 })
  const out = suggestFair({ rosterA: A, rosterB: B, sendA: [A[1], A[2]], sendB: [B[6]], pack, opts: noSim })
  assert.ok(out.suggestions.length > 0)
  for (const s of out.suggestions) {
    assert.ok(s.player && s.player.id && s.player.name)
    assert.ok(Number.isFinite(s.deltaA) && Number.isFinite(s.deltaB))
  }
  // The best suggestion must be at least as balanced as the worst one returned.
  const first = out.suggestions[0]
  const last = out.suggestions[out.suggestions.length - 1]
  assert.ok(first.bothPositive === last.bothPositive ? first.imbalance <= last.imbalance : true)
})

test('the simulation reports change in expected wins and playoff odds', () => {
  const A = roster({ rbFrom: 0, wrFrom: 20 })
  const B = roster({ rbFrom: 20, wrFrom: 0, qb: 5, te: 4 })
  const v = evaluateTrade({
    rosterA: A, rosterB: B, sendA: [A[1]], sendB: [B[6]], pack,
    opts: { sim: true, draws: 200 },
  })
  assert.ok(v.sim, 'simulation block missing')
  for (const key of ['A', 'B']) {
    const s = v.sim[key]
    assert.ok(Number.isFinite(s.expectedWins.delta), 'expected wins delta must be finite')
    assert.ok(Number.isFinite(s.playoffOdds.delta), 'playoff odds delta must be finite')
    assert.ok(s.playoffOdds.before >= 0 && s.playoffOdds.before <= 1)
  }
})

test('evaluation is fast enough to run live while the user edits a trade', () => {
  const A = roster({ rbFrom: 0, wrFrom: 20 })
  const B = roster({ rbFrom: 20, wrFrom: 0, qb: 5, te: 4 })
  const t0 = Date.now()
  const N = 20
  for (let i = 0; i < N; i++) {
    evaluateTrade({ rosterA: A, rosterB: B, sendA: [A[1 + (i % 4)]], sendB: [B[6]], pack, opts: noSim })
  }
  const ms = (Date.now() - t0) / N
  assert.ok(ms < 250, `${ms.toFixed(0)}ms per evaluation is too slow for live editing`)
})
