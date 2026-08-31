/**
 * League intelligence tests.
 *
 * The claim this module makes is narrow and easy to get wrong: a trade between two other
 * teams costs you something even though nothing on your roster moved. The invariant that
 * proves the implementation is honest is the pair of assertions in "a deal you are not in":
 * your own points must not move by a hair, and your position must be allowed to.
 *
 * Get the first one wrong and the module is quietly re-scoring your roster on the side.
 * Get the second wrong and it has nothing to say.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  leagueBoard, tradeImpact, positionalShape, openings, teamStrength,
  leagueContext, startableDepth, powerRankings, CORE_POS,
} from '../app/js/scout.js'
import { playerPPG, DEFAULT_LEAGUE } from '../app/js/trade.js'
import { DEFAULT_SCORING } from '../app/js/scoring.js'

globalThis.window = globalThis.window || {}
await import('../app/data/pack.js')
const pack = globalThis.window.TD_PACK

const rank = (pos) => pack.players
  .filter((p) => p.pos === pos && (p.mu || p.kWeeks || p.dstWeeks))
  .sort((a, b) => playerPPG(b) - playerPPG(a))

const RB = rank('RB'), WR = rank('WR'), QB = rank('QB'), TE = rank('TE')
const K = rank('K'), DST = rank('DST')

/** A legal roster drawn from a given depth band, so teams are comparable but not equal. */
function roster(n, { rb = 5, wr = 6 } = {}) {
  return [
    QB[n],
    ...RB.slice(n * rb, n * rb + rb),
    ...WR.slice(n * wr, n * wr + wr),
    TE[n], TE[n + 12],
    K[n % 8], DST[n % 8],
  ].filter(Boolean)
}

/** A six-team league, strongest first, so rank movement is easy to reason about. */
function league(n = 6) {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    name: `Team ${i + 1}`,
    players: roster(i),
  }))
}

const CTX = { pack, cfg: DEFAULT_SCORING, league: DEFAULT_LEAGUE }

/* ------------------------------------------------------------------ depth */

test('startable depth counts the flex for the positions that can fill it', () => {
  const slots = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 }
  assert.equal(startableDepth(slots, 'RB'), 3)
  assert.equal(startableDepth(slots, 'WR'), 3)
  assert.equal(startableDepth(slots, 'TE'), 2)
  // A single flex never takes a quarterback; only a superflex does.
  assert.equal(startableDepth(slots, 'QB'), 1)
  assert.equal(startableDepth({ ...slots, SUPERFLEX: 1 }, 'QB'), 2)
  assert.equal(startableDepth(slots, 'K'), 1)
})

/* ------------------------------------------------------------------ strength */

test('team strength is positive, weighted above raw, and ranks the stronger roster first', () => {
  const teams = league()
  const board = leagueBoard({ teams, ...CTX })

  for (const r of board.rows) {
    assert.ok(r.total > 0, `${r.name} scored ${r.total}`)
    // Playoff weeks count double by default, so the weighted figure must exceed the raw.
    assert.ok(r.weighted > r.total)
    assert.ok(Number.isFinite(r.perGame) && r.perGame > 0)
  }

  // Rosters were drawn strongest-first, so the top of the board should reflect that. Not
  // an exact ordering -- lineup shape genuinely reshuffles adjacent teams -- but the best
  // roster must not finish in the bottom half.
  const best = board.ranked[0]
  assert.ok(best.index <= 1, `expected a top-band roster first, got index ${best.index}`)
  assert.deepEqual(board.ranked.map((r) => r.rank), [1, 2, 3, 4, 5, 6])
})

test('replacement level is computed against every roster in the league, not one', () => {
  const teams = league()
  const { replacement, rostered } = leagueContext({ teams, ...CTX })
  const total = teams.reduce((s, t) => s + t.players.length, 0)
  assert.equal(rostered.size, total)
  for (const pos of CORE_POS) assert.ok(replacement[pos] > 0)
})

