#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
convert_aftersx.py
==================
Convert specific "aftersx" label blocks from Ren'Py (.rpy) source files
(with Chinese translations from tl/chinese/) into the JSON format used
by the cb_refactored VN engine.

Usage (run from project root):
    python3 scripts/convert_aftersx.py

Outputs one JSON file per label into data/ (replacing the existing stubs).
"""

import json
import os
import re
import sys
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
GAME_DIR = Path("/Applications/CB2_3_chn/game")
TL_DIR = GAME_DIR / "tl" / "chinese"
ASSETS_IMG = PROJECT_ROOT / "assets" / "images"

# ---------------------------------------------------------------------------
# Character variable → display name
# ---------------------------------------------------------------------------
CHAR_MAP = {
    "k": "Keitaro",
    "hi": "Hiro",
    "hu": "Hunter",
    "n": "Natsumi",
    "yi": "Yoichi",
    "t": "Taiga",
    "s": "Seto",
    "f": "Felix",
    "e": "Eduard",
    "l": "Lee",
    "a": "Aiden",
    "g": "Goro",
    "yo": "Yoshinori",
    "yu": "Yuri",
    "khi": "Keitaro & Hiro",
    "khu": "Keitaro & Hunter",
    "kna": "Keitaro & Natsumi",
    "kyo": "Keitaro & Yoichi",
    "kta": "Keitaro & Taiga",
    "mys": "???",
    "mys_seto": "???",
    "mys_felix": "???",
    "mys_taiga": "???",
    "mys_hiro": "???",
    "mys_k": "???",
    "mys_yoichi": "???",
    "mys_hunter": "???",
    "mys_yoshi": "???",
    "mys_aiden": "???",
    "mys_goro": "???",
    "emp": "empty",
    "con": "Conductor",
    "ol": "Old Lady",
}


# ---------------------------------------------------------------------------
# Build audio path lookup from script.rpy
# ---------------------------------------------------------------------------
def build_audio_lookup() -> dict:
    script_rpy = GAME_DIR / "script.rpy"
    lookup = {}
    pat = re.compile(r"""define\s+audio\.(\w+)\s*=\s*["']([^"']+)["']""")
    for line in script_rpy.read_text(encoding="utf-8", errors="replace").splitlines():
        m = pat.search(line)
        if m:
            lookup[m.group(1)] = m.group(2)
    return lookup


# ---------------------------------------------------------------------------
# Build image name lookup from script.rpy  (image xxx = "path")
# ---------------------------------------------------------------------------
def build_image_lookup() -> dict:
    """
    Parse  image <tag> <name...> = "path"  lines from script.rpy.
    Returns dict  image_sprite_key → relative_path
    e.g.  "cg hiro10" → "CGs/hiro/cg_hiro_10_1.jpg"
    """
    script_rpy = GAME_DIR / "script.rpy"
    lookup = {}
    # Match:  image <name_parts> = "path"
    pat = re.compile(r"""^\s*image\s+([^=]+?)\s*=\s*["']([^"']+)["']""")
    for line in script_rpy.read_text(encoding="utf-8", errors="replace").splitlines():
        m = pat.match(line)
        if m:
            key = m.group(1).strip()
            path = m.group(2).strip()
            # Strip leading "images/" if present (Ren'Py sometimes includes it)
            if path.startswith("images/"):
                path = path[len("images/") :]
            lookup[key] = path
    return lookup


# ---------------------------------------------------------------------------
# Build sprite body/face lookup from assets directory
# ---------------------------------------------------------------------------
def build_sprite_lookup() -> dict:
    """
    Returns a dict mapping sprite-name (as used in .rpy show commands)
    → relative asset path (relative to assets/images/).

    Body sprites: {char}{variant}_b_{outfit...}.png  → show {char}{variant?}_{outfit...}
    Face sprites: {char}{variant}_f_{expr...}.png    → show {char}{variant?} {expr...}
    CG images:    cg_{char}_{n}.jpg                  → show cg {char}{n}
    """
    lookup = {}

    body_dir = ASSETS_IMG / "Sprites" / "Body"
    face_dir = ASSETS_IMG / "Sprites" / "Faces"
    extra_dir = ASSETS_IMG / "Sprites" / "Extras"

    # Body sprites
    if body_dir.exists():
        for f in body_dir.iterdir():
            if not f.is_file():
                continue
            name = f.stem  # e.g. hunter1_b_sleep
            # Expected: {char}{variant}_b_{outfit}
            m = re.match(r"^([a-z_]+?)(\d*)_b_(.+)$", name)
            if m:
                char, variant, outfit = m.group(1), m.group(2), m.group(3)
                v = variant if variant else "1"
                # Key with explicit variant: "hunter2_sleep"
                key_explicit = f"{char}{v}_{outfit}"
                # Key without variant number (defaults to 1): "hunter_sleep"
                key_no_v = f"{char}_{outfit}" if v == "1" else None
                path = f"Sprites/Body/{f.name}"
                lookup[key_explicit] = path
                if key_no_v:
                    lookup.setdefault(key_no_v, path)

    # Face sprites
    if face_dir.exists():
        for f in face_dir.iterdir():
            if not f.is_file():
                continue
            name = f.stem  # e.g. hunter1_f_worry1
            m = re.match(r"^([a-z_]+?)(\d*)_f_(.+)$", name)
            if m:
                char, variant, expr = m.group(1), m.group(2), m.group(3)
                v = variant if variant else "1"
                # Face sprite key uses a SPACE: "hunter2 worry1"
                key_explicit = f"{char}{v} {expr}"
                key_no_v = f"{char} {expr}" if v == "1" else None
                path = f"Sprites/Faces/{f.name}"
                lookup[key_explicit] = path
                if key_no_v:
                    lookup.setdefault(key_no_v, path)

    # Extras sprites
    if extra_dir.exists():
        for f in extra_dir.iterdir():
            if not f.is_file():
                continue
            name = f.stem
            lookup.setdefault(name, f"Sprites/Extras/{f.name}")

    return lookup


def build_cg_lookup() -> dict:
    """Build CG lookup: sprite key → relative path."""
    lookup = {}
    cg_dir = ASSETS_IMG / "CGs"
    if cg_dir.exists():
        for f in cg_dir.rglob("*"):
            if f.is_file() and f.suffix.lower() in (".jpg", ".png", ".webp"):
                rel = f.relative_to(ASSETS_IMG)
                stem = f.stem.lower()
                lookup[stem] = str(rel)
                # Also store without directory prefix e.g. "sx_hunter_10_1"
                lookup.setdefault(f.stem, str(rel))
    return lookup


def build_bg_lookup() -> dict:
    """Build background lookup: bg name → relative path."""
    lookup = {}
    bg_dir = ASSETS_IMG / "BGs"
    if bg_dir.exists():
        for f in bg_dir.iterdir():
            if f.is_file():
                stem = f.stem.lower()
                rel = f"BGs/{f.name}"
                lookup[stem] = rel
    return lookup


# ---------------------------------------------------------------------------
# Parse Chinese translation file → dict: line_number → (chn_text, chn_voice)
# ---------------------------------------------------------------------------
def parse_translations(tl_file: Path, label_name: str) -> dict:
    """
    Returns {orig_line_number: (chinese_text_or_None, voice_or_None)}
    for all translate blocks belonging to label_name.
    """
    if not tl_file.exists():
        return {}

    result = {}
    text = tl_file.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()

    # Pattern: # game/xxx.rpy:<lineno>
    lineno_pat = re.compile(r"#\s*game/[^:]+:(\d+)")
    # Pattern: translate chinese {label}_<hash>:
    block_pat = re.compile(
        r"translate\s+chinese\s+" + re.escape(label_name) + r"_[0-9a-f]+(?:_\d+)?:"
    )
    # Pattern: <charvar> "text"  or  "text" (narrator)
    say_pat = re.compile(r"""^\s+(?P<who>[a-z_]+\s*)?"(?P<text>[^"]*)"$""")
    voice_pat = re.compile(r"^\s+voice\s+audio\.(\w+)")

    i = 0
    while i < len(lines):
        line = lines[i]
        # Find a translate block for our label
        if block_pat.search(line):
            # Scan backwards to find the line number comment
            orig_line = None
            for j in range(max(0, i - 5), i):
                m = lineno_pat.search(lines[j])
                if m:
                    orig_line = int(m.group(1))
                    break

            # Scan forward in the block body (until the block ends)
            chinese_text = None
            voice_key = None
            has_voice_line = False
            i += 1
            while i < len(lines):
                bl = lines[i]
                # End of block: empty line followed by a non-indented (or comment) line
                # which signals the next block header or file-level comment.
                if bl.strip() == "":
                    # Peek ahead: if next non-empty line is unindented → end of block
                    j = i + 1
                    while j < len(lines) and lines[j].strip() == "":
                        j += 1
                    if j >= len(lines):
                        break
                    next_line = lines[j]
                    if not next_line.startswith(" ") and not next_line.startswith("\t"):
                        break
                # Voice line in translation (non-comment)
                if not bl.strip().startswith("#"):
                    vm = voice_pat.match(bl)
                    if vm:
                        voice_key = vm.group(1)
                        has_voice_line = True
                # Chinese dialogue/narration (non-comment)
                sm = say_pat.match(bl)
                if sm and not bl.strip().startswith("#"):
                    chinese_text = sm.group("text")
                i += 1

            if orig_line is not None and chinese_text is not None:
                # When the block starts with a voice line, Ren'Py records the
                # line number of the *voice* statement in the comment.  The
                # actual say statement is one line later.  Store under both so
                # either lineno or lineno+1 will hit.
                result[orig_line] = (chinese_text, voice_key)
                if has_voice_line:
                    result[orig_line + 1] = (chinese_text, voice_key)
            continue
        i += 1

    return result


