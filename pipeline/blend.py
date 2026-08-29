"""Blending the model with the expert-consensus market.

The model sees usage, efficiency and opportunity. It does not see a training-camp holdout,
a coordinator change, a suspension, or a rookie who has clearly won a job. The consensus
board sees all of that and nothing of the model's opportunity math. Blending them is
standard practice for a reason, but the weight should be measured, not asserted -- so this
module fits the rank-to-points curve on prior seasons and the backtest sweeps the weight.

`ecr_to_points` converts a consensus RANK into an expected points-per-game, which is what
makes the two sources comparable at all: a rank is ordinal, a projection is not.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from identity import norm_team  # noqa: E402
from sources import CACHE  # noqa: E402

HISTORY = CACHE / "ecr_history.parquet"

# Preseason window: the board as it stood right before the season, which is the
# information a drafter actually had.
PRESEASON_WINDOW = ("-08-15", "-09-08")


def load_history() -> pd.DataFrame:
    if not HISTORY.exists():
        return pd.DataFrame()
    d = pd.read_parquet(HISTORY)
    d["scrape_date"] = pd.to_datetime(d["scrape_date"], errors="coerce")
    return d


def preseason_board(hist: pd.DataFrame, season: int, page: str = "redraft-overall") -> pd.DataFrame:
    """The last consensus board published before `season` kicked off."""
    if not len(hist):
        return pd.DataFrame()
    lo = pd.Timestamp(f"{season}{PRESEASON_WINDOW[0]}")
    hi = pd.Timestamp(f"{season}{PRESEASON_WINDOW[1]}")
    w = hist[(hist["page_type"] == page) & hist["scrape_date"].between(lo, hi)]
    if not len(w):
        return pd.DataFrame()
    latest = w[w["scrape_date"] == w["scrape_date"].max()].copy()
    for c in ("ecr", "sd", "best", "worst"):
        latest[c] = pd.to_numeric(latest.get(c), errors="coerce")
    latest["tm"] = latest["tm"].map(norm_team)
    return latest.dropna(subset=["ecr"])


def fit_rank_curve(actuals: pd.DataFrame, boards: dict, seasons) -> dict:
    """Expected points per game as a function of positional consensus rank.

    Fitted per position as a log-linear decay, which fits fantasy value curves far better
    than a straight line: the drop from RB1 to RB6 dwarfs the drop from RB30 to RB35.
    """
    rows = []
    for s in seasons:
        b = boards.get(s)
        if b is None or not len(b):
            continue
        a = actuals[actuals["season"] == s]
        m = b.merge(a, left_on="_pid", right_on="gsis_id", how="inner")
        if len(m):
            rows.append(m[["pos_x" if "pos_x" in m else "pos", "ecr", "actual_ppg"]]
                        .rename(columns={"pos_x": "pos"}))
    if not rows:
        return {}
    d = pd.concat(rows, ignore_index=True)

    curves = {}
    for pos, g in d.groupby("pos"):
        g = g[(g["ecr"] > 0) & g["actual_ppg"].notna()]
        if len(g) < 25:
            continue
        # Rank within position, since the overall board mixes positions.
        g = g.assign(prank=g["ecr"].rank())
        X = np.column_stack([np.ones(len(g)), np.log(g["prank"])])
        beta = np.linalg.lstsq(X, g["actual_ppg"].to_numpy(), rcond=None)[0]
        curves[pos] = {"a": float(beta[0]), "b": float(beta[1]), "n": int(len(g))}
    return curves


def ecr_to_points(curves: dict, pos: str, positional_rank: float) -> float:
    c = curves.get(pos)
    if not c or positional_rank <= 0:
        return np.nan
    return float(c["a"] + c["b"] * np.log(positional_rank))
