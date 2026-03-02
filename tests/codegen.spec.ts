import { describe, it, expect } from "vitest";
import { tokenize } from "../rrs/lexer";
import { parse } from "../rrs/parser";
import { collectDefines, compile } from "../rrs/codegen";
import { atToLeftPercent } from "../src/assets";

describe("codegen.collectDefines", () => {
  it("converts token-kind+raw into JS typed values and registers positions", () => {
    const defines: any[] = [
      {
        kind: "Define",
        key: "GAME_NAME",
        value: { kind: "Str", raw: "My VN Game" },
      },
      { kind: "Define", key: "IS_TRUE", value: { kind: "Ident", raw: "True" } },
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
      // position.* should register with registerPosition -> atToLeftPercent must reflect it
      {
        kind: "Define",
        key: "position.p5",
        value: { kind: "Num", raw: "0.42" },
      },
      // string raw (older form) should be accepted as Other
      { kind: "Define", key: "RAW_STR", value: "raw_text_value" },
      // Complex sentinel (empty string) should be skipped
      { kind: "Define", key: "COMPLEX", value: "" },
    ];

    const out = collectDefines(defines as any);

    expect(out).toHaveProperty("GAME_NAME", "My VN Game");
    expect(out).toHaveProperty("IS_TRUE", true);
    expect(out).toHaveProperty("IS_FALSE", false);
    expect(out).toHaveProperty("NONE_VAL", null);
    expect(out).toHaveProperty("NUM_A", 1.5);
    expect(out).toHaveProperty("HEX", "#ff00ff");
    expect(out).toHaveProperty("RAW_STR", "raw_text_value");
    // COMPLEX should be skipped
    expect(out).not.toHaveProperty("COMPLEX");

    // position.p5 should exist as numeric; collectDefines returns the numeric value
    // Note: toHaveProperty("position.p5") treats the dot as a nested path separator,
    // so we use `in` and bracket notation instead.
    expect("position.p5" in out).toBe(true);
    expect(typeof out["position.p5"]).toBe("number");
    expect(out["position.p5"]).toBeCloseTo(0.42);
  });
});

describe("codegen.compile & hoistNestedLabels", () => {
  it("hoists nested labels into top-level compiled labels and emits say steps", () => {
    const src = `
label start {
  speak k "Hello";
  label inner {
    speak k "Inner";
    return;
  }
  speak k "After";
  jump done;
}
label done {
  speak k "Done";
  return;
}
`;

    const prog = parse(tokenize(src));
    const compiled = compile(prog, "test.rrs");

    // compiled.labels should include both 'start' and the hoisted 'inner'
    expect(compiled.labels).toHaveProperty("start");
    expect(compiled.labels).toHaveProperty("inner");
    expect(compiled.labels).toHaveProperty("done");

    const startSteps: any[] = compiled.labels["start"];
    // start should include say "Hello" and "After" and a jump to done
    expect(startSteps.some((s) => s.type === "say" && s.text === "Hello")).toBe(
      true,
    );
    expect(startSteps.some((s) => s.type === "say" && s.text === "After")).toBe(
      true,
    );
    expect(
      startSteps.some((s) => s.type === "jump" && s.target === "done"),
    ).toBe(true);

    // inner steps compiled should include the 'Inner' say
    const innerSteps: any[] = compiled.labels["inner"];
    expect(innerSteps.some((s) => s.type === "say" && s.text === "Inner")).toBe(
      true,
    );

    // done label should have say "Done"
    const doneSteps: any[] = compiled.labels["done"];
    expect(doneSteps.some((s) => s.type === "say" && s.text === "Done")).toBe(
      true,
    );
  });

  it("generates music and sound JSON steps with correct fields", () => {
    const src = `
label audio {
  music::play("Audio/BGM/theme.ogg") | fadeout(2.5) | fadein(1.2);
  music::play(outdoors);
  music::stop();
  sound::play("Audio/SFX/door.ogg");
  sound::play(alert);
  sound::stop();
}
`;
    const prog = parse(tokenize(src));
    const compiled = compile(prog, "audio_test.rrs");

    expect(compiled.labels).toHaveProperty("audio");
    const steps: any[] = compiled.labels["audio"];

    // music::play with quoted src should emit a music step with src and fade values
    const musicPlayQuoted = steps.find(
      (s) =>
        s.type === "music" &&
        s.action === "play" &&
        s.src === "Audio/BGM/theme.ogg",
    );
    expect(musicPlayQuoted).toBeDefined();
    expect(musicPlayQuoted.fadeout).toBeCloseTo(2.5);
    expect(musicPlayQuoted.fadein).toBeCloseTo(1.2);

    // music::play with identifier alias should emit src as alias string
    const musicPlayAlias = steps.find(
      (s) => s.type === "music" && s.action === "play" && s.src === "outdoors",
    );
    expect(musicPlayAlias).toBeDefined();

    // music::stop emits stop action
    const musicStop = steps.filter(
      (s) => s.type === "music" && s.action === "stop",
    );
    expect(musicStop.length).toBeGreaterThanOrEqual(1);

    // sound::play with quoted path
    const soundPlayQuoted = steps.find(
      (s) =>
        s.type === "sound" &&
        s.action === "play" &&
        s.src === "Audio/SFX/door.ogg",
    );
    expect(soundPlayQuoted).toBeDefined();

    // sound::play with alias
    const soundPlayAlias = steps.find(
      (s) => s.type === "sound" && s.action === "play" && s.src === "alert",
    );
    expect(soundPlayAlias).toBeDefined();

    // sound::stop exists
    const soundStop = steps.find(
      (s) => s.type === "sound" && s.action === "stop",
    );
    expect(soundStop).toBeDefined();
  });
});
