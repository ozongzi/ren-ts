/*
ren_ts/zip-rpy-migrate-tool/src/zipWriterTool.ts

Streaming ZIP writer for the migration tool.

Exports:
  - buildAssetsZip(writable, mediaEntries, scriptsMap, opts)

Behavior:
  - Media entries are copied in STORE mode (no compression) and streamed from their
    original sources (ZIP entry blobs or RPA streams) without fully materializing
    the file in JS heap.
  - Scripts (in-memory strings) are written into `data/*.rrs` and compressed
    when appropriate (DEFLATE for text-like files).
  - Writes Central Directory and EOCD (supports ZIP64 when necessary) via the
    project's zipWriter helpers.
*/

import {
  buildLocalHeader,
  buildDataDescriptor,
  writeZipFooter,
  shouldDeflate,
  u8,
  crc32Stream,
  deflateStream,
  ZIP_METHOD_STORE,
  ZIP_METHOD_DEFLATE,
  CentralDirEntry,
  encodeUtf8,
  dosDateTime,
} from "../rpy-migrate-tool/converterFs/zipWriter";

import { RpaReader } from "../rpy-migrate-tool/rpaReader";
import type { ZipEntryMeta } from "./zipIndex";
import { entryDataOffset, entryCompressedStream, parseZipCentralDirectory } from "./zipIndex";

/**
 * Types used by this writer - keep compatible with processor.ts
 */
export type ZipSourceRef = {
  type: "zip";
  file: File;
  entryMeta: ZipEntryMeta;
};

export type RpaSourceRef = {
  type: "rpa";
  reader: RpaReader;
  entryPath: string;
};

export type MediaEntry = {
  path: string; // e.g. "images/CGs/yoichi/sx_yoichi_9_6b.jpg" (relative to game root)
  source: ZipSourceRef | RpaSourceRef;
};

export type BuildOptions = {
  // optional gallery payload to include in manifest
  gallery?: unknown;
  // progress callback: ({writtenEntries, totalEntries, currentFile}) => void
  onProgress?: (p: { written: number; total: number; current?: string }) => void;
};

/**
 * Write assets.zip into an already-open FileSystemWritableFileStream.
 *
 * Params:
 *  - writable: FileSystemWritableFileStream (obtained via showSaveFilePicker or Tauri)
 *  - mediaEntries: array of MediaEntry (streamed copy, stored as-is)
 *  - scriptsMap: Map<rrsFilename, rrsContentString>
 *  - opts: BuildOptions
 */
