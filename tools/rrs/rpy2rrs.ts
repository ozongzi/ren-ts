#!/usr/bin/env -S deno run --allow-read --allow-write
// ── rpy2rrs.ts ────────────────────────────────────────────────────────────────
//
// Converts Ren'Py .rpy files to .rrs format.
// Loads asset maps (audio, bg, cg, sx) and character definitions from the
// game's script.rpy (or another specified file), then translates the
// structural syntax of each .rpy file.
//
// Usage:
//   deno run --allow-read --allow-write tools/rrs/rpy2rrs.ts <file.rpy>
//   deno run --allow-read --allow-write tools/rrs/rpy2rrs.ts <dir/>
//   deno task rpy2rrs <file.rpy>
//
// Options:
//   -o <path>         Output path (single-file mode only) or output directory
//   --manifest        Write manifest.json listing all successfully converted files
//   --dry-run         Parse only, do not write files
//   --verbose         Print generated rrs to stdout
//   --script <path>   Path to script.rpy (required for asset/character maps)
//   --tl <dir>        Path to tl/chinese directory for Chinese translations
//                     (translations are disabled by default; must be explicitly enabled)
//   --no-tl           Kept for backward compatibility; now a no-op (no-tl is the default)
//   --cook            Before converting story files, read the already-generated
//                     script.rrs (or convert script.rpy first) to extract all
//                     top-level variable definitions (audio.*, image.*) and
//                     inline / hard-code resolved paths everywhere they appear
//   --skip <pattern>  Skip files matching this glob/name pattern (repeatable)
//   --stub-exit <label=var>  Inject `jump VAR;` when closing label LABEL
//   --help, -h        Show this help

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
      // Python attribute access → spaces around dot (but careful with numbers)
      .replace(/(\w)\.([\w_])/g, (_m, a, b) => `${a} . ${b}`)
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

// ── Script.rpy map loader ─────────────────────────────────────────────────────

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

async function loadAssetMaps(scriptRpyPath: string): Promise<AssetMaps> {
  const audio = new Map<string, string>();
  const bg = new Map<string, string>();
  const cg = new Map<string, string>();
  const sx = new Map<string, string>();
  const misc = new Map<string, string>();
  const charMap = new Map<string, string>();

  let text: string;
  try {
    text = await Deno.readTextFile(scriptRpyPath);
  } catch {
    console.warn(
      `Warning: Could not read ${scriptRpyPath}; asset maps will be empty.`,
    );
    return { audio, bg, cg, sx, misc, charMap };
  }

  for (const line of text.split("\n")) {
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
    // Single or double quotes around the display name are both accepted.
    const charMatch = trimmed.match(
      /^(?:define\s+\$?|\$\s*)(\w+)\s*=\s*Character\s*\(\s*(['"])([^'"]+)\2/,
    );
    if (charMatch) {
      const abbr = charMatch[1];
      const fullName = charMatch[3];
      // Skip narrator/nvl and minigame re-used slots
      if (abbr !== "narrator" && abbr !== "nvl" && abbr !== "k_foreplay") {
        // "empty" is a placeholder name used by the emp (silent narrator) char;
        // store it as "" so it renders as narration (no nameplate).
        charMap.set(abbr, fullName === "empty" ? "" : fullName);
      }
      continue;
    }

    // image bg_NAME = "PATH"  (single-word key)
    // image bg_NAME STATE = "PATH"  (two-word key, e.g. "bg_cabin_taiga_night lightsoff")
    // Both are stored with underscore-joined key: bg_NAME_STATE
    const bgMatch = trimmed.match(
      /^image\s+(bg_\S+)(?:\s+(\w+))?\s*=\s*"([^"]+)"/,
    );
    if (bgMatch) {
      const bgKey = bgMatch[2] ? bgMatch[1] + "_" + bgMatch[2] : bgMatch[1];
      bg.set(bgKey, bgMatch[3]);
      // Also store the base key (without modifier) so bare `scene bg_NAME` still resolves
      if (bgMatch[2]) bg.set(bgMatch[1], bgMatch[3]);
      continue;
    }

    // image cg NAME = "PATH"  (multi-word key, e.g. "cg black" → cg_black)
    const cgSpaceMatch = trimmed.match(/^image\s+cg\s+(\S+)\s*=\s*"([^"]+)"/);
    if (cgSpaceMatch) {
      cg.set("cg_" + cgSpaceMatch[1], cgSpaceMatch[2]);
      continue;
    }

    // image cg_NAME = "PATH"  (underscore key)
    const cgUnderMatch = trimmed.match(/^image\s+(cg_\S+)\s*=\s*"([^"]+)"/);
    if (cgUnderMatch) {
      cg.set(cgUnderMatch[1], cgUnderMatch[2]);
      continue;
    }

    // image sx NAME_PARTS = "PATH"  (key with spaces → underscore-joined)
    // e.g. "image sx hiro10_9 = ..."  or  "image sx natsumi6 face1 = ..."
    const sxMatch = trimmed.match(/^image\s+sx\s+(.*?)\s*=\s*"([^"]+)"/);
    if (sxMatch) {
      const rawKey = sxMatch[1].trim().replace(/\s+/g, "_");
      sx.set("sx_" + rawKey, sxMatch[2]);
      // Also store without prefix for resolution via raw name
      sx.set(rawKey, sxMatch[2]);
      continue;
    }

    // sx_ underscore images
    const sxUnderMatch = trimmed.match(/^image\s+(sx_\S+)\s*=\s*"([^"]+)"/);
    if (sxUnderMatch) {
      sx.set(sxUnderMatch[1], sxUnderMatch[2]);
      continue;
    }

    // Misc images without standard prefix (e.g. "montage_bg", "jrm_entry1_1")
    // Only store single-word image names to avoid capturing ATL/Movie defs
    const miscMatch = trimmed.match(/^image\s+([a-zA-Z0-9_]+)\s*=\s*"([^"]+)"/);
    if (miscMatch) {
      misc.set(miscMatch[1], miscMatch[2]);
      continue;
    }

    // image NAME = Movie(play="PATH", ...)  — animated CG / sprite movie
    // Store the webm path in the misc map so `scene NAME` can resolve it.
    const movieMatch = trimmed.match(
      /^image\s+([a-zA-Z0-9_]+)\s*=\s*Movie\s*\(\s*play\s*=\s*"([^"]+\.webm)"/,
    );
    if (movieMatch) {
      misc.set(movieMatch[1], movieMatch[2]);
      continue;
    }
  }

  return { audio, bg, cg, sx, misc, charMap };
}

