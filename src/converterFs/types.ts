// ─── Shared types for the ConverterFs abstraction ─────────────────────────────

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
 * ever being saved to disk.  No write-path permission is required for these.
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
   * path.  Returns when the file has been written to disk.
   *
   * On FSA (Chrome/Edge): opens showSaveFilePicker so the user picks where
   * to save, then streams each file through CompressionStream into the
   * writable.  JS heap stays at O(pipe buffer size) regardless of total
   * archive size.
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

// ─── Public factory result ────────────────────────────────────────────────────

export type ConverterId = "tauri" | "fsa";

export interface ConverterFsResult {
  fs: IConverterFs;
  /** "tauri" or "fsa" — lets the caller adapt UI (e.g. download hint vs native save) */
  kind: ConverterId;
}
