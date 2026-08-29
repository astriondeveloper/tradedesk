/**
 * Does the roster-context math actually change the answer?
 *
 * The claim this whole tool rests on is that summing projected points misprices trades.
 * That is easy to assert and easy to get wrong, so this checks it against the real 2026
 * projection set using only the lineup solver and the replacement-level engine -- no
 * trade evaluator involved, so it is an independent check on the thesis rather than a
 * restatement of it.
 *
 * Three things get measured, each corresponding to one of the three failure modes:
 *
 *   1. Two RB2s for one RB1. Point-summing says the side receiving two players wins.
 *      Starter-optimized weekly value should often say the opposite, because the second
 *      RB2 lands on a bench where he scores nothing.
 *   2. The same trade, two roster shapes. A back-heavy team and a receiver-heavy team
 *      should not agree on what a deal is worth.
 *   3. Bench points are not worth face value. Measure how much of a roster's raw
 *      projected total never reaches a starting lineup.
 *
 * Run: node scripts/thesis.mjs
 */

import { scoreLine, DEFAULT_SCORING } from '../app/js/scoring.js'
import { optimizeLineup, slotsFromCounts } from '../app/js/lineup.js'
import { computeReplacement } from '../app/js/replacement.js'

globalThis.window = globalThis.window || {}
await import('../app/data/pack.js')
await import('../app/data/demo.js')
const pack = globalThis.window.TD_PACK
const demo = globalThis.window.TD_DEMO

const SLOT_COUNTS = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 }
const SLOTS = slotsFromCounts(SLOT_COUNTS)
const LEAGUE = { teams: 12, slots: { ...SLOT_COUNTS, BEN: 7 } }
const byId = new Map(pack.players.map((p) => [p.id, p]))

/** Season points per game under the user's league, from the shipped projection. */
function ppg(p) {
  if (!p) return 0
  if (p.pos === 'DST' && p.dstWeeks) {
    const w = Object.values(p.dstWeeks)
    return w.reduce((s, mu) => s + scoreLine(mu, DEFAULT_SCORING, 'DST'), 0) / w.length
  }
  if (p.pos === 'K' && p.kWeeks) {
    const w = Object.values(p.kWeeks)
    return w.reduce((s, mu) => s + scoreLine(mu, DEFAULT_SCORING, 'K'), 0) / w.length
  }
  return scoreLine(p.mu || {}, DEFAULT_SCORING, p.pos)
}

const weeks = Array.from({ length: pack.meta.regSeasonWeeks }, (_, i) => i + 1)

/** Starter points across the season, with bye-week players unavailable. */
function seasonStarters(roster) {
  let total = 0
  const perWeek = []
  for (const w of weeks) {
    const active = roster.filter((p) => p.bye !== w)
    const out = optimizeLineup(active, SLOTS, ppg)
    perWeek.push(out.total)
    total += out.total
  }
  return { total, perWeek }
}

const sum = (roster) => roster.reduce((s, p) => s + ppg(p), 0)

function trade(rosterA, rosterB, sendA, sendB) {
  const outA = new Set(sendA.map((p) => p.id))
  const outB = new Set(sendB.map((p) => p.id))
  const afterA = rosterA.filter((p) => !outA.has(p.id)).concat(sendB)
  const afterB = rosterB.filter((p) => !outB.has(p.id)).concat(sendA)
  return { afterA, afterB }
}

const f = (n, d = 1) => n.toFixed(d).padStart(7)
const rule = (t) => console.log(`\n${'='.repeat(74)}\n${t}\n${'='.repeat(74)}`)

const teamA = demo.teamA.players.map((p) => byId.get(p.id)).filter(Boolean)
const teamB = demo.teamB.players.map((p) => byId.get(p.id)).filter(Boolean)

rule('SETUP')
console.log(`${demo.teamA.name}: ${teamA.length} players, raw projected ${f(sum(teamA))} pts/wk`)
console.log(`${demo.teamB.name}: ${teamB.length} players, raw projected ${f(sum(teamB))} pts/wk`)
const repl = computeReplacement(pack.players, LEAGUE, ppg)
console.log('\nreplacement level, computed from the pool (not typed in):')
for (const [pos, v] of Object.entries(repl)) console.log(`   ${pos.padEnd(4)} ${f(v, 2)} pts/game`)

