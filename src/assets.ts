// ─── Asset path resolver ──────────────────────────────────────────────────────
//
// The JSON script files reference assets with paths like:
//   "CGs/cg1_arrival1.jpg"       → images
//   "BGs/bg_bus.jpg"             → images
//   "Sprites/Body/Keitaro_Casual.png" → images
//   "UI/logo.png"                → images
//   "Audio/BGM/Outdoors.ogg"     → audio
//   "Audio/SFX/sfx_door.ogg"     → audio
//   "Audio/Voice/..."            → audio
//   "#000000"                    → CSS color (no file)
//
// ── Web mode ──
//   All image assets live under /assets/images/
//   All audio assets live under /assets/Audio/
//   (note: capital A in "Audio" matches the real directory)
//
// ── Tauri mode (user-specified assets directory) ──
//   The user picks their `assets/` folder at first launch.  Paths are
//   converted via convertFileSrc() from tauri_bridge so the WebView can load
//   them via the asset:// protocol.
//     images  → <assetsDir>/images/<src>
//     audio   → <assetsDir>/<src>

import {
  isTauri,
  getActiveAssetsDir,
  convertFileSrcSync,
  buildNativeImagePath,
  buildNativeAudioPath,
} from "./tauri_bridge";

// ─── Type guard helpers ───────────────────────────────────────────────────────

/** Returns true if the src is a CSS colour (starts with #) */
export function isCssColor(src: string): boolean {
  return src.startsWith("#");
}

/** Returns true if the src is an audio path */
export function isAudioPath(src: string): boolean {
  return src.startsWith("Audio/");
}

/** Returns true if the src is a video path (.webm) */
export function isVideoPath(src: string): boolean {
  return src.endsWith(".webm");
}

// ─── Path resolution ──────────────────────────────────────────────────────────

/**
 * Convert a raw src string from the JSON data into a URL that the browser
 * can load at runtime.
 *
 * Web mode:
 *   - CSS colours  → returned as-is
 *   - Audio paths  → prefixed with /assets/
 *   - Image paths  → prefixed with /assets/images/
 *
 * Tauri mode (assetsDir set):
 *   - CSS colours  → returned as-is
 *   - Audio paths  → convertFileSrc(<assetsDir>/<src>)
 *   - Image paths  → convertFileSrc(<assetsDir>/images/<src>)
 */
/**
 * Convert a raw src string from the JSON data into a URL the browser can load.
 *
 * When `src` contains no "/" and is not a CSS colour, it is treated as an
 * unresolved image key (e.g. "cg.arrival2" — not found in the defines dict).
 * The fallback converts it to a path by replacing "." with "_":
 *   "cg.arrival2"      → images/cg_arrival2.jpg   (tries .jpg first)
 *   "bg_entrance_day"  → images/bg_entrance_day.jpg
 * Extensions other than .jpg will not be found via this fallback — games
 * should declare all images explicitly in their script.rpy so the codegen
 * resolves them at compile time.
 */
export function resolveAsset(src: string): string {
  if (!src) return "";
  if (isCssColor(src)) return src;

  // ── Unresolved image key fallback ──────────────────────────────────────────
  // Keys reach here when the codegen couldn't find the image in the imageMap.
  // They have no "/" and are not a colour.  Convert to a best-guess path.
  if (!src.includes("/") && !src.startsWith("#")) {
    // "cg.arrival2" → "cg_arrival2", "bg_entrance_day" → "bg_entrance_day"
    const filename = src.replace(/\./g, "_");
    // Recurse with the fallback path (defaults to .jpg; games should declare
    // all images explicitly to avoid this path)
    return resolveAsset(`images/${filename}.jpg`);
  }

  if (isTauri) {
    const assetsDir = getActiveAssetsDir();
    if (assetsDir) {
      if (isAudioPath(src)) {
        return convertFileSrcSync(buildNativeAudioPath(assetsDir, src));
      }
      return convertFileSrcSync(buildNativeImagePath(assetsDir, src));
    }
    // Tauri but no assetsDir chosen yet — return empty so <img> doesn't 404
    return "";
  }

  // ── Web mode ──
  if (isAudioPath(src)) return `/assets/${src}`;
  // Image asset (BGs, CGs, Sprites, UI, FX, Animated CGs, …)
  // Some verbatim .rpy paths already include the "images/" segment
  // (e.g. "images/BGs/foo.jpg"); strip it before prepending so we never
  // produce a double "images/images/" prefix.
  const imgSrc = src.startsWith("images/") ? src.slice("images/".length) : src;
  return `/assets/images/${imgSrc}`;
}

/**
 * Convenience: resolve an audio src.
 *
 * Web:   returns the /assets/ prefixed URL.
 * Tauri: returns an asset:// URL using the active assetsDir.
 *
 * If the src is already an absolute path / URL it is returned unchanged.
 */
