/**
 * renpy_reader/tests/codegen.spec.ts
 *
 * Unit tests for the code generation step (src/rrs/codegen.ts) via the public
 * parseScript() entrypoint which runs tokenize -> parse -> compile.
 *
 * These tests exercise:
 *  - collection of top-level defines
 *  - emission of scene/show/say/jump/set steps
 *  - compilation of if/menu constructs
 *  - hoisting of nested labels
 *
 * Run with: `bun run test` or `vitest`
 */

import { describe, it, expect } from "vitest";
import { parseScript } from "../src/rrs/index.ts";

describe("codegen / compile via parseScript()", () => {
  it("collects top-level defines and emits basic scene/show/say/jump steps", () => {
    const src = `
      // Top-level defines
      char.k = "Keitaro";
      image.bg_entrance = "BGs/entrance.jpg";
      position.p1 = 0.5;

      label start {
        scene "BGs/entrance.jpg";
        show keitaro.normal1 @ center;
        speak k "Hello there";
        jump next;
      }

      label next {
        speak k "You arrived";
        return;
      }
    `;

    const result = parseScript(src, "test.rrs");

    // Defines should include the top-level keys and values (strings preserved)
    expect(result.defines["char.k"]).toBe("Keitaro");
    expect(result.defines["image.bg_entrance"]).toBe("BGs/entrance.jpg");
    expect(result.defines["position.p1"]).toBe("0.5");

    // Labels
    expect(result.labels).toHaveProperty("start");
    expect(result.labels).toHaveProperty("next");

    const startSteps = result.labels["start"];
    // Expect at least 4 steps: scene, show, say, jump
    expect(startSteps.length).toBeGreaterThanOrEqual(4);

    // Find steps by type
    const sceneStep = startSteps.find((s) => s.type === "scene");
    expect(sceneStep).toBeDefined();
    expect((sceneStep as any).src).toBe("BGs/entrance.jpg");

    const showStep = startSteps.find((s) => s.type === "show");
    expect(showStep).toBeDefined();
    expect((showStep as any).sprite).toBe("keitaro.normal1");
    expect((showStep as any).at).toBe("center");

    const sayStep = startSteps.find((s) => s.type === "say");
    expect(sayStep).toBeDefined();
    expect((sayStep as any).who).toBe("k");
    expect((sayStep as any).text).toBe("Hello there");

    const jumpStep = startSteps.find((s) => s.type === "jump");
    expect(jumpStep).toBeDefined();
    expect((jumpStep as any).target).toBe("next");
  });

  it("emits set steps for assignments and respects operators", () => {
    const src = `
      label conf {
        game.score = 10;
        player.lives += 1;
        player.lives -= 2;
      }
    `;

    const result = parseScript(src, "assign.rrs");
    const steps = result.labels["conf"];

    // Collect all set steps
    const setSteps = steps.filter((s) => s.type === "set");
    expect(setSteps.length).toBeGreaterThanOrEqual(3);

    // Map by var name for easy assertions
    const byVar: Record<string, any> = {};
    for (const s of setSteps) {
      byVar[(s as any).var] = s;
    }

    expect(byVar["game.score"]).toBeDefined();
    expect(byVar["game.score"].op).toBe("=");
    expect(byVar["game.score"].value).toBe("10");

    expect(byVar["player.lives"]).toBeDefined();
    // Note: latest assignment in sequence may overwrite; ensure operators appear on some set step
    const ops = setSteps.map((s) => (s as any).op);
    expect(ops).toContain("+=");
    expect(ops).toContain("-=");
  });

  it("compiles if/elif/else into an 'if' step and menu into a 'menu' step", () => {
    const src = `
      label control {
        if is_day {
          jump morning;
        } elif is_evening {
          jump evening;
        } else {
          jump night;
        }

        menu {
          "Go left" => { jump left; }
          "Go right" if unlocked => { jump right; }
        }
      }
    `;

    const result = parseScript(src, "flow.rrs");
    const steps = result.labels["control"];

    // Find the if and menu steps
    const ifStep = steps.find((s) => s.type === "if");
    expect(ifStep).toBeDefined();
    const branches = (ifStep as any).branches;
    expect(Array.isArray(branches)).toBe(true);
    expect(branches.length).toBe(3);
    expect(branches[0].condition).toBe("is_day");
    expect(branches[1].condition).toBe("is_evening");
    expect(branches[2].condition).toBeNull();

    const menuStep = steps.find((s) => s.type === "menu");
    expect(menuStep).toBeDefined();
    const options = (menuStep as any).options;
    expect(Array.isArray(options)).toBe(true);
    expect(options.length).toBe(2);
    expect(options[0].text).toBe("Go left");
    expect(options[1].text).toBe("Go right");
    // Second option should have a condition string
    expect(typeof options[1].condition).toBe("string");
    expect(options[1].condition).toBe("unlocked");
  });

  it("hoists nested labels to top-level labels and removes Label stmts from parent body", () => {
    const src = `
      label parent {
        speak ??? "before";
        label inner {
          speak ??? "inside";
        }
        speak ??? "after";
      }
    `;

    const result = parseScript(src, "hoist.rrs");

    // Both labels should be top-level keys
    expect(result.labels).toHaveProperty("parent");
    expect(result.labels).toHaveProperty("inner");

    const parentSteps = result.labels["parent"].map((s) =>
      (s as any).type === "say" ? (s as any).text : (s as any).type,
    );

    // Ensure 'before' and 'after' say steps exist in parent steps
    expect(parentSteps).toContain("before");
    expect(parentSteps).toContain("after");
    // Parent steps should NOT contain a 'Label' step (i.e. nested label was hoisted)
    expect(parentSteps).not.toContain("Label");

    const innerSteps = result.labels["inner"];
    expect(innerSteps.some((s) => s.type === "say" && (s as any).text === "inside")).toBe(true);
  });
});
