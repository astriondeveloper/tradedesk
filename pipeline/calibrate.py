"""Fit the team-level coefficients the projection model depends on.

Every number produced here is estimated from 2019-2025 game data rather than asserted.
`python3 pipeline/calibrate.py` prints the fitted values and writes them to
pipeline/coefficients.json, which the model loads. If a coefficient looks wrong, it is
wrong in the data or in this fit -- not hidden inside a projection expression.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from features import load_games, load_team_history  # noqa: E402
from identity import norm_team  # noqa: E402

OUT = Path(__file__).resolve().parent / "coefficients.json"


def _ols(X: np.ndarray, y: np.ndarray) -> np.ndarray:
    return np.linalg.lstsq(X, y, rcond=None)[0]


def team_game_frame() -> pd.DataFrame:
    """One row per team-game: volume, production, and the market context it happened in."""
    tw = load_team_history()
    g = load_games()
    for c in ("total_line", "spread_line", "home_score", "away_score"):
        g[c] = pd.to_numeric(g[c], errors="coerce")

    # market context per (game, team)
    ctx = []
    for _, r in g.iterrows():
        if pd.isna(r["total_line"]) or pd.isna(r["spread_line"]):
            continue
        ctx.append({"game_id": r["game_id"], "team": r["home_team"], "is_home": 1,
                    "implied": r["total_line"] / 2 + r["spread_line"] / 2,
                    "spread": r["spread_line"], "total": r["total_line"],
                    "pts": r["home_score"]})
        ctx.append({"game_id": r["game_id"], "team": r["away_team"], "is_home": 0,
                    "implied": r["total_line"] / 2 - r["spread_line"] / 2,
                    "spread": -r["spread_line"], "total": r["total_line"],
                    "pts": r["away_score"]})
    ctx = pd.DataFrame(ctx)

    num = lambda c: pd.to_numeric(tw.get(c), errors="coerce").fillna(0.0)  # noqa: E731
    d = pd.DataFrame({
        "game_id": tw["game_id"],
        "team": tw["team"].map(norm_team),
        "season": tw["season"],
        "week": tw["week"],
        "pass_att": num("attempts"),
        "sacks": num("sacks_suffered"),
        "carries": num("carries"),
        "pass_yds": num("passing_yards"),
        "rush_yds": num("rushing_yards"),
        "pass_td": num("passing_tds"),
        "rush_td": num("rushing_tds"),
        "targets": num("targets"),
        "receptions": num("receptions"),
    })
    d["dropbacks"] = d["pass_att"] + d["sacks"]
    d["plays"] = d["dropbacks"] + d["carries"]
    d["off_td"] = d["pass_td"] + d["rush_td"]
    d["pass_rate"] = (d["dropbacks"] / d["plays"].replace(0, np.nan)).clip(0.2, 0.9)

    m = d.merge(ctx, on=["game_id", "team"], how="inner")
    return m.dropna(subset=["implied", "spread", "plays"])


def fit(df: pd.DataFrame) -> dict:
    out: dict = {"n_team_games": int(len(df))}

    # --- pass rate vs game script -------------------------------------------------
    # `spread` is team-relative and POSITIVE WHEN FAVORED (built that way in
    # team_game_frame from the home-positive source convention). A negative coefficient
    # is therefore the expected football result: favorites run more to bleed clock, and
    # underdogs throw more playing from behind.
    X = np.column_stack([np.ones(len(df)), df["spread"], df["total"] - df["total"].mean()])
    b = _ols(X, df["pass_rate"].to_numpy())
    resid = df["pass_rate"].to_numpy() - X @ b
    out["pass_rate"] = {
        "intercept": round(float(b[0]), 5),
        "per_point_favored": round(float(b[1]), 5),
        "per_point_total": round(float(b[2]), 5),
        "resid_sd": round(float(resid.std()), 5),
        "note": "dropbacks/(dropbacks+carries); spread positive = favored; "
                "negative per_point_favored means underdogs pass more",
    }

    # --- plays vs total (pace rises slightly in high-total games) -----------------
    X = np.column_stack([np.ones(len(df)), df["total"] - df["total"].mean()])
    b = _ols(X, df["plays"].to_numpy())
    out["plays"] = {
        "intercept": round(float(b[0]), 4),
        "per_point_total": round(float(b[1]), 5),
        "sd": round(float(df["plays"].std()), 4),
    }

    # --- offensive touchdowns vs implied team total -------------------------------
    # The single most important scaling in the model: how many TDs a team's implied
    # total actually buys.
    X = np.column_stack([np.ones(len(df)), df["implied"]])
    b = _ols(X, df["off_td"].to_numpy())
    pred = X @ b
    out["off_td_vs_implied"] = {
        "intercept": round(float(b[0]), 5),
        "per_implied_point": round(float(b[1]), 5),
        "corr": round(float(np.corrcoef(pred, df["off_td"])[0, 1]), 4),
        "mean_off_td": round(float(df["off_td"].mean()), 4),
        "var_mean_ratio": round(float(df["off_td"].var() / max(df["off_td"].mean(), 1e-9)), 4),
    }

    # --- pass/rush TD split vs implied --------------------------------------------
    share = (df["pass_td"] / df["off_td"].replace(0, np.nan)).dropna()
    out["pass_td_share"] = {"mean": round(float(share.mean()), 4), "sd": round(float(share.std()), 4)}

    # --- yards per attempt --------------------------------------------------------
    out["efficiency"] = {
        "league_ypa": round(float((df["pass_yds"].sum() / max(df["pass_att"].sum(), 1))), 4),
        "league_ypc": round(float((df["rush_yds"].sum() / max(df["carries"].sum(), 1))), 4),
        "league_catch_rate": round(float(df["receptions"].sum() / max(df["targets"].sum(), 1)), 4),
        "league_ypt": round(float(df["pass_yds"].sum() / max(df["targets"].sum(), 1)), 4),
    }

    # --- team scoring dispersion (feeds DST points-allowed simulation) ------------
    out["team_points"] = {
        "mean": round(float(df["pts"].mean()), 3),
        "sd": round(float(df["pts"].std()), 3),
        "resid_sd_vs_implied": round(float((df["pts"] - df["implied"]).std()), 3),
    }

    # --- team yards allowed distribution (feeds DST yards-allowed tiers) ----------
    d2 = df.copy()
    d2["off_yards"] = d2["pass_yds"] + d2["rush_yds"]
    out["team_yards"] = {
        "mean": round(float(d2["off_yards"].mean()), 2),
        "sd": round(float(d2["off_yards"].std()), 2),
    }
    return out


def positional_dispersion() -> dict:
    """Week-to-week dispersion of usage and efficiency, by position.

    Used to parameterize the simulation so floor/ceiling reflect how volatile a position
    genuinely is rather than a single hand-picked variance.
    """
    from features import load_player_history

    h = load_player_history()
    h = h[h["pos"].isin(["QB", "RB", "WR", "TE"])]
    # Only measure the usage channels a position actually has. Without this, a handful of
    # trick-play attempts produce a nonsense CV (TEs "throwing", WRs "rushing") that would
    # then be used to size simulation variance.
    channels = {
        "QB": ("patt", "ratt"),
        "RB": ("ratt", "tgt"),
        "WR": ("tgt",),
        "TE": ("tgt",),
    }
    out = {}
    for pos, grp in h.groupby("pos"):
        # Restrict to players with a real role so the numbers describe starters.
        active = grp[(grp["tgt"] + grp["ratt"] + grp["patt"]) >= 5]
        by_player = active.groupby("gsis_id")
        cvs = {}
        for col in channels.get(pos, ()):
            s = by_player[col].agg(["mean", "std", "size"])
            # Require a real per-game workload, not a token one, before trusting the CV.
            s = s[(s["size"] >= 8) & (s["mean"] >= 3)]
            if len(s) >= 20:
                cvs[col] = round(float((s["std"] / s["mean"]).median()), 4)
        out[pos] = cvs
    return out


def main() -> None:
    df = team_game_frame()
    coef = fit(df)
    coef["positional_cv"] = positional_dispersion()
    OUT.write_text(json.dumps(coef, indent=2))
    print(json.dumps(coef, indent=2))
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
