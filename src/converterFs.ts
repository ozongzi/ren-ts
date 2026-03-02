// ─── Converter Filesystem Abstraction ────────────────────────────────────────
//
// The conversion tools (rpy → rrs + ZIP packing) need to:
//   - Walk a directory tree recursively
//   - Read text files
//   - Write text files (creating parent dirs as needed)
//   - Check whether a path / sub-directory exists
//   - Build a ZIP archive from the converted output
//
// On Tauri these operations go through plugin-fs + a native Rust zip command.
// On Chrome/Edge they go through the File System Access API (FSA).
//
// This module exposes a single IConverterFs interface with two implementations:
//   TauriConverterFs  — wraps the existing tauri_bridge helpers
//   FsaConverterFs    — wraps FileSystemDirectoryHandle + streaming ZIP
//
// ── Why not WASM for ZIP? ─────────────────────────────────────────────────────
//
// Compiling the Rust zip builder to WASM does not solve the memory problem.
// WASM has no access to the filesystem — file bytes still have to be copied
// from the FSA handle into WASM linear memory by JS before WASM can touch
// them, making the memory profile identical to a pure-JS solution.
//
// ── Streaming ZIP instead ─────────────────────────────────────────────────────
//
// The FSA implementation uses the browser's built-in streaming pipeline:
//
//   FSA FileSystemFileHandle.getFile() → ReadableStream
//     → CompressionStream("deflate-raw")   (browser built-in, no library)
//     → FileSystemWritableFileStream        (via showSaveFilePicker)
//
// Files are processed one at a time with a ~64 KiB pipe buffer.
// JS heap high-water mark is O(buffer_size), not O(archive_size).
// This matches the Rust implementation's memory profile exactly.
//
// ZIP format reference: PKWARE APPNOTE.TXT §4
// We implement the subset needed for Store + Deflate entries:
//   Local File Header  (4.3.7)
//   File data
//   Data Descriptor    (4.3.9)  — avoids pre-computing compressed size
//   Central Directory  (4.3.12)
//   End of Central Directory (4.3.16)
//
// All multi-byte integers are little-endian. We stay within ZIP32 limits
// (4 GiB / 65535 files) which is more than sufficient for game assets.

import {
  isTauri,
  pickDirectory,
  readTextFileTauri,
  writeTextFileTauri,
  makeDirTauri,
  pathExists,
  walkDir as tauriWalkDir,
  streamingBuildZip,
  pickSavePath,
  type ZipFileEntry,
  type StreamingZipProgress,
} from "./tauri_bridge";

// ─── CancelledError ───────────────────────────────────────────────────────────

/** Thrown when the user cancels a picker (not an application error). */
export class CancelledError extends Error {
  constructor() {
    super("已取消");
    this.name = "CancelledError";
  }
}

// ─── Progress callback type ───────────────────────────────────────────────────

export interface ZipProgress {
  index: number;
  total: number;
  zipPath: string;
}

// ─── IConverterFs interface ───────────────────────────────────────────────────

export interface IConverterFs {
  /**
   * Human-readable label for the root directory (shown in UI).
   * e.g. "game" or "/Users/alice/game"
   */
  readonly label: string;

  /**
   * Recursively walk the directory tree rooted at `dir` (relative to the
   * chosen game root), collecting files that satisfy `predicate(filename)`.
   *
   * `dir` is a relative path from the game root, e.g. "tl/chinese".
   * Pass "" to walk the entire game root.
   *
   * Returns relative paths from the game root, e.g.
   *   ["script.rpy", "tl/cn/script.rpy"].
   */
  walkDir(dir: string, predicate: (name: string) => boolean): Promise<string[]>;

  /**
   * Read a text file at the given relative path.
   * Returns null if the file cannot be read.
   */
  readText(relPath: string): Promise<string | null>;

  /**
   * Write a text file at the given relative path, creating parent
   * directories as needed.  Overwrites existing files silently.
   */
  writeText(relPath: string, content: string): Promise<void>;