# ---------------------------------------------------------------------------
# Parse a label block from a .rpy file
# Returns a list of raw tokens (dicts with type, raw_data)
# ---------------------------------------------------------------------------


def _unquote(s: str) -> str:
    """Remove surrounding quotes from a string."""
    s = s.strip()
    if (s.startswith('"') and s.endswith('"')) or (
        s.startswith("'") and s.endswith("'")
    ):
        return s[1:-1]
    return s


def _get_indent(line: str) -> int:
    return len(line) - len(line.lstrip())


def parse_rpy_label(rpy_file: Path, target_label: str) -> list:
    """
    Extract lines belonging to `target_label` from `rpy_file`.
    Returns list of (lineno, stripped_line) tuples.
    The label may be at any indent level.
    """
    lines = rpy_file.read_text(encoding="utf-8", errors="replace").splitlines()
    result = []

    # Find the label line
    label_pat = re.compile(
        r"^\s+label\s+" + re.escape(target_label) + r"\s*:\s*$|"
        r"^label\s+" + re.escape(target_label) + r"\s*:\s*$"
    )
    start_idx = None
    label_indent = 0

    for idx, line in enumerate(lines):
        if label_pat.match(line):
            start_idx = idx + 1
            label_indent = _get_indent(line)
            break

    if start_idx is None:
        print(
            f"  [WARN] label '{target_label}' not found in {rpy_file.name}",
            file=sys.stderr,
        )
        return []

    body_indent = None
    for idx in range(start_idx, len(lines)):
        line = lines[idx]
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            result.append((idx + 1, ""))
            continue
        indent = _get_indent(line)
        # First non-empty line sets body indent
        if body_indent is None:
            body_indent = indent
        # If we outdent to label level or above → end of block
        if indent <= label_indent and stripped:
            break
        result.append((idx + 1, line))

    return result


