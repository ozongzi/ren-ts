// Utility helpers for rpy_tool
// Small, self-contained functions used by the walker / converter / zip writer.

export function normalizePath(p: string): string {
  // Convert backslashes to forward slashes and collapse duplicate slashes.
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

/**
 * Return the basename (filename portion) of a path.
 * Examples:
 *   basename("a/b/c.txt") -> "c.txt"
 *   basename("foo") -> "foo"
 */
export function basename(path: string): string {
  const p = path.replace(/\\/g, "/");
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

/**
 * Strip the extension from a file name (the last dot and following chars).
 * If no dot present, returns the original string.
 *
 * Examples:
 *   stripExt("day1.rpy") -> "day1"
 *   stripExt("archive.tar.gz") -> "archive.tar"
 */
export function stripExt(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? name : name.slice(0, idx);
}

/** Encode a string to UTF-8 bytes. */
export function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Decode UTF-8 bytes to string. */
export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

// Extension checks (case-insensitive). Kept compact and easy to extend.
const IMAGE_RE = /\.(jpg|jpeg|png|webp|gif|bmp|webm|mp4)$/i;
const AUDIO_RE = /\.(ogg|mp3|wav|flac|aac)$/i;
const VIDEO_RE = /\.(webm|mp4|ogv|mkv)$/i;

/** Return true when the path looks like an image file. */
export function isImagePath(p: string): boolean {
  return IMAGE_RE.test(p);
}

/** Return true when the path looks like an audio file. */
export function isAudioPath(p: string): boolean {
  return AUDIO_RE.test(p);
}

/** Return true when the path looks like a video file. */
export function isVideoPath(p: string): boolean {
  return VIDEO_RE.test(p);
}

/** Return true when the path looks like any typical asset (image/audio/video). */
export function isAssetPath(p: string): boolean {
  return isImagePath(p) || isAudioPath(p) || isVideoPath(p);
}

/**
 * Ensure a filename is safe as a ZIP entry name by removing leading slashes
 * and collapsing backslashes. This does not attempt to sanitise malicious
 * filenames beyond normalising separators.
 */
export function safeZipPath(p: string): string {
  let s = p.replace(/\\/g, "/");
  // Remove leading slash to ensure relative path within zip
  s = s.replace(/^\/+/, "");
  // Collapse ../ segments for safety (simple approach)
  // Note: we do not fully resolve absolute traversal here; caller should avoid untrusted input.
  while (s.indexOf("/../") !== -1) {
    s = s.replace(/(^|\/)[^\/]+\/\.\.\//, "$1");
  }
  return s;
}
