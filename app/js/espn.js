/**
 * ESPN league import.
 *
 * WHY THIS IS A PASTE AND NOT A FETCH. ESPN's fantasy API is not reachable from the
 * environment this app is built in, and a published page cannot call it either -- the
 * content security policy blocks requests to anything but a short CDN allowlist. More to
 * the point, a private league needs your `espn_s2` and `SWID` cookies, and a tool that
 * asks for those is a tool you should not use. Your own browser already has them, so the
 * exchange is: you open one URL while logged in, and paste back what ESPN hands you.
 * Nothing leaves your machine and no credential ever touches this app.
 *
 *   https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/
 *     leagues/YOUR_LEAGUE_ID?view=mTeam&view=mRoster&view=mSettings
 *
 * Every id below is taken from ESPN's own published constants rather than inferred. The
 * scoring map in particular runs to 235 stat ids; the ones this league can use are mapped
 * exactly, and anything unrecognised is REPORTED rather than silently dropped, because a
 * scoring rule you did not notice is worse than one the app admits it cannot read.
 */

import { cloneScoring, DEFAULT_SCORING } from './scoring.js'

/* ------------------------------------------------------------------ ESPN constants */

/** Lineup slot ids -> our slot names. */
export const SLOT_MAP = Object.freeze({
  0: 'QB', 1: 'QB', 2: 'RB', 3: 'RBWR', 4: 'WR', 5: 'WRT', 6: 'TE', 7: 'SUPERFLEX',
  16: 'DST', 17: 'K', 20: 'BEN', 21: 'IR', 23: 'FLEX',
})

