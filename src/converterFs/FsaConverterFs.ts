// ─── FsaConverterFs ───────────────────────────────────────────────────────────
//
// IConverterFs implementation backed by the File System Access API
// (Chrome/Edge 86+).
//
// Path model: all public-facing paths are relative to the root
// FileSystemDirectoryHandle chosen by the user, using "/" as separator.
// The root itself is represented as "".
//
// ZIP strategy: stream each file through CompressionStream("deflate-raw") into
// a FileSystemWritableFileStream opened via showSaveFilePicker().  JS heap
// high-water mark is O(pipe chunk size) — typically ~64 KiB — regardless of
// total archive size.  This matches the Rust implementation's memory profile.
//
// RPA support: on the first walkDir call we scan the root for *.rpa files,
// open them via RpaReader, and cache a map of relPath → { reader, entry }.
// A real disk file always wins over an RPA virtual entry at the same path.

import { RpaReader } from "../rpaReader";
import type {
  IConverterFs,
  ZipProgress,
  VirtualZipEntry,
  ConverterFsResult,
} from "./types";
import { CancelledError } from "./types";
import { fsaResolveFile, fsaResolveDir, fsaWalkDir } from "./fsaHelpers";
import {
  shouldDeflate,
  encodeUtf8,
  u8,
  crc32Stream,
  dosDateTime,
  deflateStream,
  writeZipFooter,
  buildLocalHeader,
  buildDataDescriptor,
  ZIP_METHOD_STORE,
  ZIP_METHOD_DEFLATE,
  type CentralDirEntry,
} from "./zipWriter";

// ─── RPA virtual file record ──────────────────────────────────────────────────

