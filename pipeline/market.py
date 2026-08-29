"""Market-anchored team scoring environment.

Books post lines for the early weeks and fill the rest in as the season approaches. For
2026 only 112 of 272 regular-season games had a posted total and spread at build time, so
the remaining weeks need implied team totals inferred rather than left blank -- a
rest-of-season projection that silently drops week 12 is worse than useless.

The approach is a ridge-regularized additive ratings model:

    implied_points(team, opp, home) = mu + attack[team] - defense[opp] + hfa * is_home

fit by least squares on the team-games that DO have posted lines, regularized toward a
prior built from recent actual scoring. That keeps the market as the anchor wherever it
exists and degrades gracefully -- toward observed team strength -- where it does not.

This is the regression-based scoring model from the referenced Chapter 15 methodology,
pointed at team totals instead of spreads.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from identity import norm_team

RIDGE_LAMBDA = 8.0          # shrink attack/defense ratings toward the prior
PRIOR_HALFLIFE_GAMES = 20.0  # recency weight on historical scoring used for the prior
IMPLIED_CLAMP = (13.0, 34.0)


def _team_scoring_prior(games: pd.DataFrame, upto_season: int) -> tuple[dict, dict, float]:
    """Recency-weighted points scored / allowed per team from completed games."""
    g = games[(games["season"] < upto_season) & (games["season"] >= upto_season - 3)].copy()
    for c in ("home_score", "away_score"):
        g[c] = pd.to_numeric(g[c], errors="coerce")
    g = g.dropna(subset=["home_score", "away_score"]).sort_values(["season", "week"])

    rows = []
    for _, r in g.iterrows():
        rows.append((r["home_team"], r["home_score"], r["away_score"]))
        rows.append((r["away_team"], r["away_score"], r["home_score"]))
    df = pd.DataFrame(rows, columns=["team", "scored", "allowed"])

    league = float(df["scored"].mean())
    att, dfn = {}, {}
    for team, grp in df.groupby("team"):
        n = len(grp)
        w = 0.5 ** (np.arange(n - 1, -1, -1) / PRIOR_HALFLIFE_GAMES)
        att[team] = float(np.average(grp["scored"], weights=w)) - league
        dfn[team] = league - float(np.average(grp["allowed"], weights=w))
    return att, dfn, league


def fit_ratings(games: pd.DataFrame, season: int, *, fit_mask: pd.Series | None = None) -> dict:
    """Fit attack/defense/HFA from posted lines for `season`."""
    g = games[(games["season"] == season) & (games["game_type"] == "REG")].copy()
    g["total_line"] = pd.to_numeric(g["total_line"], errors="coerce")
    g["spread_line"] = pd.to_numeric(g["spread_line"], errors="coerce")
    have = g["total_line"].notna() & g["spread_line"].notna()
    if fit_mask is not None:
        have = have & fit_mask.reindex(g.index).fillna(False)
    fit = g[have]

    prior_att, prior_def, league = _team_scoring_prior(games, season)
    teams = sorted(set(games[games["season"] == season]["home_team"]) |
                   set(games[games["season"] == season]["away_team"]))
    idx = {t: i for i, t in enumerate(teams)}
    n_t = len(teams)

    if len(fit) < 8:
        # No usable market at all: fall back entirely to the historical prior.
        return {
            "teams": teams, "mu": league,
            "attack": {t: prior_att.get(t, 0.0) for t in teams},
            "defense": {t: prior_def.get(t, 0.0) for t in teams},
            "hfa": 1.0, "n_fit_games": 0, "method": "prior_only",
        }

    # Design matrix: one row per team-game, columns [attack(32), defense(32), hfa].
    rows, y = [], []
    for _, r in fit.iterrows():
        tot, spr = r["total_line"], r["spread_line"]
        for team, opp, is_home, target in (
            (r["home_team"], r["away_team"], 1.0, tot / 2 + spr / 2),
            (r["away_team"], r["home_team"], 0.0, tot / 2 - spr / 2),
        ):
            row = np.zeros(2 * n_t + 1)
            row[idx[team]] = 1.0
            row[n_t + idx[opp]] = -1.0
            row[-1] = is_home
            rows.append(row)
            y.append(target - league)

    X = np.array(rows)
    y = np.array(y)

    # Ridge toward the historical prior rather than toward zero.
    prior_vec = np.zeros(2 * n_t + 1)
    for t, i in idx.items():
        prior_vec[i] = prior_att.get(t, 0.0)
        prior_vec[n_t + i] = prior_def.get(t, 0.0)
    prior_vec[-1] = 1.0

    A = X.T @ X + RIDGE_LAMBDA * np.eye(2 * n_t + 1)
    b = X.T @ y + RIDGE_LAMBDA * prior_vec
    beta = np.linalg.solve(A, b)

    return {
        "teams": teams,
        "mu": league,
        "attack": {t: float(beta[idx[t]]) for t in teams},
        "defense": {t: float(beta[n_t + idx[t]]) for t in teams},
        "hfa": float(beta[-1]),
        "n_fit_games": int(len(fit)),
        "method": "market_ridge",
    }


def implied_for(ratings: dict, team: str, opp: str, home: bool) -> float:
    v = (
        ratings["mu"]
        + ratings["attack"].get(team, 0.0)
        - ratings["defense"].get(opp, 0.0)
        + (ratings["hfa"] if home else 0.0)
    )
    return float(np.clip(v, *IMPLIED_CLAMP))


def _roof_lookup(games: pd.DataFrame, season: int) -> dict:
    """Home stadium roof by team from the prior season.

    The 2026 feed leaves `roof` null for 43 games, and every team affected -- ARI, ATL,
    DAL, HOU, IND -- plays indoors. Defaulting those to "outdoors" would drop the dome
    adjustment on precisely the teams that earn it, which matters here because this
    league pays field goals by distance and penalizes misses.
    """
    prev = games[(games["season"] == season - 1) & (games["game_type"] == "REG")]
    out = {}
    for team, grp in prev.groupby("home_team"):
        mode = grp["roof"].dropna().mode()
        if len(mode):
            out[team] = str(mode.iloc[0])
    return out


def build_schedule(games: pd.DataFrame, season: int) -> tuple[dict, dict, dict]:
    """Per-team weekly schedule with implied totals, market where posted, model elsewhere.

    Returns (schedule_by_team, byes_by_team, coverage_stats).
    """
    ratings = fit_ratings(games, season)
    roof_by_home = _roof_lookup(games, season)
    g = games[(games["season"] == season) & (games["game_type"] == "REG")].copy()
    g["week"] = pd.to_numeric(g["week"], errors="coerce")
    g["total_line"] = pd.to_numeric(g["total_line"], errors="coerce")
    g["spread_line"] = pd.to_numeric(g["spread_line"], errors="coerce")

    sched: dict[str, list] = {}
    seen: dict[str, set] = {}
    n_market = n_model = 0
    n_roof_filled = 0

    for _, r in g.iterrows():
        wk = int(r["week"])
        roof = r.get("roof")
        if not isinstance(roof, str) or not roof:
            roof = roof_by_home.get(r["home_team"], "outdoors")
            n_roof_filled += 1
        posted = pd.notna(r["total_line"]) and pd.notna(r["spread_line"])
        if posted:
            home_imp = float(r["total_line"]) / 2 + float(r["spread_line"]) / 2
            away_imp = float(r["total_line"]) / 2 - float(r["spread_line"]) / 2
            n_market += 2
        else:
            home_imp = implied_for(ratings, r["home_team"], r["away_team"], True)
            away_imp = implied_for(ratings, r["away_team"], r["home_team"], False)
            n_model += 2

        for team, opp, is_home, imp, opp_imp in (
            (r["home_team"], r["away_team"], True, home_imp, away_imp),
            (r["away_team"], r["home_team"], False, away_imp, home_imp),
        ):
            sched.setdefault(team, []).append({
                "w": wk,
                "opp": opp,
                "home": is_home,
                "roof": roof,
                "implied": round(imp, 2),
                "oppImplied": round(opp_imp, 2),
                "total": round(imp + opp_imp, 2),
                "src": "market" if posted else "model",
            })
            seen.setdefault(team, set()).add(wk)

    for t in sched:
        sched[t].sort(key=lambda x: x["w"])

    max_week = int(g["week"].max()) if len(g) else 18
    byes = {}
    for t, ws in seen.items():
        missing = sorted(set(range(1, max_week + 1)) - ws)
        byes[t] = missing[0] if missing else 0

    cov = {
        "team_games_market": n_market,
        "team_games_modeled": n_model,
        "market_share": round(n_market / max(1, n_market + n_model), 4),
        "roof_filled_from_prior_season": n_roof_filled,
        "ratings_fit_games": ratings["n_fit_games"],
        "hfa": round(ratings["hfa"], 3),
        "method": ratings["method"],
        "max_week": max_week,
    }
    return sched, byes, cov


def backtest(games: pd.DataFrame, season: int, hold_frac: float = 0.6, seed: int = 7) -> dict:
    """Fit on a fraction of a completed season's posted lines, predict the rest.

    Answers the only question that matters for the fallback: when the model has to stand
    in for an unposted line, how much worse is it than the line itself?
    """
    g = games[(games["season"] == season) & (games["game_type"] == "REG")].copy()
    g["total_line"] = pd.to_numeric(g["total_line"], errors="coerce")
    g["spread_line"] = pd.to_numeric(g["spread_line"], errors="coerce")
    g = g[g["total_line"].notna() & g["spread_line"].notna()]
    if len(g) < 50:
        return {"ok": False, "reason": f"season {season} has too few posted lines"}

    rng = np.random.default_rng(seed)
    mask = pd.Series(rng.random(len(g)) > hold_frac, index=g.index)
    ratings = fit_ratings(games, season, fit_mask=mask)

    held = g[~mask]
    pred, actual = [], []
    for _, r in held.iterrows():
        pred.append(implied_for(ratings, r["home_team"], r["away_team"], True))
        actual.append(r["total_line"] / 2 + r["spread_line"] / 2)
        pred.append(implied_for(ratings, r["away_team"], r["home_team"], False))
        actual.append(r["total_line"] / 2 - r["spread_line"] / 2)

    pred, actual = np.array(pred), np.array(actual)
    naive = np.full_like(actual, actual.mean())
    return {
        "ok": True,
        "season": season,
        "fit_games": int(mask.sum()),
        "held_team_games": int(len(pred)),
        "rmse_model": round(float(np.sqrt(((pred - actual) ** 2).mean())), 3),
        "rmse_league_mean": round(float(np.sqrt(((naive - actual) ** 2).mean())), 3),
        "mae_model": round(float(np.abs(pred - actual).mean()), 3),
        "corr": round(float(np.corrcoef(pred, actual)[0, 1]), 4),
        "bias": round(float((pred - actual).mean()), 3),
    }


if __name__ == "__main__":
    import json
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from features import load_games

    g = load_games()
    print("=== backtest: predicting held-out posted lines ===")
    for yr in (2023, 2024, 2025):
        print(json.dumps(backtest(g, yr)))
    print("\n=== 2026 schedule build ===")
    sched, byes, cov = build_schedule(g, 2026)
    print(json.dumps(cov, indent=2))
    imp = {t: round(np.mean([x["implied"] for x in v]), 2) for t, v in sched.items()}
    top = sorted(imp.items(), key=lambda kv: -kv[1])
    print("top 6:", top[:6])
    print("bot 6:", top[-6:])
