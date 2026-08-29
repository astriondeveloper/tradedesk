/**
 * sim.js — correlated Monte Carlo producing CALIBRATED floor / median / ceiling.
 *
 * Contract: docs/ARCHITECTURE.md sections 5 (pack schema), 6 (module table), 7 (projection
 * model), 8 (trade evaluation), 10 (honesty rules).
 *
 *   makeRng(seed)                                     -> deterministic PRNG
 *   simPlayerWeek(player, week, cfg, pack, rng, n)    -> {mean, sd, p10, p50, p90, samples, ...}
 *   simRoster(players, week, cfg, pack, rng, n, slots)-> optimal-lineup distribution
 *   simSeason(roster, opts)                           -> {pointsPerWeek, expectedWins, playoffOdds, dist}
 *   weekPlan(player, week, cfg, pack)                 -> the deterministic per-week setup (introspection)
 *   CORRELATION, SIM_CONSTANTS, DEFAULT_SLOTS, DEFAULT_SEED
 *
 * ===========================================================================
 * WHY THIS MODULE EXISTS
 * ===========================================================================
 * A point estimate hides the only thing a trade actually turns on: risk. Three specific
 * mistakes are baked out here, and each one is the reason for a chunk of code below.
 *
 * 1. YOU CANNOT SUM PLAYER FLOORS TO GET A LINEUP FLOOR.
 *    `simRoster` re-solves the optimal starting lineup INSIDE every draw. The lineup adapts
 *    to whoever booms, so E[best lineup] > best lineup of E[player]. That gap is real value
 *    (reported as `adaptivity`) and every tool that adds up per-player floors misses it.
 *
 * 2. INJURY RISK IS WHERE THE FLOOR LIVES.
 *    Availability is a Bernoulli draw per player-week (`player.avail` from the pack's injury
 *    priors). An inactive week scores exactly 0 — not "a bad game". A 0.60-availability
 *    workhorse and a 0.95-availability workhorse have almost the same ceiling and wildly
 *    different floors, which is precisely the trade-off a trade evaluator has to price.
 *
 * 3. UNCORRELATED DRAWS UNDERSTATE CEILINGS.
 *    A QB and his own pass catchers score in the same game, off the same drives, on the same
 *    touchdowns. Drawing them independently flattens the right tail of any stack. Here every
 *    team-week carries a latent game environment (a Gaussian copula), and same-team passing
 *    touchdowns come out of ONE team touchdown count, so a QB->WR stack booms together.
 *    See CORRELATION for the numbers and their justification.
 *
 * ===========================================================================
 * THE DRAW, COMPONENT BY COMPONENT
 * ===========================================================================
 * Nothing here scores fantasy points itself. Every draw produces a component stat line in the
 * canonical vocabulary (contract section 3) and hands it to `scoreLine`, so changing PPR from
 * 1.0 to 0.5 re-derives every floor and ceiling with no rebuild (contract section 2).
 *
 *   AVAILABILITY  Bernoulli(player.avail). Inactive => 0 points, no line scored. (Scoring an
 *                 all-zero DST line would pay +5/+5 off the shutout tiers, which is why an
 *                 inactive week short-circuits instead of scoring an empty object.)
 *
 *   VOLUME        Gamma-Poisson (negative binomial): a mean-1 Gamma multiplier M with
 *                 Var(M) = 1/k, then N ~ Poisson(mu * M). Then Var(N) = mu + mu^2/k, so
 *                 CV(N)^2 = 1/mu + 1/k and k is solved so CV(N) == player.cv exactly. When
 *                 player.cv is at or below the Poisson floor 1/sqrt(mu) the count is already
 *                 that variable and M is dropped (pure Poisson). The Gamma is drawn from the
 *                 correlated normal latent by Wilson-Hilferty, which is monotone in the
 *                 latent — that monotonicity is what makes the copula work.
 *
 *   EFFICIENCY    Per OPPORTUNITY, never per game. Each target is a catch Bernoulli and then
 *                 a lognormal yardage draw; each carry and each completion likewise. Volume
 *                 and yardage therefore correlate the way they do in a real box score: the
 *                 12-target game is also the 140-yard game, without anyone imposing it.
 *
 *   TOUCHDOWNS    Team offensive touchdowns are UNDERdispersed relative to Poisson —
 *                 pack.coef.off_td_vs_implied.var_mean_ratio is 0.813, not 1.0. A Poisson
 *                 team draw would therefore manufacture variance that the last seven seasons
 *                 say is not there. So the team count is a BINOMIAL draw, Binomial(n, p) with
 *                 1 - p = 0.813 and n*p = the team's expected touchdowns, which reproduces
 *                 that variance-to-mean ratio by construction. The team count is then split
 *                 pass/rush and THINNED to each player by his share of the team's touchdown
 *                 mean. Thinning (rather than an independent per-player Poisson) is what
 *                 couples a QB to his receivers: they are drawing from the same touchdowns.
 *
 * ===========================================================================
 * NOTES FOR CALLERS
 * ===========================================================================
 * - Every random number comes from the caller's `rng`. No Math.random anywhere, no Date.
 *   Same seed + same inputs => bit-identical output, always.
 * - `week` is a real NFL week. A player whose team has no game that week (bye, or an
 *   unsigned free agent with team 'FA') scores 0 and is reported with `bye: true`. Missing
 *   pack data is never invented: it is reported in the result's `note` (contract section 10).
 * - Values inferred rather than sourced — correlation strengths, per-opportunity yardage
 *   spread, injury persistence, the playoff win cut — are named constants with a stated
 *   basis, exported so the UI can label them as inferred.
 * - Percentiles are linear-interpolated order statistics. p10 <= p50 <= p90 always holds;
 *   it is strict for any player with a real projection and a live game.
 */

import { scoreLine, DEFAULT_SCORING } from './scoring.js';
import { optimizeLineup, slotsFromCounts } from './lineup.js';

/* ===========================================================================
 * 1. Deterministic randomness
 * =========================================================================== */

/** Seed used when a caller omits `rng`. Fixed so "no rng" is still reproducible. */
export const DEFAULT_SEED = 0x7d3d1e;

/** xmur3 string/number hash — spreads a human-friendly seed across all 32 bits. */
function hashSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    let h = (seed | 0) ^ 0x9e3779b9;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  }
  const s = seed === undefined || seed === null ? '' : String(seed);
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * mulberry32 — 32-bit state, period 2^32, passes gjrand/PractRand at the sizes we use, and
 * is one multiply-heavy line. Every draw in this module flows through it.
 *
 * The returned function is callable (uniform on [0,1)) and carries:
 *   rng.normal()   one standard normal, via inverse CDF => exactly one uniform consumed
 *   rng.fork(tag)  an independent stream derived from this seed and `tag`
 *   rng.seed       the original seed argument, for reporting
 *
 * `normal` deliberately uses the inverse CDF rather than Box-Muller: Box-Muller produces two
 * normals per call and would need a cache, and a cache that survives across calls makes the
 * stream position depend on call history. One uniform in, one normal out, no state.
 *
 * @param {number|string} [seed]
 * @returns {function(): number}
 */
export function makeRng(seed) {
  let a = hashSeed(seed === undefined ? DEFAULT_SEED : seed);
  const rng = function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.seed = seed === undefined ? DEFAULT_SEED : seed;
  rng.normal = function normal() { return normInv(rng()); };
  rng.fork = function fork(tag) { return makeRng(String(rng.seed) + '|' + String(tag)); };
  return rng;
}

/** Coerce anything into a usable rng. */
function asRng(rng) {
  return typeof rng === 'function' ? rng : makeRng(DEFAULT_SEED);
}

// Acklam's rational approximation to the inverse standard normal CDF.
// Relative error < 1.15e-9 over the whole domain — far below Monte Carlo noise at any n we
// will ever run, and monotone, which the Gaussian copula requires.
const A_LOW = 0.02425;
const IN_A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
  1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
const IN_B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
  6.680131188771972e1, -1.328068155288572e1];
const IN_C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
  -2.549732539343734, 4.374664141464968, 2.938163982698783];
const IN_D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
  3.754408661907416];

