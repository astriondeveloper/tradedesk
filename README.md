# Trade Desk

A full-PPR fantasy football projection system and a trade evaluator that does the roster math
public analyzers skip.

**Live: [astriondeveloper.github.io/tradedesk](https://astriondeveloper.github.io/tradedesk/)** —
rebuilt from fresh data every morning.

Or open `dist/tradedesk.html` in a browser. No server, no network, no install — the data is
baked in.

---

## The problem with every trade analyzer

They add up projected points. That is wrong three ways, and this tool treats each one as a
first-class output rather than a caveat.

**Bench points are worth almost nothing.** Measured on the shipped projections, between 33%
and 35% of a roster's raw projected total never reaches a starting lineup at any point in the
season. Everything here is denominated in starter points and points above the player you would
otherwise start. Bench depth is priced as insurance — how often a player actually sits outside
the lineup, times how often a reserve at his depth gets called on, times what he beats the
streamer by — not at face value.

The case that makes it concrete. Trading Bijan Robinson for Saquon Barkley plus Breece Hall,
against a roster already deep at running back:

| | point-summing | this tool |
|---|---|---|
| side giving up the RB1 | **+4.85 pts/wk** | **−87.3 pts, season** |
| side giving up two RB2s | −4.85 pts/wk | **+91.7 pts, season** |

Not a difference of degree. The two methods disagree about who won, and the app says so in
words rather than leaving you to notice.

**The same trade is not worth the same to both teams.** Both rosters are evaluated
independently against their own shape. Searching one-for-one swaps across two real rosters
turns up Omarion Hampton for DeVonta Smith: point-summing calls it a flat −1.18 a week for
everybody, while it is worth **+48.0 over the season to a back-heavy roster and −39.9 to a
receiver-heavy one**. One team should accept and the other should refuse. That is the trade
that actually gets accepted, and a summing tool cannot find it.

**Weeks are not equal.** Every remaining week is walked separately, the optimal lineup
re-solved each time with bye-week players simply absent. Bye collisions fall out of the
schedule instead of needing a rule, and the fantasy playoff weeks can be weighted.

And one more the good analyzers still skip: a point estimate hides risk. Because the
projections are distributions, a verdict also reports change in expected wins and playoff odds,
so a trade that raises the mean while lowering the floor says so.

---

## Bringing in your real ESPN league

Paste, not fetch, and deliberately so. A private league needs your `espn_s2` and `SWID`
cookies, and a tool that asks for those is a tool you should not use. Your browser already
has them.

1. On the **League** tab, enter your league id (the number in your ESPN URL) and press
   **Build the link**.
2. Open that link in a tab where you are logged into ESPN.
3. Select all of it and paste it back.

What comes across: every team's roster, your exact scoring rules, your starting slots, your
playoff weeks, and ESPN's current injury designations. Scoring is mapped from ESPN's own
published stat ids rather than guessed — and anything the app cannot model is **listed with
its point value** instead of quietly dropped, so you can judge whether it matters. Players
ESPN has that the pack does not are listed too, never silently matched to someone else.

One thing this settled: the D/ST tier boundaries the app previously carried as *inferred*
turn out to match ESPN's own definitions exactly (0 / 1-6 / 7-13 / 14-17 / 18-21 / 22-27 /
28-34 / 35-45 / 46+, and <100 / 100-199 / … / 550+). They are no longer a guess.

## Finding a trade worth sending

The **Propose** tab answers the question the trade evaluator cannot: *what should I actually
offer this person?*

Every package is valued **twice** —

- **Model value:** what it is really worth to each roster, from the week-by-week starter
  math with byes, playoff weeks and replacement level.
- **Market value:** what each side will *perceive* it as worth, from consensus rank measured
  over replacement so it is comparable.

The deal you want is one that prices out even on names and is not even at all once your
bench is accounted for. On two complementary rosters the top result is *give McCaffrey and
Gibbs, get Chase, Higgins and Pitts*: worth **+9.5 points a week** to the back-heavy side
while the other side perceives it as a **small gain for themselves**, because consensus rank
cannot see that the backs being sent were the third and fourth on a roster that starts two.

Each candidate reports a **would-they-accept** score built from perceived value (which
dominates), how well the incoming players fit their lineup, and true value (a minor term,
because they cannot see it). Deals split into **worth sending** and **longshots**, and when
nothing clears the bar the app says so rather than manufacturing something.

