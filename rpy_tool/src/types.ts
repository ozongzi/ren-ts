/**
 * Types used by the rpy_tool implementation.
 *
 * This file contains lightweight structural types describing:
 * - translation mode selection
 * - walk results (scripts, assets, tl files, gallery files)
 * - gallery entries (as produced by parseGalleryRpy)
 * - manifest format that will be written to data/manifest.json
 */

export type TranslationMode = "none" | "json" | "tl";

/**
 * Gallery entry as returned by parseGalleryRpy and written into manifest.json.
 */
export interface GalleryEntry {
  /** Unique scene id e.g. "char_g1" */
  id: string;
  /** Display name derived from char key (e.g. "Alice") */
  character: string;
  /** Ordered list of asset paths relative to the images/ directory */
  frames: string[];
}

/**
 * Single .rpy script discovered during walk (plain-text).
 */
export interface WalkScriptRpy {
  kind: "rpy";
  /** Relative path inside the game's root (e.g. "scripts/day1.rpy") */
  relPath: string;
  content: string;
}

/**
 * Single .rpyc script discovered during walk (binary).
 */
export interface WalkScriptRpyc {
  kind: "rpyc";
  relPath: string;
  bytes: Uint8Array;
}

export type WalkScript = WalkScriptRpy | WalkScriptRpyc;

/**
 * Asset discovered during walk. `getBytes` is a lazy async reader so the
 * walker can enumerate without forcing large buffers to live in memory.
 */
export interface WalkAsset {
  /** Relative path inside the game's root, e.g. "images/BGs/cabin.jpg" */
  path: string;
  /** Read the asset bytes (may come from disk, zip or rpa) */
  getBytes: () => Promise<Uint8Array>;
}

/**
 * Result returned by the walker.
 */
export interface WalkResult {
  /** Discovered scripts (.rpy and .rpyc). Order is discovery order. */
  scripts: WalkScript[];
  /** Discovered assets (images/audio/video...). Each asset should be written immediately to the output zip. */
  assets: WalkAsset[];
  /** Translation source files found under the configured tl directory. */
  tlFiles: Array<{ path: string; content: string }>;
  /** Gallery files (matching configured gallery filename). Also these files should be converted as scripts. */
  galleryFiles: Array<{ path: string; content: string }>;
}

/**
 * Manifest format to be written to data/manifest.json
 * - files: list of emitted .rrs filenames (basenames only, no directories)
 * - gallery: aggregated GalleryEntry[] produced from gallery rpy files
 */
export interface OutputManifest {
  files: string[];
  gallery: GalleryEntry[];
}
