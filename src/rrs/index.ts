// ── rrs runtime parser ────────────────────────────────────────────────────────
//
// Public API used by the loader to compile .rrs source text directly into
// the engine's ScriptFile format, bypassing the offline JSON compilation step.

import { tokenize } from "../../shared/rrs/lexer.ts";
import { parse } from "../../shared/rrs/parser.ts";
import { compile } from "../../shared/rrs/codegen.ts";
import type { ScriptFile } from "../types";

// ─── Image map extraction ─────────────────────────────────────────────────────

/**
 * Extract the image var-ref → file path map from a .rrs source string without
 * fully compiling it.
 *
 * This is used by the loader to read the global image table from script.rrs
 * before loading any other files.  Story files may not declare all images
 * themselves; they rely on this global map to resolve ident refs like
 * `image.bg.bathroom2_sunset` at codegen time.
 *
 * The format emitted by rpy2rrs for image definitions is:
 *   image.bg.bathroom2_sunset   = "BGs/bathroom2_sunset.jpg";
 *   image.cg.yoshinori1_5       = "CGs/cg_yoshinori_1_5.jpg";
 *   image.sx.hiro10_9           = "CGs/SX/hiro10_9.jpg";
 *   image.misc.montage_bg       = "CGs/montage_bg.jpg";
 */
export function extractImageMap(src: string): Map<string, string> {
  const map = new Map<string, string>();
  // Match:  image.<ns>.<key> = "<value>";
  const re =
    /^(image\.[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"([^"]*)"\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    map.set(m[1], m[2]);
  }
  return map;
}

// ─── Character map extraction ─────────────────────────────────────────────────

/**
 * Extract the character abbreviation → display name map from a .rrs source
 * string without fully compiling it.
 *
 * This is used by the loader to read the global character table from
 * script.rrs before loading any other files.  Story files carry no `char`
 * declarations of their own; they rely on this global map to resolve speaker
 * abbreviations like `k` → "Keitaro" at codegen time.
 *
 * The format emitted by rpy2rrs for character definitions is:
 *   char.k   = "Keitaro";
 *   char.hi  = "Hiro";
 *   char.emp = "";          ← empty string = narration (no nameplate)
 */
export function extractCharMap(src: string): Map<string, string> {
  const map = new Map<string, string>();
  // Match:  char.<abbr> = "<value>";
  const re = /^char\.([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"([^"]*)"\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    map.set(m[1], m[2]);
  }
  return map;
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Parse and compile a .rrs source string into the engine's ScriptFile format.
 *
 * @param src            Raw text content of the .rrs file
 * @param filename       Source filename used for error messages and the `source` field
 * @param globalCharMap  Optional character map extracted from script.rrs.
 *                       Story files have no `char` declarations; passing the
 *                       global map here lets the codegen resolve abbreviations
 *                       like `speak k "text"` → speaker "Keitaro".
 * @param globalImageMap Optional image map extracted from script.rrs.
 *                       Story files may reference image vars like
 *                       `image.bg.foo` that are declared in script.rrs; this
 *                       map lets the codegen resolve those refs to real paths.
 * @returns              A ScriptFile whose `labels` map is ready for the label registry
 */
export function parseScript(
  src: string,
  filename: string,
  globalCharMap?: Map<string, string>,
  globalImageMap?: Map<string, string>,
): ScriptFile {
  const tokens = tokenize(src);
  const ast = parse(tokens);
  // compile() returns { source, labels } which is structurally identical to ScriptFile
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return compile(
    ast,
    filename,
    globalCharMap,
    globalImageMap,
  ) as any as ScriptFile;
}
