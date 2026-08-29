/**
 * Live draft assistant.
 *
 * The number that should drive a pick is not raw value, and it is not positional rank.
 * It is VONA -- value over next available -- the points you gain by taking this player NOW
 * versus the best player at his position who will still be there at your next turn. A back
 * who is 3 points better than the next back is worth far less than a tight end who is 6
 * points better than his, even if the back scores more.
 *
 * Everything here recomputes as the board depletes, which is the part static cheat sheets
 * cannot do: replacement level rises as a position drains, tiers collapse as they are
 * picked through, and a run on running backs changes what the next pick should be.
 */

import { DEFAULT_SCORING } from './scoring.js'
import { computeReplacement, replacementDetail } from './replacement.js'
import { playerPPG } from './trade.js'
import { slotsFromCounts } from './lineup.js'

const isObj = (x) => x !== null && typeof x === 'object'
const num = (x, d = 0) => (Number.isFinite(x) ? x : d)

/** Positions a real redraft board cares about. */
export const DRAFT_POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST']

/**
 * Chance a player is still on the board after `picks` more selections.
 *
 * Built from consensus rank: a player ranked well inside the next `picks` window is very
 * likely gone, one ranked well beyond it is very likely there, and the transition is
 * smooth because drafts are not that orderly. `ecr.sd` widens the transition for players
 * the market disagrees about -- exactly the players whose availability is hardest to call.
 */
export function survivalOdds(player, pickNumber, picksUntilNext) {
  const ecr = player?.ecr?.ov
  if (!Number.isFinite(ecr)) return 0.85 // off the board entirely: probably available
  const nextPick = num(pickNumber, 1) + Math.max(0, num(picksUntilNext, 0))
  // Spread of the transition: rank disagreement plus a floor for ordinary draft chaos.
  const sd = Math.max(6, num(player?.ecr?.sd, 0) * 2.2)
  const z = (ecr - nextPick) / sd
  return 1 / (1 + Math.exp(-z))
}

/**
 * Tier breaks from gaps in the value curve.
 *
 * A tier boundary is a drop much larger than the typical drop nearby. This is what makes
 * draft urgency legible: six players left in a tier means you can wait, one means you
 * cannot.
 */
export function assignTiers(sorted, ptsOf, sensitivity = 2.5) {
  const n = sorted.length
  if (n === 0) return []
  const gaps = []
  for (let i = 1; i < n; i++) gaps.push(Math.max(0, ptsOf(sorted[i - 1]) - ptsOf(sorted[i])))
  const positive = gaps.filter((g) => g > 0).sort((a, b) => a - b)
  const median = positive.length ? positive[Math.floor(positive.length / 2)] : 0
  const p90 = positive.length ? positive[Math.floor(positive.length * 0.9)] : 0

  // A break has to clear BOTH a relative and an absolute bar. Relative alone fragments
  // the board: near the bottom of a position the typical gap is a rounding error, so any
  // multiple of it triggers, and every player lands in his own tier -- which is how a
  // first version produced "last 1 in tier 9" for a replacement-level kicker and made
  // every row look urgent.
  const relBar = median * sensitivity
  const absBar = Math.max(0.5, p90 * 0.6)

  const tiers = new Array(n)
  let tier = 1
  let sizeInTier = 0
  tiers[0] = 1
  sizeInTier = 1
  for (let i = 1; i < n; i++) {
    const g = gaps[i - 1]
    // Never break off a tier of one unless the gap is genuinely large.
    const bigEnough = g > relBar && g > absBar
    if (bigEnough && (sizeInTier >= 2 || g > absBar * 1.6)) {
      tier++
      sizeInTier = 0
    }
    tiers[i] = tier
    sizeInTier++
  }
  return tiers
}

/** Which starting slots this roster still needs, and how badly. */
export function rosterNeeds(myRoster, league, cfg = DEFAULT_SCORING) {
  const slots = league?.slots || {}
  const have = {}
  for (const p of myRoster || []) have[p.pos] = (have[p.pos] || 0) + 1

  const need = {}
  for (const pos of DRAFT_POS) {
    const required = num(slots[pos], 0)
    const got = num(have[pos], 0)
    // Flex-eligible positions carry a share of the flex requirement.
    const flexShare = ['RB', 'WR', 'TE'].includes(pos) ? num(slots.FLEX, 0) / 3 : 0
    const target = required + flexShare
    need[pos] = Math.max(0, (target - got) / Math.max(target, 1))
  }
  return { have, need }
}

