// ─── Streaming ZIP writer — browser-side utilities ────────────────────────────
//
// Implements the minimal ZIP32/ZIP64 subset needed to stream an archive
// directly into a FileSystemWritableFileStream opened via showSaveFilePicker().
//
// Memory profile: one ~64 KiB pipe buffer per in-flight file entry.
// No full-file or full-archive accumulation at any point.
//
// ZIP format reference: PKWARE APPNOTE.TXT §4
// Structures implemented:
//   Local File Header       (4.3.7)   — 30 + filename bytes
//   File data               (4.3.8)   — raw or deflate-compressed
//   Data Descriptor         (4.3.9)   — crc32 + sizes (written after data)
//   Central Directory       (4.3.12)  — one record per entry
//   ZIP64 EOCD              (4.3.14)  — when archive > 4 GiB or > 65535 entries
//   ZIP64 EOCD Locator      (4.3.15)
//   End of Central Directory(4.3.16)
//
// All multi-byte integers are little-endian.
//
// We use Data Descriptors (General Purpose Bit Flag bit 3) so that CRC-32 and
// compressed size are written AFTER the file data — this allows streaming
// without seeking, which is required for FileSystemWritableFileStream.
//
// Compression policy:
//   Text-like formats (.rrs, .json, .txt, …)  → DEFLATE via CompressionStream
//   Everything else (images, audio, video, …)  → STORE (method 0)

// ─── ZIP format constants ─────────────────────────────────────────────────────

export const ZIP_LOCAL_HEADER_SIG    = 0x04034b50;
export const ZIP_DATA_DESCRIPTOR_SIG = 0x08074b50;
export const ZIP_CENTRAL_DIR_SIG     = 0x02014b50;
export const ZIP_EOCD_SIG            = 0x06054b50;
export const ZIP64_EOCD_SIG          = 0x06064b50;
export const ZIP64_EOCD_LOCATOR_SIG  = 0x07064b50;
export const ZIP64_EXTRA_ID          = 0x0001;

/** Sentinel / maximum value for 32-bit ZIP fields. */
export const ZIP32_MAX = 0xffffffff;

export const ZIP_VERSION_NEEDED_STORE   = 10; // 1.0
export const ZIP_VERSION_NEEDED_DEFLATE = 20; // 2.0
export const ZIP_VERSION_NEEDED_ZIP64   = 45; // 4.5 — required when ZIP64 fields present
export const ZIP_VERSION_MADE_BY        = 0x031e; // UNIX, spec version 3.0
export const ZIP_FLAG_DATA_DESCRIPTOR   = 1 << 3;
export const ZIP_METHOD_STORE           = 0;
export const ZIP_METHOD_DEFLATE         = 8;

// ─── Compression policy ───────────────────────────────────────────────────────

/** Returns true for file types that benefit from DEFLATE compression. */
export function shouldDeflate(zipPath: string): boolean {
  const ext = zipPath.split(".").pop()?.toLowerCase() ?? "";
  return ["rrs", "json", "txt", "xml", "html", "css", "js", "svg"].includes(ext);
}

// ─── Little-endian binary helpers ─────────────────────────────────────────────

const _enc = new TextEncoder();

/** Encode a string to UTF-8 bytes. */
export function encodeUtf8(s: string): Uint8Array {
  return _enc.encode(s);
}

/** Write a little-endian 16-bit value into `buf` at `offset`. */
export function writeU16(buf: DataView, offset: number, value: number): void {
  buf.setUint16(offset, value, true);
}

/** Write a little-endian 32-bit value into `buf` at `offset`. */
export function writeU32(buf: DataView, offset: number, value: number): void {
  buf.setUint32(offset, value, true);
}

/**
 * Write a 64-bit unsigned integer (little-endian) into a DataView.
 *
 * JS numbers are safe up to 2^53.  ZIP64 fields can reach 2^64 in theory but
 * in practice archive offsets/sizes stay well below Number.MAX_SAFE_INTEGER for
 * any realistic game asset bundle.
 */
export function writeU64(dv: DataView, offset: number, value: number): void {
  dv.setUint32(offset,     value >>> 0,                             true); // low 32
  dv.setUint32(offset + 4, Math.floor(value / 0x100000000) >>> 0,   true); // high 32
}

// ─── CRC-32 ───────────────────────────────────────────────────────────────────

/** CRC-32 table (standard ZIP polynomial 0xEDB88320), computed once at load. */
export const CRC32_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c;
  }
  return t;
})();

