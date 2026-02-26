import type { Step, ScriptFile, Manifest, GalleryEntry } from "./types";
import { parseScript } from "./rrs/index";
import { isTauri, getActiveAssetsDir } from "./tauri_bridge";

// ─── Label registry ───────────────────────────────────────────────────────────

const labelIndex: Map<string, Step[]> = new Map();
let loadedFiles: Set<string> = new Set();
let manifestFiles: string[] = [];
let manifestStart: string = "start";
let manifestGame: string | undefined = undefined;
let manifestGallery: GalleryEntry[] = [];

// ─── Define vars ─────────────────────────────────────────────────────────────
// All top-level defines from every .rrs file are merged here.
// Keys are stored verbatim: "image.bg.foo", "char.k", "audio.bgm_main", etc.
// This dict is injected into GameState.vars before the game starts so the
// engine can resolve image paths, character names and audio aliases at runtime.

let defineVars: Record<string, string> = {};

// ─── Data file reader ─────────────────────────────────────────────────────────

async function readDataFile(filename: string): Promise<string> {
  if (isTauri) {
    const assetsDir = getActiveAssetsDir();
    if (!assetsDir) {
      throw new Error(
        `[loader] Cannot read "${filename}": assets directory has not been selected yet.`,
      );
    }
    // @ts-ignore
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    return readTextFile(`${assetsDir}/data/${filename}`);
  }

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
 * Load the manifest and eagerly parse all .rrs files.
 * All top-level defines from every file are merged into defineVars.
 * All labels from every file are registered in labelIndex.
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
  manifestStart = manifest.start ?? "start";
  manifestGame = manifest.game;
  manifestGallery = manifest.gallery ?? [];

  console.info(
    `[loader] Manifest loaded. ${manifest.files.length} files listed. ` +
      `Start label: "${manifestStart}". ` +
      `First 3: ${manifest.files.slice(0, 3).join(", ")}`,
  );

  // Load all files in parallel — no ordering dependency now that codegen no
  // longer needs a global charMap / imageMap from script.rrs.
  await Promise.all(manifest.files.map(loadFile));

  const labelCount = labelIndex.size;
  const defineCount = Object.keys(defineVars).length;
  const fileCount = manifest.files.length;

  if (labelCount === 0) {
    console.error(
      `[loader] ⚠️  No labels loaded from ${fileCount} files! ` +
        `Check that manifest.json lists .rrs files and that the assets directory is correct.`,
    );
  } else {
    console.info(
      `[loader] ✓ Loaded ${labelCount} labels and ${defineCount} defines from ${fileCount} files.`,
    );
  }
}

/**
 * Load a single .rrs file, parse it, and register its labels + defines.
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

  if (src.trimStart().startsWith("<!")) {
    console.warn(
      `[loader] ✗ ${filename} — received HTML instead of script text. ` +
        `Check that the dev server middleware / assets directory is correct.`,
    );
    return;
  }

  if (!src.includes("label ")) {
    console.warn(
      `[loader] ✗ ${filename} — content does not look like a .rrs file ` +
        `(no "label " keyword found). First 200 chars: ${src.slice(0, 200)}`,
    );
    return;
  }

  let script: ScriptFile;
  try {
    script = parseScript(src, filename);
  } catch (e) {
    console.warn(`[loader] Parse error in ${filename}:`, e);
    return;
  }

  // Merge this file's defines into the global defineVars dict.
  // Later files win on collision (last-writer-wins, consistent with Ren'Py).
  Object.assign(defineVars, script.defines);

  const newLabels = Object.keys(script.labels);
  if (newLabels.length === 0) {
    console.warn(`[loader] ✗ ${filename} — parsed OK but produced 0 labels`);
    return;
  }

  for (const [label, steps] of Object.entries(script.labels)) {
    if (labelIndex.has(label)) {
      console.warn(
        `[loader] Duplicate label "${label}" in ${filename} – overwriting`,
      );
    }
    labelIndex.set(label, steps as Step[]);
  }
}

/** Return the steps for a given label, or null if unknown. */
export function getLabel(name: string): Step[] | null {
  return labelIndex.get(name) ?? null;
}

/** Return true if the label exists in the index. */
export function hasLabel(name: string): boolean {
  return labelIndex.has(name);
}

/** Return all known label names. */
export function allLabels(): string[] {
  return Array.from(labelIndex.keys());
}

/** Return the list of filenames from the manifest. */
export function getManifestFiles(): string[] {
  return manifestFiles;
}

/** Return the entry-point label name from the manifest (defaults to "start"). */
export function getManifestStart(): string {
  return manifestStart;
}

/** Return the game display name from the manifest, if present. */
export function getManifestGame(): string | undefined {
  return manifestGame;
}

/** Return the gallery entries from the manifest. */
export function getGallery(): GalleryEntry[] {
  return manifestGallery;
}

/**
 * Return the merged defines dict from all loaded .rrs files.
 *
 * This is used by the engine to populate the initial GameState.vars so that
 * every image path, character name and audio alias is available at runtime:
 *   vars["image.bg.entrance_day"] = "BGs/entrance_day.jpg"
 *   vars["char.k"]                = "Keitaro"
 *   vars["audio.bgm_main"]        = "Audio/BGM/main.ogg"
 *   vars["persistent.animations"] = "true"
 */
export function getDefineVars(): Record<string, unknown> {
  return { ...defineVars };
}

/** Clear everything — used in tests / hot-reload scenarios. */
export function reset(): void {
  labelIndex.clear();
  loadedFiles = new Set();
  manifestFiles = [];
  manifestStart = "start";
  manifestGame = undefined;
  manifestGallery = [];
  defineVars = {};
}
