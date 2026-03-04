// ─── converterFs.ts — compatibility re-export barrel ─────────────────────────
//
// This file is kept as the single public import surface for the converter
// filesystem abstraction so that all existing import sites continue to work
// without modification.
//
// Implementation has been split into focused modules under src/converterFs/:
//
//   converterFs/types.ts          — CancelledError, ZipProgress, VirtualZipEntry,
//                                   IConverterFs, ConverterId, ConverterFsResult
//
//   converterFs/zipWriter.ts      — browser-side streaming ZIP utilities:
//                                   ZIP format constants, CRC-32, header builders,
//                                   deflateStream(), writeZipFooter()
//
//   converterFs/fsaHelpers.ts     — FSA path resolution and directory walk:
//                                   fsaResolveFile(), fsaResolveDir(), fsaWalkDir()
//
//   converterFs/TauriConverterFs.ts — Tauri-backed implementation +
//                                   pickTauriConverterFs(), tauriConverterFsFromPath()
//
//   converterFs/FsaConverterFs.ts   — File System Access API implementation +
//                                   pickFsaConverterFs()

// ─── Public types ─────────────────────────────────────────────────────────────

export {
  CancelledError,
  type ZipProgress,
  type VirtualZipEntry,
  type IConverterFs,
  type ConverterId,
  type ConverterFsResult,
} from "./converterFs/types";

// ─── TauriConverterFs ─────────────────────────────────────────────────────────

export {
  TauriConverterFs,
  tauriConverterFsFromPath,
} from "./converterFs/TauriConverterFs";

// ─── FsaConverterFs ───────────────────────────────────────────────────────────

export { FsaConverterFs } from "./converterFs/FsaConverterFs";

// ─── Platform-aware factory ───────────────────────────────────────────────────

import { isTauri } from "./tauri/platform";
import { pickTauriConverterFs } from "./converterFs/TauriConverterFs";
import { pickFsaConverterFs } from "./converterFs/FsaConverterFs";
import type { ConverterFsResult } from "./converterFs/types";

/**
 * Show a directory picker appropriate for the current platform and return an
 * IConverterFs rooted at the chosen directory.
 *
 * Returns null if the user cancels or the platform is unsupported.
 */
export async function pickConverterFs(): Promise<ConverterFsResult | null> {
  if (isTauri) return pickTauriConverterFs();
  return pickFsaConverterFs();
}
