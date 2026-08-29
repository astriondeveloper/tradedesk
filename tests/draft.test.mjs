import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  draftBoard, assignTiers, survivalOdds, detectRun, riskScore,
  positionScarcity, rosterNeeds, bestAvailable,
} from '../app/js/draft.js'
import { playerPPG } from '../app/js/trade.js'
import { PRESETS } from '../app/js/scoring.js'

globalThis.window = globalThis.window || {}
await import('../app/data/pack.js')
const pack = globalThis.window.TD_PACK

const LEAGUE = { teams: 12, slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BEN: 7 } }
const drafted = pack.players.filter((p) => p.ecr && p.ecr.ov)
const board = (over = {}) => draftBoard({
  available: drafted, myRoster: [], league: LEAGUE, pack, pickNumber: 1, picksUntilNext: 22, ...over,
})

test('the early board is skill players, not kickers and defenses', () => {
  // VONA at the bottom of a thin position used to compare one unrosterable player against
  // a slightly worse one and report the gap as an edge, which put the 43rd-best kicker
  // second overall. The alternative to any pick is floored at replacement level.
  const b = board()
  const top40 = b.board.slice(0, 40)
  const junk = top40.filter((r) => ['K', 'DST'].includes(r.pos))
  assert.equal(junk.length, 0, `K/DST in the top 40: ${junk.map((r) => r.player.name).join(', ')}`)
  assert.ok(['WR', 'RB', 'TE'].includes(b.board[0].pos), 'the first pick should be a skill player')
})

test('kickers surface once everything else is gone', () => {
  const goneIds = new Set(drafted.filter((p) => !['K', 'DST'].includes(p.pos))
    .sort((a, b) => a.ecr.ov - b.ecr.ov).slice(0, 150).map((p) => p.id))
  const late = drafted.filter((p) => !goneIds.has(p.id))
  const b = draftBoard({ available: late, myRoster: [], league: LEAGUE, pack, pickNumber: 151, picksUntilNext: 22 })
  const top10 = b.board.slice(0, 10).map((r) => r.pos)
  assert.ok(top10.includes('K') || top10.includes('DST'),
    'with the skill players drafted, a kicker or defense should finally rank')
})

test('replacement level rises as a position drains', () => {
  const before = board().replacement
  const goneIds = new Set(drafted.filter((p) => p.pos === 'RB')
    .sort((a, b) => playerPPG(b) - playerPPG(a)).slice(0, 40).map((p) => p.id))
  const after = draftBoard({
    available: drafted.filter((p) => !goneIds.has(p.id)),
    myRoster: [], league: LEAGUE, pack, pickNumber: 41, picksUntilNext: 22,
  }).replacement
  assert.ok(after.RB < before.RB,
    `draining RBs should lower what is left: ${before.RB} -> ${after.RB}`)
  assert.ok(Math.abs(after.WR - before.WR) < Math.abs(after.RB - before.RB),
    'the untouched position should move less than the drained one')
})

test('VONA is never larger than the raw gap to the streamable baseline', () => {
  for (const r of board().board) {
    assert.ok(Number.isFinite(r.vona), `${r.player.name} has a non-finite VONA`)
    assert.ok(r.vona <= r.vor + 1e-6,
      `${r.player.name}: VONA ${r.vona} exceeds VOR ${r.vor}, which means the fallback is wrong`)
  }
})

test('tiers group players instead of fragmenting into singletons', () => {
  const b = board()
  for (const pos of ['RB', 'WR', 'TE', 'QB']) {
    const rows = b.byPosition[pos]
    if (rows.length < 12) continue
    const tiers = rows.slice(0, 20).map((r) => r.tier)
    const distinct = new Set(tiers).size
    assert.ok(distinct <= tiers.length * 0.75,
      `${pos}: ${distinct} tiers across ${tiers.length} players is fragmentation, not tiering`)
  }
})

test('a clear gap in a synthetic curve is detected as a tier break', () => {
  const list = [
    { pts: 20 }, { pts: 19.5 }, { pts: 19 },   // tier 1
    { pts: 12 }, { pts: 11.6 }, { pts: 11.2 }, // tier 2 after a 7-point cliff
  ]
  const tiers = assignTiers(list, (p) => p.pts)
  assert.equal(tiers[0], tiers[2], 'the first three belong together')
  assert.notEqual(tiers[2], tiers[3], 'the cliff must start a new tier')
  assert.equal(tiers[3], tiers[5], 'the last three belong together')
})

