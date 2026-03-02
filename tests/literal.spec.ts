import { describe, it, expect } from "vitest";
import { collectDefines } from "../rrs/codegen";
import { parseValue } from "../src/evaluate";
import { VarStore } from "../src/vars";

describe("Literal parsing semantics (shared behavior)", () => {
  it("collectDefines converts token-kind+raw into typed runtime values", () => {
    // Construct a set of defines mirroring parser output (token-kind + raw)
    const defines: import("../rrs/ast").DefineDecl[] = [
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

  it("VarStore.applySet uses parseValue and resolves variable references", () => {
    // Basic assignment from quoted string -> string
    const stepA = {
      type: "set" as const,
      var: "x",
      op: "=" as const,
      value: '"true"',
    };
    const resA = VarStore.empty().applySet(stepA);
    expect(resA.get("x")).toBe("true");

    // Unquoted True -> boolean true
    const stepB = {
      type: "set" as const,
      var: "y",
      op: "=" as const,
      value: "True",
    };
    const resB = VarStore.empty().applySet(stepB);
    expect(resB.get("y")).toBe(true);

    // Numeric RHS -> number
    const stepC = {
      type: "set" as const,
      var: "z",
      op: "=" as const,
      value: "42",
    };
    const resC = VarStore.empty().applySet(stepC);
    expect(resC.get("z")).toBe(42);

    // Variable reference: RHS is an identifier matching an existing key in game vars
    const baseStore = VarStore.empty().set("otherVar", 123);
    const stepD = {
      type: "set" as const,
      var: "a",
      op: "=" as const,
      value: "otherVar",
    };
    const resD = baseStore.applySet(stepD);
    expect(resD.get("a")).toBe(123);
  });
});
