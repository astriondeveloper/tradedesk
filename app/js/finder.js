/**
 * Trade finder and acceptance model.
 *
 * Knowing a trade is good for you is half the job. The other half is knowing whether the
 * person on the other end will say yes, and that is a different question with a different
 * answer, because they are not running this model. They are looking at names, at where
 * those names were drafted, and at whether the deal looks fair.
 *
 * So every candidate is valued TWICE:
 *
 *   model value    what the deal is actually worth to each roster, from the week-by-week
 *                  starter math -- roster shape, byes, playoff weeks, replacement level.
 *   market value   what each side will PERCEIVE it as worth, from consensus rank mapped
 *                  onto the same points scale so the two are directly comparable.
 *
 * The trade you want is one where both are positive for you and market value is at worst
 * neutral for them. That gap is not a trick: it exists because consensus rank has no idea
 * what your roster looks like, so a receiver who is your fourth-best is priced the same as
 * one who would start every week for them.
 *
 * A note on the search. Evaluating every package exactly is far too slow to do live -- two
 * fifteen-man rosters generate about fourteen thousand combinations and a full evaluation
 * walks eighteen weeks of optimal lineups. So packages are SCREENED on per-player marginal
 * values, which cost one pass per player rather than one per combination, and only the
 * survivors are evaluated exactly. Marginals are not perfectly additive -- losing two
 * running backs hurts more than twice losing one -- which is precisely why the shortlist is
 * re-scored properly instead of being trusted.
 */

import { DEFAULT_SCORING } from './scoring.js'
import { optimizeLineup, slotsFromCounts } from './lineup.js'
import { evaluateTrade, playerPPG, DEFAULT_LEAGUE, seasonLedger } from './trade.js'

const isObj = (x) => x !== null && typeof x === 'object'
const num = (x, d = 0) => (Number.isFinite(x) ? x : d)
const sum = (xs) => xs.reduce((a, b) => a + b, 0)

/** How many screened packages get an exact evaluation. */
export const SHORTLIST = 60

/** Package shapes searched, as [give, get] counts. */
export const SHAPES = Object.freeze([[1, 1], [2, 1], [1, 2], [2, 2], [3, 2], [2, 3]])

/* ------------------------------------------------------------------ market value */

/**
 * What the market thinks a player is worth, in the same points-per-game units the model
 * uses.
 *
 * Built by quantile-mapping consensus rank onto the model's own value ladder within each
 * position: the player the market ranks third at his position is priced at whatever the
 * model's third-best is worth. That keeps the two numbers comparable, keeps it responsive
 * to the scoring settings, and avoids inventing a separate currency nobody can sanity
 * check.
 *
 * A player off the consensus board is priced at the model's value for his rank, because
 * the market has no opinion to represent.
 */
export function marketValues(pack, cfg = DEFAULT_SCORING, league = DEFAULT_LEAGUE) {
  const out = new Map()
  const byPos = new Map()
  for (const p of pack.players) {
    if (!byPos.has(p.pos)) byPos.set(p.pos, [])
    byPos.get(p.pos).push(p)
  }

  // Replacement level per position, so value is measured OVER the streamable alternative
  // rather than in raw points. This is not a refinement, it is the difference between the
  // model working and not: in this scoring a replacement quarterback scores about 17 and an
  // elite receiver about 21, so on raw points a waiver-wire QB prices like a first-round
  // WR. The first version of this function did exactly that and duly proposed trading
  // three bench players for Ja'Marr Chase and Rashee Rice while reporting the market values
  // as within a point of each other.
  const repl = replacementByPos(pack, cfg, league)

  for (const [pos, list] of byPos) {
    const scored = list.map((p) => ({ p, v: playerPPG(p, cfg) })).sort((a, b) => b.v - a.v)
    // A player below replacement has no trade value. He does not have NEGATIVE value --
    // nobody pays you to take him -- so the ladder floors at zero.
    const ladder = scored.map((s) => Math.max(0, s.v - num(repl[pos], 0)))

    const ranked = scored.filter((s) => Number.isFinite(s.p.ecr?.ov))
      .sort((a, b) => a.p.ecr.ov - b.p.ecr.ov)
    ranked.forEach((s, i) => out.set(s.p.id, ladder[Math.min(i, ladder.length - 1)]))
    // Unranked players keep their own value over replacement: the market is silent about
    // them, which is not the same as pricing them at zero.
    scored.forEach((s, i) => { if (!out.has(s.p.id)) out.set(s.p.id, ladder[i]) })
  }
  return out
}

