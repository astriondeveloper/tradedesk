# Trade Desk — Architecture & Interface Contract

This document is the **contract**. Every module is written against it. If you change a
shape here, change it here first, then in code.

---

## 0. The thesis

A trade evaluator's accuracy comes from the projections you feed it. The tool's job is the
math you can't do in your head: **converting projections into your roster's context.**

Three things public analyzers get wrong, and what we do instead:

| Their mistake | What we do |
|---|---|
| Sum projected points | Score only what your **optimal starting lineup** produces, week by week |
| One number for both teams | Evaluate **both rosters independently** — same trade, two different answers |
| Treat weeks as equal | Weight **playoff weeks**, model **bye overlap**, respect the real schedule |

And one more the good analyzers still miss: a point estimate hides risk. Every number here
carries a distribution, so a trade reports **Δ expected wins** and **Δ playoff odds**, not
just Δ points.

---

## 1. Data sources

All fetched at build time by `pipeline/`, cached under `pipeline/.cache/`, and compiled to a
single data pack. No runtime network calls — the app is fully offline once built.

| Dataset | Source | Use |
|---|---|---|
| Weekly player component stats, 2019–2025 | nflverse `stats_player_week_{yr}.csv` | usage, efficiency, empirical distributions |
| Weekly team stats, 2019–2025 | nflverse `stats_team_week_{yr}.csv` | team volume, pace, DST components |
| Snap counts, 2019–2025 | nflverse `snap_counts_{yr}.csv` | role / participation |
| Injuries, 2019–2025 | nflverse `injuries_{yr}.csv` | availability priors |
| 2026 Week 1 rosters | nflverse `roster_weekly_2026.csv` | **current team after offseason trades/FA** |
| 2026 depth charts | nflverse `depth_charts_2026.csv` | projected role for movers and rookies |
| Schedules 2019–2026 + betting lines | nfldata `games.csv` | schedule, byes, **spread/total**, roof, surface |
| Expert consensus ranks | DynastyProcess `db_fpecr_latest.csv` | ADP/market anchor, rank SD, bye |

`games.csv` for 2026 ships with **`spread_line` and `total_line` already posted**. That is the
single most valuable input in the whole build:

```
implied_team_total = total_line / 2  −  spread_line / 2
```

The betting market prices team scoring environment better than any homegrown team model, so
we anchor to it rather than competing with it. `roof == "dome"` feeds the kicker adjustment.

> **Blocked source note:** `datafield.dev` (the referenced Chapter 15, "Modeling the NFL") is
> blocked by this environment's egress proxy and could not be read directly. The methodology
> here follows its published scope — nflverse play-by-play, custom efficiency metrics,
> regression-based prediction, and explicit injury adjustment — but is not a transcription of it.

---

## 2. The core design decision: score in the browser

**The pipeline never computes fantasy points.** It emits *component stat lines*; the app
scores them live.

This is what makes "every scoring format" real rather than a marketing claim. Change PPR from
1.0 to 0.5 and every projection, replacement level, VOR, lineup, and trade verdict in the app
re-derives from the same underlying components — instantly, with no rebuild.

---

## 3. Component vocabulary (canonical keys)

Every stat line — historical or projected — uses exactly these keys. Missing key ⇒ 0.

**Passing:** `patt` `pcmp` `pyd` `ptd` `pint` `psack` `p2p` `p40` `pfd`
**Rushing:** `ratt` `ryd` `rtd` `r2p` `r40` `rfd`
**Receiving:** `tgt` `rec` `reyd` `retd` `re2p` `re40` `refd`
**Misc:** `fuml` `sttd`
**Kicking:** `fgm_0_19` `fgm_20_29` `fgm_30_39` `fgm_40_49` `fgm_50_59` `fgm_60`
and the matching misses `fgx_0_19` … `fgx_60`; `xpm` `xpx`
**DST:** `sack` `dint` `fumrec` `safety` `dtd` `blk` `ptsAllowed` `ydsAllowed`

Note `patt` (pass attempts) vs `ptsAllowed` — deliberately disambiguated.

---

## 4. Scoring config schema

