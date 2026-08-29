"""Compile the real league into app/data/league.js.

`league.json` is transcribed by hand from ESPN's matchup pages, so it is exactly the kind
of input that rots quietly: a mistyped NFL team or a name that resolves to the wrong Josh
would produce a roster that looks fine and prices wrong. Three checks run against the pack
before anything is written, and every one of them is fatal:

1. **Every name resolves exactly**, through the same strict resolver the market join uses.
   An ambiguous name is a failure, never a guess, and so is a name that only matched on the
   surname -- those have to be spelled out in `identity.ALIASES` first.
2. **Position agrees** with the pack.
3. **The NFL team agrees**, cross-examined against the schedule. ESPN's opponent column for
   the transcribed week is carried through and checked against the pack's own schedule for
   that team, which catches a mistyped team code even when the name still resolves.

The output is a plain roster list per team: ids and enough labelling for the app to draw a
row. No projections and no fantasy points -- those are the browser's job, from the pack.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / "app" / "data" / "pack.js"
SRC = ROOT / "pipeline" / "league.json"
OUT = ROOT / "app" / "data" / "league.js"

sys.path.insert(0, str(Path(__file__).resolve().parent))
from identity import Resolver, norm_name, norm_team  # noqa: E402


def load_pack() -> dict:
    txt = PACK.read_text()
    return json.loads(re.sub(r"^window\.TD_PACK=", "", txt).rstrip().rstrip(";"))


def build_resolver(pack: dict) -> Resolver:
    r = Resolver()
    for p in pack["players"]:
        if p["pos"] == "DST":
            continue  # matched by team, not by name
        r.add(p["id"], p["name"], p.get("team", ""), p["pos"])
    return r


def week_opponent(pack: dict, team: str, week: int) -> tuple[str, bool] | None:
    """(opponent, is_away) for a team in a week, or None on a bye."""
    for g in pack["schedule"].get(team, []):
        if g["w"] == week:
            return g["opp"], not g["home"]
    return None


def parse_opp(raw: str) -> tuple[str, bool]:
    """ESPN's opponent cell: "@KC" is away at KC, "TB" is home against TB."""
    away = raw.startswith("@")
    return norm_team(raw.lstrip("@")), away


def resolve_roster(team: dict, pack: dict, res: Resolver, week: int,
                   errors: list[str]) -> list[dict]:
    out = []
    for row in team["players"]:
        label = f"{team['name']} / {row['name']}"
        want_team = norm_team(row["nfl"])

        if row["pos"] == "DST":
            pid = f"DST-{want_team}"
            hit = next((p for p in pack["players"] if p["id"] == pid), None)
            if hit is None:
                errors.append(f"{label}: no D/ST in the pack for {want_team}")
                continue
        else:
            pid = res.resolve(row["name"], row["nfl"], row["pos"])
            if pid is None:
                errors.append(f"{label}: does not resolve to a pack player "
                              f"({row['pos']} {want_team})")
                continue
            hit = res.canonical[pid]
            if hit["pos"] != row["pos"]:
                errors.append(f"{label}: pack has him at {hit['pos']}, "
                              f"league.json says {row['pos']}")
                continue
            if hit["team"] != want_team:
                errors.append(f"{label}: pack has him on {hit['team']}, "
                              f"league.json says {want_team}")
                continue
            # The resolver will fall back to initial-plus-surname, which is fine for a
            # market join over thousands of rows and not fine for 127 rosters that decide
            # every verdict in the app. Demand an exact normalized match, and make the
            # exceptions deliberate by naming them in identity.ALIASES.
            if norm_name(row["name"]) != norm_name(hit["name"]):
                errors.append(f"{label}: matched {hit['name']!r} only by surname. If that is "
                              f"the same player, add {norm_name(row['name'])!r} -> "
                              f"{norm_name(hit['name'])!r} to identity.ALIASES")
                continue

        # Cross-examine the NFL team against the schedule. A wrong team code that still
        # resolves a name shows up here, because the opponent will not line up.
        sched = week_opponent(pack, want_team, week)
        opp, away = parse_opp(row["opp"])
        if sched is None:
            errors.append(f"{label}: {want_team} has no week {week} game (bye?), but ESPN "
                          f"showed {row['opp']}")
        elif (sched[0], sched[1]) != (opp, away):
            shown = ("@" if sched[1] else "") + sched[0]
            errors.append(f"{label}: pack has {want_team} playing {shown} in week {week}, "
                          f"ESPN showed {row['opp']}")

        pack_row = next(p for p in pack["players"] if p["id"] == pid)
        entry = {
            "id": pid,
            "name": pack_row["name"],
            "pos": pack_row["pos"],
            "team": pack_row["team"],
            "bye": pack_row["bye"],
            "slot": row["slot"],
        }
        if row.get("status"):
            entry["status"] = row["status"]
        out.append(entry)
    return out


