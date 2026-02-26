import { describe, it, expect } from "vitest";
import { tokenize } from "../src/rrs/lexer.ts";
import { parse } from "../src/rrs/parser.ts";

describe("parser: top-level defines and labels", () => {
  it("parses top-level define declarations (simple keys and dotted keys)", () => {
    const src = `
      char.k = "Keitaro"
      audio.bgm_main = "Audio/BGM/main.ogg"
      CAMP_NAME = "Camp Buddy"
    `;
    const prog = parse(tokenize(src));

    // Expect three defines
    expect(prog.defines.length).toBeGreaterThanOrEqual(3);

    const keys = prog.defines.map((d) => d.key);
    const vals = Object.fromEntries(prog.defines.map((d) => [d.key, d.value]));

    expect(keys).toContain("char.k");
    expect(keys).toContain("audio.bgm_main");
    expect(keys).toContain("CAMP_NAME");

    expect(vals["char.k"]).toBe("Keitaro");
    expect(vals["audio.bgm_main"]).toBe("Audio/BGM/main.ogg");
    expect(vals["CAMP_NAME"]).toBe("Camp Buddy");
  });

  it("parses labels and simple statements (speak, jump, return)", () => {
    const src = `
      label start {
        speak Hiro "Hello there";
        jump next;
      }

      label next {
        speak Hiro "You arrived";
        return;
      }
    `;
    const prog = parse(tokenize(src));

    // Should have two labels: start and next
    const start = prog.labels.find((l) => l.name === "start");
    const next = prog.labels.find((l) => l.name === "next");

    expect(start).toBeDefined();
    expect(next).toBeDefined();

    // start.body should contain a Speak and a Jump
    const startKinds = start!.body.map((s) => s.kind);
    expect(startKinds).toContain("Speak");
    expect(startKinds).toContain("Jump");

    // Verify the Jump target in start is 'next'
    const jumpStmt = start!.body.find((s) => s.kind === "Jump");
    // @ts-expect-error - we only assert shape in tests
    expect((jumpStmt as any).target).toBe("next");

    // next.body should contain Speak then Return
    const nextKinds = next!.body.map((s) => s.kind);
    expect(nextKinds).toContain("Speak");
    expect(nextKinds).toContain("Return");
  });
});

describe("parser: conditional statements (if / elif / else)", () => {
  it("parses if / elif / else branches and preserves conditions", () => {
    const src = `
      label decision {
        if is_day {
          speak ??? "Good morning";
        } elif is_evening {
          speak ??? "Good evening";
        } else {
          speak ??? "Good night";
        }
      }
    `;
    const prog = parse(tokenize(src));
    const lbl = prog.labels.find((l) => l.name === "decision");
    expect(lbl).toBeDefined();

    const ifStmt = lbl!.body.find((s) => s.kind === "If");
    expect(ifStmt).toBeDefined();

    // @ts-expect-error - assert shape
    const branches = (ifStmt as any).branches;
    expect(branches).toHaveLength(3);
    // First branch condition should be 'is_day'
    expect(branches[0].condition).toBe("is_day");
    // Second branch condition should be 'is_evening'
    expect(branches[1].condition).toBe("is_evening");
    // Third (else) branch condition should be null
    expect(branches[2].condition).toBeNull();

    // Ensure bodies contain Speak statements
    expect(branches.every((b: any) => Array.isArray(b.body) && b.body.some((st: any) => st.kind === "Speak"))).toBe(true);
  });

  it("parses nested if statements inside labels", () => {
    const src = `
      label nested_if {
        if cond1 {
          if cond2 {
            jump inner;
          }
        }
      }
    `;
    const prog = parse(tokenize(src));
    const lbl = prog.labels.find((l) => l.name === "nested_if");
    expect(lbl).toBeDefined();

    const outerIf = lbl!.body.find((s) => s.kind === "If");
    expect(outerIf).toBeDefined();

    // Inspect nested body for inner If
    // @ts-expect-error
    const outerBranches = (outerIf as any).branches;
    expect(outerBranches[0].body.some((st: any) => st.kind === "If")).toBe(true);

    const innerIf = outerBranches[0].body.find((st: any) => st.kind === "If");
    // @ts-expect-error
    const innerBranches = (innerIf as any).branches;
    expect(innerBranches[0].body.some((st: any) => st.kind === "Jump")).toBe(true);
  });
});

describe("parser: menu and choices", () => {
  it("parses a simple menu with two choices and guarded bodies", () => {
    const src = `
      label choices {
        menu {
          "Choice A" => {
            jump a;
          }
          "Choice B" => {
            jump b;
          }
        }
      }
    `;
    const prog = parse(tokenize(src));
    const lbl = prog.labels.find((l) => l.name === "choices");
    expect(lbl).toBeDefined();

    const menuStmt = lbl!.body.find((s) => s.kind === "Menu");
    expect(menuStmt).toBeDefined();

    // @ts-expect-error - inspect choices
    const choices = (menuStmt as any).choices;
    expect(Array.isArray(choices)).toBe(true);
    expect(choices).toHaveLength(2);

    expect(choices[0].text).toBe("Choice A");
    expect(choices[1].text).toBe("Choice B");

    // Each choice body should contain a Jump to the respective label
    expect(choices[0].body.some((st: any) => st.kind === "Jump" && (st as any).target === "a")).toBe(true);
    expect(choices[1].body.some((st: any) => st.kind === "Jump" && (st as any).target === "b")).toBe(true);
  });

  it("parses menu choice with a condition guard", () => {
    const src = `
      label guarded_menu {
        menu {
          "Secret" if unlocked => {
            jump secret;
          }
        }
      }
    `;
    const prog = parse(tokenize(src));
    const lbl = prog.labels.find((l) => l.name === "guarded_menu");
    expect(lbl).toBeDefined();

    const menuStmt = lbl!.body.find((s) => s.kind === "Menu");
    expect(menuStmt).toBeDefined();

    // @ts-expect-error
    const choices = (menuStmt as any).choices;
    expect(choices[0].text).toBe("Secret");
    // Condition should be present as a string 'unlocked' or similar
    expect(choices[0].condition).toBeDefined();
    expect(typeof choices[0].condition).toBe("string");
  });
});

describe("parser: assignment operator parsing and dotted names", () => {
  it("parses dotted assignments inside label bodies and distinguishes operators", () => {
    const src = `
      label conf {
        game.score = 10;
        player.lives += 1;
      }
    `;
    const prog = parse(tokenize(src));
    const lbl = prog.labels.find((l) => l.name === "conf");
    expect(lbl).toBeDefined();

    // Find assign statements
    // @ts-expect-error
    const assigns = lbl!.body.filter((s: any) => s.kind === "Assign");
    expect(assigns.length).toBeGreaterThanOrEqual(2);

    const scoreAssign = assigns.find((a: any) => a.name === "game.score");
    const livesAssign = assigns.find((a: any) => a.name === "player.lives");

    expect(scoreAssign).toBeDefined();
    expect(livesAssign).toBeDefined();

    expect(scoreAssign.op).toBe("=");
    expect(livesAssign.op).toBe("+=");
    expect(scoreAssign.value).toBe("10");
    expect(livesAssign.value).toBe("1");
  });
});
