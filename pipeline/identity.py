"""Player identity resolution.

nflverse keys everything on `gsis_id`. The FantasyPros ECR export does not carry any
usable cross-reference id (every id column comes through as the literal string "NA"),
so the market anchor has to be joined by name. Name joins are where fantasy data
pipelines quietly rot, so this module is deliberately strict: it normalizes hard,
requires position agreement, and reports its own match rate so a regression is visible
instead of silent.
"""

from __future__ import annotations

import re
import unicodedata

# Team abbreviation drift across sources and eras. Three families collide here:
# nflverse (2-3 char), FantasyPros ECR (mostly 3 char: SFO/GBP/KCC/NEP), and legacy
# relocations. Canonical form is the nflverse code.
TEAM_FIX = {
    # relocations / historical
    "OAK": "LV", "SD": "LAC", "SDG": "LAC", "STL": "LA", "SL": "LA", "PHO": "ARI",
    # nflverse uses LA for the Rams; many sources emit LAR
    "LAR": "LA", "RAM": "LA",
    # alternate spellings
    "ARZ": "ARI", "BLT": "BAL", "CLV": "CLE", "HST": "HOU", "JAC": "JAX",
    "WSH": "WAS", "WFT": "WAS",
    # FantasyPros three-letter forms
    "SFO": "SF", "GBP": "GB", "KCC": "KC", "NEP": "NE", "NOS": "NO",
    "TBB": "TB", "LVR": "LV", "NWE": "NE", "NOR": "NO", "TAM": "TB",
    "JAX": "JAX", "FA": "FA",
}

SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}

# Hand-maintained aliases for the cases normalization genuinely cannot bridge:
# legal-name changes and persistent source disagreements. Keyed on normalized name.
ALIASES = {
    "hollywood brown": "marquise brown",
    "gabe davis": "gabriel davis",
    "josh palmer": "joshua palmer",
    "cam ward": "cameron ward",
    "chig okonkwo": "chigoziem okonkwo",
    "demarcus robinson": "demarcus robinson",
    "mike thomas": "michael thomas",
    "ken walker": "kenneth walker",
    "kenneth walker iii": "kenneth walker",
    "tank bigsby": "thomas bigsby",
    "bucky irving": "bucky irving",
    "marvin mims": "marvin mims",
    "brian robinson": "brian robinson",
    "aj brown": "a j brown",
    "dj moore": "d j moore",
    "cd lamb": "ceedee lamb",
    "jsn": "jaxon smith njigba",
}


def norm_team(t: str | None) -> str:
    if not t or (isinstance(t, float)):
        return ""
    t = str(t).strip().upper()
    return TEAM_FIX.get(t, t)


def norm_name(name: str | None) -> str:
    """Aggressive normalization: accent-fold, drop punctuation and generational suffixes."""
    if not name or not isinstance(name, str):
        return ""
    s = unicodedata.normalize("NFKD", name)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower().replace("&", " and ")
    s = re.sub(r"[.\'’`]", "", s)       # O'Neal -> oneal, T.J. -> tj
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    parts = [p for p in s.split() if p not in SUFFIXES]
    s = " ".join(parts)
    return ALIASES.get(s, s)


def name_keys(name: str, team: str = "", pos: str = "") -> list[str]:
    """Progressively looser join keys, most specific first."""
    n = norm_name(name)
    if not n:
        return []
    t, p = norm_team(team), (pos or "").upper()
    keys = []
    if t and p:
        keys.append(f"{n}|{p}|{t}")
    if p:
        keys.append(f"{n}|{p}")
    keys.append(n)
    # Initial-plus-surname form, for sources that abbreviate ("A.Rodgers").
    parts = n.split()
    if len(parts) >= 2:
        short = f"{parts[0][0]} {parts[-1]}"
        if p:
            keys.append(f"{short}|{p}")
        keys.append(short)
    return keys


class Resolver:
    """Builds a multi-key index over a canonical player list, then resolves foreign names."""

    def __init__(self) -> None:
        self._idx: dict[str, set[str]] = {}
        self.canonical: dict[str, dict] = {}

    def add(self, pid: str, name: str, team: str = "", pos: str = "", **extra) -> None:
        self.canonical[pid] = {"id": pid, "name": name, "team": norm_team(team), "pos": pos, **extra}
        for k in name_keys(name, team, pos):
            self._idx.setdefault(k, set()).add(pid)

    def resolve(self, name: str, team: str = "", pos: str = "") -> str | None:
        """Return a gsis_id, or None. Ambiguous matches resolve to None, never a guess."""
        for k in name_keys(name, team, pos):
            hits = self._idx.get(k)
            if not hits:
                continue
            if len(hits) == 1:
                return next(iter(hits))
            # Ambiguous on this key: try to break the tie on team, then position.
            t, p = norm_team(team), (pos or "").upper()
            if t:
                by_team = [h for h in hits if self.canonical[h].get("team") == t]
                if len(by_team) == 1:
                    return by_team[0]
            if p:
                by_pos = [h for h in hits if self.canonical[h].get("pos") == p]
                if len(by_pos) == 1:
                    return by_pos[0]
        return None
