#!/usr/bin/env deno run --allow-read
/**
 * validate_assets.ts
 *
 * Validates all resource references (images / audio) inside every .rrs
 * file produced by rpy2rrs.ts against the files that actually exist in
 * the assets/ directory.
 *
 * Usage:
 *   deno run --allow-read tools/rrs/validate_assets.ts [options]
 *
 * Options:
 *   --data   <dir>    Path to the .rrs output directory
 *                     (default: assets/data)
 *   --assets <dir>    Path to the engine assets root directory
 *                     (default: assets)
 *   --ci              Exit with code 1 if any real (non-case) errors are found
 *   --verbose         Print every checked reference, not just failures
 *   --no-color        Disable ANSI colour output
 *
 * Exit codes:
 *   0  All references resolve to existing files (case-insensitive)
 *   1  One or more references could not be resolved at all
 */

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = Deno.args;

function getArg(flag: string, def: string): string {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return def;
}

const dataDir = getArg("--data", "assets/data");
const assetsDir = getArg("--assets", "assets");
const ci = args.includes("--ci");
const verbose = args.includes("--verbose");
const noColor =
  args.includes("--no-color") || Deno.env.get("NO_COLOR") !== undefined;

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const c = {
  reset: noColor ? "" : "\x1b[0m",
  bold: noColor ? "" : "\x1b[1m",
  dim: noColor ? "" : "\x1b[2m",
  red: noColor ? "" : "\x1b[31m",
  green: noColor ? "" : "\x1b[32m",
  yellow: noColor ? "" : "\x1b[33m",
  cyan: noColor ? "" : "\x1b[36m",
};

function ok(s: string) {
  return `${c.green}✓${c.reset} ${s}`;
}
function warn(s: string) {
  return `${c.yellow}⚠${c.reset} ${s}`;
}
function err(s: string) {
  return `${c.red}✗${c.reset} ${s}`;
}
function hdr(s: string) {
  return `${c.bold}${c.cyan}${s}${c.reset}`;
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

/**
 * The engine's resolveAsset() logic:
 *   Audio/*  → <assetsDir>/<src>          (no extra subdir)
 *   everything else → <assetsDir>/images/<src>
 */
function enginePath(src: string): string {
  if (src.startsWith("Audio/")) return `${assetsDir}/${src}`;
  return `${assetsDir}/images/${src}`;
}

// ─── Build a case-insensitive file index ──────────────────────────────────────

/**
 * Walk a directory tree and return two sets:
 *   exact  – paths exactly as stored on disk (relative to assetsDir, no leading /)
 *   lower  – same paths lowercased  (for case-insensitive lookup)
 */
async function buildFileIndex(root: string): Promise<{
  exact: Set<string>;
  lower: Map<string, string>; // lowercase → original
}> {
  const exact = new Set<string>();
  const lower = new Map<string, string>();

  async function walk(dir: string): Promise<void> {
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const e of Deno.readDir(dir)) entries.push(e);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory) {
        await walk(full);
      } else {
        // Store relative to assetsDir
        // Store the full path (including assetsDir prefix) so it matches
        // the output of enginePath(), which also includes assetsDir.
        exact.add(full);
        lower.set(full.toLowerCase(), full);
      }
    }
  }

  await walk(root);
  return { exact, lower };
}

// ─── Extract all quoted asset references from a .rrs file ─────────────────────

const ASSET_EXT_RE = /\.(jpg|png|ogg|mp3|wav|webm)$/i;
const QUOTED_PATH_RE = /"([^"]+\.(jpg|png|ogg|mp3|wav|webm))"/gi;

interface Ref {
  file: string;
  line: number;
  src: string; // raw path in .rrs
  resolved: string; // path as resolved by enginePath()
}

async function extractRefs(rrsDir: string): Promise<Ref[]> {
  const refs: Ref[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const e of Deno.readDir(rrsDir)) entries.push(e);
  } catch (e) {
    console.error(`Cannot read data directory "${rrsDir}": ${e}`);
    Deno.exit(2);
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".rrs")) continue;
    const filePath = `${rrsDir}/${entry.name}`;
    let content: string;
    try {
      content = await Deno.readTextFile(filePath);
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Reset lastIndex for the global regex on each line
      QUOTED_PATH_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = QUOTED_PATH_RE.exec(line)) !== null) {
        const src = m[1];
        if (!ASSET_EXT_RE.test(src)) continue;
        refs.push({
          file: entry.name,
          line: i + 1,
          src,
          resolved: enginePath(src),
        });
      }
    }
  }
  return refs;
}

// ─── Classify a reference ────────────────────────────────────────────────────

