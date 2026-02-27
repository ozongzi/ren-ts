#!/usr/bin/env bun
// ── rpy2rrs.ts ────────────────────────────────────────────────────────────────
//
// CLI entry point: converts Ren'Py .rpy files to .rrs format.
// All conversion logic lives in rpy2rrs-core.ts.
//
// Usage:
//   bun run tools/rrs/rpy2rrs.ts <file.rpy>
//   bun run tools/rrs/rpy2rrs.ts <dir/>
//   bun run rpy2rrs <file.rpy>
//
// Options:
//   -o <path>             Output path (single-file mode) or output directory
//                         Use `-o -` to write single-file conversion to stdout
//   --manifest            Write manifest.json listing all successfully converted files
//   --dry-run             Parse only, do not write files
//   --silent              Suppress informational logging
//   --tl <dir>            Path to tl/chinese directory for Chinese translations
//                         (disabled by default; must be explicitly enabled)
//   --skip <pattern>      Skip files matching this name (repeatable)
//   --game <name>         Game display name written into manifest.json
//   --help, -h            Show this help

import {
  stat as fsStat,
  readFile,
  writeFile,
  mkdir,
  opendir,
} from "node:fs/promises";

import { convertRpy } from "./rpy2rrs-core.ts";
import { parseTranslationBlocks } from "./translation-extractor.ts";

// ── Non-story files to skip (UI / system) ────────────────────────────────────

const DEFAULT_SKIP_FILES = new Set([
  "screens.rpy",
  "options.rpy",
  "gui.rpy",
  "about.rpy",
  "save.rpy",
  "load.rpy",
  "updater.rpy",
  "gallery.rpy",
  "gallery_config.rpy",
  "gallery_images.rpy",
]);

// ── Help text ─────────────────────────────────────────────────────────────────

const HELP = `
rpy2rrs — convert Ren'Py .rpy files to .rrs

USAGE
  bun run rpy2rrs <input> [options]
  bun run tools/rrs/rpy2rrs.ts <input> [options]

INPUT
  A single .rpy file    → convert that file
  A directory path      → convert every *.rpy file inside it
                          (skips known non-story files by default)

OPTIONS
  -o <path>             Output path or output directory
                        Use '-' as path to write single-file conversion to stdout
  --manifest            Write manifest.json listing all converted .rrs files
  --tl <dir>            Path to tl/chinese directory for Chinese translations
                        (disabled by default; must be explicitly enabled)
  --skip <name>         Additional filename to skip in directory mode (repeatable)
  --dry-run             Parse only, do not write files
  --silent              Suppress informational logging
  --game <name>         Game display name written into manifest.json
  --help, -h            Show this message

EXAMPLES
  bun run rpy2rrs /path/to/game/day1.rpy
  bun run rpy2rrs /path/to/game/ -o assets/data/ --manifest
  bun run rpy2rrs /path/to/game/day1.rpy -o -   # write to stdout
`;

// ── Translation loader ────────────────────────────────────────────────────────

async function loadChineseTranslationsForFile(
  tlDir: string,
  sourceBaseName: string,
): Promise<Map<string, string>> {
  const filePath = `${tlDir}/${sourceBaseName}.rpy`;
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return new Map();
  }
  return parseTranslationBlocks(content);
}

// ── Single-file converter ─────────────────────────────────────────────────────

interface ConvertFileResult {
  ok: boolean;
}

