#!/usr/bin/env bun
// ── scan-assets.ts ────────────────────────────────────────────────────────────
//
// CLI: scan a directory of game assets and emit `image.XX = "path"` defines
// in .rrs format.  Mirrors the Ren'Py automatic image registration mechanism.
//
// Usage:
//   bun run tools/rrs/scan-assets.ts <assetsDir> [options]
//
// Options:
//   -o <path>          Output file path. Use `-` for stdout (default: stdout)
//   --root <path>      Override the root used for relative paths in defines.
//                      Defaults to <assetsDir> itself.
//   --prefix <str>     Only include files whose relative path starts with this
//                      prefix (e.g. "images/" or "BGs/").  Repeatable.
//   --inject <rrs>     Inject the defines block at the top of an existing .rrs
//                      file (after the first comment line if present), writing
//                      the result to -o.
//   --dry-run          Print what would be written without touching any files.
//   --silent           Suppress informational output (stderr).
//   --no-header        Omit the "// Auto-generated…" comment line.
//   --help, -h         Show this help.
//
// Examples:
//   # Dump all defines to stdout
//   bun run tools/rrs/scan-assets.ts /path/to/game/assets
//
//   # Write to a dedicated .rrs file
//   bun run tools/rrs/scan-assets.ts /path/to/game/assets/images \
//     -o assets/data/image_defines.rrs
//
//   # Inject into an existing .rrs, writing result to a new file
//   bun run tools/rrs/scan-assets.ts /path/to/game/assets/images \
//     --inject assets/data/yoichi1.rrs -o assets/data/yoichi1_patched.rrs
//
//   # Only images under BGs/ and Sprites/
//   bun run tools/rrs/scan-assets.ts /path/to/assets \
//     --prefix images/BGs/ --prefix images/Sprites/ -o assets/data/img.rrs

import { stat, readFile, writeFile, mkdir } from "node:fs/promises";
import * as nodePath from "node:path";
import {
  generateImageDefines,
  renderDefinesBlock,
} from "../../rpy-rrs-bridge/scan-assets-core.ts";

// ── Help text ─────────────────────────────────────────────────────────────────

const HELP = `
scan-assets — generate image.XX defines from a game assets directory

USAGE
  bun run tools/rrs/scan-assets.ts <assetsDir> [options]
  bun run scan-assets <assetsDir> [options]

ARGUMENTS
  <assetsDir>           Directory to scan recursively for image files.

OPTIONS
  -o <path>             Output file (default: stdout).  Use '-' for stdout.
  --root <path>         Root directory used when computing relative paths that
                        appear in the define values.  Defaults to <assetsDir>.
  --prefix <str>        Only emit defines for paths that start with this string
                        after relativisation.  May be given multiple times.
  --inject <rrs>        Inject the defines block into an existing .rrs file.
                        The block is inserted after the leading source-comment
                        line ("// Source: …") when present, otherwise prepended.
  --dry-run             Show what would be written; do not create/modify files.
  --silent              Suppress progress/info messages on stderr.
  --no-header           Omit the "// Auto-generated…" comment from the output.
  --help, -h            Show this message.

EXAMPLES
  # All images → stdout
  bun run scan-assets /path/to/assets

  # Write a standalone defines file
  bun run scan-assets /path/to/assets/images -o assets/data/img_defines.rrs

  # Patch an existing .rrs (overwrites in-place when -o matches --inject)
  bun run scan-assets /path/to/assets/images \\
    --inject assets/data/day1.rrs -o assets/data/day1.rrs

  # Limit scope to a sub-folder
  bun run scan-assets /path/to/assets --prefix images/BGs/ -o assets/data/bgs.rrs
`.trim();

// ── Recursive directory walker ────────────────────────────────────────────────

async function walkDir(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: { name: string; isFile: () => boolean; isDirectory: () => boolean }[];
  try {
    const { opendir } = await import("node:fs/promises");
    const handle = await opendir(dir);
    entries = [];
    for await (const entry of handle) {
      entries.push(entry);
    }
  } catch {
    return [];
  }
  for (const entry of entries) {
    const full = nodePath.join(dir, entry.name);
    if (entry.isFile()) {
      results.push(full);
    } else if (entry.isDirectory()) {
      const nested = await walkDir(full);
      results.push(...nested);
    }
  }
  return results;
}

// ── Inject helper ─────────────────────────────────────────────────────────────

/**
 * Insert `block` into `existing` RRS source text.
 *
 * Insertion point:
 *   1. After the first line if it looks like a source-comment
 *      (`// Source: …`) — a blank line is added between the comment and block.
 *   2. Otherwise prepended at the very top.
 *
 * The function also de-duplicates: if the existing content already contains a
 * line that starts with `// Auto-generated image defines`, the old block (up
 * to the first blank line following it) is replaced instead of appended again.
 */
