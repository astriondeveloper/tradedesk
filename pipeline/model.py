"""The projection model.

Produces, for every fantasy-relevant player, a per-game distribution over *components*
(never over fantasy points -- the browser scores them, so any league format works).

The structure is a volume x efficiency decomposition, anchored to the betting market:

    team volume      <- pace and pass rate, scaled to the market-implied team total
    player share     <- recency-weighted usage, shrunk toward an empirical role prior
    efficiency       <- per-opportunity rates, regressed by how quickly each stabilizes
    touchdowns       <- expected TDs from play-by-play opportunity, not realized TDs
    opponent         <- defense-vs-position, shrunk hard because the true effect is small

and then reconciled: every team's projected player totals are scaled so they sum to that
team's projected team totals. Unreconciled projections are the reason public numbers so
often imply a team throwing for 5,200 yards.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

import features as F  # noqa: E402
import priors as P  # noqa: E402
import redzone as RZ  # noqa: E402
from identity import Resolver, norm_team  # noqa: E402
from sources import CACHE, LOG_SEASONS, TARGET_SEASON  # noqa: E402

COEF_PATH = Path(__file__).resolve().parent / "coefficients.json"

# Fraction of dropbacks that become pass attempts (the rest are sacks), and the fraction
# of attempts that produce a charted target (the rest are throwaways, spikes, batted
# balls). Both recomputed at build time; these are only fallbacks.
SACK_RATE = 0.065
TARGET_PER_ATTEMPT = 0.95

# Availability floor/ceiling for the FANTASY view of a player: no starter is certain to
# play every week, and none is hopeless. This is what shapes a player's floor.
AVAIL_CLAMP = (0.55, 0.97)

# Availability for the RECONCILIATION view is a different quantity and needs a different
# floor. There, `a` must be the honest probability a player is active at all, because the
# constraint being enforced is SUM(a_i * share_i) = 1 across the whole roster. A team's
# tenth receiver has maybe a 10% chance of being active in a given week, not 55%; giving
# him the fantasy floor inflates the weighted sum and deflates every real contributor.
ACTIVE_CLAMP = (0.03, 0.98)


def active_probability(role_priors: dict, pos: str, rank: int, own_rate: float | None,
                       reg_weeks: int = 17) -> float:
    """Probability a player is active in a given week.

    Anchored on the empirical median games played at each depth rank (priors.py measures
    it alongside the usage shares), blended with the player's own history where he has
    any. Decays past the table so deep reserves land near zero rather than at a floor.
    """
    table = role_priors.get(pos, {})
    base = 0.25
    if table:
        ranks = sorted(int(r) for r in table)
        deepest = ranks[-1]
        key = str(rank) if (rank <= deepest and str(rank) in table) else str(deepest)
        g = _num(table[key].get("games"), 10.0)
        base = g / max(reg_weeks, 1)
        if rank > deepest:
            base *= DEPTH_DECAY ** (rank - deepest)
    if own_rate is not None and np.isfinite(own_rate):
        base = 0.6 * float(own_rate) + 0.4 * base
    return float(np.clip(base, *ACTIVE_CLAMP))


def load_coefficients() -> dict:
    if not COEF_PATH.exists():
        raise RuntimeError("run `python3 pipeline/calibrate.py` first")
    return json.loads(COEF_PATH.read_text())


# ---------------------------------------------------------------------------
# Weighted player history
# ---------------------------------------------------------------------------

def weighted_player_rates(hist: pd.DataFrame, team_hist: pd.DataFrame) -> pd.DataFrame:
    """Recency-weighted per-game usage, shares, and efficiency for every player."""
    tv = P._team_game_volume(team_hist)
    m = hist.merge(tv, on=["season", "week", "team"], how="left")
    m = m.sort_values(["gsis_id", "season", "week"])

    rows = []
    for pid, g in m.groupby("gsis_id", sort=False):
        n = len(g)
        if n == 0:
            continue
        w = F._hl_weights(n, F.RECENCY_HALFLIFE_GAMES)
        sw = w.sum()

        def wsum(col: str) -> float:
            return float(np.dot(g[col].fillna(0.0).to_numpy(dtype=float), w))

        def wmean(col: str) -> float:
            return wsum(col) / sw if sw > 0 else 0.0

        tgt, ratt, patt = wsum("tgt"), wsum("ratt"), wsum("patt")
        team_tgt, team_ratt, team_patt = wsum("team_tgt"), wsum("team_ratt"), wsum("team_patt")

        rows.append({
            "gsis_id": pid,
            "pos": g["pos"].mode().iloc[0] if len(g["pos"].mode()) else g["pos"].iloc[0],
            "name": g["name"].iloc[-1],
            "last_team": g["team"].iloc[-1],
            "w_games": float(sw),
            "n_games": int(n),
            "last_season": int(g["season"].max()),
            # per-game usage
            "tgt_pg": wmean("tgt"), "ratt_pg": wmean("ratt"), "patt_pg": wmean("patt"),
            # shares of team volume
            "tgt_share": tgt / team_tgt if team_tgt > 0 else np.nan,
            "rush_share": ratt / team_ratt if team_ratt > 0 else np.nan,
            "db_share": patt / team_patt if team_patt > 0 else np.nan,
            # efficiency, as weighted totals so shrinkage can use real opportunity counts
            "tgt_tot": tgt, "rec_tot": wsum("rec"), "reyd_tot": wsum("reyd"),
            "ratt_tot": ratt, "ryd_tot": wsum("ryd"),
            "patt_tot": patt, "pyd_tot": wsum("pyd"), "pcmp_tot": wsum("pcmp"),
            "ptd_tot": wsum("ptd"), "pint_tot": wsum("pint"),
            "retd_tot": wsum("retd"), "rtd_tot": wsum("rtd"),
            "fuml_tot": wsum("fuml"), "p40_tot": wsum("p40"),
            "r40_tot": wsum("r40"), "re40_tot": wsum("re40"),
            "pfd_tot": wsum("pfd"), "rfd_tot": wsum("rfd"), "refd_tot": wsum("refd"),
            "psack_tot": wsum("psack"), "sttd_tot": wsum("sttd"),
            "p2p_tot": wsum("p2p"), "r2p_tot": wsum("r2p"), "re2p_tot": wsum("re2p"),
        })
    return pd.DataFrame(rows)


def per_player_cv(hist: pd.DataFrame, coef: dict) -> pd.DataFrame:
    """Week-to-week coefficient of variation in usage, shrunk to the positional median.

    This is what sets the width of each player's weekly distribution, which is what makes
    floor and ceiling mean something rather than being mean +/- an arbitrary constant.
    """
    recent = hist[hist["season"] >= hist["season"].max() - 1]
    pos_cv = coef.get("positional_cv", {})
    rows = []
    for (pid, pos), g in recent.groupby(["gsis_id", "pos"]):
        chan = {"QB": "patt", "RB": "ratt", "WR": "tgt", "TE": "tgt"}.get(pos)
        if chan is None:
            continue
        s = g[chan].astype(float)
        s = s[s.notna()]
        if len(s) < 5 or s.mean() < 2:
            continue
        obs = float(s.std() / s.mean()) if s.mean() > 0 else np.nan
        if not np.isfinite(obs):
            continue
        prior = float(pos_cv.get(pos, {}).get(chan, 0.45))
        n = len(s)
        k = 10.0
        rows.append({"gsis_id": pid, "usage_cv": (n * obs + k * prior) / (n + k)})
    return pd.DataFrame(rows) if rows else pd.DataFrame(columns=["gsis_id", "usage_cv"])


# ---------------------------------------------------------------------------
# Team weekly context
# ---------------------------------------------------------------------------

def team_week_factors(sched: dict, coef: dict) -> tuple[dict, dict]:
    """Per (team, week) multipliers relative to that team's own season-average context.

    Split into a volume factor and a touchdown factor because they respond differently:
    plays barely move with the game total, while touchdowns scale strongly with the
    implied team total.
    """
    pr = coef["pass_rate"]
    pl = coef["plays"]
    td = coef["off_td_vs_implied"]

    all_totals = [w["total"] for t in sched for w in sched[t]]
    mean_total = float(np.mean(all_totals)) if all_totals else 44.0

    def plays_of(total: float) -> float:
        return pl["intercept"] + pl["per_point_total"] * (total - mean_total)

    def pass_rate_of(total: float, spread_favored: float) -> float:
        v = (pr["intercept"] + pr["per_point_favored"] * spread_favored
             + pr["per_point_total"] * (total - mean_total))
        return float(np.clip(v, 0.42, 0.72))

    def off_td_of(implied: float) -> float:
        return max(0.4, td["intercept"] + td["per_implied_point"] * implied)

    factors: dict[str, dict] = {}
    base: dict[str, dict] = {}
    for team, weeks in sched.items():
        implieds = [w["implied"] for w in weeks]
        totals = [w["total"] for w in weeks]
        spreads = [w["implied"] - w["oppImplied"] for w in weeks]
        b_imp = float(np.mean(implieds))
        b_tot = float(np.mean(totals))
        b_spr = float(np.mean(spreads))

        b_plays = plays_of(b_tot)
        b_pr = pass_rate_of(b_tot, b_spr)
        b_td = off_td_of(b_imp)

        base[team] = {
            "implied": round(b_imp, 3),
            "plays": round(b_plays, 3),
            "pass_rate": round(b_pr, 4),
            "dropbacks": round(b_plays * b_pr, 3),
            "rush_att": round(b_plays * (1 - b_pr), 3),
            "pass_att": round(b_plays * b_pr * (1 - SACK_RATE), 3),
            "targets": round(b_plays * b_pr * (1 - SACK_RATE) * TARGET_PER_ATTEMPT, 3),
            "off_td": round(b_td, 3),
            # Team passing yards per game. Receiving yards reconcile against this, since
            # a passing yard and a receiving yard are the same yard seen from both ends.
            "pass_yds": round(b_plays * b_pr * (1 - SACK_RATE) * coef["efficiency"]["league_ypa"], 2),
        }

        fw = {}
        for w in weeks:
            spread = w["implied"] - w["oppImplied"]
            plays = plays_of(w["total"])
            prate = pass_rate_of(w["total"], spread)
            fw[w["w"]] = {
                "pass": round((plays * prate) / max(b_plays * b_pr, 1e-6), 4),
                "rush": round((plays * (1 - prate)) / max(b_plays * (1 - b_pr), 1e-6), 4),
                "td": round(off_td_of(w["implied"]) / max(b_td, 1e-6), 4),
                "opp": w["opp"],
                "home": w["home"],
                "roof": w["roof"],
                "implied": w["implied"],
                "oppImplied": w["oppImplied"],
                "src": w["src"],
            }
        factors[team] = fw
    return factors, base


# ---------------------------------------------------------------------------
# Player projection
# ---------------------------------------------------------------------------

def _num(v, default: float = 0.0) -> float:
    """NaN-safe float. `float(x or 0.0)` does NOT do this: NaN is truthy in Python, so
    that idiom passes NaN straight through and it then poisons every downstream sum."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if np.isfinite(f) else default


