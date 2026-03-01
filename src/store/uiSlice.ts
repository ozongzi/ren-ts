// ─── UI Slice ─────────────────────────────────────────────────────────────────
//
// Manages modal visibility flags and transient UI-only state that is never
// persisted to disk.
//
//   showGallery      — CG gallery modal
//   showSettings     — settings modal
//   showTools        — converter tools panel
//   showSaveSelector — save / load file selector overlay
//   saveError        — last save/load error string (auto-dismissed by App.tsx)

// ─── Slice interface ──────────────────────────────────────────────────────────

export interface UISlice {
  showGallery: boolean;
  showSettings: boolean;
  showTools: boolean;
  showSaveSelector: boolean;
  saveError: string | null;

  openGallery: () => void;
  closeGallery: () => void;

  openSettings: () => void;
  closeSettings: () => void;

  openTools: () => void;
  closeTools: () => void;

  openSaveSelector: () => void;
  closeSaveSelector: () => void;

  clearSaveError: () => void;
  /** Internal: set a save error message to display as a toast. */
  setSaveError: (msg: string) => void;
}

// ─── Slice factory ────────────────────────────────────────────────────────────

import type { StateCreator } from "zustand";

export const createUISlice: StateCreator<UISlice, [], [], UISlice> = (set) => ({
  showGallery: false,
  showSettings: false,
  showTools: false,
  showSaveSelector: false,
  saveError: null,

  openGallery:  () => set({ showGallery: true }),
  closeGallery: () => set({ showGallery: false }),

  openSettings:  () => set({ showSettings: true }),
  closeSettings: () => set({ showSettings: false }),

  openTools:  () => set({ showTools: true }),
  closeTools: () => set({ showTools: false }),

  openSaveSelector:  () => set({ showSaveSelector: true }),
  closeSaveSelector: () => set({ showSaveSelector: false }),

  clearSaveError: () => set({ saveError: null }),
  setSaveError:   (msg: string) => set({ saveError: msg }),
});
