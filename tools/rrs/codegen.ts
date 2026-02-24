// ── Code generator: .rrs AST → engine JSON steps ─────────────────────────────
//
// Key responsibilities
//   • Emit engine-compatible JSON step objects for every AST node
//   • Track sprite state (position + charVer) so that:
//       - `expr char::face`  can emit the correct `at` without re-stating it
//       - `hide char::*`     can expand the wildcard to the live face key
//   • Derive sprite src paths from naming conventions:
//       body  → Sprites/Body/{charVer}_b_{outfit}.png
//       face  → Sprites/Faces/{charVer}_f_{faceExpr}.png
//   • Resolve short voice filenames to their full Audio/ prefix
//   • Expand `define` declarations into char / audio / const maps used at
//     codegen time (character name resolution, audio path aliases, constants)

import type {
  AssignStmt,
  CallStmt,
  DefineDecl,
  ExprStmt,
  HideStmt,
  IfStmt,
  JumpStmt,
  JsonFile,
  JsonLabel,
  JsonStep,
  LabelDecl,
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
} from "./types.ts";

// ── Define maps ───────────────────────────────────────────────────────────────

/**
 * Build the three resolution maps from the top-level `define` declarations.
 *
 * charMap   : abbr  → full name   (from `define char.<abbr> = "Name"`)
 * audioMap  : alias → path        (from `define audio.<alias> = "path"`)
 * constMap  : name  → value       (from `define <NAME> = value`)
 */
export function buildDefineMaps(defines: DefineDecl[]): {
  charMap: Map<string, string>;
  audioMap: Map<string, string>;
  constMap: Map<string, string>;
} {
  const charMap = new Map<string, string>();
  const audioMap = new Map<string, string>();
  const constMap = new Map<string, string>();

  for (const d of defines) {
    if (d.key.startsWith("char.")) {
      charMap.set(d.key.slice("char.".length), d.value);
    } else if (d.key.startsWith("audio.")) {
      audioMap.set(d.key.slice("audio.".length), d.value);
    } else {
      constMap.set(d.key, d.value);
    }
  }

  return { charMap, audioMap, constMap };
}

// ── Public entry point ────────────────────────────────────────────────────────

export function compile(program: Program, sourceName: string): JsonFile {
  const labels: Record<string, JsonLabel> = {};
  const { charMap, audioMap } = buildDefineMaps(program.defines);

  for (const label of program.labels) {
    const ctx = new CodegenContext(charMap, audioMap);
    labels[label.name] = ctx.genLabel(label);
  }

  return { source: sourceName, labels };
}

// ── Sprite-state tracking ─────────────────────────────────────────────────────

interface SpriteEntry {
  /** Raw DSL body key, e.g. "hiro_casual" */
  bodyKey: string;
  /** Currently visible face JSON key, e.g. "hiro laugh1" — null if no face */
  faceKey: string | null;
  /** Stage position, e.g. "right2", "p5_3" */
  at: string;
  /** Resolved character+version string, e.g. "hiro1", "hiro2" */
  charVer: string;
}

// ── Code generation context (one instance per label) ─────────────────────────

class CodegenContext {
  /**
   * Map from character *base* name (no trailing digits, e.g. "hiro") to the
   * sprite currently visible on stage for that character.  Branch-points
   * (if / menu) snapshot and restore this map so sibling branches are
   * independent and the post-branch state is the pre-branch snapshot.
   */
  private spriteState = new Map<string, SpriteEntry>();

  /**
   * Character abbreviation → full name  (from `define char.*` declarations).
   * Used by genSpeak() to resolve short speaker identifiers.
   */
  private charMap: Map<string, string>;

  /**
   * Audio alias → full path  (from `define audio.*` declarations).
   * Used by genMusic(), genSound(), and voice resolution to expand aliases.
   */
  private audioMap: Map<string, string>;

