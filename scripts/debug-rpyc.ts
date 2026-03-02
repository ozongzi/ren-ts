#!/usr/bin/env bun
// ── scripts/debug-rpyc.ts ─────────────────────────────────────────────────────
//
// Dumps the raw decoded pickle structure of one or more .rpyc files so we can
// understand the actual AST layout.
//
// Usage:
//   bun scripts/debug-rpyc.ts <file1.rpyc> [file2.rpyc ...] [--depth <n>] [--nodes]
//
// Options:
//   --depth <n>   Max depth for JSON-like pretty-print (default: 6)
//   --nodes       Print a flat list of all top-level AST node classNames
//   --fields      Print all field names found on AST nodes (for mapping work)
//   --sample <n>  Print the first <n> nodes in full detail (default: 5)

import * as fs from "node:fs";
import * as path from "node:path";
import { readRpyc } from "../src/rpycReader";
import type { PickleValue } from "../src/pickle";
import {
  isPickleObject,
  isPickleTuple,
  getField,
  shortClass,
} from "../src/pickle";

// ─── CLI arg parsing ──────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const inputFiles: string[] = [];
let maxDepth = 6;
let showNodes = false;
let showFields = false;
let sampleCount = 5;

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === "--depth") {
    maxDepth = parseInt(rawArgs[++i] ?? "6", 10);
  } else if (a === "--nodes") {
    showNodes = true;
  } else if (a === "--fields") {
    showFields = true;
  } else if (a === "--sample") {
    sampleCount = parseInt(rawArgs[++i] ?? "5", 10);
  } else {
    inputFiles.push(a);
  }
}

if (inputFiles.length === 0) {
  console.error(
    "Usage: bun scripts/debug-rpyc.ts <file1.rpyc> [--depth n] [--nodes] [--fields] [--sample n]",
  );
  process.exit(1);
}

// ─── Pretty-printer ───────────────────────────────────────────────────────────

function pp(val: PickleValue, depth = 0, indent = 0): string {
  if (depth > maxDepth) return "…";
  const pad = "  ".repeat(indent);
  const pad1 = "  ".repeat(indent + 1);

  if (val === null) return "null";
  if (typeof val === "boolean") return String(val);
  if (typeof val === "number") return String(val);
  if (typeof val === "string") return JSON.stringify(val);
  if (val instanceof Uint8Array) return `<bytes len=${val.length}>`;

  if (Array.isArray(val)) {
    if (val.length === 0) return "[]";
    if (depth >= maxDepth) return `[… ${val.length} items]`;
    const items = val
      .slice(0, 20)
      .map((v) => pad1 + pp(v as PickleValue, depth + 1, indent + 1));
    const ellipsis =
      val.length > 20 ? [`${pad1}… ${val.length - 20} more`] : [];
    return `[\n${[...items, ...ellipsis].join(",\n")}\n${pad}]`;
  }

  if (val instanceof Map) {
    if (val.size === 0) return "{}";
    if (depth >= maxDepth) return `{… ${val.size} entries}`;
    const entries = [...val.entries()]
      .slice(0, 20)
      .map(
        ([k, v]) =>
          `${pad1}${pp(k as PickleValue, depth + 1, indent + 1)}: ${pp(v as PickleValue, depth + 1, indent + 1)}`,
      );
    const ellipsis = val.size > 20 ? [`${pad1}… ${val.size - 20} more`] : [];
    return `{\n${[...entries, ...ellipsis].join(",\n")}\n${pad}}`;
  }

  if (isPickleTuple(val)) {
    if (val.items.length === 0) return "()";
    if (depth >= maxDepth) return `(… ${val.items.length} items)`;
    const items = val.items
      .slice(0, 10)
      .map((v) => pad1 + pp(v, depth + 1, indent + 1));
    const ellipsis =
      val.items.length > 10 ? [`${pad1}… ${val.items.length - 10} more`] : [];
    return `(\n${[...items, ...ellipsis].join(",\n")}\n${pad})`;
  }

  if (isPickleObject(val)) {
    const cls = shortClass(val);
    const fieldEntries = Object.entries(val.fields);
    if (fieldEntries.length === 0 && val.args.length === 0) {
      return `<${cls}>`;
    }
    if (depth >= maxDepth) {
      return `<${cls} fields=[${fieldEntries.map(([k]) => k).join(", ")}]>`;
    }
    const parts: string[] = [];
    for (const [k, v] of fieldEntries.slice(0, 30)) {
      parts.push(`${pad1}.${k} = ${pp(v, depth + 1, indent + 1)}`);
    }
    if (fieldEntries.length > 30)
      parts.push(`${pad1}… ${fieldEntries.length - 30} more fields`);
    if (val.args.length > 0) {
      parts.push(
        `${pad1}.args = ${pp(val.args as unknown as PickleValue, depth + 1, indent + 1)}`,
      );
    }
    return `<${cls}\n${parts.join("\n")}\n${pad}>`;
  }

  // PickleCallResult
  if (
    val !== null &&
    typeof val === "object" &&
    (val as { _type?: string })._type === "call"
  ) {
    const c = val as {
      _type: "call";
      callable: PickleValue;
      args: PickleValue[];
    };
    return `call(${pp(c.callable, depth + 1, indent + 1)}, ${pp(c.args as unknown as PickleValue, depth + 1, indent + 1)})`;
  }

  return JSON.stringify(val);
}

