"""Empirical checks on source conventions.

Sign conventions in betting feeds are the kind of thing that is easy to assume and
catastrophic to get backwards -- flipping the spread would invert every implied team
total and quietly make the whole projection set worse than using no market at all. So
the convention is measured against realized results, not assumed from documentation.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def check_spread_orientation(games: pd.DataFrame) -> dict:
    """Determine whether `spread_line` is quoted from the home team's perspective.

    Uses completed games: if the convention is home-positive-when-favored, then
    `spread_line` should correlate positively with `home_score - away_score`.
    """
    g = games.dropna(subset=["home_score", "away_score", "spread_line"]).copy()
    for c in ("home_score", "away_score", "spread_line", "total_line"):
        g[c] = pd.to_numeric(g[c], errors="coerce")
    g = g.dropna(subset=["home_score", "away_score", "spread_line"])
    if len(g) < 100:
        return {"ok": False, "reason": "insufficient completed games"}

    margin = g["home_score"] - g["away_score"]
    corr = float(np.corrcoef(g["spread_line"], margin)[0, 1])

    favored_home = g["spread_line"] > 0
    home_win = margin > 0
    hit = float((favored_home == home_win)[g["spread_line"].abs() > 3].mean())

    # Calibration: mean margin should track the spread closely if the orientation is right.
    bias = float((margin - g["spread_line"]).mean())

    return {
        "ok": corr > 0.3,
        "orientation": "home_positive_when_favored" if corr > 0 else "away_positive_when_favored",
        "corr_spread_vs_home_margin": round(corr, 4),
        "favorite_straight_up_win_rate": round(hit, 4),
        "mean_margin_minus_spread": round(bias, 3),
        "n_games": int(len(g)),
    }


def check_total_calibration(games: pd.DataFrame) -> dict:
    """Confirm total_line is a game total, not a team total."""
    cols = ["home_score", "away_score", "total_line"]
    g = games[cols].copy()
    for c in cols:
        g[c] = pd.to_numeric(g[c], errors="coerce")
    g = g.dropna(subset=cols)
    actual = g["home_score"] + g["away_score"]
    return {
        "n_games": int(len(g)),
        "mean_total_line": round(float(g["total_line"].mean()), 2),
        "mean_actual_total": round(float(actual.mean()), 2),
        "bias": round(float((actual - g["total_line"]).mean()), 3),
        "corr": round(float(np.corrcoef(g["total_line"], actual)[0, 1]), 4),
    }


def check_implied_totals(games: pd.DataFrame) -> dict:
    """Validate implied = total/2 +/- spread/2 against realized team scoring."""
    cols = ["home_score", "away_score", "total_line", "spread_line"]
    g = games[cols].copy()
    for c in cols:
        g[c] = pd.to_numeric(g[c], errors="coerce")
    g = g.dropna(subset=cols)
    home_imp = g["total_line"] / 2 + g["spread_line"] / 2
    away_imp = g["total_line"] / 2 - g["spread_line"] / 2
    imp = pd.concat([home_imp, away_imp])
    act = pd.concat([g["home_score"], g["away_score"]])
    return {
        "n_team_games": int(len(imp)),
        "mean_implied": round(float(imp.mean()), 2),
        "mean_actual": round(float(act.mean()), 2),
        "bias": round(float((act - imp).mean()), 3),
        "corr": round(float(np.corrcoef(imp, act)[0, 1]), 4),
        "rmse": round(float(np.sqrt(((act - imp) ** 2).mean())), 3),
    }


def check_bye_weeks(sched: dict, byes: dict, ecr: pd.DataFrame) -> dict:
    """Cross-check schedule-derived byes against the byes FantasyPros publishes."""
    if ecr is None or len(ecr) == 0 or "bye" not in ecr.columns:
        return {"checked": 0}
    e = ecr.dropna(subset=["bye", "tm"])
    agree = disagree = 0
    bad = []
    for tm, grp in e.groupby("tm"):
        if tm not in byes:
            continue
        published = int(grp["bye"].mode().iloc[0]) if len(grp["bye"].mode()) else None
        if published is None:
            continue
        if published == byes[tm]:
            agree += 1
        else:
            disagree += 1
            bad.append({"team": tm, "schedule_derived": byes[tm], "published": published})
    return {"checked": agree + disagree, "agree": agree, "disagree": disagree, "mismatches": bad}


def run_all(games: pd.DataFrame, sched=None, byes=None, ecr=None) -> dict:
    out = {
        "spread_orientation": check_spread_orientation(games),
        "total_calibration": check_total_calibration(games),
        "implied_totals": check_implied_totals(games),
    }
    if sched is not None and byes is not None:
        out["bye_weeks"] = check_bye_weeks(sched, byes, ecr)
    return out


if __name__ == "__main__":
    import json
    import sys

    sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
    from features import load_games, market_schedule, load_ecr

    g = load_games()
    sched, byes = market_schedule(g)
    print(json.dumps(run_all(g, sched, byes, load_ecr()), indent=2))
