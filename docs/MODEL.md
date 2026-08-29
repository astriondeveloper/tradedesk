# Projection Model Specification

Implements section 7 of `ARCHITECTURE.md`. Every parameter below has a concrete starting value.
Nothing here changes a schema or an exported name from the contract.

---

## 0. How to read this document

### 0.1 Confidence tags

Every number carries one:

| Tag | Meaning |
|---|---|
| **[M]** | **Measured** in this repo's own cache, this session. Method, sample size, and file are given. Trust it. |
| **[L]** | **Literature.** Well-established outside result. Trust the direction; the magnitude may need a nudge. |
| **[R]** | **Reasoned.** Derived arithmetically from an [M] quantity, but not itself fit. Defensible, not measured. |
| **[G]** | **Guess.** Plausible starting value with no evidence behind it. **Must** be calibrated by the §8 backtest. Do not defend these in the UI. |

There are exactly nine **[G]** values in this document. They are listed together in §11.2 so they can be
found and killed. Everything else is [M], [L], or [R].

### 0.2 Three corrections to the brief's premises

Verify these before writing code. All three were checked against the cache.

**(a) `spread_line` is positive when the HOME team is favored.**
On 2019–2025 REG games: `corr(spread_line, home_score − away_score) = +0.504`; RMSE of home score
against `total/2 + spread/2` is **9.03**, against `total/2 − spread/2` it is **11.37** **[M]**.
The contract's formula `implied = total_line/2 − spread_line/2` is therefore the **away** team's total.

*Fix without touching the contract:* when building `pack.schedule[team][w]`, store the team's own
spread in standard betting convention (negative means favored):

```js
spread = home ? -game.spread_line : +game.spread_line
implied    = total/2 - spread/2      // matches ARCHITECTURE.md §1 verbatim
oppImplied = total/2 + spread/2
```

**(b) Only 112 of 272 2026 games have posted lines, not all 272.** **[M]**

| Week | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 |
|---|--|--|--|--|--|--|--|--|--|--|--|--|--|--|--|--|--|--|
| games | 16 | 16 | 16 | 16 | 15 | 14 | 14 | 14 | 15 | 14 | 13 | 16 | 14 | 15 | 16 | 16 | 16 | 16 |
| lines | 16 | 16 | 16 | 16 | 15 | 14 | 7 | 0 | 1 | 1 | 1 | 5 | 0 | 0 | 0 | 4 | 0 | 0 |

**Weeks 15–17, the weeks the trade evaluator weights double, have zero posted lines.** §1.2 specifies
the ratings model that fills them, validated on 2025 holdout.

**(c) `roof` is null for 43 of the 272 2026 games** **[M]**. Fall back to the home stadium's 2025 roof
value; if the team has no 2025 home game in the cache, use `"outdoors"`.

### 0.3 The ceiling on any weekly model

Regressing team points on the market-implied total, 2019–2025, n = 3,726 team-games **[M]**:

```
points = -0.25 + 1.025 × implied     R² = 0.161     residual SD = 9.12
```

The slope is 1.0 within noise, so **the market is unbiased and cannot be beaten on the level of team
scoring.** It explains 16% of single-game team-scoring variance. That 16% is the ceiling. Everything
this model does beyond anchoring to the line is an attempt to allocate a fixed, market-determined
pie among players. Design accordingly: spend effort on allocation (shares, opportunity, availability),
not on out-predicting the line.

---

## 1. Team volume

### 1.1 The division of labor

The market and team history govern **different quantities**. This resolves the "how much weight does
the market get" question cleanly rather than as a blend:

| Quantity | Owner | Why |
|---|---|---|
| Points scored, and therefore total TDs | **Market, weight 1.0** | Slope on implied is 1.025, intercept −0.25. History adds nothing the line has not priced **[M]** |
| Plays per game | **Team history**, market as a small additive term | Market R² on plays is 0.030 **[M]** |
| Pass/rush split | **Team history**, market as a small additive term | Market R² on pass rate is 0.035 **[M]** |

Do not blend the market and a homegrown team-scoring model. Use the line for the level and history
only for composition.

### 1.2 Implied team total

**Weeks with a posted line:** use it, per §0.2(a).

**Weeks without (7–18 in 2026):** fit an additive offense/defense ratings model **on the posted implied
totals**, so the extrapolation inherits the market's own team ratings rather than competing with them.

```
implied(team, opp, home) = μ + O[team] + D[opp] + H · 1{home}
```

Ridge least squares over the 224 team-games that do have lines, penalty λ = 2 on the O and D terms,
none on μ or H **[M, validated]**.

Holdout validation, 2025: fit on weeks 1–6 lines, predict weeks 7–18 lines **[M]**

| λ | in-sample resid SD | holdout RMSE | vs naive league mean |
|---|---|---|---|
| 1 | 1.39 | **3.08** | 4.12 |
| 2 | ~1.5 | ~3.15 | 4.12 |
| 10 | 2.20 | 3.53 | 4.12 |
| 80 | 2.94 | 3.97 | 4.12 |

