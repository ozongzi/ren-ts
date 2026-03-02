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
  if (nativePath.startsWith("file://")) {
    nativePath = decodeURIComponent(nativePath.slice(7));
  }
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

// ─── Zip path persistence (Tauri) ─────────────────────────────────────────────

const ZIP_PATH_KEY = "cb_zip_path";

export function getStoredZipPath(): string | null {
  try {
    return localStorage.getItem(ZIP_PATH_KEY);
  } catch {
    return null;
  }
}

export function persistZipPath(p: string): void {
  try {
    localStorage.setItem(ZIP_PATH_KEY, p);
  } catch {
    // localStorage unavailable (private browsing?) — not fatal.
  }
}

export function clearStoredZipPath(): void {
  try {
    localStorage.removeItem(ZIP_PATH_KEY);
  } catch {
    // Ignore localStorage errors — not fatal.
  }
}

// ─── FSA handle persistence (Web, Chrome/Edge only) ──────────────────────────
//
// The File System Access API lets us hold a FileSystemFileHandle that points
// at the user's zip without copying any bytes.  We persist the handle in
// IndexedDB (the only storage that can hold non-serialisable objects like
// FileSystemFileHandle).  On next launch we call requestPermission() to ask
// the browser to re-grant read access — on Chrome this is a silent one-click
// prompt, not a full re-pick.
//
// Firefox and Safari do not support showOpenFilePicker / persistent handles,
// so on those browsers the user must re-pick every session.  We detect support
// with `fsaSupported` and degrade gracefully.

const FSA_DB_NAME = "cb_fsa_store";
const FSA_DB_VERSION = 1;
const FSA_STORE = "handles";
const FSA_KEY = "zip_handle";

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

function openFsaDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FSA_DB_NAME, FSA_DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(FSA_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Persist a FileSystemFileHandle in IndexedDB so we can restore it next
 * launch without asking the user to re-pick the file.
 */
export async function saveFsaHandle(
  handle: FileSystemFileHandle,
): Promise<void> {
  if (!fsaSupported) return;
  try {
    const db = await openFsaDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(FSA_STORE, "readwrite");
      tx.objectStore(FSA_STORE).put(handle, FSA_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn("[tauri_bridge] saveFsaHandle failed:", err);
  }
}

/**
 * Try to restore a previously saved FileSystemFileHandle from IndexedDB and
 * re-request read permission.
 *
 * Returns the File if permission is granted, or null if:
 *   - No handle was stored
 *   - The user denies permission
 *   - The browser doesn't support FSA
 */
export async function loadFsaHandle(): Promise<File | null> {
  if (!fsaSupported) return null;
  try {
    const db = await openFsaDb();
    const handle = await new Promise<FileSystemFileHandle | undefined>(
      (resolve, reject) => {
        const tx = db.transaction(FSA_STORE, "readonly");
        const req = tx.objectStore(FSA_STORE).get(FSA_KEY);
        req.onsuccess = () =>
          resolve(req.result as FileSystemFileHandle | undefined);
        req.onerror = () => reject(req.error);
      },
    );
    db.close();
    if (!handle) return null;

    // Check / request read permission.  On Chrome this is instant if the
    // page was recently used; otherwise it shows a small permission prompt.
    // queryPermission / requestPermission are not yet in lib.dom, so we cast.
    type HandleWithPerm = FileSystemFileHandle & {
      queryPermission: (d: { mode: string }) => Promise<PermissionState>;
      requestPermission: (d: { mode: string }) => Promise<PermissionState>;
    };
    const h = handle as HandleWithPerm;
    const perm = await h.queryPermission({ mode: "read" });
    if (perm === "granted") return handle.getFile();

    const requested = await h.requestPermission({ mode: "read" });
    if (requested === "granted") return handle.getFile();

    return null;
  } catch (err) {
    console.warn("[tauri_bridge] loadFsaHandle failed:", err);
    return null;
  }
}

/**
 * Remove the stored FileSystemFileHandle from IndexedDB (e.g. on unmount).
 */
export async function clearFsaHandle(): Promise<void> {
  if (!fsaSupported) return;
  try {
    const db = await openFsaDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(FSA_STORE, "readwrite");
      tx.objectStore(FSA_STORE).delete(FSA_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Not fatal.
  }
}

/**
 * Open a native file picker for a zip (web only, FSA).
 * Returns the chosen FileSystemFileHandle, or null if cancelled / unsupported.
 */
export async function pickZipFileWeb(): Promise<FileSystemFileHandle | null> {
  if (!fsaSupported) return null;
  try {
    type ShowOpenFilePicker = (
      opts?: Record<string, unknown>,
    ) => Promise<FileSystemFileHandle[]>;
    const picker = (
      window as unknown as { showOpenFilePicker: ShowOpenFilePicker }
    ).showOpenFilePicker;
    const [handle] = await picker({
      types: [
        { description: "ZIP Archive", accept: { "application/zip": [".zip"] } },
      ],
      multiple: false,
    });
    return handle;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return null;
    throw err;
  }
}

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
  } catch {
    // Ignore localStorage errors (e.g. private browsing, storage disabled).
    // We intentionally swallow the error because storing the assets dir is
    // best-effort and should not break app startup.
  }
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

// ─── Tauri plugin helpers (dialog + fs) ──────────────────────────────────────
//
// These thin wrappers import the Tauri plugins lazily so that a tree-shake /
// bundler in non-Tauri builds can eliminate the dead code.

/**
 * Creates a placeholder file in the iOS Documents directory so that
 * the folder becomes visible in the native iOS "Files" app.
 */
export async function ensureIOSDocumentsFolder(dir: string): Promise<void> {
  if (!isIOS) return;
  if (dir.startsWith("file://")) {
    dir = decodeURIComponent(dir.slice(7));
  }
  try {
    const { writeTextFile, exists } = await import("@tauri-apps/plugin-fs");
    const path = `${dir}/请将游戏文件（data, images, Audio等）放在此文件夹下.txt`;
    if (!(await exists(path))) {
      await writeTextFile(
        path,
        "为了在 iOS 上游玩，请将您电脑端的游戏文件（包含 data、images、Audio 等目录）复制到当前文件夹下，然后在应用内点击「从“我的 iPhone”加载」。\n",
      );
    }
  } catch (e) {
    console.warn("[tauri_bridge] Failed to ensure iOS documents folder:", e);
  }
}

/** Get the app's documents directory (useful for iOS where directory picker fails). */
export async function getAppDocumentsDir(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { documentDir } = await import("@tauri-apps/api/path");
    let dir = await documentDir();
    if (dir.startsWith("file://")) {
      dir = decodeURIComponent(dir.slice(7));
    }
    await ensureIOSDocumentsFolder(dir);
    return dir;
  } catch (err) {
    console.warn("[tauri_bridge] getAppDocumentsDir failed:", err);
    return null;
  }
}

/**
 * Open a native file picker restricted to .zip files (Tauri) and return the
 * chosen absolute path, or null if cancelled.
 */
export async function pickZipFileTauri(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({
      directory: false,
      multiple: false,
      title: "选择 assets.zip",
      filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
    });
    if (typeof result === "string") {
      return result.startsWith("file://")
        ? decodeURIComponent(result.slice(7))
        : result;
    }
    return null;
  } catch (err) {
    console.warn("[tauri_bridge] pickZipFileTauri failed:", err);
    return null;
  }
}

