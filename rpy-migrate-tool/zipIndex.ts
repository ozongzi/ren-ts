// Lightweight ZIP Central Directory parser for Blob/File objects.
// Provides minimal helpers needed by the migration tool:
//  - parseZipCentralDirectory(blob) => Map<path, ZipEntryMeta>
//  - entryDataOffset(blob, entry) => absolute byte offset where file data starts
//  - entryCompressedStream(blob, entry) => ReadableStream<Uint8Array> over the compressed bytes
//
// The implementation is intentionally small and follows the same Central
// Directory parsing approach used elsewhere in the project (ZIP32 + ZIP64).
//
// Notes:
//  - `file` can be a `File` or `Blob` (File extends Blob).
//  - The returned `ZipEntryMeta` values reflect fields from the Central Dir.
//  - Caller should handle decompression for DEFLATE entries if needed.

export interface ZipEntryMeta {
  name: string;
  method: number; // 0 = STORE, 8 = DEFLATE
  localHeaderOffset: number;
  compressedSize: number;
  uncompressedSize: number;
}

/**
 * Parse the Central Directory of a Blob (File) and return a Map of path -> meta.
 * Throws on invalid / unsupported ZIP structures.
 */
export async function parseZipCentralDirectory(file: Blob): Promise<Map<string, ZipEntryMeta>> {
  const ZIP32_SENTINEL = 0xffffffff;

  // Blob has `size` in the DOM spec.
  const fileSize = (file as any).size as number;
  const searchSize = Math.min(fileSize, 65_558); // EOCD + max comment
  const searchStart = fileSize - searchSize;
  const searchSlice = file.slice(searchStart);
  const searchBuf = new Uint8Array(await searchSlice.arrayBuffer());

  // Find EOCD32 signature (0x06054b50) scanning backwards.
  let eocd32RelOffset = -1;
  for (let i = searchBuf.length - 22; i >= 0; i--) {
    if (
      searchBuf[i] === 0x50 &&
      searchBuf[i + 1] === 0x4b &&
      searchBuf[i + 2] === 0x05 &&
      searchBuf[i + 3] === 0x06
    ) {
      eocd32RelOffset = i;
      break;
    }
  }
  if (eocd32RelOffset === -1) {
    throw new Error("Could not find End of Central Directory record — not a ZIP?");
  }

  const eocd32 = new DataView(searchBuf.buffer, eocd32RelOffset);
  const cdSize32 = eocd32.getUint32(12, true);
  const cdOffset32 = eocd32.getUint32(16, true);

  let cdOffset: number;
  let cdSize: number;

  // Handle ZIP64 case where cdOffset or cdSize is 0xFFFFFFFF
  if (cdOffset32 === ZIP32_SENTINEL || cdSize32 === ZIP32_SENTINEL) {
    const locatorAbsOffset = searchStart + eocd32RelOffset - 20;
    if (locatorAbsOffset < 0) throw new Error("ZIP64 locator not found (file too small)");

    const locatorSlice = file.slice(locatorAbsOffset, locatorAbsOffset + 20);
    const locator = new DataView(await locatorSlice.arrayBuffer());
    if (locator.getUint32(0, true) !== 0x07064b50) throw new Error("Bad ZIP64 EOCD locator signature");

    // Locator offset 8 is an 8-byte absolute offset to the ZIP64 EOCD record.
    const zip64EocdOffset = Number(locator.getBigUint64(8, true));
    const zip64EocdSlice = file.slice(zip64EocdOffset, zip64EocdOffset + 56);
    const zip64Eocd = new DataView(await zip64EocdSlice.arrayBuffer());
    if (zip64Eocd.getUint32(0, true) !== 0x06064b50) throw new Error("Bad ZIP64 EOCD signature");

    // ZIP64 EOCD: offset 40 = size of central dir, offset 48 = central dir offset
    cdSize = Number(zip64Eocd.getBigUint64(40, true));
    cdOffset = Number(zip64Eocd.getBigUint64(48, true));
  } else {
    cdOffset = cdOffset32;
    cdSize = cdSize32;
  }

  // Read the central directory blob
  const cdSlice = file.slice(cdOffset, cdOffset + cdSize);
  const cdAb = await cdSlice.arrayBuffer();
  if (cdAb.byteLength !== cdSize) {
    throw new Error("Central Directory read truncated (possible platform file-size limit)");
  }
  const cdBuf = new DataView(cdAb);
  let pos = 0;
  const result = new Map<string, ZipEntryMeta>();

  while (pos + 46 <= cdBuf.byteLength) {
    const sig = cdBuf.getUint32(pos, true);
    if (sig !== 0x02014b50) break; // central dir file header signature

    const method = cdBuf.getUint16(pos + 10, true);
    let compressedSize = cdBuf.getUint32(pos + 20, true);
    let uncompressedSize = cdBuf.getUint32(pos + 24, true);
    const fnLen = cdBuf.getUint16(pos + 28, true);
    const extraLen = cdBuf.getUint16(pos + 30, true);
    const commentLen = cdBuf.getUint16(pos + 32, true);
    let localHeaderOffset = cdBuf.getUint32(pos + 42, true);

    // If any of the size/offset fields are the 32-bit sentinel, read ZIP64 extra.
    if (
      uncompressedSize === ZIP32_SENTINEL ||
      compressedSize === ZIP32_SENTINEL ||
      localHeaderOffset === ZIP32_SENTINEL
    ) {
      const extraStart = pos + 46 + fnLen;
      const extraEnd = extraStart + extraLen;
      let ep = extraStart;
      while (ep + 4 <= extraEnd) {
        const headerId = cdBuf.getUint16(ep, true);
        const headerSize = cdBuf.getUint16(ep + 2, true);
        if (headerId === 0x0001) {
          // ZIP64 extra — fields appear in order: uncompressedSize (8), compressedSize (8), localHeaderOffset (8)
          let fp = ep + 4;
          if (uncompressedSize === ZIP32_SENTINEL && fp + 8 <= ep + 4 + headerSize) {
            uncompressedSize = Number(cdBuf.getBigUint64(fp, true));
            fp += 8;
          }
          if (compressedSize === ZIP32_SENTINEL && fp + 8 <= ep + 4 + headerSize) {
            compressedSize = Number(cdBuf.getBigUint64(fp, true));
            fp += 8;
          }
          if (localHeaderOffset === ZIP32_SENTINEL && fp + 8 <= ep + 4 + headerSize) {
            localHeaderOffset = Number(cdBuf.getBigUint64(fp, true));
            fp += 8;
          }
          break;
        }
        ep += 4 + headerSize;
      }
    }

    const nameBytes = new Uint8Array(cdBuf.buffer, cdBuf.byteOffset + pos + 46, fnLen);
    const name = new TextDecoder("utf-8").decode(nameBytes);

    // Skip directory entries (names ending with '/')
    if (!name.endsWith("/") && name !== "") {
      result.set(name, {
        name,
        method,
        localHeaderOffset,
        compressedSize,
        uncompressedSize,
      });
    }

    pos += 46 + fnLen + extraLen + commentLen;
  }

  if (result.size === 0) {
    throw new Error("Central Directory parsed but no file entries found. ZIP may be empty or corrupt.");
  }

  return result;
}

