/**
 * Trade evaluation.
 *
 * Public trade analyzers add up projected points. That is wrong in three specific ways,
 * and every one of them is a first-class output here rather than a footnote:
 *
 *   1. Bench points are worth almost nothing. What matters is points above the player you
 *      would otherwise start. Measured on the real 2026 projection set, 33-35% of a
 *      roster's raw projected total never reaches a starting lineup at all. So the ledger
 *      is built from STARTER points and from points above replacement, and bench depth is
 *      priced as insurance -- how often it actually enters the lineup times what it is
 *      worth when it does -- not at face value.
 *
 *   2. The same trade is not worth the same to both teams. A roster with three good backs
 *      and one receiver should price a deal differently from its mirror image. Both sides
 *      are therefore evaluated independently against their own shape, and the verdict
 *      carries two numbers, never one. On the shipped data this is not a subtle effect:
 *      Omarion Hampton for DeVonta Smith is worth +48 points over the season to a
 *      back-heavy roster and -40 to a receiver-heavy one, while point-summing calls it a
 *      flat -1.18 a week for everybody.
 *
 *   3. Weeks are not equal. Every remaining week is walked separately with the lineup
 *      re-solved and bye-week players removed, so bye collisions fall out of the math
 *      instead of being bolted on, and the fantasy playoff weeks can be weighted.
 *
 * And one more that even the good analyzers skip: a point estimate hides risk. Because
 * the projections are distributions, the verdict also reports the change in expected wins
 * and in playoff odds, so a trade that raises the mean while lowering the floor says so.
 */

import { scoreLine, expectedDstScore, DEFAULT_SCORING } from './scoring.js'
import { optimizeLineup, slotsFromCounts } from './lineup.js'
import { computeReplacement } from './replacement.js'
import { simSeason, makeRng, DEFAULT_SEED } from './sim.js'

/* ------------------------------------------------------------------ defaults */

export const DEFAULT_LEAGUE = Object.freeze({
  /** Eight teams, nine starters, seven on the bench -- see `pipeline/league.json`. */
  teams: 8,
  slots: Object.freeze({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BEN: 7 }),
  /** Fantasy postseason. Weighted because these weeks decide seasons. */
  playoffWeeks: Object.freeze([15, 16, 17]),
  /** How much more a playoff week counts than a regular one in the weighted ledger. */
  playoffWeight: 2.0,
})

/** Draws for the season simulation behind delta-wins and playoff odds. */
export const SIM_DRAWS = 1200

/**
 * How often a bench player actually enters the lineup, by how far he sits behind the
 * starter he backs up. Insurance is worth something -- it is not worth face value.
 * Derived from the availability model: a starter misses roughly 12-18% of weeks, and the
 * first backup absorbs most of that, the second much less.
 */
const BENCH_ENTRY_RATE = [0.34, 0.16, 0.08, 0.04, 0.02]

/* ------------------------------------------------------------------ helpers */

const isObj = (x) => x !== null && typeof x === 'object'
const num = (x, d = 0) => (Number.isFinite(x) ? x : d)
const uniqById = (list) => {
  const seen = new Set()
  const out = []
  for (const p of list || []) {
    if (!isObj(p) || !p.id || seen.has(p.id)) continue
    seen.add(p.id)
    out.push(p)
  }
  return out
}

/**
 * Points per game for a player under a scoring config.
 *
 * D/ST scoring integrates the tier tables over their uncertainty rather than reading them
 * at the mean: tier tables are step functions, so the points at the average outcome are
 * not the average of the points. It matters here because this format stacks two of them.
 */
export function playerPPG(player, cfg = DEFAULT_SCORING, week = null) {
  if (!isObj(player)) return 0
  if (player.pos === 'DST' && player.dstWeeks) {
    const weeks = week !== null && player.dstWeeks[String(week)]
      ? [player.dstWeeks[String(week)]]
      : Object.values(player.dstWeeks)
    if (!weeks.length) return 0
    return weeks.reduce((s, mu) => s + expectedDstScore(mu, cfg, player.dstSd || {}), 0) / weeks.length
  }
  if (player.pos === 'K' && player.kWeeks) {
    const weeks = week !== null && player.kWeeks[String(week)]
      ? [player.kWeeks[String(week)]]
      : Object.values(player.kWeeks)
    if (!weeks.length) return 0
    return weeks.reduce((s, mu) => s + scoreLine(mu, cfg, 'K'), 0) / weeks.length
  }
  return scoreLine(player.mu || {}, cfg, player.pos)
}

