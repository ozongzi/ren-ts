// ── rrs runtime parser ────────────────────────────────────────────────────────
//
// Public API used by the loader to compile .rrs source text directly into
// the engine's ScriptFile format, bypassing the offline JSON compilation step.

import { tokenize } from "./lexer";
import { parse } from "./parser";
import { compile } from "./codegen";
import type { ScriptFile } from "../types";

// ─── Pre-processor ────────────────────────────────────────────────────────────

/**
 * Scan a .rrs source string and recover any dialogue lines that the converter
 * could not handle at conversion time.
 *
 * The converter emits lines like:
 *   // UNHANDLED: k "Hello, world!"
 *
 * when it encounters a dialogue line whose speaker abbreviation was not in its
 * charMap.  Since rpy2rrs now correctly handles the `$abbr = Character(...)`
 * form used by this game and generates `define char.ABBR = "Name";` at the
 * top of every .rrs file, these UNHANDLED lines should no longer appear for
 * known characters.  This function acts as a safety net for any stragglers.
 *
 * Strategy (two passes):
 *   1. Scan the file for `define char.ABBR = "Name";` lines emitted by the
 *      converter — these are the canonical source of truth for speaker names.
 *   2. Replace any remaining `// UNHANDLED: abbr "text"` comments whose abbr
 *      appears in that map with proper `speak "Name" "text";` statements.
 *      Everything else is left as a comment.
 *
 * Rules for display names:
 *   • "" (empty string) → narration (no speaker nameplate shown)
 *   • "???" → mysterious / inner-monologue
 *   • Anything else → shown verbatim in the nameplate
 */
function preprocessUnhandledDialogue(src: string): string {
  // ── Pass 1: collect character definitions from the .rrs file itself ───────
  // The converter emits these at the top of every generated file:
  //   define char.k   = "Keitaro";
  //   define char.mys = "???";
  //   define char.emp = "";
  const charDefRe =
    /^define\s+char\.([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"([^"]*)"\s*;/gm;

  const localMap = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = charDefRe.exec(src)) !== null) {
    localMap.set(m[1], m[2]);
  }

  // If the file has no define char.* lines at all there is nothing we can do —
  // leave everything as-is so the parser sees the raw comments (harmless).
  if (localMap.size === 0) return src;

  // ── Pass 2: replace UNHANDLED dialogue comments ───────────────────────────
  // Pattern:  <indent> // UNHANDLED: <abbr> "<text>"
  //
  // We require the line to end right after the closing quote so we don't
  // accidentally match multi-token Ren'Py screen/UI lines like:
  //   // UNHANDLED: text "label" style "column2"
  const unhandledRe =
    /^([ \t]*)\/\/\s*UNHANDLED:\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+"((?:[^"\\]|\\.)*)"[ \t]*$/gm;

  return src.replace(
    unhandledRe,
    (_match: string, indent: string, abbr: string, text: string) => {
      if (!localMap.has(abbr)) {
        // Unknown abbreviation — leave as a comment.
        return _match;
      }

      const displayName = localMap.get(abbr)!;

      // Escape any double-quotes inside the display name (rare).
      const safeName = displayName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

      return `${indent}speak "${safeName}" "${text}";`;
    },
  );
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Parse and compile a .rrs source string into the engine's ScriptFile
 * format (same structure that the old JSON files used to contain).
 *
 * @param src       Raw text content of the .rrs file
 * @param filename  Source filename used for error messages and the `source` field
 * @returns         A ScriptFile whose `labels` map is ready for the label registry
 */
export function parseScript(src: string, filename: string): ScriptFile {
  const processed = preprocessUnhandledDialogue(src);
  const tokens = tokenize(processed);
  const ast = parse(tokens);
  // compile() returns { source, labels } which is structurally identical to ScriptFile
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return compile(ast, filename) as any as ScriptFile;
}
