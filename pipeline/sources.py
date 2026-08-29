"""Source registry + cached downloader for every dataset Trade Desk uses.

Every URL here was probed for reachability from the build environment before being
committed. Two things are deliberately NOT used, and the reasons are recorded so nobody
re-tries them and wastes an afternoon:

  * api.sleeper.app        - blocked by the egress proxy (CONNECT tunnel 403)
  * github.com/<o>/<r>/raw - 403; use raw.githubusercontent.com or a release asset instead

nflverse release assets under github.com/nflverse/nflverse-data/releases/download DO work.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".cache"

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"
RAW_GH = "https://raw.githubusercontent.com"

# Seasons of history used to fit the model. 2019+ keeps us inside the modern
# high-volume passing era while still giving enough sample for share stability.
HIST_SEASONS = [2019, 2020, 2021, 2022, 2023, 2024, 2025]

# Seasons whose full weekly component lines get shipped in the pack so the app can
# show real production under the user's own scoring. Kept short for pack size.
LOG_SEASONS = [2024, 2025]

TARGET_SEASON = 2026


@dataclass(frozen=True)
class Source:
    key: str
    url: str
    required: bool = True

    @property
    def path(self) -> Path:
        return CACHE / f"{self.key}.csv"


def _sources() -> list[Source]:
    s: list[Source] = []
    for yr in HIST_SEASONS:
        s.append(Source(f"player_week_{yr}", f"{NFLVERSE}/stats_player/stats_player_week_{yr}.csv"))
        s.append(Source(f"team_week_{yr}", f"{NFLVERSE}/stats_team/stats_team_week_{yr}.csv"))
        s.append(Source(f"snaps_{yr}", f"{NFLVERSE}/snap_counts/snap_counts_{yr}.csv", required=False))
        s.append(Source(f"injuries_{yr}", f"{NFLVERSE}/injuries/injuries_{yr}.csv", required=False))
    # Current-season inputs. These are what make offseason trades and signings
    # propagate into the projections at all.
    s.append(Source(f"roster_{TARGET_SEASON}", f"{NFLVERSE}/weekly_rosters/roster_weekly_{TARGET_SEASON}.csv"))
    s.append(Source(f"roster_{TARGET_SEASON - 1}", f"{NFLVERSE}/weekly_rosters/roster_weekly_{TARGET_SEASON - 1}.csv"))
    s.append(Source(f"depth_{TARGET_SEASON}", f"{NFLVERSE}/depth_charts/depth_charts_{TARGET_SEASON}.csv", required=False))
    # Schedules carry the 2026 betting lines, which set the scoring environment.
    s.append(Source("games", f"{RAW_GH}/nflverse/nfldata/master/data/games.csv"))
    # Expert consensus ranks: the market anchor, plus rank dispersion as an
    # independent read on uncertainty.
    s.append(Source("ecr", f"{RAW_GH}/dynastyprocess/data/master/files/db_fpecr_latest.csv", required=False))
    s.append(Source("dp_values", f"{RAW_GH}/dynastyprocess/data/master/files/values-players.csv", required=False))
    return s


SOURCES = _sources()
BY_KEY = {s.key: s for s in SOURCES}


def fetch(src: Source, *, refresh: bool = False, retries: int = 4) -> Path | None:
    """Download one source to the cache. Returns None if an optional source is unavailable."""
    if src.path.exists() and not refresh and src.path.stat().st_size > 0:
        return src.path

    CACHE.mkdir(parents=True, exist_ok=True)
    tmp = src.path.with_suffix(".part")

    delay = 2.0
    for attempt in range(1, retries + 1):
        proc = subprocess.run(
            ["curl", "-sS", "-L", "--fail", "--max-time", "180", src.url, "-o", str(tmp)],
            capture_output=True,
            text=True,
        )
        if proc.returncode == 0 and tmp.exists() and tmp.stat().st_size > 0:
            tmp.replace(src.path)
            return src.path
        if attempt < retries:
            time.sleep(delay)
            delay *= 2

    tmp.unlink(missing_ok=True)
    if src.required:
        raise RuntimeError(f"required source unavailable: {src.key} <- {src.url}")
    print(f"  [skip] optional source unavailable: {src.key}", file=sys.stderr)
    return None


def fetch_all(*, refresh: bool = False) -> dict[str, Path]:
    """Fetch everything, returning key -> local path for what was obtained."""
    out: dict[str, Path] = {}
    for src in SOURCES:
        before = src.path.exists()
        p = fetch(src, refresh=refresh)
        if p is not None:
            out[src.key] = p
            size = p.stat().st_size
            tag = "cached" if before and not refresh else "fetched"
            print(f"  [{tag:>7}] {src.key:<24} {size / 1_048_576:7.2f} MB")
    return out


def manifest(paths: dict[str, Path]) -> list[dict]:
    """Provenance record embedded in the pack so the app can show data age and origin."""
    rows = []
    for key, path in sorted(paths.items()):
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        rows.append(
            {
                "key": key,
                "url": BY_KEY[key].url,
                "bytes": path.stat().st_size,
                "sha256": h.hexdigest()[:16],
                "mtime": int(path.stat().st_mtime),
            }
        )
    return rows


if __name__ == "__main__":
    refresh = "--refresh" in sys.argv
    print(f"Fetching {len(SOURCES)} sources into {CACHE}")
    got = fetch_all(refresh=refresh)
    total = sum(p.stat().st_size for p in got.values())
    print(f"\n{len(got)}/{len(SOURCES)} sources available, {total / 1_048_576:.1f} MB cached")
