// ─── Zustand game store ───────────────────────────────────────────────────────
//
// Single source of truth for all game state. Components read from this store
// and dispatch actions through the exported action functions.
//
// Architecture:
//   store state   ←→  engine.ts (pure transforms)
//   store actions  →  audio.ts  (side-effects)
//   store actions  →  save.ts   (persistence)
//   store actions  →  tauri_bridge.ts (Tauri-specific I/O)

import { create } from "zustand";
import type { GameState } from "./types";
import {
  createInitialState,
  startNewGame,
  advance,
  resumeFromSave,
  type AdvanceAction,
} from "./engine";
import { loadAll } from "./loader";
import { audioManager } from "./audio";
import {
  applySave,
  exportSave,
  openSaveFile,
  pickNewSaveFile,
  autoSaveToHandle,
} from "./save";
import {
  isTauri,
  getStoredAssetsDir,
  persistAssetsDir,
  clearStoredAssetsDir,
  setActiveAssetsDir,
} from "./tauri_bridge";
import { getManifestGame } from "./loader";

// ─── Store shape ──────────────────────────────────────────────────────────────

interface StoreState extends GameState {
  // Loading flag for the initial manifest fetch
  manifestLoaded: boolean;

  // UI-only state (not saved)
  showGallery: boolean;
  showSettings: boolean;
  saveError: string | null;
  showTools: boolean;

  // Volume settings (mirrored from audioManager for reactivity)
  volumeMaster: number;
  volumeBGM: number;
  volumeSFX: number;
  volumeVoice: number;

  // File System Access API handle for auto-saving (non-serialisable, session-only)
  saveFileHandle: FileSystemFileHandle | null;
  // Native filesystem path for Tauri auto-saves (replaces handle in Tauri mode)
  saveFilePath: string | null;
  // Display name of the current save file (e.g. "save_2024-01-01.json")
  saveFileName: string | null;

  // Game title from manifest.json (optional — undefined when not set)
  gameTitle: string | undefined;

  // ── Tauri: user-selected assets directory ──
  // Populated on startup from localStorage (Tauri only).
  // null means the user hasn't chosen a directory yet → show AssetsDirScreen.
  assetsDir: string | null;
}

interface StoreActions {
  // ── Bootstrap ──
  init: () => Promise<void>;

  // ── Gameplay ──
  newGame: () => Promise<void>;
  enterGame: () => void;
  click: () => void;
  choose: (index: number) => void;
  jumpTo: (label: string) => void;

  // ── Save / Load ──
  saveExport: () => void;
  saveImport: () => Promise<void>;
  continueSave: (save: import("./save").LoadedSave) => void;

  // ── Tauri: assets directory ──
  setAssetsDir: (dir: string) => void;
  clearAssetsDir: () => void;

  // ── UI toggles ──
  openGallery: () => void;
  closeGallery: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  goToTitle: () => void;
  backToSaveMenu: () => void;
  clearSaveError: () => void;
  openTools: () => void;
  closeTools: () => void;

  // ── Volume ──
  setVolumeMaster: (v: number) => void;
  setVolumeBGM: (v: number) => void;
  setVolumeSFX: (v: number) => void;
  setVolumeVoice: (v: number) => void;
}

type Store = StoreState & StoreActions;

// ─── Create store ──────────────────────────────────────────────────────────────