```js
{
  id: 'full-ppr', name: 'Full PPR',
  pass: { yd: 0.04, td: 4, int: -2, twoPt: 2, sack: 0, fd: 0, b40: 0, b300: 0, b400: 0 },
  rush: { yd: 0.1,  td: 6, twoPt: 2, fd: 0, b40: 0, b100: 0, b200: 0 },
  rec:  { rec: 1.0, yd: 0.1, td: 6, twoPt: 2, fd: 0, b40: 0, b100: 0, b200: 0,
          recBonusByPos: { TE: 0 } },        // TE premium, additive per reception
  misc: { fumLost: -2, stTd: 6 },
  k:    { fg: { '0_19': 3, '20_29': 3, '30_39': 3, '40_49': 4, '50_59': 5, '60': 6 },
          miss: -1, xp: 1, xpMiss: -1 },
  dst:  { sack: 1, int: 2, fumRec: 2, safety: 2, td: 6, blk: 2, stTd: 6,
          paTiers: [ {max:0,  pts:5}, {max:6,  pts:4}, {max:13, pts:3},
                     {max:17, pts:1}, {max:21, pts:0}, {max:27, pts:0},
                     {max:34, pts:-1},{max:45, pts:-3},{max:1e9, pts:-5} ],
          yaTiers: [ {max:99, pts:5}, {max:199,pts:3}, {max:299,pts:2},
                     {max:349,pts:0}, {max:399,pts:-1},{max:449,pts:-3},
                     {max:499,pts:-5},{max:549,pts:-6},{max:1e9, pts:-7} ] }
}
```

**Default preset is the user's league**, exactly as specified: full PPR, 0.04/4/−2 passing,
0.1 rush+rec yards, 6-point rush/rec TDs, −2 fumble lost, distance FGs 3/4/5/6 with −1 miss
and 1 PAT, DST 1/2/2/2/6, and **both** PA and YA tier stacks. No bonuses enabled anywhere.

**Tier boundaries are inferred, not given.** The user supplied nine payout values per stack
but not the bucket edges; the boundaries above are the standard ESPN cutoffs. They are
surfaced as editable in the UI and flagged in-app so they can be checked against the real
league settings.

---

## 5. Data pack schema (`app/data/pack.js` → `window.TD_PACK`)

```js
{
  meta: { generated, season: 2026, currentWeek, seasonState: 'preseason'|'regular',
          regSeasonWeeks: 18, sources: [...], playerCount, packBytes },

  teams: { KC: { name, bye, div, roofHome } , ... },

  // per team, per week — the scoring environment
  schedule: { KC: [ { w, opp, home, roof, spread, total, implied, oppImplied }, ... ] },

  // defense-vs-position multipliers, regressed to 1.0
  dvp: { KC: { QB, RB, WR, TE, K, DST }, ... },

  players: [ {
    id, name, pos, team, age, exp, bye,
    ecr:  { ov, pos, sd, best, worst, owned },   // market anchor + market uncertainty
    inj:  { missRate, durability, status },      // availability prior
    role: { depth, snapShare, routeShare, tgtShare, rushShare },

    // per-game projection: distribution parameters over components
    proj: { mu: {<component>: n}, sd: {<component>: n}, stack: 'KC-pass' },

    // historical component lines, 2024–2025, for empirical distributions
    // and for showing real production under *this* league's scoring
    log: [ [season, week, opp, <component values in packed order>], ... ]
  } ],

  logKeys: [ ... ]   // component key order for the packed `log` rows
}
```

`log` is packed positionally against `logKeys` to keep the pack small enough to ship inside a
single self-contained HTML file.

---

## 6. Module interfaces

Source is ES modules under `app/js/`. `scripts/bundle.mjs` inlines everything into
`dist/tradedesk.html` for offline use and for artifact publishing.

| File | Exports | Owns |
|---|---|---|
| `scoring.js` | `scoreLine(line, cfg, pos)`, `PRESETS`, `DEFAULT_SCORING` | component → points |
| `lineup.js` | `optimizeLineup(players, slots, ptsOf)` | **exact** optimal lineup |
| `replacement.js` | `computeReplacement(pool, league, ptsOf)`, `vor()` | endogenous replacement level |
| `projections.js` | `project(player, opts)` | weekly / ROS mean + floor/ceiling |
| `sim.js` | `simWeek()`, `simSeason()` | correlated Monte Carlo |
| `trade.js` | `evaluateTrade(input)` | the verdict |
| `draft.js` | `draftBoard(state)` | live VOR/VONA, tiers, runs |
| `ui/*.js` | view modules | rendering only, no math |

### `optimizeLineup` must be exact

Greedy slot-filling (dedicated slots first, then flex from the remainder) is optimal only when
slot eligibility sets are **laminar** — nested or disjoint. It breaks on overlapping flex
definitions, e.g. a `W/T` slot alongside a `R/W` slot, where the greedy pick of a WR for the
first can strand the second. Rosters are tiny (≤ 20 players, ≤ 12 slots), so we solve the
assignment exactly with min-cost bipartite matching (Hungarian). Cost is negligible and the
answer is always right.

