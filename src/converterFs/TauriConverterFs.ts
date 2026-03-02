// ─── TauriConverterFs ────────────────────────────────────────────────────────
//
// IConverterFs implementation backed by Tauri plugin-fs.
//
// Path model: all public-facing paths are relative to `rootPath` (the game
// directory chosen by the user).  Internally we convert to absolute paths
// before calling any Tauri API.
//
// RPA support: on the first walkDir call we scan the root for *.rpa files,
// parse their indices, and cache the result.  Virtual files from RPA archives
// are merged transparently with on-disk files; a real disk file always wins
// over an RPA entry at the same relative path (same precedence as Ren'Py).

import {
  pickDirectory,
  readTextFileTauri,
  writeTextFileTauri,
  makeDirTauri,
  pathExists,
  walkDir as tauriWalkDir,
} from "../tauri/fs";
import {
  listRpa,
  readRpaEntry,
  streamingBuildZip,
  type ZipFileEntry,
  type StreamingZipProgress,
  type VirtualZipEntry as TauriBridgeVirtualEntry,
  type RpaFileEntry as TauriBridgeRpaEntry,
} from "../tauri/zip";
import { pickSavePath } from "../tauri/fs";
import type {
  IConverterFs,
  ZipProgress,
  VirtualZipEntry,
  ConverterFsResult,
} from "./types";
import { CancelledError } from "./types";

// ─── RPA virtual entry ────────────────────────────────────────────────────────

/**
 * Describes a single file that lives inside an RPA archive, expressed as a
 * path relative to the game root (same coordinate space as all other
 * IConverterFs paths).
 *
 * rpaAbs  – absolute path to the .rpa file on disk
 * entry   – in-archive path exactly as Ren'Py wrote it (forward-slash)
 */