test('survival odds fall as the wait gets longer', () => {
  const p = drafted.find((x) => x.ecr.ov > 40 && x.ecr.ov < 60)
  const soon = survivalOdds(p, 30, 2)
  const later = survivalOdds(p, 30, 40)
  assert.ok(soon > later, 'a longer wait must mean worse odds he is still there')
  assert.ok(soon <= 1 && later >= 0)
})

test('roster need weights a position but never overrides a large edge', () => {
  const b0 = board()
  const topRB = b0.byPosition.RB[0].player
  // A roster already stuffed with backs should not keep ranking backs first.
  const stuffed = pack.players.filter((p) => p.pos === 'RB')
    .sort((a, b) => playerPPG(b) - playerPPG(a)).slice(0, 5)
  const b1 = draftBoard({
    available: drafted.filter((p) => !stuffed.some((s) => s.id === p.id)),
    myRoster: stuffed, league: LEAGUE, pack, pickNumber: 6, picksUntilNext: 22,
  })
  const rbRankBefore = b0.board.findIndex((r) => r.pos === 'RB')
  const rbRankAfter = b1.board.findIndex((r) => r.pos === 'RB')
  assert.ok(rbRankAfter >= rbRankBefore,
    'filling the RB slots should not make RBs more urgent')
  assert.ok(topRB)
})

test('a positional run is detected', () => {
  const picks = [{ pos: 'RB' }, { pos: 'RB' }, { pos: 'WR' }, { pos: 'RB' },
    { pos: 'RB' }, { pos: 'RB' }, { pos: 'WR' }, { pos: 'QB' }]
  const { runs } = detectRun(picks)
  assert.ok(runs.length >= 1)
  assert.equal(runs[0].pos, 'RB')
  assert.match(runs[0].text, /5 of the last 8/)

  const calm = [{ pos: 'RB' }, { pos: 'WR' }, { pos: 'TE' }, { pos: 'QB' },
    { pos: 'WR' }, { pos: 'RB' }, { pos: 'WR' }, { pos: 'TE' }]
  assert.equal(detectRun(calm).runs.length, 0, 'a balanced board is not a run')
})

test('risk combines availability, market disagreement and volatility', () => {
  const safe = { avail: 0.96, ecr: { sd: 3 }, cv: 0.25 }
  const risky = { avail: 0.62, ecr: { sd: 35 }, cv: 0.85 }
  assert.ok(riskScore(risky) > riskScore(safe))
  assert.ok(riskScore(safe) >= 0 && riskScore(risky) <= 1)
  assert.ok(Number.isFinite(riskScore({})), 'a bare player object must not produce NaN')
})

test('scarcity reflects how many startable players are left', () => {
  const s = positionScarcity({ available: drafted, league: LEAGUE, pack })
  for (const [pos, v] of Object.entries(s)) {
    assert.ok(v.scarcity >= 0 && v.scarcity <= 1, `${pos} scarcity ${v.scarcity}`)
    assert.ok(Number.isFinite(v.replacement))
  }
})

test('scoring format changes the board', () => {
  const full = board({ cfg: PRESETS.fullPPR }).board.slice(0, 30).map((r) => r.player.id)
  const std = board({ cfg: PRESETS.standard }).board.slice(0, 30).map((r) => r.player.id)
  assert.notDeepEqual(full, std, 'full PPR and standard should not produce the same board')
})

test('an empty or tiny board does not throw', () => {
  for (const available of [[], drafted.slice(0, 3), null]) {
    const b = draftBoard({ available, myRoster: [], league: LEAGUE, pack, pickNumber: 1 })
    assert.ok(Array.isArray(b.board))
  }
  assert.ok(Array.isArray(bestAvailable({ available: drafted, league: LEAGUE, pack })))
  assert.ok(rosterNeeds([], LEAGUE).need.RB > 0)
})

test('the board is fast enough to recompute after every pick', () => {
  const t0 = Date.now()
  for (let i = 0; i < 5; i++) board({ pickNumber: 1 + i * 12 })
  const ms = (Date.now() - t0) / 5
  assert.ok(ms < 400, `${ms.toFixed(0)}ms per board is too slow for a live draft`)
})
