/**
 * ESPN import tests.
 *
 * The fixture mirrors the shape ESPN actually returns from
 *   /apis/v3/games/ffl/seasons/{yr}/segments/0/leagues/{id}?view=mTeam&view=mRoster&view=mSettings
 * with real player names drawn from the pack, so a matching regression shows up here
 * rather than as a silently short roster.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEspnLeague, normName, buildResolver, espnUrl, SLOT_MAP, POS_MAP } from '../app/js/espn.js'
import { scoreLine } from '../app/js/scoring.js'

globalThis.window = globalThis.window || {}
await import('../app/data/pack.js')
const pack = globalThis.window.TD_PACK

const pick = (pos, n) => pack.players.filter((p) => p.pos === pos && (p.mu || p.kWeeks || p.dstWeeks)).slice(0, n)
const ESPN_TEAM_ID = { ATL: 1, BUF: 2, CIN: 4, DAL: 6, DET: 8, KC: 12, LA: 14, SF: 25, PHI: 21, BAL: 33 }

function espnPlayer(p, slotId) {
  return {
    lineupSlotId: slotId,
    playerPoolEntry: {
      player: {
        id: 1000 + Math.abs(hash(p.id)) % 90000,
        fullName: p.name,
        defaultPositionId: { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, DST: 16 }[p.pos],
        proTeamId: ESPN_TEAM_ID[p.team] ?? 0,
        injuryStatus: 'ACTIVE',
      },
    },
  }
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h }

/** The user's league, expressed the way ESPN expresses it. */
function fixture(opts = {}) {
  const qb = pick('QB', 4), rb = pick('RB', 10), wr = pick('WR', 12), te = pick('TE', 4)
  const k = pick('K', 2), dst = pick('DST', 2)
  const teamRoster = (i) => [
    espnPlayer(qb[i], 0),
    espnPlayer(rb[i * 2], 2), espnPlayer(rb[i * 2 + 1], 2),
    espnPlayer(wr[i * 3], 4), espnPlayer(wr[i * 3 + 1], 4), espnPlayer(wr[i * 3 + 2], 23),
    espnPlayer(te[i], 6),
    espnPlayer(k[i], 17), espnPlayer(dst[i], 16),
    espnPlayer(rb[i * 2 + 4], 20), espnPlayer(wr[i * 3 + 6], 20),
  ]
  return {
    id: 987654,
    settings: {
      name: 'Sunday Money',
      size: 12,
      rosterSettings: {
        lineupSlotCounts: { 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 16: 1, 17: 1, 20: 7, 21: 1 },
      },
      scheduleSettings: { matchupPeriodCount: 14, playoffTeamCount: 6 },
      scoringSettings: {
        scoringType: 'H2H_POINTS',
        scoringItems: opts.scoringItems || [
          { statId: 3, points: 0.04 }, { statId: 4, points: 4 }, { statId: 20, points: -2 },
          { statId: 24, points: 0.1 }, { statId: 25, points: 6 },
          { statId: 42, points: 0.1 }, { statId: 43, points: 6 }, { statId: 53, points: 1 },
          { statId: 72, points: -2 },
          { statId: 80, points: 3 }, { statId: 77, points: 4 }, { statId: 74, points: 5 },
          { statId: 85, points: -1 }, { statId: 86, points: 1 },
          { statId: 99, points: 1 }, { statId: 95, points: 2 }, { statId: 96, points: 2 },
          { statId: 98, points: 2 }, { statId: 94, points: 6 },
          { statId: 89, points: 5 }, { statId: 90, points: 4 }, { statId: 91, points: 3 },
          { statId: 92, points: 1 }, { statId: 121, points: 0 }, { statId: 122, points: 0 },
          { statId: 123, points: -1 }, { statId: 124, points: -3 }, { statId: 125, points: -5 },
          { statId: 128, points: 5 }, { statId: 129, points: 3 }, { statId: 130, points: 2 },
          { statId: 131, points: 0 }, { statId: 132, points: -1 }, { statId: 133, points: -3 },
          { statId: 134, points: -5 }, { statId: 135, points: -6 }, { statId: 136, points: -7 },
        ],
      },
    },
    teams: [
      { id: 1, location: 'Gridiron', nickname: 'Ghosts', abbrev: 'GG',
        record: { overall: { wins: 3, losses: 1 } }, roster: { entries: teamRoster(0) } },
      { id: 2, location: 'Third', nickname: 'Down', abbrev: 'TD',
        record: { overall: { wins: 2, losses: 2 } }, roster: { entries: teamRoster(1) } },
    ],
  }
}

test('a realistic ESPN payload imports cleanly', () => {
  const r = parseEspnLeague(fixture(), pack)
  assert.ok(r.ok, r.error)
  assert.equal(r.league.name, 'Sunday Money')
  assert.equal(r.league.teams, 12)
  assert.equal(r.teams.length, 2)
  assert.ok(r.teams[0].players.length >= 9, `only ${r.teams[0].players.length} matched`)
  assert.equal(r.teams[0].name, 'Gridiron Ghosts')
  assert.equal(r.teams[0].wins, 3)
  assert.equal(r.unmatched.length, 0, JSON.stringify(r.unmatched.slice(0, 3)))
})

