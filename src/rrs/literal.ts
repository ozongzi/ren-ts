/**
 * Shared literal parsing utilities
 *
 * Responsibilities:
 *  - Provide a single source of truth for converting lexer/parser token info
 *    (kind + raw) into runtime JS values.
 *  - Provide a convenience for parsing raw RHS strings (as used by evaluate.parseValue)
 *
 * Public API:
 *  - export type TokenKind = "Str" | "Num" | "Ident" | "HexColor" | "Other"
 *  - export function tokenRawToValue(kind: TokenKind, raw: string): unknown
 *      -> Used by codegen.collectDefines which receives parser token-kind + raw.
 *  - export function rawStringToValue(raw: string): unknown
 *      -> Used by evaluate.parseValue: it will strip/recognise quoted strings
 *         then call tokenRawToValue (or perform equivalent heuristics).
 *
 * Notes:
 *  - Behavior mirrors the existing heuristics in codegen.collectDefines and
 *    evaluate.parseValue: quoted strings remain strings, bare True/False/None
 *    map to true/false/null, numeric tokens convert to numbers, hex colors
 *    preserved as strings.
 *  - This module intentionally keeps the heuristics compact and consistent so
 *    both codegen and evaluate share the same logic.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type TokenKind = "Str" | "Num" | "Ident" | "HexColor" | "Other";

/**
 * Unescape an inner-quoted string produced by the lexer/parser.
 * Mirrors the minimal unescaping used elsewhere: unescape escaped quotes and
 * backslashes. We intentionally do NOT interpret other escape sequences
 * (like \n) because the original code did not.
 */
function unescapeQuotedString(s: string): string {
  // Replace escaped backslash first to avoid double-unescaping.
  return s.replace(/\\\\/g, "\\").replace(/\\"/g, '"').replace(/\\'/g, "'");
}

/**
 * Convert a token-kind + raw string (from the parser/lexer) into a JS value.
 *
 * Semantics:
 *  - kind === "Str"      -> return raw as-is (parser has already stripped quotes)
 *  - kind === "HexColor" -> return raw as string (preserve)
 *  - kind === "Num"      -> attempt numeric conversion (Number(raw)) and return number if valid, otherwise fall back to string
 *  - kind === "Ident" | "Other" -> try boolean/null identifiers, numeric parse, else return raw string
 */
export function tokenRawToValue(kind: TokenKind, raw: string): unknown {
  // Defensive: ensure raw is a string
  raw = String(raw ?? "");

  if (kind === "Str") {
    // Parser promises that Str tokens have already had quotes removed.
    return raw;
  }

  if (kind === "HexColor") {
    // Preserve color tokens as strings (e.g. "#ff00ff")
    return raw;
  }

  if (kind === "Num") {
    const maybeNum = Number(raw);
    if (!Number.isNaN(maybeNum) && raw.trim() !== "") return maybeNum;
    // Fall through to string fallback if numeric parse failed
    return raw;
  }

  // Ident / Other: attempt to coerce booleans/null and numbers, otherwise string.
  const lower = raw.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (lower === "none") return null;

  const maybeNum = Number(raw);
  if (!Number.isNaN(maybeNum) && raw.trim() !== "") return maybeNum;

  return raw;
}

/**
 * Parse a runtime raw string (as found in JSON `value` fields for set steps).
 *
 * Behavior:
 *  - If raw is not a string (number/boolean) return as-is.
 *  - If raw is a quoted string (single or double), unescape and return inner string.
 *  - Otherwise delegate to tokenRawToValue using a guessed token kind (prefer non-Str).
 *
 * This mirrors the previous evaluate.parseValue behavior while routing shared
 * logic through tokenRawToValue so codegen/evaluate agree.
 */
export function rawStringToValue(raw: string | number | boolean): unknown {
  // Guard: non-strings are returned as-is (JSON may contain numeric/boolean values directly).
  if (typeof raw !== "string") return raw;

  // Quoted string: "..." or '...'
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    const inner = raw.slice(1, -1);
    return unescapeQuotedString(inner);
  }

  // Heuristic: if it looks like a hex color, keep as string
  if (raw.startsWith("#") && /^#[0-9a-fA-F]{3,8}$/.test(raw)) {
    return tokenRawToValue("HexColor", raw);
  }

  // Heuristic: if it looks like a plain number (allow leading + / - / decimal)
  const n = Number(raw);
  if (!Number.isNaN(n) && raw.trim() !== "") return n;

  // Otherwise treat as identifier/other and let tokenRawToValue handle booleans/null.
  return tokenRawToValue("Other", raw);
}
