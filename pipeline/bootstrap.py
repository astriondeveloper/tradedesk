"""Fetch the large, frozen inputs that `sources.py` deliberately leaves out.

    python3 pipeline/bootstrap.py            # fetch whatever is missing
    python3 pipeline/bootstrap.py --check    # report what is missing, fetch nothing

`sources.py` registers the datasets that move: rosters, injuries, box scores, the
consensus board, the betting lines. `refresh.py` re-pulls those every run. Two inputs are
not in that registry, because they are large and effectively frozen, and re-downloading
them on every refresh would turn a one-minute job into a ten-minute one:

    pbp_{2023,2024,2025}.csv    ~300MB decompressed. Fits the P(TD | yard line) curves
                                and the kicker distance profile, and supplies red-zone
                                opportunity per player.
    ecr_history.parquet         ~39MB. Every consensus board back to 2019, which is what
                                the market-blend weight was fitted against.

On a machine that already has them this script is a no-op. On a clean checkout -- a CI
runner, a new laptop -- it is a hard prerequisite, and that is the point of it existing
separately. Both files degrade *silently*: `redzone.load_pbp` and `blend.load_history`
return empty frames when the file is absent, so a build without them succeeds and quietly
ships worse projections. A pipeline that fails loudly is fine; one that succeeds with the
red-zone model switched off is not, so the workflow runs this first and refuses to build
if it cannot get them.
"""

from __future__ import annotations

import argparse
import gzip
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from redzone import PBP_SEASONS  # noqa: E402
from sources import CACHE, fetch_all  # noqa: E402

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download"
RAW_GH = "https://raw.githubusercontent.com"

# key -> (url, gzipped?). Kept here rather than in sources.py so the refresh loop, which
# walks the registry, never picks these up.
FROZEN: dict[str, tuple[str, bool]] = {
    **{
        f"pbp_{yr}": (f"{NFLVERSE}/pbp/play_by_play_{yr}.csv.gz", True)
        for yr in PBP_SEASONS
    },
    "ecr_history": (f"{RAW_GH}/dynastyprocess/data/master/files/db_fpecr.parquet", False),
}


def path_for(key: str) -> Path:
    return CACHE / (f"{key}.parquet" if key.endswith("_history") else f"{key}.csv")


def download(url: str, dest: Path, *, gzipped: bool, retries: int = 4) -> None:
    """Download to `dest`, decompressing on the way if needed. Atomic: a failed attempt
    never leaves a truncated file where a later run would treat it as cached."""
    CACHE.mkdir(parents=True, exist_ok=True)
    raw = dest.with_suffix(dest.suffix + ".part")

    delay = 2.0
    for attempt in range(1, retries + 1):
        proc = subprocess.run(
            ["curl", "-sS", "-L", "--fail", "--max-time", "600", url, "-o", str(raw)],
            capture_output=True,
            text=True,
        )
        if proc.returncode == 0 and raw.exists() and raw.stat().st_size > 0:
            break
        if attempt == retries:
            raw.unlink(missing_ok=True)
            raise RuntimeError(f"could not fetch {url}: {proc.stderr.strip() or 'empty response'}")
        time.sleep(delay)
        delay *= 2

    if gzipped:
        tmp = dest.with_suffix(dest.suffix + ".tmp")
        with gzip.open(raw, "rb") as fin, open(tmp, "wb") as fout:
            shutil.copyfileobj(fin, fout, length=1 << 20)
        raw.unlink(missing_ok=True)
        tmp.replace(dest)
    else:
        raw.replace(dest)


def missing() -> list[str]:
    return [k for k in FROZEN if not (path_for(k).exists() and path_for(k).stat().st_size > 0)]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="report what is missing and exit")
    args = ap.parse_args()

    gaps = missing()

    if args.check:
        if gaps:
            print(f"{len(gaps)} frozen input(s) missing: {', '.join(sorted(gaps))}")
            sys.exit(1)
        print("all frozen inputs present")
        return

    print(f"frozen inputs: {len(FROZEN) - len(gaps)}/{len(FROZEN)} already cached")
    for key in sorted(gaps):
        url, gz = FROZEN[key]
        dest = path_for(key)
        print(f"  [fetching] {key:<16} {url}")
        download(url, dest, gzipped=gz)
        print(f"  [done    ] {key:<16} {dest.stat().st_size / 1_048_576:7.2f} MB")

    print("\nregistry sources (already-cached ones are left alone):")
    fetch_all(refresh=False)

    still = missing()
    if still:
        # Unreachable unless a download reported success and wrote nothing.
        print(f"\nstill missing after fetching: {', '.join(sorted(still))}", file=sys.stderr)
        sys.exit(1)
    print("\nReady. `python3 pipeline/build_pack.py` will now build with the full model.")


if __name__ == "__main__":
    main()
