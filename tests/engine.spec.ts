import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as loader from "../src/loader";
import { createInitialState, startNewGame, advance } from "../src/engine";

describe("engine core flows (startNewGame, menu handling, advance)", () => {
  // Simple in-memory label registry used by mocked loader.getLabel()
  const labels: Record<string, any[]> = {};

  beforeEach(() => {
    // Provide deterministic manifest start and define vars
    vi.spyOn(loader, "getManifestStart").mockReturnValue("start");
    vi.spyOn(loader, "getDefineVars").mockReturnValue({
      "char.k": "Keitaro",
      "image.bg": "BGs/default.jpg",
    });

    // Mock getLabel to return steps from our in-test registry
    vi.spyOn(loader, "getLabel").mockImplementation((name: string) => {
      return labels[name] ?? null;
    });

    // Reset our labels map before each test
    for (const k of Object.keys(labels)) delete labels[k];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("startNewGame seeds define vars and stops at first blocking step (say)", () => {
    // Arrange: start label has a single blocking 'say' step
    labels["start"] = [
      { type: "say", who: "k", text: "Welcome to the test game" },
    ];

    const initial = createInitialState();

    // Act
    const state = startNewGame(initial);

    // Assert basic play state
    expect(state.phase).toBe("playing");
    expect(state.currentLabel).toBe("start");

    // Dialogue should be set from the first 'say' step (blocking)
    expect(state.waitingForInput).toBe(true);
    expect(state.dialogue).toBeTruthy();
    // voice/who/text shape asserted
    expect((state.dialogue as any).text).toBe("Welcome to the test game");
    // Engine resolves speaker abbreviations via define vars (e.g. 'char.k' -> 'Keitaro')
    expect((state.dialogue as any).who).toBe("Keitaro");

    // Define vars should be injected into the VarStore define layer
    // VarStore exposes defineVars() to read them back
    // @ts-expect-error - test is only concerned with runtime shape
    const defines = (state.vars as any).defineVars?.();
    expect(defines).toBeDefined();
    expect(defines["char.k"]).toBe("Keitaro");
    expect(defines["image.bg"]).toBe("BGs/default.jpg");
  });

  it("presents a menu and handles choosing an option (inlines option steps)", () => {
    // Arrange:
    // start -> menu with two options whose steps are simple 'say' (blocking)
    labels["start"] = [
      {
        type: "menu",
        options: [
          {
            text: "Option A",
            condition: null,
            steps: [{ type: "say", who: null, text: "You chose A" }],
          },
          {
            text: "Option B",
            condition: null,
            steps: [{ type: "say", who: null, text: "You chose B" }],
          },
        ],
      },
    ];

    const initial = createInitialState();
    const stateAtMenu = startNewGame(initial);

    // Menu should be presented (choices are exposed via `choices`; waitingForInput is not used for menu)
    expect(stateAtMenu.waitingForInput).toBe(false);
    expect(stateAtMenu.choices).toBeTruthy();
    expect(stateAtMenu.choices!.length).toBe(2);
    expect(stateAtMenu.choices![0].text).toBe("Option A");

    // Act: choose option 0
    const afterChoose = advance(stateAtMenu, { kind: "choose", index: 0 });

    // After choosing, the engine should inline the option steps and run until blocked.
    // The first (and only) step is a 'say' so dialogue should be set to the option text.
    expect(afterChoose.choices).toBeNull();
    expect(afterChoose.waitingForInput).toBe(true);
    expect(afterChoose.dialogue).toBeTruthy();
    expect((afterChoose.dialogue as any).text).toBe("You chose A");
  });

  it("clicking to advance past a say clears dialogue and resumes execution", () => {
    // Arrange: reuse the menu->option flow to reach a dialogue.
    labels["start"] = [
      {
        type: "menu",
        options: [
          {
            text: "Pick",
            condition: null,
            steps: [{ type: "say", who: null, text: "Picked" }],
          },
        ],
      },
    ];

    const initial = createInitialState();
    const atMenu = startNewGame(initial);
    const afterChoose = advance(atMenu, { kind: "choose", index: 0 });

    // Sanity: we are blocked on the say
    expect(afterChoose.waitingForInput).toBe(true);
    expect((afterChoose.dialogue as any).text).toBe("Picked");

    // Act: simulate player click to advance the say
    const afterClick = advance(afterChoose, { kind: "click" });

    // Expect dialogue consumed and no longer waiting on input.
    expect(afterClick.waitingForInput).toBe(false);
    expect(afterClick.dialogue).toBeNull();
    // Also choices should still be null (we already consumed the menu)
    expect(afterClick.choices).toBeNull();
  });
});
