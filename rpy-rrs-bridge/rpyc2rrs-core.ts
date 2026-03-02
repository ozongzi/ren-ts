// ── rpyc2rrs-core.ts ──────────────────────────────────────────────────────────
//
// Converts a decoded rpyc AST (list of renpy.ast.* PickleObjects) to .rrs
// source text.
//
// The input is the root PickleValue produced by readRpyc().astPickle —
// typically a list of renpy.ast.Node subclass instances.
//
// Design notes
// ────────────
//  • This module has zero I/O and zero side-effects — all work is pure
//    in-memory transformation.
//  • It shares helper functions with rpy2rrs-core.ts (escStr, normTransition,
//    etc.) but is kept as a separate file to avoid pulling the full text-based
//    Converter class into the rpyc path.
//  • Node traversal mirrors Ren'Py's own AST structure documented in
//    renpy/ast.py.  Only the subset of node types that map to .rrs constructs
//    is handled; unsupported nodes emit a // skip comment.
//  • imspec handling covers all three tuple lengths (3, 6, 7) as described
//    in ast.py's ImspecType annotation.
//  • detectMinigameFromAst mirrors the four-phase logic in minigame-detect.ts
//    but operates on structured AST nodes instead of raw text, so it is used
//    instead of the text-based detectMinigame for the rpyc conversion path.
//
// Supported renpy.ast node types
// ───────────────────────────────
//   Label, Say, Show, Scene, Hide, With, Jump, Call, Return,
//   Menu, If, While, Python, Define, Default, Init, Pass,
//   UserStatement (voice shorthand)
//
// Public API
// ──────────
//   unwrapAstNodes(astPickle)        → PickleValue[]
//   detectMinigameFromAst(rootNodes) → MinigameDetectResult
//   convertRpyc(astPickle, filename, translation_map?) → string

import {
  type PickleValue,
  type PickleObject,
  isPickleObject,
  getField,
  shortClass,
  asString,
  asList,
} from "../src/pickle";
import type { MinigameDetectResult, MinigameStub } from "./minigame-detect";

// ─── Shared helpers (duplicated from rpy2rrs-core.ts to stay self-contained) ──

function escStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function fmtSpeaker(name: string): string {
  if (/[^A-Za-z0-9_]/.test(name)) return `"${escStr(name)}"`;
  return name;
}

