#!/usr/bin/env bun
// ── parse_gallery.ts ─────────────────────────────────────────────────────────
//
// Parses gallery_images.rpy from a Ren'Py game directory and extracts all
//   image NAME = Movie(play="path/to/file.webm", ...)
// declarations.  Each image name is split on underscores:
//   parts[0]  → character key  (e.g. "hiro")
//   parts[1]  → group segment  (e.g. "g1", "g9a")
//   parts[2+] → frame index    (ignored for grouping)
//
// All frames sharing the same {parts[0]}_{parts[1]} prefix become one entry.
// Character display name = parts[0] with first letter capitalised.
// Entries are ordered by first-appearance in the file (insertion order).
//
// The resulting gallery array is injected into manifest.json under "gallery".
//
// Usage:
//   bun run tools/rrs/parse_gallery.ts \
//     --rpy  /path/to/game/gallery_images.rpy \
//     --manifest /path/to/output/manifest.json
//
//   # Positional shorthand (rpy first, manifest second):
//   bun run tools/rrs/parse_gallery.ts <gallery_images.rpy> <manifest.json>
//
// Options:
//   --rpy <path>        Path to gallery_images.rpy
//   --manifest <path>   Path to manifest.json to update
//   --dry-run           Print result to stdout, do not write manifest
//   --help, -h          Show this help

