// ── Code generator: .rrs AST → engine JSON steps ─────────────────────────────
//
// Key responsibilities:
//   • Emit engine-compatible JSON step objects for every AST node
//   • Resolve image keys via the flat defines dict:
//       show cg.arrival2  →  lookup "image.cg.arrival2"  →  "CGs/cg1_arrival2.jpg"
//       scene bg_entrance_day  →  lookup "image.bg_entrance_day"  →  "BGs/entrance_day.jpg"
//   • Resolve character names via char.* entries
//   • Resolve audio aliases via audio.* entries
//   • NO hardcoded sprite path conventions (Sprites/Body/…, Sprites/Faces/…)
//   • NO game-specific prefix heuristics (cg_, bg_, sx_)

import type {
  AssignStmt,
  CallStmt,
  DefineDecl,
  HideStmt,
  IfStmt,
  JsonFile,
  JsonLabel,
  JsonStep,
  JumpStmt,
  LabelDecl,
  LabelStmt,
  MenuStmt,
  MusicStmt,
  Program,
  ReturnStmt,
  SceneStmt,
  ShowStmt,
  SoundStmt,
  SpeakStmt,
  Stmt,
  WaitStmt,
  WithStmt,
} from "./ast.ts";

import { registerPosition } from "../assets";

// ── Define map builder ────────────────────────────────────────────────────────

/**
 * Build resolution maps from the top-level define declarations.
 *
 * All top-level `A = B;` declarations go into a single flat dict.
 * Entries are split by key prefix:
 *
 *   char.*      → charMap   (abbr → full name)
 *   audio.*     → audioMap  (alias → path)
 *   image.*     → imageMap  (full "image.x.y" key → file path)
 *   position.*  → registered directly with registerPosition()
 *   everything else → ignored (constants, game-state vars, etc.)
 *
 * Image keys keep the full `image.` prefix so lookups from genShow/genScene
 * can prepend "image." to the DSL key and query the map directly:
 *   DSL key "cg.arrival2"  →  lookup "image.cg.arrival2"
 *   DSL key "bg_entrance_day"  →  lookup "image.bg_entrance_day"
 */