def check_shape(src: dict, rosters: list[dict], errors: list[str]) -> None:
    """Every roster must fit the league's own slot table. A tenth starter is a typo."""
    slots = src["slots"]
    size = sum(slots.values())
    for team in rosters:
        counts: dict[str, int] = {}
        for p in team["players"]:
            counts[p["slot"]] = counts.get(p["slot"], 0) + 1
        for slot, n in slots.items():
            got = counts.get(slot, 0)
            if slot == "BEN":
                if got > n:
                    errors.append(f"{team['name']}: {got} bench players, league allows {n}")
            elif got != n:
                errors.append(f"{team['name']}: {got} players in {slot}, league has {n}")
        if len(team["players"]) > size:
            errors.append(f"{team['name']}: {len(team['players'])} players, roster holds {size}")


def check_unique(rosters: list[dict], errors: list[str]) -> None:
    """No player is on two rosters. In a real league that is impossible; here it is a typo."""
    owner: dict[str, str] = {}
    for team in rosters:
        for p in team["players"]:
            prev = owner.get(p["id"])
            if prev:
                errors.append(f"{p['name']} is on both {prev} and {team['name']}")
            owner[p["id"]] = team["name"]


def main() -> None:
    pack = load_pack()
    src = json.loads(SRC.read_text())
    week = src["asOfWeek"]

    if pack["meta"]["season"] != src["season"]:
        raise SystemExit(f"pack is {pack['meta']['season']}, league.json is {src['season']}")

    res = build_resolver(pack)
    errors: list[str] = []
    rosters = []
    for team in src["rosters"]:
        rosters.append({
            "name": team["name"],
            "owner": team["owner"],
            "players": resolve_roster(team, pack, res, week, errors),
        })

    check_shape(src, rosters, errors)
    check_unique(rosters, errors)

    names = {t["name"] for t in rosters}
    if src["myTeam"] not in names:
        errors.append(f"myTeam {src['myTeam']!r} is not one of the rosters")
    for a, b in src["matchups"]:
        for n in (a, b):
            if n not in names:
                errors.append(f"matchup names {n!r}, which is not one of the rosters")
    if len(rosters) != src["teams"]:
        errors.append(f"{len(rosters)} rosters for a {src['teams']}-team league")

    if errors:
        print(f"{len(errors)} problem(s); nothing written:\n", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        raise SystemExit(1)

    league = {
        "name": src["name"],
        "season": src["season"],
        "asOfWeek": week,
        "teams": src["teams"],
        "slots": src["slots"],
        "playoffWeeks": src["playoffWeeks"],
        "myTeam": src["myTeam"],
        "matchups": src["matchups"],
        "rosters": rosters,
    }
    OUT.write_text(f"window.TD_LEAGUE={json.dumps(league, separators=(',', ':'))};\n")

    total = sum(len(t["players"]) for t in rosters)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
    print(f"{len(rosters)} teams, {total} players, all resolved against the pack "
          f"and checked against the week {week} schedule")
    for t in rosters:
        starters = [p for p in t["players"] if p["slot"] != "BEN"]
        mine = " (you)" if t["name"] == src["myTeam"] else ""
        print(f"  {t['name'][:34]:<34} {t['owner'][:16]:<16} "
              f"{len(starters)} starters, {len(t['players']) - len(starters)} bench{mine}")


if __name__ == "__main__":
    main()
