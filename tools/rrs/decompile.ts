/// <reference lib="deno.ns" />
// ── decompile.ts ─────────────────────────────────────────────────────────────
// Decompiles engine-format JSON back into .rrs DSL.
//
// Usage:
//   deno run --allow-read --allow-write tools/rrs/decompile.ts <input.json>
//   deno run --allow-read --allow-write tools/rrs/decompile.ts <input.json> -o out.rrs
//   deno run --allow-read --allow-write tools/rrs/decompile.ts <input.json> --dry-run

const INDENT = "  ";

// ── JSON step shapes ──────────────────────────────────────────────────────────

interface Step {
  type: string;
  // allow arbitrary extra fields
  [key: string]: unknown;
}

interface Branch {
  condition: string | null;
  steps: Step[];
}

interface MenuOption {
  text: string;
  condition?: string | null;
  steps: Step[];
}

// ── Entry point ───────────────────────────────────────────────────────────────

function main() {
  const args = Deno.args;
  if (args.length < 1) {
    console.error(
      "Usage: deno run --allow-read --allow-write tools/rrs/decompile.ts " +
        "<input.json> [-o output.rrs] [--dry-run] [--verbose]",
    );
    Deno.exit(1);
  }

  const inputPath = args[0];
  let outputPath: string | null = null;
  const dryRun = args.includes("--dry-run");
  const verbose = args.includes("--verbose");

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "-o" && i + 1 < args.length) {
      outputPath = args[i + 1];
    }
  }

  if (!outputPath && !dryRun) {
    outputPath = inputPath.replace(/\.json$/, "") + ".rrs";
  }

  const jsonText = Deno.readTextFileSync(inputPath);
  const data = JSON.parse(jsonText);

  const output = decompileFile(data, verbose);

  if (dryRun) {
    console.log(output);
  } else if (outputPath) {
    Deno.writeTextFileSync(outputPath, output);
    console.log(`✓ Decompiled → ${outputPath}`);
  }
}

// ── Top-level decompiler ──────────────────────────────────────────────────────

function decompileFile(
  data: { source?: string; labels?: Record<string, Step[]> },
  verbose = false,
): string {
  const lines: string[] = [];

  if (data.source) {
    lines.push(`// Source: ${data.source}`);
    lines.push("");
  }

  if (!data.labels) {
    lines.push("// (no labels found)");
    return lines.join("\n");
  }

  for (const [labelName, steps] of Object.entries(data.labels)) {
    if (verbose)
      console.log(`[decompile] label ${labelName}: ${steps.length} steps`);
    lines.push(`label ${labelName} {`);
    decompileSteps(steps, lines, 1);
    lines.push("}");
    lines.push("");
  }

  return lines.join("\n");
}

// ── Step list processor ───────────────────────────────────────────────────────

