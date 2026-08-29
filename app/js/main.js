/**
 * Trade Desk -- application shell.
 *
 * Everything here is rendering and wiring. All the math lives in the engine modules, and
 * this file is careful not to reimplement any of it: if a number appears on screen, some
 * tested module produced it.
 */

import {
  scoreLine, explainLine, expectedDstScore, PRESETS, DEFAULT_SCORING, cloneScoring,
} from './scoring.js'
import { optimizeLineup, slotsFromCounts } from './lineup.js'
import { replacementDetail } from './replacement.js'
import { evaluateTrade, suggestFair, playerPPG, DEFAULT_LEAGUE } from './trade.js'
import { draftBoard, detectRun, positionScarcity } from './draft.js'
import { findTrades, marketValues } from './finder.js'
import { parseEspnLeague, espnUrl } from './espn.js'

const PACK = window.TD_PACK
/**
 * The real league, compiled by `pipeline/build_league.py` from `pipeline/league.json`.
 * Every roster in it resolved against this pack, so an id here always exists.
 */
const LEAGUE = window.TD_LEAGUE || null
const leagueTeam = (name) => LEAGUE?.rosters.find((t) => t.name === name) || null
/** Who a team plays in the week the league was transcribed. */
function leagueOpponent(name) {
  for (const [a, b] of LEAGUE?.matchups || []) {
    if (a === name) return b
    if (b === name) return a
  }
  return null
}
const $ = (id) => document.getElementById(id)
const el = (tag, cls, html) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (html !== undefined) n.innerHTML = html
  return n
}
const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '—')
const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—')
const sign = (n) => (n > 0 ? '+' : '')
const cls = (n, eps = 0.05) => (n > eps ? 'up' : n < -eps ? 'down' : 'flat')

const byId = new Map(PACK.players.map((p) => [p.id, p]))

/* ------------------------------------------------------------------ state */

const STORE = 'tradedesk:v2'

const state = {
  view: 'trade',
  nameA: 'My team',
  nameB: 'Their team',
  A: [],            // player ids
  B: [],
  move: {},         // id -> true when included in the trade
  cfg: cloneScoring(DEFAULT_SCORING),
  league: {
    teams: LEAGUE?.teams ?? DEFAULT_LEAGUE.teams,
    slots: { ...DEFAULT_LEAGUE.slots, ...(LEAGUE?.slots || {}) },
    playoffWeeks: [...(LEAGUE?.playoffWeeks || DEFAULT_LEAGUE.playoffWeeks)],
    playoffWeight: DEFAULT_LEAGUE.playoffWeight,
  },
  draft: { taken: [], mine: [], pick: 1, next: snakeGap(), pos: '' },
  // Manual availability overrides. This is the answer to breaking news the pack cannot
  // know about: mark a player and every projection re-runs, with no network involved.
  status: {},
  espn: null,          // the imported league: teams, rosters, settings
  // `opponent` is the selected option's LABEL, never its index: which teams are listed
  // depends on side A, so a position in that list is not a stable identifier.
  finder: { untouchable: [], targets: [], maxGive: 2, maxGet: 2, opponent: '', result: null },
  players: { q: '', pos: '', window: 'season', limit: 50, sort: 'pts', dir: -1, open: null },
}

/**
 * Which league the saved session belongs to.
 *
 * A saved session holds rosters and a league size. When the shipped league is re-transcribed
 * -- a new week, a trade, a different league entirely -- the saved copy is a snapshot of a
 * league that no longer exists, and silently restoring it would put yesterday's rosters in
 * front of you with today's data pack. So the stamp goes in with the session, and a session
 * stamped for a different league gives its rosters back.
 */
/**
 * Picks between your turns in a snake draft: everyone else picks twice. Hardcoding this
 * at 22 was the twelve-team answer, and in an eight-team league it overstates the wait by
 * eight picks -- which is exactly the input VONA is most sensitive to.
 */
function snakeGap() {
  return Math.max(1, ((LEAGUE?.teams ?? DEFAULT_LEAGUE.teams) - 1) * 2)
}

const leagueStamp = () => (LEAGUE
  ? `${LEAGUE.name}|${LEAGUE.season}|w${LEAGUE.asOfWeek}|${LEAGUE.teams}`
  : 'none')

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      stamp: leagueStamp(),
      nameA: state.nameA, nameB: state.nameB, A: state.A, B: state.B,
      cfg: state.cfg, league: state.league, draft: state.draft,
      status: state.status, espn: state.espn,
      finder: { opponent: state.finder.opponent },
    }))
  } catch (e) { /* private mode, quota, blocked storage: the session still works */ }
}
/** @returns true when the saved session belongs to the league that is loaded now. */
function load() {
  try {
    const raw = localStorage.getItem(STORE)
    if (!raw) return false
    const s = JSON.parse(raw)

    // Scoring, injury statuses and the draft board are about players, not about which
    // league is loaded, so they survive a re-transcription. Everything else does not.
    if (s.cfg) state.cfg = s.cfg
    if (s.draft) state.draft = { ...state.draft, ...s.draft }
    if (s.status) state.status = s.status

    // Stale session: init() reloads the shipped league and re-seeds its designations.
    if (s.stamp !== leagueStamp()) return false

    Object.assign(state, {
      nameA: s.nameA ?? state.nameA,
      nameB: s.nameB ?? state.nameB,
      A: Array.isArray(s.A) ? s.A.filter((id) => byId.has(id)) : [],
      B: Array.isArray(s.B) ? s.B.filter((id) => byId.has(id)) : [],
    })
    if (s.league) state.league = { ...state.league, ...s.league }
    if (s.espn) state.espn = s.espn
    if (s.finder?.opponent) state.finder.opponent = s.finder.opponent
    return true
  } catch (e) { /* corrupt or unavailable storage: fall back to defaults */ }
  return false
}

/**
 * How a manual status changes a player's availability.
 *
 * Availability is what shapes a floor and what the reconciliation weights, so an override
 * flows through every number in the app rather than being a cosmetic label. `OUT` is not
 * set to zero: a player ruled out for a week is still on the roster for the rest of the
 * season, and zeroing him would delete his whole remaining value.
 */
const STATUS_AVAIL = { H: null, Q: 0.62, OUT: 0.18, IR: 0.04 }
const STATUS_LABEL = { H: 'Healthy', Q: 'Questionable', OUT: 'Out', IR: 'IR / season' }

/** A player with any manual status applied. Never mutates the pack. */
function withStatus(p) {
  if (!p) return p
  const s = state.status[p.id]
  if (!s || s === 'H') return p
  const mult = STATUS_AVAIL[s]
  if (mult == null) return p
  return { ...p, avail: mult, _status: s }
}

const roster = (side) => state[side].map((id) => withStatus(byId.get(id))).filter(Boolean)
const ppg = (p, week = null) => playerPPG(p, state.cfg, week)

/* ------------------------------------------------------------------ header */

function dataAgeDays() {
  const t = Date.parse(PACK.meta.generated)
  if (!Number.isFinite(t)) return null
  return Math.floor((Date.now() - t) / 86400000)
}

function renderStamp() {
  const m = PACK.meta
  const cov = m.marketCoverage || {}
  const age = dataAgeDays()
  const ageText = age == null ? '' : age <= 0 ? 'built today'
    : age === 1 ? 'built yesterday' : `built ${age} days ago`
  const stale = age != null && age > 7
  $('stamp').innerHTML =
    `<b>${esc(m.season)} projections</b> · <span class="${stale ? 'down' : ''}">${esc(ageText)}</span><br>`
    + `${PACK.players.length} players · ${Math.round((cov.market_share || 0) * 100)}% of games have a posted line`
}

/** A standing warning about what the pack cannot know. */
function staleBanner() {
  const age = dataAgeDays()
  if (age == null) return ''
  const hard = age > 7
  return `<div class="stale">
    <b>This data is ${age === 0 ? 'from today' : `${age} day${age === 1 ? '' : 's'} old`} and does not update itself.</b>
    Injury news, depth-chart changes and in-season trades after that date are not in here.
    ${hard ? 'At this age, treat the projections as a starting point rather than current. ' : ''}
    Rebuild it with <code>python3 pipeline/refresh.py</code>, or mark a player's status on
    his row to flow a change through every number immediately.
  </div>`
}

/* ------------------------------------------------------------------ rosters */

/**
 * Which league roster, if any, a side currently holds.
 *
 * Derived from the ids rather than remembered, so the picker cannot drift out of step with
 * the roster: add or drop anybody and it falls back to "custom" on the next render by
 * itself.
 */
function matchedLeagueTeam(side) {
  if (!LEAGUE) return ''
  const ids = state[side]
  for (const t of LEAGUE.rosters) {
    if (t.players.length !== ids.length) continue
    const have = new Set(ids)
    if (t.players.every((p) => have.has(p.id))) return t.name
  }
  return ''
}

function renderTeamPick(side) {
  const sel = $(`pick${side}`)
  if (!sel) return
  if (!LEAGUE) { sel.hidden = true; return }
  const current = matchedLeagueTeam(side)
  sel.innerHTML = ''
  const custom = el('option')
  custom.value = ''
  custom.textContent = (current || !state[side].length) ? 'Custom roster' : 'Custom roster (edited)'
  sel.appendChild(custom)
  for (const t of LEAGUE.rosters) {
    const o = el('option')
    o.value = t.name
    o.textContent = t.name === LEAGUE.myTeam ? `${t.name} — you` : `${t.name} — ${t.owner}`
    sel.appendChild(o)
  }
  sel.value = current
}

