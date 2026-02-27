// ── parse-gallery-core.ts ─────────────────────────────────────────────────────
//
// Pure-function core for parsing gallery_images.rpy.
// No file I/O, no process.argv, no side effects.

export interface GalleryEntry {
  /** Unique scene ID derived from "{charKey}_{groupSegment}", e.g. "char_g1" */
  id: string;
  /**
   * Display name of the character.
   * Derived purely from the image-name prefix: first letter capitalised,
   * rest lower-cased.  No hardcoded name map is used.
   * e.g. raw key "alice" → display name "Alice"
   */
  character: string;
  /**
   * Ordered list of asset paths (relative to the game's images/ directory).
   * e.g. "Animated CGs/char_1/char_1_1.webm"
   */
  frames: string[];
}

/**
 * Parse the contents of gallery_images.rpy and return a list of gallery
 * entries in file-appearance order (one entry per unique charKey_groupSegment).
 *
 * The only assumption made about image names is:
 *   NAME = "{charKey}_{groupSegment}[_{frameId...}]"
 * where charKey and groupSegment are non-empty strings separated by "_".
 * No game-specific names are hardcoded anywhere in this function.
 */
export function parseGalleryRpy(src: string): GalleryEntry[] {
  const lines = src.split("\n");

  // Preserve insertion order; Map key = groupId e.g. "char_g1"
  const groups = new Map<string, GalleryEntry>();

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Match:  image NAME = Movie(play="images/path/file.webm", ...)
    // Handles both double-quoted and single-quoted paths.
    const m = line.match(
      /^image\s+(\S+)\s*=\s*Movie\s*\(\s*play\s*=\s*["']([^"']+)["']/,
    );
    if (!m) continue;

    const imageName = m[1]; // e.g. "char_g1_1" or "char_g6a_10a"
    const rawPath = m[2]; // e.g. "images/Animated CGs/char_1/Char_1_1.webm"

    // Strip the leading "images/" prefix — the asset resolver does not need it.
    const assetPath = rawPath.startsWith("images/")
      ? rawPath.slice("images/".length)
      : rawPath;

    // Split on "_" to extract the two grouping segments.
    // parts[0] = character key  (arbitrary, game-defined, e.g. "alice")
    // parts[1] = group segment  (arbitrary, game-defined, e.g. "g1", "g2a")
    // parts[2+] = frame qualifier(s) — not used for grouping
    const parts = imageName.split("_");
    if (parts.length < 2) continue;

    const charKey = parts[0].toLowerCase();
    const groupSegment = parts[1];
    const groupId = `${charKey}_${groupSegment}`;

    // Derive display name purely from the raw key: capitalise first letter.
    const character = charKey.charAt(0).toUpperCase() + charKey.slice(1);

    if (!groups.has(groupId)) {
      groups.set(groupId, { id: groupId, character, frames: [] });
    }
    groups.get(groupId)!.frames.push(assetPath);
  }

  return Array.from(groups.values());
}