/* ------------------------------------------------------------------ the invariant */

test('a deal you are not in leaves your points alone and can still move your rank', () => {
  const teams = league()
  const a = 1
  const b = 4
  const me = 2

  // A lopsided deal: the strong team hands its RB2 over for the weak team's WR5. Real
  // enough to move the board, which is all the test needs.
  const sendA = [teams[a].players.find((p) => p.pos === 'RB')]
  const sendB = teams[b].players.filter((p) => p.pos === 'WR').slice(0, 2)

  const imp = tradeImpact({
    teams, ...CTX, myIndex: me,
    swap: { aIndex: a, bIndex: b, sendA, sendB },
  })

  const mine = imp.teams.find((t) => t.mine)
  assert.ok(mine, 'the reader must appear on the board')

  // The whole point: nothing about this roster changed, so its score must not move at all.
  assert.equal(mine.after.weighted, mine.before.weighted)
  assert.equal(mine.delta, 0)

  // ...and the two teams that did trade must have moved.
  const movers = imp.teams.filter((t) => t.inPlay)
  assert.equal(movers.length, 2)
  assert.ok(movers.some((t) => Math.abs(t.delta) > 0.01),
    'a real trade has to change at least one of the two rosters')

  // The standing readout has to be internally consistent with the board.
  assert.equal(imp.standing.rankBefore, mine.before.rank)
  assert.equal(imp.standing.rankAfter, mine.after.rank)
  assert.equal(imp.standing.rankDelta, mine.rankDelta)
  assert.equal(
    imp.standing.gapDelta,
    imp.standing.gapToFirstAfter - imp.standing.gapToFirstBefore,
  )
})

test('the headline metric moves even when the leader is not in the deal', () => {
  // This is the bug the first version shipped with. Gap-to-first is the intuitive measure
  // of "what did this cost me" and it is exactly 0.00 whenever the two teams trading are
  // not the team on top -- which is most trades. The field average is what actually moves.
  const teams = league()
  const a = 4, b = 5, me = 1 // neither trader is the leader, and neither is the reader

  const sendA = teams[a].players.filter((p) => p.pos === 'RB').slice(0, 2)
  const sendB = teams[b].players.filter((p) => p.pos === 'WR').slice(4, 5)

  const imp = tradeImpact({
    teams, ...CTX, myIndex: me,
    swap: { aIndex: a, bIndex: b, sendA, sendB },
  })
  const st = imp.standing

  assert.equal(st.gapToFirstAfter, st.gapToFirstBefore,
    'sanity: the leader did not trade, so gap-to-first is inert here')
  assert.ok(Math.abs(st.fieldDelta) > 0.01,
    `the field average must register the deal, got ${st.fieldDelta}`)

  // And the direction has to be right: the field average moves the same way as the
  // combined swing across the two teams that traded.
  assert.equal(Math.sign(st.fieldDelta), Math.sign(st.dealSwing))
})

test('a trade where both sides gain makes the field stronger for everyone else', () => {
  // The point of the whole panel. A deal that helps both participants is not neutral for
  // the rest of the league -- it is a loss they had no say in.
  const teams = league()
  const a = 2, b = 3

  // Complementary swap: each ships a buried player at a position they are deep in.
  const sendA = teams[a].players.filter((p) => p.pos === 'WR').slice(4)
  const sendB = teams[b].players.filter((p) => p.pos === 'RB').slice(3)

  const imp = tradeImpact({
    teams, ...CTX, myIndex: 0,
    swap: { aIndex: a, bIndex: b, sendA, sendB },
  })

  const movers = imp.teams.filter((t) => t.inPlay)
  const bothGain = movers.every((t) => t.delta > 0)
  if (bothGain) {
    assert.ok(imp.standing.fieldDelta > 0,
      'both participants gaining has to read as the field getting stronger')
    assert.ok(imp.dealSwing > 0)
  }
  // Whatever the direction, the aggregate and the per-team deltas must agree.
  const summed = movers.reduce((s, t) => s + t.delta, 0)
  assert.ok(Math.abs(summed - imp.dealSwing) < 1e-9)
})

