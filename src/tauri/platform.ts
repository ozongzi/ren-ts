// ─── Platform / environment detection ────────────────────────────────────────
//
// Single source of truth for "what runtime are we in?".
// Import this module instead of sniffing the UA or window globals elsewhere.

/**
 * True when the page is running inside a Tauri v2 WebView.
 * Tauri injects `__TAURI_INTERNALS__` into the window object before the page
 * script runs, so this check is safe to evaluate at module load time.
 */
export const isTauri: boolean =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** True if we are running in a mobile environment (iOS or Android). */
export const isMobile: boolean =
  typeof navigator !== "undefined" &&
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent,
  );

/** True if we are running specifically on iOS. */
export const isIOS: boolean =
  typeof navigator !== "undefined" &&
  (/iPad|iPhone|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/** True when the browser supports the File System Access API (Chrome/Edge). */
export const fsaSupported: boolean =
  !isTauri && typeof window !== "undefined" && "showOpenFilePicker" in window;

/**
 * True when the current platform supports the conversion tools (rpy → rrs).
 *
 * Requirements:
 *  - Tauri desktop: full filesystem access via plugin-fs / plugin-dialog.
 *  - Web (Chrome/Edge): File System Access API available — allows the user to
 *    pick a game directory handle and read/write files through it.
 *
 * Returns false on Firefox, Safari, iOS, and any other environment that lacks
 * the necessary filesystem APIs.  In those cases the Tools button should be
 * hidden or show an "unsupported" notice instead of silently doing nothing.
 */
export const supportsConversionTools: boolean = isTauri || fsaSupported;

// ─── convertFileSrc ───────────────────────────────────────────────────────────
//
// Tauri's `convertFileSrc` converts a native filesystem path like
//   /Users/alice/assets/images/BGs/bg_arrival.jpg
// into an `asset://` URL that the WebView is allowed to load:
//   asset://localhost/%2FUsers%2Falice%2Fassets%2Fimages%2FBGs%2Fbg_arrival.jpg
//
// It is synchronous once the module is loaded.  Call `initPlatform()` once
// before using `convertFileSrcSync`.

let _convertFileSrc: ((filePath: string, protocol?: string) => string) | null =
  null;

/**
 * Initialise the Tauri bridge.  Must be awaited once before the React tree
 * mounts so that `convertFileSrcSync` works synchronously from that point on.
 *
 * Safe to call in a non-Tauri context — it becomes a no-op.
 */
export async function initPlatform(): Promise<void> {
  if (!isTauri) return;
  try {
    const mod = await import("@tauri-apps/api/core");
    _convertFileSrc = mod.convertFileSrc;
  } catch (err) {
    console.warn("[platform] Failed to load @tauri-apps/api/core:", err);
  }
}

/**
 * Convert a native path to an `asset://` URL synchronously.
 *
 * Falls back to returning the path unchanged if:
 *  - we are not in Tauri, or
 *  - `initPlatform()` has not yet been called.
 */
export function convertFileSrcSync(nativePath: string): string {
  if (nativePath.startsWith("file://")) {
    nativePath = decodeURIComponent(nativePath.slice(7));
  }
  if (_convertFileSrc) return _convertFileSrc(nativePath);
  return nativePath;
}

// ─── Native path builders ─────────────────────────────────────────────────────

/**
 * Build the native filesystem path for an image asset.
 *
 * @param assetsDir  Absolute path chosen by the user, e.g. "/Users/alice/cb_assets"
 * @param src        Relative asset path from the JSON script, e.g. "BGs/bg_arrival.jpg"
 * @returns          Absolute path, e.g. "/Users/alice/cb_assets/images/BGs/bg_arrival.jpg"
 */
export function buildNativeImagePath(assetsDir: string, src: string): string {
  let rel = src.startsWith("/") ? src.slice(1) : src;
  // Some verbatim .rpy paths already include the "images/" segment; strip it
  // before prepending so we never produce a double "images/images/" prefix.
  if (rel.startsWith("images/")) rel = rel.slice("images/".length);
  return `${assetsDir}/images/${rel}`;
}

/**
 * Build the native filesystem path for an audio asset.
 *
 * @param assetsDir  Absolute path chosen by the user
 * @param src        Relative audio path, e.g. "Audio/BGM/Outdoors.ogg"
 * @returns          Absolute path, e.g. "/Users/alice/cb_assets/Audio/BGM/Outdoors.ogg"
 */
export function buildNativeAudioPath(assetsDir: string, src: string): string {
  const rel = src.startsWith("/") ? src.slice(1) : src;
  return `${assetsDir}/${rel}`;
}
