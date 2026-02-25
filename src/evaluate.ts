// ─── Condition evaluator & variable operations ────────────────────────────────
//
// Ren'Py conditions are written in Python syntax. We evaluate a safe subset:
//   - Comparison:  ==  !=  <  >  <=  >=
//   - Boolean:     and  or  not
//   - Literals:    True  False  strings  numbers
//   - Variables:   any key present in the vars map
//   - persistent.* → always False (not implemented in web port)
//   - renpy.*      → always False
//
// We do NOT use eval() on untrusted code — instead we substitute variable
// values into the expression string, then use Function() only on the
// resulting sanitised numeric/boolean/string expression.

import type { Step } from "./types";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Vars = Record<string, unknown>;

// ─── Value parser ─────────────────────────────────────────────────────────────

/**
 * Parse a raw value string from a `set` step into a JavaScript value.
 *
 * Examples:
 *   "1"          → 1
 *   "\"Day 1\""  → "Day 1"
 *   "True"       → true
 *   "False"      → false
 *   "0.5"        → 0.5
 *   "my_var"     → "my_var"      (variable reference — caller handles this)
 */
export function parseValue(raw: string | number | boolean): unknown {
  // Guard: JSON may store numeric/boolean values directly (not as strings).
  // e.g. `"value": 1` instead of `"value": "1"` — return as-is.
  if (typeof raw !== "string") return raw;

  if (raw === "True") return true;
  if (raw === "False") return false;
  if (raw === "None") return null;

  // Quoted string: "..." or '...'
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    // Unescape inner escaped quotes and backslashes
    return raw
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, "\\");
  }

  // Number
  const n = Number(raw);
  if (!isNaN(n) && raw.trim() !== "") return n;

  // Fallback: return as string (could be a variable reference)
  return raw;
}

// ─── Variable operations ──────────────────────────────────────────────────────

/**
 * Apply a `set` step's operation to the vars map and return a new map.
 *
 * Supported operators: =  +=  -=  *=  /=
 *
 * The `value` field in the JSON is a raw Python expression string. We parse
 * it with parseValue(); if the result is a string that matches a known
 * variable name, we resolve it as a variable reference.
 */
export function applySetStep(
  vars: Vars,
  step: Extract<Step, { type: "set" }>,
): Vars {
  const parsed = parseValue(step.value);

  // Resolve variable references: if parsed is a string and there is a
  // matching key in vars, use the variable's current value.
  const rawStr = typeof step.value === "string" ? step.value : undefined;
  let value: unknown =
    typeof parsed === "string" && rawStr !== undefined && rawStr in vars
      ? vars[rawStr]
      : parsed;

  const current = vars[step.var] ?? 0;

  switch (step.op) {
    case "=":
      break; // value already set
    case "+=":
      value = (current as number) + (value as number);
      break;
    case "-=":
      value = (current as number) - (value as number);
      break;
    case "*=":
      value = (current as number) * (value as number);
      break;
    case "/=": {
      const divisor = value as number;
      value = divisor !== 0 ? (current as number) / divisor : 0;
      break;
    }
  }

  return { ...vars, [step.var]: value };
}

// ─── Condition evaluator ──────────────────────────────────────────────────────

/**
 * Evaluate a Ren'Py condition string against the current vars map.
 *
 * Returns true if:
 *  - condition is null  (the `else` / fallback branch)
 *  - the condition evaluates to a truthy value
 *
 * Returns false on evaluation errors (with a console warning).
 */
export function evaluateCondition(
  condition: string | null,
  vars: Vars,
): boolean {
  // null condition = unconditional / else branch
  if (condition === null) return true;

  try {
    return Boolean(_evaluate(condition, vars));
  } catch (err) {
    console.warn("[evaluate] Failed to evaluate condition:", condition, err);
    return false;
  }
}

// ─── Internal evaluator ───────────────────────────────────────────────────────

