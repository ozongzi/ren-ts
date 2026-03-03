// ─── Tauri RPA + ZIP commands ─────────────────────────────────────────────────
//
// Wrappers around the Rust-backed Tauri commands:
//   • list_rpa        – parse an RPA-2/3 archive and return all entry paths
//   • read_rpa_entry  – read the raw bytes of one entry from an RPA archive
//   • build_zip       – stream-write a ZIP archive entirely in Rust
//
// File bytes never cross the IPC boundary for ZIP builds — Rust reads each
// source directly from disk (or from an RPA archive) and writes the output
// file natively.  Only metadata (paths, progress counters) is serialised.

import { isTauri } from "./platform.ts";

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface ZipFileEntry {
  /** Absolute path to read the source file from. */
  absPath: string;
  /** Path stored inside the ZIP archive (forward-slash, no leading slash). */
  zipPath: string;
}

export interface RpaFileEntry {
  /** Absolute path to the .rpa file on disk. */
  rpaPath: string;
  /** In-archive path as returned by listRpa (e.g. "images/bg/day.png"). */
  entryPath: string;
  /** Path to store inside the output ZIP archive. */
  zipPath: string;
}

export interface VirtualZipEntry {
  /** UTF-8 text content to write directly into the archive (no disk read). */
  content: string;
  /** Path stored inside the ZIP archive (forward-slash, no leading slash). */
  zipPath: string;
}

export interface StreamingZipProgress {
  /** 0-based index of the file just processed. */
  index: number;
  total: number;
  zipPath: string;
  /** Cumulative uncompressed bytes written so far. */
  bytesWritten: number;
}

// ─── RPA bridge ───────────────────────────────────────────────────────────────

/**
 * List all file paths stored inside an RPA archive.
 *
 * @param rpaPath  Absolute path to the `.rpa` file on disk.
 * @returns        Sorted list of in-archive paths, e.g. `["images/bg/day.png", …]`.
 */
export async function listRpa(rpaPath: string): Promise<string[]> {
  if (!isTauri) throw new Error("listRpa requires a Tauri context");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("list_rpa", { path: rpaPath });
}

/**
 * Read the raw bytes of a single entry from an RPA archive.
 *
 * Tauri's IPC layer encodes the byte array as a JSON number array; `invoke`
 * returns it as a plain `number[]` which we wrap in a `Uint8Array`.
 *
 * @param rpaPath    Absolute path to the `.rpa` file on disk.
 * @param entryPath  In-archive path as returned by `listRpa`.
 * @returns          Raw file bytes.
 */
export async function readRpaEntry(
  rpaPath: string,
  entryPath: string,
): Promise<Uint8Array> {
  if (!isTauri) throw new Error("readRpaEntry requires a Tauri context");
  const { invoke } = await import("@tauri-apps/api/core");
  const bytes = await invoke<number[]>("read_rpa_entry", {
    rpaPath,
    entryPath,
  });
  return new Uint8Array(bytes);
}

// ─── ZIP builder ──────────────────────────────────────────────────────────────

/** Strip a leading `file://` scheme and percent-decode the remainder. */
function normPath(p: string): string {
  return p.startsWith("file://") ? decodeURIComponent(p.slice(7)) : p;
}

/**
 * Build a ZIP archive by invoking the native Rust `build_zip` command.
 *
 * The Rust side reads each source file in 128 KiB chunks and writes directly
 * to the output file — no full-file or full-archive buffers anywhere.
 *
 * Virtual entries (`virtualFiles`) are in-memory text entries passed directly
 * to Rust via IPC.  They are written into the archive without ever being saved
 * to disk, so no write-path permission is required for them.
 *
 * @param outputPath    Absolute path where the ZIP will be written.
 * @param files         Ordered list of {absPath, zipPath} disk entries.
 * @param onProgress    Optional callback invoked after each entry is written.
 * @param onSkip        Optional callback when a disk file could not be read.
 * @param virtualFiles  Optional list of in-memory text entries to append.
 * @param rpaFiles      Optional list of RPA-sourced entries; Rust reads them
 *                      directly from the archive — no bytes cross the IPC boundary.
 * @returns             Total number of entries successfully written.
 */
export async function streamingBuildZip(
  outputPath: string,
  files: ZipFileEntry[],
  onProgress?: (p: StreamingZipProgress) => void,
  onSkip?: (absPath: string, zipPath: string) => void,
  virtualFiles?: VirtualZipEntry[],
  rpaFiles?: RpaFileEntry[],
): Promise<number> {
  if (!isTauri) throw new Error("streamingBuildZip requires a Tauri context");

  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  // Normalise entry paths (strip file:// prefix if present).
  const normalisedFiles = files.map((f) => ({
    abs_path: normPath(f.absPath),
    zip_path: f.zipPath,
  }));

  // Subscribe to per-file progress / skip events emitted by Rust.
  type RustProgress = {
    index: number;
    total: number;
    zip_path: string;
    bytes_written: number;
  };
  type RustSkip = { abs_path: string; zip_path: string; reason: string };

  const unlistenProgress = onProgress
    ? await listen<RustProgress>("zip://progress", (ev) => {
        onProgress({
          index: ev.payload.index,
          total: ev.payload.total,
          zipPath: ev.payload.zip_path,
          bytesWritten: ev.payload.bytes_written,
        });
      })
    : null;

  const unlistenSkip = onSkip
    ? await listen<RustSkip>("zip://skip", (ev) => {
        onSkip(ev.payload.abs_path, ev.payload.zip_path);
      })
    : null;

  try {
    const written = await invoke<number>("build_zip", {
      outputPath: normPath(outputPath),
      entries: normalisedFiles,
      rpaEntries:
        rpaFiles && rpaFiles.length > 0
          ? rpaFiles.map((r) => ({
              rpa_path: normPath(r.rpaPath),
              entry_path: r.entryPath,
              zip_path: r.zipPath,
            }))
          : null,
      virtualEntries:
        virtualFiles && virtualFiles.length > 0
          ? virtualFiles.map((v) => ({
              content: v.content,
              zip_path: v.zipPath,
            }))
          : null,
    });
    return written;
  } finally {
    unlistenProgress?.();
    unlistenSkip?.();
  }
}
