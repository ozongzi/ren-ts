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
export function resolveAsset(src: string): string {
  if (!src) return "";
  if (isCssColor(src)) return src;

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
 * Character sprite names follow patterns like:
 *   "keitaro body"
 *   "keitaro face_normal"
 *   "hiro body"
 *   "hunter face_happy"
 *
 * CG / scene sprite names follow patterns like:
 *   "cg arrival1"
 *   "cg_arrival1"
 *   "bg forest"
 *   "logo"
 *   "overlay dark"
 *
 * We consider a sprite to be a *positioned character sprite* (rendered at an
 * `at` position on screen) if it is explicitly given an `at` value in the
 * show step OR if the sprite key looks like a character name.
 *
 * A sprite WITHOUT an `at` value is treated as a full-screen layer (CG, BG
 * overlay, UI element).
 */
export function isCharacterSprite(spriteKey: string, at?: string): boolean {
  if (at) return true;
  // Even without `at`, a few patterns are clearly character sprites:
  const lower = spriteKey.toLowerCase();
  if (lower.includes(" body") || lower.includes(" face")) return true;
  return false;
}

/**
 * Extract the "character name" portion from a sprite key like "keitaro body"
 * or "keitaro face_happy".  Returns null for non-character sprites.
 */
export function spriteCharacterName(spriteKey: string): string | null {
  const lower = spriteKey.toLowerCase();
  const bodyIdx = lower.indexOf(" body");
  if (bodyIdx !== -1) return spriteKey.slice(0, bodyIdx);
  const faceIdx = lower.indexOf(" face");
  if (faceIdx !== -1) return spriteKey.slice(0, faceIdx);
  return null;
}

/**
 * Returns true if the sprite key represents a face layer (rendered on top of
 * the body layer for the same character).
 */
export function isFaceSprite(spriteKey: string): boolean {
  return spriteKey.toLowerCase().includes(" face");
}

/**
 * Returns true if the sprite key represents a body layer.
 */
export function isBodySprite(spriteKey: string): boolean {
  return spriteKey.toLowerCase().includes(" body");
}

// ─── Position helpers ─────────────────────────────────────────────────────────

/** Known Ren'Py `at` position names mapped to CSS left-percentages. */
export const AT_POSITION_LEFT: Record<string, number> = {
  offscreenleft: -20,
  left: 15,
  cleft: 27,
  center: 50,
  cright: 73,
  right: 85,
  offscreenright: 120,
  truecenter: 50,
  // fx / misc special positions
  fx_pos: 50,
  sniff: 50,
};

// Positions for left1-4 and right1-4 (used in 2-character and
// multi-character scenes where characters need distinct slots).
//   left1 ≈ cleft, left2 ≈ 25 %, left3 ≈ 35 %, left4 ≈ 42 %
//   right1 ≈ cright, right2 ≈ 75 %, right3 ≈ 65 %, right4 ≈ 58 %
const LEFT_NUMBERED: Record<number, number> = { 1: 18, 2: 25, 3: 35, 4: 42 };
const RIGHT_NUMBERED: Record<number, number> = { 1: 82, 2: 75, 3: 65, 4: 58 };

/**
 * Convert a Ren'Py `at` string into a CSS `left` percentage string, or
 * return undefined if the position is unknown.
 *
 * Handles:
 *  • Named positions in AT_POSITION_LEFT (left, right, center, …)
 *  • left1–left4 / right1–right4
 *  • pN_K  and  pN_Ka  (group-scene slots: K-th of N characters)
 *    Uses the formula  left% = K / (N + 1) * 100
 */
export function atToLeftPercent(at: string): string | undefined {
  const lower = at.toLowerCase();

  // 1. Named lookup
  const named = AT_POSITION_LEFT[lower];
  if (named !== undefined) return `${named}%`;

  // 2. leftN / rightN  (e.g. "left2", "right3")
  const lrMatch = lower.match(/^(left|right)(\d)$/);
  if (lrMatch) {
    const side = lrMatch[1];
    const n = parseInt(lrMatch[2], 10);
    const val = side === "left" ? LEFT_NUMBERED[n] : RIGHT_NUMBERED[n];
    if (val !== undefined) return `${val}%`;
  }

  // 3. pN_K  or  pN_Ka  (e.g. "p4_2", "p7_3a")
  //    N = total characters in the group, K = this character's slot (1-based)
  const groupMatch = lower.match(/^p(\d+)_(\d+)[a-z]?$/);
  if (groupMatch) {
    const n = parseInt(groupMatch[1], 10);
    const k = parseInt(groupMatch[2], 10);
    if (n > 0 && k >= 1 && k <= n) {
      const pct = Math.round((k / (n + 1)) * 100);
      return `${pct}%`;
    }
  }

  return undefined;
}
