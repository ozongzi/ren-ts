import { describe, it, expect } from "vitest";
import {
  detectMinigame,
  renderMinigameStubs,
} from "../rpy-rrs-bridge/minigame-detect";

// ── Synthetic fixtures ────────────────────────────────────────────────────────

describe("detectMinigame — synthetic cases", () => {
  it("returns empty stubs for a plain dialogue file", () => {
    const src = `
label start:
    k "Hello there!"
    jump day2

label day2:
    k "How are you?"
    jump end_scene

label end_scene:
    return
`.trim();
    const result = detectMinigame(src);
    expect(result.stubs).toHaveLength(0);
  });

  it("returns empty stubs when entry label has dialogue", () => {
    const src = `
label mini_entry:
    k "Let's play!"
    call screen mini_screen

label mini_exit_local:
    jump outside_label

screen mini_screen():
    textbutton "Go" action Jump("mini_exit_local")
`.trim();
    const result = detectMinigame(src);
    expect(result.stubs).toHaveLength(0);
  });

  it("returns empty stubs when there are no external exits", () => {
    const src = `
label mini_entry:
    call screen mini_screen

label mini_loop:
    call screen mini_screen

screen mini_screen():
    textbutton "Loop" action Jump("mini_loop")
`.trim();
    const result = detectMinigame(src);
    expect(result.stubs).toHaveLength(0);
  });

  it("warns and skips stub when a candidate has multiple external exits", () => {
    const src = `
label mini_entry:
    call screen choice_screen

label mini_end:
    jump outside_a

screen choice_screen():
    textbutton "A" action Jump("outside_a")
    textbutton "B" action Jump("outside_b")
`.trim();
    const result = detectMinigame(src);
    expect(result.stubs).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/outside_a/);
    expect(result.warnings[0]).toMatch(/outside_b/);
  });

  it("detects a minimal single-screen minigame", () => {
    const src = `
label quiz_start:
    call screen quiz_screen

screen quiz_screen():
    textbutton "Done" action Jump("after_quiz")
`.trim();
    const result = detectMinigame(src);
    expect(result.stubs).toHaveLength(1);
    expect(result.stubs[0].entryLabel).toBe("quiz_start");
    expect(result.stubs[0].exitLabel).toBe("after_quiz");
    expect(result.warnings).toHaveLength(0);
  });

  it("detects a multi-label minigame where exit is reached through internal jumps", () => {
    const src = `
label game_entry:
    call screen game_screen

label game_round:
    call screen game_screen

label game_over:
    jump after_game

screen game_screen():
    textbutton "Next" action Jump("game_round")
    textbutton "Done" action Jump("game_over")
`.trim();
    const result = detectMinigame(src);
    // game_entry is unreferenced; game_round and game_over are referenced
    // by screen jumps and label jumps respectively
    const entry = result.stubs.find((s) => s.entryLabel === "game_entry");
    expect(entry).toBeDefined();
    expect(entry?.exitLabel).toBe("after_game");
  });

  it("generates stubs for multiple independent entry candidates", () => {
    // score_screen in journal.rpy is the canonical example:
    // two unreferenced labels, each independently calls a screen and
    // ultimately reaches the same external exit.
    const src = `
label screen_a:
    call screen sa

label screen_b:
    call screen sb

screen sa():
    textbutton "Go" action Jump("after_game")

screen sb():
    textbutton "Go" action Jump("after_game")
`.trim();
    const result = detectMinigame(src);
    expect(result.stubs).toHaveLength(2);
    const labels = result.stubs.map((s) => s.entryLabel).sort();
    expect(labels).toEqual(["screen_a", "screen_b"]);
    for (const stub of result.stubs) {
      expect(stub.exitLabel).toBe("after_game");
    }
  });

  it("detects exit via bare renpy.jump(variable) inside a label", () => {
    const src = `
label arcade_start:
    call screen arcade_screen

label arcade_done:
    $ renpy.jump(next_scene)

screen arcade_screen():
    textbutton "Finish" action Jump("arcade_done")
`.trim();
    // renpy.jump(next_scene) — bare identifier treated as external exit target
    const result = detectMinigame(src);
    expect(result.stubs).toHaveLength(1);
    expect(result.stubs[0].entryLabel).toBe("arcade_start");
    expect(result.stubs[0].exitLabel).toBe("next_scene");
  });

  it("detects exit via quoted renpy.jump inside a label", () => {
    const src = `
label arcade_start:
    call screen arcade_screen

label arcade_done:
    $ renpy.jump('after_arcade')

screen arcade_screen():
    textbutton "Finish" action Jump("arcade_done")
`.trim();
    const result = detectMinigame(src);
    expect(result.stubs).toHaveLength(1);
    expect(result.stubs[0].entryLabel).toBe("arcade_start");
    expect(result.stubs[0].exitLabel).toBe("after_arcade");
  });

  it("renderMinigameStubs produces valid rrs syntax for a single stub", () => {
    const rrs = renderMinigameStubs(
      [{ entryLabel: "quiz_start", exitLabel: "after_quiz" }],
      "quiz.rrs",
    );
    expect(rrs).toMatch(/label quiz_start \{/);
    expect(rrs).toMatch(/jump after_quiz;/);
    expect(rrs.endsWith("\n")).toBe(true);
  });

  it("renderMinigameStubs produces all labels when given multiple stubs", () => {
    const rrs = renderMinigameStubs(
      [
        { entryLabel: "mini_a", exitLabel: "after_game" },
        { entryLabel: "mini_b", exitLabel: "after_game" },
      ],
      "multi.rrs",
    );
    expect(rrs).toContain("label mini_a {");
    expect(rrs).toContain("label mini_b {");
    expect(rrs).toMatch(/jump after_game;/);
  });

  it("renderMinigameStubs returns only header comment when stubs is empty", () => {
    const rrs = renderMinigameStubs([], "empty.rrs");
    expect(rrs).toContain("// Source: empty.rrs");
    expect(rrs).not.toMatch(/label \w+ \{/);
  });

  // ── journal-style: multiple unreferenced candidates, screen jumps exclude internals ──

  it("picks the deepest-rooted candidate when internal labels are excluded by screen jumps", () => {
    // Mirrors journal.rpy structure:
    //   score_screen is unreferenced by labels but exit_game is targeted by screen `end`
    //   journal_start is the true entry — its BFS covers more nodes
    const src = `
label exit_game:
    $ renpy.jump(label_afterjournal)

label score_screen:
    call screen end

label game_start:
    call screen word_screen

label journal_start:
    call screen tutorial

screen word_screen():
    textbutton "Done" action Jump("exit_game")

screen end():
    textbutton "Exit" action Jump("exit_game")

screen tutorial():
    textbutton "Play" action Jump("game_start")
    textbutton "Skip" action Jump("exit_game")
`.trim();
    const result = detectMinigame(src);
    // journal_start and score_screen are both unreferenced by labels,
    // but exit_game is referenced by screens so it's excluded.
    // Both score_screen and journal_start should get stubs since they
    // each independently reach label_afterjournal.
    const entry = result.stubs.find((s) => s.entryLabel === "journal_start");
    expect(entry).toBeDefined();
    expect(entry?.exitLabel).toBe("label_afterjournal");
  });

  // ── script.rpy-style: game entry file with reserved label names ──────────

  it("does not flag 'splashscreen' label as a minigame even though it calls screen and has no dialogue", () => {
    const src = `
label splashscreen:

    scene cg white with dissolve
    show screen language_choice
    $ renpy.pause(2.0)
    show screen disclaimer
    $ renpy.pause()

    return
`.trim();
    const result = detectMinigame(src);
    expect(result.stubs).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("does not flag 'start' label as a minigame even though it calls screen and jumps externally", () => {
    const src = `
label start:
    $ score_hiro = 0
    $ score_natsumi = 0

    show screen keymap_screen
    $ _game_menu_screen = None

    $ foreplay = True

    jump day1
    return
`.trim();
    const result = detectMinigame(src);
    expect(result.stubs).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("does not flag a file containing both 'splashscreen' and 'start' as a minigame", () => {
    // Mirrors the real script.rpy structure: 26k lines of init definitions
    // followed by two Ren'Py engine-reserved entry labels.
    const src = `
init:
    $ a = Character("Aiden")
    $ k = Character("Keitaro")

label splashscreen:
    show screen language_choice
    $ renpy.pause(2.0)
    show screen disclaimer
    $ renpy.pause()
    return

label start:
    $ score = 0
    show screen keymap_screen
    jump day1
    return
`.trim();
    const result = detectMinigame(src);
    expect(result.stubs).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  // ── foreplay-style: show screen + renpy.jump inside init python block ─────────

  it("detects show screen (not call screen) as callsScreen", () => {
    const src = `
label mini_entry:
    show screen mini_hud
    show screen mini_options
    $ renpy.pause(hard=True)

label mini_done:
    jump after_mini

screen mini_options():
    textbutton "Quit" action Jump("mini_done")
`.trim();
    const result = detectMinigame(src);
    expect(result.stubs).toHaveLength(1);
    expect(result.stubs[0].entryLabel).toBe("mini_entry");
    expect(result.stubs[0].exitLabel).toBe("after_mini");
  });

  it("detects exit via renpy.jump(var) buried inside an init python block", () => {
    // Mirrors foreplay.rpy: the only label is the entry, exit jumps live inside
    // an init python function — outside label context entirely.
    const src = `
init python:

    def finish_game():
        if score >= 60:
            renpy.jump(label_aftergame)

label minigame_entry:
    show screen game_hud
    show screen game_options
    $ renpy.pause(hard=True)

screen game_hud():
    text "Playing..."

screen game_options():
    textbutton "Skip" action Jump(label_aftergame)
`.trim();
    const result = detectMinigame(src);
    expect(result.stubs).toHaveLength(1);
    expect(result.stubs[0].entryLabel).toBe("minigame_entry");
    expect(result.stubs[0].exitLabel).toBe("label_aftergame");
  });
});