// ─── Collect all classNames recursively ──────────────────────────────────────

function collectClasses(val: PickleValue, out: Map<string, number>): void {
  if (val === null || typeof val !== "object") return;
  if (Array.isArray(val)) {
    for (const v of val) collectClasses(v as PickleValue, out);
    return;
  }
  if (val instanceof Map) {
    for (const [k, v] of val) {
      collectClasses(k as PickleValue, out);
      collectClasses(v as PickleValue, out);
    }
    return;
  }
  if (isPickleTuple(val)) {
    for (const v of val.items) collectClasses(v, out);
    return;
  }
  if (isPickleObject(val)) {
    out.set(val.className, (out.get(val.className) ?? 0) + 1);
    for (const v of Object.values(val.fields))
      collectClasses(v as PickleValue, out);
    for (const v of val.args) collectClasses(v, out);
    return;
  }
}

// ─── Collect all field names on AST nodes ────────────────────────────────────

function collectAstFields(
  val: PickleValue,
  out: Map<string, Set<string>>,
): void {
  if (val === null || typeof val !== "object") return;
  if (Array.isArray(val)) {
    for (const v of val) collectAstFields(v as PickleValue, out);
    return;
  }
  if (val instanceof Map) {
    for (const [, v] of val) collectAstFields(v as PickleValue, out);
    return;
  }
  if (isPickleTuple(val)) {
    for (const v of val.items) collectAstFields(v, out);
    return;
  }
  if (isPickleObject(val)) {
    const cls = val.className;
    if (cls.startsWith("renpy.ast.") || cls.startsWith("renpy.")) {
      if (!out.has(cls)) out.set(cls, new Set());
      for (const k of Object.keys(val.fields)) out.get(cls)!.add(k);
    }
    for (const v of Object.values(val.fields))
      collectAstFields(v as PickleValue, out);
    for (const v of val.args) collectAstFields(v, out);
    return;
  }
}

// ─── Flatten top-level nodes ──────────────────────────────────────────────────

function flattenNodes(val: PickleValue): PickleValue[] {
  if (Array.isArray(val)) return val as PickleValue[];
  if (isPickleTuple(val)) return val.items;
  if (isPickleObject(val)) {
    // Some rpyc files wrap a list in a PickleObject (e.g. renpy.script.Script)
    const stmts =
      val.fields["stmts"] ?? val.fields["nodes"] ?? val.fields["_items"];
    if (stmts !== undefined) return flattenNodes(stmts as PickleValue);
    // Check args
    if (val.args.length === 1) return flattenNodes(val.args[0]);
  }
  return [val];
}

// ─── Walk the block tree to count all statement nodes ────────────────────────

