#!/usr/bin/env -S deno run --allow-read --allow-write
// ── rrs compiler CLI ──────────────────────────────────────────────────────────
//
// Usage:
//   deno run --allow-read --allow-write tools/rrs/cli.ts <file.rrs> [options]
//   deno run --allow-read --allow-write tools/rrs/cli.ts <dir/>      [options]
//   deno task rrs:compile <file.rrs>
//
// Options:
//   -o <path>     Write output to this path (single-file mode only)
//   --dry-run     Parse and type-check only; do not write output files
//   --verbose     Print the generated JSON to stdout as well
//   --help        Show this help message

import { tokenize } from "./lexer.ts";
import { parse } from "./parser.ts";
import { compile } from "./codegen.ts";

// ── ANSI colour helpers ───────────────────────────────────────────────────────

const isTTY = Deno.stdout.isTerminal?.() ?? false;

function green(s: string) {
  return isTTY ? `\x1b[32m${s}\x1b[0m` : s;
}
function red(s: string) {
  return isTTY ? `\x1b[31m${s}\x1b[0m` : s;
}
function yellow(s: string) {
  return isTTY ? `\x1b[33m${s}\x1b[0m` : s;
}
function dim(s: string) {
  return isTTY ? `\x1b[2m${s}\x1b[0m` : s;
}
function bold(s: string) {
  return isTTY ? `\x1b[1m${s}\x1b[0m` : s;
}

// ── Help text ─────────────────────────────────────────────────────────────────

const HELP = `
${bold("rrs")} — compile .rrs files to engine JSON

${bold("USAGE")}
  deno task rrs:compile <input> [options]
  deno run --allow-read --allow-write tools/rrs/cli.ts <input> [options]

${bold("INPUT")}
  A single .rrs file   → compile that file
  A directory path     → compile every *.rrs file found inside it
                         (non-recursive by default; use --recursive for nested dirs)

${bold("OPTIONS")}
  -o <path>       Output path for the compiled JSON  (single-file mode only)
  --recursive     Recurse into sub-directories when input is a directory
  --dry-run       Lex + parse only; validate syntax without writing any files
  --verbose       Print the generated JSON to stdout after each file
  --help, -h      Show this message

${bold("EXAMPLES")}
  # Compile a single file next to the source
  deno task rrs:compile data/day1.rrs

  # Compile a single file to an explicit output path
  deno task rrs:compile data/day1.rrs -o data/day1.json

  # Compile every .rrs in the data/ directory
  deno task rrs:compile data/

  # Validate all scripts without writing output
  deno task rrs:compile data/ --dry-run
`;

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rawArgs = Deno.args.slice();

  if (
    rawArgs.length === 0 ||
    rawArgs.includes("--help") ||
    rawArgs.includes("-h")
  ) {
    console.log(HELP);
    Deno.exit(rawArgs.length === 0 ? 1 : 0);
  }

  // ── Parse flags ─────────────────────────────────────────────────────────────

  let outputPath: string | undefined;
  let dryRun = false;
  let verbose = false;
  let recursive = false;
  const positional: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "-o") {
      if (i + 1 >= rawArgs.length) {
        die("-o requires a path argument");
      }
      outputPath = rawArgs[++i];
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--verbose") {
      verbose = true;
    } else if (arg === "--recursive") {
      recursive = true;
    } else if (arg.startsWith("-")) {
      die(`Unknown option '${arg}'`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) {
    die("No input file or directory specified");
  }
  if (positional.length > 1 && outputPath) {
    die("-o can only be used with a single input file");
  }

  // ── Gather input files ───────────────────────────────────────────────────────

  const inputFiles: string[] = [];

  for (const p of positional) {
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(p);
    } catch {
      die(`Path not found: ${p}`);
      return; // unreachable — die() exits
    }

    if (stat.isFile) {
      inputFiles.push(p);
    } else if (stat.isDirectory) {
      const found = await collectScripts(p, recursive);
      if (found.length === 0) {
        console.warn(yellow(`  No .rrs files found in '${p}'`));
      }
      inputFiles.push(...found);
    } else {
      die(`'${p}' is neither a file nor a directory`);
    }
  }

  if (inputFiles.length === 0) {
    die("No .rrs input files found");
  }

  if (inputFiles.length > 1 && outputPath) {
    die("-o can only be used with a single input file");
  }

  // ── Compile ──────────────────────────────────────────────────────────────────

  let succeeded = 0;
  let failed = 0;

  for (const inputPath of inputFiles) {
    const outPath = outputPath ?? inputPath.replace(/\.rrs$/, ".json");
    const success = await compileFile(inputPath, outPath, { dryRun, verbose });
    if (success) succeeded++;
    else failed++;
  }

  // ── Summary ──────────────────────────────────────────────────────────────────

  if (inputFiles.length > 1) {
    const summary = `\n${succeeded} succeeded, ${failed} failed`;
    console.log(failed > 0 ? red(summary) : green(summary));
  }

  if (failed > 0) Deno.exit(1);
}