/** Replacement points per position, from the pool and the league's starting slots. */
function replacementByPos(pack, cfg, league) {
  const teams = num(league?.teams, 12)
  const slots = league?.slots || DEFAULT_LEAGUE.slots
  const out = {}
  const byPos = new Map()
  for (const p of pack.players) {
    if (!byPos.has(p.pos)) byPos.set(p.pos, [])
    byPos.get(p.pos).push(p)
  }
  // Flex is shared, so its slots are apportioned to the flex-eligible positions by how
  // often each actually fills one at this scoring.
  const flexTotal = teams * num(slots.FLEX, 0)
  const flexShare = flexApportionment(byPos, cfg, flexTotal, teams, slots)
  for (const [pos, list] of byPos) {
    const sorted = list.map((p) => playerPPG(p, cfg)).sort((a, b) => b - a)
    const starters = Math.round(teams * num(slots[pos], 0) + num(flexShare[pos], 0))
    out[pos] = sorted.length ? num(sorted[Math.min(starters, sorted.length - 1)], 0) : 0
  }
  return out
}

/** How many flex slots each eligible position actually wins, at this scoring. */
function flexApportionment(byPos, cfg, flexTotal, teams, slots) {
  const share = { RB: 0, WR: 0, TE: 0 }
  if (flexTotal <= 0) return share
  const pool = []
  for (const pos of ['RB', 'WR', 'TE']) {
    const list = (byPos.get(pos) || []).map((p) => ({ pos, v: playerPPG(p, cfg) }))
      .sort((a, b) => b.v - a.v)
    // Skip the players already consumed by dedicated slots at that position.
    pool.push(...list.slice(Math.round(teams * num(slots[pos], 0))))
  }
  pool.sort((a, b) => b.v - a.v)
  for (const x of pool.slice(0, flexTotal)) share[x.pos] += 1
  return share
}

/* ------------------------------------------------------------------ marginals */

/**
 * What each player is worth to a specific roster, and what each outside player would add.
 *
 * This is the screening currency. `lose[id]` is the starter points the roster gives up by
 * losing that player -- which for a bench piece is near zero however good he looks, and
 * that is the entire point.
 */
export function rosterMarginals(roster, ctx) {
  const base = seasonLedger(roster, ctx).total
  const lose = new Map()
  for (const p of roster) {
    const without = roster.filter((x) => x.id !== p.id)
    lose.set(p.id, base - seasonLedger(without, ctx).total)
  }
  return { base, lose }
}

/** What adding each candidate would be worth to this roster. */
export function addMarginals(roster, candidates, ctx) {
  const base = seasonLedger(roster, ctx).total
  const gain = new Map()
  for (const p of candidates) {
    gain.set(p.id, seasonLedger([...roster, p], ctx).total - base)
  }
  return { base, gain }
}

/* ------------------------------------------------------------------ combinations */

function* combos(list, k) {
  const n = list.length
  if (k > n) return
  const idx = Array.from({ length: k }, (_, i) => i)
  while (true) {
    yield idx.map((i) => list[i])
    let i = k - 1
    while (i >= 0 && idx[i] === n - k + i) i--
    if (i < 0) return
    idx[i]++
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1
  }
}

/* ------------------------------------------------------------------ acceptance */

/**
 * Would they actually say yes?
 *
 * Three things decide it, and only the first is about points:
 *
 *   perceived gain   market value in minus market value out, from THEIR side. This is the
 *                    number they will look at, whether or not it is the right one.
 *   real gain        what the deal does to their starting lineup. A manager who is paying
 *                    attention will notice eventually, and a deal that is bad for them in
 *                    both currencies is not a proposal, it is a waste of a message.
 *   shape fit        whether what they receive plays a position they actually need.
 *
 * The output is a 0-1 score and a plain-language read. It is a judgement, not a
 * probability, and it is labelled that way in the app.
 */
