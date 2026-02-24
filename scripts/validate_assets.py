#!/usr/bin/env python3
"""
validate_assets.py
==================
Scans every JSON data file and checks that every image/audio `src` reference
either:
  - Is a valid CSS colour  (#rrggbb, #rgb, etc.)
  - Is an image path WITH an extension that actually exists under assets/images/
  - Is an audio path that actually exists under assets/Audio/

Also validates:
  - `voice` fields on `say` steps
  - `src` on `sound`, `music`, `ambience` steps

Usage (run from the project root):
    python3 scripts/validate_assets.py

Exit code 0 = all clean, 1 = problems found.
"""

import json
import sys
from collections import defaultdict
from pathlib import Path

# ── Configuration ─────────────────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
IMAGES_DIR = PROJECT_ROOT / "assets" / "images"
AUDIO_DIR = PROJECT_ROOT / "assets" / "Audio"

SKIP_FILES = {"manifest.json", "script.json"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webm", ".gif", ".bmp", ".avif"}
AUDIO_EXTS = {".ogg", ".mp3", ".wav", ".opus"}

import re

CSS_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{3,8}$")


# ── Build file indexes ────────────────────────────────────────────────────────
def build_index(base_dir: Path) -> tuple[set[str], set[str]]:
    """
    Returns (exact_paths, lower_paths) relative to base_dir.
    """
    exact: set[str] = set()
    lower: set[str] = set()
    if not base_dir.is_dir():
        return exact, lower
    for f in base_dir.rglob("*"):
        if f.is_file():
            rel = str(f.relative_to(base_dir))
            exact.add(rel)
            lower.add(rel.lower())
    return exact, lower


# ── src classification ────────────────────────────────────────────────────────
def classify_image_src(src: str, img_exact: set[str], img_lower: set[str]) -> str:
    """
    'ok' / 'missing' / 'bad'
    """
    if not src:
        return "ok"
    if CSS_COLOR_RE.match(src):
        return "ok"
    # Audio paths are checked separately
    if src.startswith("Audio/"):
        return "ok"
    ext = Path(src).suffix.lower()
    if ext not in IMAGE_EXTS:
        return "bad"
    if src in img_exact:
        return "ok"
    if src.lower() in img_lower:
        return "ok"
    return "missing"


def classify_audio_src(src: str, aud_exact: set[str], aud_lower: set[str]) -> str:
    """
    'ok' / 'missing' / 'bad'
    """
    if not src:
        return "ok"
    # Normalise: strip leading "Audio/"
    rel = src[len("Audio/") :] if src.startswith("Audio/") else src
    ext = Path(rel).suffix.lower()
    if ext not in AUDIO_EXTS:
        return "bad"
    if rel in aud_exact:
        return "ok"
    if rel.lower() in aud_lower:
        return "ok"
    return "missing"


# ── Recursive step walker ─────────────────────────────────────────────────────
def walk_steps(
    steps: list,
    filename: str,
    label: str,
    img_exact: set[str],
    img_lower: set[str],
    aud_exact: set[str],
    aud_lower: set[str],
    errors: list,
) -> None:
    """Recursively walk a step list and collect problems."""
    for idx, step in enumerate(steps):
        if not isinstance(step, dict):
            continue

        loc = f"{filename}  label={label!r}  step[{idx}]"
        t = step.get("type", "")

        # ── Image-bearing commands ────────────────────────────────────────────
        if t in ("scene", "show", "play"):
            src = step.get("src", "")
            if src:
                status = classify_image_src(src, img_exact, img_lower)
                if status != "ok":
                    errors.append(
                        {
                            "file": filename,
                            "loc": loc,
                            "type": t,
                            "field": "src (image)",
                            "value": src,
                            "status": status,
                        }
                    )

        # ── Audio-bearing commands ────────────────────────────────────────────
        if t in ("sound", "music", "ambience", "voice"):
            src = step.get("src", "")
            action = step.get("action", "")
            if src and action != "stop":
                status = classify_audio_src(src, aud_exact, aud_lower)
                if status != "ok":
                    errors.append(
                        {
                            "file": filename,
                            "loc": loc,
                            "type": t,
                            "field": "src (audio)",
                            "value": src,
                            "status": status,
                        }
                    )

        # ── Voice field on say steps ──────────────────────────────────────────
        if t == "say":
            voice = step.get("voice", "")
            if voice:
                status = classify_audio_src(voice, aud_exact, aud_lower)
                if status != "ok":
                    errors.append(
                        {
                            "file": filename,
                            "loc": loc,
                            "type": "say",
                            "field": "voice",
                            "value": voice,
                            "status": status,
                        }
                    )

        # ── Recurse into choices ──────────────────────────────────────────────
        for choice in step.get("choices", []):
            if not isinstance(choice, dict):
                continue
            nested = choice.get("steps", [])
            if isinstance(nested, list):
                lbl = choice.get("label", "?")
                walk_steps(
                    nested,
                    filename,
                    f"{label}/choice({lbl!r})",
                    img_exact,
                    img_lower,
                    aud_exact,
                    aud_lower,
                    errors,
                )

        # ── Recurse into inline steps ─────────────────────────────────────────
        nested_steps = step.get("steps")
        if isinstance(nested_steps, list):
            walk_steps(
                nested_steps,
                filename,
                f"{label}/steps[{idx}]",
                img_exact,
                img_lower,
                aud_exact,
                aud_lower,
                errors,
            )


# ── Main ──────────────────────────────────────────────────────────────────────
def main() -> int:
    print(f"Building image index from {IMAGES_DIR} …", flush=True)
    img_exact, img_lower = build_index(IMAGES_DIR)
    print(f"  {len(img_exact)} image files indexed.", flush=True)

    print(f"Building audio index from {AUDIO_DIR} …", flush=True)
    aud_exact, aud_lower = build_index(AUDIO_DIR)
    print(f"  {len(aud_exact)} audio files indexed.", flush=True)

    errors: list[dict] = []
    json_files = sorted(DATA_DIR.glob("*.json"))
    print(f"Scanning {len(json_files)} JSON files …\n", flush=True)

    for json_file in json_files:
        if json_file.name in SKIP_FILES:
            continue
        try:
            data = json.loads(json_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            errors.append(
                {
                    "file": json_file.name,
                    "loc": json_file.name,
                    "type": "—",
                    "field": "—",
                    "value": "",
                    "status": f"JSON_PARSE_ERROR: {exc}",
                }
            )
            continue

        # ── Handle both flat list and label-keyed dict formats ────────────────
        if isinstance(data, list):
            walk_steps(
                data,
                json_file.name,
                "(root)",
                img_exact,
                img_lower,
                aud_exact,
                aud_lower,
                errors,
            )
        elif isinstance(data, dict):
            labels = data.get("labels", {})
            if isinstance(labels, dict):
                for label_name, steps in labels.items():
                    if isinstance(steps, list):
                        walk_steps(
                            steps,
                            json_file.name,
                            label_name,
                            img_exact,
                            img_lower,
                            aud_exact,
                            aud_lower,
                            errors,
                        )
            else:
                # Fallback: treat top-level dict values that are lists as step lists
                steps = data.get("steps", [])
                if isinstance(steps, list):
                    walk_steps(
                        steps,
                        json_file.name,
                        "(root)",
                        img_exact,
                        img_lower,
                        aud_exact,
                        aud_lower,
                        errors,
                    )

    # ── Report ────────────────────────────────────────────────────────────────
    if not errors:
        print("✅  No broken asset references found across all data files.")
        return 0

    parse_err = [e for e in errors if e["status"].startswith("JSON_PARSE_ERROR")]
    bad_img = [
        e for e in errors if e["status"] == "bad" and e["field"] == "src (image)"
    ]
    missing_img = [
        e for e in errors if e["status"] == "missing" and e["field"] == "src (image)"
    ]
    bad_aud = [
        e for e in errors if e["status"] == "bad" and e["field"] == "src (audio)"
    ]
    missing_aud = [
        e for e in errors if e["status"] == "missing" and e["field"] == "src (audio)"
    ]
    bad_voice = [e for e in errors if e["status"] == "bad" and e["field"] == "voice"]
    missing_voice = [
        e for e in errors if e["status"] == "missing" and e["field"] == "voice"
    ]
    # Catch-all for anything not matched above
    classified = (
        parse_err
        + bad_img
        + missing_img
        + bad_aud
        + missing_aud
        + bad_voice
        + missing_voice
    )
    classified_ids = {id(e) for e in classified}
    other = [e for e in errors if id(e) not in classified_ids]

    total = len(errors)
    print(f"⚠️  Found {total} problem(s):\n")

    def print_group(title: str, group: list) -> None:
        if not group:
            return
        print(f"── {title} ({len(group)}) " + "─" * max(0, 60 - len(title)))
        seen: dict[str, list[str]] = defaultdict(list)
        for e in group:
            if isinstance(e, dict):
                seen[e["value"]].append(f"{e['file']}  [{e['type']}.{e['field']}]")
            else:
                seen[str(e)].append("?")
        for val, locs in sorted(seen.items()):
            print(f"   {val!r}")
            for loc in locs[:6]:
                print(f"      • {loc}")
            if len(locs) > 6:
                print(f"      … and {len(locs) - 6} more")
        print()

    print_group("JSON parse errors", parse_err)
    print_group(
        "BAD image src (no image extension / bare alias / Ren'Py fragment)",
        bad_img,
    )
    print_group(
        "MISSING image files (extension ok but not found on disk)",
        missing_img,
    )
    print_group("BAD audio src (no audio extension)", bad_aud)
    print_group(
        "MISSING audio files (extension ok but not found on disk)",
        missing_aud,
    )
    print_group("BAD voice path (no audio extension)", bad_voice)
    print_group(
        "MISSING voice files (extension ok but not found on disk)",
        missing_voice,
    )
    if other:
        print_group("OTHER (uncategorised)", other)

    return 1


if __name__ == "__main__":
    sys.exit(main())
