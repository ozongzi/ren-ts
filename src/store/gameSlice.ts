// ─── Game Slice ───────────────────────────────────────────────────────────────
//
// Owns the core engine execution state (currentLabel, stepIndex, callStack,
// vars, visual state, audio state, dialogue/choices) and the three gameplay
// actions that drive it: click / choose / jumpTo.
//
// Also owns the title-screen navigation helpers (goToTitle, backToSaveMenu)
// that need to stop audio and reset engine state.
//
// The `applyGameState` helper lives here because it is the single place that:
//   1. Syncs audio side-effects when bgmSrc / sfxSrc / voiceSrc change.
//   2. Triggers auto-save on every blocking dialogue step.
// It is exported so saveSlice (enterGame) can call it without duplicating logic.

import type { StateCreator } from "zustand";
import type { GameState } from "../types";
import { createInitialState, advance, type AdvanceAction } from "../engine";
import { audioManager } from "../audio";
import { resolveAssetAsync } from "../assets";

// ─── Slice interface ──────────────────────────────────────────────────────────

export interface GameSlice extends GameState {
  click: () => void;
  choose: (index: number) => void;
  jumpTo: (label: string) => void;
  goToTitle: () => void;
  backToSaveMenu: () => void;
}

// ─── Slice deps (fields from sibling slices that gameSlice reads) ─────────────

type GameSliceDeps = GameSlice & {
  // from assetsSlice
  zipFileName: string | null;
  gameTitle: string | undefined;
  manifestLoaded: boolean;
  // from saveSlice
  saveId: string | null;
  saveFileName: string | null;
  autoSave: () => void;
  // from uiSlice
  showTools: boolean;
};

// ─── Audio sync ───────────────────────────────────────────────────────────────

function syncAudio(prev: GameState, next: GameState): void {
  // BGM
  if (next.bgmSrc !== prev.bgmSrc) {
    if (next.bgmSrc) {
      const rawBgm = next.bgmSrc;
      // Queue the raw src so unlock() can re-resolve+play inside the user gesture
      audioManager.queueBGM(rawBgm, { fadein: 1 });
      // Also attempt resolve+play now (works if already unlocked)
      resolveAssetAsync(rawBgm).then((url) => {
        console.log("[audio-debug] syncAudio resolved bgm:", rawBgm, "->", url?.slice(0,60));
        if (url) audioManager.playBGM(url, { fadein: 1 });
      });
    } else {
      audioManager.stopBGM({ fadeout: 1 });
    }
  }
  // SFX
  if (next.sfxSrc !== prev.sfxSrc && next.sfxSrc) {
    const rawSfx = next.sfxSrc;
    resolveAssetAsync(rawSfx).then((url) => {
      if (url) audioManager.playSFX(url);
    });
  }
  // Voice
  if (next.voiceSrc !== prev.voiceSrc) {
    if (next.voiceSrc) {
      const rawVoice = next.voiceSrc;
      resolveAssetAsync(rawVoice).then((url) => {
        if (url) audioManager.playVoice(url);
        else audioManager.stopVoice();
      });
    } else {
      audioManager.stopVoice();
    }
  }
}

// ─── applyGameState (exported for saveSlice.enterGame) ───────────────────────

/**
 * Apply the result of an engine advance to the store and fire all side-effects:
 *   - Sync audio channels when src fields changed.
 *   - Trigger auto-save on every blocking dialogue step.
 *
 * Exported so that saveSlice.enterGame can reuse it without duplicating the
 * audio-sync and auto-save logic.
 */
export function makeApplyGameState(
  set: (partial: Partial<GameSliceDeps>) => void,
  get: () => GameSliceDeps,
) {
  return function applyGameState(next: GameState): void {
    const prev = get();
    syncAudio(prev, next);
    set(next as Partial<GameSliceDeps>);

    // Auto-save on every blocking dialogue step (fire-and-forget).
    if (next.waitingForInput && next.phase === "playing") {
      get().autoSave();
    }
  };
}

// ─── Slice factory ────────────────────────────────────────────────────────────

export const createGameSlice: StateCreator<GameSliceDeps, [], [], GameSlice> = (
  set,
  get,
) => {
  const applyGameState = makeApplyGameState(set, get);

  return {
    // ── Initial engine state (from createInitialState) ──────────────────────
    ...createInitialState(),

    // ── click ────────────────────────────────────────────────────────────────
    click: () => {
      const state = get();
      if (!state.waitingForInput) return;
      const action: AdvanceAction = { kind: "click" };
      applyGameState(advance(state, action));
    },

    // ── choose ───────────────────────────────────────────────────────────────
    choose: (index: number) => {
      const state = get();
      if (!state.choices) return;
      const action: AdvanceAction = { kind: "choose", index };
      applyGameState(advance(state, action));
    },

    // ── jumpTo ───────────────────────────────────────────────────────────────
    jumpTo: (label: string) => {
      const state = get();
      const action: AdvanceAction = { kind: "jump", label };
      applyGameState(advance(state, action));
    },

    // ── goToTitle ────────────────────────────────────────────────────────────
    goToTitle: () => {
      audioManager.stopAll();
      // Preserve zip / manifest state so the user does not have to re-select
      // the zip on every visit to the title screen.
      const { zipFileName, gameTitle } = get();
      set({
        ...createInitialState(),
        manifestLoaded: true,
        saveId: null,
        saveFileName: null,
        zipFileName,
        gameTitle,
        showTools: false,
      } as Partial<GameSliceDeps>);
    },

    // ── backToSaveMenu ───────────────────────────────────────────────────────
    backToSaveMenu: () => {
      // Pause all audio but keep full game state so the player can resume.
      audioManager.stopBGM({ fadeout: 0.5 });
      audioManager.stopSFX();
      audioManager.stopVoice();
      set({ phase: "save_loaded" } as Partial<GameSliceDeps>);
    },
  };
};