export function resolveAudio(src: string): string {
  if (!src) return "";
  // Already an absolute URL or native path
  if (src.startsWith("/") || src.startsWith("asset://")) return src;

  if (isTauri) {
    const assetsDir = getActiveAssetsDir();
    if (assetsDir && isAudioPath(src)) {
      return convertFileSrcSync(buildNativeAudioPath(assetsDir, src));
    }
    return "";
  }

  if (isAudioPath(src)) return `/assets/${src}`;
  return src;
}

// ─── Sprite classification ────────────────────────────────────────────────────

/**
 * Sprite keys use the Ren'Py tag system with dots as separators:
 *   "keitaro_casual"   — body sprite  (no dot → tag = whole key)
 *   "keitaro.normal1"  — face sprite  (has dot → tag = "keitaro")
 *   "cg.arrival2"      — CG image     (has dot → tag = "cg")
 *   "bg_entrance_day"  — BG overlay   (no dot → tag = whole key)
 *   "hina.sick.normal1"— multi-attr face
 *
 * A sprite is considered *positioned* (rendered at an `at` slot on screen)
 * when it has an explicit `at` value.  Body and face sprites both carry `at`.
 * Full-screen layers (CGs shown after `scene`) have no `at`.
 */
export function isCharacterSprite(_spriteKey: string, at?: string): boolean {
  // Any sprite with an explicit position is a character sprite
  return at !== undefined && at !== "";
}

/**
 * Extract the TAG from a sprite key (first dot-segment, or whole key).
 *   "keitaro.normal1"  → "keitaro"
 *   "keitaro_casual"   → "keitaro_casual"
 *   "cg.arrival2"      → "cg"
 */
export function spriteCharacterName(spriteKey: string): string | null {
  // For backward compat: return the tag portion as the "character name"
  const dotIdx = spriteKey.indexOf(".");
  if (dotIdx >= 0) return spriteKey.slice(0, dotIdx);
  // Body sprites have underscores: "keitaro_casual" → "keitaro"
  const uscIdx = spriteKey.indexOf("_");
  if (uscIdx >= 0) return spriteKey.slice(0, uscIdx);
  return spriteKey;
}

/**
 * Returns true if the sprite key represents a face/expression layer.
 * In the new dot notation, any key containing a dot is a face/attr sprite
 * (e.g. "keitaro.normal1", "hina.sick.normal1").
 */
export function isFaceSprite(spriteKey: string): boolean {
  return spriteKey.includes(".");
}

/**
 * Returns true if the sprite key represents a body layer.
 * Body sprites have no dots (e.g. "keitaro_casual", "hiro2_camp").
 */
export function isBodySprite(spriteKey: string): boolean {
  return !spriteKey.includes(".");
}

// ─── Position helpers ─────────────────────────────────────────────────────────

/** Known Ren'Py `at` position names mapped to CSS left-percentages. */
export const AT_POSITION_LEFT: Record<string, number> = {
  offscreenleft: -20,
  left: 25,
  cleft: 27,
  center: 50,
  cright: 73,
  right: 75,
  offscreenright: 120,
  truecenter: 50,
  fx_pos: 50,
  sniff: 55,

  // left1–left4 / right1–right4
  left1: 30,
  left2: 35,
  left3: 43,
  left4: 45,
  right1: 70,
  right2: 65,
  right3: 57,
  right4: 55,
};

/**
 * Convert a Ren'Py `at` string into a CSS `left` percentage string, or
 * return undefined if the position is unknown.
 *
 * Handles:
/**
 * Runtime position table populated from `position.xxx = 0.94;` defines
 * in script.rrs (converted from Ren'Py `Position(xpos=...)` declarations).
 * Values are xpos fractions (0–1); multiply by 100 for CSS left%.
 */
const _runtimePositions: Record<string, number> = {};

/** Register a position from a parsed `position.NAME = VALUE` define. */
export function registerPosition(name: string, xpos: number): void {
  _runtimePositions[name.toLowerCase()] = xpos;
}

/**
 * Convert a Ren'Py `at` string into a CSS `left` percentage string, or
 * return undefined if the position is unknown.
 *
 * Priority:
 *  1. Runtime positions registered via registerPosition() (from script.rrs)
 *  2. Hardcoded fallback table AT_POSITION_LEFT
 */
export function atToLeftPercent(at: string): string | undefined {
  const lower = at.toLowerCase();
  const runtime = _runtimePositions[lower];
  if (runtime !== undefined) return `${Math.round(runtime * 100)}%`;
  const val = AT_POSITION_LEFT[lower];
  if (val !== undefined) return `${val}%`;
  return undefined;
}