  /**
   * Check whether a file or directory exists at the given relative path.
   */
  exists(relPath: string): Promise<boolean>;

  /**
   * Pre-acquire the save-file target so the caller can call this inside a
   * user-gesture handler (e.g. onClick) before any async work begins.
   *
   * On Tauri: opens the native save-path dialog and returns the chosen path
   * string, or null if the user cancels.
   * On FSA (Chrome/Edge): calls showSaveFilePicker and returns the resulting
   * FileSystemFileHandle, or null if the user cancels.
   * Must be called synchronously (or as the first await) inside a user
   * gesture, because browsers forbid showSaveFilePicker outside one.
   */
  pickZipSaveTarget(): Promise<unknown | null>;

  /**
   * Build a ZIP archive from the files listed in `include`.
   *
   * On Tauri: invokes the native Rust command and saves to a user-chosen
   * path.  Returns null ("already on disk").
   *
   * On FSA (Chrome/Edge): opens showSaveFilePicker so the user picks where
   * to save, then streams each file through CompressionStream into the
   * writable.  JS heap stays at O(pipe buffer size) regardless of total
   * archive size.  Returns null ("already on disk via FSA writable").
   *
   * In both cases the caller triggers no download — the file is written
   * directly by the implementation.
   *
   * @param include      Relative paths (from game root) to pack into the ZIP.
   * @param onProgress   Called after each file entry is written.
   * @param onSkip       Called when a file could not be read (entry skipped).
   * @param saveTarget   Pre-acquired target from pickZipSaveTarget(). When
   *                     provided the implementation skips its own picker call.
   */
  buildZip(
    include: string[],
    onProgress?: (p: ZipProgress) => void,
    onSkip?: (relPath: string) => void,
    saveTarget?: unknown,
  ): Promise<void>;
}

// ─── TauriConverterFs ────────────────────────────────────────────────────────

class TauriConverterFs implements IConverterFs {
  constructor(private readonly rootPath: string) {}

  get label(): string {
    return this.rootPath;
  }

  private abs(rel: string): string {
    return rel === "" ? this.rootPath : `${this.rootPath}/${rel}`;
  }

  async walkDir(
    dir: string,
    predicate: (name: string) => boolean,
  ): Promise<string[]> {
    const absPaths = await tauriWalkDir(this.abs(dir), predicate);
    const prefix = this.rootPath.endsWith("/")
      ? this.rootPath
      : this.rootPath + "/";
    return absPaths.map((p) =>
      p.startsWith(prefix) ? p.slice(prefix.length) : p,
    );
  }

  async readText(relPath: string): Promise<string | null> {
    return readTextFileTauri(this.abs(relPath));
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
    return pathExists(this.abs(relPath));
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

    const entries: ZipFileEntry[] = include.map((rel) => ({
      absPath: this.abs(rel),
      zipPath: rel,
    }));

    await streamingBuildZip(
      outputPath,
      entries,
      onProgress
        ? (p: StreamingZipProgress) =>
            onProgress({ index: p.index, total: p.total, zipPath: p.zipPath })
        : undefined,
      onSkip
        ? (absPath: string, zipPath: string) => {
            const prefix = this.rootPath.endsWith("/")
              ? this.rootPath
              : this.rootPath + "/";
            const rel = absPath.startsWith(prefix)
              ? absPath.slice(prefix.length)
              : zipPath;
            onSkip(rel);
          }
        : undefined,
    );
  }
}

// ─── FsaConverterFs ──────────────────────────────────────────────────────────
//
// ── FSA path model ────────────────────────────────────────────────────────────
//
// All paths passed to / returned from this implementation are relative to the
// root FileSystemDirectoryHandle chosen by the user, using "/" as separator.
// e.g.  "script.rpy", "tl/chinese/script.rpy", "data/scene1.rrs"
//
// The root itself is represented as "".

/**
 * Resolve a relative path into a FileSystemFileHandle by traversing
 * directory handles from `root`.  Creates intermediate directories when
 * `create` is true.  Returns null if any segment is missing and `create` is
 * false.
 */
