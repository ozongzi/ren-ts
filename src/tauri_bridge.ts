// ─── tauri_bridge.ts — compatibility re-export barrel ────────────────────────
//
// This file is kept as the single public surface for the tauri bridge so that
// all existing import sites continue to work without modification.
//
// Implementation has been split into focused modules under src/tauri/:
//
//   tauri/platform.ts  — isTauri, isMobile, isIOS, fsaSupported,
//                        supportsConversionTools, initPlatform(),
//                        convertFileSrcSync(), buildNativeImagePath(),
//                        buildNativeAudioPath()
//
//   tauri/fs.ts        — filesystem helpers: walkDir, pathExists,
//                        readTextFileTauri, writeTextFileTauri, makeDirTauri,
//                        readBinaryFileTauri, writeBinaryFileTauri,
//                        removeFileTauri, openTauriFileShim,
//                        readDirectory, pickDirectory, pickZipFileTauri,
//                        pickSavePath, pickAndReadTextFile,
//                        pickAndWriteTextFile, getAppDocumentsDir,
//                        ensureIOSDocumentsFolder,
//                        getStoredAssetsDir, persistAssetsDir,
//                        clearStoredAssetsDir, getStoredZipPath,
//                        persistZipPath, clearStoredZipPath,
//                        getActiveAssetsDir, setActiveAssetsDir
//
//   tauri/fsa.ts       — FSA handle persistence: saveFsaHandle,
//                        queryFsaHandle, requestFsaPermission,
//                        loadFsaHandle, clearFsaHandle, pickZipFileWeb
//
//   tauri/zip.ts       — RPA + ZIP commands: listRpa, readRpaEntry,
//                        streamingBuildZip,
//                        ZipFileEntry, RpaFileEntry, VirtualZipEntry,
//                        StreamingZipProgress

// ─── platform ─────────────────────────────────────────────────────────────────

export {
  isTauri,
  isMobile,
  isIOS,
  fsaSupported,
  supportsConversionTools,
  convertFileSrcSync,
  buildNativeImagePath,
  buildNativeAudioPath,
} from "./tauri/platform";

// initTauriBridge() is the historical name; re-export under both names.
export { initPlatform as initTauriBridge } from "./tauri/platform";

// ─── filesystem ───────────────────────────────────────────────────────────────

export {
  getStoredZipPath,
  persistZipPath,
  clearStoredZipPath,
  getStoredAssetsDir,
  persistAssetsDir,
  clearStoredAssetsDir,
  getActiveAssetsDir,
  setActiveAssetsDir,
  ensureIOSDocumentsFolder,
  getAppDocumentsDir,
  pickZipFileTauri,
  pickDirectory,
  pickSavePath,
  pickAndReadTextFile,
  pickAndWriteTextFile,
  writeTextFileTauri,
  readTextFileTauri,
  readBinaryFileTauri,
  writeBinaryFileTauri,
  removeFileTauri,
  makeDirTauri,
  pathExists,
  readDirectory,
  walkDir,
  openTauriFileShim,
  type DirEntry,
} from "./tauri/fs";

// ─── FSA handle persistence ───────────────────────────────────────────────────

export {
  saveFsaHandle,
  queryFsaHandle,
  requestFsaPermission,
  loadFsaHandle,
  clearFsaHandle,
  pickZipFileWeb,
} from "./tauri/fsa";

// ─── RPA + ZIP commands ───────────────────────────────────────────────────────

export {
  listRpa,
  readRpaEntry,
  streamingBuildZip,
  type ZipFileEntry,
  type RpaFileEntry,
  type VirtualZipEntry,
  type StreamingZipProgress,
} from "./tauri/zip";
