"""Feature construction: history, team context, the betting market, DvP, availability, roles.

Everything here is source-derived. Nothing is invented. Where a value has to be assumed
(a rookie's role, a shrinkage constant) it is named and defaulted in one place so it can be
audited and calibrated rather than buried in an expression.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from components import (
    DST_KEYS,
    OFFENSE_KEYS,
    KICKER_KEYS,
    extract_offense,
    team_defense_components,
)
from identity import norm_team
from sources import CACHE, HIST_SEASONS, TARGET_SEASON

warnings.filterwarnings("ignore")

FANTASY_POS = ["QB", "RB", "WR", "TE", "K"]

# ---------------------------------------------------------------------------
# Tunable constants. Every one of these is a modeling choice, gathered here so the
# backtest can move them and nobody has to hunt through the code.
# ---------------------------------------------------------------------------

# Exponential recency weight on prior games. A half-life of 26 games means last season
# carries roughly half the weight of this season -- slow enough to keep sample, fast
# enough that a changed role shows up.
RECENCY_HALFLIFE_GAMES = 26.0

# Shrinkage denominators for usage shares: share = (n*obs + k*prior) / (n + k).
# Target share stabilizes fast, rush share slightly slower, snap share fastest.
SHRINK_TGT_SHARE = 4.0
SHRINK_RUSH_SHARE = 5.0
SHRINK_SNAP_SHARE = 3.0

# Efficiency shrinkage, in "opportunities toward the prior". Yards per carry is
# notoriously noise-dominated and stabilizes far later than yards per target, so it is
# regressed several times harder.
SHRINK_YPT = 45.0
SHRINK_YPC = 160.0
SHRINK_CATCH_RATE = 40.0

# Touchdown regression: weight on *expected* TDs (from opportunity) vs realized TDs.
# Not a guess -- fitted in pipeline/redzone.py::validate_regression over 406 paired
# player-seasons of play-by-play. Expected TDs predict next season better than realized
# TDs (r = 0.496 vs 0.453) and the optimal linear blend lands at 0.765 on expected.
# Re-run `python3 pipeline/redzone.py` to re-derive.
TD_EXPECTED_WEIGHT = 0.765

# Defense-vs-position: the true effect is small and DvP is the classic overfit. Shrink
# hard and clamp, so a 3-game sample can never swing a projection 30%.
DVP_SHRINK_GAMES = 10.0
DVP_CLAMP = (0.88, 1.12)

# League-average team baselines, recomputed from data but bounded for sanity.
LEAGUE_PLAYS_MIN, LEAGUE_PLAYS_MAX = 55.0, 75.0


def _hl_weights(n: int, halflife: float) -> np.ndarray:
    """Weights for n observations ordered oldest -> newest."""
    if n <= 0:
        return np.array([])
    age = np.arange(n - 1, -1, -1, dtype=float)
    return 0.5 ** (age / halflife)


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

def load_player_history(seasons=None) -> pd.DataFrame:
    """All player-weeks across seasons, with canonical components attached."""
    seasons = seasons or HIST_SEASONS
    frames = []
    for yr in seasons:
        p = CACHE / f"player_week_{yr}.csv"
        if not p.exists():
            continue
        df = pd.read_csv(p, low_memory=False)
        df = df[df["season_type"] == "REG"] if "season_type" in df.columns else df
        comp = extract_offense(df)
        keep = pd.DataFrame(
            {
                "gsis_id": df["player_id"],
                "name": df["player_display_name"],
                "pos": df["position"],
                "season": pd.to_numeric(df["season"], errors="coerce"),
                "week": pd.to_numeric(df["week"], errors="coerce"),
                "team": df["team"].map(norm_team),
                "opp": df["opponent_team"].map(norm_team),
                # Usage context needed for share modeling, kept alongside components.
                "target_share": pd.to_numeric(df.get("target_share"), errors="coerce"),
                "air_yards_share": pd.to_numeric(df.get("air_yards_share"), errors="coerce"),
                "receiving_air_yards": pd.to_numeric(df.get("receiving_air_yards"), errors="coerce"),
            }
        )
        frames.append(pd.concat([keep, comp], axis=1))
    out = pd.concat(frames, ignore_index=True)
    return out.dropna(subset=["season", "week"])


def load_team_history(seasons=None) -> pd.DataFrame:
    seasons = seasons or HIST_SEASONS
    frames = []
    for yr in seasons:
        p = CACHE / f"team_week_{yr}.csv"
        if not p.exists():
            continue
        df = pd.read_csv(p, low_memory=False)
        if "season_type" in df.columns:
            df = df[df["season_type"] == "REG"]
        frames.append(df)
    df = pd.concat(frames, ignore_index=True)
    df["team"] = df["team"].map(norm_team)
    df["opponent_team"] = df["opponent_team"].map(norm_team)
    return df


def load_games() -> pd.DataFrame:
    g = pd.read_csv(CACHE / "games.csv", low_memory=False)
    for c in ("home_team", "away_team"):
        g[c] = g[c].map(norm_team)
    return g


# ---------------------------------------------------------------------------
# Team scoring environment, anchored to the betting market
# ---------------------------------------------------------------------------

def team_pace(team_hist: pd.DataFrame) -> pd.DataFrame:
    """Recency-weighted offensive plays per game and pass rate, per team."""
    th = team_hist.copy()
    th["plays"] = (
        pd.to_numeric(th.get("attempts"), errors="coerce").fillna(0)
        + pd.to_numeric(th.get("carries"), errors="coerce").fillna(0)
        + pd.to_numeric(th.get("sacks_suffered"), errors="coerce").fillna(0)
    )
    th["pass_plays"] = pd.to_numeric(th.get("attempts"), errors="coerce").fillna(0) + pd.to_numeric(
        th.get("sacks_suffered"), errors="coerce"
    ).fillna(0)
    th = th.sort_values(["team", "season", "week"])

    rows = []
    for team, grp in th.groupby("team"):
        w = _hl_weights(len(grp), RECENCY_HALFLIFE_GAMES)
        plays = np.average(grp["plays"].to_numpy(dtype=float), weights=w)
        prate = np.average(
            (grp["pass_plays"] / grp["plays"].replace(0, np.nan)).fillna(0.57).to_numpy(dtype=float),
            weights=w,
        )
        rows.append({"team": team, "plays_pg": plays, "pass_rate": prate})
    out = pd.DataFrame(rows)
    out["plays_pg"] = out["plays_pg"].clip(LEAGUE_PLAYS_MIN, LEAGUE_PLAYS_MAX)
    out["pass_rate"] = out["pass_rate"].clip(0.45, 0.70)
    return out


def market_schedule(games: pd.DataFrame, season: int = TARGET_SEASON) -> tuple[dict, dict]:
    """Per-team weekly schedule with market-implied team totals.

        implied_team_total = total_line/2 - spread_line/2

    `spread_line` in this feed is quoted from the HOME team's perspective, positive when
    the home team is favored. Verified against the data rather than assumed: see
    `pipeline/checks.py::check_spread_orientation`.

    Returns (schedule_by_team, byes_by_team).
    """
    g = games[(games["season"] == season) & (games["game_type"] == "REG")].copy()
    g["week"] = pd.to_numeric(g["week"], errors="coerce")
    g["total_line"] = pd.to_numeric(g["total_line"], errors="coerce")
    g["spread_line"] = pd.to_numeric(g["spread_line"], errors="coerce")

    league_total = float(g["total_line"].median()) if g["total_line"].notna().any() else 44.0

    sched: dict[str, list] = {}
    weeks_seen: dict[str, set] = {}
    for _, r in g.iterrows():
        total = r["total_line"] if pd.notna(r["total_line"]) else league_total
        spread = r["spread_line"] if pd.notna(r["spread_line"]) else 0.0
        home_implied = total / 2.0 + spread / 2.0
        away_implied = total / 2.0 - spread / 2.0
        wk = int(r["week"])
        for team, opp, home, imp, opp_imp in (
            (r["home_team"], r["away_team"], True, home_implied, away_implied),
            (r["away_team"], r["home_team"], False, away_implied, home_implied),
        ):
            sched.setdefault(team, []).append(
                {
                    "w": wk,
                    "opp": opp,
                    "home": home,
                    "roof": str(r.get("roof") or "outdoors"),
                    "surface": str(r.get("surface") or ""),
                    "total": round(float(total), 2),
                    "spread": round(float(spread if home else -spread), 2),
                    "implied": round(float(imp), 2),
                    "oppImplied": round(float(opp_imp), 2),
                    "hasLine": bool(pd.notna(r["total_line"])),
                }
            )
            weeks_seen.setdefault(team, set()).add(wk)

    for t in sched:
        sched[t].sort(key=lambda x: x["w"])

    max_week = int(g["week"].max()) if len(g) else 18
    byes = {}
    for t, seen in weeks_seen.items():
        missing = sorted(set(range(1, max_week + 1)) - seen)
        byes[t] = missing[0] if missing else 0
    return sched, byes


# ---------------------------------------------------------------------------
# Defense vs position
# ---------------------------------------------------------------------------

def defense_vs_position(hist: pd.DataFrame, seasons=(2024, 2025)) -> dict:
    """Multiplier per (defense, position), regressed hard toward 1.0.

    Computed on a neutral full-PPR basis: total points a defense allowed to a position
    per game, relative to the league mean. Shrunk by games played and clamped, because
    the honest effect size here is small and the temptation to overfit it is large.
    """
    h = hist[hist["season"].isin(seasons)].copy()
    h = h[h["pos"].isin(["QB", "RB", "WR", "TE"])]

    # Neutral scoring for the DvP calculation only. This never reaches the app.
    pts = (
        0.04 * h["pyd"] + 4 * h["ptd"] - 2 * h["pint"]
        + 0.1 * h["ryd"] + 6 * h["rtd"]
        + 0.1 * h["reyd"] + 6 * h["retd"] + 1.0 * h["rec"]
        - 2 * h["fuml"]
    )
    h = h.assign(pts=pts)

    # Points allowed per game by each defense to each position.
    per_game = h.groupby(["opp", "pos", "season", "week"])["pts"].sum().reset_index()
    allowed = per_game.groupby(["opp", "pos"]).agg(pts=("pts", "mean"), n=("pts", "size")).reset_index()
    league = allowed.groupby("pos")["pts"].mean().to_dict()

    out: dict[str, dict] = {}
    for _, r in allowed.iterrows():
        base = league.get(r["pos"], np.nan)
        if not base or np.isnan(base) or base <= 0:
            continue
        raw = r["pts"] / base
        n = float(r["n"])
        shrunk = (n * raw + DVP_SHRINK_GAMES * 1.0) / (n + DVP_SHRINK_GAMES)
        out.setdefault(r["opp"], {})[r["pos"]] = float(np.clip(shrunk, *DVP_CLAMP))

    for team in out:
        out[team].setdefault("K", 1.0)
        out[team].setdefault("DST", 1.0)
    return out


# ---------------------------------------------------------------------------
# Availability
# ---------------------------------------------------------------------------

# Share of regular-season games missed, by position, from 2019-2025 rosters+injuries.
# Recomputed at build time; these are the fallbacks when a player has no history.
POS_MISS_BASE = {"QB": 0.13, "RB": 0.19, "WR": 0.16, "TE": 0.17, "K": 0.04, "DST": 0.0}


def availability(hist: pd.DataFrame, seasons=(2022, 2023, 2024, 2025)) -> pd.DataFrame:
    """Per-player share of team games missed, shrunk to the position base rate.

    A player's own history is a weak signal at fantasy sample sizes -- durability is far
    less persistent than fantasy media implies -- so this shrinks aggressively and is used
    to shape the floor, not to move the mean much.
    """
    h = hist[hist["season"].isin(seasons)].copy()
    # Team games available to each player-season: the max week their team played.
    team_weeks = h.groupby(["team", "season"])["week"].nunique().rename("team_games").reset_index()
    played = (
        h.groupby(["gsis_id", "pos", "team", "season"])["week"].nunique().rename("played").reset_index()
    )
    m = played.merge(team_weeks, on=["team", "season"], how="left")
    agg = m.groupby(["gsis_id", "pos"]).agg(played=("played", "sum"), avail=("team_games", "sum")).reset_index()

    K = 24.0  # shrink toward the position base over ~1.5 seasons of exposure
    base = agg["pos"].map(POS_MISS_BASE).fillna(0.15)
    obs_miss = 1.0 - (agg["played"] / agg["avail"].replace(0, np.nan))
    obs_miss = obs_miss.clip(0.0, 0.8).fillna(base)
    n = agg["avail"].fillna(0.0)
    agg["miss_rate"] = (n * obs_miss + K * base) / (n + K)
    agg["exposure"] = n
    # Unshrunk share of team games the player was actually active for. The shrunk
    # miss_rate is the right input for a fantasy floor; this raw rate is the right input
    # for the reconciliation weight, which needs the honest probability he plays at all.
    agg["raw_active"] = (agg["played"] / agg["avail"].replace(0, np.nan)).clip(0.0, 1.0)
    return agg[["gsis_id", "pos", "miss_rate", "exposure", "raw_active"]]


def injury_flags(season: int = TARGET_SEASON - 1) -> pd.DataFrame:
    """Most recent reported injury designation per player, as a current-status hint."""
    p = CACHE / f"injuries_{season}.csv"
    if not p.exists():
        return pd.DataFrame(columns=["gsis_id", "last_status", "last_injury"])
    df = pd.read_csv(p, low_memory=False)
    df = df.dropna(subset=["gsis_id"]).sort_values("week")
    last = df.groupby("gsis_id").tail(1)
    return pd.DataFrame(
        {
            "gsis_id": last["gsis_id"],
            "last_status": last["report_status"].fillna(""),
            "last_injury": last["report_primary_injury"].fillna(""),
        }
    )


# ---------------------------------------------------------------------------
# 2026 roles
# ---------------------------------------------------------------------------

DEPTH_POS = {"QB": "QB", "RB": "RB", "WR": "WR", "TE": "TE", "PK": "K", "K": "K", "FB": "RB"}


def depth_chart_roles(season: int = TARGET_SEASON) -> pd.DataFrame:
    """Latest depth-chart snapshot: team, position, and depth rank.

    This is how offseason movement reaches the projections. A receiver traded in March
    has no snaps with his new offense, so his usage prior has to come from the role the
    team is lining him up in.
    """
    p = CACHE / f"depth_{season}.csv"
    if not p.exists():
        return pd.DataFrame(columns=["gsis_id", "dc_team", "dc_pos", "dc_rank"])
    df = pd.read_csv(p, low_memory=False)
    df = df[df["dt"] == df["dt"].max()]  # newest snapshot only
    df = df[df["pos_abb"].isin(DEPTH_POS)]
    df = df.dropna(subset=["gsis_id"])
    df["dc_pos"] = df["pos_abb"].map(DEPTH_POS)
    df["dc_rank"] = pd.to_numeric(df["pos_rank"], errors="coerce").fillna(9)
    df["dc_team"] = df["team"].map(norm_team)
    # A player can appear at more than one spot; keep his best (lowest) rank.
    df = df.sort_values("dc_rank").groupby("gsis_id").head(1)
    return df[["gsis_id", "dc_team", "dc_pos", "dc_rank"]].reset_index(drop=True)


def current_rosters(season: int = TARGET_SEASON) -> pd.DataFrame:
    p = CACHE / f"roster_{season}.csv"
    df = pd.read_csv(p, low_memory=False)
    df = df[df["gsis_id"].notna()]
    df = df.sort_values("week").groupby("gsis_id").tail(1)
    return pd.DataFrame(
        {
            "gsis_id": df["gsis_id"],
            "name": df["full_name"],
            "pos": df["position"],
            "team": df["team"].map(norm_team),
            "status": df["status"],
            "birth_date": df["birth_date"],
            "years_exp": pd.to_numeric(df["years_exp"], errors="coerce"),
            "rookie_year": pd.to_numeric(df.get("rookie_year"), errors="coerce"),
        }
    ).reset_index(drop=True)


def load_ecr() -> pd.DataFrame:
    """FantasyPros expert consensus: the market anchor, plus rank dispersion.

    `sd`, `best` and `worst` are an independent read on uncertainty -- disagreement among
    rankers -- which is genuinely different information from our simulated variance.
    """
    p = CACHE / "ecr.csv"
    if not p.exists():
        return pd.DataFrame()
    df = pd.read_csv(p, low_memory=False)
    redraft = df[df["page_type"].isin(
        ["redraft-overall", "redraft-qb", "redraft-rb", "redraft-wr", "redraft-te", "redraft-k", "redraft-dst"]
    )].copy()
    for c in ("ecr", "sd", "best", "worst", "bye", "player_owned_avg"):
        redraft[c] = pd.to_numeric(redraft.get(c), errors="coerce")
    redraft["tm"] = redraft["tm"].map(norm_team)
    # Overall page wins for the headline rank; position pages fill in the deep guys.
    redraft["_pri"] = np.where(redraft["page_type"] == "redraft-overall", 0, 1)
    redraft = redraft.sort_values(["_pri", "ecr"]).groupby(["player", "pos"], as_index=False).head(1)
    return redraft.reset_index(drop=True)


def superflex_ecr() -> pd.DataFrame:
    p = CACHE / "ecr.csv"
    if not p.exists():
        return pd.DataFrame()
    df = pd.read_csv(p, low_memory=False)
    sf = df[df["page_type"] == "redraft-op"].copy()
    sf["ecr"] = pd.to_numeric(sf["ecr"], errors="coerce")
    sf["tm"] = sf["tm"].map(norm_team)
    return sf[["player", "pos", "tm", "ecr"]].reset_index(drop=True)
