// ─── SaveStore ────────────────────────────────────────────────────────────────
//
// A unified interface for reading and writing save files across all platforms.
//
// Three implementations, selected at runtime:
//
//   TauriSaveStore   — uses plugin-fs to read/write files in Documents/Saves/
//                      Available on: macOS, Windows, Linux, iOS (Tauri)
//
//   OpfsSaveStore    — uses the Origin Private File System (OPFS) to store
//                      save files as small JSON blobs.  No bytes are exposed
//                      to the user's visible filesystem; export/import handle
//                      the hand-off.
//                      Available on: Chrome 86+, Firefox 111+, Safari 15.2+
//
//   LegacySaveStore  — no persistent storage.  list() always returns [].
//                      Save/load go through browser download / <input> picker.
//                      Available on: any browser (last-resort fallback)
//
// All three expose the same interface so the rest of the app never branches
// on platform.  Export and import are handled identically on all platforms
// (Tauri: native save/open dialog; Web: download anchor / <input> picker).

import type { SaveData } from "./types";
import {
  isTauri,
  getAppDocumentsDir,
  makeDirTauri,
  readDirectory,
  readTextFileTauri,
  writeTextFileTauri,
  pickAndReadTextFile,
  pickAndWriteTextFile,
} from "./tauri_bridge";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SaveEntry {
  /** Stable identifier — used as the key for load/delete. */
  id: string;
  /** Human-readable filename, e.g. "rr_save_2024-01-01T12-00-00.json". */
  fileName: string;
  /** ISO timestamp from the save data itself (not filesystem mtime). */
  timestamp: string;
  /** Short location string for display ("第一章 · 序章", …). */
  label: string;
  /** Parsed save data. */
  save: SaveData;
}

export interface SaveStore {
  /**
   * Return all stored saves, newest first.
   * Never throws — returns [] on any error.
   */
  list(): Promise<SaveEntry[]>;

  /**
   * Persist a new save.  The implementation chooses the file name / key.
   * Returns the resulting SaveEntry so the caller can update UI immediately.
   */
  write(data: SaveData): Promise<SaveEntry>;

  /**
   * Overwrite an existing save in-place (auto-save after each dialogue step).
   * If `id` is not found the implementation may create a new file instead.
   */
  update(id: string, data: SaveData): Promise<void>;

  /**
   * Delete a save by id.  No-op if not found.
   */
  remove(id: string): Promise<void>;

  /**
   * Open a platform-native export dialog so the user gets a portable .json
   * copy.  On Tauri this is a native save dialog; on web it triggers a
   * download.
   */
  exportToFile(data: SaveData): Promise<void>;

