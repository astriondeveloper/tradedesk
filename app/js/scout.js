/**
 * League intelligence: reading trades you are not in.
 *
 * The trade evaluator answers "is this deal good for the two teams in it". That is the
 * wrong question when the two teams are not you. When two rivals trade, nothing about your
 * roster changes and your season still just got better or worse, because fantasy standings
 * are relative. A deal that makes the team you are chasing stronger is a loss you took
 * without being consulted.
 *
 * So this module answers three different questions:
 *
 *   WHERE DO I STAND?      Every roster in the league scored the same way -- optimal lineup
 *                          solved week by week, byes removed, playoff weeks weighted -- so
 *                          team strength is one comparable number, before and after the
 *                          deal. Your rank movement is the headline, not their point swing.
 *
 *   WHAT SHAPE ARE THEY?   A roster is not a total, it is a shape. `positionalShape` scores
 *                          each position by what it actually contributes above replacement
 *                          in the slots the league starts, which is what separates a team
 *                          with three startable backs from one with three backs.
 *
 *   WHO DO I CALL?         A trade leaves both sides lopsided -- that is what trades do.
 *                          `openings` finds where a rival's new hole meets your surplus.
 *                          This is the actionable output: the deal you just watched tells
 *                          you who needs what, before they have advertised it.
 *
 * Nothing here re-implements valuation. Strength comes from `seasonLedger`, replacement
 * level from `replacement.js`, and the deal itself from `evaluateTrade`. This module is
 * composition and comparison, which is the only way the numbers stay consistent with what
 * the rest of the app already tells you.
 */

import { DEFAULT_SCORING } from './scoring.js'
import { optimizeLineup, slotsFromCounts } from './lineup.js'
import { computeReplacement } from './replacement.js'
import { seasonLedger, playerPPG, remainingWeeks, DEFAULT_LEAGUE } from './trade.js'

const isObj = (x) => x !== null && typeof x === 'object'
const num = (x, d = 0) => (Number.isFinite(x) ? x : d)

/** Positions that have a real market. K and DST are streamed, not traded. */
export const CORE_POS = Object.freeze(['QB', 'RB', 'WR', 'TE'])

/**
 * How many of a position a lineup can actually start, flex included.
 *
 * The flex is the reason a "surplus" is not just "more than the base slots". A twelfth
 * receiver is worthless; the third one is a flex starter most weeks. Measured on this
 * scoring the single flex goes to a receiver about ten times in twelve, so RB and WR both
 * count it as available depth and the shape reads correctly for either roster type.
 */
export function startableDepth(slots, pos) {
  const base = num(slots?.[pos], 0)
  const flex = num(slots?.FLEX, 0) + num(slots?.SUPERFLEX, 0)
  if (pos === 'RB' || pos === 'WR' || pos === 'TE') return base + flex
  if (pos === 'QB') return base + num(slots?.SUPERFLEX, 0)
  return base
}

/* ------------------------------------------------------------------ team strength */

/**
 * One roster's projected strength: total starter points across the remaining weeks, and
 * the playoff-weighted figure the app uses everywhere else.
 *
 * Deliberately the same `seasonLedger` the trade verdict runs on. A second, simpler
 * strength metric here would eventually disagree with the verdict on the same screen, and
 * a dashboard that contradicts itself is worse than one that omits the number.
 */
export function teamStrength(roster, ctx) {
  const led = seasonLedger(roster || [], ctx)
  const playoff = led.perWeek.filter((w) => w.playoff).reduce((s, w) => s + w.points, 0)
  const n = led.perWeek.length || 1
  return {
    total: led.total,
    weighted: led.weighted,
    playoff,
    perGame: led.total / n,
    weeks: n,
  }
}

/**
 * Build the shared evaluation context once and reuse it for every team.
 *
 * Replacement level is computed from the whole projection universe minus everyone rostered
 * ANYWHERE in the league, not minus one team. That distinction is the point: in a 12-team
 * league the free agent you would actually stream is the best player nobody owns, and
 * pricing every team against its own leftovers would flatter deep rosters.
 */