# ---------------------------------------------------------------------------
# Convert raw .rpy lines → JSON steps
# ---------------------------------------------------------------------------


def convert_label(
    rpy_file: Path,
    label_name: str,
    tl_file: Optional[Path],
    audio_map: dict,
    sprite_map: dict,
    cg_map: dict,
    bg_map: dict,
    image_map: Optional[dict] = None,
) -> list:
    """
    Convert a single label block into a list of JSON step dicts.
    """
    raw_lines = parse_rpy_label(rpy_file, label_name)
    if not raw_lines:
        return []

    translations = {}
    if tl_file:
        translations = parse_translations(tl_file, label_name)

    # ------------------------------------------------------------------
    # Sprite path resolution helpers
    # ------------------------------------------------------------------
    _image_map = image_map or {}

    def resolve_sprite_src(sprite_key: str) -> Optional[str]:
        """Try to resolve a sprite name to an image path."""
        # 1. Direct sprite_map lookup (Body/Face sprites)
        if sprite_key in sprite_map:
            return sprite_map[sprite_key]
        # 2. Named image lookup from script.rpy  (image cg hiro10 = "...")
        if sprite_key in _image_map:
            return _image_map[sprite_key]
        # 3. CG file-system lookup
        key_lower = sprite_key.replace(" ", "_").lower()
        if key_lower in cg_map:
            return cg_map[key_lower]
        # 4. Try removing leading "cg " prefix
        if sprite_key.startswith("cg "):
            cg_key = sprite_key[3:].replace(" ", "_").lower()
            if cg_key in cg_map:
                return cg_map[cg_key]
            # Also try with underscores replaced by hyphens etc.
            alt = sprite_key[3:].replace(" ", "_")
            if (
                alt in _image_map.get("cg " + sprite_key[3:], {})
                or ("cg " + alt) in _image_map
            ):
                return _image_map.get("cg " + alt)
        return None

    def resolve_bg_src(bg_name: str) -> str:
        """Convert bg_name (e.g. bg_cabin_day) to image path."""
        # Special colour constants
        if bg_name in ("#000000", "cg black", "black"):
            return "#000000"
        if bg_name in ("#ffffff", "cg white", "white"):
            return "#ffffff"

        # 1. Check image_map directly (handles bg_xxx = "BGs/..." and cg xxx = "CGs/...")
        if bg_name in _image_map:
            return _image_map[bg_name]

        # 2. Strip "with ..." suffix that sometimes leaks in (e.g. "cg white with Dissolve(5.0)")
        #    Already handled in the scene parser, but guard here too.
        clean = re.split(r"\s+with\s+", bg_name)[0].strip()
        if clean != bg_name:
            return resolve_bg_src(clean)

        # 3. Strip leading "bg_" prefix and look up bg_map (keyed by stem.lower())
        stem = clean
        if stem.startswith("bg_"):
            stem = stem[3:]
            # Also check image_map with the full bg_ name
            if clean in _image_map:
                return _image_map[clean]
        if stem.lower() in bg_map:
            return bg_map[stem.lower()]

        # 4. CG images (scene cg yoichi5_1 etc.) – look up image_map
        if clean.startswith("cg "):
            cg_key = clean  # "cg yoichi5_1"
            if cg_key in _image_map:
                return _image_map[cg_key]

        # 5. Last resort
        return f"BGs/{stem}.jpg"

    def resolve_audio(key: str) -> Optional[str]:
        if key in audio_map:
            return audio_map[key]
        # Try voices/
        ogg = PROJECT_ROOT / "assets" / "Audio" / "Voice" / "voices" / f"{key}.ogg"
        if ogg.exists():
            return f"Audio/Voice/voices/{key}.ogg"
        return None

    def resolve_music(name: str) -> Optional[str]:
        """Resolve a music name to an Audio path."""
        if name in audio_map:
            return audio_map[name]
        # Try BGM folder
        bgm_dir = PROJECT_ROOT / "assets" / "Audio" / "BGM"
        if bgm_dir.exists():
            for f in bgm_dir.iterdir():
                if f.stem.lower() == name.lower():
                    return f"Audio/BGM/{f.name}"
        return f"Audio/BGM/{name}.ogg"

    # ------------------------------------------------------------------
    # Main parse loop
    # ------------------------------------------------------------------
    # We process lines with indentation to handle if/else and menu
    all_lines = raw_lines  # list of (lineno, raw_line)

    # Pre-pass: collect all lines with their (lineno, indent, stripped)
    tokens = []
    for lineno, raw in all_lines:
        stripped = raw.strip()
        if not stripped:
            continue
        indent = _get_indent(raw)
        tokens.append((lineno, indent, stripped))

    def do_convert(token_list: list) -> list:
        """Convert a flat list of (lineno, indent, stripped) to JSON steps."""
        steps = []
        i = 0
        pending_voice = None  # voice line waiting for the next say line

        while i < len(token_list):
            lineno, indent, line = token_list[i]

            # ---- voice (always precedes a say line) ----
            m = re.match(r"^voice\s+audio\.(\w+)", line)
            if m:
                pending_voice = m.group(1)
                i += 1
                continue

            # ---- character dialogue ----
            # Patterns: k "text"  |  hu "text"  |  "text" (narrator)
            # Must not be a keyword
            char_say_pat = re.compile(
                r"^(?P<who>"
                + "|".join(re.escape(c) for c in CHAR_MAP)
                + r')\s+"(?P<text>.*)"$'
            )
            narrate_pat = re.compile(r'^"(?P<text>.*)"$')

            cm = char_say_pat.match(line)
            nm = narrate_pat.match(line) if not cm else None

            if cm or nm:
                if cm:
                    who_var = cm.group("who").strip()
                    eng_text = cm.group("text")
                    who_name = CHAR_MAP.get(who_var, who_var)
                else:
                    who_var = None
                    eng_text = nm.group("text")
                    who_name = None

                # Look up Chinese translation.
                # Ren'Py tl comments point to the voice line (lineno-1) when a
                # voice precedes the say, so check both lineno and lineno-1.
                chn_text = None
                chn_voice = None
                for lookup_ln in (lineno, lineno - 1, lineno + 1):
                    if lookup_ln in translations:
                        chn_text, chn_voice = translations[lookup_ln]
                        break

                text = chn_text if chn_text else eng_text

                # Resolve voice
                voice_key = chn_voice or pending_voice
                voice_path = resolve_audio(voice_key) if voice_key else None
                pending_voice = None

                if who_name and who_name != "empty":
                    step = {"type": "say", "who": who_name, "text": text}
                    if voice_path:
                        step["voice"] = voice_path
                else:
                    step = {"type": "narrate", "text": text}
                    if voice_path:
                        step["voice"] = voice_path
                steps.append(step)
                i += 1
                continue

            # ---- scene ----
            # Handles: scene bg_xxx [with transition]
            #          scene cg xxx [with transition]
            #          scene cg black / cg white
            #          scene xxx with Dissolve(0.25)  (parameterised transition)
            m = re.match(r"^scene\s+(.+?)(?:\s+with\s+(\w+(?:\([^)]*\))?))?$", line)
            if m:
                scene_arg = m.group(1).strip()
                raw_trans = m.group(2)
                transition = raw_trans.split("(")[0].lower() if raw_trans else None
                src = resolve_bg_src(scene_arg)
                step = {"type": "scene", "src": src}
                if transition:
                    step["transition"] = transition
                steps.append(step)
                pending_voice = None
                i += 1
                continue

            # ---- show ----
            # Handle:  show <sprite> [at <pos>] [with <transition>]
            # Also handles ATL blocks:  show <sprite>:  (colon = ATL body follows)
            # and parameterized transitions: with Dissolve(0.25)
            if line.startswith("show ") and not line.startswith("show screen"):
                # Strip trailing ATL colon if present
                show_line = line.rstrip()
                is_atl = show_line.endswith(":")
                if is_atl:
                    show_line = show_line[:-1].rstrip()
                    # Skip the ATL body lines (they are indented further)
                    i += 1
                    if i < len(token_list):
                        atl_indent = token_list[i][1]
                        while i < len(token_list) and token_list[i][1] >= atl_indent:
                            i += 1
                    # Don't emit a step for pure ATL-only shows (no sprite info we can use)
                    # But do emit if we can parse the sprite name
                    # Fall through to parse show_line (without colon)

                # Parse:  show <sprite_parts> [at <pos>] [with <transition(...)>]
                # Transition may be:  dissolve | fade | move | Dissolve(0.25) | ...
                m = re.match(
                    r"^show\s+(.+?)(?:\s+at\s+(\S+))?(?:\s+with\s+(\w+(?:\([^)]*\))?))?$",
                    show_line,
                )
                if m:
                    sprite_key = m.group(1).strip()
                    at_pos = m.group(2)
                    raw_transition = m.group(3)
                    # Normalise transition: Dissolve(0.25) → dissolve
                    transition = None
                    if raw_transition:
                        transition = raw_transition.split("(")[0].lower()
                    src = resolve_sprite_src(sprite_key)
                    step: dict = {"type": "show", "sprite": sprite_key}
                    if src is not None:
                        step["src"] = src
                    if at_pos:
                        step["at"] = at_pos
                    if transition:
                        step["transition"] = transition
                    steps.append(step)
                if not is_atl:
                    i += 1
                continue

            # ---- hide ----
            m = re.match(r"^hide\s+(.+?)(?:\s+with\s+(\w+))?$", line)
            if m and not line.startswith("hide screen"):
                sprite_key = m.group(1).strip()
                transition = m.group(2)
                step = {"type": "hide", "sprite": sprite_key}
                if transition:
                    step["transition"] = transition
                steps.append(step)
                i += 1
                continue

            # ---- with (standalone transition) ----
            m = re.match(r"^with\s+(\w+)$", line)
            if m:
                steps.append({"type": "with", "transition": m.group(1)})
                i += 1
                continue

            # ---- play music / bgsound / sound ----
            m = re.match(r"^play\s+(?:music|bgsound|sound)\s+(\S+)\s*(loop)?", line)
            if m:
                audio_name = m.group(1)
                src = resolve_music(audio_name)
                step = {"type": "music", "action": "play", "src": src}
                steps.append(step)
                i += 1
                continue

            # ---- stop music / bgsound ----
            m = re.match(
                r"^\$?\s*renpy\.music\.stop\s*\(.*?fadeout\s*=\s*([\d.]+)", line
            )
            m2 = re.match(
                r"^stop\s+(?:music|bgsound|sound)(?:\s+fadeout\s+([\d.]+))?", line
            )
            if m or m2:
                fadeout = float((m or m2).group(1)) if (m or m2).group(1) else 2.0
                steps.append({"type": "music", "action": "stop", "fadeout": fadeout})
                i += 1
                continue

            # ---- pause ----
            m = re.match(r"^\$?\s*renpy\.pause\s*\(([\d.]+)", line)
            m2 = re.match(r"^pause\s+([\d.]+)", line)
            if m or m2:
                dur = float((m or m2).group(1))
                steps.append({"type": "pause", "duration": dur})
                i += 1
                continue

            # ---- $ variable assignment ----
            m = re.match(r"^\$\s*(\w+)\s*([\+\-\*\/]?=)\s*(.+)$", line)
            if m:
                var = m.group(1)
                op = m.group(2)
                val = m.group(3).strip()
                # Skip renpy. function calls and location/screen vars
                skip_vars = {
                    "location",
                    "renpy",
                    "ui",
                    "store",
                }
                if not any(var.startswith(s) for s in skip_vars) and not val.startswith(
                    "renpy."
                ):
                    # Try to convert value
                    try:
                        parsed_val = int(val)
                    except ValueError:
                        try:
                            parsed_val = float(val)
                        except ValueError:
                            parsed_val = val
                    steps.append(
                        {
                            "type": "set",
                            "var": var,
                            "op": op,
                            "value": parsed_val,
                        }
                    )
                i += 1
                continue

            # ---- jump ----
            m = re.match(r"^jump\s+(\S+)$", line)
            if m:
                steps.append({"type": "jump", "target": m.group(1)})
                i += 1
                continue

            # ---- call ----
            m = re.match(r"^call\s+(\S+)", line)
            if m:
                steps.append({"type": "call", "target": m.group(1)})
                i += 1
                continue

            # ---- return ----
            if line == "return":
                steps.append({"type": "return"})
                i += 1
                continue

            # ---- if / elif / else ----
            m_if = re.match(r"^(if|elif|else)\b(.*?):?\s*$", line)
            if m_if:
                keyword = m_if.group(1)
                condition = m_if.group(2).strip().rstrip(":")

                # Collect the body of this branch (increased indent)
                body_tokens = []
                j = i + 1
                if j < len(token_list):
                    branch_indent = token_list[j][1]
                    while j < len(token_list) and token_list[j][1] >= branch_indent:
                        # stop at elif/else at same indent as the if
                        bl = token_list[j][2]
                        if token_list[j][1] == indent and re.match(
                            r"^(elif|else)\b", bl
                        ):
                            break
                        body_tokens.append(token_list[j])
                        j += 1

                branch_steps = do_convert(body_tokens)

                if keyword == "if":
                    # Start a new if node
                    if_node = {
                        "type": "if",
                        "branches": [{"condition": condition, "steps": branch_steps}],
                    }
                    steps.append(if_node)
                elif keyword in ("elif", "else"):
                    # Attach to last if node
                    cond = condition if keyword == "elif" else "else"
                    if steps and steps[-1].get("type") == "if":
                        steps[-1]["branches"].append(
                            {"condition": cond, "steps": branch_steps}
                        )
                i = j
                continue

            # ---- menu ----
            if line == "menu:":
                options = []
                j = i + 1
                # Each menu choice is indented one level
                # Find indent of first choice
                if j < len(token_list):
                    choice_indent = token_list[j][1]
                    while j < len(token_list) and token_list[j][1] >= choice_indent:
                        cl, ci, cs = token_list[j]
                        if ci == choice_indent:
                            # This is a menu option line: "Option text":
                            opt_m = re.match(r'^"(.+)":$', cs)
                            if opt_m:
                                opt_text = opt_m.group(1)
                                # Collect body of this option
                                opt_body = []
                                j += 1
                                if j < len(token_list):
                                    opt_indent = token_list[j][1]
                                    while (
                                        j < len(token_list)
                                        and token_list[j][1] >= opt_indent
                                    ):
                                        opt_body.append(token_list[j])
                                        j += 1
                                opt_steps = do_convert(opt_body)
                                options.append(
                                    {
                                        "text": opt_text,
                                        "steps": opt_steps,
                                    }
                                )
                                continue
                        j += 1
                steps.append({"type": "menu", "options": options})
                i = j
                continue

            # ---- skip unrecognised lines ----
            # (show screen, hide screen, renpy.* calls, comments, etc.)
            i += 1
            continue

        return steps

    return do_convert(tokens)