// ── Compile a single file ─────────────────────────────────────────────────────

async function compileFile(
  inputPath: string,
  outputPath: string,
  opts: { dryRun: boolean; verbose: boolean },
): Promise<boolean> {
  const t0 = performance.now();

  let src: string;
  try {
    src = await Deno.readTextFile(inputPath);
  } catch (e) {
    printError(
      inputPath,
      `Cannot read file: ${e instanceof Error ? e.message : e}`,
    );
    return false;
  }

  // ── Lex ───────────────────────────────────────────────────────────────────

  let tokens;
  try {
    tokens = tokenize(src);
  } catch (e) {
    printError(inputPath, `Lex error: ${e instanceof Error ? e.message : e}`);
    return false;
  }

  // ── Parse ─────────────────────────────────────────────────────────────────

  let ast;
  try {
    ast = parse(tokens);
  } catch (e) {
    printError(inputPath, `Parse error: ${e instanceof Error ? e.message : e}`);
    return false;
  }

  // ── Validate basic structure ──────────────────────────────────────────────

  if (ast.labels.length === 0) {
    printWarning(inputPath, "File contains no labels — output will be empty");
  }

  // ── Code-gen ──────────────────────────────────────────────────────────────

  let jsonFile;
  try {
    jsonFile = compile(ast, inputPath);
  } catch (e) {
    printError(
      inputPath,
      `Codegen error: ${e instanceof Error ? e.message : e}`,
    );
    return false;
  }

  const jsonText = JSON.stringify(jsonFile, null, 2);
  const elapsed = (performance.now() - t0).toFixed(1);

  // ── Dry run ───────────────────────────────────────────────────────────────

  if (opts.dryRun) {
    const labelNames = ast.labels.map((l) => l.name).join(", ");
    console.log(
      `${green("✓")} ${dim("[dry-run]")} ${inputPath}  ` +
        dim(`labels: [${labelNames}]  ${elapsed}ms`),
    );
    if (opts.verbose) console.log(jsonText);
    return true;
  }

  // ── Write output ──────────────────────────────────────────────────────────

  try {
    await Deno.writeTextFile(outputPath, jsonText);
  } catch (e) {
    printError(
      inputPath,
      `Cannot write '${outputPath}': ${e instanceof Error ? e.message : e}`,
    );
    return false;
  }

  const labelCount = ast.labels.length;
  const stepCount = Object.values(jsonFile.labels).reduce(
    (n, l) => n + l.length,
    0,
  );

  console.log(
    `${green("✓")} ${inputPath}  ${dim("→")}  ${outputPath}  ` +
      dim(
        `${labelCount} label${labelCount !== 1 ? "s" : ""}, ${stepCount} steps  ${elapsed}ms`,
      ),
  );

  if (opts.verbose) console.log(jsonText);

  return true;
}

// ── Directory walker ──────────────────────────────────────────────────────────

async function collectScripts(
  dir: string,
  recursive: boolean,
): Promise<string[]> {
  const results: string[] = [];

  for await (const entry of Deno.readDir(dir)) {
    const fullPath = `${dir}/${entry.name}`;
    if (entry.isFile && entry.name.endsWith(".rrs")) {
      results.push(fullPath);
    } else if (entry.isDirectory && recursive) {
      results.push(...(await collectScripts(fullPath, recursive)));
    }
  }

  // Sort for deterministic output order
  results.sort();
  return results;
}

// ── Error / warning helpers ───────────────────────────────────────────────────

function printError(file: string, msg: string): void {
  console.error(`${red("✗")} ${file}\n  ${red("Error:")} ${msg}`);
}

function printWarning(file: string, msg: string): void {
  console.warn(`${yellow("⚠")} ${file}: ${msg}`);
}

function die(msg: string): never {
  console.error(`${red("Error:")} ${msg}\nRun with --help for usage.`);
  Deno.exit(1);
}

// ── Run ───────────────────────────────────────────────────────────────────────

main();
