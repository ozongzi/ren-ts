// ── rrs runtime parser ────────────────────────────────────────────────────────
//
// Public API used by the loader to compile .rrs source text directly into
// the module's JsonFile format.
//
// All image / character / audio resolution is deferred to runtime.
// Top-level defines are collected into a flat Record<string, unknown> and
// returned as part of the JsonFile.defines — the loader converts the JsonFile
// into the engine's ScriptFile representation when integrating with the app.

import { tokenize } from "./lexer.ts";
import { parse } from "./parser.ts";
import { compile } from "./codegen.ts";
import type { JsonFile } from "./ast.ts";

/**
 * Parse and compile a .rrs source string into the module's JsonFile format.
 *
 * @param src       Raw text content of the .rrs file
 * @param filename  Source filename used for error messages and the `source` field
 * @returns         A JsonFile with `defines` (flat key→value dict of all
 *                  top-level declarations) and `labels` (engine-ready step arrays)
 */
export function parseScript(src: string, filename: string): JsonFile {
  const tokens = tokenize(src);
  const ast = parse(tokens);
  // compile() returns { source, defines, labels } — structurally identical to JsonFile
   
  return compile(ast, filename) as JsonFile;
}