function _evaluate(raw: string, vars: Vars): unknown {
  let expr = raw.trim();

  // 1. Strip outer parentheses (Ren'Py wraps conditions in parens)
  expr = stripOuterParens(expr);

  // Handle compound expressions with `and` / `or`
  // We parse them ourselves to avoid string-substitution ambiguity.

  // Try to detect top-level `or`
  const orIdx = findTopLevel(expr, " or ");
  if (orIdx !== -1) {
    const left = expr.slice(0, orIdx);
    const right = expr.slice(orIdx + 4);
    return _evaluate(left, vars) || _evaluate(right, vars);
  }

  const andIdx = findTopLevel(expr, " and ");
  if (andIdx !== -1) {
    const left = expr.slice(0, andIdx);
    const right = expr.slice(andIdx + 5);
    return _evaluate(left, vars) && _evaluate(right, vars);
  }

  // Handle `not expr`
  if (expr.startsWith("not ")) {
    return !_evaluate(expr.slice(4), vars);
  }

  // Handle comparison operators (ordered longest-first to avoid mis-parsing)
  for (const op of ["!=", "==", "<=", ">=", "<", ">"]) {
    const idx = findTopLevel(expr, op);
    if (idx !== -1) {
      const leftVal = resolveOperand(expr.slice(0, idx).trim(), vars);
      const rightVal = resolveOperand(expr.slice(idx + op.length).trim(), vars);
      return compare(leftVal, op, rightVal);
    }
  }

  // Handle `in` operator  (e.g.  "hiro" in completed_routes)
  const inIdx = findTopLevel(expr, " in ");
  if (inIdx !== -1) {
    const leftVal = resolveOperand(expr.slice(0, inIdx).trim(), vars);
    const rightVal = resolveOperand(expr.slice(inIdx + 4).trim(), vars);
    if (Array.isArray(rightVal)) return rightVal.includes(leftVal);
    return false;
  }

  // Bare operand (variable, literal, boolean)
  return resolveOperand(expr, vars);
}

/** Strip a single matching outer paren pair if present */
function stripOuterParens(s: string): string {
  if (!s.startsWith("(") || !s.endsWith(")")) return s;
  // Make sure the opening paren matches the closing paren
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0 && i !== s.length - 1) {
        // The first '(' closes before the end — they don't wrap the whole expr
        return s;
      }
    }
  }
  return s.slice(1, -1).trim();
}

/**
 * Find the index of `needle` in `haystack` that is at the "top level"
 * (not inside parentheses or quotes).  Returns -1 if not found.
 */
function findTopLevel(haystack: string, needle: string): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i <= haystack.length - needle.length; i++) {
    const ch = haystack[i];

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;

    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth--;
      continue;
    }

    if (depth === 0 && haystack.startsWith(needle, i)) {
      return i;
    }
  }
  return -1;
}

/** Resolve a single operand to a JavaScript value */
function resolveOperand(token: string, vars: Vars): unknown {
  token = token.trim();

  // Boolean literals
  if (token === "True") return true;
  if (token === "False") return false;
  if (token === "None") return null;

  // String literal
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }

  // Number literal
  const n = Number(token);
  if (!isNaN(n) && token !== "") return n;

  // dotted token handling: try direct key then nested lookup (vars["a.b"] or vars.a.b).
  // If unresolved and token is a persistent.* or renpy.* reference, treat as False.
  if (token.includes(".")) {
    // Direct lookup: vars["persistent.animations"]
    if (token in vars) return vars[token];

    // Nested object traversal: vars.persistent && vars.persistent.animations
    const parts = token.split(".");
    if (parts.length > 0 && parts[0] in vars) {
      let cur: any = (vars as any)[parts[0]];
      let found = true;
      for (let i = 1; i < parts.length; i++) {
        if (
          cur !== undefined &&
          cur !== null &&
          typeof cur === "object" &&
          parts[i] in cur
        ) {
          cur = cur[parts[i]];
        } else {
          found = false;
          break;
        }
      }
      if (found) return cur;
    }

    // Fall back: treat persistent.* and renpy.* as False when unresolved
    if (token.startsWith("persistent.") || token.startsWith("renpy.")) {
      return false;
    }
  }

  // Variable lookup
  if (token in vars) return vars[token];

  // Nested expression in parens
  if (token.startsWith("(") && token.endsWith(")")) {
    return _evaluate(token.slice(1, -1).trim(), vars);
  }

  // Unknown token — treat as falsy
  console.warn("[evaluate] Unknown token:", token);
  return undefined;
}

/** Compare two values with a Python-style comparison operator */
function compare(left: unknown, op: string, right: unknown): boolean {
  switch (op) {
    case "==":
      return left == right; // intentional loose equality for Python parity
    case "!=":
      return left != right;
    case "<":
      return (left as number) < (right as number);
    case ">":
      return (left as number) > (right as number);
    case "<=":
      return (left as number) <= (right as number);
    case ">=":
      return (left as number) >= (right as number);
    default:
      return false;
  }
}

// ─── Initial game variables ───────────────────────────────────────────────────

/**
 * Return a fresh copy of the game's default variable state.
 *
 * Variables are now initialized from the game script itself (via `define`
 * declarations or assignment statements in `label start`), so no
 * game-specific defaults are hardcoded here.
 */
export function defaultVars(): Vars {
  return {};
}
