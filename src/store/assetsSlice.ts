// ─── Assets Slice ─────────────────────────────────────────────────────────────
//
// Manages the active assets.zip and the initial manifest / script loading.
//
//   zipFileName    — display name of the mounted zip (e.g. "assets.zip")
//   gameTitle      — display name from manifest.json (undefined when absent)
//   manifestLoaded — true once loadAll() has completed successfully
//
// Lifecycle:
//   init()       — called once on app mount; in Web mode auto-mounts
//                  WebFetchFS so self-hosted deployments work without any
//                  user interaction.  In Tauri mode waits for the user to
//                  pick a zip (no stored path to rehydrate).
//   mountZip()   — called when the user selects an assets.zip file; mounts
//                  ZipFS and kicks off loadAll().
//   unmountZip() — resets to unset state (returns to ZipPickerScreen).

import type { StateCreator } from "zustand";
import { loadAll, getManifestGame, defaultGameData } from "../loader";
import {
  mountFilesystem,
  unmountFilesystem,
  ZipFS,
  WebFetchFS,
} from "../filesystem";
import { isTauri } from "../tauri_bridge";

// ─── Slice interface ──────────────────────────────────────────────────────────

export interface AssetsSlice {
  /** Display name of the currently mounted zip, e.g. "assets.zip". Null = none. */
  zipFileName: string | null;
  /** Display name from manifest.json, or undefined when not present. */
  gameTitle: string | undefined;
  /** True once all .rrs files have been parsed and registered. */
  manifestLoaded: boolean;

  /** Bootstrap: auto-mount WebFetchFS on web, or wait for user zip selection in Tauri. */
  init: () => Promise<void>;
  /**
   * Mount the given File as a ZipFS, parse the Central Directory index, then
   * run loadAll().  Called when the user selects a file via the picker.
   */
  mountZip: (file: File) => Promise<void>;
  /** Unmount the current filesystem and return to the ZipPickerScreen. */
  unmountZip: () => void;
}

// ─── Shared load helper ───────────────────────────────────────────────────────

type SetFn = (
  partial: Partial<AssetsSlice & { loading: boolean; error: string | null }>,
) => void;

async function runLoadAll(set: SetFn): Promise<void> {
  set({ loading: true, error: null });
  try {
    // Reset any previously loaded game data so stale labels/defines don't bleed in.
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
    set({ loading: true, error: null } as Partial<
      AssetsSlice & { loading: boolean; error: string | null }
    >);

    if (!isTauri) {
      // Web mode: auto-mount WebFetchFS so self-hosted deployments work
      // without the user having to pick any file.
      mountFilesystem(new WebFetchFS("/assets"));
      await runLoadAll(set as SetFn);
      return;
    }

    // Tauri mode: wait for the user to pick a zip — nothing to auto-load.
    set({ loading: false } as Partial<
      AssetsSlice & { loading: boolean; error: string | null }
    >);
  },

  // ── mountZip ───────────────────────────────────────────────────────────────
  mountZip: async (file: File) => {
    set({ loading: true, error: null } as Partial<
      AssetsSlice & { loading: boolean; error: string | null }
    >);

    // Tear down any previously mounted filesystem (revokes old Blob URLs).
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
      } as Partial<AssetsSlice & { loading: boolean; error: string | null }>);
      return;
    }

    mountFilesystem(zipFs);

    set({ zipFileName: file.name } as Partial<
      AssetsSlice & { loading: boolean; error: string | null }
    >);

    await runLoadAll(set as SetFn);
  },

  // ── unmountZip ─────────────────────────────────────────────────────────────
  unmountZip: () => {
    unmountFilesystem();
    defaultGameData.reset();
    set({
      zipFileName: null,
      manifestLoaded: false,
      gameTitle: undefined,
      error: null,
    } as Partial<AssetsSlice & { loading: boolean; error: string | null }>);
  },
});
