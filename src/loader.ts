import type { Step, ScriptFile, Manifest, GalleryEntry } from "./types";
import { parseScript } from "../rrs/index";
import { getFs } from "./filesystem";
import { registerPosition } from "./assets";

// ─── Data file reader (module-level, no state) ────────────────────────────────

async function readDataFile(filename: string): Promise<string> {
  return getFs().readText(`data/${filename}`);
}

// ─── GameData class ───────────────────────────────────────────────────────────
//
// Encapsulates all loader state so that:
//   - Tests can create isolated instances without calling reset().
//   - The module has no mutable top-level variables.
//   - The default singleton (below) preserves the existing function-export API.

export class GameData {
  private _labelIndex: Map<string, Step[]> = new Map();
  private _loadedFiles: Set<string> = new Set();
  private _manifestFiles: string[] = [];
  private _manifestStart: string = "start";
  private _manifestGame: string | undefined = undefined;
  private _manifestGallery: GalleryEntry[] = [];
  private _defineVars: Record<string, unknown> = {};

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Load the manifest and eagerly parse all .rrs files.
   * All top-level defines from every file are merged into defineVars.
   * All labels from every file are registered in labelIndex.
   */
  async loadAll(): Promise<void> {
    const manifestText = await readDataFile("manifest.json");

    let manifest: Manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch (e) {
      throw new Error("[loader] Failed to parse manifest.json", { cause: e });
    }

    this._manifestFiles = manifest.files;
    this._manifestStart = manifest.start ?? "start";
    this._manifestGame = manifest.game;
    this._manifestGallery = manifest.gallery ?? [];

    console.info(
      `[loader] Manifest loaded. ${manifest.files.length} files listed. ` +
        `Start label: "${this._manifestStart}". ` +
        `First 3: ${manifest.files.slice(0, 3).join(", ")}`,
    );

    // Load all files in parallel — no ordering dependency.
    await Promise.all(manifest.files.map((f) => this.loadFile(f)));

    // Register runtime positions from merged define vars.
    for (const [k, v] of Object.entries(this._defineVars)) {
      if (!k.startsWith("position.")) continue;
      const name = k.slice("position.".length);
      const raw = v as unknown;
      const n = typeof raw === "number" ? raw : Number(String(raw));
      if (!Number.isNaN(n)) {
        registerPosition(name, Number(n));
      }
    }

    const labelCount = this._labelIndex.size;
    const defineCount = Object.keys(this._defineVars).length;
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
  async loadFile(filename: string): Promise<void> {
    if (this._loadedFiles.has(filename)) return;
    this._loadedFiles.add(filename);

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

    if (!src.includes("label ") && !src.includes(" = ")) {
      console.warn(
        `[loader] ✗ ${filename} — content does not look like a .rrs file ` +
          `(no "label " or assignments found). First 200 chars: ${src.slice(0, 200)}`,
      );
      return;
    }

    let script: ScriptFile;
    try {
      const json = parseScript(src, filename);
      script = {
        source: json.source,
        defines: json.defines as Record<string, unknown>,
        labels: json.labels as Record<string, Step[]>,
      };
    } catch (e) {
      console.warn(`[loader] Parse error in ${filename}:`, e);
      return;
    }

    // Merge defines — later files win on collision (consistent with Ren'Py).
    Object.assign(this._defineVars, script.defines);

    const newLabels = Object.keys(script.labels);
    if (newLabels.length === 0) {
      // defines-only file (e.g. definitions.rrs) — that's fine, defines were merged above.
      return;
    }

    for (const [label, steps] of Object.entries(script.labels)) {
      if (this._labelIndex.has(label)) {
        console.warn(
          `[loader] Duplicate label "${label}" in ${filename} – overwriting`,
        );
      }
      this._labelIndex.set(label, steps as Step[]);
    }
  }

  /** Return the steps for a given label, or null if unknown. */
  getLabel(name: string): Step[] | null {
    return this._labelIndex.get(name) ?? null;
  }

  /** Return true if the label exists in the index. */
  hasLabel(name: string): boolean {
    return this._labelIndex.has(name);
  }

  /** Return all known label names. */
  allLabels(): string[] {
    return Array.from(this._labelIndex.keys());
  }

  /** Return the list of filenames from the manifest. */
  getManifestFiles(): string[] {
    return this._manifestFiles;
  }

  /** Return the entry-point label name from the manifest (defaults to "start"). */
  getManifestStart(): string {
    return this._manifestStart;
  }

  /** Return the game display name from the manifest, if present. */
  getManifestGame(): string | undefined {
    return this._manifestGame;
  }

  /** Return the gallery entries from the manifest. */
  getGallery(): GalleryEntry[] {
    return this._manifestGallery;
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
  getDefineVars(): Record<string, unknown> {
    return { ...this._defineVars };
  }

  /** Reset all state — useful in tests to get a clean instance. */
  reset(): void {
    this._labelIndex.clear();
    this._loadedFiles = new Set();
    this._manifestFiles = [];
    this._manifestStart = "start";
    this._manifestGame = undefined;
    this._manifestGallery = [];
    this._defineVars = {};
  }
}

// ─── Default singleton + backward-compatible function exports ─────────────────
//
// All existing callers (engine.ts, store, tests) import the named functions
// directly — those continue to work unchanged via these thin wrappers.
// New code that needs an isolated instance (e.g. tests) can do `new GameData()`.

export const defaultGameData = new GameData();

export async function loadAll(): Promise<void> {
  return defaultGameData.loadAll();
}

export async function loadFile(filename: string): Promise<void> {
  return defaultGameData.loadFile(filename);
}

export function getLabel(name: string): Step[] | null {
  return defaultGameData.getLabel(name);
}

export function hasLabel(name: string): boolean {
  return defaultGameData.hasLabel(name);
}

export function allLabels(): string[] {
  return defaultGameData.allLabels();
}

export function getManifestFiles(): string[] {
  return defaultGameData.getManifestFiles();
}

export function getManifestStart(): string {
  return defaultGameData.getManifestStart();
}

export function getManifestGame(): string | undefined {
  return defaultGameData.getManifestGame();
}

export function getGallery(): GalleryEntry[] {
  return defaultGameData.getGallery();
}

export function getDefineVars(): Record<string, unknown> {
  return defaultGameData.getDefineVars();
}

/** @deprecated Use `new GameData()` in tests instead of resetting the singleton. */
export function reset(): void {
  defaultGameData.reset();
}
