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
  listRpa,
  readRpaEntry,
  streamingBuildZip,
  pickSavePath,
  type ZipFileEntry,
  type StreamingZipProgress,
  type VirtualZipEntry as TauriBridgeVirtualEntry,
  type RpaFileEntry as TauriBridgeRpaEntry,
} from "./tauri_bridge";
import { RpaReader } from "./rpaReader";

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

// ─── Virtual ZIP entry ────────────────────────────────────────────────────────

/**
 * An in-memory text file that is written directly into the ZIP archive without
 * ever being saved to disk. This means no write-path permission is required.
 */
export interface VirtualZipEntry {
  /** UTF-8 text content. */
  content: string;
  /** Path stored inside the ZIP archive (forward-slash, no leading slash). */
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
   * Build a ZIP archive from the files listed in `include` plus any in-memory
   * `virtualEntries`.
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
   * @param include         Relative paths (from game root) to pack into the ZIP.
   * @param onProgress      Called after each file entry is written.
   * @param onSkip          Called when a file could not be read (entry skipped).
   * @param saveTarget      Pre-acquired target from pickZipSaveTarget(). When
   *                        provided the implementation skips its own picker call.
   * @param virtualEntries  In-memory text entries appended after all disk
   *                        files. Never written to disk — no write permission
   *                        required.
   */
  buildZip(
    include: string[],
    onProgress?: (p: ZipProgress) => void,
    onSkip?: (relPath: string) => void,
    saveTarget?: unknown,
    virtualEntries?: VirtualZipEntry[],
  ): Promise<void>;
}

// ─── TauriConverterFs ────────────────────────────────────────────────────────

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

class TauriConverterFs implements IConverterFs {
  constructor(private readonly rootPath: string) {}

  get label(): string {
    return this.rootPath;
  }

  private abs(rel: string): string {
    return rel === "" ? this.rootPath : `${this.rootPath}/${rel}`;
  }

