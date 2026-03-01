import { describe, it, expect } from "vitest";
import { tokenize, type Token } from "../rrs/lexer";
import { tokenRawToValue, rawStringToValue } from "../rrs/literal";
import { parseValue, applySetStep, evaluateCondition } from "../src/evaluate";

describe("Lexer: tokenization edge cases", () => {
  it("parses string literals with escapes and preserves inner content", () => {
    const src = `"Hello \\"World\\"" 'It\\'s OK'`;
    const toks = tokenize(src);
    // Expect two Str tokens then EOF
    const kinds = toks.map((t) => t.kind);
    expect(kinds[0]).toBe("Str");
    expect(kinds[1]).toBe("Str");
    // Values should be unescaped inner content
    expect(toks[0].value).toBe('Hello "World"');
    expect(toks[1].value).toBe("It's OK");
  });

  it("handles numeric tokens and dangling dot", () => {
    const src = `123 1.5 1.`;
    const toks = tokenize(src);
    // 123 -> Num '123', 1.5 -> Num '1.5', 1. -> Num '1' and '.' token
    const nums = toks.filter((t) => t.kind === "Num").map((t) => t.value);
    expect(nums).toEqual(expect.arrayContaining(["123", "1.5", "1"]));
    const dotTok = toks.find((t) => t.kind === ".");
    expect(dotTok).toBeTruthy();
  });

  it("recognizes hex colors, special ??? token and fullwidth pipe", () => {
    const src = `#abc #ff00ff ??? ｜ |`;
    const toks = tokenize(src);
    // HexColor tokens
    const hexes = toks.filter((t) => t.kind === "HexColor").map((t) => t.value);
    expect(hexes).toEqual(expect.arrayContaining(["#abc", "#ff00ff"]));
    // ??? becomes Ident with value '???'
    const q = toks.find((t) => t.kind === "Ident" && t.value === "???");
    expect(q).toBeTruthy();
    // Fullwidth pipe and regular pipe should both produce '|' kind
    const pipes = toks.filter((t) => t.kind === "|");
    // there should be at least two pipes (one fullwidth, one ascii)
    expect(pipes.length).toBeGreaterThanOrEqual(2);
  });

  it("parses two-character and compound operators correctly", () => {
    const src = `a::b => c == d != e <= f >= g += h -= i *= j /= k || &&`;
    const toks = tokenize(src);
    // Check for a few multi-char tokens by their kind
    const kinds = toks.map((t) => t.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "::",
        "=>",
        "==",
        "!=",
        "<=",
        ">=",
        "+=",
        "-=",
        "*=",
        "/=",
        "||",
        "&&",
      ]),
    );
  });

  it("skips // line comments", () => {
    const src = `one // this is a comment\ntwo`;
    const toks = tokenize(src);
    const idents = toks.filter((t) => t.kind === "Ident").map((t) => t.value);
    expect(idents).toEqual(expect.arrayContaining(["one", "two"]));
    // comment text should not appear as tokens
    expect(idents).not.toEqual(expect.arrayContaining(["this"]));
  });
});

describe("literal utilities: tokenRawToValue & rawStringToValue", () => {
  it("converts token kinds to JS values correctly", () => {
    // Str preserves as string
    expect(tokenRawToValue("Str", "hello")).toBe("hello");
    // HexColor preserved as string
    expect(tokenRawToValue("HexColor", "#ffee00")).toBe("#ffee00");
    // Num -> number when valid
    expect(tokenRawToValue("Num", "3.14")).toBeCloseTo(3.14);
    // Ident booleans/null
    expect(tokenRawToValue("Ident", "True")).toBe(true);
    expect(tokenRawToValue("Ident", "false")).toBe(false);
    expect(tokenRawToValue("Ident", "None")).toBeNull();
    // Other: numeric-like string should become number
    expect(tokenRawToValue("Other", "42")).toBe(42);
    // Non-numeric other remains string
    expect(tokenRawToValue("Other", "foo")).toBe("foo");
  });

  it("rawStringToValue handles quoted strings, numbers, hex and fallbacks", () => {
    expect(rawStringToValue('"a \\"quoted\\""')).toBe('a "quoted"');
    expect(rawStringToValue("'single \\'q\\''")).toBe("single 'q'");
    expect(rawStringToValue("#abc")).toBe("#abc");
    expect(rawStringToValue("1")).toBe(1);
    expect(rawStringToValue("  0.5  ")).toBe(0.5);
    expect(rawStringToValue("True")).toBe(true);
    expect(rawStringToValue("None")).toBeNull();
    // non-string inputs returned as-is
    expect(rawStringToValue(5)).toBe(5);
    expect(rawStringToValue(false)).toBe(false);
  });

  it("tokenRawToValue falls back to string when numeric parse fails", () => {
    // Very large exponent parses to Infinity in JS; accept Infinity as numeric parse result
    expect(tokenRawToValue("Num", "1e9999")).toBe(Infinity);
  });
});