// ---------------------------------------------------------------------------
rule('1. BENCH POINTS ARE NOT WORTH FACE VALUE')
for (const [name, roster] of [[demo.teamA.name, teamA], [demo.teamB.name, teamB]]) {
  const raw = sum(roster) * weeks.length
  const started = seasonStarters(roster).total
  console.log(`${name.padEnd(14)} raw roster total ${f(raw)}   actually started ${f(started)}`
    + `   stranded on the bench ${f(raw - started)}  (${((1 - started / raw) * 100).toFixed(0)}%)`)
}
console.log('\nThat gap is why summing a roster tells you almost nothing. Points only count')
console.log('when they reach a starting slot.')

// ---------------------------------------------------------------------------
rule('2. TWO RB2s FOR ONE RB1')
const rbs = pack.players.filter((p) => p.pos === 'RB' && p.mu).sort((a, b) => ppg(b) - ppg(a))
const rb1 = rbs[0]
const rb2a = rbs[14]
const rb2b = rbs[18]

// Give the RB1 side a roster that is already deep at back, so the second RB2 has nowhere
// to go. That is the situation the trade actually happens in.
const deepRB = [
  rbs[3], rbs[8], rbs[22], rbs[30],
  ...pack.players.filter((p) => p.pos === 'WR' && p.mu).sort((a, b) => ppg(b) - ppg(a)).slice(3, 8),
  pack.players.filter((p) => p.pos === 'QB' && p.mu).sort((a, b) => ppg(b) - ppg(a))[4],
  pack.players.filter((p) => p.pos === 'TE' && p.mu).sort((a, b) => ppg(b) - ppg(a))[3],
  pack.players.find((p) => p.pos === 'K' && p.kWeeks),
  pack.players.find((p) => p.pos === 'DST'),
]
const holderOfRB1 = [rb1, ...deepRB]
const holderOfRB2s = [rb2a, rb2b, ...deepRB.slice(0, 4).map((_, i) => rbs[40 + i]),
  ...deepRB.slice(4)]

console.log(`RB1  ${rb1.name.padEnd(24)} ${f(ppg(rb1), 2)} pts/wk`)
console.log(`RB2a ${rb2a.name.padEnd(24)} ${f(ppg(rb2a), 2)} pts/wk`)
console.log(`RB2b ${rb2b.name.padEnd(24)} ${f(ppg(rb2b), 2)} pts/wk`)
console.log(`\npoint-summing verdict: the two RB2s total ${f(ppg(rb2a) + ppg(rb2b), 2)} vs `
  + `${f(ppg(rb1), 2)} for the RB1`)
console.log(`  -> a summing tool says the side GIVING UP the RB1 gains `
  + `${(ppg(rb2a) + ppg(rb2b) - ppg(rb1)).toFixed(2)} pts/wk`)

const { afterA, afterB } = trade(holderOfRB1, holderOfRB2s, [rb1], [rb2a, rb2b])
const beforeRB1side = seasonStarters(holderOfRB1).total
const afterRB1side = seasonStarters(afterA).total
const beforeRB2side = seasonStarters(holderOfRB2s).total
const afterRB2side = seasonStarters(afterB).total

console.log('\nstarter-optimized verdict, walked week by week over the full season:')
console.log(`  side that gave up the RB1 : ${f(beforeRB1side)} -> ${f(afterRB1side)}`
  + `  delta ${f(afterRB1side - beforeRB1side)}`)
console.log(`  side that gave up two RB2s: ${f(beforeRB2side)} -> ${f(afterRB2side)}`
  + `  delta ${f(afterRB2side - beforeRB2side)}`)
const flipped = (afterRB1side - beforeRB1side) < 0 && (afterRB2side - beforeRB2side) > 0
console.log(`\n  -> the two verdicts ${flipped ? 'DISAGREE' : 'agree'}`
  + `${flipped ? ' -- point-summing gets this backwards' : ''}`)

// ---------------------------------------------------------------------------
rule('3. THE SAME TRADE, TWO ROSTER SHAPES')
const wrs = pack.players.filter((p) => p.pos === 'WR' && p.mu).sort((a, b) => ppg(b) - ppg(a))
const giveRB = rbs[6]
const getWR = wrs[6]
console.log(`the deal: ${giveRB.name} (RB, ${ppg(giveRB).toFixed(2)}) `
  + `for ${getWR.name} (WR, ${ppg(getWR).toFixed(2)})`)
