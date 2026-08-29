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
import { createReadStream, mkdirSync, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP = join(ROOT, 'app')
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

// This machine keeps its browsers somewhere Playwright does not look. A CI runner that
// ran `playwright install` does not, so only override the path when it is really there.
const PINNED_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const browser = await chromium.launch(
  existsSync(PINNED_CHROME) ? { executablePath: PINNED_CHROME } : {},
)
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
  demo: !!window.TD_DEMO,
}))
note(packInfo.players > 900, 'data pack present', `${packInfo.players} players, ${packInfo.season}`)
note(packInfo.demo, 'demo league present')

// --- the trade view rendered a real verdict -----------------------------------
const rowsA = await page.locator('#rowsA .row').count()
const rowsB = await page.locator('#rowsB .row').count()
note(rowsA > 5 && rowsB > 5, 'both rosters populated from the demo', `${rowsA} / ${rowsB}`)

const names = await page.locator('#rowsA .nm').allTextContents()
note(names.some((n) => n.trim().length > 3), 'roster shows real player names', names[0] || '')

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
note(oppCount > 0, 'propose tab offers an opponent', `${oppCount} option(s)`)
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
    // Four teams, not two. Two is enough to test an import and useless for testing the
    // thing that matters here: watching a deal you are not in needs somebody to be the
    // reader while two other teams trade.
    teams: [
      { id: 1, location: 'Alpha', nickname: 'Ones', roster: { entries: team(0) } },
      { id: 2, location: 'Beta', nickname: 'Twos', roster: { entries: team(1) } },
      { id: 3, location: 'Gamma', nickname: 'Threes', roster: { entries: team(2) } },
      { id: 4, location: 'Delta', nickname: 'Fours', roster: { entries: team(3) } },
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
note(teamPicker >= 4, 'team picker populated', `${teamPicker} teams`)
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
  note(/manual status/.test(overrideNote || ''), 'the override is disclosed in the verdict')
}
const staleShown = await page.locator('#verdict .stale').count()
note(staleShown > 0, 'data age warning is shown with the verdict')

/* --------------------------------------------- watching a deal you are not in */

// Put two rivals in the panels, declare yourself a third team, and check the board reports
// what their deal did to a roster that did not change. This is the path that has no
// equivalent anywhere else in the app, so nothing else covers it.
note(await page.locator('#scoutBar').isVisible(), 'the team loader appears once a league is imported')

await page.selectOption('#pickMe', '3')   // I am Delta Fours
await page.selectOption('#pickA', '0')    // Alpha and Beta trade
await page.selectOption('#pickB', '1')
await page.locator('#pickLoad').click()
await page.waitForTimeout(2500)

const whoText = await page.locator('#scoutWho').textContent()
note(/watching from outside/.test(whoText || ''), 'the app knows you are not in this deal',
  (whoText || '').trim())

// Move a real player so there is a deal to score.
await page.locator('#rowsA .row .pill').nth(1).click()
await page.locator('#rowsB .row .pill').nth(1).click()
await page.waitForTimeout(4000)

note(await page.locator('#impactPanel').isVisible(), 'league impact panel renders')
const boardRows = await page.locator('#impactBody .board tbody tr').count()
note(boardRows === 4, 'every team is on the board', `${boardRows} rows`)
note(await page.locator('#impactBody .board tr.me').count() === 1, 'your own row is marked')
note(await page.locator('#impactBody .board tr.inplay').count() === 2,
  'both teams in the deal are marked')

// The invariant, checked through the DOM rather than the module: the reader's roster did
// not change, so the reader's before and after numbers must be identical on screen.
const myCells = await page.locator('#impactBody .board tr.me td').allTextContents()
note(myCells.length >= 5 && myCells[2].trim() === myCells[3].trim(),
  'a deal you are not in does not move your own points', `${myCells[2]} -> ${myCells[3]}`)
note(/^(—|0\.0)$/.test((myCells[4] || '').trim()),
  'and your change column reads as no change', (myCells[4] || '').trim())

const impactHead = await page.locator('#impactBody .headline .big').textContent()
note(/[-+]?\d/.test(impactHead || ''), 'the impact headline shows a number', impactHead)
const impactWord = await page.locator('#impactBody .verdictword').textContent()
note(/field/.test(impactWord || ''), 'and states the direction in words', impactWord)