/** Update a running CRC-32 accumulator with `data`. */
export function crc32Update(crc: number, data: Uint8Array): number {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return c ^ 0xffffffff;
}

/**
 * Narrow a Uint8Array to `Uint8Array<ArrayBuffer>` so TypeScript's strict DOM
 * types accept it as `FileSystemWriteChunkType`.
 *
 * At runtime this is a no-op: every Uint8Array produced from File/stream data
 * is already backed by a plain ArrayBuffer.
 */
export function u8(data: Uint8Array): Uint8Array<ArrayBuffer> {
  return data as unknown as Uint8Array<ArrayBuffer>;
}

/**
 * Drain an async readable stream, accumulating CRC-32 and byte count while
 * passing each chunk to `sink`.
 */
export async function crc32Stream(
  readable: ReadableStream<Uint8Array>,
  sink: (chunk: Uint8Array) => Promise<void>,
): Promise<{ crc: number; size: number }> {
  const reader = readable.getReader();
  let crc  = 0;
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      crc   = crc32Update(crc, value);
      size += value.length;
      await sink(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { crc, size };
}

// ─── DOS date/time ────────────────────────────────────────────────────────────

/** Encode a JS Date into the MS-DOS date/time fields used by the ZIP format. */
export function dosDateTime(d: Date): { modTime: number; modDate: number } {
  const modTime =
    (d.getHours() << 11) |
    (d.getMinutes() << 5) |
    Math.floor(d.getSeconds() / 2);
  const modDate =
    (Math.max(0, d.getFullYear() - 1980) << 9) |
    ((d.getMonth() + 1) << 5) |
    d.getDate();
  return { modTime, modDate };
}

// ─── Central directory entry (in-memory record) ───────────────────────────────

/** Metadata accumulated for each file while writing its local header + data. */
export interface CentralDirEntry {
  nameBytes:          Uint8Array;
  method:             number;
  modTime:            number;
  modDate:            number;
  crc:                number;
  compressedSize:     number;
  uncompressedSize:   number;
  localHeaderOffset:  number;
}

// ─── Header / record builders ─────────────────────────────────────────────────

/**
 * Build a Local File Header (30 + filename bytes).
 *
 * CRC-32, compressed size, and uncompressed size are all zeroed because we
 * write a Data Descriptor immediately after the file data (bit 3 of the
 * General Purpose Bit Flag is set).  This removes the need to seek back.
 */
export function buildLocalHeader(
  nameBytes: Uint8Array,
  method:    number,
  modTime:   number,
  modDate:   number,
): Uint8Array {
  const buf = new ArrayBuffer(30 + nameBytes.length);
  const dv  = new DataView(buf);
  writeU32(dv,  0, ZIP_LOCAL_HEADER_SIG);
  writeU16(dv,  4, method === ZIP_METHOD_DEFLATE
    ? ZIP_VERSION_NEEDED_DEFLATE
    : ZIP_VERSION_NEEDED_STORE);
  writeU16(dv,  6, ZIP_FLAG_DATA_DESCRIPTOR);
  writeU16(dv,  8, method);
  writeU16(dv, 10, modTime);
  writeU16(dv, 12, modDate);
  // CRC-32, compressed size, uncompressed size — all zeroed (live in descriptor)
  writeU32(dv, 14, 0);
  writeU32(dv, 18, 0);
  writeU32(dv, 22, 0);
  writeU16(dv, 26, nameBytes.length);
  writeU16(dv, 28, 0); // extra field length
  new Uint8Array(buf, 30).set(nameBytes);
  return new Uint8Array(buf);
}

/**
 * Build a Data Descriptor (16 bytes, with signature).
 * Written immediately after each entry's (possibly compressed) file data.
 */
export function buildDataDescriptor(
  crc:              number,
  compressedSize:   number,
  uncompressedSize: number,
): Uint8Array {
  const buf = new ArrayBuffer(16);
  const dv  = new DataView(buf);
  writeU32(dv,  0, ZIP_DATA_DESCRIPTOR_SIG);
  writeU32(dv,  4, crc);
  writeU32(dv,  8, compressedSize);
  writeU32(dv, 12, uncompressedSize);
  return new Uint8Array(buf);
}

/**
 * Build a Central Directory File Header (46 + filename bytes, with an optional
 * ZIP64 extra field when the local header offset does not fit in 32 bits).
 */
export function buildCentralDirEntry(e: CentralDirEntry): Uint8Array {
  // A ZIP64 extra field is needed only when the local header offset >= 4 GiB.
  // The sizes in the Data Descriptor are stored as 32-bit values in this
  // implementation, and individual files are always < 4 GiB.
  const needsZip64Offset = e.localHeaderOffset > ZIP32_MAX;
  // ZIP64 extra field layout: 2-byte id + 2-byte data-size + 8-byte offset = 12 bytes
  const zip64ExtraLen    = needsZip64Offset ? 12 : 0;

  const buf = new ArrayBuffer(46 + e.nameBytes.length + zip64ExtraLen);
  const dv  = new DataView(buf);

  writeU32(dv,  0, ZIP_CENTRAL_DIR_SIG);
  writeU16(dv,  4, ZIP_VERSION_MADE_BY);
  writeU16(dv,  6, needsZip64Offset
    ? ZIP_VERSION_NEEDED_ZIP64
    : e.method === ZIP_METHOD_DEFLATE
      ? ZIP_VERSION_NEEDED_DEFLATE
      : ZIP_VERSION_NEEDED_STORE);
  writeU16(dv,  8, ZIP_FLAG_DATA_DESCRIPTOR);
  writeU16(dv, 10, e.method);
  writeU16(dv, 12, e.modTime);
  writeU16(dv, 14, e.modDate);
  writeU32(dv, 16, e.crc);
  writeU32(dv, 20, e.compressedSize);
  writeU32(dv, 24, e.uncompressedSize);
  writeU16(dv, 28, e.nameBytes.length);
  writeU16(dv, 30, zip64ExtraLen);   // extra field length
  writeU16(dv, 32, 0);               // file comment length
  writeU16(dv, 34, 0);               // disk number start
  writeU16(dv, 36, 0);               // internal file attributes
  writeU32(dv, 38, 0);               // external file attributes
  // Local header offset: set to sentinel 0xFFFFFFFF when stored in ZIP64 extra
  writeU32(dv, 42, needsZip64Offset ? ZIP32_MAX : e.localHeaderOffset);
  new Uint8Array(buf, 46).set(e.nameBytes);

  if (needsZip64Offset) {
    const xBase = 46 + e.nameBytes.length;
    writeU16(dv, xBase,     ZIP64_EXTRA_ID); // header id = 0x0001
    writeU16(dv, xBase + 2, 8);              // data size  = 8 bytes (one u64)
    writeU64(dv, xBase + 4, e.localHeaderOffset);
  }

  return new Uint8Array(buf);
}

/**
 * Build a ZIP64 End of Central Directory record (56 bytes).
 * Written before the ZIP64 EOCD Locator and the EOCD32 record.
 */
export function buildZip64Eocd(
  entryCount:       number,
  centralDirSize:   number,
  centralDirOffset: number,
): Uint8Array {
  const buf = new ArrayBuffer(56);
  const dv  = new DataView(buf);
  writeU32(dv,  0, ZIP64_EOCD_SIG);
  writeU64(dv,  4, 44);              // size of remaining ZIP64 EOCD record (56 − 12)
  writeU16(dv, 12, ZIP_VERSION_MADE_BY);
  writeU16(dv, 14, ZIP_VERSION_NEEDED_ZIP64);
  writeU32(dv, 16, 0);               // number of this disk
  writeU32(dv, 20, 0);               // disk where central directory starts
  writeU64(dv, 24, entryCount);      // entries on this disk
  writeU64(dv, 32, entryCount);      // total entries across all disks
  writeU64(dv, 40, centralDirSize);
  writeU64(dv, 48, centralDirOffset);
  return new Uint8Array(buf);
}

/**
 * Build a ZIP64 End of Central Directory Locator (20 bytes).
 * Must be written immediately before the EOCD32 record.
 */
export function buildZip64EocdLocator(zip64EocdOffset: number): Uint8Array {
  const buf = new ArrayBuffer(20);
  const dv  = new DataView(buf);
  writeU32(dv,  0, ZIP64_EOCD_LOCATOR_SIG);
  writeU32(dv,  4, 0);               // disk containing ZIP64 EOCD
  writeU64(dv,  8, zip64EocdOffset); // absolute byte offset of ZIP64 EOCD
  writeU32(dv, 16, 1);               // total number of disks
  return new Uint8Array(buf);
}

/**
 * Build the (ZIP32-compatible) End of Central Directory record (22 bytes).
 *
 * When the archive exceeds ZIP32 limits the fields that cannot represent the
 * true value are clamped to their respective sentinel values (0xFFFF or
 * 0xFFFFFFFF).  The real values live in the ZIP64 EOCD record.
 */
export function buildEocd(
  entryCount:       number,
  centralDirSize:   number,
  centralDirOffset: number,
): Uint8Array {
  const clamp      = (v: number) => (v > ZIP32_MAX ? ZIP32_MAX : v);
  const clampCount = (v: number) => (v > 0xffff    ? 0xffff    : v);

  const buf = new ArrayBuffer(22);
  const dv  = new DataView(buf);
  writeU32(dv,  0, ZIP_EOCD_SIG);
  writeU16(dv,  4, 0);                          // disk number
  writeU16(dv,  6, 0);                          // disk with central directory
  writeU16(dv,  8, clampCount(entryCount));
  writeU16(dv, 10, clampCount(entryCount));
  writeU32(dv, 12, clamp(centralDirSize));
  writeU32(dv, 16, clamp(centralDirOffset));
  writeU16(dv, 20, 0);                          // comment length
  return new Uint8Array(buf);
}

// ─── High-level streaming helper ─────────────────────────────────────────────

/**
 * Compress a single `ReadableStream<Uint8Array>` through the browser's built-in
 * `CompressionStream("deflate-raw")` and write the compressed bytes to `writable`,
 * while simultaneously computing the CRC-32 of the *uncompressed* data.
 *
 * Returns `{ crc, uncompressedSize, compressedSize }`.
 *
 * Uses `tee()` so the CRC accumulation and the compression pipeline run in
 * parallel — only a single pass over the source data is required.
 */
export async function deflateStream(
  rawStream: ReadableStream<Uint8Array>,
  writable:  FileSystemWritableFileStream,
  onBytesWritten: (n: number) => void,
): Promise<{ crc: number; uncompressedSize: number; compressedSize: number }> {
  const [branchA, branchB] = rawStream.tee();

  // Branch A: accumulate CRC-32 over the raw (uncompressed) bytes.
  const crcPromise = crc32Stream(branchA, async () => {});

  // Branch B: compress and write to the writable stream.
  const compressedPromise = (async () => {
    const compStream = new CompressionStream(
      "deflate-raw",
    ) as unknown as TransformStream<Uint8Array, Uint8Array>;
    const compressed = branchB.pipeThrough(compStream);
    const reader     = compressed.getReader();
    let   compBytes  = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(u8(value));
        compBytes        += value.length;
        onBytesWritten(value.length);
      }
    } finally {
      reader.releaseLock();
    }
    return compBytes;
  })();

  const [{ crc, size: uncompressedSize }, compressedSize] = await Promise.all([
    crcPromise,
    compressedPromise,
  ]);

  return { crc, uncompressedSize, compressedSize };
}