export function leagueContext({ teams, pack, cfg = DEFAULT_SCORING, league = DEFAULT_LEAGUE, fromWeek }) {
  const weeks = remainingWeeks(pack, fromWeek)
  const rostered = new Set()
  for (const t of teams || []) for (const p of t.players || []) if (p && p.id) rostered.add(p.id)

  const pool = Array.isArray(pack?.players) ? pack.players : []
  const replacement = computeReplacement(pool, { ...league, rostered }, (p) => playerPPG(p, cfg))

  return {
    ctx: { weeks, slots: slotsFromCounts(league.slots), cfg, pack, league, cache: new Map() },
    replacement,
    rostered,
  }
}

/**
 * The board: every team ranked by strength, optionally with one trade already applied.
 *
 * @param {object} input
 * @param {Array}  input.teams   [{ name, players: [...] }], every team in the league
 * @param {object} [input.swap]  { aIndex, bIndex, sendA, sendB } -- the deal to apply
 * @param {number} [input.myIndex] which team is the reader's
 */
export function leagueBoard(input) {
  const inp = isObj(input) ? input : {}
  const teams = Array.isArray(inp.teams) ? inp.teams : []
  const { ctx, replacement } = leagueContext(inp)
  const swap = isObj(inp.swap) ? inp.swap : null

  const applied = teams.map((t, i) => {
    let players = Array.isArray(t.players) ? t.players.slice() : []
    if (swap) {
      const outA = new Set((swap.sendA || []).map((p) => p.id))
      const outB = new Set((swap.sendB || []).map((p) => p.id))
      if (i === swap.aIndex) {
        players = players.filter((p) => !outA.has(p.id)).concat(swap.sendB || [])
      } else if (i === swap.bIndex) {
        players = players.filter((p) => !outB.has(p.id)).concat(swap.sendA || [])
      }
    }
    return { ...t, players }
  })

  const rows = applied.map((t, i) => {
    const s = teamStrength(t.players, ctx)
    return {
      // Spread the team first so anything the caller attached -- owner, colours, an ESPN
      // id -- survives. Rebuilding the row field by field silently dropped all of it, and
      // the symptom was an empty Manager column three layers away.
      ...t,
      index: i,
      name: t.name || `Team ${i + 1}`,
      players: t.players,
      // An explicit myIndex wins; otherwise honour whatever the caller already marked,
      // so a team list that knows which roster is the reader's keeps that knowledge.
      mine: inp.myIndex != null ? i === inp.myIndex : !!t.mine,
      inPlay: !!swap && (i === swap.aIndex || i === swap.bIndex),
      ...s,
    }
  })

  const ranked = rows.slice().sort((a, b) => b.weighted - a.weighted)
  ranked.forEach((r, i) => { r.rank = i + 1 })

  return { rows, ranked, replacement, ctx }
}

/**
 * What a trade between two other teams does to everyone, the reader included.
 *
 * The number that matters is not how much the two sides gained. It is what happened to the
 * gap between the reader and the teams above them -- which moves even though the reader's
 * roster did not.
 */