function countAllNodes(nodes: PickleValue[]): number {
  let count = 0;
  for (const n of nodes) {
    if (!isPickleObject(n)) continue;
    count++;
    // Recurse into known block fields
    for (const fieldName of ["block", "stmts", "body", "items", "entries"]) {
      const sub = n.fields[fieldName];
      if (
        sub !== undefined &&
        (Array.isArray(sub) || isPickleTuple(sub as PickleValue))
      ) {
        const subNodes = Array.isArray(sub)
          ? (sub as PickleValue[])
          : (sub as { items: PickleValue[] }).items;
        count += countAllNodes(subNodes);
      }
    }
  }
  return count;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

for (const inputPath of inputFiles) {
  const absInput = path.resolve(inputPath);

  console.log(`\n${"═".repeat(72)}`);
  console.log(`FILE: ${absInput}`);
  console.log("═".repeat(72));

  try {
    const buf = fs.readFileSync(absInput);
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const rpycFile = await readRpyc(bytes);

    console.log(`Version : ${rpycFile.version}`);
    console.log(
      `Slot-2  : ${rpycFile.rawSource !== null ? "present" : "absent"}`,
    );

    const ast = rpycFile.astPickle;
    console.log(
      `\nRoot type: ${
        ast === null
          ? "null"
          : Array.isArray(ast)
            ? `Array(${(ast as PickleValue[]).length})`
            : ast instanceof Map
              ? `Map(${ast.size})`
              : isPickleTuple(ast)
                ? `Tuple(${ast.items.length})`
                : isPickleObject(ast)
                  ? `PickleObject<${shortClass(ast)}>`
                  : typeof ast
      }`,
    );

    // ── Raw root dump ────────────────────────────────────────────────────────
    console.log("\n── Raw root value (depth=" + maxDepth + ") ──");
    console.log(pp(ast, 0, 0));

    // ── Flattened nodes ──────────────────────────────────────────────────────
    const nodes = flattenNodes(ast);
    console.log(`\n── Flattened top-level nodes: ${nodes.length} ──`);

    const totalNodes = countAllNodes(nodes);
    console.log(`   Total nodes (recursive): ${totalNodes}`);

    if (showNodes || nodes.length <= 30) {
      console.log("\nTop-level node classNames:");
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (isPickleObject(n)) {
          const cls = shortClass(n);
          const nameField =
            getField(n, "name") ??
            getField(n, "target") ??
            getField(n, "varname") ??
            "";
          const namePart =
            typeof nameField === "string" && nameField ? ` "${nameField}"` : "";
          console.log(`  [${i}] ${cls}${namePart}`);
        } else {
          console.log(
            `  [${i}] ${typeof n === "object" ? JSON.stringify(n)?.slice(0, 60) : String(n)}`,
          );
        }
      }
    }

    // ── Sample first N nodes in full ─────────────────────────────────────────
    if (sampleCount > 0) {
      console.log(`\n── First ${sampleCount} top-level nodes (full detail) ──`);
      for (let i = 0; i < Math.min(sampleCount, nodes.length); i++) {
        console.log(`\n[${i}] ${pp(nodes[i], 0, 0)}`);
      }
    }

    // ── Class frequency table ─────────────────────────────────────────────────
    {
      const classes = new Map<string, number>();
      collectClasses(ast, classes);
      const sorted = [...classes.entries()].sort((a, b) => b[1] - a[1]);
      console.log(`\n── Class frequencies (top 40) ──`);
      for (const [cls, count] of sorted.slice(0, 40)) {
        console.log(`  ${count.toString().padStart(5)}  ${cls}`);
      }
    }

    // ── AST field map ─────────────────────────────────────────────────────────
    if (showFields) {
      const fieldMap = new Map<string, Set<string>>();
      collectAstFields(ast, fieldMap);
      console.log(`\n── AST node fields ──`);
      for (const [cls, fields] of [...fieldMap.entries()].sort()) {
        console.log(`  ${cls}:`);
        for (const f of [...fields].sort()) console.log(`    .${f}`);
      }
    }
  } catch (err) {
    console.error(
      `✗ Failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (err instanceof Error && err.stack) {
      console.error(err.stack.split("\n").slice(1, 8).join("\n"));
    }
  }
}