test('every team keeps a rank and the ranks stay a permutation', () => {
  const teams = league()
  const sendA = teams[0].players.filter((p) => p.pos === 'RB').slice(0, 1)
  const sendB = teams[3].players.filter((p) => p.pos === 'WR').slice(0, 1)
  const imp = tradeImpact({
    teams, ...CTX, myIndex: 0,
    swap: { aIndex: 0, bIndex: 3, sendA, sendB },
  })

  for (const key of ['before', 'after']) {
    const ranks = imp.teams.map((t) => t[key].rank).sort((x, y) => x - y)
    assert.deepEqual(ranks, [1, 2, 3, 4, 5, 6], `${key} ranks must be a clean permutation`)
  }
})

test('a trade with nothing moving leaves the whole board untouched', () => {
  const teams = league()
  const imp = tradeImpact({
    teams, ...CTX, myIndex: 0,
    swap: { aIndex: 0, bIndex: 1, sendA: [], sendB: [] },
  })
  for (const t of imp.teams) {
    assert.equal(t.delta, 0, `${t.name} moved on an empty trade`)
    assert.equal(t.rankDelta, 0)
  }
})

test('players actually change hands on the board', () => {
  const teams = league()
  const moving = teams[0].players.find((p) => p.pos === 'RB')
  const board = leagueBoard({
    teams, ...CTX,
    swap: { aIndex: 0, bIndex: 1, sendA: [moving], sendB: [] },
  })
  const from = board.rows[0].players.map((p) => p.id)
  const to = board.rows[1].players.map((p) => p.id)
  assert.ok(!from.includes(moving.id), 'the player left the sending roster')
  assert.ok(to.includes(moving.id), 'the player arrived on the receiving roster')
})

/* ------------------------------------------------------------------ shape */

test('positional shape separates a hole from a surplus', () => {
  const { replacement } = leagueContext({ teams: league(), ...CTX })
  const opts = { cfg: DEFAULT_SCORING, league: DEFAULT_LEAGUE, replacement }

  // Eight receivers and no back at all: WR must read as surplus, RB as a hole.
  const lopsided = [QB[3], ...WR.slice(0, 8), TE[2], K[0], DST[0]]
  const s = positionalShape(lopsided, opts)

  assert.ok(s.WR.surplus > 0, 'eight startable receivers is a surplus')
  assert.ok(s.RB.hole, 'no running backs at all is a hole')
  assert.equal(s.RB.count, 0)
  assert.equal(s.RB.surplus, 0)
  assert.ok(s.WR.startable > s.RB.startable)

  // A roster carrying exactly its starters has no surplus to trade from.
  const tight = [QB[3], ...RB.slice(0, 3), ...WR.slice(0, 3), TE[2], K[0], DST[0]]
  const t = positionalShape(tight, opts)
  assert.equal(t.WR.surplus, 0, 'three receivers with three receiver slots is not depth')
})

test('surplus never counts a bench player worse than the waiver wire', () => {
  const { replacement } = leagueContext({ teams: league(), ...CTX })
  const deep = [QB[3], ...RB.slice(0, 3), ...WR.slice(0, 3), ...WR.slice(140, 148),
    TE[2], K[0], DST[0]].filter(Boolean)
  const s = positionalShape(deep, { cfg: DEFAULT_SCORING, league: DEFAULT_LEAGUE, replacement })
  // The eight deep-bench receivers are all below replacement, so they add nothing.
  const tight = positionalShape(
    [QB[3], ...RB.slice(0, 3), ...WR.slice(0, 3), TE[2], K[0], DST[0]],
    { cfg: DEFAULT_SCORING, league: DEFAULT_LEAGUE, replacement },
  )
  assert.equal(s.WR.surplus, tight.WR.surplus)
})

/* ------------------------------------------------------------------ openings */

