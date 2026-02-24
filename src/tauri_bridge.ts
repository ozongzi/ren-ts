// ─── Tauri Bridge ─────────────────────────────────────────────────────────────
//
// Thin layer between the React app and the Tauri v2 runtime.
//
// Responsibilities:
//   1. Detect whether we are running inside a Tauri WebView.
//   2. Lazily initialise `convertFileSrc` from @tauri-apps/api/core so that
//      asset URLs can be resolved synchronously after the bridge is ready.
//   3. Persist the user-selected assets directory in localStorage.
//   4. Build native asset paths for images and audio.
//
// Usage:
//   // In main.tsx, before rendering React:
//   await initTauriBridge();
//
//   // Everywhere else (synchronous):
//   if (isTauri) { ... convertFileSrcSync(path) ... }

// ─── Tauri detection ──────────────────────────────────────────────────────────

/**
 * True when the page is running inside a Tauri v2 WebView.
 * Tauri injects `__TAURI_INTERNALS__` into the window object before the page
 * script runs, so this check is safe to evaluate at module load time.
 */
export const isTauri: boolean =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ─── convertFileSrc ───────────────────────────────────────────────────────────

/**
 * Synchronous wrapper around Tauri's `convertFileSrc`.
 *
 * Tauri's `convertFileSrc` converts a native filesystem path like
 *   /Users/alice/assets/images/BGs/bg_arrival.jpg
 * into an `asset://` URL that the WebView is allowed to load:
 *   asset://localhost/%2FUsers%2Falice%2Fassets%2Fimages%2FBGs%2Fbg_arrival.jpg
 *
 * It is synchronous once loaded.  Call `initTauriBridge()` first.
 */
let _convertFileSrc: ((filePath: string, protocol?: string) => string) | null =
  null;

/**
 * Initialise the Tauri bridge.  Must be awaited once before the React tree
 * mounts so that `convertFileSrcSync` works synchronously from that point on.
 *
 * Safe to call in a non-Tauri context — it becomes a no-op.
 */
export async function initTauriBridge(): Promise<void> {
  if (!isTauri) return;
  try {
    // deno-ignore-next-line -- resolved by Vite at build time; not visible to Deno LSP
    // @ts-ignore
    const mod = await import("@tauri-apps/api/core");
    _convertFileSrc = mod.convertFileSrc;
  } catch (err) {
    console.warn("[tauri_bridge] Failed to load @tauri-apps/api/core:", err);
  }
}

/**
 * Convert a native path to an `asset://` URL synchronously.
 *
 * Falls back to returning the path unchanged if:
 *  - we are not in Tauri, or
 *  - `initTauriBridge()` has not yet been called.
 */
export function convertFileSrcSync(nativePath: string): string {
  if (_convertFileSrc) return _convertFileSrc(nativePath);
  return nativePath;
}

// ─── Assets directory persistence ─────────────────────────────────────────────
//
// The user selects their `assets/` folder once via a directory picker dialog.
// We persist the chosen path in localStorage so it survives app restarts.
//
// Layout assumed inside the chosen directory:
//   <assetsDir>/
//     images/         ← BGs, CGs, Sprites, UI, FX, …
//     Audio/          ← Audio/BGM, Audio/SFX, Audio/Voice
//     videos/         ← *.webm animated CGs  (optional)

const ASSETS_DIR_KEY = "cb_assets_dir";

/** Return the stored assets directory path, or null if none has been chosen. */
export function getStoredAssetsDir(): string | null {
  try {
    return localStorage.getItem(ASSETS_DIR_KEY);
  } catch {
    return null;
  }
}

/** Persist the chosen assets directory path to localStorage. */
export function persistAssetsDir(dir: string): void {
  try {
    localStorage.setItem(ASSETS_DIR_KEY, dir);
  } catch {
    // localStorage unavailable (private browsing?) — not fatal.
  }
}

/** Remove the stored assets directory (e.g. if the user wants to reselect). */
export function clearStoredAssetsDir(): void {
  try {
    localStorage.removeItem(ASSETS_DIR_KEY);
  } catch {}
}