function renderRoster(side) {
  const box = $(`rows${side}`)
  const list = roster(side)
  box.innerHTML = ''
  if (!list.length) {
    box.appendChild(el('p', 'empty',
      'No players yet. Pick a league team above, or search for players by name.'))
    return
  }
  const order = ['QB', 'RB', 'WR', 'TE', 'K', 'DST']
  const repl = currentReplacement()
  list.slice().sort((a, b) => order.indexOf(a.pos) - order.indexOf(b.pos) || ppg(b) - ppg(a))
    .forEach((p) => {
      const v = ppg(p) - (repl[p.pos] || 0)
      const row = el('div', `row${state.move[p.id] ? ' on' : ''}`)
      row.innerHTML =
        `<button class="pill" aria-label="Move ${esc(p.name)} in this trade">${side === 'A' ? '→' : '←'}</button>`
        + `<div><div class="nm">${esc(p.name)}</div>`
        + `<div class="sub"><span class="pos" data-p="${p.pos}">${p.pos}</span>`
        + `<span>${esc(p.team)}</span>${p.bye ? `<span>bye ${p.bye}</span>` : ''}</div></div>`
        + `<div class="ppg">${f1(ppg(p))}</div>`
        + `<div class="vor ${cls(v)}">${sign(v)}${f1(v)}<span class="dim"> vor</span></div>`
        + '<button class="del" aria-label="Remove">×</button>'
      const sub = row.querySelector('.sub')
      const pick = el('select', 'statuspick')
      pick.setAttribute('aria-label', `Injury status for ${p.name}`)
      pick.setAttribute('data-s', state.status[p.id] || 'H')
      for (const [k, label] of Object.entries(STATUS_LABEL)) {
        const o = el('option'); o.value = k; o.textContent = label
        if ((state.status[p.id] || 'H') === k) o.selected = true
        pick.appendChild(o)
      }
      pick.onchange = () => {
        if (pick.value === 'H') delete state.status[p.id]
        else state.status[p.id] = pick.value
        renderTrade()
      }
      sub.appendChild(pick)
      row.querySelector('.pill').onclick = () => {
        state.move[p.id] = !state.move[p.id]
        renderTrade()
      }
      row.querySelector('.del').onclick = () => {
        state[side] = state[side].filter((x) => x !== p.id)
        delete state.move[p.id]
        renderTrade()
      }
      box.appendChild(row)
    })
}

/**
 * Every player the league actually holds.
 *
 * With all eight rosters known, replacement level stops being an estimate: it is literally
 * the best player nobody owns. replacement.js prefers that method and falls back to the
 * rank baseline on its own if coverage is too thin, so handing it the set is safe even
 * after the rosters have been edited about.
 */
function rosteredIds() {
  const out = new Set()
  const source = state.espn?.teams?.length ? state.espn.teams : (LEAGUE?.rosters || [])
  for (const t of source) for (const p of t.players) out.add(p.id)
  // Whatever is loaded by hand is owned too, even if it is not in the shipped league.
  for (const id of state.A) out.add(id)
  for (const id of state.B) out.add(id)
  return out.size ? out : null
}

/**
 * The league as the engines should see it: the settings, plus who owns whom.
 *
 * Kept separate from `state.league` because that is what gets persisted, and a Set does
 * not survive a round trip through JSON.
 */
function engineLeague() {
  const rostered = rosteredIds()
  return rostered ? { ...state.league, rostered } : state.league
}

let replCache = null
let replKey = ''
function currentReplacement() {
  const L = engineLeague()
  const key = JSON.stringify([state.cfg, state.league.slots, state.league.teams,
    L.rostered ? [...L.rostered].sort() : null])
  if (key !== replKey) {
    replKey = key
    const d = replacementDetail(PACK.players, L, (p) => ppg(p))
    replCache = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.pts]))
    replCache._detail = d
  }
  return replCache
}

/* ------------------------------------------------------------------ search */

function wireSearch(side) {
  const input = $(`search${side}`)
  const box = $(`res${side}`)
  let idx = -1

  const close = () => { box.hidden = true; box.innerHTML = ''; idx = -1 }

  const run = () => {
    const q = input.value.trim().toLowerCase()
    if (q.length < 2) return close()
    const onRoster = new Set([...state.A, ...state.B])
    const hits = PACK.players
      .filter((p) => !onRoster.has(p.id)
        && (p.name.toLowerCase().includes(q) || p.team.toLowerCase() === q))
      .sort((a, b) => ppg(b) - ppg(a))
      .slice(0, 12)
    if (!hits.length) {
      box.hidden = false
      box.innerHTML = `<div class="empty">No player matches "${esc(q)}". `
        + 'This tool only knows players in its data pack, and will not invent one.</div>'
      return
    }
    box.hidden = false
    box.innerHTML = ''
    hits.forEach((p, i) => {
      const b = el('button', i === idx ? 'active' : '')
      b.innerHTML = `<span>${esc(p.name)}</span>`
        + `<span class="pos" data-p="${p.pos}">${p.pos}</span>`
        + `<span class="num dim">${f1(ppg(p))}</span>`
      b.onclick = () => {
        state[side].push(p.id)
        input.value = ''
        close()
        renderTrade()
      }
      box.appendChild(b)
    })
  }

  input.addEventListener('input', run)
  input.addEventListener('keydown', (e) => {
    const btns = [...box.querySelectorAll('button')]
    if (e.key === 'Escape') return close()
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      idx = Math.max(0, Math.min(btns.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))
      btns.forEach((b, i) => b.classList.toggle('active', i === idx))
      btns[idx]?.scrollIntoView({ block: 'nearest' })
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      ;(btns[idx] || btns[0])?.click()
    }
  })
  input.addEventListener('blur', () => setTimeout(close, 160))
}

/* ------------------------------------------------------------------ verdict */

