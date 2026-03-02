// ── minigame-detect.ts ────────────────────────────────────────────────────────
//
// Pure-function core for detecting whether a .rpy file is a "minigame" —
// a self-contained interactive screen sequence that should be stubbed out
// rather than converted line-by-line.
//
// A minigame file has three structural features:
//   1. Exactly one "entry label" — a label that is not jumped/called to by
//      any other label within the same file.
//   2. That entry label has no dialogue and calls at least one screen.
//   3. Following the full call-graph from the entry label, all paths that
//      leave the file converge on exactly one external label.
//
// When those conditions are met the converter emits a stub:
//
//   label <entryLabel> {
//     jump <exitLabel>;
//   }
//
// No I/O — callers pass the raw .rpy source string.

// ── Types ─────────────────────────────────────────────────────────────────────

interface LabelInfo {
  /** Local labels reachable via jump/call from this label */
  jumpsTo: Set<string>;
  /** External (file-outside) labels reached via jump from this label */
  externalJumps: Set<string>;
  /** Whether this label contains `call screen` */
  callsScreen: boolean;
  /** Whether this label contains any dialogue line */
  hasDialogue: boolean;
}

/** Map from screen name → set of jump targets found inside that screen */
type ScreenJumps = Map<string, Set<string>>;

export interface MinigameStub {
  entryLabel: string;
  exitLabel: string;
}

export interface MinigameDetectResult {
  /**
   * Empty array → not a minigame, convert normally.
   * One or more stubs → each entry-label candidate gets its own stub.
   */
  stubs: MinigameStub[];
  /** Informational warnings (e.g. a candidate had multiple exit labels) */
  warnings: string[];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Return true if `line` (already trimmed) looks like a dialogue statement:
 *   - Bare quoted string:  "Hello there."
 *   - Character + string:  k "Hello."  /  "???" "Hello."
 * We exclude lines that are screen widget calls, python assignments, etc.
 */
function isDialogueLine(line: string): boolean {
  // Must start with a quote, or an identifier/quoted-name followed by a quote.
  // Quick negative checks first.
  if (!line) return false;
  if (
    line.startsWith("$") ||
    line.startsWith("call ") ||
    line.startsWith("jump ") ||
    line.startsWith("scene ") ||
    line.startsWith("show ") ||
    line.startsWith("hide ") ||
    line.startsWith("play ") ||
    line.startsWith("stop ") ||
    line.startsWith("with ") ||
    line.startsWith("if ") ||
    line.startsWith("elif ") ||
    line.startsWith("else:") ||
    line.startsWith("while ") ||
    line.startsWith("menu:") ||
    line.startsWith("menu ") ||
    line.startsWith("return") ||
    line.startsWith("pass") ||
    line.startsWith("label ") ||
    line.startsWith("screen ") ||
    line.startsWith("python") ||
    line.startsWith("image ") ||
    line.startsWith("define ") ||
    line.startsWith("default ") ||
    line.startsWith("init ") ||
    line.startsWith("#") ||
    line.startsWith("window ") ||
    line.startsWith("nvl ") ||
    line.startsWith("pause")
  ) {
    return false;
  }

  // Bare quoted string → narration
  if (line.startsWith('"') || line.startsWith("'")) return true;

  // identifier/quoted-name followed eventually by a quoted string
  // e.g.  k "Hello"  or  "???" "Hello"
  const charSayRe = /^(?:[A-Za-z_]\w*|"[^"]+"|'[^']+')\s+"/.test(line);
  if (charSayRe) return true;

  return false;
}

/** Strip a trailing inline comment and trim */
function stripComment(line: string): string {
  let inStr = false;
  let strChar = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === strChar) inStr = false;
    } else {
      if (ch === '"' || ch === "'") {
        inStr = true;
        strChar = ch;
      } else if (ch === "#") return line.slice(0, i).trim();
    }
  }
  return line.trim();
}