interface RpaVirtualFile {
  rpaAbs: string;
  entry: string;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class TauriConverterFs implements IConverterFs {
  constructor(private readonly rootPath: string) {}

  get label(): string {
    return this.rootPath;
  }

  private abs(rel: string): string {
    return rel === "" ? this.rootPath : `${this.rootPath}/${rel}`;
  }

  // ── RPA index cache ─────────────────────────────────────────────────────────
  //
  // Built lazily on the first walkDir call and cached for the lifetime of this
  // instance.  Maps each relative path (game-root-relative) to the RPA source.

  private _rpaCache: Map<string, RpaVirtualFile> | null = null;

  /**
   * Scan the root directory for *.rpa files, build their indices, and return
   * a map of  relPath → RpaVirtualFile  for every entry found.
   *
   * Results are cached after the first call.
   */
  private async _getRpaIndex(): Promise<Map<string, RpaVirtualFile>> {
    if (this._rpaCache !== null) return this._rpaCache;

    const cache = new Map<string, RpaVirtualFile>();

    // Find all .rpa files anywhere under the root.
    let rpaAbsPaths: string[];
    try {
      rpaAbsPaths = await tauriWalkDir(this.rootPath, (name) =>
        name.toLowerCase().endsWith(".rpa"),
      );
    } catch {
      // Walk failed (permissions, etc.) — return an empty index.
      this._rpaCache = cache;
      return cache;
    }

    // Build the index for each archive in parallel.
    await Promise.all(
      rpaAbsPaths.map(async (rpaAbs) => {
        try {
          const entries = await listRpa(rpaAbs);
          for (const entry of entries) {
            const normEntry = entry.replace(/\\/g, "/");
            // First RPA to claim a path wins (same precedence as Ren'Py).
            if (!cache.has(normEntry)) {
              cache.set(normEntry, { rpaAbs, entry: normEntry });
            }
          }
        } catch (err) {
          console.warn(`[TauriConverterFs] Failed to index ${rpaAbs}:`, err);
        }
      }),
    );

    this._rpaCache = cache;
    return cache;
  }

  // ── IConverterFs implementation ─────────────────────────────────────────────

  async walkDir(
    dir: string,
    predicate: (name: string) => boolean,
  ): Promise<string[]> {
    const prefix = this.rootPath.endsWith("/")
      ? this.rootPath
      : this.rootPath + "/";

    // 1. Regular disk files under the requested sub-directory.
    const absPaths = await tauriWalkDir(this.abs(dir), predicate);
    const diskFiles = new Set(
      absPaths.map((p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p)),
    );

    // 2. Virtual files from RPA archives.
    const rpaIndex = await this._getRpaIndex();
    const dirPrefix = dir === "" ? "" : dir.endsWith("/") ? dir : dir + "/";

    const rpaFiles: string[] = [];
    for (const [relPath] of rpaIndex) {
      if (dirPrefix !== "" && !relPath.startsWith(dirPrefix)) continue;
      if (diskFiles.has(relPath)) continue;
      const name = relPath.slice(relPath.lastIndexOf("/") + 1);
      if (predicate(name)) rpaFiles.push(relPath);
    }

    rpaFiles.sort();
    return [...diskFiles, ...rpaFiles];
  }

  async readText(relPath: string): Promise<string | null> {
    // Prefer on-disk file.
    if (await pathExists(this.abs(relPath))) {
      return readTextFileTauri(this.abs(relPath));
    }

    // Fall back to RPA.
    const rpaIndex = await this._getRpaIndex();
    const vf = rpaIndex.get(relPath.replace(/\\/g, "/"));
    if (!vf) return null;

    try {
      const bytes = await readRpaEntry(vf.rpaAbs, vf.entry);
      return new TextDecoder().decode(bytes);
    } catch (err) {
      console.warn(
        `[TauriConverterFs] readText from RPA failed for ${relPath}:`,
        err,
      );
      return null;
    }
  }

  async writeText(relPath: string, content: string): Promise<void> {
    const absPath = this.abs(relPath);
    const parent = absPath.replace(/\/[^/]+$/, "");
    if (parent !== absPath && !(await pathExists(parent))) {
      await makeDirTauri(parent);
    }
    await writeTextFileTauri(absPath, content);
  }

  async exists(relPath: string): Promise<boolean> {
    if (await pathExists(this.abs(relPath))) return true;
    const rpaIndex = await this._getRpaIndex();
    return rpaIndex.has(relPath.replace(/\\/g, "/"));
  }

  async pickZipSaveTarget(): Promise<unknown | null> {
    const path = await pickSavePath({
      title: "保存 assets.zip",
      defaultPath: "assets.zip",
      filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
    });
    return path ?? null;
  }

  async buildZip(
    include: string[],
    onProgress?: (p: ZipProgress) => void,
    onSkip?: (relPath: string) => void,
    saveTarget?: unknown,
    virtualEntries?: VirtualZipEntry[],
  ): Promise<void> {
    const outputPath =
      saveTarget != null
        ? (saveTarget as string)
        : await pickSavePath({
            title: "保存 assets.zip",
            defaultPath: "assets.zip",
            filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
          });
    if (!outputPath) throw new CancelledError();

    // Separate include list into real disk files and RPA virtual files.
    const rpaIndex = await this._getRpaIndex();
    const prefix = this.rootPath.endsWith("/")
      ? this.rootPath
      : this.rootPath + "/";

    const diskEntries: ZipFileEntry[] = [];
    const rpaEntries: TauriBridgeRpaEntry[] = [];

    for (const rel of include) {
      const normRel = rel.replace(/\\/g, "/");
      const vf = rpaIndex.get(normRel);

      if (vf && !(await pathExists(this.abs(normRel)))) {
        // File lives only inside an RPA archive — Rust reads it directly.
        rpaEntries.push({
          rpaPath: vf.rpaAbs,
          entryPath: vf.entry,
          zipPath: normRel,
        });
      } else {
        diskEntries.push({ absPath: this.abs(normRel), zipPath: normRel });
      }
    }

    // Caller-supplied virtual (in-memory) entries.
    const allVirtual: TauriBridgeVirtualEntry[] =
      virtualEntries && virtualEntries.length > 0
        ? virtualEntries.map((v) => ({ content: v.content, zipPath: v.zipPath }))
        : [];

    await streamingBuildZip(
      outputPath,
      diskEntries,
      onProgress
        ? (p: StreamingZipProgress) =>
            onProgress({ index: p.index, total: p.total, zipPath: p.zipPath })
        : undefined,
      onSkip
        ? (absPath: string, zipPath: string) => {
            const rel = absPath.startsWith(prefix)
              ? absPath.slice(prefix.length)
              : zipPath;
            onSkip(rel);
          }
        : undefined,
      allVirtual.length > 0 ? allVirtual : undefined,
      rpaEntries.length > 0 ? rpaEntries : undefined,
    );
  }
}

// ─── Public factory ───────────────────────────────────────────────────────────

/**
 * Show a Tauri directory picker and return a TauriConverterFs rooted at the
 * chosen directory.  Returns null if the user cancels.
 */
export async function pickTauriConverterFs(): Promise<ConverterFsResult | null> {
  const path = await pickDirectory();
  if (!path) return null;
  return { fs: new TauriConverterFs(path), kind: "tauri" };
}

/**
 * Wrap an already-known Tauri path string as an IConverterFs.
 * Used when the path was typed manually rather than picked via dialog.
 */
export function tauriConverterFsFromPath(path: string): IConverterFs {
  return new TauriConverterFs(path);
}
