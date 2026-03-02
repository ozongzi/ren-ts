// ─── Assets Slice ─────────────────────────────────────────────────────────────
//
// Manages the active assets.zip and the initial manifest / script loading.
//
//   zipFileName    — display name of the mounted zip (e.g. "assets.zip")
//   gameTitle      — display name from manifest.json (undefined when absent)
//   manifestLoaded — true once loadAll() has completed successfully
//
// Lifecycle (all platforms):
//   init()       — tries to auto-restore a previously used zip:
//                    Tauri:  reads stored path from localStorage, loads via readBinaryFileTauri
//                    Web:    reads cached zip bytes from OPFS
//                  Falls through to unloaded state if nothing is cached / path is gone.
//   mountZip()   — called when the user selects an assets.zip file; mounts
//                  ZipFS, persists the source for next launch, kicks off loadAll().
//   unmountZip() — resets to unset state (returns to AssetsDirScreen).

import type { StateCreator } from "zustand";
import { loadAll, getManifestGame, defaultGameData } from "../loader";
import { mountFilesystem, unmountFilesystem, ZipFS } from "../filesystem";
import {
  isTauri,
  openTauriFileShim,
  getStoredZipPath,
  clearStoredZipPath,
  saveFsaHandle,
  loadFsaHandle,
  clearFsaHandle,
} from "../tauri_bridge";

// ─── Slice interface ──────────────────────────────────────────────────────────

export interface AssetsSlice {
  /** Display name of the currently mounted zip, e.g. "assets.zip". Null = none. */
  zipFileName: string | null;
  /** Display name from manifest.json, or undefined when not present. */
  gameTitle: string | undefined;
  /** True once all .rrs files have been parsed and registered. */
  manifestLoaded: boolean;

  /**
   * Bootstrap: attempt to auto-restore the last used zip.
   * - Tauri: re-reads the file from the stored native path.
   * - Web:   re-reads the file from the OPFS cache.
   * Silently falls through to the picker screen if nothing is available.
   */
  init: () => Promise<void>;

  /**
   * Mount the given File as a ZipFS and run loadAll().
   * Called when the user selects a file via the plain <input type="file"> picker
   * (Firefox/Safari) where no FSA handle is available.
   */
  mountZip: (file: File) => Promise<void>;

  /**
   * Mount a zip selected via the File System Access API.
   * Persists the handle to IndexedDB so the next launch can restore it without
   * re-picking.  Chrome/Edge only — falls back to mountZip on other browsers.
   */
  mountZipFromHandle: (handle: FileSystemFileHandle) => Promise<void>;

  /** Unmount the current filesystem and return to the picker screen. */
  unmountZip: () => void;
}

// ─── Shared load helper ───────────────────────────────────────────────────────

type SetFn = (
  partial: Partial<AssetsSlice & { loading: boolean; error: string | null }>,
) => void;

async function runLoadAll(set: SetFn): Promise<void> {
  set({ loading: true, error: null });
  try {
    defaultGameData.reset();
    await loadAll();
    set({
      manifestLoaded: true,
      loading: false,
      gameTitle: getManifestGame(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    unmountFilesystem();
    set({
      loading: false,
      error: `无法加载剧本数据：${msg}`,
      zipFileName: null,
      manifestLoaded: false,
    });
  }
}

/**
 * Try to mount a File as ZipFS. Returns false and sets an error on failure.
 */
async function mountZipFile(file: File, set: SetFn): Promise<boolean> {
  unmountFilesystem();
  let zipFs: ZipFS;
  try {
    zipFs = await ZipFS.mount(file);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    set({
      loading: false,
      error: `ZIP 文件无法解析：${msg}`,
      zipFileName: null,
      manifestLoaded: false,
    });
    return false;
  }
  mountFilesystem(zipFs);
  set({ zipFileName: file.name });
  return true;
}

// ─── Slice factory ────────────────────────────────────────────────────────────

export const createAssetsSlice: StateCreator<
  AssetsSlice & {
    loading: boolean;
    error: string | null;
    manifestLoaded: boolean;
  },
  [],
  [],
  AssetsSlice
> = (set) => ({
  zipFileName: null,
  gameTitle: undefined,
  manifestLoaded: false,

  // ── init ───────────────────────────────────────────────────────────────────
  init: async () => {
    set({ loading: true, error: null });

    if (isTauri) {
      // ── Tauri: try to reload from stored native path ──────────────────────
      // openTauriFileShim returns a File-API-compatible object that satisfies
      // ZipFS (size, name, slice) using plugin-fs seek+read under the hood.
      // Unlike readBinaryFileTauri it never copies the whole file into JS heap,
      // which is essential for ZIP archives that can exceed 4 GB.
      const storedPath = getStoredZipPath();
      if (storedPath) {
        const shim = await openTauriFileShim(storedPath);
        if (shim) {
          const ok = await mountZipFile(shim as unknown as File, set as SetFn);
          if (ok) {
            await runLoadAll(set as SetFn);
            return;
          }
          // File was corrupt — clear the stale path.
          clearStoredZipPath();
        } else {
          // File was gone or unreadable — clear the stale path.
          clearStoredZipPath();
        }
      }
      // Nothing to restore — show picker.
      set({ loading: false });
      return;
    }

    // ── Web: try to restore from FSA handle (Chrome/Edge only) ───────────
    // loadFsaHandle() re-requests permission and returns the File directly —
    // no bytes are copied.  On Firefox/Safari it returns null immediately.
    const restoredFile = await loadFsaHandle();
    if (restoredFile) {
      const ok = await mountZipFile(restoredFile, set as SetFn);
      if (ok) {
        await runLoadAll(set as SetFn);
        return;
      }
      // Handle was stale or file unreadable — clear it.
      await clearFsaHandle();
    }

    // Nothing to restore (or unsupported browser) — show picker.
    set({ loading: false });
  },

  // ── mountZip ───────────────────────────────────────────────────────────────
  mountZip: async (file: File) => {
    set({ loading: true, error: null });

    const ok = await mountZipFile(file, set as SetFn);
    if (!ok) return;

    // Persist for next launch (fire-and-forget, non-blocking).
    // Tauri: path is persisted by AssetsDirScreen before calling mountZip.
    // Web FSA: the caller passes an optional handle via mountZipWithHandle.
    // Nothing extra to do here for plain File objects.

    await runLoadAll(set as SetFn);
  },

  // ── mountZipFromHandle ─────────────────────────────────────────────────────
  mountZipFromHandle: async (handle: FileSystemFileHandle) => {
    set({ loading: true, error: null });
    let file: File;
    try {
      file = await handle.getFile();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({
        loading: false,
        error: `无法读取文件：${msg}`,
        zipFileName: null,
        manifestLoaded: false,
      });
      return;
    }
    const ok = await mountZipFile(file, set as SetFn);
    if (!ok) return;
    // Persist handle for next launch (fire-and-forget).
    saveFsaHandle(handle).catch((e) =>
      console.warn("[assetsSlice] saveFsaHandle failed:", e),
    );
    await runLoadAll(set as SetFn);
  },

  // ── unmountZip ─────────────────────────────────────────────────────────────
  unmountZip: () => {
    unmountFilesystem();
    defaultGameData.reset();
    // Clear persisted state so next launch starts at the picker too.
    if (isTauri) {
      clearStoredZipPath();
    } else {
      clearFsaHandle().catch(() => {});
    }
    set({
      zipFileName: null,
      manifestLoaded: false,
      gameTitle: undefined,
      error: null,
    });
  },
});