  constructor(
    charMap: Map<string, string> = new Map(),
    audioMap: Map<string, string> = new Map(),
  ) {
    this.charMap = charMap;
    this.audioMap = audioMap;
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
      case "Expr":
        return this.genExpr(stmt);
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
    }
  }

  // ── Individual generators ─────────────────────────────────────────────────

  private genAssign(stmt: AssignStmt): JsonStep[] {
    return [{ type: "set", var: stmt.name, op: stmt.op, value: stmt.value }];
  }

  private genScene(stmt: SceneStmt): JsonStep[] {
    // A scene change clears all sprite state
    this.spriteState.clear();
    const step: JsonStep = { type: "scene", src: stmt.src };
    if (stmt.transition) step.transition = stmt.transition;
    return [step];
  }

  private genMusic(stmt: MusicStmt): JsonStep[] {
    const step: JsonStep = { type: "music", action: stmt.action };
    if (stmt.src !== undefined) {
      step.src = this.resolveAudioAlias(stmt.src);
    }
    if (stmt.fadeout !== undefined) step.fadeout = stmt.fadeout;
    if (stmt.fadein !== undefined) step.fadein = stmt.fadein;
    return [step];
  }

  private genSound(stmt: SoundStmt): JsonStep[] {
    const step: JsonStep = { type: "sound", action: stmt.action };
    if (stmt.src !== undefined) {
      step.src = this.resolveAudioAlias(stmt.src);
    }
    return [step];
  }

  private genShow(stmt: ShowStmt): JsonStep[] {
    const {
      bodyKey,
      faceExpr,
      at,
      transition,
      src,
      faceSrc,
      spriteKeyOverride,
    } = stmt;

    // ── Case 1: body::face  →  two JSON show steps ────────────────────────
    if (faceExpr !== undefined && faceExpr !== "*") {
      const { charBase, charVer } = parseBodyKey(bodyKey);
      const bodySrc = deriveBodySrc(bodyKey, charVer);
      const { faceKey, faceSrc: derivedFaceSrc } = deriveFace(
        charVer,
        faceExpr,
      );

      const bodyStep: JsonStep = {
        type: "show",
        sprite: bodyKey,
        src: src ?? bodySrc,
      };
      if (at) bodyStep.at = at;

      const faceStep: JsonStep = {
        type: "show",
        sprite: faceKey,
        // Use explicit faceSrc if provided; fall back to derived path
        src: faceSrc ?? derivedFaceSrc,
      };
      if (at) faceStep.at = at;

      // Update sprite state so expr / hide::* work in subsequent statements
      if (at) {
        this.spriteState.set(charBase, { bodyKey, faceKey, at, charVer });
      }

      return [bodyStep, faceStep];
    }

    // ── Case 2: single sprite (CG, overlay, or body-only) ─────────────────
    //    When spriteKeyOverride is set (from  key: "cg_fade"  in the block),
    //    use it verbatim so special overlay sprites are not mis-converted.
    //    Otherwise: CG DSL key "cg_arrival1" → JSON sprite key "cg arrival1"
    const spriteKey =
      spriteKeyOverride ??
      (bodyKey.toLowerCase().startsWith("cg_")
        ? "cg " + bodyKey.slice(3)
        : bodyKey);

    const step: JsonStep = { type: "show", sprite: spriteKey };

    if (src) {
      step.src = src;
    } else if (!bodyKey.toLowerCase().startsWith("cg_")) {
      // Attempt to auto-derive src for a plain body sprite
      try {
        const { charVer } = parseBodyKey(bodyKey);
        step.src = deriveBodySrc(bodyKey, charVer);
      } catch {
        console.warn(
          `[rrs] Warning: could not derive src for sprite '${bodyKey}' — add an explicit src: block`,
        );
      }
    } else {
      console.warn(
        `[rrs] Warning: CG sprite '${bodyKey}' has no explicit src: block`,
      );
    }

    if (at) step.at = at;
    if (transition) step.transition = transition;

    return [step];
  }

  private genExpr(stmt: ExprStmt): JsonStep[] {
    const stateKey = charBaseOf(stmt.char);
    const state = this.spriteState.get(stateKey);

    // Derive charVer directly from stmt.char — never inherit from body state.
    //
    // The decompiler extracts the face character part verbatim from the JSON
    // sprite key (e.g. "keitaro21 sigh2" → charPart "keitaro21", so the DSL
    // gets `expr keitaro21::sigh2`).  Body and face versions can differ
    // (e.g. body is taiga3_camp but face is "taiga grin3" v1), so using the
    // body's charVer from state would produce the wrong face key.
    //
    //   "keitaro21" ends with digits → charVer = "keitaro21"  (not "keitaro211")
    //   "taiga"     has no digits    → charVer = "taiga1"     (not body's "taiga3")
    //   "hiro"      has no digits    → charVer = "hiro1"
    const charVer = /\d+$/.test(stmt.char) ? stmt.char : `${stmt.char}1`;

    const { faceKey, faceSrc } = deriveFace(charVer, stmt.expr);

    const step: JsonStep = { type: "show", sprite: faceKey, src: faceSrc };

    // Use explicit @ position from stmt if provided; otherwise look up tracked state.
    const at = stmt.at ?? state?.at;
    if (at) {
      step.at = at;
      // Update the tracked face key (and position if an explicit one was given)
      const updatedEntry: SpriteEntry = state
        ? { ...state, faceKey, ...(stmt.at ? { at: stmt.at } : {}) }
        : { bodyKey: "", faceKey, at, charVer };
      this.spriteState.set(stateKey, updatedEntry);
    } else {
      console.warn(
        `[rrs] Warning: expr ${stmt.char}::${stmt.expr} — ` +
          `no known stage position for '${stmt.char}'.  ` +
          `Make sure a preceding 'show ${stmt.char}_…::… @ pos' exists in the same label.`,
      );
    }

    // Optional transition (e.g. expr hiro::grin1 | dissolve)
    if (stmt.transition) step.transition = stmt.transition;

    return [step];
  }

  private genHide(stmt: HideStmt): JsonStep[] {
    const steps: JsonStep[] = [];

    for (const target of stmt.targets) {
      if (target.type === "body") {
        // When verbatim flag is set (from quoted hide target), use key as-is.
        // Otherwise: CG DSL key "cg_arrival1" → JSON sprite key "cg arrival1"
        const isVerbatim = (target as { verbatim?: boolean }).verbatim === true;
        const spriteKey = isVerbatim
          ? target.key
          : target.key.toLowerCase().startsWith("cg_")
            ? "cg " + target.key.slice(3)
            : target.key;
        steps.push({ type: "hide", sprite: spriteKey });
      } else {
        // face target: char::expr  or  char::*
        const stateKey = charBaseOf(target.char);

        if (target.expr === "*") {
          // Wildcard — expand from sprite state
          const state = this.spriteState.get(stateKey);
          if (state?.faceKey) {
            steps.push({ type: "hide", sprite: state.faceKey });
            this.spriteState.set(stateKey, { ...state, faceKey: null });
          } else {
            console.warn(
              `[rrs] Warning: hide ${target.char}::* — ` +
                `no live face tracked for '${target.char}'.  Step omitted.`,
            );
          }
        } else {
          // Specific face expression
          const state = this.spriteState.get(stateKey);
          // Same charVer derivation as genExpr: always derive from target.char,
          // never from body state (face version is independent of body version).
          const charVer = /\d+$/.test(target.char)
            ? target.char
            : `${target.char}1`;
          const { faceKey } = deriveFace(charVer, target.expr);
          steps.push({ type: "hide", sprite: faceKey });
          if (state) {
            this.spriteState.set(stateKey, { ...state, faceKey: null });
          }
        }
      }
    }

    return steps;
  }

  private genWith(stmt: WithStmt): JsonStep[] {
    return [{ type: "with", transition: stmt.transition }];
  }

  private genSpeak(stmt: SpeakStmt): JsonStep[] {
    // Resolve the speaker name through the char map.
    // If the who value matches an abbreviation in charMap, use the full name.
    // Otherwise pass through as-is (already a full name, "???", etc.).
    const who = this.charMap.get(stmt.who) ?? stmt.who;

    return stmt.lines.map((line) => {
      const step: JsonStep = { type: "say", who, text: line.text };
      if (line.voice) {
        step.voice = resolveVoice(this.resolveAudioAlias(line.voice));
      }
      return step;
    });
  }

  /**
   * Expand an audio alias (e.g. "audio.bgm_main") to its full path.
   * If the value starts with "audio." and the alias is known, return the path.
   * Otherwise return the value unchanged.
   */
  private resolveAudioAlias(src: string): string {
    if (src.startsWith("audio.")) {
      const alias = src.slice("audio.".length);
      return this.audioMap.get(alias) ?? src;
    }
    return src;
  }

  private genWait(stmt: WaitStmt): JsonStep[] {
    // The engine uses the "pause" step type with a duration field
    return [{ type: "pause", duration: stmt.duration }];
  }

  private genIf(stmt: IfStmt): JsonStep[] {
    // Snapshot sprite state — each branch is compiled independently
    const snapshot = new Map(this.spriteState);

    const branches = stmt.branches.map((branch) => {
      this.spriteState = new Map(snapshot);
      return {
        condition: branch.condition,
        steps: branch.body.flatMap((s) => this.genStmt(s)),
      };
    });

    // Restore snapshot after all branches (we can't know at compile time
    // which branch will execute at runtime)
    this.spriteState = snapshot;

    return [{ type: "if", branches }];
  }

  private genMenu(stmt: MenuStmt): JsonStep[] {
    const snapshot = new Map(this.spriteState);

    const options = stmt.choices.map((choice) => {
      this.spriteState = new Map(snapshot);
      return {
        text: choice.text,
        condition: choice.condition ?? null,
        steps: choice.body.flatMap((s) => this.genStmt(s)),
      };
    });

    this.spriteState = snapshot;

    return [{ type: "menu", options }];
  }

  private genJump(stmt: JumpStmt): JsonStep[] {
    return [{ type: "jump", target: stmt.target }];
  }

  private genCall(stmt: CallStmt): JsonStep[] {
    return [{ type: "call", target: stmt.target }];
  }

  // deno-lint-ignore no-unused-vars
  private genReturn(_stmt: ReturnStmt): JsonStep[] {
    return [{ type: "return" }];
  }
}

