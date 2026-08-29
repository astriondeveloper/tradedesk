"""Empirical role priors: what usage does a team's WR1 / RB2 / TE1 actually get?

These priors are what let the model project a player who has never taken a snap for his
current team -- a rookie, or anyone who moved in the offseason. Getting them from data
rather than from intuition matters, because they are doing all the work for exactly the
players whose value is hardest to read and most likely to be mispriced in a trade.

Role rank is derived from realized usage within each team-season (the team's most-targeted
WR is WR1, and so on), which is the honest historical analogue of a depth chart.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

MAX_RANK = 5


def _team_game_volume(team_hist: pd.DataFrame) -> pd.DataFrame:
    num = lambda c: pd.to_numeric(team_hist.get(c), errors="coerce").fillna(0.0)  # noqa: E731
    return pd.DataFrame({
        "season": team_hist["season"],
        "week": team_hist["week"],
        "team": team_hist["team"],
        "team_patt": num("attempts"),
        "team_tgt": num("targets"),
        "team_ratt": num("carries"),
        "team_pyd": num("passing_yards"),
        "team_ryd": num("rushing_yards"),
    })


def role_priors(hist: pd.DataFrame, team_hist: pd.DataFrame, seasons=(2022, 2023, 2024, 2025)) -> dict:
    """Mean usage share by (position, depth rank), measured across team-seasons."""
    h = hist[hist["season"].isin(seasons) & hist["pos"].isin(["QB", "RB", "WR", "TE"])].copy()
    tv = _team_game_volume(team_hist)
    m = h.merge(tv, on=["season", "week", "team"], how="left")

    # Season totals per player-team-season.
    agg = m.groupby(["gsis_id", "pos", "team", "season"]).agg(
        g=("week", "nunique"),
        tgt=("tgt", "sum"), ratt=("ratt", "sum"), patt=("patt", "sum"),
        team_tgt=("team_tgt", "sum"), team_ratt=("team_ratt", "sum"), team_patt=("team_patt", "sum"),
    ).reset_index()
    agg = agg[agg["g"] >= 4]

    agg["tgt_share"] = agg["tgt"] / agg["team_tgt"].replace(0, np.nan)
    agg["rush_share"] = agg["ratt"] / agg["team_ratt"].replace(0, np.nan)
    agg["db_share"] = agg["patt"] / agg["team_patt"].replace(0, np.nan)

    out: dict = {}
    for pos in ("QB", "RB", "WR", "TE"):
        sub = agg[agg["pos"] == pos].copy()
        key = "db_share" if pos == "QB" else ("rush_share" if pos == "RB" else "tgt_share")
        sub = sub.dropna(subset=[key])
        # Rank within team-season by the usage channel that defines the role.
        sub["rank"] = sub.groupby(["team", "season"])[key].rank(ascending=False, method="first")
        rows = {}
        for r in range(1, MAX_RANK + 1):
            s = sub[sub["rank"] == r]
            if len(s) < 10:
                continue
            entry = {
                "n": int(len(s)),
                "tgt_share": round(float(s["tgt_share"].median(skipna=True) or 0.0), 4),
                "rush_share": round(float(s["rush_share"].median(skipna=True) or 0.0), 4),
                "db_share": round(float(s["db_share"].median(skipna=True) or 0.0), 4),
                "games": round(float(s["g"].median()), 2),
            }
            rows[str(r)] = {k: (0.0 if (isinstance(v, float) and np.isnan(v)) else v)
                            for k, v in entry.items()}
        out[pos] = rows
    return out


def build(hist: pd.DataFrame, team_hist: pd.DataFrame) -> dict:
    return role_priors(hist, team_hist)


if __name__ == "__main__":
    from features import load_player_history, load_team_history

    p = build(load_player_history(), load_team_history())
    print(json.dumps(p, indent=2))