/**
 * Risk, 0 (safe) to 1 (volatile), from three independent reads.
 *
 * Availability is the injury component; `ecr.sd` is how much the experts disagree, which
 * is real information the model cannot see; `cv` is how much the player's own usage swings
 * week to week.
 */
export function riskScore(player) {
  const miss = 1 - num(player?.avail, 0.85)
  const disagreement = Math.min(1, num(player?.ecr?.sd, 8) / 40)
  const volatility = Math.min(1, num(player?.cv, 0.4) / 0.9)
  return Math.min(1, 0.45 * (miss / 0.45) * 0.45 + 0.3 * disagreement + 0.25 * volatility)
}

/**
 * The board.
 *
 * @param {object} state
 * @param {Array}  state.available   players still undrafted
 * @param {Array}  state.myRoster    what you have already taken
 * @param {object} state.league      slots and team count
 * @param {object} state.cfg         scoring
 * @param {object} state.pack
 * @param {number} state.pickNumber  the overall pick you are on now
 * @param {number} state.picksUntilNext  picks before your next turn (snake: 2*(teams-slot))
 */
export function draftBoard(state) {
  const s = isObj(state) ? state : {}
  const cfg = isObj(s.cfg) ? s.cfg : DEFAULT_SCORING
  const league = isObj(s.league) ? s.league : { teams: 12, slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BEN: 7 } }
  const available = (s.available || []).filter(isObj)
  const myRoster = (s.myRoster || []).filter(isObj)
  const pickNumber = num(s.pickNumber, 1)
  const picksUntilNext = num(s.picksUntilNext, Math.max(1, (num(league.teams, 12) - 1) * 2))

  const pts = (p) => playerPPG(p, cfg)

  // Replacement level over the REMAINING pool, so scarcity emerges as the board drains
  // rather than being fixed at the start.
  const replacement = computeReplacement(available, league, pts)

  // A stable floor for the VONA fallback, computed from the FULL universe rather than the
  // depleting board. Without it, the last player listed at a thin position has nobody
  // behind him, falls back to a replacement level derived from that same thin list, and
  // scores an enormous VONA -- which is how a replacement-level kicker came out ranked
  // second overall on an empty roster.
  const universe = Array.isArray(s.pack?.players) && s.pack.players.length ? s.pack.players : available
  const floorRepl = computeReplacement(universe, league, pts)

  // Per-position sorted lists, tiers, and the next-available estimate.
  const byPos = {}
  for (const pos of DRAFT_POS) {
    const list = available.filter((p) => p.pos === pos).sort((a, b) => pts(b) - pts(a))
    const tiers = assignTiers(list, pts)
    byPos[pos] = { list, tiers }
  }

  const { need } = rosterNeeds(myRoster, league, cfg)

  const rows = []
  for (const pos of DRAFT_POS) {
    const { list, tiers } = byPos[pos]
    for (let i = 0; i < list.length; i++) {
      const p = list[i]
      const value = pts(p)
      const vor = value - num(replacement[pos], 0)

      // VONA: what survives to my next pick at this position, weighted by the odds each
      // candidate is still there. Taking a player is only urgent if the drop-off behind
      // him is steep AND the fall-off will happen before I pick again.
      let expectedNext = 0
      let massSoFar = 0
      for (let j = i + 1; j < list.length && massSoFar < 0.999; j++) {
        const q = list[j]
        const alive = survivalOdds(q, pickNumber, picksUntilNext)
        const takeHere = alive * (1 - massSoFar)
        expectedNext += takeHere * pts(q)
        massSoFar += takeHere
      }
      // Whatever probability mass is left over means "nobody at this position survives",
      // and the honest alternative there is the streamable baseline from the full
      // universe, not from the handful of names still on this particular board.
      const streamFloor = Math.max(num(replacement[pos], 0), num(floorRepl[pos], 0))
      if (massSoFar < 1) expectedNext += (1 - massSoFar) * streamFloor

      // The alternative to any pick is FLOORED at replacement, because taking a
      // replacement-level player is always available. Without this floor, VONA at the
      // bottom of a position compares one unrosterable player against a slightly worse
      // unrosterable player and reports the gap as an edge -- which put the 43rd-best
      // kicker second on the overall board, ahead of every running back.
      expectedNext = Math.max(expectedNext, streamFloor)
      const vona = value - expectedNext

      const risk = riskScore(p)
      const ecrGap = Number.isFinite(p?.ecr?.ov) ? p.ecr.ov - pickNumber : null

      // Need nudges the ordering; it never overrides a large VONA edge. A team with an
      // empty starting slot should break a tie toward filling it, not reach past a
      // materially better player to do it.
      const needBonus = 1 + 0.25 * num(need[pos], 0)
      const score = vona * needBonus

      rows.push({
        player: p,
        pos,
        posRank: i + 1,
        points: value,
        vor,
        vona,
        tier: tiers[i],
        // How many players from here down are still in this tier -- the number that says
        // whether you can wait. Counting the whole tier (including players already past)
        // would overstate it.
        tierRemaining: tiers.filter((t, j) => t === tiers[i] && j >= i).length,
        tierSize: tiers.filter((t) => t === tiers[i]).length,
        ecr: p?.ecr?.ov ?? null,
        ecrGap,
        needScore: num(need[pos], 0),
        risk,
        score,
        reason: reasonFor({ pos, vona, vor, tier: tiers[i], list, tiers, i, ecrGap, risk, need: need[pos] }),
      })
    }
  }

  rows.sort((a, b) => b.score - a.score)
  return {
    replacement,
    replacementDetail: replacementDetail(available, league, pts),
    needs: need,
    picksUntilNext,
    board: rows,
    byPosition: Object.fromEntries(DRAFT_POS.map((pos) => [pos,
      rows.filter((r) => r.pos === pos).slice(0, 25)])),
  }
}

