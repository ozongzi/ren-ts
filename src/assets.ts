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
// All resolution goes through the active IFileSystem (ZipFS or WebFetchFS).
// resolveAsset() and resolveAudio() are now async; callers that previously
// received a synchronous URL string should await them instead.
//
// Path conventions inside the zip / server layout:
//   images/BGs/bg_bus.jpg        → image asset
//   Audio/BGM/foo.ogg            → audio asset
//   data/manifest.json           → loaded by loader.ts, not here

import { getFs } from "./filesystem";

// ─── Blob URL cache (sync access for already-resolved assets) ─────────────────
//
// Components that need a synchronous URL (e.g. <img src={url}>) can call
// resolveAssetSync() which returns the cached Blob URL if available, or an
// empty string while the async resolve is in-flight.  The component should
// call resolveAsset() in a useEffect / useAsset hook and re-render on settle.

const _urlCache: Map<string, string> = new Map();

/**
 * Async: resolve an asset path to a URL and cache it.
 * Returns "" for CSS colours (they need no resolution).
 */
export async function resolveAssetAsync(src: string): Promise<string> {
  if (!src) return "";
  if (isCssColor(src)) return src;

  const cached = _urlCache.get(src);
  if (cached !== undefined) return cached;

  const fsPath = _toFsPath(src);
  try {
    const url = await getFs().resolveUrl(fsPath);
    _urlCache.set(src, url);
    return url;
  } catch (err) {
    console.error(`[assets] Failed to resolve "${src}":`, err);
    _urlCache.set(src, "");
    return "";
  }
}

/**
 * Synchronous: return a cached URL, or "" if not yet resolved.
 * CSS colours are returned as-is immediately.
 */
export function resolveAsset(src: string): string {
  if (!src) return "";
  if (isCssColor(src)) return src;
  return _urlCache.get(src) ?? "";
}

/**
 * Async: resolve an audio src to a URL and cache it.
 */
export async function resolveAudioAsync(
  src: string | undefined,
): Promise<string> {
  if (!src) return "";
  return resolveAssetAsync(src);
}

/**
 * Synchronous: return a cached audio URL, or "" if not yet resolved.
 */
export function resolveAudio(src: string): string {
  if (!src) return "";
  return _urlCache.get(src) ?? "";
}

/**
 * Convert a raw script asset path to the filesystem path used inside the zip
 * or on the static server.
 *
 *   "BGs/bg.jpg"         → "images/BGs/bg.jpg"
 *   "images/BGs/bg.jpg"  → "images/BGs/bg.jpg"   (already prefixed)
 *   "Audio/BGM/foo.ogg"  → "Audio/BGM/foo.ogg"   (already correct)
 *   "#000000"            → "#000000"              (CSS colour, unchanged)
 */
function _toFsPath(src: string): string {
  if (isCssColor(src)) return src;
  if (isAudioPath(src)) return src;
  // Videos in Ren'Py are stored under the images/ directory by default,
  // so treat .webm exactly like image assets.
  // Image + video: strip any existing "images/" prefix then re-add
  const stripped = src.startsWith("images/")
    ? src.slice("images/".length)
    : src;
  return `images/${stripped}`;
}

// ─── Type guard helpers ───────────────────────────────────────────────────────

/** Returns true if the src is a CSS colour (starts with #) */
export function isCssColor(src: string): boolean {
  return src.startsWith("#");
}

/** Returns true if the src is an audio path */
export function isAudioPath(src: string): boolean {
  // Standard prefix used by most VNs
  if (src.startsWith("Audio/")) return true;
  // DDLC uses bare bgm/ sfx/ voice/ prefixes without "Audio/"
  if (src.startsWith("bgm/")) return true;
  if (src.startsWith("sfx/")) return true;
  if (src.startsWith("voice/")) return true;
  return false;
}

/** Returns true if the src is a video path (.webm) */
export function isVideoPath(src: string): boolean {
  return src.endsWith(".webm");
}

// ─── Path resolution ──────────────────────────────────────────────────────────

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

  // ── DDLC transforms (from transforms.rpyc, 1280px canvas) ─────────────────
  // Naming: [t|s|h|l|f|hf|i] + slot (1-char count)(1-char index)
  // All series share the same xcenter values per slot number.
  // thide / lhide = off-screen (move out)
  thide: -25, lhide: -25,

  // 1-up layouts
  t11: 50, s11: 50, h11: 50, l11: 50, f11: 50, hf11: 50, i11: 50,

  // 2-up layouts
  t21: 31.2, s21: 31.2, h21: 31.2, l21: 31.2, f21: 31.2, hf21: 31.2,
  t22: 68.8, s22: 68.8, h22: 68.8, l22: 68.8, f22: 68.8, hf22: 68.8,

  // 3-up layouts
  t31: 18.8, s31: 18.8, h31: 18.8, l31: 18.8, f31: 18.8, hf31: 18.8,
  t32: 50,   s32: 50,   h32: 50,   l32: 50,   f32: 50,   hf32: 50,
  t33: 81.2, s33: 81.2, h33: 81.2, l33: 81.2, f33: 81.2, hf33: 81.2,

  // 4-up layouts
  t41: 15.6, s41: 15.6, h41: 15.6, l41: 15.6, f41: 15.6, hf41: 15.6,
  t42: 38.5, s42: 38.5, h42: 38.5, l42: 38.5, f42: 38.5, hf42: 38.5,
  t43: 61.4, s43: 61.4, h43: 61.4, l43: 61.4, f43: 61.4, hf43: 61.4,
  t44: 84.4, s44: 84.4, h44: 84.4, l44: 84.4, f44: 84.4, hf44: 84.4,
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