export function tradeImpact(input) {
  const inp = isObj(input) ? input : {}
  const before = leagueBoard({ ...inp, swap: null })
  const after = leagueBoard(inp)

  const beforeByIndex = new Map(before.ranked.map((r) => [r.index, r]))
  const afterByIndex = new Map(after.ranked.map((r) => [r.index, r]))

  const teams = before.rows.map((r) => {
    const b = beforeByIndex.get(r.index)
    const a = afterByIndex.get(r.index)
    return {
      index: r.index,
      name: r.name,
      mine: r.mine,
      inPlay: a.inPlay,
      before: { weighted: b.weighted, total: b.total, rank: b.rank },
      after: { weighted: a.weighted, total: a.total, rank: a.rank },
      delta: a.weighted - b.weighted,
      rankDelta: b.rank - a.rank, // positive = moved up the board
    }
  })

  // A trade does not conserve league strength. Players move to rosters where they start,
  // or stop starting, so the total goes up or down -- and that is the mechanism by which a
  // deal you are not in reaches you. Both sides gaining is the classic "good trade", and
  // it is precisely the case where everyone else just lost ground.
  const dealSwing = teams.filter((t) => t.inPlay).reduce((s, t) => s + t.delta, 0)

  const me = teams.find((t) => t.mine) || null
  let standing = null
  if (me) {
    const others = teams.filter((t) => !t.mine)
    const meanOf = (list, key) => (list.length
      ? list.reduce((s, t) => s + t[key].weighted, 0) / list.length : 0)

    const aheadBefore = teams.filter((t) => t.before.rank < me.before.rank)
    const aheadAfter = teams.filter((t) => t.after.rank < me.after.rank)
    const leaderBefore = teams.reduce((x, t) => (t.before.rank < x.before.rank ? t : x), teams[0])
    const leaderAfter = teams.reduce((x, t) => (t.after.rank < x.after.rank ? t : x), teams[0])

    // The headline. Gap-to-first was the obvious choice and it is the wrong one: it reads
    // exactly 0.00 unless the leader happens to be one of the two teams trading, which is
    // most of the time. What always moves, and always means something, is the strength of
    // the field the reader has to beat, measured against a roster that did not change.
    const fieldBefore = meanOf(others, 'before')
    const fieldAfter = meanOf(others, 'after')

    standing = {
      rankBefore: me.before.rank,
      rankAfter: me.after.rank,
      rankDelta: me.rankDelta,
      teamsAheadBefore: aheadBefore.length,
      teamsAheadAfter: aheadAfter.length,
      myStrength: me.after.weighted,
      fieldBefore,
      fieldAfter,
      /** Positive = the field got stronger = worse for the reader. */
      fieldDelta: fieldAfter - fieldBefore,
      gapToFirstBefore: leaderBefore.before.weighted - me.before.weighted,
      gapToFirstAfter: leaderAfter.after.weighted - me.after.weighted,
      dealSwing,
    }
    standing.gapDelta = standing.gapToFirstAfter - standing.gapToFirstBefore
  }

  return { teams, standing, dealSwing, before, after }
}

/* ------------------------------------------------------------------ roster shape */

/**
 * Where a roster is deep and where it is hollow, per position.
 *
 * `startable` is what the position actually contributes: the points above replacement of
 * however many players the lineup can start there. `depth` is what is left over. A hole is
 * a position that cannot even fill its slots with someone better than a waiver pickup; a
 * surplus is real startable talent sitting on a bench, which is exactly the inventory that
 * gets traded.
 */
export function positionalShape(roster, { cfg = DEFAULT_SCORING, league = DEFAULT_LEAGUE, replacement }) {
  const slots = league.slots || DEFAULT_LEAGUE.slots
  const out = {}

  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DST']) {
    const repl = num(replacement?.[pos], 0)
    const men = (roster || [])
      .filter((p) => p && p.pos === pos)
      .map((p) => ({ p, ppg: playerPPG(p, cfg) }))
      .sort((a, b) => b.ppg - a.ppg)

    const canStart = Math.max(1, startableDepth(slots, pos))
    const starters = men.slice(0, canStart)
    const reserves = men.slice(canStart)

    const startable = starters.reduce((s, m) => s + (m.ppg - repl), 0)
    // Reserves are only worth their edge over replacement, and only the positive part --
    // a bench player worse than the waiver wire is not depth, he is a roster spot.
    const surplus = reserves.reduce((s, m) => s + Math.max(0, m.ppg - repl), 0)

    out[pos] = {
      pos,
      count: men.length,
      canStart,
      filled: starters.length,
      startable,
      surplus,
      best: men.length ? men[0].ppg : 0,
      replacement: repl,
      // Under-filled, or filled with players no better than the wire.
      hole: starters.length < canStart || startable <= 0.5 * canStart,
      names: men.slice(0, 5).map((m) => ({ id: m.p.id, name: m.p.name, ppg: m.ppg })),
    }
  }
  return out
}

