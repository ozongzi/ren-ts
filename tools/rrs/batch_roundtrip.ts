#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run
/// <reference lib="deno.ns" />
// ── rrs batch round-trip tool ─────────────────────────────────────────────────
//
// Usage:
//   deno run --allow-read --allow-write --allow-run tools/rrs/batch_roundtrip.ts [data/]
//
// Steps:
//   1. Backup all *.json in the data directory → data/backup_<timestamp>/
//   2. Decompile every scene JSON → *.rrs  (skips non-label files)
//   3. Compile every generated *.rrs → back to the original *.json path
//
// Files that are NEVER recompiled (no labels / special format):
//   manifest.json
//
// All other json files that have no "labels" key will also be skipped
// gracefully at the decompile step (a warning is printed and they are
// left untouched so the backup is still the source of truth).

import { tokenize } from "./lexer.ts";
import { parse } from "./parser.ts";
import { compile } from "./codegen.ts";

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const isTTY = Deno.stdout.isTerminal?.() ?? false;
const green = (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s: string) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s);
const yellow = (s: string) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s);
const dim = (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const cyan = (s: string) => (isTTY ? `\x1b[36m${s}\x1b[0m` : s);

// ── Skip list (files with no "labels" / non-scene JSON) ───────────────────────

const SKIP_FILES = new Set(["manifest.json"]);

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = Deno.args;
  const dataDir = args[0] ?? "data";

  // Verify the directory exists
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(dataDir);
  } catch {
    console.error(red(`Error: directory not found: ${dataDir}`));
    Deno.exit(1);
    return;
  }
  if (!stat.isDirectory) {
    console.error(red(`Error: '${dataDir}' is not a directory`));
    Deno.exit(1);
    return;
  }

  // ── 1. Gather all JSON files ─────────────────────────────────────────────

  const jsonFiles: string[] = [];
  for await (const entry of Deno.readDir(dataDir)) {
    if (entry.isFile && entry.name.endsWith(".json")) {
      jsonFiles.push(`${dataDir}/${entry.name}`);
    }
  }
  jsonFiles.sort();

  console.log(
    bold(
      cyan(
        "\n── Step 1: Backup ──────────────────────────────────────────────",
      ),
    ),
  );

  // ── 2. Create timestamped backup directory ────────────────────────────────

  const now = new Date();
  const ts = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "_",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const backupDir = `${dataDir}/backup_${ts}`;

  await Deno.mkdir(backupDir, { recursive: true });
  console.log(`Backup directory: ${bold(backupDir)}`);

  let backupCount = 0;
  for (const src of jsonFiles) {
    const name = src.split("/").pop()!;
    const dst = `${backupDir}/${name}`;
    await Deno.copyFile(src, dst);
    backupCount++;
  }
  console.log(green(`✓ Backed up ${backupCount} JSON files`));

  // ── 3. Decompile ─────────────────────────────────────────────────────────

  console.log(
    bold(
      cyan(
        "\n── Step 2: Decompile JSON → .rrs ───────────────────────────────",
      ),
    ),
  );

  const decompileCli = "tools/rrs/decompile.ts";
  let decompOk = 0;
  let decompSkip = 0;
  let decompFail = 0;
  const compilable: string[] = []; // .rrs paths ready to compile

  for (const jsonPath of jsonFiles) {
    const name = jsonPath.split("/").pop()!;

    // Skip non-scene files by name
    if (SKIP_FILES.has(name)) {
      console.log(
        `${yellow("–")} ${dim(jsonPath)}  ${dim("(skipped: not a scene file)")}`,
      );
      decompSkip++;
      continue;
    }

    // Peek at the file to check it has "labels"
    let hasLabels = false;
    try {
      const text = await Deno.readTextFile(jsonPath);
      const data = JSON.parse(text);
      hasLabels = typeof data === "object" && data !== null && "labels" in data;
    } catch {
      console.warn(
        `${yellow("⚠")} ${jsonPath}  ${yellow("(cannot parse JSON — skipped)")}`,
      );
      decompSkip++;
      continue;
    }

    if (!hasLabels) {
      console.log(
        `${yellow("–")} ${dim(jsonPath)}  ${dim("(no labels key — skipped)")}`,
      );
      decompSkip++;
      continue;
    }

    const rrsPath = jsonPath.replace(/\.json$/, ".rrs");

    // Run the decompiler as a subprocess (keeps memory tidy for large files)
    const result = await new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        decompileCli,
        jsonPath,
        "-o",
        rrsPath,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();

    if (result.success) {
      console.log(`${green("✓")} ${jsonPath}  ${dim("→")}  ${rrsPath}`);
      compilable.push(rrsPath);
      decompOk++;
    } else {
      const errText = new TextDecoder().decode(result.stderr).trim();
      console.error(`${red("✗")} ${jsonPath}\n  ${red(errText)}`);
      decompFail++;
    }
  }

  console.log(
    `\n${green(`${decompOk} decompiled`)}, ` +
      `${decompSkip > 0 ? yellow(`${decompSkip} skipped`) : dim(`${decompSkip} skipped`)}, ` +
      `${decompFail > 0 ? red(`${decompFail} failed`) : dim(`${decompFail} failed`)}`,
  );

  if (compilable.length === 0) {
    console.error(red("\nNo .rrs files to compile — aborting."));
    Deno.exit(decompFail > 0 ? 1 : 0);
    return;
  }

  // ── 4. Compile .rrs → JSON ────────────────────────────────────────────────

  console.log(
    bold(
      cyan(
        "\n── Step 3: Compile .rrs → JSON ─────────────────────────────────",
      ),
    ),
  );

  const compileCli = "tools/rrs/cli.ts";
  let compileOk = 0;
  let compileFail = 0;
  const failedFiles: string[] = [];

  for (const rrsPath of compilable) {
    const jsonOut = rrsPath.replace(/\.rrs$/, ".json");

    const result = await new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        compileCli,
        rrsPath,
        "-o",
        jsonOut,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();

    const outText = new TextDecoder().decode(result.stdout).trim();
    const errText = new TextDecoder().decode(result.stderr).trim();

    if (result.success) {
      // The CLI prints its own success line; relay it
      if (outText) console.log(outText);
      compileOk++;
    } else {
      const msg = errText || outText;
      console.error(`${red("✗")} ${rrsPath}\n  ${red(msg)}`);
      compileFail++;
      failedFiles.push(rrsPath);
    }
  }

  // ── 5. Summary ────────────────────────────────────────────────────────────

  console.log(
    bold(
      cyan(
        "\n── Summary ─────────────────────────────────────────────────────",
      ),
    ),
  );
  console.log(`  JSON files found   : ${jsonFiles.length}`);
  console.log(`  Backed up          : ${backupCount}  →  ${backupDir}`);
  console.log(`  Decompiled         : ${decompOk}`);
  console.log(`  Decompile skipped  : ${decompSkip}`);
  console.log(`  Decompile failures : ${decompFail}`);
  console.log(`  Compiled back      : ${compileOk}`);
  console.log(`  Compile failures   : ${compileFail}`);

  if (compileFail > 0) {
    console.log(bold(red(`\n${compileFail} file(s) failed to compile:`)));
    for (const f of failedFiles) {
      console.log(`  ${red("•")} ${f}`);
    }
    console.log(
      yellow(
        `\nBackup is safe at ${backupDir}\n` +
          `Fix the issues above and re-run, or restore from backup.`,
      ),
    );
    Deno.exit(1);
  } else {
    console.log(
      green(
        `\n✓ Round-trip complete. All ${compileOk} scene files recompiled successfully.`,
      ),
    );
    console.log(dim(`  Original JSONs are backed up at: ${backupDir}`));
  }
}

main();