Search notes: roughly 37,000 packages get screened on per-player marginal values, then a
stratified shortlist — sampled across bands of perceived fairness, not just by what helps
you most — gets a full exact evaluation. Sampling by strata matters: ranking on your own
gain alone fills the shortlist with mild fleeces and never evaluates the balanced deals at
all.

## The league it defaults to

Full PPR, exactly as configured:

| | |
|---|---|
| Pass yd / TD / INT | 0.04 / 4 / −2 |
| Rush & rec yd | 0.1 |
| Rush & rec TD | 6 |
| Reception | 1.0 |
| Fumble lost | −2 |
| FG by distance | 3 / 4 / 5 / 6, −1 miss, PAT 1 |
| D/ST | sack 1, INT 2, FR 2, safety 2, TD 6 |
| D/ST points allowed | 5 / 4 / 3 / 1 / 0 / 0 / −1 / −3 / −5 |
| D/ST yards allowed | 5 / 3 / 2 / 0 / −1 / −3 / −5 / −6 / −7 |

No bonuses anywhere. Every field is editable and the whole app re-derives live, because the
data pack ships **component stat lines, never fantasy points** — the browser does the scoring.
Switch to standard and Ja'Marr Chase drops out of the top three on the spot.

### What this format actually does, measured

`node scripts/league-edges.mjs` tests the format's reputation rather than repeating it.

- **Receptions supply 31.4% of all RB/WR/TE points.** Trey McBride and Wan'Dale Robinson draw
  over 40% of their value from catches; Derrick Henry draws 11%. Kenneth Gainwell is RB31 here
  and RB44 in standard — that gap is the arbitrage against anyone in the league still valuing
  in standard scoring.
- **Quarterbacks compress, confirmed.** QB3 to QB14 is 1.49 points a week, against 4.59 for
  RB3-to-RB14 and 3.19 for WR3-to-WR14. The best quarterback is worth 3.07 over replacement;
  the best receiver is worth 10.88.
- **D/ST streaming is genuinely +EV here.** The spread from the best season-long defense to the
  worst is 6.23 points a game. The average best-to-worst swing *within a single defense's own
  season* is 5.86. Matchup moves a defense nearly as much as talent does, which is a
  consequence of stacking both tier tables and is not true in most leagues.
- **Kickers are a tiebreaker.** Indoors is worth +0.83 points a game after controlling for
  offense quality (t = 4.30 over 2,716 kicker-games), but the whole position spans under two
  points.
- **One finding worth acting on:** with a single flex, this scoring fills it with a receiver
  10 times out of 12. Replacement is WR35 but only RB27 — a startable receiver is a deeper
  commodity than a startable back.

---

## How the projections are built

Volume × efficiency, anchored to the betting market, reconciled to real team totals.

1. **Team scoring environment from the market.** `implied = total_line/2 ± spread_line/2` from
   posted 2026 lines. Only 112 of 272 games are priced yet, and the fantasy playoff weeks have
   none, so a ridge ratings model fills the rest; held out on completed seasons it lands within
   2.4–3.0 RMSE of the real line against a 3.5–4.0 naive baseline. Every week is tagged
   `market` or `model` and the app shows which.
2. **Usage share**, recency-weighted across seven seasons and shrunk toward role priors
   measured from data, not intuition — WR1 25.4% target share, WR2 18.0%, TE1 16.8%. Players
   who changed teams lean on the 2026 depth chart, which is how offseason trades propagate.
3. **Efficiency**, regressed by how fast each rate stabilizes. Yards per carry is regressed
   several times harder than yards per target, because it is mostly noise at these samples.
4. **Touchdowns from opportunity, not from touchdowns.** An empirical P(TD | yard line) curve
   fitted over 137,303 plays, integrated across each player's actual carries and targets.
   Expected touchdowns predict next season better than realized ones (r = 0.496 vs 0.453) and
   the optimal blend weight fits at **0.765** — measured, not assumed.
5. **Opponent adjustment**, shrunk hard and clamped, because DvP is the classic overfit.
6. **Reconciliation.** Every team's projected players are scaled to sum to that team's
   projected team totals. Receiving yards equal passing yards to within 0.1%.
7. **Market blend.** The consensus board orders players better than an opportunity model does
   while having no opinion on magnitude, so the blend happens in *rank* space and keeps the
   model's calibrated value ladder.

