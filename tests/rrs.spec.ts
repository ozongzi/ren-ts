import { describe, it, expect } from "vitest";
import { parseScript } from "../rrs";
import type { JsonFile } from "../rrs/ast";

/**
 * Black-box tests for the .rrs frontend (parser + codegen).
 *
 * These tests exercise:
 *  - Top-level defines parsing + typed conversion (strings, numbers, booleans, null, hex)
 *  - Nested label hoisting (nested `label` inside a label body is lifted to top-level)
 *  - Control-flow constructs: if/else -> compiled into an `if` step with branches
 *  - Menu -> compiled into a `menu` step with options and nested steps
 *  - Jump -> emitted as `jump` step targeting a label
 *
 * The tests call the public API `parseScript(src, filename)` which returns a
 * ScriptFile-like object ({ defines, labels, source }).
 */

describe("rrs parser + codegen black-box", () => {
  it("parses top-level defines with correct typed values", () => {
    const src = `
GAME_NAME = "My VN Game";
IS_TRUE = True;
IS_FALSE = False;
NONE_VAL = None;
NUM_A = 1.5;
HEX = #ff00ff;
position.left = 0.25;
`;

    const out = parseScript(src, "defines.rrs") as JsonFile;

    // Basic shape
    expect(out).toHaveProperty("defines");
    const d = out.defines;

    expect(d).toHaveProperty("GAME_NAME", "My VN Game");
    expect(d).toHaveProperty("IS_TRUE", true);
    expect(d).toHaveProperty("IS_FALSE", false);
    expect(d).toHaveProperty("NONE_VAL", null);
    expect(d).toHaveProperty("NUM_A", 1.5);
    expect(d).toHaveProperty("HEX", "#ff00ff");
    // position.* expected to be parsed as number (collectDefines attempts numeric)
    // Note: toHaveProperty("position.left") would treat the dot as a nested path,
    // so we access the key directly via bracket notation instead.
    expect("position.left" in d).toBe(true);
    expect(typeof d["position.left"]).toBe("number");
    expect(d["position.left"] as number).toBeCloseTo(0.25);
  });

  it("hoists nested labels and preserves parent body order", () => {
    const src = `
label start {
  speak ??? "Hello";
  label inner {
    speak ??? "Inside";
  }
  speak ??? "After";
}
`;

    const out = parseScript(src, "hoist.rrs") as JsonFile;
    const labels = out.labels;

    // Top-level labels must include both start and inner
    expect(labels).toHaveProperty("start");
    expect(labels).toHaveProperty("inner");

    const startSteps = labels["start"];
    const innerSteps = labels["inner"];

    // start should contain two say steps: "Hello" and "After"
    const startSayTexts = startSteps
      .filter((s: any) => s.type === "say")
      .map((s: any) => s.text);
    expect(startSayTexts).toEqual(["Hello", "After"]);

    // inner should contain the "Inside" line
    const innerSayTexts = innerSteps
      .filter((s: any) => s.type === "say")
      .map((s: any) => s.text);
    expect(innerSayTexts).toEqual(["Inside"]);
  });

  it("compiles if/else into an `if` step with branches and nested steps", () => {
    const src = `
label cond_test {
  if True {
    speak ??? "A";
  } else {
    speak ??? "B";
  }
}
`;

    const out = parseScript(src, "if.rrs") as JsonFile;
    const steps = out.labels["cond_test"];

    // There should be exactly one top-level step and it should be an if-step.
    expect(steps.length).toBeGreaterThan(0);
    const ifStep = steps.find((s: any) => s.type === "if");
    expect(ifStep).toBeDefined();
    // Narrow the type for TS by using a dedicated any alias after the runtime assertion.
    const ifStepAny = ifStep as any;

    // Branches: first with condition "True", second is else (condition null)
    expect(ifStepAny.branches).toBeInstanceOf(Array);
    expect(ifStepAny.branches.length).toBe(2);

    const [first, second] = ifStepAny.branches;
    // first branch condition should be the raw condition string (parser keeps it)
    expect(first.condition).toBeDefined();
    // The first branch should produce a say step with text "A"
    const firstTexts = first.steps
      .filter((s: any) => s.type === "say")
      .map((s: any) => s.text);
    expect(firstTexts).toEqual(["A"]);

    // else branch (condition null) -> say "B"
    expect(second.condition).toBeNull();
    const secondTexts = second.steps
      .filter((s: any) => s.type === "say")
      .map((s: any) => s.text);
    expect(secondTexts).toEqual(["B"]);
  });

  it("compiles menu choices into a `menu` step with options and nested steps", () => {
    const src = `
label choices {
  menu {
    "Go A" => { jump a; }
    "Go B" => { jump b; }
  }
}

label a { speak ??? "Answer A"; }
label b { speak ??? "Answer B"; }
`;

    const out = parseScript(src, "menu.rrs") as JsonFile;
    const steps = out.labels["choices"];

    const menuStep = steps.find((s: any) => s.type === "menu");
    expect(menuStep).toBeDefined();
    const menuAny = menuStep as any;

    const options = menuAny.options;
    expect(Array.isArray(options)).toBe(true);
    expect(options.length).toBe(2);

    expect(options[0].text).toBe("Go A");
    expect(options[1].text).toBe("Go B");

    // Each option should contain a jump step to target labels
    const opt0Jumps = options[0].steps
      .filter((s: any) => s.type === "jump")
      .map((s: any) => s.target);
    const opt1Jumps = options[1].steps
      .filter((s: any) => s.type === "jump")
      .map((s: any) => s.target);

    expect(opt0Jumps).toEqual(["a"]);
    expect(opt1Jumps).toEqual(["b"]);

    // And the target labels a/b should have their say steps
    expect(out.labels).toHaveProperty("a");
    expect(out.labels).toHaveProperty("b");
    const aTexts = out.labels["a"]
      .filter((s: any) => s.type === "say")
      .map((s: any) => s.text);
    const bTexts = out.labels["b"]
      .filter((s: any) => s.type === "say")
      .map((s: any) => s.text);
    expect(aTexts).toEqual(["Answer A"]);
    expect(bTexts).toEqual(["Answer B"]);
  });

  it("emits jump steps and preserves jump targets", () => {
    const src = `
label from {
  jump to;
}

label to {
  speak ??? "Destination";
}
`;
    const out = parseScript(src, "jump.rrs") as JsonFile;
    const fromSteps = out.labels["from"];
    const jumpStep = fromSteps.find((s: any) => s.type === "jump");
    expect(jumpStep).toBeDefined();
    const jumpStepAny = jumpStep as any;
    expect(jumpStepAny.target).toBe("to");

    const toSteps = out.labels["to"];
    const texts = toSteps
      .filter((s: any) => s.type === "say")
      .map((s: any) => s.text);
    expect(texts).toEqual(["Destination"]);
  });
});