  // ── RPA index cache ─────────────────────────────────────────────────────────
  //
  // We build the virtual-file map lazily on the first walkDir call and cache
  // it for the lifetime of this ConverterFs instance.  The cache maps each
  // relative path (game-root-relative) to the RPA source it lives in.
  //
  // A path that exists both on disk AND inside an RPA always prefers the
  // on-disk copy (real file wins, same as Ren'Py itself).

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
      // If the walk fails (permissions, etc.) just return an empty index.
      this._rpaCache = cache;
      return cache;
    }

    // Build the index for each archive in parallel.
    await Promise.all(
      rpaAbsPaths.map(async (rpaAbs) => {
        try {
          const entries = await listRpa(rpaAbs);
          for (const entry of entries) {
            // Normalise to forward slashes.
            const normEntry = entry.replace(/\\/g, "/");
            // Only register if no earlier RPA already claimed this path.
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
      // Skip if the path does not live under the requested sub-directory.
      if (dirPrefix !== "" && !relPath.startsWith(dirPrefix)) continue;
      // Skip if a real disk file already covers this path.
      if (diskFiles.has(relPath)) continue;
      // Apply the caller's predicate against just the filename part.
      const name = relPath.slice(relPath.lastIndexOf("/") + 1);
      if (predicate(name)) {
        rpaFiles.push(relPath);
      }
    }

    // Merge: disk files first, then virtual RPA files (sorted for stability).
    rpaFiles.sort();
    return [...diskFiles, ...rpaFiles];
  }

  async readText(relPath: string): Promise<string | null> {
    // Prefer disk file.
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
    // Check disk first (fast path).
    if (await pathExists(this.abs(relPath))) return true;

    // Check RPA index.
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

    // Separate the include list into real disk files and RPA virtual files.
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
        // File lives only inside an RPA archive.  Hand it to the Rust side as
        // an RpaZipEntry so Rust reads the bytes directly — nothing crosses
        // the IPC boundary and binary assets (images, audio) are handled
        // correctly without any UTF-8 encoding step.
        rpaEntries.push({
          rpaPath: vf.rpaAbs,
          entryPath: vf.entry,
          zipPath: normRel,
        });
      } else {
        diskEntries.push({ absPath: this.abs(normRel), zipPath: normRel });
      }
    }

    // Caller-supplied virtual entries (generated .rrs / manifest.json).
    const allVirtual: TauriBridgeVirtualEntry[] =
      virtualEntries && virtualEntries.length > 0
        ? virtualEntries.map((v) => ({
            content: v.content,
            zipPath: v.zipPath,
          }))
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
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;
const ZIP32_MAX = 0xffffffff; // sentinel / max for 32-bit fields
const ZIP_VERSION_NEEDED_DEFLATE = 20; // 2.0
const ZIP_VERSION_NEEDED_STORE = 10; // 1.0
const ZIP_VERSION_NEEDED_ZIP64 = 45; // 4.5 — required when ZIP64 fields present
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
/**
 * Write a 64-bit unsigned integer (little-endian) into a DataView.
 * JS numbers are safe up to 2^53; ZIP64 fields can theoretically reach 2^64
 * but in practice we only write archive offsets/sizes which stay well below
 * Number.MAX_SAFE_INTEGER for any realistic game asset bundle.
 */
function writeU64(dv: DataView, offset: number, value: number): void {
  // Low 32 bits
  dv.setUint32(offset, value >>> 0, true);
  // High 32 bits — for values < 2^53 the upper word is simply Math.floor(value / 2^32)
  dv.setUint32(offset + 4, Math.floor(value / 0x100000000) >>> 0, true);
}

function buildCentralDirEntry(e: CentralDirEntry): Uint8Array {
  // Determine whether we need a ZIP64 extra field for this entry.
  // We only need it when localHeaderOffset >= 4 GiB (the sizes in the data
  // descriptor are already stored as 32-bit values in our implementation and
  // individual files are always < 4 GiB).
  const needsZip64Offset = e.localHeaderOffset > ZIP32_MAX;
  // ZIP64 extra field: 2-byte header id + 2-byte size + 8-byte offset = 12 bytes
  const zip64ExtraLen = needsZip64Offset ? 12 : 0;

  const buf = new ArrayBuffer(46 + e.nameBytes.length + zip64ExtraLen);
  const dv = new DataView(buf);
  writeU32(dv, 0, ZIP_CENTRAL_DIR_SIG);
  writeU16(dv, 4, ZIP_VERSION_MADE_BY);
  writeU16(
    dv,
    6,
    needsZip64Offset
      ? ZIP_VERSION_NEEDED_ZIP64
      : e.method === ZIP_METHOD_DEFLATE
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
  writeU16(dv, 30, zip64ExtraLen); // extra field length
  writeU16(dv, 32, 0); // file comment length
  writeU16(dv, 34, 0); // disk number start
  writeU16(dv, 36, 0); // internal attributes
  writeU32(dv, 38, 0); // external attributes
  // Local header offset: sentinel when >= 4 GiB (real value in ZIP64 extra)
  writeU32(dv, 42, needsZip64Offset ? ZIP32_MAX : e.localHeaderOffset);
  new Uint8Array(buf, 46).set(e.nameBytes);

  if (needsZip64Offset) {
    const xBase = 46 + e.nameBytes.length;
    writeU16(dv, xBase, ZIP64_EXTRA_ID); // header id
    writeU16(dv, xBase + 2, 8); // data size (one 8-byte field)
    writeU64(dv, xBase + 4, e.localHeaderOffset);
  }

  return new Uint8Array(buf);
}

/**
 * Build a ZIP64 End of Central Directory record (56 bytes).
 */
function buildZip64Eocd(
  entryCount: number,
  centralDirSize: number,
  centralDirOffset: number,
): Uint8Array {
  const buf = new ArrayBuffer(56);
  const dv = new DataView(buf);
  writeU32(dv, 0, ZIP64_EOCD_SIG);
  writeU64(dv, 4, 44); // size of remaining record (56 - 12)
  writeU16(dv, 12, ZIP_VERSION_MADE_BY);
  writeU16(dv, 14, ZIP_VERSION_NEEDED_ZIP64);
  writeU32(dv, 16, 0); // number of this disk
  writeU32(dv, 20, 0); // disk where CD starts
  writeU64(dv, 24, entryCount); // entries on this disk
  writeU64(dv, 32, entryCount); // total entries
  writeU64(dv, 40, centralDirSize);
  writeU64(dv, 48, centralDirOffset);
  return new Uint8Array(buf);
}

/**
 * Build a ZIP64 End of Central Directory Locator (20 bytes).
 * Must be written immediately before the EOCD32 record.
 */
function buildZip64EocdLocator(zip64EocdOffset: number): Uint8Array {
  const buf = new ArrayBuffer(20);
  const dv = new DataView(buf);
  writeU32(dv, 0, ZIP64_EOCD_LOCATOR_SIG);
  writeU32(dv, 4, 0); // disk with ZIP64 EOCD
  writeU64(dv, 8, zip64EocdOffset); // absolute offset of ZIP64 EOCD
  writeU32(dv, 16, 1); // total disks
  return new Uint8Array(buf);
}

/**
 * Build the End of Central Directory record (22 bytes).
 * When the archive exceeds ZIP32 limits, fields that don't fit are set to
 * the sentinel value 0xFFFFFFFF — the real values live in the ZIP64 EOCD.
 */
function buildEocd(
  entryCount: number,
  centralDirSize: number,
  centralDirOffset: number,
): Uint8Array {
  const buf = new ArrayBuffer(22);
  const dv = new DataView(buf);
  const clamp = (v: number) => (v > ZIP32_MAX ? ZIP32_MAX : v);
  const clampCount = (v: number) => (v > 0xffff ? 0xffff : v);
  writeU32(dv, 0, ZIP_EOCD_SIG);
  writeU16(dv, 4, 0); // disk number
  writeU16(dv, 6, 0); // disk with central dir
  writeU16(dv, 8, clampCount(entryCount));
  writeU16(dv, 10, clampCount(entryCount));
  writeU32(dv, 12, clamp(centralDirSize));
  writeU32(dv, 16, clamp(centralDirOffset));
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

/**
 * Maps a game-root-relative path to the RpaReader that owns it and the
 * exact in-archive entry name.
 */
interface FsaRpaVirtualFile {
  reader: RpaReader;
  entry: string;
}

class FsaConverterFs implements IConverterFs {
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
    // Prefer disk file.
    try {
      const fh = await fsaResolveFile(this.root, relPath, false);
      if (fh) {
        const file = await fh.getFile();
        return file.text();
      }
    } catch {
      // fall through to RPA
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
    virtualEntries?: VirtualZipEntry[],
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
        const [branchA, branchB] = rawStream.tee();

        const crcPromise = crc32Stream(branchA, async () => {});

        const compressedPromise = (async () => {
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

        const [crcResult, compSize] = await Promise.all([
          crcPromise,
          compressedPromise,
        ]);
        crc = crcResult.crc;
        uncompressedSize = crcResult.size;
        compressedSize = compSize;
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
      for (let index = 0; index < include.length; index++) {
        const relPath = include[index];
        const normRel = relPath.replace(/\\/g, "/");

        // ── Determine source: disk file or RPA virtual entry ──────────────
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

      // ── Virtual (in-memory text) entries ──────────────────────────────────
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

        // Compress via CompressionStream
        const rawStream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(rawBytes);
            controller.close();
          },
        });

        let crc = 0;
        let uncompressedSize = 0;
        let compressedSize = 0;

        const [branchA, branchB] = rawStream.tee();

        const crcPromise = crc32Stream(branchA, async () => {});

        const compressedPromise = (async () => {
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

        [{ crc, size: uncompressedSize }, compressedSize] = await Promise.all([
          crcPromise,
          compressedPromise,
        ]);

        const dataDescriptor = buildDataDescriptor(
          crc,
          compressedSize,
          uncompressedSize,
        );
        await writable.write(u8(dataDescriptor));
        archiveOffset += dataDescriptor.length;

        centralDir.push({
          nameBytes,
          method: ZIP_METHOD_DEFLATE,
          modTime,
          modDate,
          crc,
          compressedSize,
          uncompressedSize,
          localHeaderOffset,
        });

        onProgress?.({ index, total, zipPath: ventry.zipPath });
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

      // ── Write ZIP64 EOCD + Locator (when archive exceeds ZIP32 limits) ────
      // Needed when: centralDirOffset >= 4 GiB, centralDirSize >= 4 GiB,
      // or entry count > 65535.  We always write them when the offset alone
      // exceeds 4 GiB, which is the common case for large game asset bundles.
      const needsZip64 =
        centralDirOffset > ZIP32_MAX ||
        centralDirSize > ZIP32_MAX ||
        centralDir.length > 0xffff;

      if (needsZip64) {
        const zip64EocdOffset = archiveOffset;
        const zip64Eocd = buildZip64Eocd(
          centralDir.length,
          centralDirSize,
          centralDirOffset,
        );
        await writable.write(u8(zip64Eocd));
        archiveOffset += zip64Eocd.length;

        const zip64Locator = buildZip64EocdLocator(zip64EocdOffset);
        await writable.write(u8(zip64Locator));
        archiveOffset += zip64Locator.length;
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
      ).showDirectoryPicker({ mode: "read" });
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