/**
 * Read the Local File Header and return the absolute offset where file data starts.
 * This handles variable-length filename + extra fields in the local header.
 */
export async function entryDataOffset(file: Blob, entry: ZipEntryMeta): Promise<number> {
  // Read the fixed 30-byte portion of the local header first.
  const headerSlice = file.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30);
  const headerAb = await headerSlice.arrayBuffer();
  if (headerAb.byteLength < 30) throw new Error("Failed to read local file header");
  const header = new DataView(headerAb);

  const sig = header.getUint32(0, true);
  if (sig !== 0x04034b50) throw new Error("Bad local file header signature");

  const fnLen = header.getUint16(26, true);
  const extraLen = header.getUint16(28, true);
  return entry.localHeaderOffset + 30 + fnLen + extraLen;
}

/**
 * Return a ReadableStream<Uint8Array> for the compressed bytes of an entry.
 * The stream covers exactly `compressedSize` bytes starting at the data offset.
 */
export async function entryCompressedStream(file: Blob, entry: ZipEntryMeta): Promise<ReadableStream<Uint8Array>> {
  const dataOffset = await entryDataOffset(file, entry);
  const slice = file.slice(dataOffset, dataOffset + entry.compressedSize);
  // Blob.stream gives ReadableStream<Uint8Array>
  return slice.stream() as ReadableStream<Uint8Array>;
}