interface FsaRpaVirtualFile {
  reader: RpaReader;
  entry: string;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class FsaConverterFs implements IConverterFs {
  constructor(private readonly root: FileSystemDirectoryHandle) {}

  get label(): string {
    return this.root.name;
  }

  // ── RPA index cache ─────────────────────────────────────────────────────────
  //
  // Built lazily on the first walkDir call.  Maps each relative path
  // (game-root-relative, forward-slash) to the RpaReader + entry name.
  //
  // Real disk files always win over RPA virtual files, matching Ren'Py's own
  // precedence rules.

  private _rpaCache: Map<string, FsaRpaVirtualFile> | null = null;

  private async _getRpaIndex(): Promise<Map<string, FsaRpaVirtualFile>> {
    if (this._rpaCache !== null) return this._rpaCache;

    const cache = new Map<string, FsaRpaVirtualFile>();

    // Find all .rpa files under the root directory.
    let rpaPaths: string[];
    try {
      rpaPaths = await fsaWalkDir(
        this.root,
        (name) => name.toLowerCase().endsWith(".rpa"),
        "",
      );
    } catch {
      this._rpaCache = cache;
      return cache;
    }

    // Open and index each archive in parallel.
    await Promise.all(
      rpaPaths.map(async (rpaRel) => {
        try {
          const fh = await fsaResolveFile(this.root, rpaRel, false);
          if (!fh) return;
          const file = await fh.getFile();
          const reader = await RpaReader.open(file);
          for (const entry of reader.paths) {
            const normEntry = entry.replace(/\\/g, "/");
            // First RPA to claim a path wins (same as Ren'Py).
            if (!cache.has(normEntry)) {
              cache.set(normEntry, { reader, entry: normEntry });
            }
          }
        } catch (err) {
          console.warn(`[FsaConverterFs] Failed to index RPA ${rpaRel}:`, err);
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
    // 1. Regular disk files.
    const dirHandle =
      dir === "" ? this.root : await fsaResolveDir(this.root, dir, false);
    const diskFiles = new Set<string>(
      dirHandle
        ? await fsaWalkDir(dirHandle, predicate, dir === "" ? "" : dir)
        : [],
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
    try {
      const fh = await fsaResolveFile(this.root, relPath, false);
      if (fh) {
        const file = await fh.getFile();
        return file.text();
      }
    } catch {
      // Fall through to RPA.
    }

    // Fall back to RPA.
    const rpaIndex = await this._getRpaIndex();
    const vf = rpaIndex.get(relPath.replace(/\\/g, "/"));
    if (!vf) return null;

    try {
      const bytes = await vf.reader.read(vf.entry);
      if (!bytes) return null;
      return new TextDecoder("utf-8").decode(bytes);
    } catch (err) {
      console.warn(
        `[FsaConverterFs] readText from RPA failed for ${relPath}:`,
        err,
      );
      return null;
    }
  }

  async readBinary(relPath: string): Promise<Uint8Array | null> {
    // Prefer on-disk file — read raw bytes without any encoding conversion.
    try {
      const fh = await fsaResolveFile(this.root, relPath, false);
      if (fh) {
        const file = await fh.getFile();
        const buf = await file.arrayBuffer();
        return new Uint8Array(buf);
      }
    } catch {
      // Fall through to RPA.
    }

    // Fall back to RPA.
    const rpaIndex = await this._getRpaIndex();
    const vf = rpaIndex.get(relPath.replace(/\\/g, "/"));
    if (!vf) return null;

    try {
      const bytes = await vf.reader.read(vf.entry);
      if (!bytes) return null;
      return bytes;
    } catch (err) {
      console.warn(
        `[FsaConverterFs] readBinary from RPA failed for ${relPath}:`,
        err,
      );
      return null;
    }
  }

  async writeText(relPath: string, content: string): Promise<void> {
    const fh = await fsaResolveFile(this.root, relPath, true);
    if (!fh) throw new Error(`Cannot create file: ${relPath}`);
    const writable = await fh.createWritable();
    await writable.write(content);
    await writable.close();
  }

  async exists(relPath: string): Promise<boolean> {
    if (relPath === "" || relPath === ".") return true;

    // Check disk first.
    const parts = relPath.split("/").filter(Boolean);
    let dir: FileSystemDirectoryHandle = this.root;
    for (let i = 0; i < parts.length - 1; i++) {
      try {
        dir = await dir.getDirectoryHandle(parts[i], { create: false });
      } catch {
        // Not on disk — check RPA below.
        const rpaIndex = await this._getRpaIndex();
        return rpaIndex.has(relPath.replace(/\\/g, "/"));
      }
    }
    const last = parts[parts.length - 1];
    try {
      await dir.getFileHandle(last, { create: false });
      return true;
    } catch {
      /* not a file */
    }
    try {
      await dir.getDirectoryHandle(last, { create: false });
      return true;
    } catch {
      /* not a dir */
    }

    // Check RPA index.
    const rpaIndex = await this._getRpaIndex();
    return rpaIndex.has(relPath.replace(/\\/g, "/"));
  }

  async pickZipSaveTarget(): Promise<unknown | null> {
    type ShowSaveFilePicker = (
      opts?: Record<string, unknown>,
    ) => Promise<FileSystemFileHandle>;
    const picker = (
      window as unknown as { showSaveFilePicker: ShowSaveFilePicker }
    ).showSaveFilePicker;
    try {
      return await picker({
        suggestedName: "assets.zip",
        types: [
          {
            description: "ZIP Archive",
            accept: { "application/zip": [".zip"] },
          },
        ],
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return null;
      throw err;
    }
  }

  /**
   * Build a ZIP archive by streaming each file directly from the FSA handle
   * through CompressionStream into a FileSystemWritableFileStream.
   *
   * Memory profile: O(pipe chunk size) — typically ~64 KiB per in-flight
   * chunk, regardless of the total archive size.
   */
  async buildZip(
    include: string[],
    onProgress?: (p: ZipProgress) => void,
    onSkip?: (relPath: string) => void,
    saveTarget?: unknown,
    virtualEntries?: VirtualZipEntry[],
  ): Promise<void> {
    // Resolve the save handle — use the pre-acquired one when provided,
    // otherwise open the picker here (fallback path for direct callers).
    let saveHandle: FileSystemFileHandle;
    if (saveTarget != null) {
      saveHandle = saveTarget as FileSystemFileHandle;
    } else {
      type ShowSaveFilePicker = (
        opts?: Record<string, unknown>,
      ) => Promise<FileSystemFileHandle>;
      const picker = (
        window as unknown as { showSaveFilePicker: ShowSaveFilePicker }
      ).showSaveFilePicker;
      try {
        saveHandle = await picker({
          suggestedName: "assets.zip",
          types: [
            {
              description: "ZIP Archive",
              accept: { "application/zip": [".zip"] },
            },
          ],
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          throw new CancelledError();
        }
        throw err;
      }
    }

    // Pre-build RPA index so we can classify each include path.
    const rpaIndex = await this._getRpaIndex();

    const writable = await saveHandle.createWritable();
    const virt = virtualEntries ?? [];
    const total = include.length + virt.length;
    const centralDir: CentralDirEntry[] = [];
    let archiveOffset = 0;
    const now = new Date();
    const { modTime, modDate } = dosDateTime(now);

    /**
     * Write one ReadableStream<Uint8Array> entry into the open ZIP writable.
     * Handles both STORE and DEFLATE methods, writes the local header +
     * file data + data descriptor, appends to centralDir, advances
     * archiveOffset.
     */
    const writeStreamEntry = async (
      relPath: string,
      rawStream: ReadableStream<Uint8Array>,
      index: number,
    ): Promise<void> => {
      const nameBytes = encodeUtf8(relPath);
      const method = shouldDeflate(relPath)
        ? ZIP_METHOD_DEFLATE
        : ZIP_METHOD_STORE;

      const localHeaderOffset = archiveOffset;
      const localHeader = buildLocalHeader(nameBytes, method, modTime, modDate);
      await writable.write(u8(localHeader));
      archiveOffset += localHeader.length;

      let crc: number;
      let uncompressedSize: number;
      let compressedSize: number;

      if (method === ZIP_METHOD_STORE) {
        const result = await crc32Stream(rawStream, async (chunk) => {
          await writable.write(u8(chunk));
          archiveOffset += chunk.length;
        });
        crc = result.crc;
        uncompressedSize = result.size;
        compressedSize = result.size;
      } else {
        // DEFLATE: tee the stream so CRC and compression run in parallel.
        const result = await deflateStream(rawStream, writable, (n) => {
          archiveOffset += n;
        });
        crc = result.crc;
        uncompressedSize = result.uncompressedSize;
        compressedSize = result.compressedSize;
      }

      const dataDescriptor = buildDataDescriptor(
        crc,
        compressedSize,
        uncompressedSize,
      );
      await writable.write(u8(dataDescriptor));
      archiveOffset += dataDescriptor.length;

      centralDir.push({
        nameBytes,
        method,
        modTime,
        modDate,
        crc,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });

      onProgress?.({ index, total, zipPath: relPath });
    };

    try {
      // ── Disk files + RPA virtual files ─────────────────────────────────────
      for (let index = 0; index < include.length; index++) {
        const relPath = include[index];
        const normRel = relPath.replace(/\\/g, "/");

        // Determine source: real disk file or RPA virtual entry.
        const diskFh = await fsaResolveFile(this.root, normRel, false);

        if (diskFh) {
          // Real disk file — stream directly from FSA handle.
          let file: File;
          try {
            file = await diskFh.getFile();
          } catch {
            onSkip?.(normRel);
            continue;
          }
          await writeStreamEntry(
            normRel,
            file.stream() as ReadableStream<Uint8Array>,
            index,
          );
        } else {
          // Not on disk — look up in RPA index.
          const vf = rpaIndex.get(normRel);
          if (!vf) {
            onSkip?.(normRel);
            continue;
          }

          const rawStream = vf.reader.stream(vf.entry);
          if (!rawStream) {
            onSkip?.(normRel);
            continue;
          }

          await writeStreamEntry(normRel, rawStream, index);
        }
      }

      // ── Virtual (in-memory text) entries ────────────────────────────────────
      const enc = new TextEncoder();
      const diskCount = include.length;
      for (let vi = 0; vi < virt.length; vi++) {
        const ventry = virt[vi];
        const index = diskCount + vi;
        const nameBytes = encodeUtf8(ventry.zipPath);
        const rawBytes = enc.encode(ventry.content);

        const localHeaderOffset = archiveOffset;
        const localHeader = buildLocalHeader(
          nameBytes,
          ZIP_METHOD_DEFLATE,
          modTime,
          modDate,
        );
        await writable.write(u8(localHeader));
        archiveOffset += localHeader.length;

        // Compress via CompressionStream.
        const rawStream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(rawBytes);
            controller.close();
          },
        });

        const result = await deflateStream(rawStream, writable, (n) => {
          archiveOffset += n;
        });

        const dataDescriptor = buildDataDescriptor(
          result.crc,
          result.compressedSize,
          result.uncompressedSize,
        );
        await writable.write(u8(dataDescriptor));
        archiveOffset += dataDescriptor.length;

        centralDir.push({
          nameBytes,
          method: ZIP_METHOD_DEFLATE,
          modTime,
          modDate,
          crc: result.crc,
          compressedSize: result.compressedSize,
          uncompressedSize: result.uncompressedSize,
          localHeaderOffset,
        });

        onProgress?.({ index, total, zipPath: ventry.zipPath });
      }

      // ── Write Central Directory + EOCD ──────────────────────────────────────
      await writeZipFooter(writable, centralDir, archiveOffset);

      await writable.close();
    } catch (err) {
      // Attempt to discard the partial write on error.
      try {
        await (
          writable as FileSystemWritableFileStream & {
            abort?: () => Promise<void>;
          }
        ).abort?.();
      } catch {
        // Ignore abort errors.
      }
      throw err;
    }
  }
}

// ─── Public factory ───────────────────────────────────────────────────────────

/**
 * Show a directory picker (FSA) and return an FsaConverterFs rooted at the
 * chosen directory.  Returns null if the user cancels or FSA is unsupported.
 */
export async function pickFsaConverterFs(): Promise<ConverterFsResult | null> {
  if (typeof window === "undefined" || !("showDirectoryPicker" in window)) {
    return null;
  }
  type ShowDirectoryPicker = (
    opts?: Record<string, unknown>,
  ) => Promise<FileSystemDirectoryHandle>;
  try {
    const handle = await (
      window as unknown as { showDirectoryPicker: ShowDirectoryPicker }
    ).showDirectoryPicker({ mode: "read" });
    return { fs: new FsaConverterFs(handle), kind: "fsa" };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return null;
    throw err;
  }
}