// ── Character map reader from generated .rrs ─────────────────────────────────

/**
 * Read a previously-generated .rrs file and extract every
 *   char.ABBR = "Full Name";
 * line into a Map<abbr, fullName>.
 *
 * This is used in the two-pass workflow: script.rpy is converted first, and
 * the resulting script.rrs is then read back to build the definitive character
 * name table before all other files are converted.
 */
async function loadCharMapFromRrs(
  rrsPath: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let text: string;
  try {
    text = await Deno.readTextFile(rrsPath);
  } catch {
    return map; // file not yet written (dry-run or error) — return empty map
  }
  const re = /^char\.(\w+)\s*=\s*"([^"]*)"\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    map.set(m[1], m[2]);
  }
  return map;
}

// ── Cook-mode: read top-level defines from an already-generated .rrs file ─────

/**
 * Read an already-generated .rrs file and extract top-level
 * `audio.*` and `image.*` define declarations so the converter can
 * resolve aliases to hard paths in --cook mode.
 *
 * Returns:
 *   audio  — alias → path,  e.g. "outdoors" → "Audio/Ambient/outdoors.ogg"
 *   image  — full dotted key → path,  e.g. "image.bg.tent_day" → "BGs/tent_day.jpg"
 */
async function loadCookedMapsFromRrs(rrsPath: string): Promise<{
  audio: Map<string, string>;
  image: Map<string, string>;
}> {
  const audio = new Map<string, string>();
  const image = new Map<string, string>();
  let text: string;
  try {
    text = await Deno.readTextFile(rrsPath);
  } catch {
    return { audio, image }; // file not yet available — return empty maps
  }
  // audio.NAME = "path/to/file.ogg";
  const audioRe = /^audio\.(\w+)\s*=\s*"([^"]*)"\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = audioRe.exec(text)) !== null) {
    audio.set(m[1], m[2]);
  }
  // image.NS.KEY = "path/to/file.ext";   (NS = bg / cg / sx / misc / …)
  const imageRe = /^(image\.[a-zA-Z0-9_.]+)\s*=\s*"([^"]*)"\s*;/gm;
  while ((m = imageRe.exec(text)) !== null) {
    image.set(m[1], m[2]);
  }
  return { audio, image };
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
    content = await Deno.readTextFile(filePath);
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
    private readonly cookedAudio?: Map<string, string>,
    private readonly cookedImage?: Map<string, string>,
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

  // ── Asset resolution ────────────────────────────────────────────────────────

  private resolveAudio(varName: string): string {
    return this.maps.audio.get(varName) ?? `Audio/???/${varName}.ogg`;
  }

  /**
   * Return the image var-ref string for a bg image.
   * Falls back to a quoted unknown marker if the key is not in the map.
   */
  private bgVarRef(key: string): string {
    if (!this.maps.bg.has(key)) return `"BGs/<UNKNOWN:${key}>.jpg"`;
    // Strip the bg_ prefix for the var ref key: bg_bathroom2_sunset → bathroom2_sunset
    const refKey = key.startsWith("bg_") ? key.slice("bg_".length) : key;
    const varRef = `image.bg.${refKey}`;
    // Cook mode: inline the hard path if available
    if (this.cookedImage) {
      const path = this.cookedImage.get(varRef);
      if (path !== undefined) return `"${escStr(path)}"`;
    }
    return varRef;
  }

  /**
   * Return the image var-ref string for a cg image.
   * Falls back to a quoted unknown marker if the key is not in the map.
   */
  private cgVarRef(key: string): string {
    if (!this.maps.cg.has(key)) return `"CGs/<UNKNOWN:${key}>.jpg"`;
    // Strip the cg_ prefix for the var ref key: cg_arrival1 → arrival1
    const refKey = key.startsWith("cg_") ? key.slice("cg_".length) : key;
    const varRef = `image.cg.${refKey}`;
    // Cook mode: inline the hard path if available
    if (this.cookedImage) {
      const path = this.cookedImage.get(varRef);
      if (path !== undefined) return `"${escStr(path)}"`;
    }
    return varRef;
  }

  /**
   * Return the image var-ref string for a sx image.
   * Falls back to a quoted unknown marker if the key is not in the map.
   */
  private sxVarRef(key: string): string {
    const found = this.maps.sx.has("sx_" + key) || this.maps.sx.has(key);
    if (!found) return `"CGs/<UNKNOWN:sx_${key}>.jpg"`;
    // Normalise: strip any sx_ prefix for the var ref key
    const refKey = key.startsWith("sx_") ? key.slice("sx_".length) : key;
    const varRef = `image.sx.${refKey}`;
    // Cook mode: inline the hard path if available
    if (this.cookedImage) {
      const path = this.cookedImage.get(varRef);
      if (path !== undefined) return `"${escStr(path)}"`;
    }
    return varRef;
  }

  /**
   * Return the image var-ref string for a misc image.
   * Falls back to null if the name is not in any map.
   */
  private miscVarRef(name: string): string | null {
    let varRef: string | null = null;
    if (this.maps.cg.has(name)) {
      const refKey = name.startsWith("cg_") ? name.slice("cg_".length) : name;
      varRef = `image.cg.${refKey}`;
    } else if (this.maps.bg.has("bg_" + name)) {
      varRef = `image.bg.${name}`;
    } else if (this.maps.misc.has(name)) {
      varRef = `image.misc.${name}`;
    }
    if (varRef === null) return null;
    // Cook mode: inline the hard path if available
    if (this.cookedImage) {
      const path = this.cookedImage.get(varRef);
      if (path !== undefined) return `"${escStr(path)}"`;
    }
    return varRef;
  }

  // ── Look-ahead helper ───────────────────────────────────────────────────────

  private peekNext(): [number, string] | null {
    for (let i = this.pos; i < this.lines.length; i++) {
      const l = this.lines[i].trim();
      if (l && !l.startsWith("#")) return [i, l];
    }
    return null;
  }

  // ── Main line processor ─────────────────────────────────────────────────────

  private processLine(rawLine: string): void {
    const indent = getIndent(rawLine);
    // Strip Ren'Py inline comments (#...) that appear after a statement,
    // but ONLY when the # is not inside a string literal.
    // Simple heuristic: if the line has an unquoted #, strip from there.
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
          } // skip escaped char
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
      // Skip a bare lone quote (multiline string residue that wasn't joined)
      if (line === '"' || line === "'") return;
    }

    // ── Ren'Py image declarations → top-level .rrs image var declarations ─────
    // Instead of silently discarding these, emit them as `image.ns.key = "path"`
    // top-level defines so the codegen can resolve them via the imageMap.
    if (
      line.startsWith("image ") &&
      (line.includes(" = Movie(") ||
        /\s=\s*"/.test(line) ||
        /\s=\s*im\./.test(line))
    ) {
      this.processImageDecl(line);
      return;
    }

    // ── define audio.VAR = "path" → emit as top-level audio alias ─────────────
    // `define audio.xxx = "path"` becomes `audio.xxx = "path";` in the .rrs
    // output so that play music / bgsound can reference the alias by name.
    const audioDefineMatch = line.match(
      /^define\s+(audio\.\w+)\s*=\s*"([^"]+)"/,
    );
    if (audioDefineMatch) {
      this.emit(`${audioDefineMatch[1]} = "${escStr(audioDefineMatch[2])}";`);
      return;
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
      line.startsWith("define ") ||
      line === "init:" ||
      line.startsWith("init ") ||
      line.startsWith("default ") ||
      line.startsWith("python:") ||
      // ATL animation commands
      /^(zoom|xalign|yalign|xpos|ypos|alpha|ease|linear)\s/.test(line) ||
      // Working flag is internal
      line.match(/^\$\s*working\s*=/) !== null ||
      // Time-transition cutscenes (video-only, no .rrs equivalent)
      line.match(/^\$\s*time_transition_\w+\s*\(/) !== null ||
      // Ren'Py save/ui calls
      line.match(/^\$\s*renpy\.save_persistent\s*\(/) !== null ||
      // Ren'Py movie cutscene
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
      const resolvedMusic = this.cookedAudio?.get(varName);
      const musicArg =
        resolvedMusic !== undefined ? `"${escStr(resolvedMusic)}"` : varName;
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
      const resolvedSn = this.cookedAudio?.get(sn);
      const snArg = resolvedSn !== undefined ? `"${escStr(resolvedSn)}"` : sn;
      this.emit(`${this.pad()}sound::play(${snArg});`);
      return;
    }

    // ── play audio NAME [loop] ────────────────────────────────────────────────
    const playAudioMatch = line.match(/^play\s+audio\s+(\S+)/);
    if (playAudioMatch) {
      const an = playAudioMatch[1];
      const resolvedAn = this.cookedAudio?.get(an);
      const anArg = resolvedAn !== undefined ? `"${escStr(resolvedAn)}"` : an;
      this.emit(`${this.pad()}sound::play(${anArg});`);
      return;
    }

    // ── play bgsound / bgsound2 NAME [loop] ───────────────────────────────────
    const playBgsoundMatch = line.match(/^play\s+bgsound2?\s+(\S+)/);
    if (playBgsoundMatch) {
      const bn = playBgsoundMatch[1];
      const resolvedBn = this.cookedAudio?.get(bn);
      const bnArg = resolvedBn !== undefined ? `"${escStr(resolvedBn)}"` : bn;
      this.emit(`${this.pad()}music::play(${bnArg});`);
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

    // ── scene cg black / white / NAME [with TRANS] ────────────────────────────
    // Also matches `scene cg NAME:` (Ren'Py ATL block start — colon stripped).
    const sceneCgMatch = line.match(
      /^scene\s+cg\s+(\S+?)(?::)?(?:\s+with\s+(\S+.*))?$/,
    );
    if (sceneCgMatch) {
      // Strip trailing colon — Ren'Py ATL blocks use `scene cg NAME:` syntax
      const cgName = sceneCgMatch[1].replace(/:$/, "");
      const trans = sceneCgMatch[2] ? normTransition(sceneCgMatch[2]) : "";
      const transPart = trans ? ` | ${trans}` : "";
      if (cgName === "black") {
        this.emit(`${this.pad()}scene #000000${transPart};`);
      } else if (cgName === "white") {
        this.emit(`${this.pad()}scene #ffffff${transPart};`);
      } else {
        const ref = this.cgVarRef("cg_" + cgName);
        this.emit(`${this.pad()}scene ${ref}${transPart};`);
      }
      return;
    }

    // ── scene bg_NAME [sepia|lightsoff|lightson|...] [with TRANS] ────────────
    // Also handles multi-word bg keys like `bg_cabin_taiga_night lightsoff`.
    const sceneBgMatch = line.match(
      /^scene\s+(bg_\S+)(?:\s+(\w+))?(?:\s+with\s+(\S+.*))?$/,
    );
    if (sceneBgMatch) {
      const bgBase = sceneBgMatch[1];
      const modifier = sceneBgMatch[2];
      const transRaw = sceneBgMatch[3];
      // Check if modifier is a known transition keyword
      const isTransition =
        modifier &&
        /^(dissolve|fade|flash|move|with)$/.test(modifier.toLowerCase());
      // Check if modifier is a visual filter (sepia, etc.) — these are Ren'Py
      // display filters, NOT separate image variants; strip them from the key.
      const isFilter = modifier && /^(sepia)$/i.test(modifier);
      // If modifier is not a transition or filter, try bg_BASE_MODIFIER as key
      const bgKey =
        modifier && !isTransition && !isFilter
          ? bgBase + "_" + modifier
          : bgBase;
      const resolvedKey = this.maps.bg.has(bgKey)
        ? bgKey
        : modifier &&
            !isTransition &&
            !isFilter &&
            this.maps.bg.has(bgBase + " " + modifier)
          ? bgBase + " " + modifier
          : bgKey;
      const ref = this.bgVarRef(resolvedKey);
      const trans = transRaw
        ? normTransition(transRaw)
        : modifier && isTransition
          ? normTransition(modifier)
          : "";
      // Preserve visual filter keyword in .rrs output so codegen/engine can apply it.
      const filterPart = isFilter ? ` ${modifier!.toLowerCase()}` : "";
      const transPart = trans ? ` | ${trans}` : "";
      this.emit(`${this.pad()}scene ${ref}${filterPart}${transPart};`);
      return;
    }

    // ── scene sx NAME... [with TRANS] ─────────────────────────────────────────
    // Handles: `scene sx hiro10_9`, `scene sx yoichi8body1 1`, multi-word keys.
    if (/^scene\s+sx\s+/.test(line)) {
      const withIdx = line.indexOf(" with ");
      const afterSx = (withIdx === -1 ? line : line.slice(0, withIdx))
        .replace(/^scene\s+sx\s+/, "")
        .trim();
      const transRaw = withIdx === -1 ? "" : line.slice(withIdx + 6).trim();
      const trans = transRaw ? normTransition(transRaw) : "";
      const transPart = trans ? ` | ${trans}` : "";
      const lookupKey = afterSx.replace(/\s+/g, "_");
      const hasSx =
        this.maps.sx.has("sx_" + lookupKey) || this.maps.sx.has(lookupKey);
      if (hasSx) {
        this.emit(
          `${this.pad()}scene ${this.sxVarRef(lookupKey)}${transPart};`,
        );
      } else {
        this.emit(`${this.pad()}expr sx::${lookupKey}${transPart};`);
      }
      return;
    }

    // ── scene sx_NAME FRAME (underscore-prefixed with numeric frame) ──────────
    const sceneSxUnderMatch = line.match(
      /^scene\s+(sx_\S+)\s+(\d+)(?:\s+with\s+(\S+.*))?$/,
    );
    if (sceneSxUnderMatch) {
      const sxKey = sceneSxUnderMatch[1] + "_" + sceneSxUnderMatch[2];
      const trans = sceneSxUnderMatch[3]
        ? normTransition(sceneSxUnderMatch[3])
        : "";
      const transPart = trans ? ` | ${trans}` : "";
      const hasSxKey =
        this.maps.sx.has(sxKey) || this.maps.sx.has(sceneSxUnderMatch[1]);
      if (hasSxKey) {
        this.emit(`${this.pad()}scene ${this.sxVarRef(sxKey)}${transPart};`);
      } else {
        this.emit(`${this.pad()}expr sx::${sxKey}${transPart};`);
      }
      return;
    }

    // ── scene "PATH" [with TRANS] (literal path) ──────────────────────────────
    const sceneLiteralMatch = line.match(
      /^scene\s+("(?:[^"\\]|\\.)*")(?:\s+with\s+(\S+.*))?$/,
    );
    if (sceneLiteralMatch) {
      const trans = sceneLiteralMatch[2]
        ? normTransition(sceneLiteralMatch[2])
        : "";
      const transPart = trans ? ` | ${trans}` : "";
      this.emit(`${this.pad()}scene ${sceneLiteralMatch[1]}${transPart};`);
      return;
    }

    // ── scene NAME [with TRANS] (bare name — try bg_NAME or misc lookup) ──────
    // Must come after all other `scene X` patterns.
    // Also handles `scene cg_black` / `scene cg_white` (underscore CG form).
    const sceneBareName = line.match(
      /^scene\s+([a-zA-Z][a-zA-Z0-9_]*)(?:\s+with\s+(\S+.*))?$/,
    );
    if (sceneBareName) {
      const name = sceneBareName[1];
      const trans = sceneBareName[2] ? normTransition(sceneBareName[2]) : "";
      const transPart = trans ? ` | ${trans}` : "";
      // Special-case underscore CG colour aliases
      if (name === "cg_black") {
        this.emit(`${this.pad()}scene #000000${transPart};`);
        return;
      }
      if (name === "cg_white") {
        this.emit(`${this.pad()}scene #ffffff${transPart};`);
        return;
      }
      const ref = this.miscVarRef(name);
      if (ref) {
        this.emit(`${this.pad()}scene ${ref}${transPart};`);
      } else {
        // Unknown bare name — emit with a comment so it's visible but parseable
        this.emit(`${this.pad()}scene "<UNKNOWN:${name}>"${transPart};`);
      }
      return;
    }

    // ── show sx NAME... [with TRANS] ──────────────────────────────────────────
    // Handles multi-word sx keys: `show sx hiro10_9`, `show sx yoichi8head1 1`,
    // `show sx natsumi6 face1`, etc.
    // All words between `sx` and optional `with TRANS` are joined with `_`.
    if (/^show\s+sx\s+/.test(line)) {
      const withIdx = line.indexOf(" with ");
      const afterSx = (withIdx === -1 ? line : line.slice(0, withIdx))
        .replace(/^show\s+sx\s+/, "")
        .trim();
      const transRaw = withIdx === -1 ? "" : line.slice(withIdx + 6).trim();
      const trans = transRaw ? normTransition(transRaw) : "";
      const transPart = trans ? ` | ${trans}` : "";
      // Join all key words with underscores (e.g. "natsumi6 face1" → "natsumi6_face1")
      const lookupKey = afterSx.replace(/\s+/g, "_");
      const hasSx =
        this.maps.sx.has("sx_" + lookupKey) || this.maps.sx.has(lookupKey);
      if (hasSx) {
        this.emit(`${this.pad()}show sx_${lookupKey}${transPart} {`);
        this.emit(`${this.pad(1)}src: ${this.sxVarRef(lookupKey)};`);
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

    // ── show cg NAME [with TRANS] ─────────────────────────────────────────────
    // Also matches `show cg NAME:` (Ren'Py ATL block start — colon stripped).
    const showCgSpaceMatch = line.match(
      /^show\s+cg\s+(\S+?)(?::)?(?:\s+with\s+(\S+.*))?$/,
    );
    if (showCgSpaceMatch) {
      // Strip trailing colon — Ren'Py ATL blocks use `show cg NAME:` syntax
      const cgKey = "cg_" + showCgSpaceMatch[1].replace(/:$/, "");
      const ref = this.cgVarRef(cgKey);
      const trans = showCgSpaceMatch[2]
        ? normTransition(showCgSpaceMatch[2])
        : "";
      const transPart = trans ? ` | ${trans}` : "";
      this.emit(`${this.pad()}show ${cgKey}${transPart} {`);
      this.emit(`${this.pad(1)}src: ${ref};`);
      this.emit(`${this.pad()}};`);
      return;
    }

    // ── show cg_NAME [at POS] [with TRANS] (underscore form) ─────────────────
    const showCgUnderMatch = line.match(
      /^show\s+(cg_\S+)(?:\s+at\s+(\S+))?(?:\s+with\s+(\S+.*))?$/,
    );
    if (showCgUnderMatch) {
      const cgKey = showCgUnderMatch[1];
      const ref = this.cgVarRef(cgKey);
      const at = showCgUnderMatch[2] ? ` @ ${showCgUnderMatch[2]}` : "";
      const trans = showCgUnderMatch[3]
        ? normTransition(showCgUnderMatch[3])
        : "";
      const transPart = trans ? ` | ${trans}` : "";
      if (!ref.includes("<UNKNOWN")) {
        this.emit(`${this.pad()}show ${cgKey}${transPart} {`);
        this.emit(`${this.pad(1)}src: ${ref};`);
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
      const ref = this.bgVarRef(showBgMatch[1]);
      const at = showBgMatch[2] ? ` @ ${showBgMatch[2]}` : "";
      const trans = showBgMatch[3] ? normTransition(showBgMatch[3]) : "";
      const transPart = trans ? ` | ${trans}` : "";
      this.emit(`${this.pad()}show ${ref}${at}${transPart};`);
      return;
    }

    // ── show CHAR_BODY [sepia] [at POS] [with TRANS] ──────────────────────────
    // Body sprite: NAME_PART pattern (e.g. keitaro_casual, hiro2_camp).
    // The optional `sepia` is a Ren'Py display filter — strip it, don't use it
    // as a face expression.
    // Looks ahead for a matching face line to combine into show BODY::FACE.
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
        // Note: also accepts sepia modifier on face lines (stripped).
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

    // ── show CHAR MODIFIER EXPR [at POS] [with TRANS] ─────────────────────────
    // Three-word face expression: char + state modifier + expression.
    // e.g. `show hina sick normal1 at center` → expr hina_sick::normal1 @ center
    // If the third word is "sepia" it is a visual filter, not an expression;
    // emit a body-with-modifier show instead (no face expression).
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
        // sepia is a display filter — emit body+modifier sprite without face expr.
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

    // ── show CHAR EXPR [sepia] [at POS] [with TRANS] ──────────────────────────
    // Two-word face expression; `sepia` modifier is allowed and stripped.
    // Guard: if the second word IS "sepia" the line is actually a body-only
    // sprite with a filter (no face expression) — emit show CHAR instead.
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
        // sepia is a display filter — emit a plain show for the body sprite.
        this.emit(`${this.pad()}show ${char}${atPart}${transPart};`);
      } else {
        this.emit(`${this.pad()}expr ${char}::${expr}${atPart}${transPart};`);
      }
      return;
    }

    // ── show NAME [with TRANS] (simple / animated CG / movie sprite) ──────────
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

    // ── hide CHAR MODIFIER EXPR [with TRANS] (three-word form) ──────────────
    // If the third word is "sepia" it is a visual filter — emit hide CHAR::MODIFIER
    // (the modifier is the face expression, sepia is stripped).
    const hide3WordMatch = line.match(
      /^hide\s+(\w+)\s+(\w+)\s+(\w+)(?:\s+with\s+\S+)?\s*$/,
    );
    if (hide3WordMatch) {
      const char = hide3WordMatch[1];
      const modifier = hide3WordMatch[2];
      const expr = hide3WordMatch[3];
      if (expr === "sepia") {
        // sepia is a display filter — hide the face expression (modifier) sprite.
        this.emit(`${this.pad()}hide ${char}::${modifier};`);
      } else {
        this.emit(`${this.pad()}hide ${char}_${modifier}::${expr};`);
      }
      return;
    }

    // ── hide CHAR EXPR [sepia] [with TRANS] / hide cg NAME [with TRANS] ──────
    // Guard: if the second word IS "sepia" it is a filter — just hide CHAR (body only).
    const hideFaceMatch = line.match(
      /^hide\s+(\w+)\s+(\w+)(?:\s+sepia)?(?:\s+with\s+\S+)?\s*$/,
    );
    if (hideFaceMatch) {
      const hns = hideFaceMatch[1];
      const hex = hideFaceMatch[2];
      if (hns === "cg" || hns === "bg") {
        this.emit(`${this.pad()}hide ${hns}_${hex};`);
      } else if (hex === "sepia") {
        // sepia is a display filter — just hide the body sprite.
        this.emit(`${this.pad()}hide ${hns};`);
      } else {
        this.emit(`${this.pad()}hide ${hns}::${hex};`);
      }
      return;
    }

    // ── hide NAME [with TRANS] ────────────────────────────────────────────────
    const hideMatch = line.match(/^hide\s+(\S+)(?:\s+with\s+\S+)?\s*$/);
    if (hideMatch) {
      this.emit(`${this.pad()}hide ${hideMatch[1]};`);
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
   * Parse a Ren'Py `image X = "PATH"` or `image X = Movie(...)` line and emit
   * a top-level .rrs declaration of the form:
   *   image.bg.bathroom2_sunset = "BGs/bathroom2_sunset.jpg";
   *   image.cg.yoshinori1_5     = "CGs/cg_yoshinori_1_5.jpg";
   *   image.sx.hiro10_9         = "CGs/SX/hiro10_9.jpg";
   *   image.misc.montage_bg     = "CGs/montage_bg.jpg";
   *
   * Paths are stored verbatim as declared in the .rpy source (no stripping).
   * The codegen resolves them at compile time via the imageMap built from
   * these declarations.
   */
  private processImageDecl(line: string): void {
    // image cg NAME = "PATH"  (space-separated two-word key, e.g. "cg yoshinori1_5")
    const cgSpace = line.match(/^image\s+cg\s+(\S+)\s*=\s*"([^"]+)"/);
    if (cgSpace) {
      const key = cgSpace[1].replace(/\s+/g, "_");
      this.emit(`image.cg.${key} = "${escStr(cgSpace[2])}";`);
      return;
    }

    // image bg_NAME [STATE] = "PATH"
    const bgUnder = line.match(
      /^image\s+(bg_\S+)(?:\s+(\w+))?\s*=\s*"([^"]+)"/,
    );
    if (bgUnder) {
      const base = bgUnder[1].slice("bg_".length); // strip bg_ prefix
      const state = bgUnder[2];
      const key = state ? base + "_" + state : base;
      this.emit(`image.bg.${key} = "${escStr(bgUnder[3])}";`);
      if (state) {
        // Also emit base key for scenes that reference without modifier
        this.emit(`image.bg.${base} = "${escStr(bgUnder[3])}";`);
      }
      return;
    }

    // image cg_NAME = "PATH"  (underscore form)
    const cgUnder = line.match(/^image\s+(cg_\S+)\s*=\s*"([^"]+)"/);
    if (cgUnder) {
      const key = cgUnder[1].slice("cg_".length); // strip cg_ prefix
      this.emit(`image.cg.${key} = "${escStr(cgUnder[2])}";`);
      return;
    }

    // image sx NAME... = "PATH"  (space-separated key, e.g. "sx hiro10_9")
    const sxSpace = line.match(/^image\s+sx\s+(.*?)\s*=\s*"([^"]+)"/);
    if (sxSpace) {
      const key = sxSpace[1].trim().replace(/\s+/g, "_");
      this.emit(`image.sx.${key} = "${escStr(sxSpace[2])}";`);
      return;
    }

    // image sx_NAME = "PATH"  (underscore form)
    const sxUnder = line.match(/^image\s+(sx_\S+)\s*=\s*"([^"]+)"/);
    if (sxUnder) {
      const key = sxUnder[1].slice("sx_".length); // strip sx_ prefix
      this.emit(`image.sx.${key} = "${escStr(sxUnder[2])}";`);
      return;
    }

    // image NAME = Movie(play="PATH.webm")  — animated CG / sprite movie
    const movie = line.match(
      /^image\s+([a-zA-Z0-9_]+)\s*=\s*Movie\s*\(\s*play\s*=\s*"([^"]+\.webm)"/,
    );
    if (movie) {
      this.emit(`image.misc.${movie[1]} = "${escStr(movie[2])}";`);
      return;
    }

    // image NAME... FILTER = im.SomeEffect("PATH")  — image filter variants (e.g. im.Sepia)
    // The sepia/filter word is the last name token; strip it so the key matches the base
    // image declaration (e.g. `image lee_sleep sepia = im.Sepia(...)` → `image.misc.lee_sleep`).
    // This intentionally produces the same key as the plain `image lee_sleep = "..."` definition;
    // duplicate definitions with identical paths are harmless — last writer wins in the map.
    const KNOWN_IMG_FILTERS = new Set(["sepia"]);
    const imEffect = line.match(
      /^image\s+((?:\w+\s+)*\w+)\s*=\s*im\.\w+\s*\(\s*"([^"]+)"/,
    );
    if (imEffect) {
      const words = imEffect[1].trim().split(/\s+/);
      // Strip trailing filter word if recognised (e.g. "sepia")
      if (
        words.length > 1 &&
        KNOWN_IMG_FILTERS.has(words[words.length - 1].toLowerCase())
      ) {
        words.pop();
      }
      const key = words.join("_");
      this.emit(`image.misc.${key} = "${escStr(imEffect[2])}";`);
      return;
    }

    // image NAME = "PATH"  (generic misc — single or multi-word key)
    const misc = line.match(/^image\s+((?:\w+\s+)*\w+)\s*=\s*"([^"]+)"/);
    if (misc) {
      const key = misc[1].trim().replace(/\s+/g, "_");
      this.emit(`image.misc.${key} = "${escStr(misc[2])}";`);
    }
  }

  private wouldCloseBlocks(indent: number): boolean {
    return (
      this.blockStack.length > 0 &&
      this.blockStack[this.blockStack.length - 1].rpyCol >= indent
    );
  }

  /**
   * Look ahead from `fromPos` for the next non-blank non-comment line that
   * is a face-expression `show` for `charBase`.  Returns the line index or -1
   * if interrupted by any other non-trivial line.
   */
  private peekNextFaceLine(charBase: string, fromPos: number): number {
    for (let i = fromPos; i < this.lines.length; i++) {
      const l = this.lines[i].trim();
      if (!l || l.startsWith("#")) continue;
      const m = l.match(
        /^show\s+(\w+)\s+(\w+)(?:\s+sepia)?(?:\s+at\s+\S+)?(?:\s+with\s+\S+)?$/,
      );
      if (m && (m[1] === charBase || m[1].startsWith(charBase))) {
        return i;
      }
      break;
    }
    return -1;
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
  deno task rpy2rrs <input> [options]
  deno run --allow-read --allow-write tools/rrs/rpy2rrs.ts <input> [options]

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
  --cook                After converting script.rpy (or reading an existing
                        script.rrs), read its top-level variable definitions
                        and inline / hard-code resolved paths in all other
                        files (audio aliases → quoted paths, image var-refs →
                        quoted paths)
  --skip <name>         Additional filename to skip in directory mode (repeatable)
  --stub-exit <l=v>     When label L closes, inject \`jump v;\`  (repeatable)
                        Example: --stub-exit foreplay=label_afterforeplay
  --dry-run             Parse only, do not write files
  --verbose             Print generated .rrs to stdout
  --game <name>         Game display name written into manifest.json
  --help, -h            Show this message

EXAMPLES
  deno task rpy2rrs /path/to/game/day1.rpy
  deno task rpy2rrs /path/to/game/ -o assets/data/ --manifest --script /path/to/game/script.rpy
  deno task rpy2rrs /path/to/game/day1.rpy --no-tl   # English output
`;

async function main(): Promise<void> {
  const rawArgs = Deno.args.slice();

  if (
    rawArgs.length === 0 ||
    rawArgs.includes("--help") ||
    rawArgs.includes("-h")
  ) {
    console.log(HELP);
    Deno.exit(rawArgs.length === 0 ? 1 : 0);
  }

  let outputArg: string | undefined;
  let scriptRpy: string | undefined;
  let tlDir: string | undefined;
  let noTl = false; // kept for backward-compat; no-tl is now the default
  let cook = false;
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
    } else if (arg === "--script") {
      scriptRpy = rawArgs[++i];
    } else if (arg === "--tl") {
      tlDir = rawArgs[++i];
    } else if (arg === "--no-tl") {
      noTl = true; // no-op; kept for backward-compat
    } else if (arg === "--cook") {
      cook = true;
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
        Deno.exit(1);
      }
      STUB_EXIT_MAP[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    } else if (arg.startsWith("-")) {
      console.error(`Unknown option '${arg}'`);
      Deno.exit(1);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) {
    console.error("No input specified.  Run with --help for usage.");
    Deno.exit(1);
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
        outputIsDir = (await Deno.stat(outputArg)).isDirectory;
      } catch {
        outputIsDir = false;
      }
    }
  }

  // Auto-detect script.rpy if not specified: look for it in the first positional
  // argument (which may be the game directory).
  if (!scriptRpy && positional.length > 0) {
    const candidate = `${positional[0].replace(/\/$/, "")}/script.rpy`;
    try {
      await Deno.stat(candidate);
      scriptRpy = candidate;
      console.log(`Auto-detected script.rpy at: ${scriptRpy}`);
    } catch {
      // Not found — will proceed without asset maps
    }
  }

  // Translations are opt-in only: use --tl <dir> to enable.
  // (Auto-detection of tl/chinese has been removed; --no-tl is a no-op now.)
  void noTl;

  // ── Cook mode: build cooked maps from script.rrs ─────────────────────────
  // When --cook is specified we read the already-generated (or about-to-be-
  // generated) script.rrs and extract all top-level audio.* / image.* defines
  // so that story files can inline hard paths instead of emitting variable refs.
  let cookedAudio: Map<string, string> | undefined;
  let cookedImage: Map<string, string> | undefined;

  // Determine where script.rrs lives (mirrors the outPath logic for script.rpy)
  let scriptRrsPath: string | undefined;
  if (cook && scriptRpy) {
    const scriptBaseName = scriptRpy
      .split("/")
      .pop()!
      .replace(/\.rpy$/, ".rrs");
    if (outputIsDir && outputArg) {
      scriptRrsPath = `${outputArg.replace(/\/$/, "")}/${scriptBaseName}`;
    } else if (outputArg && !outputIsDir) {
      // Single-file mode — script.rrs would sit next to script.rpy
      scriptRrsPath = scriptRpy.replace(/\.rpy$/, ".rrs");
    } else {
      scriptRrsPath = scriptRpy.replace(/\.rpy$/, ".rrs");
    }
  }

  // Load asset maps (and character map) once
  let maps: AssetMaps;
  if (scriptRpy) {
    console.log(`Loading asset maps from ${scriptRpy} …`);
    maps = await loadAssetMaps(scriptRpy);
    console.log(
      `  audio: ${maps.audio.size}  bg: ${maps.bg.size}  cg: ${maps.cg.size}  sx: ${maps.sx.size}  misc: ${maps.misc.size}  chars: ${maps.charMap.size}`,
    );
  } else {
    console.warn(
      `Warning: --script not specified and no script.rpy auto-detected. ` +
        `Asset maps and character definitions will be empty.`,
    );
    maps = {
      audio: new Map(),
      bg: new Map(),
      cg: new Map(),
      sx: new Map(),
      misc: new Map(),
      charMap: new Map(),
    };
  }

  // ── Cook: if script.rrs doesn't exist yet, convert script.rpy first ────────
  if (cook && scriptRrsPath && scriptRpy) {
    let scriptRrsExists = false;
    try {
      await Deno.stat(scriptRrsPath);
      scriptRrsExists = true;
    } catch {
      scriptRrsExists = false;
    }

    if (!scriptRrsExists) {
      console.log(
        `[cook] script.rrs not found at ${scriptRrsPath}; converting script.rpy first …`,
      );
      await convertFile(scriptRpy, scriptRrsPath, maps, {
        dryRun,
        verbose,
        tlDir,
      });
    }

    console.log(`[cook] Loading cooked maps from ${scriptRrsPath} …`);
    const cooked = await loadCookedMapsFromRrs(scriptRrsPath);
    cookedAudio = cooked.audio;
    cookedImage = cooked.image;
    console.log(
      `[cook]   audio aliases: ${cookedAudio.size}  image refs: ${cookedImage.size}`,
    );
  }

  // Gather input files
  const inputFiles: string[] = [];
  for (const p of positional) {
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(p);
    } catch {
      console.error(`Path not found: ${p}`);
      Deno.exit(1);
      return;
    }
    if (stat.isFile) {
      inputFiles.push(p);
    } else if (stat.isDirectory) {
      for await (const entry of Deno.readDir(p)) {
        if (entry.isFile && entry.name.endsWith(".rpy")) {
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
    Deno.exit(1);
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
      cookedAudio,
      cookedImage,
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
        await Deno.mkdir(manifestDir, { recursive: true });
        await Deno.writeTextFile(manifestPath, manifestContent);
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

  if (failed > 0) Deno.exit(1);
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
    cookedAudio?: Map<string, string>;
    cookedImage?: Map<string, string>;
  },
  skipFiles?: Set<string>,
): Promise<ConvertResult> {
  // If this is script.rpy, we still convert it (for label start etc.) — it is
  // no longer unconditionally skipped.
  void skipFiles; // reserved for future per-file skip logic
  const t0 = performance.now();

  let src: string;
  try {
    src = await Deno.readTextFile(inputPath);
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

  // Local image definitions (e.g. bg/cg/misc images defined in individual
  // story .rpy files rather than in script.rpy) are now handled by
  // processImageDecl() at conversion time — they are emitted as top-level
  // image.* declarations in the output .rrs file.  The Converter's maps are
  // still used to determine the correct var-ref namespace (bg/cg/sx/misc) for
  // scene/show commands that reference those images.
  //
  // We perform a quick pre-scan of the file to populate file-local map entries
  // so that the Converter can emit correct var-refs for locally-defined images.
  const localMisc = new Map(maps.misc);
  const localBg = new Map(maps.bg);
  const localCg = new Map(maps.cg);
  for (const rawLine of lines) {
    const t = rawLine.trim();
    // image bg_NAME = "PATH"  (with optional state modifier)
    const bgM = t.match(/^image\s+(bg_\S+)(?:\s+(\w+))?\s*=\s*"([^"]+)"/);
    if (bgM) {
      const key = bgM[2] ? bgM[1] + "_" + bgM[2] : bgM[1];
      localBg.set(key, bgM[3]);
      if (bgM[2]) localBg.set(bgM[1], bgM[3]);
      continue;
    }
    // image cg NAME = "PATH"
    const cgM = t.match(/^image\s+cg\s+(\S+)\s*=\s*"([^"]+)"/);
    if (cgM) {
      localCg.set("cg_" + cgM[1], cgM[2]);
      continue;
    }
    // image cg_NAME = "PATH"
    const cgUM = t.match(/^image\s+(cg_\S+)\s*=\s*"([^"]+)"/);
    if (cgUM) {
      localCg.set(cgUM[1], cgUM[2]);
      continue;
    }
    // image NAME = "PATH"  (single-word misc)
    const miscM = t.match(/^image\s+([a-zA-Z0-9_]+)\s*=\s*"([^"]+)"/);
    if (miscM) {
      localMisc.set(miscM[1], miscM[2]);
      continue;
    }
    // image NAME = Movie(play="PATH", ...)  — animated CG / sprite movie
    const movieM = t.match(
      /^image\s+([a-zA-Z0-9_]+)\s*=\s*Movie\s*\(\s*play\s*=\s*"([^"]+\.webm)"/,
    );
    if (movieM) {
      localMisc.set(movieM[1], movieM[2]);
    }
  }

  // Load per-file Chinese translations (avoids cross-file conflicts)
  let effectiveMaps: AssetMaps = {
    ...maps,
    bg: localBg,
    cg: localCg,
    misc: localMisc,
  };
  if (opts.tlDir) {
    const tl = await loadChineseTranslationsForFile(opts.tlDir, sourceBaseName);
    effectiveMaps = { ...effectiveMaps, tl };
  }

  const converter = new Converter(
    lines,
    effectiveMaps,
    filename,
    opts.cookedAudio,
    opts.cookedImage,
  );
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
      await Deno.mkdir(outDir, { recursive: true });
    } catch {
      // ignore if already exists
    }
  }

  try {
    await Deno.writeTextFile(outputPath, result);
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