export function acceptance({ theirMarketDelta, theirModelDelta, theirNeedFit, myMarketDelta }) {
  const perceived = num(theirMarketDelta)
  const real = num(theirModelDelta)
  const fit = Math.max(0, Math.min(1, num(theirNeedFit, 0.5)))

  // Perceived value dominates, and deliberately so. The manager on the other end is not
  // running this model; he is looking at names and where they went in the draft. A deal
  // that looks fair to him is a deal he will consider, whether or not it is fair.
  //
  // Centred slightly positive at zero: a deal that prices out even IS worth sending, and
  // most get-nothing counters come from deals that visibly favour the proposer.
  const perceivedScore = 1 / (1 + Math.exp(-(perceived + 1.5) / 4.5))

  // True value is a MINOR term, not a co-equal one. Weighting it heavily would rule out
  // exactly the trades worth making -- the ones that look fair on names and are not,
  // because consensus rank cannot see his roster. It is kept only so a deal that is awful
  // for him in both currencies ranks below one that is merely quiet.
  const realScore = 1 / (1 + Math.exp(-real / 60))

  // Obvious fleeces get refused regardless of the arithmetic, and asking costs credibility
  // for the next one.
  const insultPenalty = perceived < -18 ? 0.3 : perceived < -9 ? 0.65 : 1

  // Perceived value is the BASE and the other two are modifiers, not co-equal addends.
  // Summed weights cannot work here: with real value near zero for them and a mediocre
  // positional fit, an evenly-priced deal could never score above 0.36 no matter how fair
  // it looked, so the finder reported that nothing was proposable on rosters where obvious
  // trades existed. A deal that prices out even should sit near a coin flip and move from
  // there.
  const fitMod = 0.78 + 0.34 * fit          // 0.78 at no fit, 1.12 at a perfect one
  const realMod = 0.88 + 0.20 * realScore   // 0.88 to 1.08
  const score = Math.max(0, Math.min(1, perceivedScore * fitMod * realMod * insultPenalty))

  let read
  if (score > 0.72 && real > 0) {
    read = 'Should be an easy yes: it looks good to them on name value and it genuinely helps their lineup.'
  } else if (score > 0.72) {
    read = 'They will likely accept. It looks like a win on name value, though their starting lineup barely moves.'
  } else if (score > 0.5) {
    read = 'Plausible. Worth sending, but expect a counter.'
  } else if (perceived < -12) {
    read = 'They will almost certainly refuse. On the names alone this reads as them losing.'
  } else {
    read = 'Unlikely. It does not look like a gain from their side.'
  }
  return { score, read, perceived, real, fit }
}

/**
 * How well what they receive fits the holes in their lineup.
 *
 * Measured on QUALITY, not headcount. A first version counted bodies -- a roster with five
 * running backs registered as having no need for one -- which is wrong in the case that
 * matters most: five mediocre backs is exactly the roster that wants a good one. What
 * decides fit is whether the incoming player would actually displace someone in their
 * starting lineup, and by how much.
 */
export function needFit(theirRoster, incoming, league, cfg = DEFAULT_SCORING) {
  if (!incoming || !incoming.length) return 0.5
  const slots = league?.slots || DEFAULT_LEAGUE.slots

  const byPos = new Map()
  for (const p of theirRoster) {
    if (!byPos.has(p.pos)) byPos.set(p.pos, [])
    byPos.get(p.pos).push(playerPPG(p, cfg))
  }
  for (const [, v] of byPos) v.sort((a, b) => b - a)

  let total = 0
  for (const p of incoming) {
    const starters = Math.max(1, Math.round(num(slots[p.pos], 0)
      + (['RB', 'WR', 'TE'].includes(p.pos) ? num(slots.FLEX, 0) / 3 : 0)))
    const list = byPos.get(p.pos) || []
    // The player he would replace: their worst current starter at the position, or nothing
    // at all if they cannot even field the slot.
    const incumbent = list.length >= starters ? list[starters - 1] : 0
    const upgrade = playerPPG(p, cfg) - incumbent
    // A clear upgrade to a starting slot is a 1; a lateral move is a 0.5; strict depth is
    // near zero. Scaled so ~4 points a game of upgrade reads as a full fit.
    total += Math.max(0, Math.min(1, 0.5 + upgrade / 8))
    list.push(playerPPG(p, cfg))
    list.sort((a, b) => b - a)
    byPos.set(p.pos, list)
  }
  return total / incoming.length
}