export async function buildAssetsZip(
  writable: FileSystemWritableFileStream,
  mediaEntries: MediaEntry[],
  scriptsMap: Map<string, string>,
  opts: BuildOptions = {},
): Promise<void> {
  // Central directory records accumulated while writing entries
  const centralDir: CentralDirEntry[] = [];

  // Track current archive byte offset
  let archiveOffset = 0;

  // Helper to update progress
  const totalEntries = mediaEntries.length + scriptsMap.size + 1; // +1 for manifest
  let writtenEntries = 0;
  const reportProgress = (current?: string) => {
    opts.onProgress?.({ written: writtenEntries, total: totalEntries, current });
  };

  // Helper to write raw bytes chunk to writable and advance archiveOffset
  async function writeChunk(chunk: Uint8Array) {
    await writable.write(u8(chunk));
    archiveOffset += chunk.length;
  }

  // Helper: write a Local Header and return its length
  async function writeLocalHeader(nameBytes: Uint8Array, method: number, modTime: number, modDate: number): Promise<number> {
    const localHeader = buildLocalHeader(nameBytes, method, modTime, modDate);
    await writeChunk(localHeader);
    return localHeader.length;
  }

  // Helper: obtain a ReadableStream of UNCOMPRESSED bytes for a ZIP entry
  async function readableUncompressedFromZip(ref: ZipSourceRef): Promise<ReadableStream<Uint8Array>> {
    const { file, entryMeta } = ref;
    // entryCompressedStream returns a ReadableStream of the compressed bytes slice
    const compStream = await entryCompressedStream(file, entryMeta);
    if (entryMeta.method === 0) {
      // STORE: compressed bytes are actually the raw bytes
      return compStream;
    }
    if (entryMeta.method === 8) {
      // DEFLATE: need to inflate (deflate-raw -> raw)
      // Pipe through DecompressionStream("deflate-raw")
      return compStream.pipeThrough(new DecompressionStream("deflate-raw")) as ReadableStream<Uint8Array>;
    }
    throw new Error(`Unsupported ZIP compression method ${entryMeta.method}`);
  }

  // Helper: obtain a ReadableStream of UNCOMPRESSED bytes for an RPA entry
  async function readableFromRpa(ref: RpaSourceRef): Promise<ReadableStream<Uint8Array>> {
    // RpaReader.stream returns a ReadableStream<Uint8Array> or null
    const s = ref.reader.stream(ref.entryPath);
    if (!s) throw new Error(`RPA entry not found: ${ref.entryPath}`);
    return s;
  }

  // Write a media entry as STORE (no compression). Source can be zip entry or rpa entry.
  async function writeMediaEntry(entry: MediaEntry) {
    const zipPath = entry.path;
    const nameBytes = encodeUtf8(zipPath);
    const now = new Date();
    const { modTime, modDate } = dosDateTime(now);

    // Always STORE for media
    const method = ZIP_METHOD_STORE;

    const localHeaderOffset = archiveOffset;
    await writeLocalHeader(nameBytes, method, modTime, modDate);

    // Obtain uncompressed readable stream
    let readable: ReadableStream<Uint8Array>;
    if (entry.source.type === "zip") {
      readable = await readableUncompressedFromZip(entry.source);
    } else {
      readable = await readableFromRpa(entry.source);
    }

    // Drain readable -> write into writable while computing CRC and count
    const { crc, size: uncompressedSize } = await crc32Stream(readable, async (chunk) => {
      await writeChunk(chunk);
    });

    // For STORE, compressedSize == uncompressedSize
    const compressedSize = uncompressedSize;

    // Write data descriptor
    const dd = buildDataDescriptor(crc, compressedSize, uncompressedSize);
    await writeChunk(dd);

    // Push central dir entry
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

    writtenEntries++;
    reportProgress(zipPath);
  }

  // Write a virtual (in-memory) entry (scripts & manifest).
  // content: Uint8Array or string (text)
  async function writeVirtualEntry(zipPath: string, content: string | Uint8Array) {
    const nameBytes = encodeUtf8(zipPath);
    const now = new Date();
    const { modTime, modDate } = dosDateTime(now);

    // Determine compression method
    const method = shouldDeflate(zipPath) ? ZIP_METHOD_DEFLATE : ZIP_METHOD_STORE;
    const localHeaderOffset = archiveOffset;
    await writeLocalHeader(nameBytes, method, modTime, modDate);

    // Create a ReadableStream<Uint8Array> over content
    const contentBytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const readable = new ReadableStream<Uint8Array>({
      start(ctrl) {
        // Emit in one chunk
        ctrl.enqueue(contentBytes);
        ctrl.close();
      },
    });

    let crc = 0;
    let compressedSize = 0;
    let uncompressedSize = 0;

    if (method === ZIP_METHOD_STORE) {
      // Write raw bytes directly
      const res = await crc32Stream(readable, async (chunk) => {
        await writeChunk(chunk);
      });
      crc = res.crc;
      uncompressedSize = res.size;
      compressedSize = res.size;
    } else {
      // DEFLATE: use deflateStream helper which writes compressed bytes to writable
      const res = await deflateStream(readable, writable as unknown as FileSystemWritableFileStream, (n) => {
        // onBytesWritten called for compressed bytes
        archiveOffset += n;
        compressedSize += n;
      });
      // deflateStream returns crc computed over uncompressed bytes and sizes
      crc = res.crc;
      uncompressedSize = res.uncompressedSize;
      // compressedSize already tracked via callback OR can use res.compressedSize
      if (compressedSize === 0) compressedSize = res.compressedSize;
    }

    // For STORE we already added data bytes to archiveOffset inside writeChunk;
    // For DEFLATE we incremented archiveOffset inside the deflateStream callback.
    // Now write data descriptor
    const dd = buildDataDescriptor(crc, compressedSize, uncompressedSize);
    await writeChunk(dd);

    // Push Central Dir entry
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

    writtenEntries++;
    reportProgress(zipPath);
  }

  // Write all media entries (in given order)
  for (const me of mediaEntries) {
    await writeMediaEntry(me);
  }

  // Write all script entries into data/
  for (const [rrsName, rrsContent] of scriptsMap) {
    const zipPath = `data/${rrsName}`;
    await writeVirtualEntry(zipPath, rrsContent);
  }

  // Build manifest and write as data/manifest.json (uncompressed text is fine; keep small)
  const manifest: any = { files: Array.from(scriptsMap.keys()) };
  if (opts.gallery !== undefined) manifest.gallery = opts.gallery;
  const manifestText = JSON.stringify(manifest, null, 2);
  await writeVirtualEntry("data/manifest.json", manifestText);

  // Finally write Central Directory + EOCD
  await writeZipFooter(writable, centralDir, archiveOffset);

  // done - close writable (caller may close outside if desired)
}
