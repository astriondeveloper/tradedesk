"""nflverse columns -> the canonical component vocabulary in docs/ARCHITECTURE.md §3.

The pipeline never computes fantasy points. It emits components; the browser scores them.
That is what makes "works in every scoring format" true rather than aspirational.

`validate_mapping` re-derives nflverse's own `fantasy_points_ppr` from the extracted
components. If the mapping drifts, that check fails loudly instead of silently poisoning
every projection downstream.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

# canonical key -> nflverse column
PASS = {
    "patt": "attempts",
    "pcmp": "completions",
    "pyd": "passing_yards",
    "ptd": "passing_tds",
    "pint": "passing_interceptions",
    "psack": "sacks_suffered",
    "p2p": "passing_2pt_conversions",
    "p40": "passing_40",
    "pfd": "passing_first_downs",
}
RUSH = {
    "ratt": "carries",
    "ryd": "rushing_yards",
    "rtd": "rushing_tds",
    "r2p": "rushing_2pt_conversions",
    "r40": "rushing_40",
    "rfd": "rushing_first_downs",
}
RECV = {
    "tgt": "targets",
    "rec": "receptions",
    "reyd": "receiving_yards",
    "retd": "receiving_tds",
    "re2p": "receiving_2pt_conversions",
    "re40": "receiving_40",
    "refd": "receiving_first_downs",
}
KICK = {
    "fgm_0_19": "fg_made_0_19", "fgm_20_29": "fg_made_20_29", "fgm_30_39": "fg_made_30_39",
    "fgm_40_49": "fg_made_40_49", "fgm_50_59": "fg_made_50_59", "fgm_60": "fg_made_60_",
    "fgx_0_19": "fg_missed_0_19", "fgx_20_29": "fg_missed_20_29", "fgx_30_39": "fg_missed_30_39",
    "fgx_40_49": "fg_missed_40_49", "fgx_50_59": "fg_missed_50_59", "fgx_60": "fg_missed_60_",
    "xpm": "pat_made", "xpx": "pat_missed",
}
# Fumbles lost arrive split by the phase they happened in; fantasy scoring cares only
# about the total, and only about ones actually lost.
FUMBLE_PARTS = ["sack_fumbles_lost", "rushing_fumbles_lost", "receiving_fumbles_lost"]

OFFENSE_KEYS = list(PASS) + list(RUSH) + list(RECV) + ["fuml", "sttd"]
KICKER_KEYS = list(KICK)
DST_KEYS = ["sack", "dint", "fumrec", "safety", "dtd", "blk", "sttd", "ptsAllowed", "ydsAllowed"]


def _col(df: pd.DataFrame, name: str) -> pd.Series:
    if name in df.columns:
        return pd.to_numeric(df[name], errors="coerce").fillna(0.0)
    return pd.Series(0.0, index=df.index)


def extract_offense(df: pd.DataFrame) -> pd.DataFrame:
    """Player-week rows -> canonical offensive + kicking components."""
    out = pd.DataFrame(index=df.index)
    for group in (PASS, RUSH, RECV, KICK):
        for key, src in group.items():
            out[key] = _col(df, src)
    out["fuml"] = sum(_col(df, c) for c in FUMBLE_PARTS)
    out["sttd"] = _col(df, "special_teams_tds")
    return out


def validate_mapping(df: pd.DataFrame, comp: pd.DataFrame, tol: float = 0.02) -> dict:
    """Re-derive nflverse `fantasy_points_ppr` from components as an integrity check.

    nflverse scores PPR as: 0.04/pass yd, 4/pass TD, -2/INT, 0.1/rush+rec yd, 6/TD,
    1/reception, -2/fumble lost, 2/two-point conversion, 6/special-teams TD.
    """
    if "fantasy_points_ppr" not in df.columns:
        return {"checked": 0, "note": "no reference column present"}

    derived = (
        0.04 * comp["pyd"] + 4 * comp["ptd"] - 2 * comp["pint"]
        + 0.1 * comp["ryd"] + 6 * comp["rtd"]
        + 0.1 * comp["reyd"] + 6 * comp["retd"] + 1.0 * comp["rec"]
        - 2 * comp["fuml"]
        + 2 * (comp["p2p"] + comp["r2p"] + comp["re2p"])
        + 6 * comp["sttd"]
    )
    ref = pd.to_numeric(df["fantasy_points_ppr"], errors="coerce")
    mask = ref.notna()
    diff = (derived[mask] - ref[mask]).abs()
    bad = int((diff > tol).sum())
    worst_idx = diff.idxmax() if len(diff) else None
    return {
        "checked": int(mask.sum()),
        "mismatches": bad,
        "max_abs_diff": float(diff.max()) if len(diff) else 0.0,
        "worst_row": None if worst_idx is None else {
            "player": str(df.loc[worst_idx].get("player_display_name", "?")),
            "season": int(df.loc[worst_idx].get("season", 0)),
            "week": int(df.loc[worst_idx].get("week", 0)),
            "derived": float(derived.loc[worst_idx]),
            "reference": float(ref.loc[worst_idx]),
        },
    }


def team_defense_components(team_week: pd.DataFrame, games: pd.DataFrame) -> pd.DataFrame:
    """Build DST component lines.

    Sacks / INTs / fumble recoveries / safeties / defensive TDs come from the team's own
    defensive columns. Points allowed comes from the game result. Yards allowed is the
    OPPONENT's offensive production in that same game, which has to be joined back in --
    it is not a column on the defense's own row.
    """
    tw = team_week.copy()
    tw["team"] = tw["team"].astype(str)
    tw["opponent_team"] = tw["opponent_team"].astype(str)

    # Offensive yardage each team produced, keyed by (game, team), used as the
    # opponent's yards-allowed.
    tw["off_yards"] = _col(tw, "passing_yards") + _col(tw, "rushing_yards")
    off = tw[["game_id", "team", "off_yards"]].rename(
        columns={"team": "opponent_team", "off_yards": "ydsAllowed"}
    )

    d = pd.DataFrame(
        {
            "season": tw["season"],
            "week": tw["week"],
            "game_id": tw["game_id"],
            "team": tw["team"],
            "opponent_team": tw["opponent_team"],
            "sack": _col(tw, "def_sacks"),
            "dint": _col(tw, "def_interceptions"),
            "fumrec": _col(tw, "fumble_recovery_opp"),
            "safety": _col(tw, "def_safeties"),
            "dtd": _col(tw, "def_tds"),
            "blk": _col(tw, "def_punt_blocks") + _col(tw, "def_pat_blocks") + _col(tw, "def_fg_blocks"),
            "sttd": _col(tw, "special_teams_tds"),
        }
    )
    d = d.merge(off, on=["game_id", "opponent_team"], how="left")

    # Points allowed from the box score.
    g = games[["game_id", "home_team", "away_team", "home_score", "away_score"]].copy()
    home = g.rename(columns={"home_team": "team", "away_score": "ptsAllowed"})[["game_id", "team", "ptsAllowed"]]
    away = g.rename(columns={"away_team": "team", "home_score": "ptsAllowed"})[["game_id", "team", "ptsAllowed"]]
    pa = pd.concat([home, away], ignore_index=True)
    d = d.merge(pa, on=["game_id", "team"], how="left")

    d["ydsAllowed"] = pd.to_numeric(d["ydsAllowed"], errors="coerce")
    d["ptsAllowed"] = pd.to_numeric(d["ptsAllowed"], errors="coerce")
    return d.dropna(subset=["ptsAllowed", "ydsAllowed"]).reset_index(drop=True)