import { readFile, writeFile } from "node:fs/promises";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GalleryEntry {
  /** Unique scene ID derived from "{charKey}_{groupSegment}", e.g. "char_g1" */
  id: string;
  /**
   * Display name of the character.
   * Derived purely from the image-name prefix: first letter capitalised,
   * rest lower-cased.  No hardcoded name map is used.
   * e.g. raw key "alice" → display name "Alice"
   */
  character: string;
  /**
   * Ordered list of asset paths (relative to the game's images/ directory).
   * e.g. "Animated CGs/char_1/char_1_1.webm"
   */
  frames: string[];
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse the contents of gallery_images.rpy and return a list of gallery
 * entries in file-appearance order (one entry per unique charKey_groupSegment).
 *
 * The only assumption made about image names is:
 *   NAME = "{charKey}_{groupSegment}[_{frameId...}]"
 * where charKey and groupSegment are non-empty strings separated by "_".
 * No game-specific names are hardcoded anywhere in this function.
 */
export function parseGalleryRpy(src: string): GalleryEntry[] {
  const lines = src.split("\n");

  // Preserve insertion order; Map key = groupId e.g. "char_g1"
  const groups = new Map<string, GalleryEntry>();

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Match:  image NAME = Movie(play="images/path/file.webm", ...)
    // Handles both double-quoted and single-quoted paths.
    const m = line.match(
      /^image\s+(\S+)\s*=\s*Movie\s*\(\s*play\s*=\s*["']([^"']+)["']/,
    );
    if (!m) continue;

    const imageName = m[1]; // e.g. "char_g1_1" or "char_g6a_10a"
    const rawPath = m[2]; // e.g. "images/Animated CGs/char_1/Char_1_1.webm"

    // Strip the leading "images/" prefix — the asset resolver does not need it.
    const assetPath = rawPath.startsWith("images/")
      ? rawPath.slice("images/".length)
      : rawPath;

    // Split on "_" to extract the two grouping segments.
    // parts[0] = character key  (arbitrary, game-defined, e.g. "alice")
    // parts[1] = group segment  (arbitrary, game-defined, e.g. "g1", "g2a")
    // parts[2+] = frame qualifier(s) — not used for grouping
    const parts = imageName.split("_");
    if (parts.length < 2) {
      // Cannot determine a group — skip this entry.
      continue;
    }

    const charKey = parts[0].toLowerCase();
    const groupSegment = parts[1];
    const groupId = `${charKey}_${groupSegment}`;

    // Derive display name purely from the raw key: capitalise first letter.
    // No hardcoded name lookup table — works with any game's character names.
    const character = charKey.charAt(0).toUpperCase() + charKey.slice(1);

    if (!groups.has(groupId)) {
      groups.set(groupId, { id: groupId, character, frames: [] });
    }
    groups.get(groupId)!.frames.push(assetPath);
  }

  // Return in insertion order (first appearance in the .rpy file).
  // This naturally groups characters together since the file typically
  // declares all frames for one character before moving to the next.
  return Array.from(groups.values());
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const HELP = `
parse_gallery.ts — extract animated gallery data from gallery_images.rpy

Usage:
  bun run tools/rrs/parse_gallery.ts --rpy <path> --manifest <path> [options]
  bun run tools/rrs/parse_gallery.ts <gallery_images.rpy> <manifest.json>

Options:
  --rpy <path>        Path to gallery_images.rpy  (required)
  --manifest <path>   Path to manifest.json to update (required unless --dry-run)
  --dry-run           Print the gallery JSON to stdout instead of writing
  --help, -h          Show this help

How it works:
  Each line of the form
    image NAME = Movie(play="images/PATH", ...)
  is parsed.  NAME is split on underscores:
    parts[0]  → character key  (display name = first letter capitalised)
    parts[1]  → scene group ID
  All frames sharing the same parts[0]_parts[1] key become one gallery entry.
  Entries preserve the order they first appear in the .rpy file.
`.trim();

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }

  let rpyPath: string | undefined;
  let manifestPath: string | undefined;
  let dryRun = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--rpy") {
      rpyPath = args[++i];
    } else if (arg === "--manifest") {
      manifestPath = args[++i];
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }

  // Fall back to positional args
  if (!rpyPath && positional[0]) rpyPath = positional[0];
  if (!manifestPath && positional[1]) manifestPath = positional[1];

  if (!rpyPath) {
    console.error("Error: --rpy <path> is required");
    console.error("\n" + HELP);
    process.exit(1);
  }

  if (!manifestPath && !dryRun) {
    console.error(
      "Error: --manifest <path> is required (or pass --dry-run to print only)",
    );
    console.error("\n" + HELP);
    process.exit(1);
  }

  // ── Read gallery_images.rpy ───────────────────────────────────────────────

  let rpySrc: string;
  try {
    rpySrc = await readFile(rpyPath, "utf-8");
  } catch (e) {
    console.error(
      `Error: cannot read "${rpyPath}": ${e instanceof Error ? e.message : e}`,
    );
    process.exit(1);
  }

  // ── Parse ─────────────────────────────────────────────────────────────────

  const entries = parseGalleryRpy(rpySrc);

  // Build a summary: unique characters and their entry counts.
  const charCounts = new Map<string, number>();
  let totalFrames = 0;
  for (const e of entries) {
    charCounts.set(e.character, (charCounts.get(e.character) ?? 0) + 1);
    totalFrames += e.frames.length;
  }
  const charSummary = Array.from(charCounts.entries())
    .map(([c, n]) => `${c}: ${n} scene${n !== 1 ? "s" : ""}`)
    .join(", ");

  console.log(
    `\x1b[32m✓\x1b[0m Parsed ${entries.length} gallery scenes ` +
      `(${totalFrames} total frames)`,
  );
  console.log(`  ${charSummary}`);

  // ── Dry-run: print and exit ───────────────────────────────────────────────

  if (dryRun) {
    console.log("\n[dry-run] gallery entries:");
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  // ── Update manifest.json ──────────────────────────────────────────────────

  let manifestSrc: string;
  try {
    manifestSrc = await readFile(manifestPath!, "utf-8");
  } catch (e) {
    console.error(
      `Error: cannot read manifest "${manifestPath}": ${e instanceof Error ? e.message : e}`,
    );
    process.exit(1);
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestSrc);
  } catch (e) {
    console.error(
      `Error: cannot parse manifest "${manifestPath}": ${e instanceof Error ? e.message : e}`,
    );
    process.exit(1);
  }

  manifest.gallery = entries;

  const output = JSON.stringify(manifest, null, 2) + "\n";

  try {
    await writeFile(manifestPath!, output, "utf-8");
    console.log(`\x1b[32m✓\x1b[0m manifest.json updated → ${manifestPath}`);
    console.log(
      `  "gallery": ${entries.length} entries, ` +
        `${charCounts.size} character${charCounts.size !== 1 ? "s" : ""}`,
    );
  } catch (e) {
    console.error(
      `Error: cannot write manifest "${manifestPath}": ${e instanceof Error ? e.message : e}`,
    );
    process.exit(1);
  }
}

main();