/**
 * Write the final sections of the ZIP archive to `writable`:
 *   Central Directory entries → optional ZIP64 EOCD + Locator → EOCD32
 *
 * Returns the total number of bytes written (so callers can close the writable
 * cleanly without needing to track it themselves).
 */
export async function writeZipFooter(
  writable:    FileSystemWritableFileStream,
  centralDir:  CentralDirEntry[],
  archiveOffset: number,
): Promise<void> {
  const centralDirOffset = archiveOffset;
  let   centralDirSize   = 0;

  for (const entry of centralDir) {
    const cdEntry = buildCentralDirEntry(entry);
    await writable.write(u8(cdEntry));
    centralDirSize += cdEntry.length;
  }

  // Write ZIP64 EOCD + Locator when the archive exceeds ZIP32 limits.
  // Common cases: centralDirOffset >= 4 GiB (large asset bundles) or
  // entry count > 65535 (many small files).
  const needsZip64 =
    centralDirOffset > ZIP32_MAX ||
    centralDirSize   > ZIP32_MAX ||
    centralDir.length > 0xffff;

  if (needsZip64) {
    const zip64EocdOffset = centralDirOffset + centralDirSize;
    const zip64Eocd       = buildZip64Eocd(centralDir.length, centralDirSize, centralDirOffset);
    await writable.write(u8(zip64Eocd));
    const zip64Locator    = buildZip64EocdLocator(zip64EocdOffset);
    await writable.write(u8(zip64Locator));
  }

  const eocd = buildEocd(centralDir.length, centralDirSize, centralDirOffset);
  await writable.write(u8(eocd));
}