# ---------------------------------------------------------------------------
# Labels to convert: (target_label, rpy_source_file, output_json_file)
# ---------------------------------------------------------------------------
CONVERSIONS = [
    # (label_name, source_rpy, output_json)
    ("day11_aftersxhunter", "day11_hunter.rpy", "day11_hunter_aftersx.json"),
    ("day15_aftersxnatsumi", "day15_natsumi.rpy", "day15_natsumi_aftersx.json"),
    ("day15_hunteraftersx", "day15_hunter.rpy", "day15_hunter_aftersx.json"),
    ("day16_yoichisx", "day16_yoichi.rpy", "day16_yoichi_sx.json"),
    ("day17_aftersxyoichi", "day17_yoichi.rpy", "day17_yoichi_aftersx.json"),
    ("day22_aftersxnatsumi", "day22_natsumi.rpy", "day22_natsumi_aftersx.json"),
    ("day23_aftersxhunter", "day23_hunter.rpy", "day23_hunter_aftersx.json"),
    ("day24_aftersxnatsumi", "day24_natsumi.rpy", "day24_natsumi_aftersx.json"),
    ("day30_afterhiro10", "day30_hiro.rpy", "day30_hiro_aftersx.json"),
    ("day30_aftersx_huntercostume", "day30_hunter.rpy", "day30_hunter_aftersx.json"),
    ("day30_natsumiaftersx", "day30_natsumi.rpy", "day30_natsumi_aftersx.json"),
    ("day30_yoichiaftersx", "day30_yoichi.rpy", "day30_yoichi_aftersx.json"),
    ("aftersx_hiro_day50", "day50_hirope.rpy", "day50_hiro_aftersx.json"),
    ("aftersx_yoichi_day50", "day50_yoichipe.rpy", "day50_yoichi_aftersx.json"),
    ("day50_aftersx_natsumi", "day50_natsumipe.rpy", "day50_natsumi_aftersx.json"),
    ("day50_hunter_aftersx", "day50_hunterpe.rpy", "day50_hunter_aftersx.json"),
    # Additional labels referenced by the newly-converted aftersx scenes
    ("day11_hunteraftercheat", "day11_hunter.rpy", "day11_hunter_aftercheat.json"),
    ("day15_natsumiaftercheat", "day15_natsumi.rpy", "day15_natsumi_aftercheat.json"),
    ("day30_aftersx_hiro", "day30_hiro.rpy", "day30_hiro_aftersx2.json"),
]