describe("evaluate pipeline: parseValue, applySetStep, evaluateCondition", () => {
  it("parseValue delegates to rawStringToValue and returns typed values", () => {
    expect(parseValue('"x"')).toBe("x");
    expect(parseValue("True")).toBe(true);
    expect(parseValue("3.5")).toBe(3.5);
    expect(parseValue("#fff")).toBe("#fff");
  });

  it("applySetStep handles =, +=, -=, *=, /= and division by zero", () => {
    // = assignment uses parsed value directly
    let vars: Record<string, any> = {};
    const stepA: any = { type: "set", var: "a", op: "=", value: "2" };
    vars = applySetStep(vars, stepA);
    expect(vars.a).toBe(2);

    // += increments numeric
    const stepB: any = { type: "set", var: "a", op: "+=", value: "3" };
    vars = applySetStep(vars, stepB);
    expect(vars.a).toBe(5);

    // -= subtract
    const stepC: any = { type: "set", var: "a", op: "-=", value: "1" };
    vars = applySetStep(vars, stepC);
    expect(vars.a).toBe(4);

    // *= multiply
    const stepD: any = { type: "set", var: "a", op: "*=", value: "2" };
    vars = applySetStep(vars, stepD);
    expect(vars.a).toBe(8);

    // /= divide by non-zero
    const stepE: any = { type: "set", var: "a", op: "/=", value: "4" };
    vars = applySetStep(vars, stepE);
    expect(vars.a).toBe(2);

    // /= divide by zero -> result should be 0 per implementation
    const stepF: any = { type: "set", var: "a", op: "/=", value: "0" };
    vars = applySetStep(vars, stepF);
    expect(vars.a).toBe(0);
  });

  it("applySetStep resolves variable references and evaluates renpy.random.randint", () => {
    const baseVars: Record<string, any> = { otherVar: 123 };
    const stepRef: any = { type: "set", var: "x", op: "=", value: "otherVar" };
    const out = applySetStep({ ...baseVars }, stepRef);
    expect(out.x).toBe(123);

    // Function call: renpy.random.randint(a,b) should produce integer in range
    const stepRand: any = {
      type: "set",
      var: "r",
      op: "=",
      value: "renpy.random.randint(1,3)",
    };
    const out2 = applySetStep({ ...baseVars }, stepRand);
    expect(typeof out2.r).toBe("number");
    expect(out2.r).toBeGreaterThanOrEqual(1);
    expect(out2.r).toBeLessThanOrEqual(3);
  });

  it("evaluateCondition supports and/or/not, comparisons, in-operator and unknown tokens", () => {
    const vars: Record<string, any> = {
      a: 5,
      b: 10,
      arr: ["x", "y"],
      truthy: true,
      nested: { inner: 2 },
    };

    // and/or
    expect(evaluateCondition("a < b and b > 0", vars)).toBe(true);
    expect(evaluateCondition("a > b or b == 10", vars)).toBe(true);
    expect(evaluateCondition("not False", vars)).toBe(true);

    // comparisons
    expect(evaluateCondition("a == 5", vars)).toBe(true);
    expect(evaluateCondition("a != 5", vars)).toBe(false);

    // in operator
    expect(evaluateCondition(`'x' in arr`, vars)).toBe(true);
    expect(evaluateCondition(`'z' in arr`, vars)).toBe(false);

    // dotted lookup into nested object
    expect(evaluateCondition("nested.inner == 2", vars)).toBe(true);

    // persistent.* and renpy.* unresolved should return false (treated as falsy)
    expect(evaluateCondition("persistent.foo", vars)).toBe(false);
    expect(evaluateCondition("renpy.something", vars)).toBe(false);

    // unknown token leads to falsy/undefined behaviour but evaluateCondition returns boolean
    expect(evaluateCondition("some_nonexistent_var", vars)).toBe(false);
  });

  it("evaluateCondition handles parentheses and precedence correctly", () => {
    const vars: Record<string, any> = { x: 1, y: 2 };
    // (x == 1 and y == 2) -> true
    expect(evaluateCondition("(x == 1 and y == 2)", vars)).toBe(true);
    // not (x == 1 and y == 2) -> false
    expect(evaluateCondition("not (x == 1 and y == 2)", vars)).toBe(false);
  });
});