/** Inverse standard normal CDF. Input is clamped off 0 and 1 so it never returns +/-Infinity. */
export function normInv(p) {
  let u = p;
  if (!(u > 0)) u = 1e-12;
  else if (!(u < 1)) u = 1 - 1e-12;

  let q;
  if (u < A_LOW) {
    q = Math.sqrt(-2 * Math.log(u));
    return (((((IN_C[0] * q + IN_C[1]) * q + IN_C[2]) * q + IN_C[3]) * q + IN_C[4]) * q + IN_C[5])
      / ((((IN_D[0] * q + IN_D[1]) * q + IN_D[2]) * q + IN_D[3]) * q + 1);
  }
  if (u > 1 - A_LOW) {
    q = Math.sqrt(-2 * Math.log(1 - u));
    return -(((((IN_C[0] * q + IN_C[1]) * q + IN_C[2]) * q + IN_C[3]) * q + IN_C[4]) * q + IN_C[5])
      / ((((IN_D[0] * q + IN_D[1]) * q + IN_D[2]) * q + IN_D[3]) * q + 1);
  }
  q = u - 0.5;
  const r = q * q;
  return (((((IN_A[0] * r + IN_A[1]) * r + IN_A[2]) * r + IN_A[3]) * r + IN_A[4]) * r + IN_A[5]) * q
    / (((((IN_B[0] * r + IN_B[1]) * r + IN_B[2]) * r + IN_B[3]) * r + IN_B[4]) * r + 1);
}

/* ===========================================================================
 * 2. Distributions
 * =========================================================================== */

