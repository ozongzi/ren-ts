/*
ren_ts/zip-rpy-migrate-tool/src/cliTest.ts

Node-only small CLI-friendly test runner:
- Reads `assets/test.zip` from the repository root (ren_ts/assets/test.zip)
- Runs the processor to collect scripts and media
- Converts .rpy / .rpyc to .rrs using existing converters
- Writes output files into ren_ts/zip-rpy-migrate-tool/out/
  preserving the path layout:
    out/
      data/
        *.rrs
        manifest.json
      images/...
      Audio/...
      ...

Usage:
  node ./dist/zip-rpy-migrate-tool/src/cliTest.js
(or run via ts-node / compile with tsc)

Notes:
- This file assumes a Node 18+ environment where global `Blob`/`File` exist.
- Uses zlib.inflateRawSync to handle deflate-compressed ZIP entries.
*/

import fs from "fs";
import path from "path";
import { inflateRawSync } from "zlib";

import { processTopLevelZip, ProcessResult } from "./processor";
import { parseZipCentralDirectory, entryDataOffset } from "./zipIndex";

// converters for scripts
import { convertRpy } from "../../rpy-migrate-tool/rpy-rrs-bridge/rpy2rrs-core";
import { convertRpyc } from "../../rpy-migrate-tool/rpy-rrs-bridge/rpyc2rrs-core";
import { readRpyc } from "../../rpy-migrate-tool/rpycReader";

type AnyScript = { path: string; data: any; isRpy: boolean };
type AnyMedia = { path: string; source: any };

async function ensureDir(p: string) {
  await fs.promises.mkdir(p, { recursive: true });
}

function normalizeOutPath(...parts: string[]) {
  return path.join(...parts);
}

async function writeFileBytes(targetPath: string, bytes: Uint8Array) {
  await ensureDir(path.dirname(targetPath));
  await fs.promises.writeFile(targetPath, Buffer.from(bytes));
}

async function writeFileText(targetPath: string, text: string) {
  await ensureDir(path.dirname(targetPath));
  await fs.promises.writeFile(targetPath, text, { encoding: "utf-8" });
}

async function readBlobAsUint8Array(blob: Blob): Promise<Uint8Array> {
  // Node's Blob.arrayBuffer() available in Node 18+
  const ab = await blob.arrayBuffer();
  return new Uint8Array(ab);
}

async function extractMediaEntryToDisk(baseOut: string, media: AnyMedia) {
  const dest = path.join(baseOut, media.path);
  const src = media.source;

  if (src.type === "zip") {
    // src.file is a File/Blob and src.entryMeta is ZipEntryMeta
    const fileBlob = src.file as Blob;
    const meta = src.entryMeta as any;
    // compute dataOffset and take slice
    // entryDataOffset expects Blob and entry meta
    const dataOffset = await entryDataOffset(fileBlob, meta);
    const slice = fileBlob.slice(dataOffset, dataOffset + meta.compressedSize);
    let bytes = await readBlobAsUint8Array(slice);
    if (meta.method === 8) {
      // deflate-raw -> inflate
      try {
        // Node's zlib.inflateRawSync expects Buffer
        const inflated = inflateRawSync(Buffer.from(bytes));
        bytes = new Uint8Array(inflated);
      } catch (err) {
        console.warn(
          `Warning: inflateRawSync failed for ${media.path}, attempting to write raw bytes. Error:`,
          err,
        );
      }
    }
    await writeFileBytes(dest, bytes);
    return;
  }

  if (src.type === "rpa") {
    const reader = src.reader as any;
    const entryPath = src.entryPath as string;
    const data = await reader.read(entryPath);
    if (!data) {
      console.warn(
        `RPA entry ${entryPath} returned null, skipping ${media.path}`,
      );
      return;
    }
    await writeFileBytes(dest, data);
    return;
  }

  console.warn(`Unknown media source type for ${media.path}, skipping.`);
}

/**
 * Convert scripts collected by processor into .rrs strings.
 * Returns a Map rrName -> rrsContent
 */