// ── Sprite naming helpers ─────────────────────────────────────────────────────

interface CharInfo {
  /** Base character name without version digits, e.g. "hiro" */
  charBase: string;
  /** Numeric version, e.g. 1 or 2 */
  version: number;
  /** Character+version string used in file paths, e.g. "hiro1", "hiro2" */
  charVer: string;
}

/**
 * Parse a DSL body-sprite key into its character components.
 *
 * Examples:
 *   "hiro_casual"          → { charBase:"hiro",    version:1, charVer:"hiro1"    }
 *   "hiro2_camp"           → { charBase:"hiro",    version:2, charVer:"hiro2"    }
 *   "keitaro2_casual_blush1" → { charBase:"keitaro", version:2, charVer:"keitaro2" }
 *   "hunter_pe"            → { charBase:"hunter",  version:1, charVer:"hunter1"  }
 */
function parseBodyKey(bodyKey: string): CharInfo {
  const underscoreIdx = bodyKey.indexOf("_");

  // No underscore → treat the whole string as the character part
  const charPart =
    underscoreIdx >= 0 ? bodyKey.slice(0, underscoreIdx) : bodyKey;

  // Does the character part end with a version digit?
  const versionMatch = charPart.match(/^(.*?)(\d+)$/);
  if (versionMatch) {
    const charBase = versionMatch[1];
    const version = parseInt(versionMatch[2], 10);
    return { charBase, version, charVer: charPart };
  }

  // No version digit → default to version 1
  return { charBase: charPart, version: 1, charVer: charPart + "1" };
}