/** Lanczos log-gamma, needed by the Poisson rejection sampler. */
const LG = [76.18009172947146, -86.50532032941677, 24.01409824083091,
  -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
function logGamma(x) {
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += LG[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

/**
 * Poisson(lambda). Knuth's product-of-uniforms below 10 (exact, and cheap at small lambda);
 * Hoermann's PTRS transformed-rejection at or above it (exact, O(1) expected draws).
 * Non-finite or negative lambda yields 0; absurd lambdas are capped so a bad pack value
 * cannot spin the sampler.
 */
export function poisson(rng, lambda) {
  const lam = Number.isFinite(lambda) ? lambda : 0;
  if (lam <= 0) return 0;
  if (lam > 1e6) return Math.round(lam);

  if (lam < 10) {
    const L = Math.exp(-lam);
    let k = 0;
    let p = 1;
    do { k++; p *= rng(); } while (p > L && k < 1000);
    return k - 1;
  }

  const b = 0.931 + 2.53 * Math.sqrt(lam);
  const a = -0.059 + 0.02483 * b;
  const invAlpha = 1.1239 + 1.1328 / (b - 3.4);
  const vr = 0.9277 - 3.6224 / (b - 2);
  const logLam = Math.log(lam);

  for (let guard = 0; guard < 1000; guard++) {
    const U = rng() - 0.5;
    const V = rng();
    const us = 0.5 - (U < 0 ? -U : U);
    const k = Math.floor((2 * a / us + b) * U + lam + 0.43);
    if (us >= 0.07 && V <= vr) return k;
    if (k < 0 || (us < 0.013 && V > us)) continue;
    if (Math.log(V * invAlpha / (a / (us * us) + b)) <= k * logLam - lam - logGamma(k + 1)) return k;
  }
  return Math.round(lam);
}

/**
 * Binomial(n, p). Direct Bernoulli sum up to n = 128 (exact); beyond that a normal
 * approximation with continuity correction, clamped to [0, n]. Every binomial in this module
 * is a thinning of a touchdown count or a target count, so n is single digits in practice and
 * the approximation branch is effectively unreachable.
 */
export function binomial(rng, n, p) {
  const N = Math.max(0, Math.floor(Number.isFinite(n) ? n : 0));
  if (N === 0) return 0;
  let q = Number.isFinite(p) ? p : 0;
  if (q <= 0) return 0;
  if (q >= 1) return N;

  if (N <= 128) {
    let k = 0;
    for (let i = 0; i < N; i++) if (rng() < q) k++;
    return k;
  }
  const mu = N * q;
  const sd = Math.sqrt(N * q * (1 - q));
  const v = Math.round(mu + sd * rng.normal());
  return v < 0 ? 0 : (v > N ? N : v);
}

/**
 * A mean-1 Gamma(k, 1/k) multiplier drawn from a standard normal `z`.
 *
 * Monotone in z, which is the whole point: it lets the correlated latent drive the
 * overdispersion of a count without needing a gamma inverse CDF.
 *
 *   k >= 1  Wilson-Hilferty: Gamma(k) ~ k*(1 - 1/(9k) + z/sqrt(9k))^3. Accurate to well under
 *           a percent in mean and variance for k >= 1, and monotone.
 *   k < 1   Wilson-Hilferty degrades badly in the extreme right skew, so a mean-1 lognormal
 *           with the same variance 1/k is used instead. Also monotone in z, also mean 1.
 */
export function gammaMult(z, k) {
  if (!Number.isFinite(k) || k <= 0) return 1;
  if (k >= 1) {
    const c = 1 - 1 / (9 * k) + z / Math.sqrt(9 * k);
    if (c <= 0) return 0;
    return c * c * c;
  }
  const s2 = Math.log(1 + 1 / k);
  return Math.exp(Math.sqrt(s2) * z - 0.5 * s2);
}

/**
 * Shape k of the Gamma mixing distribution such that a Gamma-Poisson with mean `mu` has
 * coefficient of variation exactly `cv`.
 *
 *   Var(N) = mu + mu^2/k   =>   cv^2 = 1/mu + 1/k
 *
 * Returns Infinity (meaning: no mixing, pure Poisson) when the requested cv is at or below
 * the Poisson floor 1/sqrt(mu). A count cannot be LESS variable than Poisson in this family,
 * and pretending otherwise would fabricate precision.
 */
export function nbShape(mu, cv) {
  if (!(mu > 0) || !(cv > 0)) return Infinity;
  const excess = cv * cv - 1 / mu;
  if (excess <= 1e-9) return Infinity;
  return 1 / excess;
}

/**
 * A count with mean `mean` and variance-to-mean ratio `vmr`.
 *
 * vmr >= 1 is Poisson (or overdispersed, which this family cannot express, so Poisson is the
 * honest floor). vmr < 1 is UNDERdispersed and is drawn as Binomial(n, p) with 1 - p = vmr:
 * Binomial has var/mean = 1 - p by definition, so matching is exact up to rounding n to an
 * integer. This is the team-touchdown draw — see the header note on
 * pack.coef.off_td_vs_implied.var_mean_ratio = 0.813.
 */
export function underdispersedCount(rng, mean, vmr) {
  const m = Number.isFinite(mean) ? mean : 0;
  if (m <= 0) return 0;
  const r = Number.isFinite(vmr) ? vmr : 1;
  if (r >= 1) return poisson(rng, m);
  const p = 1 - r;
  let n = Math.round(m / p);
  if (n < 1) n = 1;
  const pAdj = m / n;
  if (!(pAdj > 0) || pAdj >= 1) return poisson(rng, m);
  return binomial(rng, n, pAdj);
}

/**
 * One mean-preserving lognormal yield: E[out] === mean exactly, spread set by `logSd`.
 * Used per opportunity — per reception, per carry, per completion.
 */
function lognormalYield(rng, mean, logSd) {
  if (!(mean > 0)) return 0;
  return mean * Math.exp(logSd * rng.normal() - 0.5 * logSd * logSd);
}

/* ===========================================================================
 * 3. Summary statistics
 * =========================================================================== */

/** Linear-interpolated order statistic on an ascending array. */
export function quantile(sorted, q) {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const h = (n - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(h);
  const hi = lo + 1 >= n ? n - 1 : lo + 1;
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** mean / sd / p10 / p50 / p90 / min / max of a sample. `sd` is the sample sd (n-1). */
function summarize(samples) {
  const n = samples.length;
  if (n === 0) {
    return { n: 0, mean: 0, sd: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, min: 0, max: 0, se: 0 };
  }
  let sum = 0;
  for (let i = 0; i < n; i++) sum += samples[i];
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) { const d = samples[i] - mean; ss += d * d; }
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;

  const sorted = Float64Array.from(samples);
  sorted.sort();
  return {
    n,
    mean: r4(mean),
    sd: r4(sd),
    se: r4(n > 0 ? sd / Math.sqrt(n) : 0),
    p10: r4(quantile(sorted, 0.10)),
    p25: r4(quantile(sorted, 0.25)),
    p50: r4(quantile(sorted, 0.50)),
    p75: r4(quantile(sorted, 0.75)),
    p90: r4(quantile(sorted, 0.90)),
    min: r4(sorted[0]),
    max: r4(sorted[n - 1]),
  };
}

function r4(x) {
  return Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : 0;
}

function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/* ===========================================================================
 * 4. Correlation — the named constants and why they are what they are
 * =========================================================================== */

/**
 * Correlation structure. One latent pair per TEAM-WEEK drives every player on that team.
 *
 *   L_channel = sqrt(TEAM_ENV) * zEnv
 *             +/- sqrt(PASS_SCRIPT) * zScript      (+ for the pass channel, - for the rush)
 *             + sqrt(PLAYER_USAGE) * ePlayer       (shared by one player's own channels)
 *             + sqrt(remainder) * eChannel
 *
 * L_channel is standard normal by construction and drives that channel's volume multiplier.
 * The implied correlations, which are the numbers to argue about:
 *
 *   same team, both pass channel (QB attempts <-> WR/TE targets)
 *       TEAM_ENV + PASS_SCRIPT = 0.38
 *       A QB and his primary receiver correlate around 0.3-0.4 in weekly fantasy points once
 *       shared touchdowns are included; the touchdown thinning below supplies the rest, so
 *       the VOLUME correlation sits at the low end of that band on purpose.
 *
 *   same team, pass channel vs rush channel (QB attempts <-> RB carries)
 *       TEAM_ENV - PASS_SCRIPT = 0.02
 *       Near zero, and that is the right answer: a good offense generates more of both, while
 *       game script trades one for the other. The two effects very nearly cancel.
 *
 *   one player's own pass and rush channels (an RB's carries <-> his targets)
 *       TEAM_ENV - PASS_SCRIPT + PLAYER_USAGE = 0.17
 *       Positive because snap share moves both, damped because game script splits them.
 *
 * EFF_ENV_BETA tilts per-opportunity EFFICIENCY through a SECOND, independent team latent
 * (zEff), so teammates share yards-per-play luck as well as volume. Small on purpose:
 * efficiency is much closer to independent across players than volume is.
 *
 * zEff is deliberately NOT zEnv. Driving efficiency off the same latent as volume makes
 * count and per-opportunity yield positively covary, and E[count * yield] then exceeds
 * E[count] * E[yield] — a systematic 1-2% upward drift of every projected mean away from the
 * pack's calibrated numbers. The volume-to-yardage link the model actually needs is already
 * there for free: yards are drawn PER OPPORTUNITY, so a 12-target game is mechanically a
 * bigger yardage game than a 5-target game. zEff only has to supply the teammate coupling.
 *
 * Touchdowns are NOT correlated through this copula. They come out of a single team
 * touchdown count that is split pass/rush and thinned to each player, which is a stronger and
 * more mechanically honest coupling: a QB's passing touchdown IS his receiver's receiving
 * touchdown, not a separate correlated event.
 *
 * DST_OPP_ENV loads a defense's points/yards allowed on its OPPONENT's zEnv, so starting a
 * D/ST against a quarterback you also start is correctly penalized as the hedge it is.
 *
 * These strengths are INFERRED (contract section 10). They are exported so the UI can say so.
 */
export const CORRELATION = Object.freeze({
  /** Shared team scoring-environment share of latent variance. */
  TEAM_ENV: 0.20,
  /** Pass-vs-rush game-script share. Enters the pass channel +, the rush channel -. */
  PASS_SCRIPT: 0.18,
  /** A single player's own usage swing, shared across his pass and rush channels. */
  PLAYER_USAGE: 0.15,
  /** Lognormal loading of per-opportunity efficiency on the team EFFICIENCY latent (zEff). */
  EFF_ENV_BETA: 0.10,
  /** Share of a D/ST's points- and yards-allowed variance driven by the opponent's latent. */
  DST_OPP_ENV: 0.45,
  /** Total correlation between a D/ST's points allowed and yards allowed. */
  DST_PA_YA: 0.75,
  /** Lognormal loading of D/ST takeaway rates on the opponent latent (negative sign). */
  DST_TAKEAWAY_BETA: 0.12,

  /** Derived, for display: same-team QB <-> pass catcher volume correlation. */
  get STACK() { return this.TEAM_ENV + this.PASS_SCRIPT; },
  /** Derived, for display: same-team QB pass volume <-> RB carry correlation. */
  get QB_RB() { return this.TEAM_ENV - this.PASS_SCRIPT; },
});

const L_ENV = Math.sqrt(CORRELATION.TEAM_ENV);
const L_SCRIPT = Math.sqrt(CORRELATION.PASS_SCRIPT);
const L_USAGE = Math.sqrt(CORRELATION.PLAYER_USAGE);
const L_PASS_RESID = Math.sqrt(Math.max(0,
  1 - CORRELATION.TEAM_ENV - CORRELATION.PASS_SCRIPT - CORRELATION.PLAYER_USAGE));
const L_RUSH_RESID = L_PASS_RESID;

/**
 * Everything else that is inferred rather than measured. Exported for the same reason.
 *
 * The per-opportunity yardage spreads are set so the resulting per-play distributions match
 * the shape of real NFL play-by-play: a right-skewed pile near the median with a long tail.
 * CATCH_YARD_LOGSD 0.85 gives yards-per-reception a CV near 1.0 and puts roughly 3% of
 * receptions past 30 yards. RUSH_YARD_SHIFT lets a carry lose yards, which a raw lognormal
 * cannot: yards = Lognormal(ypc + shift) - shift.
 */
export const SIM_CONSTANTS = Object.freeze({
  /** Lognormal sigma of yards on a completed pass / a reception (same event, both sides). */
  CATCH_YARD_LOGSD: 0.85,
  /** Lognormal sigma of yards on a carry. */
  RUSH_YARD_LOGSD: 0.75,
  /** Yards added before the lognormal and subtracted after, so a carry can go negative. */
  RUSH_YARD_SHIFT: 2.0,
  /** player.cv is clamped into this band before it sets the negative-binomial shape. */
  CV_MIN: 0.15,
  CV_MAX: 1.25,
  /** Hard cap on a per-opportunity loop, so a pathological draw cannot stall a season sim. */
  MAX_OPPORTUNITIES: 200,
  /**
   * Probability that a player who missed last week is still out this week, over and above his
   * baseline miss rate. 0.5 implies a mean absence of two weeks. INFERRED: the pack carries a
   * per-game availability but no injury-duration prior. Set to 0 for independent weeks —
   * which understates season-long tail risk, because real injuries persist.
   */
  INJURY_PERSISTENCE: 0.5,
  /** Fallback when pack.coef.off_td_vs_implied.var_mean_ratio is missing. */
  TEAM_TD_VMR: 0.813,
  /** Fallback when pack.coef.pass_td_share.mean is missing. */
  PASS_TD_SHARE: 0.6229,
});

/** The user's league starting lineup (contract section 6 / replacement.js DEFAULT_LEAGUE). */
export const DEFAULT_SLOTS = Object.freeze(
  { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
);

/* ===========================================================================
 * 5. Pack access
 * =========================================================================== */

const packCache = new WeakMap();

/** Per-pack lookup index, built once and memoized on the pack object itself. */
function packIndex(pack) {
  if (pack === null || typeof pack !== 'object') return { games: new Map(), coef: {} };
  let ix = packCache.get(pack);
  if (ix) return ix;

  const games = new Map();
  const sched = pack.schedule;
  if (sched && typeof sched === 'object') {
    for (const team of Object.keys(sched)) {
      const arr = sched[team];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const g = arr[i];
        if (g && Number.isFinite(g.w)) games.set(team + '|' + g.w, g);
      }
    }
  }

  const coef = pack.coef && typeof pack.coef === 'object' ? pack.coef : {};
  const td = coef.off_td_vs_implied || {};
  const pts = coef.pass_td_share || {};

  ix = {
    games,
    teamTdVmr: Number.isFinite(td.var_mean_ratio) ? td.var_mean_ratio : SIM_CONSTANTS.TEAM_TD_VMR,
    passTdShare: Number.isFinite(pts.mean) ? pts.mean : SIM_CONSTANTS.PASS_TD_SHARE,
  };
  packCache.set(pack, ix);
  return ix;
}

function gameFor(pack, team, week) {
  if (!team || !Number.isFinite(week)) return null;
  return packIndex(pack).games.get(team + '|' + week) || null;
}

/** Weekly team multipliers {pass, rush, td}. Missing week (bye) or missing pack => all 1. */
function factorsFor(pack, team, week) {
  const tf = pack && pack.teamFactors;
  const t = tf && tf[team];
  const f = t && t[String(week)];
  if (!f) return { pass: 1, rush: 1, td: 1 };
  return {
    pass: Number.isFinite(f.pass) ? f.pass : 1,
    rush: Number.isFinite(f.rush) ? f.rush : 1,
    td: Number.isFinite(f.td) ? f.td : 1,
  };
}

/** Defense-vs-position multiplier for `pos` against `oppTeam`. Regressed to 1.0 in the pack. */
function dvpFor(pack, oppTeam, pos) {
  const d = pack && pack.dvp && pack.dvp[oppTeam];
  const v = d && d[pos];
  return Number.isFinite(v) ? v : 1;
}

/* ===========================================================================
 * 6. The per-player, per-week plan
 * =========================================================================== */

const OFFENSE = new Set(['QB', 'RB', 'WR', 'TE']);

function normPos(pos) {
  if (typeof pos !== 'string') return '';
  const p = pos.trim().toUpperCase();
  if (p === 'DEF' || p === 'D/ST' || p === 'DST' || p === 'D' || p === 'DEFENSE') return 'DST';
  if (p === 'PK' || p === 'KICKER' || p === 'K') return 'K';
  return p;
}

function ratio(a, b) {
  if (!(b > 0)) return 0;
  const v = a / b;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function clamp01(x) {
  return x < 0 ? 0 : (x > 1 ? 1 : x);
}

/**
 * Everything deterministic about one player in one week, computed once and reused across all
 * n draws. This is where the pack's per-game means become per-WEEK means: team pass/rush/td
 * factors for this opponent and this game environment, then the opponent's defense-vs-position
 * multiplier.
 *
 * Returns a plan object whose `live` flag says whether there is anything to draw at all.
 * `note` explains, in plain words, every case where the answer is 0 for a data reason rather
 * than a football reason — the app is required to say so rather than silently emit a number.
 *
 * @param {Object} player
 * @param {number} week
 * @param {Object} cfg  scoring config; carried so `drawPoints` can score without re-reading
 * @param {Object} pack
 */
export function weekPlan(player, week, cfg, pack) {
  const P = player && typeof player === 'object' ? player : {};
  const pos = normPos(P.pos);
  const team = typeof P.team === 'string' ? P.team : '';
  const w = Number(week);

  const plan = {
    id: P.id !== undefined && P.id !== null ? String(P.id) : null,
    name: typeof P.name === 'string' ? P.name : null,
    player: P,
    pos,
    team,
    week: w,
    live: false,
    bye: false,
    note: '',
    avail: 1,
    cfg: cfg && typeof cfg === 'object' ? cfg : DEFAULT_SCORING,
  };

  if (!Number.isFinite(w)) { plan.note = 'No week supplied.'; return plan; }

  const game = gameFor(pack, team, w);
  if (!game) {
    plan.bye = true;
    const byeWeek = Number.isFinite(P.bye) ? P.bye : null;
    plan.note = !team || team === 'FA'
      ? `${plan.name || 'Player'} has no NFL team in the pack, so there is no week ${w} game to project.`
      : (byeWeek === w
        ? `${team} is on bye in week ${w}.`
        : `No week ${w} game for ${team} in the pack schedule.`);
    return plan;
  }
  plan.game = game;
  plan.opp = typeof game.opp === 'string' ? game.opp : '';
  plan.home = !!game.home;
  plan.implied = Number.isFinite(game.implied) ? game.implied : null;

  // Availability: the Bernoulli that makes the floor mean something.
  const avail = Number(P.avail);
  plan.avail = Number.isFinite(avail) ? clamp01(avail) : 1;

  const f = factorsFor(pack, team, w);
  plan.factors = f;

  if (pos === 'K') return planKicker(plan, P, w);
  if (pos === 'DST') return planDst(plan, P, w, pack);
  if (OFFENSE.has(pos)) return planOffense(plan, P, pack);

  plan.note = `Position "${P.pos}" is not simulated; only QB/RB/WR/TE/K/DST have pack projections.`;
  return plan;
}

function planKicker(plan, P, w) {
  const kw = P.kWeeks && P.kWeeks[String(w)];
  if (!kw) {
    plan.note = `No week ${w} kicking projection in the pack for ${plan.name || plan.id}.`;
    return plan;
  }
  // Per bucket: expected attempts and the make rate. Attempts are Poisson, makes are a
  // binomial thinning of the attempts, so the make rate is preserved exactly.
  const buckets = [];
  for (const b of ['0_19', '20_29', '30_39', '40_49', '50_59', '60']) {
    const made = num(kw['fgm_' + b]);
    const miss = num(kw['fgx_' + b]);
    const att = made + miss;
    if (att > 0) buckets.push({ b, att, rate: clamp01(made / att) });
  }
  const xpm = num(kw.xpm);
  const xpx = num(kw.xpx);
  plan.kick = {
    buckets,
    xpAtt: xpm + xpx,
    xpRate: xpm + xpx > 0 ? clamp01(xpm / (xpm + xpx)) : 0,
  };
  plan.live = buckets.length > 0 || plan.kick.xpAtt > 0;
  if (!plan.live) plan.note = `Week ${w} kicking projection is all zeros.`;
  return plan;
}

function planDst(plan, P, w, pack) {
  const dw = P.dstWeeks && P.dstWeeks[String(w)];
  if (!dw) {
    plan.note = `No week ${w} D/ST projection in the pack for ${plan.name || plan.id}.`;
    return plan;
  }
  const sd = P.dstSd && typeof P.dstSd === 'object' ? P.dstSd : {};
  plan.dst = {
    counts: {
      sack: num(dw.sack), dint: num(dw.dint), fumrec: num(dw.fumrec),
      safety: num(dw.safety), dtd: num(dw.dtd), blk: num(dw.blk), sttd: num(dw.sttd),
    },
    paMu: num(dw.ptsAllowed),
    yaMu: num(dw.ydsAllowed),
    paSd: num(sd.ptsAllowed) || 9.12,
    ySd: num(sd.ydsAllowed) || 81,
  };
  // The offense being defended is the opponent's; its latent drives points/yards allowed.
  plan.envTeam = plan.opp || plan.team;
  plan.live = true;
  if (!(P.dstSd && Number.isFinite(sd.ptsAllowed))) {
    plan.note = 'D/ST points- and yards-allowed spread not in the pack for this team; '
      + 'league-average spread used.';
  }
  void pack;
  return plan;
}

function planOffense(plan, P, pack) {
  const mu = P.mu && typeof P.mu === 'object' ? P.mu : null;
  if (!mu) {
    plan.note = `No component projection (mu) in the pack for ${plan.name || plan.id}.`;
    return plan;
  }

  const f = plan.factors;
  const dvp = dvpFor(pack, plan.opp, plan.pos);
  plan.dvp = dvp;

  // Volume means for THIS week. Passing and receiving ride the pass factor, carries the rush
  // factor, and everything is tilted by the opponent's defense-vs-position multiplier.
  const passMult = f.pass * dvp;
  const rushMult = f.rush * dvp;
  const tdMult = f.td * dvp;

  const patt = num(mu.patt) * passMult;
  const ratt = num(mu.ratt) * rushMult;
  const tgt = num(mu.tgt) * passMult;

  // Negative-binomial shape, solved so each count's CV equals the player's own cv. cv is
  // clamped: the pack's range is 0.20-1.23, but a caller may hand us a synthetic player.
  let cv = num(P.cv);
  if (!(cv > 0)) cv = 0.42;
  cv = Math.min(SIM_CONSTANTS.CV_MAX, Math.max(SIM_CONSTANTS.CV_MIN, cv));
  plan.cv = cv;

  const ix = packIndex(pack);
  const base = pack && pack.teamBase && pack.teamBase[plan.team];
  const teamTd = base && Number.isFinite(base.off_td) ? base.off_td * f.td : 0;
  plan.team_td = {
    mean: teamTd,
    passMean: teamTd * ix.passTdShare,
    rushMean: teamTd * (1 - ix.passTdShare),
    vmr: ix.teamTdVmr,
    passShare: ix.passTdShare,
  };
  if (!teamTd) {
    plan.note = `No team touchdown baseline for ${plan.team}; touchdowns drawn independently `
      + 'as Poisson, so this player will not share touchdowns with teammates.';
  }

  plan.pass = patt > 0 ? {
    att: patt,
    shape: nbShape(patt, cv),
    cmpRate: clamp01(ratio(num(mu.pcmp), num(mu.patt))),
    ydPerCmp: ratio(num(mu.pyd), num(mu.pcmp)),
    intRate: clamp01(ratio(num(mu.pint), num(mu.patt))),
    sackPerAtt: ratio(num(mu.psack), num(mu.patt)),
    tdMean: num(mu.ptd) * tdMult,
    fdPerCmp: clamp01(ratio(num(mu.pfd), num(mu.pcmp))),
    b40PerCmp: clamp01(ratio(num(mu.p40), num(mu.pcmp))),
    twoPt: num(mu.p2p),
  } : null;

  plan.rush = ratt > 0 ? {
    att: ratt,
    shape: nbShape(ratt, cv),
    ydPerAtt: ratio(num(mu.ryd), num(mu.ratt)),
    tdMean: num(mu.rtd) * tdMult,
    fdPerAtt: clamp01(ratio(num(mu.rfd), num(mu.ratt))),
    b40PerAtt: clamp01(ratio(num(mu.r40), num(mu.ratt))),
    twoPt: num(mu.r2p),
  } : null;

  plan.rec = tgt > 0 ? {
    tgt,
    shape: nbShape(tgt, cv),
    catchRate: clamp01(ratio(num(mu.rec), num(mu.tgt))),
    ydPerRec: ratio(num(mu.reyd), num(mu.rec)),
    tdMean: num(mu.retd) * tdMult,
    fdPerRec: clamp01(ratio(num(mu.refd), num(mu.rec))),
    b40PerRec: clamp01(ratio(num(mu.re40), num(mu.rec))),
    twoPt: num(mu.re2p),
  } : null;

  // Fumbles and return touchdowns scale with total opportunity.
  plan.opportunityMean = patt + ratt + tgt;
  plan.fumlMean = num(mu.fuml);
  plan.sttdMean = num(mu.sttd);

  plan.envTeam = plan.team;
  plan.live = !!(plan.pass || plan.rush || plan.rec);
  if (!plan.live && !plan.note) {
    plan.note = `${plan.name || plan.id} has no projected volume in week ${plan.week}.`;
  }
  return plan;
}

/* ===========================================================================
 * 7. The draw
 * =========================================================================== */

/**
 * Per-sim, per-team-week latent state. One object per team that appears in the draw, built
 * lazily so a two-player roster does not draw latents for all 32 teams.
 */
function newEnv() {
  return { teams: new Map() };
}

function teamEnv(env, rng, plan) {
  const key = plan.envTeam || plan.team || '?';
  let e = env.teams.get(key);
  if (e) return e;
  e = {
    zEnv: rng.normal(),     // scoring environment: drives volume
    zScript: rng.normal(),  // pass-vs-rush tilt
    zEff: rng.normal(),     // per-opportunity efficiency, independent of zEnv on purpose
    td: null,               // team offensive touchdowns, drawn on first use
    tdPass: 0,
    tdRush: 0,
  };
  env.teams.set(key, e);
  return e;
}

/** Draw (once per team-week) the team touchdown count and split it pass/rush. */
function teamTouchdowns(e, rng, plan) {
  if (e.td !== null) return e;
  const t = plan.team_td;
  if (!t || !(t.mean > 0)) { e.td = 0; e.tdPass = 0; e.tdRush = 0; return e; }
  const total = underdispersedCount(rng, t.mean, t.vmr);
  const passTd = binomial(rng, total, t.passShare);
  e.td = total;
  e.tdPass = passTd;
  e.tdRush = total - passTd;
  return e;
}

/**
 * Player touchdowns: a THINNING of the team's count by this player's share of the team
 * touchdown mean. Mean is exact (E = teamMean * share = playerMean) and the resulting
 * variance-to-mean ratio is 1 - share*(1 - vmr) <= 1, i.e. Poisson or slightly under, which
 * is what the data says. Two players thinned from the same count are coupled, which is
 * exactly the QB-to-receiver link.
 *
 * The share > 1 branch cannot happen for any player in the shipped pack (the largest observed
 * passing share is 0.91), but the pack is data and data changes: rather than silently capping
 * the mean, fall back to a Poisson scaled by the realized team multiplier, which preserves
 * both the player's mean and his correlation with the team.
 */
function drawTd(rng, playerMean, teamCount, teamMean) {
  if (!(playerMean > 0)) return 0;
  if (!(teamMean > 0)) return poisson(rng, playerMean);
  const share = playerMean / teamMean;
  if (share <= 1) return binomial(rng, teamCount, share);
  return poisson(rng, playerMean * (teamCount / teamMean));
}

/** Volume: negative binomial with the Gamma part driven by the correlated latent. */
function drawVolume(rng, mean, shape, latent) {
  if (!(mean > 0)) return 0;
  const m = Number.isFinite(shape) ? mean * gammaMult(latent, shape) : mean;
  return poisson(rng, m);
}

/**
 * One draw of one player's component line, scored.
 *
 * Returns points, and writes the component line into `outLine` when one is supplied (used by
 * the tests and by any caller that wants to see what produced a score).
 */
function drawPoints(plan, env, rng, outLine) {
  if (outLine) for (const k of Object.keys(outLine)) delete outLine[k];

  // Bye / no data: 0 points, and no random numbers consumed. A no-game week is a certainty,
  // not an outcome, so it must not perturb the stream for the players drawn after it.
  if (!plan.live) return 0;

  // AVAILABILITY. Always consumes exactly one uniform, even at avail === 1, so that two
  // otherwise-identical players with different availability see the same conditional draws.
  // That is what makes "same ceiling, different floor" a clean comparison rather than noise.
  const u = rng();
  if (u >= plan.avail) return 0;

  if (plan.pos === 'K') return drawKicker(plan, rng, outLine);
  if (plan.pos === 'DST') return drawDst(plan, env, rng, outLine);
  return drawOffense(plan, env, rng, outLine);
}

function drawOffense(plan, env, rng, outLine) {
  const e = teamEnv(env, rng, plan);

  // Channel latents. See CORRELATION for the decomposition.
  const ePlayer = rng.normal();
  const zEnv = e.zEnv;
  const zScript = e.zScript;
  const shared = L_ENV * zEnv + L_USAGE * ePlayer;
  const lPass = shared + L_SCRIPT * zScript + L_PASS_RESID * rng.normal();
  const lRush = shared - L_SCRIPT * zScript + L_RUSH_RESID * rng.normal();

  // Efficiency rides its own team latent (see CORRELATION on why not zEnv), mean-preserving
  // so it cannot inflate projections — only redistribute them across the distribution.
  const b = CORRELATION.EFF_ENV_BETA;
  const effMult = Math.exp(b * e.zEff - 0.5 * b * b);

  const line = outLine || {};
  const cap = SIM_CONSTANTS.MAX_OPPORTUNITIES;
  let opportunities = 0;

  // ---- passing -----------------------------------------------------------
  const pass = plan.pass;
  if (pass) {
    const att = Math.min(cap, drawVolume(rng, pass.att, pass.shape, lPass));
    opportunities += att;
    if (att > 0) {
      let cmp = 0;
      let yds = 0;
      const ypc = pass.ydPerCmp * effMult;
      for (let i = 0; i < att; i++) {
        if (rng() < pass.cmpRate) {
          cmp++;
          yds += lognormalYield(rng, ypc, SIM_CONSTANTS.CATCH_YARD_LOGSD);
        }
      }
      line.patt = att;
      line.pcmp = cmp;
      line.pyd = Math.round(yds);
      line.pint = binomial(rng, att, pass.intRate);
      line.psack = poisson(rng, pass.sackPerAtt * att);
      if (cmp > 0) {
        line.pfd = binomial(rng, cmp, pass.fdPerCmp);
        line.p40 = binomial(rng, cmp, pass.b40PerCmp);
      }
      if (pass.twoPt > 0) line.p2p = poisson(rng, pass.twoPt);
    }
    if (pass.tdMean > 0) {
      teamTouchdowns(e, rng, plan);
      line.ptd = drawTd(rng, pass.tdMean, e.tdPass, plan.team_td.passMean);
    }
  }

  // ---- rushing -----------------------------------------------------------
  const rush = plan.rush;
  if (rush) {
    const att = Math.min(cap, drawVolume(rng, rush.att, rush.shape, lRush));
    opportunities += att;
    if (att > 0) {
      const shift = SIM_CONSTANTS.RUSH_YARD_SHIFT;
      const ypc = rush.ydPerAtt * effMult + shift;
      let yds = 0;
      for (let i = 0; i < att; i++) {
        yds += lognormalYield(rng, ypc, SIM_CONSTANTS.RUSH_YARD_LOGSD) - shift;
      }
      line.ratt = att;
      line.ryd = Math.round(yds);
      line.rfd = binomial(rng, att, rush.fdPerAtt);
      line.r40 = binomial(rng, att, rush.b40PerAtt);
      if (rush.twoPt > 0) line.r2p = poisson(rng, rush.twoPt);
    }
    if (rush.tdMean > 0) {
      teamTouchdowns(e, rng, plan);
      line.rtd = drawTd(rng, rush.tdMean, e.tdRush, plan.team_td.rushMean);
    }
  }

  // ---- receiving ---------------------------------------------------------
  const rec = plan.rec;
  if (rec) {
    const tgt = Math.min(cap, drawVolume(rng, rec.tgt, rec.shape, lPass));
    opportunities += tgt;
    if (tgt > 0) {
      let caught = 0;
      let yds = 0;
      const ypr = rec.ydPerRec * effMult;
      for (let i = 0; i < tgt; i++) {
        if (rng() < rec.catchRate) {
          caught++;
          yds += lognormalYield(rng, ypr, SIM_CONSTANTS.CATCH_YARD_LOGSD);
        }
      }
      line.tgt = tgt;
      line.rec = caught;
      line.reyd = Math.round(yds);
      if (caught > 0) {
        line.refd = binomial(rng, caught, rec.fdPerRec);
        line.re40 = binomial(rng, caught, rec.b40PerRec);
      }
      if (rec.twoPt > 0) line.re2p = poisson(rng, rec.twoPt);
    }
    if (rec.tdMean > 0) {
      teamTouchdowns(e, rng, plan);
      line.retd = drawTd(rng, rec.tdMean, e.tdPass, plan.team_td.passMean);
    }
  }

  // ---- misc: scale with realized opportunity ------------------------------
  if (plan.fumlMean > 0 && plan.opportunityMean > 0) {
    line.fuml = poisson(rng, plan.fumlMean * (opportunities / plan.opportunityMean));
  }
  if (plan.sttdMean > 0) line.sttd = poisson(rng, plan.sttdMean);

  return scoreLine(line, plan.cfg, plan.pos);
}

function drawKicker(plan, rng, outLine) {
  const k = plan.kick;
  const line = outLine || {};
  for (let i = 0; i < k.buckets.length; i++) {
    const b = k.buckets[i];
    const att = poisson(rng, b.att);
    if (att === 0) continue;
    const made = binomial(rng, att, b.rate);
    line['fgm_' + b.b] = made;
    line['fgx_' + b.b] = att - made;
  }
  if (k.xpAtt > 0) {
    const att = poisson(rng, k.xpAtt);
    const made = binomial(rng, att, k.xpRate);
    line.xpm = made;
    line.xpx = att - made;
  }
  return scoreLine(line, plan.cfg, 'K');
}

function drawDst(plan, env, rng, outLine) {
  const d = plan.dst;
  const e = teamEnv(env, rng, plan); // the OPPONENT's environment latent
  const line = outLine || {};

  // Points and yards allowed: correlated with each other (DST_PA_YA) and driven by the
  // opponent's game environment (DST_OPP_ENV). Clamped at 0 — a defense cannot allow
  // negative points, and an unclamped normal would hand the shutout tier away for free.
  const cShare = CORRELATION.DST_PA_YA;
  const envShare = Math.min(cShare, CORRELATION.DST_OPP_ENV);
  const common = Math.sqrt(envShare) * e.zEnv + Math.sqrt(cShare - envShare) * rng.normal();
  const resid = Math.sqrt(Math.max(0, 1 - cShare));
  const pa = d.paMu + d.paSd * (common + resid * rng.normal());
  const ya = d.yaMu + d.ySd * (common + resid * rng.normal());
  line.ptsAllowed = Math.max(0, Math.round(pa));
  line.ydsAllowed = Math.max(0, Math.round(ya));

  // Takeaways and pressure run the other way: a defense wrecking a game gets more of them.
  const tb = CORRELATION.DST_TAKEAWAY_BETA;
  const tMult = Math.exp(-tb * e.zEnv - 0.5 * tb * tb);
  const c = d.counts;
  line.sack = poisson(rng, c.sack * tMult);
  line.dint = poisson(rng, c.dint * tMult);
  line.fumrec = poisson(rng, c.fumrec * tMult);
  line.safety = poisson(rng, c.safety * tMult);
  line.dtd = poisson(rng, c.dtd * tMult);
  line.blk = poisson(rng, c.blk);
  line.sttd = poisson(rng, c.sttd);

  return scoreLine(line, plan.cfg, 'DST');
}

/* ===========================================================================
 * 8. simPlayerWeek
 * =========================================================================== */

function readN(n, fallback) {
  if (typeof n === 'number') return n > 0 ? Math.floor(n) : fallback;
  if (n && typeof n === 'object' && Number.isFinite(n.n) && n.n > 0) return Math.floor(n.n);
  return fallback;
}

function readOpt(n, key, fallback) {
  if (n && typeof n === 'object' && !Array.isArray(n) && n[key] !== undefined) return n[key];
  return fallback;
}

/**
 * Simulate one player's week.
 *
 * @param {Object} player   pack player: {id, name, pos, team, avail, cv, mu|kWeeks|dstWeeks}
 * @param {number} week     NFL week
 * @param {Object} cfg      scoring config (defaults to the user's league)
 * @param {Object} pack     window.TD_PACK
 * @param {function} rng    from makeRng; omitted => a fixed default seed
 * @param {number|Object} [n=2000]  draw count, or {n, keepSamples}
 * @returns {{mean, sd, se, p10, p25, p50, p75, p90, min, max, n, playRate, bye, live,
 *            note, samples: Float64Array}}
 */
export function simPlayerWeek(player, week, cfg, pack, rng, n) {
  const draws = readN(n, 2000);
  const keep = readOpt(n, 'keepSamples', true) !== false;
  const r = asRng(rng);
  const plan = weekPlan(player, week, cfg, pack);

  const samples = new Float64Array(draws);
  const env = newEnv();
  let played = 0;

  if (plan.live) {
    for (let i = 0; i < draws; i++) {
      env.teams.clear();
      const pts = drawPoints(plan, env, r, null);
      samples[i] = pts;
      if (pts !== 0) played++;
    }
  }

  const out = summarize(samples);
  out.id = plan.id;
  out.name = plan.name;
  out.pos = plan.pos;
  out.team = plan.team;
  out.week = plan.week;
  out.opp = plan.opp || null;
  out.live = plan.live;
  out.bye = plan.bye;
  out.avail = plan.avail;
  // Share of draws that produced a non-zero score. Below `avail` by however often an active
  // player happened to score exactly nothing.
  out.playRate = draws > 0 ? r4(played / draws) : 0;
  out.note = plan.note;
  if (keep) out.samples = samples;
  return out;
}

/* ===========================================================================
 * 9. simRoster — the optimal lineup, re-solved inside every draw
 * =========================================================================== */

function resolveSlots(slots) {
  if (Array.isArray(slots)) return slots;
  if (slots && typeof slots === 'object') return slotsFromCounts(slots);
  return slotsFromCounts(DEFAULT_SLOTS);
}

/**
 * Distribution of a roster's OPTIMAL STARTING LINEUP score for one week.
 *
 * The lineup is re-optimized inside every draw. That is the whole point of this function and
 * the thing naive tools get wrong: you cannot sum player floors to get a lineup floor,
 * because the lineup adapts. If your WR2 busts, your WR4 starts in the flex instead; if your
 * TE goes for 30 you keep him and bench someone else. The difference between simulating that
 * and adding up per-player means is reported as `adaptivity` and it is never negative.
 *
 * THREE NUMBERS COME BACK, AND THEY MEAN DIFFERENT THINGS. Reporting only the first would be
 * dishonest, because it is a hindsight number:
 *
 *   mean         the OPTIMAL lineup, re-solved with each draw's results already known. This
 *                is perfect lineup-setting: an upper bound no manager reaches every week.
 *   exAnte       the lineup you would actually set — chosen once, from projections, before
 *                kickoff — scored on each draw's realized points. Its mean equals naiveMean
 *                by construction; its p10/p90 are the floor and ceiling of a real week.
 *   naiveMean    what a spreadsheet reports: solve the lineup once on the means and add up.
 *
 * `adaptivity` (mean - naiveMean) is the Jensen gap a point-estimate tool throws away, and it
 * is also exactly how much of the optimal lineup requires knowing the future: exAnte.mean
 * equals naiveMean identically (same players every draw, so the mean of the sum is the sum of
 * the means), which doubles as a self-check that the run is internally consistent.
 *
 * Pass `{keepPlayerSamples: true}` to get each player's own draw vector back on his row in
 * `players`, aligned draw-for-draw across the roster. That is the roster's joint distribution,
 * so a caller can measure the QB-to-receiver correlation rather than take it on faith.
 *
 * @param {Array<Object>} players roster
 * @param {number} week
 * @param {Object} cfg
 * @param {Object} pack
 * @param {function} rng
 * @param {number|Object} [n=2000]  draws, or {n, keepSamples, allowNegative}
 * @param {Array|Object} [slots]  slot array, or a counts map; defaults to the user's league
 */
export function simRoster(players, week, cfg, pack, rng, n, slots) {
  const draws = readN(n, 2000);
  const keep = readOpt(n, 'keepSamples', true) !== false;
  const keepPlayerSamples = readOpt(n, 'keepPlayerSamples', false) === true;
  const allowNegative = readOpt(n, 'allowNegative', true) !== false;
  const r = asRng(rng);
  const slotList = resolveSlots(slots !== undefined ? slots : readOpt(n, 'slots', undefined));

  const roster = Array.isArray(players) ? players.filter((p) => p && typeof p === 'object') : [];
  const plans = roster.map((p) => weekPlan(p, week, cfg, pack));
  const count = roster.length;

  // Per-draw scratch. `pts` is keyed by roster index; ptsOf is a closure over it, so
  // optimizeLineup sees this draw's realized points with no allocation.
  const pts = new Float64Array(count);
  const index = new Map();
  for (let i = 0; i < count; i++) index.set(roster[i], i);
  const ptsOf = (p) => {
    const i = index.get(p);
    return i === undefined ? 0 : pts[i];
  };

  const samples = new Float64Array(draws);
  const sumPts = new Float64Array(count);
  const sumStarted = new Float64Array(count);
  const startCount = new Float64Array(count);
  // Every player's every draw, kept so the ex-ante lineup can be re-scored after the fact.
  // count * draws doubles: 600 KB for a 15-player roster at 5000 draws.
  const grid = new Float64Array(count * draws);
  const env = newEnv();
  const opts = { allowNegative };

  for (let d = 0; d < draws; d++) {
    env.teams.clear();
    const base = d * count;
    for (let i = 0; i < count; i++) {
      const v = drawPoints(plans[i], env, r, null);
      pts[i] = v;
      sumPts[i] += v;
      grid[base + i] = v;
    }
    const res = optimizeLineup(roster, slotList, ptsOf, opts);
    samples[d] = res.total;
    const as = res.assignments;
    for (let a = 0; a < as.length; a++) {
      const pl = as[a].player;
      if (pl === null) continue;
      const i = index.get(pl);
      if (i === undefined) continue;
      startCount[i] += 1;
      sumStarted[i] += as[a].pts;
    }
  }

  const out = summarize(samples);
  out.week = Number(week);
  out.slots = slotList.map((s) => (typeof s === 'string' ? s : (s && s.id) || 'SLOT'));

  // Per-player detail. `startRate` is bench value priced the way the contract asks for it in
  // section 8: by how often a player actually enters the lineup, not at face value.
  const detail = new Array(count);
  for (let i = 0; i < count; i++) {
    const mean = draws > 0 ? sumPts[i] / draws : 0;
    const rate = draws > 0 ? startCount[i] / draws : 0;
    detail[i] = {
      id: plans[i].id,
      name: plans[i].name,
      pos: plans[i].pos,
      team: plans[i].team,
      mean: r4(mean),
      startRate: r4(rate),
      // Mean points in the draws where he actually started — a boom-week specialist scores
      // well above his own mean here, which is exactly why he is worth a bench spot.
      startedMean: r4(startCount[i] > 0 ? sumStarted[i] / startCount[i] : 0),
      // Mean points contributed to the lineup across ALL draws.
      contribution: r4(draws > 0 ? sumStarted[i] / draws : 0),
      live: plans[i].live,
      bye: plans[i].bye,
      note: plans[i].note,
    };
    if (keepPlayerSamples) {
      // Transposed out of the draw-major grid, so row d of every player's vector is the same
      // simulated week. That alignment is what makes correlations measurable.
      const own = new Float64Array(draws);
      for (let d = 0; d < draws; d++) own[d] = grid[d * count + i];
      detail[i].samples = own;
    }
  }
  out.players = detail;

  // The naive answer: solve the lineup once against each player's simulated MEAN. This is
  // what a spreadsheet produces. `adaptivity` is what the spreadsheet leaves on the table.
  const meanPts = new Float64Array(count);
  for (let i = 0; i < count; i++) meanPts[i] = draws > 0 ? sumPts[i] / draws : 0;
  const meanSolve = optimizeLineup(roster, slotList, (p) => {
    const i = index.get(p);
    return i === undefined ? 0 : meanPts[i];
  }, opts);
  out.naiveMean = r4(meanSolve.total);
  out.adaptivity = r4(out.mean - meanSolve.total);
  out.meanLineup = meanSolve.assignments.map((a) => ({
    slot: a.slot,
    id: a.player ? (a.player.id !== undefined ? String(a.player.id) : null) : null,
    name: a.player && typeof a.player.name === 'string' ? a.player.name : null,
    pts: r4(a.pts),
  }));

  // Ex-ante: freeze the mean-optimal lineup, then score it on every draw. Its mean is
  // naiveMean up to Monte Carlo error, but its spread is the one a manager actually lives
  // with — including the weeks a starter is inactive and the slot simply scores 0.
  const starterIdx = [];
  for (let a = 0; a < meanSolve.assignments.length; a++) {
    const pl = meanSolve.assignments[a].player;
    if (pl === null) continue;
    const i = index.get(pl);
    if (i !== undefined) starterIdx.push(i);
  }
  const exAnte = new Float64Array(draws);
  for (let d = 0; d < draws; d++) {
    const base = d * count;
    let t = 0;
    for (let s = 0; s < starterIdx.length; s++) t += grid[base + starterIdx[s]];
    exAnte[d] = t;
  }
  const ex = summarize(exAnte);
  out.exAnte = {
    mean: ex.mean, sd: ex.sd, p10: ex.p10, p50: ex.p50, p90: ex.p90,
    lineup: out.meanLineup,
  };
  if (keep) out.exAnte.samples = exAnte;

  const notes = [];
  for (let i = 0; i < count; i++) if (plans[i].note) notes.push(plans[i].note);
  out.notes = notes;
  if (keep) out.samples = samples;
  return out;
}

/* ===========================================================================
 * 10. simSeason
 * =========================================================================== */

/**
 * Two-state weekly availability chain, so an injury persists instead of resetting every week.
 *
 * Stationary probability of being out is q = 1 - avail. With P(back in | out) = b, the mean
 * absence is 1/b weeks and P(out | in) = a follows from q = a / (a + b). Setting
 * b = 1 - INJURY_PERSISTENCE gives a mean absence of 1 / (1 - persistence) weeks.
 *
 * Independent weeks (persistence 0) reduce to Bernoulli(avail) exactly, which is why that is
 * the escape hatch rather than a different code path.
 */
function injuryChain(avail, persistence) {
  const q = clamp01(1 - avail);
  const b = clamp01(1 - persistence);
  if (q <= 0) return { pOutFromIn: 0, pOutFromOut: 0 };
  if (q >= 1) return { pOutFromIn: 1, pOutFromOut: 1 };
  if (b <= 0) return { pOutFromIn: q, pOutFromOut: 1 };
  const a = clamp01((q * b) / (1 - q));
  return { pOutFromIn: a, pOutFromOut: 1 - b };
}

/**
 * Monte Carlo the remaining season for one roster.
 *
 * Each simulated season walks the weeks in order, so an injury in week 6 can still have the
 * player out in week 7 (see INJURY_PERSISTENCE), and re-solves the optimal lineup every week
 * of every season. Opponents are drawn as Normal(opponentMean, opponentSd) per week and
 * independently across weeks, because you play a different team each week.
 *
 * @param {Array<Object>} roster
 * @param {Object} opts
 *   fromWeek, toWeek    inclusive week range (default: 1..pack.meta.regSeasonWeeks)
 *   cfg, pack, slots, rng, n
 *   opponentMean, opponentSd   league-average opponent. Omitted => this roster's own weekly
 *                              mean and sd, i.e. a mirror of yourself, a clean 50% baseline.
 *   priorWins           wins already banked before fromWeek (default 0)
 *   playoffWinThreshold total wins needed to make the playoffs. INFERRED when omitted.
 *   teams, playoffTeams league shape used to infer that threshold (default 12 and 6)
 *   injuryPersistence   see SIM_CONSTANTS.INJURY_PERSISTENCE; 0 = independent weeks
 *   allowNegative       passed to optimizeLineup
 * @returns {{pointsPerWeek, expectedWins, playoffOdds, dist, ...}}
 */
export function simSeason(roster, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const pack = o.pack;
  const cfg = o.cfg && typeof o.cfg === 'object' ? o.cfg : DEFAULT_SCORING;
  const r = asRng(o.rng);
  const draws = Number.isFinite(o.n) && o.n > 0 ? Math.floor(o.n) : 1000;
  const slotList = resolveSlots(o.slots);
  const allowNegative = o.allowNegative !== false;
  const persistence = Number.isFinite(o.injuryPersistence)
    ? clamp01(o.injuryPersistence) : SIM_CONSTANTS.INJURY_PERSISTENCE;

  const regWeeks = pack && pack.meta && Number.isFinite(pack.meta.regSeasonWeeks)
    ? pack.meta.regSeasonWeeks : 18;
  let from = Number.isFinite(o.fromWeek) ? Math.floor(o.fromWeek) : 1;
  let to = Number.isFinite(o.toWeek) ? Math.floor(o.toWeek) : regWeeks;
  if (from < 1) from = 1;
  if (to < from) to = from;
  const weeks = [];
  for (let w = from; w <= to; w++) weeks.push(w);
  const W = weeks.length;

  const players = Array.isArray(roster) ? roster.filter((p) => p && typeof p === 'object') : [];
  const count = players.length;

  // Plans: one per player per week, all deterministic work done once up front.
  const plans = new Array(W);
  for (let wi = 0; wi < W; wi++) {
    const row = new Array(count);
    for (let i = 0; i < count; i++) row[i] = weekPlan(players[i], weeks[wi], cfg, pack);
    plans[wi] = row;
  }
  // Availability comes off the player, not off a week's plan: week `from` may be that
  // player's bye, and a bye plan reports avail 1 because there is nothing to be unavailable
  // for. Reading it from the plan there would silently make a fragile player durable.
  const chains = new Array(count);
  for (let i = 0; i < count; i++) {
    const a = Number(players[i].avail);
    chains[i] = injuryChain(Number.isFinite(a) ? clamp01(a) : 1, persistence);
  }

  const pts = new Float64Array(count);
  const index = new Map();
  for (let i = 0; i < count; i++) index.set(players[i], i);
  const ptsOf = (p) => {
    const i = index.get(p);
    return i === undefined ? 0 : pts[i];
  };
  const lineOpts = { allowNegative };

  const env = newEnv();
  const out = new Array(W);
  for (let wi = 0; wi < W; wi++) out[wi] = new Float64Array(draws);
  const totalPoints = new Float64Array(draws);
  const wins = new Float64Array(draws);
  const isOut = new Uint8Array(count);

  // --- pass 1: the roster's own weekly scores -----------------------------
  for (let d = 0; d < draws; d++) {
    isOut.fill(0);
    let seasonPts = 0;
    for (let wi = 0; wi < W; wi++) {
      env.teams.clear();
      const row = plans[wi];
      for (let i = 0; i < count; i++) {
        const plan = row[i];
        let v = 0;
        if (plan.live) {
          // Availability from the persistence chain, replacing the plan's own Bernoulli.
          const c = chains[i];
          const pOut = isOut[i] ? c.pOutFromOut : c.pOutFromIn;
          const stillOut = r() < pOut;
          isOut[i] = stillOut ? 1 : 0;
          if (!stillOut) v = drawActive(plan, env, r);
        }
        pts[i] = v;
      }
      const res = optimizeLineup(players, slotList, ptsOf, lineOpts);
      out[wi][d] = res.total;
      seasonPts += res.total;
    }
    totalPoints[d] = seasonPts;
  }

  // --- opponent model ------------------------------------------------------
  const weekSummaries = new Array(W);
  for (let wi = 0; wi < W; wi++) weekSummaries[wi] = summarize(out[wi]);

  let oppMeanDefault = 0;
  let oppSdDefault = 0;
  for (let wi = 0; wi < W; wi++) {
    oppMeanDefault += weekSummaries[wi].mean;
    oppSdDefault += weekSummaries[wi].sd;
  }
  oppMeanDefault = W > 0 ? oppMeanDefault / W : 0;
  oppSdDefault = W > 0 ? oppSdDefault / W : 0;

  const oppMean = Number.isFinite(o.opponentMean) ? o.opponentMean : oppMeanDefault;
  const oppSd = Number.isFinite(o.opponentSd) ? Math.max(0, o.opponentSd) : oppSdDefault;
  const opponentInferred = !Number.isFinite(o.opponentMean) || !Number.isFinite(o.opponentSd);

  // --- pass 2: play the schedule ------------------------------------------
  // Opponents are drawn after the roster's own weeks so the roster's stream does not depend
  // on the opponent parameters — same seed, same roster scores, whatever opponent you face.
  const weekWins = new Float64Array(W);
  for (let d = 0; d < draws; d++) {
    let w = 0;
    for (let wi = 0; wi < W; wi++) {
      const opp = Math.max(0, oppMean + oppSd * r.normal());
      const mine = out[wi][d];
      const res = mine > opp ? 1 : (mine < opp ? 0 : 0.5);
      w += res;
      weekWins[wi] += res;
    }
    wins[d] = w;
  }

  const priorWins = Number.isFinite(o.priorWins) ? o.priorWins : 0;
  const teamsInLeague = Number.isFinite(o.teams) && o.teams > 1 ? o.teams : 12;
  const playoffTeams = Number.isFinite(o.playoffTeams) && o.playoffTeams > 0 ? o.playoffTeams : 6;

  // The playoff cut is INFERRED when not supplied (contract section 10). A league where half
  // the teams advance cuts at .500; a stingier league cuts higher, scaled by how far
  // playoffTeams/teams sits below one half.
  const cutRate = 0.5 + 0.35 * (1 - (2 * playoffTeams) / teamsInLeague);
  const inferredThreshold = Math.ceil(W * Math.min(0.95, Math.max(0.05, cutRate)));
  const threshold = Number.isFinite(o.playoffWinThreshold)
    ? o.playoffWinThreshold : inferredThreshold;

  let made = 0;
  for (let d = 0; d < draws; d++) if (priorWins + wins[d] >= threshold) made++;

  // P(wins >= k) for every k, so the UI can apply its own cut instead of trusting ours.
  const winCdf = new Array(W + 1);
  for (let k = 0; k <= W; k++) {
    let c = 0;
    for (let d = 0; d < draws; d++) if (wins[d] >= k) c++;
    winCdf[k] = r4(draws > 0 ? c / draws : 0);
  }

  const winStats = summarize(wins);
  const ptStats = summarize(totalPoints);

  return {
    n: draws,
    fromWeek: from,
    toWeek: to,
    games: W,
    slots: slotList.map((s) => (typeof s === 'string' ? s : (s && s.id) || 'SLOT')),

    pointsPerWeek: weekSummaries.map((s, wi) => ({
      week: weeks[wi],
      mean: s.mean,
      sd: s.sd,
      p10: s.p10,
      p50: s.p50,
      p90: s.p90,
      winProb: r4(draws > 0 ? weekWins[wi] / draws : 0),
    })),

    expectedWins: winStats.mean,
    playoffOdds: r4(draws > 0 ? made / draws : 0),

    dist: {
      wins: {
        mean: winStats.mean,
        sd: winStats.sd,
        p10: winStats.p10,
        p50: winStats.p50,
        p90: winStats.p90,
        cdf: winCdf,
        samples: wins,
      },
      points: {
        mean: ptStats.mean,
        sd: ptStats.sd,
        p10: ptStats.p10,
        p50: ptStats.p50,
        p90: ptStats.p90,
        samples: totalPoints,
      },
    },

    opponent: {
      mean: r4(oppMean),
      sd: r4(oppSd),
      inferred: opponentInferred,
      note: opponentInferred
        ? 'No opponent supplied, so the opponent is a mirror of this roster: same mean, same '
          + 'spread. Win rate is therefore a clean 50% baseline and every delta is relative.'
        : '',
    },
    playoff: {
      threshold,
      priorWins,
      inferred: !Number.isFinite(o.playoffWinThreshold),
      note: Number.isFinite(o.playoffWinThreshold)
        ? ''
        : `Playoff cut inferred at ${threshold} of ${W} remaining wins for ${playoffTeams} of `
          + `${teamsInLeague} teams. Use dist.wins.cdf to apply your league's real cut.`,
    },
    injuryPersistence: persistence,
  };
}

/**
 * The active-week draw used by simSeason: identical to `drawPoints` except that availability
 * has already been resolved by the persistence chain. Kept separate rather than parameterized
 * so the single-week path stays a straight line.
 */
function drawActive(plan, env, rng) {
  if (!plan.live) return 0;
  if (plan.pos === 'K') return drawKicker(plan, rng, null);
  if (plan.pos === 'DST') return drawDst(plan, env, rng, null);
  return drawOffense(plan, env, rng, null);
}

/* ===========================================================================
 * 11. Introspection helper
 * =========================================================================== */

/**
 * One draw of a player's raw component line, for tests and for the "show me a simulated box
 * score" view. Returns {line, points}.
 */
export function drawPlayerLine(player, week, cfg, pack, rng) {
  const plan = weekPlan(player, week, cfg, pack);
  const line = {};
  const env = newEnv();
  const points = drawPoints(plan, env, asRng(rng), line);
  return { line, points, plan };
}
