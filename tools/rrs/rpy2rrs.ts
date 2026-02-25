#!/usr/bin/env bun
// ── rpy2rrs.ts ────────────────────────────────────────────────────────────────
//
// Converts Ren'Py .rpy files to .rrs format.
// Loads asset maps (audio, bg, cg, sx) and character definitions from the
// game's script.rpy (or another specified file), then translates the
// structural syntax of each .rpy file.
//
// Usage:
//   bun run tools/rrs/rpy2rrs.ts <file.rpy>
//   bun run tools/rrs/rpy2rrs.ts <dir/>
//   bun run rpy2rrs <file.rpy>
//
// Options:
//   -o <path>         Output path (single-file mode only) or output directory
//   --manifest        Write manifest.json listing all successfully converted files
//   --dry-run         Parse only, do not write files
//   --verbose         Print generated rrs to stdout
//   --tl <dir>        Path to tl/chinese directory for Chinese translations
//                     (translations are disabled by default; must be explicitly enabled)
//   --no-tl           Kept for backward compatibility; now a no-op (no-tl is the default)
//   --skip <pattern>  Skip files matching this glob/name pattern (repeatable)
//   --stub-exit <label=var>  Inject `jump VAR;` when closing label LABEL
//   --help, -h        Show this help

import {
  stat as fsStat,
  readFile,
  writeFile,
  mkdir,
  opendir,
} from "node:fs/promises";

// ── Non-story files to skip (UI / system) ────────────────────────────────────
// These are generic Ren'Py infrastructure files present in virtually every
// game.  Additional patterns can be added via --skip on the command line.

const DEFAULT_SKIP_FILES = new Set([
  "screens.rpy",
  "options.rpy",
  "gui.rpy",
  "about.rpy",
  "save.rpy",
  "load.rpy",
  "updater.rpy",
  // galleries / menus
  "gallery.rpy",
  "gallery_config.rpy",
  "gallery_images.rpy",
]);

// NOTE: script.rpy is no longer in the skip list.  It is still used as the
// source for asset maps and character definitions, but its labels (including
// `label start`) are now also converted to .rrs.

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns name with quotes if it contains special chars */
function fmtSpeaker(name: string): string {
  if (/[^A-Za-z0-9_]/.test(name)) return `"${name}"`;
  return name;
}

/**
 * Escape a character abbreviation for use as a define key segment.
 * Only alphanumeric and underscores are valid ident chars in .rrs.
 */
function safeDefineKey(abbr: string): string {
  return abbr.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** Normalize a Ren'Py transition name to .rrs equivalent */
function normTransition(raw: string): string {
  const t = raw.trim();
  if (/^[Dd]issolve\s*\(/.test(t)) return "dissolve";
  if (t === "dissolve") return "dissolve";
  if (t === "fade") return "fade";
  if (t === "Fade" || /^Fade\s*\(/.test(t)) return "fade";
  if (/^flash/i.test(t)) return "flash";
  if (t === "None") return "";
  // Ren'Py-specific transitions that have no .rrs equivalent — drop them.
  // NOTE: keep moveout* / movein* variants (valid .rrs), only drop the
  // bare `movetransition` name and other purely Ren'Py-internal ones.
  if (
    t === "movetransition" ||
    /^blinds/i.test(t) ||
    /^pixellate/i.test(t) ||
    /^vpunch/i.test(t) ||
    /^hpunch/i.test(t) ||
    /^wipe/i.test(t) ||
    /^ease/i.test(t) ||
    /^bounce/i.test(t) ||
    /^zoomin/i.test(t) ||
    /^zoomout/i.test(t) ||
    /^irisfade/i.test(t) ||
    /^squares/i.test(t)
  ) {
    return "";
  }
  return t
    .toLowerCase()
    .replace(/\(.*\)/, "")
    .trim();
}

/** Escape a string for .rrs double-quote context */
function escStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Strip Ren'Py inline text markup tags from a dialogue string.
 * e.g. {i}text{/i}  →  text
 *      {b}text{/b}  →  text
 *      {color=#fff}text{/color}  →  text
 *      {size=+5}text{/size}      →  text
 */
function stripRpyTags(s: string): string {
  // Remove paired tags: {tag}content{/tag}  or bare {tag}
  return s.replace(/\{[^{}]*\}/g, "").trim();
}

/** Transform a Ren'Py condition expression to .rrs syntax */
function normCondition(cond: string): string {
  return (
    cond
      .trim()
      // Python attribute access — keep dots as-is (do not insert spaces)
      .replace(/(\w)\.([\w_])/g, (_m, a, b) => `${a}.${b}`)
      // Python boolean operators
      .replace(/\band\b/g, "&&")
      .replace(/\bor\b/g, "||")
      .replace(/\bnot\s+/g, "! ")
  );
}

/** Extract a Python string literal's content (handles 'x' or "x") */
function extractPyStr(raw: string): string {
  const m = raw.match(/^(['"])([\s\S]*?)\1$/);
  return m ? m[2] : raw;
}

// ── Asset maps ───────────────────────────────────────────────────────────────

interface AssetMaps {
  /** audio.VAR → file path */
  audio: Map<string, string>;
  /** bg_NAME → file path */
  bg: Map<string, string>;
  /** cg_NAME → file path */
  cg: Map<string, string>;
  /** sx_NAME → file path */
  sx: Map<string, string>;
  /** misc image NAME → file path (images that are not bg/cg/sx prefixed) */
  misc: Map<string, string>;
  /**
   * Character abbreviation → full name.
   * Populated by parsing `define <abbr> = Character("Name", ...)` lines.
   * Used to emit `define char.<abbr> = "Name";` at the top of each .rrs file.
   */
  charMap: Map<string, string>;
  /**
   * Chinese translation: english dialogue text → chinese dialogue text.
   * Populated from tl/chinese/*.rpy translate blocks when --tl is set.
   */
  tl?: Map<string, string>;
}

function emptyAssetMaps(): AssetMaps {
  return {
    audio: new Map(),
    bg: new Map(),
    cg: new Map(),
    sx: new Map(),
    misc: new Map(),
    charMap: new Map(),
  };
}

// ── Chinese translation loader ────────────────────────────────────────────────

/**
 * Load a single `tl/chinese/<name>.rpy` translation file and return a map
 * from english dialogue text → chinese dialogue text.
 */
async function loadChineseTranslationsForFile(
  tlDir: string,
  sourceBaseName: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const filePath = `${tlDir}/${sourceBaseName}.rpy`;
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return map;
  }
  parseTranslationBlocks(content, map);
  return map;
}

/**
 * Extract (english → chinese) pairs from one translation `.rpy` file.
 */
function parseTranslationBlocks(
  content: string,
  out: Map<string, string>,
): void {
  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Start of a translate block: `translate LANG ID:`
    if (/^translate\s+\w+\s+\w+\s*:/.test(trimmed)) {
      i++;
      let englishText: string | null = null;
      let chineseText: string | null = null;

      while (i < lines.length) {
        const innerRaw = lines[i];
        const inner = innerRaw.trim();

        if (!inner) {
          if (englishText !== null) break;
          i++;
          continue;
        }

        if (
          innerRaw.length > 0 &&
          innerRaw[0] !== " " &&
          innerRaw[0] !== "\t"
        ) {
          break;
        }

        if (inner.startsWith("#")) {
          if (!inner.match(/^#\s+voice\b/)) {
            const cm = inner.match(
              /^#\s+[\w_]+\s+"((?:[^"\\]|\\.)*)"\s*(?:with\s+\S+)?\s*$/,
            );
            if (cm) englishText = cm[1].replace(/\{[^{}]*\}/g, "").trim();
          }
          i++;
          continue;
        }

        if (/^voice\s+audio\./.test(inner)) {
          i++;
          continue;
        }

        if (inner.startsWith("old ") || inner.startsWith("new ")) {
          const om = inner.match(/^old\s+"((?:[^"\\]|\\.)*)"\s*$/);
          if (om) {
            englishText = om[1].replace(/\{[^{}]*\}/g, "").trim();
            i++;
            continue;
          }
          const nm = inner.match(/^new\s+"((?:[^"\\]|\\.)*)"\s*$/);
          if (nm && englishText !== null) {
            chineseText = nm[1];
            i++;
            if (!out.has(englishText)) out.set(englishText, chineseText);
            englishText = null;
            chineseText = null;
            continue;
          }
          i++;
          continue;
        }

        const dm = inner.match(
          /^[\w_]+\s+"((?:[^"\\]|\\.)*)"\s*(?:with\s+\S+)?\s*$/,
        );
        if (dm) {
          chineseText = dm[1];
          i++;
          break;
        }

        break;
      }

      if (englishText !== null && chineseText !== null) {
        if (!out.has(englishText)) {
          out.set(englishText, chineseText);
        }
      }
    } else {
      i++;
    }
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function getIndent(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === " ") i++;
  return i;
}