def _shrink(obs: float, prior: float, n: float, k: float) -> float:
    obs = float(obs) if obs is not None else np.nan
    prior = _num(prior, 0.0)
    n, k = _num(n, 0.0), _num(k, 1.0)
    if not np.isfinite(obs):
        return prior
    denom = n + k
    return prior if denom <= 0 else (n * obs + k * prior) / denom


# Per-rank decay applied past the deepest rank the empirical table covers.
DEPTH_DECAY = 0.42


def role_prior(role_priors: dict, pos: str, rank: int) -> dict:
    """Usage prior for a position at a given depth rank, extrapolated past the table.

    priors.py only emits a rank once it has enough team-seasons behind it, so the table
    stops at rank 4 or 5 depending on position. Every deeper player still needs a prior,
    and it must be SMALL: an earlier version fell back to a flat 0.05 target share for
    anything off the table, which handed a team's sixth and seventh tight ends five
    percent of the passing game each and inflated every roster's target shares to roughly
    double the real budget.

    So: take the deepest rank the table does cover, and decay geometrically from there.
    """
    table = role_priors.get(pos, {})
    if not table:
        return {}
    ranks = sorted(int(r) for r in table)
    deepest = ranks[-1]
    if rank <= deepest and str(rank) in table:
        return dict(table[str(rank)])
    base = dict(table[str(deepest)])
    decay = DEPTH_DECAY ** max(0, rank - deepest)
    return {k: (v * decay if k.endswith("_share") else v) for k, v in base.items()}