function renderTrade() {
  renderRoster('A')
  renderRoster('B')
  renderTeamPick('A')
  renderTeamPick('B')
  $('capA').textContent = `${state.A.length} players`
  $('capB').textContent = `${state.B.length} players`

  const box = $('verdict')
  const A = roster('A')
  const B = roster('B')
  const sendA = A.filter((p) => state.move[p.id])
  const sendB = B.filter((p) => state.move[p.id])

  if (!A.length && !B.length) {
    box.innerHTML = staleBanner()
      + '<p class="empty">Add players to both rosters, then tap the arrows to build a trade.</p>'
    save()
    return
  }
  if (!sendA.length && !sendB.length) {
    box.innerHTML = '<p class="empty">Nobody is moving yet. Tap the arrow next to each player in the deal.</p>'
    save()
    return
  }

  const v = evaluateTrade({
    rosterA: A, rosterB: B, sendA, sendB, pack: PACK, cfg: state.cfg,
    league: engineLeague(), nameA: state.nameA, nameB: state.nameB,
    opts: { sim: true, draws: 600 },
  })

  const n = v.weeks.length || 1
  const h = v.headline
  const perWeek = h.perWeekA

  let html = staleBanner() + `<div class="headline">
    <div>
      <span class="verdictword ${cls(perWeek)}">${esc(h.forA)} for you</span>
      <span class="big ${cls(perWeek)}">${sign(perWeek)}${f1(perWeek)}</span>
      <span class="unit">pts / week, starters</span>
    </div>
    <div class="read">${esc(h.reason)}</div>
  </div><div class="ledger">`

  for (const s of [v.A, v.B]) {
    const d = s.starters.delta
    const sim = v.sim ? (s === v.A ? v.sim.A : v.sim.B) : null
    html += `<div class="side">
      <div class="sidehead"><h3>${esc(s.label)}</h3>
        <span class="delta ${cls(d)}">${sign(d)}${f1(d)}<span class="dim" style="font-size:10px"> season</span></span>
      </div>`

    if (s.gave.length || s.got.length) {
      html += '<div class="sub" style="margin-bottom:8px">'
        + (s.got.length ? `<span class="up">in: ${s.got.map((p) => esc(p.name)).join(', ')}</span>` : '')
        + (s.gave.length ? `<span class="down" style="display:block">out: ${s.gave.map((p) => esc(p.name)).join(', ')}</span>` : '')
        + '</div>'
    }

    html += `<div class="stats">
      <div class="stat"><div class="k">Starters / week</div>
        <div class="v">${f1(s.starters.before / n)} → ${f1(s.starters.after / n)}</div>
        <div class="n ${cls(d)}">${sign(d / n)}${f1(d / n)}</div></div>
      <div class="stat"><div class="k">Playoff wks ${state.league.playoffWeeks.join('/')}</div>
        <div class="v ${cls(s.playoffDelta)}">${sign(s.playoffDelta)}${f1(s.playoffDelta)}</div>
        <div class="n">weighted ×${state.league.playoffWeight}</div></div>
      <div class="stat"><div class="k">Bench insurance</div>
        <div class="v ${cls(s.bench.delta)}">${sign(s.bench.delta)}${f1(s.bench.delta)}</div>
        <div class="n">${f1(s.bench.before)} → ${f1(s.bench.after)}</div></div>
      <div class="stat"><div class="k">Above replacement</div>
        <div class="v ${cls(s.par.delta)}">${sign(s.par.delta)}${f1(s.par.delta)}</div>
        <div class="n">started, season</div></div>
      <div class="stat"><div class="k">Point-summing says</div>
        <div class="v ${cls(s.naive.delta)}">${sign(s.naive.delta)}${f2(s.naive.delta)}</div>
        <div class="n">pts/wk — what a naive tool reports</div></div>
      <div class="stat"><div class="k">Roster</div>
        <div class="v">${s.roster.after}/${s.roster.limit}</div>
        <div class="n">after the deal</div></div>`

    if (sim) {
      html += `<div class="stat"><div class="k">Expected wins</div>
        <div class="v ${cls(sim.expectedWins.delta)}">${sign(sim.expectedWins.delta)}${f2(sim.expectedWins.delta)}</div>
        <div class="n">${f1(sim.expectedWins.before)} → ${f1(sim.expectedWins.after)}</div></div>
      <div class="stat"><div class="k">Playoff odds</div>
        <div class="v ${cls(sim.playoffOdds.delta)}">${sign(sim.playoffOdds.delta * 100)}${f1(sim.playoffOdds.delta * 100)}pp</div>
        <div class="n">${Math.round(sim.playoffOdds.before * 100)}% → ${Math.round(sim.playoffOdds.after * 100)}%</div></div>
      <div class="stat"><div class="k">Weekly floor</div>
        <div class="v">${f1(sim.floor.before)} → ${f1(sim.floor.after)}</div>
        <div class="n">10th pct · ceiling ${f1(sim.ceiling.after)}</div></div>`
    }
    html += '</div>'

    // Week strip: the point of the whole exercise made visible.
    const maxAbs = Math.max(1, ...s.perWeek.map((w) => Math.abs(w.delta)))
    html += '<div class="weekstrip">'
    for (const w of s.perWeek) {
      const hgt = Math.max(1, Math.round((Math.abs(w.delta) / maxAbs) * 36))
      const k = w.delta > 0.05 ? 'pos' : w.delta < -0.05 ? 'neg' : ''
      html += `<div class="wk ${k}${w.playoff ? ' playoff' : ''}" title="Week ${w.week}: ${sign(w.delta)}${f1(w.delta)}">`
        + `<i style="height:${hgt}px"></i></div>`
    }
    html += '</div><div class="striplegend">'
      + '<span>week-by-week change in your starting lineup</span>'
      + `<span style="color:var(--amber)">▂ playoff weeks</span></div>`

    if (s.flags.length) {
      html += '<div class="flags">'
      for (const fl of s.flags) {
        const c = fl.kind === 'good' ? ' good' : fl.kind === 'info' ? ' info' : ''
        html += `<div class="flag${c}">${esc(fl.text)}</div>`
      }
      html += '</div>'
    }
    html += '</div>'
  }
  html += '</div>'

  const overridden = Object.keys(state.status).filter((id) => state.status[id] !== 'H')
  if (overridden.length) {
    html += `<p class="note">${overridden.length} player${overridden.length === 1 ? '' : 's'} `
      + `carrying a manual status: ${overridden.map((id) => esc(byId.get(id)?.name || id)
        + ' (' + STATUS_LABEL[state.status[id]] + ')').join(', ')}. `
      + 'Those availabilities are yours, not the data\'s, and they flow through every number above.</p>'
  }

  if (v.sim?.A?.assumptions?.opponent) {
    // The simulation invents an opponent when none is supplied. Expected wins and playoff
    // odds are only as meaningful as that assumption, so it is stated rather than buried.
    html += `<p class="note">Expected wins and playoff odds assume an opponent. `
      + `${esc(v.sim.A.assumptions.opponent)}</p>`
  }

  // Fairness search, only when the deal is meaningfully lopsided.
  const gap = Math.abs(v.A.starters.delta - v.B.starters.delta)
  if (gap > 25 && B.length > sendB.length) {
    html += '<div class="panel" style="margin-top:12px"><p class="eyebrow"><b>What would even this out</b>'
      + ' &nbsp;·&nbsp; searched against their roster</p><div id="fairBox" class="dim">searching…</div></div>'
  }

  box.innerHTML = html

  if (gap > 25 && B.length > sendB.length) {
    // Deferred so the verdict paints first; the search re-evaluates the whole trade once
    // per candidate and would otherwise block the first render.
    setTimeout(() => {
      const fair = suggestFair({
        rosterA: A, rosterB: B, sendA, sendB, pack: PACK, cfg: state.cfg,
        league: engineLeague(), opts: { sim: false },
      })
      const target = $('fairBox')
      if (!target) return
      if (!fair.suggestions.length) { target.textContent = 'Nothing on their roster balances this.'; return }
      target.innerHTML = '<div class="tablewrap"><table class="data"><thead><tr>'
        + '<th>Add from their side</th><th>Pos</th><th class="r">You</th><th class="r">Them</th><th>Result</th>'
        + '</tr></thead><tbody>'
        + fair.suggestions.slice(0, 5).map((s) => `<tr>
            <td class="name">${esc(s.player.name)}</td>
            <td><span class="pos" data-p="${s.player.pos}">${s.player.pos}</span></td>
            <td class="n r ${cls(s.deltaA)}">${sign(s.deltaA)}${f1(s.deltaA)}</td>
            <td class="n r ${cls(s.deltaB)}">${sign(s.deltaB)}${f1(s.deltaB)}</td>
            <td class="dim">${s.bothPositive ? 'both sides gain' : 'closer to even'}</td>
          </tr>`).join('')
        + '</tbody></table></div>'
    }, 0)
  }
  save()
}

/* ------------------------------------------------------------------ players */

const P_COLS = [
  { k: 'name', t: 'Player', cls: 'name' },
  { k: 'pos', t: 'Pos' },
  { k: 'team', t: 'Tm' },
  { k: 'bye', t: 'Bye', r: true },
  { k: 'pts', t: 'Pts/g', r: true, num: true },
  { k: 'range', t: 'Floor – ceiling', r: false },
  { k: 'vor', t: 'VOR', r: true, num: true },
  { k: 'ecr', t: 'ECR', r: true, num: true },
  { k: 'tgtShare', t: 'Tgt%', r: true, num: true },
  { k: 'tdLuck', t: 'TD luck', r: true, num: true },
  { k: 'sos', t: 'SoS', r: true, num: true },
  { k: 'sosPlayoff', t: 'SoS 15-17', r: true, num: true },
  { k: 'avail', t: 'Avail', r: true, num: true },
]

function playerRow(p) {
  const repl = currentReplacement()
  const wk = state.players.window
  let pts
  if (wk === 'playoff') {
    const ws = state.league.playoffWeeks
    pts = ws.reduce((s, w) => s + ppg(p, w), 0) / Math.max(ws.length, 1)
  } else {
    pts = ppg(p)
  }
  const role = p.role || {}
  const sos = PACK.sos?.[p.team]?.[p.pos]
  // Floor and ceiling from the player's own weekly dispersion, shown as a range because a
  // bare mean hides the thing that decides a week.
  const sd = pts * Math.min(0.8, Math.max(0.18, p.cv || 0.4))
  return {
    p,
    name: p.name,
    pos: p.pos,
    team: p.team,
    bye: p.bye,
    pts,
    floor: Math.max(0, pts - 1.28 * sd),
    ceil: pts + 1.28 * sd,
    vor: pts - (repl[p.pos] || 0),
    ecr: p.ecr?.ov ?? null,
    tgtShare: role.tgtShare ?? null,
    tdLuck: (role.aTD != null && role.xTD != null) ? role.aTD - role.xTD : null,
    sos: sos?.season ?? null,
    sosPlayoff: sos?.playoff ?? null,
    avail: p.avail,
  }
}

