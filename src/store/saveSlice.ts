// ─── Save Slice ───────────────────────────────────────────────────────────────
//
// Manages active save state and all save/load actions.
//
// The slice no longer holds a FileSystemFileHandle or a native path — all
// file I/O is delegated to the SaveStore returned by getSaveStore(), which
// picks the right backend (Tauri / OPFS / Legacy) at runtime.
//
// Active save tracking:
//   saveId       — id of the current save entry (used for in-place auto-save)
//   saveFileName — display name shown in the toolbar
//
// The concept of "no auto-save location chosen" is now gone: on all platforms
// that support persistence (Tauri + OPFS), a save file is created automatically
// when a new game starts.  On the legacy fallback a download is triggered.

import type { StateCreator } from "zustand";
import type { GameState } from "../types";
import { stateToSave, applySave, formatLabel } from "../save";
import { getSaveStore, type SaveEntry } from "../saveStore";
import { startNewGame, resumeFromSave } from "../engine";
import { audioManager } from "../audio";

// ─── Slice interface ──────────────────────────────────────────────────────────

export interface SaveSlice {
  /** Id of the active save entry, used for in-place auto-save. Null = no active save. */
  saveId: string | null;
  /** Human-readable file name shown in the toolbar. */
  saveFileName: string | null;

  /** Write the current state to a new save and land on SaveLoadedScreen. */
  newGame: () => Promise<void>;

  /** Transition from the SaveLoadedScreen lobby into active gameplay. */
  enterGame: () => void;

  /**
   * In-place auto-save: overwrite the current saveId entry with fresh state.
   * No-op if saveId is null.  Fire-and-forget — errors are logged but not surfaced.
   */
  autoSave: () => void;

  /** Export the current state as a portable .json file (download / native dialog). */
  saveExport: () => Promise<void>;

  /**
   * Import a .json save file from disk and land on SaveLoadedScreen.
   * No-op if the user cancels.
   */
  saveImport: () => Promise<void>;

  /**
   * Apply an already-parsed SaveEntry to the store and land on SaveLoadedScreen.
   * Used by the SaveSelector UI after the user picks an entry from the list.
   */
  continueSave: (entry: SaveEntry) => void;
}

// ─── Slice factory ────────────────────────────────────────────────────────────

type SaveSliceDeps = SaveSlice &
  GameState & {
    loading: boolean;
    error: string | null;
    saveError: string | null;
    setSaveError: (msg: string) => void;
    clearSaveError: () => void;
    manifestLoaded: boolean;
  };

export function createSaveSlice(
  applyGameState: (next: GameState) => void,
): StateCreator<SaveSliceDeps, [], [], SaveSlice> {
  return (set, get) => ({
    saveId: null,
    saveFileName: null,

    // ── newGame ──────────────────────────────────────────────────────────────
    newGame: async () => {
      const state = get();
      const next = startNewGame(state);
      let saveId: string | null = null;
      let saveFileName: string | null = null;

      try {
        const store = getSaveStore();
        const entry = await store.write(stateToSave(next));
        saveId = entry.id;
        saveFileName = entry.fileName;
      } catch (err) {
        console.warn("[saveSlice] newGame write failed:", err);
      }

      set({
        ...(next as unknown as Partial<SaveSliceDeps>),
        phase: "save_loaded",
        saveId,
        saveFileName,
      });
    },

    // ── enterGame ────────────────────────────────────────────────────────────
    enterGame: () => {
      const state = get();
      if (state.phase !== "save_loaded") return;

      if (state.bgmSrc) {
        audioManager.playBGM(state.bgmSrc, { fadein: 1 });
      }

      const playing: GameState = { ...state, phase: "playing" };
      const next = resumeFromSave(playing);
      applyGameState(next);
    },

    // ── autoSave ─────────────────────────────────────────────────────────────
    autoSave: () => {
      const state = get();
      const { saveId } = state;
      if (!saveId) return;

      const data = stateToSave(state);
      getSaveStore()
        .update(saveId, data)
        .catch((err) => {
          console.warn("[saveSlice] autoSave failed:", err);
        });
    },

    // ── saveExport ───────────────────────────────────────────────────────────
    saveExport: async () => {
      const state = get();
      try {
        await getSaveStore().exportToFile(stateToSave(state));
      } catch (err) {
        get().setSaveError(
          `导出失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    // ── saveImport ───────────────────────────────────────────────────────────
    saveImport: async () => {
      try {
        const save = await getSaveStore().importFromFile();
        if (!save) return; // cancelled

        const state = get();
        const next = applySave(state, save);

        // After import the data is now persisted inside the store (OPFS/Tauri).
        // List the store to find the entry we just wrote so we have its id.
        let saveId: string | null = null;
        let saveFileName: string | null = null;
        try {
          const entries = await getSaveStore().list();
          if (entries.length > 0) {
            saveId = entries[0].id;
            saveFileName = entries[0].fileName;
          }
        } catch {
          // Non-fatal: we can still continue without auto-save.
        }

        get().clearSaveError();
        set({
          ...(next as unknown as Partial<SaveSliceDeps>),
          phase: "save_loaded",
          saveId,
          saveFileName,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== "已取消") {
          get().setSaveError(`导入失败：${msg}`);
        }
      }
    },

    // ── continueSave ─────────────────────────────────────────────────────────
    continueSave: (entry: SaveEntry) => {
      const state = get();
      const next = applySave(state, entry.save);

      get().clearSaveError();
      set({
        ...(next as unknown as Partial<SaveSliceDeps>),
        phase: "save_loaded",
        saveId: entry.id,
        saveFileName: entry.fileName,
      });
    },
  });
}

// ─── Re-export formatLabel for SaveLoadedScreen / Toolbar ────────────────────
export { formatLabel };
