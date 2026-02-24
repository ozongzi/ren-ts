#!/usr/bin/env python3
from __future__ import annotations

"""
gen_animated_cg.py
------------------
Scans data/*.json and assets/images/Animated CGs/ to build a JSON file:

  {
    "characters": ["Hiro", "Hunter", "Natsumi", "Yoichi", "Taiga", "Other"],
    "entries": [
      {
        "name": "Apron Sex a",
        "character": "Hiro",
        "frames": [
          "Animated CGs/hiro_9a/Hiro_9a_1.webm",
          "Animated CGs/hiro_9a/Hiro_9a_2.webm",
          ...
        ]
      },
      ...
    ]
  }

Run from the repo root:
  python3 scripts/gen_animated_cg.py > src/cg_animated_sequences.json
"""

import json
import os
import re
import sys
from collections import defaultdict
from typing import Dict, List, Optional, Set, Tuple

DATA_DIR = "data"
ANIM_BASE = os.path.join("assets", "images", "Animated CGs")

# ── Character classification ──────────────────────────────────────────────────
# Maps a lowercase keyword that appears in the gallery name OR the webm folder
# name to the display character name.

CHARACTER_KEYWORDS: List[Tuple[str, str]] = [
    # (lowercase keyword, display name)
    ("hiro", "Hiro"),
    ("hunter", "Hunter"),
    ("natsumi", "Natsumi"),
    ("yoichi", "Yoichi"),
    ("taiga", "Taiga"),
    ("keitaro", "Keitaro"),
]
CHARACTER_ORDER = ["Hiro", "Hunter", "Natsumi", "Yoichi", "Taiga", "Keitaro", "Other"]


def classify_character(gallery_name: str, folder_name: str) -> str:
    """
    Determine which character a CG belongs to by checking the gallery name
    first, then the animated-CG folder name, in CHARACTER_KEYWORDS order.
    """
    combined = (gallery_name + " " + folder_name).lower()
    for keyword, display in CHARACTER_KEYWORDS:
        if keyword in combined:
            return display
    return "Other"


# ── Step 1: Scan all animated CG folders on disk ──────────────────────────────
# folder_lower → (real_folder_name, [non-idle webm files sorted by frame number])

folder_map: Dict[str, Tuple[str, List[str]]] = {}

for _folder_name in os.listdir(ANIM_BASE):
    _folder_path = os.path.join(ANIM_BASE, _folder_name)
    if not os.path.isdir(_folder_path):
        continue

    _webms = [f for f in os.listdir(_folder_path) if f.lower().endswith(".webm")]

    def _sort_key(name: str) -> Tuple[int, int]:
        m = re.search(r"_(\d+)(_idle)?\.webm$", name, re.IGNORECASE)
        if m:
            return (int(m.group(1)), 1 if m.group(2) else 0)
        return (999, 0)

    _webms_sorted = sorted(_webms, key=_sort_key)
    # Keep only the main (non-idle) files for the gallery sequence
    _main_webms = [f for f in _webms_sorted if "_idle" not in f.lower()]
    folder_map[_folder_name.lower()] = (_folder_name, _main_webms)


# ── Step 2: Walk JSON steps to extract animated sprites ───────────────────────


def collect_anim_sprites(steps: list) -> List[str]:
    """
    Recursively collect sprite names from the animations==True branch only.
    These show-steps have src=null and a sprite name like "hiro_9a_3".
    """
    sprites: List[str] = []
    for step in steps:
        t = step.get("type", "")
        if t in ("scene", "show") and step.get("src") is None:
            sp = step.get("sprite") or ""
            if sp:
                sprites.append(sp)
        elif t == "if":
            for branch in step.get("branches") or []:
                cond = (branch.get("condition") or "").lower()
                if "animations" in cond and "true" in cond:
                    sprites.extend(collect_anim_sprites(branch.get("steps") or []))
                    break  # only process the True branch
        elif t in ("menu", "choice"):
            for opt in step.get("options") or []:
                sprites.extend(collect_anim_sprites(opt.get("steps") or []))
    return sprites


# ── Step 3: Map a sprite name → webm path ────────────────────────────────────


