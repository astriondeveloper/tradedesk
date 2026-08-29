"""Generate a realistic demo league so the app is usable the moment it opens.

An empty trade evaluator is useless: you cannot judge one until real rosters are in it,
and typing thirty players before you learn anything is a bad first minute. So this runs a
plausible 12-team snake draft over the actual 2026 consensus board and ships two of the
resulting rosters as a worked example.

The two teams are chosen deliberately, not at random. One is built RB-heavy and thin at
receiver; the other is the mirror image. That is the case the whole tool exists to price:
the same trade is a win for one of these rosters and a loss for the other, and a tool that
sums projected points cannot tell them apart.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / "app" / "data" / "pack.js"
OUT = ROOT / "app" / "data" / "demo.js"

TEAMS = 12
ROUNDS = 15
# Roughly how a real room drafts: positional need with a bias toward the board.
SLOT_TARGETS = {"QB": 2, "RB": 5, "WR": 6, "TE": 2, "K": 1, "DST": 1}
# Nobody takes a kicker or defense early.
LATE_ONLY = {"K": 12, "DST": 11}


def load_pack() -> dict:
    txt = PACK.read_text()
    return json.loads(re.sub(r"^window\.TD_PACK=", "", txt).rstrip().rstrip(";"))


def board(pack: dict) -> list:
    """Draftable players ordered by consensus rank, model rank breaking ties."""
    import sanity

    rows = []
    for p in pack["players"]:
        ecr = (p.get("ecr") or {}).get("ov")
        ppg = sanity.ppg(p)
        rows.append({"p": p, "ecr": ecr if ecr else 9999, "ppg": ppg})
    # Players off the consensus board sort behind it, ordered by the model.
    rows.sort(key=lambda r: (r["ecr"], -r["ppg"]))
    return rows


def snake_draft(pack: dict) -> list[list[dict]]:
    avail = board(pack)
    rosters = [[] for _ in range(TEAMS)]
    counts = [{k: 0 for k in SLOT_TARGETS} for _ in range(TEAMS)]

    for rnd in range(1, ROUNDS + 1):
        order = range(TEAMS) if rnd % 2 else reversed(range(TEAMS))
        # Real rooms do not end up without a kicker. Reserve the last two rounds so every
        # team can actually field a legal lineup -- otherwise the demo opens with an empty
        # slot and the verdict starts by complaining about it.
        forced = None
        if rnd == ROUNDS - 1:
            forced = "DST"
        elif rnd == ROUNDS:
            forced = "K"

        for team in order:
            pick = None
            for i, row in enumerate(avail):
                pos = row["p"]["pos"]
                if forced:
                    if pos != forced or counts[team][pos] >= 1:
                        continue
                else:
                    if counts[team][pos] >= SLOT_TARGETS[pos]:
                        continue
                    if pos in LATE_ONLY and rnd < LATE_ONLY[pos]:
                        continue
                pick = i
                break
            if pick is None:
                continue
            row = avail.pop(pick)
            rosters[team].append(row["p"])
            counts[team][row["p"]["pos"]] += 1
    return rosters


def shape(roster: list[dict]) -> dict:
    import sanity

    by = {}
    for p in roster:
        by.setdefault(p["pos"], []).append(sanity.ppg(p))
    return {k: round(sum(sorted(v, reverse=True)[:3]), 1) for k, v in by.items()}


def pick_contrasting_pair(rosters: list[list[dict]]) -> tuple[int, int]:
    """Find the two rosters with the most opposite RB/WR balance.

    This is what makes the demo teach something: two teams whose strengths are inverted
    are exactly the pair for whom the same trade has two different answers.
    """
    scores = []
    for i, r in enumerate(rosters):
        s = shape(r)
        scores.append((i, s.get("RB", 0) - s.get("WR", 0)))
    # Ascending by (RB strength - WR strength): the first entry is the most
    # receiver-heavy roster, the last is the most back-heavy. Returned back-heavy first so
    # the caller's naming lines up with the shape.
    scores.sort(key=lambda t: t[1])
    return scores[-1][0], scores[0][0]


def main() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    pack = load_pack()
    rosters = snake_draft(pack)
    a, b = pick_contrasting_pair(rosters)

    def pack_team(idx: int, name: str) -> dict:
        return {
            "name": name,
            "players": [
                {"id": p["id"], "name": p["name"], "pos": p["pos"],
                 "team": p["team"], "bye": p["bye"]}
                for p in rosters[idx]
            ],
        }

    demo = {
        "note": ("A 12-team snake draft run over the real 2026 consensus board. These two "
                 "rosters were picked because their strengths are inverted -- the same "
                 "trade should not be worth the same to both of them."),
        "league": {"teams": TEAMS, "rounds": ROUNDS},
        "teamA": pack_team(a, "Ground Game"),
        "teamB": pack_team(b, "Air Raid"),
        "shapeA": shape(rosters[a]),
        "shapeB": shape(rosters[b]),
    }
    OUT.write_text(f"window.TD_DEMO={json.dumps(demo, separators=(',', ':'))};\n")

    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
    for label, idx in (("A / Ground Game", a), ("B / Air Raid", b)):
        print(f"\n{label}  top-3 PPG by position: {shape(rosters[idx])}")
        for p in sorted(rosters[idx], key=lambda x: ["QB", "RB", "WR", "TE", "K", "DST"].index(x["pos"])):
            import sanity
            print(f"   {p['pos']:<4} {p['name'][:26]:<26} {p['team']:<4} bye {p['bye']:<3} {sanity.ppg(p):5.1f}")


if __name__ == "__main__":
    main()