/**
 * Week-specific points, applying that week's schedule, opponent, and availability.
 *
 * AVAILABILITY BELONGS HERE, and leaving it out was a real hole. `mu` is per game PLAYED,
 * so a player who misses a fifth of the season is not worth his per-game number across a
 * season ledger -- he is worth roughly four fifths of it, with the rest falling to whoever
 * starts in his place. Without this the deterministic ledger quietly assumed every player
 * was available every week; injury risk existed only inside the Monte Carlo, and a manual
 * "he's out" changed nothing at all on screen.
 *
 * Scaling by availability also lets the lineup solver make the right call on its own: a
 * 90%-available 15-point player outranks a 60%-available 18-point one, which is the
 * comparison a manager is actually making when he plans a season.
 */
function weekPPG(player, week, cfg, pack, cache) {
  const key = `${player.id}|${week}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit

  let v
  if (player.pos === 'DST' || player.pos === 'K') {
    v = playerPPG(player, cfg, week)
  } else {
    const factors = pack?.teamFactors?.[player.team]?.[String(week)]
    const base = playerPPG(player, cfg)
    if (!factors) {
      v = base
    } else {
      // Rebuild the week's line rather than scaling the points total, so the scoring
      // config keeps applying to the right components: a week that adds targets should
      // move a full-PPR projection more than a standard one.
      const mu = player.mu || {}
      const scaled = {}
      for (const k of Object.keys(mu)) {
        const f = PASS_KEYS.has(k) ? factors.pass : (RUSH_KEYS.has(k) ? factors.rush : 1)
        const t = TD_KEYS.has(k) ? factors.td : 1
        scaled[k] = mu[k] * f * t
      }
      const opp = pack?.schedule?.[player.team]?.find((w) => w.w === week)?.opp
      const dvp = opp ? num(pack?.dvp?.[opp]?.[player.pos], 1) : 1
      v = scoreLine(scaled, cfg, player.pos) * dvp
    }
  }
  // Expected points for the week, not points if he plays. A D/ST never misses a game, so
  // it is exempt; everyone else is scaled by his probability of being available.
  const avail = player.pos === 'DST' ? 1 : Math.max(0, Math.min(1, num(player.avail, 0.9)))
  v *= avail
  cache.set(key, v)
  return v
}

const PASS_KEYS = new Set(['patt', 'pcmp', 'pyd', 'ptd', 'pint', 'p40', 'pfd',
  'tgt', 'rec', 'reyd', 'retd', 're40', 'refd'])
const RUSH_KEYS = new Set(['ratt', 'ryd', 'rtd', 'r40', 'rfd'])
const TD_KEYS = new Set(['ptd', 'retd', 'rtd'])

/** Weeks remaining, from `fromWeek` through the end of the regular season. */
function remainingWeeks(pack, fromWeek) {
  const last = num(pack?.meta?.regSeasonWeeks, 18)
  const from = Math.max(1, Math.trunc(num(fromWeek, 1)))
  const out = []
  for (let w = from; w <= last; w++) out.push(w)
  return out
}

/* ------------------------------------------------------ starters, week by week */

/**
 * Walk every remaining week, solving the optimal lineup each time.
 *
 * Bye-week players are simply absent, which is the whole trick: bye damage and bye
 * stacking emerge from the schedule instead of needing a separate rule.
 */
export function seasonLedger(roster, { weeks, slots, cfg, pack, league, cache }) {
  const perWeek = []
  let total = 0
  let weighted = 0
  const playoff = new Set(league.playoffWeeks || [])

  for (const w of weeks) {
    const active = roster.filter((p) => p.bye !== w)
    const out = optimizeLineup(active, slots, (p) => weekPPG(p, w, cfg, pack, cache))
    const isPlayoff = playoff.has(w)
    perWeek.push({
      week: w,
      points: out.total,
      playoff: isPlayoff,
      empty: out.assignments.filter((a) => !a.player).map((a) => a.slot),
      lineup: out.assignments.map((a) => ({
        slot: a.slot,
        id: a.player ? a.player.id : null,
        name: a.player ? a.player.name : null,
        pts: a.pts,
      })),
    })
    total += out.total
    weighted += out.total * (isPlayoff ? num(league.playoffWeight, 1) : 1)
  }
  return { perWeek, total, weighted }
}

/**
 * Points above replacement actually STARTED across the season.
 *
 * This is the number the whole tool exists to produce. A starter is worth what he beats
 * the streamable alternative by, not what he scores.
 */
function parStarted(ledger, replacement, byId) {
  let par = 0
  for (const wk of ledger.perWeek) {
    for (const s of wk.lineup) {
      if (!s.id) continue
      const p = byId.get(s.id)
      if (!p) continue
      par += s.pts - num(replacement[p.pos], 0)
    }
  }
  return par
}

/**
 * Bench value priced as insurance.
 *
 * A bench player is not worth his projection: he is worth the chance he is needed times
 * what he adds when he plays. Depth behind an already-deep position is worth close to
 * nothing, which is exactly why two RB2s lose to one RB1 on a roster that already has
 * backs.
 */
function benchInsurance(roster, ledger, replacement, cfg) {
  const weeksCount = ledger.perWeek.length || 1

  // How often each player is actually in the optimal lineup. A binary "did he ever start"
  // is useless over a full season: with byes, all but the deepest reserve starts at least
  // one week, so every roster reported zero bench value. What matters is the share of
  // weeks he DOESN'T start -- that is the time he is sitting there as insurance.
  const startWeeks = new Map()
  for (const wk of ledger.perWeek) {
    for (const s of wk.lineup) if (s.id) startWeeks.set(s.id, (startWeeks.get(s.id) || 0) + 1)
  }

  const byPos = new Map()
  for (const p of roster) {
    const benchShare = 1 - (startWeeks.get(p.id) || 0) / weeksCount
    if (benchShare <= 0.05) continue // a genuine every-week starter is not depth
    if (!byPos.has(p.pos)) byPos.set(p.pos, [])
    byPos.get(p.pos).push({ p, benchShare })
  }

  let value = 0
  const detail = []
  for (const [pos, list] of byPos) {
    list.sort((a, b) => playerPPG(b.p, cfg) - playerPPG(a.p, cfg))
    list.forEach(({ p, benchShare }, i) => {
      // The Nth-best reserve at a position is needed less often than the first.
      const rate = BENCH_ENTRY_RATE[Math.min(i, BENCH_ENTRY_RATE.length - 1)]
      // And he is only worth what he beats the streamer by, when he does play.
      const edge = Math.max(0, playerPPG(p, cfg) - num(replacement[pos], 0))
      const v = rate * edge * benchShare * weeksCount
      value += v
      detail.push({
        id: p.id, name: p.name, pos,
        benchShare, entryRate: rate, edgeOverReplacement: edge, value: v,
      })
    })
  }
  detail.sort((a, b) => b.value - a.value)
  return { value, detail }
}

/** Worst single week, and which weeks a bye actually costs something. */
function byeDamage(ledger) {
  if (!ledger.perWeek.length) return { worstWeek: null, worstPoints: 0, meanPoints: 0, drop: 0 }
  const mean = ledger.total / ledger.perWeek.length
  let worst = ledger.perWeek[0]
  for (const w of ledger.perWeek) if (w.points < worst.points) worst = w
  return {
    worstWeek: worst.week,
    worstPoints: worst.points,
    meanPoints: mean,
    drop: mean - worst.points,
    emptySlotWeeks: ledger.perWeek.filter((w) => w.empty.length).map((w) => w.week),
  }
}

/* ------------------------------------------------------------------ the verdict */

/**
 * Evaluate a trade for both rosters independently.
 *
 * @param {object} input
 * @param {Array}  input.rosterA  team A's players (full player objects from the pack)
 * @param {Array}  input.rosterB  team B's players
 * @param {Array}  input.sendA    players leaving A for B
 * @param {Array}  input.sendB    players leaving B for A
 * @param {object} input.pack     the data pack
 * @param {object} [input.cfg]    scoring config; defaults to the user's league
 * @param {object} [input.league] slots, playoff weeks, weighting
 * @param {number} [input.fromWeek]
 * @param {object} [input.opts]   {sim: boolean, draws, seed, pool}
 */
export function evaluateTrade(input) {
  const inp = isObj(input) ? input : {}
  const pack = inp.pack
  const cfg = isObj(inp.cfg) ? inp.cfg : DEFAULT_SCORING
  const league = { ...DEFAULT_LEAGUE, ...(isObj(inp.league) ? inp.league : {}) }
  const opts = isObj(inp.opts) ? inp.opts : {}

  const rosterA = uniqById(inp.rosterA)
  const rosterB = uniqById(inp.rosterB)
  const sendA = uniqById(inp.sendA)
  const sendB = uniqById(inp.sendB)

  const slots = slotsFromCounts(league.slots)
  const weeks = remainingWeeks(pack, inp.fromWeek)
  const cache = new Map()

  // Replacement level from the projection universe and the league's own settings. Never
  // typed in: the free-agent baseline is what makes "points above what you'd start
  // instead" mean anything.
  const pool = Array.isArray(opts.pool) ? opts.pool
    : (Array.isArray(pack?.players) ? pack.players : [...rosterA, ...rosterB])
  const rostered = new Set([...rosterA, ...rosterB].map((p) => p.id))
  const replacement = computeReplacement(pool, { ...league, rostered }, (p) => playerPPG(p, cfg))

  const outA = new Set(sendA.map((p) => p.id))
  const outB = new Set(sendB.map((p) => p.id))
  const afterA = uniqById([...rosterA.filter((p) => !outA.has(p.id)), ...sendB])
  const afterB = uniqById([...rosterB.filter((p) => !outB.has(p.id)), ...sendA])

  const byId = new Map()
  for (const p of [...rosterA, ...rosterB, ...sendA, ...sendB]) byId.set(p.id, p)

  const rosterLimit = Object.entries(league.slots)
    .reduce((s, [, n]) => s + num(n, 0), 0)

  function side(label, before, after, gave, got) {
    const ctx = { weeks, slots, cfg, pack, league, cache }
    const lb = seasonLedger(before, ctx)
    const la = seasonLedger(after, ctx)

    const perWeek = lb.perWeek.map((w, i) => ({
      week: w.week,
      playoff: w.playoff,
      before: w.points,
      after: la.perWeek[i].points,
      delta: la.perWeek[i].points - w.points,
    }))

    const playoffDelta = perWeek.filter((w) => w.playoff)
      .reduce((s, w) => s + w.delta, 0)

    const benchB = benchInsurance(before, lb, replacement, cfg)
    const benchA = benchInsurance(after, la, replacement, cfg)

    return {
      label,
      gave: gave.map((p) => ({ id: p.id, name: p.name, pos: p.pos, ppg: playerPPG(p, cfg) })),
      got: got.map((p) => ({ id: p.id, name: p.name, pos: p.pos, ppg: playerPPG(p, cfg) })),
      starters: { before: lb.total, after: la.total, delta: la.total - lb.total },
      weighted: { before: lb.weighted, after: la.weighted, delta: la.weighted - lb.weighted },
      playoffDelta,
      perWeek,
      par: {
        before: parStarted(lb, replacement, byId),
        after: parStarted(la, replacement, byId),
        get delta() { return this.after - this.before },
      },
      bench: {
        before: benchB.value,
        after: benchA.value,
        delta: benchA.value - benchB.value,
        detail: benchA.detail.slice(0, 6),
      },
      bye: { before: byeDamage(lb), after: byeDamage(la) },
      roster: { before: before.length, after: after.length, limit: rosterLimit },
      // Raw point-summing, reported ONLY so the app can show what a naive tool would say
      // and how far off it is.
      naive: {
        before: before.reduce((s, p) => s + playerPPG(p, cfg), 0),
        after: after.reduce((s, p) => s + playerPPG(p, cfg), 0),
        get delta() { return this.after - this.before },
      },
      _ledgers: { before: lb, after: la },
      _rosters: { before, after },
    }
  }

  const A = side(inp.nameA || 'Team A', rosterA, afterA, sendA, sendB)
  const B = side(inp.nameB || 'Team B', rosterB, afterB, sendB, sendA)

  for (const s of [A, B]) s.flags = buildFlags(s, league, cfg)

  const out = {
    league,
    weeks,
    replacement,
    A,
    B,
    headline: headline(A, B, league),
  }

  if (opts.sim !== false && pack) {
    out.sim = simulateBothSides(A, B, { cfg, pack, league, slots, weeks, opts })
  }
  return out
}

/* ------------------------------------------------------------------ flags */

function buildFlags(s, league, cfg) {
  const flags = []
  const push = (kind, text) => flags.push({ kind, text })

  if (s.roster.after > s.roster.limit) {
    push('bad', `Over the roster limit by ${s.roster.after - s.roster.limit}. `
      + 'Someone gets dropped, and that cost is not in the numbers above.')
  }
  const emptyAfter = new Set()
  for (const w of s._ledgers.after.perWeek) for (const slot of w.empty) emptyAfter.add(slot)
  const emptyBefore = new Set()
  for (const w of s._ledgers.before.perWeek) for (const slot of w.empty) emptyBefore.add(slot)
  const newlyEmpty = [...emptyAfter].filter((x) => !emptyBefore.has(x))
  if (newlyEmpty.length) {
    push('bad', `Leaves ${newlyEmpty.join(', ')} unfilled in at least one week. `
      + 'You would be streaming that spot.')
  }

  if (s.bench.delta < -8 && s.starters.delta > 0) {
    push('info', 'Trading depth for starters. Usually right, but one injury and you are '
      + 'starting a waiver player.')
  }
  const byeWorse = s.bye.after.drop - s.bye.before.drop
  if (byeWorse > 6) {
    push('info', `Week ${s.bye.after.worstWeek} gets worse: your weakest week now costs `
      + `${s.bye.after.drop.toFixed(1)} points below your average, up from `
      + `${s.bye.before.drop.toFixed(1)}. Check the bye overlap.`)
  } else if (byeWorse < -6) {
    push('good', `Bye weeks get easier. Weakest week costs ${s.bye.after.drop.toFixed(1)} `
      + `instead of ${s.bye.before.drop.toFixed(1)}.`)
  }

  if (s.playoffDelta > 4 && s.starters.delta <= 0) {
    push('info', 'Loses ground on the season but gains in the playoff weeks. If you expect '
      + 'to make the postseason, that is the trade-off you want.')
  } else if (s.playoffDelta < -4 && s.starters.delta >= 0) {
    push('bad', 'Gains on the season but gives up ground in weeks '
      + `${league.playoffWeeks.join(', ')}. That is backwards if you are contending.`)
  }

  const naiveSign = Math.sign(s.naive.delta)
  const realSign = Math.sign(s.starters.delta)
  if (naiveSign !== 0 && realSign !== 0 && naiveSign !== realSign) {
    push('info', `Point-summing says ${s.naive.delta > 0 ? '+' : ''}${s.naive.delta.toFixed(1)} `
      + 'per week and gets the direction wrong. The players you gain do not all reach your '
      + 'starting lineup.')
  }
  return flags
}

/* ------------------------------------------------------------------ headline */

function verdictWord(delta, weeksCount) {
  const perWeek = weeksCount ? delta / weeksCount : 0
  if (perWeek > 1.5) return 'clear win'
  if (perWeek > 0.3) return 'slight win'
  if (perWeek < -1.5) return 'clear loss'
  if (perWeek < -0.3) return 'slight loss'
  return 'even'
}

function headline(A, B, league) {
  const n = A.perWeek.length || 1
  const forA = verdictWord(A.starters.delta, n)
  const forB = verdictWord(B.starters.delta, n)
  const both = A.starters.delta > 0 && B.starters.delta > 0
  const lopsided = Math.abs(A.starters.delta - B.starters.delta) > 40

  let reason
  if (both) {
    reason = 'Both lineups improve. Roster shapes differ enough that this is a real fit, '
      + 'which is the kind that actually gets accepted.'
  } else if (A.starters.delta > 0 && lopsided) {
    reason = 'Heavily one-sided in your favor on these projections. Expect a no unless they '
      + 'value your players differently than you do.'
  } else if (A.starters.delta > 0) {
    reason = `Gains you ${(A.starters.delta / n).toFixed(1)} points a week in your starting `
      + 'lineup, costing them about the same.'
  } else if (Math.abs(A.starters.delta / n) < 0.3) {
    reason = 'Your starting lineup barely moves. Judge this on depth and schedule, not points.'
  } else {
    reason = `Costs you ${Math.abs(A.starters.delta / n).toFixed(1)} points a week in your `
      + 'starting lineup. Only do it for the depth or the bye relief.'
  }
  return {
    verdict: forA,
    forA,
    forB,
    deltaA: A.starters.delta,
    deltaB: B.starters.delta,
    perWeekA: A.starters.delta / n,
    perWeekB: B.starters.delta / n,
    playoffWeeks: league.playoffWeeks,
    reason,
  }
}

/* ------------------------------------------------------------------ simulation */

function simulateBothSides(A, B, { cfg, pack, league, slots, weeks, opts }) {
  const draws = num(opts.draws, SIM_DRAWS)
  const seed = num(opts.seed, DEFAULT_SEED)
  const from = weeks[0]
  const to = weeks[weeks.length - 1]

  const run = (roster, salt) => simSeason(roster, {
    pack, cfg, slots, fromWeek: from, toWeek: to,
    rng: makeRng(seed + salt), n: draws,
  })

  // A typical week's floor and ceiling, averaged across the remaining weeks. The season
  // distribution in `dist` is over WINS, not points, so the weekly spread has to come from
  // the per-week rows -- reading dist.p10 gives undefined, which is how the UI ended up
  // rendering "— → —" where the floor should be.
  const weeklyQ = (res, q) => {
    const rows = res.pointsPerWeek || []
    if (!rows.length) return null
    return rows.reduce((s, r) => s + num(r[q], 0), 0) / rows.length
  }

  // The same seed for before and after so the comparison is paired: the difference is the
  // trade, not the draw.
  const out = {}
  for (const [key, s] of [['A', A], ['B', B]]) {
    const before = run(s._rosters.before, 0)
    const after = run(s._rosters.after, 0)
    out[key] = {
      draws,
      expectedWins: { before: before.expectedWins, after: after.expectedWins,
        delta: after.expectedWins - before.expectedWins },
      playoffOdds: { before: before.playoffOdds, after: after.playoffOdds,
        delta: after.playoffOdds - before.playoffOdds },
      pointsPerWeek: { before: before.pointsPerWeek, after: after.pointsPerWeek },
      floor: { before: weeklyQ(before, 'p10'), after: weeklyQ(after, 'p10') },
      median: { before: weeklyQ(before, 'p50'), after: weeklyQ(after, 'p50') },
      ceiling: { before: weeklyQ(before, 'p90'), after: weeklyQ(after, 'p90') },
      wins: { before: before.dist?.wins, after: after.dist?.wins },
      // The simulation infers an opponent when none is supplied, and says so. Carried
      // through rather than dropped, because "playoff odds" with an invented opponent is
      // a number that needs its caveat attached.
      assumptions: {
        opponent: after.opponent?.note || null,
        playoff: after.playoff?.note || null,
      },
    }
  }
  return out
}

/* ------------------------------------------------------------------ fairness search */

/**
 * What would make this deal fair?
 *
 * Searches the other roster for the single addition that brings both sides closest to
 * even. Searching beats guessing: "add a mid-round pick" is not an answer a roster can act
 * on, and the right sweetener depends on both shapes.
 */
export function suggestFair(input) {
  const inp = isObj(input) ? input : {}
  const base = evaluateTrade({ ...inp, opts: { ...(inp.opts || {}), sim: false } })
  const rosterB = uniqById(inp.rosterB)
  const already = new Set(uniqById(inp.sendB).map((p) => p.id))

  const results = []
  for (const cand of rosterB) {
    if (already.has(cand.id)) continue
    const r = evaluateTrade({
      ...inp,
      sendB: [...(inp.sendB || []), cand],
      opts: { ...(inp.opts || {}), sim: false },
    })
    // Fair means both sides land near zero, not that one side maximizes.
    const imbalance = Math.abs(r.A.starters.delta - r.B.starters.delta)
    const worst = Math.min(r.A.starters.delta, r.B.starters.delta)
    results.push({
      player: { id: cand.id, name: cand.name, pos: cand.pos, team: cand.team },
      deltaA: r.A.starters.delta,
      deltaB: r.B.starters.delta,
      imbalance,
      bothPositive: r.A.starters.delta > 0 && r.B.starters.delta > 0,
      worstSide: worst,
    })
  }
  results.sort((a, b) => {
    if (a.bothPositive !== b.bothPositive) return a.bothPositive ? -1 : 1
    return a.imbalance - b.imbalance
  })
  return {
    base: { deltaA: base.A.starters.delta, deltaB: base.B.starters.delta },
    suggestions: results.slice(0, 8),
  }
}
