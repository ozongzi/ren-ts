/*
ren_ts/zip-rpy-migrate-tool/src/processor.ts

Main processor: walk ZIP / RPA nested archives and collect:
 - scripts[]: in-memory collection of .rpy (string) and .rpyc (Uint8Array)
 - media[]: references to media entries (kept as streamable sources, no full materialization)

Notes:
 - This module reuses the local lightweight zip index helpers in ./zipIndex.ts
 - RPA parsing is handled via the project's RpaReader implementation.
 - Media entries are represented by a reference describing how to stream them later.
 - Scripts are fully read into memory (per your requirement).
*/

import {
  parseZipCentralDirectory,
  entryDataOffset,
  ZipEntryMeta,
  entryCompressedStream,
} from "./zipIndex";
import { RpaReader } from "../../rpy-migrate-tool/rpaReader";

type ScriptEntry = {
  // path relative to the `game/` root inside the top-level archive (forward slashes)
  path: string;
  // for .rpy -> text; for .rpyc -> bytes
  data: string | Uint8Array;
  isRpy: boolean;
};

type ZipSourceRef = {
  type: "zip";
  // the File object (top-level File or a File created from a nested zip entry's blob).
  file: File;
  entryMeta: ZipEntryMeta;
};

type RpaSourceRef = {
  type: "rpa";
  reader: RpaReader;
  entryPath: string; // path inside the rpa archive
};

type MediaEntry = {
  // path where the media should be stored in target assets.zip (relative to game root)
  path: string;
  // source information used later for streaming copy (no bytes loaded here)
  source: ZipSourceRef | RpaSourceRef;
};

export type ProcessResult = {
  gameDir: string; // the detected game root path inside the top-level ZIP (e.g. "CampBuddy-win32/.../game")
  scripts: ScriptEntry[];
  media: MediaEntry[];
};

const IMAGE_EXT = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "tga",
  "dds",
  "svg",
];
const AUDIO_EXT = ["ogg", "mp3", "wav", "flac", "m4a", "aac"];
const VIDEO_EXT = ["webm", "mp4", "ogv", "mkv"];
const SCRIPT_EXT = ["rpy", "rpyc"];
const ARCHIVE_EXT = ["zip", "rpa"];

function extOf(path: string): string {
  const p = path.split("/").pop() ?? "";
  const i = p.lastIndexOf(".");
  return i === -1 ? "" : p.slice(i + 1).toLowerCase();
}

function isMediaExt(ext: string) {
  return (
    IMAGE_EXT.includes(ext) ||
    AUDIO_EXT.includes(ext) ||
    VIDEO_EXT.includes(ext)
  );
}
function isScriptExt(ext: string) {
  return SCRIPT_EXT.includes(ext);
}
function isArchiveExt(ext: string) {
  return ARCHIVE_EXT.includes(ext);
}

/**
 * Read all bytes from a ReadableStream<Uint8Array>
 */