console.log(`point-summing verdict: a flat ${(ppg(getWR) - ppg(giveRB)).toFixed(2)} pts/wk `
  + 'for whoever receives the receiver -- the same number for every team alive.\n')

for (const [name, base] of [[demo.teamA.name, teamA], [demo.teamB.name, teamB]]) {
  // Give each roster the same back, then trade him for the same receiver.
  const withRB = [...base.filter((p) => p.id !== giveRB.id && p.id !== getWR.id), giveRB]
  const after = [...withRB.filter((p) => p.id !== giveRB.id), getWR]
  const b = seasonStarters(withRB).total
  const a = seasonStarters(after).total
  const shape = { RB: 0, WR: 0 }
  for (const p of withRB) if (shape[p.pos] !== undefined) shape[p.pos] += ppg(p)
  console.log(`${name.padEnd(14)} (RB corps ${f(shape.RB)}, WR corps ${f(shape.WR)})`
    + `   starters ${f(b)} -> ${f(a)}   delta ${f(a - b)}`)
}
console.log('\nSame players, same projections, two different answers. A tool that reports one')
console.log('number for a trade is answering a question nobody asked.')

// The magnitudes already differ, but the sharper version of the claim is that the same
// deal can be a GAIN for one roster and a LOSS for the other. That is a search over
// candidate swaps rather than a single constructed example, and saying so matters: the
// point is that such trades exist and are common, not that this particular one is
// special.
console.log('\nSearching one-for-one swaps for a deal whose SIGN flips between the two rosters...')
const cands = []
for (const give of [...rbs.slice(2, 26), ...wrs.slice(2, 26)]) {
  for (const get of [...rbs.slice(2, 26), ...wrs.slice(2, 26)]) {
    if (give.id === get.id || give.pos === get.pos) continue
    cands.push([give, get])
  }
}
let best = null
for (const [give, get] of cands) {
  const deltas = []
  for (const base of [teamA, teamB]) {
    const withGive = [...base.filter((p) => p.id !== give.id && p.id !== get.id), give]
    const after = [...withGive.filter((p) => p.id !== give.id), get]
    deltas.push(seasonStarters(after).total - seasonStarters(withGive).total)
  }
  if (deltas[0] > 0 !== deltas[1] > 0) {
    const spread = Math.abs(deltas[0] - deltas[1])
    if (!best || spread > best.spread) best = { give, get, deltas, spread }
  }
}
if (best) {
  console.log(`\n  ${best.give.name} (${best.give.pos}) for ${best.get.name} (${best.get.pos})`)
  console.log(`  point-summing says a flat ${(ppg(best.get) - ppg(best.give)).toFixed(2)} pts/wk`
    + ' for everyone, but:')
  console.log(`    ${demo.teamA.name.padEnd(14)} ${f(best.deltas[0])} over the season`
    + `  ${best.deltas[0] > 0 ? '(ACCEPT)' : '(DECLINE)'}`)
  console.log(`    ${demo.teamB.name.padEnd(14)} ${f(best.deltas[1])} over the season`
    + `  ${best.deltas[1] > 0 ? '(ACCEPT)' : '(DECLINE)'}`)
  console.log('\n  One roster should take this deal and the other should refuse it. That is the')
  console.log('  trade that actually gets accepted, and a summing tool cannot find it.')
} else {
  console.log('  none found in this candidate set -- the magnitudes still differ, but no sign flip.')
}

// ---------------------------------------------------------------------------
rule('4. WEEKS ARE NOT EQUAL')
const playoff = pack.playoffWeeks
const s = seasonStarters(teamA)
const reg = s.perWeek.filter((_, i) => !playoff.includes(weeks[i]))
const po = s.perWeek.filter((_, i) => playoff.includes(weeks[i]))
const mean = (xs) => xs.reduce((x, y) => x + y, 0) / xs.length
console.log(`${demo.teamA.name}: regular weeks average ${f(mean(reg))}, `
  + `playoff weeks (${playoff.join(', ')}) average ${f(mean(po))}`)
const worst = s.perWeek.indexOf(Math.min(...s.perWeek))
console.log(`worst week is ${weeks[worst]} at ${f(s.perWeek[worst])} -- `
  + `${(100 * (1 - s.perWeek[worst] / mean(s.perWeek))).toFixed(0)}% below its own average`)
console.log('\nA season total hides that entirely.')
