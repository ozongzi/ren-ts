import { describe, it, expect } from "vitest";
import { tokenize } from "../rrs/lexer";
import { parse } from "../rrs/parser";

describe("rrs parser - focused branch tests", () => {
  it("parses top-level defines and skips complex/unparseable defines", () => {
    const src = `
image.bg_main = "BGs/main.jpg";
char.h = "Hiro";
NUM_VAL = 2.5;
FLAG = True;
HEX_COL = #abcdef;
flash = Fade(.25, 0, .75, color="#fff");
`;
    const prog = parse(tokenize(src));
    // Expect defines present for simple values
    const byKey: Record<string, any> = {};
    for (const d of prog.defines) {
      byKey[d.key] = d.value;
    }

    expect(byKey["image.bg_main"]).toBeDefined();
    // String define: parser stores Str token.raw
    expect((byKey["image.bg_main"] as any).kind).toBe("Str");
    expect((byKey["image.bg_main"] as any).raw).toBe("BGs/main.jpg");

    expect((byKey["char.h"] as any).raw).toBe("Hiro");
    expect((byKey["NUM_VAL"] as any).kind).toBe("Num");
    expect((byKey["NUM_VAL"] as any).raw).toBe("2.5");
    expect((byKey["FLAG"] as any).kind).toBe("Ident");
    expect((byKey["FLAG"] as any).raw).toBe("True");
    expect((byKey["HEX_COL"] as any).kind).toBe("HexColor");
    expect((byKey["HEX_COL"] as any).raw).toBe("#abcdef");

    // Complex define 'flash' is parsed but the parser captures the leading identifier token (Fade)
    // The parser returns a DefineDecl for 'flash' whose value is an Ident token with raw 'Fade'
    expect(byKey).toHaveProperty("flash");
    expect((byKey["flash"] as any).kind).toBe("Ident");
    expect((byKey["flash"] as any).raw).toBe("Fade");
  });

  it("parses scene variants (hex, quoted string, identifier) and filters/transitions", () => {
    const src = `
label scenes {
  scene #000000;
  scene "BGs/park.jpg" | dissolve;
  scene image.bg_day sepia | fade;
}
`;
    const prog = parse(tokenize(src));
    const lbl = prog.labels.find((l) => l.name === "scenes");
    expect(lbl).toBeDefined();
    const body = lbl!.body as any[];

    // Expect three Scene stmts
    const scenes = body.filter((s: any) => s.kind === "Scene");
    expect(scenes.length).toBe(3);

    // Hex colour
    expect(scenes[0].srcIsLiteral).toBe(true);
    expect(scenes[0].src).toBe("#000000");

    // Quoted string with transition
    expect(scenes[1].srcIsLiteral).toBe(true);
    expect(scenes[1].src).toBe("BGs/park.jpg");
    expect(scenes[1].transition).toBe("dissolve");

    // Ident + filter + transition
    expect(scenes[2].srcIsLiteral).toBe(false);
    expect(scenes[2].src).toBe("image.bg_day");
    expect(scenes[2].filter).toBe("sepia");
    expect(scenes[2].transition).toBe("fade");
  });

  it("parses music and sound statements with modifiers and identifiers", () => {
    const src = `
label audio_test {
  music::play("Audio/bgm.ogg") | fadeout(3.0) | fadein(1.0);
  music::stop();
  sound::play(alert);
  sound::stop();
}
`;
    const prog = parse(tokenize(src));
    const lbl = prog.labels.find((l) => l.name === "audio_test");
    expect(lbl).toBeDefined();
    const body = lbl!.body as any[];

    const mus = body.filter((s) => s.kind === "Music");
    expect(mus.length).toBe(2);
    const play = mus[0];
    expect(play.action).toBe("play");
    expect(play.src).toBe("Audio/bgm.ogg");
    expect(play.fadeout).toBeCloseTo(3.0);
    expect(play.fadein).toBeCloseTo(1.0);

    const stop = mus[1];
    expect(stop.action).toBe("stop");

    const snd = body.filter((s) => s.kind === "Sound");
    expect(snd.length).toBe(2);
    expect(snd[0].src).toBe("alert");
    expect(snd[1].action).toBe("stop");
  });

  it("parses show/hide/with statements (position and transition)", () => {
    const src = `
label show_test {
  show hero.normal1 @ center | dissolve;
  show cg.arrival2;
  hide hero;
  with fade;
}
`;
    const prog = parse(tokenize(src));
    const lbl = prog.labels.find((l) => l.name === "show_test");
    expect(lbl).toBeDefined();
    const body = lbl!.body as any[];

    const shows = body.filter((s) => s.kind === "Show");
    expect(shows.length).toBe(2);
    expect(shows[0].key).toBe("hero.normal1");
    expect(shows[0].at).toBe("center");
    expect(shows[0].transition).toBe("dissolve");
    expect(shows[1].key).toBe("cg.arrival2");

    const hide = body.find((s) => s.kind === "Hide");
    expect(hide).toBeDefined();
    expect(hide!.tag).toBe("hero");

    const withStmt = body.find((s) => s.kind === "With");
    expect(withStmt).toBeDefined();
    expect(withStmt!.transition).toBe("fade");
  });

  it("parses speak in block, inline, legacy and voice-ref forms", () => {
    const src = `
label speak_test {
  speak h {
    "Line one" | audio.vo1;
    "Line two";
  }
  speak h "Hello" | audio.vo_hello;
  speak ??? "Anon";
  speak h "voice_file" { "A"; "B"; }  // legacy form: first string is voice, block with lines
}
`;
    const prog = parse(tokenize(src));
    const lbl = prog.labels.find((l) => l.name === "speak_test");
    expect(lbl).toBeDefined();
    const body = lbl!.body as any[];

    // Block form should produce a Speak stmt with two lines, first with voice
    const block = body[0];
    expect(block.kind).toBe("Speak");
    expect(block.who).toBe("h");
    expect(block.lines.length).toBe(2);
    expect(block.lines[0].text).toBe("Line one");
    expect(block.lines[0].voice).toBe("audio.vo1");
    expect(block.lines[1].text).toBe("Line two");
    expect(block.lines[1].voice).toBeUndefined();

    // Inline with voice
    const inline = body.find(
      (s) => s.kind === "Speak" && s.lines.some((l: any) => l.text === "Hello"),
    );
    expect(inline).toBeDefined();
    expect(inline!.lines[0].voice).toBe("audio.vo_hello");

    // speak ??? "Anon"
    const anon = body.find((s) => s.kind === "Speak" && s.who === "???");
    expect(anon).toBeDefined();
    expect(anon!.lines[0].text).toBe("Anon");

    // legacy form: first string treated as voice and block contains texts
    const legacy = body.find(
      (s) => s.kind === "Speak" && s.lines.some((l: any) => l.text === "A"),
    );
    expect(legacy).toBeDefined();
    // The legacy handling stores voice on the lines in that branch; check one of them
    expect(legacy!.lines.length).toBe(2);
    expect(legacy!.lines[0].voice).toBe("voice_file");
  });

  it("parses wait, assignments (with compound ops) and raw assignments", () => {
    const src = `
label set_test {
  wait(1.5);
  counter = 0;
  counter += 2;
  counter -= 1;
  counter *= 3;
  counter /= 2;
  somevar = otherVar;
}
`;
    const prog = parse(tokenize(src));
    const lbl = prog.labels.find((l) => l.name === "set_test");
    expect(lbl).toBeDefined();
    const body = lbl!.body as any[];

    const wait = body.find((s) => s.kind === "Wait");
    expect(wait).toBeDefined();
    expect(wait.duration).toBeCloseTo(1.5);

    const assigns = body.filter((s) => s.kind === "Assign");
    expect(assigns.length).toBeGreaterThanOrEqual(6);
    // Validate one compound op present
    const plus = assigns.find(
      (a: any) => a.name === "counter" && a.op === "+=",
    );
    expect(plus).toBeDefined();
    const ref = assigns.find((a: any) => a.name === "somevar");
    expect(ref.value).toBe("otherVar");
  });

  it("parses if with elif and else branches and nested labels", () => {
    const src = `
label parent {
  if x == 1 {
    speak ??? "A";
  } elif y == 2 {
    speak ??? "B";
  } else {
    speak ??? "C";
  }

  label nested {
    speak ??? "Nested";
  }
}
`;
    const prog = parse(tokenize(src));
    const parent = prog.labels.find((l) => l.name === "parent");
    expect(parent).toBeDefined();
    const body = parent!.body as any[];

    const ifStmt = body.find((s) => s.kind === "If");
    expect(ifStmt).toBeDefined();
    // branches should include three entries
    expect(ifStmt.branches.length).toBe(3);
    expect(ifStmt.branches[0].condition).toBe("x == 1");
    expect(ifStmt.branches[1].condition).toBe("y == 2");
    expect(ifStmt.branches[2].condition).toBeNull();

    // Nested label should appear as a LabelStmt inside parent body
    const nested = body.find((s) => s.kind === "Label" && s.name === "nested");
    expect(nested).toBeDefined();
    expect(nested!.body.some((s: any) => s.kind === "Speak")).toBe(true);
  });

  it("parses menu entries with conditional guards and jumps/calls/return", () => {
    const src = `
label menu_test {
  menu {
    "Choice A" if a == 1 => { jump targetA; }
    "Choice B" => { call sub; }
  }
  jump after_menu;
  call sub;
  return;
}

label sub {
  speak ??? "Sub";
  return;
}

label targetA {
  speak ??? "Target A";
  return;
}

label after_menu {
  speak ??? "After";
  return;
}
`;
    const prog = parse(tokenize(src));
    const menuLabel = prog.labels.find((l) => l.name === "menu_test");
    expect(menuLabel).toBeDefined();
    const body = menuLabel!.body as any[];

    const menu = body.find((s) => s.kind === "Menu");
    expect(menu).toBeDefined();
    expect(menu.choices.length).toBe(2);
    expect(menu.choices[0].text).toBe("Choice A");
    expect(menu.choices[0].condition).toBeDefined();
    // choice body should contain a Jump
    expect(menu.choices[0].body.some((st: any) => st.kind === "Jump")).toBe(
      true,
    );

    // Top-level jump/call/return in menu_test
    expect(
      body.some((s: any) => s.kind === "Jump" && s.target === "after_menu"),
    ).toBe(true);
    expect(body.some((s: any) => s.kind === "Call" && s.target === "sub")).toBe(
      true,
    );
    expect(body.some((s: any) => s.kind === "Return")).toBe(true);

    // Validate sub/targetA/after_menu labels exist in program.labels list
    const labelNames = prog.labels.map((l) => l.name);
    expect(labelNames).toEqual(
      expect.arrayContaining(["sub", "targetA", "after_menu"]),
    );
  });
});