function renderPlayers() {
  const s = state.players
  $('playerCount').textContent = PACK.players.length

  const head = $('pHead')
  head.innerHTML = ''
  for (const c of P_COLS) {
    const th = el('th', c.r ? 'r' : '')
    th.textContent = c.t
    if (s.sort === c.k) th.setAttribute('aria-sort', s.dir > 0 ? 'ascending' : 'descending')
    th.onclick = () => {
      if (s.sort === c.k) s.dir = -s.dir
      else { s.sort = c.k; s.dir = c.k === 'name' || c.k === 'ecr' ? 1 : -1 }
      renderPlayers()
    }
    head.appendChild(th)
  }

  const q = s.q.trim().toLowerCase()
  let rows = PACK.players
    .filter((p) => (!s.pos || p.pos === s.pos))
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.team.toLowerCase() === q)
    .map(playerRow)

  rows.sort((a, b) => {
    const av = a[s.sort], bv = b[s.sort]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (typeof av === 'string') return s.dir * av.localeCompare(bv)
    return s.dir * (av - bv)
  })
  rows = rows.slice(0, s.limit)

  const body = $('pBody')
  body.innerHTML = ''
  for (const r of rows) {
    const tr = el('tr', state.players.open === r.p.id ? 'sel' : '')
    const rangeMax = Math.max(r.ceil, 1)
    const markerPct = Math.min(100, Math.max(0, (r.pts / rangeMax) * 100))
    tr.innerHTML =
      `<td class="name">${esc(r.name)}</td>`
      + `<td><span class="pos" data-p="${r.pos}">${r.pos}</span></td>`
      + `<td class="dim">${esc(r.team)}</td>`
      + `<td class="n r dim">${r.bye || '—'}</td>`
      + `<td class="n r">${f1(r.pts)}</td>`
      + `<td><div class="range"><span class="num dim" style="font-size:10px">${f1(r.floor)}</span>`
      + `<span class="bar"><u style="left:${markerPct}%"></u></span>`
      + `<span class="num dim" style="font-size:10px">${f1(r.ceil)}</span></div></td>`
      + `<td class="n r ${cls(r.vor)}">${sign(r.vor)}${f1(r.vor)}</td>`
      + `<td class="n r dim">${r.ecr == null ? '—' : Math.round(r.ecr)}</td>`
      + `<td class="n r dim">${r.tgtShare == null ? '—' : (r.tgtShare * 100).toFixed(1)}</td>`
      + `<td class="n r ${r.tdLuck == null ? 'dim' : cls(-r.tdLuck, 1.5)}">${r.tdLuck == null ? '—' : sign(r.tdLuck) + f1(r.tdLuck)}</td>`
      + `<td class="n r dim">${r.sos == null ? '—' : f2(r.sos)}</td>`
      + `<td class="n r ${r.sosPlayoff == null ? 'dim' : cls(r.sosPlayoff - 1, 0.02)}">${r.sosPlayoff == null ? '—' : f2(r.sosPlayoff)}</td>`
      + `<td class="n r dim">${Math.round((r.avail || 0) * 100)}%</td>`
    tr.onclick = () => {
      state.players.open = state.players.open === r.p.id ? null : r.p.id
      renderPlayers()
    }
    body.appendChild(tr)
  }

  $('pDetail').innerHTML = state.players.open ? playerDetail(byId.get(state.players.open)) : ''
}

function playerDetail(p) {
  if (!p) return ''
  const line = p.mu || (p.kWeeks ? Object.values(p.kWeeks)[0] : null)
    || (p.dstWeeks ? Object.values(p.dstWeeks)[0] : null)
  const items = line ? explainLine(line, state.cfg, p.pos) : []
  const role = p.role || {}

  let out = `<div class="detail"><p class="eyebrow"><b>${esc(p.name)}</b> &nbsp;·&nbsp; `
    + `${p.pos} ${esc(p.team)}${p.bye ? ` · bye ${p.bye}` : ''}</p>`

  out += '<div class="kv">'
  const kv = (k, v) => { out += `<div><div class="k">${k}</div><div class="v">${v}</div></div>` }
  kv('Projected', `${f2(ppg(p))} /g`)
  if (role.tgtShare != null) kv('Target share', `${(role.tgtShare * 100).toFixed(1)}%`)
  if (role.rushShare != null && role.rushShare > 0.01) kv('Rush share', `${(role.rushShare * 100).toFixed(1)}%`)
  if (role.ypt != null) kv('Yds / target', f2(role.ypt))
  if (role.catchRate != null) kv('Catch rate', `${(role.catchRate * 100).toFixed(0)}%`)
  if (role.xTD != null) kv('Expected TDs', f1(role.xTD))
  if (role.aTD != null) kv('Actual TDs', f1(role.aTD))
  kv('Availability', `${Math.round((p.avail || 0) * 100)}%`)
  if (p.ecr?.ov) kv('Consensus rank', `${Math.round(p.ecr.ov)} ± ${f1(p.ecr.sd)}`)
  if (p.blendAdj) kv('Market adjust', `×${f2(p.blendAdj)}`)
  out += '</div>'

  if (role.aTD != null && role.xTD != null) {
    const oe = role.aTD - role.xTD
    if (Math.abs(oe) > 2) {
      out += `<div class="flags"><div class="flag ${oe > 0 ? '' : 'good'}">`
        + `Scored ${f1(Math.abs(oe))} ${oe > 0 ? 'more' : 'fewer'} touchdowns than his opportunities implied. `
        + `${oe > 0 ? 'Regression candidate: the projection already discounts this.' : 'Positive regression candidate.'}`
        + '</div></div>'
    }
  }

  if (items.length) {
    out += '<p class="eyebrow" style="margin-top:14px"><b>Where the points come from</b></p>'
      + '<div class="tablewrap"><table class="data"><tbody>'
      + items.map((i) => `<tr><td>${esc(i.label)}</td><td class="dim">${esc(i.detail)}</td>`
        + `<td class="n r">${esc(i.pointsText)}</td></tr>`).join('')
      + '</tbody></table></div>'
  }

  // Real history, scored under the user's own settings.
  if (p.log?.length) {
    const K = PACK.logKeys
    const games = p.log.map((r) => {
      const o = {}
      for (let i = 0; i < K.length; i++) o[K[i]] = r[i + 3]
      return { season: r[0], week: r[1], opp: r[2], pts: scoreLine(o, state.cfg, p.pos) }
    })
    const tot = games.reduce((s, g) => s + g.pts, 0)
    const max = Math.max(1, ...games.map((g) => g.pts))
    out += `<p class="eyebrow" style="margin-top:14px"><b>What he actually did</b> &nbsp;·&nbsp; `
      + `${games.length} games, ${f2(tot / games.length)} /g under your scoring</p>`
      + '<div class="spark">'
      + games.map((g) => `<i class="${g.pts > max * 0.75 ? 'hi' : ''}" style="height:${Math.max(1, (g.pts / max) * 36)}px" `
        + `title="${g.season} wk${g.week} vs ${esc(g.opp)}: ${f1(g.pts)}"></i>`).join('')
      + '</div>'
      + `<p class="note">Real games from ${PACK.meta.logSeasons.join(' and ')}, re-scored under the settings `
      + 'you have set. Change the scoring and this changes with it.</p>'
  }
  out += '</div>'
  return out
}

/* ------------------------------------------------------------------ draft */

function renderDraft() {
  const d = state.draft
  // Keep the controls showing what the board is actually computed from, so the snake gap
  // on screen is the league's rather than whatever the markup was authored with.
  if ($('dPick').value !== String(d.pick)) $('dPick').value = d.pick
  if ($('dNext').value !== String(d.next)) $('dNext').value = d.next
  const taken = new Set(d.taken)
  const available = PACK.players.filter((p) => !taken.has(p.id))
  const mine = d.mine.map((id) => byId.get(id)).filter(Boolean)

  const board = draftBoard({
    available, myRoster: mine, league: state.league, cfg: state.cfg, pack: PACK,
    pickNumber: d.pick, picksUntilNext: d.next,
  })

  const { runs } = detectRun(d.taken.map((id) => byId.get(id)).filter(Boolean))
  $('dRuns').innerHTML = runs.length
    ? `<div class="flags"><div class="flag info">${esc(runs[0].text)} — the position is going faster than normal.</div></div>`
    : ''

  const sc = positionScarcity({ available, league: state.league, cfg: state.cfg, pack: PACK })
  $('dScarcity').innerHTML = Object.entries(sc).map(([pos, v]) => `<div class="stat">
      <div class="k"><span class="pos" data-p="${pos}">${pos}</span></div>
      <div class="v">${v.aboveReplacement}</div>
      <div class="n">above repl.</div></div>`).join('')

  const rows = board.board.filter((r) => !d.pos || r.pos === d.pos).slice(0, 60)
  $('dBody').innerHTML = rows.map((r) => `<tr>
      <td><button class="btn" data-take="${esc(r.player.id)}">+</button></td>
      <td class="name">${esc(r.player.name)}</td>
      <td><span class="pos" data-p="${r.pos}">${r.pos}</span></td>
      <td class="n r dim">${r.tier}</td>
      <td class="n r">${f1(r.points)}</td>
      <td class="n r ${cls(r.vor)}">${sign(r.vor)}${f1(r.vor)}</td>
      <td class="n r ${cls(r.vona)}"><b>${sign(r.vona)}${f1(r.vona)}</b></td>
      <td class="n r dim">${r.ecr == null ? '—' : Math.round(r.ecr)}</td>
      <td class="n r ${r.risk > 0.55 ? 'down' : 'dim'}">${Math.round(r.risk * 100)}</td>
      <td class="dim" style="white-space:normal;max-width:230px">${esc(r.reason)}</td>
    </tr>`).join('')

  $('dBody').querySelectorAll('[data-take]').forEach((b) => {
    b.onclick = () => {
      const id = b.getAttribute('data-take')
      d.taken.push(id)
      d.mine.push(id)
      d.pick += 1
      renderDraft()
      save()
    }
  })

  $('dRosterCount').textContent = mine.length
  $('dRoster').innerHTML = mine.length
    ? mine.map((p) => `<div class="row"><span></span>
        <div><div class="nm">${esc(p.name)}</div>
        <div class="sub"><span class="pos" data-p="${p.pos}">${p.pos}</span><span>${esc(p.team)}</span></div></div>
        <div class="ppg">${f1(ppg(p))}</div><span></span>
        <button class="del" data-undo="${esc(p.id)}" aria-label="Undo">×</button></div>`).join('')
    : '<p class="empty">Nothing drafted yet.</p>'

  $('dRoster').querySelectorAll('[data-undo]').forEach((b) => {
    b.onclick = () => {
      const id = b.getAttribute('data-undo')
      d.mine = d.mine.filter((x) => x !== id)
      d.taken = d.taken.filter((x) => x !== id)
      d.pick = Math.max(1, d.pick - 1)
      renderDraft()
      save()
    }
  })
}