### Backtest

Out-of-sample on 2025 with a strict pre-season information cutoff, 435 players with six or
more games, running the pipeline that actually ships:

| predictor | MAE | RMSE | bias | corr |
|---|---|---|---|---|
| **this model** | **2.628** | **3.694** | −0.494 | **0.778** |
| last year's points per game | 2.878 | 3.742 | +0.733 | 0.774 |
| positional average | 3.998 | 4.947 | 0.000 | 0.449 |

The model wins MAE at every position. Two things to read honestly:

- **The evaluation set favors the baseline.** It only contains players who played six games in
  both years, which is exactly where "what he did last year" works best. The model's advantage
  is larger for rookies, players who changed teams, and players whose role changed — cases
  where the baseline is undefined or misleading.
- **Projections are compressed relative to outcomes, by design.** The player who finishes as
  the top receiver is partly the one who got lucky, so an honest projection of today's top
  receiver sits below what the eventual leader will score. A model whose top projection matched
  the realized top score would be overconfident, not accurate. Bias against *per-team-game*
  production is +0.09, so the residual is survivorship in the evaluation set rather than
  miscalibration.

---

## Does it stay current?

**The hosted page does. A copy you download does not, and it says so on screen.**

The app itself makes no network calls at runtime — it ships a static data pack, so it works
offline, holds no credentials, and cannot break because a feed changed mid-week. Freshness
comes from rebuilding the pack, not from the page phoning home.

So the pack gets rebuilt for you. Every morning at 11:00 UTC, GitHub Actions re-fetches every
volatile source — injury reports, the consensus board, depth charts, rosters, last week's box
scores, newly posted betting lines — refits the projections, verifies the result in a real
browser, and redeploys. Seven seasons of play-by-play do not change and stay cached, which is
what keeps the job to a few minutes instead of half an hour.

Two things about that are worth knowing:

- **A failed refresh does not ship a broken page.** If a feed is down or a schema moved, the
  job falls back to the pack committed in the repo and deploys that. If the browser check
  fails, nothing deploys at all and the previous day's page stays up. Either way the age
  stamp in the header tells the truth rather than the intention.
- **The rebuilt pack is never committed back.** It is 2MB and it changes daily; committing it
  would add roughly 700MB a year of history for something reproducible in a minute.

Three ways to deal with what even a morning rebuild cannot know, in order of effort:

1. **Mark a status on the player's row.** Healthy / Questionable / Out / IR. This flows
   through availability into every projection, lineup, and trade verdict immediately, needs
   no network, and is the right tool for news that broke an hour ago. It is disclosed in the
   verdict so a changed number is never unexplained.
2. **Re-run `python3 pipeline/refresh.py`.** About a minute. Re-fetches only what moves —
   injury reports, the consensus board, depth charts, rosters, last week's box scores, and
   newly posted betting lines — then rebuilds the pack, the demo and the bundle. Seven
   seasons of play-by-play do not change and are left alone. Tuesday or Wednesday is the
   right time, after the injury reports land. Only needed for a local copy — the hosted page
   already runs this for itself.
3. **Import your ESPN league again.** ESPN's own injury designations come across with the
   rosters and seed the status overrides.

The app shows its data age in the header and repeats it above every verdict, turning red
past a week. It will not let you forget how old the numbers are. On the hosted page an age
above a day means the morning rebuild failed, not that it is waiting on you.

## Limitations

Stated plainly, because a projection tool that hides these is worse than no tool.

- **41% of 2026 games have a posted betting line.** The rest, including every fantasy playoff
  week, use the ratings model. The app labels which is which.
- **The D/ST tier boundaries are inferred.** Nine payouts were supplied for each stack but not
  the bucket edges, so the standard ESPN cutoffs are used. They are the only numbers in the
  app that were guessed rather than given or measured, they are editable on the League tab, and
  with both stacks live they are worth several points a week.
- **Preseason depth charts rank whoever takes the most preseason snaps**, which puts camp
  bodies above starters. Players absent from the consensus board are pushed down to compensate,
  but a genuine late-summer job change may still be mispriced.
- **The acceptance score is a judgement, not a probability.** It is calibrated on
  reasoning about how managers value trades, not on a dataset of accepted and rejected
  offers, because no such dataset exists here. Treat it as a ranking, not a forecast.
- **Expected wins and playoff odds assume an opponent.** With none supplied the simulation
  mirrors your own roster and says so on screen.