/**
 * Where a rival's hole meets your surplus.
 *
 * Scored as the smaller of the two sides, because a trade needs both: your spare receiver
 * is worth nothing to a team already three deep there, and their desperate need at tight
 * end is worth nothing if you have not got one. Taking the minimum is what stops this from
 * listing every team that is merely weak somewhere.
 */
export function openings(input) {
  const inp = isObj(input) ? input : {}
  const cfg = isObj(inp.cfg) ? inp.cfg : DEFAULT_SCORING
  const league = { ...DEFAULT_LEAGUE, ...(isObj(inp.league) ? inp.league : {}) }
  const replacement = inp.replacement || {}

  const mine = positionalShape(inp.myRoster, { cfg, league, replacement })
  const found = []

  for (const t of inp.teams || []) {
    if (t.mine) continue
    const theirs = positionalShape(t.players, { cfg, league, replacement })

    for (const give of CORE_POS) {
      for (const get of CORE_POS) {
        if (give === get) continue
        const mySurplus = mine[give]?.surplus || 0
        const theirNeed = theirs[give]?.hole
          ? Math.max(0, (theirs[give].canStart * (replacement[give] || 0) * 0.35) + 1)
          : 0
        const theirSurplus = theirs[get]?.surplus || 0
        const myNeed = mine[get]?.hole ? 1 : 0

        if (!mySurplus || !theirSurplus || !theirNeed || !myNeed) continue

        found.push({
          team: t.name,
          index: t.index,
          give,
          get,
          mySurplus,
          theirSurplus,
          // Both halves have to be real, so the weaker one sets the score.
          score: Math.min(mySurplus, theirSurplus),
          myPlayers: mine[give].names.slice(mine[give].canStart),
          theirPlayers: theirs[get].names.slice(theirs[get].canStart),
          theirShape: theirs,
        })
      }
    }
  }

  found.sort((a, b) => b.score - a.score)
  // One entry per team: the best angle, not four variations on it.
  const seen = new Set()
  return found.filter((o) => {
    if (seen.has(o.index)) return false
    seen.add(o.index)
    return true
  })
}

/* ------------------------------------------------------------------ ghosting */

/**
 * What the other manager is left holding, and what they come back asking for.
 *
 * A trade is a negotiation, not a transaction. The offer you send is rarely the deal you
 * sign, so the useful question is not only "will they accept" but "what do they counter
 * with" -- and that is answerable, because the counter is driven by the hole your own
 * offer just opened in their roster.
 *
 * Three readouts, all measured on their roster AS IT WOULD BE after the deal:
 *
 *   exposed    positions they can no longer fill with anyone better than a waiver pickup.
 *              This is what your offer cost them, and where they will push back.
 *   likelyAsk  the players on YOUR roster they will name to fix it -- best first, drawn
 *              from your own spare parts before your starters, because that is the
 *              counter you can actually afford to say yes to.
 *   canGive    what they are still deep in, which is what you ask for in return.
 *
 * @param {object} input
 * @param {Array}  input.myRoster     your roster before the deal
 * @param {Array}  input.theirRoster  their roster before the deal
 * @param {Array}  input.give         players you send (they receive)
 * @param {Array}  input.get          players you receive (they send)
 */
