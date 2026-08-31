# Trade Desk

A full-PPR fantasy football projection system and a trade evaluator that does the roster math
public analyzers skip.

**Live: [astriondeveloper.github.io/tradedesk](https://astriondeveloper.github.io/tradedesk/)** —
rebuilt from fresh data every six hours.

Or open `dist/tradedesk.html` in a browser. No server, no network, no install — the data is
baked in, including all eight rosters in the league. Either way it opens on your team against
whoever you play this week.

---

## The problem with every trade analyzer

They add up projected points. That is wrong three ways, and this tool treats each one as a
first-class output rather than a caveat.

**Bench points are worth almost nothing.** Measured on the eight rosters actually in this
league, between **36.6% and 43.0%** of a roster's raw projected total never reaches a starting
lineup at any point in the season. Your own roster is the worst of the eight at 43%. Everything
here is denominated in starter points and points above the player you would otherwise start.
Bench depth is priced as insurance — how often a player actually sits outside the lineup, times
how often a reserve at his depth gets called on, times what he beats the streamer by — not at
face value.

The case that makes it concrete. Trading Bijan Robinson for Saquon Barkley plus Breece Hall,
against a roster already deep at running back:

| | point-summing | this tool |
|---|---|---|
| side giving up the RB1 | **+4.86 pts/wk** | **−92.0 pts, season** |
| side giving up two RB2s | −4.86 pts/wk | **+66.3 pts, season** |

Not a difference of degree. The two methods disagree about who won, and the app says so in
words rather than leaving you to notice.

**The same trade is not worth the same to both teams.** Both rosters are evaluated
independently against their own shape. Searching one-for-one swaps across the league's two most
opposite rosters turns up Kyren Williams for Tee Higgins: point-summing calls it a flat +1.79 a
week for everybody, while it is worth **+29.0 over the season to the most back-heavy roster in
the league and −7.6 to the most receiver-heavy one**. One team should accept and the other
should refuse. That is the trade that actually gets accepted, and a summing tool cannot find it.

**Weeks are not equal.** Every remaining week is walked separately, the optimal lineup
re-solved each time with bye-week players simply absent. Bye collisions fall out of the
schedule instead of needing a rule, and the fantasy playoff weeks can be weighted.

And one more the good analyzers still skip: a point estimate hides risk. Because the
projections are distributions, a verdict also reports change in expected wins and playoff odds,
so a trade that raises the mean while lowering the floor says so.

---

## The league it is built for

Eight teams, transcribed off the ESPN matchup pages and shipped with the app. Nine starters —
QB, two RB, two WR, TE, FLEX, D/ST, K — and seven on the bench. Playoff weeks 15/16/17.

| team | manager | | team | manager |
|---|---|---|---|---|
| CMCn MY WAY TO THE CHAMPIONSHIP | Colby Campbell | vs | **Pissed Off** | **Gavin Taylor — you** |
| Zachs team | Zach Bradford | vs | Brennan put BTA | Brennan Meeks |
| Keegan's team | Keegan Verble | vs | Riley's Rowdy Team | Riley Campbell |
| Wastonder The Towel | Dylan Campbell | vs | Njigba B Trippin | Jonathan Preston |

The rosters live in `pipeline/league.json` and are compiled by `pipeline/build_league.py`, which
refuses to write anything it cannot verify. All 127 rostered players resolve to a player in the
data pack, and each one's NFL team is cross-examined against the pack's own schedule: a mistyped
team code shows up as an opponent that does not line up rather than as a roster that looks fine
and prices wrong. Edit the JSON, re-run the build, and every number in the app follows.

Because the whole league is known, replacement level stops being an estimate. The app hands the
engine the set of players somebody owns, and replacement becomes literally the best player on
the waiver wire — the method `replacement.js` always preferred and never had the data for.

Two consequences worth knowing about, both visible on the League tab:

- **Eight teams is a shallow league.** Slot math alone would put replacement at WR22 and RB20.
- **This league hoards running backs.** The actual free-agent bar is WR24 but **RB34** — a
  startable back is far scarcer here than the format implies, and that is the single most
  decision-relevant number in the app.

Anything that happened after the transcription — a waiver claim, a trade, an injury — has to be
edited on the Trade tab or re-transcribed into `league.json`. The app says so on the League tab
rather than letting you assume it keeps up.

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
bench is accounted for. Run from your roster against CMCn MY WAY TO THE CHAMPIONSHIP, the top
result is *give Nico Collins and Drake London, get Trey McBride and Ladd McConkey*: worth
**+4.3 points a week** to you while the other side still reads it as a **gain for themselves**
on name value, and it scores 55% to accept — because consensus rank cannot see that the
receivers being sent are the second and third on a roster that starts two and a flex.

Each candidate reports a **would-they-accept** score built from perceived value (which
dominates), how well the incoming players fit their lineup, and true value (a minor term,
because they cannot see it). Deals split into **worth sending** and **longshots**, and when
nothing clears the bar the app says so rather than manufacturing something.

Search notes: against the real rosters in this league, 4,300 to 7,000 packages get screened on
per-player marginal values, then a stratified shortlist — sampled across bands of perceived
fairness, not just by what helps you most — gets a full exact evaluation. Sampling by strata
matters: ranking on your own gain alone fills the shortlist with mild fleeces and never
evaluates the balanced deals at all. Every rival roster is priced with the injury designations
the league file carries, not at full availability, so a search does not quietly value a
questionable player as healthy just because you have never opened his team.

## Power rankings

Every published power ranking is a sum of a roster wearing a suit, and summing a roster is
the exact mistake this whole tool exists to correct. So the **Power** tab ranks teams on
playoff-weighted **starter** points — the same ledger the trade verdict runs on — and shows
the roster-total ranking beside it, because the disagreement is the interesting part.

On the eight real rosters the two rankings disagree about most of the league:

| | starters | roster total | |
|---|---|---|---|
| Brennan put BTA | **3rd** | 8th | ▲5 — least wasteful shape in the league |
| Wastonder The Towel | **8th** | 4th | ▼4 — 40% of their points never start |
| Pissed Off (you) | **6th** | 5th | ▼1 |

A team the summed ranking has fourth and the starter ranking has eighth is a manager about
to overvalue his own bench in a trade. That is not trivia, it is a price.

**Bench-locked** is the share of a roster its own shape strands, and it is measured *flat* —
no availability on either side of the ratio — deliberately. The rank above it wants expected
points, so an injury-prone star is correctly worth less there. Bench-locked is about a
different failure: a roster four deep at one position and empty at another strands points no
matter how healthy everyone is. Mixing the two bases booked injury risk as wasted bench and
read six points high before it was caught, against a figure `scripts/thesis.mjs` measures
independently.

The **positional map** scores every team at every position as standard deviations from the
league average of starter points above replacement, so "strong at tight end" means something
relative to what the other seven are actually starting there. Shading is a second channel;
the number is always printed.

Not shown, deliberately: expected wins, playoff odds, strength of schedule. The league
carries only the current week's matchups, so there is no remaining schedule to compute them
from, and inventing one would produce numbers that look authoritative and mean nothing.

## Watching a trade you are not in

Two rivals trading changes your season without touching your roster, because standings are
relative. Load any two teams into the panels — you do not have to be one of them — tell the
app which team is yours, and the **League impact** board scores every roster in the league the
same way, before and after.

The number that matters is not their point swing. It is this: **a trade does not conserve
league strength.** Players move to rosters where they actually start, or stop starting, so the
total goes up or down. A deal where both sides gain is the classic good trade, and it is
exactly the case where everyone else just lost ground without being consulted.

The first version of this reported change in your gap to the leader, which was wrong in a way
worth recording: that number is exactly `0.00` unless the leader happens to be one of the two
teams trading, which is most trades. The headline is now the change in the average strength of
the field you have to beat, which moves whenever anything moves. Your rank change is reported
alongside it, because a reshuffle can push a rival past you at constant field strength.

Underneath, **Your openings** reads the aftermath. A trade leaves both sides lopsided — that is
what trades do — so the app scores every roster's shape by position and finds where a rival's
new hole meets your surplus. Fits are ranked on the *smaller* half, because a trade needs both:
your spare receiver is worth nothing to a team already three deep there. This is the actionable
part. The deal you just watched tells you who needs what before they have advertised it.

## The interface

Dark, dense, single-theme, and built to be operated rather than read.

- **Elevation is colour, not shadow.** Deep navy ground at `#080D18`, steel panels at
  `#101827`, raised surfaces at `#1B2536`, separated by 1px hairlines at
  `rgba(255,255,255,0.07)`. There is not one `box-shadow` used for depth in the stylesheet.
- **Dual fonts, enforced.** Inter for anything read as language, JetBrains Mono for every
  number, on tabular figures. Both **embedded as base64 rather than linked**: a webfont link
  fails on `file://`, and the downloaded single file is the copy that goes to a draft on
  hotel wifi.
- **An 8px grid**, telemetry alignment (identity left, numbers right) in roster rows and
  tables alike, and selection as a 2px amber rule rather than a glow.
- **Amber means "look here". Sage and terracotta mean better and worse.** They never mix.

### The diverging pair was measured, not chosen

Muted sage for gains and dusty terracotta for losses is the right instinct and the first
pair that looked correct was unusable. `#7FA88C` / `#C08A76` scored a deuteranope ΔE of
**3.1** and a normal-vision ΔE of **11.2** — desaturating a green and a red moves both
toward the same grey, so a red-green colourblind reader could not have told a gain from a
loss, and nor could anyone else at a glance.

Separating the pair on **lightness** as well as hue is the fix. The shipped values score
deutan **15.5** and normal **20.8**. There are two terracottas, because contrast and
separation pull against each other: the bar fill is the darker step (3.7:1, the correct
floor for a graphical object) and the text ink is a lighter step that clears 4.5:1 on every
surface in the app. And every number carries a `+`/`−` glyph, so direction never rests on
hue at all.

### The instruments

- **Bullet charts, not bars.** "+4.4 a week" means nothing without the thing it is measured
  against, so every bullet carries a reference marker showing what a *naive* read of the
  same trade says — point-summing, or what the other manager perceives from name value. The
  distance between the bar and the marker is this application's entire argument, drawn to
  scale. Zero is a drawn position on a symmetric scale, so direction survives greyscale.
- **Gauges** for acceptance and lineup fit, with a tick at the threshold where a deal
  becomes worth sending, so a bare percentage has a meaning.
- **A funnel** for the screen: packages screened → evaluated exactly → worth sending, on a
  square-root scale, because on a linear one the last step is a single pixel.
- **The exchange matrix** frames what leaves and what arrives as two halves of one
  instrument rather than two lists that happen to sit side by side.
- **The ghosting matrix** treats a trade as a negotiation. It reads the opponent's roster
  *as it would be after the deal*, names the positions your own offer just left them
  exposed at, and predicts which of your players they come back asking for — excluding the
  ones they are sending you, since nobody counters for a player they just traded away.
- **A drill-down drawer** rather than a modal, so the row you clicked and its neighbours
  stay on screen. It itemises the arithmetic — every term, the multiplication, the
  contribution — and totals to the projection in its own header, which a browser check
  asserts.

All of the geometry is a pure function in `instruments.js` and tested there. A chart that
is wrong does not throw; it draws a plausible bar of the wrong length and is believed.

## The league it defaults to
## The scoring
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
- **Quarterbacks compress, confirmed — and eight teams makes it worse.** QB3 to QB14 is 1.49
  points a week, against 4.59 for RB3-to-RB14 and 3.20 for WR3-to-WR14. Fifteen quarterbacks
  are rostered league-wide, so the best one nobody owns is still this model's QB4 at 18.4 a
  game: the best quarterback in the league is worth **1.99** over him, the best receiver
  **9.98**. Paying up at quarterback here is close to setting money on fire.
- **D/ST streaming is genuinely +EV here.** The spread from the best season-long defense to the
  worst is 6.23 points a game. The average best-to-worst swing *within a single defense's own
  season* is 5.85. Matchup moves a defense nearly as much as talent does, which is a
  consequence of stacking both tier tables and is not true in most leagues.
- **Kickers are a tiebreaker, and in this league not even that.** Indoors is worth +0.83 points
  a game after controlling for offense quality (t = 4.30 over 2,716 kicker-games), but the whole
  position spans 1.97 points — and with only eight kickers rostered, the best kicker on the
  board is a free agent. Every kicker in the league is worth zero over replacement.
- **One finding worth acting on:** with a single flex, this scoring fills it with a receiver
  5 times out of 8. But the slot math and the waiver wire disagree, and the waiver wire wins:
  replacement is WR24 and **RB34**. A startable back is the scarce thing in this league,
  because eight managers are sitting on **38** of them — nearly five apiece, for two starting
  slots and a flex.

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

The rosters are a separate problem, and no rebuild fixes them: they are a hand transcription
of week 1, so a waiver claim on Tuesday is not in here until somebody puts it there.

Four ways to deal with what even a morning rebuild cannot know, in order of effort:
1. **Mark a status on the player's row.** Healthy / Questionable / Out / IR. This flows
   through availability into every projection, lineup, and trade verdict immediately, needs
   no network, and is the right tool for news that broke an hour ago. It is disclosed in the
   verdict so a changed number is never unexplained.
2. **Add and drop players on the Trade tab.** Good for one session. The panels hold whatever
   you leave in them, and the team loader puts a league roster back when you want to start
   over.
3. **Edit `pipeline/league.json` and re-run `python3 pipeline/build_league.py`.** A second or
   two. This is the right move once a real transaction has happened, because it fixes the
   roster everywhere — Trade, Propose, replacement level — instead of in one session.
4. **Re-run `python3 pipeline/refresh.py`.** About a minute. Re-fetches only what moves —
   injury reports, the consensus board, depth charts, rosters, last week's box scores, and
   newly posted betting lines — then rebuilds the pack, re-resolves the league against it, and
   rebuilds the bundle. Seven seasons of play-by-play do not change and are left alone.
   Tuesday or Wednesday is the right time, after the injury reports land. Only needed for a
   local copy — the hosted page already runs this for itself.

Importing your ESPN league again also works, and brings ESPN's own injury designations with it.
An import overrides the shipped rosters for as long as it is loaded.

The browser remembers your session, and that remembering is stamped with which league it
belongs to. Rebuild the league and the next visit loads the new rosters instead of quietly
restoring last week's on top of this week's data. Your scoring settings and your injury
overrides survive that, because those are about players rather than about which league is
loaded.

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
- **The rosters are a hand transcription of week 1.** Every name was verified against the pack
  and every NFL team against the schedule, so nobody is the wrong player — but a roster that
  changed after the screenshots were taken is simply not in here until it is re-entered.
- **Replacement level now depends on how this league drafts, not just on its size.** That is
  the more accurate answer, and it is also a more opinionated one: the bar at each position is
  the best unowned player *by this model's ranking*, so a player the model likes more than the
  room does sets it. QB replacement is Spencer Rattler at 18.4 for exactly that reason. The
  League tab names the player behind every position's number so you can judge it.
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
  league.json      the eight real rosters, transcribed by hand
  build_league.py  resolves them against the pack -> app/data/league.js
  bootstrap.py     fetch the large frozen inputs a clean checkout is missing
  refresh.py       re-fetch what moves, rebuild everything

app/css/
  fonts.css        Inter + JetBrains Mono, base64 so the offline build matches the hosted one
  app.css          the design system

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
  scout.js         league board, power rankings, roster shape, openings, ghosting
  instruments.js   bullet charts, gauges, funnels -- pure, tested geometry
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
npm test                          # 317 tests
node scripts/bundle.mjs           # build dist/tradedesk.html
node scripts/verify-browser.mjs   # end-to-end checks, file:// and served over http
node scripts/thesis.mjs           # the three claims, checked against the real rosters
node scripts/league-edges.mjs     # what this scoring format actually does

pip install -r pipeline/requirements.txt
python3 pipeline/bootstrap.py     # fetch everything a clean checkout lacks (~460MB, cached)
python3 pipeline/build_league.py  # re-resolve the rosters -> app/data/league.js
python3 pipeline/sources.py       # fetch source data (~460MB, cached)
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

- **Settings → General → Default branch must be `main`.** Two GitHub rules have to agree and
  neither is visible from a workflow file: scheduled runs fire on the *default* branch only,
  and this repo's `github-pages` environment accepts deployments from `main` only. If those
  disagree, the daily rebuild runs and then cannot publish. `pages.yml` fails loudly with
  that exact message rather than letting you find out by noticing the page is a month old.
- **Settings → Pages → Source: GitHub Actions.** The workflow asks for this itself
  (`configure-pages` with `enablement: true`), so it usually just works. Pages on a *private*
  repo additionally needs a paid plan; on a free account the repo has to be public, or you
  keep using `dist/tradedesk.html` locally, which is the same app with the same data.

A refused deploy is easy to misread: it fails in one second with no runner assigned, no steps
and no logs, which looks like broken infrastructure rather than a wrong setting. The way to
tell them apart is to dispatch the same workflow on `main` and compare.

## Data

- **[nflverse](https://github.com/nflverse)** — play-by-play, weekly box scores, rosters, depth
  charts, injuries, snap counts, schedules. Released under CC-BY-4.0 / MIT depending on the
  dataset.
- **[DynastyProcess](https://github.com/dynastyprocess/data)** — FantasyPros expert consensus
  ranks, scraped daily. MIT.

Every file is fingerprinted into the pack's provenance record, visible on the app's
"How this works" tab. Nothing is fetched at runtime.
