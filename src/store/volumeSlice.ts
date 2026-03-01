// ─── Volume Slice ─────────────────────────────────────────────────────────────
//
// Manages audio volume levels (master / BGM / SFX / voice).
// Persists to localStorage so settings survive app restarts.
// Mirrors values into audioManager for actual playback control.

import type { StateCreator } from "zustand";
import { audioManager } from "../audio";

// ─── localStorage key ─────────────────────────────────────────────────────────

const VOLUMES_KEY = "cb_volumes";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp(v: unknown, def: number): number {
  return typeof v === "number" && isFinite(v) ? Math.max(0, Math.min(1, v)) : def;
}

export function loadVolumes(): {
  volumeMaster: number;
  volumeBGM: number;
  volumeSFX: number;
  volumeVoice: number;
} {
  try {
    const raw = localStorage.getItem(VOLUMES_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        volumeMaster: clamp(p.master, 1),
        volumeBGM:    clamp(p.bgm,    0.7),
        volumeSFX:    clamp(p.sfx,    0.8),
        volumeVoice:  clamp(p.voice,  1.0),
      };
    }
  } catch {
    // localStorage unavailable or corrupt — fall back to defaults
  }
  return { volumeMaster: 1, volumeBGM: 0.7, volumeSFX: 0.8, volumeVoice: 1.0 };
}

function saveVolumes(v: {
  master: number;
  bgm: number;
  sfx: number;
  voice: number;
}): void {
  try {
    localStorage.setItem(VOLUMES_KEY, JSON.stringify(v));
  } catch {
    // Ignore write errors (private browsing, storage full, etc.)
  }
}

// ─── Slice interface ──────────────────────────────────────────────────────────

export interface VolumeSlice {
  volumeMaster: number;
  volumeBGM: number;
  volumeSFX: number;
  volumeVoice: number;

  setVolumeMaster: (v: number) => void;
  setVolumeBGM:    (v: number) => void;
  setVolumeSFX:    (v: number) => void;
  setVolumeVoice:  (v: number) => void;
}

// ─── Slice factory ────────────────────────────────────────────────────────────

export const createVolumeSlice: StateCreator<
  VolumeSlice,
  [],
  [],
  VolumeSlice
> = (set, get) => {
  const persisted = loadVolumes();

  // Apply persisted volumes to audioManager immediately so the first track
  // that plays uses the correct levels even before any setter is called.
  audioManager.setVolumes({
    master: persisted.volumeMaster,
    bgm:    persisted.volumeBGM,
    sfx:    persisted.volumeSFX,
    voice:  persisted.volumeVoice,
  });

  return {
    ...persisted,

    setVolumeMaster: (v: number) => {
      const vol = Math.max(0, Math.min(1, v));
      audioManager.setVolumes({ master: vol });
      set({ volumeMaster: vol });
      const s = get();
      saveVolumes({ master: vol, bgm: s.volumeBGM, sfx: s.volumeSFX, voice: s.volumeVoice });
    },

    setVolumeBGM: (v: number) => {
      const vol = Math.max(0, Math.min(1, v));
      audioManager.setVolumes({ bgm: vol });
      set({ volumeBGM: vol });
      const s = get();
      saveVolumes({ master: s.volumeMaster, bgm: vol, sfx: s.volumeSFX, voice: s.volumeVoice });
    },

    setVolumeSFX: (v: number) => {
      const vol = Math.max(0, Math.min(1, v));
      audioManager.setVolumes({ sfx: vol });
      set({ volumeSFX: vol });
      const s = get();
      saveVolumes({ master: s.volumeMaster, bgm: s.volumeBGM, sfx: vol, voice: s.volumeVoice });
    },

    setVolumeVoice: (v: number) => {
      const vol = Math.max(0, Math.min(1, v));
      audioManager.setVolumes({ voice: vol });
      set({ volumeVoice: vol });
      const s = get();
      saveVolumes({ master: s.volumeMaster, bgm: s.volumeBGM, sfx: s.volumeSFX, voice: vol });
    },
  };
};