  /**
   * Open a platform-native import dialog so the user can load a .json copy
   * from anywhere.  Returns the parsed save, or null if cancelled.
   */
  importFromFile(): Promise<SaveData | null>;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

const SAVE_VERSION = 1 as const;

function makeSaveId(): string {
  return `rr_save_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
}

function saveFileName(id: string): string {
  return `${id}.json`;
}

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
    throw new Error("存档损坏：缺少 currentLabel");
  }
  if (typeof s.stepIndex !== "number") {
    throw new Error("存档损坏：缺少 stepIndex");
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

function toEntry(id: string, fileName: string, save: SaveData): SaveEntry {
  return {
    id,
    fileName,
    timestamp: save.timestamp,
    label: save.currentLabel,
    save,
  };
}

function triggerDownload(json: string, fileName: string): void {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function pickFileViaInput(): Promise<string> {
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

// ─── TauriSaveStore ───────────────────────────────────────────────────────────

class TauriSaveStore implements SaveStore {
  private savesDir: string | null = null;

  private async getSavesDir(): Promise<string> {
    if (this.savesDir) return this.savesDir;
    const docDir = await getAppDocumentsDir();
    if (!docDir) throw new Error("无法获取文档目录");
    const dir = `${docDir}/Saves`;
    await makeDirTauri(dir);
    this.savesDir = dir;
    return dir;
  }

  async list(): Promise<SaveEntry[]> {
    try {
      const dir = await this.getSavesDir();
      const entries = await readDirectory(dir);
      const results: SaveEntry[] = [];
      for (const e of entries) {
        if (!e.isFile || !e.name.endsWith(".json")) continue;
        const path = `${dir}/${e.name}`;
        const text = await readTextFileTauri(path);
        if (!text) continue;
        try {
          const save = validateSave(JSON.parse(text));
          const id = e.name.replace(/\.json$/, "");
          results.push(toEntry(id, e.name, save));
        } catch {
          // Skip corrupt files silently.
        }
      }
      results.sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );
      return results;
    } catch {
      return [];
    }
  }

  async write(data: SaveData): Promise<SaveEntry> {
    const id = makeSaveId();
    const fileName = saveFileName(id);
    const dir = await this.getSavesDir();
    await writeTextFileTauri(
      `${dir}/${fileName}`,
      JSON.stringify(data, null, 2),
    );
    return toEntry(id, fileName, data);
  }

  async update(id: string, data: SaveData): Promise<void> {
    const dir = await this.getSavesDir();
    await writeTextFileTauri(
      `${dir}/${saveFileName(id)}`,
      JSON.stringify(data, null, 2),
    );
  }

  async remove(id: string): Promise<void> {
    try {
      const dir = await this.getSavesDir();
      // Tauri plugin-fs remove is not exposed through our bridge yet;
      // overwrite with a tombstone marker so list() skips it.
      // A proper delete would require adding a removeFile helper.
      await writeTextFileTauri(`${dir}/${saveFileName(id)}`, "null");
    } catch {
      // Not fatal.
    }
  }

  async exportToFile(data: SaveData): Promise<void> {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const fileName = `rr_save_${ts}.json`;
    await pickAndWriteTextFile(JSON.stringify(data, null, 2), {
      title: "导出存档",
      defaultPath: fileName,
      filters: [{ name: "游戏存档", extensions: ["json"] }],
    });
  }

  async importFromFile(): Promise<SaveData | null> {
    const result = await pickAndReadTextFile({
      title: "导入存档",
      filters: [{ name: "游戏存档", extensions: ["json"] }],
    });
    if (!result) return null;
    try {
      const save = validateSave(JSON.parse(result.text));
      // Copy into the Saves directory so it appears in the list.
      const dir = await this.getSavesDir();
      const baseName =
        result.path.split(/[/\\]/).pop() ?? saveFileName(makeSaveId());
      const dest = `${dir}/${baseName}`;
      if (result.path !== dest) {
        await writeTextFileTauri(dest, result.text);
      }
      return save;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`存档文件无效：${msg}`, { cause: err });
    }
  }
}

// ─── OpfsSaveStore ────────────────────────────────────────────────────────────
//
// Save files are stored in the Origin Private File System under:
//   cb_saves/<id>.json
//
// OPFS is appropriate here because save files are tiny (a few KB each).
// This is completely different from the assets zip which can be several GB —
// we deliberately do NOT cache the zip in OPFS.

const OPFS_SAVES_DIR = "cb_saves";

class OpfsSaveStore implements SaveStore {
  private async getDir(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(OPFS_SAVES_DIR, { create: true });
  }

  async list(): Promise<SaveEntry[]> {
    try {
      const dir = await this.getDir();
      const results: SaveEntry[] = [];
      // @ts-expect-error — values() is available on FileSystemDirectoryHandle in all modern browsers
      for await (const handle of dir.values()) {
        if (handle.kind !== "file" || !handle.name.endsWith(".json")) continue;
        try {
          const file = await (handle as FileSystemFileHandle).getFile();
          const text = await file.text();
          // Skip tombstones written by remove()
          if (text.trim() === "null") continue;
          const save = validateSave(JSON.parse(text));
          const id = handle.name.replace(/\.json$/, "");
          results.push(toEntry(id, handle.name, save));
        } catch {
          // Skip corrupt entries.
        }
      }
      results.sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );
      return results;
    } catch {
      return [];
    }
  }

  private async writeJson(id: string, data: SaveData): Promise<void> {
    const dir = await this.getDir();
    const fh = await dir.getFileHandle(saveFileName(id), { create: true });
    const writable = await fh.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
  }

  async write(data: SaveData): Promise<SaveEntry> {
    const id = makeSaveId();
    await this.writeJson(id, data);
    return toEntry(id, saveFileName(id), data);
  }

  async update(id: string, data: SaveData): Promise<void> {
    await this.writeJson(id, data);
  }

  async remove(id: string): Promise<void> {
    try {
      const dir = await this.getDir();
      await dir.removeEntry(saveFileName(id));
    } catch {
      // Not found — not an error.
    }
  }

  async exportToFile(data: SaveData): Promise<void> {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    triggerDownload(JSON.stringify(data, null, 2), `rr_save_${ts}.json`);
  }

  async importFromFile(): Promise<SaveData | null> {
    let text: string;
    try {
      text = await pickFileViaInput();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "已取消") return null;
      throw err;
    }
    const save = validateSave(JSON.parse(text));
    // Copy into OPFS so it appears in the list.
    const id = makeSaveId();
    await this.writeJson(id, save);
    return save;
  }
}

// ─── LegacySaveStore ──────────────────────────────────────────────────────────
//
// Last-resort fallback for browsers that don't support OPFS (extremely rare
// in 2025 — essentially just very old Safari).  No persistent storage; the
// user must export/import manually every session.

class LegacySaveStore implements SaveStore {
  async list(): Promise<SaveEntry[]> {
    return [];
  }

  async write(data: SaveData): Promise<SaveEntry> {
    const id = makeSaveId();
    // No persistent storage — just return an entry so the caller has an id.
    // The user can export manually via exportToFile() / saveExport().
    return toEntry(id, saveFileName(id), data);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async update(_id: string, _data: SaveData): Promise<void> {
    // No persistent storage available — silently no-op.
    // The user relies on manual export.
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async remove(_id: string): Promise<void> {
    // Nothing to remove.
  }

  async exportToFile(data: SaveData): Promise<void> {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    triggerDownload(JSON.stringify(data, null, 2), `rr_save_${ts}.json`);
  }

  async importFromFile(): Promise<SaveData | null> {
    let text: string;
    try {
      text = await pickFileViaInput();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "已取消") return null;
      throw err;
    }
    return validateSave(JSON.parse(text));
  }
}

// ─── Singleton factory ────────────────────────────────────────────────────────

let _store: SaveStore | null = null;

/**
 * Return the platform-appropriate SaveStore singleton.
 *
 * Selection order:
 *   1. Tauri  — if running inside a Tauri WebView
 *   2. OPFS   — if navigator.storage.getDirectory is available (all modern browsers)
 *   3. Legacy — last resort
 */
export function getSaveStore(): SaveStore {
  if (_store) return _store;

  if (isTauri) {
    _store = new TauriSaveStore();
  } else if (
    typeof navigator !== "undefined" &&
    typeof navigator.storage?.getDirectory === "function"
  ) {
    _store = new OpfsSaveStore();
  } else {
    _store = new LegacySaveStore();
  }

  return _store;
}
