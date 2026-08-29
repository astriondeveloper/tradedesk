"""Expected touchdowns from play-by-play opportunity.

Realized touchdowns are the noisiest meaningful thing in fantasy football. A back who
scores 12 on the same opportunity that usually yields 7 has not found a skill; he has had
a season. Projecting next year off his 12 is the most common and most expensive error in
public projections.

So we build the counterfactual: an empirical touchdown probability curve by yard line and
play type, fit on real plays, and then integrate each player's actual opportunities
through it.

    expected_TDs(player) = SUM over his carries and targets of  P(TD | yardline, type)

The gap between expected and realized is the regression signal. It is computed here, from
plays, rather than approximated from box scores.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sources import CACHE  # noqa: E402

PBP_SEASONS = (2023, 2024, 2025)

USECOLS = [
    "season", "week", "posteam", "defteam", "yardline_100", "goal_to_go", "play_type",
    "rush_attempt", "pass_attempt", "complete_pass",
    "rusher_player_id", "receiver_player_id", "passer_player_id",
    "touchdown", "rush_touchdown", "pass_touchdown", "td_player_id",
    "field_goal_attempt", "kick_distance", "field_goal_result",
]


def load_pbp(seasons=PBP_SEASONS) -> pd.DataFrame:
    frames = []
    for yr in seasons:
        p = CACHE / f"pbp_{yr}.csv"
        if not p.exists():
            continue
        df = pd.read_csv(p, usecols=lambda c: c in USECOLS, low_memory=False)
        frames.append(df)
    if not frames:
        return pd.DataFrame(columns=USECOLS)
    df = pd.concat(frames, ignore_index=True)
    df = df[df["yardline_100"].notna() & df["posteam"].notna()]
    df["yardline_100"] = pd.to_numeric(df["yardline_100"], errors="coerce")
    return df.dropna(subset=["yardline_100"])


def td_probability_curves(pbp: pd.DataFrame, smooth: float = 25.0) -> dict:
    """P(touchdown | yard line) separately for designed runs and for pass targets.

    Smoothed toward the overall rate by yard line with a pseudo-count, so the 1-yard-line
    bucket does not swing on a handful of plays.
    """
    curves = {}

    runs = pbp[(pbp["rush_attempt"] == 1) & pbp["rusher_player_id"].notna()]
    passes = pbp[(pbp["pass_attempt"] == 1) & pbp["receiver_player_id"].notna()]

    for name, df, td_col in (("rush", runs, "rush_touchdown"), ("target", passes, "pass_touchdown")):
        if not len(df):
            curves[name] = {}
            continue
        yl = df["yardline_100"].clip(1, 99).round().astype(int)
        td = pd.to_numeric(df[td_col], errors="coerce").fillna(0)
        agg = pd.DataFrame({"yl": yl, "td": td}).groupby("yl")["td"].agg(["sum", "size"])
        overall = float(td.sum() / max(len(td), 1))
        # Shrink each yard line toward a monotone-ish local baseline.
        probs = {}
        for y in range(1, 100):
            if y in agg.index:
                s, n = float(agg.loc[y, "sum"]), float(agg.loc[y, "size"])
            else:
                s, n = 0.0, 0.0
            probs[y] = (s + smooth * overall) / (n + smooth)
        curves[name] = probs
        curves[f"{name}_overall"] = overall
    return curves


def player_opportunity(pbp: pd.DataFrame, curves: dict) -> pd.DataFrame:
    """Per player-season: opportunities, expected TDs, realized TDs, red-zone volume."""
    rows = []

    runs = pbp[(pbp["rush_attempt"] == 1) & pbp["rusher_player_id"].notna()].copy()
    runs["yl"] = runs["yardline_100"].clip(1, 99).round().astype(int)
    runs["xtd"] = runs["yl"].map(curves["rush"]).astype(float)
    runs["td"] = pd.to_numeric(runs["rush_touchdown"], errors="coerce").fillna(0)
    r = runs.groupby(["rusher_player_id", "season"]).agg(
        ratt=("yl", "size"), rz_ratt=("yl", lambda s: int((s <= 20).sum())),
        gl_ratt=("yl", lambda s: int((s <= 5).sum())),
        x_rtd=("xtd", "sum"), a_rtd=("td", "sum"),
    ).reset_index().rename(columns={"rusher_player_id": "gsis_id"})
    rows.append(r)

    tgts = pbp[(pbp["pass_attempt"] == 1) & pbp["receiver_player_id"].notna()].copy()
    tgts["yl"] = tgts["yardline_100"].clip(1, 99).round().astype(int)
    tgts["xtd"] = tgts["yl"].map(curves["target"]).astype(float)
    tgts["td"] = pd.to_numeric(tgts["pass_touchdown"], errors="coerce").fillna(0)
    t = tgts.groupby(["receiver_player_id", "season"]).agg(
        tgt=("yl", "size"), rz_tgt=("yl", lambda s: int((s <= 20).sum())),
        gl_tgt=("yl", lambda s: int((s <= 5).sum())),
        x_retd=("xtd", "sum"), a_retd=("td", "sum"),
    ).reset_index().rename(columns={"receiver_player_id": "gsis_id"})
    rows.append(t)

    out = rows[0].merge(rows[1], on=["gsis_id", "season"], how="outer")
    num = [c for c in out.columns if c not in ("gsis_id", "season")]
    out[num] = out[num].fillna(0.0)
    out["x_td"] = out["x_rtd"] + out["x_retd"]
    out["a_td"] = out["a_rtd"] + out["a_retd"]
    out["td_oe"] = out["a_td"] - out["x_td"]  # touchdowns over expected
    return out


def validate_regression(opp: pd.DataFrame) -> dict:
    """Does expected TD predict NEXT season's TDs better than realized TD does?

    This is the empirical justification for weighting expected over realized. If it does
    not hold in this data, the weight in the model should change.
    """
    res = {}
    seasons = sorted(opp["season"].unique())
    pairs = []
    for y0, y1 in zip(seasons[:-1], seasons[1:]):
        a = opp[opp["season"] == y0].set_index("gsis_id")
        b = opp[opp["season"] == y1].set_index("gsis_id")
        common = a.index.intersection(b.index)
        # Require a real workload in the base year so we are not correlating noise.
        common = [i for i in common if (a.loc[i, "ratt"] + a.loc[i, "tgt"]) >= 50]
        if len(common) < 30:
            continue
        pairs.append(pd.DataFrame({
            "x_td": a.loc[common, "x_td"].to_numpy(),
            "a_td": a.loc[common, "a_td"].to_numpy(),
            "next_td": b.loc[common, "a_td"].to_numpy(),
            "opp": (a.loc[common, "ratt"] + a.loc[common, "tgt"]).to_numpy(),
        }))
    if not pairs:
        return {"ok": False, "reason": "not enough paired seasons"}

    d = pd.concat(pairs, ignore_index=True)
    # Put both predictors on a per-opportunity footing so the comparison is fair.
    r_x = float(np.corrcoef(d["x_td"], d["next_td"])[0, 1])
    r_a = float(np.corrcoef(d["a_td"], d["next_td"])[0, 1])

    # Best linear blend weight on expected vs realized.
    X = np.column_stack([np.ones(len(d)), d["x_td"], d["a_td"]])
    beta = np.linalg.lstsq(X, d["next_td"].to_numpy(), rcond=None)[0]
    wx = float(beta[1] / (beta[1] + beta[2])) if (beta[1] + beta[2]) != 0 else 0.5

    res = {
        "ok": True,
        "n_player_seasons": int(len(d)),
        "corr_expected_vs_next": round(r_x, 4),
        "corr_realized_vs_next": round(r_a, 4),
        "expected_beats_realized": bool(r_x > r_a),
        "implied_expected_weight": round(float(np.clip(wx, 0.0, 1.0)), 3),
        "mean_abs_td_oe": round(float(d["a_td"].sub(d["x_td"]).abs().mean()), 3),
    }
    return res


def kicker_distance_profile(pbp: pd.DataFrame) -> dict:
    """League field-goal make rates by distance bucket, for kicker projection."""
    fg = pbp[pbp["field_goal_attempt"] == 1].copy()
    fg["kick_distance"] = pd.to_numeric(fg["kick_distance"], errors="coerce")
    fg = fg.dropna(subset=["kick_distance"])
    fg["made"] = (fg["field_goal_result"] == "made").astype(int)
    buckets = [(0, 19, "0_19"), (20, 29, "20_29"), (30, 39, "30_39"),
               (40, 49, "40_49"), (50, 59, "50_59"), (60, 99, "60")]
    out = {}
    for lo, hi, key in buckets:
        sel = fg[(fg["kick_distance"] >= lo) & (fg["kick_distance"] <= hi)]
        if len(sel):
            out[key] = {"rate": round(float(sel["made"].mean()), 4),
                        "att_share": round(float(len(sel) / len(fg)), 4), "n": int(len(sel))}
    return out


def build(seasons=PBP_SEASONS) -> dict:
    pbp = load_pbp(seasons)
    curves = td_probability_curves(pbp)
    opp = player_opportunity(pbp, curves)
    return {
        "curves": curves,
        "opportunity": opp,
        "regression_check": validate_regression(opp),
        "kicker_fg": kicker_distance_profile(pbp),
        "n_plays": int(len(pbp)),
    }


if __name__ == "__main__":
    out = build()
    print(f"plays parsed: {out['n_plays']:,}")
    c = out["curves"]
    print("\nP(TD | yard line):")
    print(f"{'yl':>4} {'rush':>8} {'target':>8}")
    for y in (1, 2, 3, 5, 10, 15, 20, 30, 50, 75):
        print(f"{y:>4} {c['rush'][y]:>8.4f} {c['target'][y]:>8.4f}")
    print(f"\noverall rush TD rate: {c['rush_overall']:.4f}   target: {c['target_overall']:.4f}")
    print("\nexpected-vs-realized TD regression check:")
    print(json.dumps(out["regression_check"], indent=2))
    print("\nleague FG rates by distance:")
    print(json.dumps(out["kicker_fg"], indent=2))
    o = out["opportunity"]
    top = o[o["season"] == max(o["season"])].nlargest(8, "td_oe")[
        ["gsis_id", "a_td", "x_td", "td_oe", "ratt", "tgt"]]
    print("\nmost touchdown-lucky players, most recent season (prime regression candidates):")
    print(top.to_string(index=False))