async function fsaResolveFile(
  root: FileSystemDirectoryHandle,
  relPath: string,
  create: boolean,
): Promise<FileSystemFileHandle | null> {
  const parts = relPath.split("/").filter(Boolean);
  if (parts.length === 0) return null;

  let dir: FileSystemDirectoryHandle = root;
  for (let i = 0; i < parts.length - 1; i++) {
    try {
      dir = await dir.getDirectoryHandle(parts[i], { create });
    } catch {
      return null;
    }
  }
  try {
    return await dir.getFileHandle(parts[parts.length - 1], { create });
  } catch {
    return null;
  }
}

/**
 * Resolve a relative path into a FileSystemDirectoryHandle.
 * Creates all path segments when `create` is true.
 * Returns null if not found and `create` is false.
 */
async function fsaResolveDir(
  root: FileSystemDirectoryHandle,
  relPath: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  if (relPath === "" || relPath === ".") return root;
  const parts = relPath.split("/").filter(Boolean);
  let dir: FileSystemDirectoryHandle = root;
  for (const part of parts) {
    try {
      dir = await dir.getDirectoryHandle(part, { create });
    } catch {
      return null;
    }
  }
  return dir;
}

/**
 * Recursively collect relative paths of files satisfying `predicate` under
 * `dirHandle`.  `prefix` is the relative path used to reach this handle from
 * the root (empty string at the root level).
 */
/**
 * Names that are never useful for game conversion and are known to cause
 * NotReadableError (or equivalent) on macOS / Windows when enumerated via
 * the File System Access API.
 */
const FSA_SKIP_NAMES = new Set([
  // macOS system / metadata directories
  ".Spotlight-V100",
  ".fseventsd",
  ".Trashes",
  ".MobileBackups",
  ".DocumentRevisions-V100",
  ".TemporaryItems",
  // Windows system directories
  "System Volume Information",
  "$RECYCLE.BIN",
  "$SysReset",
  "Recovery",
  // Common VCS / tool noise that is never game content
  ".git",
  ".svn",
  "node_modules",
]);

async function fsaWalkDir(
  dirHandle: FileSystemDirectoryHandle,
  predicate: (name: string) => boolean,
  prefix: string,
): Promise<string[]> {
  const results: string[] = [];

  let entries: Array<{ name: string; kind: string }>;
  try {
    // FileSystemDirectoryHandle.values() is async-iterable (Chrome/Edge 86+).
    // @ts-expect-error — TypeScript's DOM lib may not yet include values()
    const iter = dirHandle.values();
    entries = [];
    for await (const entry of iter) {
      entries.push(entry);
    }
  } catch {
    // Directory is not readable (permission denied, system folder, etc.).
    // Skip silently — the caller receives an empty list for this subtree.
    return results;
  }

  for (const entry of entries) {
    // Skip hidden files/dirs (leading dot) and known system directories.
    if (entry.name.startsWith(".") || FSA_SKIP_NAMES.has(entry.name)) {
      continue;
    }

    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.kind === "file") {
      if (predicate(entry.name)) results.push(rel);
    } else if (entry.kind === "directory") {
      try {
        const nested = await fsaWalkDir(
          entry as FileSystemDirectoryHandle,
          predicate,
          rel,
        );
        results.push(...nested);
      } catch {
        // Subdirectory unreadable — skip it.
      }
    }
  }
  return results;
}

// ─── Streaming ZIP writer ─────────────────────────────────────────────────────
//
// Implements a minimal ZIP32 writer that streams directly into a
// FileSystemWritableFileStream opened via showSaveFilePicker().
//
// Memory profile: one 64 KiB pipe buffer per in-flight file.
// No full-file or full-archive accumulation at any point.
//
// ── ZIP format recap ──────────────────────────────────────────────────────────
//
//  For each file:
//    [Local File Header]            fixed 30 + filename bytes
//    [File data]                    compressed or stored bytes
//    [Data Descriptor]              crc32 + compressed size + uncompressed size
//                                   (allows streaming: sizes not known upfront)
//
//  After all files:
//    [Central Directory entries]    one per file
//    [End of Central Directory]     points to Central Directory start
//
// We use Data Descriptors (bit 3 of General Purpose Flag set) so we never
// need to seek back to fill in sizes — a requirement for streaming to a
// FileSystemWritableFileStream, which does not support random-access seeks.
//
// Compression: text files (.rrs, .json, .txt, …) use DEFLATE via the
// browser's built-in CompressionStream("deflate-raw").  Everything else
// uses STORE (method 0) to avoid re-compressing already-compressed media.