export const useGameStore = create<Store>((set, get) => {
  // ─── Audio sync helper ─────────────────────────────────────────────────────
  // After every state update we sync audio side-effects.

  function syncAudio(prev: GameState, next: GameState): void {
    // BGM
    if (next.bgmSrc !== prev.bgmSrc) {
      if (next.bgmSrc) {
        audioManager.playBGM(next.bgmSrc, { fadein: 1 });
      } else {
        audioManager.stopBGM({ fadeout: 1 });
      }
    }

    // SFX
    if (next.sfxSrc !== prev.sfxSrc && next.sfxSrc) {
      audioManager.playSFX(next.sfxSrc);
    }

    // Voice
    if (next.voiceSrc !== prev.voiceSrc) {
      if (next.voiceSrc) {
        audioManager.playVoice(next.voiceSrc);
      } else {
        audioManager.stopVoice();
      }
    }
  }

  // ─── Apply next game state + sync audio ───────────────────────────────────

  function applyGameState(next: GameState): void {
    const prev = get();
    syncAudio(prev, next);
    set(next as Partial<Store>);

    // Auto-save to the open file handle / path on every blocking dialogue step.
    if (next.waitingForInput && next.phase === "playing") {
      const { saveFileHandle, saveFilePath } = get();
      if (saveFileHandle || saveFilePath) {
        autoSaveToHandle(saveFileHandle, next, saveFilePath).catch((err) => {
          console.warn("[save] Auto-save to file failed:", err);
        });
      }
    }
  }

  // ─── Initial store state ───────────────────────────────────────────────────

  const initial: Store = {
    ...createInitialState(),
    manifestLoaded: false,
    showGallery: false,
    showSettings: false,
    saveError: null,
    volumeMaster: 1,
    volumeBGM: 0.7,
    volumeSFX: 0.8,
    volumeVoice: 1.0,
    saveFileHandle: null,
    saveFilePath: null,
    saveFileName: null,
    assetsDir: null,
    gameTitle: undefined,
    showTools: false,

    // ── Bootstrap ──────────────────────────────────────────────────────────

    init: async () => {
      set({ loading: true, error: null });

      // Rehydrate the Tauri assets directory from localStorage on every startup.
      if (isTauri) {
        const stored = getStoredAssetsDir();
        if (stored) {
          setActiveAssetsDir(stored);
          set({ assetsDir: stored });
        } else {
          // First launch in Tauri — assetsDir not yet chosen.
          // AssetsDirScreen will be shown; loadAll() will run after the user
          // picks a directory via setAssetsDir().
          set({ loading: false });
          return;
        }
      }

      try {
        await loadAll();
        set({
          manifestLoaded: true,
          loading: false,
          gameTitle: getManifestGame(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isTauri) {
          // Clear the stored dir so the user is returned to AssetsDirScreen
          // where they can pick a correct folder or open the converter.
          clearStoredAssetsDir();
          setActiveAssetsDir(null);
          set({
            loading: false,
            error: `无法加载剧本数据：${msg}`,
            assetsDir: null,
          });
        } else {
          set({ loading: false, error: `无法加载剧本数据：${msg}` });
        }
      }
    },

    // ── Gameplay ───────────────────────────────────────────────────────────

    newGame: async () => {
      const state = get();

      // Ask the user where to save.
      // pickNewSaveFile() returns { handle, path, fileName } — whichever pair
      // is appropriate for the current runtime (Tauri vs FSA vs fallback).
      const loc = await pickNewSaveFile();

      // Run the engine to the first blocking point, but stay in the
      // "save_loaded" lobby rather than jumping straight into gameplay.
      const next = startNewGame(state);

      // Write the initial save to the chosen file right away.
      if (loc.handle || loc.path) {
        autoSaveToHandle(loc.handle, next, loc.path).catch((err) => {
          console.warn("[save] Initial save failed:", err);
        });
      }

      set({
        ...next,
        phase: "save_loaded",
        saveFileHandle: loc.handle,
        saveFilePath: loc.path,
        saveFileName: loc.fileName,
      } as Partial<Store>);
    },

    enterGame: () => {
      const state = get();
      if (state.phase !== "save_loaded") return;
      // Restart BGM that was suppressed while in the lobby.
      if (state.bgmSrc) {
        audioManager.playBGM(state.bgmSrc, { fadein: 1 });
      }
      // If the restored save is not at a blocking step (no dialogue, no choices),
      // run forward automatically to the first blocking point so the player isn't
      // left staring at a black screen with nothing to click.
      const playing: GameState = { ...state, phase: "playing" };
      const next = resumeFromSave(playing);
      applyGameState(next);
    },

    click: () => {
      const state = get();
      if (!state.waitingForInput) return;
      const action: AdvanceAction = { kind: "click" };
      const next = advance(state, action);
      applyGameState(next);
    },

    choose: (index: number) => {
      const state = get();
      if (!state.choices) return;
      const action: AdvanceAction = { kind: "choose", index };
      const next = advance(state, action);
      applyGameState(next);
    },

    jumpTo: (label: string) => {
      const state = get();
      const action: AdvanceAction = { kind: "jump", label };
      const next = advance(state, action);
      applyGameState(next);
    },

    // ── Save / Load ────────────────────────────────────────────────────────

    saveExport: () => {
      const state = get();
      if (state.phase !== "playing") return;
      try {
        exportSave(state);
      } catch (err) {
        set({
          saveError: `导出失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },

    saveImport: async () => {
      try {
        const loaded = await openSaveFile();
        get().continueSave(loaded);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== "已取消") {
          set({ saveError: `导入失败：${msg}` });
        }
      }
    },

    continueSave: ({ save, handle, savePath }: import("./save").LoadedSave) => {
      const state = get();
      const next = applySave(state, save);
      // Derive a display name: prefer the FSA handle name, then the tail of
      // the native path, then null.
      const fileName =
        handle?.name ??
        (savePath ? (savePath.split(/[/\\]/).pop() ?? null) : null);
      // Land on the "save_loaded" lobby instead of going directly into play.
      // BGM will be started when the player clicks "进入游戏".
      set({
        ...next,
        phase: "save_loaded",
        saveError: null,
        saveFileHandle: handle,
        saveFilePath: savePath,
        saveFileName: fileName,
      } as Partial<Store>);
    },

    // ── UI toggles ─────────────────────────────────────────────────────────

    openGallery: () => set({ showGallery: true }),
    closeGallery: () => set({ showGallery: false }),
    openSettings: () => set({ showSettings: true }),
    closeSettings: () => set({ showSettings: false }),

    goToTitle: () => {
      audioManager.stopAll();
      // Keep assetsDir and gameTitle so the user doesn't have to re-pick on every title visit.
      const assetsDir = get().assetsDir;
      const gameTitle = get().gameTitle;
      set({
        ...createInitialState(),
        manifestLoaded: true,
        saveFileHandle: null,
        saveFilePath: null,
        saveFileName: null,
        assetsDir,
        gameTitle,
        showTools: false,
      } as Partial<Store>);
    },

    openTools: () => set({ showTools: true }),
    closeTools: () => set({ showTools: false }),

    backToSaveMenu: () => {
      // Pause audio but keep all game state intact so the player can resume.
      audioManager.stopBGM({ fadeout: 0.5 });
      audioManager.stopSFX();
      audioManager.stopVoice();
      set({ phase: "save_loaded" });
    },

    // ── Tauri: assets directory ────────────────────────────────────────────────

    setAssetsDir: (dir: string) => {
      // Keep both the module-level variable (for resolveAsset) and the store
      // (for UI reactivity) in sync, and persist to localStorage.
      setActiveAssetsDir(dir);
      persistAssetsDir(dir);
      // Clear any previous load error so AssetsDirScreen shows a clean state
      // while the new folder is being loaded.
      set({ assetsDir: dir, error: null });

      // If scripts haven't been loaded yet (first launch — no stored dir),
      // kick off loadAll() now that we have a valid assetsDir.
      if (!get().manifestLoaded) {
        set({ loading: true });
        loadAll()
          .then(() =>
            set({
              manifestLoaded: true,
              loading: false,
              gameTitle: getManifestGame(),
            }),
          )
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            // Loading failed — send the user back to AssetsDirScreen with the
            // error displayed so they can pick a different folder or use the
            // converter tool.
            clearStoredAssetsDir();
            setActiveAssetsDir(null);
            set({
              loading: false,
              error: `无法加载剧本数据：${msg}`,
              assetsDir: null,
            });
          });
      }
    },

    clearAssetsDir: () => {
      setActiveAssetsDir(null);
      clearStoredAssetsDir();
      set({ assetsDir: null });
    },

    clearSaveError: () => set({ saveError: null }),

    // ── Volume ─────────────────────────────────────────────────────────────

    setVolumeMaster: (v: number) => {
      const vol = Math.max(0, Math.min(1, v));
      audioManager.setVolumes({ master: vol });
      set({ volumeMaster: vol });
    },
    setVolumeBGM: (v: number) => {
      const vol = Math.max(0, Math.min(1, v));
      audioManager.setVolumes({ bgm: vol });
      set({ volumeBGM: vol });
    },
    setVolumeSFX: (v: number) => {
      const vol = Math.max(0, Math.min(1, v));
      audioManager.setVolumes({ sfx: vol });
      set({ volumeSFX: vol });
    },
    setVolumeVoice: (v: number) => {
      const vol = Math.max(0, Math.min(1, v));
      audioManager.setVolumes({ voice: vol });
      set({ volumeVoice: vol });
    },
  };

  return initial;
});

// ─── Convenience selector hooks ───────────────────────────────────────────────

/** Select only the fields needed by the game screen */
export const selectGameScreen = (s: Store) => ({
  phase: s.phase,
  backgroundSrc: s.backgroundSrc,
  sprites: s.sprites,
  dialogue: s.dialogue,
  choices: s.choices,
  waitingForInput: s.waitingForInput,
  autoAdvanceDelay: s.autoAdvanceDelay,
  loading: s.loading,
  error: s.error,
});

export const selectPhase = (s: Store) => s.phase;
export const selectLoading = (s: Store) => ({
  loading: s.loading,
  error: s.error,
  manifestLoaded: s.manifestLoaded,
});
export const selectDialogue = (s: Store) => ({
  dialogue: s.dialogue,
  waitingForInput: s.waitingForInput,
});
export const selectChoices = (s: Store) => s.choices;
export const selectBackground = (s: Store) => s.backgroundSrc;
export const selectSprites = (s: Store) => s.sprites;

export const selectUI = (s: Store) => ({
  showGallery: s.showGallery,
  showSettings: s.showSettings,
  showTools: s.showTools,
  saveError: s.saveError,
});
export const selectVolumes = (s: Store) => ({
  master: s.volumeMaster,
  bgm: s.volumeBGM,
  sfx: s.volumeSFX,
  voice: s.volumeVoice,
});
