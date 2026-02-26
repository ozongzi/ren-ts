/**
 * renpy_reader/tests/lexer.spec.ts
 *
 * Unit tests for `src/rrs/lexer.ts`
 *
 * Covers:
 * - identifiers
 * - string literals (single/double, escapes)
 * - numeric literals (integer & float)
 * - comments (//)
 * - hex colours
 * - full-width pipe
 * - special "???" identifier
 * - unknown character error
 *
 * Run with: `bun run test` or `vitest` from project root.
 */

import { describe, it, expect } from "vitest";
import { tokenize } from "../src/rrs/lexer.ts";

describe("lexer/tokenize basic tokens", () => {
  it("tokenizes identifiers", () => {
    const src = "foo bar _baz123";
    const tokens = tokenize(src);
    // expect three identifiers then EOF
    const kinds = tokens.map((t) => t.kind);
    const values = tokens.map((t) => t.value);
    expect(kinds.slice(0, 3)).toEqual(["Ident", "Ident", "Ident"]);
    expect(values.slice(0, 3)).toEqual(["foo", "bar", "_baz123"]);
    expect(tokens[tokens.length - 1].kind).toBe("EOF");
  });

  it("tokenizes integer and float numbers", () => {
    const src = "123 45.67";
    const tokens = tokenize(src);
    const numTokens = tokens.filter((t) => t.kind === "Num");
    expect(numTokens.length).toBe(2);
    expect(numTokens[0].value).toBe("123");
    expect(numTokens[1].value).toBe("45.67");
  });

  it("handles // line comments and updates line numbers", () => {
    const src = "first // this is a comment\nsecond";
    const tokens = tokenize(src);
    // tokens: Ident(first), Ident(second), EOF
    const idTokens = tokens.filter((t) => t.kind === "Ident");
    expect(idTokens.length).toBe(2);
    expect(idTokens[0].value).toBe("first");
    expect(idTokens[1].value).toBe("second");
    // second should be on line 2
    expect(idTokens[1].line).toBeGreaterThanOrEqual(2);
  });

  it("recognizes hex colours (#abc and #A1B2C3) as HexColor tokens", () => {
    const src = "#abc #A1B2C3";
    const tokens = tokenize(src);
    const hex = tokens.filter((t) => t.kind === "HexColor");
    expect(hex.length).toBe(2);
    expect(hex[0].value.toLowerCase()).toBe("#abc");
    expect(hex[1].value).toBe("#A1B2C3");
  });

  it("treats full-width pipe (U+FF5C) as '|'", () => {
    // include the full-width pipe between two string tokens
    const src = `"a"｜"b"`; // note: the middle char is U+FF5C
    const tokens = tokenize(src);
    // Expect sequence: Str, |, Str, EOF
    expect(tokens[0].kind).toBe("Str");
    expect(tokens[1].kind).toBe("|");
    expect(tokens[1].value).toBe("|");
    expect(tokens[2].kind).toBe("Str");
  });

  it("parses the special '???' identifier", () => {
    const src = "???";
    const tokens = tokenize(src);
    expect(tokens[0].kind).toBe("Ident");
    expect(tokens[0].value).toBe("???");
  });
});

describe("lexer/string literal handling", () => {
  it("parses double-quoted strings and escape sequences", () => {
    const src = `"Hello\\nWorld" "She said: \\"Hi\\""`;
    const tokens = tokenize(src);
    const strs = tokens.filter((t) => t.kind === "Str");
    expect(strs.length).toBe(2);
    expect(strs[0].value).toBe("Hello\nWorld");
    expect(strs[1].value).toBe('She said: "Hi"');
  });

  it("parses single-quoted strings and escaped single quote", () => {
    const src = `'It\\'s fine' 'Backslash \\\\'`;
    const tokens = tokenize(src);
    const strs = tokens.filter((t) => t.kind === "Str");
    expect(strs.length).toBe(2);
    expect(strs[0].value).toBe("It's fine");
    expect(strs[1].value).toBe("Backslash \\");
  });

  it("returns string tokens with correct line numbers for multi-line input", () => {
    const src = `"one"\n"two"\n"three"`;
    const tokens = tokenize(src);
    const strs = tokens.filter((t) => t.kind === "Str");
    expect(strs.length).toBe(3);
    expect(strs[0].line).toBe(1);
    expect(strs[1].line).toBe(2);
    expect(strs[2].line).toBe(3);
  });
});

describe("lexer/errors and edge cases", () => {
  it("throws on unknown characters", () => {
    // $ is not a known token in the lexer implementation
    expect(() => tokenize("foo $ bar")).toThrow(/Unexpected character/);
  });

  it("handles unterminated string by returning what it can or throwing consistently", () => {
    // behaviour: the lexer tries to read until EOF; the implementation will
    // return a Str token even if closing quote missing (it just exits loop on EOF).
    // We assert that a Str token is emitted and EOF follows.
    const src = `"unterminated`;
    const tokens = tokenize(src);
    // First token should be Str (value contains the rest)
    expect(tokens[0].kind).toBe("Str");
    expect(tokens[tokens.length - 1].kind).toBe("EOF");
  });
});