test('the imported scoring reproduces the league exactly', () => {
  const r = parseEspnLeague(fixture(), pack)
  const c = r.cfg
  assert.equal(c.pass.yd, 0.04)
  assert.equal(c.pass.td, 4)
  assert.equal(c.pass.int, -2)
  assert.equal(c.rush.yd, 0.1)
  assert.equal(c.rush.td, 6)
  assert.equal(c.rec.rec, 1)
  assert.equal(c.rec.td, 6)
  assert.equal(c.misc.fumLost, -2)

  // A hand-computed line must score the same under the import as under the app's default.
  const line = { rec: 8, tgt: 12, reyd: 110, retd: 1 }
  assert.equal(scoreLine(line, c, 'WR'), 25)
  const qbLine = { pyd: 300, ptd: 2, pint: 1, ryd: 20 }
  assert.equal(scoreLine(qbLine, c, 'QB'), 20)
})

test('the D/ST tier ladders import with ESPN\'s own bucket edges', () => {
  const r = parseEspnLeague(fixture(), pack)
  const pa = r.cfg.dst.paTiers
  const ya = r.cfg.dst.yaTiers
  assert.deepEqual(pa.map((t) => t.max), [0, 6, 13, 17, 21, 27, 34, 45, 1e9])
  assert.deepEqual(pa.map((t) => t.pts), [5, 4, 3, 1, 0, 0, -1, -3, -5])
  assert.deepEqual(ya.map((t) => t.max), [99, 199, 299, 349, 399, 449, 499, 549, 1e9])
  assert.deepEqual(ya.map((t) => t.pts), [5, 3, 2, 0, -1, -3, -5, -6, -7])

  // And a D/ST line scores what it should: 3 sacks, 2 INT, 1 FR, 1 TD, 10 PA, 250 YA.
  const dstLine = { sack: 3, dint: 2, fumrec: 1, dtd: 1, ptsAllowed: 10, ydsAllowed: 250 }
  assert.equal(scoreLine(dstLine, r.cfg, 'DST'), 3 + 4 + 2 + 6 + 3 + 2)
})

test('kicker distance buckets expand from ESPN\'s three to the app\'s six', () => {
  const r = parseEspnLeague(fixture(), pack)
  // ESPN buckets are 0-39 / 40-49 / 50+; the app models six, so the wider ESPN bands fill
  // the finer ones rather than leaving them at zero.
  assert.equal(r.cfg.k.fg['0_19'], 3)
  assert.equal(r.cfg.k.fg['20_29'], 3)
  assert.equal(r.cfg.k.fg['30_39'], 3)
  assert.equal(r.cfg.k.fg['40_49'], 4)
  assert.equal(r.cfg.k.fg['50_59'], 5)
  assert.equal(r.cfg.k.fg['60'], 5)
  assert.equal(r.cfg.k.miss, -1)
  assert.equal(r.cfg.k.xp, 1)
})

test('slots come from ESPN, and an IR slot is not a starting slot', () => {
  const r = parseEspnLeague(fixture(), pack)
  assert.equal(r.slots.QB, 1)
  assert.equal(r.slots.RB, 2)
  assert.equal(r.slots.WR, 2)
  assert.equal(r.slots.TE, 1)
  assert.equal(r.slots.FLEX, 1)
  assert.equal(r.slots.K, 1)
  assert.equal(r.slots.DST, 1)
  assert.equal(r.slots.BEN, 7)
  assert.ok(!('IR' in r.slots), 'IR must not be imported as a startable slot')
})

test('a half-PPR league imports as half PPR, not as the default', () => {
  const half = fixture({
    scoringItems: [
      { statId: 3, points: 0.04 }, { statId: 4, points: 4 }, { statId: 20, points: -2 },
      { statId: 24, points: 0.1 }, { statId: 25, points: 6 },
      { statId: 42, points: 0.1 }, { statId: 43, points: 6 },
      { statId: 53, points: 0.5 }, { statId: 72, points: -2 },
    ],
  })
  const r = parseEspnLeague(half, pack)
  assert.equal(r.cfg.rec.rec, 0.5)
  // And a rule ESPN did NOT mention must score nothing rather than inheriting a default.
  assert.equal(r.cfg.pass.b300, 0, 'an unmentioned bonus must be zero, not the app default')
})

