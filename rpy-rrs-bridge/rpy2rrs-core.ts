// ── rpy2rrs-core.ts ───────────────────────────────────────────────────────────
//
// Pure-function core for Ren'Py → .rrs conversion.
// Exposes:
//   convertRpy(src, filename, opts?) → rrs source string
//
// No file I/O, no process.argv, no side effects.

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns name with quotes if it contains special chars */
function fmtSpeaker(name: string): string {
  if (/[^A-Za-z0-9_]/.test(name)) return `"${name}"`;
  return name;
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
 */
function stripRpyTags(s: string): string {
  return s.replace(/\{[^{}]*\}/g, "").trim();
}

/** Transform a Ren'Py condition expression to .rrs syntax */
function normCondition(cond: string): string {
  return cond
    .trim()
    .replace(/(\w)\.([\w_])/g, (_m, a, b) => `${a}.${b}`)
    .replace(/\band\b/g, "&&")
    .replace(/\bor\b/g, "||")
    .replace(/\bnot\s+/g, "! ");
}

/** Extract a Python string literal's content (handles 'x' or "x") */
function extractPyStr(raw: string): string {
  const m = raw.match(/^(['"])([\s\S]*?)\1$/);
  return m ? m[2] : raw;
}

function getIndent(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === " ") i++;
  return i;
}

function fmtFloat(n: number): string {
  return n === Math.floor(n) ? String(Math.floor(n)) : String(n);
}

// ── Block / speak types ───────────────────────────────────────────────────────

interface BlockInfo {
  rpyCol: number;
  type: "label" | "if" | "elif" | "else" | "menu" | "choice";
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
  /** label name → exit label for minigame stubs */
  private stubMap: Map<string, string>;

  constructor(
    lines: string[],
    private readonly filename: string,
    private readonly translation_map?: Map<string, string>,
    stubs?: Array<{ entryLabel: string; exitLabel: string }>,
  ) {
    this.lines = lines;
    this.stubMap = new Map(
      stubs?.map((s) => [s.entryLabel, s.exitLabel]) ?? [],
    );
  }

  private translate(text: string): string {
    return this.translation_map?.get(text) ?? text;
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

  // ── Asset resolution ───────────────────────────────────────────────────────

  private resolveAudio(varName: string): string {
    return `audio.${varName}`;
  }

  // ── Unified show/scene key builder ──────────────────────────────────────────

  private static imageKey(words: string[]): string {
    return words.join(".");
  }

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
      if (forScene && FILTERS.has(p)) {
        filter = p;
        i++;
        continue;
      }
      words.push(p.replace(/:$/, ""));
      i++;
    }
    return { words, at, trans, filter };
  }

  // ── Main line processor ─────────────────────────────────────────────────────

  private processLine(rawLine: string): void {
    const indent = getIndent(rawLine);
    let line = rawLine.trim();

    if (!line || line.startsWith("#")) return;

    // Strip inline comments
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

    // ── define/$ VAR = Position(...) ─────────────────────────────────────────
    const positionMatch = line.match(
      /^(?:define\s+|(?:\$\s*))(\w+)\s*=\s*Position\s*\(\s*xpos\s*=\s*([\d.]+)/,
    );
    if (positionMatch) {
      this.emit(`position.${positionMatch[1]} = ${positionMatch[2]};`);
      return;
    }

    // ── default VAR = VALUE ───────────────────────────────────────────────────
    const defaultMatch = line.match(/^default\s+([\w.]+)\s*=\s*(.+)$/);
    if (defaultMatch) {
      const varName = defaultMatch[1];
      let val = defaultMatch[2].trim();
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

    // ── label X: ──────────────────────────────────────────────────────────────
    const labelMatch = line.match(/^label\s+(\w+)\s*:/);
    if (labelMatch) {
      this.flushSpeak();
      this.closeBlocksAt(indent);
      const labelName = labelMatch[1];

      // Minigame stub: emit a pass-through label and skip the entire body.
      const stubExit = this.stubMap.get(labelName);
      if (stubExit !== undefined) {
        this.emit(`${this.pad()}label ${labelName} {`);
        this.emit(`${this.pad()}  jump ${stubExit};`);
        this.emit(`${this.pad()}}`);
        // Skip all lines that belong to this label's body (indented deeper
        // than the label declaration itself).
        while (this.pos < this.lines.length) {
          const peek = this.lines[this.pos];
          const peekTrimmed = peek.trim();
          if (peekTrimmed === "") {
            this.pos++;
            continue;
          }
          const peekIndent = getIndent(peek);
          if (peekIndent <= indent) break;
          this.pos++;
        }
        return;
      }

      this.emit(`${this.pad()}label ${labelName} {`);
      this.blockStack.push({ rpyCol: indent, type: "label" });
      return;
    }

    // ── if COND: ──────────────────────────────────────────────────────────────
    const ifMatch = line.match(/^if\s+(.*?)\s*:$/);
    if (ifMatch) {
      this.flushSpeak();
      this.closeBlocksAt(indent);
      this.emit(`${this.pad()}if ${normCondition(ifMatch[1])} {`);
      this.blockStack.push({ rpyCol: indent, type: "if" });
      return;
    }

    // ── elif COND: ────────────────────────────────────────────────────────────
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

    // ── else: ─────────────────────────────────────────────────────────────────
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

    // ── menu: ─────────────────────────────────────────────────────────────────
    if (line === "menu:" || line === "menu :") {
      this.flushSpeak();
      this.closeBlocksAt(indent);
      this.menuPreamble = true;
      this.menuOpen = false;
      this.menuPreambleCol = indent;
      return;
    }

    // ── "CHOICE" [if CONDITION]: ──────────────────────────────────────────────
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

    // ── voice audio.VAR ───────────────────────────────────────────────────────
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

    // ── CHAR "text" ───────────────────────────────────────────────────────────
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

    // ── flush speak + close deeper blocks before other statements ─────────────
    this.flushSpeak();
    this.closeBlocksAt(indent);

    // ── bare expression statements (no assignment) ────────────────────────────
    if (/^\$\s*\w[\w.]*\s*[+\-*/%]/.test(line) && !line.includes("=")) {
      return;
    }

    // ── $ renpy.jump(VAR) ─────────────────────────────────────────────────────
    const rpyJumpMatch = line.match(/^\$\s*renpy\.jump\s*\(\s*(\w+)\s*\)/);
    if (rpyJumpMatch) {
      this.emit(`${this.pad()}jump ${rpyJumpMatch[1]};`);
      return;
    }

    // ── $ renpy.call(VAR) ─────────────────────────────────────────────────────
    const rpyCallMatch = line.match(/^\$\s*renpy\.call\s*\(\s*(\w+)\s*\)/);
    if (rpyCallMatch) {
      this.emit(`${this.pad()}call ${rpyCallMatch[1]};`);
      return;
    }

    // ── $ renpy.pause(X) → wait(X) ───────────────────────────────────────────
    const pauseMatch = line.match(/^\$\s*renpy\.pause\s*\(\s*([\d.]+)/);
    if (pauseMatch) {
      this.emit(`${this.pad()}wait(${fmtFloat(parseFloat(pauseMatch[1]))});`);
      return;
    }
    if (line.match(/^\$\s*renpy\.pause\s*\(/)) return;

    // ── $ renpy.music.stop(...) ───────────────────────────────────────────────
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
      if (fadein) {
        this.emit(
          `${this.pad()}music::play(${varName}) | fadein(${fmtFloat(parseFloat(fadein))});`,
        );
      } else {
        this.emit(`${this.pad()}music::play(${varName});`);
      }
      return;
    }

    // ── play sound NAME ───────────────────────────────────────────────────────
    const playSoundMatch = line.match(/^play\s+sound\s+(\S+)/);
    if (playSoundMatch) {
      this.emit(`${this.pad()}sound::play(${playSoundMatch[1]});`);
      return;
    }

    // ── play audio NAME ───────────────────────────────────────────────────────
    const playAudioMatch = line.match(/^play\s+audio\s+(\S+)/);
    if (playAudioMatch) {
      this.emit(`${this.pad()}sound::play(${playAudioMatch[1]});`);
      return;
    }

    // ── play bgsound / bgsound2 NAME ─────────────────────────────────────────
    const playBgsoundMatch = line.match(/^play\s+bgsound2?\s+(\S+)/);
    if (playBgsoundMatch) {
      this.emit(`${this.pad()}music::play(${playBgsoundMatch[1]});`);
      return;
    }

    // ── stop music / bgsound / sound / audio ─────────────────────────────────
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

    // ── scene WORDS... ────────────────────────────────────────────────────────
    if (/^scene\s+/.test(line)) {
      const tail = line.slice("scene".length).trim();
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

    // ── show WORDS... ─────────────────────────────────────────────────────────
    if (/^show\s+/.test(line)) {
      const tail = line.slice("show".length).trim();
      const { words, at, trans } = Converter.parseShowTail(tail, false);
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

    // ── hide WORDS... ─────────────────────────────────────────────────────────
    if (/^hide\s+/.test(line)) {
      const tail = line
        .slice("hide".length)
        .trim()
        .replace(/\s+with\s+\S+.*$/, "")
        .trim();
      const tag = tail.split(/\s+/)[0];
      if (tag) this.emit(`${this.pad()}hide ${tag};`);
      return;
    }

    // ── with TRANS ────────────────────────────────────────────────────────────
    const withMatch = line.match(/^with\s+(\S+.*)$/);
    if (withMatch) {
      const trans = normTransition(withMatch[1]);
      if (trans) this.emit(`${this.pad()}with ${trans};`);
      return;
    }

    // ── jump LABEL ────────────────────────────────────────────────────────────
    const jumpMatch = line.match(/^jump\s+(\w+)\s*$/);
    if (jumpMatch) {
      const label = jumpMatch[1];

      this.emit(`${this.pad()}jump ${label};`);
      return;
    }

    // ── call LABEL ────────────────────────────────────────────────────────────
    const callMatch = line.match(/^call\s+(\w+)\s*$/);
    if (callMatch) {
      this.emit(`${this.pad()}call ${callMatch[1]};`);
      return;
    }

    // ── return ────────────────────────────────────────────────────────────────
    if (line === "return") return;

    // ── $abbr = Character("Name", ...) ───────────────────────────────────────
    const charDefMatch = line.match(
      /^\$\s*(\w+)\s*=\s*Character\s*\(\s*(['"])([^'"]+)\2/,
    );
    if (charDefMatch) {
      const abbr = charDefMatch[1];
      const fullName = charDefMatch[3];
      if (abbr !== "narrator" && abbr !== "nvl" && abbr !== "k_foreplay") {
        const name = fullName === "empty" ? "" : fullName;
        this.emit(`char.${abbr} = "${name}";`);
      }
      return;
    }

    // ── $ VAR op VALUE ────────────────────────────────────────────────────────
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

    // ── gui.init(w, h) ────────────────────────────────────────────────────────
    const guiInitMatch = line.match(/^gui\.init\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/);
    if (guiInitMatch) {
      const w = guiInitMatch[1];
      const h = guiInitMatch[2];
      this.emit(`${this.pad()}config.screen_width = ${w};`);
      this.emit(`${this.pad()}config.screen_height = ${h};`);
      return;
    }

    // ── Unrecognised ──────────────────────────────────────────────────────────
    this.emit(`${this.pad()}// UNHANDLED: ${line}`);
  }

  // ── Image declaration emitter ─────────────────────────────────────────────

  private processImageDecl(line: string): void {
    const eqIdx = line.indexOf("=");
    if (eqIdx < 0) return;

    const wordsPart = line.slice("image".length, eqIdx).trim();
    const valuePart = line.slice(eqIdx + 1).trim();

    if (valuePart.startsWith("Composite(")) return;

    const rawWords = wordsPart.split(/\s+/).filter((w) => w.length > 0);
    if (rawWords.length === 0) return;

    const KNOWN_FILTERS = new Set(["sepia"]);
    const words = [...rawWords];
    if (
      words.length > 1 &&
      KNOWN_FILTERS.has(words[words.length - 1].toLowerCase())
    ) {
      words.pop();
    }

    const key = "image." + words.join(".");

    const movieM = valuePart.match(
      /^Movie\s*\(\s*(?:play\s*=\s*)?"([^"]+\.webm)"/,
    );
    if (movieM) {
      this.emit(`${key} = "${escStr(movieM[1])}";`);
      return;
    }

    const imM = valuePart.match(/^im\.\w+\s*\(\s*"([^"]+)"/);
    if (imM) {
      this.emit(`${key} = "${escStr(imM[1])}";`);
      return;
    }

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

  // ── Line preprocessor ─────────────────────────────────────────────────────

  private preprocessLines(lines: string[]): string[] {
    const result: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const raw = lines[i].replace(/\r$/, "");
      i++;

      const hasUnclosedString = (() => {
        const t = raw.trim();
        if (!/^[\w_]+\s*"/.test(t)) return false;
        let inStr = false;
        for (let ci = 0; ci < t.length; ci++) {
          const ch = t[ci];
          if (ch === "\\") {
            ci++;
            continue;
          }
          if (ch === '"') inStr = !inStr;
        }
        return inStr;
      })();

      if (hasUnclosedString) {
        let joined = raw.trimEnd();
        while (i < lines.length) {
          const cont = lines[i].replace(/\r$/, "");
          i++;
          joined += " " + cont.trim();
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

  // ── Entry point ────────────────────────────────────────────────────────────

  convert(): string {
    this.emit(`// Source: data/${this.filename}`);
    this.emit("");

    this.lines = this.preprocessLines(this.lines);

    while (this.pos < this.lines.length) {
      const rawLine = this.lines[this.pos++];
      this.processLine(rawLine);
    }

    this.flushSpeak();

    while (this.blockStack.length > 0) {
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

    return this.out.join("\n") + "\n";
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Convert a Ren'Py `.rpy` source string to `.rrs` format.
 *
 * @param src             - Raw content of the `.rpy` file
 * @param filename        - Logical filename used in the `// Source:` comment (e.g. "day1.rrs")
 * @param translation_map - Optional map of english text → translated text
 * @param stubs           - Optional minigame stubs: label bodies are replaced with a direct jump
 * @returns               - The converted `.rrs` source string
 */
export function convertRpy(
  src: string,
  filename: string,
  translation_map?: Map<string, string>,
  stubs?: Array<{ entryLabel: string; exitLabel: string }>,
): string {
  const lines = src.split("\n");
  const converter = new Converter(lines, filename, translation_map, stubs);
  return converter.convert();
}
