// ── rrs runtime parser ────────────────────────────────────────────────────────
//
// Public API used by the loader to compile .rrs source text directly into
// the engine's ScriptFile format.
//
// All image / character / audio resolution is deferred to runtime.
// Top-level defines are collected into a flat Record<string, string> and
// returned as part of ScriptFile.defines — the loader merges them all into
// a single dict that becomes the initial GameState.vars.

import { tokenize } from "./lexer.ts";
import { parse } from "./parser.ts";
import { compile } from "./codegen.ts";
import type { ScriptFile } from "../types";

/**
 * Parse and compile a .rrs source string into the engine's ScriptFile format.
 *
 * @param src       Raw text content of the .rrs file
 * @param filename  Source filename used for error messages and the `source` field
 * @returns         A ScriptFile with `defines` (flat key→value dict of all
 *                  top-level declarations) and `labels` (engine-ready step arrays)
 */
export function parseScript(src: string, filename: string): ScriptFile {
  const tokens = tokenize(src);
  const ast = parse(tokens);
  // compile() returns { source, defines, labels } — structurally identical to ScriptFile
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return compile(ast, filename) as any as ScriptFile;
}