const ZIP_LOCAL_HEADER_SIG = 0x04034b50;
const ZIP_DATA_DESCRIPTOR_SIG = 0x08074b50;
const ZIP_CENTRAL_DIR_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_VERSION_NEEDED_DEFLATE = 20; // 2.0
const ZIP_VERSION_NEEDED_STORE = 10; // 1.0
const ZIP_VERSION_MADE_BY = 0x031e; // UNIX, spec version 3.0
const ZIP_FLAG_DATA_DESCRIPTOR = 1 << 3;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;

/** Returns true for file types that benefit from DEFLATE compression. */
function shouldDeflate(zipPath: string): boolean {
  const ext = zipPath.split(".").pop()?.toLowerCase() ?? "";
  return ["rrs", "json", "txt", "xml", "html", "css", "js", "svg"].includes(
    ext,
  );
}

/** Encode a string to UTF-8 bytes. */
const _enc = new TextEncoder();
function encodeUtf8(s: string): Uint8Array {
  return _enc.encode(s);
}

/** Write a little-endian 16-bit value into `buf` at `offset`. */
function writeU16(buf: DataView, offset: number, value: number): void {
  buf.setUint16(offset, value, true);
}

/** Write a little-endian 32-bit value into `buf` at `offset`. */
function writeU32(buf: DataView, offset: number, value: number): void {
  buf.setUint32(offset, value, true);
}

/**
 * CRC-32 table (standard ZIP polynomial 0xEDB88320).
 * Computed once at module load time.
 */
const CRC32_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c;
  }
  return t;
})();

/** Update a running CRC-32 with `data`. */
function crc32Update(crc: number, data: Uint8Array): number {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return c ^ 0xffffffff;
}

/**
 * Narrow a Uint8Array to Uint8Array<ArrayBuffer> so TypeScript's strict DOM
 * types accept it as FileSystemWriteChunkType / ArrayBufferView<ArrayBuffer>.
 * At runtime this is a no-op — every Uint8Array produced from File/stream
 * data is already backed by a plain ArrayBuffer.
 */
function u8(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return data as unknown as Uint8Array<ArrayBuffer>;
}

