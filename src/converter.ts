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

    // define ABBR = Character("Full Name", ...)
    const charMatch = trimmed.match(
      /^define\s+(\w+)\s*=\s*Character\s*\(\s*(?:_\()?["']([^"']+)["']/,
    );
    if (charMatch) {
      const abbr = charMatch[1];
      const fullName = charMatch[2];
      charMap.set(abbr, fullName);
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
    const miscMatch = trimmed.match(/^image\s+([\w_]+(?:\s+[\w_]+)*)\s*=\s*"([^"]+\.(?:png|jpg|jpeg|webp))"/i);
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
  private charMap: Map<string, string>;
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
    this.charMap = maps.charMap;
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
    // Try exact match, then underscore-prefix variant
    if (this.maps.sx.has(key)) return this.maps.sx.get(key)!;
    const underKey = key.replace(/^sfx_/, "");
    if (this.maps.sx.has(underKey)) return this.maps.sx.get(underKey)!;
    return null;
  }

  private wouldCloseBlocks(indent: number): boolean {
    for (let i = this.blockStack.length - 1; i >= 0; i--) {
      if (this.blockStack[i].rpyCol >= indent) return true;
    }
    return false;
  }

  private processLine(rawLine: string): void {
    // Strip comments
    const indent = getIndent(rawLine);
    let line = rawLine.trim();

    // Strip inline Python comments (but not inside strings)
    {
      let inStr = false;
      let strChar = "";
      let out = "";
      for (let ci = 0; ci < line.length; ci++) {
        const ch = line[ci];
        if (!inStr && (ch === '"' || ch === "'")) {
          inStr = true;
          strChar = ch;
          out += ch;
        } else if (inStr && ch === strChar && line[ci - 1] !== "\\") {
          inStr = false;
          out += ch;
        } else if (!inStr && ch === "#") {
          break;
        } else {
          out += ch;
        }
      }
      line = out.trim();
    }

    if (!line) return;

    // ── label NAME: ──────────────────────────────────────────────────────────
    const labelMatch = line.match(/^label\s+([\w.]+)\s*(?:\(.*\))?\s*:/);
    if (labelMatch) {
      this.flushSpeak();
      this.closeBlocksAt(indent);
      const rpyCol = indent;
      const type = "label" as const;
      const labelName = labelMatch[1];
      this.blockStack.push({ type, rpyCol, labelName });
      this.emit(`label ${labelName} {`);
      return;
    }

    // ── if COND: ─────────────────────────────────────────────────────────────
    const ifMatch = line.match(/^if\s+(.+):/);
    if (ifMatch) {
      this.flushSpeak();
      if (this.wouldCloseBlocks(indent)) {
        this.closeBlocksAt(indent);
      }
      const rpyCol = indent;
      const type = "if" as const;
      this.blockStack.push({ type, rpyCol });
      this.emit(`${this.pad()}if ${normCondition(ifMatch[1])} {`);
      return;
    }

    // ── elif COND: ───────────────────────────────────────────────────────────
    const elifMatch = line.match(/^elif\s+(.+):/);
    if (elifMatch) {
      this.flushSpeak();
      const last = this.blockStack[this.blockStack.length - 1];
      const expectedClose = last && (last.type === "if" || last.type === "elif") && last.rpyCol === indent;
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
        last && (last.type === "if" || last.type === "elif") && last.rpyCol === indent;
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
    const choiceMatch = line.match(/^"((?:[^"\\]|\\.)*)"\s*(?:if\s+(.+?))?\s*:/);
    const inMenu =
      this.blockStack.length > 0 &&
      this.blockStack[this.blockStack.length - 1].type === "menu";
    if (choiceMatch && inMenu) {
      if (this.menuPreamble) {
        // First choice: open the menu block
        this.menuPreamble = false;
        this.menuOpen = true;
        this.emit(`${this.pad()}menu {`);
      } else {
        // Subsequent choices: close previous choice block
        if (this.blockStack[this.blockStack.length - 1].type === "choice") {
          this.blockStack.pop();
          this.emit(this.pad() + "}");
        }
      }
      const rawText = choiceMatch[1];
      const rawCond = choiceMatch[2];
      const choiceText = stripRpyTags(rawText);
      const condPart = rawCond ? ` if ${normCondition(rawCond)}` : "";
      this.blockStack.push({ type: "choice", rpyCol: indent });
      this.emit(`${this.pad()}"${escStr(choiceText)}"${condPart} => {`);
      return;
    }

    // ── voice EXPR ───────────────────────────────────────────────────────────
    const voiceMatch = line.match(/^voice\s+"([^"]+)"/);
    if (voiceMatch) {
      this.pendingVoice = this.resolveAudio(voiceMatch[1]);
      return;
    }

    // ── CHAR "text" ──────────────────────────────────────────────────────────
    const dialogMatch = line.match(
      /^([\w]+(?:_[\w]+)*)\s*"((?:[^"\\]|\\.)*)"\s*(?:with\s+\S+)?\s*$/,
    );
    if (dialogMatch) {
      const charKey = dialogMatch[1].trimEnd();
      const charName = this.charMap.get(charKey);
      if (charName !== undefined) {
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
    }

    // For all other statements: flush speak buffer then close deeper blocks
    this.flushSpeak();
    this.closeBlocksAt(indent);

    // ── $ python expression statements (skip) ────────────────────────────────
    if (/^\$\s*\w[\w.]*\s*[+\-*/%]/.test(line) && !line.includes("=")) {
      this.emit(`${this.pad()}// UNHANDLED: ${line}`);
      return;
    }

    // ── $ varName = expr  (Python assignment) ─────────────────────────────────
    const pyAssignMatch = line.match(
      /^\$\s*([\w.]+)\s*([\+\-\*\/]?=)\s*(.+)$/,
    );
    if (pyAssignMatch) {
      const varName = pyAssignMatch[1];
      const op = pyAssignMatch[2];
      const rawVal = pyAssignMatch[3].trim().replace(/\s*#.*$/, "");
      this.emit(`${this.pad()}${varName} ${op} ${rawVal};`);
      return;
    }

    // ── jump LABEL ───────────────────────────────────────────────────────────
    const rpyJumpMatch = line.match(/^jump\s+([\w.]+)/);
    if (rpyJumpMatch) {
      this.emit(`${this.pad()}jump ${rpyJumpMatch[1]};`);
      return;
    }

    // ── call LABEL ───────────────────────────────────────────────────────────
    const rpyCallMatch = line.match(/^call\s+([\w.]+)/);
    if (rpyCallMatch) {
      this.emit(`${this.pad()}call ${rpyCallMatch[1]};`);
      return;
    }

    // ── return ───────────────────────────────────────────────────────────────
    if (/^return(\s|$)/.test(line)) {
      this.emit(`${this.pad()}return;`);
      return;
    }

    // ── pause N ──────────────────────────────────────────────────────────────
    const pauseMatch = line.match(/^pause\s+([\d.]+)/);
    if (pauseMatch) {
      this.emit(`${this.pad()}wait(${fmtFloat(parseFloat(pauseMatch[1]))});`);
      return;
    }

    // ── stop music [fadeout N] ───────────────────────────────────────────────
    const musicStopMatch = line.match(
      /^stop\s+(music|audio)\s*(?:fadeout\s+([\d.]+))?/,
    );
    if (musicStopMatch) {
      const fo = musicStopMatch[2]
        ? ` | fadeout(${fmtFloat(parseFloat(musicStopMatch[2]))})`
        : "";
      this.emit(`${this.pad()}music::stop()${fo};`);
      return;
    }

    // ── stop sound ───────────────────────────────────────────────────────────
    if (/^stop\s+sound/.test(line)) {
      this.emit(`${this.pad()}sound::stop();`);
      return;
    }

    // ── play music "path" [fadein N] ─────────────────────────────────────────
    const playMusicMatch = line.match(
      /^play\s+(?:music|audio)\s+"([^"]+)"(?:\s+fadein\s+([\d.]+))?/,
    );
    if (playMusicMatch) {
      const path = playMusicMatch[1];
      const fadein = playMusicMatch[2]
        ? ` | fadein(${fmtFloat(parseFloat(playMusicMatch[2]))})`
        : "";
      this.emit(`${this.pad()}music::play("${escStr(path)}")${fadein};`);
      return;
    }

    // ── play music audio.VAR ─────────────────────────────────────────────────
    const playMusicVarMatch = line.match(
      /^play\s+(?:music|audio)\s+audio\.([\w]+)(?:\s+fadein\s+([\d.]+))?/,
    );
    if (playMusicVarMatch) {
      const resolved = this.resolveAudio(playMusicVarMatch[1]);
      const fadein = playMusicVarMatch[2]
        ? ` | fadein(${fmtFloat(parseFloat(playMusicVarMatch[2]))})`
        : "";
      this.emit(`${this.pad()}music::play("${escStr(resolved)}")${fadein};`);
      return;
    }

    // ── play sound "path" ────────────────────────────────────────────────────
    const playSoundMatch = line.match(/^play\s+sound\s+"([^"]+)"/);
    if (playSoundMatch) {
      this.emit(`${this.pad()}sound::play("${escStr(playSoundMatch[1])}");`);
      return;
    }

    // ── play voice "path" ────────────────────────────────────────────────────
    const playVoiceMatch = line.match(/^play\s+voice\s+"([^"]+)"/);
    if (playVoiceMatch) {
      this.pendingVoice = playVoiceMatch[1];
      return;
    }

    // ── scene "PATH" [with TRANS] ─────────────────────────────────────────────
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

    // ── scene bg NAME [with TRANS] ────────────────────────────────────────────
    const sceneBgMatch = line.match(
      /^scene\s+bg\s+([\w_]+(?:\s+[\w_]+)*)\s*(?:with\s+(\S+))?/,
    );
    if (sceneBgMatch) {
      const bgBase = "bg_" + sceneBgMatch[1].trim().replace(/\s+/g, "_");
      const transRaw = sceneBgMatch[2] ?? "";
      const trans = transRaw ? normTransition(transRaw) : "";
      const transPart = trans ? ` | ${trans}` : "";
      const bgPath = this.resolveBg(bgBase);
      if (bgPath) {
        this.emit(`${this.pad()}scene "${escStr(bgPath)}"${transPart};`);
      } else {
        this.emit(
          `${this.pad()}scene "<UNKNOWN: ${bgBase}>"${transPart};`,
        );
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

    // ── show SPRITE [at POS] [with TRANS] ─────────────────────────────────────
    const showMatch = line.match(
      /^show\s+([\w_]+(?:\s+[\w_]+)*)\s*(?:at\s+([\w]+))?\s*(?:with\s+(\S+))?/,
    );
    if (showMatch) {
      const spriteName = showMatch[1].trim().replace(/\s+/g, "_");
      const at = showMatch[2] ?? "";
      const trans = showMatch[3] ? normTransition(showMatch[3]) : "";
      const atPart = at ? ` @ ${at}` : "";
      const transPart = trans ? ` | ${trans}` : "";
      this.emit(`${this.pad()}show ${spriteName}${atPart}${transPart};`);
      return;
    }

    // ── expr CHAR FACE [at POS] [with TRANS] ─────────────────────────────────
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

    // ── hide NAME ────────────────────────────────────────────────────────────
    const hideMatch = line.match(/^hide\s+([\w_]+(?:\s+[\w_]+)*)/);
    if (hideMatch) {
      const key = hideMatch[1].trim().replace(/\s+/g, "_");
      this.emit(`${this.pad()}hide ${key};`);
      return;
    }

    // ── with TRANS ───────────────────────────────────────────────────────────
    const withMatch = line.match(/^with\s+(\S+)/);
    if (withMatch) {
      const trans = normTransition(withMatch[1]);
      if (trans) {
        this.emit(`${this.pad()}with ${trans};`);
      }
      return;
    }

    // ── define / default (top-level variable assignment in labels) ────────────
    if (/^define\s/.test(line) || /^default\s/.test(line)) {
      // Skip top-level Ren'Py define/default (already handled in asset maps)
      return;
    }

    // ── Python block markers ──────────────────────────────────────────────────
    if (/^init\s/.test(line) || /^python:/.test(line) || /^init python:/.test(line)) {
      this.emit(`${this.pad()}// UNHANDLED: ${line}`);
      return;
    }

    // ── Unrecognised ──────────────────────────────────────────────────────────
    if (line && !line.startsWith("#")) {
      this.emit(`${this.pad()}// UNHANDLED: ${line}`);
    }
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

    // Emit define char.* declarations
    for (const [abbr, fullName] of this.charMap) {
      this.emit(`define char.${abbr} = "${escStr(fullName)}";`);
    }
    if (this.charMap.size > 0) {
      this.emit("");
    }

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
 * @param opts         Optional game name and start label for the manifest
 */
export function convertBatch(
  inputs: BatchInput[],
  scriptText?: string,
  opts?: { game?: string; start?: string },
): BatchResult {
  const maps = scriptText ? parseAssetMaps(scriptText) : emptyAssetMaps();

  const files: BatchResult["files"] = [];
  const skipped: string[] = [];

  for (const input of inputs) {
    const result = convertRpyText(input.text, input.name, maps);
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