// ── Phase 1: scan ─────────────────────────────────────────────────────────────

interface ScanResult {
  localLabels: Set<string>;
  labelInfos: Map<string, LabelInfo>;
  screenJumps: ScreenJumps;
  /** Jump targets found anywhere in the file (including init python blocks) */
  topLevelJumps: Set<string>;
}

/**
 * Single-pass scan of the .rpy source.
 *
 * We track the "current context" which is either:
 *   - { kind: "label", name }
 *   - { kind: "screen", name }
 *   - { kind: "top" }
 *
 * Context switches on dedent back to column 0 (or the `label`/`screen`
 * keyword line itself).  Because Ren'Py uses indentation for blocks we
 * only need to track whether we are *inside* a label or screen; we do
 * not need to fully parse the indentation stack.
 */
function scanFile(src: string): ScanResult {
  const lines = src.split("\n");

  const localLabels = new Set<string>();
  const labelInfos = new Map<string, LabelInfo>();
  const screenJumps: ScreenJumps = new Map();
  const topLevelJumps = new Set<string>();

  type Context =
    | { kind: "top" }
    | { kind: "label"; name: string }
    | { kind: "screen"; name: string };

  let ctx: Context = { kind: "top" };

  const freshLabel = (): LabelInfo => ({
    jumpsTo: new Set(),
    externalJumps: new Set(),
    callsScreen: false,
    hasDialogue: false,
  });

  const ensureLabel = (name: string): LabelInfo => {
    if (!labelInfos.has(name)) labelInfos.set(name, freshLabel());
    return labelInfos.get(name)!;
  };

  for (const rawLine of lines) {
    // Determine indentation
    let indent = 0;
    while (indent < rawLine.length && rawLine[indent] === " ") indent++;
    const trimmed = stripComment(rawLine.trim());
    if (!trimmed) continue;

    // ── Context switch: back to top level ────────────────────────────────────
    // Any label/screen declaration at column 0 switches context.
    // Also, any non-indented line that isn't a continuation resets context
    // if we were inside something (Ren'Py blocks end on dedent to 0).
    if (indent === 0 && ctx.kind !== "top") {
      // Only reset if this line itself starts a new block or is a top-level stmt
      const isNewBlock =
        /^label\s+\w+/.test(trimmed) ||
        /^screen\s+\w+/.test(trimmed) ||
        /^init\b/.test(trimmed) ||
        /^python\b/.test(trimmed) ||
        /^image\s/.test(trimmed) ||
        /^define\s/.test(trimmed) ||
        /^default\s/.test(trimmed) ||
        /^transform\s/.test(trimmed) ||
        /^style\s/.test(trimmed);
      if (isNewBlock) {
        ctx = { kind: "top" };
      }
    }

    // ── label declaration ─────────────────────────────────────────────────────
    const labelMatch = trimmed.match(/^label\s+(\w+)\s*(?:\(.*\))?\s*:/);
    if (labelMatch) {
      const name = labelMatch[1];
      localLabels.add(name);
      ensureLabel(name);
      ctx = { kind: "label", name };
      continue;
    }

    // ── screen declaration ────────────────────────────────────────────────────
    const screenMatch = trimmed.match(/^screen\s+(\w+)\s*(?:\(.*\))?\s*:/);
    if (screenMatch) {
      const name = screenMatch[1];
      if (!screenJumps.has(name)) screenJumps.set(name, new Set());
      ctx = { kind: "screen", name };
      continue;
    }

    // ── Lines inside a label ──────────────────────────────────────────────────
    if (ctx.kind === "label") {
      const info = ensureLabel(ctx.name);

      // call screen <name>  OR  show screen <name>
      const callScreenMatch = trimmed.match(/^(?:call|show)\s+screen\s+(\w+)/);
      if (callScreenMatch) {
        info.callsScreen = true;
        // We'll resolve screen jump targets after the full scan
        continue;
      }

      // renpy.pause(hard=True) — used by show-screen-based minigames instead
      // of call screen to hand control to the screen loop
      if (/renpy\.pause\s*\(/.test(trimmed)) {
        info.callsScreen = true;
        continue;
      }

      // jump <target>
      const jumpMatch = trimmed.match(/^jump\s+(\w+)/);
      if (jumpMatch) {
        // We'll classify local vs external after full scan
        info.jumpsTo.add(jumpMatch[1]); // tentatively local; reclassify later
        continue;
      }

      // call <label>  (not screen)
      const callMatch = trimmed.match(/^call\s+(\w+)(?:\s|$)/);
      if (callMatch && callMatch[1] !== "screen") {
        info.jumpsTo.add(callMatch[1]);
        continue;
      }

      // $ renpy.jump('target') or $ renpy.jump("target")
      const rpyJumpMatch = trimmed.match(
        /renpy\.jump\s*\(\s*['"](\w+)['"]\s*\)/,
      );
      if (rpyJumpMatch) {
        info.jumpsTo.add(rpyJumpMatch[1]);
        continue;
      }

      // $ renpy.jump(variable_name) — bare identifier (dynamic target).
      // The variable name itself is treated as the external exit target,
      // since the convention is that the caller sets e.g. `label_afterjournal`
      // to the desired destination before calling this minigame.
      const rpyJumpBareMatch = trimmed.match(
        /renpy\.jump\s*\(\s*([A-Za-z_]\w*)\s*\)/,
      );
      if (rpyJumpBareMatch) {
        info.jumpsTo.add(rpyJumpBareMatch[1]);
        continue;
      }

      // dialogue detection
      if (isDialogueLine(trimmed)) {
        info.hasDialogue = true;
      }

      continue;
    }

    // ── Collect jump targets from anywhere in the file ────────────────────────
    // This catches renpy.jump() calls inside init python blocks, Python
    // functions, etc. that are outside of label/screen context.
    {
      const anyRpyJump = trimmed.matchAll(
        /renpy\.jump\s*\(\s*['"]?([A-Za-z_]\w*)['"]?\s*\)/g,
      );
      for (const m of anyRpyJump) topLevelJumps.add(m[1]);

      const anyJumpCall = trimmed.matchAll(
        /\bJump\s*\(\s*['"]?([A-Za-z_]\w*)['"]?\s*\)/g,
      );
      for (const m of anyJumpCall) topLevelJumps.add(m[1]);
    }

    // ── Lines inside a screen ─────────────────────────────────────────────────
    if (ctx.kind === "screen") {
      const targets = screenJumps.get(ctx.name)!;

      // Jump("target") / Jump('target') / Jump(bare_var)
      const jumpCallMatches = trimmed.matchAll(
        /\bJump\s*\(\s*['"]?(\w+)['"]?\s*\)/g,
      );
      for (const m of jumpCallMatches) {
        targets.add(m[1]);
      }

      // renpy.jump('target') / renpy.jump("target") / renpy.jump(bare_var)
      const rpyJumpMatches = trimmed.matchAll(
        /renpy\.jump\s*\(\s*['"]?(\w+)['"]?\s*\)/g,
      );
      for (const m of rpyJumpMatches) {
        targets.add(m[1]);
      }

      // bare jump <target> inside a screen block (rare but possible)
      const bareJump = trimmed.match(/^jump\s+(\w+)/);
      if (bareJump) targets.add(bareJump[1]);

      continue;
    }
  }

  return { localLabels, labelInfos, screenJumps, topLevelJumps };
}

// ── Phase 2: classify local vs external jumps ─────────────────────────────────

/**
 * After scanning, we know which labels exist locally.
 * Reclassify each tentative jump target:
 *   - if the target is in localLabels → stays in jumpsTo
 *   - otherwise → move to externalJumps
 *
 * Also merge screen jump targets into label infos for labels that call those screens.
 */
function classifyAndMerge(src: string, result: ScanResult): void {
  const { localLabels, labelInfos, screenJumps, topLevelJumps } = result;

  // For each label, reclassify jumpsTo targets
  for (const [, info] of labelInfos) {
    const toRemove: string[] = [];
    for (const target of info.jumpsTo) {
      if (!localLabels.has(target)) {
        toRemove.push(target);
        info.externalJumps.add(target);
      }
    }
    for (const t of toRemove) info.jumpsTo.delete(t);
  }

  // Merge screen jump targets into labels that call those screens.
  // We need to re-scan for call screen lines to find which label calls which screen.
  const lines = src.split("\n");
  type Context =
    | { kind: "top" }
    | { kind: "label"; name: string }
    | { kind: "screen"; name: string };
  let ctx: Context = { kind: "top" };

  for (const rawLine of lines) {
    let indent = 0;
    while (indent < rawLine.length && rawLine[indent] === " ") indent++;
    const trimmed = stripComment(rawLine.trim());
    if (!trimmed) continue;

    if (indent === 0) {
      const labelM = trimmed.match(/^label\s+(\w+)/);
      if (labelM) {
        ctx = { kind: "label", name: labelM[1] };
        continue;
      }
      const screenM = trimmed.match(/^screen\s+(\w+)/);
      if (screenM) {
        ctx = { kind: "screen", name: screenM[1] };
        continue;
      }
      if (
        /^init\b|^python\b|^image\s|^define\s|^default\s|^transform\s|^style\s/.test(
          trimmed,
        )
      ) {
        ctx = { kind: "top" };
      }
    }

    if (ctx.kind === "label") {
      const csm = trimmed.match(/^(?:call|show)\s+screen\s+(\w+)/);
      if (csm) {
        const screenName = csm[1];
        const targets = screenJumps.get(screenName);
        if (targets) {
          const info = labelInfos.get(ctx.name)!;
          for (const t of targets) {
            if (localLabels.has(t)) {
              info.jumpsTo.add(t);
            } else {
              info.externalJumps.add(t);
            }
          }
        }
      }
    }
  }

  // Merge topLevelJumps into every label that has no externalJumps yet and
  // is itself a minigame candidate (callsScreen, no dialogue).  This handles
  // the pattern where exit jumps live inside init python functions rather than
  // directly in a label body (e.g. foreplay.rpy).
  //
  // IMPORTANT: only inject into labels that look like minigame candidates
  // (callsScreen && !hasDialogue).  Injecting into ordinary dialogue labels
  // would cause script.rpy-style definition files to be falsely detected as
  // minigames when their init python blocks happen to contain a renpy.jump().
  for (const [, info] of labelInfos) {
    if (
      info.externalJumps.size === 0 &&
      info.callsScreen &&
      !info.hasDialogue
    ) {
      for (const t of topLevelJumps) {
        if (!localLabels.has(t)) {
          info.externalJumps.add(t);
        }
      }
    }
  }
}

// ── Phase 3: find entry label candidates ─────────────────────────────────────

/**
 * Ren'Py built-in / game-entry reserved label names.
 *
 * These labels are called directly by the Ren'Py engine itself (not by any
 * other label in the game files), so they will always appear as "unreferenced"
 * entry points.  They must never be treated as minigame candidates even when
 * they contain `show screen` / `renpy.pause()` and no dialogue — that is
 * perfectly normal for a splash-screen or game-start initialisation label.
 */
const RENPY_RESERVED_LABELS = new Set([
  "start",
  "splashscreen",
  "main_menu",
  "after_load",
  "quit",
  "after_warp",
  "hide_windows",
]);

function findEntryCandidates(
  localLabels: Set<string>,
  labelInfos: Map<string, LabelInfo>,
  screenJumps: ScreenJumps,
): string[] {
  // Collect all labels that are referenced by any other label's jumpsTo,
  // AND by any screen's Jump() targets — screens can jump directly to a local
  // label (e.g. screen `end` jumps to `exit_game`), so those targets are also
  // "referenced" and must not be treated as entry points.
  const referenced = new Set<string>();
  for (const [, info] of labelInfos) {
    for (const t of info.jumpsTo) referenced.add(t);
  }
  for (const [, targets] of screenJumps) {
    for (const t of targets) {
      if (localLabels.has(t)) referenced.add(t);
    }
  }

  // Entry label candidates: not referenced by anyone, callsScreen, no dialogue,
  // and not a Ren'Py engine-reserved label name.
  return [...localLabels].filter((name) => {
    if (referenced.has(name)) return false;
    if (RENPY_RESERVED_LABELS.has(name)) return false;
    const info = labelInfos.get(name);
    return info != null && info.callsScreen && !info.hasDialogue;
  });
}

// ── Phase 4: BFS to collect external exits ───────────────────────────────────

function collectExternalExits(
  entryLabel: string,
  labelInfos: Map<string, LabelInfo>,
): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [entryLabel];
  const externalExits = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const info = labelInfos.get(current);
    if (!info) continue;

    for (const ext of info.externalJumps) {
      externalExits.add(ext);
    }

    for (const local of info.jumpsTo) {
      if (!visited.has(local)) queue.push(local);
    }
  }

  return externalExits;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Analyse a `.rpy` source string and determine whether it is a minigame.
 *
 * Each unreferenced entry-label candidate that has no dialogue and calls a
 * screen gets its own stub.  When a candidate has multiple external exits or
 * none, it is skipped (with a warning for the multi-exit case).
 *
 * @param src  - Raw content of the `.rpy` file
 * @returns    - A `MinigameDetectResult`; `stubs` is empty when not a minigame
 */
export function detectMinigame(src: string): MinigameDetectResult {
  const warnings: string[] = [];

  // Phase 1: scan
  const scanResult = scanFile(src);

  // Phase 2: classify
  classifyAndMerge(src, scanResult);

  const { localLabels, labelInfos } = scanResult;

  // Early-out: if ANY label in the file has dialogue, this is a normal script
  // file (e.g. script.rpy / definitions.rpy).  Minigame files are pure
  // screen-interaction sequences with no character dialogue at all.
  for (const [, info] of labelInfos) {
    if (info.hasDialogue) return { stubs: [], warnings };
  }

  // Phase 3: find all entry candidates
  const candidates = findEntryCandidates(
    localLabels,
    labelInfos,
    scanResult.screenJumps,
  );

  if (candidates.length === 0) {
    return { stubs: [], warnings };
  }

  // Phase 4: for each candidate, BFS to find external exit
  const stubs: MinigameStub[] = [];

  for (const entryLabel of candidates) {
    const exits = collectExternalExits(entryLabel, labelInfos);

    if (exits.size === 0) {
      // No external exit — loop or incomplete; skip silently
      continue;
    }

    if (exits.size > 1) {
      warnings.push(
        `minigame-detect: entry label "${entryLabel}" has ${exits.size} external exit(s): ` +
          [...exits].join(", ") +
          ". Skipping stub generation for this label.",
      );
      continue;
    }

    stubs.push({ entryLabel, exitLabel: [...exits][0] });
  }

  return { stubs, warnings };
}

/**
 * Render all minigame stubs for a file as a single `.rrs` source string.
 *
 * @param stubs     - Array from `detectMinigame().stubs`
 * @param filename  - Used in the `// Source:` comment
 */
export function renderMinigameStubs(
  stubs: MinigameStub[],
  filename: string,
): string {
  const lines: string[] = [
    `// Source: ${filename}`,
    `// [minigame stub — interactive screen sequence replaced with jump]`,
    ``,
  ];
  for (const stub of stubs) {
    lines.push(`label ${stub.entryLabel} {`);
    lines.push(`  jump ${stub.exitLabel};`);
    lines.push(`}`);
    lines.push(``);
  }
  return lines.join("\n");
}
