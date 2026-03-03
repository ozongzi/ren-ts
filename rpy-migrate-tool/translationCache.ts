// ─── translationCache.ts ──────────────────────────────────────────────────────
//
// Persistent storage for LLM translation maps using the Origin Private File
// System (OPFS).
//
// Layout inside OPFS:
//   llm_translation/<cacheKey>.json
//
// Each file is a plain JSON object: { "english text": "translated text", ... }
//
// The cacheKey is derived from the game directory name so each game gets its
// own independent cache file.
//
// Public API
// ──────────
//   loadCache(key)              → TranslationMap (empty if not found)
//   saveCache(key, map)         → void
//   clearCache(key)             → void
//   exportMapAsJson(map, name)  → triggers browser download
//   importMapFromJson(map)      → merges a user-picked JSON file into map
//                                 (empty-string values are skipped)
//   exportUntranslated(all, map, name) → downloads { "orig": "", ... } JSON
//
// Platform notes
// ──────────────
//   OPFS is available in all modern browsers (Chrome 86+, Firefox 111+,
//   Safari 15.2+) and inside Tauri WebViews.  On environments where OPFS is
//   unavailable the load/save functions degrade gracefully (load returns an
//   empty map, save is a no-op with a console warning).

import type { TranslationMap } from "./llmTranslate.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const OPFS_DIR = "llm_translation";

// ─── OPFS helpers ─────────────────────────────────────────────────────────────

/** Returns true when OPFS is available in this environment. */
function opfsAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function"
  );
}

/** Resolve (and optionally create) the llm_translation directory handle. */
async function getOpfsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create: true });
}

/** Sanitise a cache key so it is safe to use as a file name. */
function sanitiseKey(key: string): string {
  // Replace path separators and other special characters with underscores.
  return key
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120);
}

function cacheFileName(key: string): string {
  return `${sanitiseKey(key)}.json`;
}

// ─── loadCache ────────────────────────────────────────────────────────────────

/**
 * Load the persisted translation map for `cacheKey` from OPFS.
 * Returns an empty Map if the file does not exist or cannot be parsed.
 */
export async function loadCache(cacheKey: string): Promise<TranslationMap> {
  const map: TranslationMap = new Map();
  if (!opfsAvailable()) return map;

  try {
    const dir = await getOpfsDir();
    const fh = await dir.getFileHandle(cacheFileName(cacheKey));
    const file = await fh.getFile();
    const text = await file.text();
    const obj = JSON.parse(text);
    if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof k === "string" && typeof v === "string" && v !== "") {
          map.set(k, v);
        }
      }
    }
  } catch {
    // File not found or corrupt — return empty map.
  }

  return map;
}

// ─── saveCache ────────────────────────────────────────────────────────────────

/**
 * Persist the current translation map for `cacheKey` to OPFS.
 * Performs a full overwrite (not a merge) so deleted entries are removed.
 *
 * Silently no-ops when OPFS is unavailable.
 */
export async function saveCache(
  cacheKey: string,
  map: TranslationMap,
): Promise<void> {
  if (!opfsAvailable()) {
    console.warn("[translationCache] OPFS not available — cache not saved.");
    return;
  }

  try {
    const dir = await getOpfsDir();
    const fh = await dir.getFileHandle(cacheFileName(cacheKey), {
      create: true,
    });
    const writable = await fh.createWritable();
    await writable.write(mapToJson(map));
    await writable.close();
  } catch (err) {
    console.warn("[translationCache] Failed to save cache:", err);
  }
}

// ─── clearCache ───────────────────────────────────────────────────────────────

/**
 * Delete the persisted cache file for `cacheKey`.
 * Silently no-ops when the file does not exist or OPFS is unavailable.
 */
export async function clearCache(cacheKey: string): Promise<void> {
  if (!opfsAvailable()) return;

  try {
    const dir = await getOpfsDir();
    await dir.removeEntry(cacheFileName(cacheKey));
  } catch {
    // Not found — not an error.
  }
}

// ─── exportMapAsJson ──────────────────────────────────────────────────────────

/**
 * Trigger a browser download of the full translation map as a JSON file.
 *
 * @param map       The translation map to export.
 * @param gameName  Used to construct the suggested filename.
 */