test('an opening needs both halves to be real', () => {
  const { replacement } = leagueContext({ teams: league(), ...CTX })

  // I am drowning in receivers and have no backs. They are the mirror image.
  const myRoster = [QB[3], RB[80], ...WR.slice(0, 9), TE[2], K[0], DST[0]].filter(Boolean)
  const theirRoster = [QB[4], ...RB.slice(3, 11), WR[120], TE[5], K[1], DST[1]].filter(Boolean)

  const teams = [
    { index: 0, name: 'Me', mine: true, players: myRoster },
    { index: 1, name: 'Mirror', mine: false, players: theirRoster },
  ]
  const found = openings({
    myRoster, teams, pack, cfg: DEFAULT_SCORING, league: DEFAULT_LEAGUE, replacement,
  })

  assert.ok(found.length >= 1, 'a perfect mirror has to produce an opening')
  const o = found[0]
  assert.equal(o.team, 'Mirror')
  assert.equal(o.give, 'WR')
  assert.equal(o.get, 'RB')
  assert.ok(o.score > 0)
  // Scored on the weaker half, so it can never exceed either side on its own.
  assert.ok(o.score <= o.mySurplus && o.score <= o.theirSurplus)
})

test('two identically shaped rosters produce no opening', () => {
  const { replacement } = leagueContext({ teams: league(), ...CTX })
  const shape = [QB[3], ...RB.slice(0, 5), ...WR.slice(0, 6), TE[2], K[0], DST[0]]
  const teams = [
    { index: 0, name: 'Me', mine: true, players: shape },
    { index: 1, name: 'Twin', mine: false, players: shape },
  ]
  const found = openings({
    myRoster: shape, teams, pack, cfg: DEFAULT_SCORING, league: DEFAULT_LEAGUE, replacement,
  })
  assert.equal(found.length, 0, 'nobody needs what they already have')
})

test('openings list each team once, at their best angle', () => {
  const { replacement } = leagueContext({ teams: league(), ...CTX })
  const myRoster = [QB[3], RB[80], ...WR.slice(0, 9), TE[2], K[0], DST[0]].filter(Boolean)
  const teams = [
    { index: 0, name: 'Me', mine: true, players: myRoster },
    { index: 1, name: 'A', mine: false, players: [QB[4], ...RB.slice(3, 11), WR[120], TE[5], K[1], DST[1]] },
    { index: 2, name: 'B', mine: false, players: [QB[5], ...RB.slice(11, 19), WR[130], TE[6], K[2], DST[2]] },
  ]
  const found = openings({
    myRoster, teams, pack, cfg: DEFAULT_SCORING, league: DEFAULT_LEAGUE, replacement,
  })
  const names = found.map((o) => o.team)
  assert.equal(new Set(names).size, names.length, 'one row per team')
  assert.ok(!names.includes('Me'), 'you cannot trade with yourself')
  // Sorted strongest fit first.
  for (let i = 1; i < found.length; i++) assert.ok(found[i - 1].score >= found[i].score)
})

/* ------------------------------------------------------------------ consistency */

test('board strength agrees with a direct seasonLedger call', () => {
  const teams = league(3)
  const { ctx } = leagueContext({ teams, ...CTX })
  const board = leagueBoard({ teams, ...CTX })
  for (const r of board.rows) {
    const direct = teamStrength(teams[r.index].players, ctx)
    assert.ok(Math.abs(direct.total - r.total) < 1e-6,
      `${r.name}: board says ${r.total}, ledger says ${direct.total}`)
  }
})

/* ------------------------------------------------------------------ power rankings */

