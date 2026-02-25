import type { Step, ScriptFile, Manifest } from "./types";
import { parseScript, extractCharMap, extractImageMap } from "./rrs/index";
import { isTauri, getActiveAssetsDir } from "./tauri_bridge";

// ─── Label registry ───────────────────────────────────────────────────────────
// Maps every label name → its steps array, loaded lazily from .rrs files.

const labelIndex: Map<string, Step[]> = new Map();
let loadedFiles: Set<string> = new Set();
let manifestFiles: string[] = [];
let manifestStart: string = "start";
let manifestGame: string | undefined = undefined;

// Global character abbreviation → display name map, populated from script.rrs.
// All other files are compiled with this map so `speak k "text"` resolves to
// speaker "Keitaro" even though story files carry no `define` declarations.
let globalCharMap: Map<string, string> = new Map();

// Global image var-ref → file path map, populated from script.rrs.
// All other files are compiled with this map so `scene image.bg.foo` resolves
// to the correct path even though story files may not declare that image.
let globalImageMap: Map<string, string> = new Map();

// ─── Data file reader ─────────────────────────────────────────────────────────

/**
 * Read a data file by filename (e.g. "manifest.json", "day1.rrs").
 *
 * - Tauri mode: reads directly from <assetsDir>/data/<filename> via the
 *   Tauri filesystem plugin (no HTTP server required in production).
 * - Web / dev mode: fetches from /assets/data/<filename> via HTTP (served by
 *   the Vite dev-server middleware).
 */