/* ------------------------------------------------------------------ league */

function numField(label, value, onInput, step = 'any') {
  const l = el('label', 'fld')
  l.innerHTML = `<span>${esc(label)}</span>`
  const i = el('input')
  i.type = 'number'
  i.step = step
  i.value = value
  i.oninput = () => onInput(parseFloat(i.value))
  l.appendChild(i)
  return l
}

/**
 * What league the app is actually configured for.
 *
 * Worth showing plainly: every replacement level, every verdict and every proposal is
 * computed against this, and a tool that quietly priced a 12-team league while you played
 * in an 8-team one would be wrong in a way you could not see.
 */
function renderLeagueIdentity() {
  const panel = $('leaguePanel')
  if (!LEAGUE) { panel.hidden = true; return }
  panel.hidden = false
  const starters = Object.entries(LEAGUE.slots)
    .filter(([k]) => k !== 'BEN')
    .map(([k, n]) => (n > 1 ? `${n}×${k}` : k)).join(' · ')
  $('leagueStamp').textContent = `as of week ${LEAGUE.asOfWeek}, ${LEAGUE.season}`

  const mismatch = []
  if (state.league.teams !== LEAGUE.teams) {
    mismatch.push(`Teams is set to ${state.league.teams} below, but the league has `
      + `${LEAGUE.teams}. Replacement level is being computed for the wrong league size.`)
  }
  const wanted = LEAGUE.playoffWeeks.join(',')
  if (state.league.playoffWeeks.join(',') !== wanted) {
    mismatch.push(`Playoff weeks are set to ${state.league.playoffWeeks.join('/')} below, `
      + `but the league plays ${LEAGUE.playoffWeeks.join('/')}.`)
  }

  $('leagueBox').innerHTML =
    `<p class="note" style="margin-top:0"><b>${esc(LEAGUE.teams)} teams</b> &nbsp;·&nbsp; `
    + `starting ${esc(starters)}, ${LEAGUE.slots.BEN} on the bench &nbsp;·&nbsp; `
    + `playoff weeks ${LEAGUE.playoffWeeks.join('/')} &nbsp;·&nbsp; `
    + `you are <b>${esc(LEAGUE.myTeam)}</b>. Rosters were read off the ESPN matchup pages `
    + `for week ${LEAGUE.asOfWeek} and every player resolved against this pack, so nothing `
    + 'here is a guess about who is on whose roster. Anything after that date -- waivers, '
    + 'trades, an injury -- has to be edited on the Trade tab or re-transcribed into '
    + '<code>pipeline/league.json</code>.</p>'
    + (mismatch.length
      ? `<div class="flags">${mismatch.map((m) => `<div class="flag">${esc(m)}</div>`).join('')}</div>`
      : '')
    + '<div class="tablewrap" style="margin-top:12px"><table class="data"><thead><tr>'
    + '<th>Team</th><th>Manager</th><th class="r">Players</th><th>Week '
    + `${LEAGUE.asOfWeek} opponent</th></tr></thead><tbody>`
    + LEAGUE.rosters.map((t) => {
      const me = t.name === LEAGUE.myTeam
      return `<tr><td>${esc(t.name)}${me ? ' <span class="dim">(you)</span>' : ''}</td>`
        + `<td class="dim">${esc(t.owner)}</td>`
        + `<td class="n r">${t.players.length}</td>`
        + `<td class="dim">${esc(leagueOpponent(t.name) || '—')}</td></tr>`
    }).join('')
    + '</tbody></table></div>'
}

function renderLeague() {
  const c = state.cfg

  renderLeagueIdentity()

  const sel = $('preset')
  if (!sel.options.length) {
    for (const [k, v] of Object.entries(PRESETS)) {
      const o = el('option')
      o.value = k
      o.textContent = v.name || k
      sel.appendChild(o)
    }
    sel.value = 'fullPPR'
    sel.onchange = () => {
      state.cfg = cloneScoring(PRESETS[sel.value])
      renderLeague()
      renderAll()
    }
  }

  $('lTeams').value = state.league.teams
  $('lPlayoff').value = state.league.playoffWeeks.join(',')
  $('lPWeight').value = state.league.playoffWeight

  const slot = $('slotGrid')
  slot.innerHTML = ''
  for (const k of ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DST', 'BEN']) {
    slot.appendChild(numField(k, state.league.slots[k] ?? 0, (v) => {
      state.league.slots[k] = Number.isFinite(v) ? v : 0
    }, '1'))
  }

  const pass = $('passGrid')
  pass.innerHTML = ''
  pass.appendChild(numField('Pass yd', c.pass.yd, (v) => { c.pass.yd = v }))
  pass.appendChild(numField('Pass TD', c.pass.td, (v) => { c.pass.td = v }))
  pass.appendChild(numField('Interception', c.pass.int, (v) => { c.pass.int = v }))
  pass.appendChild(numField('2-pt', c.pass.twoPt, (v) => { c.pass.twoPt = v }))

  const rush = $('rushGrid')
  rush.innerHTML = ''
  rush.appendChild(numField('Rush yd', c.rush.yd, (v) => { c.rush.yd = v }))
  rush.appendChild(numField('Rush TD', c.rush.td, (v) => { c.rush.td = v }))
  rush.appendChild(numField('Rec yd', c.rec.yd, (v) => { c.rec.yd = v }))
  rush.appendChild(numField('Per reception', c.rec.rec, (v) => { c.rec.rec = v }))
  rush.appendChild(numField('Rec TD', c.rec.td, (v) => { c.rec.td = v }))
  rush.appendChild(numField('Fumble lost', c.misc.fumLost, (v) => { c.misc.fumLost = v }))
  rush.appendChild(numField('TE per rec bonus', c.rec.recBonusByPos?.TE ?? 0, (v) => {
    c.rec.recBonusByPos = { ...(c.rec.recBonusByPos || {}), TE: v }
  }))

  const kick = $('kickGrid')
  kick.innerHTML = ''
  for (const b of ['0_19', '20_29', '30_39', '40_49', '50_59', '60']) {
    kick.appendChild(numField(`FG ${b.replace('_', '-')}`, c.k.fg[b], (v) => { c.k.fg[b] = v }))
  }
  kick.appendChild(numField('Miss', c.k.miss, (v) => { c.k.miss = v }))
  kick.appendChild(numField('PAT', c.k.xp, (v) => { c.k.xp = v }))

  const dst = $('dstGrid')
  dst.innerHTML = ''
  for (const [k, label] of [['sack', 'Sack'], ['int', 'Interception'], ['fumRec', 'Fumble rec'],
    ['safety', 'Safety'], ['td', 'Defensive TD'], ['blk', 'Blocked kick']]) {
    dst.appendChild(numField(label, c.dst[k], (v) => { c.dst[k] = v }))
  }

  const tierGrid = (host, tiers, label) => {
    host.innerHTML = ''
    tiers.forEach((t, i) => {
      const lo = i === 0 ? 0 : tiers[i - 1].max + 1
      const name = t.max >= 1e8 ? `${lo}+` : `${lo}–${t.max}`
      host.appendChild(numField(`${label} ${name}`, t.pts, (v) => { t.pts = v }))
    })
  }
  tierGrid($('paGrid'), c.dst.paTiers, 'pts')
  tierGrid($('yaGrid'), c.dst.yaTiers, 'yds')

  const repl = currentReplacement()
  const detail = repl._detail || {}
  $('replBox').innerHTML = '<div class="tablewrap"><table class="data"><thead><tr>'
    + '<th>Pos</th><th class="r">Replacement</th><th>How it was derived</th></tr></thead><tbody>'
    + ['QB', 'RB', 'WR', 'TE', 'K', 'DST'].map((pos) => {
      const d = detail[pos] || {}
      return `<tr><td><span class="pos" data-p="${pos}">${pos}</span></td>`
        + `<td class="n r">${f2(d.pts)}</td>`
        + `<td class="dim" style="white-space:normal">${esc(d.note || '')}</td></tr>`
    }).join('')
    + '</tbody></table></div>'
    + '<p class="note">This is the player you would actually start instead. '
    + (['QB', 'RB', 'WR', 'TE', 'K', 'DST'].every((pos) => detail[pos]?.method === 'freeAgent')
      ? 'Every roster in the league is loaded, so it is not an estimate from slot math: it is '
        + 'literally the best player nobody owns. '
      : 'Where the rosters loaded do not cover the league, it falls back to a rank baseline '
        + 'from league size and starting slots -- the "how it was derived" column says which '
        + 'you are getting at each position. ')
    + 'That is what turns raw points into value, and it is why a 12-point '
    + 'quarterback is worse than nothing while a 12-point running back is a starter.</p>'
}

/* ------------------------------------------------------------------ method */