type Status =
  | "ok" // exact match on disk
  | "case" // exists but with different case (macOS OK, Linux may fail)
  | "unknown" // contains <UNKNOWN: marker from converter
  | "missing"; // not found at all

interface CheckedRef extends Ref {
  status: Status;
  actualPath?: string; // only set for "case" hits
}

function checkRef(
  ref: Ref,
  idx: { exact: Set<string>; lower: Map<string, string> },
): CheckedRef {
  const { resolved, src } = ref;

  // Marker from converter — definitely broken
  if (src.includes("<UNKNOWN")) {
    return { ...ref, status: "unknown" };
  }

  // Exact match
  if (idx.exact.has(resolved)) {
    return { ...ref, status: "ok" };
  }

  // Case-insensitive match
  const lo = resolved.toLowerCase();
  const actual = idx.lower.get(lo);
  if (actual) {
    return { ...ref, status: "case", actualPath: actual };
  }

  return { ...ref, status: "missing" };
}

// ─── Aggregate summary ────────────────────────────────────────────────────────

interface Summary {
  total: number;
  okCount: number;
  caseCount: number;
  unknownCount: number;
  missingCount: number;
  byFile: Map<string, CheckedRef[]>; // only non-ok refs
}

function buildSummary(checked: CheckedRef[]): Summary {
  const s: Summary = {
    total: checked.length,
    okCount: 0,
    caseCount: 0,
    unknownCount: 0,
    missingCount: 0,
    byFile: new Map(),
  };

  for (const r of checked) {
    if (r.status === "ok") {
      s.okCount++;
      if (verbose) {
        console.log(ok(`  ${r.file}:${r.line}  ${r.src}`));
      }
      continue;
    }

    s[
      r.status === "case"
        ? "caseCount"
        : r.status === "unknown"
          ? "unknownCount"
          : "missingCount"
    ]++;

    if (!s.byFile.has(r.file)) s.byFile.set(r.file, []);
    s.byFile.get(r.file)!.push(r);
  }

  return s;
}

// ─── Report ───────────────────────────────────────────────────────────────────

function printReport(s: Summary): void {
  const hasCritical = s.unknownCount + s.missingCount > 0;

  console.log();
  console.log(hdr("═══ Asset validation report ═══"));
  console.log();
  console.log(`  Total references checked : ${c.bold}${s.total}${c.reset}`);
  console.log(`  ${c.green}Exact matches${c.reset}           : ${s.okCount}`);
  console.log(
    `  ${c.yellow}Case-only mismatches${c.reset}    : ${s.caseCount}` +
      (s.caseCount > 0
        ? `  ${c.dim}(works on macOS/Windows, may fail on Linux)${c.reset}`
        : ""),
  );
  console.log(
    `  ${c.red}UNKNOWN placeholders${c.reset}    : ${s.unknownCount}` +
      (s.unknownCount > 0
        ? `  ${c.dim}(converter could not resolve asset)${c.reset}`
        : ""),
  );
  console.log(
    `  ${c.red}Truly missing files${c.reset}     : ${s.missingCount}` +
      (s.missingCount > 0
        ? `  ${c.dim}(not found even case-insensitively)${c.reset}`
        : ""),
  );
  console.log();

  if (s.byFile.size === 0) {
    console.log(ok("All references are valid!"));
    console.log();
    return;
  }

  // Group by status type for cleaner output
  const caseRefs: CheckedRef[] = [];
  const unknownRefs: CheckedRef[] = [];
  const missingRefs: CheckedRef[] = [];

  for (const refs of s.byFile.values()) {
    for (const r of refs) {
      if (r.status === "case") caseRefs.push(r);
      if (r.status === "unknown") unknownRefs.push(r);
      if (r.status === "missing") missingRefs.push(r);
    }
  }

  // ── Case mismatches ──
  if (caseRefs.length > 0) {
    console.log(hdr(`── Case mismatches (${caseRefs.length}) ──`));
    console.log(
      `${c.dim}   These resolve on macOS/Windows but may fail on Linux.${c.reset}`,
    );
    console.log();

    // Deduplicate by src
    const seen = new Set<string>();
    for (const r of caseRefs) {
      if (seen.has(r.src)) continue;
      seen.add(r.src);
      console.log(
        warn(
          `  ${c.yellow}${r.src}${c.reset}` +
            `\n      actual: ${c.dim}${r.actualPath}${c.reset}`,
        ),
      );
    }
    console.log();
  }

  // ── UNKNOWN placeholders ──
  if (unknownRefs.length > 0) {
    console.log(
      hdr(`── UNKNOWN placeholders (${unknownRefs.length} occurrences) ──`),
    );
    console.log(
      `${c.dim}   The converter could not find the asset in any map.${c.reset}`,
    );
    console.log(
      `${c.dim}   These will appear as broken images / silence at runtime.${c.reset}`,
    );
    console.log();

    // Group by src
    const byKey = new Map<string, CheckedRef[]>();
    for (const r of unknownRefs) {
      if (!byKey.has(r.src)) byKey.set(r.src, []);
      byKey.get(r.src)!.push(r);
    }
    for (const [src, refs] of byKey) {
      console.log(err(`  ${src}`));
      for (const r of refs) {
        console.log(`      ${c.dim}${r.file}:${r.line}${c.reset}`);
      }
    }
    console.log();
  }

  // ── Truly missing ──
  if (missingRefs.length > 0) {
    console.log(
      hdr(`── Truly missing files (${missingRefs.length} occurrences) ──`),
    );
    console.log(
      `${c.dim}   These files are not in the assets directory at all.${c.reset}`,
    );
    console.log();

    const byKey = new Map<string, CheckedRef[]>();
    for (const r of missingRefs) {
      if (!byKey.has(r.src)) byKey.set(r.src, []);
      byKey.get(r.src)!.push(r);
    }
    for (const [src, refs] of byKey) {
      console.log(err(`  ${src}`));
      console.log(`      resolved → ${c.dim}${enginePath(src)}${c.reset}`);
      for (const r of refs.slice(0, 3)) {
        console.log(`      ${c.dim}${r.file}:${r.line}${c.reset}`);
      }
      if (refs.length > 3) {
        console.log(`      ${c.dim}… and ${refs.length - 3} more${c.reset}`);
      }
    }
    console.log();
  }

  // Final verdict
  if (hasCritical) {
    console.log(
      err(
        `${c.bold}${s.unknownCount + s.missingCount} critical error(s) found.${c.reset}`,
      ),
    );
  } else {
    console.log(
      warn(`${s.caseCount} case-only mismatch(es) — no critical errors.`),
    );
  }
  console.log();
}