/**
 * Derive the asset path for a body sprite.
 *
 * Convention: Sprites/Body/{charVer}_b_{outfit}.png
 *   "hiro_casual"  + charVer="hiro1"    → Sprites/Body/hiro1_b_casual.png
 *   "hiro2_camp"   + charVer="hiro2"    → Sprites/Body/hiro2_b_camp.png
 */
function deriveBodySrc(bodyKey: string, charVer: string): string {
  const underscoreIdx = bodyKey.indexOf("_");
  if (underscoreIdx < 0) {
    // Shouldn't happen for well-formed body keys, but be safe
    return `Sprites/Body/${charVer}_b_unknown.png`;
  }
  const outfit = bodyKey.slice(underscoreIdx + 1);
  return `Sprites/Body/${charVer}_b_${outfit}.png`;
}

/**
 * Derive both the JSON sprite key and the asset path for a face/expression sprite.
 *
 * JSON key convention:
 *   version 1 → "{charBase} {faceExpr}"   e.g.  "hiro laugh1"
 *   version 2+ → "{charVer} {faceExpr}"   e.g.  "hiro2 shy2"
 *
 * Asset path convention: Sprites/Faces/{charVer}_f_{faceExpr}.png
 */
function deriveFace(
  charVer: string,
  faceExpr: string,
): { faceKey: string; faceSrc: string } {
  const m = charVer.match(/^(.*?)(\d+)$/);
  const version = m ? parseInt(m[2], 10) : 1;
  const charBase = m ? m[1] : charVer;

  // Version-1 sprites omit the digit from the sprite key ("hiro laugh1", not "hiro1 laugh1")
  const faceKeyChar = version === 1 ? charBase : charVer;
  // The JSON sprite key preserves spaces as-is (e.g. "hina sick normal1")
  const faceKey = `${faceKeyChar} ${faceExpr}`;
  // The file path uses underscores for multi-word expressions
  // (e.g. "sick normal1" → "Sprites/Faces/hina1_f_sick_normal1.png")
  const exprForPath = faceExpr.replace(/ /g, "_");
  const faceSrc = `Sprites/Faces/${charVer}_f_${exprForPath}.png`;

  return { faceKey, faceSrc };
}

/**
 * Normalise a character name to its base (strip trailing version digits).
 * Used as the lookup key into the sprite-state map.
 *   "hiro"   → "hiro"
 *   "hiro2"  → "hiro"
 *   "keitaro2" → "keitaro"
 */
function charBaseOf(charName: string): string {
  return charName.replace(/\d+$/, "");
}

// ── Voice path resolution ─────────────────────────────────────────────────────

const VOICE_BASE = "Audio/Voice/voices/";

/**
 * If the author wrote a bare filename (no "/" in the string), prepend the
 * default voice directory.  Full paths are passed through unchanged.
 *
 *   "hiro_v_laugh1.ogg"                 → "Audio/Voice/voices/hiro_v_laugh1.ogg"
 *   "Audio/Voice/Voiced Scenes/…ogg"    → unchanged
 */
function resolveVoice(voice: string): string {
  return voice.includes("/") ? voice : VOICE_BASE + voice;
}