// ── Core converter ────────────────────────────────────────────────────────────

interface BlockInfo {
  rpyCol: number;
  type: "label" | "if" | "elif" | "else" | "menu" | "choice";
  /** For type === "label": the label name (used for stub-exit injection). */
  labelName?: string;
}

/**
 * Per-run stub-exit map: label name → variable name containing the jump target.
 * Populated from --stub-exit label=varName command-line arguments.
 * When we close a label whose name appears in this map we inject
 * `jump varName;` so the engine can handle the dynamic jump.
 */
let STUB_EXIT_MAP: Record<string, string> = {};

interface SpeakLine {
  text: string;
  voice?: string;
}

interface SpeakBuffer {
  who: string;
  lines: SpeakLine[];
}

class Converter {
  private lines: string[];
  private pos = 0;
  private out: string[] = [];
  private blockStack: BlockInfo[] = [];
  private pendingVoice: string | null = null;
  private speakBuf: SpeakBuffer | null = null;
  /** Character abbreviation → full name, from asset maps. */
  private charMap: Map<string, string>;

  /**
   * After we see `menu:` we enter preamble mode.
   * In preamble mode all dialogue is skipped (it's always a `{fast}` repeat of
   * what was just said before the menu). The first `"CHOICE":` line ends
   * preamble and causes us to emit `menu {`.
   */
  private menuPreamble = false;
  private menuOpen = false;
  private menuPreambleCol = -1;

  constructor(
    lines: string[],
    private readonly maps: AssetMaps,
    private readonly filename: string,
  ) {
    this.lines = lines;
    this.charMap = maps.charMap;
  }

  /** Translate a dialogue string: return Chinese if available, else original. */
  private translate(text: string): string {
    return this.maps.tl?.get(text) ?? text;
  }

  // ── Output helpers ──────────────────────────────────────────────────────────

  private depth(): number {
    return this.blockStack.length;
  }

  private pad(extra = 0): string {
    return "  ".repeat(this.depth() + extra);
  }

  private emit(line: string): void {
    this.out.push(line);
  }

  // ── Block management ────────────────────────────────────────────────────────

  private closeBlocksAt(atCol: number): void {
    if (this.menuPreamble && this.menuPreambleCol >= atCol) {
      this.menuPreamble = false;
      this.menuPreambleCol = -1;
    }
    while (this.blockStack.length > 0) {
      const top = this.blockStack[this.blockStack.length - 1];
      if (top.rpyCol >= atCol) {
        this.blockStack.pop();
        if (top.type === "menu" && !this.menuOpen) {
          // nothing to close
        } else {
          // Inject stub-exit jump before closing a minigame label
          if (top.type === "label" && top.labelName) {
            const exitVar = STUB_EXIT_MAP[top.labelName];
            if (exitVar) {
              this.flushSpeak();
              this.emit(`${this.pad(1)}jump ${exitVar};`);
            }
          }
          this.emit(this.pad() + "}");
        }
        if (top.type === "menu") {
          this.menuOpen = false;
          this.menuPreamble = false;
          this.menuPreambleCol = -1;
        }
      } else {
        break;
      }
    }
  }

  private closeSiblingAt(atCol: number): void {
    if (this.menuPreamble && this.menuPreambleCol >= atCol) {
      this.menuPreamble = false;
      this.menuPreambleCol = -1;
    }
    while (this.blockStack.length > 0) {
      const top = this.blockStack[this.blockStack.length - 1];
      if (top.rpyCol > atCol) {
        this.blockStack.pop();
        this.emit(this.pad() + "}");
        if (top.type === "menu") {
          this.menuOpen = false;
          this.menuPreamble = false;
          this.menuPreambleCol = -1;
        }
      } else {
        break;
      }
    }
    if (
      this.blockStack.length > 0 &&
      this.blockStack[this.blockStack.length - 1].rpyCol === atCol
    ) {
      const top = this.blockStack.pop()!;
      if (!(top.type === "menu" && !this.menuOpen)) {
        this.emit(this.pad() + "}");
      }
      if (top.type === "menu") {
        this.menuOpen = false;
        this.menuPreamble = false;
        this.menuPreambleCol = -1;
      }
    }
  }

  // ── Speak buffering ─────────────────────────────────────────────────────────

  private flushSpeak(): void {
    if (!this.speakBuf) return;
    const { who, lines } = this.speakBuf;
    this.speakBuf = null;
    const sp = fmtSpeaker(who);
    if (lines.length === 1 && !lines[0].voice) {
      this.emit(`${this.pad()}speak ${sp} "${escStr(lines[0].text)}";`);
    } else if (lines.length === 1 && lines[0].voice) {
      this.emit(
        `${this.pad()}speak ${sp} "${escStr(lines[0].text)}" | ${lines[0].voice};`,
      );
    } else {
      this.emit(`${this.pad()}speak ${sp} {`);
      for (const l of lines) {
        if (l.voice) {
          this.emit(`${this.pad(1)}"${escStr(l.text)}" | ${l.voice};`);
        } else {
          this.emit(`${this.pad(1)}"${escStr(l.text)}";`);
        }
      }
      this.emit(`${this.pad()}}`);
    }
  }

