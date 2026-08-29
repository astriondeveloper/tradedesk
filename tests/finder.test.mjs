import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findTrades, bestProposal, marketValues, acceptance, needFit,
  rosterMarginals, SHAPES,
} from '../app/js/finder.js'
import { playerPPG, DEFAULT_LEAGUE } from '../app/js/trade.js'
import { slotsFromCounts } from '../app/js/lineup.js'
import { DEFAULT_SCORING, PRESETS } from '../app/js/scoring.js'

globalThis.window = globalThis.window || {}
await import('../app/data/pack.js')
const pack = globalThis.window.TD_PACK

const rank = (pos) => pack.players
  .filter((p) => p.pos === pos && (p.mu || p.kWeeks || p.dstWeeks))
  .sort((a, b) => playerPPG(b) - playerPPG(a))
const QB = rank('QB'), RB = rank('RB'), WR = rank('WR'), TE = rank('TE')
const K = rank('K'), DST = rank('DST')

/** Back-heavy and receiver-poor. */
const rbRich = [QB[3], ...RB.slice(0, 5), ...WR.slice(30, 35), TE[2], TE[10], K[0], DST[0]]
/** The mirror image. */
const wrRich = [QB[4], ...RB.slice(30, 35), ...WR.slice(0, 5), TE[3], TE[11], K[1], DST[1]]

test('market value is measured over replacement, not in raw points', () => {
  const mv = marketValues(pack, DEFAULT_SCORING, DEFAULT_LEAGUE)
  const chase = pack.players.find((p) => p.name === "Ja'Marr Chase")
  const lateQb = QB[Math.min(24, QB.length - 1)]

  assert.ok(mv.get(chase.id) > 6, `an elite WR should carry real trade value, got ${mv.get(chase.id)}`)
  assert.ok(mv.get(lateQb.id) < 3,
    `a replacement-level QB should be near worthless in trade, got ${mv.get(lateQb.id)}`)
  // The failure this guards: on raw points a streamable QB scores about as much as an
  // elite receiver, so the finder priced three bench players as equal to Chase.
  assert.ok(mv.get(chase.id) > mv.get(lateQb.id) * 3)
  for (const [, v] of mv) assert.ok(v >= 0, 'no player should carry negative trade value')
})

test('the finder returns a deal that is good for me and plausible for them', () => {
  const r = findTrades({ myRoster: rbRich, theirRoster: wrRich, pack, opts: { maxMs: 20000 } })
  assert.ok(r.screened > 100, `only screened ${r.screened} packages`)
  assert.ok(r.candidates.length > 0)
  assert.ok(r.proposable.length > 0,
    'complementary rosters must yield at least one proposable trade')

  const top = r.proposable[0]
  assert.ok(top.myDelta > 0, 'a proposable deal must help me')
  assert.ok(top.acceptance.score >= 0.5)
  // The signature of the arbitrage: near-even on names, clearly positive for me.
  assert.ok(Math.abs(top.marketDelta.them) < 12,
    `a proposable deal should price out close to even, got ${top.marketDelta.them}`)
})

test('it gives away depth, not starters', () => {
  const r = findTrades({ myRoster: rbRich, theirRoster: wrRich, pack, opts: { maxMs: 20000 } })
  const top = r.proposable[0]
  assert.ok(top, 'need a proposable deal for this check')
  // The roster is stacked at RB, so the deal should move backs out and receivers in.
  const gaveRB = top.give.filter((p) => p.pos === 'RB').length
  const gotWR = top.get.filter((p) => p.pos === 'WR').length
  assert.ok(gaveRB >= 1, 'should be trading from the position of surplus')
  assert.ok(gotWR >= 1, 'should be trading for the position of need')
})

test('the screen is an approximation and the shortlist is re-scored exactly', () => {
  const r = findTrades({ myRoster: rbRich, theirRoster: wrRich, pack, opts: { maxMs: 20000 } })
  // If screening were exact this would always be zero; it is not, which is why the
  // shortlist gets a real evaluation. What matters is that the error is bounded enough
  // for screening to be useful.
  const errs = r.candidates.map((c) => Math.abs(c.screenError))
  const median = errs.sort((a, b) => a - b)[Math.floor(errs.length / 2)]
  assert.ok(Number.isFinite(median))
  assert.ok(median < 60, `screening error median ${median} is too large to rank on`)
})

test('untouchable players are never offered', () => {
  const keep = new Set([RB[0].id, RB[1].id])
  const r = findTrades({
    myRoster: rbRich, theirRoster: wrRich, pack,
    opts: { untouchable: keep, maxMs: 20000 },
  })
  for (const c of r.candidates) {
    for (const p of c.give) assert.ok(!keep.has(p.id), `${p.name} was marked untouchable`)
  }
})

test('targeting restricts what comes back', () => {
  const want = new Set([WR[0].id])
  const r = findTrades({
    myRoster: rbRich, theirRoster: wrRich, pack,
    opts: { targets: want, maxMs: 20000 },
  })
  for (const c of r.candidates) {
    assert.ok(c.get.every((p) => want.has(p.id)), 'a target list must bound what is asked for')
  }
})