/* ------------------------------------------------------------------ the search */

/**
 * Find trades worth proposing.
 *
 * @param {object} input
 * @param {Array}  input.myRoster
 * @param {Array}  input.theirRoster
 * @param {object} input.pack
 * @param {object} [input.cfg]
 * @param {object} [input.league]
 * @param {object} [input.opts]  {shapes, shortlist, untouchable:Set<id>, targets:Set<id>, maxMs}
 * @returns {{candidates, screened, evaluated, elapsedMs, notes}}
 */
export function findTrades(input) {
  const inp = isObj(input) ? input : {}
  const pack = inp.pack
  const cfg = isObj(inp.cfg) ? inp.cfg : DEFAULT_SCORING
  const league = { ...DEFAULT_LEAGUE, ...(isObj(inp.league) ? inp.league : {}) }
  const opts = isObj(inp.opts) ? inp.opts : {}

  const mine = (inp.myRoster || []).filter(isObj)
  const theirs = (inp.theirRoster || []).filter(isObj)
  if (!mine.length || !theirs.length) {
    return { candidates: [], screened: 0, evaluated: 0, elapsedMs: 0,
      notes: ['Both rosters need players before anything can be searched.'] }
  }

  const started = Date.now()
  const maxMs = num(opts.maxMs, 12000)
  const shapes = opts.shapes || SHAPES
  const shortlist = num(opts.shortlist, SHORTLIST)
  const untouchable = opts.untouchable instanceof Set ? opts.untouchable : new Set()
  const targets = opts.targets instanceof Set && opts.targets.size ? opts.targets : null

  const slots = slotsFromCounts(league.slots)
  const weeks = []
  const last = num(pack?.meta?.regSeasonWeeks, 18)
  for (let w = Math.max(1, num(inp.fromWeek, 1)); w <= last; w++) weeks.push(w)
  const cache = new Map()
  const ctx = { weeks, slots, cfg, pack, league, cache }

  const market = marketValues(pack, cfg, league)
  const mv = (p) => num(market.get(p.id), playerPPG(p, cfg))

  // Screening currency. Four ledger passes per player rather than one per combination.
  const myLose = rosterMarginals(mine, ctx)
  const theirLose = rosterMarginals(theirs, ctx)
  const myGain = addMarginals(mine, theirs, ctx)
  const theirGain = addMarginals(theirs, mine, ctx)

  const givable = mine.filter((p) => !untouchable.has(p.id))
  const gettable = targets ? theirs.filter((p) => targets.has(p.id)) : theirs

  const screened = []
  for (const [nGive, nGet] of shapes) {
    if (nGive > givable.length || nGet > gettable.length) continue
    for (const give of combos(givable, nGive)) {
      const giveLoss = sum(give.map((p) => num(myLose.lose.get(p.id))))
      const giveTheirGain = sum(give.map((p) => num(theirGain.gain.get(p.id))))
      const giveMarket = sum(give.map(mv))
      for (const get of combos(gettable, nGet)) {
        const getGain = sum(get.map((p) => num(myGain.gain.get(p.id))))
        const getTheirLoss = sum(get.map((p) => num(theirLose.lose.get(p.id))))
        const getMarket = sum(get.map(mv))

        const myApprox = getGain - giveLoss
        const theirApprox = giveTheirGain - getTheirLoss
        const theirMarket = giveMarket - getMarket

        // Screen out what cannot possibly be worth proposing: no gain for me, or a
        // perceived loss so large it would be refused on sight.
        if (myApprox <= 0) continue
        if (theirMarket < -22) continue
        screened.push({ give, get, myApprox, theirApprox, theirMarket, myMarket: -theirMarket })
      }
      if (Date.now() - started > maxMs) break
    }
    if (Date.now() - started > maxMs) break
  }

  // Shortlist by STRATA of perceived value, not by my gain alone.
  //
  // Ranking purely on what I gain fills the whole shortlist with the largest hauls that
  // squeak past the filter -- every one of them a mild fleece, none of them proposable --
  // and the genuinely balanced deals never get an exact evaluation at all. Sampling the
  // best few from each band of perceived fairness guarantees the even-looking trades are
  // actually considered, which is the entire point of the exercise.
  const BANDS = [
    [3, Infinity], [0, 3], [-3, 0], [-6, -3], [-10, -6], [-Infinity, -10],
  ]
  const perBand = Math.max(4, Math.ceil(shortlist / BANDS.length))
  const picked = []
  const seen = new Set()
  for (const [lo, hi] of BANDS) {
    const band = screened
      .filter((c) => c.theirMarket >= lo && c.theirMarket < hi)
      .sort((a, b) => b.myApprox - a.myApprox)
    for (const c of band.slice(0, perBand)) {
      const key = c.give.map((p) => p.id).join(',') + '>' + c.get.map((p) => p.id).join(',')
      if (seen.has(key)) continue
      seen.add(key)
      picked.push(c)
    }
  }
  // Top up from anywhere if the bands did not fill the budget.
  for (const c of screened.sort((a, b) => b.myApprox - a.myApprox)) {
    if (picked.length >= shortlist) break
    const key = c.give.map((p) => p.id).join(',') + '>' + c.get.map((p) => p.id).join(',')
    if (seen.has(key)) continue
    seen.add(key)
    picked.push(c)
  }

  const evaluated = []
  for (const cand of picked.slice(0, shortlist)) {
    if (Date.now() - started > maxMs * 1.6) break
    const v = evaluateTrade({
      rosterA: mine, rosterB: theirs, sendA: cand.give, sendB: cand.get,
      pack, cfg, league, opts: { sim: false },
    })
    const fit = needFit(theirs, cand.give, league, cfg)
    const acc = acceptance({
      theirMarketDelta: cand.theirMarket,
      theirModelDelta: v.B.starters.delta,
      theirNeedFit: fit,
      myMarketDelta: cand.myMarket,
    })
    evaluated.push({
      give: cand.give.map((p) => ({ id: p.id, name: p.name, pos: p.pos, team: p.team })),
      get: cand.get.map((p) => ({ id: p.id, name: p.name, pos: p.pos, team: p.team })),
      myDelta: v.A.starters.delta,
      theirDelta: v.B.starters.delta,
      myPlayoffDelta: v.A.playoffDelta,
      myPerWeek: v.A.starters.delta / Math.max(weeks.length, 1),
      marketDelta: { me: cand.myMarket, them: cand.theirMarket },
      acceptance: acc,
      flags: v.A.flags,
      // How far apart the two ways of valuing this deal are. A large gap is the whole
      // opportunity: the market cannot see roster context, and you can.
      edge: v.A.starters.delta - cand.myMarket,
      screenError: v.A.starters.delta - cand.myApprox,
    })
  }

  evaluated.sort((a, b) => {
    // Proposable first -- a brilliant trade they will refuse is worth nothing.
    const ra = a.acceptance.score >= 0.5 ? 1 : 0
    const rb = b.acceptance.score >= 0.5 ? 1 : 0
    if (ra !== rb) return rb - ra
    return b.myDelta - a.myDelta
  })

  const proposable = evaluated.filter((c) => c.acceptance.score >= 0.5)
  const longshots = evaluated.filter((c) => c.acceptance.score < 0.5)

  const notes = []
  if (Date.now() - started > maxMs) {
    notes.push('The search hit its time budget, so this is the best of what it reached '
      + 'rather than an exhaustive sweep. Narrow it with targets or untouchables for a '
      + 'more complete answer.')
  }
  if (!evaluated.length) {
    notes.push('Nothing in these two rosters improves your starting lineup without looking '
      + 'like a fleece from their side. That is a real answer, not a failure.')
  }

  if (!proposable.length && longshots.length) {
    notes.push('Nothing here clears the bar for a deal they would plausibly accept. The '
      + 'longshots below improve your lineup but read as a loss from their side, so '
      + 'sending one costs you credibility for the next ask.')
  }

  return {
    candidates: evaluated,
    proposable,
    longshots,
    screened: screened.length,
    evaluated: evaluated.length,
    elapsedMs: Date.now() - started,
    notes,
  }
}

/**
 * The single most proposable deal, with the reasoning spelled out.
 *
 * Useful as the app's one-click answer: what should I actually send this person?
 */
export function bestProposal(input) {
  const r = findTrades(input)
  const top = r.candidates.find((c) => c.acceptance.score >= 0.5) || r.candidates[0]
  if (!top) return { ...r, proposal: null }
  return { ...r, proposal: top }
}