  private addSpeakLine(who: string, text: string, voice: string | null): void {
    if (this.speakBuf && this.speakBuf.who !== who) {
      this.flushSpeak();
    }
    if (!this.speakBuf) {
      this.speakBuf = { who, lines: [] };
    }
    this.speakBuf.lines.push({ text, voice: voice ?? undefined });
  }

  // ── Asset resolution ────────────────────────────────────────────────────────

  private resolveAudio(varName: string): string {
    return `audio.${varName}`;
  }

  // ── Look-ahead helper ───────────────────────────────────────────────────────

  private peekNext(): [number, string] | null {
    for (let i = this.pos; i < this.lines.length; i++) {
      const l = this.lines[i].trim();
      if (l && !l.startsWith("#")) return [i, l];
    }
    return null;
  }

  // ── Unified show/scene key builder ──────────────────────────────────────────

  /**
   * Given the words of a Ren'Py image reference (everything between the
   * command keyword and any `at`/`with` clause), return the dot-joined key
   * used in the .rrs output.
   *
   * Examples:
   *   ["cg", "arrival2"]          → "cg.arrival2"
   *   ["keitaro_casual"]          → "keitaro_casual"
   *   ["keitaro", "normal1"]      → "keitaro.normal1"
   *   ["hina", "sick", "normal1"] → "hina.sick.normal1"
   *   ["bg_entrance_day"]         → "bg_entrance_day"
   */
  private static imageKey(words: string[]): string {
    return words.join(".");
  }

  /**
   * Parse the tail of a `show` or `scene` line (everything after the keyword)
   * into { words, at, trans, filter }.
   *
   * Stops accumulating words when it encounters `at`, `with`, or a known
   * filter keyword.  Trailing ATL colon (`:`) is stripped from the last word.
   *
   * show keitaro normal1 at center with dissolve
   *   → words=["keitaro","normal1"] at="center" trans="dissolve"
   * scene bg_entrance_day sepia with dissolve
   *   → words=["bg_entrance_day"] filter="sepia" trans="dissolve"
   */
  private static parseShowTail(
    tail: string,
    forScene = false,
  ): { words: string[]; at: string; trans: string; filter: string } {
    const FILTERS = new Set(["sepia"]);
    const parts = tail.trim().split(/\s+/);
    const words: string[] = [];
    let at = "";
    let trans = "";
    let filter = "";
    let i = 0;
    while (i < parts.length) {
      const p = parts[i];
      if (p === "with" && i + 1 < parts.length) {
        trans = normTransition(parts[i + 1]);
        i += 2;
        continue;
      }
      if (p === "at" && i + 1 < parts.length) {
        at = parts[i + 1];
        i += 2;
        continue;
      }
      // Filter keyword (only meaningful for scene)
      if (forScene && FILTERS.has(p)) {
        filter = p;
        i++;
        continue;
      }
      // Strip trailing ATL colon
      words.push(p.replace(/:$/, ""));
      i++;
    }
    return { words, at, trans, filter };
  }

  // ── Main line processor ─────────────────────────────────────────────────────

