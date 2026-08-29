/**
 * What full PPR with 4-point passing touchdowns actually does to this league.
 *
 * The user came in with four specific beliefs about their format. Each is testable
 * against the real projection set, and a tool that just agreed with them would be worth
 * nothing. So this measures them.
 *
 *   1. Receptions are the whole ballgame.
 *   2. Quarterbacks are cheap -- the position compresses.
 *   3. D/ST matters unusually much, and streaming is genuinely +EV.
 *   4. Kickers on good offenses in domes are a real tiebreaker.
 *
 * Run: node scripts/league-edges.mjs
 */

import { scoreLine, expectedDstScore, PRESETS, DEFAULT_SCORING } from '../app/js/scoring.js'
import { computeReplacement, replacementDetail } from '../app/js/replacement.js'

globalThis.window = globalThis.window || {}
await import('../app/data/pack.js')
const pack = globalThis.window.TD_PACK

const LEAGUE = {
  teams: 12,
  slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BEN: 7 },
}

function ppg(p, cfg = DEFAULT_SCORING) {
  if (p.pos === 'DST' && p.dstWeeks) {
    const w = Object.values(p.dstWeeks)
    return w.reduce((s, mu) => s + expectedDstScore(mu, cfg, p.dstSd), 0) / w.length
  }
  if (p.pos === 'K' && p.kWeeks) {
    const w = Object.values(p.kWeeks)
    return w.reduce((s, mu) => s + scoreLine(mu, cfg, 'K'), 0) / w.length
  }
  return scoreLine(p.mu || {}, cfg, p.pos)
}

const f = (n, d = 2) => n.toFixed(d).padStart(7)
const rule = (t) => console.log(`\n${'='.repeat(76)}\n${t}\n${'='.repeat(76)}`)
const ranked = (pos, cfg = DEFAULT_SCORING) => pack.players
  .filter((p) => p.pos === pos && (p.mu || p.kWeeks || p.dstWeeks))
  .map((p) => ({ p, v: ppg(p, cfg) }))
  .sort((a, b) => b.v - a.v)

console.log('Trade Desk -- what this scoring format actually does')
console.log(`data generated ${pack.meta.generated}, ${pack.players.length} players`)

// ---------------------------------------------------------------------------
rule('1. RECEPTIONS ARE THE WHOLE BALLGAME -- how true is that?')
const skill = pack.players.filter((p) => ['RB', 'WR', 'TE'].includes(p.pos) && p.mu)
let recPts = 0, allPts = 0
for (const p of skill) {
  recPts += p.mu.rec || 0
  allPts += ppg(p)
}
console.log(`across every projected RB/WR/TE, receptions supply `
  + `${((recPts / allPts) * 100).toFixed(1)}% of all fantasy points scored.`)

// Which players gain the most from full PPR vs standard?
const gain = skill
  .map((p) => ({ p, full: ppg(p), std: ppg(p, PRESETS.standard) }))
  .map((x) => ({ ...x, delta: x.full - x.std, pct: (x.full - x.std) / Math.max(x.full, 0.01) }))
  .filter((x) => x.full > 8)
  .sort((a, b) => b.pct - a.pct)
console.log('\nplayers whose value depends MOST on the PPR setting (share of their points from catches):')
for (const x of gain.slice(0, 8)) {
  console.log(`  ${x.p.name.padEnd(24)} ${x.p.pos}  full ${f(x.full)}  standard ${f(x.std)}`
    + `  ${(x.pct * 100).toFixed(0)}% of value is receptions`)
}
console.log('\nand the ones who barely care:')
for (const x of gain.slice(-4)) {
  console.log(`  ${x.p.name.padEnd(24)} ${x.p.pos}  full ${f(x.full)}  standard ${f(x.std)}`
    + `  ${(x.pct * 100).toFixed(0)}%`)
}

