#!/usr/bin/env bun
// ── parse-gallery.ts ──────────────────────────────────────────────────────────
//
// CLI entry point for gallery_images.rpy → manifest.json["gallery"].
// All parsing logic lives in parse-gallery-core.ts.
//
// Usage:
//   bun run tools/rrs/parse-gallery.ts --rpy <path> --manifest <path> [options]
//   bun run tools/rrs/parse-gallery.ts <gallery_images.rpy> <manifest.json>
//
// Options:
//   --rpy <path>        Path to gallery_images.rpy  (required)
//   --manifest <path>   Path to manifest.json to update
//   --dry-run           Print the gallery JSON to stdout instead of writing
//   --help, -h          Show this help

import { readFile, writeFile } from "node:fs/promises";
import { parseGalleryRpy } from "../../rpy-rrs-bridge/parse-gallery-core.ts";

const HELP = `
parse-gallery.ts — extract animated gallery data from gallery_images.rpy

Usage:
  bun run tools/rrs/parse-gallery.ts --rpy <path> --manifest <path> [options]
  bun run tools/rrs/parse-gallery.ts <gallery_images.rpy> <manifest.json>

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

  if (!rpyPath && positional[0]) rpyPath = positional[0];
  if (!manifestPath && positional[1]) manifestPath = positional[1];

  if (!rpyPath) {
    console.error("Error: --rpy <path> is required\n\n" + HELP);
    process.exit(1);
  }

  if (!manifestPath && !dryRun) {
    console.error(
      "Error: --manifest <path> is required (or pass --dry-run to print only)\n\n" +
        HELP,
    );
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
    `\x1b[32m✓\x1b[0m Parsed ${entries.length} gallery scenes (${totalFrames} total frames)`,
  );
  console.log(`  ${charSummary}`);

  // ── Dry-run ───────────────────────────────────────────────────────────────

  if (dryRun) {
    console.log("\n[dry-run] gallery entries:");
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  // ── Update manifest.json ──────────────────────────────────────────────────

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await readFile(manifestPath!, "utf-8"));
  } catch (e) {
    console.error(
      `Error: cannot read/parse manifest "${manifestPath}": ${e instanceof Error ? e.message : e}`,
    );
    process.exit(1);
  }

  manifest.gallery = entries;

  try {
    await writeFile(
      manifestPath!,
      JSON.stringify(manifest, null, 2) + "\n",
      "utf-8",
    );
    console.log(`\x1b[32m✓\x1b[0m manifest.json updated → ${manifestPath}`);
    console.log(
      `  "gallery": ${entries.length} entries, ${charCounts.size} character${charCounts.size !== 1 ? "s" : ""}`,
    );
  } catch (e) {
    console.error(
      `Error: cannot write manifest "${manifestPath}": ${e instanceof Error ? e.message : e}`,
    );
    process.exit(1);
  }
}

main();
