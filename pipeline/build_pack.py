"""Compile every input into the single data pack the app ships with.

Run:  python3 pipeline/build_pack.py
Out:  app/data/pack.js   (window.TD_PACK = {...})

Design rule, from docs/ARCHITECTURE.md: this file emits COMPONENTS and model parameters,
never fantasy points. Scoring happens in the browser so the same pack serves full PPR,
half PPR, standard, superflex, TE-premium, and anything the user hand-configures.
"""

from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

import checks  # noqa: E402
import features as F  # noqa: E402
import market  # noqa: E402
import model as M  # noqa: E402
import priors as P  # noqa: E402
import redzone as RZ  # noqa: E402
from components import DST_KEYS  # noqa: E402
from identity import Resolver, norm_team  # noqa: E402
from sources import CACHE, LOG_SEASONS, TARGET_SEASON, manifest  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "app" / "data" / "pack.js"

# Components carried in each player's shipped weekly log. Chosen to be exactly what the
# scoring engine needs, so historical weeks can be re-scored under any league format.
LOG_KEYS = [
    "patt", "pcmp", "pyd", "ptd", "pint", "psack", "p2p", "p40", "pfd",
    "ratt", "ryd", "rtd", "r2p", "r40", "rfd",
    "tgt", "rec", "reyd", "retd", "re2p", "re40", "refd",
    "fuml", "sttd",
]
DST_LOG_KEYS = ["sack", "dint", "fumrec", "safety", "dtd", "blk", "sttd", "ptsAllowed", "ydsAllowed"]
K_LOG_KEYS = ["fgm_0_19", "fgm_20_29", "fgm_30_39", "fgm_40_49", "fgm_50_59", "fgm_60",
              "fgx_0_19", "fgx_20_29", "fgx_30_39", "fgx_40_49", "fgx_50_59", "fgx_60",
              "xpm", "xpx"]

TEAM_NAMES = {
    "ARI": "Cardinals", "ATL": "Falcons", "BAL": "Ravens", "BUF": "Bills", "CAR": "Panthers",
    "CHI": "Bears", "CIN": "Bengals", "CLE": "Browns", "DAL": "Cowboys", "DEN": "Broncos",
    "DET": "Lions", "GB": "Packers", "HOU": "Texans", "IND": "Colts", "JAX": "Jaguars",
    "KC": "Chiefs", "LA": "Rams", "LAC": "Chargers", "LV": "Raiders", "MIA": "Dolphins",
    "MIN": "Vikings", "NE": "Patriots", "NO": "Saints", "NYG": "Giants", "NYJ": "Jets",
    "PHI": "Eagles", "PIT": "Steelers", "SEA": "Seahawks", "SF": "49ers", "TB": "Buccaneers",
    "TEN": "Titans", "WAS": "Commanders",
}