/** Player position ids -> our positions. */
export const POS_MAP = Object.freeze({ 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DST' })

/** ESPN pro team ids -> abbreviations, normalised to the pack's spelling. */
export const TEAM_MAP = Object.freeze({
  0: 'FA', 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET',
  9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LA', 15: 'MIA', 16: 'MIN',
  17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC',
  25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU',
})

/**
 * Scoring stat ids this app understands, mapped onto its own config.
 *
 * `path` is where the value lands in a scoring config. `per` marks a rate that ESPN
 * expresses per unit (a yard, a reception) rather than per event.
 */
const SCORING_MAP = {
  3: { path: 'pass.yd', label: 'Passing yards' },
  4: { path: 'pass.td', label: 'Passing TD' },
  19: { path: 'pass.twoPt', label: '2pt pass' },
  20: { path: 'pass.int', label: 'Interception thrown' },
  64: { path: 'pass.sack', label: 'Sacked' },
  17: { path: 'pass.b300', label: '300-yard passing game' },
  18: { path: 'pass.b400', label: '400-yard passing game' },

  24: { path: 'rush.yd', label: 'Rushing yards' },
  25: { path: 'rush.td', label: 'Rushing TD' },
  26: { path: 'rush.twoPt', label: '2pt rush' },
  37: { path: 'rush.b100', label: '100-yard rushing game' },
  38: { path: 'rush.b200', label: '200-yard rushing game' },

  42: { path: 'rec.yd', label: 'Receiving yards' },
  43: { path: 'rec.td', label: 'Receiving TD' },
  44: { path: 'rec.twoPt', label: '2pt reception' },
  53: { path: 'rec.rec', label: 'Per reception' },
  58: { path: 'rec.b100', label: '100-yard receiving game' },
  59: { path: 'rec.b200', label: '200-yard receiving game' },

  72: { path: 'misc.fumLost', label: 'Fumble lost' },
  101: { path: 'misc.stTd', label: 'Kick return TD' },
  102: { path: 'misc.stTd', label: 'Punt return TD' },

  80: { path: 'k.fg.0_19', label: 'FG 0-39', also: ['k.fg.20_29', 'k.fg.30_39'] },
  77: { path: 'k.fg.40_49', label: 'FG 40-49' },
  74: { path: 'k.fg.50_59', label: 'FG 50+', also: ['k.fg.60'] },
  82: { path: 'k.miss', label: 'FG missed 0-39' },
  79: { path: 'k.miss', label: 'FG missed 40-49' },
  76: { path: 'k.miss', label: 'FG missed 50+' },
  85: { path: 'k.miss', label: 'FG missed' },
  86: { path: 'k.xp', label: 'PAT made' },
  88: { path: 'k.xpMiss', label: 'PAT missed' },

  99: { path: 'dst.sack', label: 'Sack' },
  95: { path: 'dst.int', label: 'Interception' },
  96: { path: 'dst.fumRec', label: 'Fumble recovered' },
  98: { path: 'dst.safety', label: 'Safety' },
  97: { path: 'dst.blk', label: 'Blocked kick' },
  93: { path: 'dst.td', label: 'Blocked kick return TD' },
  94: { path: 'dst.td', label: 'Fumble or INT return TD' },
  103: { path: 'dst.td', label: 'Interception return TD' },
  104: { path: 'dst.td', label: 'Fumble return TD' },
}

/**
 * Points-allowed and yards-allowed tier stat ids, in ascending bucket order.
 *
 * This is the part worth stating plainly: the app previously carried these bucket edges as
 * INFERRED, because a league's scoring screen shows nine payouts without the cutoffs.
 * ESPN's own stat definitions name them, and they match what was inferred exactly. They
 * are no longer a guess.
 */
const PA_TIERS = [
  [89, 0, '0 points allowed'], [90, 6, '1-6'], [91, 13, '7-13'], [92, 17, '14-17'],
  [121, 21, '18-21'], [122, 27, '22-27'], [123, 34, '28-34'], [124, 45, '35-45'],
  [125, 1e9, '46+'],
]
const YA_TIERS = [
  [128, 99, 'under 100 yards allowed'], [129, 199, '100-199'], [130, 299, '200-299'],
  [131, 349, '300-349'], [132, 399, '350-399'], [133, 449, '400-449'],
  [134, 499, '450-499'], [135, 549, '500-549'], [136, 1e9, '550+'],
]

/** Stat ids that are real scoring rules but that this app's model cannot represent. */
const KNOWN_UNSUPPORTED = {
  0: 'per pass attempt', 1: 'per completion', 2: 'per incompletion',
  15: '40+ yard TD pass bonus', 16: '50+ yard TD pass bonus',
  35: '40+ yard TD rush bonus', 36: '50+ yard TD rush bonus',
  23: 'per rush attempt', 60: '40+ yard TD reception bonus', 61: '50+ yard TD reception bonus',
  62: 'per target', 106: 'forced fumble', 120: 'per point allowed', 127: 'per yard allowed',
}

/* ------------------------------------------------------------------ name matching */

const SUFFIX = /\b(jr|sr|ii|iii|iv|v)\b/g

/** Same normalisation the build pipeline uses, so both sides agree on a name. */
export function normName(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(SUFFIX, '')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * Resolve an ESPN player onto a pack player.
 *
 * Strict on purpose. An ambiguous match returns null and is reported, because putting the
 * wrong player on a roster produces a confident, wrong trade verdict -- which is worse
 * than a gap the user can see and fill in by hand.
 */
export function buildResolver(pack) {
  const byKey = new Map()
  const add = (k, p) => {
    if (!k) return
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(p)
  }
  for (const p of pack.players) {
    const n = normName(p.name)
    add(`${n}|${p.pos}|${p.team}`, p)
    add(`${n}|${p.pos}`, p)
    add(n, p)
  }
  return function resolve(name, pos, team) {
    const n = normName(name)
    for (const key of [`${n}|${pos}|${team}`, `${n}|${pos}`, n]) {
      const hits = byKey.get(key)
      if (!hits || !hits.length) continue
      if (hits.length === 1) return hits[0]
      const byTeam = hits.filter((h) => h.team === team)
      if (byTeam.length === 1) return byTeam[0]
      const byPos = hits.filter((h) => h.pos === pos)
      if (byPos.length === 1) return byPos[0]
    }
    return null
  }
}

/* ------------------------------------------------------------------ parsing */

function setPath(obj, path, value) {
  const parts = path.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = value
}

/**
 * Turn an ESPN league payload into scoring, slots and rosters.
 *
 * @param {object|string} payload the JSON ESPN returns (object or raw text)
 * @param {object} pack
 * @returns {{ok, league, cfg, slots, teams, unmatched, unsupported, warnings, summary}}
 */
export function parseEspnLeague(payload, pack) {
  let data = payload
  if (typeof data === 'string') {
    const txt = data.trim()
    try {
      data = JSON.parse(txt)
    } catch (e) {
      return { ok: false, error: 'That does not parse as JSON. Copy the whole response, '
        + 'from the opening { to the closing }.' }
    }
  }
  // Some ESPN endpoints wrap the league in a single-element array.
  if (Array.isArray(data)) data = data[0]
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'Empty response.' }
  }
  if (!data.teams && !data.settings) {
    return { ok: false, error: 'This looks like ESPN JSON but has no teams or settings. '
      + 'Make sure the URL includes view=mTeam&view=mRoster&view=mSettings.' }
  }

  const warnings = []
  const unsupported = []
  const settings = data.settings || {}

  /* ---- scoring ---- */
  const cfg = cloneScoring(DEFAULT_SCORING)
  // Start from zero so the imported league is what ESPN says, not our defaults with a few
  // fields overwritten. A rule ESPN does not mention is a rule that scores nothing.
  const zeroed = zeroScoring(cfg)
  const items = settings.scoringSettings?.scoringItems || []
  let mapped = 0

  if (!items.length) {
    warnings.push('No scoring settings in the payload, so the app kept its full-PPR '
      + 'defaults. Add view=mSettings to the URL to import your real scoring.')
  } else {
    for (const item of items) {
      const id = Number(item.statId)
      const pts = Number(item.points ?? item.pointsOverrides?.['16'] ?? 0)
      if (!Number.isFinite(id)) continue

      const m = SCORING_MAP[id]
      if (m) {
        setPath(zeroed, m.path, pts)
        for (const extra of m.also || []) setPath(zeroed, extra, pts)
        mapped++
        continue
      }
      const pa = PA_TIERS.find((t) => t[0] === id)
      if (pa) {
        const idx = PA_TIERS.indexOf(pa)
        zeroed.dst.paTiers[idx] = { max: pa[1], pts }
        mapped++
        continue
      }
      const ya = YA_TIERS.find((t) => t[0] === id)
      if (ya) {
        const idx = YA_TIERS.indexOf(ya)
        zeroed.dst.yaTiers[idx] = { max: ya[1], pts }
        mapped++
        continue
      }
      if (pts !== 0) {
        unsupported.push({
          statId: id,
          points: pts,
          label: KNOWN_UNSUPPORTED[id] || `ESPN stat ${id}`,
          known: !!KNOWN_UNSUPPORTED[id],
        })
      }
    }
    zeroed.id = 'espn-import'
    zeroed.name = settings.name ? `${settings.name} (imported)` : 'ESPN import'
  }

  /* ---- roster slots ---- */
  const counts = settings.rosterSettings?.lineupSlotCounts || {}
  const slots = {}
  for (const [id, n] of Object.entries(counts)) {
    const name = SLOT_MAP[Number(id)]
    const num = Number(n)
    if (!name || !num) continue
    if (name === 'IR') continue // an IR slot is not a starting slot
    slots[name] = (slots[name] || 0) + num
  }
  if (!Object.keys(slots).length) {
    warnings.push('No lineup slots in the payload; kept the current roster settings.')
  }

  /* ---- teams and rosters ---- */
  const resolve = buildResolver(pack)
  const teams = []
  const unmatched = []

  for (const t of data.teams || []) {
    const name = t.name || [t.location, t.nickname].filter(Boolean).join(' ') || `Team ${t.id}`
    const entries = t.roster?.entries || []
    const players = []
    for (const e of entries) {
      const pl = e.playerPoolEntry?.player || e.player
      if (!pl) continue
      const pos = POS_MAP[pl.defaultPositionId]
      const team = TEAM_MAP[pl.proTeamId] || ''
      if (!pos) continue // IDP or a slot this app does not model
      const hit = resolve(pl.fullName, pos, team)
      if (hit) {
        players.push({
          id: hit.id,
          name: hit.name,
          pos: hit.pos,
          espnName: pl.fullName,
          // ESPN's own injury flag, which is fresher than anything baked into the pack.
          injuryStatus: pl.injuryStatus || null,
          lineupSlot: SLOT_MAP[e.lineupSlotId] || null,
        })
      } else {
        unmatched.push({ team: name, name: pl.fullName, pos, proTeam: team })
      }
    }
    teams.push({
      espnId: t.id,
      name,
      abbrev: t.abbrev || '',
      owner: (t.owners && t.owners[0]) || null,
      wins: t.record?.overall?.wins ?? null,
      losses: t.record?.overall?.losses ?? null,
      players,
    })
  }

  /* ---- playoffs ---- */
  const sched = settings.scheduleSettings || {}
  const regSeasonWeeks = Number(sched.matchupPeriodCount) || null
  const playoffTeams = Number(sched.playoffTeamCount) || null
  let playoffWeeks = null
  if (regSeasonWeeks) {
    // ESPN's regular season ends after matchupPeriodCount; the fantasy postseason runs the
    // weeks after it, capped at the NFL regular season.
    const last = Number(pack?.meta?.regSeasonWeeks) || 18
    playoffWeeks = []
    for (let w = regSeasonWeeks + 1; w <= Math.min(last, regSeasonWeeks + 3); w++) playoffWeeks.push(w)
    if (!playoffWeeks.length) playoffWeeks = null
  }

  if (unmatched.length) {
    warnings.push(`${unmatched.length} player(s) on ESPN could not be matched to this app's `
      + 'data and were left off. They are listed below so you can add them by hand rather '
      + 'than have the app guess.')
  }
  if (unsupported.length) {
    warnings.push(`${unsupported.length} scoring rule(s) could not be modelled and were `
      + 'ignored. They are listed below with their point values so you can judge whether '
      + 'they matter.')
  }

  return {
    ok: true,
    league: {
      id: data.id ?? null,
      name: settings.name || 'Imported league',
      teams: Number(settings.size) || (data.teams || []).length || 12,
      regSeasonWeeks,
      playoffTeams,
      playoffWeeks,
      scoringType: settings.scoringSettings?.scoringType ?? null,
    },
    cfg: items.length ? zeroed : cfg,
    slots: Object.keys(slots).length ? slots : null,
    teams,
    unmatched,
    unsupported,
    warnings,
    summary: {
      teams: teams.length,
      rostered: teams.reduce((s, t) => s + t.players.length, 0),
      scoringRulesMapped: mapped,
      scoringRulesIgnored: unsupported.length,
      unmatched: unmatched.length,
    },
  }
}

/** A scoring config with every numeric rule set to zero, tiers included. */
function zeroScoring(base) {
  const c = cloneScoring(base)
  const walk = (o) => {
    for (const k of Object.keys(o)) {
      const v = o[k]
      if (typeof v === 'number') o[k] = 0
      else if (Array.isArray(v)) v.forEach((x) => { if (x && typeof x === 'object' && 'pts' in x) x.pts = 0 })
      else if (v && typeof v === 'object') walk(v)
    }
  }
  for (const section of ['pass', 'rush', 'rec', 'misc', 'k', 'dst']) {
    if (c[section]) walk(c[section])
  }
  // Restore the tier ladders' shape; only the payouts were zeroed.
  c.dst.paTiers = PA_TIERS.map(([, max]) => ({ max, pts: 0 }))
  c.dst.yaTiers = YA_TIERS.map(([, max]) => ({ max, pts: 0 }))
  return c
}

/** The URL to open, for a given league and season. */
export function espnUrl(leagueId, season) {
  const id = String(leagueId || '').trim().replace(/[^0-9]/g, '')
  const yr = Number(season) || 2026
  return `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${yr}`
    + `/segments/0/leagues/${id}?view=mTeam&view=mRoster&view=mSettings`
}

/** Human-readable description of the tier ladders, for the settings screen. */
export const TIER_LABELS = Object.freeze({
  pa: PA_TIERS.map(([, , label]) => label),
  ya: YA_TIERS.map(([, , label]) => label),
})