def sprite_to_webm(sprite: str, all_sprites: Set[str]) -> Optional[str]:
    """
    Convert a sprite name like "hiro_9a_3" to a relative path like
    "Animated CGs/hiro_9a/Hiro_9a_3.webm".

    Key fix: after finding the matching folder (e.g. "hiro_11") we extract
    the frame number by STRIPPING the folder prefix from the sprite name,
    rather than running a regex on the full name (which would misparse
    "hiro_11_2" as frame 11 instead of frame 2).

    Returns None if we cannot find a matching file.
    """
    # Skip idle-variant sprites: names like "hiro_9a_3_1" where "hiro_9a_3"
    # also exists in the same label → the _1 suffix marks an idle overlay.
    if re.search(r"_\d+_\d+$", sprite):
        base = re.sub(r"_\d+$", "", sprite)
        if base in all_sprites:
            return None

    # Find the folder by trying progressively shorter underscore-split prefixes.
    # e.g. "hiro_9a_3" → try "hiro_9a" (found), then "hiro" (fallback).
    parts = sprite.split("_")
    found_folder_key: Optional[str] = None
    folder_prefix_len: int = 0  # number of underscore-joined parts used as prefix

    for n in range(len(parts) - 1, 0, -1):
        candidate = "_".join(parts[:n]).lower()
        if candidate in folder_map:
            found_folder_key = candidate
            folder_prefix_len = n
            break

    if found_folder_key is None:
        return None

    real_folder, webm_files = folder_map[found_folder_key]

    # Extract frame number: everything AFTER the folder prefix.
    # e.g. sprite="hiro_11_2", prefix="hiro_11" (2 parts) → suffix parts = ["2"] → num = "2"
    # e.g. sprite="hiro_11_14", prefix="hiro_11" (2 parts) → suffix = ["14"] → num = "14"
    # e.g. sprite="hiro_9a_3", prefix="hiro_9a" (2 parts) → suffix = ["3"] → num = "3"
    suffix_parts = parts[folder_prefix_len:]
    if not suffix_parts:
        return None
    num = suffix_parts[0]  # first part after the folder prefix is the frame number

    # Find the matching non-idle webm file by frame number.
    for wf in webm_files:
        if (
            re.search(rf"_{num}\.webm$", wf, re.IGNORECASE)
            and "_idle" not in wf.lower()
        ):
            return f"Animated CGs/{real_folder}/{wf}"

    # Fallback: any file containing that number token.
    for wf in webm_files:
        if re.search(rf"_{num}[._]", wf, re.IGNORECASE) or wf.lower().endswith(
            f"_{num}.webm"
        ):
            return f"Animated CGs/{real_folder}/{wf}"

    return None


# ── Step 4: Parse all data files ─────────────────────────────────────────────

# gallery_name → {"frames": [...], "folder": first_folder_name_seen}
gallery_data: Dict[str, Dict] = {}

for fname in sorted(os.listdir(DATA_DIR)):
    if not fname.endswith(".json"):
        continue
    with open(os.path.join(DATA_DIR, fname), encoding="utf-8") as fh:
        data = json.load(fh)

    for _label_name, steps in data.get("labels", {}).items():
        unlock_names = [s["name"] for s in steps if s.get("type") == "gallery_unlock"]
        if not unlock_names:
            continue

        sprites = collect_anim_sprites(steps)
        if not sprites:
            continue

        sprite_set: Set[str] = set(sprites)
        webm_paths: List[str] = []
        first_folder: str = ""

        for sprite in sprites:
            path = sprite_to_webm(sprite, sprite_set)
            if path and path not in webm_paths:
                webm_paths.append(path)
                if not first_folder:
                    # Extract folder name from path for character classification
                    parts_path = path.split("/")
                    if len(parts_path) >= 2:
                        first_folder = parts_path[1]  # "Animated CGs/<folder>/file"

        if not webm_paths:
            continue

        for name in unlock_names:
            if name not in gallery_data:
                gallery_data[name] = {
                    "frames": list(webm_paths),
                    "folder": first_folder,
                }
            else:
                existing = gallery_data[name]["frames"]
                for p in webm_paths:
                    if p not in existing:
                        existing.append(p)


# ── Step 5: Build output structure with character classification ──────────────

entries: List[Dict] = []
for name, info in sorted(gallery_data.items()):
    character = classify_character(name, info["folder"])
    entries.append(
        {
            "name": name,
            "character": character,
            "frames": info["frames"],
        }
    )

# Sort entries: by character order first, then by name within character
char_rank = {c: i for i, c in enumerate(CHARACTER_ORDER)}
entries.sort(key=lambda e: (char_rank.get(e["character"], 99), e["name"]))

# Collect actual characters present (in canonical order)
present_chars = []
seen_chars: Set[str] = set()
for e in entries:
    c = e["character"]
    if c not in seen_chars:
        seen_chars.add(c)
        present_chars.append(c)

result = {
    "characters": present_chars,
    "entries": entries,
}


# ── Step 6: Diagnostics to stderr, JSON to stdout ────────────────────────────

total = len(entries)
print(f"Total entries: {total}", file=sys.stderr)
for char in present_chars:
    char_entries = [e for e in entries if e["character"] == char]
    print(f"  {char:12s}: {len(char_entries):3d} entries", file=sys.stderr)

frame_counts = [len(e["frames"]) for e in entries]
if frame_counts:
    print(
        f"\nFrames per entry: min={min(frame_counts)}  max={max(frame_counts)}  "
        f"avg={sum(frame_counts) / len(frame_counts):.1f}",
        file=sys.stderr,
    )

# Warn about entries with only 1 frame (possible extraction failure)
one_frame = [e["name"] for e in entries if len(e["frames"]) == 1]
if one_frame:
    print(f"\nEntries with only 1 frame ({len(one_frame)}):", file=sys.stderr)
    for n in sorted(one_frame):
        print(f"  {n}", file=sys.stderr)

print(json.dumps(result, ensure_ascii=False, indent=2))