  private processLine(rawLine: string): void {
    const indent = getIndent(rawLine);
    let line = rawLine.trim();

    // ── Blank / comment ───────────────────────────────────────────────────────
    if (!line || line.startsWith("#")) return;

    // Strip inline Ren'Py comments: find # that is not inside a string
    {
      let inStr = false;
      let strChar = "";
      for (let ci = 0; ci < line.length; ci++) {
        const ch = line[ci];
        if (inStr) {
          if (ch === "\\") {
            ci++;
            continue;
          }
          if (ch === strChar) inStr = false;
        } else {
          if (ch === '"' || ch === "'") {
            inStr = true;
            strChar = ch;
          } else if (ch === "#") {
            line = line.slice(0, ci).trim();
            break;
          }
        }
      }
      if (!line) return;
      if (line === '"' || line === "'") return;
    }

    // ── Ren'Py image declarations ─────────────────────────────────────────────
    if (
      line.startsWith("image ") &&
      (line.includes(" = Movie(") ||
        /\s=\s*Movie\s*\(/.test(line) ||
        /\s=\s*"/.test(line) ||
        /\s=\s*im\./.test(line) ||
        /\s=\s*Composite\(/.test(line))
    ) {
      this.processImageDecl(line);
      return;
    }

    // ── define audio.VAR = "path" ─────────────────────────────────────────────
    const audioDefineMatch = line.match(
      /^define\s+(audio\.\w+)\s*=\s*"([^"]+)"/,
    );
    if (audioDefineMatch) {
      this.emit(`${audioDefineMatch[1]} = "${escStr(audioDefineMatch[2])}";`);
      return;
    }

    // ── define/$ VAR = Position(xpos=X, ...) ─────────────────────────────────
    const positionMatch = line.match(
      /^(?:define\s+|(?:\$\s*))(\w+)\s*=\s*Position\s*\(\s*xpos\s*=\s*([\d.]+)/,
    );
    if (positionMatch) {
      this.emit(`position.${positionMatch[1]} = ${positionMatch[2]};`);
      return;
    }

    // ── default VAR = VALUE ───────────────────────────────────────────────────
    // Treat Ren'Py `default X = Y` as an emitted assignment so persistent
    // defaults and other defaulted variables are present in the generated .rrs.
    // Example: `default persistent.animations = True` → `persistent.animations = true;`
    const defaultMatch = line.match(/^default\s+([\w.]+)\s*=\s*(.+)$/);
    if (defaultMatch) {
      const varName = defaultMatch[1];
      let val = defaultMatch[2].trim();
      // Normalize Python booleans to JS/rrs booleans
      val = val.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false");
      this.emit(`${this.pad()}${varName} = ${val};`);
      return;
    }

    // ── Statements we always skip ─────────────────────────────────────────────
    if (
      line.startsWith("$renpy.free_memory") ||
      line.startsWith("$ renpy.free_memory") ||
      line.startsWith("show screen ") ||
      line.startsWith("hide screen ") ||
      line.startsWith("$shuffle_menu") ||
      line.startsWith("$ shuffle_menu") ||
      line === "window hide" ||
      line === "window show" ||
      line.startsWith("define ") ||
      line === "init:" ||
      line.startsWith("init ") ||
      line.startsWith("python:") ||
      /^(zoom|xalign|yalign|xpos|ypos|alpha|ease|linear)\s/.test(line) ||
      line.match(/^\$\s*working\s*=/) !== null ||
      line.match(/^\$\s*time_transition_\w+\s*\(/) !== null ||
      line.match(/^\$\s*renpy\.save_persistent\s*\(/) !== null ||
      line.match(/^\$\s*renpy\.movie_cutscene\s*\(/) !== null
    ) {
      return;
    }

    // ── Block-opener / branch handlers ────────────────────────────────────────

    // label X:
    const labelMatch = line.match(/^label\s+(\w+)\s*:/);
    if (labelMatch) {
      this.flushSpeak();
      this.closeBlocksAt(indent);
      this.emit(`${this.pad()}label ${labelMatch[1]} {`);
      this.blockStack.push({
        rpyCol: indent,
        type: "label",
        labelName: labelMatch[1],
      });
      return;
    }

    // if COND:
    const ifMatch = line.match(/^if\s+(.*?)\s*:$/);
    if (ifMatch) {
      this.flushSpeak();
      this.closeBlocksAt(indent);
      this.emit(`${this.pad()}if ${normCondition(ifMatch[1])} {`);
      this.blockStack.push({ rpyCol: indent, type: "if" });
      return;
    }

    // elif COND:
    const elifMatch = line.match(/^elif\s+(.*?)\s*:$/);
    if (elifMatch) {
      this.flushSpeak();
      this.closeSiblingAt(indent);
      const last = this.out[this.out.length - 1];
      const expectedClose = this.pad() + "}";
      if (last === expectedClose) {
        this.out[this.out.length - 1] =
          `${this.pad()}} elif ${normCondition(elifMatch[1])} {`;
      } else {
        this.emit(`${this.pad()}} elif ${normCondition(elifMatch[1])} {`);
      }
      this.blockStack.push({ rpyCol: indent, type: "elif" });
      return;
    }

    // else:
    if (line === "else:") {
      this.flushSpeak();
      this.closeSiblingAt(indent);
      const last = this.out[this.out.length - 1];
      const expectedClose = this.pad() + "}";
      if (last === expectedClose) {
        this.out[this.out.length - 1] = `${this.pad()}} else {`;
      } else {
        this.emit(`${this.pad()}} else {`);
      }
      this.blockStack.push({ rpyCol: indent, type: "else" });
      return;
    }

    // menu:
    if (line === "menu:" || line === "menu :") {
      this.flushSpeak();
      this.closeBlocksAt(indent);
      this.menuPreamble = true;
      this.menuOpen = false;
      this.menuPreambleCol = indent;
      return;
    }

    // "CHOICE" [if CONDITION]:  (inside a menu block, or starting one from preamble)
    // Handles both plain choices and guarded choices: "text" if condition:
    const choiceMatch = line.match(
      /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*(?:if\s+(.*?))?\s*:$/,
    );
    const inMenu =
      this.menuPreamble || this.blockStack.some((b) => b.type === "menu");
    if (choiceMatch && inMenu) {
      this.flushSpeak();

      if (!this.menuOpen) {
        this.menuOpen = true;
        this.menuPreamble = false;
        const col =
          this.menuPreambleCol >= 0
            ? this.menuPreambleCol
            : this.blockStack.length > 0
              ? this.blockStack[this.blockStack.length - 1].rpyCol + 4
              : indent - 4;
        this.blockStack.push({ rpyCol: col, type: "menu" });
        const menuDepth = this.blockStack.length - 1;
        this.emit("  ".repeat(menuDepth) + "menu {");
        this.menuPreambleCol = -1;
      } else {
        this.closeSiblingAt(indent);
      }

      const rawText = choiceMatch[1];
      const rawCond = choiceMatch[2] ?? null;
      const choiceText = this.translate(
        extractPyStr(
          rawText.startsWith("'")
            ? '"' + rawText.slice(1, -1).replace(/"/g, '\\"') + '"'
            : rawText,
        ),
      );
      const condPart = rawCond ? ` if ${normCondition(rawCond)}` : "";
      this.emit(`${this.pad()}"${escStr(choiceText)}"${condPart} => {`);
      this.blockStack.push({ rpyCol: indent, type: "choice" });
      return;
    }

    // ── voice audio.VAR  /  play voice audio.VAR ──────────────────────────────
    // Allow optional whitespace between "audio." and the variable name.
    const voiceMatch = line.match(/^(?:play\s+)?voice\s+audio\.\s*(\w+)/);
    if (voiceMatch) {
      if (this.menuPreamble) return;
      if (this.wouldCloseBlocks(indent)) {
        this.flushSpeak();
        this.closeBlocksAt(indent);
      }
      this.pendingVoice = this.resolveAudio(voiceMatch[1]);
      return;
    }

    // ── CHAR "text" [with TRANS]  or  CHAR"text" (no space) ──────────────────
    // Handles: `t "text"`, `t"text"`, `CHAR "text" with vpunch`, etc.
    // \s* between char key and quote handles both `t "text"` and `t"text"`.
    const dialogMatch = line.match(
      /^([\w]+(?:_[\w]+)*)\s*"((?:[^"\\]|\\.)*)"\s*(?:with\s+\S+)?\s*$/,
    );
    if (dialogMatch) {
      const charKey = dialogMatch[1].trimEnd();
      // Always emit speak using the raw abbreviation as speaker key.
      // The codegen resolves abbr → full name at compile time via the global
      // charMap extracted from script.rrs — no charMap lookup needed here.
      if (this.menuPreamble) return;
      if (this.wouldCloseBlocks(indent)) {
        this.flushSpeak();
        this.closeBlocksAt(indent);
      }
      const rawText = dialogMatch[2];
      const stripped = stripRpyTags(rawText);
      const text = this.translate(stripped);
      const voice = this.pendingVoice;
      this.pendingVoice = null;
      this.addSpeakLine(charKey, text, voice);
      return;
    }

    // ── For all other statements: flush speak buffer then close deeper blocks ──
    this.flushSpeak();
    this.closeBlocksAt(indent);

    // ── $ score_taigabot + 1  (bare expression statements) ──────────────────
    // Python expression statements (no assignment) — skip them.
    if (/^\$\s*\w[\w.]*\s*[+\-*/%]/.test(line) && !line.includes("=")) {
      return;
    }

    // ── $ renpy.jump(VAR) / $ renpy.call(VAR) → dynamic jump/call ────────────
    // Ren'Py minigames (foreplay, journal) use renpy.jump(label_afterforeplay)
    // to return to the caller.  The engine supports dynamic jump: if the target
    // label does not exist it reads state.vars[target] and jumps there instead.
    const rpyJumpMatch = line.match(/^\$\s*renpy\.jump\s*\(\s*(\w+)\s*\)/);
    if (rpyJumpMatch) {
      this.emit(`${this.pad()}jump ${rpyJumpMatch[1]};`);
      return;
    }
    const rpyCallMatch = line.match(/^\$\s*renpy\.call\s*\(\s*(\w+)\s*\)/);
    if (rpyCallMatch) {
      this.emit(`${this.pad()}call ${rpyCallMatch[1]};`);
      return;
    }

    // ── $ renpy.pause(X, ...) → wait(X) ──────────────────────────────────────
    const pauseMatch = line.match(/^\$\s*renpy\.pause\s*\(\s*([\d.]+)/);
    if (pauseMatch) {
      this.emit(`${this.pad()}wait(${fmtFloat(parseFloat(pauseMatch[1]))});`);
      return;
    }
    // renpy.pause with only keyword args (hard=False etc.) → skip
    if (line.match(/^\$\s*renpy\.pause\s*\(/)) {
      return;
    }

    // ── $ renpy.music.stop(..., fadeout=X) ───────────────────────────────────
    const musicStopMatch = line.match(
      /^\$\s*renpy\.music\.stop\s*\(.*?fadeout\s*=\s*([\d.]+)/,
    );
    if (musicStopMatch) {
      const s = fmtFloat(parseFloat(musicStopMatch[1]));
      this.emit(`${this.pad()}music::stop() | fadeout(${s});`);
      return;
    }
    if (line.match(/^\$\s*renpy\.music\.stop\s*\(/)) {
      this.emit(`${this.pad()}music::stop();`);
      return;
    }

    // ── $persistent.routes_completed.append("ROUTE") ─────────────────────────
    const routeMatch = line.match(
      /^\$\s*persistent\.routes_completed\.append\s*\(\s*["'](\w+)["']\s*\)/,
    );
    if (routeMatch) {
      this.emit(`${this.pad()}// route_complete: ${routeMatch[1]};`);
      return;
    }

    // ── play music NAME [fadein X] [loop] ─────────────────────────────────────
    const playMusicMatch = line.match(
      /^play\s+music\s+(\S+)(?:\s+fadein\s+([\d.]+))?(?:\s+loop)?(?:\s+fadein\s+([\d.]+))?/,
    );
    if (playMusicMatch) {
      const varName = playMusicMatch[1];
      const fadein = playMusicMatch[2] ?? playMusicMatch[3];
      const musicArg = varName;
      if (fadein) {
        this.emit(
          `${this.pad()}music::play(${musicArg}) | fadein(${fmtFloat(parseFloat(fadein))});`,
        );
      } else {
        this.emit(`${this.pad()}music::play(${musicArg});`);
      }
      return;
    }

    // ── play sound NAME ───────────────────────────────────────────────────────
    const playSoundMatch = line.match(/^play\s+sound\s+(\S+)/);
    if (playSoundMatch) {
      const sn = playSoundMatch[1];
      this.emit(`${this.pad()}sound::play(${sn});`);
      return;
    }

    // ── play audio NAME [loop] ────────────────────────────────────────────────
    const playAudioMatch = line.match(/^play\s+audio\s+(\S+)/);
    if (playAudioMatch) {
      const an = playAudioMatch[1];
      this.emit(`${this.pad()}sound::play(${an});`);
      return;
    }

    // ── play bgsound / bgsound2 NAME [loop] ───────────────────────────────────
    const playBgsoundMatch = line.match(/^play\s+bgsound2?\s+(\S+)/);
    if (playBgsoundMatch) {
      const bn = playBgsoundMatch[1];
      this.emit(`${this.pad()}music::play(${bn});`);
      return;
    }

    // ── stop music / bgsound / bgsound2 / sound / audio ──────────────────────
    const stopMatch = line.match(
      /^stop\s+(music|bgsound2?|sound|audio)(?:\s+fadeout\s+([\d.]+))?/,
    );
    if (stopMatch) {
      const isSound = stopMatch[1] === "sound" || stopMatch[1] === "audio";
      const fadeout = stopMatch[2];
      if (isSound) {
        this.emit(`${this.pad()}sound::stop();`);
      } else if (fadeout) {
        this.emit(
          `${this.pad()}music::stop() | fadeout(${fmtFloat(parseFloat(fadeout))});`,
        );
      } else {
        this.emit(`${this.pad()}music::stop();`);
      }
      return;
    }

    // ── scene WORDS... [FILTER] [with TRANS] ─────────────────────────────────
    // Unified scene handler: Ren'Py tag+attrs → dot-joined key.
    //   scene cg black with dissolve  → scene cg.black | dissolve;
    //   scene bg_entrance_day sepia   → scene bg_entrance_day sepia;
    //   scene cg arrival1             → scene cg.arrival1;
    if (/^scene\s+/.test(line)) {
      const tail = line.slice("scene".length).trim();
      // Literal quoted path (rare)
      const litM = tail.match(/^("(?:[^"\\]|\\.)*")(?:\s+with\s+(\S+.*))?$/);
      if (litM) {
        const trans = litM[2] ? normTransition(litM[2]) : "";
        const transPart = trans ? ` | ${trans}` : "";
        this.emit(`${this.pad()}scene ${litM[1]}${transPart};`);
        return;
      }
      const { words, at, trans, filter } = Converter.parseShowTail(tail, true);
      if (words.length === 0) {
        this.emit(`${this.pad()}// UNHANDLED scene: ${line}`);
        return;
      }
      const key = Converter.imageKey(words);
      const filterPart = filter ? ` ${filter}` : "";
      const atPart = at ? ` @ ${at}` : "";
      const transPart = trans ? ` | ${trans}` : "";
      this.emit(`${this.pad()}scene ${key}${filterPart}${atPart}${transPart};`);
      return;
    }

    // ── show WORDS... [at POS] [with TRANS] ──────────────────────────────────
    // Unified show handler: Ren'Py tag+attrs → dot-joined key.
    //   show cg arrival2 with dissolve      → show cg.arrival2 | dissolve;
    //   show keitaro_casual at center       → show keitaro_casual @ center;
    //   show keitaro normal1 at center      → show keitaro.normal1 @ center;
    //   show hina sick normal1 at right2    → show hina.sick.normal1 @ right2;
    //   show sx keitaro1 1 with dissolve    → show sx.keitaro1.1 | dissolve;
    // `sepia` appearing between the key words and `at`/`with` is a Ren'Py
    // display filter — it is silently dropped (not part of the image key).
    if (/^show\s+/.test(line)) {
      const tail = line.slice("show".length).trim();
      const { words, at, trans } = Converter.parseShowTail(tail, false);
      // Drop any standalone "sepia" word from the key words (display filter, not part of key)
      const keyWords = words.filter((w) => w !== "sepia");
      if (keyWords.length === 0) {
        this.emit(`${this.pad()}// UNHANDLED show: ${line}`);
        return;
      }
      const key = Converter.imageKey(keyWords);
      const atPart = at ? ` @ ${at}` : "";
      const transPart = trans ? ` | ${trans}` : "";
      this.emit(`${this.pad()}show ${key}${atPart}${transPart};`);
      return;
    }

    // ── hide WORDS... [with TRANS] ────────────────────────────────────────────
    // Unified hide handler: only the TAG (first word) is used.
    // Ren'Py hide ignores attributes — `hide keitaro grin1` ≡ `hide keitaro`.
    //   hide keitaro_casual        → hide keitaro_casual;
    //   hide keitaro grin1         → hide keitaro;
    //   hide cg arrival2           → hide cg;
    //   hide hina sick normal1     → hide hina;
    if (/^hide\s+/.test(line)) {
      const tail = line
        .slice("hide".length)
        .trim()
        .replace(/\s+with\s+\S+.*$/, "") // strip optional "with TRANS"
        .trim();
      const tag = tail.split(/\s+/)[0];
      if (tag) {
        this.emit(`${this.pad()}hide ${tag};`);
      }
      return;
    }

    // ── with TRANS (standalone) ───────────────────────────────────────────────
    const withMatch = line.match(/^with\s+(\S+.*)$/);
    if (withMatch) {
      const trans = normTransition(withMatch[1]);
      if (trans) this.emit(`${this.pad()}with ${trans};`);
      return;
    }

    // ── jump LABEL ────────────────────────────────────────────────────────────
    const jumpMatch = line.match(/^jump\s+(\w+)\s*$/);
    if (jumpMatch) {
      this.emit(`${this.pad()}jump ${jumpMatch[1]};`);
      return;
    }

    // ── call LABEL ────────────────────────────────────────────────────────────
    const callMatch = line.match(/^call\s+(\w+)\s*$/);
    if (callMatch) {
      this.emit(`${this.pad()}call ${callMatch[1]};`);
      return;
    }

    // ── return ────────────────────────────────────────────────────────────────
    if (line === "return") {
      return;
    }

    // ── $abbr = Character("Name", ...) → char.abbr = "Name"; ─────────────────
    // Character definitions appear in script.rpy inside  init: / python:  blocks.
    // We translate them into .rrs declarations in the `char` namespace so
    // that script.rrs becomes the single source of truth for speaker names.
    // Story files use `speak k "text"` with no char declarations of their own;
    // the loader reads script.rrs first and passes the resulting charMap to all
    // other files.
    const charDefMatch = line.match(
      /^\$\s*(\w+)\s*=\s*Character\s*\(\s*(['"])([^'"]+)\2/,
    );
    if (charDefMatch) {
      const abbr = charDefMatch[1];
      const fullName = charDefMatch[3];
      // Skip internal / re-used slots that are not real story characters.
      if (abbr !== "narrator" && abbr !== "nvl" && abbr !== "k_foreplay") {
        // "empty" is a placeholder used by the emp (silent narrator) variable;
        // store it as "" so it renders without a nameplate.
        const name = fullName === "empty" ? "" : fullName;
        this.emit(`char.${abbr} = "${name}";`);
      }
      return;
    }

    // ── $ VAR op VALUE (Python assignment) ────────────────────────────────────
    const assignMatch = line.match(
      /^\$\s*([\w.]+)\s*([+\-*/]?=)\s*([\s\S]+?)\s*$/,
    );
    if (assignMatch) {
      const varName = assignMatch[1];
      const op = assignMatch[2];
      const rawVal = assignMatch[3];

      if (
        varName.startsWith("renpy.") ||
        varName.startsWith("persistent.") ||
        varName === "day" ||
        varName === "time" ||
        varName === "location"
      ) {
        return;
      }

      const val = rawVal
        .replace(/\bTrue\b/g, "true")
        .replace(/\bFalse\b/g, "false");

      if (op === "=") {
        this.emit(`${this.pad()}${varName} = ${val};`);
      } else {
        this.emit(`${this.pad()}${varName} ${op} ${val};`);
      }
      return;
    }

    // ── Anything unrecognised: emit as a comment ──────────────────────────────
    this.emit(`${this.pad()}// UNHANDLED: ${line}`);
  }

  // ── Image declaration emitter ────────────────────────────────────────────────

  /**
   * Parse a Ren'Py `image WORDS... = VALUE` line and emit a top-level .rrs
   * declaration using the dot-joined key format:
   *
   *   image cg arrival2 = "CGs/..."      →  image.cg.arrival2 = "CGs/...";
   *   image keitaro_casual = "Spr/..."   →  image.keitaro_casual = "Spr/...";
   *   image keitaro grin1 = "Spr/..."    →  image.keitaro.grin1 = "Spr/...";
   *   image hina sick normal1 = "..."    →  image.hina.sick.normal1 = "...";
   *   image bg_entrance_day = "BGs/..."  →  image.bg_entrance_day = "BGs/...";
   *   image sx keitaro1 1 = "CGs/..."    →  image.sx.keitaro1.1 = "CGs/...";
   *   image taiga_3b_1 = Movie(...)      →  image.taiga_3b_1 = "path.webm";
   *   image lee_sleep sepia = im.Sepia() →  (skipped — filter variant)
   *   image X = Composite(...)           →  (skipped — composite)
   *
   * The key is built by:
   *   1. Taking all words between `image` and `=`
   *   2. Dropping any trailing known filter word (e.g. "sepia")
   *   3. Joining with "." and prepending "image."
   *
   * This mirrors the Ren'Py tag system: spaces become dots.
   */
  private processImageDecl(line: string): void {
    const eqIdx = line.indexOf("=");
    if (eqIdx < 0) return;

    const wordsPart = line.slice("image".length, eqIdx).trim();
    const valuePart = line.slice(eqIdx + 1).trim();

    // Skip Composite(...) — multi-layer images with no single path
    if (valuePart.startsWith("Composite(")) return;

    const rawWords = wordsPart.split(/\s+/).filter((w) => w.length > 0);
    if (rawWords.length === 0) return;

    // Drop trailing known filter words (e.g. "sepia") — these are display
    // filters, not part of the image identity.  The base image is already
    // declared without the filter word and that declaration wins.
    const KNOWN_FILTERS = new Set(["sepia"]);
    const words = [...rawWords];
    if (
      words.length > 1 &&
      KNOWN_FILTERS.has(words[words.length - 1].toLowerCase())
    ) {
      // Strip the trailing filter word so the key becomes the base image name.
      // We still emit the declaration because the base variant may not exist
      // separately (e.g. `image bg_tent_day sepia = im.Sepia("BGs/tent_day.jpg")`
      // is sometimes the only definition for that background).
      words.pop();
    }

    // Build the dot-joined key: "image." + words joined by "."
    const key = "image." + words.join(".");

    // ── Movie(play="PATH.webm") or Movie("PATH.webm", ...) ───────────────────
    // Handles both positional and named-argument forms, with or without extra
    // kwargs like size=(1920,1080) or loop=True.
    const movieM = valuePart.match(
      /^Movie\s*\(\s*(?:play\s*=\s*)?"([^"]+\.webm)"/,
    );
    if (movieM) {
      this.emit(`${key} = "${escStr(movieM[1])}";`);
      return;
    }

    // ── im.Filter("PATH") — image effect wrapper ──────────────────────────────
    const imM = valuePart.match(/^im\.\w+\s*\(\s*"([^"]+)"/);
    if (imM) {
      this.emit(`${key} = "${escStr(imM[1])}";`);
      return;
    }

    // ── "PATH" or "#HEXCOLOR" string literal ──────────────────────────────────
    const strM = valuePart.match(/^"([^"]+)"/);
    if (strM) {
      this.emit(`${key} = "${escStr(strM[1])}";`);
      return;
    }
  }

  private wouldCloseBlocks(indent: number): boolean {
    return (
      this.blockStack.length > 0 &&
      this.blockStack[this.blockStack.length - 1].rpyCol >= indent
    );
  }

  // ── Entry point ─────────────────────────────────────────────────────────────

  /**
   * Pre-process lines to join Ren'Py multi-line string continuations.
   * Ren'Py allows:
   *   k "Some text that
   *      continues here"
   * We join these into a single logical line so the parser sees the whole string.
   * We also strip Windows \r line endings.
   */
  private preprocessLines(lines: string[]): string[] {
    const result: string[] = [];
    let i = 0;
    while (i < lines.length) {
      // Normalize CRLF → LF
      const raw = lines[i].replace(/\r$/, "");
      i++;

      // Check if this line contains an unmatched open quote (unclosed string)
      // Only trigger for lines that look like dialogue: CHAR "text...
      const hasUnclosedString = (() => {
        const t = raw.trim();
        // Must look like a dialogue line: word followed by quote
        if (!/^[\w_]+\s*"/.test(t)) return false;
        let inStr = false;
        let count = 0;
        for (let ci = 0; ci < t.length; ci++) {
          const ch = t[ci];
          if (ch === "\\") {
            ci++;
            continue;
          }
          if (ch === '"') {
            inStr = !inStr;
            if (inStr) count++;
          }
        }
        return inStr; // still inside a string at end of line
      })();

      if (hasUnclosedString) {
        // Collect continuation lines until the string is closed
        let joined = raw.trimEnd();
        while (i < lines.length) {
          const cont = lines[i].replace(/\r$/, "");
          i++;
          const contTrim = cont.trim();
          // Append content (strip leading whitespace from continuation)
          joined += " " + contTrim;
          // Check if string is now closed
          let inStr = false;
          for (let ci = 0; ci < joined.length; ci++) {
            const ch = joined[ci];
            if (ch === "\\") {
              ci++;
              continue;
            }
            if (ch === '"') inStr = !inStr;
          }
          if (!inStr) break;
        }
        result.push(joined);
      } else {
        result.push(raw);
      }
    }
    return result;
  }

  convert(): string {
    this.emit(`// Source: data/${this.filename}`);
    this.emit("");

    // Pre-process to join multi-line strings and normalize line endings
    this.lines = this.preprocessLines(this.lines);

    while (this.pos < this.lines.length) {
      const rawLine = this.lines[this.pos++];
      this.processLine(rawLine);
    }

    this.flushSpeak();

    while (this.blockStack.length > 0) {
      const top = this.blockStack.pop()!;
      if (!(top.type === "menu" && !this.menuOpen)) {
        // Inject stub-exit jump before closing a minigame label at EOF
        if (top.type === "label" && top.labelName) {
          const exitVar = STUB_EXIT_MAP[top.labelName];
          if (exitVar) {
            this.emit(`${this.pad(1)}jump ${exitVar};`);
          }
        }
        this.emit(this.pad() + "}");
      }
      if (top.type === "menu") {
        this.menuOpen = false;
        this.menuPreamble = false;
        this.menuPreambleCol = -1;
      }
    }

    return this.out.join("\n") + "\n";
  }
}

// ── Numeric formatting ────────────────────────────────────────────────────────

function fmtFloat(n: number): string {
  return n === Math.floor(n) ? String(Math.floor(n)) : String(n);
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const HELP = `
rpy2rrs — convert Ren'Py .rpy files to .rrs

USAGE
  bun run rpy2rrs <input> [options]
  bun run tools/rrs/rpy2rrs.ts <input> [options]

INPUT
  A single .rpy file    → convert that file
  A directory path      → convert every *.rpy file inside it
                          (skips known non-story files by default)

OPTIONS
  -o <path>             Output path or output directory
  --manifest            Write manifest.json in the output directory listing all
                        successfully converted story .rrs files
  --script <path>       Path to script.rpy (used for asset + character maps)
  --tl <dir>            Path to tl/chinese directory for Chinese translations
                        (disabled by default; must be explicitly enabled)
  --no-tl               Kept for backward compatibility; translations are now
                        disabled by default
  --skip <name>         Additional filename to skip in directory mode (repeatable)
  --stub-exit <l=v>     When label L closes, inject \`jump v;\`  (repeatable)
                        Example: --stub-exit foreplay=label_afterforeplay
  --dry-run             Parse only, do not write files
  --verbose             Print generated .rrs to stdout
  --game <name>         Game display name written into manifest.json
  --help, -h            Show this message

EXAMPLES
  bun run rpy2rrs /path/to/game/day1.rpy
  bun run rpy2rrs /path/to/game/ -o assets/data/ --manifest
  bun run rpy2rrs /path/to/game/day1.rpy --no-tl   # English output
`;

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (
    rawArgs.length === 0 ||
    rawArgs.includes("--help") ||
    rawArgs.includes("-h")
  ) {
    console.log(HELP);
    process.exit(rawArgs.length === 0 ? 1 : 0);
  }

  let outputArg: string | undefined;
  let tlDir: string | undefined;
  let noTl = false; // kept for backward-compat; no-tl is now the default
  let dryRun = false;
  let verbose = false;
  let writeManifest = false;
  let gameName: string | undefined;
  const extraSkip: string[] = [];
  const positional: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "-o") {
      outputArg = rawArgs[++i];
    } else if (arg === "--tl") {
      tlDir = rawArgs[++i];
    } else if (arg === "--no-tl") {
      noTl = true; // no-op; kept for backward-compat
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--verbose") {
      verbose = true;
    } else if (arg === "--manifest") {
      writeManifest = true;
    } else if (arg === "--game") {
      gameName = rawArgs[++i];
    } else if (arg === "--skip") {
      extraSkip.push(rawArgs[++i]);
    } else if (arg === "--stub-exit") {
      const pair = rawArgs[++i];
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) {
        console.error(
          `--stub-exit requires format label=varName, got: ${pair}`,
        );
        process.exit(1);
      }
      STUB_EXIT_MAP[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    } else if (arg.startsWith("-")) {
      console.error(`Unknown option '${arg}'`);
      process.exit(1);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) {
    console.error("No input specified.  Run with --help for usage.");
    process.exit(1);
  }

  // Build the effective skip set (defaults + any extra --skip args)
  const skipFiles = new Set([...DEFAULT_SKIP_FILES, ...extraSkip]);

  // Determine if -o is a directory
  let outputIsDir = false;
  if (outputArg) {
    if (outputArg.endsWith("/")) {
      outputIsDir = true;
    } else {
      try {
        outputIsDir = (await fsStat(outputArg)).isDirectory();
      } catch {
        outputIsDir = false;
      }
    }
  }

  // Translations are opt-in only: use --tl <dir> to enable.
  // (Auto-detection of tl/chinese has been removed; --no-tl is a no-op now.)
  void noTl;

  // Asset maps are populated per-file from the file's own image/audio declarations
  const maps: AssetMaps = emptyAssetMaps();

  // Gather input files
  const inputFiles: string[] = [];
  for (const p of positional) {
    let st: Awaited<ReturnType<typeof fsStat>>;
    try {
      st = await fsStat(p);
    } catch {
      console.error(`Path not found: ${p}`);
      process.exit(1);
      return;
    }
    if (st.isFile()) {
      inputFiles.push(p);
    } else if (st.isDirectory()) {
      for await (const entry of await opendir(p)) {
        if (entry.isFile() && entry.name.endsWith(".rpy")) {
          // Skip known non-story files in directory mode
          if (skipFiles.has(entry.name)) {
            if (verbose) console.log(`  skip: ${entry.name}`);
            continue;
          }
          inputFiles.push(`${p.replace(/\/$/, "")}/${entry.name}`);
        }
      }
      inputFiles.sort();
    }
  }

  if (inputFiles.length === 0) {
    console.error("No .rpy files found.");
    process.exit(1);
  }

  let succeeded = 0;
  let failed = 0;
  // Track successfully converted story files for manifest
  const manifestEntries: string[] = [];

  // Character definitions are now emitted inline by processLine() when it
  // encounters  $abbr = Character("Name", ...)  in script.rpy.  The resulting
  // script.rrs is the single source of truth; the runtime loader reads it
  // first and passes the extracted charMap to all other files.
  // No two-pass strategy is needed here — every file is converted in one go.
  for (const inputPath of inputFiles) {
    const baseName = inputPath
      .split("/")
      .pop()!
      .replace(/\.rpy$/, ".rrs");

    let outPath: string;
    if (outputIsDir && outputArg) {
      outPath = `${outputArg.replace(/\/$/, "")}/${baseName}`;
    } else if (outputArg && !outputIsDir) {
      outPath = outputArg;
    } else {
      outPath = inputPath.replace(/\.rpy$/, ".rrs");
    }

    const result = await convertFile(inputPath, outPath, maps, {
      dryRun,
      verbose,
      tlDir,
    });

    if (result.ok) {
      succeeded++;
      // Only add to manifest if the output contains a label (story content)
      if (result.hasLabels) {
        manifestEntries.push(baseName);
      }
    } else {
      failed++;
    }
  }

  if (inputFiles.length > 1) {
    const summary = `\n${succeeded} succeeded, ${failed} failed`;
    console.log(
      failed > 0 ? `\x1b[31m${summary}\x1b[0m` : `\x1b[32m${summary}\x1b[0m`,
    );
  }

  // ── Write manifest.json ────────────────────────────────────────────────────
  if (writeManifest && manifestEntries.length > 0) {
    const manifestDir =
      outputIsDir && outputArg
        ? outputArg.replace(/\/$/, "")
        : positional[0].replace(/\/$/, "");

    const manifestPath = `${manifestDir}/manifest.json`;
    // Manifest always includes start:"start" (Ren'Py convention).
    // The game name is optional.
    const sortedEntries = manifestEntries.sort();
    const manifestObj: Record<string, unknown> = {
      start: "start",
      files: sortedEntries,
    };
    if (gameName) manifestObj.game = gameName;
    const manifestContent = JSON.stringify(manifestObj, null, 2) + "\n";

    if (!dryRun) {
      try {
        // Ensure the output directory exists
        await mkdir(manifestDir, { recursive: true });
        await writeFile(manifestPath, manifestContent, "utf-8");
        console.log(
          `\x1b[32m✓\x1b[0m manifest.json → ${manifestPath}  (${manifestEntries.length} files)`,
        );
      } catch (e) {
        console.error(
          `✗ manifest.json: Cannot write '${manifestPath}': ${e instanceof Error ? e.message : e}`,
        );
      }
    } else {
      console.log(
        `✓ [dry-run] manifest.json → ${manifestPath}  (${manifestEntries.length} files)`,
      );
    }
  }

  if (failed > 0) process.exit(1);
}

interface ConvertResult {
  ok: boolean;
  hasLabels: boolean;
}

async function convertFile(
  inputPath: string,
  outputPath: string,
  maps: AssetMaps,
  opts: {
    dryRun: boolean;
    verbose: boolean;
    tlDir?: string;
  },
  skipFiles?: Set<string>,
): Promise<ConvertResult> {
  // If this is script.rpy, we still convert it (for label start etc.) — it is
  // no longer unconditionally skipped.
  void skipFiles; // reserved for future per-file skip logic
  const t0 = performance.now();

  let src: string;
  try {
    src = await readFile(inputPath, "utf-8");
  } catch (e) {
    console.error(
      `✗ ${inputPath}: Cannot read: ${e instanceof Error ? e.message : e}`,
    );
    return { ok: false, hasLabels: false };
  }

  const sourceBaseName = inputPath
    .split("/")
    .pop()!
    .replace(/\.rpy$/, "");
  const filename = sourceBaseName + ".rrs";
  const lines = src.split("\n");

  // The Converter no longer uses prefix-based asset maps (bg/cg/sx/misc).
  // All image declarations are emitted as dot-keyed image.* defines by
  // processImageDecl(), and show/scene/hide commands use the unified
  // Ren'Py tag system.  Only the charMap and tl map are still needed.
  let effectiveMaps: AssetMaps = { ...maps };
  if (opts.tlDir) {
    const tl = await loadChineseTranslationsForFile(opts.tlDir, sourceBaseName);
    effectiveMaps = { ...effectiveMaps, tl };
  }

  const converter = new Converter(lines, effectiveMaps, filename);
  let result: string;
  try {
    result = converter.convert();
  } catch (e) {
    console.error(
      `✗ ${inputPath}: Conversion error: ${e instanceof Error ? e.message : e}`,
    );
    if (e instanceof Error && e.stack) console.error(e.stack);
    return { ok: false, hasLabels: false };
  }

  const elapsed = (performance.now() - t0).toFixed(1);
  const hasLabels = /\blabel\s+\w/.test(result);

  if (opts.verbose) console.log(result);

  if (opts.dryRun) {
    console.log(`✓ [dry-run] ${inputPath}  →  ${outputPath}  (${elapsed}ms)`);
    return { ok: true, hasLabels };
  }

  // Ensure the output directory exists
  const outDir = outputPath.replace(/\/[^/]+$/, "");
  if (outDir && outDir !== outputPath) {
    try {
      await mkdir(outDir, { recursive: true });
    } catch {
      // ignore if already exists
    }
  }

  try {
    await writeFile(outputPath, result, "utf-8");
  } catch (e) {
    console.error(
      `✗ ${inputPath}: Cannot write '${outputPath}': ${e instanceof Error ? e.message : e}`,
    );
    return { ok: false, hasLabels: false };
  }

  const lineCount = result.split("\n").length;
  console.log(
    `\x1b[32m✓\x1b[0m ${inputPath}  →  ${outputPath}  (${lineCount} lines, ${elapsed}ms)`,
  );
  return { ok: true, hasLabels };
}

main();