A 25% RMSE reduction over the league mean, r = 0.67. Light regularization wins; λ = 2 is the safe
default (λ = 1 is marginally better but fragile with 2026's uneven week coverage).

2026 fit: μ = 23.05, H = **+1.19** implied-total points (a 2.4-point spread home edge), offense-rating
SD 0.97, defense-rating SD 0.57 **[M]**. Note the offense spread is nearly 2× the defense spread. That
is the market telling you defenses matter less than offenses for fantasy scoring environment.

**Honesty requirement (contract §10):** every projection built on a modeled rather than posted line
must be flagged `impliedSource: 'model'` in the pack and labeled in the UI. Carry the holdout RMSE of
**3.1 points** as the uncertainty on those weeks and widen the week's environment variance accordingly
(§8.4).

### 1.3 Plays per game

League baseline, 2019–2025 REG, n = 3,726 team-games **[M]**: mean **62.9**, SD 8.4 (2023–2025: 62.2).

Team pace shrinkage, by variance decomposition (within-team game-to-game variance 66.8, true
between-team-season variance 4.45) **[M]**:

```
k_pace = 15 games          true between-team SD = 2.11 plays/game
```

Year-over-year team pace correlation is only **0.207**; odd/even split-half within a season is **0.378**
**[M]**. Pace is a weak, slowly-identified team trait. Fifteen games of shrinkage is not conservatism,
it is what the variance ratio says.

```
pace[team] = (G · plays_obs + 15 · 62.9) / (G + 15)          G = team games in the EWMA window
plays[w]   = pace[team] + 0.37 · (implied[w] − 22.6)
plays[w]   = clip(plays[w], 55, 72)
```

Slope +0.37 plays per implied point, from `plays ~ gtot + implied`, n = 3,726, R² = 0.030 **[M]**.
Clip bounds are the 0.5th/99.5th percentiles of the observed distribution **[R]**.

### 1.4 Pass/rush split

Work in dropbacks (attempts + sacks), not attempts, because sacks consume a play. League mean dropback
rate **0.5737**, SD across team-games 0.1075 **[M]**.

Team tendency shrinkage (within-team game-to-game variance 0.00994, true between-team-season variance
0.00161) **[M]**:

```
k_passrate = 6.2 games     true between-team SD = 4.0 percentage points
```

Year-over-year team pass-rate correlation **0.450**, split-half **0.582** **[M]**. Pass rate is a
stickier team trait than pace, hence the much smaller k.

Game-script and environment adjustment, from the joint fit `passrate ~ spread_team + total`, n = 3,726,
R² = 0.035 **[M]**:

```
pr_team   = (G · passrate_obs + 6.2 · 0.5737) / (G + 6.2)
passrate  = pr_team + 0.0024 · spread_team + 0.0030 · (total − 46.1)
passrate  = clip(passrate, 0.42, 0.70)
```

`spread_team` is negative when favored, so an underdog passes more. A 7-point dog adds 1.7 points of
pass rate; a 7-point favorite subtracts the same. That is a real but small effect. The 0.0030 total
coefficient adds 1.2 points of pass rate for a 50-point game over a 42-point game.

### 1.5 From plays to team opportunity counts

```
dropbacks = plays × passrate
attempts  = dropbacks × (1 − 0.0697)      // sack rate per dropback, 2023–25 [M]
carries   = plays − dropbacks
```

2023–2025 league team-game means for sanity checks **[M]**: attempts 32.8, carries 26.9, plays 62.2,
sacks suffered 2.46, passing yards 231.6, rushing yards 116.5, passing TDs 1.45, rushing TDs 0.91,
interceptions 0.73, receptions 21.2, targets 31.3.

### 1.6 Reconciling to the market's point total

After shares and efficiency produce per-player yards and expected TDs, the team's offensive TDs must
match the line. Measured **[M]**, n = 3,726:

```
E[offensive TDs] = -0.677 + 0.1378 × implied        R² = 0.146
```

At implied 23.0 that is 2.49 offensive TDs; league mean is 2.43. Rescale every player's `xTD` on the
team by the single factor `E[offensive TDs] / Σ player xTD` before simulating. Apply the same factor
to rush and receiving TDs so the pass/rush TD mix stays where the opportunity model put it.

Do **not** rescale yards to the implied total. Yards and points decouple through field position and
turnovers; the yardage model is already anchored by plays × efficiency.

---

## 2. Player share

### 2.1 Two timescales

The single most important structural finding. Role and skill move at different speeds, and using one
half-life for both is the most common way to get this wrong.

Out-of-sample weighted MSE, grid search over exponential half-life, career-game index, 2019–2025 **[M]**:

| Quantity | n observations | Optimal half-life |
|---|---|---|
| WR target share | 13,976 | **4 games** |
| RB rush share | 8,744 | **3 games** |
| WR catch rate | 11,953 | **24 games** |
| RB yards per carry | 7,194 | **32 games** |

**Use HL = 4 games for all share/role quantities, HL = 24 games for all efficiency quantities.**

The MSE surface is flat near the optimum for the efficiency metrics (24 vs 32 differ by 0.03%), so a
single value of 24 for all of them is safe. The share surface is sharper: HL = 12 is 5% worse than
HL = 4 for target share and 12% worse for rush share. Do not use a long window for shares.

### 2.2 Weighting scheme

Weight game *g*, played *Δ* games ago in the player's own career-game index:

```
w_g = 2 ^ ( -(Δ + OFFSEASON_GAP · seasonsBetween) / HL )

HL           = 4   for shares
HL           = 24  for efficiency
OFFSEASON_GAP = 4  extra games of decay per season boundary       [G-1]
```

`OFFSEASON_GAP = 4` (one share half-life per offseason) is a **guess**. It encodes "a season boundary
costs you as much confidence in a player's role as four games of staleness." Calibrate it in §8 by
splitting the PIT diagnostic on `games since season change`.

Only games where the player was active count toward Δ. A player who missed weeks 3–6 has his week 2
game weighted as if it were one game ago in week 7, not five.

### 2.3 Shrinkage

```
share = ( Σ w_g · N_g  +  k · prior ) / ( Σ w_g · D_g  +  k )
```

`N_g` is the player's targets or carries in game *g*; `D_g` is the **team's** attempts or carries in
that game. `k` is therefore in units of team opportunities, which makes it scoring-format-independent
and directly comparable across positions.

Two regimes, because the right k depends on whether the evidence is current-season or carried over.

**In-season k** (fit by odd/even split-half within season, denominator ≈ 210 team attempts) **[M]**:

| Share | k (team opps) | split-half r | n player-seasons | prior |
|---|---|---|---|---|
| WR target share | **20** | 0.912 | 1,308 | 0.1287 |
| TE target share | **13** | 0.895 | 672 | 0.0968 |
| RB target share | **40** | 0.821 | 816 | 0.0647 |
| RB rush share | **11** | 0.933 | 838 | 0.2923 |
| QB rush share | **25** | 0.767 | 361 | 0.1303 |

**Cross-season k** (fit season Y → season Y+1) **[M]**:

| Share | k, all | k, same team | k, **new team** | r YoY | n |
|---|---|---|---|---|---|
| WR target share | 68 | **64** | **140** | 0.816 | 962 |
| TE target share | 86 | **84** | **124** | 0.806 | 538 |
| RB target share | 148 | **110** | **520** | 0.714 | 612 |
| RB rush share | 78 | **64** | **172** | 0.771 | 617 |

**This table is how offseason moves propagate.** A running back who changed teams gets his *receiving*
role shrunk more than 4× harder than one who stayed (k 520 vs 110), and his rush share 2.7× harder
(172 vs 64). That is not an assumption; it is the measured difference in year-over-year predictability
between movers and stayers, and it falls straight out of the roster join.

**Interpolate between regimes** as current-season evidence accumulates:

```
k = k_cross + (k_in − k_cross) · min(1, G_current / 6)
```

where `G_current` is the player's games played this season, and `k_cross` is the same-team or new-team
column as appropriate. Six games is the crossover **[R]**: the in-season k values were fit at a
~half-season denominator, and six games of a 4-game half-life is 79% of the asymptotic EWMA weight.

The effective EWMA window at HL = 4 has weight `1/(1 − 2^(−1/4)) = 6.29` games, or about 208 team pass
attempts. That matches the ~210-attempt denominator the in-season k values were fit at, which is why
those k values transfer directly to the EWMA form.

### 2.4 Priors from the depth chart

Priors for movers and rookies, from `depth_charts_2026.csv` position rank. Measured as mean share by
season-usage rank within team and position, players with ≥ 6 games, 2019–2025 **[M]**:

| Slot | Target share | SD | Rush share |
|---|---|---|---|
| WR1 | 0.2321 | 0.0429 | 0.011 |
| WR2 | 0.1710 | 0.0444 | 0.007 |
| WR3 | 0.1246 | 0.0406 | 0.006 |
| WR4 | 0.0813 | 0.0416 | 0.006 |
| WR5+ | 0.0514 | 0.0343 | 0.004 |
| TE1 | 0.1504 | 0.0510 | 0.006 |
| TE2 | 0.0722 | 0.0340 | 0.002 |
| TE3+ | 0.0425 | 0.0211 | 0.000 |
| RB1 | 0.0982 | 0.0408 | **0.5285** |
| RB2 | 0.0669 | 0.0389 | **0.2731** |
| RB3 | 0.0342 | 0.0291 | **0.1327** |
| RB4+ | 0.0291 | 0.0247 | **0.0723** |
| QB1 | — | — | 0.1394 (SD 0.069) |

Three rules on top of the table:

1. **Renormalize.** Sum the prior shares across the team's actual 2026 depth chart and divide through
   so target shares sum to 1.0 and rush shares sum to 1.0. The raw table does not sum to 1 because it
   is a per-slot average over teams with different depth-chart shapes.
2. **Rookies get the depth-chart prior with no observation and no discount**, but their `k` is
   irrelevant (no `N`, no `D`), so the projection is purely the prior. Flag `roleSource: 'inferred'`
   per contract §10. Their uncertainty comes from §8.4's prior-only variance inflation, not from a
   shifted mean.
3. **Depth-chart rank is not role.** A pass-catching RB2 and a goal-line RB2 have the same depth rank
   and opposite value in full PPR. Where a 2025 sample exists, the EWMA + shrinkage handles it. Where
   it does not (true rookie), split the RB prior by draft capital if available and otherwise accept
   the average and let the ECR blend (§9) carry the signal. ECR knows about rookie roles; this model
   does not.

---

## 3. Efficiency

### 3.1 Regress toward the aDOT-implied expectation, not the league mean

Fit on 2023–2025 play-by-play, n = 51,105 targets with non-null air yards **[M]**:

```
catchRate(aDOT) = 1 / (1 + exp(-(1.2981 - 0.06480 · aDOT)))

E[YPT | aDOT]   = 5.2476 + 0.33920 · aDOT - 0.0030230 · aDOT²

E[YAC | rec]    = 5.986 - 0.1349 · aDOT
```

| aDOT | catch rate | E[YPT] |
|---|---|---|
| −3 | 0.816 | 4.20 |
| 0 | 0.786 | 5.25 |
| 3 | 0.751 | 6.24 |
| 6 | 0.713 | 7.17 |
| 9 | 0.671 | 8.06 |
| 12 | 0.627 | 8.88 |
| 15 | 0.581 | 9.65 |
| 20 | 0.501 | 10.82 |
| 25 | 0.420 | 11.84 |

This is why aDOT is the right thing to model and catch rate is not. Catch rate at a fixed aDOT is
nearly all noise; catch rate *across* aDOT is nearly all deterministic. Independent confirmation:
catch rate versus target depth has R² above 0.95 in published work **[L]**
([PFF](https://www.pff.com/news/depth-and-passer-adjusted-catch-rates)).

Procedure per receiver:

1. Estimate `aDOT` by the EWMA + shrinkage of §2.2/§3.2. aDOT is the *most* stable receiving trait
   (cross-season r = 0.651, k = 50 targets) **[M]** — it is where the receiver-specific signal actually
   lives.
2. Compute baseline `catchRate` and `E[YPT]` from the curves above.
3. Shrink the player's **residual** above baseline, not the raw rate, with the k values in §3.2.

In full PPR this ordering matters more than usual. Reception count is 1.0 points each and is driven
entirely by targets × catch rate, so a receiver's aDOT is a first-order fantasy input, not a
descriptive footnote. A 6-aDOT slot receiver converts targets to points at 0.713 rec + 7.17 yd =
**1.43 pts/target**; a 15-aDOT boundary receiver at 0.581 rec + 9.65 yd = **1.55 pts/target**. Close.
Then note the 15-aDOT receiver needs ~15% more team pass attempts to see the same target count,
because deep routes take longer to develop and appear less often. This is the mechanism behind the
contract's claim that volume slot WRs are underpriced in full PPR.

### 3.2 Shrinkage constants

All fit by the same split-half / cross-season MSE minimization. `k` is in per-opportunity units
(targets, carries, attempts) **[M]**.

| Rate | k in-season | k cross-season | split-half r | cross-season r | league prior |
|---|---|---|---|---|---|
| WR yards/target | 170 | **240** | 0.202 | 0.269 | 8.18 |
| TE yards/target | 160 | 160 (use in-season) | 0.175 | — | 7.49 |
| RB yards/target | 170 | 170 | 0.120 | — | 5.91 |
| WR catch rate | 78 | **102** | 0.327 | 0.450 | 0.6401 |
| TE catch rate | 80 | 80 | 0.309 | — | 0.6986 |
| **RB catch rate** | **1020** | **1020** | **0.032** | — | 0.7822 |
| WR aDOT | 18 | **50** | 0.680 | 0.651 | 10.69 |
| TE aDOT | 35 | 35 | 0.479 | — | 7.13 |
| WR YAC/reception | 41 | 41 | 0.457 | — | 4.37 |
| RB YAC/reception | 96 | 96 | 0.190 | — | 7.91 |
| **RB yards/carry** | **310** | **520** | **0.272** | **0.270** | 4.36 |
| QB yards/carry | 64 | 64 | 0.372 | — | 5.10 |
| QB yards/attempt | 220 | 220 | 0.440 | — | 7.17 |
| QB completion rate | 280 | 280 | 0.371 | — | 0.6489 |
| QB TD/attempt | 350 | 350 | 0.325 | — | 0.0456 |
| **QB INT/attempt** | **1960** | **1960** | **0.102** | — | 0.0207 |

Bolded rows are the ones where the answer is effectively "there is no player signal, use the prior."
RB catch rate and QB interception rate are noise. Do not let the UI imply otherwise.

### 3.3 YPC versus YPT, stated precisely

The brief asked for the well-established result that YPC is noisier than YPT. It reproduces here, and
the honest version is more useful than the folk version.

**Per opportunity, YPC is 2.2× noisier than YPT.** k = 520 carries versus k = 240 targets
cross-season **[M]**. Equivalently, half the weight goes to the player's own observation only after
520 carries (about 2.7 workhorse seasons) versus 240 targets (about 2 target-hog seasons).

Decomposing into true talent spread **[M]**, using play-level SD from 2023–2025 pbp:

| | play-level SD | k | implied true between-player SD | as % of mean |
|---|---|---|---|---|
| Yards per target | 9.60 | 240 | **0.62 yd/target** | 7.6% of 8.18 |
| Yards per carry | 6.18 | 520 | **0.27 yd/carry** | 6.3% of 4.36 |

The true talent spread is comparable in percentage terms. What differs is the noise floor per
opportunity: a single target carries 9.6 yards of noise around a 0.62-yard talent signal. YPC is
worse still.

Published confirmation **[L]**: year-over-year YPC correlation for backs with 100+ carries in
consecutive seasons is under 0.30, R² ≈ 0.11
([Footballguys](https://www.footballguys.com/article/HarstadRegression02?article=HarstadRegression02),
[PFF](https://www.pff.com/news/fantasy-football-different-ways-to-look-at-yards-per-carry)). Our
cross-season measurement is r = 0.270 **[M]**, in agreement.

**Practical consequence for the implementer:** a back coming off 5.4 YPC on 250 carries projects to
`(250 × 5.4 + 520 × 4.36) / 770 = 4.70`. He keeps a third of his edge. A receiver coming off 10.5 YPT
on 120 targets projects to `(120 × 10.5 + 240 × 8.18) / 360 = 8.95`. Neither keeps most of it. If your
projections show a back at 5.2 YPC, you have a bug.

---

## 4. Touchdowns

### 4.1 Expected TDs from field position

Fit logistic models to 2023–2025 REG plays, n = 45,894 rushes and 51,105 targets **[M]**. Features:
`[1, log(yardline_100), log(yardline_100)², 1{yl≤5}, 1{yl≤2}]`.

```
rush xTD coefficients: [ 0.1914, -0.6914, -0.1885,  0.1068, -0.0248]
pass xTD coefficients: [-0.0248,  0.3842, -0.3807,  0.0514,  0.0738]
```

Resulting per-opportunity TD probabilities **[M]**:

| yardline_100 | rush TD / carry | pass TD / target |
|---|---|---|
| 1 | 0.568 | 0.525 |
| 2 | 0.426 | 0.546 |
| 3 | 0.334 | 0.497 |
| 5 | 0.214 | 0.416 |
| 8 | 0.113 | 0.295 |
| 12 | 0.064 | 0.195 |
| 20 | 0.027 | 0.092 |
| 35 | 0.010 | 0.030 |
| 60 | 0.003 | 0.008 |
| 85 | 0.001 | 0.003 |

League overall: 0.0340 TD per carry, 0.0465 TD per target **[M]**.

Aggregate calibration is excellent: `Σ actual TD / Σ xTD` = **1.020** for rushing and **1.070** for
receiving over 2023–2025 **[M]**. The receiving figure being above 1.0 reflects a small systematic
under-prediction near the goal line; multiply receiving xTD by 1.07 or refit with an interaction. Do
not attribute the 7% to any player.

Per-player xTD requires a red-zone opportunity distribution. Two paths:

- **Preferred:** compute each player's EWMA-weighted share of the team's carries and targets *within
  each yardline bucket* from pbp (2023–2025 is cached). Buckets: 1, 2, 3, 4, 5, 6–7, 8–10, 11–15,
  16–20, 21–30, 31–50, 51–100. Then `xTD = Σ_bucket (projected team opportunities in bucket) ×
  (player share in bucket) × p(bucket)`.
- **Fallback** where pbp is unavailable: use the player's overall share for all buckets and scale by a
  red-zone-role multiplier from depth chart position. This throws away most of the model's edge. Use
  it only for players with no 2023–2025 pbp history.

The team's per-bucket opportunity counts scale with the implied total via §1.6.

### 4.2 Touchdowns over expected are not a skill

The strongest single result in this document. Split-half within season, players with ≥ 1.0 xTD in each
half, 2023–2025 **[M]**:

| | n player-seasons | split-half r of (TD / xTD) | best k | MSE at best k | MSE at k = ∞ (pure xTD) | MSE at k = 0 (raw ratio) |
|---|---|---|---|---|---|---|
| Rushing | 160 | **−0.139** | ≥ 60 | 2.5276 | **2.5149** | 7.0715 |
| Receiving | 308 | **+0.136** | ≥ 60 | 1.9992 | **2.0005** | 4.4191 |

The grid search ran out of room at k = 60 and the MSE at k = ∞ is indistinguishable from the best k.
Using the raw observed TD-over-expected ratio is **2.2× to 2.8× worse in MSE than ignoring it
entirely.** Split-half correlation of the ratio is −0.14 for rushing.

```
TDOE_k = 50 (in xTD units), toward a ratio of 1.0
```

At a typical full-season 6.1 rush xTD, that is 11% weight on the player's own conversion rate and 89%
on the expectation **[M]**. Setting k = ∞ costs nothing measurable; k = 50 is a hedge against the
possibility that the effect exists and this sample is too small to see it (n = 160 and n = 308).

At the *rate* level with a full prior season, expected TD rate does beat actual TD rate for receiving
(both-model regression coefficients: actual 0.182, expected 0.369, so 67% weight on expected **[M]**),
which matches published touchdown-regression work **[L]**
([Sharp Football](https://www.sharpfootballanalysis.com/fantasy/nfl-red-zone-stats-expectations-running-backs/)).
For rushing the split was closer (actual 0.420, expected 0.306, n = 79) but the R² of both is 0.37, so
the difference is inside the noise.

**This is the model's advertised edge (contract §7.4), and it is real.** A back who scored 12 on 7.0
expected projects to `7.0 × ((12/7.0 · 7.0) + 50 · 1.0) / (7.0 + 50) = 7.0 × 1.088 = 7.6`, not 12. He
keeps 0.6 of his 5.0-touchdown surplus.

### 4.3 The count distribution: binomial, not Poisson, and definitely not negative binomial

Conditional on xTD, per-game TD counts are **under-dispersed relative to Poisson** **[M]**:

| xTD bucket | rush n | rush var/mean | rec n | rec var/mean |
|---|---|---|---|---|
| 0.00–0.10 | 784 | 1.04 | 1,893 | 0.95 |
| 0.10–0.20 | 670 | 0.95 | 1,853 | 0.98 |
| 0.20–0.30 | 364 | 0.94 | 1,019 | 0.83 |
| 0.30–0.50 | 448 | 0.73 | 1,282 | 0.75 |
| 0.50–0.75 | 512 | 0.61 | 965 | 0.61 |
| 0.75–1.00 | 226 | 0.60 | 302 | 0.69 |
| 1.00–1.50 | 269 | 0.59 | 171 | 0.59 |
| 1.50–3.00 | 98 | 0.54 | 43 | 0.81 |

Poisson has var/mean = 1 by construction. Negative binomial has var/mean > 1. **Both are wrong in the
same direction, and negative binomial is wrong by more.** At λ = 1.2 a Poisson overstates the TD
variance by 70%.

The reason is structural, and knowing it makes the fix obvious. A player's touchdowns in a game are a
sum of independent Bernoulli trials with heterogeneous small probabilities, one per opportunity. That
is a Poisson-binomial, whose variance is `Σ pᵢ(1 − pᵢ) = λ − Σpᵢ²`, strictly less than λ. Poisson is
the limit as every pᵢ → 0, which is exactly wrong for a back with three carries from the 2.

Folk wisdom says NFL touchdown counts are overdispersed, and marginally they are **[L]**. That
overdispersion lives entirely in the *opportunity* variation, not in the conversion. If you simulate
opportunities first and then convert, you must not add it again.

**Specification:**

- **Preferred.** In the simulation, draw the player's opportunities *by yardline bucket*, then draw an
  independent Bernoulli per opportunity at that bucket's `p`. This is exact and needs no distribution
  choice at all. It is also the only way to get the RB1/RB2 goal-line competition right, since the
  bucket opportunity counts are competing shares of a fixed team total.
- **Fallback closed form.** Given λ = xTD for the week:

```js
if (lambda < 0.20) {
  td = poisson(lambda);                    // difference from binomial is under 2% of the SD here
} else {
  const n = Math.max(1, Math.round(lambda / 0.35));
  td = binomial(n, lambda / n);            // var/mean = 1 - lambda/n ≈ 0.65
}
```

`p̄ = 0.35` **[R]**, back-solved from `var/mean ≈ 1 − p̄` in the λ > 0.5 rows of the table above. This
reproduces var/mean = 0.60 at λ = 1.19 (measured 0.59) and 0.69 at λ = 0.62 (measured 0.61). It
slightly *understates* dispersion for 0.20 < λ < 0.40; that is acceptable because the opportunity
draw supplies the missing variance.

Marginal dispersion is restored by drawing the opportunity counts with their own overdispersion (§8.2),
which the measured `var/mean` for weekly opportunity counts confirms is where it belongs: WR targets
1.25, RB carries 2.24, QB attempts 2.10 **[M]**.

---

## 5. Defense versus position

### 5.1 The effect is small. Here is exactly how small.

True between-defense SD of the season fantasy-points-allowed ratio, after removing sampling noise by
variance decomposition, 2019–2025 **[M]**:

| Position | split-half r (odd/even weeks) | observed season-ratio SD | **true between-defense SD** | implied k |
|---|---|---|---|---|
| QB | 0.223 | 0.141 | **0.084** | 31 games |
| RB | 0.338 | 0.148 | **0.102** | 18 games |
| WR | 0.058 | 0.117 | **0.060** | 47 games |
| TE | 0.126 | 0.187 | **0.098** | 43 games |

Predictive slope of an observed ratio onto future outcomes **[M]**:

| Position | wk 1–4 → rest | wk 1–8 → rest | wk 1–12 → rest | season Y → Y+1 |
|---|---|---|---|---|
| QB | 0.120 | 0.128 | 0.097 | 0.181 |
| RB | 0.113 | 0.276 | 0.399 | 0.334 |
| WR | 0.072 | 0.122 | 0.162 | 0.185 |
| TE | 0.099 | 0.140 | 0.136 | 0.150 |

Independent confirmation **[L]**: published year-over-year fantasy-points-allowed correlations top out
around 0.27 for QB, and within-season first-12-games to game-13 relationships are weaker still
([Yahoo](https://sports.yahoo.com/article/fantasy-football-do-defenses-repeat-performances-year-over-year-142331371.html)).

### 5.2 Formula

```
raw[d][p]  = ( Σ_games FP allowed by d to position p ) / ( Σ_games league-mean FP to p that season )
dvp[d][p]  = 1 + β[p] · ( raw[d][p] − 1 )
dvp[d][p]  = clip(dvp[d][p], CAP_LO[p], CAP_HI[p])
```

The `raw` denominator must be the league mean **over the same games**, not the season average, so bye
weeks and short weeks do not bias it.

| Position | β in-season (≥ 8 games) | β preseason (last year's ratio) | cap |
|---|---|---|---|
| QB | **0.13** | 0.18 | [0.92, 1.08] |
| RB | **0.30** | 0.33 | [0.88, 1.12] |
| WR | **0.12** | 0.19 | [0.92, 1.08] |
| TE | **0.15** | 0.15 | [0.92, 1.08] |
| K | **0.10** | 0.10 | [0.94, 1.06] **[G-2]** |
| DST | **0.35** | 0.35 | [0.85, 1.15] **[R]** |

β values are the measured slopes from §5.1, rounded down slightly. With fewer than 8 team games of
current-season data, use the preseason column applied to the prior season's ratio, blending linearly
to the in-season value at 8 games.

The DST β is higher **[R]** because a DST's fantasy production is driven by the *opponent offense*,
which the market already rates directly. Prefer deriving the DST matchup from `oppImplied` rather than
from a DvP ratio; §10.2.

### 5.3 What the caps are for, and where not to apply DvP

**The caps are bug detectors, not model parameters.** Work it through for WR: observed season-ratio SD
is 0.117, β is 0.12, so the applied multiplier has SD `0.117 × 0.12 = 0.014`. A 1σ matchup is worth
**±1.4%** on a WR's projection. A 2σ matchup is ±2.8%. The [0.92, 1.08] cap is a 5.7σ event. If your
computed dvp values ever range wider than 0.94 to 1.06 for WRs, you have a data error, not an insight.

For a 14-point-per-game WR that 1σ matchup is 0.20 fantasy points. It will never change a lineup
decision and should never be the headline of a UI card.

**Apply DvP only to efficiency and TD terms. Never to volume.**

Team volume in §1 is set by the team's own pace and the market-implied total. The implied total is
`total/2 ± spread/2`, and the market built both numbers knowing who the opponent is. Multiplying
volume by a DvP factor double-counts the defense. This is the single easiest way to corrupt an
otherwise sound model, and it is invisible in a point estimate.

Concretely: `yards = volume × efficiency × dvp[opp][pos]`, and `xTD = xTD_base × dvp[opp][pos]`, with
volume untouched.

---

## 6. Availability

### 6.1 Base rates

Definition of active: appears in `stats_player_week` **or** has `offense_snaps > 0` in `snap_counts`.
Using the stat-row alone undercounts activity by 8% (40,330 stat rows versus 44,033 snap-active
player-weeks, 2019–2025) **[M]**. Universe is fantasy-relevant players (top 32 QB / 48 RB / 72 WR /
32 TE by season opportunity), 2019–2025 **[M]**:

| Position | n player-seasons | **per-game miss prob** | mean games missed | P(0 missed) | P(≥3 missed) | E[missed \| ≥1] |
|---|---|---|---|---|---|---|
| QB | 224 | **0.145** | 2.42 | 0.362 | 0.397 | 3.80 |
| RB | 336 | **0.110** | 1.84 | 0.369 | 0.298 | 2.91 |
| TE | 224 | **0.103** | 1.72 | 0.397 | 0.241 | 2.86 |
| WR | 504 | **0.094** | 1.58 | 0.413 | 0.228 | 2.69 |
| K | — | **0.060** **[G-3]** | — | — | — | — |
| DST | — | **0.000** | — | — | — | — |

The QB rate is high because QB absence includes benching, not only injury. For fantasy availability
that is correct.

Kicker base rate is a **guess**. Kickers cannot be ranked by opportunity in the same way, so the
universe definition breaks. Measure it directly from `fg_att + pat_att > 0` before shipping.

Independent confirmation **[L]**: published estimates put a typical NFL player at roughly 14.2 healthy
games of 16, and running backs above receivers in both frequency and duration of absence
([ProFootballLogic](https://www.profootballlogic.com/articles/nfl-injury-rate-analysis/),
[Apex](https://apexfantasyleagues.com/more-injury-prone-wide-receivers-running-backs/)). Our 14.9 of
17 for WR and 15.2 of 17 for RB are consistent.

### 6.2 Injury history is nearly worthless. Do not build a durability model.

Year-over-year correlation of games missed, within position, 2019–2025 **[M]**:

| Position | n | r | E[missed next \| 0 last year] | E[missed next \| ≥3 last year] |
|---|---|---|---|---|
| QB | 139 | +0.081 | 1.76 | 2.68 |
| RB | 188 | **−0.063** | 2.18 | 2.06 |
| WR | 292 | +0.083 | 1.75 | 2.04 |
| TE | 132 | +0.044 | 1.84 | 1.91 |

For running backs the sign is *negative*. A back who missed three or more games last year misses
slightly fewer this year than one who played all 17. The "injury-prone" label does not survive contact
with the data at these sample sizes.

The gap between the two conditioning columns is 0.29 games (WR) to 0.92 (QB), against a conditioning
variable that differs by roughly 3 games. That is a regression weight of 0.10 to 0.30 **[M-derived]**.

```
w_history = 0.15
```

Take 0.15, the midpoint, and hold it **[R]**. Anything larger is fitting noise, and the UI should
never show a "durability" score with more resolution than this weight supports.

### 6.3 Per-week probability of playing

```
missRate = clip( base[pos]
                 + 0.15 · (priorMissPerGame − base[pos])
                 + 0.010 · max(0, age − 28),
                 0.02, 0.45 )

p_play = 1 − missRate
```

`priorMissPerGame` is the EWMA of the player's own missed-game indicator over the last two seasons at
the efficiency half-life (24 games), not the share half-life.

Age slope 0.010 per year above 28 **[M-derived]** from pooled RB+WR+TE games missed by age bucket:

| Age bucket | n | mean games missed | P(0 missed) |
|---|---|---|---|
| 20–23 | 109 | 1.66 | 0.413 |
| 23–25 | 233 | 1.53 | 0.416 |
| 25–27 | 228 | 1.70 | 0.333 |
| 27–29 | 142 | 1.68 | 0.345 |
| 29–31 | 77 | 2.09 | 0.377 |
| 31+ | 50 | 2.62 | 0.300 |

Flat to 28, then roughly +0.2 games per year, which is +0.012 per game. Round to 0.010. There is no
detectable age effect below 28 and none should be modeled.

### 6.4 In-season status override

When `injuries_2026.csv` carries a current designation, it overrides the base rate. Measured P(active)
by report status, fantasy positions, 2019–2025 **[M]**:

| Report status | n | P(active) |
|---|---|---|
| Out | 2,267 | **0.000** |
| Doubtful | 362 | **0.011** |
| Questionable | 2,947 | **0.624** |
| Listed, no designation | 6,250 | **0.888** |

Questionable by position **[M]**: QB 0.426 (n=242), RB 0.585 (n=776), TE 0.673 (n=556), WR 0.661
(n=1,373). Use the position-specific values, not the pooled 0.624. The commonly cited "Questionable
means 75%" is too optimistic **[L, and contradicted here]**.

Refine with practice participation **[M]**, Questionable only: DNP 0.412 (n=468), Limited 0.643
(n=1,886), Full 0.733 (n=546).

A player who is Questionable and does play runs at **92.2%** of his own season-average opportunity
count **[M]**. Apply that as a multiplicative haircut on volume in the branches where he plays. Do not
apply it to efficiency.

### 6.5 How availability enters the simulation

Availability is a Bernoulli gate on the whole week, drawn **before** anything else and **independently
per player**, then the components are drawn conditional on playing.

```
if (!bernoulli(p_play)) { all components = 0; }
```

Two consequences the implementer must not lose:

1. **The mean deflates by 9–15%.** Full-season per-game expectation including zeros is `p_play × μ`.
   Measured mean deflation from missed games: QB 0.938×, RB 0.882×, WR 0.882×, TE 0.824× **[M]**.
   Report `mean` in the pack **including** the availability gate, since that is what a roster actually
   receives. Report the conditional-on-playing mean separately if the UI wants a "when healthy" number,
   and label it.
2. **The p10 floor is where this shows up, exactly as the contract says.** For a player with
   `p_play = 0.90`, the 10th percentile of the weekly distribution is at or near zero regardless of how
   good he is. That is correct and it is the reason the floor is worth computing. Do not smooth it away.

Injury gates are drawn independently across players. They are *not* part of the correlation structure
in §7. Correlated injury (an offensive line collapse, a QB injury tanking his receivers) is real but
second-order and unmeasured here; leave it out rather than guess.

---

## 7. Correlation structure

### 7.1 What actually correlates

Measured on within-player-season standardized weekly full-PPR points, 2019–2025, players with ≥ 8
games, slots assigned by season opportunity rank within team **[M]**. Standardizing within
player-season removes cross-player heterogeneity, which is what makes these the correct numbers to
target in a simulation that already conditions on projected means.

**Same team** (n = 2,400–3,200 team-games per pair):

| Pair | r |
|---|---|
| QB1 × WR1 | **+0.344** |
| QB1 × WR2 | +0.301 |
| QB1 × WR3 | +0.241 |
| QB1 × TE1 | **+0.255** |
| QB1 × RB1 | **+0.066** |
| QB1 × RB2 | +0.071 |
| RB1 × RB2 | −0.011 |
| RB1 × WR1 | **−0.031** |
| WR1 × WR2 | +0.009 |
| WR1 × TE1 | +0.011 |
| WR2 × TE1 | −0.013 |

**Opposing teams:**

| Pair | r |
|---|---|
| QB1 × opp QB1 | **+0.172** |
| QB1 × opp WR2 | +0.097 |
| QB1 × opp WR1 | +0.084 |
| WR1 × opp WR1 | **+0.070** |
| TE1 × opp WR2 | +0.061 |
| WR1 × opp TE1 | +0.054 |
| RB1 × opp QB1 | +0.037 |
| RB1 × opp RB1 | **−0.078** |

Two things worth internalizing before implementing:

- **WR1 × WR2 on the same team is +0.01, not positive-and-large.** The shared passing environment
  pushes them together; target competition pulls them apart; the two nearly cancel. Any implementation
  that imposes a positive same-team pass-catcher correlation is wrong.
- **RB1 versus his own QB is +0.07, essentially zero, not negative.** The folk claim of a negative
  RB–QB correlation is not supported here. RB1 × own WR1 is −0.03 and RB1 × *opposing* RB1 is −0.08,
  which is the real game-script signature: when one team runs, the other passes.

Widely cited DFS figures put QB–WR1 near 0.47 **[L]**. Those are computed on salary-filtered slate
subsets without within-player standardization and are not the right target for this simulator. Use the
table above.

### 7.2 Induce it structurally, not by imposing a matrix

Do not build a 20×20 correlation matrix over players and Cholesky it. It will not be positive definite
after edits, it will not survive a roster change, and it will silently break the share-competition
structure that produces the WR1 × WR2 ≈ 0 result.

Instead use a small Gaussian copula over **environment factors**, and let share competition do the rest:

```
Z_G                     game factor, one per game
Z_T[home], Z_T[away]    team pass-environment factors
Z_R[home], Z_R[away]    team rush-environment factors
```

Correlation matrix over `(Z_T[h], Z_R[h], Z_T[a], Z_R[a])`, with `Z_G` implicit as the shared component:

```
            Z_T[h]   Z_R[h]   Z_T[a]   Z_R[a]
Z_T[h]       1.00     0.10     0.40    -0.05
Z_R[h]       0.10     1.00    -0.05    -0.15
Z_T[a]       0.40    -0.05     1.00     0.10
Z_R[a]      -0.05    -0.15     0.10     1.00
```

Cholesky-factor this 4×4 once at module load (it is constant), draw four standard normals per
game per simulation, and multiply.

Apply the team factors as lognormal multipliers on team totals:

```
passMult[t] = exp( SIGMA_T · Z_T[t] − SIGMA_T² / 2 )     applied to team pass yards and pass TDs
rushMult[t] = exp( SIGMA_R · Z_R[t] − SIGMA_R² / 2 )     applied to team rush yards and rush TDs

SIGMA_T = 0.30
SIGMA_R = 0.30
```

### 7.3 Why these exact numbers

`SIGMA_T = 0.30` is **[M]**, not tuned. Residual SD of team passing yards after regressing on
`implied` and `oppImplied` is 69.7 on a mean of 232, a coefficient of variation of **0.30**.

The implied QB–WR1 correlation falls out with no free parameter. If both load fully on the team pass
factor:

```
corr(QB1, WR1) = SIGMA_T² / (cv_QB · cv_WR1)
```

Measured weekly coefficient of variation from §8.1: a QB at μ = 16 has SD 7.3, cv = 0.46. A WR1 at
μ = 14 has SD 8.1, cv = 0.58.

```
0.30² / (0.46 × 0.58) = 0.09 / 0.267 = 0.337
```

Measured QB1 × WR1 is **0.344**. The structural model reproduces it to within 0.007 with no fudge
factor. That is the strongest available evidence that the factor decomposition is the right shape.

`ρ(Z_T[h], Z_T[a]) = 0.40` is **[R]**, back-solved the same way:

```
corr(QB1, opp QB1) = ρ · SIGMA_T² / cv_QB² = ρ × 0.09 / 0.2116 = 0.425 ρ
```

Setting that equal to the measured 0.172 gives ρ = 0.405. Round to 0.40.

`ρ(Z_R[h], Z_R[a]) = −0.15` **[R]** targets the measured RB1 × opp RB1 = −0.078; the same arithmetic
with `cv_RB ≈ 0.55` gives `ρ × 0.09 / 0.3025 = −0.078` → ρ = −0.26. Use −0.15 as a conservative value
since the RB1 slot is noisier than QB1 and the estimate is less reliable. **[G-4]** on the exact value;
the sign and order of magnitude are [M].

`ρ(Z_T, Z_R)` within team = +0.10 and cross team = −0.05 are **[G-5]**, chosen to reproduce the small
positive QB1 × RB1 (+0.066) and the near-zero RB1 × opp WR1 (+0.018). Verify in the §8 backtest via
diagnostic (e).

### 7.4 Shares are drawn, not correlated

Within a team and simulation, draw the player share vector from a Dirichlet whose concentration
reproduces the game-to-game share variance:

```
alpha_i = share_i · C
C_targets = 30     C_carries = 12       [R]
```

`C` is chosen so that `sd(share_i) = sqrt(share_i(1−share_i)/(C+1))` matches the measured game-level
share dispersion. For a WR1 at 0.232 target share, `C = 30` gives SD 0.0757; the measured game-to-game
target share SD around a player's own season mean is ~0.07 **[M-derived from var/mean = 1.25 on 6.0
targets/game]**. Carries are more concentrated per game (var/mean 2.24) so `C` is lower.

The Dirichlet produces mild negative share correlations automatically. Combined with the shared
`passMult`, this yields WR1 × WR2 near zero and RB1 × RB2 slightly negative, matching §7.1, with no
explicit pairwise parameter.

**Goal-line shares must be drawn from their own Dirichlet**, separately from overall shares, or the
RB1/RB2 touchdown competition disappears and both backs' ceilings inflate.

### 7.5 Simulation order per game

```
1. draw Z_T[h], Z_R[h], Z_T[a], Z_R[a]           (Cholesky of the 4×4)
2. for each team:
     draw team plays, pass rate  -> attempts, carries (§1)
     apply passMult / rushMult   -> team yard and TD budgets (§1.6, §7.2)
     draw target-share vector    (Dirichlet, C = 30)
     draw carry-share vector     (Dirichlet, C = 12)
     draw goal-line share vector (Dirichlet, C = 8)
3. for each player:
     availability gate (§6.5)  -- independent
     opportunities  = team opportunities x drawn share  (overdispersed count, §8.2)
     receptions     = binomial(targets, catchRate)
     yards          = opportunities x efficiency draw   (§8.2)
     touchdowns     = binomial(n, p) per §4.3
4. score with scoreLine(components, cfg, pos)
```

Everything downstream of step 1 is conditionally independent given the factors. That is what makes the
simulation both correct and fast.

---

## 8. Variance and calibration

### 8.1 The target

Measured weekly full-PPR points SD as a function of the player's own mean, players with ≥ 10 games,
2019–2025, games played only **[M]**:

| Position | n | SD(μ) | SD at μ=10 | SD at μ=15 | SD at μ=20 |
|---|---|---|---|---|---|
| QB | 219 | **5.89 + 0.092 μ** | 6.8 | 7.3 | 7.7 |
| RB | 589 | **2.50 + 0.371 μ** | 6.2 | 8.1 | 9.9 |
| WR | 957 | **2.20 + 0.422 μ** | 6.4 | 8.5 | 10.6 |
| TE | 466 | **1.70 + 0.464 μ** | 6.3 | 8.7 | 11.0 |

QB weekly variance is nearly independent of skill: the good QB and the bad QB both have about a
7-point weekly SD. That is a large part of why the position compresses in this scoring (contract §9).

Standardized weekly residual quantiles, pooled within player-season **[M]**:

| Position | p5 | p10 | p25 | p50 | p75 | p90 | p95 | skew | excess kurtosis |
|---|---|---|---|---|---|---|---|---|---|
| QB | −1.56 | **−1.22** | −0.70 | −0.04 | +0.68 | **+1.29** | +1.63 | +0.10 | −0.38 |
| RB | −1.22 | **−1.03** | −0.70 | −0.25 | +0.57 | **+1.44** | +1.92 | +0.87 | +0.30 |
| WR | −1.22 | **−1.03** | −0.70 | −0.25 | +0.56 | **+1.41** | +1.92 | +0.86 | +0.39 |
| TE | −1.22 | **−1.03** | −0.72 | −0.20 | +0.55 | **+1.41** | +1.93 | +0.84 | +0.25 |
| *Normal reference* | *−1.64* | *−1.28* | *−0.67* | *0* | *+0.67* | *+1.28* | *+1.64* | *0* | *0* |

**Skill-position weekly scoring is strongly right-skewed and a Normal is not an acceptable
approximation.** The true p10 is −1.03σ, not −1.28σ; a Normal floor is 24% too low. The true p90 is
+1.41σ, not +1.28σ; a Normal ceiling is 9% too low. Median sits at −0.24σ.

Do **not** fit a skew-normal or a lognormal to weekly points. Simulate the components per §7.5 and use
this table as the **acceptance test**. The skew emerges naturally from the TD Bernoullis and the
overdispersed opportunity counts. If the simulated quantiles come out symmetric, the TD model is wrong.

### 8.2 Per-component dispersion

Measured median within-player-season variance-to-mean ratio and coefficient of variation for weekly
counts, players with ≥ 10 games **[M]**:

| Component | position | n | var/mean | cv | mean |
|---|---|---|---|---|---|
| targets | WR | 640 | **1.25** | 0.466 | 6.0 |
| targets | TE | 335 | **1.08** | 0.531 | 4.3 |
| targets | RB | 309 | **1.29** | 0.630 | 3.5 |
| carries | RB | 355 | **2.24** | 0.432 | 12.1 |
| attempts | QB | 213 | **2.10** | 0.254 | 32.1 |

Opportunity counts are **over**-dispersed. This is the layer that supplies the marginal overdispersion
that §4.3 removed from the TD draw. Draw them as negative binomial with the measured var/mean:

```js
// negative binomial with mean m and variance ratio phi
function drawOpportunities(m, phi) {
  if (phi <= 1.001) return poisson(m);
  const r = m / (phi - 1);
  const p = 1 / phi;
  return negBinomial(r, p);            // mean m, variance m*phi
}
PHI = { WR_targets: 1.25, TE_targets: 1.08, RB_targets: 1.29,
        RB_carries: 2.24, QB_attempts: 2.10, QB_carries: 1.6 };  // QB_carries is [G-6]
```

Note the ordering: the Dirichlet share draw already contributes dispersion. Draw the share first, then
the count with the *residual* phi. As a starting point use `phi_residual = max(1.0, phi − 0.25)` for
targets and `max(1.0, phi − 0.6)` for carries **[G-7]**, and let the §8.3 backtest set them. The
symptom of getting this wrong is a U-shaped PIT histogram.

Per-opportunity yardage dispersion **[M]**, 2023–2025 pbp: yards per target SD **9.60** on a mean of
7.40; yards per carry SD **6.18** on a mean of 4.33. Simulate yards as
`sum of n iid draws`, or equivalently `Normal(n·μ, sqrt(n)·σ)` for n ≥ 8, with a lognormal or gamma
for small n so the right tail survives. Yards per target is heavily right-skewed at the play level
(most targets are 0 yards; completions have a long tail), so a Normal is only acceptable in aggregate.

### 8.3 The backtest procedure, exactly

Run this before the pack ships. It is the only thing that makes the p10 an honest number.

**Setup.** 2025 is a complete season in the cache with posted lines for every week. Replay it.

```
for w in 5..17:
    freeze inputs to: all seasons <= 2024, plus 2025 weeks 1..w-1
    use the ACTUAL posted line for the 2025 week-w game (games.csv has it)
    project every player with a non-zero projected opportunity
    simulate N = 4000 draws -> empirical CDF F_hat of weekly full-PPR points
    record u = F_hat(actual points)     [randomized PIT at the atom at 0]
```

Weeks 1–4 are excluded because the in-season share estimate has no current-season data and the
preseason regime is tested separately in step 6.

Randomized PIT at zero: if the actual score is 0 and the simulated `P(X = 0) = q`, draw
`u ~ Uniform(0, q)`. Without this the PIT histogram spikes at 0 for reasons that are not
miscalibration.

**Diagnostics.** With 13 weeks × roughly 250 relevant players, n ≈ 3,000–15,000 depending on the
opportunity filter. Binomial standard error on a 0.10 coverage estimate at n = 10,000 is 0.0030.

| # | Check | Pass band |
|---|---|---|
| a | `mean(u < 0.10)` overall | 0.10 ± 0.010 |
| b | `mean(u < q)` for q ∈ {0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95}, **by position** | each within ±0.020 |
| c | Same, **by projection decile** | each within ±0.030 |
| d | Slope of actual on projected mean, by position | 1.00 ± 0.10, intercept within ±1.0 pt |
| e | For each team-game with ≥ 3 projected pass catchers: ratio of simulated `Var(sum)` to realized `Var(sum)` across the season | 0.90–1.10 |
| f | Lineup-level: sample 200 random 12-team-league rosters, solve the optimal lineup per week with `optimizeLineup`, PIT of the realized starter total | `mean(u < 0.10)` = 0.10 ± 0.015 |
| g | Zero mass: simulated `P(points < 1)` versus observed | within ±0.02 |
| h | CRPS by position, versus two benchmarks: (i) position-mean constant, (ii) `Normal(μ_model, σ_empirical)` from §8.1 | must beat both |

Diagnostic **f** is the one that matters. The trade evaluator scores optimal lineups, not individual
players, and lineup totals are where correlation misspecification and availability errors compound.
A model can pass (a) through (d) and fail (f).

Diagnostic **h(ii)** is the real test of whether the component simulation earns its complexity. If the
full component sim does not beat a Normal with the right mean and the empirically-known SD, simplify.

### 8.4 What to do when it fails

Fix in this order. Re-run the whole backtest after each step; do not tune two knobs at once.

1. **Zero mass wrong (g fails).** Availability, not variance. Adjust `base[pos]` in §6.1 or the
   Questionable conversion in §6.4. Nothing else can produce this signature.
2. **PIT U-shaped, too many extremes (a, b fail symmetrically).** Variance too small. Apply a single
   global scalar `s` to every component SD, chosen so the observed p10 coverage hits 0.10. Then, only
   if a position still fails (b), apply a per-position scalar.
3. **PIT hump-shaped, too few extremes.** Same fix with `s < 1`. Most likely cause is over-shrinking
   efficiency; check §3.2 k values against the position that fails.
4. **PIT left-skewed, too much mass at low u (too many bad outcomes).** The floor is too high. Usual
   cause is the `phi` residual split in §8.2 being too generous to the Dirichlet. Raise `phi_residual`.
5. **Marginals pass, sums under-dispersed (e < 0.90).** Correlation too low. Raise `SIGMA_T` in
   increments of 0.02. Raise `ρ(Z_T[h], Z_T[a])` only if the *cross-team* sums are also under-dispersed.
6. **Marginals pass, sums over-dispersed (e > 1.10).** Lower `SIGMA_T`. Check first that you are not
   applying the team multiplier twice (once to yards and once to TDs *and* again through the §1.6
   rescale).
7. **Preseason regime.** Repeat the whole procedure with the freeze at "end of 2024, nothing from
   2025," projecting all 17 weeks of 2025 at once. Expect materially worse calibration. This is what
   tunes `OFFSEASON_GAP` [G-1] and the cross-season k values, and it is the regime the app actually
   ships in for 2026 week 1.

**Never fix a calibration failure by moving `μ`.** If diagnostic (d) fails, the mean is wrong and you
fix the mean. If (d) passes and (a)/(b) fail, the mean is right and the dispersion is wrong. Conflating
them produces a model that is well-calibrated on average and wrong for everyone.

---

## 9. Blending with the ECR market anchor

### 9.1 Make the two commensurate first

ECR is a rank. The model produces points. Blending them requires a rank-to-points map, and it must be
built from realized outcomes, not from the model's own output (which would make the blend circular).

Build `rankToPPG[pos][rank]` by, for each season 2019–2025, ranking players at each position by
realized full-PPR points per team-game (zeros for missed games included) and averaging across seasons
at each rank. Smooth with a monotone fit. This gives "what does the player who finishes as WR12
actually score," which is what a rank means.

Then `ecrPPG = rankToPPG[pos][round(ecr_pos)]`, and blend in points space:

```
mu_final = (1 − w) · mu_model + w · ecrPPG
```

Blend the **mean only**. The market's rank SD feeds the weight and the UI. It does not feed the
simulation dispersion, which is calibrated in §8 against realized outcomes and already includes
whatever uncertainty is real.

### 9.2 The weight

```
w = w_pos · (0.40 + 0.60 · k_m / (k_m + n_eff)) · d_sd
k_m = 12 games
```

`n_eff` is the player's EWMA-weighted game count at the share half-life, so a rookie has `n_eff = 0`
and gets `w = w_pos · d_sd`, while a 40-game veteran gets `w = w_pos · 0.54 · d_sd`. The 0.40 floor
means the market never fully disappears; it knows about training camp, holdouts, and scheme changes
that no historical model can see.

Base weights **[R]**, anchored on how well a purely historical model can do at each position.
Prior-season points-per-game predicting next-season points-per-game, players with ≥ 8 games both
seasons, 2019–2025 **[M]**:

| Position | n | r | R² | slope | residual SD | **w_pos** |
|---|---|---|---|---|---|---|
| QB | 157 | 0.542 | 0.294 | 0.520 | 3.45 | **0.45** |
| RB | 401 | 0.730 | 0.532 | 0.746 | 3.81 | **0.35** |
| WR | 650 | 0.783 | 0.614 | 0.795 | 3.28 | **0.30** |
| TE | 339 | 0.755 | 0.570 | 0.784 | 2.60 | **0.35** |
| K | — | — | — | — | — | **0.70** |
| DST | — | — | — | — | — | **0.65** |

`w_pos` is inversely ordered with the model's demonstrated predictive power. WR is where history works
best (R² 0.61), so the market gets the least. QB is where it works worst (R² 0.29, and the slope of
0.52 means half of last year's QB edge evaporates), so the market gets the most among skill positions.
K and DST have almost no stable player-level signal, so let the market lead and spend the modeling
effort elsewhere.

These R² values are inflated by survivorship: they condition on playing ≥ 8 games in both seasons. The
true out-of-sample task includes players who got hurt or lost their job, where ECR is comparatively
better informed. That is another reason the market floor is 0.40 rather than 0.

Published comparison **[L]**: season-long projections achieved R² = 0.53 against actuals versus R² =
0.27 for expert rankings and 0.23 for crowd rankings
([Fantasy Football Analytics](https://fantasyfootballanalytics.net/2016/04/accuracy-of-rankings-vs-projections.html)).
That is the case for the model getting more than half the weight for veterans. It is *not* a case for
ignoring ECR, because that study's pool included players whose historical sample was thin or absent.

### 9.3 Down-weighting the market where experts disagree

The ECR file carries `sd`, `best`, and `worst` per player. High disagreement means the consensus is a
midpoint of incompatible views, not a confident estimate.

Reference `sd` by ECR band, from the 2026-08-28 redraft-overall scrape, n = 510 **[M]**:

| ECR band | n | median sd | sd / ecr |
|---|---|---|---|
| 1–12 | 10 | 1.4 | 0.271 |
| 13–24 | 9 | 5.7 | 0.319 |
| 25–48 | 24 | 7.8 | 0.208 |
| 49–84 | 34 | 11.8 | 0.175 |
| 85–150 | 60 | 16.1 | 0.141 |
| 151+ | 373 | 29.0 | 0.101 |

```
d_sd = clip( 1 / (1 + 0.5 · (sd_player / sd_ref(ecr) − 1)), 0.60, 1.40 )
```

`sd_ref` is a log-linear interpolation of the table. The 0.5 coefficient **[G-8]** halves the
sensitivity so a player at 2× the typical disagreement gets `d_sd = 0.67` rather than 0.5.

Median positional `sd` for context **[M]**: WR 28.8, TE 23.7, RB 21.5, QB 18.1, K 26.1, DST 30.9. Note
that WR carries the highest expert disagreement and also the position where the model does best. Those
two facts point the same way, which is reassuring.

### 9.4 Movers, rookies, and disagreement flags

```
w = 0.65   for a player with zero 2026 games AND (rookie OR changed teams)   [R]
```

The model is running on a depth-chart prior alone for these players (§2.4). ECR incorporates beat
reporting, camp usage, and draft capital that this pipeline never sees. Decay `w` toward the §9.2
formula as `n_eff` accumulates.

**Disagreement flag.** When `|mu_model − ecrPPG|` exceeds 2.0 points per game, do not silently split
the difference. Blend as normal, and set `flag: 'model-market-divergence'` on the player so the UI can
surface it per contract §10. These are the model's actual bets. The user should see them, not have
them averaged into invisibility.

The touchdown-regression cases from §4.2 are exactly where this fires, and they are the ones worth
showing.

---

## 10. Kicker and DST

Brief, because these are not in the brief's nine questions, but the pack schema requires `proj` for
them and the league's scoring makes DST unusually valuable (contract §9).

### 10.1 Kicker

FG and PAT attempts scale with the team's implied total; make rate rather than opportunity the
regressed quantity. League baseline per team-game **[R, from 2023–25 team scoring]**: about 2.0 FG
attempts and 2.4 PAT attempts at a 23-point implied total, moving roughly +0.06 FG attempts and
+0.16 PAT attempts per implied point.

Distance mix drives the payout under 3/4/5/6 scoring, so simulate the FG distance bucket, not just
the make. Use the league distance mix from `fg_made_*` / `fg_missed_*` columns, adjusted by roof:
dome games run slightly longer average attempts and higher make rates. 52 of the 2026 games are domes
**[M]**. Regress individual kicker accuracy hard; kicker FG% is among the least stable rates in the
sport and the sample per season is under 35 attempts.

### 10.2 DST

Per team-game baselines, 2023–2025 **[M]**: sacks 2.44 (SD 1.79, var/mean 1.32), interceptions 0.73
(SD 0.87, var/mean 1.04), opponent fumble recoveries 0.50 (SD 0.71), defensive TDs 0.062, safeties
0.027, points allowed 22.6 (SD 9.9), net yards allowed about 330 (SD 80). Correlation between points
allowed and yards allowed is **+0.593** **[M]**.

Because this league stacks **both** the PA and YA tiers, that 0.59 correlation is the whole game. The
two tier stacks are not independent bonuses; a shutout usually comes with a low yardage total, so the
good outcomes compound and the bad ones compound. Simulate points allowed and yards allowed **jointly**
with r = 0.59, never independently. Independent draws will understate both the ceiling and the floor
and will make DST streaming look less valuable than it is.

Drive DST projection from `oppImplied`, not from a DvP-style ratio. The market has already priced the
opponent offense; that is the dominant term.

Sacks and interceptions are overdispersed (var/mean 1.32 and 1.04), so negative binomial for sacks,
Poisson for interceptions is adequate.

---

## 11. Parameter reference

### 11.1 Everything in one place

```js
// ---- §1 team volume -----------------------------------------------------
LEAGUE_PLAYS_PER_GAME  = 62.9;   // [M]
K_PACE                 = 15;     // games                              [M]
PLAYS_PER_IMPLIED_PT   = 0.37;   // [M]
PLAYS_CLIP             = [55, 72];                                  // [R]
LEAGUE_PASS_RATE       = 0.5737; // dropbacks / plays                   [M]
K_PASSRATE             = 6.2;    // games                              [M]
PASSRATE_PER_SPREAD_PT = 0.0024; // spread_team, neg = favored          [M]
PASSRATE_PER_TOTAL_PT  = 0.0030; // vs total = 46.1                     [M]
PASSRATE_CLIP          = [0.42, 0.70];                              // [R]
SACK_RATE_PER_DROPBACK = 0.0697; // [M]
TEAM_TD_INTERCEPT      = -0.677; // E[offTD] = a + b*implied            [M]
TEAM_TD_SLOPE          = 0.1378; // [M]
RATINGS_RIDGE_LAMBDA   = 2;      // holdout-validated                   [M]
MODELED_IMPLIED_RMSE   = 3.1;    // pts, weeks with no posted line      [M]

// ---- §2 shares ----------------------------------------------------------
HL_SHARE      = 4;    // games                                          [M]
HL_EFFICIENCY = 24;   // games                                          [M]
OFFSEASON_GAP = 4;    // extra games of decay per season boundary  [G-1]
K_SHARE_IN    = { WR_tgt: 20, TE_tgt: 13, RB_tgt: 40,
                  RB_rush: 11, QB_rush: 25 };                        // [M]
K_SHARE_XSEAS = { WR_tgt: {same:  64, moved: 140},
                  TE_tgt: {same:  84, moved: 124},
                  RB_tgt: {same: 110, moved: 520},
                  RB_rush:{same:  64, moved: 172} };                 // [M]
K_CROSSOVER_GAMES = 6;                                               // [R]

// ---- §3 efficiency ------------------------------------------------------
CATCH_RATE_A = 1.2981;  CATCH_RATE_B = -0.06480;                     // [M]
YPT_C0 = 5.2476; YPT_C1 = 0.33920; YPT_C2 = -0.0030230;              // [M]
YAC_C0 = 5.986;  YAC_C1 = -0.1349;                                   // [M]
K_EFF = { WR_ypt: 240, TE_ypt: 160, RB_ypt: 170,
          WR_catch: 102, TE_catch: 80, RB_catch: 1020,
          WR_adot: 50, TE_adot: 35,
          WR_yac: 41, RB_yac: 96,
          RB_ypc: 520, QB_ypc: 64,
          QB_ypa: 220, QB_cmp: 280, QB_ptd: 350, QB_int: 1960 };     // [M]

// ---- §4 touchdowns ------------------------------------------------------
XTD_RUSH_COEF = [ 0.1914, -0.6914, -0.1885,  0.1068, -0.0248];       // [M]
XTD_PASS_COEF = [-0.0248,  0.3842, -0.3807,  0.0514,  0.0738];       // [M]
XTD_PASS_CALIBRATION = 1.07;                                         // [M]
K_TDOE = 50;    // xTD units, toward ratio 1.0                        [M]
TD_PBAR = 0.35; // binomial trials = round(lambda / TD_PBAR)          [R]
TD_POISSON_THRESHOLD = 0.20;                                         // [R]

// ---- §5 DvP -------------------------------------------------------------
DVP_BETA_IN  = { QB: 0.13, RB: 0.30, WR: 0.12, TE: 0.15,
                 K: 0.10, DST: 0.35 };                        // [M], K [G-2]
DVP_BETA_PRE = { QB: 0.18, RB: 0.33, WR: 0.19, TE: 0.15,
                 K: 0.10, DST: 0.35 };                               // [M]
DVP_CAP = { QB:[0.92,1.08], RB:[0.88,1.12], WR:[0.92,1.08],
            TE:[0.92,1.08], K:[0.94,1.06], DST:[0.85,1.15] };        // [R]
// applies to efficiency and xTD ONLY, never to volume

// ---- §6 availability ----------------------------------------------------
MISS_BASE  = { QB: 0.145, RB: 0.110, TE: 0.103, WR: 0.094,
               K: 0.060, DST: 0.0 };                          // [M], K [G-3]
W_INJ_HISTORY = 0.15;                                                // [R]
AGE_SLOPE     = 0.010;  AGE_KNEE = 28;                               // [M]
MISS_CLIP     = [0.02, 0.45];                                        // [R]
P_PLAY_STATUS = { Out: 0.0, Doubtful: 0.011,
                  Questionable: { QB:0.426, RB:0.585, TE:0.673, WR:0.661 },
                  Listed: 0.888 };                                   // [M]
Q_PRACTICE_MULT = { DNP: 0.412/0.624, LIMITED: 0.643/0.624,
                    FULL: 0.733/0.624 };                             // [M]
Q_PLAYED_VOLUME_HAIRCUT = 0.922;                                     // [M]

// ---- §7 correlation -----------------------------------------------------
SIGMA_T = 0.30;  SIGMA_R = 0.30;                                     // [M]
RHO = { TT_cross: 0.40, RR_cross: -0.15, TR_within: 0.10,
        TR_cross: -0.05 };                     // [R], RR [G-4], TR [G-5]
DIRICHLET_C = { targets: 30, carries: 12, goalline: 8 };             // [R]

// ---- §8 variance --------------------------------------------------------
FP_SD = { QB:[5.89,0.092], RB:[2.50,0.371],
          WR:[2.20,0.422], TE:[1.70,0.464] };  // sd = a + b*mu        [M]
PHI = { WR_tgt:1.25, TE_tgt:1.08, RB_tgt:1.29,
        RB_car:2.24, QB_att:2.10, QB_car:1.6 };         // [M], QB_car [G-6]
PHI_RESIDUAL_OFFSET = { targets: 0.25, carries: 0.60 };            // [G-7]
YPT_PLAY_SD = 9.60;   YPC_PLAY_SD = 6.18;                            // [M]

// ---- §9 market blend ----------------------------------------------------
W_POS = { QB:0.45, RB:0.35, WR:0.30, TE:0.35, K:0.70, DST:0.65 };     // [R]
K_MARKET = 12;   MARKET_FLOOR = 0.40;                                // [R]
W_NEW_PLAYER = 0.65;                                                 // [R]
D_SD_SENSITIVITY = 0.5;  D_SD_CLIP = [0.60, 1.40];                 // [G-8]
DIVERGENCE_FLAG_PPG = 2.0;                                         // [G-9]
```

### 11.2 The nine guesses

These have no evidence behind them. Calibrate every one against §8.3 before trusting any of them, and
do not defend them in the UI.

| ID | Parameter | Value | How to calibrate |
|---|---|---|---|
| G-1 | `OFFSEASON_GAP` | 4 games | §8.4 step 7, preseason regime; split PIT by season-boundary distance |
| G-2 | `DVP_BETA_IN.K` | 0.10 | Refit §5.1 with kicker fantasy points allowed |
| G-3 | `MISS_BASE.K` | 0.060 | Redefine the kicker universe by `fg_att + pat_att > 0` and remeasure §6.1 |
| G-4 | `RHO.RR_cross` | −0.15 | Diagnostic (e) restricted to opposing-team RB pairs |
| G-5 | `RHO.TR_within` / `TR_cross` | +0.10 / −0.05 | Diagnostic (e); target QB1×RB1 = +0.066 |
| G-6 | `PHI.QB_car` | 1.6 | Direct measurement, same method as §8.2 |
| G-7 | `PHI_RESIDUAL_OFFSET` | 0.25 / 0.60 | §8.4 step 2; symptom is a U-shaped PIT |
| G-8 | `D_SD_SENSITIVITY` | 0.5 | Requires a season of held-out ECR; not calibratable from this cache |
| G-9 | `DIVERGENCE_FLAG_PPG` | 2.0 | Product decision, not statistical. Tune to flag rate, not accuracy |

G-8 deserves a note: there is **no historical ECR in the cache**. `ecr.csv` contains a single scrape
dated 2026-08-28. The market-blend weight in §9 therefore cannot be validated against this data at all.
Every number in §9 is [R] reasoning from the model's own measured predictive power, and the whole
section should be treated as the least-supported part of this document. Log ECR scrapes weekly from
now on so 2027 has something to fit.

---

## 12. What this model does not do

Stated so the UI does not imply otherwise, per contract §10.

- **No weather.** `temp` and `wind` are null for all 2026 games in the cache. Wind above roughly 15 mph
  is a real effect on passing and kicking, but the data is not there until game week.
- **No offensive line, no coaching change, no scheme.** Team pass rate carries a shrunk version of this
  implicitly, and the market-implied total carries the rest. Nothing player-specific.
- **No correlated injury.** Availability is drawn independently per player (§6.5). A QB injury does not
  drag his receivers down in the simulation, though it does in reality.
- **No in-game usage feedback.** A back does not get more carries in the simulated branches where his
  team is ahead. The game-script effect is captured only through the pregame spread term in §1.4.
- **No rookie-specific projection beyond the depth-chart prior.** No draft capital, no college
  production, no combine. The ECR blend at `w = 0.65` is doing all the work for these players and the
  UI must label their roles as inferred.
- **Nothing about touchdown-over-expected as a player skill**, deliberately, because §4.2 shows it is
  not one.

---

## Sources

Empirical constants tagged [M] were measured this session against `pipeline/.cache/`:
`stats_player_week_{2019..2025}.csv`, `stats_team_week_{2019..2025}.csv`, `pbp_{2023..2025}.csv`,
`injuries_{2019..2025}.csv`, `snap_counts_{2019..2025}.csv`, `games.csv`, `db_fpecr_latest.csv`.

External results tagged [L]:

- [Footballguys — Regression Alert: Be Very Wary of Yards per Carry](https://www.footballguys.com/article/HarstadRegression02?article=HarstadRegression02)
- [PFF — Different ways to look at yards per carry for fantasy](https://www.pff.com/news/fantasy-football-different-ways-to-look-at-yards-per-carry)
- [PFF — Depth and Passer-adjusted Catch Rates](https://www.pff.com/news/depth-and-passer-adjusted-catch-rates)
- [Sharp Football Analysis — NFL Red Zone Stats Vs. Expectation: Running Backs](https://www.sharpfootballanalysis.com/fantasy/nfl-red-zone-stats-expectations-running-backs/)
- [Yahoo Sports — Do defenses repeat performances year-over-year?](https://sports.yahoo.com/article/fantasy-football-do-defenses-repeat-performances-year-over-year-142331371.html)
- [ProFootballLogic — NFL Injury Rate Analysis](https://www.profootballlogic.com/articles/nfl-injury-rate-analysis/)
- [Apex Fantasy — More Injury Prone: Running Backs or Wide Receivers?](https://apexfantasyleagues.com/more-injury-prone-wide-receivers-running-backs/)
- [Fantasy Football Analytics — Which are More Accurate: Rankings or Projections?](https://fantasyfootballanalytics.net/2016/04/accuracy-of-rankings-vs-projections.html)
- [4for4 — The Definitive Guide to Stacking on DraftKings](https://www.4for4.com/2018/preseason/definitive-guide-stacking-draftkings) (DFS correlation figures; superseded here by direct measurement)
- [FanDuel Research — Touchdown Regression](https://www.fanduel.com/research/touchdown-regression-what-it-is-and-how-to-use-it-for-player-prop-bets-fantasy-football)
