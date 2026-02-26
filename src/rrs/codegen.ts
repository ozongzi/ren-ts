// ── Code generator: .rrs AST → engine JSON steps ─────────────────────────────
//
// Responsibilities:
//   • Emit engine-compatible JSON step objects for every AST node
//   • Collect all top-level define declarations into a flat key→value dict
//     (image.*, char.*, audio.*, position.*, everything else)
//   • NO compile-time resolution of image/char/audio — all keys are emitted
//     as-is and resolved at runtime via GameState.vars
//
// Runtime resolution contract (handled by engine.ts):
//   scene bg_entrance_day   → look up vars["image.bg_entrance_day"]
//   show  keitaro.normal1   → look up vars["image.keitaro.normal1"]
//   speak k "text"          → look up vars["char.k"] for display name
//   music::play(audio.foo)  → look up vars["audio.foo"]
//   voice | audio.vo_001    → look up vars["audio.vo_001"]
//   Literal paths ("BGs/…", "#000") → used as-is (contain "/" or start with "#")

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
import { tokenRawToValue, TokenKind } from "./literal";

// ── Define collector ──────────────────────────────────────────────────────────

/**
 * Collect all top-level define declarations into a flat key→value dict.
 *
 * This version attempts to preserve primitive types for simple literal values:
 *  - True / true  → boolean true
 *  - False / false → boolean false
 *  - None          → null
 *  - numeric literal → number
 *  - quoted strings (already provided as unquoted content by the parser) → string
 *
 * Complex / unparsed values remain skipped (value === "").
 *
 * position.* entries still register with the CSS layout helper; when a value
 * parses to a number we use that number, otherwise we fall back to parsing
 * the original raw string.
 */