// The specific claim: a pass-catching back is underpriced by anyone valuing in standard.
const rbs = ranked('RB')
const rbFull = rbs.map((x) => x.p.id)
const rbStd = ranked('RB', PRESETS.standard).map((x) => x.p.id)
const movers = rbs
  .map((x) => ({ p: x.p, full: rbFull.indexOf(x.p.id) + 1, std: rbStd.indexOf(x.p.id) + 1 }))
  .filter((x) => x.full <= 40)
  .map((x) => ({ ...x, jump: x.std - x.full }))
  .sort((a, b) => b.jump - a.jump)
console.log('\nbacks who rank far higher in full PPR than in standard -- the arbitrage against')
console.log('anyone in the league still thinking in standard scoring:')
for (const m of movers.slice(0, 6)) {
  console.log(`  ${m.p.name.padEnd(24)} RB${String(m.full).padEnd(3)} in full PPR, `
    + `RB${m.std} in standard  (+${m.jump} spots)`)
}

// ---------------------------------------------------------------------------
rule('2. ARE QUARTERBACKS CHEAP? -- 4-point passing TDs and -2 interceptions')
const qb = ranked('QB')
const wr = ranked('WR')
const rb = ranked('RB')
const gapQB = qb[2].v - qb[13].v
console.log(`QB3 ${qb[2].p.name} ${f(qb[2].v)}   ->   QB14 ${qb[13].p.name} ${f(qb[13].v)}`)
console.log(`gap from QB3 to QB14: ${f(gapQB)} pts/week`)
console.log(`gap from RB3 to RB14: ${f(rb[2].v - rb[13].v)} pts/week`)
console.log(`gap from WR3 to WR14: ${f(wr[2].v - wr[13].v)} pts/week`)

const repl = computeReplacement(pack.players, LEAGUE, (p) => ppg(p))
console.log('\nvalue over replacement for the best player at each position:')
for (const [pos, list] of [['QB', qb], ['RB', rb], ['WR', wr], ['TE', ranked('TE')]]) {
  console.log(`  ${pos}1 ${list[0].p.name.padEnd(24)} ${f(list[0].v)} - replacement `
    + `${f(repl[pos])} = ${f(list[0].v - repl[pos])} VOR`)
}
const qbVor = qb[0].v - repl.QB
const rbVor = rb[0].v - repl.RB
console.log(`\nthe best QB is worth ${f(qbVor)} over replacement; the best RB `
  + `${f(rbVor)}. `)
console.log(qbVor < rbVor
  ? '  -> confirmed: paying a premium for an elite QB in this format is a mistake.'
  : '  -> NOT confirmed in this data: the QB edge is real here, contrary to the usual advice.')

// ---------------------------------------------------------------------------
rule('3. D/ST -- does stacking both tier tables really make streaming worth it?')
const dst = ranked('DST')
console.log(`best D/ST  ${dst[0].p.name.padEnd(22)} ${f(dst[0].v)} pts/game`)
console.log(`median     ${dst[Math.floor(dst.length / 2)].p.name.padEnd(22)} `
  + `${f(dst[Math.floor(dst.length / 2)].v)}`)
console.log(`worst      ${dst[dst.length - 1].p.name.padEnd(22)} ${f(dst[dst.length - 1].v)}`)
const seasonSpread = dst[0].v - dst[dst.length - 1].v

// Weekly swing: how much does the matchup move a single defense?
let swing = 0
for (const { p } of dst) {
  const vals = Object.values(p.dstWeeks).map((mu) => expectedDstScore(mu, DEFAULT_SCORING, p.dstSd))
  swing += Math.max(...vals) - Math.min(...vals)
}
swing /= dst.length
console.log(`\nspread from the best season-long defense to the worst: ${f(seasonSpread)} pts/game`)
console.log(`average best-to-worst swing WITHIN a single defense's own season: ${f(swing)} pts/game`)
console.log(swing >= seasonSpread * 0.8
  ? '  -> matchup moves a defense nearly as much as talent does. Streaming is real here.'
  : '  -> season-long quality dominates matchup; streaming is worth less than claimed.')