export function counterplay(input) {
  const inp = isObj(input) ? input : {}
  const cfg = isObj(inp.cfg) ? inp.cfg : DEFAULT_SCORING
  const league = { ...DEFAULT_LEAGUE, ...(isObj(inp.league) ? inp.league : {}) }
  const replacement = inp.replacement || {}

  const give = inp.give || []
  const get = inp.get || []
  const outOfMine = new Set(give.map((p) => p.id))
  const outOfTheirs = new Set(get.map((p) => p.id))

  const myAfter = (inp.myRoster || []).filter((p) => !outOfMine.has(p.id)).concat(get)
  const theirAfter = (inp.theirRoster || []).filter((p) => !outOfTheirs.has(p.id)).concat(give)

  const mine = positionalShape(myAfter, { cfg, league, replacement })
  const theirs = positionalShape(theirAfter, { cfg, league, replacement })

  // A hole is worse the more of its slots go unfilled and the further below replacement
  // whoever is standing in them sits.
  const exposed = CORE_POS
    .map((pos) => theirs[pos])
    .filter((s) => s && s.hole)
    .map((s) => ({
      pos: s.pos,
      filled: s.filled,
      canStart: s.canStart,
      startable: s.startable,
      severity: (s.canStart - s.filled) * 2 + Math.max(0, -s.startable),
    }))
    .sort((a, b) => b.severity - a.severity)

  // What they will name. Spare parts first: a counter you can say yes to is worth more
  // than one you have to refuse.
  //
  // Players they are sending in THIS deal are excluded. They end up on your roster, so a
  // naive read of your post-trade roster offers them straight back -- and no manager
  // counters by asking for the player they just traded away. Caught by reading the output
  // rather than the code: the matrix cheerfully suggested they would want back the
  // quarterback they were sending.
  const justSent = new Set(get.map((p) => p.id))
  const likelyAsk = []
  for (const hole of exposed.slice(0, 2)) {
    const s = mine[hole.pos]
    if (!s) continue
    const eligible = s.names.filter((p) => !justSent.has(p.id))
    const spare = eligible.slice(Math.max(0, s.canStart - (s.names.length - eligible.length)))
    const pick = spare.length ? spare : eligible.slice(0, 1)
    for (const p of pick.slice(0, 2)) {
      likelyAsk.push({ ...p, pos: hole.pos, fromSurplus: spare.length > 0 })
    }
  }

  const canGive = CORE_POS
    .map((pos) => theirs[pos])
    .filter((s) => s && s.surplus > 1)
    .sort((a, b) => b.surplus - a.surplus)
    .map((s) => ({
      pos: s.pos,
      surplus: s.surplus,
      names: s.names.slice(s.canStart, s.canStart + 2),
    }))

  return { exposed, likelyAsk, canGive, theirShape: theirs, myShape: mine }
}

/* ------------------------------------------------------------------ power rankings */

/**
 * Power rankings, ranked the way this app insists everything be ranked.
 *
 * Every public power ranking is, underneath, a sum of a roster. That is the exact mistake
 * the rest of this application exists to correct: a third of a roster's projected points
 * never reaches a starting lineup, and which third depends on the roster's shape. A team
 * four deep at running back and empty at tight end sums beautifully and starts badly.
 *
 * So teams are ranked on playoff-weighted STARTER points -- the same seasonLedger the
 * trade verdict and the league-impact board run on -- and the naive roster-total ranking
 * is computed alongside it and shown, because the disagreement is the interesting part.
 * A team the summed ranking has third and the starter ranking has sixth is a team whose
 * manager is about to overvalue his own bench in a trade, which is actionable.
 *
 * What is NOT here, deliberately: expected wins, playoff odds and strength of schedule.
 * The shipped league carries only the current week's matchups, so a full remaining
 * schedule does not exist to compute them from. Inventing one would produce numbers that
 * look authoritative and mean nothing.
 */