/** Accumulate CRC-32 over an async stream, yielding each chunk to `sink`. */
async function crc32Stream(
  readable: ReadableStream<Uint8Array>,
  sink: (chunk: Uint8Array) => Promise<void>,
): Promise<{ crc: number; size: number }> {
  const reader = readable.getReader();
  let crc = 0;
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      crc = crc32Update(crc, value);
      size += value.length;
      await sink(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { crc, size };
}

/** Central directory entry metadata collected while writing local entries. */
interface CentralDirEntry {
  nameBytes: Uint8Array;
  method: number;
  modTime: number;
  modDate: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * Build a Local File Header (30 + name bytes).
 * Sizes / CRC are zeroed because we use a Data Descriptor (bit 3 set).
 */
function buildLocalHeader(
  nameBytes: Uint8Array,
  method: number,
  modTime: number,
  modDate: number,
): Uint8Array {
  const buf = new ArrayBuffer(30 + nameBytes.length);
  const dv = new DataView(buf);
  writeU32(dv, 0, ZIP_LOCAL_HEADER_SIG);
  writeU16(
    dv,
    4,
    method === ZIP_METHOD_DEFLATE
      ? ZIP_VERSION_NEEDED_DEFLATE
      : ZIP_VERSION_NEEDED_STORE,
  );
  writeU16(dv, 6, ZIP_FLAG_DATA_DESCRIPTOR);
  writeU16(dv, 8, method);
  writeU16(dv, 10, modTime);
  writeU16(dv, 12, modDate);
  // CRC-32, compressed size, uncompressed size → all 0 (in data descriptor)
  writeU32(dv, 14, 0);
  writeU32(dv, 18, 0);
  writeU32(dv, 22, 0);
  writeU16(dv, 26, nameBytes.length);
  writeU16(dv, 28, 0); // extra field length
  new Uint8Array(buf, 30).set(nameBytes);
  return new Uint8Array(buf);
}

/**
 * Build a Data Descriptor (16 bytes, with signature).
 * Written after each file's compressed data.
 */
function buildDataDescriptor(
  crc: number,
  compressedSize: number,
  uncompressedSize: number,
): Uint8Array {
  const buf = new ArrayBuffer(16);
  const dv = new DataView(buf);
  writeU32(dv, 0, ZIP_DATA_DESCRIPTOR_SIG);
  writeU32(dv, 4, crc);
  writeU32(dv, 8, compressedSize);
  writeU32(dv, 12, uncompressedSize);
  return new Uint8Array(buf);
}

/**
 * Build a Central Directory File Header (46 + name bytes).
 */
function buildCentralDirEntry(e: CentralDirEntry): Uint8Array {
  const buf = new ArrayBuffer(46 + e.nameBytes.length);
  const dv = new DataView(buf);
  writeU32(dv, 0, ZIP_CENTRAL_DIR_SIG);
  writeU16(dv, 4, ZIP_VERSION_MADE_BY);
  writeU16(
    dv,
    6,
    e.method === ZIP_METHOD_DEFLATE
      ? ZIP_VERSION_NEEDED_DEFLATE
      : ZIP_VERSION_NEEDED_STORE,
  );
  writeU16(dv, 8, ZIP_FLAG_DATA_DESCRIPTOR);
  writeU16(dv, 10, e.method);
  writeU16(dv, 12, e.modTime);
  writeU16(dv, 14, e.modDate);
  writeU32(dv, 16, e.crc);
  writeU32(dv, 20, e.compressedSize);
  writeU32(dv, 24, e.uncompressedSize);
  writeU16(dv, 28, e.nameBytes.length);
  writeU16(dv, 30, 0); // extra field length
  writeU16(dv, 32, 0); // file comment length
  writeU16(dv, 34, 0); // disk number start
  writeU16(dv, 36, 0); // internal attributes
  writeU32(dv, 38, 0); // external attributes
  writeU32(dv, 42, e.localHeaderOffset);
  new Uint8Array(buf, 46).set(e.nameBytes);
  return new Uint8Array(buf);
}

/**
 * Build the End of Central Directory record (22 bytes).
 */
function buildEocd(
  entryCount: number,
  centralDirSize: number,
  centralDirOffset: number,
): Uint8Array {
  const buf = new ArrayBuffer(22);
  const dv = new DataView(buf);
  writeU32(dv, 0, ZIP_EOCD_SIG);
  writeU16(dv, 4, 0); // disk number
  writeU16(dv, 6, 0); // disk with central dir
  writeU16(dv, 8, entryCount);
  writeU16(dv, 10, entryCount);
  writeU32(dv, 12, centralDirSize);
  writeU32(dv, 16, centralDirOffset);
  writeU16(dv, 20, 0); // comment length
  return new Uint8Array(buf);
}

/** MS-DOS date/time encoding for a JS Date object. */
function dosDateTime(d: Date): { modTime: number; modDate: number } {
  const modTime =
    (d.getHours() << 11) |
    (d.getMinutes() << 5) |
    Math.floor(d.getSeconds() / 2);
  const modDate =
    (Math.max(0, d.getFullYear() - 1980) << 9) |
    ((d.getMonth() + 1) << 5) |
    d.getDate();
  return { modTime, modDate };
}

// ─── FsaConverterFs ──────────────────────────────────────────────────────────

class FsaConverterFs implements IConverterFs {
  constructor(private readonly root: FileSystemDirectoryHandle) {}

  get label(): string {
    return this.root.name;
  }

  async walkDir(
    dir: string,
    predicate: (name: string) => boolean,
  ): Promise<string[]> {
    const dirHandle =
      dir === "" ? this.root : await fsaResolveDir(this.root, dir, false);
    if (!dirHandle) return [];
    return fsaWalkDir(dirHandle, predicate, dir === "" ? "" : dir);
  }

  async readText(relPath: string): Promise<string | null> {
    try {
      const fh = await fsaResolveFile(this.root, relPath, false);
      if (!fh) return null;
      const file = await fh.getFile();
      return file.text();
    } catch {
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
    const parts = relPath.split("/").filter(Boolean);
    let dir: FileSystemDirectoryHandle = this.root;
    for (let i = 0; i < parts.length - 1; i++) {
      try {
        dir = await dir.getDirectoryHandle(parts[i], { create: false });
      } catch {
        return false;
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
      return false;
    }
  }

  /**
   * Build a ZIP archive by streaming each file directly from the FSA handle
   * through CompressionStream into a FileSystemWritableFileStream.
   *
   * Memory profile: O(pipe chunk size) — typically 64 KiB per in-flight
   * chunk, regardless of the total archive size.
   */
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
      if (err instanceof DOMException && err.name === "AbortError") {
        return null;
      }
      throw err;
    }
  }

  async buildZip(
    include: string[],
    onProgress?: (p: ZipProgress) => void,
    onSkip?: (relPath: string) => void,
    saveTarget?: unknown,
  ): Promise<void> {
    // If a pre-acquired handle was passed in (from pickZipSaveTarget called
    // inside the user-gesture handler), use it directly.  Otherwise fall back
    // to calling the picker here — this path is kept for Tauri compatibility
    // and direct programmatic callers.
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

    const writable = await saveHandle.createWritable();
    const total = include.length;
    const centralDir: CentralDirEntry[] = [];
    let archiveOffset = 0;
    const now = new Date();
    const { modTime, modDate } = dosDateTime(now);

    try {
      for (let index = 0; index < include.length; index++) {
        const relPath = include[index];
        const nameBytes = encodeUtf8(relPath);
        const method = shouldDeflate(relPath)
          ? ZIP_METHOD_DEFLATE
          : ZIP_METHOD_STORE;

        // Resolve file handle
        const fh = await fsaResolveFile(this.root, relPath, false);
        if (!fh) {
          onSkip?.(relPath);
          continue;
        }

        let file: File;
        try {
          file = await fh.getFile();
        } catch {
          onSkip?.(relPath);
          continue;
        }

        const localHeaderOffset = archiveOffset;

        // Write Local File Header (sizes/crc zeroed; data descriptor follows)
        const localHeader = buildLocalHeader(
          nameBytes,
          method,
          modTime,
          modDate,
        );
        await writable.write(u8(localHeader));
        archiveOffset += localHeader.length;

        // ── Stream file data ──────────────────────────────────────────────────
        //
        // STORE: pipe raw bytes, accumulate CRC and size.
        // DEFLATE: pipe through CompressionStream("deflate-raw"), accumulate
        //          CRC over raw bytes (before compression) and track
        //          compressed output size separately.

        let crc = 0;
        let uncompressedSize = 0;
        let compressedSize = 0;

        if (method === ZIP_METHOD_STORE) {
          // One async pass: read raw → write → update CRC
          const rawStream = file.stream() as ReadableStream<Uint8Array>;
          const result = await crc32Stream(rawStream, async (chunk) => {
            await writable.write(u8(chunk));
            archiveOffset += chunk.length;
          });
          crc = result.crc;
          uncompressedSize = result.size;
          compressedSize = result.size;
        } else {
          // DEFLATE: we need both raw (for CRC/uncompressed size) and
          // compressed (for compressed size) counts simultaneously.
          //
          // We tee the raw stream:
          //   branch A → CRC accumulator (raw bytes, uncompressed size)
          //   branch B → CompressionStream → compressed byte counter + writable
          //
          // Both branches are drained concurrently.

          const [branchA, branchB] = (
            file.stream() as ReadableStream<Uint8Array>
          ).tee();

          // Branch A: CRC + uncompressed size (drain raw bytes, don't write)
          const crcPromise = crc32Stream(branchA, async () => {
            // We only need CRC/size, not to write the raw bytes anywhere.
          });

          // Branch B: compress and write to archive
          const compressedPromise = (async () => {
            // Cast through unknown to satisfy strict DOM lib variance on
            // CompressionStream's WritableStream<BufferSource> input type.
            const compStream = new CompressionStream(
              "deflate-raw",
            ) as unknown as TransformStream<Uint8Array, Uint8Array>;
            const compressed = branchB.pipeThrough(compStream);
            const reader = compressed.getReader();
            let compBytes = 0;
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                await writable.write(u8(value));
                compBytes += value.length;
                archiveOffset += value.length;
              }
            } finally {
              reader.releaseLock();
            }
            return compBytes;
          })();

          [{ crc, size: uncompressedSize }, compressedSize] = await Promise.all(
            [crcPromise, compressedPromise],
          );
        }

        // Write Data Descriptor (CRC-32, compressed size, uncompressed size)
        const dataDescriptor = buildDataDescriptor(
          crc,
          compressedSize,
          uncompressedSize,
        );
        await writable.write(u8(dataDescriptor));
        archiveOffset += dataDescriptor.length;

        // Record metadata for the Central Directory
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
      }

      // ── Write Central Directory ───────────────────────────────────────────
      const centralDirOffset = archiveOffset;
      let centralDirSize = 0;

      for (const entry of centralDir) {
        const cdEntry = buildCentralDirEntry(entry);
        await writable.write(u8(cdEntry));
        archiveOffset += cdEntry.length;
        centralDirSize += cdEntry.length;
      }

      // ── Write End of Central Directory ────────────────────────────────────
      const eocd = buildEocd(
        centralDir.length,
        centralDirSize,
        centralDirOffset,
      );
      await writable.write(u8(eocd));

      await writable.close();
    } catch (err) {
      // Attempt to discard the partial write on error
      try {
        await (
          writable as FileSystemWritableFileStream & {
            abort?: () => Promise<void>;
          }
        ).abort?.();
      } catch {
        // ignore abort errors
      }
      throw err;
    }
  }
}