function renderMethod() {
  const m = PACK.meta
  const cov = m.marketCoverage || {}
  const integ = m.integrity || {}
  $('methodBody').innerHTML = `
    <p class="eyebrow"><b>What this does that point-summing does not</b></p>
    <div class="flags">
      <div class="flag good"><b>Bench points are worth almost nothing.</b> Across the eight real
        rosters in this league, between 37% and 43% of a roster's raw projected total never
        reaches a starting lineup. Everything here is measured in starter points and in points
        above the player you would otherwise start, and bench depth is priced as insurance
        rather than at face value.</div>
      <div class="flag good"><b>The same trade is not worth the same to both teams.</b> Both
        rosters are evaluated against their own shape, so a deal can be a gain for one and a
        loss for the other. On this data, Kyren Williams for Tee Higgins is worth +29 points
        over a season to the most back-heavy roster in the league and ‒8 to the most
        receiver-heavy one, while point-summing calls it a flat +1.8 a week for everyone.</div>
      <div class="flag good"><b>Weeks are not equal.</b> Every remaining week is walked with the
        lineup re-solved and bye players removed, so bye collisions and the playoff schedule
        show up in the number instead of being ignored.</div>
    </div>

    <p class="eyebrow" style="margin-top:16px"><b>How the projections are built</b></p>
    <p class="note">
      Player usage and efficiency come from seven seasons of play-by-play and box scores.
      Touchdowns are projected from <em>opportunity</em> rather than from what a player
      actually scored, using a touchdown-probability curve fitted by yard line over 137,303
      plays — expected touchdowns predict next season better than realized ones
      (r = 0.50 against 0.45), and the model weights them 0.765 to 0.235 accordingly. Team
      scoring environment is anchored to the betting market: implied team totals from posted
      spreads and totals, with a ridge ratings model filling the weeks books have not priced
      yet. The result is then blended with the expert consensus board in rank space, which
      measured 17% better than the model alone on a 2025 out-of-sample test.
    </p>

    <p class="eyebrow" style="margin-top:16px"><b>What it gets wrong, measured</b></p>
    <p class="note">
      Backtested on 2025 with a strict pre-season information cutoff, across 435 players:
      mean absolute error 2.63 points a game against 2.88 for the obvious baseline of last
      year's average, correlation 0.78. Projections are deliberately <em>compressed</em>
      relative to outcomes — the player who finishes as the top receiver is partly the
      one who got lucky, so an honest projection of today's top receiver sits below what the
      eventual leader will actually score. A model whose top projection matched the realized
      top score would be overconfident, not accurate.
    </p>

    <p class="eyebrow" style="margin-top:16px"><b>Known limits</b></p>
    <div class="flags">
      <div class="flag info">Only ${Math.round((cov.market_share || 0) * 100)}% of 2026 games
        have a posted betting line yet, and the fantasy playoff weeks have none. The rest use a
        ratings model that lands within about 3 points of a real line on held-out seasons.</div>
      <div class="flag info">The D/ST tier <em>boundaries</em> are inferred. Nine payouts were
        supplied for each stack but not the cutoffs, so the standard ESPN edges are used. They
        are editable on the League tab and they are worth several points a week.</div>
      <div class="flag info">Preseason depth charts rank whoever takes the most preseason snaps,
        which puts camp bodies above starters. Players absent from the consensus board are
        pushed down to compensate, but a genuine late-summer job change may still be mispriced.</div>
    </div>

    <p class="eyebrow" style="margin-top:16px"><b>Checks that ran when this data was built</b></p>
    <div class="kv">
      <div><div class="k">Spread orientation</div><div class="v" style="font-size:11px">${esc(integ.spread_orientation?.orientation || '—')}</div></div>
      <div><div class="k">Byes cross-checked</div><div class="v">${integ.bye_weeks ? `${integ.bye_weeks.agree}/${integ.bye_weeks.checked}` : '—'}</div></div>
      <div><div class="k">Expected TD beats actual</div><div class="v">${integ.td_regression?.expected_beats_realized ? 'yes' : 'no'}</div></div>
      <div><div class="k">Implied total bias</div><div class="v">${f2(integ.implied_totals?.bias)}</div></div>
    </div>`

  $('sourceBox').innerHTML = '<div class="tablewrap"><table class="data"><thead><tr>'
    + '<th>Dataset</th><th class="r">Size</th><th>Fingerprint</th></tr></thead><tbody>'
    + (m.sources || []).slice(0, 40).map((s) => `<tr><td>${esc(s.key)}</td>`
      + `<td class="n r dim">${(s.bytes / 1048576).toFixed(2)} MB</td>`
      + `<td class="dim num" style="font-size:10px">${esc(s.sha256)}</td></tr>`).join('')
    + '</tbody></table></div>'
    + '<p class="note">Play-by-play, box scores, rosters, depth charts, injuries and schedules '
    + 'from nflverse. Expert consensus ranks from FantasyPros via DynastyProcess. '
    + `Built ${esc(m.generated)}. Nothing is fetched at runtime.</p>`
}

/* ------------------------------------------------------------------ wiring */

function renderAll() {
  renderStamp()
  if (state.view === 'trade') renderTrade()
  if (state.view === 'propose') renderPropose()
  if (state.view === 'players') renderPlayers()
  if (state.view === 'draft') renderDraft()
  if (state.view === 'league') { renderLeague(); renderEspnResult(null) }
  if (state.view === 'method') renderMethod()
}

function show(view) {
  state.view = view
  for (const b of document.querySelectorAll('nav.tabs button')) {
    b.setAttribute('aria-selected', String(b.dataset.view === view))
  }
  for (const s of document.querySelectorAll('.view')) {
    s.hidden = s.id !== `view-${view}`
  }
  renderAll()
}

/**
 * Put one league roster on a side.
 *
 * The league file carries the injury designations that were on the ESPN page when it was
 * transcribed, and those seed the status overrides exactly the way an ESPN import does:
 * fresher than anything the pack knows, and yours to change afterwards.
 */
function loadTeam(side, name) {
  const t = leagueTeam(name)
  if (!t) return false
  state[side] = t.players.map((p) => p.id).filter((id) => byId.has(id))
  state[`name${side}`] = t.name
  $(`name${side}`).value = t.name
  for (const id of state[side]) if (state.move[id]) delete state.move[id]
  return true
}

/**
 * Apply the league file's injury designations across every roster in it, once.
 *
 * These have to land for the whole league rather than for whichever teams happen to have
 * been opened: the Propose tab prices a rival's roster straight out of the league file,
 * so a designation that only took effect after you had visited that team would make the
 * same search return different numbers depending on where you had clicked. Seeding is
 * tied to the league stamp, so a session that already carries your own edits keeps them.
 */
function seedLeagueStatus() {
  for (const t of LEAGUE?.rosters || []) {
    for (const p of t.players) {
      if (p.status === 'OUT' || p.status === 'IR' || p.status === 'Q') state.status[p.id] = p.status
    }
  }
}

/** Open on the real league: your roster against whoever you play this week. */
function loadLeagueRosters() {
  if (!LEAGUE) return
  const mine = LEAGUE.myTeam
  const theirs = leagueOpponent(mine)
    || LEAGUE.rosters.find((t) => t.name !== mine)?.name
  loadTeam('A', mine)
  if (theirs) loadTeam('B', theirs)
  state.move = {}
  renderTrade()
}