export function buildDefineMaps(
  defines: DefineDecl[],
  globalCharMap?: Map<string, string>,
  globalImageMap?: Map<string, string>,
): {
  charMap: Map<string, string>;
  audioMap: Map<string, string>;
  imageMap: Map<string, string>;
} {
  const charMap = new Map<string, string>(globalCharMap);
  const audioMap = new Map<string, string>();
  const imageMap = new Map<string, string>(globalImageMap);

  for (const d of defines) {
    if (d.key.startsWith("char.")) {
      charMap.set(d.key.slice("char.".length), d.value);
    } else if (d.key.startsWith("audio.")) {
      audioMap.set(d.key.slice("audio.".length), d.value);
    } else if (d.key.startsWith("image.")) {
      // Store with full key including "image." prefix
      imageMap.set(d.key, d.value);
    } else if (d.key.startsWith("position.")) {
      const xpos = parseFloat(d.value);
      if (!isNaN(xpos)) registerPosition(d.key.slice("position.".length), xpos);
    }
    // Other entries (constants, game-state vars, etc.) are not needed at
    // codegen time and are intentionally ignored here.
  }

  return { charMap, audioMap, imageMap };
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Compile a parsed .rrs program into a ScriptFile (engine-ready JSON).
 */
export function compile(
  program: Program,
  sourceName: string,
  globalCharMap?: Map<string, string>,
  globalImageMap?: Map<string, string>,
): JsonFile {
  program = hoistNestedLabels(program);

  const labels: Record<string, JsonLabel> = {};
  const { charMap, audioMap, imageMap } = buildDefineMaps(
    program.defines,
    globalCharMap,
    globalImageMap,
  );

  for (const label of program.labels) {
    const ctx = new CodegenContext(charMap, audioMap, imageMap);
    labels[label.name] = ctx.genLabel(label);
  }

  return { source: sourceName, labels };
}

/**
 * Lift nested LabelStmt nodes out of label bodies into the top-level labels
 * list.  This makes every label a first-class entry in the compiled output,
 * matching how RenPy treats nested label declarations.
 */
function hoistNestedLabels(prog: Program): Program {
  const extraLabels: LabelDecl[] = [];

  function walkStmts(stmts: Stmt[]): Stmt[] {
    const out: Stmt[] = [];
    for (const stmt of stmts) {
      if (stmt.kind === "Label") {
        extraLabels.push({ name: stmt.name, body: walkStmts(stmt.body) });
        continue;
      }
      if (stmt.kind === "If") {
        out.push({
          ...stmt,
          branches: stmt.branches.map((b) => ({
            ...b,
            body: walkStmts(b.body),
          })),
        });
        continue;
      }
      if (stmt.kind === "Menu") {
        out.push({
          ...stmt,
          choices: stmt.choices.map((c) => ({
            ...c,
            body: walkStmts(c.body),
          })),
        });
        continue;
      }
      out.push(stmt);
    }
    return out;
  }

  const newLabels = prog.labels.map((lbl) => ({
    ...lbl,
    body: walkStmts(lbl.body),
  }));

  return { ...prog, labels: [...newLabels, ...extraLabels] };
}

// ── Code generation context (one instance per label) ─────────────────────────

class CodegenContext {
  /**
   * Character abbreviation → full name  (from top-level `char.*` declarations).
   */
  private charMap: Map<string, string>;

  /**
   * Audio alias → full path  (from `audio.*` declarations).
   */
  private audioMap: Map<string, string>;

  /**
   * Full image key (with "image." prefix) → file path.
   * e.g. "image.cg.arrival2" → "CGs/cg1_arrival2.jpg"
   *      "image.keitaro_casual" → "Sprites/Body/keitaro1_b_casual.png"
   */
  private imageMap: Map<string, string>;

  constructor(
    charMap: Map<string, string> = new Map(),
    audioMap: Map<string, string> = new Map(),
    imageMap: Map<string, string> = new Map(),
  ) {
    this.charMap = charMap;
    this.audioMap = audioMap;
    this.imageMap = imageMap;
  }

  // ── Label ─────────────────────────────────────────────────────────────────

  genLabel(label: LabelDecl): JsonLabel {
    return label.body.flatMap((s) => this.genStmt(s));
  }

  // ── Statement dispatch ────────────────────────────────────────────────────

  genStmt(stmt: Stmt): JsonStep[] {
    switch (stmt.kind) {
      case "Assign":
        return this.genAssign(stmt);
      case "Scene":
        return this.genScene(stmt);
      case "Music":
        return this.genMusic(stmt);
      case "Sound":
        return this.genSound(stmt);
      case "Show":
        return this.genShow(stmt);
      case "Hide":
        return this.genHide(stmt);
      case "With":
        return this.genWith(stmt);
      case "Speak":
        return this.genSpeak(stmt);
      case "Wait":
        return this.genWait(stmt);
      case "If":
        return this.genIf(stmt);
      case "Menu":
        return this.genMenu(stmt);
      case "Jump":
        return this.genJump(stmt);
      case "Call":
        return this.genCall(stmt);
      case "Return":
        return this.genReturn(stmt);
      case "Label":
        // Already hoisted; nothing to emit inline.
        return this.genNestedLabel(stmt);
    }
  }

  private genNestedLabel(_stmt: LabelStmt): JsonStep[] {
    return [];
  }

  // ── Assign ────────────────────────────────────────────────────────────────

  private genAssign(stmt: AssignStmt): JsonStep[] {
    return [{ type: "set", var: stmt.name, op: stmt.op, value: stmt.value }];
  }

  // ── Image resolution ──────────────────────────────────────────────────────

  /**
   * Resolve a DSL image variable reference to its file path.
   *
   * DSL key: "cg.arrival2"      →  lookup "image.cg.arrival2" in imageMap
   * DSL key: "bg_entrance_day"  →  lookup "image.bg_entrance_day"
   *
   * Only call this for identifier variable references (not string literals or
   * hex colours — those must be passed through unchanged without a lookup).
   * Logs console.error and returns undefined when the key is absent from the
   * imageMap so callers can decide how to handle the missing asset.
   */
  private resolveImageKey(key: string): string | undefined {
    const lookupKey = "image." + key;
    const resolved = this.imageMap.get(lookupKey);
    if (resolved !== undefined) return resolved;

    console.error(`[codegen] image variable not found: ${lookupKey}`);
    return undefined;
  }

  // ── Scene ─────────────────────────────────────────────────────────────────

  private genScene(stmt: SceneStmt): JsonStep[] {
    let src: string;
    if (stmt.srcIsLiteral) {
      // Quoted string literal or hex colour — use the path/value as-is,
      // no imageMap lookup needed.
      src = stmt.src;
    } else {
      // Identifier variable reference — must resolve via imageMap.
      // console.error is emitted by resolveImageKey when not found.
      src = this.resolveImageKey(stmt.src) ?? stmt.src;
    }

    const step: JsonStep = { type: "scene", src };
    if (stmt.filter) step.filter = stmt.filter;
    if (stmt.transition) step.transition = stmt.transition;
    return [step];
  }

  // ── Music ─────────────────────────────────────────────────────────────────

  private genMusic(stmt: MusicStmt): JsonStep[] {
    const step: JsonStep = { type: "music", action: stmt.action };
    if (stmt.src !== undefined) {
      const resolved = this.resolveAudioAlias(stmt.src);
      if (resolved !== undefined) step.src = resolved;
    }
    if (stmt.fadeout !== undefined) step.fadeout = stmt.fadeout;
    if (stmt.fadein !== undefined) step.fadein = stmt.fadein;
    return [step];
  }

  // ── Sound ─────────────────────────────────────────────────────────────────

  private genSound(stmt: SoundStmt): JsonStep[] {
    const step: JsonStep = { type: "sound", action: stmt.action };
    if (stmt.src !== undefined) {
      const resolved = this.resolveAudioAlias(stmt.src);
      if (resolved !== undefined) step.src = resolved;
    }
    return [step];
  }

  // ── Show ──────────────────────────────────────────────────────────────────

  /**
   * Emit a single `show` step.
   *
   * The sprite key in the JSON step is the dot-joined DSL key
   * (e.g. "cg.arrival2", "keitaro.normal1", "keitaro_casual").
   *
   * The engine uses the TAG (portion before the first ".") to determine
   * which existing sprite to replace:
   *   show keitaro.grin1  →  replaces any sprite with tag "keitaro"
   *   show keitaro_casual →  replaces any sprite with tag "keitaro_casual"
   *   show cg.arrival2    →  replaces any sprite with tag "cg"
   *
   * `show` always uses identifier variable references (never a quoted string
   * literal), so the imageMap lookup is always performed and an error is
   * logged when the variable is not declared.
   */
  private genShow(stmt: ShowStmt): JsonStep[] {
    // show always uses identifier variable references — must resolve via imageMap.
    // resolveImageKey logs console.error when not found.
    const resolvedSrc = this.resolveImageKey(stmt.key);

    const step: JsonStep = { type: "show", sprite: stmt.key };
    if (resolvedSrc !== undefined) {
      step.src = resolvedSrc;
    }

    if (stmt.at) step.at = stmt.at;
    if (stmt.transition) step.transition = stmt.transition;
    return [step];
  }

  // ── Hide ──────────────────────────────────────────────────────────────────

  /**
   * Emit a single `hide` step.
   *
   * The engine removes all sprites whose TAG matches stmt.tag.
   * Tag = first dot-segment of sprite key, or whole key if no dots.
   *   hide keitaro       →  removes "keitaro.normal1", "keitaro.grin1", …
   *   hide keitaro_casual →  removes exactly "keitaro_casual"
   *   hide cg            →  removes "cg.arrival2", etc.
   */
  private genHide(stmt: HideStmt): JsonStep[] {
    return [{ type: "hide", sprite: stmt.tag }];
  }

  // ── With ──────────────────────────────────────────────────────────────────

  private genWith(stmt: WithStmt): JsonStep[] {
    return [{ type: "with", transition: stmt.transition }];
  }

  // ── Speak ─────────────────────────────────────────────────────────────────

  private genSpeak(stmt: SpeakStmt): JsonStep[] {
    const who = this.charMap.get(stmt.who) ?? stmt.who;
    return stmt.lines.map((line) => {
      const step: JsonStep = { type: "say", who, text: line.text };
      if (line.voice) {
        const resolved = this.resolveAudioAlias(line.voice);
        // Only set voice when the alias resolved to a real path.
        // For dotted references (audio.xxx) that are not in the audioMap,
        // resolveAudioAlias returns undefined — we omit the field entirely
        // rather than emitting a broken / hardcoded path.
        if (resolved !== undefined) step.voice = resolved;
      }
      return step;
    });
  }

  // ── Audio alias resolution ────────────────────────────────────────────────

  /**
   * Expand an audio alias to its full path.
   *
   * Handles:
   *   1. `audio.bgm_main`  — dotted variable-reference form.
   *      Only the audioMap is consulted; if the key is not present,
   *      returns undefined (no hardcoded path prefix is applied).
   *   2. `outdoors`        — bare alias name; looked up in audioMap,
   *      then returned as-is if not found (assumed to be a plain path).
   *   3. Plain path string — returned unchanged.
   */
  private resolveAudioAlias(src: string): string | undefined {
    if (src.startsWith("audio.")) {
      // Dotted form: pure variable-name lookup only.
      // Return undefined when the key is absent — callers must not
      // apply any hardcoded directory prefix as a fallback.
      const alias = src.slice("audio.".length);
      return this.audioMap.get(alias);
    }
    return this.audioMap.get(src) ?? src;
  }

  // ── Wait ──────────────────────────────────────────────────────────────────

  private genWait(stmt: WaitStmt): JsonStep[] {
    return [{ type: "pause", duration: stmt.duration }];
  }

  // ── If ────────────────────────────────────────────────────────────────────

  private genIf(stmt: IfStmt): JsonStep[] {
    const branches = stmt.branches.map((branch) => ({
      condition: branch.condition,
      steps: branch.body.flatMap((s) => this.genStmt(s)),
    }));
    return [{ type: "if", branches }];
  }

  // ── Menu ──────────────────────────────────────────────────────────────────

  private genMenu(stmt: MenuStmt): JsonStep[] {
    const options = stmt.choices.map((choice) => ({
      text: choice.text,
      condition: choice.condition ?? null,
      steps: choice.body.flatMap((s) => this.genStmt(s)),
    }));
    return [{ type: "menu", options }];
  }

  // ── Jump / Call / Return ──────────────────────────────────────────────────

  private genJump(stmt: JumpStmt): JsonStep[] {
    return [{ type: "jump", target: stmt.target }];
  }

  private genCall(stmt: CallStmt): JsonStep[] {
    return [{ type: "call", target: stmt.target }];
  }

  private genReturn(_stmt: ReturnStmt): JsonStep[] {
    return [{ type: "return" }];
  }
}