async function readAllFromStream(
  rs: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = rs.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Inflate a Blob that contains raw DEFLATE bytes (deflate-raw).
 * Uses DecompressionStream available in modern browsers / Tauri WebView.
 */
async function inflateRawBlob(blob: Blob): Promise<Uint8Array> {
  // Prefer browser DecompressionStream when available (browser / WebView).
  if (typeof DecompressionStream !== "undefined") {
    // Pipe blob.stream() through DecompressionStream("deflate-raw")
    const ds = new DecompressionStream("deflate-raw");
    const decompressedStream = blob.stream().pipeThrough(ds);
    return await readAllFromStream(
      decompressedStream as ReadableStream<Uint8Array>,
    );
  }

  // Fallback for Node: use zlib.inflateRawSync via dynamic import.
  // This branch expects to run in a Node environment (e.g. CLI test).
  try {
    const ab = await blob.arrayBuffer();
    // Use dynamic import so this module still runs in browsers where 'zlib' does not exist.
    const zlib = await import("zlib");
    // zlib.inflateRawSync accepts a Buffer
    const inflated = zlib.inflateRawSync(Buffer.from(ab));
    return new Uint8Array(inflated);
  } catch (err) {
    // As a last resort, return the raw bytes (may be compressed) to avoid throwing.
    // Caller may handle or report failures upstream.
    const ab = await blob.arrayBuffer();
    return new Uint8Array(ab);
  }
}

/**
 * Read entry bytes from a ZIP (handles STORE and DEFLATE).
 * Uses entry metadata and the top-level File blob.
 */
async function readEntryBytesFromZip(
  file: File | Blob,
  entry: ZipEntryMeta,
): Promise<Uint8Array> {
  const dataOffset = await entryDataOffset(file, entry);
  const slice = (file as Blob).slice(
    dataOffset,
    dataOffset + entry.compressedSize,
  );
  if (entry.method === 0) {
    // STORE: compressed bytes === raw bytes
    const ab = await slice.arrayBuffer();
    return new Uint8Array(ab);
  }
  if (entry.method === 8) {
    // DEFLATE: need to inflate raw deflate bytes (ZIP stores deflate-raw)
    return await inflateRawBlob(slice);
  }
  throw new Error(
    `Unsupported ZIP compression method ${entry.method} for "${entry.name}"`,
  );
}

/**
 * Utility: create a File object from a Blob (keeps blob's underlying data)
 */
function blobToFile(blob: Blob, filename: string): File {
  // File constructor reuses blob's underlying data, not copying it.
  return new File([blob], filename, { type: "application/octet-stream" });
}

/**
 * Find the outermost "game" directory path inside a ZIP index.
 * Return the path WITHOUT a trailing slash; e.g. "CampBuddy-win32/game" or "game"
 *
 * Strategy:
 *  - For every entry path that contains "/game/" or startsWith("game/"), compute
 *    number of segments before the 'game' token. Pick the entry with minimal segmentsBefore
 *    — that indicates the shallowest (最外层) 'game' directory.
 */
function detectGameDirFromIndex(entryNames: Iterable<string>): string | null {
  let best: { segmentsBefore: number; gameRoot: string } | null = null;
  for (const name of entryNames) {
    // normalize to forward slashes already guaranteed by zipIndex
    const idx = name.indexOf("/game/");
    if (idx !== -1) {
      const before = name.slice(0, idx); // may be ""
      const segmentsBefore = before === "" ? 0 : before.split("/").length;
      const gameRoot = before === "" ? "game" : `${before}/game`;
      if (!best || segmentsBefore < best.segmentsBefore) {
        best = { segmentsBefore, gameRoot };
      }
    } else if (name.startsWith("game/")) {
      // top-level game/
      if (!best || 0 < best.segmentsBefore) {
        best = { segmentsBefore: 0, gameRoot: "game" };
      }
    }
  }
  return best ? best.gameRoot : null;
}

/**
 * Main exported processor: accepts a top-level File (ZIP). Walks nested zip/rpa archives
 * found under the detected game root and collects scripts and media references.
 */
export async function processTopLevelZip(
  zipFile: File,
): Promise<ProcessResult> {
  // parse central directory of top-level zip
  const index = await parseZipCentralDirectory(zipFile);
  const allNames = Array.from(index.keys());
  const gameDir = detectGameDirFromIndex(allNames);
  if (!gameDir) {
    throw new Error(
      "Game directory not found in zip (no 'game/' folder detected)",
    );
  }

  // Collect results
  const scripts: ScriptEntry[] = [];
  const media: MediaEntry[] = [];

  // Helper: ensure forward slashes and no leading slash
  const normalizeRel = (p: string) => p.replace(/\\/g, "/").replace(/^\/+/, "");

  // Helper to push script content
  async function collectScriptFromZipEntry(
    relPath: string,
    entryMeta: ZipEntryMeta,
    sourceFile: File,
  ) {
    const ext = extOf(relPath);
    try {
      const bytes = await readEntryBytesFromZip(sourceFile, entryMeta);
      if (ext === "rpy") {
        const text = new TextDecoder("utf-8").decode(bytes);
        scripts.push({ path: normalizeRel(relPath), data: text, isRpy: true });
      } else if (ext === "rpyc") {
        scripts.push({
          path: normalizeRel(relPath),
          data: bytes,
          isRpy: false,
        });
      }
    } catch (err) {
      console.warn(`Failed reading script ${relPath} from zip:`, err);
    }
  }

  // Process an RPA blob: index it and collect entries
  async function processRpaBlob(rpaBlob: Blob, parentRelPrefix: string) {
    // RpaReader expects a File-like object (File is a Blob + name). Give it a File wrapper.
    const rpaFile = blobToFile(rpaBlob, "nested.rpa");
    let reader: RpaReader;
    try {
      reader = await RpaReader.open(rpaFile);
    } catch (err) {
      console.warn("Failed to open RPA:", err);
      return;
    }

    for (const pathInRpa of reader.paths) {
      // Build destination relative path: parentRelPrefix + pathInRpa
      const rel = parentRelPrefix
        ? `${parentRelPrefix}/${pathInRpa}`
        : pathInRpa;
      const ext = extOf(rel);
      if (isMediaExt(ext)) {
        media.push({
          path: normalizeRel(rel),
          source: { type: "rpa", reader, entryPath: pathInRpa },
        });
      } else if (ext === "rpy") {
        const data = await reader.read(pathInRpa);
        if (data) {
          const text = new TextDecoder("utf-8").decode(data);
          scripts.push({ path: normalizeRel(rel), data: text, isRpy: true });
        }
      } else if (ext === "rpyc") {
        const data = await reader.read(pathInRpa);
        if (data) {
          scripts.push({ path: normalizeRel(rel), data, isRpy: false });
        }
      } else {
        // ignore other files
      }
    }
  }

  /**
   * Recursive: process an archive Blob (zip) or RPA file, with a prefix that will be
   * prepended to every inner entry to produce a relPath relative to top-level game root.
   *
   * - If the archive is a zip:
   *    - For the top-level zip we only traverse entries under the detected gameDir.
   *    - For nested zips we treat all entries in that nested zip as belonging under the parentRelPrefix.
   * - If the archive is an RPA, we index & iterate its internal paths via RpaReader.
   */
  async function processNestedZipBlob(
    zipBlob: Blob,
    parentRelPrefix: string,
    treatAsTopLevelGameScope = false,
  ) {
    // Create a File wrapper so parseZipCentralDirectory can rely on .size and blob.slice semantics
    const nestedFile = blobToFile(zipBlob, "nested.zip");
    let nestedIndex: Map<string, ZipEntryMeta>;
    try {
      nestedIndex = await parseZipCentralDirectory(nestedFile);
    } catch (err) {
      console.warn("Failed to parse nested zip central directory:", err);
      return;
    }

    // If treatAsTopLevelGameScope is true, attempt to detect 'game/' inside nested zip and use it;
    // otherwise interpret nested zip entries as rooted at the nested zip's root.
    let nestedGameRoot: string | null = null;
    if (treatAsTopLevelGameScope) {
      nestedGameRoot = detectGameDirFromIndex(nestedIndex.keys());
    }

    for (const [entryName, meta] of nestedIndex) {
      // decide the logical relative path inside the overall game root
      let innerRel: string;
      if (nestedGameRoot) {
        if (!entryName.startsWith(nestedGameRoot + "/")) continue;
        innerRel = entryName.slice(nestedGameRoot.length + 1);
      } else {
        innerRel = entryName;
      }

      const prefixedRel = parentRelPrefix
        ? `${parentRelPrefix}/${innerRel}`
        : innerRel;
      const ext = extOf(innerRel);

      if (isArchiveExt(ext)) {
        // don't materialize entry bytes beyond a Blob slice; create a Blob referencing nestedFile bytes
        try {
          const dataOffset = await entryDataOffset(nestedFile, meta);
          let nestedArchiveBlob = nestedFile.slice(
            dataOffset,
            dataOffset + meta.compressedSize,
          );
          // If the nested entry is DEFLATE-compressed in the parent zip, inflate it so
          // nested archive parsing sees the raw archive bytes.
          if (meta.method === 8) {
            try {
              const inflated = await inflateRawBlob(nestedArchiveBlob);
              nestedArchiveBlob = new Blob([inflated.buffer]);
            } catch (err) {
              console.warn(
                "Failed to inflate nested archive entry, continuing with raw blob:",
                err,
              );
            }
          }
          if (ext === "rpa") {
            // RPA parse
            await processRpaBlob(
              nestedArchiveBlob,
              normalizeRel(prefixedRel.replace(/\.rpa$/i, "")),
            );
          } else {
            // nested zip -> recurse (not treating nested zip as having its own 'game' unless instructed)
            await processNestedZipBlob(
              nestedArchiveBlob,
              normalizeRel(prefixedRel),
              false,
            );
          }
        } catch (err) {
          console.warn(
            "Failed to handle nested archive entry:",
            prefixedRel,
            err,
          );
        }
      } else if (isMediaExt(ext)) {
        // push a ZipSourceRef referencing nestedFile and the entry meta (meta refers to nestedFile offsets)
        media.push({
          path: normalizeRel(prefixedRel),
          source: {
            type: "zip",
            file: nestedFile,
            entryMeta: meta,
          },
        });
      } else if (ext === "rpy" || ext === "rpyc") {
        await collectScriptFromZipEntry(prefixedRel, meta, nestedFile);
      } else if (ext === "rpa") {
        // (handled by isArchiveExt earlier, but keep for safety)
        try {
          const dataOffset = await entryDataOffset(nestedFile, meta);
          const innerBlob = nestedFile.slice(
            dataOffset,
            dataOffset + meta.compressedSize,
          );
          await processRpaBlob(
            innerBlob,
            normalizeRel(prefixedRel.replace(/\.rpa$/i, "")),
          );
        } catch (err) {
          console.warn("Failed to open rpa entry:", prefixedRel, err);
        }
      } else {
        // ignore everything else
      }
    }
  }

  // Top-level iteration: gather all entries under gameDir
  const gamePrefix = gameDir.endsWith("/") ? gameDir : `${gameDir}`;
  const gamePrefixWithSlash = gamePrefix + "/";

  for (const [entryName, meta] of index) {
    if (!entryName.startsWith(gamePrefixWithSlash)) continue;
    // relative path inside game root
    const relInsideGame = entryName.slice(gamePrefixWithSlash.length);
    if (!relInsideGame || relInsideGame.endsWith("/")) continue; // skip directories

    const ext = extOf(relInsideGame);
    const relNormalized = normalizeRel(relInsideGame);

    if (isArchiveExt(ext)) {
      // read as blob slice (no full materialize) and handle nested
      const dataOffset = await entryDataOffset(zipFile, meta);
      let blob = zipFile.slice(dataOffset, dataOffset + meta.compressedSize);
      // If this entry is DEFLATE-compressed inside the parent ZIP, inflate it first
      // so that nested archive / RPA parsers receive raw archive bytes.
      if (meta.method === 8) {
        try {
          const inflated = await inflateRawBlob(blob);
          blob = new Blob([inflated.buffer]);
        } catch (err) {
          console.warn(
            "Failed to inflate top-level nested archive entry, will continue with raw blob:",
            err,
          );
        }
      }
      if (ext === "rpa") {
        await processRpaBlob(blob, relNormalized.replace(/\.rpa$/i, ""));
      } else {
        // nested zip under game root: treat its internal entries as relative to this nested file's parent dir
        // For example game/mini.zip whose inner file day2.rpy => final path "day2.rpy" if mini.zip is directly under game/,
        // but if mini.zip located in subdir "sub/mini.zip" then prefix with "sub".
        const parentDir = relNormalized.split("/").slice(0, -1).join("/");
        const prefix = parentDir;
        // For nested top-level zip treatAsTopLevelGameScope = false (we don't expect nested zips to contain a 'game' folder)
        await processNestedZipBlob(blob, prefix, false);
      }
    } else if (isMediaExt(ext)) {
      media.push({
        path: relNormalized,
        source: {
          type: "zip",
          file: zipFile,
          entryMeta: meta,
        },
      });
    } else if (ext === "rpy" || ext === "rpyc") {
      await collectScriptFromZipEntry(relInsideGame, meta, zipFile);
    } else {
      // ignore other files
    }
  }

  return {
    gameDir,
    scripts,
    media,
  };
}