function init() {
  const resumed = load()
  // A session that predates this league never had its designations applied, and a fresh
  // one has none at all. Either way they seed now, for every roster rather than the two
  // that happen to be on screen.
  if (!resumed) seedLeagueStatus()
  $('nameA').value = state.nameA
  $('nameB').value = state.nameB

  for (const b of document.querySelectorAll('nav.tabs button')) {
    b.onclick = () => show(b.dataset.view)
  }
  for (const side of ['A', 'B']) {
    wireSearch(side)
    $(`name${side}`).addEventListener('input', (e) => {
      state[`name${side}`] = e.target.value
      renderTrade()
    })
    $(`pick${side}`).addEventListener('change', (e) => {
      // "Custom roster" is a label for a state you reach by editing, not a roster to load.
      // Selecting it should not wipe what is there, so re-render and leave the roster alone.
      if (e.target.value) loadTeam(side, e.target.value)
      renderTrade()
      save()
    })
  }
  document.querySelectorAll('[data-paste]').forEach((b) => {
    b.onclick = () => {
      const box = $(`paste${b.dataset.paste}`)
      box.hidden = !box.hidden
      b.textContent = box.hidden ? 'Paste a list instead' : 'Hide paste box'
    }
  })
  document.querySelectorAll('[data-import]').forEach((b) => {
    b.onclick = () => {
      const side = b.dataset.import
      const lines = $(`pt${side}`).value.split('\n').map((x) => x.trim()).filter(Boolean)
      const missing = []
      for (const line of lines) {
        const nm = line.split(',')[0].trim().toLowerCase()
        const hit = PACK.players.find((p) => p.name.toLowerCase() === nm)
          || PACK.players.find((p) => p.name.toLowerCase().includes(nm))
        if (hit && !state[side].includes(hit.id)) state[side].push(hit.id)
        else if (!hit) missing.push(line)
      }
      $(`pt${side}`).value = missing.join('\n')
      if (missing.length) {
        // Never silently invent a player. Say which lines did not match and leave them
        // in the box so they can be corrected.
        alert(`Could not match ${missing.length} line(s). They are still in the box:\n\n`
          + missing.slice(0, 8).join('\n'))
      }
      renderTrade()
    }
  })

  wireEspn()
  $('fRun').onclick = runFinder
  $('fOpponent').addEventListener('change', () => {
    state.finder.opponent = $('fOpponent').value
    state.finder.targets = []
    state.finder.result = null   // the old results were searched against someone else
    renderPropose()
  })
  for (const id of ['fMaxGive', 'fMaxGet']) $(id).addEventListener('change', () => {})

  $('loadLeague').onclick = loadLeagueRosters
  $('clearTrade').onclick = () => { state.move = {}; renderTrade() }
  $('wipe').onclick = () => {
    state.A = []; state.B = []; state.move = {}
    state.cfg = cloneScoring(DEFAULT_SCORING)
    state.league = {
      teams: LEAGUE?.teams ?? DEFAULT_LEAGUE.teams,
      slots: { ...DEFAULT_LEAGUE.slots, ...(LEAGUE?.slots || {}) },
      playoffWeeks: [...(LEAGUE?.playoffWeeks || DEFAULT_LEAGUE.playoffWeeks)],
      playoffWeight: DEFAULT_LEAGUE.playoffWeight,
    }
    replKey = ''
    state.draft = { taken: [], mine: [], pick: 1, next: snakeGap(), pos: '' }
    state.status = {}
    state.espn = null
    state.finder = { untouchable: [], targets: [], maxGive: 2, maxGet: 2, opponent: '', result: null }
    try { localStorage.removeItem(STORE) } catch (e) { /* nothing to clear */ }
    renderAll()
  }

  for (const [id, key] of [['pSearch', 'q'], ['pPos', 'pos'], ['pWindow', 'window'], ['pLimit', 'limit']]) {
    $(id).addEventListener('input', (e) => {
      state.players[key] = key === 'limit' ? parseInt(e.target.value, 10) : e.target.value
      renderPlayers()
    })
  }

  for (const [id, key] of [['dPick', 'pick'], ['dNext', 'next'], ['dPos', 'pos']]) {
    $(id).addEventListener('input', (e) => {
      state.draft[key] = key === 'pos' ? e.target.value : (parseInt(e.target.value, 10) || 1)
      renderDraft()
    })
  }
  $('dReset').onclick = () => {
    state.draft = { taken: [], mine: [], pick: 1, next: snakeGap(), pos: '' }
    renderDraft()
    save()
  }

  $('applyLeague').onclick = () => {
    state.league.teams = parseInt($('lTeams').value, 10) || (LEAGUE?.teams ?? DEFAULT_LEAGUE.teams)
    state.league.playoffWeeks = $('lPlayoff').value.split(',')
      .map((x) => parseInt(x.trim(), 10)).filter(Number.isFinite)
    state.league.playoffWeight = parseFloat($('lPWeight').value) || 1
    replKey = ''
    renderAll()
    save()
  }
  $('resetLeague').onclick = () => {
    state.cfg = cloneScoring(DEFAULT_SCORING)
    state.league = {
      teams: LEAGUE?.teams ?? DEFAULT_LEAGUE.teams,
      slots: { ...DEFAULT_LEAGUE.slots, ...(LEAGUE?.slots || {}) },
      playoffWeeks: [...(LEAGUE?.playoffWeeks || DEFAULT_LEAGUE.playoffWeeks)],
      playoffWeight: DEFAULT_LEAGUE.playoffWeight,
    }
    replKey = ''
    $('preset').value = 'fullPPR'
    renderLeague()
    renderAll()
    save()
  }

  // Open on the real league if there is nothing saved: your roster against this week's
  // opponent, so the first screen is your actual decision rather than a worked example.
  if (!state.A.length && !state.B.length && LEAGUE) loadLeagueRosters()
  show('trade')
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
else init()

/* ------------------------------------------------------------------ ESPN import */

function renderEspnResult(r) {
  const box = $('espnResult')
  if (!r) { box.innerHTML = ''; return }
  if (!r.ok) {
    box.innerHTML = `<div class="flags"><div class="flag">${esc(r.error)}</div></div>`
    return
  }
  const s = r.summary
  let html = `<div class="flags"><div class="flag good">Imported <b>${esc(r.league.name)}</b>: `
    + `${s.teams} teams, ${s.rostered} players matched, ${s.scoringRulesMapped} scoring rules read.`
    + '</div>'
  for (const w of r.warnings) html += `<div class="flag info">${esc(w)}</div>`
  html += '</div>'

  if (r.unsupported.length) {
    html += '<p class="eyebrow" style="margin-top:12px"><b>Scoring rules not modelled</b></p>'
      + '<div class="tablewrap"><table class="data"><thead><tr><th>Rule</th>'
      + '<th class="r">Points</th><th>ESPN stat</th></tr></thead><tbody>'
      + r.unsupported.map((u) => `<tr><td>${esc(u.label)}</td>`
        + `<td class="n r">${esc(u.points)}</td><td class="dim">${u.statId}</td></tr>`).join('')
      + '</tbody></table></div>'
  }
  if (r.unmatched.length) {
    html += '<p class="eyebrow" style="margin-top:12px"><b>Players left off</b>'
      + ' &nbsp;·&nbsp; add these by hand rather than let the app guess</p>'
      + '<div class="tablewrap"><table class="data"><thead><tr><th>Player</th><th>Pos</th>'
      + '<th>Team</th><th>Roster</th></tr></thead><tbody>'
      + r.unmatched.slice(0, 25).map((u) => `<tr><td>${esc(u.name)}</td>`
        + `<td><span class="pos" data-p="${esc(u.pos)}">${esc(u.pos)}</span></td>`
        + `<td class="dim">${esc(u.proTeam)}</td><td class="dim">${esc(u.team)}</td></tr>`).join('')
      + '</tbody></table></div>'
  }

  html += '<p class="eyebrow" style="margin-top:14px"><b>Pick your team</b></p>'
    + '<div class="grid g2"><label class="fld"><span>Mine</span><select id="espnMine"></select></label>'
    + '<label class="fld"><span>Load as "their team"</span><select id="espnTheirs"></select></label></div>'
    + '<div style="margin-top:8px"><button class="btn solid" id="espnApply">Load these rosters</button></div>'
  box.innerHTML = html

  for (const id of ['espnMine', 'espnTheirs']) {
    const sel = $(id)
    r.teams.forEach((t, i) => {
      const o = el('option')
      o.value = String(i)
      o.textContent = `${t.name} (${t.players.length})`
      sel.appendChild(o)
    })
    if (id === 'espnTheirs' && r.teams.length > 1) sel.value = '1'
  }
  $('espnApply').onclick = () => {
    const mine = r.teams[Number($('espnMine').value)]
    const theirs = r.teams[Number($('espnTheirs').value)]
    if (!mine || !theirs || mine === theirs) {
      alert('Pick two different teams.')
      return
    }
    state.A = mine.players.map((p) => p.id)
    state.B = theirs.players.map((p) => p.id)
    state.nameA = mine.name
    state.nameB = theirs.name
    state.move = {}
    // ESPN's own injury flags are fresher than anything in the pack, so they seed the
    // status overrides -- and are then yours to adjust.
    for (const t of [mine, theirs]) {
      for (const p of t.players) {
        if (p.injuryStatus === 'OUT') state.status[p.id] = 'OUT'
        else if (p.injuryStatus === 'QUESTIONABLE' || p.injuryStatus === 'DOUBTFUL') state.status[p.id] = 'Q'
        else if (p.injuryStatus === 'INJURY_RESERVE') state.status[p.id] = 'IR'
      }
    }
    if (r.cfg) state.cfg = r.cfg
    if (r.slots) state.league.slots = { ...state.league.slots, ...r.slots }
    if (r.league.teams) state.league.teams = r.league.teams
    if (r.league.playoffWeeks) state.league.playoffWeeks = r.league.playoffWeeks
    replKey = ''
    $('nameA').value = state.nameA
    $('nameB').value = state.nameB
    save()
    show('trade')
  }
}

function wireEspn() {
  $('espnMakeUrl').onclick = () => {
    const id = $('espnId').value.trim()
    if (!id) { alert('Enter your league id. It is the number in your ESPN league URL.'); return }
    const url = espnUrl(id, $('espnYear').value)
    $('espnUrl').textContent = url
    $('espnOpen').href = url
    $('espnUrlBox').hidden = false
  }
  $('espnCopy').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('espnUrl').textContent)
      $('espnCopy').textContent = 'Copied'
      setTimeout(() => { $('espnCopy').textContent = 'Copy' }, 1500)
    } catch (e) {
      // Clipboard access is refused in plenty of contexts; the text is on screen to select.
      $('espnCopy').textContent = 'Select it above'
    }
  }
  $('espnImport').onclick = () => {
    const raw = $('espnPaste').value
    if (!raw.trim()) { alert('Paste the ESPN response first.'); return }
    const r = parseEspnLeague(raw, PACK)
    state.espn = r.ok ? { league: r.league, teams: r.teams } : null
    renderEspnResult(r)
    save()
  }
  $('espnClear').onclick = () => {
    $('espnPaste').value = ''
    state.espn = null
    renderEspnResult(null)
    save()
  }
}

