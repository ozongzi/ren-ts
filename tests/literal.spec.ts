import { describe, it, expect } from "vitest";
import { collectDefines } from "../rrs/codegen";
import { parseValue, applySetStep } from "../src/evaluate";

describe("Literal parsing semantics (shared behavior)", () => {
  it("collectDefines converts token-kind+raw into typed runtime values", () => {
    // Construct a set of defines mirroring parser output (token-kind + raw)
    const defines: any[] = [
      {
        kind: "Define",
        key: "GAME_NAME",
        value: { kind: "Str", raw: "My VN Game" },
      },
      { kind: "Define", key: "IS_LIT", value: { kind: "Ident", raw: "True" } },
      {
        kind: "Define",
        key: "IS_FALSE",
        value: { kind: "Ident", raw: "False" },
      },
      {
        kind: "Define",
        key: "NONE_VAL",
        value: { kind: "Ident", raw: "None" },
      },
      { kind: "Define", key: "NUM_A", value: { kind: "Num", raw: "1.5" } },
      {
        kind: "Define",
        key: "HEX",
        value: { kind: "HexColor", raw: "#ff00ff" },
      },
      // Complex/unparseable define (parser sentinel) should be skipped
      { kind: "Define", key: "COMPLEX", value: "" },
    ];

    const out = collectDefines(defines);

    expect(out).toHaveProperty("GAME_NAME", "My VN Game");
    expect(out).toHaveProperty("IS_LIT", true);
    expect(out).toHaveProperty("IS_FALSE", false);
    expect(out).toHaveProperty("NONE_VAL", null);
    expect(out).toHaveProperty("NUM_A", 1.5);
    expect(out).toHaveProperty("HEX", "#ff00ff");
    expect(out).not.toHaveProperty("COMPLEX");
  });

  it("parseValue preserves quoted strings and converts unquoted literals", () => {
    expect(parseValue('"true"')).toBe("true"); // quoted -> string
    expect(parseValue("'42'")).toBe("42");
    expect(parseValue("True")).toBe(true);
    expect(parseValue("true")).toBe(true);
    expect(parseValue("False")).toBe(false);
    expect(parseValue("None")).toBe(null);
    expect(parseValue("1")).toBe(1);
    expect(parseValue("0.5")).toBe(0.5);
    expect(parseValue("#abc")).toBe("#abc"); // hex color preserved as string
  });

  it("applySetStep uses parseValue and resolves variable references", () => {
    // Basic assignment from quoted string -> string
    const stepA: any = { type: "set", var: "x", op: "=", value: '"true"' };
    const varsA = {};
    const resA = applySetStep(varsA as any, stepA);
    expect(resA.x).toBe("true");

    // Unquoted True -> boolean true
    const stepB: any = { type: "set", var: "y", op: "=", value: "True" };
    const resB = applySetStep(varsA as any, stepB);
    expect(resB.y).toBe(true);

    // Numeric RHS -> number
    const stepC: any = { type: "set", var: "z", op: "=", value: "42" };
    const resC = applySetStep(varsA as any, stepC);
    expect(resC.z).toBe(42);

    // Variable reference: RHS is an identifier matching an existing key
    const baseVars = { otherVar: 123 } as Record<string, unknown>;
    const stepD: any = { type: "set", var: "a", op: "=", value: "otherVar" };
    const merged = { ...baseVars }; // applySetStep expects a merged plain record
    const resD = applySetStep(merged as any, stepD);
    expect(resD.a).toBe(123);
  });
});