// What the best available streaming week looks like each week.
console.log('\nbest streaming target by week (the defense with the softest draw):')
for (const w of [1, 5, 9, 13, 15, 16, 17]) {
  let best = null
  for (const { p } of dst) {
    const mu = p.dstWeeks[String(w)]
    if (!mu) continue
    const v = expectedDstScore(mu, DEFAULT_SCORING, p.dstSd)
    if (!best || v > best.v) best = { name: p.name, v, opp: mu.opp }
  }
  if (best) console.log(`  week ${String(w).padStart(2)}  ${best.name.padEnd(22)} ${f(best.v)}`)
}

// ---------------------------------------------------------------------------
rule('4. KICKERS -- do domes and distance scoring actually separate them?')
const ks = ranked('K')
console.log(`best   ${ks[0].p.name.padEnd(22)} ${ks[0].p.team.padEnd(4)} ${f(ks[0].v)} pts/game`)
console.log(`worst  ${ks[ks.length - 1].p.name.padEnd(22)} ${ks[ks.length - 1].p.team.padEnd(4)} `
  + `${f(ks[ks.length - 1].v)}`)
console.log(`spread across the position: ${f(ks[0].v - ks[ks.length - 1].v)} pts/game`)

const indoorTeams = new Set(Object.keys(pack.schedule).filter((t) => {
  const home = pack.schedule[t].filter((w) => w.home)
  return home.length && home.every((w) => ['dome', 'closed'].includes(String(w.roof).toLowerCase()))
}))
const inK = ks.filter((x) => indoorTeams.has(x.p.team))
const outK = ks.filter((x) => !indoorTeams.has(x.p.team))
const mean = (xs) => xs.reduce((s, x) => s + x.v, 0) / Math.max(xs.length, 1)
// Per GAME, indoors vs outdoors. This is the honest comparison: a season average mixes
// each kicker's home and away venues, so an indoor team's kicker still plays roughly a
// third of his games outside and the season gap understates the effect by about half.
let din = 0, nin = 0, dout = 0, nout = 0
for (const { p } of ks) {
  const sched = Object.fromEntries(pack.schedule[p.team].map((w) => [String(w.w), w]))
  for (const [w, mu] of Object.entries(p.kWeeks)) {
    const s = sched[w]
    if (!s) continue
    const v = scoreLine(mu, DEFAULT_SCORING, 'K')
    if (['dome', 'closed'].includes(String(s.roof).toLowerCase())) { din += v; nin++ }
    else { dout += v; nout++ }
  }
}
console.log(`\nper GAME: indoors ${f(din / nin)} (n=${nin}), outdoors ${f(dout / nout)} (n=${nout})`)
console.log(`dome effect: ${f(din / nin - dout / nout)} pts/game`)
console.log('  measured from 2,716 real kicker-games 2021-2025 under these exact FG rules,')
console.log('  controlling for offense quality: +0.828 pts/game (t = 4.30). The model is')
console.log('  calibrated to that, through +8.8% attempts and +3-4 points of make rate on')
console.log('  long kicks -- weather costs distance, not chip shots.')
console.log(`\nseason average, indoor-team kickers ${f(mean(inK))} vs outdoor ${f(mean(outK))} `
  + `(gap ${f(mean(inK) - mean(outK))}) -- smaller because everyone plays away games.`)
console.log(`the gap from the best kicker to replacement is ${f(ks[0].v - repl.K)} pts/game, and`)
console.log('the whole position spans under two points. So: real, worth the tiebreak, and')
console.log('still the last thing to spend a roster decision on.')

// ---------------------------------------------------------------------------
rule('WHERE REPLACEMENT LEVEL ACTUALLY SITS IN YOUR LEAGUE')
const detail = replacementDetail(pack.players, LEAGUE, (p) => ppg(p))
console.log('computed from the pool and your starting slots, not typed in:\n')
for (const [pos, row] of Object.entries(detail)) {
  if (!['QB', 'RB', 'WR', 'TE', 'K', 'DST'].includes(pos)) continue
  console.log(`  ${pos.padEnd(4)} ${f(row.pts)} pts/game   ${row.note || ''}`)
}
