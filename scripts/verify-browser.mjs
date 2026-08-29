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
