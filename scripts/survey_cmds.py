#!/usr/bin/env python3
"""
survey_cmds.py
==============
Print all distinct `cmd` values (and their counts) found across every JSON
data file, plus a breakdown of which fields each command uses.

Usage (run from the project root):
    python3 scripts/survey_cmds.py
"""

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
SKIP_FILES = {"manifest.json", "script.json"}


def collect_cmds(steps, cmd_counter, field_map):
    for step in steps:
        if not isinstance(step, dict):
            continue
        cmd = step.get("cmd", "")
        if cmd:
            cmd_counter[cmd] += 1
            for k in step.keys():
                if k != "cmd":
                    field_map[cmd].add(k)
        for choice in step.get("choices", []):
            if isinstance(choice, dict):
                collect_cmds(choice.get("steps", []), cmd_counter, field_map)
        if isinstance(step.get("steps"), list):
            collect_cmds(step["steps"], cmd_counter, field_map)


def main():
    cmd_counter: Counter = Counter()
    field_map: dict = defaultdict(set)

    json_files = sorted(DATA_DIR.glob("*.json"))
    for f in json_files:
        if f.name in SKIP_FILES:
            continue
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            print(f"  PARSE ERROR {f.name}: {exc}", file=sys.stderr)
            continue
        steps = data if isinstance(data, list) else data.get("steps", [])
        if isinstance(steps, list):
            collect_cmds(steps, cmd_counter, field_map)

    print(f"Scanned {len(json_files)} files.\n")
    print(f"{'cmd':<25}  {'count':>6}  fields")
    print("-" * 80)
    for cmd, n in cmd_counter.most_common():
        fields = ", ".join(sorted(field_map[cmd]))
        print(f"  {cmd:<23}  {n:>6}  {fields}")


if __name__ == "__main__":
    main()