note(await page.locator('#openingsPanel').isVisible(), 'openings panel renders')
const bars = await page.locator('#openingsBody .posbar').count()
note(bars === 6, 'your positional shape is broken out', `${bars} positions`)
await page.screenshot({ path: join(SHOTS, 'desktop-scout.png'), fullPage: true })

// Put the reader back inside the deal and the framing has to change.
await page.selectOption('#pickMe', '0')
await page.waitForTimeout(3000)
const inDeal = await page.locator('#scoutWho').textContent()
note(/you are in this deal/.test(inDeal || ''), 'and it knows when you are in the deal',
  (inDeal || '').trim())

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

/* -------------------------------------------------------------- served over http */

// Everything above tested the flattened single file opened from disk. GitHub Pages serves
// something else entirely: app/ as it is written, with real ES module imports, over http.
// The two share no loading code, so passing one says nothing about the other -- an import
// path that only the bundler resolves would sail through every check above.
//
// The mount mirrors what the pages workflow assembles: app/ at the root, with the
// single-file build alongside it as /tradedesk.html.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

const server = createServer((req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '')
  const file = rel === '/' || rel === '/index.html' ? join(APP, 'index.html')
    : rel === '/tradedesk.html' ? FILE
      : join(APP, rel)
  if (!file.startsWith(APP) && file !== FILE) { res.writeHead(403).end(); return }
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end('not found'); return }
  const ext = file.slice(file.lastIndexOf('.'))
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': statSync(file).size,
  })
  createReadStream(file).pipe(res)
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const origin = `http://127.0.0.1:${server.address().port}`

console.log(`\nloading app/ over ${origin} -- the shape GitHub Pages serves\n`)

const hostedErrors = []
const hosted = await ctx.newPage()
hosted.on('pageerror', (e) => hostedErrors.push(String(e)))
hosted.on('console', (m) => { if (m.type() === 'error') hostedErrors.push('console: ' + m.text()) })
await hosted.goto(origin, { waitUntil: 'load' })
await hosted.waitForTimeout(2500)

note(hostedErrors.length === 0, 'the unbundled module graph loads over http',
  hostedErrors.slice(0, 2).join(' | '))

const hostedRows = await hosted.locator('#rowsA .row').count()
note(hostedRows > 5, 'hosted build renders the demo', `${hostedRows} rows`)

// The staleness advice differs by how the page was opened, and getting it backwards would
// tell a hosted user to go run a Python script they do not have.
await hosted.locator('#rowsA .row .pill').first().click()
await hosted.waitForTimeout(2000)
const hostedStale = (await hosted.locator('#verdict .stale').first().textContent()) || ''
note(/refetches and refits every morning/.test(hostedStale),
  'hosted copy says it rebuilds itself')
note(!/refresh\.py/.test(hostedStale),
  'hosted copy does not tell the reader to run a local script')

const offlineHref = await hosted.locator('#offline').getAttribute('href')
note(await hosted.locator('#offline').isVisible(), 'offline download offered when hosted')
const dl = await hosted.request.get(new URL(offlineHref, origin).href)
note(dl.ok() && Number(dl.headers()['content-length'] || 0) > 1e6,
  'the offline download resolves', `${offlineHref} -> ${dl.status()}`)

// And the inverse: the file:// copy must not claim it updates itself.
const fileStale = (await page.locator('#verdict .stale').first().textContent()) || ''
note(/refresh\.py/.test(fileStale) && !/every morning/.test(fileStale),
  'downloaded copy still says how to rebuild it')

// The single file gets served over https at least as often as it gets opened from disk --
// published as an artifact, or sitting at /tradedesk.html next to the deployed page. It is
// a frozen copy in every one of those cases, and protocol alone would say otherwise.
const served = await ctx.newPage()
await served.goto(`${origin}/tradedesk.html`, { waitUntil: 'load' })
await served.waitForTimeout(2500)
await served.locator('#rowsA .row .pill').first().click()
await served.waitForTimeout(2000)
const servedStale = (await served.locator('#verdict .stale').first().textContent()) || ''
note(/refresh\.py/.test(servedStale) && !/every morning/.test(servedStale),
  'the single-file build does not claim a nightly rebuild when served over http')
note(await served.locator('#offline').isHidden(),
  'the single-file build does not offer itself as a download')
await served.close()

await hosted.screenshot({ path: join(SHOTS, 'hosted-trade.png'), fullPage: true })
server.close()

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