export function powerRankings(input) {
  const inp = isObj(input) ? input : {}
  const cfg = isObj(inp.cfg) ? inp.cfg : DEFAULT_SCORING
  const league = { ...DEFAULT_LEAGUE, ...(isObj(inp.league) ? inp.league : {}) }

  const board = leagueBoard({ ...inp, swap: null })
  const { replacement } = board
  const ctxWeeks = board.ctx.weeks
  const flatSlots = slotsFromCounts(league.slots)

  const rows = board.rows.map((r) => {
    const shape = positionalShape(r.players, { cfg, league, replacement })

    // How much of this roster its own shape strands on the bench.
    //
    // Measured FLAT -- no availability, no opponent adjustment, on both sides of the
    // ratio -- which is deliberate and is not how the rank above is computed. The rank
    // wants expected points, so an injury-prone star is correctly worth less there.
    // This number is about a different failure: a roster four deep at one position and
    // empty at another strands points no matter how healthy everyone is. Mixing the two
    // bases booked injury risk as wasted bench and read six points high.
    //
    // Same basis as `scripts/thesis.mjs`, so the figure here and the one quoted in the
    // README are the same measurement rather than two that nearly agree.
    const flat = (p) => playerPPG(p, cfg)
    const rosterPerWeek = r.players.reduce((s, p) => s + flat(p), 0)
    let startedFlat = 0
    for (const w of ctxWeeks) {
      const active = r.players.filter((p) => p.bye !== w)
      startedFlat += optimizeLineup(active, flatSlots, flat).total
    }
    const wasted = rosterPerWeek > 0
      ? Math.max(0, 1 - (startedFlat / (rosterPerWeek * (ctxWeeks.length || 1))))
      : 0

    return {
      index: r.index,
      name: r.name,
      owner: r.owner || '',
      mine: !!r.mine,
      weighted: r.weighted,
      total: r.total,
      perGame: r.perGame,
      playoff: r.playoff,
      rosterPerWeek,
      wasted,
      shape,
    }
  })

  const rankBy = (list, key, dir = -1) => {
    const order = list.slice().sort((a, b) => (a[key] - b[key]) * dir)
    const at = new Map(order.map((r, i) => [r.index, i + 1]))
    return (r) => at.get(r.index)
  }
  const realRank = rankBy(rows, 'weighted')
  const naiveRank = rankBy(rows, 'rosterPerWeek')
  const playoffRank = rankBy(rows, 'playoff')

  // Per position, how each team compares to the rest of the league at that position.
  // A z-score rather than a raw total, because "strong at QB" only means anything
  // relative to what the other seven are starting there.
  const zByPos = {}
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DST']) {
    const vals = rows.map((r) => num(r.shape[pos]?.startable, 0))
    const mean = vals.reduce((s, v) => s + v, 0) / (vals.length || 1)
    const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (vals.length || 1)) || 1
    zByPos[pos] = rows.map((_, i) => (vals[i] - mean) / sd)
  }

  rows.forEach((r, i) => {
    r.rank = realRank(r)
    r.naiveRank = naiveRank(r)
    r.playoffRank = playoffRank(r)
    // Positive means the starter ranking rates them ABOVE what summing their roster does.
    r.rankGap = r.naiveRank - r.rank

    const zs = CORE_POS.map((pos) => ({ pos, z: zByPos[pos][i] }))
      .sort((a, b) => b.z - a.z)
    r.best = zs[0]
    r.worst = zs[zs.length - 1]
  })

  const ranked = rows.slice().sort((a, b) => a.rank - b.rank)
  const weights = ranked.map((r) => r.weighted)
  const median = weights.length
    ? (weights.length % 2
      ? weights[(weights.length - 1) / 2]
      : (weights[weights.length / 2 - 1] + weights[weights.length / 2]) / 2)
    : 0

  // The teams the two methods disagree about most. Ties broken toward the larger absolute
  // point gap, so a one-place difference on a knife edge does not outrank a real one.
  const byGap = rows.slice().sort((a, b) => b.rankGap - a.rankGap || b.wasted - a.wasted)
  const overrated = byGap[byGap.length - 1]
  const underrated = byGap[0]

  return {
    rows: ranked,
    replacement,
    median,
    spread: weights.length ? weights[0] - weights[weights.length - 1] : 0,
    // Only worth surfacing when the two rankings actually disagree about somebody.
    mostOverrated: overrated && overrated.rankGap < 0 ? overrated : null,
    mostUnderrated: underrated && underrated.rankGap > 0 ? underrated : null,
  }
}