async function convertFile(
  inputPath: string,
  outputPath: string,
  opts: {
    dryRun: boolean;
    tlDir?: string;
    silent?: boolean;
  },
): Promise<ConvertFileResult> {
  const t0 = performance.now();

  let src: string;
  try {
    src = await readFile(inputPath, "utf-8");
  } catch (e) {
    console.error(
      `✗ ${inputPath}: Cannot read: ${e instanceof Error ? e.message : e}`,
    );
    return { ok: false };
  }

  const sourceBaseName = inputPath
    .split("/")
    .pop()!
    .replace(/\.rpy$/, "");
  const filename = sourceBaseName + ".rrs";

  let translation_map: Map<string, string> | undefined;
  if (opts.tlDir) {
    const tl = await loadChineseTranslationsForFile(opts.tlDir, sourceBaseName);
    if (tl.size > 0) translation_map = tl;
  }

  let result: string;
  try {
    result = convertRpy(src, filename, translation_map);
  } catch (e) {
    console.error(
      `✗ ${inputPath}: Conversion error: ${e instanceof Error ? e.message : e}`,
    );
    if (e instanceof Error && e.stack) console.error(e.stack);
    return { ok: false };
  }

  const elapsed = (performance.now() - t0).toFixed(1);

  if (opts.dryRun) {
    if (!opts.silent) {
      console.log(`✓ [dry-run] ${inputPath}  →  ${outputPath}  (${elapsed}ms)`);
    }
    return { ok: true };
  }

  // stdout mode: `-o -`
  if (outputPath === "-") {
    try {
      process.stdout.write(result);
    } catch (e) {
      console.error(
        `✗ ${inputPath}: Cannot write to stdout: ${e instanceof Error ? e.message : e}`,
      );
      return { ok: false };
    }
    if (!opts.silent) {
      const lineCount = result.split("\n").length;
      console.log(
        `\x1b[32m✓\x1b[0m ${inputPath}  →  stdout  (${lineCount} lines, ${elapsed}ms)`,
      );
    }
    return { ok: true };
  }

  // Ensure output directory exists
  const outDir = outputPath.replace(/\/[^/]+$/, "");
  if (outDir && outDir !== outputPath) {
    try {
      await mkdir(outDir, { recursive: true });
    } catch {
      /* ignore */
    }
  }

  try {
    await writeFile(outputPath, result, "utf-8");
  } catch (e) {
    console.error(
      `✗ ${inputPath}: Cannot write '${outputPath}': ${e instanceof Error ? e.message : e}`,
    );
    return { ok: false };
  }

  const lineCount = result.split("\n").length;
  if (!opts.silent) {
    console.log(
      `\x1b[32m✓\x1b[0m ${inputPath}  →  ${outputPath}  (${lineCount} lines, ${elapsed}ms)`,
    );
  }
  return { ok: true };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (
    rawArgs.length === 0 ||
    rawArgs.includes("--help") ||
    rawArgs.includes("-h")
  ) {
    console.log(HELP);
    process.exit(rawArgs.length === 0 ? 1 : 0);
  }

  // ── Parse arguments ────────────────────────────────────────────────────────

  let outputArg: string | undefined;
  let tlDir: string | undefined;
  let dryRun = false;
  let silent = false;
  let writeManifest = false;
  let gameName: string | undefined;
  const extraSkip: string[] = [];
  const positional: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "-o") {
      outputArg = rawArgs[++i];
    } else if (arg === "--tl") {
      tlDir = rawArgs[++i];
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--silent") {
      silent = true;
    } else if (arg === "--manifest") {
      writeManifest = true;
    } else if (arg === "--game") {
      gameName = rawArgs[++i];
    } else if (arg === "--skip") {
      extraSkip.push(rawArgs[++i]);
    } else if (arg.startsWith("-")) {
      console.error(`Unknown option '${arg}'`);
      process.exit(1);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) {
    console.error("No input specified.  Run with --help for usage.");
    process.exit(1);
  }

  const skipFiles = new Set([...DEFAULT_SKIP_FILES, ...extraSkip]);

  // ── Resolve output mode ────────────────────────────────────────────────────

  let outputIsDir = false;
  if (outputArg) {
    if (outputArg === "-") {
      outputIsDir = false;
    } else if (outputArg.endsWith("/")) {
      outputIsDir = true;
    } else {
      try {
        outputIsDir = (await fsStat(outputArg)).isDirectory();
      } catch {
        outputIsDir = false;
      }
    }
  }

  if (outputArg === "-" && positional.length > 1) {
    console.error(
      "Using `-o -` (stdout) is only supported when converting a single file.",
    );
    process.exit(1);
  }

  // ── Gather input files ─────────────────────────────────────────────────────

  const inputFiles: string[] = [];
  for (const p of positional) {
    let st: Awaited<ReturnType<typeof fsStat>>;
    try {
      st = await fsStat(p);
    } catch {
      console.error(`Path not found: ${p}`);
      process.exit(1);
      return;
    }
    if (st.isFile()) {
      inputFiles.push(p);
    } else if (st.isDirectory()) {
      for await (const entry of await opendir(p)) {
        if (entry.isFile() && entry.name.endsWith(".rpy")) {
          if (skipFiles.has(entry.name)) {
            if (!silent) console.log(`  skip: ${entry.name}`);
            continue;
          }
          inputFiles.push(`${p.replace(/\/$/, "")}/${entry.name}`);
        }
      }
      inputFiles.sort();
    }
  }

  if (inputFiles.length === 0) {
    console.error("No .rpy files found.");
    process.exit(1);
  }

  // ── Convert files ──────────────────────────────────────────────────────────

  let succeeded = 0;
  let failed = 0;
  const manifestEntries: string[] = [];

  for (const inputPath of inputFiles) {
    const baseName = inputPath
      .split("/")
      .pop()!
      .replace(/\.rpy$/, ".rrs");

    let outPath: string;
    if (outputIsDir && outputArg) {
      outPath = `${outputArg.replace(/\/$/, "")}/${baseName}`;
    } else if (outputArg && !outputIsDir) {
      outPath = outputArg;
    } else {
      outPath = inputPath.replace(/\.rpy$/, ".rrs");
    }

    const result = await convertFile(inputPath, outPath, {
      dryRun,
      tlDir,
      silent,
    });

    if (result.ok) {
      succeeded++;
      manifestEntries.push(baseName);
    } else {
      failed++;
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  if (inputFiles.length > 1) {
    const summary = `\n${succeeded} succeeded, ${failed} failed`;
    if (!silent) {
      console.log(
        failed > 0 ? `\x1b[31m${summary}\x1b[0m` : `\x1b[32m${summary}\x1b[0m`,
      );
    }
  }

  // ── Write manifest.json ────────────────────────────────────────────────────

  if (writeManifest && manifestEntries.length > 0) {
    const manifestDir =
      outputIsDir && outputArg
        ? outputArg.replace(/\/$/, "")
        : positional[0].replace(/\/$/, "");

    const manifestPath = `${manifestDir}/manifest.json`;
    const sortedEntries = manifestEntries.sort();
    const manifestObj: Record<string, unknown> = {
      start: "start",
      files: sortedEntries,
    };
    if (gameName) manifestObj.game = gameName;
    const manifestContent = JSON.stringify(manifestObj, null, 2) + "\n";

    if (!dryRun) {
      try {
        await mkdir(manifestDir, { recursive: true });
        await writeFile(manifestPath, manifestContent, "utf-8");
        if (!silent) {
          console.log(
            `\x1b[32m✓\x1b[0m manifest.json → ${manifestPath}  (${manifestEntries.length} files)`,
          );
        }
      } catch (e) {
        console.error(
          `✗ manifest.json: Cannot write '${manifestPath}': ${e instanceof Error ? e.message : e}`,
        );
      }
    } else {
      if (!silent) {
        console.log(
          `✓ [dry-run] manifest.json → ${manifestPath}  (${manifestEntries.length} files)`,
        );
      }
    }
  }

  if (failed > 0) process.exit(1);
}

main();