function injectDefinesBlock(existing: string, block: string): string {
  if (!block) return existing;

  const AUTO_MARKER = "// Auto-generated image defines";

  // ── Replace existing auto-generated block if present ──
  const markerIdx = existing.indexOf(AUTO_MARKER);
  if (markerIdx !== -1) {
    // Find the end of the auto-generated block: next blank line (or EOF)
    let endIdx = existing.indexOf("\n\n", markerIdx);
    if (endIdx === -1) endIdx = existing.length;
    else endIdx += 2; // include the blank line separator
    return existing.slice(0, markerIdx) + block + existing.slice(endIdx);
  }

  const lines = existing.split("\n");

  // ── Insert after leading source comment ──
  if (lines.length > 0 && lines[0].trimStart().startsWith("// Source:")) {
    const rest = lines.slice(1).join("\n").replace(/^\n+/, ""); // strip leading blanks
    return lines[0] + "\n\n" + block + rest;
  }

  // ── Prepend ──
  return block + existing;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.length === 0 || rawArgs.includes("--help") || rawArgs.includes("-h")) {
    console.log(HELP);
    process.exit(rawArgs.length === 0 ? 1 : 0);
  }

  // ── Argument parsing ───────────────────────────────────────────────────────

  let assetsDirArg: string | undefined;
  let outputArg: string | undefined;
  let rootArg: string | undefined;
  let injectArg: string | undefined;
  const prefixes: string[] = [];
  let dryRun = false;
  let silent = false;
  let noHeader = false;

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "-o") {
      outputArg = rawArgs[++i];
    } else if (arg === "--root") {
      rootArg = rawArgs[++i];
    } else if (arg === "--prefix") {
      prefixes.push(rawArgs[++i]);
    } else if (arg === "--inject") {
      injectArg = rawArgs[++i];
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--silent") {
      silent = true;
    } else if (arg === "--no-header") {
      noHeader = true;
    } else if (arg.startsWith("-")) {
      console.error(`Unknown option: '${arg}'.  Run with --help for usage.`);
      process.exit(1);
    } else {
      if (!assetsDirArg) {
        assetsDirArg = arg;
      } else {
        console.error(`Unexpected extra argument: '${arg}'.`);
        process.exit(1);
      }
    }
  }

  if (!assetsDirArg) {
    console.error("Missing <assetsDir> argument.  Run with --help for usage.");
    process.exit(1);
  }

  // Resolve to absolute paths
  const assetsDir = nodePath.resolve(assetsDirArg);
  const rootDir = rootArg ? nodePath.resolve(rootArg) : assetsDir;

  // Validate assetsDir
  try {
    const s = await stat(assetsDir);
    if (!s.isDirectory()) {
      console.error(`Not a directory: ${assetsDir}`);
      process.exit(1);
    }
  } catch {
    console.error(`Directory not found: ${assetsDir}`);
    process.exit(1);
  }

  const info = (msg: string) => {
    if (!silent) process.stderr.write(msg + "\n");
  };

  info(`Scanning: ${assetsDir}`);
  if (rootDir !== assetsDir) info(`Root for relative paths: ${rootDir}`);

  // ── Walk and relativise ────────────────────────────────────────────────────

  const t0 = performance.now();
  const allFiles = await walkDir(assetsDir);
  info(`Found ${allFiles.length} file(s) total`);

  // Make paths relative to rootDir and normalise to forward slashes
  const relativePaths = allFiles.map((f) => {
    const rel = nodePath.relative(rootDir, f);
    return rel.replace(/\\/g, "/");
  });

  // Apply prefix filters
  const filtered =
    prefixes.length > 0
      ? relativePaths.filter((p) => prefixes.some((pfx) => p.startsWith(pfx)))
      : relativePaths;

  if (prefixes.length > 0) {
    info(`After prefix filter (${prefixes.join(", ")}): ${filtered.length} file(s)`);
  }

  // ── Generate defines ───────────────────────────────────────────────────────

  const scanResult = generateImageDefines(filtered);
  const elapsed = (performance.now() - t0).toFixed(1);

  info(`Images found: ${scanResult.defines.length}`);
  info(`Skipped (non-image): ${scanResult.skipped.length}`);
  if (scanResult.conflicts.length > 0) {
    for (const c of scanResult.conflicts) {
      process.stderr.write(
        `  [warn] key conflict '${c.key}': '${c.winner}' wins over '${c.loser}'\n`,
      );
    }
  }
  info(`Elapsed: ${elapsed}ms`);

  if (scanResult.defines.length === 0) {
    info("No image defines to emit.");
    if (!dryRun && !outputArg) process.exit(0);
  }

  const headerComment = noHeader
    ? null
    : "// Auto-generated image defines — do not edit manually";
  const block = renderDefinesBlock(scanResult, headerComment);

  // ── Compose final output ───────────────────────────────────────────────────

  let finalContent: string;

  if (injectArg) {
    const injectPath = nodePath.resolve(injectArg);
    let existingContent = "";
    try {
      existingContent = await readFile(injectPath, "utf-8");
    } catch {
      console.error(`Cannot read inject target: ${injectPath}`);
      process.exit(1);
    }
    finalContent = injectDefinesBlock(existingContent, block);
    info(`Injecting into: ${injectPath}`);
  } else {
    finalContent = block;
  }

  // ── Write / print output ───────────────────────────────────────────────────

  const toStdout = !outputArg || outputArg === "-";

  if (dryRun) {
    info("[dry-run] would write:");
    // Always print the content in dry-run, regardless of --silent
    process.stdout.write(finalContent);
    if (!finalContent.endsWith("\n")) process.stdout.write("\n");
    info(`[dry-run] ${scanResult.defines.length} define(s), not written.`);
    process.exit(0);
  }

  if (toStdout) {
    process.stdout.write(finalContent);
    if (!finalContent.endsWith("\n")) process.stdout.write("\n");
  } else {
    const outPath = nodePath.resolve(outputArg!);
    const outDir = nodePath.dirname(outPath);

    try {
      await mkdir(outDir, { recursive: true });
    } catch {
      /* ignore — dir may already exist */
    }

    try {
      await writeFile(outPath, finalContent, "utf-8");
    } catch (e) {
      console.error(
        `Cannot write '${outPath}': ${e instanceof Error ? e.message : e}`,
      );
      process.exit(1);
    }

    const lineCount = finalContent.split("\n").length - 1;
    info(
      `\x1b[32m✓\x1b[0m Written: ${outPath}  (${scanResult.defines.length} defines, ${lineCount} lines)`,
    );
  }
}

main().catch((e) => {
  console.error("Unexpected error:", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(2);
});
