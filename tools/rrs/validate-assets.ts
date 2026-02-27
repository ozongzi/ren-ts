#!/usr/bin/env node
/**
 * Simplified validate_assets.ts
 *
 * - Scans a directory of .rrs files (expected to be JSON produced by rpy2rrs)
 * - For each .rrs file: parse as JSON (failure -> immediate error/exit)
 * - Inspect `defines` (flat key->value map). If a define's value looks like a
 *   path (contains '/' or ends with a common media extension), verify that the
 *   corresponding file exists in the assets directory.
 *
 * Usage:
 *   node tools/rrs/validate_assets.ts [--data <dataDir>] [--assets <assetsDir>] [--ci]
 *
 * Exit codes:
 *   0  All checked paths exist
 *   1  One or more referenced paths are missing
 *   2  Unexpected IO / parse error
 */

import { readdir, readFile, access } from "fs/promises";
import path from "path";
import { parseScript } from "../../rrs/index.ts";

const args = process.argv.slice(2);

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
  args.includes("--no-color") || process.env["NO_COLOR"] !== undefined;

const c = {
  reset: noColor ? "" : "\x1b[0m",
  bold: noColor ? "" : "\x1b[1m",
  dim: noColor ? "" : "\x1b[2m",
  red: noColor ? "" : "\x1b[31m",
  green: noColor ? "" : "\x1b[32m",
  yellow: noColor ? "" : "\x1b[33m",
  cyan: noColor ? "" : "\x1b[36m",
};
function hdr(s: string) {
  return `${c.bold}${c.cyan}${s}${c.reset}`;
}
function ok(s: string) {
  return `${c.green}✓${c.reset} ${s}`;
}
function err(s: string) {
  return `${c.red}✗${c.reset} ${s}`;
}

const ASSET_EXT_RE = /\.(jpg|png|ogg|mp3|wav|webm)$/i;

/** Map a src (as used in defines) to an expected path on disk.
 *  NOTE: defines now contain full relative paths under the assets root.
 *  Join assetsDir + src directly without adding prefixes.
 */
function enginePath(src: string): string {
  return path.join(assetsDir, src);
}

/** Remove surrounding quotes if present. */
function stripQuotes(s: string): string {
  if (!s) return s;
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log(`Asset validator (simplified)`);
  console.log(`  data dir   : ${dataDir}`);
  console.log(`  assets dir : ${assetsDir}`);
  console.log();

  let entries: string[];
  try {
    entries = await readdir(dataDir);
  } catch (e) {
    console.error(`Failed to read data directory "${dataDir}":`, e);
    process.exit(2);
    return;
  }

  const rrsFiles = entries.filter((n) => n.endsWith(".rrs"));
  if (rrsFiles.length === 0) {
    console.warn(`No .rrs files found in ${dataDir}`);
    process.exit(0);
    return;
  }

  const missing: {
    file: string;
    defineKey: string;
    value: string;
    resolved: string;
  }[] = [];
  let totalDefines = 0;
  let foundCount = 0;

  for (const fname of rrsFiles) {
    const full = path.join(dataDir, fname);
    let text: string;
    try {
      text = await readFile(full, "utf-8");
    } catch (e) {
      console.error(`Failed to read ${full}:`, e);
      process.exit(2);
      return;
    }

    // Parse the .rrs source using the project's rrs parser (not raw JSON)
    let script;
    try {
      script = parseScript(text, fname);
    } catch (e) {
      console.error(`Failed to parse .rrs in ${fname}:`, e);
      // Parsing .rrs must succeed per your instruction
      process.exit(2);
      return;
    }

    // collect defines from parsed ScriptFile
    const defines = (script && (script as any).defines) || {};
    if (!defines || typeof defines !== "object") {
      continue;
    }

    for (const [k, rawVal] of Object.entries(defines)) {
      if (rawVal === undefined || rawVal === null) continue;
      const sval = String(rawVal);
      const val = stripQuotes(sval);

      // Heuristic: if it contains a slash or ends with a known extension, treat as a path
      if (val.includes("/") || ASSET_EXT_RE.test(val)) {
        const resolved = enginePath(val);
        let exists = await fileExists(resolved);

        // If not found, and this appears to be an image (not an Audio/ path),
        // attempt the fallback of prefixing with "images/" under assetsDir.
        // This preserves behavior: first try the define value as-is, then try
        // assets/images/<val> as a second chance.
        let altResolved: string | null = null;
        if (!exists && ASSET_EXT_RE.test(val) && !/^Audio\//i.test(val)) {
          altResolved = path.join(assetsDir, "images", val);
          exists = await fileExists(altResolved);
        }

        totalDefines++;
        if (!exists) {
          // Prefer reporting the alternative resolved path if we attempted it,
          // otherwise report the original resolved path.
          missing.push({
            file: fname,
            defineKey: k,
            value: val,
            resolved: altResolved ?? resolved,
          });
        } else {
          foundCount++;
          if (verbose) {
            console.log(
              ok(
                `  ${fname}  ${k} => ${val}  (found: ${altResolved ?? resolved})`,
              ),
            );
          }
        }
      }
    }
  }

  console.log();
  console.log(hdr("Validation summary"));
  console.log(`  Total defines scanned: ${totalDefines}`);
  console.log(`  Found (existing)     : ${foundCount}`);
  console.log(`  Missing               : ${missing.length}`);
  if (missing.length === 0) {
    console.log(ok("All referenced define paths exist."));
    process.exit(0);
    return;
  }

  console.error(`Found ${missing.length} missing referenced asset(s):`);
  for (const m of missing) {
    console.error(
      ` - ${m.file} :: ${m.defineKey} = ${m.value}  -> ${m.resolved}`,
    );
  }

  if (ci) {
    console.error("Exiting with failure due to --ci.");
    process.exit(1);
  } else {
    // Non-CI: still exit with code 1 to indicate missing assets
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(2);
});
