"""Out-of-sample backtest: project a completed season, then check against what happened.

Run:  python3 pipeline/backtest.py --season 2025

The model is rebuilt using ONLY data available before the target season -- prior seasons
for usage, efficiency and expected touchdowns; that season's schedule and betting lines,
which are posted preseason -- and then scored against what players actually did.

Three baselines, because a projection is only as good as what it beats:

  last_year   the player's own prior-season points per game (what most people default to)
  ecr         the expert consensus ordering (the market)
  league_avg  positional mean (the floor any model must clear)

One thing to expect, and not to "fix": a calibrated projection is COMPRESSED relative to
outcomes. The player who finishes WR1 is partly the player who got lucky, so the expected
value of today's WR1 is lower than the realized value of the eventual WR1. A model whose
top projection equals the realized top score is overconfident, not accurate. What matters
is bias near zero, good rank correlation, and beating the baselines.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

import features as F  # noqa: E402
import market  # noqa: E402
import model as M  # noqa: E402
import priors as P  # noqa: E402
import redzone as RZ  # noqa: E402
import blend as BL  # noqa: E402
from identity import Resolver  # noqa: E402
from sanity import SCORING  # noqa: E402

MIN_GAMES = 6  # a player needs a real season for the comparison to mean anything


def actual_ppg(hist: pd.DataFrame, season: int) -> pd.DataFrame:
    """Realized full-PPR points per game in `season`."""
    h = hist[hist["season"] == season].copy()
    pts = sum(w * h[k].fillna(0.0) for k, w in SCORING.items() if k in h.columns)
    h = h.assign(pts=pts)
    g = h.groupby("gsis_id").agg(games=("week", "nunique"), total=("pts", "sum"),
                                 pos=("pos", "first"), name=("name", "first"))
    g["actual_ppg"] = g["total"] / g["games"]
    return g.reset_index()


def build_projection(target: int, use_blend: bool = True) -> pd.DataFrame:
    """Run the full model with a strict pre-target-season information cutoff.

    `use_blend` mirrors what actually ships: the consensus-rank blend from
    build_pack.market_blend, fed the board as it stood before this season kicked off.
    Reporting backtest numbers for a pipeline different from the one that ships would be
    worse than reporting nothing.
    """
    hist_seasons = [s for s in range(2019, target)]
    hist = F.load_player_history(hist_seasons)
    team_hist = F.load_team_history(hist_seasons)
    games = F.load_games()
    coef = M.load_coefficients()

    sched, byes, cov = market.build_schedule(games, target)

    pbp_seasons = tuple(s for s in RZ.PBP_SEASONS if s < target)
    rz = RZ.build(pbp_seasons) if pbp_seasons else None
    if rz is None:
        raise SystemExit(f"no play-by-play cached before {target}")

    role_priors = P.role_priors(hist, team_hist, seasons=tuple(hist_seasons[-4:]))
    rates = M.weighted_player_rates(hist, team_hist)

    roster = F.current_rosters(target)
    resolver = Resolver()
    for _, x in roster.iterrows():
        resolver.add(x["gsis_id"], x["name"], x["team"], x["pos"])

    # Universe: players on that season's opening rosters at fantasy positions.
    uni = roster[roster["pos"].isin(["QB", "RB", "WR", "TE"])].copy()
    uni = uni.rename(columns={"pos": "pos"})[["gsis_id", "name", "pos", "team"]]

    # No depth chart for past seasons in the cache, so rank comes from prior-season usage
    # within team+position -- the same information a preseason projector would have had.
    usage = rates.set_index("gsis_id")
    uni["_u"] = uni["gsis_id"].map(
        lambda i: (usage.loc[i, "tgt_pg"] + usage.loc[i, "ratt_pg"] + usage.loc[i, "patt_pg"])
        if i in usage.index else 0.0)
    uni["dc_rank"] = uni.sort_values("_u", ascending=False).groupby(["team", "pos"]).cumcount() + 1

    av = F.availability(hist, seasons=tuple(hist_seasons[-4:]))
    own_active = {r["gsis_id"]: r["raw_active"] for _, r in av.iterrows()}

    factors, base = M.team_week_factors(sched, coef)
    proj = M.project_players(rates, uni, role_priors, rz["opportunity"], rz["curves"],
                             base, coef, own_active)
    proj = M.reconcile_to_team(proj, base)

    if use_blend:
        board = BL.preseason_board(BL.load_history(), target)
        ecr_rank = {}
        if len(board):
            for _, row in board.iterrows():
                pid = resolver.resolve(row["player"], row.get("tm", ""), row["pos"])
                if pid and pd.notna(row.get("ecr")):
                    ecr_rank[pid] = float(row["ecr"])
        if ecr_rank:
            from build_pack import market_blend
            proj = market_blend(proj, ecr_rank)
            proj = M.reconcile_to_team(proj, base)

    proj["proj_ppg"] = sum(
        w * proj[f"mu_{k}"] for k, w in SCORING.items() if f"mu_{k}" in proj.columns
    )
    return proj.merge(uni[["gsis_id", "name"]], on="gsis_id", how="left")


def evaluate(target: int) -> dict:
    full_hist = F.load_player_history()
    actual = actual_ppg(full_hist, target)
    proj = build_projection(target)

    prior = actual_ppg(full_hist, target - 1)[["gsis_id", "actual_ppg"]].rename(
        columns={"actual_ppg": "last_year_ppg"})

    d = (actual[actual["games"] >= MIN_GAMES]
         .merge(proj[["gsis_id", "proj_ppg"]], on="gsis_id", how="inner")
         .merge(prior, on="gsis_id", how="left"))
    d = d[d["pos"].isin(["QB", "RB", "WR", "TE"])]

    pos_mean = d.groupby("pos")["actual_ppg"].transform("mean")
    d["league_avg"] = pos_mean
    d["last_year_ppg"] = d["last_year_ppg"].fillna(pos_mean)

    def metrics(pred: pd.Series, act: pd.Series) -> dict:
        e = pred - act
        # Spearman as Pearson on ranks, so this does not need scipy.
        rp, ra = pd.Series(pred).rank(), pd.Series(act).rank()
        return {
            "mae": round(float(e.abs().mean()), 3),
            "rmse": round(float(np.sqrt((e ** 2).mean())), 3),
            "bias": round(float(e.mean()), 3),
            "corr": round(float(np.corrcoef(pred, act)[0, 1]), 4),
            "spearman": round(float(np.corrcoef(rp, ra)[0, 1]), 4),
        }

    out = {"season": target, "n_players": int(len(d)), "min_games": MIN_GAMES, "overall": {}, "by_pos": {}}
    out["overall"] = {
        "model": metrics(d["proj_ppg"], d["actual_ppg"]),
        "last_year": metrics(d["last_year_ppg"], d["actual_ppg"]),
        "league_avg": metrics(d["league_avg"], d["actual_ppg"]),
    }
    for pos, g in d.groupby("pos"):
        if len(g) < 10:
            continue
        out["by_pos"][pos] = {
            "n": int(len(g)),
            "model": metrics(g["proj_ppg"], g["actual_ppg"]),
            "last_year": metrics(g["last_year_ppg"], g["actual_ppg"]),
            "proj_mean": round(float(g["proj_ppg"].mean()), 2),
            "actual_mean": round(float(g["actual_ppg"].mean()), 2),
            "proj_top5_mean": round(float(g.nlargest(5, "proj_ppg")["proj_ppg"].mean()), 2),
            "actual_top5_mean": round(float(g.nlargest(5, "actual_ppg")["actual_ppg"].mean()), 2),
        }

    # Where the model was most wrong, in both directions. Useful for spotting a systematic
    # failure mode rather than just an unlucky season.
    d = d.assign(err=d["proj_ppg"] - d["actual_ppg"])
    cols = ["name", "pos", "proj_ppg", "actual_ppg", "err"]
    out["worst_over"] = d.nlargest(8, "err")[cols].round(2).to_dict("records")
    out["worst_under"] = d.nsmallest(8, "err")[cols].round(2).to_dict("records")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2025)
    args = ap.parse_args()

    r = evaluate(args.season)
    o = r["overall"]
    print(f"=== backtest {r['season']} | {r['n_players']} players with >= {r['min_games']} games ===\n")
    print(f"{'predictor':<12}{'MAE':>8}{'RMSE':>8}{'bias':>8}{'corr':>8}{'spearman':>10}")
    for k in ("model", "last_year", "league_avg"):
        m = o[k]
        print(f"{k:<12}{m['mae']:>8.3f}{m['rmse']:>8.3f}{m['bias']:>8.3f}{m['corr']:>8.4f}{m['spearman']:>10.4f}")

    lift = (o["last_year"]["mae"] - o["model"]["mae"]) / o["last_year"]["mae"] * 100
    print(f"\nMAE improvement over last-year-PPG baseline: {lift:+.1f}%")

    print(f"\n{'pos':<5}{'n':>5}{'modelMAE':>10}{'lastYrMAE':>11}{'corr':>8}"
          f"{'projMean':>10}{'actMean':>9}{'projTop5':>10}{'actTop5':>9}")
    for pos, m in r["by_pos"].items():
        print(f"{pos:<5}{m['n']:>5}{m['model']['mae']:>10.2f}{m['last_year']['mae']:>11.2f}"
              f"{m['model']['corr']:>8.3f}{m['proj_mean']:>10.2f}{m['actual_mean']:>9.2f}"
              f"{m['proj_top5_mean']:>10.2f}{m['actual_top5_mean']:>9.2f}")

    print("\nmost over-projected:")
    for x in r["worst_over"][:5]:
        print(f"  {x['name'][:22]:<22} {x['pos']:<3} proj {x['proj_ppg']:>6.2f}  actual {x['actual_ppg']:>6.2f}")
    print("most under-projected:")
    for x in r["worst_under"][:5]:
        print(f"  {x['name'][:22]:<22} {x['pos']:<3} proj {x['proj_ppg']:>6.2f}  actual {x['actual_ppg']:>6.2f}")

    Path(__file__).resolve().parent.joinpath(f"backtest_{args.season}.json").write_text(
        json.dumps(r, indent=2))


if __name__ == "__main__":
    main()