test('unsupported scoring rules are reported, never silently dropped', () => {
  const weird = fixture({
    scoringItems: [
      { statId: 53, points: 1 }, { statId: 42, points: 0.1 },
      { statId: 15, points: 2 },   // 40+ yard TD pass bonus: known, unmodelled
      { statId: 62, points: 0.5 }, // per target: known, unmodelled
      { statId: 231, points: 3 },  // something this app has never heard of
    ],
  })
  const r = parseEspnLeague(weird, pack)
  const ids = r.unsupported.map((u) => u.statId)
  assert.ok(ids.includes(15) && ids.includes(62) && ids.includes(231))
  assert.ok(r.unsupported.find((u) => u.statId === 231).points === 3)
  assert.ok(r.warnings.some((w) => /could not be modelled/.test(w)))
  // A zero-valued rule is not a rule, and should not be reported as a problem.
  const quiet = parseEspnLeague(fixture({
    scoringItems: [{ statId: 53, points: 1 }, { statId: 15, points: 0 }],
  }), pack)
  assert.equal(quiet.unsupported.length, 0)
})

test('players ESPN has but the pack does not are listed, not invented', () => {
  const fx = fixture()
  fx.teams[0].roster.entries.push({
    lineupSlotId: 20,
    playerPoolEntry: { player: { id: 999999, fullName: 'Fake Nonexistent Player', defaultPositionId: 3, proTeamId: 12 } },
  })
  const r = parseEspnLeague(fx, pack)
  assert.equal(r.unmatched.length, 1)
  assert.equal(r.unmatched[0].name, 'Fake Nonexistent Player')
  assert.ok(!r.teams[0].players.some((p) => /Fake/.test(p.name)), 'must not fabricate a match')
  assert.ok(r.warnings.some((w) => /could not be matched/.test(w)))
})

test('playoff weeks are derived from the ESPN schedule', () => {
  const r = parseEspnLeague(fixture(), pack)
  assert.equal(r.league.regSeasonWeeks, 14)
  assert.deepEqual(r.league.playoffWeeks, [15, 16, 17])
  assert.equal(r.league.playoffTeams, 6)
})

test('IDP and unknown positions are skipped rather than mangled', () => {
  const fx = fixture()
  fx.teams[0].roster.entries.push({
    lineupSlotId: 10,
    playerPoolEntry: { player: { id: 5, fullName: 'Some Linebacker', defaultPositionId: 10, proTeamId: 12 } },
  })
  const r = parseEspnLeague(fx, pack)
  assert.ok(!r.unmatched.some((u) => u.name === 'Some Linebacker'),
    'an IDP is out of scope, not an unmatched skill player')
})

test('bad input fails with a message a person can act on', () => {
  for (const bad of ['', 'not json', '{}', '[]', null, undefined, 42]) {
    const r = parseEspnLeague(bad, pack)
    assert.equal(r.ok, false)
    assert.ok(typeof r.error === 'string' && r.error.length > 10, `unhelpful error for ${JSON.stringify(bad)}`)
  }
  const html = parseEspnLeague('<!DOCTYPE html><html>login page</html>', pack)
  assert.equal(html.ok, false)
  assert.match(html.error, /JSON/)
})

test('an array-wrapped payload still parses', () => {
  const r = parseEspnLeague([fixture()], pack)
  assert.ok(r.ok)
  assert.equal(r.teams.length, 2)
})

test('raw JSON text parses the same as an object', () => {
  const a = parseEspnLeague(fixture(), pack)
  const b = parseEspnLeague(JSON.stringify(fixture()), pack)
  assert.equal(a.summary.rostered, b.summary.rostered)
  assert.deepEqual(a.cfg.dst.paTiers, b.cfg.dst.paTiers)
})

test('name normalisation handles the cases that actually break matching', () => {
  assert.equal(normName("Ja'Marr Chase"), 'jamarr chase')
  assert.equal(normName('Marvin Harrison Jr.'), 'marvin harrison')
  assert.equal(normName('D.J. Moore'), 'dj moore')
  assert.equal(normName('  Amon-Ra  St. Brown '), 'amon ra st brown')
  assert.equal(normName(null), '')
})

test('the resolver refuses to guess between two players with the same name', () => {
  const resolve = buildResolver({
    players: [
      { id: 'a', name: 'John Smith', pos: 'WR', team: 'KC' },
      { id: 'b', name: 'John Smith', pos: 'WR', team: 'BUF' },
    ],
  })
  assert.equal(resolve('John Smith', 'WR', 'KC').id, 'a')
  assert.equal(resolve('John Smith', 'WR', 'DAL'), null, 'ambiguous with no team match must be null')
})

test('the URL builder produces the documented endpoint', () => {
  const u = espnUrl(' 123-456 ', 2026)
  assert.match(u, /seasons\/2026/)
  assert.match(u, /leagues\/123456\?/)
  assert.match(u, /view=mTeam/)
  assert.match(u, /view=mRoster/)
  assert.match(u, /view=mSettings/)
})

test('the constant maps cover the slots and positions this app models', () => {
  for (const id of [0, 2, 4, 6, 16, 17, 20, 23]) assert.ok(SLOT_MAP[id], `slot ${id} unmapped`)
  for (const id of [1, 2, 3, 4, 5, 16]) assert.ok(POS_MAP[id], `position ${id} unmapped`)
})
