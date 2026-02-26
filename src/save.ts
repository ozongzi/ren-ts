// ─── Save / Load System ───────────────────────────────────────────────────────
//
// All persistence is file-based. No data is stored in the browser.
//
// File format: SaveData (see types.ts)
//
// Three tiers of file access — chosen automatically at runtime:
//
//   Tauri desktop (tauri_bridge.isTauri):
//     openSaveFile()       → Tauri dialog.open → reads via plugin-fs
//     pickNewSaveFile()    → Tauri dialog.save → writes placeholder via plugin-fs
//     autoSaveToHandle()   → overwrites by path via plugin-fs (no handle needed)
//
//   File System Access API (Chrome / Edge 86+ in browser):
//     openSaveFile()       → showOpenFilePicker → FileSystemFileHandle
//     pickNewSaveFile()    → showSaveFilePicker → FileSystemFileHandle
//     autoSaveToHandle()   → handle.createWritable() + write
//
//   Legacy fallback (Firefox / older Safari — no auto-save):
//     exportSave(state)    → triggers browser file download of a .json save
//     importSave()         → <input type="file"> picker, returns parsed SaveData
//
//   Shared:
//     applySave(base, save)→ merges a SaveData snapshot into a GameState

import type { GameState, SaveData, SpriteState } from "./types";
import { VarStore } from "./vars";
import { getDefineVars } from "./loader";
import {
  isTauri,
  pickAndReadTextFile,
  pickAndWriteTextFile,
  writeTextFileTauri,
} from "./tauri_bridge";

// ─── Constants ────────────────────────────────────────────────────────────────

const SAVE_VERSION = 1 as const;

// ─── Capability detection ─────────────────────────────────────────────────────

/** True when the browser supports the File System Access API. */
export const fsaAvailable: boolean =
  !isTauri &&
  typeof window !== "undefined" &&
  "showOpenFilePicker" in window &&
  "showSaveFilePicker" in window;

/**
 * True when some form of auto-save is available:
 *   - Tauri: always (we can write to any path via plugin-fs)
 *   - Browser: only when Chrome/Edge supports the FSA write API
 */
export const autoSaveAvailable: boolean = isTauri || fsaAvailable;

// Typed shims so we don't need `any` everywhere below.
type ShowOpenFilePicker = (
  options?: Record<string, unknown>,
) => Promise<FileSystemFileHandle[]>;
type ShowSaveFilePicker = (
  options?: Record<string, unknown>,
) => Promise<FileSystemFileHandle>;

const _showOpen = (): ShowOpenFilePicker =>
  (window as unknown as { showOpenFilePicker: ShowOpenFilePicker })
    .showOpenFilePicker;
const _showSave = (): ShowSaveFilePicker =>
  (window as unknown as { showSaveFilePicker: ShowSaveFilePicker })
    .showSaveFilePicker;

const FSA_FILE_TYPES = {
  types: [
    {
      description: "游戏存档",
      accept: { "application/json": [".json"] as `.${string}`[] },
    },
  ],
  excludeAcceptAllOption: false,
};

// ─── Serialisation helpers ────────────────────────────────────────────────────

/** Extract a SaveData snapshot from the current GameState. */
export function stateToSave(state: GameState): SaveData {
  // Extract the game-vars layer (these are the values that get serialized).
  const rawVars = state.vars.stored();

  // Normalize certain define-like keys (persistent.*) that may have been
  // represented as string literals into typed JS values so the save file
  // contains booleans/numbers/null instead of string words like "true".
  const vars: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawVars)) {
    if (k.startsWith("persistent.") && typeof v === "string") {
      const s = v.trim();
      const low = s.toLowerCase();
      if (low === "true") {
        vars[k] = true;
        continue;
      }
      if (low === "false") {
        vars[k] = false;
        continue;
      }
      if (low === "none") {
        vars[k] = null;
        continue;
      }
      // Try numeric conversion (integers and floats). Preserve as string if
      // conversion yields NaN or the original string is empty.
      const n = Number(s);
      if (!Number.isNaN(n) && s !== "") {
        vars[k] = n;
        continue;
      }
    }
    // Default: keep original value
    vars[k] = v;
  }

  return {
    version: SAVE_VERSION,
    timestamp: new Date().toISOString(),
    currentLabel: state.currentLabel,
    stepIndex: state.stepIndex,
    callStack: state.callStack,
    vars,
    completedRoutes: [...state.completedRoutes],
    backgroundSrc: state.backgroundSrc,
    bgFilter: state.bgFilter,
    sprites: state.sprites.map((sp) => ({ ...sp })),
    bgmSrc: state.bgmSrc,
    dialogue: state.dialogue ? { ...state.dialogue } : null,
  };
}

