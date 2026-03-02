// ─── File System Access API helpers ──────────────────────────────────────────
//
// The File System Access API lets us hold a FileSystemFileHandle that points
// at the user's zip without copying any bytes.  We persist the handle in
// IndexedDB (the only storage that can hold non-serialisable objects like
// FileSystemFileHandle).  On next launch we call requestPermission() to ask
// the browser to re-grant read access — on Chrome this is a silent one-click
// prompt, not a full re-pick.
//
// Firefox and Safari do not support showOpenFilePicker / persistent handles,
// so on those browsers the user must re-pick every session.  We detect support
// with `fsaSupported` and degrade gracefully.

import { fsaSupported } from "./platform";

// ─── IndexedDB constants ──────────────────────────────────────────────────────

const FSA_DB_NAME = "cb_fsa_store";
const FSA_DB_VERSION = 1;
const FSA_STORE = "handles";
const FSA_KEY = "zip_handle";

// ─── Internal DB helper ───────────────────────────────────────────────────────

function openFsaDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FSA_DB_NAME, FSA_DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(FSA_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ─── queryPermission / requestPermission shim ─────────────────────────────────
//
// These methods are not yet in lib.dom — cast helpers hide the ugly assertion.

type HandleWithPerm = FileSystemFileHandle & {
  queryPermission: (d: { mode: string }) => Promise<PermissionState>;
  requestPermission: (d: { mode: string }) => Promise<PermissionState>;
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Persist a FileSystemFileHandle in IndexedDB so we can restore it next
 * launch without asking the user to re-pick the file.
 */
export async function saveFsaHandle(
  handle: FileSystemFileHandle,
): Promise<void> {
  if (!fsaSupported) return;
  try {
    const db = await openFsaDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(FSA_STORE, "readwrite");
      tx.objectStore(FSA_STORE).put(handle, FSA_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn("[tauri/fsa] saveFsaHandle failed:", err);
  }
}

/**
 * Read the stored FileSystemFileHandle from IndexedDB and silently check
 * whether permission is already granted — WITHOUT prompting the user.
 *
 * Returns:
 *   { handle, file }        — permission already granted, File is ready to use.
 *   { handle, file: null }  — handle exists but permission is "prompt"/"denied";
 *                             call requestFsaPermission(handle) inside a user
 *                             gesture to ask for it.
 *   null                    — no handle stored, or FSA not supported.
 *
 * Safe to call during app init (no user gesture required).
 */
export async function queryFsaHandle(): Promise<{
  handle: FileSystemFileHandle;
  file: File | null;
} | null> {
  if (!fsaSupported) return null;
  try {
    const db = await openFsaDb();
    const handle = await new Promise<FileSystemFileHandle | undefined>(
      (resolve, reject) => {
        const tx = db.transaction(FSA_STORE, "readonly");
        const req = tx.objectStore(FSA_STORE).get(FSA_KEY);
        req.onsuccess = () =>
          resolve(req.result as FileSystemFileHandle | undefined);
        req.onerror = () => reject(req.error);
      },
    );
    db.close();
    if (!handle) return null;

    const perm = await (handle as HandleWithPerm).queryPermission({
      mode: "read",
    });
    if (perm === "granted") {
      const file = await handle.getFile();
      return { handle, file };
    }
    // Permission not yet granted — caller must use requestFsaPermission()
    // inside a user-gesture handler.
    return { handle, file: null };
  } catch (err) {
    console.warn("[tauri/fsa] queryFsaHandle failed:", err);
    return null;
  }
}

/**
 * Request read permission for a previously stored FileSystemFileHandle.
 * MUST be called inside a user-gesture handler (e.g. onClick) — browsers
 * block requestPermission() when called outside one.
 *
 * Returns the File on success, or null if the user denies.
 */
export async function requestFsaPermission(
  handle: FileSystemFileHandle,
): Promise<File | null> {
  try {
    const requested = await (handle as HandleWithPerm).requestPermission({
      mode: "read",
    });
    if (requested === "granted") return handle.getFile();
    return null;
  } catch (err) {
    console.warn("[tauri/fsa] requestFsaPermission failed:", err);
    return null;
  }
}

/**
 * @deprecated Use queryFsaHandle() + requestFsaPermission() instead.
 *
 * Try to restore a previously saved FileSystemFileHandle from IndexedDB and
 * silently check whether permission is already granted.  Returns the File on
 * success, or null if permission must be requested via a user gesture.
 */
export async function loadFsaHandle(): Promise<File | null> {
  const result = await queryFsaHandle();
  if (!result) return null;
  if (result.file) return result.file;
  // Cannot request permission here (no user gesture) — return null.
  return null;
}

/**
 * Remove the stored FileSystemFileHandle from IndexedDB (e.g. when the user
 * wants to pick a different file, or on sign-out).
 */
export async function clearFsaHandle(): Promise<void> {
  if (!fsaSupported) return;
  try {
    const db = await openFsaDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(FSA_STORE, "readwrite");
      tx.objectStore(FSA_STORE).delete(FSA_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Not fatal.
  }
}

/**
 * Open a native file picker for a zip (web only, FSA).
 * Returns the chosen FileSystemFileHandle, or null if cancelled / unsupported.
 */
export async function pickZipFileWeb(): Promise<FileSystemFileHandle | null> {
  if (!fsaSupported) return null;
  try {
    type ShowOpenFilePicker = (
      opts?: Record<string, unknown>,
    ) => Promise<FileSystemFileHandle[]>;
    const picker = (
      window as unknown as { showOpenFilePicker: ShowOpenFilePicker }
    ).showOpenFilePicker;
    const [handle] = await picker({
      types: [
        { description: "ZIP Archive", accept: { "application/zip": [".zip"] } },
      ],
      multiple: false,
    });
    return handle;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return null;
    throw err;
  }
}
