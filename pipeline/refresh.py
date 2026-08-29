"""Refresh the volatile inputs and rebuild the pack.

    python3 pipeline/refresh.py

This is the answer to "does it stay current". It does not, on its own -- the app ships a
static pack with no network access at runtime, by design, so it works offline and holds no
credentials. Staying current means re-running this, which takes about a minute and re-fetches
only the things that actually move:

    injuries        practice reports and game designations, updated through the week
    ECR             the consensus board, rescraped daily
    depth charts    role changes, which is where a backup becoming a starter shows up
    rosters         signings, cuts, and in-season trades
    weekly stats    last week's box scores, once the season is running
    schedules       betting lines, which fill in a week or two ahead

Seven seasons of historical play-by-play do not change, so they are left alone; that is the
bulk of the 460MB cache and re-downloading it would turn a one-minute job into ten.

Run it Tuesday or Wednesday, after the injury reports land and before you set a lineup. Then
rebuild the artifact if you use the hosted page, or just reopen the local file.
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sources import BY_KEY, CACHE, HIST_SEASONS, TARGET_SEASON, fetch  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]

# Only what moves. Everything else in the cache is history and is left in place.
def volatile_keys() -> list[str]:
    keys = [
        "ecr",              # consensus board, daily
        "dp_values",        # trade values, daily
        "games",            # schedules and betting lines
        f"roster_{TARGET_SEASON}",
        f"depth_{TARGET_SEASON}",
    ]
    # Current-season injuries and box scores exist only once the season starts.
    for season in (TARGET_SEASON, TARGET_SEASON - 1):
        for prefix in ("injuries", "player_week", "team_week", "snaps"):
            k = f"{prefix}_{season}"
            if k in BY_KEY:
                keys.append(k)
    return [k for k in keys if k in BY_KEY]


def run(cmd: list[str], label: str) -> bool:
    print(f"\n== {label}")
    t0 = time.time()
    proc = subprocess.run(cmd, cwd=ROOT)
    ok = proc.returncode == 0
    print(f"   {'done' if ok else 'FAILED'} in {time.time() - t0:.1f}s")
    return ok


def main() -> None:
    keys = volatile_keys()
    print(f"refreshing {len(keys)} volatile sources (history is left cached)")

    refreshed, failed = [], []
    for key in keys:
        src = BY_KEY[key]
        before = src.path.stat().st_mtime if src.path.exists() else 0
        try:
            path = fetch(src, refresh=True)
        except RuntimeError as exc:
            failed.append((key, str(exc)))
            print(f"  [fail   ] {key:<22} {exc}")
            continue
        if path is None:
            # An optional source that does not exist yet -- an injuries file before week 1,
            # for instance. Not an error.
            print(f"  [absent ] {key:<22} not published yet")
            continue
        changed = path.stat().st_mtime > before
        size = path.stat().st_size / 1_048_576
        refreshed.append(key)
        print(f"  [{'updated' if changed else 'same   '}] {key:<22} {size:6.2f} MB")

    if failed:
        print(f"\n{len(failed)} source(s) failed. The pack was NOT rebuilt, so the app keeps")
        print("the data it already has rather than a half-updated set.")
        for key, err in failed:
            print(f"  {key}: {err}")
        sys.exit(1)

    print(f"\n{len(refreshed)} sources refreshed")

    if not run([sys.executable, "pipeline/build_pack.py"], "rebuilding the data pack"):
        sys.exit(1)
    # The rosters themselves are transcribed by hand, but they are re-resolved against the
    # rebuilt pack every time: a player who changed NFL teams over the week fails the
    # schedule check here rather than being priced against the wrong offense all season.
    if not run([sys.executable, "pipeline/build_league.py"], "re-resolving the league rosters"):
        sys.exit(1)

    node = ROOT / "scripts" / "bundle.mjs"
    if node.exists():
        run(["node", "scripts/bundle.mjs"], "rebuilding dist/tradedesk.html")

    print("\nDone. Open dist/tradedesk.html, or republish it if you use the hosted page.")
    print("Note what this does NOT do: it cannot know about news that has not reached a")
    print("published injury report or the consensus board yet. For anything breaking, use")
    print("the status override on a player row -- it re-runs every projection immediately")
    print("and needs no network at all.")


if __name__ == "__main__":
    main()