function normTransition(raw: string): string {
  const t = raw.trim();
  if (/^[Dd]issolve\s*\(/.test(t) || t === "dissolve") return "dissolve";
  if (t === "fade" || t === "Fade" || /^Fade\s*\(/.test(t)) return "fade";
  if (/^flash/i.test(t)) return "flash";
  if (t === "None" || t === "none") return "";
  if (
    /^(movetransition|blinds|pixellate|vpunch|hpunch|wipe|ease|bounce|zoomin|zoomout|irisfade|squares)/i.test(
      t,
    )
  ) {
    return "";
  }
  return t
    .toLowerCase()
    .replace(/\(.*\)/, "")
    .trim();
}

function normCondition(cond: string): string {
  return cond
    .trim()
    .replace(/\band\b/g, "&&")
    .replace(/\bor\b/g, "||")
    .replace(/\bnot\s+/g, "! ");
}

function fmtFloat(n: number): string {
  return n === Math.floor(n) ? String(Math.floor(n)) : String(n);
}

function stripRpyTags(s: string): string {
  return s.replace(/\{[^{}]*\}/g, "").trim();
}

// ─── imspec helpers ───────────────────────────────────────────────────────────
//
// imspec is one of:
//   (name_tuple, at_list, layer)                            — length 3
//   (name_tuple, expression, tag, at_list, layer, zorder)  — length 6
//   (name_tuple, expression, tag, at_list, layer, zorder, behind) — length 7
//
// name_tuple is a tuple/list of strings like ("hiro", "casual") or
// ("bg", "cabin_day").
//
// at_list contains position expressions like "left", "right", "center",
// or custom Position(...) strings.

interface ImspecResult {
  /** Joined image key, e.g. "hiro_casual" or "bg_cabin_day" */
  key: string;
  /** The first element of the name tuple — used as the character tag */
  tag: string;
  /** Position string if found in at_list, otherwise null */
  pos: string | null;
  /** Transition string if found, otherwise null */
  trans: string | null;
}

const KNOWN_POSITIONS = new Set([
  "left",
  "cleft",
  "center",
  "cright",
  "right",
  "truecenter",
  "left1",
  "left2",
  "left3",
  "left4",
  "right1",
  "right2",
  "right3",
  "right4",
]);

function parseImspec(imspec: PickleValue): ImspecResult {
  const items = asList(imspec);
  if (!items || items.length === 0) {
    return { key: "unknown", tag: "unknown", pos: null, trans: null };
  }

  // name_tuple: items[0]
  const nameTupleRaw = items[0];
  const nameParts: string[] = [];
  const nameList = asList(nameTupleRaw);
  if (nameList) {
    for (const part of nameList) {
      const s = asString(part);
      if (s) nameParts.push(s);
    }
  } else {
    const s = asString(nameTupleRaw);
    if (s) nameParts.push(s);
  }
  const key = nameParts.join("_");
  const tag = nameParts[0] ?? "unknown";

  // at_list: items[1] for length-3, items[3] for length 6/7
  let atListRaw: PickleValue = null;
  if (items.length === 3) {
    atListRaw = items[1];
  } else if (items.length >= 6) {
    atListRaw = items[3];
  }

  let pos: string | null = null;
  const atList = asList(atListRaw);
  if (atList) {
    for (const atItem of atList) {
      const s = asString(atItem);
      if (s) {
        const low = s.toLowerCase().trim();
        if (KNOWN_POSITIONS.has(low)) {
          pos = low;
          break;
        }
        // Custom position variable — keep as-is if it looks like a simple ident
        if (/^[a-z_][a-z0-9_]*$/i.test(low)) {
          pos = low;
          break;
        }
      }
    }
  }

  return { key, tag, pos, trans: null };
}

// ─── Converter class ──────────────────────────────────────────────────────────

interface SpeakLine {
  text: string;
  voice: string | null;
}

interface SpeakBuffer {
  who: string;
  lines: SpeakLine[];
}

class AstConverter {
  private out: string[] = [];
  private depth = 0;
  private speakBuf: SpeakBuffer | null = null;
  private pendingVoice: string | null = null;
  private pendingWith: string | null = null;
  /** label name → exit label for minigame stubs */
  private stubMap: Map<string, string>;

  constructor(
    private readonly filename: string,
    private readonly translationMap?: Map<string, string>,
    stubs?: Array<{ entryLabel: string; exitLabel: string }>,
  ) {
    this.stubMap = new Map(
      stubs?.map((s) => [s.entryLabel, s.exitLabel]) ?? [],
    );
  }

  // ── Output helpers ──────────────────────────────────────────────────────────

  private pad(): string {
    return "  ".repeat(this.depth);
  }

  private emit(line: string): void {
    this.out.push(line);
  }

  private translate(text: string): string {
    if (!this.translationMap) return text;
    return this.translationMap.get(text) ?? text;
  }

  // ── speak buffer ────────────────────────────────────────────────────────────

  private flushSpeak(): void {
    if (!this.speakBuf) return;
    const { who, lines } = this.speakBuf;
    this.speakBuf = null;

    const pad = this.pad();
    if (lines.length === 1) {
      const { text, voice } = lines[0];
      const voicePart = voice ? ` | "${escStr(voice)}"` : "";
      this.emit(
        `${pad}speak ${fmtSpeaker(who)} "${escStr(text)}"${voicePart};`,
      );
    } else {
      this.emit(`${pad}speak ${fmtSpeaker(who)} {`);
      for (const { text, voice } of lines) {
        const voicePart = voice ? ` | "${escStr(voice)}"` : "";
        this.emit(`${pad}  "${escStr(text)}"${voicePart};`);
      }
      this.emit(`${pad}}`);
    }
  }

  private addSpeakLine(who: string, text: string, voice: string | null): void {
    if (this.speakBuf && this.speakBuf.who === who) {
      this.speakBuf.lines.push({ text, voice });
    } else {
      this.flushSpeak();
      this.speakBuf = { who, lines: [{ text, voice }] };
    }
  }

  // ── Top-level node list dispatcher ──────────────────────────────────────────

  /**
   * Walk a flat list of AST nodes (as emitted by Ren'Py's AST serialiser)
   * and emit rrs lines.  Ren'Py stores the AST as a flat linked list; block
   * structure (label/if/menu bodies) is encoded via the `block` field on
   * container nodes, not via nesting in the list.
   *
   * We therefore process nodes from the top-level list and recurse into
   * `block` fields where present.
   */
  processNodes(nodes: PickleValue[]): void {
    for (const node of nodes) {
      if (!isPickleObject(node)) continue;
      this.processNode(node);
    }
  }

  private processNode(node: PickleObject): void {
    const cls = shortClass(node);

    switch (cls) {
      case "Label":
        this.processLabel(node);
        break;
      case "Say":
      case "TranslateSay":
        this.processSay(node);
        break;
      case "Show":
        this.processShow(node);
        break;
      case "Scene":
        this.processScene(node);
        break;
      case "Hide":
        this.processHide(node);
        break;
      case "With":
        this.processWithNode(node);
        break;
      case "Jump":
        this.processJump(node);
        break;
      case "Call":
        this.processCall(node);
        break;
      case "Return":
        this.processReturn();
        break;
      case "Menu":
        this.processMenu(node);
        break;
      case "If":
        this.processIf(node);
        break;
      case "While":
        this.processWhile(node);
        break;
      case "Python":
      case "EarlyPython":
        this.processPython(node);
        break;
      case "Define":
        this.processDefine(node);
        break;
      case "Default":
        this.processDefault(node);
        break;
      case "Init":
        this.processInit(node);
        break;
      case "UserStatement":
        this.processUserStatement(node);
        break;
      case "Pass":
      case "EndTranslate":
      case "TranslateBlock":
      case "TranslateEarlyBlock":
      case "TranslatePython":
      case "TranslateString":
      case "Translate":
        // skip translation infrastructure nodes silently
        break;
      case "Image":
        this.processImage(node);
        break;
      default:
        // Emit a comment so the output is traceable
        this.emit(`${this.pad()}// [rpyc skip] ${cls} (${node.className})`);
        break;
    }
  }

  // ── Label ───────────────────────────────────────────────────────────────────

  private processLabel(node: PickleObject): void {
    this.flushSpeak();

    const name = asString(getField(node, "name") ?? null) ?? "unknown";
    const hide = getField(node, "hide");

    // Skip "hide" labels (internal Ren'Py use)
    if (hide === true || hide === 1) return;

    // Close any open label before starting a new one
    if (this.depth > 0) {
      this.depth--;
      this.emit(this.pad() + "}");
    }

    // Minigame stub: emit a pass-through label and skip the entire body.
    const stubExit = this.stubMap.get(name);
    if (stubExit !== undefined) {
      this.emit(`label ${name} {`);
      this.emit(`  jump ${stubExit};`);
      this.emit(`}`);
      // depth stays at 0 — no block is processed
      return;
    }

    this.emit(`label ${name} {`);
    this.depth = 1;

    const blockRaw = getField(node, "block");
    const block = asList(blockRaw ?? null);
    if (block) {
      this.processNodes(block);
    }
  }

  // ── Say ─────────────────────────────────────────────────────────────────────

  private processSay(node: PickleObject): void {
    const whoRaw = getField(node, "who");
    const whatRaw = getField(node, "what");
    const withRaw = getField(node, "with_");

    const who = asString(whoRaw ?? null) ?? "";
    const rawWhat = asString(whatRaw ?? null) ?? "";
    const what = this.translate(stripRpyTags(rawWhat));

    // Voice may have been queued by a preceding UserStatement (voice line)
    const voice = this.pendingVoice;
    this.pendingVoice = null;

    // who == "" → narration (no character)
    const speaker = who === "" || whoRaw === null ? "narrator" : who;

    this.addSpeakLine(speaker, what, voice);

    // Handle trailing `with` on the say node
    const withExpr = asString(withRaw ?? null);
    if (withExpr && withExpr !== "None") {
      const trans = normTransition(withExpr);
      if (trans) this.pendingWith = trans;
    }
  }

  // ── Show ─────────────────────────────────────────────────────────────────────

  private processShow(node: PickleObject): void {
    this.flushSpeak();

    const imspec = getField(node, "imspec");
    if (!imspec) return;

    const { key, pos } = parseImspec(imspec);

    // Collect "with" from the node's own with_ field if any
    const withRaw = getField(node, "with_");
    const withExpr = asString(withRaw ?? null);
    const trans =
      withExpr && withExpr !== "None" ? normTransition(withExpr) : null;

    // Consume any pending `with` transition generated by a With node that
    // immediately preceded this Show.
    const effectiveTrans = this.pendingWith ?? trans;
    this.pendingWith = null;

    const posPart = pos ? ` @ ${pos}` : "";
    const transPart = effectiveTrans ? ` | ${effectiveTrans}` : "";

    // Determine if this is show or expr (expression — face-only change).
    // In Ren'Py's AST there is no separate "expr" node; expr is just a show
    // with attributes. We emit "show" for everything; the engine can handle it.
    this.emit(`${this.pad()}show ${key}${posPart}${transPart};`);
  }

  // ── Scene ────────────────────────────────────────────────────────────────────

  private processScene(node: PickleObject): void {
    this.flushSpeak();

    const imspec = getField(node, "imspec");

    const withRaw = getField(node, "with_");
    const withExpr = asString(withRaw ?? null);
    const effectiveTrans =
      this.pendingWith ??
      (withExpr && withExpr !== "None" ? normTransition(withExpr) : null);
    this.pendingWith = null;

    const transPart = effectiveTrans ? ` | ${effectiveTrans}` : "";

    if (!imspec || imspec === null) {
      // `scene` with no image → clear the screen
      this.emit(`${this.pad()}scene #000000${transPart};`);
      return;
    }

    const { key } = parseImspec(imspec);

    // Detect solid colour scenes that Ren'Py encodes as e.g. ("black",)
    // or images whose key starts with "#"
    if (key === "black") {
      this.emit(`${this.pad()}scene #000000${transPart};`);
    } else if (key === "white") {
      this.emit(`${this.pad()}scene #ffffff${transPart};`);
    } else {
      this.emit(`${this.pad()}scene "${key}"${transPart};`);
    }
  }

  // ── Hide ─────────────────────────────────────────────────────────────────────

  private processHide(node: PickleObject): void {
    this.flushSpeak();

    const imspec = getField(node, "imspec");
    if (!imspec) return;

    const { key } = parseImspec(imspec);
    this.emit(`${this.pad()}hide ${key};`);
  }

  // ── With ─────────────────────────────────────────────────────────────────────

  private processWithNode(node: PickleObject): void {
    const exprRaw = getField(node, "expr");
    const expr = asString(exprRaw ?? null);
    if (!expr || expr === "None") return;

    const trans = normTransition(expr);
    if (!trans) return;

    this.flushSpeak();

    // If there's a pending with queued (from a show without its own trans),
    // emit it as a standalone `with transition;`
    this.pendingWith = trans;
    // We emit it immediately here as a standalone transition statement.
    // The next node may also pick it up via pendingWith, but that's fine
    // because the standalone emission conveys the intent.
    this.emit(`${this.pad()}with ${trans};`);
    this.pendingWith = null;
  }

  // ── Jump ─────────────────────────────────────────────────────────────────────

  private processJump(node: PickleObject): void {
    this.flushSpeak();

    const target = asString(getField(node, "target") ?? null) ?? "unknown";
    this.emit(`${this.pad()}jump ${target};`);
  }

  // ── Call ─────────────────────────────────────────────────────────────────────

  private processCall(node: PickleObject): void {
    this.flushSpeak();

    const label = asString(getField(node, "label") ?? null) ?? "unknown";
    this.emit(`${this.pad()}call ${label};`);
  }

  // ── Return ───────────────────────────────────────────────────────────────────

  private processReturn(): void {
    this.flushSpeak();
    this.emit(`${this.pad()}return;`);
  }

  // ── Menu ─────────────────────────────────────────────────────────────────────

  private processMenu(node: PickleObject): void {
    this.flushSpeak();

    const itemsRaw = getField(node, "items");
    const itemsList = asList(itemsRaw ?? null);
    if (!itemsList || itemsList.length === 0) return;

    this.emit(`${this.pad()}menu {`);
    this.depth++;

    for (const item of itemsList) {
      const itemArr = asList(item);
      if (!itemArr || itemArr.length < 2) continue;

      // item = (label_str, condition_str, block_list_or_None)
      const labelStr = asString(itemArr[0]);
      const condRaw = asString(itemArr[1]);
      const blockRaw = itemArr[2] ?? null;

      if (labelStr === null) continue;

      const translated = this.translate(stripRpyTags(labelStr));
      const condPart =
        condRaw && condRaw !== "True" && condRaw.trim() !== "True"
          ? ` if ${normCondition(condRaw)}`
          : "";

      const blockNodes = asList(blockRaw ?? null);
      if (!blockNodes) {
        // Caption-only item (no block) — emit as comment
        this.emit(`${this.pad()}// [caption] "${escStr(translated)}"`);
        continue;
      }

      this.emit(`${this.pad()}"${escStr(translated)}"${condPart} => {`);
      this.depth++;
      this.processNodes(blockNodes);
      this.flushSpeak();
      this.depth--;
      this.emit(`${this.pad()}}`);
    }

    this.depth--;
    this.emit(`${this.pad()}}`);
  }

  // ── If ───────────────────────────────────────────────────────────────────────

  private processIf(node: PickleObject): void {
    this.flushSpeak();

    const entriesRaw = getField(node, "entries");
    const entries = asList(entriesRaw ?? null);
    if (!entries || entries.length === 0) return;

    for (let i = 0; i < entries.length; i++) {
      const entry = asList(entries[i]);
      if (!entry || entry.length < 2) continue;

      const condRaw = asString(entry[0]) ?? "True";
      const blockNodes = asList(entry[1]);
      if (!blockNodes) continue;

      const isElse = condRaw === "True";

      if (i === 0) {
        this.emit(`${this.pad()}if ${normCondition(condRaw)} {`);
      } else if (isElse) {
        // Merge the closing brace of the previous branch with `else {`.
        const prev = this.out[this.out.length - 1];
        if (prev === `${this.pad()}}`) {
          this.out[this.out.length - 1] = `${this.pad()}} else {`;
        } else {
          this.emit(`${this.pad()}} else {`);
        }
      } else {
        // Merge the closing brace of the previous branch with `elif … {`.
        const prev = this.out[this.out.length - 1];
        if (prev === `${this.pad()}}`) {
          this.out[this.out.length - 1] =
            `${this.pad()}} elif ${normCondition(condRaw)} {`;
        } else {
          this.emit(`${this.pad()}} elif ${normCondition(condRaw)} {`);
        }
      }

      this.depth++;
      this.processNodes(blockNodes);
      this.flushSpeak();
      this.depth--;
      this.emit(`${this.pad()}}`);
    }
  }

  // ── While ────────────────────────────────────────────────────────────────────

  private processWhile(node: PickleObject): void {
    this.flushSpeak();
    // Ren'Py `while` is rare in VN scripts; emit as a comment placeholder.
    const cond = asString(getField(node, "condition") ?? null) ?? "True";
    this.emit(`${this.pad()}// [while ${normCondition(cond)}] — not converted`);
  }

  // ── Python / EarlyPython ─────────────────────────────────────────────────────
  //
  // Python nodes contain a PyCode whose source field has the raw Python.
  // We handle the common patterns:
  //   - Variable assignment:  foo = 1 / foo += 1
  //   - renpy.pause(X)       → wait(X);
  //   - renpy.jump(X)        → jump X;
  //   - renpy.call(X)        → call X;
  //   - Position(xpos=...)   → position.VAR = ...;
  //   Everything else is emitted as a comment.

  private processPython(node: PickleObject): void {
    const codeObj = getField(node, "code") ?? null;
    const src = isPickleObject(codeObj)
      ? asString(getField(codeObj, "source") ?? null)
      : asString(codeObj);
    if (!src) return;

    // Process each line of the python block
    for (const rawLine of src.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      this.processPythonLine(line);
    }
  }

  private processPythonLine(line: string): void {
    // renpy.pause(X)
    const pauseM = line.match(/^renpy\.pause\s*\(\s*([\d.]+)/);
    if (pauseM) {
      this.flushSpeak();
      this.emit(`${this.pad()}wait(${fmtFloat(parseFloat(pauseM[1]))});`);
      return;
    }
    if (/^renpy\.pause\s*\(/.test(line)) return; // no-arg pause, skip

    // renpy.jump(VAR)
    const jumpM = line.match(/^renpy\.jump\s*\(\s*["']?(\w+)["']?\s*\)/);
    if (jumpM) {
      this.flushSpeak();
      this.emit(`${this.pad()}jump ${jumpM[1]};`);
      return;
    }

    // renpy.call(VAR)
    const callM = line.match(/^renpy\.call\s*\(\s*["']?(\w+)["']?\s*\)/);
    if (callM) {
      this.flushSpeak();
      this.emit(`${this.pad()}call ${callM[1]};`);
      return;
    }

    // renpy.music.stop(fadeout=X)
    const musicStopM = line.match(
      /^renpy\.music\.stop\s*\(.*?fadeout\s*=\s*([\d.]+)/,
    );
    if (musicStopM) {
      this.flushSpeak();
      this.emit(
        `${this.pad()}music::stop() | fadeout(${fmtFloat(parseFloat(musicStopM[1]))});`,
      );
      return;
    }
    if (/^renpy\.music\.stop\s*\(/.test(line)) {
      this.flushSpeak();
      this.emit(`${this.pad()}music::stop();`);
      return;
    }

    // Position variable assignment: VAR = Position(xpos=X)
    const posM = line.match(/^(\w+)\s*=\s*Position\s*\(\s*xpos\s*=\s*([\d.]+)/);
    if (posM) {
      this.emit(`position.${posM[1]} = ${posM[2]};`);
      return;
    }

    // Simple variable assignment / augmented assignment
    const assignM = line.match(/^([\w.]+)\s*(=|\+=|-=|\*=|\/=)\s*(.+)$/);
    if (assignM) {
      const varName = assignM[1];
      const op = assignM[2];
      let val = assignM[3].trim();

      // Skip renpy internals
      if (
        varName.startsWith("renpy.") ||
        varName.startsWith("persistent.") ||
        varName.startsWith("config.")
      ) {
        return;
      }

      val = val.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false");

      // Strip trailing comments
      const commentIdx = val.indexOf("#");
      if (commentIdx > 0) val = val.slice(0, commentIdx).trim();

      this.flushSpeak();
      this.emit(`${this.pad()}${varName} ${op} ${val};`);
      return;
    }

    // Unrecognised — emit as comment so nothing is silently lost
    this.emit(`${this.pad()}// [py] ${line}`);
  }

  // ── Define ───────────────────────────────────────────────────────────────────

  private processDefine(node: PickleObject): void {
    const store = asString(getField(node, "store") ?? null) ?? "store";
    const varname = asString(getField(node, "varname") ?? null) ?? "";

    const codeObj = getField(node, "code") ?? null;
    const src = isPickleObject(codeObj)
      ? asString(getField(codeObj, "source") ?? null)
      : asString(codeObj);
    if (!src) return;

    const key =
      store === "store"
        ? varname
        : `${store.replace(/^store\./, "")}.${varname}`;

    // audio.XXX = "path"
    if (key.startsWith("audio.")) {
      this.emit(`${key} = ${src.trim()};`);
      return;
    }

    // Character definition: Character("Name") or Character(name="Name")
    const charNameM = src.match(
      /Character\s*\(\s*(?:name\s*=\s*)?["']([^"']+)["']/,
    );
    if (charNameM) {
      this.emit(`char.${varname} = "${escStr(charNameM[1])}";`);
      return;
    }

    // Position(...) → position.VAR = xpos
    const posM = src.match(/Position\s*\(\s*xpos\s*=\s*([\d.]+)/);
    if (posM) {
      this.emit(`position.${varname} = ${posM[1]};`);
      return;
    }

    // Generic constant — emit only at top-level (depth == 0)
    if (this.depth === 0) {
      let val = src.trim();
      val = val.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false");
      this.emit(`${key} = ${val};`);
    }
  }

  // ── Default ──────────────────────────────────────────────────────────────────

  private processDefault(node: PickleObject): void {
    const varname = asString(getField(node, "varname") ?? null) ?? "";
    const codeObj = getField(node, "code") ?? null;
    const src = isPickleObject(codeObj)
      ? asString(getField(codeObj, "source") ?? null)
      : asString(codeObj);
    if (!src || !varname) return;

    let val = src.trim();
    val = val.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false");

    this.emit(`${this.pad()}${varname} = ${val};`);
  }

  // ── Init ─────────────────────────────────────────────────────────────────────

  private processInit(node: PickleObject): void {
    // Init blocks contain define/image/etc. — recurse into them
    const blockRaw = getField(node, "block");
    const block = asList(blockRaw ?? null);
    if (block) {
      this.processNodes(block);
    }
  }

  // ── Image ────────────────────────────────────────────────────────────────────

  private processImage(node: PickleObject): void {
    // image declarations are emitted as image.key = "path" defines
    const imgname = getField(node, "imgname");
    const nameParts: string[] = [];
    const nameList = asList(imgname ?? null);
    if (nameList) {
      for (const p of nameList) {
        const s = asString(p);
        if (s) nameParts.push(s);
      }
    }
    if (nameParts.length === 0) return;

    const key = nameParts
      .join("_")
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_");

    const codeObj = getField(node, "code") ?? null;
    let src: string | null = null;
    if (isPickleObject(codeObj)) {
      src = asString(getField(codeObj, "source") ?? null);
    } else if (codeObj !== null) {
      src = asString(codeObj);
    }

    if (src) {
      // e.g. src = '"images/bg_cabin.jpg"' or 'im.Scale(...)'
      const strM = src.match(/^["']([^"']+)["']$/);
      if (strM) {
        this.emit(`image.${key} = "${escStr(strM[1])}";`);
        return;
      }
      const movieM = src.match(/Movie\s*\(\s*(?:play\s*=\s*)?["']([^"']+)["']/);
      if (movieM) {
        this.emit(`image.${key} = "${escStr(movieM[1])}";`);
        return;
      }
    }

    // Couldn't resolve path — emit comment
    this.emit(`// [image] ${nameParts.join(" ")} (path not resolved)`);
  }

  // ── UserStatement ────────────────────────────────────────────────────────────
  //
  // UserStatement.line contains the raw text of the statement.
  // Common patterns we care about:
  //   voice "path/to/voice.ogg"   → queued as pendingVoice for next Say

  private processUserStatement(node: PickleObject): void {
    const lineRaw = getField(node, "line");
    const line = asString(lineRaw ?? null) ?? "";

    // voice "..."
    const voiceM = line.match(/^(?:play\s+)?voice\s+["']([^"']+)["']/);
    if (voiceM) {
      this.pendingVoice = voiceM[1];
      return;
    }

    // voice audio.VAR
    const voiceAudioM = line.match(/^(?:play\s+)?voice\s+audio\.(\w+)/);
    if (voiceAudioM) {
      this.pendingVoice = `audio.${voiceAudioM[1]}`;
      return;
    }

    // nvl clear / window auto / etc. — skip silently
  }

  // ── Main entry point ─────────────────────────────────────────────────────────

  convert(rootNodes: PickleValue[]): string {
    this.emit(`// Source: ${this.filename}`);
    this.emit("");

    this.processNodes(rootNodes);

    // Flush any trailing speak buffer
    this.flushSpeak();

    // Close any open label block
    if (this.depth > 0) {
      this.depth = 0;
      this.emit("}");
    }

    return this.out.join("\n") + "\n";
  }
}

// ─── AST minigame detection ───────────────────────────────────────────────────
//
// Mirrors the four-phase logic of minigame-detect.ts (scanFile →
// classifyAndMerge → findEntryCandidates → collectExternalExits) but works
// directly on the structured PickleObject AST instead of raw text.
//
// The same LabelInfo shape is used so the classification and BFS phases need
// no changes.

interface AstLabelInfo {
  jumpsTo: Set<string>; // targets that may be local (reclassified below)
  externalJumps: Set<string>; // targets confirmed outside this file
  callsScreen: boolean;
  hasDialogue: boolean;
}

/** Recursively collect all Jump/Call targets and dialogue flags from a node list. */
function scanAstNodes(
  nodes: PickleValue[],
  info: AstLabelInfo,
  localLabels: Set<string>,
  screenJumps: Map<string, Set<string>>,
  inScreen: boolean,
): void {
  for (const raw of nodes) {
    if (!isPickleObject(raw)) continue;
    const cls = shortClass(raw);

    switch (cls) {
      case "Jump": {
        const target = asString(getField(raw, "target") ?? null);
        if (target) {
          if (inScreen) {
            // screen-level jump → record in screenJumps for the current label
            // (we propagate screenJumps into label info in classifyAndMergeAst)
          } else {
            info.jumpsTo.add(target);
          }
        }
        break;
      }
      case "Call": {
        const target = asString(getField(raw, "label") ?? null);
        if (target) info.jumpsTo.add(target);
        break;
      }
      case "Say":
      case "TranslateSay":
        if (!inScreen) info.hasDialogue = true;
        break;
      case "UserStatement": {
        const line = asString(getField(raw, "line") ?? null) ?? "";
        // call screen / show screen → marks label as screen-calling
        if (/^(?:call|show)\s+screen\s+\w+/.test(line)) {
          if (!inScreen) info.callsScreen = true;
        }
        // renpy.pause() is also used by show-screen-based minigames
        if (/renpy\.pause\s*\(/.test(line)) {
          if (!inScreen) info.callsScreen = true;
        }
        // screen-level Jump("target") calls
        if (inScreen) {
          const jumpM = line.matchAll(/\bJump\s*\(\s*['"]?(\w+)['"]?\s*\)/g);
          for (const m of jumpM) info.jumpsTo.add(m[1]);
          const rpyM = line.matchAll(
            /renpy\.jump\s*\(\s*['"]?(\w+)['"]?\s*\)/g,
          );
          for (const m of rpyM) info.jumpsTo.add(m[1]);
        }
        break;
      }
      case "Python":
      case "EarlyPython": {
        // $ renpy.jump('target') / renpy.jump(var) inside python blocks
        const codeObj = getField(raw, "code") ?? null;
        const src = isPickleObject(codeObj)
          ? asString(getField(codeObj, "source") ?? null)
          : asString(codeObj);
        if (src) {
          const rpyJumps = src.matchAll(
            /renpy\.jump\s*\(\s*['"]?([A-Za-z_]\w*)['"]?\s*\)/g,
          );
          for (const m of rpyJumps) info.jumpsTo.add(m[1]);
        }
        break;
      }
      case "If": {
        const entries = asList(getField(raw, "entries") ?? null);
        if (entries) {
          for (const entry of entries) {
            const pair = asList(entry);
            if (pair && pair.length >= 2) {
              const block = asList(pair[1]);
              if (block)
                scanAstNodes(block, info, localLabels, screenJumps, inScreen);
            }
          }
        }
        break;
      }
      case "Menu": {
        const items = asList(getField(raw, "items") ?? null);
        if (items) {
          for (const item of items) {
            const itemArr = asList(item);
            if (itemArr && itemArr.length >= 3) {
              const block = asList(itemArr[2]);
              if (block)
                scanAstNodes(block, info, localLabels, screenJumps, inScreen);
            }
          }
        }
        break;
      }
      case "While": {
        const block = asList(getField(raw, "block") ?? null);
        if (block)
          scanAstNodes(block, info, localLabels, screenJumps, inScreen);
        break;
      }
      // Screen nodes: scan their body for Jump() calls
      case "Screen": {
        const screenNode = getField(raw, "screen") ?? null;
        if (isPickleObject(screenNode)) {
          const name = asString(getField(screenNode, "name") ?? null) ?? "";
          if (!screenJumps.has(name)) screenJumps.set(name, new Set());
          // screen body children are not straightforward to walk (SLAst),
          // so we skip deep traversal here; UserStatement lines above cover
          // the common case of renpy.jump / Jump() in Python blocks inside screens.
        }
        break;
      }
      default:
        break;
    }
  }
}

/**
 * Scan the top-level node list and populate per-label info.
 * Only Label nodes at the top level are treated as file-local labels;
 * their body blocks are scanned recursively.
 */
function scanAstFile(rootNodes: PickleValue[]): {
  localLabels: Set<string>;
  labelInfos: Map<string, AstLabelInfo>;
  screenJumps: Map<string, Set<string>>;
} {
  const localLabels = new Set<string>();
  const labelInfos = new Map<string, AstLabelInfo>();
  const screenJumps = new Map<string, Set<string>>();

  const freshInfo = (): AstLabelInfo => ({
    jumpsTo: new Set(),
    externalJumps: new Set(),
    callsScreen: false,
    hasDialogue: false,
  });

  for (const raw of rootNodes) {
    if (!isPickleObject(raw)) continue;
    const cls = shortClass(raw);

    if (cls === "Label") {
      const hide = getField(raw, "hide");
      if (hide === true || hide === 1) continue;
      const name = asString(getField(raw, "name") ?? null);
      if (!name) continue;
      localLabels.add(name);
      if (!labelInfos.has(name)) labelInfos.set(name, freshInfo());
      const info = labelInfos.get(name)!;
      const block = asList(getField(raw, "block") ?? null);
      if (block) scanAstNodes(block, info, localLabels, screenJumps, false);
    } else if (cls === "Init") {
      // Init blocks may contain Define / Python with renpy.jump calls —
      // scan them but into a temporary sink (they don't produce dialogue or
      // screen calls that affect minigame classification).
      const block = asList(getField(raw, "block") ?? null);
      if (block) {
        // Just collect any top-level Jump targets from init python for the
        // topLevelJumps equivalent — we fold these into each label's external
        // jump set during classifyAndMergeAst.
        const sink = freshInfo();
        scanAstNodes(block, sink, localLabels, screenJumps, false);
        // Propagate any discovered jumps as potential external refs so they
        // don't accidentally mark a label as an entry candidate.
        for (const t of sink.jumpsTo) {
          for (const info of labelInfos.values()) info.jumpsTo.add(t);
        }
      }
    }
  }

  return { localLabels, labelInfos, screenJumps };
}

/** Phase 2: reclassify jumpsTo targets as local vs external. */
function classifyAndMergeAst(
  localLabels: Set<string>,
  labelInfos: Map<string, AstLabelInfo>,
  screenJumps: Map<string, Set<string>>,
): void {
  for (const [, info] of labelInfos) {
    const newJumpsTo = new Set<string>();
    for (const t of info.jumpsTo) {
      if (localLabels.has(t)) {
        newJumpsTo.add(t);
      } else {
        info.externalJumps.add(t);
      }
    }
    info.jumpsTo = newJumpsTo;
  }

  // Merge screen jump targets into the labels that call those screens.
  // Walk each label's block to find which screens it calls, then add those
  // screens' Jump targets into the label's jumpsTo / externalJumps.
  // IMPORTANT: only merge into minigame-candidate labels (callsScreen &&
  // !hasDialogue).  Merging into ordinary dialogue labels would cause large
  // script files to be falsely flagged as minigames when they happen to
  // contain a screen with a Jump() widget.
  for (const [, info] of labelInfos) {
    if (!info.callsScreen) continue;
    if (info.hasDialogue) continue;
    for (const [, targets] of screenJumps) {
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

/** Phase 3: find unreferenced entry-label candidates. */
/**
 * Ren'Py built-in / game-entry reserved label names.
 *
 * These labels are called directly by the Ren'Py engine itself (not by any
 * other label in the game files), so they will always appear as "unreferenced"
 * entry points.  They must never be treated as minigame candidates even when
 * they contain `show screen` / `renpy.pause()` and no dialogue — that is
 * perfectly normal for a splash-screen or game-start initialisation label.
 */
const RENPY_RESERVED_LABELS_AST = new Set([
  "start",
  "splashscreen",
  "main_menu",
  "after_load",
  "quit",
  "after_warp",
  "hide_windows",
]);

function findEntryCandidatesAst(
  localLabels: Set<string>,
  labelInfos: Map<string, AstLabelInfo>,
  screenJumps: Map<string, Set<string>>,
): string[] {
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
    if (RENPY_RESERVED_LABELS_AST.has(name)) return false;
    const info = labelInfos.get(name);
    return info != null && info.callsScreen && !info.hasDialogue;
  });
}

/** Phase 4: BFS to collect all external exit labels reachable from entryLabel. */
function collectExternalExitsAst(
  entryLabel: string,
  labelInfos: Map<string, AstLabelInfo>,
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
    for (const ext of info.externalJumps) externalExits.add(ext);
    for (const local of info.jumpsTo) {
      if (!visited.has(local)) queue.push(local);
    }
  }
  return externalExits;
}

/**
 * Detect minigame labels in a decoded rpyc AST.
 *
 * Mirrors the logic of `detectMinigame()` in minigame-detect.ts but operates
 * on structured PickleObject nodes instead of raw .rpy source text.
 *
 * Returns the same MinigameDetectResult shape so callers can share the
 * `renderMinigameStubs` rendering path.
 */
export function detectMinigameFromAst(
  rootNodes: PickleValue[],
): MinigameDetectResult {
  const warnings: string[] = [];

  // Phase 1: scan
  const { localLabels, labelInfos, screenJumps } = scanAstFile(rootNodes);

  // Phase 2: classify
  classifyAndMergeAst(localLabels, labelInfos, screenJumps);

  // Early-out: if ANY label in the file has dialogue, this is a normal script
  // file (e.g. script.rpy / definitions.rpy).  Minigame files are pure
  // screen-interaction sequences with no character dialogue at all.
  for (const [, info] of labelInfos) {
    if (info.hasDialogue) return { stubs: [], warnings };
  }

  // Phase 3: find candidates
  const candidates = findEntryCandidatesAst(
    localLabels,
    labelInfos,
    screenJumps,
  );
  if (candidates.length === 0) return { stubs: [], warnings };

  // Phase 4: BFS for external exits
  const stubs: MinigameStub[] = [];
  for (const entryLabel of candidates) {
    const exits = collectExternalExitsAst(entryLabel, labelInfos);
    if (exits.size === 0) continue;
    if (exits.size > 1) {
      warnings.push(
        `minigame-detect(ast): entry label "${entryLabel}" has ${exits.size} ` +
          `external exit(s): ${[...exits].join(", ")}. Skipping stub.`,
      );
      continue;
    }
    stubs.push({ entryLabel, exitLabel: [...exits][0] });
  }

  return { stubs, warnings };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Unwrap the root PickleValue from a .rpyc decode into a flat list of
 * renpy.ast.* PickleObject nodes.
 *
 * Ren'Py 7/8 serialises the AST root as a plain list; some older versions
 * wrap it in a tuple.  A single bare node is also handled as a fallback.
 *
 * Exported so callers (e.g. Tools.tsx) can run minigame detection before
 * calling convertRpyc, without duplicating the unwrap logic.
 */
export function unwrapAstNodes(astPickle: PickleValue): PickleValue[] {
  // Plain list — the most common case for older Ren'Py versions.
  if (Array.isArray(astPickle)) return astPickle as PickleValue[];

  if (
    astPickle !== null &&
    typeof astPickle === "object" &&
    (astPickle as { _type?: string })._type === "tuple"
  ) {
    const tup = astPickle as { _type: "tuple"; items: PickleValue[] };

    // Ren'Py 8.x serialises the AST slot as a 2-tuple:
    //   (metadata_dict, node_list)
    // where metadata_dict is a Map with at least "version" and "key" keys,
    // and node_list is the flat list of top-level renpy.ast.* nodes.
    if (
      tup.items.length === 2 &&
      tup.items[0] instanceof Map &&
      Array.isArray(tup.items[1])
    ) {
      return tup.items[1] as PickleValue[];
    }

    // Older format: the tuple itself IS the node list (each item is a node).
    // Also handles single-element tuples wrapping a node list.
    if (tup.items.length === 1 && Array.isArray(tup.items[0])) {
      return tup.items[0] as PickleValue[];
    }

    // Fallback: treat each tuple item as a top-level node.
    return tup.items;
  }

  if (isPickleObject(astPickle)) return [astPickle];
  return [];
}

/**
 * Convert the decoded AST from a .rpyc file to .rrs source text.
 *
 * Minigame detection is intentionally NOT performed here — callers should
 * call detectMinigameFromAst(unwrapAstNodes(astPickle)) first and handle
 * stubs via renderMinigameStubs before calling this function.  This keeps
 * the responsibility (and log output) in one place, mirroring the .rpy path.
 *
 * @param astPickle       The root PickleValue from RpycFile.astPickle.
 * @param filename        Logical filename for the `// Source:` comment.
 * @param translationMap  Optional map of english text → translated text.
 * @returns               The converted .rrs source string.
 */
export function convertRpyc(
  astPickle: PickleValue,
  filename: string,
  translationMap?: Map<string, string>,
  stubs?: Array<{ entryLabel: string; exitLabel: string }>,
): string {
  const rootNodes = unwrapAstNodes(astPickle);
  const converter = new AstConverter(filename, translationMap, stubs);
  return converter.convert(rootNodes);
}