async function convertScripts(scripts: AnyScript) {
  const map = new Map<string, string>();
  for (const s of scripts as AnyScript[]) {
    const rel = s.path.replace(/^\/+/, "");
    // make .rrs name (preserve directory structure)
    const rrsName = rel.replace(/\.(rpyc|rpy)$/i, ".rrs");
    try {
      if (s.isRpy) {
        const content =
          typeof s.data === "string"
            ? s.data
            : new TextDecoder("utf-8").decode(s.data);
        const rrs = convertRpy(content, rrsName);
        map.set(rrsName, rrs);
        console.log(`Converted rpy -> ${rrsName}`);
      } else {
        // rpyc: s.data expected Uint8Array
        const bytes = s.data as Uint8Array;
        const rpyc = await readRpyc(bytes);
        const rrs = convertRpyc(rpyc.astPickle, rrsName);
        map.set(rrsName, rrs);
        console.log(`Converted rpyc -> ${rrsName}`);
      }
    } catch (err) {
      console.warn(`Failed to convert script ${s.path}:`, err);
    }
  }
  return map;
}

async function buildManifest(rrsMap: Map<string, string>, gallery?: unknown) {
  const manifest: any = {
    files: Array.from(rrsMap.keys()),
  };
  if (gallery !== undefined) manifest.gallery = gallery;
  return JSON.stringify(manifest, null, 2);
}