def project_players(
    rates: pd.DataFrame,
    universe: pd.DataFrame,
    role_priors: dict,
    opp: pd.DataFrame,
    curves: dict,
    base: dict,
    coef: dict,
    own_active: dict | None = None,
) -> pd.DataFrame:
    """Per-game component means for each player, in his team's average 2026 context."""
    own_active = own_active or {}
    eff = coef["efficiency"]
    r = universe.merge(rates.drop(columns=["pos", "name"], errors="ignore"), on="gsis_id", how="left")

    # Expected-TD rates per opportunity, from play-by-play, blended with realized.
    o = opp.groupby("gsis_id").agg(
        x_rtd=("x_rtd", "sum"), a_rtd=("a_rtd", "sum"),
        x_retd=("x_retd", "sum"), a_retd=("a_retd", "sum"),
        ratt_pbp=("ratt", "sum"), tgt_pbp=("tgt", "sum"),
    ).reset_index()
    r = r.merge(o, on="gsis_id", how="left")

    W = F.TD_EXPECTED_WEIGHT
    league_rush_td = curves.get("rush_overall", 0.034)
    league_tgt_td = curves.get("target_overall", 0.046)

    out = []
    for _, p in r.iterrows():
        pos = p["pos"]
        team = p["team"]
        b = base.get(team)
        if b is None or pos not in ("QB", "RB", "WR", "TE"):
            continue

        rank = int(p.get("dc_rank") or 3)
        rp = role_prior(role_priors, pos, rank)
        n_games = _num(p.get("w_games"))

        # ---- usage shares -------------------------------------------------------
        # Defaults are 0.0, not a nonzero constant: an unknown deep player should project
        # to nothing, and let his own history speak if he has any.
        tgt_share = _shrink(p.get("tgt_share", np.nan), rp.get("tgt_share", 0.0),
                            n_games, F.SHRINK_TGT_SHARE)
        rush_share = _shrink(p.get("rush_share", np.nan), rp.get("rush_share", 0.0),
                             n_games, F.SHRINK_RUSH_SHARE)
        db_share = _shrink(p.get("db_share", np.nan), rp.get("db_share", 0.0),
                           n_games, F.SHRINK_TGT_SHARE)

        tgt = max(0.0, tgt_share) * b["targets"]
        ratt = max(0.0, rush_share) * b["rush_att"]
        patt = max(0.0, db_share) * b["pass_att"] if pos == "QB" else 0.0

        # ---- efficiency ---------------------------------------------------------
        tgt_tot = _num(p.get("tgt_tot"))
        ratt_tot = _num(p.get("ratt_tot"))
        patt_tot = _num(p.get("patt_tot"))

        ypt = _shrink(_num(p.get("reyd_tot")) / tgt_tot if tgt_tot > 0 else np.nan,
                      eff["league_ypt"], tgt_tot, F.SHRINK_YPT)
        catch = _shrink(_num(p.get("rec_tot")) / tgt_tot if tgt_tot > 0 else np.nan,
                        eff["league_catch_rate"], tgt_tot, F.SHRINK_CATCH_RATE)
        ypc = _shrink(_num(p.get("ryd_tot")) / ratt_tot if ratt_tot > 0 else np.nan,
                      eff["league_ypc"], ratt_tot, F.SHRINK_YPC)
        ypa = _shrink(_num(p.get("pyd_tot")) / patt_tot if patt_tot > 0 else np.nan,
                      eff["league_ypa"], patt_tot, 120.0)

        # ---- touchdowns: expected from opportunity, lightly blended with realized --
        rz_ratt = _num(p.get("ratt_pbp"))
        rz_tgt = _num(p.get("tgt_pbp"))
        x_rtd_rate = (_num(p.get("x_rtd")) / rz_ratt) if rz_ratt > 0 else league_rush_td
        a_rtd_rate = (_num(p.get("a_rtd")) / rz_ratt) if rz_ratt > 0 else league_rush_td
        x_retd_rate = (_num(p.get("x_retd")) / rz_tgt) if rz_tgt > 0 else league_tgt_td
        a_retd_rate = (_num(p.get("a_retd")) / rz_tgt) if rz_tgt > 0 else league_tgt_td

        rtd_rate = _shrink(W * x_rtd_rate + (1 - W) * a_rtd_rate, league_rush_td, rz_ratt, 60.0)
        retd_rate = _shrink(W * x_retd_rate + (1 - W) * a_retd_rate, league_tgt_td, rz_tgt, 60.0)

        # ---- QB passing touchdowns and interceptions ----------------------------
        ptd_rate = _shrink(_num(p.get("ptd_tot")) / patt_tot if patt_tot > 0 else np.nan,
                           0.045, patt_tot, 150.0)
        pint_rate = _shrink(_num(p.get("pint_tot")) / patt_tot if patt_tot > 0 else np.nan,
                            0.023, patt_tot, 200.0)

        gp = max(_num(p.get("n_games"), 1.0), 1.0)
        denom = max(_num(p.get("w_games"), gp), 1e-6)

        def per_game(col: str) -> float:
            """Weighted per-game rate for components carried straight through from history."""
            return _num(p.get(col)) / denom

        mu = {
            "tgt": tgt, "rec": tgt * catch, "reyd": tgt * ypt, "retd": tgt * retd_rate,
            "ratt": ratt, "ryd": ratt * ypc, "rtd": ratt * rtd_rate,
            "patt": patt, "pcmp": patt * _shrink(
                _num(p.get("pcmp_tot")) / patt_tot if patt_tot > 0 else np.nan,
                0.655, patt_tot, 150.0),
            "pyd": patt * ypa, "ptd": patt * ptd_rate, "pint": patt * pint_rate,
            "psack": per_game("psack_tot"),
            "fuml": per_game("fuml_tot"),
            "sttd": per_game("sttd_tot"),
            "p40": per_game("p40_tot"), "r40": per_game("r40_tot"), "re40": per_game("re40_tot"),
            "pfd": per_game("pfd_tot"), "rfd": per_game("rfd_tot"), "refd": per_game("refd_tot"),
            "p2p": per_game("p2p_tot"), "r2p": per_game("r2p_tot"), "re2p": per_game("re2p_tot"),
        }
        rec = {"gsis_id": p["gsis_id"], "pos": pos, "team": team,
               "active": active_probability(role_priors, pos, rank,
                                            own_active.get(p["gsis_id"])),
               "tgt_share": tgt_share, "rush_share": rush_share, "db_share": db_share,
               "ypt": ypt, "catch_rate": catch, "ypc": ypc, "ypa": ypa,
               "rtd_rate": rtd_rate, "retd_rate": retd_rate,
               "x_td": float(p.get("x_rtd") or 0) + float(p.get("x_retd") or 0),
               "a_td": float(p.get("a_rtd") or 0) + float(p.get("a_retd") or 0)}
        mu = {k: _num(v) for k, v in mu.items()}
        rec.update({f"mu_{k}": v for k, v in mu.items()})
        out.append(rec)

    return pd.DataFrame(out)


