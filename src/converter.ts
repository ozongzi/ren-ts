// ── converter.ts ──────────────────────────────────────────────────────────────
//
// Browser-compatible Ren'Py → .rrs converter.
//
// This module contains the core conversion logic extracted from
// tools/rrs/rpy2rrs.ts, rewritten to depend only on standard TypeScript
// (no Deno APIs).  It can be imported by:
//   - The React UI (ConvertScreen.tsx) for in-browser conversion
//   - Any bundler-based entry point that needs the conversion logic
//
// For full batch conversion with asset-map resolution, use the CLI tool:
//   deno task rpy2rrs /path/to/game/ -o assets/data/ --manifest
//
// ─────────────────────────────────────────────────────────────────────────────

// ── Public types ──────────────────────────────────────────────────────────────

export interface AssetMaps {
  /** audio.VAR → resolved file path */
  audio: Map<string, string>;
  /** bg_NAME → file path */
  bg: Map<string, string>;
  /** cg_NAME → file path */
  cg: Map<string, string>;
  /** sfx_NAME → file path */
  sx: Map<string, string>;
  /** misc_NAME → file path */
  misc: Map<string, string>;
  /** character abbreviation → full name */
  charMap: Map<string, string>;
  /** optional dialogue translation map */
  tl?: Map<string, string>;
}

// ── Translation block parser ───────────────────────────────────────────────────

/**
 * Parse a Ren'Py translation `.rpy` file (e.g. `tl/chinese/day1.rpy`) and
 * extract a map of English original text → translated text.
 *
 * Handles both the `old/new` block style and the comment-based style used
 * in different versions of Ren'Py.
 *
 * @param content  Full text content of the translation .rpy file
 * @returns        Map<originalText, translatedText>
 */
export function parseTranslationBlocks(content: string): Map<string, string> {
  const out = new Map<string, string>();
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

        // Blank line ends the block only if we already found the English text
        if (!inner) {
          if (englishText !== null) break;
          i++;
          continue;
        }

        // Non-indented line means we've left the block
        if (
          innerRaw.length > 0 &&
          innerRaw[0] !== " " &&
          innerRaw[0] !== "\t"
        ) {
          break;
        }

        // Comment lines — may encode the original English text
        if (inner.startsWith("#")) {
          if (!inner.match(/^#\s+voice\b/)) {
            const cm = inner.match(
              /^#\s+[\w_]+\s+"((?:[^"\\]|\\.)*)"\s*(?:with\s+\S+)?\s*$/,
            );
            if (cm) englishText = cm[1];
          }
          i++;
          continue;
        }

        // voice audio.xxx — skip
        if (/^voice\s+audio\./.test(inner)) {
          i++;
          continue;
        }

        // old/new style
        if (inner.startsWith("old ") || inner.startsWith("new ")) {
          const om = inner.match(/^old\s+"((?:[^"\\]|\\.)*)"\s*$/);
          if (om) {
            englishText = om[1];
            i++;
            continue;
          }
          const nm = inner.match(/^new\s+"((?:[^"\\]|\\.)*)"\s*$/);
          if (nm && englishText !== null) {
            chineseText = nm[1];
            if (!out.has(englishText)) out.set(englishText, chineseText);
            englishText = null;
            chineseText = null;
            i++;
            continue;
          }
          i++;
          continue;
        }

        // Speaker "translated text"  — the Chinese line
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
        if (!out.has(englishText)) out.set(englishText, chineseText);
      }
    } else {
      i++;
    }
  }

  return out;
}

export interface ConversionResult {
  /** Converted .rrs source text */
  rrs: string;
  /** true if the output contains at least one label block */
  hasLabels: boolean;
  /** base name of the source file (without extension) */
  baseName: string;
  /** number of source lines processed */
  lineCount: number;
  /** warnings accumulated during conversion */
  warnings: string[];
}

/** Manifest written alongside the converted files */
export interface Manifest {
  start: string;
  game?: string;
  files: string[];
}

export function emptyAssetMaps(): AssetMaps {
  return {
    audio: new Map(),
    bg: new Map(),
    cg: new Map(),
    sx: new Map(),
    misc: new Map(),
    charMap: new Map(),
  };
}

// ── Parse script.rpy content (in-memory) to extract asset + char maps ─────────

/**
 * Parse the text content of a Ren'Py `script.rpy` (or similar file) and
 * return populated AssetMaps.  This is the browser equivalent of
 * `loadAssetMaps()` in rpy2rrs.ts.
 */
export function parseAssetMaps(scriptRpyText: string): AssetMaps {
  const audio = new Map<string, string>();
  const bg = new Map<string, string>();
  const cg = new Map<string, string>();
  const sx = new Map<string, string>();
  const misc = new Map<string, string>();
  const charMap = new Map<string, string>();

  for (const line of scriptRpyText.split("\n")) {
    const trimmed = line.trim();

    // define audio.VAR = "PATH"
    const audioMatch = trimmed.match(/^define\s+audio\.(\w+)\s*=\s*"([^"]+)"/);
    if (audioMatch) {
      audio.set(audioMatch[1], audioMatch[2]);
      continue;
    }

    // Character definitions — four forms found in the wild:
    //   define abbr = Character("Name", ...)       standard Ren'Py define
    //   define $abbr = Character("Name", ...)      dollar-prefixed define
    //   $abbr = Character("Name", ...)             Python assignment (init block)
    //   $ abbr = Character("Name", ...)            Python assignment with space
    const charMatch = trimmed.match(
      /^(?:define\s+\$?|\$\s*)(\w+)\s*=\s*Character\s*\(\s*(?:_\()?(['"])([^"']+)\2/,
    );
    if (charMatch) {
      const abbr = charMatch[1];
      const fullName = charMatch[3];
      if (abbr !== "narrator" && abbr !== "nvl" && abbr !== "k_foreplay") {
        charMap.set(abbr, fullName === "empty" ? "" : fullName);
      }
      continue;
    }

    // image bg NAME = "PATH"
    const bgMatch = trimmed.match(
      /^image\s+bg\s+([\w_]+(?:\s+[\w_]+)*)\s*=\s*"([^"]+)"/,
    );
    if (bgMatch) {
      const bgKey = "bg_" + bgMatch[1].replace(/\s+/g, "_");
      bg.set(bgKey, normAssetPath(bgMatch[2]));
      continue;
    }

    // image cg NAME = "PATH" (space-separated CG name)
    const cgSpaceMatch = trimmed.match(
      /^image\s+(cg[\w_]*(?:\s+[\w_]+)*)\s*=\s*"([^"]+)"/,
    );
    if (cgSpaceMatch) {
      const cgKey = cgSpaceMatch[1].replace(/\s+/g, "_");
      cg.set(cgKey, normAssetPath(cgSpaceMatch[2]));
      continue;
    }

    // image sfx/sx NAME = "PATH"
    const sxMatch = trimmed.match(
      /^image\s+(sfx|sx)\s+([\w_]+)\s*=\s*"([^"]+)"/i,
    );
    if (sxMatch) {
      sx.set(sxMatch[2], normAssetPath(sxMatch[3]));
      continue;
    }

    // generic image NAME = "PATH"
    const miscMatch = trimmed.match(
      /^image\s+([\w_]+(?:\s+[\w_]+)*)\s*=\s*"([^"]+\.(?:png|jpg|jpeg|webp))"/i,
    );
    if (miscMatch) {
      const key = miscMatch[1].replace(/\s+/g, "_");
      misc.set(key, normAssetPath(miscMatch[2]));
      continue;
    }
  }

  return { audio, bg, cg, sx, misc, charMap };
}

