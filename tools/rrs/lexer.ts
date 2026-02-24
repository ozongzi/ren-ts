// ── Lexer / Tokenizer for .rrs ────────────────────────────────────────────────

export type TokenKind =
  // Literals
  | "Str"
  | "Num"
  | "Ident"
  | "HexColor"
  // Namespace / member access
  | "::"
  | ":"
  | "."
  // Positional
  | "@"
  // Pipe (transition modifier)
  | "|"
  // Logical
  | "||"
  | "&&"
  | "!"
  // Comparison
  | "=="
  | "!="
  | "<="
  | ">="
  | "<"
  | ">"
  // Assignment operators
  | "="
  | "+="
  | "-="
  | "*="
  | "/="
  | "=>"
  // Arithmetic
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  // Punctuation
  | ","
  | ";"
  | "{"
  | "}"
  | "("
  | ")"
  // End of file
  | "EOF";

export interface Token {
  kind: TokenKind;
  value: string;
  line: number;
}

// ── Public entry point ────────────────────────────────────────────────────────

export function tokenize(src: string): Token[] {
  return new Lexer(src).tokenize();
}

// ── Internal implementation ───────────────────────────────────────────────────

class Lexer {
  private pos = 0;
  private line = 1;

  constructor(private readonly src: string) {}

  tokenize(): Token[] {
    const tokens: Token[] = [];

    while (this.pos < this.src.length) {
      this.skipWhitespaceAndComments();
      if (this.pos >= this.src.length) break;

      const tok = this.readToken();
      tokens.push(tok);
    }

    tokens.push({ kind: "EOF", value: "", line: this.line });
    return tokens;
  }