export function collectDefines(defines: DefineDecl[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const d of defines) {
    // The parser now preserves define value tokens as objects of the form:
    //   { kind: "Str" | "Num" | "Ident" | "HexColor" | "Other", raw: string }
    // Older code (or other inputs) may still provide plain strings; handle both.
    let raw = "";
    let tokenKind: TokenKind = "Other";

    if (d.value === "" || d.value === undefined || d.value === null) {
      // skip complex/unparseable defines (parser indicates with empty string)
      continue;
    } else if (typeof d.value === "string") {
      raw = d.value;
      tokenKind = "Other";
    } else if (typeof d.value === "object" && "raw" in d.value) {
      // Preserve the parser-provided token kind when available.
      // Use String(...) to be defensive against non-string raw payloads.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dv = d.value as any;
      raw = String(dv.raw ?? "");
      tokenKind =
        typeof dv.kind === "string" ? (dv.kind as TokenKind) : "Other";
    } else {
      raw = String(d.value ?? "");
      tokenKind = "Other";
    }

    if (raw === "") continue; // skip unparseable complex values

    // Delegate literal/token heuristics to the shared util for consistent behavior
    const parsed: unknown = tokenRawToValue(tokenKind, raw);

    result[d.key] = parsed;

    // position.* still needs a numeric value for the CSS helper. If parsing
    // produced a number, use it; otherwise fall back to parseFloat of the raw
    // value string.
    if (d.key.startsWith("position.")) {
      const xpos = typeof parsed === "number" ? parsed : parseFloat(raw);
      if (!Number.isNaN(Number(xpos))) {
        registerPosition(d.key.slice("position.".length), Number(xpos));
      }
    }
  }
  return result;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Compile a parsed .rrs program into a ScriptFile (engine-ready JSON).
 *
 * Returns both the label steps and the flat defines dict.  The loader
 * accumulates defines from all files into a single dict that becomes the
 * initial GameState.vars for every new game.
 */
export function compile(program: Program, sourceName: string): JsonFile {
  program = hoistNestedLabels(program);

  const defines = collectDefines(program.defines);
  const labels: Record<string, JsonLabel> = {};

  for (const label of program.labels) {
    const ctx = new CodegenContext();
    labels[label.name] = ctx.genLabel(label);
  }

  return { source: sourceName, defines, labels };
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

// ── Code generation context ───────────────────────────────────────────────────
//
// Stateless: no charMap / audioMap / imageMap.
// All keys are passed through raw; runtime (engine.ts) resolves them via vars.

class CodegenContext {
  // ── Label ──────────────────────────────────────────────────────────────────

  genLabel(label: LabelDecl): JsonLabel {
    return label.body.flatMap((s) => this.genStmt(s));
  }

  // ── Statement dispatch ─────────────────────────────────────────────────────

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
        return []; // already hoisted
    }
  }

  // ── Assign ─────────────────────────────────────────────────────────────────

  private genAssign(stmt: AssignStmt): JsonStep[] {
    return [{ type: "set", var: stmt.name, op: stmt.op, value: stmt.value }];
  }

  // ── Scene ──────────────────────────────────────────────────────────────────
  //
  // src is emitted as-is:
  //   - Literal path/color (contains "/" or starts with "#"): used directly
  //   - Image key (e.g. "bg_entrance_day", "cg.black"): runtime looks up
  //     vars["image." + src]

  private genScene(stmt: SceneStmt): JsonStep[] {
    const step: JsonStep = { type: "scene", src: stmt.src };
    if (stmt.filter) step.filter = stmt.filter;
    if (stmt.transition) step.transition = stmt.transition;
    return [step];
  }

  // ── Music ──────────────────────────────────────────────────────────────────
  //
  // src is emitted as-is:
  //   - "audio.bgm_main"        → runtime looks up vars["audio.bgm_main"]
  //   - "Audio/BGM/foo.ogg"     → runtime uses directly (has "/")
  //   - "outdoors" (bare alias) → runtime looks up vars["audio.outdoors"]

  private genMusic(stmt: MusicStmt): JsonStep[] {
    const step: JsonStep = { type: "music", action: stmt.action };
    if (stmt.src !== undefined) step.src = stmt.src;
    if (stmt.fadeout !== undefined) step.fadeout = stmt.fadeout;
    if (stmt.fadein !== undefined) step.fadein = stmt.fadein;
    return [step];
  }

  // ── Sound ──────────────────────────────────────────────────────────────────

  private genSound(stmt: SoundStmt): JsonStep[] {
    const step: JsonStep = { type: "sound", action: stmt.action };
    if (stmt.src !== undefined) step.src = stmt.src;
    return [step];
  }

  // ── Show ───────────────────────────────────────────────────────────────────
  //
  // sprite key is emitted as-is; runtime looks up vars["image." + sprite]
  // for the actual file path.

  private genShow(stmt: ShowStmt): JsonStep[] {
    const step: JsonStep = { type: "show", sprite: stmt.key };
    if (stmt.at) step.at = stmt.at;
    if (stmt.transition) step.transition = stmt.transition;
    return [step];
  }

  // ── Hide ───────────────────────────────────────────────────────────────────

  private genHide(stmt: HideStmt): JsonStep[] {
    return [{ type: "hide", sprite: stmt.tag }];
  }

  // ── With ───────────────────────────────────────────────────────────────────

  private genWith(stmt: WithStmt): JsonStep[] {
    return [{ type: "with", transition: stmt.transition }];
  }

  // ── Speak ──────────────────────────────────────────────────────────────────
  //
  // who is the raw abbreviation (e.g. "k"); runtime resolves via vars["char.k"].
  // voice is emitted as-is; runtime resolves via vars[voice] if it starts with
  // "audio.", or uses it directly if it contains "/".

  private genSpeak(stmt: SpeakStmt): JsonStep[] {
    return stmt.lines.map((line) => {
      const step: JsonStep = { type: "say", who: stmt.who, text: line.text };
      if (line.voice) step.voice = line.voice;
      return step;
    });
  }

  // ── Wait ───────────────────────────────────────────────────────────────────

  private genWait(stmt: WaitStmt): JsonStep[] {
    return [{ type: "pause", duration: stmt.duration }];
  }

  // ── If ─────────────────────────────────────────────────────────────────────

  private genIf(stmt: IfStmt): JsonStep[] {
    const branches = stmt.branches.map((branch) => ({
      condition: branch.condition,
      steps: branch.body.flatMap((s) => this.genStmt(s)),
    }));
    return [{ type: "if", branches }];
  }

  // ── Menu ───────────────────────────────────────────────────────────────────

  private genMenu(stmt: MenuStmt): JsonStep[] {
    const options = stmt.choices.map((choice) => ({
      text: choice.text,
      condition: choice.condition ?? null,
      steps: choice.body.flatMap((s) => this.genStmt(s)),
    }));
    return [{ type: "menu", options }];
  }

  // ── Jump / Call / Return ───────────────────────────────────────────────────

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