async function main() {
  try {
    const inZip = path.join(__dirname, "..", "..", "assets", "test.zip");
    const outZip = path.join(__dirname, "..", "..", "assets", "assets.zip");

    if (!fs.existsSync(inZip)) {
      console.error(`Input zip not found: ${inZip}`);
      process.exit(2);
    }

    console.log(`Reading ${inZip}...`);
    const buf = await fs.promises.readFile(inZip);
    const topBlob = new Blob([buf]);

    console.log(
      "Processing top-level ZIP (detecting game/ and scanning nested archives)...",
    );
    const result: ProcessResult = await processTopLevelZip(topBlob as any);

    console.log(`Detected gameDir: ${result.gameDir}`);
    console.log(
      `Collected ${result.scripts.length} scripts and ${result.media.length} media entries.`,
    );

    // Convert scripts to .rrs
    const rrsMap = await convertScripts(result.scripts as any);

    // Collect entries (all stored as STORE)
    // We'll use the project's zipWriter helpers to build a STORE-only ZIP.
    const {
      buildLocalHeader,
      buildDataDescriptor,
      buildCentralDirEntry,
      writeZipFooter,
      encodeUtf8,
      u8,
      writeU32,
      writeU16,
      writeU64,
      dosDateTime,
    } = await import("../../rpy-migrate-tool/converterFs/zipWriter");

    const { crc32Update } =
      await import("../../rpy-migrate-tool/converterFs/zipWriter");

    const chunks: Uint8Array[] = [];
    let archiveOffset = 0;
    const centralDir: any[] = [];
    const now = new Date();
    const { modTime, modDate } = dosDateTime(now);

    // Helper to append chunk
    function pushChunk(b: Uint8Array) {
      chunks.push(b);
      archiveOffset += b.length;
    }

    // Helper to compute CRC32 for a Uint8Array
    function crc32Of(bytes: Uint8Array): number {
      let crc = 0;
      // use crc32Update in chunks
      crc = crc32Update(crc, bytes);
      return crc;
    }

    // Helper to read blob as Uint8Array
    async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
      const ab = await blob.arrayBuffer();
      return new Uint8Array(ab);
    }

    // Helper to get uncompressed bytes for a zip-entry source (uses entryDataOffset and inflate when necessary)
    async function extractBytesFromZipSource(
      src: any,
    ): Promise<Uint8Array | null> {
      if (src.type !== "zip") return null;
      const fileBlob = src.file as Blob;
      const meta = src.entryMeta as any;
      const dataOffset = await entryDataOffset(fileBlob, meta);
      const slice = fileBlob.slice(
        dataOffset,
        dataOffset + meta.compressedSize,
      );
      let bytes = new Uint8Array(await slice.arrayBuffer());
      if (meta.method === 8) {
        // inflate deflate-raw in Node via zlib
        try {
          const zlib = await import("zlib");
          const inflated = zlib.inflateRawSync(Buffer.from(bytes));
          bytes = new Uint8Array(inflated);
        } catch (e) {
          // fallback: try browser DecompressionStream if available
          if (typeof DecompressionStream !== "undefined") {
            const ds = new DecompressionStream("deflate-raw");
            const decompressed = slice.stream().pipeThrough(ds);
            const arr = await readAllFromStream(
              decompressed as ReadableStream<Uint8Array>,
            );
            bytes = arr;
          } else {
            // as last resort keep raw bytes (may be compressed)
            // but prefer not to fail entire process
          }
        }
      }
      return bytes;
    }

    // Add media entries
    for (const m of result.media as any[]) {
      const zipPath = m.path;
      const nameBytes = encodeUtf8(zipPath);
      const localHeader = buildLocalHeader(nameBytes, 0, modTime, modDate);
      pushChunk(localHeader);
      const localHeaderOffset = archiveOffset - localHeader.length;

      // read bytes
      const bytes = await extractBytesFromZipSource(m.source);
      if (!bytes) {
        console.warn(`Skipping media ${zipPath} (could not extract)`);
        continue;
      }

      // write data
      pushChunk(u8(bytes));
      const crc = crc32Of(bytes);
      const written = bytes.length;
      const dataDesc = buildDataDescriptor(crc, written, written);
      pushChunk(dataDesc);

      centralDir.push({
        nameBytes,
        method: 0,
        modTime,
        modDate,
        crc,
        compressedSize: written,
        uncompressedSize: written,
        localHeaderOffset,
      } as any);
      console.log(`Added media: ${zipPath}`);
    }

    // Add scripts under data/
    for (const [rrsName, rrsContent] of rrsMap) {
      const zipPath = `data/${rrsName}`;
      const nameBytes = encodeUtf8(zipPath);
      const localHeader = buildLocalHeader(nameBytes, 0, modTime, modDate);
      pushChunk(localHeader);
      const localHeaderOffset = archiveOffset - localHeader.length;

      const contentBytes = new TextEncoder().encode(rrsContent);
      pushChunk(u8(contentBytes));
      const crc = crc32Of(contentBytes);
      const written = contentBytes.length;
      const dataDesc = buildDataDescriptor(crc, written, written);
      pushChunk(dataDesc);

      centralDir.push({
        nameBytes,
        method: 0,
        modTime,
        modDate,
        crc,
        compressedSize: written,
        uncompressedSize: written,
        localHeaderOffset,
      } as any);
      console.log(`Added script: ${zipPath}`);
    }

    // manifest.json
    const manifest = JSON.stringify(
      { files: Array.from(rrsMap.keys()) },
      null,
      2,
    );
    const manifestPath = "data/manifest.json";
    const nameBytes = encodeUtf8(manifestPath);
    const localHeader = buildLocalHeader(nameBytes, 0, modTime, modDate);
    pushChunk(localHeader);
    const localHeaderOffset = archiveOffset - localHeader.length;

    const manifestBytes = new TextEncoder().encode(manifest);
    pushChunk(u8(manifestBytes));
    const crc = crc32Of(manifestBytes);
    const written = manifestBytes.length;
    const dataDesc = buildDataDescriptor(crc, written, written);
    pushChunk(dataDesc);

    centralDir.push({
      nameBytes,
      method: 0,
      modTime,
      modDate,
      crc,
      compressedSize: written,
      uncompressedSize: written,
      localHeaderOffset,
    } as any);

    // Build central directory blobs using helper builder function and append
    const cdChunks: Uint8Array[] = [];
    let centralDirSize = 0;
    for (const e of centralDir) {
      const cdEntry = buildCentralDirEntry(e as any);
      cdChunks.push(cdEntry);
      centralDirSize += cdEntry.length;
    }

    // Append central dir, zip64 eocd etc using writeZipFooter helper that writes into chunks array
    // We'll write the central dir chunks, then EOCD built by writeZipFooter; writeZipFooter expects a writable
    // object with write(Uint8Array) method. Provide a small adapter that pushes into chunks and updates archiveOffset.
    const writableAdapter = {
      async write(b: Uint8Array) {
        pushChunk(b);
      },
      async close() {
        // no-op
      },
    } as unknown as FileSystemWritableFileStream;

    // write central dir + eocd using helper (it will append to our chunks via adapter)
    await writeZipFooter(writableAdapter, centralDir as any, archiveOffset);

    // Persist to disk as assets.zip
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const outBuf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      outBuf.set(c, off);
      off += c.length;
    }
    await fs.promises.writeFile(outZip, Buffer.from(outBuf.buffer));
    console.log(`Wrote assets ZIP: ${outZip}`);
    console.log("Done.");
  } catch (err) {
    console.error("Error during CLI test run:", err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