  // ── Character helpers ───────────────────────────────────────────────────────

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? "";
  }

  private advance(): string {
    const ch = this.src[this.pos++];
    if (ch === "\n") this.line++;
    return ch;
  }

  // ── Skip whitespace and // line comments ────────────────────────────────────

  private skipWhitespaceAndComments(): void {
    while (this.pos < this.src.length) {
      const ch = this.peek();

      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        this.advance();
        continue;
      }

      // Line comment
      if (ch === "/" && this.peek(1) === "/") {
        while (this.pos < this.src.length && this.peek() !== "\n") {
          this.advance();
        }
        continue;
      }

      break;
    }
  }

  // ── Main token reader ───────────────────────────────────────────────────────

  private readToken(): Token {
    const line = this.line;
    const ch = this.peek();

    // ── String literal "..." ──────────────────────────────────────────────────
    if (ch === '"') return this.readString(line);

    // ── Numeric literal ───────────────────────────────────────────────────────
    if (ch >= "0" && ch <= "9") return this.readNumber(line);

    // ── Hex colour #RRGGBB ────────────────────────────────────────────────────
    if (ch === "#" && this.isHexDigit(this.peek(1))) {
      return this.readHexColor(line);
    }

    // ── Special identifier ??? ────────────────────────────────────────────────
    if (ch === "?" && this.peek(1) === "?" && this.peek(2) === "?") {
      this.advance();
      this.advance();
      this.advance();
      return { kind: "Ident", value: "???", line };
    }

    // ── Regular identifier ────────────────────────────────────────────────────
    if (this.isIdentStart(ch)) return this.readIdent(line);

    // ── Full-width pipe ｜ (U+FF5C) → treat as | ─────────────────────────────
    if (ch === "\uFF5C") {
      this.advance();
      return { kind: "|", value: "|", line };
    }

    // ── Two-character operators (must be checked before single-char) ──────────

    // :: namespace separator
    if (ch === ":" && this.peek(1) === ":") {
      this.advance();
      this.advance();
      return { kind: "::", value: "::", line };
    }

    // => fat arrow
    if (ch === "=" && this.peek(1) === ">") {
      this.advance();
      this.advance();
      return { kind: "=>", value: "=>", line };
    }

    // == equality
    if (ch === "=" && this.peek(1) === "=") {
      this.advance();
      this.advance();
      return { kind: "==", value: "==", line };
    }

    // != not-equal
    if (ch === "!" && this.peek(1) === "=") {
      this.advance();
      this.advance();
      return { kind: "!=", value: "!=", line };
    }

    // <= less-or-equal
    if (ch === "<" && this.peek(1) === "=") {
      this.advance();
      this.advance();
      return { kind: "<=", value: "<=", line };
    }

    // >= greater-or-equal
    if (ch === ">" && this.peek(1) === "=") {
      this.advance();
      this.advance();
      return { kind: ">=", value: ">=", line };
    }

    // += compound assignment
    if (ch === "+" && this.peek(1) === "=") {
      this.advance();
      this.advance();
      return { kind: "+=", value: "+=", line };
    }

    // -= compound assignment
    if (ch === "-" && this.peek(1) === "=") {
      this.advance();
      this.advance();
      return { kind: "-=", value: "-=", line };
    }

    // *= compound assignment
    if (ch === "*" && this.peek(1) === "=") {
      this.advance();
      this.advance();
      return { kind: "*=", value: "*=", line };
    }

    // /= compound assignment  (note: // is already consumed as a comment above)
    if (ch === "/" && this.peek(1) === "=") {
      this.advance();
      this.advance();
      return { kind: "/=", value: "/=", line };
    }

    // || logical or
    if (ch === "|" && this.peek(1) === "|") {
      this.advance();
      this.advance();
      return { kind: "||", value: "||", line };
    }

    // && logical and
    if (ch === "&" && this.peek(1) === "&") {
      this.advance();
      this.advance();
      return { kind: "&&", value: "&&", line };
    }

    // ── Single-character operators ────────────────────────────────────────────
    const singles: Partial<Record<string, TokenKind>> = {
      "=": "=",
      "@": "@",
      "|": "|",
      ",": ",",
      ";": ";",
      "{": "{",
      "}": "}",
      "(": "(",
      ")": ")",
      "*": "*",
      ":": ":",
      ".": ".",
      "!": "!",
      "<": "<",
      ">": ">",
      "+": "+",
      "-": "-",
      "/": "/",
      "%": "%",
    };

    const kind = singles[ch];
    if (kind !== undefined) {
      this.advance();
      return { kind, value: ch, line };
    }

    // ── Unknown character ─────────────────────────────────────────────────────
    throw new Error(
      `Unexpected character '${ch}' (U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}) at line ${line}`,
    );
  }

  // ── Literal readers ───────────────────────────────────────────────────────

  private readString(line: number): Token {
    this.advance(); // consume opening "
    let value = "";

    while (this.pos < this.src.length) {
      const ch = this.peek();
      if (ch === '"') {
        this.advance(); // consume closing "
        break;
      }
      if (ch === "\\") {
        this.advance(); // consume backslash
        const escaped = this.advance();
        switch (escaped) {
          case "n":
            value += "\n";
            break;
          case "t":
            value += "\t";
            break;
          case "r":
            value += "\r";
            break;
          case '"':
            value += '"';
            break;
          case "\\":
            value += "\\";
            break;
          default:
            value += escaped;
            break;
        }
        continue;
      }
      value += this.advance();
    }

    return { kind: "Str", value, line };
  }

  private readNumber(line: number): Token {
    let value = "";
    let hasDot = false;

    while (this.pos < this.src.length) {
      const ch = this.peek();
      if (ch >= "0" && ch <= "9") {
        value += this.advance();
      } else if (
        ch === "." &&
        !hasDot &&
        this.peek(1) >= "0" &&
        this.peek(1) <= "9"
      ) {
        // Only consume dot if followed by a digit (avoids eating trailing dots)
        hasDot = true;
        value += this.advance();
      } else {
        break;
      }
    }

    return { kind: "Num", value, line };
  }

  private readHexColor(line: number): Token {
    this.advance(); // consume #
    let value = "#";

    while (this.pos < this.src.length && this.isHexDigit(this.peek())) {
      value += this.advance();
    }

    if (value.length !== 7 && value.length !== 4) {
      // Still return — the codegen will validate later
      console.warn(
        `Warning: Unusual hex colour length '${value}' at line ${line}`,
      );
    }

    return { kind: "HexColor", value, line };
  }

  private readIdent(line: number): Token {
    let value = "";

    while (this.pos < this.src.length && this.isIdentContinue(this.peek())) {
      value += this.advance();
    }

    return { kind: "Ident", value, line };
  }

  // ── Character classification ──────────────────────────────────────────────

  private isIdentStart(ch: string): boolean {
    return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
  }

  private isIdentContinue(ch: string): boolean {
    return this.isIdentStart(ch) || (ch >= "0" && ch <= "9");
  }

  private isHexDigit(ch: string): boolean {
    return (
      (ch >= "0" && ch <= "9") ||
      (ch >= "a" && ch <= "f") ||
      (ch >= "A" && ch <= "F")
    );
  }
}