DEPS = {
    "mu_tgt": ["mu_rec", "mu_reyd", "mu_retd", "mu_re40", "mu_refd"],
    "mu_ratt": ["mu_ryd", "mu_rtd", "mu_r40", "mu_rfd"],
}


def reconcile_to_team(proj: pd.DataFrame, base: dict, avail: dict | None = None) -> pd.DataFrame:
    """Make each team's projected usage add up to a real football game.

    Every mu here is PER GAME PLAYED, not per team game -- a backup's projection is what
    he does when he is on the field, and how often that happens is carried separately in
    `avail`. Two consequences shape this function:

      * Targets and carries are shared within a single game, so the players in the
        rotation must sum to the team's actual per-game volume. Shrinkage pulls every
        deep player toward a role prior, so the raw shares always sum to more than one;
        normalizing over the rotation is what puts them back on the simplex.
      * Quarterback attempts are NOT shared. A team's QB1 and QB2 do not split a game;
        each is projected at starter volume, and the odds he is the one starting live in
        `avail`. Normalizing across them would halve both, which is how the first pass
        of this model ended up projecting every starting quarterback for 19 attempts.

    The normalization is AVAILABILITY-WEIGHTED, and that detail is worth stating plainly
    because getting it wrong silently costs about 25% of every projection.

    A usage share is conditional on the player being active: it is his targets divided by
    his team's targets IN THE GAMES HE PLAYED. Summed raw across a roster those shares do
    not come to 1.0 -- measured on real seasons they come to 1.34, 1.39 and 1.42 for
    targets in 2023-2025 -- because each player's share is measured against a different
    subset of games. What does hold, to within half a percent in every season checked, is

        SUM over players of ( availability_i * share_i )  =  1.0

    since in any single game the players actually on the field split exactly one game's
    worth of targets. Normalizing the unweighted sum to 1.0 instead deflates every player
    by the roster's absentee rate; an earlier version of this function did exactly that
    and the 2025 backtest showed a systematic -1.67 points per game bias as a result.
    """
    p = proj.copy()
    if "active" in p.columns:
        a = p["active"].map(_num).astype(float)
    else:
        avail = avail or {}
        a = p["gsis_id"].map(lambda i: _num(avail.get(i), 0.4)).astype(float)

    for team, grp in p.groupby("team"):
        b = base.get(team)
        if not b:
            continue
        idx = grp.index

        for col, target in (("mu_tgt", b["targets"]), ("mu_ratt", b["rush_att"])):
            vals = p.loc[idx, col].astype(float)
            weighted = float((vals * a.loc[idx]).sum())
            if weighted <= 1e-6 or target <= 0:
                continue
            scale = target / weighted
            p.loc[idx, col] = vals * scale

            # Dependents move with their driver so efficiency rates stay intact.
            for d in DEPS[col]:
                p.loc[idx, d] = p.loc[idx, d] * scale

        # Receiving yards must equal passing yards -- they are the same yards, counted
        # from the two ends of the throw. Nothing upstream enforces that: targets are
        # reconciled but per-target efficiency is not, and the market blend moves a
        # passer's yardage and his receivers' yardage independently. So tie them together
        # here, against the team's projected starting quarterback.
        target_pass_yds = b.get("pass_yds", 0.0)
        if target_pass_yds > 0:
            rec_yds = float((p.loc[idx, "mu_reyd"] * a.loc[idx]).sum())
            if rec_yds > 1e-6:
                p.loc[idx, "mu_reyd"] *= target_pass_yds / rec_yds

        # Touchdowns: rushing + receiving TDs across a roster are the team's offensive
        # touchdowns (a passing TD is the same event as its receiving TD), so they
        # reconcile against the implied-total-derived team touchdown expectation.
        td = (p.loc[idx, "mu_rtd"] + p.loc[idx, "mu_retd"]).astype(float)
        weighted_td = float((td * a.loc[idx]).sum())
        if weighted_td > 1e-6 and b["off_td"] > 0:
            scale = float(b["off_td"] / weighted_td)
            p.loc[idx, "mu_rtd"] *= scale
            p.loc[idx, "mu_retd"] *= scale
    return p
