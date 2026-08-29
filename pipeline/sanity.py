"""Face-validity check on the built pack.

A projection set can be internally consistent and still be nonsense. This scores the pack
under the user's exact league and prints the leaderboards, so obvious breakage -- a
backup ranked RB1, a team throwing 800 times, negative receptions -- is visible
immediately rather than after it has already priced a trade.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / "app" / "data" / "pack.js"

# The user's league, mirrored here so the check does not depend on the JS engine.
SCORING = {
    "pyd": 0.04, "ptd": 4, "pint": -2, "p2p": 2,
    "ryd": 0.1, "rtd": 6, "r2p": 2,
    "reyd": 0.1, "retd": 6, "rec": 1.0, "re2p": 2,
    "fuml": -2, "sttd": 6,
}
FG_PTS = {"0_19": 3, "20_29": 3, "30_39": 3, "40_49": 4, "50_59": 5, "60": 6}
PA_TIERS = [(0, 5), (6, 4), (13, 3), (17, 1), (21, 0), (27, 0), (34, -1), (45, -3), (10**9, -5)]
YA_TIERS = [(99, 5), (199, 3), (299, 2), (349, 0), (399, -1), (449, -3), (499, -5), (549, -6), (10**9, -7)]
DST_PTS = {"sack": 1, "dint": 2, "fumrec": 2, "safety": 2, "dtd": 6, "blk": 2, "sttd": 6}


def load_pack() -> dict:
    txt = PACK.read_text()
    return json.loads(re.sub(r"^window\.TD_PACK=", "", txt).rstrip().rstrip(";"))


def tier(v, tiers):
    for cap, pts in tiers:
        if v <= cap:
            return pts
    return tiers[-1][1]


def score_offense(mu: dict) -> float:
    return sum(w * float(mu.get(k, 0.0)) for k, w in SCORING.items())


def score_kicker(mu: dict) -> float:
    s = 0.0
    for b, pts in FG_PTS.items():
        s += pts * float(mu.get(f"fgm_{b}", 0.0))
        s += -1 * float(mu.get(f"fgx_{b}", 0.0))
    s += 1 * float(mu.get("xpm", 0.0)) + -1 * float(mu.get("xpx", 0.0))
    return s


def score_dst(mu: dict) -> float:
    s = sum(w * float(mu.get(k, 0.0)) for k, w in DST_PTS.items())
    s += tier(float(mu.get("ptsAllowed", 22)), PA_TIERS)
    s += tier(float(mu.get("ydsAllowed", 340)), YA_TIERS)
    return s


def ppg(p: dict) -> float:
    if p["pos"] == "DST":
        wk = p.get("dstWeeks") or {}
        return sum(score_dst(v) for v in wk.values()) / max(len(wk), 1)
    if p["pos"] == "K":
        wk = p.get("kWeeks") or {}
        return sum(score_kicker(v) for v in wk.values()) / max(len(wk), 1)
    return score_offense(p.get("mu") or {})


def main() -> None:
    pack = load_pack()
    players = pack["players"]
    for p in players:
        p["_ppg"] = ppg(p)

    print(f"pack: {len(players)} players, generated {pack['meta']['generated']}")
    print(f"market coverage: {pack['meta']['marketCoverage']['market_share']:.0%} posted lines\n")

    for pos in ("QB", "RB", "WR", "TE", "K", "DST"):
        sel = sorted([p for p in players if p["pos"] == pos], key=lambda x: -x["_ppg"])[:12]
        print(f"--- top {pos} (pts/game, full PPR) ---")
        for i, p in enumerate(sel, 1):
            ecr = p.get("ecr", {}).get("ov")
            role = p.get("role") or {}
            extra = ""
            if pos in ("RB", "WR", "TE"):
                extra = (f"  tgt%={role.get('tgtShare', 0):.3f} rush%={role.get('rushShare', 0):.3f}"
                         f" xTD={role.get('xTD', 0):.1f} aTD={role.get('aTD', 0):.1f}")
            elif pos == "QB":
                extra = f"  ypa={role.get('ypt', 0):.2f}"
            print(f"{i:>3}. {p['name'][:24]:<24} {p['team']:<4} {p['_ppg']:6.2f}"
                  f"  ecr={ecr if ecr else '-':>6}{extra}")
        print()

    # Internal consistency: do team totals look like an NFL team?
    print("--- team volume reconciliation (availability-weighted) ---")
    print("  Usage shares are conditional on playing, so team totals reconcile only when")
    print("  weighted by each player's probability of being active. Raw sums run ~1.4x.")
    # Targets and carries are shared inside one game, so they sum across the roster.
    # Quarterback volume is NOT shared -- every QB is projected at starter volume and how
    # often he actually starts lives in `avail` -- so the team's passing line is taken
    # from its top QB alone. Summing QBs here would double-count by design.
    by_team = {}
    best_qb = {}
    for p in players:
        if p["pos"] in ("QB", "RB", "WR", "TE") and p.get("mu"):
            t = by_team.setdefault(p["team"], {"tgt": 0.0, "ratt": 0.0, "patt": 0.0,
                                               "reyd": 0.0, "pyd": 0.0, "td": 0.0})
            a = float(p.get("act", 0.5))
            t["tgt"] += a * p["mu"].get("tgt", 0)
            t["ratt"] += a * p["mu"].get("ratt", 0)
            t["reyd"] += a * p["mu"].get("reyd", 0)
            t["td"] += a * (p["mu"].get("rtd", 0) + p["mu"].get("retd", 0))
            if p["pos"] == "QB":
                cur = best_qb.get(p["team"])
                if cur is None or p["mu"].get("patt", 0) > cur.get("patt", 0):
                    best_qb[p["team"]] = p["mu"]
    for tm, mu in best_qb.items():
        if tm in by_team:
            by_team[tm]["patt"] = mu.get("patt", 0)
    # Team passing yards come from the team-level budget, not one QB's line: each QB is
    # projected at starter volume with his own efficiency, so QB1's yardage is his, while
    # the receiving side is the whole roster availability-weighted.
    for tm, tb in pack.get("teamBase", {}).items():
        if tm in by_team:
            by_team[tm]["pyd"] = tb.get("pass_yds", 0.0)
    rows = sorted(by_team.items())
    print(f"{'team':<5}{'tgt/g':>8}{'ratt/g':>8}{'patt/g':>8}{'recYd/g':>9}{'passYd/g':>10}{'TD/g':>7}")
    for t, v in rows[:8]:
        print(f"{t:<5}{v['tgt']:>8.1f}{v['ratt']:>8.1f}{v['patt']:>8.1f}"
              f"{v['reyd']:>9.1f}{v['pyd']:>10.1f}{v['td']:>7.2f}")
    import statistics as st
    for k, lo, hi in (("tgt", 28, 42), ("ratt", 20, 33), ("patt", 28, 42),
                      ("reyd", 180, 300), ("td", 1.5, 3.6)):
        vals = [v[k] for v in by_team.values()]
        flag = "" if lo <= st.mean(vals) <= hi else "   <-- OUT OF EXPECTED RANGE"
        print(f"league mean {k:>5}: {st.mean(vals):7.2f}  (min {min(vals):.1f}, max {max(vals):.1f}){flag}")

    # Receiving yards should reconcile against passing yards.
    # Receiving yards are availability-weighted above; passing yards come from each
    # team's QB1 at starter volume, so compare like with like.
    tot_rec = sum(v["reyd"] for v in by_team.values())
    tot_pass = sum(v["pyd"] for v in by_team.values())
    print(f"\nrecYds/passYds ratio: {tot_rec/max(tot_pass,1):.3f}  (should be near 1.00)")


if __name__ == "__main__":
    main()