/** Open a native directory picker and return the chosen path, or null. */
export async function pickDirectory(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({
      directory: true,
      multiple: false,
      title: "选择游戏 assets 文件夹",
    });
    if (typeof result === "string") {
      return result.startsWith("file://")
        ? decodeURIComponent(result.slice(7))
        : result;
    }
    return null;
  } catch (err) {
    console.warn("[tauri_bridge] pickDirectory failed:", err);
    throw err instanceof Error ? err : new Error(String(err));
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
    const { open } = await import("@tauri-apps/plugin-dialog");
    let filePath = await open({
      multiple: false,
      directory: false,
      title: opts?.title,
      filters: opts?.filters,
    });
    if (typeof filePath !== "string") return null;
    if (filePath.startsWith("file://")) {
      filePath = decodeURIComponent(filePath.slice(7));
    }

    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const text = await readTextFile(filePath);
    return { path: filePath, text };
  } catch (err) {
    console.warn("[tauri_bridge] pickAndReadTextFile failed:", err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Open a native "save file" picker and write text to the chosen path.
 * Returns the chosen path, or null if cancelled.
 */
/**
 * Open a native "Save" dialog and return the chosen file path.
 * Does NOT write anything — the caller is responsible for writing.
 * Returns null if the user cancels or if not running in Tauri.
 */
export async function pickSavePath(opts?: {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    let filePath = await save({
      title: opts?.title,
      defaultPath: opts?.defaultPath,
      filters: opts?.filters,
    });
    if (typeof filePath !== "string") return null;
    if (filePath.startsWith("file://")) {
      filePath = decodeURIComponent(filePath.slice(7));
    }
    return filePath;
  } catch (err) {
    console.warn("[tauri_bridge] pickSavePath failed:", err);
    return null;
  }
}

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
    const { save } = await import("@tauri-apps/plugin-dialog");
    let filePath = await save({
      title: opts?.title,
      defaultPath: opts?.defaultPath,
      filters: opts?.filters,
    });
    if (typeof filePath !== "string") return null;
    if (filePath.startsWith("file://")) {
      filePath = decodeURIComponent(filePath.slice(7));
    }

    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(filePath, text);
    return filePath;
  } catch (err) {
    console.warn("[tauri_bridge] pickAndWriteTextFile failed:", err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Write text to an already-known path (auto-save to previously chosen file).
 */
export async function writeTextFileTauri(
  filePath: string,
  text: string,
): Promise<void> {
  if (filePath.startsWith("file://")) {
    filePath = decodeURIComponent(filePath.slice(7));
  }
  const { writeTextFile } = await import("@tauri-apps/plugin-fs");
  await writeTextFile(filePath, text);
}

// ─── Directory & binary file helpers (used by game-dir batch converter) ───────

export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

/**
 * List the immediate children of a directory.
 * Returns [] if the directory doesn't exist or can't be read.
 */
export async function readDirectory(dirPath: string): Promise<DirEntry[]> {
  if (!isTauri) return [];
  if (dirPath.startsWith("file://")) {
    dirPath = decodeURIComponent(dirPath.slice(7));
  }
  try {
    const { readDir } = await import("@tauri-apps/plugin-fs");
    const entries = await readDir(dirPath);
    return (
      entries as Array<{ name: string; isFile: boolean; isDirectory: boolean }>
    ).map((e) => ({
      name: e.name ?? "",
      isFile: e.isFile,
      isDirectory: e.isDirectory,
    }));
  } catch {
    return [];
  }
}

// ─── TauriFileShim ────────────────────────────────────────────────────────────
//
// A minimal File-API-compatible shim that reads byte ranges from a native
// filesystem path via plugin-fs open/seek/read, without ever loading the
// whole file into JS heap.
//
// ZipFS only uses three members of the File interface:
//   file.size          — total byte length (number)
//   file.name          — display name (string)
//   file.slice(s, e)   — returns a Blob-like whose arrayBuffer() reads [s, e)
//
// This shim satisfies all three with lazy range-reads, making it safe to use
// with ZIP archives that exceed 4 GB.

class TauriSliceBlob {
  constructor(
    private readonly filePath: string,
    private readonly start: number,
    private readonly end: number,
  ) {}

  get size(): number {
    return this.end - this.start;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const len = this.end - this.start;
    if (len <= 0) return new ArrayBuffer(0);
    const { open, SeekMode } = await import("@tauri-apps/plugin-fs");
    const fh = await open(this.filePath, { read: true });
    try {
      await fh.seek(this.start, SeekMode.Start);
      const buf = new Uint8Array(len);
      let bytesRead = 0;
      while (bytesRead < len) {
        const chunk = new Uint8Array(len - bytesRead);
        const n = await fh.read(chunk);
        if (n === null || n === 0) break;
        buf.set(chunk.subarray(0, n), bytesRead);
        bytesRead += n;
      }
      return buf.buffer as ArrayBuffer;
    } finally {
      await fh.close();
    }
  }

  // Required by ZipFS to create Blob URLs for binary assets
  async blob(): Promise<Blob> {
    return new Blob([await this.arrayBuffer()]);
  }
}

/**
 * A File-API-compatible shim that reads a native file by byte ranges.
 * Use this instead of readBinaryFileTauri when dealing with large files
 * (e.g. assets.zip > 4 GB) to avoid loading them entirely into JS heap.
 *
 * Returns null if the file cannot be stat'd (not found / no permission).
 */
export async function openTauriFileShim(filePath: string): Promise<{
  size: number;
  name: string;
  slice: (s: number, e?: number) => TauriSliceBlob;
} | null> {
  if (!isTauri) return null;
  if (filePath.startsWith("file://")) {
    filePath = decodeURIComponent(filePath.slice(7));
  }
  try {
    const { stat } = await import("@tauri-apps/plugin-fs");
    const info = await stat(filePath);
    const size = info.size;
    const name = filePath.split(/[/\\]/).pop() ?? "assets.zip";
    const path = filePath; // capture for closure
    return {
      size,
      name,
      slice(start: number, end?: number) {
        // Mirror Blob.slice() semantics: omitted end means "to end of file"
        return new TauriSliceBlob(path, start, end ?? size);
      },
    };
  } catch {
    return null;
  }
}

/**
 * Read a file as a Uint8Array (binary).  Returns null on error.
 */
export async function readBinaryFileTauri(
  filePath: string,
): Promise<Uint8Array | null> {
  if (!isTauri) return null;
  if (filePath.startsWith("file://")) {
    filePath = decodeURIComponent(filePath.slice(7));
  }
  try {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    return (await readFile(filePath)) as Uint8Array;
  } catch {
    return null;
  }
}

/**
 * Write a Uint8Array to a file path.  Creates parent directories if needed.
 */
export async function writeBinaryFileTauri(
  filePath: string,
  data: Uint8Array,
): Promise<boolean> {
  if (!isTauri) return false;
  if (filePath.startsWith("file://")) {
    filePath = decodeURIComponent(filePath.slice(7));
  }
  try {
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    await writeFile(filePath, data);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a directory (and all parent directories) at the given path.
 */
/**
 * Delete a file at the given native path.
 * Returns true on success, false if the file was not found or could not be deleted.
 */
export async function removeFileTauri(filePath: string): Promise<boolean> {
  if (!isTauri) return false;
  if (filePath.startsWith("file://")) {
    filePath = decodeURIComponent(filePath.slice(7));
  }
  try {
    const { remove } = await import("@tauri-apps/plugin-fs");
    await remove(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function makeDirTauri(dirPath: string): Promise<boolean> {
  if (!isTauri) return false;
  if (dirPath.startsWith("file://")) {
    dirPath = decodeURIComponent(dirPath.slice(7));
  }
  try {
    const { mkdir } = await import("@tauri-apps/plugin-fs");
    await mkdir(dirPath, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a path exists on the filesystem.
 */
export async function pathExists(p: string): Promise<boolean> {
  if (!isTauri) return false;
  if (p.startsWith("file://")) {
    p = decodeURIComponent(p.slice(7));
  }
  try {
    const { exists } = await import("@tauri-apps/plugin-fs");
    return await exists(p);
  } catch {
    return false;
  }
}

/**
 * Read a text file at a known native path.  Returns null on error.
 */
export async function readTextFileTauri(
  filePath: string,
): Promise<string | null> {
  if (!isTauri) return null;
  if (filePath.startsWith("file://")) {
    filePath = decodeURIComponent(filePath.slice(7));
  }
  try {
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    return await readTextFile(filePath);
  } catch {
    return null;
  }
}

/**
 * Recursively collect all file paths under a directory that match a predicate.
 * Returns paths as absolute strings.
 */
export async function walkDir(
  dir: string,
  predicate: (name: string) => boolean,
): Promise<string[]> {
  if (dir.startsWith("file://")) {
    dir = decodeURIComponent(dir.slice(7));
  }
  const results: string[] = [];
  const entries = await readDirectory(dir);
  for (const e of entries) {
    const full = `${dir}/${e.name}`;
    if (e.isFile && predicate(e.name)) {
      results.push(full);
    } else if (e.isDirectory) {
      const nested = await walkDir(full, predicate);
      results.push(...nested);
    }
  }
  return results;
}

// ─── ZIP builder (Rust-backed) ────────────────────────────────────────────────
//
// The actual ZIP work runs in a native Tauri command (`build_zip` in lib.rs).
// No file bytes ever cross the IPC boundary — Rust reads source files and
// writes the output ZIP entirely on the native side.
//
// JS only sends the file list (paths) once, receives a final entry count, and
// listens to lightweight progress events emitted by Rust after each file.
//
// Memory profile: ~128 KiB read buffer inside Rust + ZipWriter state.
// The JS heap stays near zero regardless of archive size.

export interface ZipFileEntry {
  /** Absolute path to read the source file from. */
  absPath: string;
  /** Path stored inside the ZIP archive. */
  zipPath: string;
}

export interface VirtualZipEntry {
  /** UTF-8 text content to write directly into the archive (no disk read). */
  content: string;
  /** Path stored inside the ZIP archive (forward-slash, no leading slash). */
  zipPath: string;
}

export interface StreamingZipProgress {
  /** 0-based index of the file just processed. */
  index: number;
  total: number;
  zipPath: string;
  /** Cumulative uncompressed bytes read so far. */
  bytesWritten: number;
}

/**
 * Build a ZIP archive by invoking the native Rust `build_zip` command.
 *
 * The Rust side reads each source file in 128 KiB chunks and writes directly
 * to the output file — no full-file or full-archive buffers anywhere.
 *
 * Virtual entries (`virtualFiles`) are in-memory text entries passed directly
 * to Rust via IPC. They are written into the archive without ever being saved
 * to disk, so no write-path permission is required for them.
 *
 * @param outputPath    Absolute path where the ZIP will be written.
 * @param files         Ordered list of {absPath, zipPath} disk entries.
 * @param onProgress    Optional callback invoked after each entry is written.
 * @param onSkip        Optional callback when a disk file could not be read.
 * @param virtualFiles  Optional list of in-memory text entries to append.
 * @returns             Total number of entries successfully written.
 */
export async function streamingBuildZip(
  outputPath: string,
  files: ZipFileEntry[],
  onProgress?: (p: StreamingZipProgress) => void,
  onSkip?: (absPath: string, zipPath: string) => void,
  virtualFiles?: VirtualZipEntry[],
): Promise<number> {
  if (!isTauri) throw new Error("streamingBuildZip requires a Tauri context");

  if (outputPath.startsWith("file://")) {
    outputPath = decodeURIComponent(outputPath.slice(7));
  }

  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  // Normalise entry paths (strip file:// prefix if present).
  const normalisedFiles = files.map((f) => ({
    abs_path: f.absPath.startsWith("file://")
      ? decodeURIComponent(f.absPath.slice(7))
      : f.absPath,
    zip_path: f.zipPath,
  }));

  // Subscribe to per-file progress events emitted by Rust.
  type RustProgress = {
    index: number;
    total: number;
    zip_path: string;
    bytes_written: number;
  };
  type RustSkip = { abs_path: string; zip_path: string; reason: string };

  const unlistenProgress = onProgress
    ? await listen<RustProgress>("zip://progress", (ev) => {
        onProgress({
          index: ev.payload.index,
          total: ev.payload.total,
          zipPath: ev.payload.zip_path,
          bytesWritten: ev.payload.bytes_written,
        });
      })
    : null;

  const unlistenSkip = onSkip
    ? await listen<RustSkip>("zip://skip", (ev) => {
        onSkip(ev.payload.abs_path, ev.payload.zip_path);
      })
    : null;

  try {
    const written = await invoke<number>("build_zip", {
      outputPath,
      entries: normalisedFiles,
      virtualEntries:
        virtualFiles && virtualFiles.length > 0
          ? virtualFiles.map((v) => ({
              content: v.content,
              zip_path: v.zipPath,
            }))
          : null,
    });
    return written;
  } finally {
    unlistenProgress?.();
    unlistenSkip?.();
  }
}
