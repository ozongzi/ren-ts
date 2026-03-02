#!/usr/bin/env tsx
// ── scripts/convert-rpyc.ts ───────────────────────────────────────────────────
//
// CLI helper: convert one or more .rpyc files to .rrs and write results to
// a given output directory.
//
// Usage:
//   bun scripts/convert-rpyc.ts <output-dir> <file1.rpyc> [file2.rpyc ...]
//
// Example:
//   bun scripts/convert-rpyc.ts assets/test ~/game/journal.rpyc ~/game/day8.rpyc

import * as fs from "node:fs";
import * as path from "node:path";

// ── Shim: rpycReader and rpyc2rrs-core rely on DecompressionStream which
//    is available in Bun (>=1.0) but not in Node.  We also need a minimal
//    fetch-free zlibDecompress shim for environments that might lack it.
//    Bun ships with the Web Streams API including DecompressionStream, so
//    this script is intended to be run with `bun`.

import { readRpyc } from "../src/rpycReader";
import {
  unwrapAstNodes,
  detectMinigameFromAst,
  convertRpyc,
} from "../rpy-rrs-bridge/rpyc2rrs-core";
import { renderMinigameStubs } from "../rpy-rrs-bridge/minigame-detect";

// ─── Entry point ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error(
    "Usage: bun scripts/convert-rpyc.ts <output-dir> <file1.rpyc> [file2.rpyc ...]",
  );
  process.exit(1);
}

const [outDir, ...inputFiles] = args;

fs.mkdirSync(outDir, { recursive: true });

let ok = 0;
let fail = 0;

for (const inputPath of inputFiles) {
  const absInput = path.resolve(inputPath);
  const baseName = path.basename(absInput).replace(/\.rpyc$/i, "");
  const rrsName  = baseName + ".rrs";
  const outPath  = path.join(outDir, rrsName);

  process.stdout.write(`[${baseName}] reading … `);

  try {
    // Read raw bytes — rpyc is binary.
    const buf   = fs.readFileSync(absInput);
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

    // Parse rpyc format.
    const rpycFile = await readRpyc(bytes);
    console.log(
      `rpyc ${rpycFile.version}, slot2=${rpycFile.rawSource !== null}`,
    );

    // Unwrap AST nodes.
    const rootNodes = unwrapAstNodes(rpycFile.astPickle);
    console.log(`  nodes: ${rootNodes.length}`);

    // Minigame detection.
    const mgResult = detectMinigameFromAst(rootNodes);
    for (const w of mgResult.warnings) console.warn(`  ⚠  ${w}`);

    let rrs: string;
    if (mgResult.stubs.length > 0) {
      const labels = mgResult.stubs.map((s) => s.entryLabel).join(", ");
      console.log(`  → minigame stub [${labels}]`);
      rrs = renderMinigameStubs(mgResult.stubs, rrsName);
    } else {
      rrs = convertRpyc(rpycFile.astPickle, rrsName);
      const lines = rrs.split("\n").length;
      console.log(`  → converted (${lines} lines)`);
    }

    fs.writeFileSync(outPath, rrs, "utf-8");
    console.log(`  ✓ written → ${outPath}`);
    ok++;
  } catch (err) {
    console.error(
      `  ✗ failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (err instanceof Error && err.stack) {
      console.error(err.stack.split("\n").slice(1, 6).join("\n"));
    }
    fail++;
  }
}

console.log(`\nDone: ${ok} ok, ${fail} failed.`);
if (fail > 0) process.exit(1);