function decompileSteps(steps: Step[], lines: string[], depth: number) {
  const ind = INDENT.repeat(depth);
  let i = 0;

  while (i < steps.length) {
    const step = steps[i];
    const next = steps[i + 1] as Step | undefined;
    const afterNext = steps[i + 2] as Step | undefined;

    // ── show (body sprite) ────────────────────────────────────────────────────
    if (step.type === "show" && isBodySprite(step.sprite as string)) {
      const bodyKey = step.sprite as string;
      const bodyAt = step.at as string | undefined;
      const bodyTrans = step.transition as string | undefined;

      // Look ahead: face show for the same character?
      if (
        next &&
        next.type === "show" &&
        isFaceSprite(next.sprite as string) &&
        bodyAndFaceMatch(bodyKey, next.sprite as string)
      ) {
        const faceKey = next.sprite as string;
        const faceExpr = faceExprOf(faceKey);
        const faceAt = next.at as string | undefined;
        const faceTrans = next.transition as string | undefined;

        // Strip Ren'Py transform tags before comparing positions
        const cleanBodyAt = bodyAt
          ? bodyAt.replace(/#.*$/, "").trim()
          : undefined;
        const cleanFaceAt = faceAt
          ? faceAt.replace(/#.*$/, "").trim()
          : undefined;

        // Only combine into `show body::face @ pos | trans` when body and face
        // share the same position and transition.  When they differ, emit the
        // body and face as separate statements so neither position is lost.
        const positionsMatch = cleanBodyAt === cleanFaceAt;
        const transitionsMatch = bodyTrans === faceTrans;

        if (positionsMatch && transitionsMatch) {
          // ── Combined form ──────────────────────────────────────────────────
          // Optionally absorb a trailing `with` transition
          let transition = bodyTrans ?? faceTrans;
          let skip = 2;
          if (!transition && afterNext && afterNext.type === "with") {
            transition = afterNext.transition as string;
            skip = 3;
          }

          const bodySrc = deriveBodySrc(bodyKey);
          const faceSrc = deriveFaceSrc(faceKey);
          const bodyActual = (step.src as string | null) ?? undefined;
          const faceActual = (next.src as string | null) ?? undefined;

          const bodySrcDiffers = bodyActual && bodyActual !== bodySrc;
          const faceSrcDiffers = faceActual && faceActual !== faceSrc;

          let line = `${ind}show ${bodyKey}::${faceExpr}`;
          if (cleanBodyAt) line += ` @ ${cleanBodyAt}`;
          if (transition) line += ` | ${transition}`;

          if (bodySrcDiffers || faceSrcDiffers) {
            lines.push(line + " {");
            if (bodySrcDiffers)
              lines.push(`${ind}${INDENT}src_body: "${bodyActual}";`);
            if (faceSrcDiffers)
              lines.push(`${ind}${INDENT}src_face: "${faceActual}";`);
            lines.push(`${ind}};\n`);
          } else {
            lines.push(line + ";");
          }

          i += skip;
          continue;
        }

        // ── Separate form: body and face have different positions/transitions ──
        // Emit the body show, then fall through to let the face step be
        // processed on the next iteration as a face-only (expr) step.
        {
          // In the separate form, `next` is the face step (type "show"), so there
          // is no `with` step to absorb here.  The body is emitted as-is.
          const transition = bodyTrans;
          const skip = 1;

          const derivedSrc = deriveBodySrc(bodyKey);
          const actualSrc = (step.src as string | null) ?? undefined;
          const srcDiffers = actualSrc && actualSrc !== derivedSrc;

          let line = `${ind}show ${bodyKey}`;
          if (cleanBodyAt) line += ` @ ${cleanBodyAt}`;
          if (transition) line += ` | ${transition}`;

          if (srcDiffers || bodyKey.toLowerCase().startsWith("cg_")) {
            lines.push(line + " {");
            if (bodyKey.toLowerCase().startsWith("cg_")) {
              lines.push(`${ind}${INDENT}key: "${bodyKey}";`);
            }
            if (srcDiffers) {
              lines.push(`${ind}${INDENT}src: "${actualSrc}";`);
            }
            lines.push(`${ind}};`);
          } else {
            lines.push(line + ";");
          }

          i += skip;
          continue;
        }
      }

      // Body-only show (possibly absorb `with` transition)
      let transition = bodyTrans;
      let skip = 1;
      if (!transition && next && next.type === "with") {
        transition = next.transition as string;
        skip = 2;
      }

      const derivedSrc = deriveBodySrc(bodyKey);
      const actualSrc = (step.src as string | null) ?? undefined;
      const srcDiffers = actualSrc && actualSrc !== derivedSrc;

      let line = `${ind}show ${bodyKey}`;
      // Strip Ren'Py transform tags from the position (e.g. "p5_2#blush" → "p5_2")
      // since "#" is not a valid DSL identifier character.
      const cleanBodyAt = bodyAt
        ? bodyAt.replace(/#.*$/, "").trim()
        : undefined;
      if (cleanBodyAt) line += ` @ ${cleanBodyAt}`;
      if (transition) line += ` | ${transition}`;

      if (srcDiffers || bodyKey.toLowerCase().startsWith("cg_")) {
        lines.push(line + " {");
        // Emit verbatim key override for special underscored CG/overlay sprites
        // (e.g. "cg_fade", "cg_blur") so codegen doesn't convert them to "cg fade".
        if (bodyKey.toLowerCase().startsWith("cg_")) {
          lines.push(`${ind}${INDENT}key: "${bodyKey}";`);
        }
        if (srcDiffers) {
          lines.push(`${ind}${INDENT}src: "${actualSrc}";`);
        }
        lines.push(`${ind}};`);
      } else {
        lines.push(line + ";");
      }

      i += skip;
      continue;
    }

    // ── show (CG sprite) ──────────────────────────────────────────────────────
    if (step.type === "show" && isCgSprite(step.sprite as string)) {
      const rawKey = step.sprite as string; // e.g. "cg arrival1"
      const dslKey = cgDslKey(rawKey); // e.g. "cg_arrival1"
      const at = step.at as string | undefined;
      const src = (step.src as string | null) ?? undefined;

      // Absorb trailing `with`
      let transition = step.transition as string | undefined;
      let skip = 1;
      if (!transition && next && next.type === "with") {
        transition = next.transition as string;
        skip = 2;
      }

      if (!src) {
        // src is null — the engine step is a no-op show; emit as a comment.
        lines.push(
          `${ind}// TODO: show ${dslKey} has no src (original key: "${rawKey}")`,
        );
        i += skip;
        continue;
      }

      let line = `${ind}show ${dslKey}`;
      if (at) line += ` @ ${at}`;
      if (transition) line += ` | ${transition}`;

      lines.push(line + " {");
      lines.push(`${ind}${INDENT}src: "${src}";`);
      lines.push(`${ind}};`);

      i += skip;
      continue;
    }

    // ── show (face-only — expression change) ──────────────────────────────────
    if (step.type === "show" && isFaceSprite(step.sprite as string)) {
      const faceKey = step.sprite as string;
      const charPart = faceKey.split(" ")[0]; // e.g. "keitaro" or "keitaro2"
      const expr = faceExprOf(faceKey); // e.g. "normal1"
      const at = step.at as string | undefined;

      // Absorb trailing `with`
      let transition = step.transition as string | undefined;
      let skip = 1;
      if (!transition && next && next.type === "with") {
        transition = next.transition as string;
        skip = 2;
      }

      // Emit `@ pos` when the face step carries an explicit position so the
      // compiler can round-trip the `at` field even when the body sprite was
      // shown in a previous label and is therefore absent from sprite state.
      let line = `${ind}expr ${charPart}::${expr}`;
      const cleanFaceAt = at ? at.replace(/#.*$/, "").trim() : undefined;
      if (cleanFaceAt) line += ` @ ${cleanFaceAt}`;
      if (transition) line += ` | ${transition}`;
      lines.push(line + ";");

      i += skip;
      continue;
    }

    // ── show (other / simple sprite — not body, face, or CG) ─────────────
    // Handles sprites like "logo" that have no underscore and no space in
    // their key.  The codegen will preserve the sprite key verbatim via the
    // normal Case-2 path as long as an explicit src is provided.
    // Guard: skip keys containing spaces — the parser's `show` statement
    // reads a single Ident for the body key and would choke on spaces.
    if (step.type === "show" && !(step.sprite as string).includes(" ")) {
      const rawSprite = step.sprite as string;
      const showAt = step.at as string | undefined;
      const showSrc = (step.src as string | null) ?? undefined;

      // Absorb trailing `with`
      let transition = step.transition as string | undefined;
      let skip = 1;
      if (!transition && next && next.type === "with") {
        transition = next.transition as string;
        skip = 2;
      }

      let line = `${ind}show ${rawSprite}`;
      const cleanAt = showAt ? showAt.replace(/#.*$/, "").trim() : undefined;
      if (cleanAt) line += ` @ ${cleanAt}`;
      if (transition) line += ` | ${transition}`;

      if (showSrc) {
        lines.push(line + " {");
        lines.push(`${ind}${INDENT}src: "${showSrc}";`);
        lines.push(`${ind}};`);
      } else {
        lines.push(line + ";");
      }

      i += skip;
      continue;
    }

    // ── with (standalone transition, not absorbed above) ─────────────────
    if (step.type === "with") {
      lines.push(`${ind}with ${step.transition as string};`);
      i++;
      continue;
    }

    // ── hide ──────────────────────────────────────────────────────────────────
    if (step.type === "hide") {
      const sprite = step.sprite as string;
      lines.push(`${ind}${decompileHide(sprite)}`);
      i++;
      continue;
    }

    // ── say ───────────────────────────────────────────────────────────────────
    if (step.type === "say") {
      // Try to group consecutive say steps from the same speaker into a
      // multi-line speak block (only when no other step type interrupts).
      const who = step.who as string;
      const speakLines: { text: string; voice?: string }[] = [];

      let j = i;
      while (
        j < steps.length &&
        steps[j].type === "say" &&
        (steps[j].who as string) === who
      ) {
        speakLines.push({
          text: steps[j].text as string,
          voice: steps[j].voice as string | undefined,
        });
        j++;
      }

      // Quote multi-word or special-character speaker names (e.g. "Old Lady", "Keitaro & Hiro")
      const whoToken = needsQuoting(who) ? `"${escapeString(who)}"` : who;

      if (speakLines.length === 1) {
        // Inline form
        const l = speakLines[0];
        const voicePart = l.voice ? ` | "${l.voice}"` : "";
        lines.push(
          `${ind}speak ${whoToken} "${escapeString(l.text)}"${voicePart};`,
        );
      } else {
        // Block form
        lines.push(`${ind}speak ${whoToken} {`);
        for (const l of speakLines) {
          const voicePart = l.voice ? ` | "${l.voice}"` : "";
          lines.push(`${ind}${INDENT}"${escapeString(l.text)}"${voicePart};`);
        }
        lines.push(`${ind}}`);
      }

      i = j;
      continue;
    }

    // ── set (variable assignment) ─────────────────────────────────────────────
    if (step.type === "set") {
      const varName = step.var as string;
      const op = step.op as string;
      const value = step.value;

      // Special case: Ren'Py attribute-access assignment stored as
      //   { var: "preferences", op: ".", value: "afm_enable = false" }
      // Normalize it to a plain dotted assignment:
      //   let preferences.afm_enable = false;
      if (op === ".") {
        const valueStr = String(value).trim();
        lines.push(`${ind}let ${varName}.${valueStr};`);
        i++;
        continue;
      }

      // Emit the value verbatim if it is already a quoted string literal or
      // a bare expression; emit numbers as-is.
      let valueStr: string;
      if (typeof value === "number") {
        valueStr = String(value);
      } else if (typeof value === "string") {
        // Keep it exactly as stored (already a RenPy literal or expression).
        let v = value.trim();
        // Strip trailing semicolons that sometimes appear in JSON values
        // (e.g. value: "0;" → "0") to avoid emitting doubled ;; in DSL.
        v = v.replace(/;+$/, "");
        // Convert single-quoted Ren'Py strings to double-quoted DSL strings
        // so the lexer can handle them (e.g. "'save'" → '"save"').
        if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
          v = '"' + v.slice(1, -1).replace(/"/g, '\\"') + '"';
        }
        valueStr = v;
      } else if (typeof value === "boolean") {
        valueStr = value ? "True" : "False";
      } else {
        valueStr = JSON.stringify(value);
      }
      // Use bare-assignment syntax understood by the parser:
      //   `let name = …`  for `=`  (reads cleanly)
      //   `name += …`     for compound operators
      if (op === "=") {
        lines.push(`${ind}let ${varName} ${op} ${valueStr};`);
      } else {
        lines.push(`${ind}${varName} ${op} ${valueStr};`);
      }
      i++;
      continue;
    }

    // ── scene ─────────────────────────────────────────────────────────────────
    if (step.type === "scene") {
      const src = step.src as string;
      const transition = step.transition as string | undefined;

      // Absorb trailing `with` if no inline transition
      let trans = transition;
      let skip = 1;
      if (!trans && next && next.type === "with") {
        trans = next.transition as string;
        skip = 2;
      }

      const transPart = trans ? ` | ${trans}` : "";
      // Hex colours get no quotes; everything else does
      const srcPart = src.startsWith("#") ? src : `"${src}"`;
      lines.push(`${ind}scene ${srcPart}${transPart};`);

      i += skip;
      continue;
    }

    // ── music ─────────────────────────────────────────────────────────────────
    if (step.type === "music") {
      lines.push(`${ind}${decompileAudio("music", step)}`);
      i++;
      continue;
    }

    // ── sound ─────────────────────────────────────────────────────────────────
    if (step.type === "sound") {
      lines.push(`${ind}${decompileAudio("sound", step)}`);
      i++;
      continue;
    }

    // ── pause ─────────────────────────────────────────────────────────────────
    if (step.type === "pause") {
      const dur = step.duration as number;
      lines.push(`${ind}wait(${dur});`);
      i++;
      continue;
    }

    // ── if ────────────────────────────────────────────────────────────────────
    if (step.type === "if") {
      const branches = step.branches as Branch[];
      branches.forEach((branch, idx) => {
        if (idx === 0) {
          // First branch: `if condition {`
          lines.push(`${ind}if ${branch.condition} {`);
        } else if (branch.condition !== null) {
          // Subsequent branch with condition: `} else if condition {`
          lines.push(`${ind}} else if ${branch.condition} {`);
        } else {
          // Final bare else: `} else {`
          lines.push(`${ind}} else {`);
        }

        decompileSteps(branch.steps, lines, depth + 1);
      });
      // Close the last branch
      lines.push(`${ind}}`);
      i++;
      continue;
    }

    // ── menu ──────────────────────────────────────────────────────────────────
    if (step.type === "menu") {
      const options = step.options as MenuOption[];
      lines.push(`${ind}menu {`);
      for (const opt of options) {
        // Parser syntax:  "text" => { body }
        // Conditions are not supported by the parser — emit as a comment if present.
        if (opt.condition) {
          lines.push(`${ind}${INDENT}// condition: ${opt.condition}`);
        }
        lines.push(`${ind}${INDENT}"${escapeString(opt.text)}" => {`);
        decompileSteps(opt.steps, lines, depth + 2);
        lines.push(`${ind}${INDENT}}`);
      }
      lines.push(`${ind}}`);
      i++;
      continue;
    }

    // ── return ────────────────────────────────────────────────────────────────
    if (step.type === "return") {
      lines.push(`${ind}return;`);
      i++;
      continue;
    }

    // ── jump / call ───────────────────────────────────────────────────────────
    if (step.type === "jump") {
      lines.push(`${ind}jump ${step.target as string};`);
      i++;
      continue;
    }

    if (step.type === "call") {
      lines.push(`${ind}call ${step.target as string};`);
      i++;
      continue;
    }

    // ── unknown / fallback ────────────────────────────────────────────────────
    lines.push(
      `${ind}// TODO: unknown step type "${step.type}": ${JSON.stringify(step)}`,
    );
    i++;
  }
}

// ── Audio helper ──────────────────────────────────────────────────────────────

// Parser syntax:
//   music::play("path") ;
//   music::play("path") | fadeout(2.0) ;
//   music::stop() ;
//   music::stop() | fadeout(2.0) ;
//   sound::play("path") ;
//   sound::stop() ;

function decompileAudio(keyword: "music" | "sound", step: Step): string {
  const action = step.action as string;
  const src = step.src as string | undefined;
  const fadeout = step.fadeout as number | undefined;
  const fadein = step.fadein as number | undefined;

  let line = `${keyword}::${action}(`;
  if (src) line += `"${src}"`;
  line += ")";
  if (fadeout !== undefined) line += ` | fadeout(${fadeout})`;
  if (fadein !== undefined) line += ` | fadein(${fadein})`;
  line += ";";
  return line;
}

// ── Hide helper ───────────────────────────────────────────────────────────────

function decompileHide(sprite: string): string {
  if (isCgSprite(sprite)) {
    return `hide ${cgDslKey(sprite)};`;
  }
  if (isFaceSprite(sprite)) {
    const charPart = sprite.split(" ")[0];
    const expr = faceExprOf(sprite);
    return `hide ${charPart}::${expr};`;
  }
  // Body-with-baked-position (e.g. "keitaro2_camp at p5_4"): sprite key has a
  // space but is not a face sprite.  Emit as a quoted string so the parser uses
  // it verbatim and the codegen does not mangle it.
  if (sprite.includes(" ")) {
    return `hide "${sprite}";`;
  }
  // Plain body sprite (or special underscored key like "cg_fade")
  // Emit as quoted for cg_ prefixed sprites so the codegen key override works.
  if (sprite.toLowerCase().startsWith("cg_")) {
    return `hide "${sprite}";`;
  }
  return `hide ${sprite};`;
}

// ── Sprite classification helpers ─────────────────────────────────────────────

/**
 * Returns true for face keys like "keitaro normal1", "hiro2 compassion2",
 * "hina sick normal1", "yoshinoria surprised1 sepia".
 *
 * Returns false for body-with-baked-position sprites like "keitaro2_camp at p5_4"
 * (where the first word before the space contains an underscore — those are
 * body sprites whose position was baked into the key by the JSON converter).
 */
function isFaceSprite(key: string): boolean {
  if (!key.includes(" ") || key.startsWith("cg ")) return false;
  const charPart = key.split(" ")[0];
  // Body keys always contain an underscore (e.g. "keitaro2_camp").
  // Face character parts never do (e.g. "keitaro2", "hina").
  return !charPart.includes("_");
}

/** Returns true for body keys like "keitaro_casual", "hiro2_camp" */
function isBodySprite(key: string): boolean {
  return key.includes("_") && !key.includes(" ");
}

/** Returns true for CG keys like "cg arrival1" */
function isCgSprite(key: string): boolean {
  return key.startsWith("cg ");
}

// ── Sprite key helpers ────────────────────────────────────────────────────────

/**
 * Extract the face expression from a face sprite key.
 *   "keitaro normal1"  → "normal1"
 *   "hiro2 compassion2" → "compassion2"
 */
function faceExprOf(faceKey: string): string {
  const spaceIdx = faceKey.indexOf(" ");
  return spaceIdx >= 0 ? faceKey.slice(spaceIdx + 1) : faceKey;
}

/**
 * Convert a JSON CG sprite key to a DSL key.
 *   "cg arrival1"   → "cg_arrival1"
 *   "cg hiro2"      → "cg_hiro2"
 *   "cg grouphoto1:" → "cg_grouphoto1"  (colon stripped)
 */
function cgDslKey(rawKey: string): string {
  // Strip the "cg " prefix, replace spaces with underscores, then remove any
  // characters that are not valid in a DSL identifier (letters, digits, _).
  return (
    "cg_" +
    rawKey
      .slice(3)
      .replace(/\s+/g, "_")
      .replace(/[^a-zA-Z0-9_]/g, "")
  );
}

/**
 * Get the character's charVer from a body key.
 *   "keitaro_casual"  → "keitaro1"
 *   "keitaro2_casual" → "keitaro2"
 *   "hiro_camp"       → "hiro1"
 *   "hiro2_camp"      → "hiro2"
 */
function bodyCharVer(bodyKey: string): string {
  const underIdx = bodyKey.indexOf("_");
  const charPart = underIdx >= 0 ? bodyKey.slice(0, underIdx) : bodyKey;
  if (/\d+$/.test(charPart)) return charPart; // already has digit
  return charPart + "1";
}

/**
 * Get the character's charVer from a face key.
 *   "keitaro normal1"   → "keitaro1"
 *   "keitaro2 confused1" → "keitaro2"
 *   "hiro laugh1"        → "hiro1"
 *   "hiro2 compassion2"  → "hiro2"
 */
function faceCharVer(faceKey: string): string {
  const spaceIdx = faceKey.indexOf(" ");
  const charPart = spaceIdx >= 0 ? faceKey.slice(0, spaceIdx) : faceKey;
  if (/\d+$/.test(charPart)) return charPart;
  return charPart + "1";
}

/**
 * Check whether a body key and a face key belong to the same character version.
 */
function bodyAndFaceMatch(bodyKey: string, faceKey: string): boolean {
  return bodyCharVer(bodyKey) === faceCharVer(faceKey);
}

// ── Src derivation helpers ────────────────────────────────────────────────────

/**
 * Derive the canonical body src path from a body key.
 *   "keitaro_casual"        → "Sprites/Body/keitaro1_b_casual.png"
 *   "keitaro2_camp"         → "Sprites/Body/keitaro2_b_camp.png"
 *   "keitaro_camp_camera"   → "Sprites/Body/keitaro1_b_camp_camera.png"
 */
function deriveBodySrc(bodyKey: string): string {
  const underIdx = bodyKey.indexOf("_");
  if (underIdx < 0) return "";
  const outfit = bodyKey.slice(underIdx + 1);
  const charVer = bodyCharVer(bodyKey);
  return `Sprites/Body/${charVer}_b_${outfit}.png`;
}

/**
 * Derive the canonical face src path from a face key.
 *   "keitaro normal1"    → "Sprites/Faces/keitaro1_f_normal1.png"
 *   "keitaro2 confused1" → "Sprites/Faces/keitaro2_f_confused1.png"
 */
function deriveFaceSrc(faceKey: string): string {
  const spaceIdx = faceKey.indexOf(" ");
  if (spaceIdx < 0) return "";
  // Use underscores in the file path for multi-word face expressions
  // so the derived path matches the actual asset path
  // (e.g. "hina sick normal1" → "Sprites/Faces/hina1_f_sick_normal1.png")
  const expr = faceKey.slice(spaceIdx + 1).replace(/ /g, "_");
  const charVer = faceCharVer(faceKey);
  return `Sprites/Faces/${charVer}_f_${expr}.png`;
}

// ── String escaping ───────────────────────────────────────────────────────────

/**
 * Escape double quotes inside a string so it can be safely placed inside
 * a double-quoted DSL string literal.
 */
function escapeString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Returns true if a speaker name needs to be quoted in the DSL.
 * A name can be emitted as a bare identifier only if it consists entirely of
 * letters, digits and underscores (and starts with a letter or underscore).
 * Everything else (spaces, hyphens, &, Chinese characters, etc.) must be quoted.
 */
function needsQuoting(name: string): boolean {
  return !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

// ── Run ───────────────────────────────────────────────────────────────────────

main();