export function exportMapAsJson(map: TranslationMap, gameName: string): void {
  const slug = gameName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  const ts = new Date().toISOString().slice(0, 10);
  const fileName = `translation_${slug}_${ts}.json`;
  triggerDownload(mapToJson(map), fileName);
}

// ─── importMapFromJson ────────────────────────────────────────────────────────

/**
 * Let the user pick a JSON file and merge its contents into `map`.
 *
 * Rules:
 *  • Only string-to-string pairs are accepted.
 *  • Values that are empty strings are skipped (treated as "not yet translated").
 *  • Existing entries in `map` are overwritten by non-empty values in the file.
 *
 * Returns the number of entries merged.
 * Returns null if the user cancelled the picker.
 * Throws if the file is not valid JSON or not an object.
 */
export async function importMapFromJson(
  map: TranslationMap,
): Promise<number | null> {
  let text: string;
  try {
    text = await pickJsonFile();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "已取消") return null;
    throw err;
  }

  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error("文件不是有效的 JSON 格式");
  }

  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new Error('JSON 格式应为对象 { "原文": "译文" }');
  }

  let merged = 0;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof k === "string" && typeof v === "string" && v.trim() !== "") {
      map.set(k, v);
      merged++;
    }
  }

  return merged;
}

// ─── exportUntranslated ───────────────────────────────────────────────────────

/**
 * Export all strings in `allTexts` that are NOT present in `map` as a JSON
 * object with empty-string values, ready for the user to fill in manually.
 *
 * Format:
 *   {
 *     "Hello": "",
 *     "How are you?": "",
 *     ...
 *   }
 *
 * After filling in the translations the user can import the file via
 * importMapFromJson() — empty-string values will be skipped automatically.
 *
 * @param allTexts  Complete list of extracted strings (may contain duplicates).
 * @param map       Current translation map.
 * @param gameName  Used to construct the suggested filename.
 */
export function exportUntranslated(
  allTexts: string[],
  map: TranslationMap,
  gameName: string,
): void {
  // Deduplicate and filter to only untranslated strings.
  const untranslated = [...new Set(allTexts)].filter((t) => !map.has(t));

  if (untranslated.length === 0) {
    // Nothing to export — caller should inform the user.
    return;
  }

  const obj: Record<string, string> = {};
  for (const t of untranslated) {
    obj[t] = "";
  }

  const slug = gameName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  const ts = new Date().toISOString().slice(0, 10);
  const fileName = `untranslated_${slug}_${ts}.json`;
  triggerDownload(JSON.stringify(obj, null, 2), fileName);
}

// ─── cacheStats ───────────────────────────────────────────────────────────────

/**
 * Return the number of entries currently in the cache for a given key,
 * without loading the full map (reads from OPFS but only counts entries).
 *
 * Returns 0 on any error or if no cache exists yet.
 */
export async function cacheStats(cacheKey: string): Promise<{ count: number }> {
  if (!opfsAvailable()) return { count: 0 };

  try {
    const dir = await getOpfsDir();
    const fh = await dir.getFileHandle(cacheFileName(cacheKey));
    const file = await fh.getFile();
    const text = await file.text();
    const obj = JSON.parse(text);
    if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
      const count = Object.values(obj).filter(
        (v) => typeof v === "string" && v !== "",
      ).length;
      return { count };
    }
  } catch {
    // Not found or corrupt.
  }

  return { count: 0 };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Serialise a TranslationMap to a pretty-printed JSON string. */
function mapToJson(map: TranslationMap): string {
  // Sort keys for deterministic output (easier to diff / review).
  const obj: Record<string, string> = {};
  for (const [k, v] of [...map.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    obj[k] = v;
  }
  return JSON.stringify(obj, null, 2);
}

/** Trigger a browser file download with the given text content. */
function triggerDownload(content: string, fileName: string): void {
  const blob = new Blob([content], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Show a file picker limited to .json files and return the file's text. */
function pickJsonFile(): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.style.display = "none";

    input.onchange = async () => {
      const file = input.files?.[0];
      document.body.removeChild(input);
      if (!file) {
        reject(new Error("已取消"));
        return;
      }
      try {
        resolve(await file.text());
      } catch (err) {
        reject(err);
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