/**
 * Validate a parsed object is a well-formed SaveData.
 * Throws if it looks wrong so callers can catch and report the error.
 */
function validateSave(obj: unknown): SaveData {
  if (!obj || typeof obj !== "object") {
    throw new Error("存档文件无效（不是对象）");
  }
  const s = obj as Record<string, unknown>;

  if (s.version !== SAVE_VERSION) {
    throw new Error(
      `存档版本不兼容（期望 ${SAVE_VERSION}，实际 ${s.version}）`,
    );
  }
  if (typeof s.currentLabel !== "string") {
    throw new Error("存档损坏：缺少 currentLabel 字段");
  }
  if (typeof s.stepIndex !== "number") {
    throw new Error("存档损坏：缺少 stepIndex 字段");
  }

  return {
    version: SAVE_VERSION,
    timestamp:
      typeof s.timestamp === "string" ? s.timestamp : new Date().toISOString(),
    currentLabel: s.currentLabel,
    stepIndex: s.stepIndex,
    callStack: Array.isArray(s.callStack) ? s.callStack : [],
    vars:
      s.vars && typeof s.vars === "object" && !Array.isArray(s.vars)
        ? (s.vars as Record<string, unknown>)
        : {},
    completedRoutes: Array.isArray(s.completedRoutes) ? s.completedRoutes : [],
    backgroundSrc: typeof s.backgroundSrc === "string" ? s.backgroundSrc : null,
    bgFilter: typeof s.bgFilter === "string" ? s.bgFilter : null,
    sprites: Array.isArray(s.sprites) ? s.sprites : [],
    bgmSrc: typeof s.bgmSrc === "string" ? s.bgmSrc : null,
    dialogue:
      s.dialogue && typeof s.dialogue === "object" && !Array.isArray(s.dialogue)
        ? (s.dialogue as import("./types").DialogueState)
        : null,
  };
}

// ─── File System Access API ───────────────────────────────────────────────────

/** Returned by {@link openSaveFile}. */
export interface LoadedSave {
  save: SaveData;
  /**
   * Browser FSA handle for auto-saves (Chrome/Edge only).
   * `null` in Tauri mode (we use `savePath` instead) and in legacy fallback.
   */
  handle: FileSystemFileHandle | null;
  /**
   * Native filesystem path for Tauri auto-saves.
   * `null` in browser mode.
   */
  savePath: string | null;
}

/**
 * Open an existing save file.
 *
 * - **Tauri path**: uses `plugin-dialog` open picker; reads file via
 *   `plugin-fs`.  Returns `savePath` for subsequent auto-saves.
 * - **FSA path** (Chrome/Edge): uses `showOpenFilePicker` so the handle can
 *   be reused for subsequent auto-saves to the same file.
 * - **Fallback path** (Firefox/Safari): falls back to a hidden
 *   `<input type="file">` — save data is read but neither handle nor path is
 *   available so auto-saving is unavailable.
 *
 * Throws `"已取消"` if the user dismisses the picker.
 */
export async function openSaveFile(): Promise<LoadedSave> {
  // ── Tauri path ────────────────────────────────────────────────────────────
  if (isTauri) {
    const result = await pickAndReadTextFile({
      title: "打开存档文件",
      filters: [{ name: "游戏存档", extensions: ["json"] }],
    });
    if (!result) throw new Error("已取消");
    const save = validateSave(JSON.parse(result.text));
    return { save, handle: null, savePath: result.path };
  }

  // ── FSA path (Chrome/Edge) ────────────────────────────────────────────────
  if (fsaAvailable) {
    let handles: FileSystemFileHandle[];
    try {
      handles = await _showOpen()({ ...FSA_FILE_TYPES, multiple: false });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error("已取消");
      }
      throw err;
    }
    const handle = handles[0];
    const file = await handle.getFile();
    const text = await file.text();
    const save = validateSave(JSON.parse(text));
    return { save, handle, savePath: null };
  }

  // ── Legacy fallback ──────────────────────────────────────────────────────
  const save = await importSave();
  return { save, handle: null, savePath: null };
}

// ─── NewSaveResult ────────────────────────────────────────────────────────────

/**
 * Returned by {@link pickNewSaveFile} — holds whichever handle/path is
 * appropriate for the current runtime.
 */
export interface NewSaveLocation {
  /** FSA handle (browser Chrome/Edge). Null in Tauri or legacy fallback. */
  handle: FileSystemFileHandle | null;
  /** Native path (Tauri). Null in browser mode. */
  path: string | null;
  /** Human-readable file name shown in the UI. */
  fileName: string | null;
}