// ─── Public factory ───────────────────────────────────────────────────────────

export type ConverterId = "tauri" | "fsa";

export interface ConverterFsResult {
  fs: IConverterFs;
  /** "tauri" or "fsa" — lets the caller adapt UI (e.g. download hint vs native save) */
  kind: ConverterId;
}

/**
 * Show a directory picker appropriate for the current platform and return an
 * IConverterFs rooted at the chosen directory.
 *
 * Returns null if the user cancels or the platform is unsupported.
 */
export async function pickConverterFs(): Promise<ConverterFsResult | null> {
  if (isTauri) {
    const path = await pickDirectory();
    if (!path) return null;
    return { fs: new TauriConverterFs(path), kind: "tauri" };
  }

  if (typeof window !== "undefined" && "showDirectoryPicker" in window) {
    type ShowDirectoryPicker = (
      opts?: Record<string, unknown>,
    ) => Promise<FileSystemDirectoryHandle>;
    try {
      const handle = await (
        window as unknown as { showDirectoryPicker: ShowDirectoryPicker }
      ).showDirectoryPicker({ mode: "readwrite" });
      return { fs: new FsaConverterFs(handle), kind: "fsa" };
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return null;
      throw err;
    }
  }

  return null;
}

/**
 * Wrap a Tauri path string as an IConverterFs.
 * Used when the path was typed manually rather than picked via dialog.
 */
export function tauriConverterFsFromPath(path: string): IConverterFs {
  return new TauriConverterFs(path);
}