# credits handled separately (it's a top-level label)
CREDITS_CONVERSION = ("credits", "credits.rpy", "credits.json")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print("Building lookup tables…")
    audio_map = build_audio_lookup()
    sprite_map = build_sprite_lookup()
    cg_map = build_cg_lookup()
    bg_map = build_bg_lookup()
    print(f"  audio entries : {len(audio_map)}")
    print(f"  sprite entries: {len(sprite_map)}")
    print(f"  CG entries    : {len(cg_map)}")
    print(f"  BG entries    : {len(bg_map)}")

    all_conversions = CONVERSIONS + [CREDITS_CONVERSION]

    print("Building image name lookup from script.rpy…")
    image_map = build_image_lookup()
    print(f"  image entries : {len(image_map)}")

    success = 0
    failed = 0

    for label_name, rpy_name, out_name in all_conversions:
        print(f"\nConverting '{label_name}' from {rpy_name} → {out_name} …")
        rpy_file = GAME_DIR / rpy_name
        tl_file = TL_DIR / rpy_name
        out_file = DATA_DIR / out_name

        if not rpy_file.exists():
            print(f"  [ERROR] source file not found: {rpy_file}", file=sys.stderr)
            failed += 1
            continue

        steps = convert_label(
            rpy_file=rpy_file,
            label_name=label_name,
            tl_file=tl_file if tl_file.exists() else None,
            audio_map=audio_map,
            sprite_map=sprite_map,
            cg_map=cg_map,
            bg_map=bg_map,
            image_map=image_map,
        )

        if not steps:
            print(f"  [WARN] no steps converted – keeping stub", file=sys.stderr)
            failed += 1
            continue

        out_data = {
            "source": rpy_name,
            "labels": {label_name: steps},
        }

        out_file.write_text(
            json.dumps(out_data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"  ✓ {len(steps)} steps written to {out_file.name}")
        success += 1

    print(f"\nDone. {success} succeeded, {failed} failed/warned.")


if __name__ == "__main__":
    main()
