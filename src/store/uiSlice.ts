// ─── UI Slice ─────────────────────────────────────────────────────────────────
//
// Manages modal visibility flags and transient UI-only state that is never
// persisted to disk.
//
//   showGallery      — CG gallery modal
//   showSettings     — settings modal
//   showTools        — converter tools panel (only on supported platforms)
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
import { supportsConversionTools } from "../tauri_bridge";

export const createUISlice: StateCreator<UISlice, [], [], UISlice> = (set) => ({
  showGallery: false,
  showSettings: false,
  showTools: false,
  showSaveSelector: false,
  saveError: null,

  openGallery: () => set({ showGallery: true }),
  closeGallery: () => set({ showGallery: false }),

  openSettings: () => set({ showSettings: true }),
  closeSettings: () => set({ showSettings: false }),

  openTools: () => {
    if (!supportsConversionTools) {
      set({
        saveError:
          "转换工具仅支持 Tauri 桌面端（macOS / Windows / Linux）以及 Chrome / Edge 浏览器。当前环境不支持所需的文件系统 API。",
      });
      return;
    }
    set({ showTools: true });
  },
  closeTools: () => set({ showTools: false }),

  openSaveSelector: () => set({ showSaveSelector: true }),
  closeSaveSelector: () => set({ showSaveSelector: false }),

  clearSaveError: () => set({ saveError: null }),
  setSaveError: (msg: string) => set({ saveError: msg }),
});