function reasonFor({ pos, vona, vor, tier, list, tiers, i, ecrGap, risk, need }) {
  const leftInTier = tiers.filter((t, j) => t === tier && j >= i).length
  const bits = []
  if (leftInTier <= 2 && vona > 1) {
    bits.push(`last ${leftInTier} in tier ${tier}`)
  }
  if (vona > 2.5) bits.push(`${vona.toFixed(1)} better than what survives to your next pick`)
  else if (vona < 0.6) bits.push('the position will keep')
  if (ecrGap !== null && ecrGap > 12) bits.push(`ranked ${Math.round(ecrGap)} picks later than here`)
  if (risk > 0.6) bits.push('high risk')
  if (need > 0.6) bits.push(`fills a ${pos} starting slot`)
  return bits.length ? bits.join('; ') : `VOR ${vor.toFixed(1)}`
}

/**
 * Positional run detection.
 *
 * A run changes what the next pick should be, and it is the thing people notice too late.
 */
export function detectRun(recentPicks, lookback = 8) {
  const picks = (recentPicks || []).slice(-lookback)
  if (picks.length < 4) return { runs: [], lookback: picks.length }
  const counts = {}
  for (const p of picks) counts[p.pos] = (counts[p.pos] || 0) + 1

  // Baseline: how often a position normally goes, given typical roster construction.
  const baseline = { RB: 0.3, WR: 0.34, QB: 0.11, TE: 0.12, K: 0.06, DST: 0.07 }
  const runs = []
  for (const [pos, n] of Object.entries(counts)) {
    const share = n / picks.length
    const expected = baseline[pos] ?? 0.15
    if (n >= 4 && share > expected * 1.8) {
      runs.push({
        pos, count: n, of: picks.length, share, expected,
        text: `${n} of the last ${picks.length} picks were ${pos}`,
      })
    }
  }
  runs.sort((a, b) => b.count - a.count)
  return { runs, lookback: picks.length }
}

/** Best player available, ignoring roster need. */
export function bestAvailable(state, n = 10) {
  return draftBoard(state).board
    .slice()
    .sort((a, b) => b.vor - a.vor)
    .slice(0, n)
}

/** How thin each position has become, for the scarcity strip in the UI. */
export function positionScarcity(state) {
  const s = isObj(state) ? state : {}
  const cfg = isObj(s.cfg) ? s.cfg : DEFAULT_SCORING
  const league = s.league || { teams: 12, slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BEN: 7 } }
  const available = (s.available || []).filter(isObj)
  const pts = (p) => playerPPG(p, cfg)
  const replacement = computeReplacement(available, league, pts)

  const out = {}
  for (const pos of DRAFT_POS) {
    const list = available.filter((p) => p.pos === pos).sort((a, b) => pts(b) - pts(a))
    const starters = num(league.teams, 12) * num(league.slots?.[pos], 0)
    const aboveReplacement = list.filter((p) => pts(p) > num(replacement[pos], 0) + 0.5).length
    out[pos] = {
      available: list.length,
      startersNeededLeagueWide: starters,
      aboveReplacement,
      replacement: num(replacement[pos], 0),
      topGap: list.length > 1 ? pts(list[0]) - pts(list[1]) : 0,
      scarcity: starters > 0 ? Math.max(0, 1 - aboveReplacement / Math.max(starters, 1)) : 0,
    }
  }
  return out
}
