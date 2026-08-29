/**
 * End-to-end check of the bundled app in a real browser.
 *
 * The unit tests prove the math. This proves the thing actually opens, renders real
 * players, computes a real verdict, and reacts to a scoring change -- which is the part
 * no amount of module testing can tell you.
 *
 * Run: node scripts/verify-browser.mjs
 */

import { chromium } from 'playwright'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = join(ROOT, 'dist', 'tradedesk.html')
const SHOTS = join(ROOT, 'dist', 'shots')

if (!existsSync(FILE)) {
  console.error('dist/tradedesk.html missing -- run `node scripts/bundle.mjs` first')
  process.exit(1)
}
mkdirSync(SHOTS, { recursive: true })

const problems = []
const note = (ok, label, extra = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${extra ? `  ${extra}` : ''}`)
  if (!ok) problems.push(label)
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()

const consoleErrors = []
const pageErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => pageErrors.push(String(e)))

console.log('loading the bundle from file://\n')
await page.goto(`file://${FILE}`, { waitUntil: 'load' })
await page.waitForTimeout(2500)

note(pageErrors.length === 0, 'page loads with no uncaught exception',
  pageErrors.slice(0, 2).join(' | '))
note(consoleErrors.length === 0, 'no console errors', consoleErrors.slice(0, 2).join(' | '))

// --- the data actually arrived -------------------------------------------------
const packInfo = await page.evaluate(() => ({
  players: window.TD_PACK?.players?.length ?? 0,
  season: window.TD_PACK?.meta?.season,
  league: window.TD_LEAGUE?.rosters?.length ?? 0,
  myTeam: window.TD_LEAGUE?.myTeam,
  leagueTeams: window.TD_LEAGUE?.teams,
}))
note(packInfo.players > 900, 'data pack present', `${packInfo.players} players, ${packInfo.season}`)
note(packInfo.league === packInfo.leagueTeams && packInfo.league > 1,
  'the real league is present, every roster in it',
  `${packInfo.league} of ${packInfo.leagueTeams} teams, you are ${packInfo.myTeam}`)

// --- the trade view rendered a real verdict -----------------------------------
const rowsA = await page.locator('#rowsA .row').count()
const rowsB = await page.locator('#rowsB .row').count()
note(rowsA > 5 && rowsB > 5, 'both rosters populated from the league', `${rowsA} / ${rowsB}`)

const names = await page.locator('#rowsA .nm').allTextContents()
note(names.some((n) => n.trim().length > 3), 'roster shows real player names', names[0] || '')

// The app should open on the user's own roster against this week's opponent, with both
// pickers resolving to real league teams rather than sitting on "custom".
const picks = await page.evaluate(() => ({
  a: document.getElementById('pickA')?.value,
  b: document.getElementById('pickB')?.value,
  mine: window.TD_LEAGUE?.myTeam,
  opts: document.getElementById('pickA')?.options.length ?? 0,
}))
note(picks.a === picks.mine, 'opens on your own roster', `${picks.a}`)
note(!!picks.b && picks.b !== picks.a, "the other side is this week's opponent", `${picks.b}`)
note(picks.opts === (await page.evaluate(() => window.TD_LEAGUE.rosters.length)) + 1,
  'every league team is selectable', `${picks.opts} options`)

// Move a player and confirm a verdict appears with real numbers.
await page.locator('#rowsA .row .pill').first().click()
await page.locator('#rowsB .row .pill').first().click()
await page.waitForTimeout(2500)

const verdict = await page.evaluate(() => {
  const big = document.querySelector('#verdict .big')
  const stats = [...document.querySelectorAll('#verdict .stat .v')].map((n) => n.textContent.trim())
  return {
    headline: big ? big.textContent.trim() : null,
    stats,
    sides: document.querySelectorAll('#verdict .side').length,
    weeks: document.querySelectorAll('#verdict .weekstrip .wk').length,
  }
})
note(!!verdict.headline && /[0-9]/.test(verdict.headline), 'headline shows a number',
  verdict.headline || '')
note(verdict.sides === 2, 'both sides evaluated independently', `${verdict.sides} panels`)
note(verdict.weeks >= 16, 'week-by-week strip rendered', `${verdict.weeks} weeks`)
note(!verdict.stats.some((s) => /NaN|undefined/.test(s)), 'no NaN in the verdict stats',
  verdict.stats.filter((s) => /NaN|undefined/.test(s)).join(', '))
await page.screenshot({ path: join(SHOTS, 'desktop-trade.png'), fullPage: true })

// --- players table ------------------------------------------------------------
await page.locator('nav.tabs button[data-view="players"]').click()
await page.waitForTimeout(1200)
const pRows = await page.locator('#pBody tr').count()
note(pRows > 20, 'players table populated', `${pRows} rows`)
const firstPlayer = await page.locator('#pBody tr td.name').first().textContent()
note((firstPlayer || '').trim().length > 3, 'players table shows real names', firstPlayer || '')
await page.locator('#pBody tr').first().click()
await page.waitForTimeout(700)
const detailShown = await page.locator('#pDetail .kv').count()
note(detailShown > 0, 'player detail opens')
await page.screenshot({ path: join(SHOTS, 'desktop-players.png'), fullPage: true })

// --- draft --------------------------------------------------------------------
await page.locator('nav.tabs button[data-view="draft"]').click()
await page.waitForTimeout(1800)
const dRows = await page.locator('#dBody tr').count()
note(dRows > 10, 'draft board populated', `${dRows} rows`)
const topPos = await page.locator('#dBody tr .pos').first().textContent()
note(['WR', 'RB', 'TE', 'QB'].includes((topPos || '').trim()),
  'the top draft row is a skill player, not a kicker', topPos || '')
await page.screenshot({ path: join(SHOTS, 'desktop-draft.png'), fullPage: true })

// --- scoring change propagates ------------------------------------------------
await page.locator('nav.tabs button[data-view="players"]').click()
await page.waitForTimeout(800)
const beforeTop = await page.evaluate(() =>
  [...document.querySelectorAll('#pBody tr')].slice(0, 8)
    .map((tr) => tr.children[0].textContent.trim() + '|' + tr.children[4].textContent.trim()))

await page.locator('nav.tabs button[data-view="league"]').click()
await page.waitForTimeout(800)
await page.selectOption('#preset', 'standard')
await page.waitForTimeout(1200)
await page.locator('nav.tabs button[data-view="players"]').click()
await page.waitForTimeout(1200)
const afterTop = await page.evaluate(() =>
  [...document.querySelectorAll('#pBody tr')].slice(0, 8)
    .map((tr) => tr.children[0].textContent.trim() + '|' + tr.children[4].textContent.trim()))

note(JSON.stringify(beforeTop) !== JSON.stringify(afterTop),
  'switching full PPR -> standard changes the projections')
console.log(`         full PPR top: ${beforeTop.slice(0, 3).join(', ')}`)
console.log(`         standard top: ${afterTop.slice(0, 3).join(', ')}`)
await page.screenshot({ path: join(SHOTS, 'desktop-league.png'), fullPage: true })

// --- propose: the trade finder ---
await page.locator('nav.tabs button[data-view="propose"]').click()
await page.waitForTimeout(900)
const oppCount = await page.locator('#fOpponent option').count()
const rivals = await page.evaluate(() => (window.TD_LEAGUE?.rosters?.length ?? 1) - 1)
note(oppCount >= rivals, 'propose tab offers every other team in the league',
  `${oppCount} option(s) for ${rivals} rivals`)
await page.locator('#fRun').click()
await page.waitForTimeout(14000)
const proposals = await page.locator('#fResults .proposal').count()
const resultText = await page.locator('#fResults').textContent()
note(proposals > 0 || /screened/.test(resultText || ''), 'the finder returns results',
  `${proposals} proposal card(s)`)
note(!/NaN|undefined/.test(resultText || ''), 'no NaN in the proposals',
  (resultText || '').match(/NaN|undefined/g)?.slice(0, 2).join(',') || '')
if (proposals > 0) {
  const accept = await page.locator('#fResults .proposal .meter i').first().getAttribute('style')
  note(/width:\s*\d+%/.test(accept || ''), 'acceptance meter renders', accept || '')
}
await page.screenshot({ path: join(SHOTS, 'desktop-propose.png'), fullPage: true })

// --- the opponent selection must survive side A changing --------------------------
// Which teams are listed depends on who is loaded into side A, so the list reorders when
// you switch your own roster. An index carried across that rebuild points at a different
// manager; results priced against one opponent must never be shown under another's name.
const oppBefore = await page.locator('#fOpponent').inputValue()
await page.locator('nav.tabs button[data-view="trade"]').click()
await page.waitForTimeout(600)
// Deliberately a team that is neither yours nor the selected opponent: the list reorders
// around it, so the selection has to be preserved by name and cannot merely survive by
// landing on the same index.
const otherTeam = await page.evaluate((opp) => {
  const mine = window.TD_LEAGUE.myTeam
  return [...document.getElementById('pickA').options]
    .map((o) => o.value)
    .find((v) => v && v !== mine && !opp.startsWith(v)) || ''
}, oppBefore)
await page.selectOption('#pickA', otherTeam)
await page.waitForTimeout(1500)
await page.locator('nav.tabs button[data-view="propose"]').click()
await page.waitForTimeout(900)
const oppAfter = await page.locator('#fOpponent').inputValue()
const stillMine = await page.evaluate(() => document.getElementById('pickA').value)
note(stillMine === otherTeam && oppAfter === oppBefore,
  'the opponent survives side A changing, by name rather than by position',
  `side A ${stillMine}, opponent ${oppBefore} -> ${oppAfter}`)
note(!oppAfter.startsWith(stillMine), 'and is never repointed at your own roster', oppAfter)
const staleResults = await page.locator('#fResults .proposal').count()
note(staleResults === 0, 'and proposals priced against the old pairing are cleared',
  `${staleResults} stale card(s)`)

// Put side A back on the user's own roster for the checks that follow.
await page.locator('nav.tabs button[data-view="trade"]').click()
await page.waitForTimeout(500)
await page.selectOption('#pickA', await page.evaluate(() => window.TD_LEAGUE.myTeam))
await page.waitForTimeout(1200)

// --- ESPN import ---
await page.locator('nav.tabs button[data-view="league"]').click()
await page.waitForTimeout(700)
await page.fill('#espnId', '1234567')
await page.locator('#espnMakeUrl').click()
await page.waitForTimeout(300)
const urlText = await page.locator('#espnUrl').textContent()
note(/leagues\/1234567\?/.test(urlText || '') && /view=mRoster/.test(urlText || ''),
  'ESPN link builder produces the right URL')

// Paste a realistic payload built from the page's own pack, so names really match.
const espnOk = await page.evaluate(() => {
  const pack = window.TD_PACK
  const P = (pos, n, o = 0) => pack.players.filter((p) => p.pos === pos && (p.mu || p.kWeeks || p.dstWeeks)).slice(o, o + n)
  const posId = { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, DST: 16 }
  const ent = (p, slot) => ({ lineupSlotId: slot, playerPoolEntry: { player: {
    id: 1, fullName: p.name, defaultPositionId: posId[p.pos], proTeamId: 12, injuryStatus: 'ACTIVE' } } })
  const team = (o) => [...P('QB', 1, o).map((p) => ent(p, 0)), ...P('RB', 3, o * 3).map((p) => ent(p, 2)),
    ...P('WR', 3, o * 3).map((p) => ent(p, 4)), ...P('TE', 1, o).map((p) => ent(p, 6)),
    ...P('K', 1, o).map((p) => ent(p, 17)), ...P('DST', 1, o).map((p) => ent(p, 16))]
  const payload = {
    id: 999, settings: {
      name: 'Verification League', size: 10,
      rosterSettings: { lineupSlotCounts: { 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 16: 1, 17: 1, 20: 6 } },
      scheduleSettings: { matchupPeriodCount: 14, playoffTeamCount: 6 },
      scoringSettings: { scoringItems: [
        { statId: 3, points: 0.04 }, { statId: 4, points: 4 }, { statId: 20, points: -2 },
        { statId: 24, points: 0.1 }, { statId: 25, points: 6 }, { statId: 42, points: 0.1 },
        { statId: 43, points: 6 }, { statId: 53, points: 0.5 }, { statId: 72, points: -2 }] },
    },
    teams: [
      { id: 1, location: 'Alpha', nickname: 'Ones', roster: { entries: team(0) } },
      { id: 2, location: 'Beta', nickname: 'Twos', roster: { entries: team(1) } },
    ],
  }
  const ta = document.getElementById('espnPaste')
  ta.value = JSON.stringify(payload)
  return true
})
note(espnOk, 'built an ESPN payload from the page\'s own data')
await page.locator('#espnImport').click()
await page.waitForTimeout(1500)
const importText = await page.locator('#espnResult').textContent()
note(/Imported/.test(importText || ''), 'ESPN payload imports', (importText || '').slice(0, 90))
note(/Verification League/.test(importText || ''), 'league name read from the payload')
const teamPicker = await page.locator('#espnMine option').count()
note(teamPicker >= 2, 'team picker populated', `${teamPicker} teams`)
await page.screenshot({ path: join(SHOTS, 'desktop-espn.png'), fullPage: true })

// Applying the import must change the scoring to that league's (half PPR here).
await page.selectOption('#espnMine', '0')
await page.selectOption('#espnTheirs', '1')
await page.locator('#espnApply').click()
await page.waitForTimeout(3000)
const recVal = await page.evaluate(() => {
  const tab = [...document.querySelectorAll('nav.tabs button')].find((b) => b.dataset.view === 'league')
  tab.click()
  return null
})
await page.waitForTimeout(900)
const perRec = await page.evaluate(() => {
  const labels = [...document.querySelectorAll('#rushGrid label.fld')]
  const hit = labels.find((l) => /per reception/i.test(l.querySelector('span').textContent))
  return hit ? hit.querySelector('input').value : null
})
note(perRec === '0.5', 'imported scoring replaced the defaults', `per reception = ${perRec}`)

// --- status override changes the numbers ---
await page.locator('nav.tabs button[data-view="trade"]').click()
await page.waitForTimeout(2000)
const before = await page.locator('#rowsA .row .ppg').first().textContent()
const hasPicker = await page.locator('#rowsA .statuspick').count()
note(hasPicker > 0, 'every roster row carries a status control', `${hasPicker} controls`)
if (hasPicker > 0) {
  await page.locator('#rowsA .row .pill').first().click()
  await page.locator('#rowsB .row .pill').first().click()
  await page.waitForTimeout(2500)
  const deltaBefore = await page.locator('#verdict .big').textContent()
  // Mark the player who is actually IN the trade. Marking a bench player out correctly
  // leaves the DELTA alone -- it lowers the before and the after by the same amount --
  // so the first version of this check was asserting the wrong thing.
  const movedRow = await page.locator('#rowsA .row.on').first()
  await movedRow.locator('.statuspick').selectOption('OUT')
  await page.waitForTimeout(3000)
  const deltaAfter = await page.locator('#verdict .big').textContent()
  note(deltaBefore !== deltaAfter, 'marking a traded player out changes the verdict',
    `${deltaBefore} -> ${deltaAfter}`)
  const overrideNote = await page.locator('#verdict').textContent()
  note(/flows? through the numbers above/.test(overrideNote || ''),
    'the override is disclosed in the verdict')
  // Statuses have two sources and the verdict must not claim ESPN's designations as the
  // user's own. With a seeded league and one hand-set player, both counts should appear.
  note(/set by you/.test(overrideNote || '') && /from ESPN/.test(overrideNote || ''),
    'and says which came from ESPN and which you set yourself',
    (overrideNote || '').match(/\d+ from ESPN|\d+ set by you/g)?.join(', ') || '')
}
const staleShown = await page.locator('#verdict .stale').count()
note(staleShown > 0, 'data age warning is shown with the verdict')

// --- a saved session that belongs to a different league --------------------------
// The rosters ship with the app, so a session saved before the league was last
// re-transcribed is a snapshot of a league that no longer exists. It must not be
// restored on top of today's pack -- but the things that are about players rather than
// about the league (scoring, injury overrides) should survive.
await page.evaluate(() => localStorage.setItem('tradedesk:v2', JSON.stringify({
  stamp: 'some other league|2025|w9|12',
  nameA: 'Ground Game', nameB: 'Air Raid',
  A: window.TD_LEAGUE.rosters[2].players.slice(0, 3).map((p) => p.id),
  B: window.TD_LEAGUE.rosters[3].players.slice(0, 3).map((p) => p.id),
  league: { teams: 12, playoffWeeks: [14, 15, 16] },
  status: { [window.TD_LEAGUE.rosters[0].players[0].id]: 'OUT' },
})))
await page.reload({ waitUntil: 'load' })
await page.waitForTimeout(2500)
const recovered = await page.evaluate(() => {
  const saved = JSON.parse(localStorage.getItem('tradedesk:v2'))
  return {
    pickA: document.getElementById('pickA').value,
    pickB: document.getElementById('pickB').value,
    teams: saved.league.teams,
    keptStatus: saved.status[window.TD_LEAGUE.rosters[0].players[0].id],
    mine: window.TD_LEAGUE.myTeam,
  }
})
note(recovered.pickA === recovered.mine && !!recovered.pickB && recovered.pickB !== recovered.pickA,
  'a session from a different league is replaced by the shipped rosters',
  `${recovered.pickA} vs ${recovered.pickB}`)
note(recovered.teams === 8, 'and its stale league size is discarded too', `teams ${recovered.teams}`)
note(recovered.keptStatus === 'OUT', 'while injury overrides survive, being about players')

// --- league injury designations apply to every roster, not just the loaded ones ----
// The Propose tab prices a rival straight out of the league file, so a designation that
// only landed once you had opened that team would make the same search return different
// numbers depending on where you had clicked.
const seeded = await page.evaluate(() => {
  const flagged = window.TD_LEAGUE.rosters.flatMap((t) => t.players).filter((p) => p.status)
  const store = JSON.parse(localStorage.getItem('tradedesk:v2') || '{}')
  const status = store.status || {}
  return {
    total: flagged.length,
    applied: flagged.filter((p) => status[p.id] === p.status).length,
  }
})
note(seeded.total > 0 && seeded.applied === seeded.total,
  'every league injury designation is applied, not just the loaded teams',
  `${seeded.applied}/${seeded.total}`)

// Put the page back on a trade so the screenshots below are of a populated view.
await page.locator('nav.tabs button[data-view="trade"]').click()
await page.waitForTimeout(800)

// --- method tab ---------------------------------------------------------------
await page.locator('nav.tabs button[data-view="method"]').click()
await page.waitForTimeout(600)
const sources = await page.locator('#sourceBox tbody tr').count()
note(sources > 15, 'data provenance listed', `${sources} sources`)
await page.screenshot({ path: join(SHOTS, 'desktop-method.png'), fullPage: true })

// --- phone --------------------------------------------------------------------
const phone = await ctx.newPage()
phone.on('pageerror', (e) => pageErrors.push('phone: ' + String(e)))
await phone.setViewportSize({ width: 390, height: 844 })
await phone.goto(`file://${FILE}`, { waitUntil: 'load' })
await phone.waitForTimeout(2500)
const overflow = await phone.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth)
note(overflow <= 2, 'no horizontal overflow on a phone', `${overflow}px`)
await phone.screenshot({ path: join(SHOTS, 'phone-trade.png'), fullPage: true })
await phone.locator('nav.tabs button[data-view="draft"]').click()
await phone.waitForTimeout(1500)
await phone.screenshot({ path: join(SHOTS, 'phone-draft.png'), fullPage: true })

await browser.close()

console.log(`\nscreenshots -> ${SHOTS}`)
if (consoleErrors.length) {
  console.log('\nconsole errors:')
  for (const e of consoleErrors.slice(0, 10)) console.log('  ' + e)
}
if (pageErrors.length) {
  console.log('\nuncaught exceptions:')
  for (const e of pageErrors.slice(0, 10)) console.log('  ' + e)
}
console.log(problems.length ? `\n${problems.length} CHECK(S) FAILED` : '\nall browser checks passed')
process.exit(problems.length ? 1 : 0)
