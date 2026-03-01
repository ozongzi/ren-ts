// ─── Assets Slice ─────────────────────────────────────────────────────────────
//
// Manages the user-selected assets directory (Tauri only) and the initial
// manifest / script loading that happens on startup or when the directory
// changes.
//
//   assetsDir      — absolute path chosen by the user (null = not yet chosen)
//   gameTitle      — display name from manifest.json (undefined when absent)
//   manifestLoaded — true once loadAll() has completed successfully
//
// Lifecycle:
//   init()          — called once on app mount; rehydrates assetsDir from
//                     localStorage then kicks off loadAll()
//   setAssetsDir()  — called when the user picks a new folder; persists path
//                     and re-runs loadAll() when manifest hasn't loaded yet
//   clearAssetsDir()— resets to unset state (returns to AssetsDirScreen)

import type { StateCreator } from "zustand";
import { loadAll, getManifestGame } from "../loader";
import {
  isTauri,
  getStoredAssetsDir,
  persistAssetsDir,
  clearStoredAssetsDir,
  setActiveAssetsDir,
} from "../tauri_bridge";

// ─── Slice interface ──────────────────────────────────────────────────────────

export interface AssetsSlice {
  /** Absolute path to the game's assets folder (Tauri only; null = not set). */
  assetsDir: string | null;
  /** Display name from manifest.json, or undefined when not present. */
  gameTitle: string | undefined;
  /** True once all .rrs files have been parsed and registered. */
  manifestLoaded: boolean;

  /** Bootstrap: rehydrate stored dir and kick off script loading. */
  init: () => Promise<void>;
  /** Update the assets directory, persist it, and (re)load scripts. */
  setAssetsDir: (dir: string) => void;
  /** Clear the stored directory and return to the AssetsDirScreen. */
  clearAssetsDir: () => void;
}

// ─── Shared load helper (used by both init and setAssetsDir) ─────────────────

/** Run loadAll() and update loading / error / manifest state accordingly. */
async function runLoadAll(
  set: (partial: Partial<AssetsSlice & { loading: boolean; error: string | null }>) => void,
): Promise<void> {
  set({ loading: true });
  try {
    await loadAll();
    set({
      manifestLoaded: true,
      loading: false,
      gameTitle: getManifestGame(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Loading failed — clear the stored dir so the user is returned to
    // AssetsDirScreen where they can pick a correct folder.
    clearStoredAssetsDir();
    setActiveAssetsDir(null);
    set({
      loading: false,
      error: `无法加载剧本数据：${msg}`,
      assetsDir: null,
    });
  }
}

// ─── Slice factory ────────────────────────────────────────────────────────────

export const createAssetsSlice: StateCreator<
  AssetsSlice & { loading: boolean; error: string | null; manifestLoaded: boolean },
  [],
  [],
  AssetsSlice
> = (set, get) => ({
  assetsDir: null,
  gameTitle: undefined,
  manifestLoaded: false,

  // ── init ───────────────────────────────────────────────────────────────────
  init: async () => {
    set({ loading: true, error: null } as Partial<AssetsSlice & { loading: boolean; error: string | null }>);

    if (isTauri) {
      const stored = getStoredAssetsDir();
      if (!stored) {
        // First launch — no directory chosen yet. Show AssetsDirScreen.
        set({ loading: false } as Partial<AssetsSlice & { loading: boolean; error: string | null }>);
        return;
      }
      // Rehydrate: sync module-level variable so resolveAsset() works immediately.
      setActiveAssetsDir(stored);
      set({ assetsDir: stored } as Partial<AssetsSlice & { loading: boolean; error: string | null }>);
    }

    await runLoadAll(set as Parameters<typeof runLoadAll>[0]);
  },

  // ── setAssetsDir ───────────────────────────────────────────────────────────
  setAssetsDir: (dir: string) => {
    setActiveAssetsDir(dir);
    persistAssetsDir(dir);
    // Clear any previous load error while the new folder loads.
    set({ assetsDir: dir, error: null } as Partial<AssetsSlice & { loading: boolean; error: string | null }>);

    // Only re-run loadAll if scripts haven't been loaded yet.
    // If they were already loaded (user is just switching dirs), a full page
    // reload is needed anyway — the store's game state would be stale.
    if (!get().manifestLoaded) {
      runLoadAll(set as Parameters<typeof runLoadAll>[0]);
    }
  },

  // ── clearAssetsDir ─────────────────────────────────────────────────────────
  clearAssetsDir: () => {
    setActiveAssetsDir(null);
    clearStoredAssetsDir();
    set({ assetsDir: null } as Partial<AssetsSlice & { loading: boolean; error: string | null }>);
  },
});