test('acceptance is driven by perceived value, not by true value', () => {
  // Two deals identical from their side on names, one much worse for them in truth. A
  // manager cannot see the second difference, so the scores should be close.
  const looksFair = acceptance({ theirMarketDelta: 0, theirModelDelta: 0, theirNeedFit: 0.7, myMarketDelta: 0 })
  const looksFairIsnt = acceptance({ theirMarketDelta: 0, theirModelDelta: -120, theirNeedFit: 0.7, myMarketDelta: 0 })
  assert.ok(looksFair.score > 0.45, `an even-looking deal should be near a coin flip, got ${looksFair.score}`)
  assert.ok(Math.abs(looksFair.score - looksFairIsnt.score) < 0.15,
    'true value should move the score only a little; they cannot see it')

  // A visible fleece must be rejected regardless.
  const fleece = acceptance({ theirMarketDelta: -35, theirModelDelta: -10, theirNeedFit: 1, myMarketDelta: 35 })
  assert.ok(fleece.score < 0.35, `an obvious fleece should be refused, got ${fleece.score}`)
  assert.match(fleece.read, /refuse|Unlikely/i)

  // And a deal that looks like a gain for them should score high.
  const gift = acceptance({ theirMarketDelta: 12, theirModelDelta: 40, theirNeedFit: 0.9, myMarketDelta: -12 })
  assert.ok(gift.score > 0.75)
})

test('an evenly-priced deal is reachable above the proposable threshold', () => {
  // This is the calibration bug the additive version had: with real value near zero and a
  // mediocre fit, no evenly-priced deal could clear 0.36 however fair it looked.
  const s = acceptance({ theirMarketDelta: 0, theirModelDelta: 0, theirNeedFit: 0.5, myMarketDelta: 0 })
  assert.ok(s.score >= 0.5, `an even deal with average fit scored ${s.score}`)
})

test('need is measured on lineup quality, not on headcount', () => {
  const league = DEFAULT_LEAGUE
  // Five bad backs is exactly the roster that needs a good one. Counting bodies said
  // otherwise, and that mistake suppressed every sensible proposal.
  const fiveBadRBs = [...RB.slice(40, 45), ...WR.slice(0, 4), QB[2], TE[1], K[0], DST[0]]
  const eliteRB = RB[0]
  const anotherBadRB = RB[46]

  const fitGood = needFit(fiveBadRBs, [eliteRB], league, DEFAULT_SCORING)
  const fitBad = needFit(fiveBadRBs, [anotherBadRB], league, DEFAULT_SCORING)
  assert.ok(fitGood > fitBad + 0.2,
    `an upgrade should fit better than more of the same: ${fitGood} vs ${fitBad}`)
  assert.ok(fitGood > 0.7, `a clear starting upgrade should read as a strong fit, got ${fitGood}`)
})

test('marginal value is near zero for a genuine bench player', () => {
  const ctx = {
    weeks: Array.from({ length: 18 }, (_, i) => i + 1),
    slots: slotsFromCounts(DEFAULT_LEAGUE.slots),
    cfg: DEFAULT_SCORING, pack, league: DEFAULT_LEAGUE, cache: new Map(),
  }
  const m = rosterMarginals(rbRich, ctx)
  const starter = m.lose.get(RB[0].id)
  const buried = m.lose.get(RB[4].id)   // the fifth back on a five-back roster
  assert.ok(starter > buried, `the starter should be worth more than the fifth back: ${starter} vs ${buried}`)
  for (const [, v] of m.lose) assert.ok(v >= -1e-6, 'losing a player can never help')
})

test('scoring format changes what the finder proposes', () => {
  const full = findTrades({ myRoster: rbRich, theirRoster: wrRich, pack, cfg: PRESETS.fullPPR, opts: { maxMs: 15000 } })
  const std = findTrades({ myRoster: rbRich, theirRoster: wrRich, pack, cfg: PRESETS.standard, opts: { maxMs: 15000 } })
  const sig = (r) => r.candidates.slice(0, 5).map((c) => c.give.map((p) => p.id).join(',') + '>' + c.get.map((p) => p.id).join(',')).join('|')
  assert.notEqual(sig(full), sig(std), 'the board should differ between full PPR and standard')
})

test('bestProposal returns one deal with its reasoning', () => {
  const r = bestProposal({ myRoster: rbRich, theirRoster: wrRich, pack, opts: { maxMs: 20000 } })
  assert.ok(r.proposal, 'should find something to propose')
  assert.ok(r.proposal.give.length && r.proposal.get.length)
  assert.ok(typeof r.proposal.acceptance.read === 'string')
})

test('it says so honestly when there is nothing worth proposing', () => {
  // Two identical rosters: there is no trade here and the tool should say that rather
  // than manufacture one.
  const r = findTrades({ myRoster: rbRich, theirRoster: [...rbRich], pack, opts: { maxMs: 8000 } })
  assert.ok(r.proposable.length === 0 || r.proposable[0].myDelta > 0)
  if (!r.candidates.length) assert.ok(r.notes.length > 0, 'an empty result needs an explanation')
})

test('degenerate inputs do not throw', () => {
  for (const [a, b] of [[[], []], [rbRich, []], [[], wrRich], [null, null]]) {
    const r = findTrades({ myRoster: a, theirRoster: b, pack, opts: { maxMs: 3000 } })
    assert.ok(Array.isArray(r.candidates))
    assert.ok(Array.isArray(r.notes))
  }
})

test('the search respects its time budget', () => {
  const t0 = Date.now()
  findTrades({ myRoster: rbRich, theirRoster: wrRich, pack, opts: { maxMs: 3000 } })
  const ms = Date.now() - t0
  assert.ok(ms < 12000, `a 3s budget produced a ${ms}ms search`)
})

test('every package shape searched is one someone would actually propose', () => {
  for (const [give, get] of SHAPES) {
    assert.ok(give >= 1 && get >= 1 && give <= 3 && get <= 3)
  }
})
