// ── scan-assets-core.ts ───────────────────────────────────────────────────────
//
// Pure functions for scanning a directory tree of asset files and generating
// the corresponding `image.XX = "path"` define lines in .rrs format.
//
// Design notes:
//   • No I/O here — callers supply the list of file paths (relative to some
//     root) so this module stays testable and environment-agnostic.
//   • The generated key follows Ren'Py conventions:
//       filename without extension → lowercased, spaces → underscores
//     e.g. "BGs/cabin_day.jpg"  →  image.cabin_day = "BGs/cabin_day.jpg";
//          "Sprites/Keitaro Normal1.png" → image.keitaro_normal1 = "...";
//   • Only image file extensions are recognised (see IMAGE_EXTENSIONS).
//   • Paths are expected to be forward-slash separated and relative to the
//     assets root that the engine uses at runtime (e.g. "images/BGs/foo.jpg").
//   • Duplicate keys (two files that map to the same identifier) are detected
//     and reported via the returned `conflicts` list; the first file wins.

// ── Constants ─────────────────────────────────────────────────────────────────

/** File extensions that are treated as images. Lower-case, dot-prefixed. */
export const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".bmp",
  ".webm", // animated CG videos treated as image defines (same as Ren'Py Movie)
  ".mp4",
]);

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Returns true when `filePath` points to an image / animated-CG file,
 * based solely on its extension.
 *
 * The path may be absolute or relative; only the extension portion matters.
 *
 * @example
 *   isImagePath("BGs/cabin_day.jpg")   // → true
 *   isImagePath("Audio/BGM/foo.ogg")   // → false
 *   isImagePath("yoichi_1_1.webm")     // → true
 */
export function isImagePath(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return false;
  const ext = filePath.slice(dot).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Derive the RRS image key from a file path.
 *
 * Rules (applied to the basename without extension):
 *   1. Lower-case the whole string.
 *   2. Replace any run of non-alphanumeric characters (spaces, hyphens,
 *      dots inside the name, etc.) with a single underscore.
 *   3. Strip leading / trailing underscores.
 *
 * @example
 *   imageKeyFromPath("BGs/cabin_day.jpg")          // → "cabin_day"
 *   imageKeyFromPath("Sprites/Keitaro Normal1.png") // → "keitaro_normal1"
 *   imageKeyFromPath("Yoichi_1_12_idle.webm")       // → "yoichi_1_12_idle"
 */
export function imageKeyFromPath(filePath: string): string {
  // Grab just the filename portion
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const basename = slash === -1 ? filePath : filePath.slice(slash + 1);

  // Strip extension
  const dot = basename.lastIndexOf(".");
  const stem = dot === -1 ? basename : basename.slice(0, dot);

  // Normalise to snake_case identifier
  return stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_") // non-alnum runs → single underscore
    .replace(/^_+|_+$/g, ""); // strip leading/trailing underscores
}

/**
 * Escape a path string for embedding in a double-quoted RRS string literal.
 * Only backslashes and double-quotes need escaping.
 */
function escapeRrsString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ── Main API ──────────────────────────────────────────────────────────────────

/** A single resolved image define. */
export interface ImageDefine {
  /** The RRS key, e.g. `"cabin_day"` (without the `image.` prefix). */
  key: string;
  /**
   * The path as it should appear in the define value — relative to the assets
   * root (the same directory the engine resolves assets from at runtime).
   * e.g. `"images/BGs/cabin_day.jpg"` or `"BGs/cabin_day.jpg"` depending on
   * how the caller normalises paths before passing them in.
   */
  path: string;
}

/** Returned by `generateImageDefines`. */
export interface ScanResult {
  /** All successfully generated defines, in the order they were processed. */
  defines: ImageDefine[];
  /**
   * Keys that were produced by more than one path.
   * The first file encountered wins and is included in `defines`; subsequent
   * files for the same key are listed here so callers can warn the user.
   */
  conflicts: Array<{ key: string; winner: string; loser: string }>;
  /** Paths that were skipped because they are not image files. */
  skipped: string[];
}

/**
 * Given a list of file paths (relative to some assets root), generate image
 * defines for every file that `isImagePath` recognises.
 *
 * @param filePaths  List of relative paths, e.g. `["BGs/cabin_day.jpg", …]`.
 *                   Forward-slashes expected; the function also tolerates
 *                   back-slashes (Windows) by normalising them first.
 *
 * @returns A `ScanResult` with the defines, any key conflicts, and skipped paths.
 *
 * @example
 *   const { defines } = generateImageDefines([
 *     "BGs/cabin_day.jpg",
 *     "Animated CGs/yoichi_1/Yoichi_1_1.webm",
 *   ]);
 *   // defines[0] → { key: "cabin_day",   path: "BGs/cabin_day.jpg" }
 *   // defines[1] → { key: "yoichi_1_1",  path: "Animated CGs/yoichi_1/Yoichi_1_1.webm" }
 */
export function generateImageDefines(filePaths: string[]): ScanResult {
  const defines: ImageDefine[] = [];
  const conflicts: ScanResult["conflicts"] = [];
  const skipped: string[] = [];
  const seen = new Map<string, string>(); // key → first path that claimed it

  for (const raw of filePaths) {
    // Normalise separators
    const p = raw.replace(/\\/g, "/");

    if (!isImagePath(p)) {
      skipped.push(p);
      continue;
    }

    const key = imageKeyFromPath(p);
    if (!key) {
      // Degenerate filename (e.g. ".jpg") — skip
      skipped.push(p);
      continue;
    }

    if (seen.has(key)) {
      conflicts.push({ key, winner: seen.get(key)!, loser: p });
      continue;
    }

    seen.set(key, p);
    defines.push({ key, path: p });
  }

  return { defines, conflicts, skipped };
}

/**
 * Render a `ScanResult` as a block of RRS source text.
 *
 * Each define becomes one line:
 *   `image.cabin_day = "BGs/cabin_day.jpg";`
 *
 * An optional header comment can be prepended (pass `null` to omit it).
 *
 * @param result       Output of `generateImageDefines`.
 * @param headerComment  If provided, emitted as a `// …` comment before the defines.
 *                       Pass `null` to skip the header entirely.
 */
export function renderDefinesBlock(
  result: ScanResult,
  headerComment: string | null = "// Auto-generated image defines — do not edit manually",
): string {
  if (result.defines.length === 0) return "";

  const lines: string[] = [];
  if (headerComment !== null) {
    lines.push(headerComment);
  }
  for (const d of result.defines) {
    lines.push(`image.${d.key} = "${escapeRrsString(d.path)}";`);
  }
  // Trailing newline
  lines.push("");
  return lines.join("\n");
}

/**
 * Convenience: given a flat list of file paths, return a ready-to-use RRS
 * source block containing all image defines for those paths.
 *
 * Equivalent to calling `generateImageDefines` then `renderDefinesBlock`.
 *
 * @param filePaths     Relative paths (as described in `generateImageDefines`).
 * @param headerComment Forwarded to `renderDefinesBlock`.
 */
export function buildDefinesRrs(
  filePaths: string[],
  headerComment: string | null = "// Auto-generated image defines — do not edit manually",
): string {
  const result = generateImageDefines(filePaths);
  return renderDefinesBlock(result, headerComment);
}
