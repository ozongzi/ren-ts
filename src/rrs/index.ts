// ── rrs runtime parser ────────────────────────────────────────────────────────
//
// Public API used by the loader to compile .rrs source text directly into
// the engine's ScriptFile format, bypassing the offline JSON compilation step.

import { tokenize } from "./lexer";
import { parse } from "./parser";
import { compile } from "./codegen";
import type { ScriptFile } from "../types";

// ─── Character map extraction ─────────────────────────────────────────────────

/**
 * Extract the character abbreviation → display name map from a .rrs source
 * string without fully compiling it.
 *
 * This is used by the loader to read the global character table from
 * script.rrs before loading any other files.  Story files carry no `define`
 * declarations of their own; they rely on this global map to resolve speaker
 * abbreviations like `k` → "Keitaro" at codegen time.
 *
 * The format emitted by rpy2rrs for character definitions is:
 *   define k   = "Keitaro";
 *   define hi  = "Hiro";
 *   define emp = "";          ← empty string = narration (no nameplate)
 *
 * Audio aliases (`define audio.*`) are intentionally skipped here — they are
 * handled inside compile() via the audioMap.
 */
export function extractCharMap(src: string): Map<string, string> {
  const map = new Map<string, string>();
  // Match:  define <ident> = "<value>";
  // Intentionally exclude audio.* keys — those belong to the audio alias map.
  const re =
    /^define\s+(?!audio\.)([a-zA-Z_][a-zA-Z0-9_.]*)\s*=\s*"([^"]*)"\s*;/gm;
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
 * @param src           Raw text content of the .rrs file
 * @param filename      Source filename used for error messages and the `source` field
 * @param globalCharMap Optional character map extracted from script.rrs.
 *                      Story files have no `define` declarations; passing the
 *                      global map here lets the codegen resolve abbreviations
 *                      like `speak k "text"` → speaker "Keitaro".
 * @returns             A ScriptFile whose `labels` map is ready for the label registry
 */
export function parseScript(
  src: string,
  filename: string,
  globalCharMap?: Map<string, string>,
): ScriptFile {
  const tokens = tokenize(src);
  const ast = parse(tokens);
  // compile() returns { source, labels } which is structurally identical to ScriptFile
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return compile(ast, filename, globalCharMap) as any as ScriptFile;
}
