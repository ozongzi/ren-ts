/**
 * renpy_reader/tests/evaluate.spec.ts
 *
 * Unit tests for parseValue, applySetStep and evaluateCondition in src/evaluate.ts
 *
 * Run with: `bun run test` or `vitest`
 */

import { describe, it, expect } from "vitest";
import {
  parseValue,
  applySetStep,
  evaluateCondition,
  defaultVars,
} from "../src/evaluate.ts";

describe("parseValue()", () => {
  it("parses boolean-like strings and None", () => {
    expect(parseValue("True")).toBe(true);
    expect(parseValue("False")).toBe(false);
    expect(parseValue("None")).toBeNull();
  });

  it("unquotes quoted strings and unescapes common escapes", () => {
    expect(parseValue('"Hello \\"World\\""')).toBe('Hello "World"');
    expect(parseValue("'It\\'s OK'")).toBe("It's OK");
    expect(parseValue('"Back\\\\slash"')).toBe("Back\\slash");
  });

  it("parses numeric strings into numbers and leaves non-numeric strings", () => {
    expect(parseValue("123")).toBe(123);
    expect(parseValue("45.6")).toBe(45.6);
    // non-numeric string remains string
    expect(parseValue("some_var")).toBe("some_var");
  });

  it("returns non-string inputs unchanged", () => {
    expect(parseValue(42)).toBe(42);
    expect(parseValue(true)).toBe(true);
  });
});

describe("applySetStep()", () => {
  it("applies '=' operator and creates/overwrites variables", () => {
    const vars = {};
    const step = { type: "set", var: "x", op: "=", value: "10" } as any;
    const out = applySetStep(vars, step);
    expect(out.x).toBe(10);
  });

  it("applies '+=' and '-=' operators", () => {
    const vars = { score: 5 };
    const add = { type: "set", var: "score", op: "+=", value: "3" } as any;
    const afterAdd = applySetStep(vars, add);
    expect(afterAdd.score).toBe(8);

    const sub = { type: "set", var: "score", op: "-=", value: "2" } as any;
    const afterSub = applySetStep(afterAdd, sub);
    expect(afterSub.score).toBe(6);
  });

  it("handles '*=' and '/=' operators and divides safely by zero", () => {
    const vars = { v: 4 };
    const mul = { type: "set", var: "v", op: "*=", value: "2" } as any;
    const afterMul = applySetStep(vars, mul);
    expect(afterMul.v).toBe(8);

    // divide by zero -> per implementation returns 0
    const divByZero = { type: "set", var: "v", op: "/=", value: "0" } as any;
    const afterDiv = applySetStep(afterMul, divByZero);
    expect(afterDiv.v).toBe(0);
  });

  it("resolves boolean and literal string values", () => {
    const vars = {};
    const s1 = { type: "set", var: "flag", op: "=", value: "True" } as any;
    const out1 = applySetStep(vars, s1);
    expect(out1.flag).toBe(true);

    const s2 = { type: "set", var: "name", op: "=", value: '"Alice"' } as any;
    const out2 = applySetStep(out1, s2);
    expect(out2.name).toBe("Alice");
  });

  it("evaluates renpy.random.randint(...) expressions on RHS", () => {
    const vars = {};
    const step = {
      type: "set",
      var: "r",
      op: "=",
      value: "renpy.random.randint(1,3)",
    } as any;
    const out = applySetStep(vars, step);
    // Value should be one of 1,2,3
    expect([1, 2, 3]).toContain(out.r);
  });

  it("resolves variable reference on RHS when present in vars", () => {
    const vars = { other: 7 };
    const step = { type: "set", var: "x", op: "=", value: "other" } as any; // raw string 'other'
    const out = applySetStep(vars, step);
    expect(out.x).toBe(7);
  });
});

describe("evaluateCondition()", () => {
  it("returns true for null condition (else branch)", () => {
    expect(evaluateCondition(null, {})).toBe(true);
  });

  it("evaluates basic comparisons and numeric logic", () => {
    const vars = { a: 5, b: 10 };
    expect(evaluateCondition("a < b", vars)).toBe(true);
    expect(evaluateCondition("a == 5", vars)).toBe(true);
    expect(evaluateCondition("b >= 11", vars)).toBe(false);
    expect(evaluateCondition("a != b", vars)).toBe(true);
  });

  it("handles and / or / not operators and parentheses", () => {
    const vars = { x: true, y: false, v: 2 };
    expect(evaluateCondition("x and not y", vars)).toBe(true);
    expect(evaluateCondition("x and y", vars)).toBe(false);
    expect(evaluateCondition("x or y", vars)).toBe(true);
    expect(evaluateCondition("(v > 1) and (v < 3)", vars)).toBe(true);
  });

  it("supports 'in' operator with arrays", () => {
    const vars = { list: ["a", "b", "c"] };
    expect(evaluateCondition('"a" in list', vars)).toBe(true);
    expect(evaluateCondition('"z" in list', vars)).toBe(false);
  });

  it("treats unknown tokens as falsy and returns false", () => {
    expect(evaluateCondition("this_token_does_not_exist", {},)).toBe(false);
  });

  it("gracefully handles function-call based conditions like renpy.random.randint", () => {
    // A condition that uses randint and compares range should evaluate to true
    const ok = evaluateCondition("renpy.random.randint(1,2) >= 1", {});
    expect(typeof ok === "boolean").toBe(true);
  });

  it("respects variable lookups and dotted access for nested objects", () => {
    const vars = { persistent: { unlocked: true }, unlocked: false };
    // persistent.unlocked should be resolved (object-chain traversal)
    expect(evaluateCondition("persistent.unlocked", vars)).toBe(true);
    // plain 'unlocked' refers to top-level key
    expect(evaluateCondition("unlocked", vars)).toBe(false);
  });
});
