// ─── Tauri filesystem helpers ─────────────────────────────────────────────────
//
// Thin wrappers around @tauri-apps/plugin-fs and @tauri-apps/plugin-dialog.
// All imports are lazy so that bundlers can tree-shake this module out of
// web-only builds.
//
// Path normalisation: every exported function strips a leading "file://" from
// its path arguments so callers don't have to worry about URL vs native form.

import { isTauri, isIOS } from "./platform";

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Strip a leading `file://` scheme and percent-decode the remainder. */
function normPath(p: string): string {
  return p.startsWith("file://") ? decodeURIComponent(p.slice(7)) : p;
}

// ─── Persistence (assets dir + zip path) ─────────────────────────────────────
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

export function getStoredAssetsDir(): string | null {
  try {
    return localStorage.getItem(ASSETS_DIR_KEY);
  } catch {
    return null;
  }
}

export function persistAssetsDir(dir: string): void {
  try {
    localStorage.setItem(ASSETS_DIR_KEY, dir);
  } catch {
    // localStorage unavailable (private browsing?) — not fatal.
  }
}

export function clearStoredAssetsDir(): void {
  try {
    localStorage.removeItem(ASSETS_DIR_KEY);
  } catch {
    // Ignore localStorage errors — not fatal.
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
 * Called by the store whenever `assetsDir` changes.
 */
export function setActiveAssetsDir(dir: string | null): void {
  _activeAssetsDir = dir;
}

// ─── iOS Documents folder ─────────────────────────────────────────────────────

/**
 * Creates a placeholder file in the iOS Documents directory so that
 * the folder becomes visible in the native iOS "Files" app.
 */
export async function ensureIOSDocumentsFolder(dir: string): Promise<void> {
  if (!isIOS) return;
  dir = normPath(dir);
  try {
    const { writeTextFile, exists } = await import("@tauri-apps/plugin-fs");
    const path = `${dir}/请将游戏文件（data, images, Audio等）放在此文件夹下.txt`;
    if (!(await exists(path))) {
      await writeTextFile(
        path,
        "为了在 iOS 上游玩，请将您电脑端的游戏文件（包含 data、images、Audio 等目录）复制到当前文件夹下，然后在应用内点击「从\u{201C}我的 iPhone\u{201D}加载」。\n",
      );
    }
  } catch (e) {
    console.warn("[tauri/fs] Failed to ensure iOS documents folder:", e);
  }
}

/** Get the app's documents directory (useful for iOS where directory picker fails). */
export async function getAppDocumentsDir(): Promise<string | null> {
  if (!isTauri) return null;
  try {
    const { documentDir } = await import("@tauri-apps/api/path");
    let dir = await documentDir();
    dir = normPath(dir);
    await ensureIOSDocumentsFolder(dir);
    return dir;
  } catch (err) {
    console.warn("[tauri/fs] getAppDocumentsDir failed:", err);
    return null;
  }
}

// ─── Dialog helpers ───────────────────────────────────────────────────────────

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
    if (typeof result === "string") return normPath(result);
    return null;
  } catch (err) {
    console.warn("[tauri/fs] pickZipFileTauri failed:", err);
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
    if (typeof result === "string") return normPath(result);
    return null;
  } catch (err) {
    console.warn("[tauri/fs] pickDirectory failed:", err);
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
    filePath = normPath(filePath);

    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const text = await readTextFile(filePath);
    return { path: filePath, text };
  } catch (err) {
    console.warn("[tauri/fs] pickAndReadTextFile failed:", err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

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
    const filePath = await save({
      title: opts?.title,
      defaultPath: opts?.defaultPath,
      filters: opts?.filters,
    });
    if (typeof filePath !== "string") return null;
    return normPath(filePath);
  } catch (err) {
    console.warn("[tauri/fs] pickSavePath failed:", err);
    return null;
  }
}

/**
 * Open a native "Save" dialog and write text to the chosen path.
 * Returns the chosen path on success, or null if cancelled.
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
    const { save } = await import("@tauri-apps/plugin-dialog");
    let filePath = await save({
      title: opts?.title,
      defaultPath: opts?.defaultPath,
      filters: opts?.filters,
    });
    if (typeof filePath !== "string") return null;
    filePath = normPath(filePath);

    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(filePath, text);
    return filePath;
  } catch (err) {
    console.warn("[tauri/fs] pickAndWriteTextFile failed:", err);
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
  const { writeTextFile } = await import("@tauri-apps/plugin-fs");
  await writeTextFile(normPath(filePath), text);
}

// ─── Directory & binary file helpers ─────────────────────────────────────────

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
  try {
    const { readDir } = await import("@tauri-apps/plugin-fs");
    const entries = await readDir(normPath(dirPath));
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

/**
 * Recursively collect all file paths under a directory that match a predicate.
 * Returns paths as absolute strings.
 */
export async function walkDir(
  dir: string,
  predicate: (name: string) => boolean,
): Promise<string[]> {
  dir = normPath(dir);
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

/**
 * Check whether a path exists on the filesystem.
 */
export async function pathExists(p: string): Promise<boolean> {
  if (!isTauri) return false;
  try {
    const { exists } = await import("@tauri-apps/plugin-fs");
    return await exists(normPath(p));
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
  try {
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    return await readTextFile(normPath(filePath));
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
  try {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    return (await readFile(normPath(filePath))) as Uint8Array;
  } catch {
    return null;
  }
}

/**
 * Write a Uint8Array to a file path.
 */
export async function writeBinaryFileTauri(
  filePath: string,
  data: Uint8Array,
): Promise<boolean> {
  if (!isTauri) return false;
  try {
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    await writeFile(normPath(filePath), data);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a file at the given native path.
 * Returns true on success, false if the file was not found or could not be deleted.
 */
export async function removeFileTauri(filePath: string): Promise<boolean> {
  if (!isTauri) return false;
  try {
    const { remove } = await import("@tauri-apps/plugin-fs");
    await remove(normPath(filePath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a directory (and all parent directories) at the given path.
 */
export async function makeDirTauri(dirPath: string): Promise<boolean> {
  if (!isTauri) return false;
  try {
    const { mkdir } = await import("@tauri-apps/plugin-fs");
    await mkdir(normPath(dirPath), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

// ─── TauriSliceBlob ───────────────────────────────────────────────────────────
//
// A minimal File-API-compatible shim that reads byte ranges from a native
// filesystem path via plugin-fs open/seek/read, without ever loading the
// whole file into JS heap.
//
// ZipFS only uses three members of the File interface:
//   file.size          — total byte length (number)
//   file.name          — display name (string)
//   file.slice(s, e)   — returns a Blob-like whose arrayBuffer() reads [s, e)

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
  filePath = normPath(filePath);
  try {
    const { stat } = await import("@tauri-apps/plugin-fs");
    const info = await stat(filePath);
    const size = info.size;
    const name = filePath.split(/[/\\]/).pop() ?? "assets.zip";
    const path = filePath;
    return {
      size,
      name,
      slice(start: number, end?: number) {
        return new TauriSliceBlob(path, start, end ?? size);
      },
    };
  } catch {
    return null;
  }
}