### Replacement level is computed, not typed

The prototype asked the user to type a replacement value per position. That is the single
biggest source of garbage-in. Instead:

```
replacement[pos] = projection of the best player at `pos` NOT rostered anywhere in the league
```

derived from league size × starting slots × flex behavior, with the actual free-agent pool
used when league rosters are known. Falls back to the rank-based baseline
`leagueSize × startersAt(pos) + flexShare(pos)` when only two rosters are loaded. Still
user-overridable, but correct by default.

---

## 7. Projection model

Per player, per week, a **distribution** over components — not a point estimate.

```
volume   = team_plays × play_split(pass|rush) × player_share
efficiency = regressed per-opportunity rates
TDs      = f(expected TDs from opportunity), NOT realized TDs
points   = scoreLine(simulated components, league config)
```

1. **Team volume** — plays/game from pace history, pass/rush split from tendency, scaled to the
   **market-implied team total** for that week's game. Vegas sets the scoring environment.
2. **Player share** — target/rush/route share, exponentially recency-weighted across seasons,
   shrunk toward a position-and-depth-chart prior: `share = (n·obs + k·prior)/(n + k)`.
   Players on new teams lean on the 2026 depth chart, which is how offseason trades propagate.
3. **Efficiency** — yards per target regressed toward an aDOT-implied expectation; yards per
   carry regressed hard (YPC is mostly noise at single-season samples); catch rate toward an
   aDOT-implied baseline.
4. **Touchdowns** — the biggest single edge. Project **expected** TDs from red-zone and
   goal-line opportunity plus yardage, then draw from a Poisson. A back who scored 12 on 7
   expected TDs regresses; the market usually hasn't fully priced that.
5. **Opponent (DvP)** — points allowed over expectation by position, regressed to 1.0. A real
   but small effect; overfitting DvP is a classic mistake, so shrinkage is aggressive.
6. **Availability** — per-week probability of playing from injury history, position base rate,
   and age. Feeds the floor, which is where injury risk actually shows up.
7. **Correlation** — QB↔his own pass catchers positively correlated; same-game opponents
   correlated through game total. Independent draws would understate ceiling and overstate
   floor, so stacks are drawn together.

Outputs: `mean`, `p10` (floor), `p50` (median), `p90` (ceiling) — for a given week, for the
rest of season, and for the preseason full-season view.

---

## 8. Trade evaluation

For each side independently:

1. Build rosters before and after.
2. For **every remaining week**: solve the optimal lineup, with players on bye unavailable and
   availability risk applied. Bye overlap is therefore handled structurally, not as a bolt-on.
3. Δ per week = `starterPoints(after, w) − starterPoints(before, w)`.
4. Weight playoff weeks by a configurable multiplier (default: weeks 15–17 count double).
5. Monte Carlo the full remaining season for both rosters against league-average opponents
   → **Δ expected wins** and **Δ playoff odds** with a confidence interval.
6. Report **points above replacement started**, never summed roster points. Bench value is
   counted at its real worth: insurance, priced by how often it enters the lineup, not at face.

This is what makes the two-RB2s-for-one-RB1 case come out right, and why the same trade can be
a win for one roster and a loss for the mirror image of it.

---

## 9. Full-PPR consequences the app should surface

The user's league is full PPR with 4-point passing TDs. That has specific, exploitable effects:

- **Receptions dominate.** A back catching 5 balls is +5 before a single yard. Pass-catching
  RBs and volume slot WRs are systematically underpriced by anyone still valuing in standard.
  The app shows a *reception share of value* so this is visible, not just implied.
- **QBs compress.** 4-point passing TDs and −2 interceptions flatten the position. QB3 → QB14
  is a smaller gap than it looks; the VOR math prices that automatically and should be trusted
  over positional instinct.
- **D/ST matters unusually much.** Stacking *both* points-allowed and yards-allowed tiers means
  a dominant defensive game is worth 8–10 on tiers alone and a bad one goes negative. That makes
  matchup streaming genuinely +EV here, which is not true in most leagues.
- **Kickers in domes.** Distance FGs to 6 points with a −1 miss penalty. Marginal, but a real
  tiebreaker — and `roof` is in the schedule data, so it costs nothing to model.

---

## 10. Honesty rules

The app must never present modeled output as fact.

- Every projection shows its **uncertainty**, not just a mean.
- Anything inferred rather than sourced (DST tier boundaries, replacement level, rookie roles)
  is **labeled as inferred** in the UI.
- The pack records `generated` and every source, and the app displays data age.
- No fabricated player data. If a player is not in the pack, the app says so and accepts a
  manual entry rather than guessing.