// ── Convert a single .rpy file ────────────────────────────────────────────────

/**
 * Convert the text of a single `.rpy` file to `.rrs`.
 *
 * @param rpyText   Full text content of the .rpy source file
 * @param fileName  Base name used in the `// Source:` comment (e.g. "day1.rpy")
 * @param maps      Asset + character maps (use emptyAssetMaps() for a quick
 *                  conversion without path resolution)
 * @param stubExitMap  Optional map of label → jump-target for stub exits
 */
export function convertRpyText(
  rpyText: string,
  fileName: string,
  maps: AssetMaps,
  stubExitMap: Record<string, string> = {},
): ConversionResult {
  const lines = rpyText.split(/\r?\n/);
  const warnings: string[] = [];
  const converter = new Converter(lines, maps, fileName, stubExitMap, warnings);
  const rrs = converter.convert();
  const hasLabels = /\blabel\s+\w+\s*\{/.test(rrs);
  const baseName = fileName.replace(/\.[^.]+$/, "");
  return { rrs, hasLabels, baseName, lineCount: lines.length, warnings };
}

/**
 * Build a `manifest.json` object from a list of successfully converted files.
 */
export function buildManifest(
  fileNames: string[],
  opts?: { start?: string; game?: string },
): Manifest {
  return {
    start: opts?.start ?? "start",
    ...(opts?.game ? { game: opts.game } : {}),
    files: fileNames,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function normAssetPath(p: string): string {
  if (p.startsWith("images/")) p = p.slice("images/".length);
  if (p.startsWith("Bgs/")) p = "BGs/" + p.slice("Bgs/".length);
  return p;
}

function normTransition(raw: string): string {
  const t = raw.trim();
  if (/^[Dd]issolve\s*\(/.test(t)) return "dissolve";
  if (t === "dissolve") return "dissolve";
  if (t === "fade") return "fade";
  if (t === "Fade" || /^Fade\s*\(/.test(t)) return "fade";
  if (/^flash/i.test(t)) return "flash";
  if (t === "None") return "";
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

function escStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function stripRpyTags(s: string): string {
  return s.replace(/\{[^{}]*\}/g, "").trim();
}

function normCondition(cond: string): string {
  return cond
    .trim()
    .replace(/(\w)\.([\w_])/g, (_m, a, b) => `${a} . ${b}`)
    .replace(/\band\b/g, "&&")
    .replace(/\bor\b/g, "||")
    .replace(/\bnot\s+/g, "! ");
}

function extractPyStr(raw: string): string {
  const m = raw.match(/^(['"])([\s\S]*?)\1$/);
  return m ? m[2] : raw;
}

function fmtSpeaker(name: string): string {
  if (/[^A-Za-z0-9_]/.test(name)) return `"${name}"`;
  return name;
}

function fmtFloat(n: number): string {
  return n === Math.floor(n) ? String(Math.floor(n)) : String(n);
}

function getIndent(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) {
    i += line[i] === "\t" ? 4 : 1;
  }
  return i;
}

// ── Block stack tracking ──────────────────────────────────────────────────────

interface BlockInfo {
  type: "label" | "if" | "elif" | "else" | "menu" | "choice";
  rpyCol: number;
  labelName?: string;
}

interface SpeakLine {
  text: string;
  voice?: string;
}

interface SpeakBuffer {
  who: string;
  lines: SpeakLine[];
}

// ── Converter class ───────────────────────────────────────────────────────────

class Converter {
  private lines: string[];
  private pos = 0;
  private out: string[] = [];
  private blockStack: BlockInfo[] = [];
  private pendingVoice: string | null = null;
  private speakBuf: SpeakBuffer | null = null;

  private menuPreamble = false;
  private menuOpen = false;
  private menuPreambleCol = -1;

  constructor(
    lines: string[],
    private readonly maps: AssetMaps,
    private readonly filename: string,
    private readonly stubExitMap: Record<string, string>,
    private readonly warnings: string[],
  ) {
    this.lines = lines;
  }

  private translate(text: string): string {
    return this.maps.tl?.get(text) ?? text;
  }

  private depth(): number {
    return this.blockStack.length;
  }

  private pad(extra = 0): string {
    return "  ".repeat(this.depth() + extra);
  }

  private emit(line: string): void {
    this.out.push(line);
  }

  private closeBlocksAt(targetIndent: number): void {
    while (this.blockStack.length > 0) {
      const top = this.blockStack[this.blockStack.length - 1];
      if (top.rpyCol < targetIndent) break;
      this.blockStack.pop();
      if (!(top.type === "menu" && !this.menuOpen)) {
        if (top.type === "label" && top.labelName) {
          const exitVar = this.stubExitMap[top.labelName];
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
  }

  private closeSiblingAt(targetIndent: number): void {
    while (this.blockStack.length > 0) {
      const top = this.blockStack[this.blockStack.length - 1];
      if (top.rpyCol < targetIndent) break;
      if (top.rpyCol === targetIndent) {
        if (top.type === "if" || top.type === "elif" || top.type === "else") {
          this.blockStack.pop();
          this.emit(this.pad() + "}");
          break;
        }
      }
      this.blockStack.pop();
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

  private flushSpeak(): void {
    if (!this.speakBuf) return;
    const { who, lines } = this.speakBuf;
    this.speakBuf = null;
    const sp = fmtSpeaker(who);
    if (lines.length === 1 && !lines[0].voice) {
      this.emit(`${this.pad()}speak ${sp} "${escStr(lines[0].text)}";`);
    } else if (lines.length === 1 && lines[0].voice) {
      this.emit(
        `${this.pad()}speak ${sp} "${escStr(lines[0].text)}" | "${lines[0].voice}";`,
      );
    } else {
      this.emit(`${this.pad()}speak ${sp} {`);
      for (const l of lines) {
        if (l.voice) {
          this.emit(`${this.pad(1)}"${escStr(l.text)}" | "${l.voice}";`);
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

  private resolveAudio(key: string): string {
    return this.maps.audio.get(key) ?? key;
  }

  private resolveBg(key: string): string | null {
    return this.maps.bg.get(key) ?? null;
  }

  private resolveCg(key: string): string | null {
    return this.maps.cg.get(key) ?? null;
  }

  private resolveSx(key: string): string | null {
    const underKey = key.startsWith("sx_") ? key : "sx_" + key;
    return this.maps.sx.get(underKey) ?? this.maps.sx.get(key) ?? null;
  }

  private resolveBareName(name: string): string | null {
    const bgPath = this.maps.bg.get("bg_" + name);
    if (bgPath) return bgPath;
    const cgPath = this.resolveCg("cg_" + name);
    if (cgPath) return cgPath;
    return this.maps.misc.get(name) ?? null;
  }

  private peekNextFaceLine(charBase: string, fromIdx: number): number {
    for (let i = fromIdx; i < Math.min(fromIdx + 3, this.lines.length); i++) {
      const l = this.lines[i].trim();
      const m = l.match(
        /^show\s+(\w+)\s+(\w+)(?:\s+sepia)?(?:\s+at\s+(\S+))?(?:\s+with\s+(\S+.*))?$/,
      );
      if (m && m[1] === charBase) return i;
    }
    return -1;
  }

  private wouldCloseBlocks(indent: number): boolean {
    for (let i = this.blockStack.length - 1; i >= 0; i--) {
      if (this.blockStack[i].rpyCol >= indent) return true;
    }
    return false;
  }

  private processLine(rawLine: string): void {
    const indent = getIndent(rawLine);
    let line = rawLine.trim();

    // ── Blank / comment ───────────────────────────────────────────────────────
    if (!line || line.startsWith("#")) return;

    // Strip inline Ren'Py comments: find # not inside a string
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

    // ── Statements we always skip ─────────────────────────────────────────────
    if (
      line.startsWith("$renpy.free_memory") ||
      line.startsWith("$ renpy.free_memory") ||
      line.startsWith("$persistent.sx_unlocked") ||
      line.startsWith("$ persistent.sx_unlocked") ||
      line.startsWith("show screen ") ||
      line.startsWith("hide screen ") ||
      line.startsWith("$shuffle_menu") ||
      line.startsWith("$ shuffle_menu") ||
      line === "window hide" ||
      line === "window show" ||
      (line.startsWith("image ") &&
        (line.includes(" = Movie(") || line.includes(' = "'))) ||
      line.startsWith("define ") ||
      line === "init:" ||
      line.startsWith("init ") ||
      line.startsWith("default ") ||
      line.startsWith("python:") ||
      /^(zoom|xalign|yalign|xpos|ypos|alpha|ease|linear)\s/.test(line) ||
      line.match(/^\$\s*working\s*=/) !== null ||
      line.match(/^\$\s*time_transition_\w+\s*\(/) !== null ||
      line.match(/^\$\s*renpy\.save_persistent\s*\(/) !== null ||
      line.match(/^\$\s*renpy\.movie_cutscene\s*\(/) !== null
    ) {
      return;
    }

    // ── label NAME: ──────────────────────────────────────────────────────────
    const labelMatch = line.match(/^label\s+([\w.]+)\s*(?:\(.*\))?\s*:/);
    if (labelMatch) {
      this.flushSpeak();
      this.closeBlocksAt(indent);
      const labelName = labelMatch[1];
      this.blockStack.push({ type: "label", rpyCol: indent, labelName });
      this.emit(`label ${labelName} {`);
      return;
    }

    // ── if COND: ─────────────────────────────────────────────────────────────
    const ifMatch = line.match(/^if\s+(.*?)\s*:$/);
    if (ifMatch) {
      this.flushSpeak();
      this.closeBlocksAt(indent);
      this.blockStack.push({ type: "if", rpyCol: indent });
      this.emit(`${this.pad()}if ${normCondition(ifMatch[1])} {`);
      return;
    }

    // ── elif COND: ───────────────────────────────────────────────────────────
    const elifMatch = line.match(/^elif\s+(.*?)\s*:$/);
    if (elifMatch) {
      this.flushSpeak();
      const last = this.blockStack[this.blockStack.length - 1];
      const expectedClose =
        last &&
        (last.type === "if" || last.type === "elif") &&
        last.rpyCol === indent;
      if (expectedClose) {
        this.blockStack.pop();
        this.emit(this.pad() + "}");
      } else {
        this.closeSiblingAt(indent);
      }
      this.blockStack.push({ type: "elif", rpyCol: indent });
      this.emit(`${this.pad()}elif ${normCondition(elifMatch[1])} {`);
      return;
    }

    // ── else: ────────────────────────────────────────────────────────────────
    if (/^else\s*:/.test(line)) {
      this.flushSpeak();
      const last = this.blockStack[this.blockStack.length - 1];
      const expectedClose =
        last &&
        (last.type === "if" || last.type === "elif") &&
        last.rpyCol === indent;
      if (expectedClose) {
        this.blockStack.pop();
        this.emit(this.pad() + "}");
      } else {
        this.closeSiblingAt(indent);
      }
      this.blockStack.push({ type: "else", rpyCol: indent });
      this.emit(`${this.pad()}else {`);
      return;
    }

    // ── menu: ────────────────────────────────────────────────────────────────
    if (/^menu\s*:/.test(line)) {
      this.flushSpeak();
      if (this.wouldCloseBlocks(indent)) this.closeBlocksAt(indent);
      this.blockStack.push({ type: "menu", rpyCol: indent });
      this.menuPreamble = true;
      this.menuOpen = false;
      this.menuPreambleCol = indent;
      return;
    }

    // ── "CHOICE": [if COND] ──────────────────────────────────────────────────
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
        this.blockStack.push({ type: "menu", rpyCol: col });
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
      this.blockStack.push({ type: "choice", rpyCol: indent });
      return;
    }

    // ── voice audio.VAR  /  play voice audio.VAR ──────────────────────────────
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

    // ── voice "literal_path" ─────────────────────────────────────────────────
    const voiceLitMatch = line.match(/^(?:play\s+)?voice\s+"([^"]+)"/);
    if (voiceLitMatch) {
      if (this.menuPreamble) return;
      if (this.wouldCloseBlocks(indent)) {
        this.flushSpeak();
        this.closeBlocksAt(indent);
      }
      this.pendingVoice = voiceLitMatch[1];
      return;
    }

    // ── CHAR "text" ──────────────────────────────────────────────────────────
    const dialogMatch = line.match(
      /^([\w]+(?:_[\w]+)*)\s*"((?:[^"\\]|\\.)*)"\s*(?:with\s+\S+)?\s*$/,
    );
    if (dialogMatch) {
      const charKey = dialogMatch[1].trimEnd();
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

    // For all other statements: flush speak buffer then close deeper blocks
    this.flushSpeak();
    this.closeBlocksAt(indent);

    // ── $ abbr = Character("Name", ...) → define abbr = "Name"; ─────────────
    const charDefMatch = line.match(
      /^\$\s*(\w+)\s*=\s*Character\s*\(\s*(['"])([^'"]+)\2/,
    );
    if (charDefMatch) {
      const abbr = charDefMatch[1];
      const fullName = charDefMatch[3];
      if (abbr !== "narrator" && abbr !== "nvl" && abbr !== "k_foreplay") {
        const name = fullName === "empty" ? "" : fullName;
        this.emit(`define ${abbr} = "${name}";`);
      }
      return;
    }

    // ── $ score_X + 1  (bare expression statements, no assignment) ───────────
    if (/^\$\s*\w[\w.]*\s*[+\-*/%]/.test(line) && !line.includes("=")) {
      return;
    }

    // ── $ renpy.jump(VAR) / $ renpy.call(VAR) → dynamic jump/call ────────────
    const rpyDynJump = line.match(/^\$\s*renpy\.jump\s*\(\s*(\w+)\s*\)/);
    if (rpyDynJump) {
      this.emit(`${this.pad()}jump ${rpyDynJump[1]};`);
      return;
    }
    const rpyDynCall = line.match(/^\$\s*renpy\.call\s*\(\s*(\w+)\s*\)/);
    if (rpyDynCall) {
      this.emit(`${this.pad()}call ${rpyDynCall[1]};`);
      return;
    }

    // ── $ renpy.pause(X) → wait(X) ───────────────────────────────────────────
    const rpyPause = line.match(/^\$\s*renpy\.pause\s*\(\s*([\d.]+)/);
    if (rpyPause) {
      this.emit(`${this.pad()}wait(${fmtFloat(parseFloat(rpyPause[1]))});`);
      return;
    }
    if (/^\$\s*renpy\.pause\s*\(/.test(line)) return; // keyword-args only → skip

    // ── $ renpy.music.stop(...) ───────────────────────────────────────────────
    const rpyMusicStop = line.match(
      /^\$\s*renpy\.music\.stop\s*\(.*?fadeout\s*=\s*([\d.]+)/,
    );
    if (rpyMusicStop) {
      this.emit(
        `${this.pad()}music::stop() | fadeout(${fmtFloat(parseFloat(rpyMusicStop[1]))});`,
      );
      return;
    }
    if (/^\$\s*renpy\.music\.stop\s*\(/.test(line)) {
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

    // ── jump LABEL ───────────────────────────────────────────────────────────
    const rpyJumpMatch = line.match(/^jump\s+(\w+)\s*$/);
    if (rpyJumpMatch) {
      this.emit(`${this.pad()}jump ${rpyJumpMatch[1]};`);
      return;
    }

    // ── call LABEL ───────────────────────────────────────────────────────────
    const rpyCallMatch = line.match(/^call\s+(\w+)\s*$/);
    if (rpyCallMatch) {
      this.emit(`${this.pad()}call ${rpyCallMatch[1]};`);
      return;
    }

    // ── return ───────────────────────────────────────────────────────────────
    if (line === "return") return;

    // ── pause N ──────────────────────────────────────────────────────────────
    const pauseMatch = line.match(/^pause\s+([\d.]+)/);
    if (pauseMatch) {
      this.emit(`${this.pad()}wait(${fmtFloat(parseFloat(pauseMatch[1]))});`);
      return;
    }

    // ── play music NAME [fadein X] [loop] ─────────────────────────────────────
    const playMusicMatch = line.match(
      /^play\s+music\s+(\S+)(?:\s+fadein\s+([\d.]+))?(?:\s+loop)?(?:\s+fadein\s+([\d.]+))?/,
    );
    if (playMusicMatch) {
      const varName = playMusicMatch[1];
      const fadein = playMusicMatch[2] ?? playMusicMatch[3];
      const path = this.resolveAudio(varName);
      if (fadein) {
        this.emit(
          `${this.pad()}music::play("${escStr(path)}") | fadein(${fmtFloat(parseFloat(fadein))});`,
        );
      } else {
        this.emit(`${this.pad()}music::play("${escStr(path)}");`);
      }
      return;
    }

    // ── play audio NAME [loop] ────────────────────────────────────────────────
    const playAudioMatch = line.match(/^play\s+audio\s+(\S+)/);
    if (playAudioMatch) {
      this.emit(
        `${this.pad()}sound::play("${escStr(this.resolveAudio(playAudioMatch[1]))}");`,
      );
      return;
    }

    // ── play sound NAME ───────────────────────────────────────────────────────
    const playSoundMatch = line.match(/^play\s+sound\s+(\S+)/);
    if (playSoundMatch) {
      this.emit(
        `${this.pad()}sound::play("${escStr(this.resolveAudio(playSoundMatch[1]))}");`,
      );
      return;
    }

    // ── play bgsound / bgsound2 NAME ─────────────────────────────────────────
    const playBgsoundMatch = line.match(/^play\s+bgsound2?\s+(\S+)/);
    if (playBgsoundMatch) {
      this.emit(
        `${this.pad()}music::play("${escStr(this.resolveAudio(playBgsoundMatch[1]))}");`,
      );
      return;
    }

    // ── stop music / bgsound / bgsound2 / sound / audio [fadeout N] ──────────
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

    // ── scene cg black / white / NAME [with TRANS] ────────────────────────────
    const sceneCgMatch = line.match(
      /^scene\s+cg\s+(\S+?)(?::)?(?:\s+with\s+(\S+.*))?$/,
    );
    if (sceneCgMatch) {
      const cgName = sceneCgMatch[1].replace(/:$/, "");
      const trans = sceneCgMatch[2] ? normTransition(sceneCgMatch[2]) : "";
      const transPart = trans ? ` | ${trans}` : "";
      if (cgName === "black") {
        this.emit(`${this.pad()}scene #000000${transPart};`);
      } else if (cgName === "white") {
        this.emit(`${this.pad()}scene #ffffff${transPart};`);
      } else {
        const path =
          this.resolveCg("cg_" + cgName) ?? `<UNKNOWN: cg_${cgName}>`;
        if (path.startsWith("#")) {
          this.emit(`${this.pad()}scene ${path}${transPart};`);
        } else {
          this.emit(`${this.pad()}scene "${path}"${transPart};`);
        }
      }
      return;
    }

    // ── scene bg_NAME [modifier] [with TRANS] ─────────────────────────────────
    const sceneBgUnderMatch = line.match(
      /^scene\s+(bg_\S+)(?:\s+(\w+))?(?:\s+with\s+(\S+.*))?$/,
    );
    if (sceneBgUnderMatch) {
      const bgBase = sceneBgUnderMatch[1];
      const modifier = sceneBgUnderMatch[2];
      const transRaw = sceneBgUnderMatch[3];
      const isTransition =
        modifier && /^(dissolve|fade|flash|move|with)$/i.test(modifier);
      const isFilter = modifier && /^(sepia)$/i.test(modifier);
      const bgKey =
        modifier && !isTransition && !isFilter
          ? bgBase + "_" + modifier
          : bgBase;
      const bgPath =
        this.maps.bg.get(bgKey) ??
        (modifier && !isTransition && !isFilter
          ? this.maps.bg.get(bgBase + " " + modifier)
          : undefined) ??
        this.resolveBg(bgKey) ??
        `<UNKNOWN: ${bgKey}>`;
      const trans = transRaw
        ? normTransition(transRaw)
        : modifier && isTransition
          ? normTransition(modifier)
          : "";
      const transPart = trans ? ` | ${trans}` : "";
      this.emit(`${this.pad()}scene "${bgPath}"${transPart};`);
      return;
    }

    // ── scene bg NAME [with TRANS]  (space form) ──────────────────────────────
    const sceneBgSpaceMatch = line.match(
      /^scene\s+bg\s+([\w_]+(?:\s+[\w_]+)*)\s*(?:with\s+(\S+))?/,
    );
    if (sceneBgSpaceMatch) {
      const bgBase = "bg_" + sceneBgSpaceMatch[1].trim().replace(/\s+/g, "_");
      const transRaw = sceneBgSpaceMatch[2] ?? "";
      const trans = transRaw ? normTransition(transRaw) : "";
      const transPart = trans ? ` | ${trans}` : "";
      const bgPath = this.resolveBg(bgBase) ?? `<UNKNOWN: ${bgBase}>`;
      this.emit(`${this.pad()}scene "${escStr(bgPath)}"${transPart};`);
      return;
    }

    // ── scene sx NAME... [with TRANS] ─────────────────────────────────────────
    if (/^scene\s+sx\s+/.test(line)) {
      const withIdx = line.indexOf(" with ");
      const afterSx = (withIdx === -1 ? line : line.slice(0, withIdx))
        .replace(/^scene\s+sx\s+/, "")
        .trim();
      const transRaw = withIdx === -1 ? "" : line.slice(withIdx + 6).trim();
      const trans = transRaw ? normTransition(transRaw) : "";
      const transPart = trans ? ` | ${trans}` : "";
      const lookupKey = afterSx.replace(/\s+/g, "_");
      const sxPath =
        this.maps.sx.get("sx_" + lookupKey) ?? this.maps.sx.get(lookupKey);
      if (sxPath) {
        this.emit(`${this.pad()}scene "${escStr(sxPath)}"${transPart};`);
      } else {
        this.emit(`${this.pad()}expr sx::${lookupKey}${transPart};`);
      }
      return;
    }

    // ── scene sx_NAME FRAME [with TRANS] ──────────────────────────────────────
    const sceneSxUnderMatch = line.match(
      /^scene\s+(sx_\S+)\s+(\d+)(?:\s+with\s+(\S+.*))?$/,
    );
    if (sceneSxUnderMatch) {
      const sxKey = sceneSxUnderMatch[1] + "_" + sceneSxUnderMatch[2];
      const trans = sceneSxUnderMatch[3]
        ? normTransition(sceneSxUnderMatch[3])
        : "";
      const transPart = trans ? ` | ${trans}` : "";
      const sxPath =
        this.maps.sx.get(sxKey) ?? this.maps.sx.get(sceneSxUnderMatch[1]);
      if (sxPath) {
        this.emit(`${this.pad()}scene "${escStr(sxPath)}"${transPart};`);
      } else {
        this.emit(`${this.pad()}expr sx::${sxKey}${transPart};`);
      }
      return;
    }

    // ── scene #COLOUR ─────────────────────────────────────────────────────────
    const sceneColourMatch = line.match(
      /^scene\s+(#[0-9a-fA-F]{3,8})\s*(?:with\s+(\S+))?/,
    );
    if (sceneColourMatch) {
      const trans = sceneColourMatch[2]
        ? normTransition(sceneColourMatch[2])
        : "";
      const transPart = trans ? ` | ${trans}` : "";
      this.emit(`${this.pad()}scene ${sceneColourMatch[1]}${transPart};`);
      return;
    }

    // ── scene "PATH" [with TRANS]  (literal quoted path) ─────────────────────
    const sceneLiteralMatch = line.match(
      /^scene\s+"([^"]+)"\s*(?:with\s+(\S+))?/,
    );
    if (sceneLiteralMatch) {
      const trans = sceneLiteralMatch[2]
        ? normTransition(sceneLiteralMatch[2])
        : "";
      const transPart = trans ? ` | ${trans}` : "";
      this.emit(
        `${this.pad()}scene "${escStr(normAssetPath(sceneLiteralMatch[1]))}"${transPart};`,
      );
      return;
    }

    // ── scene NAME [with TRANS]  (bare name fallback — bg/cg/misc lookup) ─────
    const sceneBareName = line.match(
      /^scene\s+([a-zA-Z][a-zA-Z0-9_]*)(?:\s+with\s+(\S+.*))?$/,
    );
    if (sceneBareName) {
      const name = sceneBareName[1];
      const trans = sceneBareName[2] ? normTransition(sceneBareName[2]) : "";
      const transPart = trans ? ` | ${trans}` : "";
      if (name === "cg_black") {
        this.emit(`${this.pad()}scene #000000${transPart};`);
        return;
      }
      if (name === "cg_white") {
        this.emit(`${this.pad()}scene #ffffff${transPart};`);
        return;
      }
      const resolved = this.resolveBareName(name);
      if (resolved) {
        this.emit(`${this.pad()}scene "${escStr(resolved)}"${transPart};`);
      } else {
        this.emit(`${this.pad()}scene "<UNKNOWN:${name}>"${transPart};`);
      }
      return;
    }

    // ── show sx NAME... [with TRANS] ──────────────────────────────────────────
    if (/^show\s+sx\s+/.test(line)) {
      const withIdx = line.indexOf(" with ");
      const afterSx = (withIdx === -1 ? line : line.slice(0, withIdx))
        .replace(/^show\s+sx\s+/, "")
        .trim();
      const transRaw = withIdx === -1 ? "" : line.slice(withIdx + 6).trim();
      const trans = transRaw ? normTransition(transRaw) : "";
      const transPart = trans ? ` | ${trans}` : "";
      const lookupKey = afterSx.replace(/\s+/g, "_");
      const sxPath =
        this.maps.sx.get("sx_" + lookupKey) ?? this.maps.sx.get(lookupKey);
      if (sxPath) {
        this.emit(`${this.pad()}show sx_${lookupKey}${transPart} {`);
        this.emit(`${this.pad(1)}src: "${escStr(sxPath)}";`);
        this.emit(`${this.pad()}};`);
      } else {
        this.emit(`${this.pad()}expr sx::${lookupKey}${transPart};`);
      }
      return;
    }

    // ── hide sx NAME... ───────────────────────────────────────────────────────
    if (/^hide\s+sx\s+/.test(line)) {
      const afterSx = line.replace(/^hide\s+sx\s+/, "").trim();
      const lookupKey = afterSx.replace(/\s+/g, "_");
      this.emit(`${this.pad()}hide sx_${lookupKey};`);
      return;
    }

    // ── show cg NAME [with TRANS]  (space form) ────────────────────────────────
    const showCgSpaceMatch = line.match(
      /^show\s+cg\s+(\S+?)(?::)?(?:\s+with\s+(\S+.*))?$/,
    );
    if (showCgSpaceMatch) {
      const cgKey = "cg_" + showCgSpaceMatch[1].replace(/:$/, "");
      const cgPath = this.resolveCg(cgKey) ?? `<UNKNOWN: ${cgKey}>`;
      const trans = showCgSpaceMatch[2]
        ? normTransition(showCgSpaceMatch[2])
        : "";
      const transPart = trans ? ` | ${trans}` : "";
      this.emit(`${this.pad()}show ${cgKey}${transPart} {`);
      this.emit(`${this.pad(1)}src: "${escStr(cgPath)}";`);
      this.emit(`${this.pad()}};`);
      return;
    }

    // ── show cg_NAME [at POS] [with TRANS]  (underscore form) ────────────────
    const showCgUnderMatch = line.match(
      /^show\s+(cg_\S+)(?:\s+at\s+(\S+))?(?:\s+with\s+(\S+.*))?$/,
    );
    if (showCgUnderMatch) {
      const cgKey = showCgUnderMatch[1];
      const cgPath = this.resolveCg(cgKey);
      const at = showCgUnderMatch[2] ? ` @ ${showCgUnderMatch[2]}` : "";
      const trans = showCgUnderMatch[3]
        ? normTransition(showCgUnderMatch[3])
        : "";
      const transPart = trans ? ` | ${trans}` : "";
      if (cgPath && !cgPath.includes("<UNKNOWN")) {
        this.emit(`${this.pad()}show ${cgKey}${transPart} {`);
        this.emit(`${this.pad(1)}src: "${escStr(cgPath)}";`);
        this.emit(`${this.pad()}};`);
      } else {
        this.emit(`${this.pad()}show ${cgKey}${at}${transPart};`);
      }
      return;
    }

    // ── show bg_NAME [at POS] [with TRANS] ────────────────────────────────────
    const showBgMatch = line.match(
      /^show\s+(bg_\S+)(?:\s+at\s+(\S+))?(?:\s+with\s+(\S+.*))?$/,
    );
    if (showBgMatch) {
      const bgPath =
        this.resolveBg(showBgMatch[1]) ?? `<UNKNOWN: ${showBgMatch[1]}>`;
      const at = showBgMatch[2] ? ` @ ${showBgMatch[2]}` : "";
      const trans = showBgMatch[3] ? normTransition(showBgMatch[3]) : "";
      const transPart = trans ? ` | ${trans}` : "";
      this.emit(`${this.pad()}show "${escStr(bgPath)}"${at}${transPart};`);
      return;
    }

    // ── show CHAR_BODY [sepia] [at POS] [with TRANS]  (with face lookahead) ───
    const showBodyMatch = line.match(
      /^show\s+(\w+_\w+)(?:\s+sepia)?(?:\s+at\s+(\S+))?(?:\s+with\s+(\S+.*))?$/,
    );
    if (showBodyMatch) {
      const bodyKey = showBodyMatch[1];
      const at = showBodyMatch[2];
      const trans = showBodyMatch[3] ? normTransition(showBodyMatch[3]) : "";
      const charBase = bodyKey.split("_")[0];
      const nextFaceIdx = this.peekNextFaceLine(charBase, this.pos);
      if (nextFaceIdx !== -1) {
        const faceRaw = this.lines[nextFaceIdx];
        const faceLine = faceRaw.trim();
        const faceM = faceLine.match(
          /^show\s+(\w+)\s+(\w+)(?:\s+sepia)?(?:\s+at\s+(\S+))?(?:\s+with\s+(\S+.*))?$/,
        );
        if (faceM) {
          const faceExpr = faceM[2];
          const faceAt = faceM[3] ?? at;
          const faceTrans = faceM[4] ? normTransition(faceM[4]) : trans;
          this.lines[nextFaceIdx] = "";
          const atPart = faceAt ? ` @ ${faceAt}` : "";
          const transPart = faceTrans ? ` | ${faceTrans}` : "";
          this.emit(
            `${this.pad()}show ${bodyKey}::${faceExpr}${atPart}${transPart};`,
          );
          return;
        }
      }
      const atPart = at ? ` @ ${at}` : "";
      const transPart = trans ? ` | ${trans}` : "";
      this.emit(`${this.pad()}show ${bodyKey}${atPart}${transPart};`);
      return;
    }

    // ── show CHAR MODIFIER EXPR [at POS] [with TRANS]  (three-word) ───────────
    const show3WordMatch = line.match(
      /^show\s+(\w+)\s+(\w+)\s+(\w+)(?:\s+at\s+(\S+))?(?:\s+with\s+(\S+.*))?$/,
    );
    if (show3WordMatch) {
      const char = show3WordMatch[1];
      const modifier = show3WordMatch[2];
      const expr = show3WordMatch[3];
      const at = show3WordMatch[4];
      const trans = show3WordMatch[5] ? normTransition(show3WordMatch[5]) : "";
      const atPart = at ? ` @ ${at}` : "";
      const transPart = trans ? ` | ${trans}` : "";
      if (expr === "sepia") {
        this.emit(
          `${this.pad()}show ${char}_${modifier}${atPart}${transPart};`,
        );
      } else {
        this.emit(
          `${this.pad()}expr ${char}_${modifier}::${expr}${atPart}${transPart};`,
        );
      }
      return;
    }

    // ── show CHAR EXPR [sepia] [at POS] [with TRANS]  (two-word face) ─────────
    const showFaceMatch = line.match(
      /^show\s+(\w+)\s+(\w+)(?:\s+sepia)?(?:\s+at\s+(\S+))?(?:\s+with\s+(\S+.*))?$/,
    );
    if (showFaceMatch) {
      const char = showFaceMatch[1];
      const expr = showFaceMatch[2];
      const at = showFaceMatch[3];
      const trans = showFaceMatch[4] ? normTransition(showFaceMatch[4]) : "";
      const atPart = at ? ` @ ${at}` : "";
      const transPart = trans ? ` | ${trans}` : "";
      if (expr === "sepia") {
        this.emit(`${this.pad()}show ${char}${atPart}${transPart};`);
      } else {
        this.emit(`${this.pad()}expr ${char}::${expr}${atPart}${transPart};`);
      }
      return;
    }

    // ── show NAME [with TRANS]  (simple / fallback) ───────────────────────────
    const showSimpleMatch = line.match(/^show\s+(\S+)(?:\s+with\s+(\S+.*))?$/);
    if (showSimpleMatch) {
      const name = showSimpleMatch[1];
      const trans = showSimpleMatch[2]
        ? normTransition(showSimpleMatch[2])
        : "";
      const transPart = trans ? ` | ${trans}` : "";
      this.emit(`${this.pad()}show ${name}${transPart};`);
      return;
    }

    // ── expr CHAR FACE [at POS] [with TRANS]  (rrs-native expr) ──────────────
    const exprMatch = line.match(
      /^expr\s+([\w_]+)\s+([\w_]+)\s*(?:at\s+([\w]+))?\s*(?:with\s+(\S+))?/,
    );
    if (exprMatch) {
      const char = exprMatch[1];
      const face = exprMatch[2];
      const at = exprMatch[3] ?? "";
      const trans = exprMatch[4] ? normTransition(exprMatch[4]) : "";
      const atPart = at ? ` @ ${at}` : "";
      const transPart = trans ? ` | ${trans}` : "";
      this.emit(`${this.pad()}expr ${char}::${face}${atPart}${transPart};`);
      return;
    }

    // ── hide CHAR MODIFIER EXPR [with TRANS]  (three-word) ────────────────────
    const hide3WordMatch = line.match(
      /^hide\s+(\w+)\s+(\w+)\s+(\w+)(?:\s+with\s+\S+)?\s*$/,
    );
    if (hide3WordMatch) {
      const char = hide3WordMatch[1];
      const modifier = hide3WordMatch[2];
      const expr = hide3WordMatch[3];
      if (expr === "sepia") {
        this.emit(`${this.pad()}hide ${char}::${modifier};`);
      } else {
        this.emit(`${this.pad()}hide ${char}_${modifier}::${expr};`);
      }
      return;
    }

    // ── hide CHAR EXPR [sepia] / hide cg NAME / hide bg NAME  (two-word) ──────
    const hide2WordMatch = line.match(
      /^hide\s+(\w+)\s+(\w+)(?:\s+sepia)?(?:\s+with\s+\S+)?\s*$/,
    );
    if (hide2WordMatch) {
      const ns = hide2WordMatch[1];
      const ex = hide2WordMatch[2];
      if (ns === "cg" || ns === "bg") {
        this.emit(`${this.pad()}hide ${ns}_${ex};`);
      } else if (ex === "sepia") {
        this.emit(`${this.pad()}hide ${ns};`);
      } else {
        this.emit(`${this.pad()}hide ${ns}::${ex};`);
      }
      return;
    }

    // ── hide NAME [with TRANS] ────────────────────────────────────────────────
    const hideMatch = line.match(/^hide\s+(\S+)(?:\s+with\s+\S+)?\s*$/);
    if (hideMatch) {
      this.emit(`${this.pad()}hide ${hideMatch[1]};`);
      return;
    }

    // ── with TRANS ───────────────────────────────────────────────────────────
    const withMatch = line.match(/^with\s+(\S+.*)/);
    if (withMatch) {
      const trans = normTransition(withMatch[1]);
      if (trans) this.emit(`${this.pad()}with ${trans};`);
      return;
    }

    // ── $ varName op= value  (Python assignment) → let varName = val ──────────
    const pyAssignMatch = line.match(
      /^\$\s*([\w.]+)\s*([+\-*/]?=)\s*([\s\S]+?)\s*$/,
    );
    if (pyAssignMatch) {
      const varName = pyAssignMatch[1];
      const op = pyAssignMatch[2];
      const rawVal = pyAssignMatch[3];
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
        this.emit(`${this.pad()}let ${varName} = ${val};`);
      } else {
        this.emit(`${this.pad()}${varName} ${op} ${val};`);
      }
      return;
    }

    // ── Unrecognised ──────────────────────────────────────────────────────────
    this.emit(`${this.pad()}// UNHANDLED: ${line}`);
  }

  private preprocessLines(lines: string[]): string[] {
    const result: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const raw = lines[i];
      // Check for unclosed string spanning lines
      const hasUnclosed = (s: string): boolean => {
        let inStr = false;
        let strChar = "";
        let count = 0;
        for (const ch of s) {
          if (!inStr && (ch === '"' || ch === "'")) {
            inStr = true;
            strChar = ch;
            count++;
          } else if (inStr && ch === strChar) {
            inStr = false;
          }
        }
        return inStr;
      };
      if (hasUnclosed(raw) && i + 1 < lines.length) {
        let joined = raw.trimEnd();
        while (i + 1 < lines.length && hasUnclosed(joined)) {
          i++;
          joined = joined + " " + lines[i].trim();
        }
        result.push(joined);
      } else {
        result.push(raw);
      }
      i++;
    }
    return result;
  }

  convert(): string {
    this.emit(`// Source: ${this.filename}`);
    this.emit("");

    // Note: define declarations are emitted inline via charDefMatch in
    // processLine() when `$ abbr = Character("Name", ...)` is encountered —
    // only script.rpy carries those lines, so only script.rrs gets defines.
    // All other files rely on the globalCharMap passed at compile time.

    this.lines = this.preprocessLines(this.lines);

    while (this.pos < this.lines.length) {
      const rawLine = this.lines[this.pos++];
      this.processLine(rawLine);
    }

    this.flushSpeak();

    while (this.blockStack.length > 0) {
      const top = this.blockStack.pop()!;
      if (!(top.type === "menu" && !this.menuOpen)) {
        if (top.type === "label" && top.labelName) {
          const exitVar = this.stubExitMap[top.labelName];
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

// ── Convenience: parse a batch of files ──────────────────────────────────────

export interface BatchInput {
  /** File name (e.g. "day1.rpy") */
  name: string;
  /** Full text content of the file */
  text: string;
}

export interface BatchResult {
  /** Converted files (only those that contained at least one label) */
  files: Array<{ name: string; rrs: string; warnings: string[] }>;
  /** Generated manifest */
  manifest: Manifest;
  /** Files that were skipped (no labels found) */
  skipped: string[];
}

/**
 * Convert a batch of .rpy files to .rrs in the browser.
 *
 * @param inputs       Array of { name, text } for each .rpy file to convert
 * @param scriptText   Optional content of script.rpy for asset/char map extraction
 * @param opts         Optional game name, start label, and per-file translation maps
 */
export function convertBatch(
  inputs: BatchInput[],
  scriptText?: string,
  opts?: {
    game?: string;
    start?: string;
    /** Map of stem (e.g. "day1") → translation Map<english, chinese> */
    translations?: Map<string, Map<string, string>>;
  },
): BatchResult {
  const maps = scriptText ? parseAssetMaps(scriptText) : emptyAssetMaps();

  const files: BatchResult["files"] = [];
  const skipped: string[] = [];

  for (const input of inputs) {
    const stem = input.name.replace(/\.rpy$/i, "");
    const tlMap = opts?.translations?.get(stem);
    const effectiveMaps: AssetMaps = tlMap ? { ...maps, tl: tlMap } : maps;
    const result = convertRpyText(input.text, input.name, effectiveMaps);
    if (!result.hasLabels) {
      skipped.push(input.name);
      continue;
    }
    const rrsName = input.name.replace(/\.rpy$/i, ".rrs");
    files.push({ name: rrsName, rrs: result.rrs, warnings: result.warnings });
  }

  const manifest = buildManifest(
    files.map((f) => f.name),
    { start: opts?.start ?? "start", game: opts?.game },
  );

  return { files, manifest, skipped };
}