/**
 * Show a "Save As" dialog so the player can choose where the auto-save file
 * will live.
 *
 * - **Tauri**: uses `plugin-dialog` save picker + writes a placeholder via
 *   `plugin-fs`.
 * - **FSA** (Chrome/Edge): uses `showSaveFilePicker` + writes a placeholder.
 * - **Fallback**: returns `{ handle: null, path: null, fileName: null }` —
 *   the caller starts the game without auto-save.
 *
 * Returns the same "null location" struct if the user cancels.
 */
export async function pickNewSaveFile(): Promise<NewSaveLocation> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const suggestedName = `rr_save_${ts}.json`;

  // ── Tauri path ────────────────────────────────────────────────────────────
  if (isTauri) {
    const chosenPath = await pickAndWriteTextFile("{}", {
      title: "选择自动存档位置",
      defaultPath: suggestedName,
      filters: [{ name: "游戏存档", extensions: ["json"] }],
    });
    if (!chosenPath) return { handle: null, path: null, fileName: null };
    const fileName = chosenPath.split(/[/\\]/).pop() ?? chosenPath;
    return { handle: null, path: chosenPath, fileName };
  }

  // ── FSA path (Chrome/Edge) ────────────────────────────────────────────────
  if (!fsaAvailable) return { handle: null, path: null, fileName: null };

  let handle: FileSystemFileHandle;
  try {
    handle = await _showSave()({
      suggestedName,
      ...FSA_FILE_TYPES,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { handle: null, path: null, fileName: null };
    }
    throw err;
  }

  // Touch the file so it exists on disk right away.
  try {
    const writable = await handle.createWritable();
    await writable.write("{}");
    await writable.close();
  } catch {
    // Non-fatal — the first real auto-save will create proper content.
  }

  return { handle, path: null, fileName: handle.name };
}

/**
 * Serialize `state` and auto-save it using whichever mechanism is available.
 *
 * Pass either `handle` (FSA / browser) or `savePath` (Tauri) — whichever is
 * non-null is used.  If both are null this is a no-op (no auto-save location
 * was chosen).
 *
 * Designed to be called fire-and-forget; errors are thrown to the caller for
 * optional logging.
 */
export async function autoSaveToHandle(
  handle: FileSystemFileHandle | null,
  state: GameState,
  savePath?: string | null,
): Promise<void> {
  const data = stateToSave(state);
  const json = JSON.stringify(data, null, 2);

  // ── Tauri path ────────────────────────────────────────────────────────────
  if (savePath) {
    await writeTextFileTauri(savePath, json);
    return;
  }

  // ── FSA path (browser) ────────────────────────────────────────────────────
  if (handle) {
    const writable = await handle.createWritable();
    await writable.write(json);
    await writable.close();
  }
}

// ─── File export (download) ───────────────────────────────────────────────────

/**
 * Serialize the current game state and trigger a browser file download.
 * The suggested file name is `rr_save_<timestamp>.json`.
 */
export function exportSave(state: GameState): void {
  const data = stateToSave(state);
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `rr_save_${ts}.json`;

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

// ─── File import (file picker) ────────────────────────────────────────────────

/**
 * Open a file picker and load a save file.
 * Returns a Promise that resolves with the parsed SaveData, or rejects with
 * an error message if the file is missing, unreadable, or invalid.
 */
export function importSave(): Promise<SaveData> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.style.display = "none";

    input.onchange = async () => {
      const file = input.files?.[0];
      document.body.removeChild(input);

      if (!file) {
        reject(new Error("没有选择文件"));
        return;
      }

      try {
        const text = await file.text();
        const obj = JSON.parse(text);
        const save = validateSave(obj);
        resolve(save);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    input.oncancel = () => {
      document.body.removeChild(input);
      reject(new Error("已取消"));
    };

    document.body.appendChild(input);
    input.click();
  });
}

// ─── Apply a save to a GameState ──────────────────────────────────────────────

// ─── Sprite zIndex normalisation ─────────────────────────────────────────────

/**
 * Returns true when a sprite key represents a face / expression layer.
 * Expression keys contain a space (e.g. "yoichi playful1", "hiro laugh2")
 * while body keys use underscores (e.g. "yoichi_camp", "hiro2_camp").
 * CG sprites also contain a space but always start with "cg " so they are
 * explicitly excluded.
 */
function _isExpressionKey(key: string): boolean {
  const spaceIdx = key.indexOf(" ");
  return spaceIdx > 0 && !key.toLowerCase().startsWith("cg ");
}

