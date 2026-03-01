// ─── Zustand game store ───────────────────────────────────────────────────────
//
// Single source of truth for all game state. Components read from this store
// and dispatch actions through the exported action functions.
//
// Architecture:
//   store.ts          — thin combinator; merges five slices + exposes selectors
//   store/gameSlice   — engine state + click / choose / jumpTo / goToTitle
//   store/saveSlice   — save file location + newGame / enterGame / save I/O
//   store/uiSlice     — modal visibility flags + saveError toast
//   store/volumeSlice — volume levels + setVolume* + localStorage persistence
//   store/assetsSlice — assetsDir + init + setAssetsDir (Tauri)
//
//   engine.ts         — pure state machine (no React, no side-effects)
//   audio.ts          — AudioManager singleton (side-effects only)
//   save.ts           — file I/O helpers
//   tauri_bridge.ts   — Tauri-specific I/O wrappers

import { create } from "zustand";

import {
  createGameSlice,
  makeApplyGameState,
  type GameSlice,
} from "./store/gameSlice";
import { createSaveSlice, type SaveSlice } from "./store/saveSlice";
import { createUISlice, type UISlice } from "./store/uiSlice";
import { createVolumeSlice, type VolumeSlice } from "./store/volumeSlice";
import { createAssetsSlice, type AssetsSlice } from "./store/assetsSlice";

// ─── Combined store type ──────────────────────────────────────────────────────

export type Store = GameSlice & SaveSlice & UISlice & VolumeSlice & AssetsSlice;

// ─── Create store ──────────────────────────────────────────────────────────────

export const useGameStore = create<Store>((set, get, api) => {
  // `applyGameState` must be constructed before the save slice so it can be
  // injected into createSaveSlice.  It closes over set/get from the top-level
  // creator, which sees the full combined Store shape.
  const applyGameState = makeApplyGameState(
    set as (partial: Partial<Store>) => void,
    get,
  );

  return {
    ...createGameSlice(set, get, api),
    ...createSaveSlice(applyGameState)(set, get, api),
    ...createUISlice(set, get, api),
    ...createVolumeSlice(set, get, api),
    ...createAssetsSlice(set, get, api),
  };
});

// ─── Convenience selector hooks ───────────────────────────────────────────────
// All selectors are unchanged — zero impact on existing component imports.

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
