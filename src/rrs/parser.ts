// ── Recursive-descent parser for .rrs ────────────────────────────────────────

import type { Token, TokenKind } from "./lexer.ts";
import type {
  AssignStmt,
  DefineDecl,
  HideTarget,
  IfBranch,
  LabelDecl,
  MenuChoice,
  Program,
  SpeakLine,
  Stmt,
} from "./ast.ts";

// ── Public entry point ────────────────────────────────────────────────────────

export function parse(tokens: Token[]): Program {
  return new Parser(tokens).parse();
}

// ── Statement-keyword set (used to detect the end of a raw expression) ────────

const STMT_KEYWORDS = new Set([
  "label",
  "scene",
  "music",
  "sound",
  "show",
  "expr",
  "hide",
  "with",
  "speak",
  "wait",
  "if",
  "elif",
  "else",
  "menu",
  "jump",
  "call",
  "return",
]);

// ── Parser ────────────────────────────────────────────────────────────────────

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Program {
    const defines: DefineDecl[] = [];
    const labels: LabelDecl[] = [];
    while (!this.check("EOF")) {
      if (this.checkIdent("label")) {
        labels.push(this.parseLabel());
      } else if (this.isTopLevelAssignment()) {
        // Bare assignment at the top level (outside any label) is a global
        // define declaration:
        //   char.k      = "Keitaro";
        //   audio.bgm   = "Audio/BGM/Main.ogg";
        //   CAMP_NAME   = "Camp Buddy";
        defines.push(this.parseDefineBody());
      } else {
        // Top-level statement outside any label (e.g. top-level `if`
        // in init scripts like always_allow_skip.rrs).  Parse and discard.
        this.parseStmt();
      }
    }
    return { defines, labels };
  }

  // ── Define ─────────────────────────────────────────────────────────────────

  /**
   * Check whether the current token sequence looks like a top-level assignment:
   *   Ident (. Ident)* =
   *
   * This distinguishes global define declarations from other top-level tokens
   * (e.g. `label`, `if`, etc.).  The `=` token is unambiguous because the
   * lexer produces separate tokens for `==`, `+=`, `-=`, etc.
   */
  private isTopLevelAssignment(): boolean {
    if (this.peek().kind !== "Ident") return false;
    let i = 1;
    while (this.peek(i).kind === "." && this.peek(i + 1).kind === "Ident") {
      i += 2;
    }
    return this.peek(i).kind === "=";
  }

  /**
   * Parse a top-level bare assignment as a define declaration (keyword already
   * absent — the caller detected it via isTopLevelAssignment()):
   *   char.k      = "Keitaro";
   *   audio.bgm   = "Audio/BGM/Main.ogg";
   *   CAMP_NAME   = "Camp Buddy";
   *
   * The key may be a simple identifier or a dotted name (e.g. char.k).
   * The value is a quoted string, a numeric literal, or a bare identifier.
   */
  private parseDefineBody(): DefineDecl {
    // Parse dotted key: e.g. "char.k", "audio.bgm_main", "CAMP_NAME"
    let key = this.expectKind("Ident").value;
    while (this.check(".")) {
      this.advance(); // consume "."
      const next = this.expectKind("Ident");
      key += "." + next.value;
    }

    this.expectKind("=");

    // Value: string literal, number, or bare identifier (True/False/etc.)
    const valTok = this.peek();
    let value: string;
    if (valTok.kind === "Str") {
      this.advance();
      value = valTok.value;
    } else if (valTok.kind === "Num") {
      this.advance();
      value = valTok.value;
    } else if (valTok.kind === "Ident") {
      this.advance();
      value = valTok.value;
    } else if (valTok.kind === "HexColor") {
      this.advance();
      value = valTok.value;
    } else {
      throw this.err(
        `Expected value after 'define ${key} =', got ${valTok.kind}`,
      );
    }

    this.eatSemi();
    return { kind: "Define", key, value };
  }

  // ── Label ──────────────────────────────────────────────────────────────────

  private parseLabel(): LabelDecl {
    this.expectIdent("label");
    const name = this.expectKind("Ident").value;
    this.expectKind("{");
    const body = this.parseBody();
    this.expectKind("}");
    return { name, body };
  }

  private parseBody(): Stmt[] {
    const stmts: Stmt[] = [];
    while (!this.check("}") && !this.check("EOF")) {
      stmts.push(this.parseStmt());
    }
    return stmts;
  }

  // ── Statement dispatch ─────────────────────────────────────────────────────

  private parseStmt(): Stmt {
    const tok = this.peek();

    if (tok.kind !== "Ident") {
      throw this.err(`Expected statement, got '${tok.value}' (${tok.kind})`);
    }

    switch (tok.value) {
      case "scene":
        this.advance();
        return this.parseScene();
      case "music":
        this.advance();
        return this.parseMusic();
      case "sound":
        this.advance();
        return this.parseSound();
      case "show":
        this.advance();
        return this.parseShow();
      case "expr":
        this.advance();
        return this.parseExpr();
      case "hide":
        this.advance();
        return this.parseHide();
      case "with":
        this.advance();
        return this.parseWith();
      case "speak":
        this.advance();
        return this.parseSpeak();
      case "wait":
        this.advance();
        return this.parseWait();
      case "if":
        this.advance();
        return this.parseIf();
      case "menu":
        this.advance();
        return this.parseMenu();
      case "jump":
        this.advance();
        return this.parseJump();
      case "call":
        this.advance();
        return this.parseCall();

      case "return":
        this.advance();
        this.eatSemi();
        return { kind: "Return" };
      case "label": {
        // Nested label — parse it and wrap as a LabelStmt so that
        // codegen's hoistNestedLabels() can lift it to the top level.
        const nested = this.parseLabel();
        return { kind: "Label", name: nested.name, body: nested.body };
      }
    }

    // ── Dotted variable assignment: a.b.c op value ;
    // Build the full dotted name before checking for an operator
    if (tok.kind === "Ident") {
      let name = tok.value;
      let peekIdx = 1;
      while (
        this.peek(peekIdx).kind === "." &&
        this.peek(peekIdx + 1).kind === "Ident"
      ) {
        name += "." + this.peek(peekIdx + 1).value;
        peekIdx += 2;
      }
      const opTok = this.peek(peekIdx);
      if (
        opTok.kind === "=" ||
        opTok.kind === "+=" ||
        opTok.kind === "-=" ||
        opTok.kind === "*=" ||
        opTok.kind === "/="
      ) {
        // Consume all the name tokens
        this.advance(); // first ident
        while (this.check(".")) {
          this.advance(); // .
          this.advance(); // ident
        }
        return this.parseAssign(name);
      }
    }

    throw this.err(`Unknown statement keyword '${tok.value}'`);
  }

  // ── Collect a dotted identifier chain: a.b.c ─────────────────────────────
  //    Used for image var refs like image.bg.foo in scene / show src fields.

  private parseDottedIdent(): string {
    let name = this.expectKind("Ident").value;
    while (this.check(".") && this.peek(1).kind === "Ident") {
      this.advance(); // consume "."
      name += "." + this.advance().value;
    }
    return name;
  }

  // ── scene "path" | transition ;
  //    scene image.bg.foo | transition ;  (image var reference)

  // Known visual filter keywords that may appear between the src and | transition.
  private static readonly SCENE_FILTERS = new Set(["sepia"]);

  private parseScene(): Stmt {
    let src: string;
    const tok = this.peek();
    if (tok.kind === "HexColor") {
      src = this.advance().value;
    } else if (tok.kind === "Str") {
      src = this.advance().value;
    } else if (tok.kind === "Ident") {
      // Dotted ident var reference, e.g. image.bg.bathroom2_sunset
      src = this.parseDottedIdent();
    } else {
      throw this.err(
        `Expected scene path, colour, or image var ref, got '${tok.value}'`,
      );
    }

    // Optional visual filter keyword, e.g. `scene image.bg.tent_day sepia | dissolve`
    let filter: string | undefined;
    const filterTok = this.peek();
    if (
      filterTok.kind === "Ident" &&
      Parser.SCENE_FILTERS.has(filterTok.value)
    ) {
      filter = this.advance().value;
    }

    let transition: string | undefined;
    if (this.check("|")) {
      this.advance();
      transition = this.expectKind("Ident").value;
    }

    this.eatSemi();
    const kind = "Scene" as const;
    return { kind, src, filter, transition };
  }

  // ── music::play("path") | fadeout(2.0) | fadein(1.0) ;
  //    music::stop() | fadeout(2.0) ;

  private parseMusic(): Stmt {
    this.expectKind("::");
    const action = this.expectKind("Ident").value as "play" | "stop";
    this.expectKind("(");
    let src: string | undefined;
    if (this.check("Str")) {
      // Quoted string path: music::play("Audio/BGM/foo.ogg")
      src = this.advance().value;
    } else if (this.peek().kind === "Ident") {
      // Bare audio alias identifier: music::play(outdoors)
      // Resolved to the actual path at codegen time via the audioMap.
      src = this.parseDottedIdent();
    }
    this.expectKind(")");

    let fadeout: number | undefined;
    let fadein: number | undefined;
    while (this.check("|")) {
      this.advance();
      const mod = this.expectKind("Ident").value;
      if (mod === "fadeout" || mod === "fadein") {
        this.expectKind("(");
        const n = parseFloat(this.expectKind("Num").value);
        this.expectKind(")");
        if (mod === "fadeout") fadeout = n;
        else fadein = n;
      }
    }

    this.eatSemi();
    const kind = "Music" as const;
    return { kind, action, src, fadeout, fadein };
  }

  // ── sound::play("path") ;

  private parseSound(): Stmt {
    this.expectKind("::");
    const action = this.expectKind("Ident").value as "play" | "stop";
    this.expectKind("(");
    let src: string | undefined;
    if (this.check("Str")) {
      // Quoted string path: sound::play("Audio/SFX/foo.ogg")
      src = this.advance().value;
    } else if (this.peek().kind === "Ident") {
      // Bare audio alias identifier: sound::play(alarmclock)
      src = this.parseDottedIdent();
    }
    this.expectKind(")");
    this.eatSemi();
    const kind = "Sound" as const;
    return { kind, action, src };
  }

  // ── show body_sprite::face_expr @ pos | transition ;
  //    show body_sprite @ pos ;
  //    show cg_name | dissolve { src: "CGs/foo.jpg" }

  private parseShow(): Stmt {
    // Accept either a bare identifier or a quoted string path
    // e.g.  show "BGs/obstacle_rain.jpg"  (legacy verbatim path)
    let bodyKey: string;
    let impliedSrc: string | undefined;
    if (this.check("Str")) {
      impliedSrc = this.advance().value;
      // Derive a sprite key from the filename: "BGs/obstacle_rain.jpg" → "obstacle_rain"
      const base = impliedSrc.split("/").pop() ?? impliedSrc;
      bodyKey = base.replace(/\.[^.]+$/, "");
    } else {
      bodyKey = this.expectKind("Ident").value;
    }

    // Optional ::face (or ::* though * makes no sense in show, we accept it)
    let faceExpr: string | undefined;
    if (this.check("::")) {
      this.advance();
      if (this.check("*")) {
        this.advance();
        faceExpr = "*";
      } else {
        // Multi-word face expression: collect all consecutive Idents
        faceExpr = this.parseMultiWordIdent();
      }
    }

    // Optional @ position
    let at: string | undefined;
    if (this.check("@")) {
      this.advance();
      at = this.expectKind("Ident").value;
    }

    // Optional | transition
    let transition: string | undefined;
    if (this.check("|")) {
      this.advance();
      transition = this.expectKind("Ident").value;
    }

    // Optional { src: "..." ; src_face: "..." ; src_body: "..." ; key: "..." } block
    let src: string | undefined = impliedSrc;
    let faceSrc: string | undefined;
    let spriteKeyOverride: string | undefined;
    if (this.check("{")) {
      this.advance();
      while (!this.check("}") && !this.check("EOF")) {
        const key = this.expectKind("Ident").value;
        this.expectKind(":");
        // Value is either a quoted string literal or a dotted ident var ref
        let val: string;
        if (this.check("Str")) {
          val = this.advance().value;
        } else {
          val = this.parseDottedIdent();
        }
        if (key === "src" || key === "src_body") src = val;
        else if (key === "src_face") faceSrc = val;
        else if (key === "key") spriteKeyOverride = val;
        this.eatSemi(); // optional semicolons inside block
      }
      this.expectKind("}");
    }

    this.eatSemi();
    return {
      kind: "Show",
      bodyKey,
      faceExpr,
      at,
      transition,
      src,
      faceSrc,
      spriteKeyOverride,
    };
  }

  // ── expr char::face_expr ;
  //    expr char::face_expr | transition ;
  //    face_expr may be multi-word, e.g.  expr hina::sick normal1;

  private parseExpr(): Stmt {
    const char = this.expectKind("Ident").value;
    this.expectKind("::");
    // Multi-word face expression: collect all consecutive Idents
    const expr = this.parseMultiWordIdent();

    // Optional @ position (needed when face step has an explicit position)
    let at: string | undefined;
    if (this.check("@")) {
      this.advance();
      at = this.expectKind("Ident").value;
    }

    // Optional | transition
    let transition: string | undefined;
    if (this.check("|")) {
      this.advance();
      transition = this.expectKind("Ident").value;
    }

    this.eatSemi();
    return { kind: "Expr", char, expr, at, transition };
  }

  // ── hide body_key, char::face, char::* ;

  private parseHide(): Stmt {
    const targets: HideTarget[] = [];
    targets.push(this.parseHideTarget());

    while (this.check(",")) {
      this.advance();
      targets.push(this.parseHideTarget());
    }

    this.eatSemi();
    return { kind: "Hide", targets };
  }

  private parseHideTarget(): HideTarget {
    // Support quoted sprite key for verbatim/unusual sprite names
    if (this.check("Str")) {
      const key = this.advance().value;
      return { type: "body", key, verbatim: true } as HideTarget & {
        verbatim: boolean;
      };
    }

    const name = this.expectKind("Ident").value;

    if (this.check("::")) {
      this.advance();
      if (this.check("*")) {
        this.advance();
        return { type: "face", char: name, expr: "*" };
      }
      // Multi-word face expression: collect all consecutive Idents
      const expr = this.parseMultiWordIdent();
      return { type: "face", char: name, expr };
    }

    return { type: "body", key: name };
  }

  // ── with transition_name ;

  private parseWith(): Stmt {
    const transition = this.expectKind("Ident").value;
    this.eatSemi();
    const kind = "With" as const;
    return { kind, transition };
  }

  // ── speak WHO "text" | "voice" ;
  //    speak WHO { "text" | "voice"; ... }
  //    WHO may be a quoted string for multi-word names like "Old Lady"

  private parseSpeak(): Stmt {
    // Speaker name: accept either a bare Ident or a quoted Str
    let who: string;
    if (this.check("Str")) {
      who = this.advance().value;
    } else {
      const tok = this.peek();
      if (tok.kind !== "Ident") {
        throw this.err(
          `Expected speaker name after 'speak', got '${tok.value}'`,
        );
      }
      who = this.advance().value;
    }

    const lines: SpeakLine[] = [];

    if (this.check("{")) {
      // ── Block form: speak WHO { "text" | "voice"; ... } ──────────────────
      this.advance(); // consume {
      while (!this.check("}") && !this.check("EOF")) {
        const text = this.expectKind("Str").value;
        let voice: string | undefined;
        if (this.check("|")) {
          this.advance();
          voice = this.expectKind("Str").value;
        }
        this.expectKind(";");
        lines.push({ text, voice });
      }
      this.expectKind("}");
    } else {
      // ── Inline: first token after WHO is a string ─────────────────────────
      const first = this.expectKind("Str").value;

      if (this.check("{")) {
        // ── Legacy: speak WHO "voice" { "text"; ... } ─────────────────────
        const voice = first;
        this.advance(); // consume {
        while (!this.check("}") && !this.check("EOF")) {
          const text = this.expectKind("Str").value;
          this.expectKind(";");
          lines.push({ text, voice });
        }
        this.expectKind("}");
      } else if (this.check("|")) {
        // ── speak WHO "text" | "voice" ; ─────────────────────────────────
        this.advance();
        const voice = this.expectKind("Str").value;
        this.expectKind(";");
        lines.push({ text: first, voice });
      } else {
        // ── speak WHO "text" ; ────────────────────────────────────────────
        this.expectKind(";");
        lines.push({ text: first });
      }
    }

    return { kind: "Speak", who, lines };
  }

  // ── wait(1.5) ;

  private parseWait(): Stmt {
    this.expectKind("(");
    const duration = parseFloat(this.expectKind("Num").value);
    this.expectKind(")");
    this.eatSemi();
    return { kind: "Wait", duration };
  }

  // ── if condition { body } (else if / elif condition { body })* (else { body })?
  //    condition = raw token stream up to the opening {

  private parseIf(): Stmt {
    const branches: IfBranch[] = [];

    // First: if <condition> { <body> }
    const firstCond = this.parseRawCondition();
    this.expectKind("{");
    const firstBody = this.parseBody();
    this.expectKind("}");
    branches.push({ condition: firstCond, body: firstBody });

    // Optional: else if / elif / else
    while (this.checkIdent("else") || this.checkIdent("elif")) {
      if (this.checkIdent("elif")) {
        // `elif` is a shorthand for `else if`
        this.advance(); // consume 'elif'
        const cond = this.parseRawCondition();
        this.expectKind("{");
        const body = this.parseBody();
        this.expectKind("}");
        branches.push({ condition: cond, body });
      } else {
        // `else`
        this.advance(); // consume 'else'

        if (this.checkIdent("if")) {
          this.advance(); // consume 'if'
          const cond = this.parseRawCondition();
          this.expectKind("{");
          const body = this.parseBody();
          this.expectKind("}");
          branches.push({ condition: cond, body });
        } else {
          // bare else
          this.expectKind("{");
          const body = this.parseBody();
          this.expectKind("}");
          branches.push({ condition: null, body });
          break; // else must be last
        }
      }
    }

    return { kind: "If", branches };
  }

  // ── menu { "text" => { body } ... }
  //    "text" if condition => { body }   (conditional menu choice)

  private parseMenu(): Stmt {
    this.expectKind("{");
    const choices: MenuChoice[] = [];

    while (!this.check("}") && !this.check("EOF")) {
      const text = this.expectKind("Str").value;

      // Optional `if <condition>` guard before `=>`
      let condition: string | undefined;
      if (this.checkIdent("if")) {
        this.advance(); // consume 'if'
        condition = this.parseRawUntilArrow();
      }

      this.expectKind("=>");
      this.expectKind("{");
      const body = this.parseBody();
      this.expectKind("}");
      choices.push({ text, condition, body });
    }

    this.expectKind("}");
    return { kind: "Menu", choices };
  }

  // ── jump label ;

  private parseJump(): Stmt {
    const target = this.expectKind("Ident").value;
    this.eatSemi();
    return { kind: "Jump", target };
  }

  // ── call label ;

  private parseCall(): Stmt {
    const target = this.expectKind("Ident").value;
    this.eatSemi();
    return { kind: "Call", target };
  }

  // ── name op value ;  (ident already consumed by caller)

  private parseAssign(name: string): AssignStmt {
    const op = this.advance().value; // consume operator token
    const value = this.parseRawUntilSemi();
    this.eatSemi();
    return { kind: "Assign", name, op, value };
  }

  // ── Raw expression collectors ────────────────────────────────────────────────

  /**
   * Collect tokens as a raw string until the next top-level `{`.
   * Used for `if` / `else if` / `elif` conditions.
   */
  private parseRawCondition(): string {
    const parts: string[] = [];
    let depth = 0;

    while (!this.check("EOF")) {
      const tok = this.peek();
      if (tok.kind === "{" && depth === 0) break;
      if (tok.kind === "{") depth++;
      if (tok.kind === "}") depth--;
      parts.push(this.tokToRaw(this.advance()));
    }

    return parts.join(" ").trim();
  }

  /** Collect tokens as a raw string until the next `;` (not consuming it). */
  private parseRawUntilSemi(): string {
    const parts: string[] = [];

    while (!this.check(";") && !this.check("EOF") && !this.check("}")) {
      parts.push(this.tokToRaw(this.advance()));
    }

    return parts.join(" ").trim();
  }

  private tokToRaw(tok: Token): string {
    if (tok.kind === "Str") {
      const escaped = tok.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `"${escaped}"`;
    }
    return tok.value;
  }

  // ── Multi-word ident collector ────────────────────────────────────────────────

  /**
   * Collect one or more consecutive Ident tokens (space-joined) as a single
   * expression string.  Stops at the first non-Ident token.
   *
   * Used for multi-word face expressions like "sick normal1", "surprised1 sepia".
   */
  private parseMultiWordIdent(): string {
    // First token may be Ident or Num (e.g. face expression "1" in hide sx::1)
    const firstTok = this.peek();
    if (firstTok.kind !== "Ident" && firstTok.kind !== "Num") {
      throw this.err(
        `Expected face expression (Ident or Num), got '${firstTok.kind}' ('${firstTok.value}')`,
      );
    }
    const first = this.advance().value;
    const parts: string[] = [first];
    // Accept consecutive Ident or Num tokens (e.g. "sick normal1", "yoichi8head1 1")
    while (this.peek().kind === "Ident" || this.peek().kind === "Num") {
      parts.push(this.advance().value);
    }
    return parts.join(" ");
  }

  /**
   * Collect tokens as a raw string until the next top-level `=>`.
   * Used for menu choice `if` conditions.
   */
  private parseRawUntilArrow(): string {
    const parts: string[] = [];
    let depth = 0;

    while (!this.check("EOF")) {
      const tok = this.peek();
      if (tok.kind === "=>" && depth === 0) break;
      if (tok.kind === "{" || tok.kind === "(") depth++;
      if (tok.kind === "}" || tok.kind === ")") depth--;
      parts.push(this.tokToRaw(this.advance()));
    }

    return parts.join(" ").trim();
  }

  // ── Token helpers ────────────────────────────────────────────────────────────

  private peek(offset = 0): Token {
    return (
      this.tokens[this.pos + offset] ?? { kind: "EOF", value: "", line: 0 }
    );
  }

  private advance(): Token {
    return this.tokens[this.pos++] ?? { kind: "EOF", value: "", line: 0 };
  }

  private check(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  private checkIdent(value: string): boolean {
    const t = this.peek();
    return t.kind === "Ident" && t.value === value;
  }

  private expectKind(kind: TokenKind): Token {
    const tok = this.peek();
    if (tok.kind !== kind) {
      throw this.err(
        `Expected '${kind}' but got '${tok.kind}' ('${tok.value}')`,
      );
    }
    return this.advance();
  }

  private expectIdent(value: string): Token {
    const tok = this.peek();
    if (tok.kind !== "Ident" || tok.value !== value) {
      throw this.err(`Expected keyword '${value}' but got '${tok.value}'`);
    }
    return this.advance();
  }

  /** Consume one or more semicolons if present (handles doubled ;; in generated DSL). */
  private eatSemi(): void {
    while (this.check(";")) this.advance();
  }

  private err(msg: string): Error {
    const tok = this.peek();
    return new Error(`Parse error at line ${tok.line}: ${msg}`);
  }
}