/* ------------------------------------------------------------------ propose */

function renderPropose() {
  const mine = roster('A')
  const sel = $('fOpponent')
  sel.innerHTML = ''

  // Everyone you could actually trade with: the other seven teams in the league, then
  // anything an ESPN import brought in, then whatever is sitting in "their team".
  const options = []
  const mineName = matchedLeagueTeam('A')
  for (const t of LEAGUE?.rosters || []) {
    if (t.name === mineName) continue
    const ids = t.players.map((p) => p.id)
    // Without a matched side A, fall back to overlap: a roster that is mostly what you
    // already hold is your own team, and offering yourself a trade is not useful.
    if (!mineName && ids.filter((id) => state.A.includes(id)).length > ids.length * 0.6) continue
    options.push({ name: t.name, label: `${t.name} (${t.owner})`, players: ids })
  }
  if (state.espn?.teams?.length) {
    state.espn.teams.forEach((t, i) => {
      const ids = t.players.map((p) => p.id)
      const overlap = ids.filter((id) => state.A.includes(id)).length
      if (overlap > ids.length * 0.6) return  // that is my own team
      options.push({ name: t.name, label: `${t.name} (ESPN)`, players: ids })
    })
  }
  // Only when "their team" is something other than a league roster -- otherwise it would
  // list the same eleven players twice under two labels.
  if (state.B.length && !matchedLeagueTeam('B')) {
    options.push({ name: state.nameB, label: `${state.nameB} (manual)`, players: [...state.B] })
  }

  // The option VALUE is the label, never the position in the list. Which teams appear
  // depends on who is loaded into side A, so switching your own roster reorders this
  // list -- and an index carried across that rebuild silently points at a different
  // manager than the one that was selected.
  for (const o of options) {
    const opt = el('option'); opt.value = o.label; opt.textContent = o.label
    sel.appendChild(opt)
  }
  const want = state.finder.opponent
  sel.value = options.some((o) => o.label === want) ? want : (options[0]?.label ?? '')
  state.finder.opponent = sel.value
  state.finder._options = options

  const chips = (host, list, key) => {
    const box = $(host)
    box.innerHTML = ''
    for (const p of list) {
      const b = el('button', 'chip')
      b.textContent = `${p.name} ${p.pos}`
      const on = state.finder[key].includes(p.id)
      b.setAttribute('aria-pressed', String(on))
      b.onclick = () => {
        const arr = state.finder[key]
        const i = arr.indexOf(p.id)
        if (i >= 0) arr.splice(i, 1); else arr.push(p.id)
        renderPropose()
      }
      box.appendChild(b)
    }
    if (!list.length) box.innerHTML = '<span class="dim" style="font-size:12px">Nothing loaded yet.</span>'
  }
  chips('fUntouchable', mine, 'untouchable')
  const opp = selectedOpponent()
  const theirs = (opp?.players || []).map((id) => withStatus(byId.get(id))).filter(Boolean)
  chips('fTargets', theirs, 'targets')

  // Proposals belong to the two rosters they were searched over. Once either side has
  // moved on, they are a stale answer to a question nobody is asking any more, and
  // leaving them on screen under a different manager's name is how you send the wrong
  // offer to the wrong person.
  const r = state.finder.result
  if (r && r.opponent === sel.value && r.forA === pairKey(state.A)) {
    renderProposals(r)
  } else {
    state.finder.result = null
    $('fResults').innerHTML = ''
  }
}

/** An order-independent fingerprint of a roster, for spotting that it has changed. */
const pairKey = (ids) => [...ids].sort().join(',')

/** The roster currently chosen in "Trade with", resolved by label rather than position. */
function selectedOpponent() {
  const want = $('fOpponent').value
  const opts = state.finder._options || []
  return opts.find((o) => o.label === want) || null
}

function renderProposals(r) {
  const box = $('fResults')
  const n = PACK.meta.regSeasonWeeks || 18
  let html = `<div class="panel"><p class="eyebrow">`
    + `<b>Results</b>${r.opponent ? ` &nbsp;·&nbsp; against ${esc(r.opponent)}` : ''} &nbsp;·&nbsp; `
    + `${r.screened.toLocaleString()} packages screened, ${r.evaluated} evaluated exactly `
    + `in ${(r.elapsedMs / 1000).toFixed(1)}s</p>`

  for (const note of r.notes) html += `<div class="flags"><div class="flag info">${esc(note)}</div></div>`

  const render = (list, title, sub) => {
    if (!list.length) return ''
    let h = `<p class="eyebrow" style="margin-top:14px"><b>${esc(title)}</b> &nbsp;·&nbsp; ${esc(sub)}</p>`
    list.slice(0, 6).forEach((c, i) => {
      const pct = Math.round(c.acceptance.score * 100)
      const meterCls = pct >= 65 ? '' : pct >= 45 ? 'mid' : 'low'
      h += `<div class="proposal${i === 0 && title[0] === 'W' ? ' top' : ''}">
        <div class="deal">
          <div class="give"><span class="lab">You send</span>${c.give.map((p) =>
            `<span>${esc(p.name)} <span class="pos" data-p="${p.pos}">${p.pos}</span></span>`).join('')}</div>
          <div class="arrow">⇄</div>
          <div class="get"><span class="lab">You get</span>${c.get.map((p) =>
            `<span>${esc(p.name)} <span class="pos" data-p="${p.pos}">${p.pos}</span></span>`).join('')}</div>
        </div>
        <div class="stats">
          <div class="stat"><div class="k">Your starters</div>
            <div class="v ${cls(c.myDelta)}">${sign(c.myPerWeek)}${f1(c.myPerWeek)}/wk</div>
            <div class="n">${sign(c.myDelta)}${f1(c.myDelta)} over the season</div></div>
          <div class="stat"><div class="k">Playoff weeks</div>
            <div class="v ${cls(c.myPlayoffDelta)}">${sign(c.myPlayoffDelta)}${f1(c.myPlayoffDelta)}</div></div>
          <div class="stat"><div class="k">They perceive</div>
            <div class="v ${cls(c.marketDelta.them)}">${sign(c.marketDelta.them)}${f1(c.marketDelta.them)}</div>
            <div class="n">on name value</div></div>
          <div class="stat"><div class="k">Truly worth to them</div>
            <div class="v ${cls(c.theirDelta)}">${sign(c.theirDelta)}${f1(c.theirDelta)}</div></div>
          <div class="stat"><div class="k">Fits their lineup</div>
            <div class="v">${Math.round(c.acceptance.fit * 100)}%</div></div>
          <div class="stat"><div class="k">Would they accept</div>
            <div class="v">${pct}%</div>
            <div class="meter ${meterCls}"><i style="width:${pct}%"></i></div></div>
        </div>
        <p class="note" style="margin-top:8px">${esc(c.acceptance.read)}</p>
        <button class="btn" data-load="${i}" data-kind="${title[0]}">Open this in the trade view</button>
      </div>`
    })
    return h
  }

  html += render(r.proposable, 'Worth sending', 'prices out fair to them, gains you real points')
  html += render(r.longshots, 'Longshots', 'better for you, but they will likely refuse')
  html += '</div>'
  box.innerHTML = html

  box.querySelectorAll('[data-load]').forEach((b) => {
    b.onclick = () => {
      const list = b.getAttribute('data-kind') === 'W' ? r.proposable : r.longshots
      const c = list[Number(b.getAttribute('data-load'))]
      if (!c) return
      const opp = selectedOpponent()
      state.B = [...(opp?.players || [])]
      state.nameB = opp?.name || 'Their team'
      $('nameB').value = state.nameB
      state.move = {}
      for (const p of c.give) state.move[p.id] = true
      for (const p of c.get) state.move[p.id] = true
      show('trade')
    }
  })
}

function runFinder() {
  const opp = selectedOpponent()
  if (!opp) { alert('Load a league or a second roster first.'); return }
  const mine = roster('A')
  const theirs = opp.players.map((id) => withStatus(byId.get(id))).filter(Boolean)
  if (!mine.length || !theirs.length) { alert('Both rosters need players.'); return }

  const btn = $('fRun')
  btn.textContent = 'Searching…'
  btn.disabled = true
  // Deferred so the button repaints before the search blocks the thread.
  setTimeout(() => {
    const maxGive = parseInt($('fMaxGive').value, 10) || 2
    const maxGet = parseInt($('fMaxGet').value, 10) || 2
    const shapes = []
    for (let g = 1; g <= maxGive; g++) for (let k = 1; k <= maxGet; k++) shapes.push([g, k])
    try {
      const result = findTrades({
        myRoster: mine, theirRoster: theirs, pack: PACK, cfg: state.cfg, league: engineLeague(),
        opts: {
          shapes,
          untouchable: new Set(state.finder.untouchable),
          targets: new Set(state.finder.targets),
          maxMs: 9000,
        },
      })
      // Stamped with BOTH rosters it was searched over. The opponent alone is not enough:
      // change your own roster and the same proposals are still an answer about players
      // you no longer have.
      result.opponent = opp.label
      result.forA = pairKey(state.A)
      state.finder.result = result
      renderProposals(result)
    } finally {
      btn.textContent = 'Search'
      btn.disabled = false
    }
  }, 30)
}