async function readDataFile(filename: string): Promise<string> {
  if (isTauri) {
    const assetsDir = getActiveAssetsDir();
    if (!assetsDir) {
      throw new Error(
        `[loader] Cannot read "${filename}": assets directory has not been selected yet.`,
      );
    }
    // Dynamic import keeps the Tauri plugin out of web builds entirely.
    // deno-ignore-next-line
    // @ts-ignore
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    return readTextFile(`${assetsDir}/data/${filename}`);
  }

  // Web / dev mode — served by the Vite static-dirs middleware
  const url = `/assets/data/${filename}`;
  const resp = await fetch(url, {
    cache: "no-store",
    headers: { Pragma: "no-cache" },
  });
  if (!resp.ok) {
    throw new Error(`[loader] HTTP ${resp.status} fetching ${url}`);
  }
  return resp.text();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Load the manifest and eagerly parse all .rrs files into the
 * label index.  Call this once on startup (after assetsDir is known in
 * Tauri mode).
 */
export async function loadAll(): Promise<void> {
  const manifestText = await readDataFile("manifest.json");

  let manifest: Manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (e) {
    throw new Error(`[loader] Failed to parse manifest.json: ${e}`);
  }

  manifestFiles = manifest.files;
  // Ren'Py convention: entry label is always "start". Fall back if not set.
  manifestStart = manifest.start ?? "start";
  manifestGame = manifest.game;

  console.info(
    `[loader] Manifest loaded. ${manifest.files.length} files listed. ` +
      `Start label: "${manifestStart}". ` +
      `First 3: ${manifest.files.slice(0, 3).join(", ")}`,
  );

  // ── Two-pass loading ───────────────────────────────────────────────────────
  // Pass 1: load script.rrs first (if present) and extract the global
  //         character map from its `char.k = "Keitaro";` declarations and the
  //         global image map from its `image.bg.foo = "..."` declarations.
  //         Story files carry no such declarations and rely on these maps.
  // Pass 2: load all remaining files in parallel, passing both global maps
  //         so speaker abbreviations and image var refs are resolved correctly.

  const SCRIPT_FILE = "script.rrs";
  if (manifest.files.includes(SCRIPT_FILE)) {
    await loadFile(SCRIPT_FILE);

    // Extract character and image definitions from the already-loaded raw
    // source.  We re-fetch the text here rather than threading the raw source
    // through loadFile() — the file is small and the cost is negligible.
    try {
      const scriptSrc = await readDataFile(SCRIPT_FILE);
      globalCharMap = extractCharMap(scriptSrc);
      globalImageMap = extractImageMap(scriptSrc);
      console.info(
        `[loader] Extracted ${globalCharMap.size} character definition(s) and ` +
          `${globalImageMap.size} image definition(s) from ${SCRIPT_FILE}`,
      );
    } catch {
      console.warn(
        `[loader] Could not re-read ${SCRIPT_FILE} for map extraction`,
      );
    }
  }

  // Load all remaining files in parallel (script.rrs is already loaded above)
  await Promise.all(
    manifest.files.filter((f) => f !== SCRIPT_FILE).map(loadFile),
  );

  // Summary log — visible in browser DevTools / Tauri WebView console
  const labelCount = labelIndex.size;
  const fileCount = manifest.files.length;
  if (labelCount === 0) {
    console.error(
      `[loader] ⚠️  No labels loaded from ${fileCount} files! ` +
        `Check that manifest.json lists .rrs files and that the assets directory is correct.`,
    );
  } else {
    console.info(
      `[loader] ✓ Loaded ${labelCount} labels from ${fileCount} script files.`,
    );
  }
}

/**
 * Load a single .rrs file, parse it, and register its labels.
 * Safe to call multiple times for the same file (no-op on second call).
 */
export async function loadFile(filename: string): Promise<void> {
  if (loadedFiles.has(filename)) return;
  loadedFiles.add(filename);

  let src: string;
  try {
    src = await readDataFile(filename);
  } catch (e) {
    console.warn(`[loader] ✗ Failed to read ${filename}:`, e);
    return;
  }

  // Peek at Content-Type in web mode — if the server returns HTML (e.g. a
  // 404 page with status 200) we'll catch it early.
  if (src.trimStart().startsWith("<!")) {
    console.warn(
      `[loader] ✗ ${filename} — received HTML instead of script text. ` +
        `Check that the dev server middleware / assets directory is correct.`,
    );
    return;
  }

  // Sanity-check: a valid rrs file should contain at least one "label" keyword.
  if (!src.includes("label ")) {
    console.warn(
      `[loader] ✗ ${filename} — content does not look like a .rrs file ` +
        `(no "label " keyword found). First 200 chars: ${src.slice(0, 200)}`,
    );
    return;
  }

  let script: ScriptFile;
  try {
    script = parseScript(src, filename, globalCharMap, globalImageMap);
  } catch (e) {
    console.warn(`[loader] Parse error in ${filename}:`, e);
    return;
  }

  const newLabels = Object.keys(script.labels);
  if (newLabels.length === 0) {
    console.warn(`[loader] ✗ ${filename} — parsed OK but produced 0 labels`);
    return;
  }

  for (const [label, steps] of Object.entries(script.labels)) {
    if (labelIndex.has(label)) {
      // In the original game multiple files can define labels with the same
      // name (e.g. helper labels). Last writer wins — consistent with how
      // Ren'Py processes files alphabetically.
      console.warn(
        `[loader] Duplicate label "${label}" in ${filename} – overwriting`,
      );
    }
    labelIndex.set(label, steps as Step[]);
  }
}

/**
 * Return the steps for a given label, or null if unknown.
 * If the label hasn't been loaded yet this returns null; callers should
 * ensure loadAll() has completed first.
 */
export function getLabel(name: string): Step[] | null {
  return labelIndex.get(name) ?? null;
}

/**
 * Return true if the label exists in the index.
 */
export function hasLabel(name: string): boolean {
  return labelIndex.has(name);
}

/**
 * Return all known label names (useful for debugging / gallery).
 */
export function allLabels(): string[] {
  return Array.from(labelIndex.keys());
}

/**
 * Return the list of filenames from the manifest.
 */
export function getManifestFiles(): string[] {
  return manifestFiles;
}

/**
 * Return the entry-point label name from the manifest.
 * Defaults to "start" (Ren'Py convention) if not specified.
 */
export function getManifestStart(): string {
  return manifestStart;
}

/**
 * Return the game display name from the manifest, if present.
 */
export function getManifestGame(): string | undefined {
  return manifestGame;
}

/**
 * Clear everything — used in tests / hot-reload scenarios.
 */
export function reset(): void {
  labelIndex.clear();
  loadedFiles = new Set();
  manifestFiles = [];
  manifestStart = "start";
  manifestGame = undefined;
  globalCharMap = new Map();
}
