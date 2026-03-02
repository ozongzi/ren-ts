// ─── Save serialisation helpers ───────────────────────────────────────────────
//
// This file contains only pure data helpers:
//   stateToSave   — extract a SaveData snapshot from a GameState
//   validateSave  — parse and validate an unknown object as SaveData
//   applySave     — merge a SaveData snapshot back into a GameState
//   formatLabel   — produce a human-readable location string from a label
//   formatTimestamp — format an ISO timestamp for display
//
// All platform-specific file I/O (Tauri plugin-fs, OPFS, download links, …)
// has been moved to src/saveStore.ts.

import type { GameState, SaveData, SpriteState } from "./types";
import { VarStore } from "./vars";
import { getDefineVars } from "./loader";
import { pruneInlineRegistry } from "./engine";

// ─── Constants ────────────────────────────────────────────────────────────────

export const SAVE_VERSION = 1 as const;

// ─── Serialisation ────────────────────────────────────────────────────────────

/** Extract a SaveData snapshot from the current GameState. */
export function stateToSave(state: GameState): SaveData {
  return {
    version: SAVE_VERSION,
    timestamp: new Date().toISOString(),
    currentLabel: state.currentLabel,
    stepIndex: state.stepIndex,
    callStack: state.callStack,
    vars: state.vars.stored(),
    completedRoutes: [...state.completedRoutes],
    backgroundSrc: state.backgroundSrc,
    bgFilter: state.bgFilter,
    sprites: state.sprites.map((sp) => ({ ...sp })),
    bgmSrc: state.bgmSrc,
    dialogue: state.dialogue ? { ...state.dialogue } : null,
  };
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate a parsed object is a well-formed SaveData.
 * Throws a descriptive Error if validation fails.
 */
export function validateSave(obj: unknown): SaveData {
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

// ─── Apply a save to a GameState ──────────────────────────────────────────────

/**
 * Normalise sprite z-indices so body sprites always sit below face sprites
 * for the same character group.
 */
function _normaliseSpriteZIndices(sprites: SpriteState[]): {
  sprites: SpriteState[];
  spriteCounter: number;
} {
  let spriteCounter = 0;

  const result = sprites.map((sp) => ({ ...sp }));

  // Group sprites by character prefix (everything before the first space)
  const atMap = new Map<string, SpriteState[]>();
  for (const sp of result) {
    const at = sp.key.split(" ")[0];
    const list = atMap.get(at) ?? [];
    list.push(sp);
    atMap.set(at, list);
  }

  for (const group of atMap.values()) {
    const bodyIdx = group.findIndex((sp) => sp.key.includes("body"));
    const faceIdx = group.findIndex((sp) => sp.key.includes("face"));

    if (bodyIdx !== -1 && faceIdx !== -1) {
      const maxBodyZ = group[bodyIdx].zIndex;
      const minFaceZ = group[faceIdx].zIndex;
      const maxGroupZ = Math.max(...group.map((s) => s.zIndex));

      if (minFaceZ <= maxBodyZ) {
        let nextZ = maxGroupZ + 1;
        group[faceIdx].zIndex = nextZ++;
        spriteCounter = Math.max(spriteCounter, nextZ);
      }
    }

    const maxZ = Math.max(...group.map((s) => s.zIndex));
    spriteCounter = Math.max(spriteCounter, maxZ + 1);
  }

  spriteCounter = Math.max(spriteCounter, result.length);

  return { sprites: result, spriteCounter };
}

/**
 * Merge a SaveData snapshot into a base GameState, returning the new state.
 * Audio sources are reset to null and restarted by the engine on first step.
 */
export function applySave(base: GameState, save: SaveData): GameState {
  const { sprites, spriteCounter } = _normaliseSpriteZIndices(
    save.sprites ?? [],
  );

  // Rebuild the VarStore: define vars as the layer-0 defaults, game vars on top.
  const vars = VarStore.fromSave(save.vars ?? {}, getDefineVars());

  // Prune stale inline label registry entries that are unreachable from the
  // restored call stack.
  pruneInlineRegistry(save.callStack ?? [], save.currentLabel);

  return {
    ...base,
    phase: "save_loaded",
    currentLabel: save.currentLabel,
    stepIndex: save.stepIndex,
    callStack: save.callStack ?? [],
    vars,
    completedRoutes: [...(save.completedRoutes ?? [])],
    backgroundSrc: save.backgroundSrc,
    bgFilter: save.bgFilter ?? null,
    bgmSrc: save.bgmSrc,
    // Audio playback sources reset — engine will replay on first step.
    sfxSrc: null,
    voiceSrc: null,
    sprites,
    spriteCounter,
    dialogue: save.dialogue,
    choices: null,
    waitingForInput: !!save.dialogue,
    autoAdvanceDelay: null,
    error: null,
  };
}

// ─── Display helpers ──────────────────────────────────────────────────────────

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Convert a raw label string (e.g. "day1_hiro", "route_true_end") into a
 * short human-readable location string for display in the save list.
 */
export function formatLabel(label: string): string {
  if (!label) return "未知位置";

  // "dayN_charname" pattern
  const dayCharMatch = label.match(/^day(\d+)_(.+)/i);
  if (dayCharMatch) {
    const day = dayCharMatch[1];
    const char = _capitalise(dayCharMatch[2].replace(/_/g, " "));
    return `第 ${day} 天 · ${char}`;
  }

  // "dayN" alone
  const dayMatch = label.match(/^day(\d+)$/i);
  if (dayMatch) return `第 ${dayMatch[1]} 天`;

  // "routeXXX" pattern
  const routeMatch = label.match(/^route_?(.+)/i);
  if (routeMatch) {
    return `路线：${_capitalise(routeMatch[1].replace(/_/g, " "))}`;
  }

  // Fallback: replace underscores with spaces and capitalise
  return _capitalise(label.replace(/_/g, " "));
}

function _capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
