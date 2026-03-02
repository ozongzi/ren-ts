// ─── File System Access API helpers ──────────────────────────────────────────
//
// Utilities for traversing and resolving paths within a
// FileSystemDirectoryHandle root.  Used by FsaConverterFs.
//
// All paths are relative to the root handle, using "/" as separator.
// The root itself is represented as "" or ".".

// ─── Path resolution ──────────────────────────────────────────────────────────

/**
 * Resolve a relative path into a FileSystemFileHandle by traversing
 * directory handles from `root`.  Creates intermediate directories when
 * `create` is true.  Returns null if any segment is missing and `create` is
 * false.
 */
export async function fsaResolveFile(
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
 * Returns null if any segment is missing and `create` is false.
 */
export async function fsaResolveDir(
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

// ─── Directory walk ───────────────────────────────────────────────────────────

/**
 * Directory names that are never useful for game conversion and are known to
 * cause NotReadableError (or equivalent) on macOS / Windows when enumerated
 * via the File System Access API.
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

/**
 * Recursively collect relative paths of files satisfying `predicate` under
 * `dirHandle`.
 *
 * @param dirHandle  The directory to walk.
 * @param predicate  Called with each file's name; include the file when true.
 * @param prefix     Relative path prefix used to reach `dirHandle` from the
 *                   root (empty string at the root level).
 * @returns          Relative paths from the original root handle.
 */
export async function fsaWalkDir(
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
    // Return an empty list for this subtree — the caller gets partial results.
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
        // Subdirectory unreadable — skip it silently.
      }
    }
  }

  return results;
}