def r2(x, nd=3):
    """Round for pack size. NaN/inf never reach the app."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(v):
        return 0.0
    return round(v, nd)


# ---------------------------------------------------------------------------
# Universe
# ---------------------------------------------------------------------------

def build_universe(rates, roster, depth, ecr, resolver) -> pd.DataFrame:
    """Everyone worth having in a fantasy tool, with a resolved current team.

    Union of: the FantasyPros redraft board (the draftable market), and anyone on a 2026
    roster with real recent usage. Team comes from the 2026 roster first, then the depth
    chart, then ECR -- so an offseason move is reflected even when one source lags.
    """
    rows = {}

    # 1. Everyone on a 2026 roster at a fantasy position.
    r = roster[roster["pos"].isin(["QB", "RB", "WR", "TE", "K", "FB", "PK"])].copy()
    r["pos"] = r["pos"].replace({"FB": "RB", "PK": "K"})
    for _, x in r.iterrows():
        rows[x["gsis_id"]] = {
            "gsis_id": x["gsis_id"], "name": x["name"], "pos": x["pos"],
            "team": norm_team(x["team"]), "status": x.get("status", "ACT"),
            "birth_date": x.get("birth_date"), "years_exp": x.get("years_exp"),
            "source": "roster2026",
        }

    # 2. ECR board members, matched by name. Anyone unmatched is still carried, because a
    #    player the market ranks inside the top 300 is tradeable whether or not this
    #    particular roster feed lists him.
    unmatched = []
    if len(ecr):
        for _, x in ecr.iterrows():
            if x["pos"] not in ("QB", "RB", "WR", "TE", "K"):
                continue
            pid = resolver.resolve(x["player"], x.get("tm", ""), x["pos"])
            if pid and pid in rows:
                continue
            if pid:
                rows[pid] = {"gsis_id": pid, "name": x["player"], "pos": x["pos"],
                             "team": norm_team(x.get("tm", "")), "status": "ACT",
                             "birth_date": None, "years_exp": None, "source": "ecr"}
            else:
                key = f"ecr:{x['player']}:{x['pos']}"
                unmatched.append({"gsis_id": key, "name": x["player"], "pos": x["pos"],
                                  "team": norm_team(x.get("tm", "")), "status": "UNKNOWN",
                                  "birth_date": None, "years_exp": None, "source": "ecr_only"})
    for u in unmatched:
        rows.setdefault(u["gsis_id"], u)

    uni = pd.DataFrame(list(rows.values()))

    # Depth chart overrides team + gives the role rank that drives priors.
    if len(depth):
        uni = uni.merge(depth, on="gsis_id", how="left")
        has_dc = uni["dc_team"].notna()
        uni.loc[has_dc, "team"] = uni.loc[has_dc, "dc_team"]
    else:
        uni["dc_team"] = np.nan
        uni["dc_pos"] = np.nan
        uni["dc_rank"] = np.nan

    uni["team"] = uni["team"].fillna("FA").map(lambda t: norm_team(t) or "FA")
    return uni


def assign_role_rank(uni: pd.DataFrame, rates: pd.DataFrame, ecr_rank: dict) -> pd.DataFrame:
    """Fill missing depth-chart rank from market rank within the player's own team+position.

    A player with no depth-chart row still needs a role prior. Ordering his team's
    position group by expert rank is the best available stand-in.
    """
    u = uni.copy()
    u["_ecr"] = u["gsis_id"].map(ecr_rank).fillna(999.0)
    need = u["dc_rank"].isna()
    if need.any():
        ranked = (u[need].sort_values("_ecr")
                  .groupby(["team", "pos"]).cumcount() + 1)
        u.loc[need, "dc_rank"] = ranked
    # Deliberately NOT clipped to the prior table's depth. The table stops at rank 5, but
    # the rank itself must keep counting -- model.project_players decays the prior beyond
    # rank 5, and clipping here would hand a team's tenth receiver a WR5 role prior. With
    # ~25 pass catchers per roster that alone inflated team target shares to ~1.5x.
    u["dc_rank"] = pd.to_numeric(u["dc_rank"], errors="coerce").fillna(6).clip(1, 12)
    return u


# ---------------------------------------------------------------------------
# D/ST and kickers
# ---------------------------------------------------------------------------

def project_dst(team_hist, games, sched, coef) -> dict:
    """Per-team D/ST, projected per week from the opponent's implied total.

    This league stacks BOTH points-allowed and yards-allowed tiers, which makes D/ST swing
    much harder than in a typical league -- a shutout is worth ~10 on tiers alone and a
    blowout loss goes negative. That makes the weekly opponent the dominant term, so D/ST
    is projected week by week rather than as a season average.
    """
    from components import team_defense_components

    d = team_defense_components(team_hist, games)
    recent = d[d["season"] >= d["season"].max() - 1]

    league = {k: float(recent[k].mean()) for k in ("sack", "dint", "fumrec", "safety", "dtd", "blk", "sttd")}
    by_team = recent.groupby("team")[["sack", "dint", "fumrec", "safety", "dtd", "blk", "sttd"]].mean()

    # Shrink each team's defensive event rates toward the league mean.
    K = 12.0
    n = recent.groupby("team").size()
    shrunk = {}
    for t in by_team.index:
        nt = float(n.get(t, 0))
        shrunk[t] = {k: (nt * float(by_team.loc[t, k]) + K * league[k]) / (nt + K) for k in league}

    # Yards allowed responds to opponent quality; use the league relationship between a
    # team's implied total and the yards it produces.
    ty = coef["team_yards"]
    tp = coef["team_points"]
    yards_per_point = ty["mean"] / max(tp["mean"], 1e-6)

    out = {}
    for team, weeks in sched.items():
        base = shrunk.get(team, league)
        wk = {}
        for w in weeks:
            opp_pts = w["oppImplied"]
            wk[w["w"]] = {
                "opp": w["opp"], "home": w["home"],
                "mu": {
                    **{k: r2(v) for k, v in base.items()},
                    "ptsAllowed": r2(opp_pts, 2),
                    "ydsAllowed": r2(opp_pts * yards_per_point, 1),
                },
            }
        out[team] = {
            "sd": {"ptsAllowed": r2(tp["resid_sd_vs_implied"], 2), "ydsAllowed": r2(ty["sd"], 1)},
            "weeks": wk,
        }
    return out


# Indoor kicking, fitted rather than guessed. Regressing kicker points (scored under this
# league's exact distance rules) on implied team total and an indoor flag, over 2,716
# kicker-games from 2021-2025:
#
#     points = 4.305 + 0.1482 * implied_total + 0.828 * indoor
#              (t = 6.32 on the total, t = 4.30 on indoor)
#
# So the dome is worth +0.83 points a game on its own, on top of whatever the offense is
# worth -- and the whole kicker position only spans about 1.7 points, so that is most of
# the available spread. It arrives through two channels, both measured:
#   attempts   2.045 per game indoors vs 1.879 outdoors  (+8.8%)
#   make rate  +0.1pp at 30-39, +3.4pp at 40-49, +4.3pp at 50-59 -- weather costs distance,
#              not short kicks, which is exactly what a -1 miss penalty punishes.
# The first version of this used a flat 1.04 attempt bump and a 2% make-rate bump, which
# reproduced only +0.12 points a game -- about an eighth of the real effect.
DOME_ATT_MULT = 1.088
DOME_MAKE_BONUS = {"30_39": 0.001, "40_49": 0.034, "50_59": 0.043, "60": 0.043}


def project_kickers(uni, hist, sched, fg_profile, coef) -> dict:
    """Kicker component projection.

    Field goal attempts scale with how often an offense stalls in scoring range, PATs with
    how often it finishes. Distance mix comes from the league profile; make rates by
    bucket come from real play-by-play. Indoor games get the fitted bump above, which
    matters here because this league pays 6 for a 60-yarder and charges 1 for a miss.
    """
    ks = uni[uni["pos"] == "K"]
    kh = hist[hist["pos"] == "K"]
    recent = kh[kh["season"] >= kh["season"].max() - 2]

    per_game = recent.groupby("gsis_id").agg(
        g=("week", "size"),
        fga=("fgm_0_19", "sum"),
    )

    # League baselines for attempts, from team scoring.
    td_c = coef["off_td_vs_implied"]

    def fga_of(implied: float) -> float:
        # Points not scored as touchdowns mostly become field goal tries.
        td_pts = (td_c["intercept"] + td_c["per_implied_point"] * implied) * 7.0
        return float(np.clip((implied - td_pts) / 3.0, 0.6, 3.6))

    def xp_of(implied: float) -> float:
        return float(np.clip(td_c["intercept"] + td_c["per_implied_point"] * implied, 0.3, 4.5))

    dist_share = {k: v["att_share"] for k, v in fg_profile.items()}
    make_rate = {k: v["rate"] for k, v in fg_profile.items()}
    tot_share = sum(dist_share.values()) or 1.0

    out = {}
    for _, k in ks.iterrows():
        team = k["team"]
        weeks = sched.get(team)
        if not weeks:
            continue
        wk = {}
        for w in weeks:
            dome = str(w.get("roof", "")).lower() in ("dome", "closed")
            fga = fga_of(w["implied"]) * (DOME_ATT_MULT if dome else 1.0)
            mu = {}
            for b, share in dist_share.items():
                att = fga * (share / tot_share)
                rate = make_rate.get(b, 0.85)
                # Indoors removes wind. Added in percentage points, not as a multiplier:
                # the measured gain is concentrated in long attempts and is close to zero
                # inside 40 yards, which a multiplicative bump would smear the wrong way.
                if dome:
                    rate = min(0.99, rate + DOME_MAKE_BONUS.get(b, 0.0))
                mu[f"fgm_{b}"] = r2(att * rate)
                mu[f"fgx_{b}"] = r2(att * (1 - rate))
            mu["xpm"] = r2(xp_of(w["implied"]) * 0.96)
            mu["xpx"] = r2(xp_of(w["implied"]) * 0.04)
            wk[w["w"]] = {"opp": w["opp"], "dome": dome, "mu": mu}
        out[k["gsis_id"]] = wk
    return out


# Weeks the fantasy postseason is usually played in this format. Configurable in the app;
# this is only the default used to precompute playoff-window strength of schedule.
DEFAULT_PLAYOFF_WEEKS = (15, 16, 17)


def strength_of_schedule(sched: dict, dvp: dict, playoff_weeks=DEFAULT_PLAYOFF_WEEKS) -> dict:
    """Per team, per position: how friendly the schedule is, full season and playoffs.

    Above 1.0 means opponents have been giving up more than average to that position.
    The playoff-window number is broken out separately because it is the one that decides
    seasons and the one every point-summing tool ignores -- a receiver with the league's
    softest week 15-17 draw is worth more than his season average says, and the trade
    evaluator needs that visible rather than buried.
    """
    out: dict[str, dict] = {}
    for team, weeks in sched.items():
        entry: dict[str, dict] = {}
        for pos in ("QB", "RB", "WR", "TE", "K", "DST"):
            season, playoff = [], []
            for w in weeks:
                mult = float(dvp.get(w["opp"], {}).get(pos, 1.0))
                season.append(mult)
                if w["w"] in playoff_weeks:
                    playoff.append(mult)
            entry[pos] = {
                "season": r2(np.mean(season) if season else 1.0, 4),
                "playoff": r2(np.mean(playoff) if playoff else 1.0, 4),
            }
        # For D/ST the relevant schedule is the offenses it faces, not a DvP multiplier.
        opp_implied = [w["oppImplied"] for w in weeks]
        po_implied = [w["oppImplied"] for w in weeks if w["w"] in playoff_weeks]
        entry["oppOffense"] = {
            "season": r2(np.mean(opp_implied) if opp_implied else 22.0, 2),
            "playoff": r2(np.mean(po_implied) if po_implied else 22.0, 2),
        }
        out[team] = entry
    return out


# ---------------------------------------------------------------------------
# Market blend
# ---------------------------------------------------------------------------

# Weight on the model's own ordering when blending with expert consensus rank.
# Measured, not chosen: pipeline/backtest.py sweeps this against 2025 actuals using the
# preseason consensus board, and MAE bottoms out in a flat 0.30-0.40 band --
# 2.635 at w=0.3 against 3.192 for the model alone, a 17% improvement, with rank
# correlation rising from 0.707 to 0.813. The market is simply better at ORDERING players
# than an opportunity model is, because it prices camp battles, holdouts and coaching
# changes that never appear in a box score. What it cannot do is put a number on anyone,
# so the model's calibrated value ladder is kept and only the ordering is blended.
MODEL_RANK_WEIGHT = 0.35

# Never let the blend move a player more than this. Protects against a stale or wrong
# consensus entry silently rewriting a projection built on real usage.
BLEND_ADJ_CLAMP = (0.55, 1.8)

NEUTRAL_PPR = {
    "pyd": 0.04, "ptd": 4, "pint": -2, "ryd": 0.1, "rtd": 6,
    "reyd": 0.1, "retd": 6, "rec": 1.0, "fuml": -2,
}
# What the blend is allowed to move. Note what is ABSENT: `patt` and `pcmp`.
# Pass attempts are a property of the TEAM, not of the quarterback -- a worse starter
# throws roughly as often as a better one, he is just less productive doing it. Scaling
# attempts by market opinion produced starting quarterbacks projected for 17-23 attempts
# a game, which is not a real stat line. So the blend moves a passer's yards, touchdowns
# and interceptions, and leaves his volume to the offense he plays in.
BLEND_SCALE_KEYS = ["tgt", "rec", "reyd", "retd", "re40", "refd",
                    "ratt", "ryd", "rtd", "r40", "rfd",
                    "pyd", "ptd", "p40", "pfd"]


def market_blend(proj: pd.DataFrame, ecr_rank: dict,
                 weight: float = MODEL_RANK_WEIGHT) -> pd.DataFrame:
    """Blend model ordering with consensus ordering, keeping the model's point scale.

    Operates on the projection frame and scales volume + touchdown components, so a
    blended player's receptions, yards and scores stay mutually consistent -- the output
    is still a real stat line, not a bare points total.

    IMPORTANT: this runs BEFORE the final team reconciliation. Blending moves players
    around relative to each other and does not respect any team's target budget; running
    it after reconciliation pushed league-average targets from 32.1 to 41.7 per game.
    Reconcile last, always.
    """
    p = proj.copy()
    p["_blend"] = 1.0

    for pos, g in p.groupby("pos"):
        if pos not in ("QB", "RB", "WR", "TE"):
            continue
        ppg = sum(w * g[f"mu_{k}"] for k, w in NEUTRAL_PPR.items() if f"mu_{k}" in g.columns)
        order = ppg.sort_values(ascending=False)
        ladder = order.to_numpy()                        # model's calibrated value ladder
        model_rank = pd.Series(np.arange(1, len(order) + 1), index=order.index)

        ids = p.loc[g.index, "gsis_id"]
        er_raw = ids.map(lambda i: ecr_rank.get(i)).astype(float)
        er = er_raw.rank()

        # A player absent from a board that runs ~800 deep is the market saying he is not
        # fantasy relevant, and that is real information -- not a missing value to be
        # filled in with his model rank. Preseason depth charts are the reason this
        # matters: they rank whoever takes the most preseason snaps, so camp arms and
        # undrafted rookies show up as their team's QB1. Left alone, that put players
        # like GB's fourth quarterback ahead of Jordan Love in the projections.
        # So unranked players are placed BEHIND everyone the market did rank, ordered
        # among themselves by the model.
        n_ranked = int(er_raw.notna().sum())
        mr = model_rank.reindex(g.index)
        unranked_order = mr[er_raw.isna()].rank()
        er_filled = er.copy()
        er_filled.loc[er_raw.isna()] = n_ranked + unranked_order

        blended_rank = weight * mr + (1 - weight) * er_filled
        br = pd.Series(blended_rank, index=g.index).sort_values()

        model_ppg = ppg.reindex(br.index).to_numpy()
        target = ladder[:len(br)]
        with np.errstate(divide="ignore", invalid="ignore"):
            factor = np.where(model_ppg > 0.5, target / np.maximum(model_ppg, 1e-6), 1.0)
        factor = np.clip(np.nan_to_num(factor, nan=1.0), *BLEND_ADJ_CLAMP)
        p.loc[br.index, "_blend"] = factor

    for k in BLEND_SCALE_KEYS:
        col = f"mu_{k}"
        if col in p.columns:
            p[col] = p[col] * p["_blend"]
    return p


# ---------------------------------------------------------------------------
# Weekly logs
# ---------------------------------------------------------------------------

def pack_logs(hist: pd.DataFrame, ids: set, seasons=LOG_SEASONS) -> dict:
    """Positional component rows per player, for the seasons we ship.

    Lets the app show what a player ACTUALLY produced under the user's own scoring, and
    gives the simulation an empirical distribution to sanity-check its parametric one
    against.
    """
    h = hist[hist["season"].isin(seasons) & hist["gsis_id"].isin(ids)]
    logs: dict[str, list] = {}
    for pid, g in h.groupby("gsis_id", sort=False):
        rows = []
        for _, x in g.sort_values(["season", "week"]).iterrows():
            rows.append([int(x["season"]), int(x["week"]), x["opp"]]
                        + [r2(x.get(k, 0.0), 2) for k in LOG_KEYS])
        if rows:
            logs[pid] = rows
    return logs


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

def build() -> dict:
    print("loading sources...")
    hist = F.load_player_history()
    team_hist = F.load_team_history()
    games = F.load_games()
    roster = F.current_rosters()
    depth = F.depth_chart_roles()
    ecr = F.load_ecr()
    coef = M.load_coefficients()

    print("building market schedule...")
    sched, byes, cov = market.build_schedule(games, TARGET_SEASON)
    print(f"  {cov['market_share']:.0%} of team-games have a posted line; rest modeled")

    # Refuse to build without the frozen inputs rather than building a worse model quietly.
    # `redzone.load_pbp` and `blend.load_history` both return empty frames when their files
    # are absent, so a machine that never ran bootstrap.py produces a pack that looks
    # completely normal -- right player count, right team totals, no warnings -- with the
    # expected-touchdown model and the market-blend weight silently switched off. A build
    # that fails is recoverable in one command; a plausible-looking bad pack is not.
    import bootstrap  # noqa: E402  (local, and only needed at build time)

    gaps = bootstrap.missing()
    if gaps:
        print(f"\nrefusing to build: {len(gaps)} frozen input(s) missing", file=sys.stderr)
        for key in sorted(gaps):
            print(f"  {key}  <- {bootstrap.FROZEN[key][0]}", file=sys.stderr)
        print("\nThese degrade silently rather than erroring, so the build stops here.",
              file=sys.stderr)
        print("Fetch them with:  python3 pipeline/bootstrap.py", file=sys.stderr)
        sys.exit(1)

    print("play-by-play opportunity + expected touchdowns...")
    rz = RZ.build()
    print(f"  {rz['n_plays']:,} plays; expected TD beats realized: {rz['regression_check'].get('expected_beats_realized')}")
    if rz["n_plays"] < 100_000:
        # Present but truncated is the other way this goes wrong. Three full seasons is
        # roughly 145k plays; anything near zero means the files are there and unreadable.
        print(f"refusing to build: only {rz['n_plays']:,} plays loaded, expected >100,000",
              file=sys.stderr)
        sys.exit(1)

    print("role priors...")
    role_priors = P.build(hist, team_hist)

    print("weighted player rates...")
    rates = M.weighted_player_rates(hist, team_hist)
    cvs = M.per_player_cv(hist, coef)

    print("identity + universe...")
    resolver = Resolver()
    for _, x in roster.iterrows():
        resolver.add(x["gsis_id"], x["name"], x["team"], x["pos"])
    # Retired/older players still show up in trades; index history too.
    for _, x in rates.iterrows():
        if x["gsis_id"] not in resolver.canonical:
            resolver.add(x["gsis_id"], x["name"], x["last_team"], x["pos"])

    uni = build_universe(rates, roster, depth, ecr, resolver)

    ecr_map, ecr_rank = {}, {}
    for _, x in ecr.iterrows():
        pid = resolver.resolve(x["player"], x.get("tm", ""), x["pos"])
        key = pid or f"ecr:{x['player']}:{x['pos']}"
        ecr_map[key] = {
            "ov": r2(x.get("ecr"), 2), "sd": r2(x.get("sd"), 2),
            "best": r2(x.get("best"), 0), "worst": r2(x.get("worst"), 0),
            "owned": r2(x.get("player_owned_avg"), 1),
        }
        if pd.notna(x.get("ecr")):
            ecr_rank[key] = float(x["ecr"])

    uni = assign_role_rank(uni, rates, ecr_rank)
    # Consensus rank keyed by resolved player id, for the market blend below.
    ecr_pos_rank = dict(ecr_rank)

    print("team weekly factors...")
    factors, base = M.team_week_factors(sched, coef)

    print("availability...")
    avail = F.availability(hist)
    inj = F.injury_flags()
    # Availability has to exist BEFORE reconciliation: usage shares are conditional on
    # playing, so the team-volume constraint is availability-weighted (see
    # model.reconcile_to_team).
    own_active = {r["gsis_id"]: r["raw_active"] for _, r in avail.iterrows()}

    print("projecting players...")
    proj = M.project_players(rates, uni, role_priors, rz["opportunity"], rz["curves"],
                             base, coef, own_active)
    proj = M.reconcile_to_team(proj, base)
    print(f"  {len(proj)} offensive players projected")

    print("blending with expert consensus...")
    proj = market_blend(proj, ecr_pos_rank)
    # Reconcile AGAIN: the blend reorders players without regard for any team's budget.
    proj = M.reconcile_to_team(proj, base)
    n_moved = int((proj["_blend"].sub(1.0).abs() > 0.01).sum())
    print(f"  {n_moved} players moved toward the consensus board (w_model={MODEL_RANK_WEIGHT})")

    print("defense-vs-position...")
    dvp = F.defense_vs_position(hist)

    print("D/ST and kickers...")
    dst = project_dst(team_hist, games, sched, coef)
    kick = project_kickers(uni, hist, sched, rz["kicker_fg"], coef)

    print("packing logs...")
    logs = pack_logs(hist, set(uni["gsis_id"]))

    # ---- assemble -----------------------------------------------------------
    avail_map = {r["gsis_id"]: float(r["miss_rate"]) for _, r in avail.iterrows()}
    cv_map = {r["gsis_id"]: float(r["usage_cv"]) for _, r in cvs.iterrows()}
    inj_map = {r["gsis_id"]: {"status": str(r["last_status"]), "injury": str(r["last_injury"])}
               for _, r in inj.iterrows()}
    proj_map = {r["gsis_id"]: r for _, r in proj.iterrows()}
    rates_map = {r["gsis_id"]: r for _, r in rates.iterrows()}

    players = []
    for _, u in uni.iterrows():
        pid = u["gsis_id"]
        pos = u["pos"]
        if pos not in ("QB", "RB", "WR", "TE", "K"):
            continue
        pr = proj_map.get(pid)
        if pr is None and pos != "K":
            continue

        miss = float(np.clip(avail_map.get(pid, F.POS_MISS_BASE.get(pos, 0.15)), 0.02, 0.45))
        entry = {
            "id": pid,
            "name": u["name"],
            "pos": pos,
            "team": u["team"],
            "bye": byes.get(u["team"], 0),
            "rank": int(u["dc_rank"]),
            "avail": r2(float(np.clip(1.0 - miss, *M.AVAIL_CLAMP)), 3),
            "cv": r2(cv_map.get(pid, 0.42), 3),
            # P(has a role in a given week). Distinct from `avail`, which is the fantasy
            # floor input for a player who HAS a role. `act` is what the team-volume
            # constraint is weighted by, and it is what tells you a listed WR7 is not
            # really a WR7.
            "act": r2(float(pr["active"]), 3) if pr is not None and "active" in pr else 0.5,
            "src": u.get("source", ""),
        }
        if pid in ecr_map:
            entry["ecr"] = ecr_map[pid]
        if pid in inj_map and inj_map[pid]["status"]:
            entry["inj"] = inj_map[pid]
        if pr is not None and abs(float(pr.get("_blend", 1.0)) - 1.0) > 0.01:
            entry["blendAdj"] = r2(pr["_blend"], 3)
        if pr is not None:
            entry["mu"] = {k[3:]: r2(v) for k, v in pr.items() if k.startswith("mu_") and abs(float(v or 0)) > 1e-4}
            entry["role"] = {
                "tgtShare": r2(pr["tgt_share"], 4), "rushShare": r2(pr["rush_share"], 4),
                "ypt": r2(pr["ypt"], 3), "catchRate": r2(pr["catch_rate"], 4),
                "ypc": r2(pr["ypc"], 3),
                "xTD": r2(pr["x_td"], 2), "aTD": r2(pr["a_td"], 2),
            }
        if pos == "K" and pid in kick:
            entry["kWeeks"] = {str(w): v["mu"] for w, v in kick[pid].items()}
        if pid in logs:
            entry["log"] = logs[pid]
        players.append(entry)

    # D/ST entries as first-class players.
    for team, d in dst.items():
        players.append({
            "id": f"DST-{team}", "name": f"{team} {TEAM_NAMES.get(team, 'D/ST')}",
            "pos": "DST", "team": team, "bye": byes.get(team, 0), "rank": 1,
            "avail": 1.0, "cv": 0.5, "src": "team",
            "dstWeeks": {str(w): v["mu"] for w, v in d["weeks"].items()},
            "dstSd": d["sd"],
            **({"ecr": ecr_map[f"ecr:{team} {TEAM_NAMES.get(team,'')}:DST"]}
               if f"ecr:{team} {TEAM_NAMES.get(team,'')}:DST" in ecr_map else {}),
        })

    sos = strength_of_schedule(sched, dvp)

    integrity = checks.run_all(games, sched, byes, ecr)
    integrity["td_regression"] = rz["regression_check"]

    pack = {
        "meta": {
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "season": TARGET_SEASON,
            "regSeasonWeeks": cov["max_week"],
            "seasonState": "preseason",
            "logSeasons": LOG_SEASONS,
            "playerCount": len(players),
            "modelRankWeight": MODEL_RANK_WEIGHT,
            # Carried into the pack so a degraded build is visible in the app's own
            # provenance tab, not only in a log nobody kept.
            "rzPlays": int(rz["n_plays"]),
            "marketCoverage": cov,
            "sources": manifest({k: p for k, p in
                                 {s.key: s.path for s in __import__("sources").SOURCES}.items()
                                 if p.exists()}),
            "integrity": integrity,
        },
        "logKeys": LOG_KEYS,
        "dstKeys": DST_LOG_KEYS,
        "teams": {t: {"name": TEAM_NAMES.get(t, t), "bye": byes.get(t, 0)} for t in sorted(sched)},
        "schedule": {t: [{"w": w["w"], "opp": w["opp"], "home": w["home"], "roof": w["roof"],
                          "implied": w["implied"], "oppImplied": w["oppImplied"], "src": w["src"]}
                         for w in v] for t, v in sched.items()},
        "teamFactors": {t: {str(w): {"pass": f["pass"], "rush": f["rush"], "td": f["td"]}
                            for w, f in v.items()} for t, v in factors.items()},
        "teamBase": base,
        "dvp": dvp,
        "sos": sos,
        "playoffWeeks": list(DEFAULT_PLAYOFF_WEEKS),
        "coef": coef,
        "players": players,
    }
    return pack


def main() -> None:
    pack = build()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(pack, separators=(",", ":"), allow_nan=False)
    OUT.write_text(f"window.TD_PACK={body};\n")
    size = OUT.stat().st_size
    pack["meta"]["packBytes"] = size

    n_by_pos = {}
    for p in pack["players"]:
        n_by_pos[p["pos"]] = n_by_pos.get(p["pos"], 0) + 1
    print(f"\nwrote {OUT}  ({size/1_048_576:.2f} MB)")
    print(f"players: {n_by_pos}")
    print(f"market coverage: {pack['meta']['marketCoverage']}")
    if size > 12 * 1_048_576:
        print("WARNING: pack is large enough to threaten the 16MB artifact limit")


if __name__ == "__main__":
    main()