/**
 * Fix any positioned sprite group where a face/expression sprite has a lower
 * zIndex than its sibling body sprite.
 *
 * This can happen when:
 *  - A save file was manually constructed with the wrong ordering.
 *  - A game-script bug showed a face before the body during the same sequence.
 *
 * Within each `at`-position group, we find the maximum body zIndex and the
 * minimum face zIndex.  If face ≤ body we bump every face sprite in that
 * group to (maxGroupZ + 1, +2, …) so it always renders on top.
 *
 * The spriteCounter returned is max(all zIndices after normalisation) + 1 so
 * that subsequent show steps continue numbering above the loaded sprites.
 */
function _normaliseSpriteZIndices(sprites: SpriteState[]): {
  sprites: SpriteState[];
  spriteCounter: number;
} {
  if (sprites.length === 0) return { sprites: [], spriteCounter: 0 };

  const result = sprites.map((sp) => ({ ...sp }));

  // Group indices by `at` position (only positioned sprites can overlap)
  const atMap = new Map<string, number[]>();
  for (let i = 0; i < result.length; i++) {
    const at = result[i].at;
    if (at) {
      const list = atMap.get(at) ?? [];
      list.push(i);
      atMap.set(at, list);
    }
  }

  for (const indices of atMap.values()) {
    if (indices.length < 2) continue;

    const bodyIdx = indices.filter((i) => !_isExpressionKey(result[i].key));
    const faceIdx = indices.filter((i) => _isExpressionKey(result[i].key));

    if (bodyIdx.length === 0 || faceIdx.length === 0) continue;

    const maxBodyZ = Math.max(...bodyIdx.map((i) => result[i].zIndex));
    const minFaceZ = Math.min(...faceIdx.map((i) => result[i].zIndex));

    if (minFaceZ <= maxBodyZ) {
      // Bump face sprites above the whole group
      const maxGroupZ = Math.max(...indices.map((i) => result[i].zIndex));
      let nextZ = maxGroupZ + 1;
      for (const fi of faceIdx) {
        result[fi] = { ...result[fi], zIndex: nextZ++ };
      }
    }
  }

  const maxZ = result.reduce((m, sp) => Math.max(m, sp.zIndex), 0);
  return { sprites: result, spriteCounter: maxZ + 1 };
}

/**
 * Merge a SaveData snapshot into an existing GameState, returning a new
 * GameState ready to resume play.
 *
 * Visual state (sprites, dialogue, bgm) is restored from the save so the
 * player immediately sees the scene and dialogue they saved at.
 */
export function applySave(base: GameState, save: SaveData): GameState {
  // Normalise face/body zIndex ordering and restore the spriteCounter so that
  // any new show steps executed after loading continue numbering above the
  // sprites that were loaded from disk.
  const { sprites, spriteCounter } = _normaliseSpriteZIndices(
    save.sprites ?? [],
  );

  return {
    ...base,
    phase: "playing",
    currentLabel: save.currentLabel,
    stepIndex: save.stepIndex,
    callStack: save.callStack,
    vars: VarStore.fromSave(save.vars, getDefineVars()),
    completedRoutes: save.completedRoutes,

    // Restore visual / audio snapshot from the save
    backgroundSrc: save.backgroundSrc ?? null,
    bgFilter: save.bgFilter ?? null,
    sprites,
    spriteCounter,
    bgmSrc: save.bgmSrc ?? null,
    sfxSrc: null,
    voiceSrc: null,
    dialogue: save.dialogue ?? null,
    choices: null,
    // If there is dialogue to show the player must click to continue
    waitingForInput: save.dialogue != null,
    autoAdvanceDelay: null,
    error: null,
  };
}

// ─── Format helpers ───────────────────────────────────────────────────────────

/**
 * Format a save timestamp into a human-readable Chinese date string.
 * e.g. "2024-06-15T12:34:56.000Z" → "2024/06/15 12:34"
 */
export function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

/**
 * Convert a label name like "day8_hiro" into a human-friendly string like
 * "第8天 · Hiro".  Falls back to the raw label name for unknown patterns.
 */
export function formatLabel(label: string): string {
  // day<N>_<character>
  const dayCharMatch = label.match(/^day(\d+)_(\w+)$/);
  if (dayCharMatch) {
    const day = dayCharMatch[1];
    const char = _capitalise(dayCharMatch[2]);
    return `第${day}天 · ${char}`;
  }
  // day<N>
  const dayMatch = label.match(/^day(\d+)$/);
  if (dayMatch) {
    return `第${dayMatch[1]}天`;
  }
  // hiro_N, hunter_N, etc.
  const routeMatch = label.match(/^(\w+?)_(\d+)$/);
  if (routeMatch) {
    return `${_capitalise(routeMatch[1])} 路线 · 第${routeMatch[2]}章`;
  }
  return label;
}

function _capitalise(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