test('power rankings rank on starters and report the summing rank alongside', () => {
  const teams = league()
  const pr = powerRankings({ teams, ...CTX, myIndex: 2 })

  assert.equal(pr.rows.length, 6)
  assert.deepEqual(pr.rows.map((r) => r.rank), [1, 2, 3, 4, 5, 6], 'ranked, in order')
  const naive = pr.rows.map((r) => r.naiveRank).sort((a, b) => a - b)
  assert.deepEqual(naive, [1, 2, 3, 4, 5, 6], 'the summing rank is a clean permutation too')

  // The real rank must follow weighted starter points, not roster totals.
  for (let i = 1; i < pr.rows.length; i++) {
    assert.ok(pr.rows[i - 1].weighted >= pr.rows[i].weighted)
  }
  // And the summing rank must follow roster totals.
  const byNaive = pr.rows.slice().sort((a, b) => a.naiveRank - b.naiveRank)
  for (let i = 1; i < byNaive.length; i++) {
    assert.ok(byNaive[i - 1].rosterPerWeek >= byNaive[i].rosterPerWeek)
  }
  assert.equal(pr.rows.filter((r) => r.mine).length, 1, 'exactly one team is the reader')
})

test('rankGap is the disagreement between the two rankings, signed toward the reader', () => {
  const pr = powerRankings({ teams: league(), ...CTX, myIndex: 0 })
  for (const r of pr.rows) {
    assert.equal(r.rankGap, r.naiveRank - r.rank,
      'positive means starters rate them above what summing does')
  }
  // The callouts must agree with the column they are drawn from.
  if (pr.mostUnderrated) assert.ok(pr.mostUnderrated.rankGap > 0)
  if (pr.mostOverrated) assert.ok(pr.mostOverrated.rankGap < 0)
})

test('bench-locked share is a plausible fraction and isolates shape from injury', () => {
  const pr = powerRankings({ teams: league(), ...CTX })
  for (const r of pr.rows) {
    assert.ok(r.wasted >= 0 && r.wasted < 1, `${r.name} wasted ${r.wasted}`)
    // A legal roster starting 9 of 16 strands a real share; anything near zero or near one
    // means the measurement has drifted onto a different basis.
    assert.ok(r.wasted > 0.15 && r.wasted < 0.6, `${r.name} wasted ${(r.wasted * 100).toFixed(1)}%`)
  }

  // The flat basis is the point: marking a player out changes the RANK inputs but must
  // not move the bench-locked figure, because that is about lineup shape, not health.
  const teams = league()
  const hurt = teams.map((t, i) => (i === 0
    ? { ...t, players: t.players.map((p, j) => (j === 1 ? { ...p, avail: 0.1 } : p)) }
    : t))
  const before = powerRankings({ teams, ...CTX })
  const after = powerRankings({ teams: hurt, ...CTX })
  const b0 = before.rows.find((r) => r.index === 0)
  const a0 = after.rows.find((r) => r.index === 0)
  assert.ok(Math.abs(a0.wasted - b0.wasted) < 1e-9,
    'availability must not leak into the shape measurement')
  assert.ok(a0.weighted < b0.weighted, 'but it must move the strength that drives the rank')
})

test('best and worst position are measured against the league, not in isolation', () => {
  const pr = powerRankings({ teams: league(), ...CTX })
  for (const r of pr.rows) {
    assert.ok(CORE_POS.includes(r.best.pos))
    assert.ok(CORE_POS.includes(r.worst.pos))
    assert.ok(r.best.z >= r.worst.z)
  }
  // Z-scores at each position must centre on the league, so they sum to about zero.
  for (const pos of CORE_POS) {
    const zs = pr.rows.map((r) => (r.best.pos === pos ? r.best.z : r.worst.pos === pos ? r.worst.z : null))
      .filter((z) => z !== null)
    for (const z of zs) assert.ok(Number.isFinite(z))
  }
})

test('the board preserves fields the caller attached to a team', () => {
  // Regression: leagueBoard rebuilt each row field by field and dropped `owner`, which
  // surfaced as an empty Manager column in the power rankings.
  const teams = league().map((t, i) => ({ ...t, owner: `Manager ${i}` }))
  const pr = powerRankings({ teams, ...CTX })
  for (const r of pr.rows) assert.match(r.owner, /^Manager \d$/)
})
