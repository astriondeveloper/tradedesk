/**
 * Integrity tests for the shipped league.
 *
 * `app/data/league.js` is the answer to "whose roster is whose", and every verdict in the
 * app is computed against it. It is compiled from a hand-transcribed file, so the failure
 * mode is not a crash: it is a roster that looks plausible and is quietly wrong, priced
 * confidently for a whole season.
 *
 * The build script (pipeline/build_league.py) already refuses to write a file whose names
 * do not resolve. These tests guard the two things it cannot: that what shipped is still
 * consistent with the pack shipped beside it, and that the engines' own defaults still
 * describe this league rather than some other one.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replacementDetail, DEFAULT_LEAGUE as REPL_LEAGUE } from '../app/js/replacement.js'
import { DEFAULT_LEAGUE } from '../app/js/trade.js'
import { scoreLine, expectedDstScore, DEFAULT_SCORING } from '../app/js/scoring.js'

globalThis.window = globalThis.window || {}
await import('../app/data/pack.js')
await import('../app/data/league.js')
const pack = globalThis.window.TD_PACK
const league = globalThis.window.TD_LEAGUE
const byId = new Map(pack.players.map((p) => [p.id, p]))

const allPlayers = league.rosters.flatMap((t) => t.players)

test('the league file has the shape the app expects', () => {
  for (const k of ['name', 'season', 'asOfWeek', 'teams', 'slots', 'playoffWeeks',
    'myTeam', 'matchups', 'rosters']) {
    assert.ok(league[k] !== undefined, `missing key: ${k}`)
  }
  assert.equal(league.season, pack.meta.season)
  assert.equal(league.rosters.length, league.teams)
  assert.ok(league.asOfWeek >= 1 && league.asOfWeek <= pack.meta.regSeasonWeeks)
  for (const t of league.rosters) {
    assert.ok(t.name && t.owner, `team missing a name or owner: ${JSON.stringify(t).slice(0, 60)}`)
    assert.ok(t.players.length > 0, `${t.name} has no players`)
  }
})

test('every rostered player is a real player in this pack', () => {
  for (const t of league.rosters) {
    for (const p of t.players) {
      const real = byId.get(p.id)
      assert.ok(real, `${t.name}: ${p.name} (${p.id}) is not in the pack`)
      // The league file carries a copy of name/pos/team/bye so a roster row can be drawn
      // without a lookup. A copy that has drifted from the pack is worse than no copy.
      assert.equal(real.name, p.name, `${p.id}: name drifted from the pack`)
      assert.equal(real.pos, p.pos, `${p.name}: position drifted from the pack`)
      assert.equal(real.team, p.team, `${p.name}: NFL team drifted from the pack`)
      assert.equal(real.bye, p.bye, `${p.name}: bye week drifted from the pack`)
    }
  }
})

test('nobody is on two rosters', () => {
  const owner = new Map()
  for (const t of league.rosters) {
    for (const p of t.players) {
      assert.ok(!owner.has(p.id), `${p.name} is on both ${owner.get(p.id)} and ${t.name}`)
      owner.set(p.id, t.name)
    }
  }
  assert.equal(owner.size, allPlayers.length)
})

test('every roster fits the league slot table', () => {
  const size = Object.values(league.slots).reduce((a, b) => a + b, 0)
  for (const t of league.rosters) {
    const counts = {}
    for (const p of t.players) counts[p.slot] = (counts[p.slot] || 0) + 1
    for (const [slot, n] of Object.entries(league.slots)) {
      if (slot === 'BEN') assert.ok((counts.BEN || 0) <= n, `${t.name}: too many on the bench`)
      else assert.equal(counts[slot] || 0, n, `${t.name}: wrong count in ${slot}`)
    }
    assert.ok(t.players.length <= size, `${t.name}: ${t.players.length} players, roster holds ${size}`)
    // Every starter has to be legal for the slot he is in, flex aside.
    for (const p of t.players) {
      if (p.slot === 'BEN' || p.slot === 'FLEX') continue
      assert.equal(p.slot, p.pos, `${t.name}: ${p.name} (${p.pos}) is in the ${p.slot} slot`)
    }
    const flex = t.players.filter((p) => p.slot === 'FLEX')
    for (const p of flex) {
      assert.ok(['RB', 'WR', 'TE'].includes(p.pos), `${t.name}: ${p.name} cannot fill a flex`)
    }
  }
})

test('the schedule names every team exactly once', () => {
  const names = league.rosters.map((t) => t.name)
  assert.equal(new Set(names).size, names.length, 'two teams share a name')
  const seen = []
  for (const m of league.matchups) {
    assert.equal(m.length, 2)
    for (const n of m) {
      assert.ok(names.includes(n), `matchup names an unknown team: ${n}`)
      seen.push(n)
    }
  }
  assert.equal(new Set(seen).size, seen.length, 'a team is in two matchups')
  assert.equal(seen.length, league.teams, 'not every team has an opponent')
  assert.ok(names.includes(league.myTeam), 'myTeam is not one of the rosters')
})

test('injury flags are ones the app knows how to apply', () => {
  for (const p of allPlayers) {
    if (p.status === undefined) continue
    assert.ok(['Q', 'OUT', 'IR'].includes(p.status), `${p.name}: unknown status ${p.status}`)
  }
})

test('the engine defaults describe this league, not some other one', () => {
  // The whole point of the exercise: if the league changes size or shape and the engine
  // defaults do not follow, every replacement level in the app is quietly computed for a
  // league nobody plays in. That is exactly the drift this test exists to catch.
  assert.equal(DEFAULT_LEAGUE.teams, league.teams)
  assert.equal(REPL_LEAGUE.teams, league.teams)
  for (const [slot, n] of Object.entries(league.slots)) {
    assert.equal(DEFAULT_LEAGUE.slots[slot], n, `default slots disagree on ${slot}`)
    assert.equal(REPL_LEAGUE.slots[slot], n, `replacement default slots disagree on ${slot}`)
  }
  assert.deepEqual([...DEFAULT_LEAGUE.playoffWeeks], league.playoffWeeks)
})

test('the rosters cover the league well enough to use the waiver wire', () => {
  // With every roster known, replacement level should be the best player nobody owns
  // rather than a rank baseline standing in for one. replacement.js only switches over
  // when coverage is real, so this asserts the switch actually happens.
  const ppg = (p) => {
    if (p.pos === 'DST' && p.dstWeeks) {
      const w = Object.values(p.dstWeeks)
      return w.reduce((s, mu) => s + expectedDstScore(mu, DEFAULT_SCORING, p.dstSd), 0) / w.length
    }
    if (p.pos === 'K' && p.kWeeks) {
      const w = Object.values(p.kWeeks)
      return w.reduce((s, mu) => s + scoreLine(mu, DEFAULT_SCORING, 'K'), 0) / w.length
    }
    return scoreLine(p.mu || {}, DEFAULT_SCORING, p.pos)
  }
  const rostered = new Set(allPlayers.map((p) => p.id))
  const d = replacementDetail(pack.players, { ...league, rostered }, ppg)
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DST']) {
    assert.equal(d[pos].method, 'freeAgent', `${pos} fell back to the rank baseline`)
    assert.ok(!rostered.has(d[pos].playerAtRank?.id),
      `${pos} replacement is a player somebody owns`)
    assert.ok(Number.isFinite(d[pos].pts) && d[pos].pts > 0, `${pos} replacement is not a number`)
  }
})
