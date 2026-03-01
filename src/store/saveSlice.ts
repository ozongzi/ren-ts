// ─── Save Slice ───────────────────────────────────────────────────────────────
//
// Manages the active save file location and all save / load actions.
//
//   saveFileHandle  — FSA FileSystemFileHandle for browser auto-save
//   saveFilePath    — native path for Tauri auto-save
//   saveFileName    — display name shown in the toolbar
//
// Actions:
//   saveExport      — serialise state and trigger a file download / dialog
//   saveImport      — open a file picker and load a save
//   continueSave    — apply an already-loaded SaveData to the game state

import type { StateCreator } from "zustand";
import type { GameState } from "../types";
import {
  applySave,
  exportSave,
  openSaveFile,
  pickNewSaveFile,
  autoSaveToHandle,
  type LoadedSave,
} from "../save";
import { startNewGame, resumeFromSave } from "../engine";
import { audioManager } from "../audio";

// ─── Slice interface ──────────────────────────────────────────────────────────

export interface SaveSlice {
  /** FSA handle for browser auto-saves (Chrome/Edge). Null in Tauri / fallback. */
  saveFileHandle: FileSystemFileHandle | null;
  /** Native filesystem path for Tauri auto-saves. Null in browser mode. */
  saveFilePath: string | null;
  /** Human-readable file name shown in the toolbar (e.g. "rr_save_2024-01-01.json"). */
  saveFileName: string | null;

  /** Serialise current state and trigger an export (download or Tauri save dialog). */
  saveExport: () => Promise<void>;
  /** Open a file picker, parse the chosen save, and land on SaveLoadedScreen. */
  saveImport: () => Promise<void>;
  /** Apply an already-parsed LoadedSave to the store and land on SaveLoadedScreen. */
  continueSave: (loaded: LoadedSave) => void;
  /**
   * Start a new game: pick a save location, run the engine to the first
   * blocking step, write an initial auto-save, and land on SaveLoadedScreen.
   */
  newGame: () => Promise<void>;
  /**
   * Transition from the SaveLoadedScreen lobby into active gameplay.
   * Restarts suppressed BGM and runs forward if not already at a blocking step.
   */
  enterGame: () => void;
}

// ─── Slice factory ────────────────────────────────────────────────────────────

// The slice needs access to the full store shape to read GameState fields and
// call applyGameState. We express this via the generic bound on StateCreator.
// The minimum surface we depend on from sibling slices is typed inline below.

type SaveSliceDeps = SaveSlice &
  GameState & {
    loading: boolean;
    error: string | null;
    // from uiSlice
    saveError: string | null;
    setSaveError: (msg: string) => void;
    clearSaveError: () => void;
    // from assetsSlice
    manifestLoaded: boolean;
    // applyGameState is a store-private helper defined in the root store and
    // passed in via a closure; we don't expose it on the slice interface.
  };

/**
 * Factory that creates the save slice.
 *
 * `applyGameState` is injected by the root store so the slice does not need
 * to duplicate the audio-sync + auto-save trigger logic.
 */
export function createSaveSlice(
  applyGameState: (next: GameState) => void,
): StateCreator<SaveSliceDeps, [], [], SaveSlice> {
  return (set, get) => ({
    saveFileHandle: null,
    saveFilePath: null,
    saveFileName: null,

    // ── newGame ──────────────────────────────────────────────────────────────
    newGame: async () => {
      const state = get();

      // Ask where to save, then run the engine to the first blocking step.
      const loc = await pickNewSaveFile();
      const next = startNewGame(state);

      // Write initial save immediately so the file exists on disk.
      if (loc.handle || loc.path) {
        autoSaveToHandle(loc.handle, next, loc.path).catch((err) => {
          console.warn("[save] Initial save failed:", err);
        });
      }

      set({
        ...(next as unknown as Partial<SaveSliceDeps>),
        phase: "save_loaded",
        saveFileHandle: loc.handle,
        saveFilePath: loc.path,
        saveFileName: loc.fileName,
      });
    },

    // ── enterGame ────────────────────────────────────────────────────────────
    enterGame: () => {
      const state = get();
      if (state.phase !== "save_loaded") return;

      // Restart BGM that was intentionally suppressed while in the lobby.
      if (state.bgmSrc) {
        audioManager.playBGM(state.bgmSrc, { fadein: 1 });
      }

      // If the restored save is not at a blocking step, run forward
      // automatically so the player is not left at a blank screen.
      const playing: GameState = { ...state, phase: "playing" };
      const next = resumeFromSave(playing);
      applyGameState(next);
    },

    // ── saveExport ───────────────────────────────────────────────────────────
    saveExport: async () => {
      const state = get();
      if (state.phase !== "playing") return;
      try {
        await exportSave(state);
      } catch (err) {
        get().setSaveError(
          `导出失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    // ── saveImport ───────────────────────────────────────────────────────────
    saveImport: async () => {
      try {
        const loaded = await openSaveFile();
        get().continueSave(loaded);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== "已取消") {
          get().setSaveError(`导入失败：${msg}`);
        }
      }
    },

    // ── continueSave ─────────────────────────────────────────────────────────
    continueSave: ({ save, handle, savePath }: LoadedSave) => {
      const state = get();
      const next = applySave(state, save);

      // Derive a display name from whichever location info is available.
      const fileName =
        handle?.name ??
        (savePath ? (savePath.split(/[/\\]/).pop() ?? null) : null);

      // Land on the lobby screen; BGM starts when the player clicks "进入游戏".
      get().clearSaveError();
      set({
        ...(next as unknown as Partial<SaveSliceDeps>),
        phase: "save_loaded",
        saveFileHandle: handle,
        saveFilePath: savePath,
        saveFileName: fileName,
      });
    },
  });
}