- **Two source feeds disagree** about a handful of veterans (Diggs, Keenan Allen, Najee Harris
  among them) who appear on the consensus board but not on the 2026 roster file. They are
  carried with their consensus team and flagged rather than dropped or silently trusted.

---

## Layout

```
pipeline/          Python. Fetches, models, and compiles the data pack.
  sources.py       34 datasets, cached and fingerprinted
  components.py    nflverse columns -> canonical components (verified against 57,048 games)
  checks.py        empirical validation of source conventions
  market.py        ridge ratings model anchored to posted lines
  redzone.py       expected touchdowns from play-by-play
  priors.py        role priors measured by depth rank
  calibrate.py     team coefficients fitted from 2019-2025
  model.py         the projection model
  blend.py         consensus-rank blending
  build_pack.py    compiles app/data/pack.js
  backtest.py      out-of-sample evaluation
  sanity.py        face-validity leaderboards
  demo_league.py   generates the demo rosters
  bootstrap.py     fetch the large frozen inputs a clean checkout is missing
  refresh.py       re-fetch what moves, rebuild everything

app/js/            The engines. Plain ES modules, no dependencies.
  scoring.js       components -> points, any format
  lineup.js        exact optimal lineup (Hungarian, not greedy)
  replacement.js   endogenous replacement level
  projections.js   weekly and rest-of-season projections
  sim.js           correlated Monte Carlo
  trade.js         the trade evaluator
  draft.js         live draft board
  espn.js          ESPN league import
  finder.js        trade search + acceptance model
  main.js          UI

scripts/
  bundle.mjs         -> dist/tradedesk.html, self-contained
  verify-browser.mjs  end-to-end check in headless Chromium
  thesis.mjs          proves the three claims against the real data
  league-edges.mjs    measures this format's actual effects

.github/workflows/
  tests.yml           unit tests, sanity, and the browser check on every push
  pages.yml           deploys to Pages; on a schedule, refits from fresh data first
```

## Running it

```bash
npm test                          # 275 tests
node scripts/bundle.mjs           # build dist/tradedesk.html
node scripts/verify-browser.mjs   # 39 end-to-end checks, file:// and served over http
node scripts/thesis.mjs           # the three claims, checked against real projections
node scripts/league-edges.mjs     # what this scoring format actually does

pip install -r pipeline/requirements.txt
python3 pipeline/bootstrap.py     # fetch everything a clean checkout lacks (~460MB, cached)
python3 pipeline/calibrate.py     # refit team coefficients
python3 pipeline/build_pack.py    # rebuild app/data/pack.js
python3 pipeline/backtest.py --season 2025
python3 pipeline/refresh.py       # weekly: refresh volatile data and rebuild
```

Rebuilding the pack needs Python 3.11 with pandas, numpy and pyarrow. The app itself needs
nothing. Run `bootstrap.py` before the first build: the play-by-play and the historical
consensus board are large and frozen, so they sit outside the refresh loop, and without them
the red-zone and market-blend models silently switch themselves off.

## Hosting it

Push to the default branch and `pages.yml` deploys. It serves `app/` as written — real ES
modules, the pack as a separate cacheable file — with the single-file build alongside it at
`/tradedesk.html` for offline use, which the page offers as a download when it notices it is
being served rather than opened.

Two settings are not in the repo and have to be set once, in the GitHub UI:

- **Settings → Pages → Source: GitHub Actions.** The workflow asks for this itself
  (`configure-pages` with `enablement: true`) so it usually just works. **Pages on a private
  repo needs a paid plan**; on a free account, either make the repo public or keep using
  `dist/tradedesk.html` locally, which is the same app with the same data.
- **Settings → General → Default branch.** Only the default branch deploys, and GitHub only
  runs scheduled jobs on the default branch, so the daily refresh follows whatever that is
  set to.

## Data

- **[nflverse](https://github.com/nflverse)** — play-by-play, weekly box scores, rosters, depth
  charts, injuries, snap counts, schedules. Released under CC-BY-4.0 / MIT depending on the
  dataset.
- **[DynastyProcess](https://github.com/dynastyprocess/data)** — FantasyPros expert consensus
  ranks, scraped daily. MIT.

Every file is fingerprinted into the pack's provenance record, visible on the app's
"How this works" tab. Nothing is fetched at runtime.