// ─── In-memory active assets directory ───────────────────────────────────────
//
// `resolveAsset` in assets.ts needs a synchronous, zero-argument way to get
// the current assetsDir.  We keep a module-level copy that is set by the
// store when assetsDir changes.

let _activeAssetsDir: string | null = null;

/** Get the currently active assets directory (may be null). */
export function getActiveAssetsDir(): string | null {
  return _activeAssetsDir;
}

/**
 * Set the currently active assets directory.
 * Called by the store whenever `assetsDir` changes, e.g. after the user picks
 * a directory or after the stored path is rehydrated on startup.
 */
export function setActiveAssetsDir(dir: string | null): void {
  _activeAssetsDir = dir;
}

// ─── Native path builders ──────────────────────────────────────────────────────

/**
 * Build the native filesystem path for an image asset.
 *
 * @param assetsDir  Absolute path chosen by the user, e.g. "/Users/alice/cb_assets"
 * @param src        Relative asset path from the JSON script, e.g. "BGs/bg_arrival.jpg"
 * @returns          Absolute path, e.g. "/Users/alice/cb_assets/images/BGs/bg_arrival.jpg"
 */
export function buildNativeImagePath(assetsDir: string, src: string): string {
  // Strip any leading slash from src (defensive)
  const rel = src.startsWith("/") ? src.slice(1) : src;
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

// ─── Tauri plugin helpers (dialog + fs) ──────────────────────────────────────
//
// These thin wrappers import the Tauri plugins lazily so that a tree-shake /
// bundler in non-Tauri builds can eliminate the dead code.

/** Open a native directory picker and return the chosen path, or null. */
export async function pickDirectory(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    // @ts-ignore -- resolved by Vite; not visible to Deno LSP
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({
      directory: true,
      multiple: false,
      title: "选择游戏 assets 文件夹",
    });
    if (typeof result === "string") return result;
    return null;
  } catch (err) {
    // User cancelled → DismissedError; treat as null
    console.warn("[tauri_bridge] pickDirectory cancelled or failed:", err);
    return null;
  }
}

/**
 * Open a native "open file" picker and return the chosen path + text content.
 * Returns null if the user cancels.
 */
export async function pickAndReadTextFile(opts?: {
  title?: string;
  filters?: { name: string; extensions: string[] }[];
}): Promise<{ path: string; text: string } | null> {
  if (!isTauri) return null;
  try {
    // @ts-ignore -- resolved by Vite; not visible to Deno LSP
    const { open } = await import("@tauri-apps/plugin-dialog");
    const filePath = await open({
      multiple: false,
      directory: false,
      title: opts?.title,
      filters: opts?.filters,
    });
    if (typeof filePath !== "string") return null;

    // @ts-ignore -- resolved by Vite; not visible to Deno LSP
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const text = await readTextFile(filePath);
    return { path: filePath, text };
  } catch (err) {
    console.warn("[tauri_bridge] pickAndReadTextFile failed:", err);
    return null;
  }
}

/**
 * Open a native "save file" picker and write text to the chosen path.
 * Returns the chosen path, or null if cancelled.
 */
export async function pickAndWriteTextFile(
  text: string,
  opts?: {
    title?: string;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  },
): Promise<string | null> {
  if (!isTauri) return null;
  try {
    // @ts-ignore -- resolved by Vite; not visible to Deno LSP
    const { save } = await import("@tauri-apps/plugin-dialog");
    const filePath = await save({
      title: opts?.title,
      defaultPath: opts?.defaultPath,
      filters: opts?.filters,
    });
    if (typeof filePath !== "string") return null;

    // @ts-ignore -- resolved by Vite; not visible to Deno LSP
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(filePath, text);
    return filePath;
  } catch (err) {
    console.warn("[tauri_bridge] pickAndWriteTextFile failed:", err);
    return null;
  }
}

/**
 * Write text to an already-known path (auto-save to previously chosen file).
 */
export async function writeTextFileTauri(
  filePath: string,
  text: string,
): Promise<void> {
  // @ts-ignore -- resolved by Vite; not visible to Deno LSP
  const { writeTextFile } = await import("@tauri-apps/plugin-fs");
  await writeTextFile(filePath, text);
}
