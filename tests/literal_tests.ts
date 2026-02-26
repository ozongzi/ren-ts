/**
 * literal_tests.ts
 *
 * Tests for literal parsing semantics across the pipeline:
 *   - parser (produces DefineDecl with token kind + raw)
 *   - codegen.collectDefines (converts token -> typed runtime define)
 *   - evaluate.parseValue / applySetStep (parses RHS of set steps)
 *
 * Goals:
 *   - Quoted string literals (e.g. `"true"`) remain strings.
 *   - Bare identifiers `True` / `true` -> boolean true.
 *   - Bare identifiers `False` / `false` -> boolean false.
 *   - Bare identifier `None` / `none` -> null.
 *   - Numeric tokens become numbers.
 *   - Hex colors are preserved as strings (e.g. `#ff00ff`).
 *
 * Also includes a short TODO plan (refactor plan) as a comment at the top:
 *
 * TODO (refactor plan summary)
 * - Create shared literal util `src/rrs/literal.ts` that exports:
 *     tokenRawToValue(kind, raw) -> unknown
 *     rawStringToValue(raw) -> unknown
 * - Keep parser emitting { kind, raw } for top-level defines (lexer-level info preserved).
 * - Have codegen.collectDefines call tokenRawToValue for consistent semantics.
 * - Have evaluate.parseValue use rawStringToValue for runtime set RHS parsing (preserving quoted vs unquoted semantics).
 * - Add unit tests (this file) that cover:
 *     -> defines: quoted string, bare True/true, bare False/false, None, numbers, hex color
 *     -> set steps via applySetStep: ensure quoted RHS -> string, unquoted True -> boolean, numeric RHS -> number
 *
 * Execution:
 * - This test file is a plain node/ts-node friendly script. It uses `assert`.
 * - Run with ts-node (or build + run the compiled JS) from project root:
 *     npx ts-node tests/literal_tests.ts
 *
 * Notes:
 * - The repository's parser currently emits define value tokens as `{ kind, raw }`.
 * - collectDefines() is expected to convert that into typed runtime defines.
 */
