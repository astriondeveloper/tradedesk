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

const PACK = window.TD_PACK
const DEMO = window.TD_DEMO || null
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
    teams: 12,
    slots: { ...DEFAULT_LEAGUE.slots },
    playoffWeeks: [...DEFAULT_LEAGUE.playoffWeeks],
    playoffWeight: DEFAULT_LEAGUE.playoffWeight,
  },
  draft: { taken: [], mine: [], pick: 1, next: 22, pos: '' },
  players: { q: '', pos: '', window: 'season', limit: 50, sort: 'pts', dir: -1, open: null },
}

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      nameA: state.nameA, nameB: state.nameB, A: state.A, B: state.B,
      cfg: state.cfg, league: state.league, draft: state.draft,
    }))
  } catch (e) { /* private mode, quota, blocked storage: the session still works */ }
}
function load() {
  try {
    const raw = localStorage.getItem(STORE)
    if (!raw) return
    const s = JSON.parse(raw)
    Object.assign(state, {
      nameA: s.nameA ?? state.nameA,
      nameB: s.nameB ?? state.nameB,
      A: Array.isArray(s.A) ? s.A.filter((id) => byId.has(id)) : [],
      B: Array.isArray(s.B) ? s.B.filter((id) => byId.has(id)) : [],
    })
    if (s.cfg) state.cfg = s.cfg
    if (s.league) state.league = { ...state.league, ...s.league }
    if (s.draft) state.draft = { ...state.draft, ...s.draft }
  } catch (e) { /* corrupt or unavailable storage: fall back to defaults */ }
}

const roster = (side) => state[side].map((id) => byId.get(id)).filter(Boolean)
const ppg = (p, week = null) => playerPPG(p, state.cfg, week)

/* ------------------------------------------------------------------ header */

function renderStamp() {
  const m = PACK.meta
  const cov = m.marketCoverage || {}
  $('stamp').innerHTML =
    `<b>${esc(m.season)} projections</b> · built ${esc((m.generated || '').slice(0, 10))}<br>`
    + `${PACK.players.length} players · ${Math.round((cov.market_share || 0) * 100)}% of games have a posted line`
}

/* ------------------------------------------------------------------ rosters */

function renderRoster(side) {
  const box = $(`rows${side}`)
  const list = roster(side)
  box.innerHTML = ''
  if (!list.length) {
    box.appendChild(el('p', 'empty', 'No players yet. Search above, or load the demo league.'))
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

let replCache = null
let replKey = ''
function currentReplacement() {
  const key = JSON.stringify([state.cfg, state.league.slots, state.league.teams])
  if (key !== replKey) {
    replKey = key
    const d = replacementDetail(PACK.players, state.league, (p) => ppg(p))
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
  $('capA').textContent = `${state.A.length} players`
  $('capB').textContent = `${state.B.length} players`

  const box = $('verdict')
  const A = roster('A')
  const B = roster('B')
  const sendA = A.filter((p) => state.move[p.id])
  const sendB = B.filter((p) => state.move[p.id])

  if (!A.length && !B.length) {
    box.innerHTML = '<p class="empty">Add players to both rosters, then tap the arrows to build a trade.</p>'
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
    league: state.league, nameA: state.nameA, nameB: state.nameB,
    opts: { sim: true, draws: 600 },
  })

  const n = v.weeks.length || 1
  const h = v.headline
  const perWeek = h.perWeekA

  let html = `<div class="headline">
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
        league: state.league, opts: { sim: false },
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

function renderLeague() {
  const c = state.cfg

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
    + '<p class="note">This is the player you would actually start instead, derived from your '
    + 'slots and the pool. It is what turns raw points into value, and it is why a 12-point '
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
      <div class="flag good"><b>Bench points are worth almost nothing.</b> Between a third and
        35% of a roster's raw projected total never reaches a starting lineup. Everything here
        is measured in starter points and in points above the player you would otherwise
        start, and bench depth is priced as insurance rather than at face value.</div>
      <div class="flag good"><b>The same trade is not worth the same to both teams.</b> Both
        rosters are evaluated against their own shape, so a deal can be a gain for one and a
        loss for the other. On this data, Omarion Hampton for DeVonta Smith is worth +48 points
        over a season to a back-heavy roster and ‒40 to a receiver-heavy one, while
        point-summing calls it a flat ‒1.2 a week for everyone.</div>
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
  if (state.view === 'players') renderPlayers()
  if (state.view === 'draft') renderDraft()
  if (state.view === 'league') renderLeague()
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

function loadDemo() {
  if (!DEMO) return
  state.A = DEMO.teamA.players.map((p) => p.id).filter((id) => byId.has(id))
  state.B = DEMO.teamB.players.map((p) => p.id).filter((id) => byId.has(id))
  state.nameA = DEMO.teamA.name
  state.nameB = DEMO.teamB.name
  $('nameA').value = state.nameA
  $('nameB').value = state.nameB
  state.move = {}
  renderTrade()
}

function init() {
  load()
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

  $('loadDemo').onclick = loadDemo
  $('clearTrade').onclick = () => { state.move = {}; renderTrade() }
  $('wipe').onclick = () => {
    state.A = []; state.B = []; state.move = {}
    state.draft = { taken: [], mine: [], pick: 1, next: 22, pos: '' }
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
    state.draft = { taken: [], mine: [], pick: 1, next: 22, pos: '' }
    $('dPick').value = 1
    renderDraft()
    save()
  }

  $('applyLeague').onclick = () => {
    state.league.teams = parseInt($('lTeams').value, 10) || 12
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
      teams: 12, slots: { ...DEFAULT_LEAGUE.slots },
      playoffWeeks: [...DEFAULT_LEAGUE.playoffWeeks],
      playoffWeight: DEFAULT_LEAGUE.playoffWeight,
    }
    replKey = ''
    $('preset').value = 'fullPPR'
    renderLeague()
    renderAll()
    save()
  }

  // Open on the demo if there is nothing saved, so the first screen shows the tool working.
  if (!state.A.length && !state.B.length && DEMO) loadDemo()
  show('trade')
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
else init()