// ─── Per-file detail mode (verbose) ──────────────────────────────────────────

function printPerFileDetail(s: Summary): void {
  if (s.byFile.size === 0) return;

  console.log(hdr("── Per-file breakdown ──"));
  console.log();

  const sorted = [...s.byFile.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  for (const [file, refs] of sorted) {
    console.log(`  ${c.bold}${file}${c.reset}  (${refs.length} issue(s))`);
    for (const r of refs) {
      const tag =
        r.status === "case"
          ? `${c.yellow}CASE${c.reset}   `
          : r.status === "unknown"
            ? `${c.red}UNKNOWN${c.reset}`
            : `${c.red}MISSING${c.reset}`;
      console.log(`    ${tag}  line ${r.line}  ${c.dim}${r.src}${c.reset}`);
    }
    console.log();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(hdr("Asset validator for .rrs files"));
  console.log(`${c.dim}  data dir   : ${dataDir}${c.reset}`);
  console.log(`${c.dim}  assets dir : ${assetsDir}${c.reset}`);
  console.log();

  // 1. Build file index
  process.stdout?.write?.("Building file index…");
  const idx = await buildFileIndex(assetsDir);
  console.log(` ${idx.exact.size} files indexed.`);

  // 2. Extract all refs
  process.stdout?.write?.("Extracting asset references…");
  const refs = await extractRefs(dataDir);
  console.log(` ${refs.length} unique raw references across all .rrs files.`);

  // 3. Deduplicate refs by (src) for checking, but keep all for per-file report
  const checked: CheckedRef[] = refs.map((r) => checkRef(r, idx));

  // 4. Build summary
  const summary = buildSummary(checked);

  // 5. Print report
  printReport(summary);

  if (verbose && summary.byFile.size > 0) {
    printPerFileDetail(summary);
  }

  // 6. Statistics per category
  const imageRefs = checked.filter((r) => !r.src.startsWith("Audio/"));
  const audioRefs = checked.filter((r) => r.src.startsWith("Audio/"));
  const imageOk = imageRefs.filter(
    (r) => r.status === "ok" || r.status === "case",
  ).length;
  const audioOk = audioRefs.filter(
    (r) => r.status === "ok" || r.status === "case",
  ).length;

  console.log(hdr("── Category breakdown ──"));
  console.log(`  Images : ${imageOk}/${imageRefs.length} resolvable`);
  console.log(`  Audio  : ${audioOk}/${audioRefs.length} resolvable`);
  console.log();

  // 7. Exit code
  const criticalCount = summary.unknownCount + summary.missingCount;
  if (ci && criticalCount > 0) {
    Deno.exit(1);
  }
}

await main();
