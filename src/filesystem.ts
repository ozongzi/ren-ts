// ─── Virtual File System abstraction ─────────────────────────────────────────
//
// All game asset / script access goes through an IFileSystem instance so that
// the loader and asset resolver never care whether files come from:
//
//   ZipFS      — a user-selected assets.zip (Tauri desktop/mobile, Web)
//   WebFetchFS — a static HTTP server (self-hosted Web deployments)
//
// The active filesystem is a module-level singleton set once at startup via
// mountFilesystem().  Everything else imports { fs } and calls it directly.
//
// ZIP format notes:
//   - Central Directory lives at the end of the file; we only read it once.
//   - Files stored with compression method 0 (STORE) are read via File.slice()
//     with zero decompression overhead — use this for images / audio / video.
//   - Files stored with compression method 8 (DEFLATE) are decompressed on
//     demand via DecompressionStream — use this for .rrs / .json text files.
//   - Blob URLs created for binary assets are cached for the lifetime of the
//     session; they are revoked on unmount to avoid leaking object URLs.

// ─── Interface ────────────────────────────────────────────────────────────────

export interface IFileSystem {
  /**
   * Read a file as a UTF-8 string.
   * Path is relative to the package root, e.g. "data/manifest.json".
   */
  readText(path: string): Promise<string>;

  /**
   * Read a file as raw bytes.
   */
  readBytes(path: string): Promise<Uint8Array>;

  /**
   * Return a URL that can be set directly on <img src> or <audio src>.
   *
   * For ZipFS this is a Blob URL created once and cached.
   * For WebFetchFS this is a plain /assets/... path.
   */
  resolveUrl(path: string): Promise<string>;

  /**
   * Return true if the given path exists in this filesystem.
   */
  exists(path: string): Promise<boolean>;
}

// ─── Module-level singleton ───────────────────────────────────────────────────

let _fs: IFileSystem | null = null;

/**
 * Mount a filesystem implementation.  Must be called once before any game
 * content is loaded (i.e. before assetsSlice.init() triggers loadAll()).
 */
export function mountFilesystem(impl: IFileSystem): void {
  _fs = impl;
}

/**
 * The active filesystem.  Throws if mountFilesystem() has not been called.
 */
export function getFs(): IFileSystem {
  if (!_fs)
    throw new Error(
      "[filesystem] No filesystem mounted. Call mountFilesystem() first.",
    );
  return _fs;
}

/**
 * True once a filesystem has been mounted.
 */
export function hasFilesystem(): boolean {
  return _fs !== null;
}

/**
 * Unmount the current filesystem and revoke any cached Blob URLs.
 * Call this when the user wants to load a different zip.
 */
export function unmountFilesystem(): void {
  if (_fs instanceof ZipFS) {
    _fs.dispose();
  }
  _fs = null;
}

// ─── ZipFS ────────────────────────────────────────────────────────────────────
//
// Reads files from a local .zip File object without extracting it to disk.
// Supports both ZIP32 and ZIP64 archives (required for archives > 4 GB, which
// is common for game assets).
//
// ZIP structure:
//
//   [Local file entries …]
//   [Central Directory entries …]  ← only this is read on mount
//   [ZIP64 End of Central Directory record]   (present when archive > 4 GB)
//   [ZIP64 End of Central Directory locator]  (present when archive > 4 GB)
//   [End of Central Directory record (EOCD32)]
//
// Central Directory entry layout (offsets from entry start):
//   0  signature           4 bytes  0x02014b50
//   10 compression         2 bytes  0=STORE, 8=DEFLATE
//   20 compressed size     4 bytes  (0xFFFFFFFF → see ZIP64 extra field)
//   24 uncompressed size   4 bytes  (0xFFFFFFFF → see ZIP64 extra field)
//   28 file name length    2 bytes
//   30 extra field length  2 bytes
//   32 file comment length 2 bytes
//   42 local header offset 4 bytes  (0xFFFFFFFF → see ZIP64 extra field)
//   46 file name           (variable)
//   46+fnLen extra fields  (variable; ZIP64 extension has id=0x0001)
//
// ZIP64 extra field layout (inside CD extra, id=0x0001):
//   0  header id    2 bytes  0x0001
//   2  data size    2 bytes
//   4  fields present in the order: uncompressedSize(8), compressedSize(8),
//      localHeaderOffset(8) — only those whose CD field equals 0xFFFFFFFF
//
// Local file header layout (offsets from local header start):
//   0  signature  4 bytes  0x04034b50
//   26 file name length  2 bytes
//   28 extra field length 2 bytes
//   30 file name (variable)
//   30+fnLen+extLen  file data starts here

interface ZipEntry {
  /** Compression method: 0 = STORE, 8 = DEFLATE */
  method: number;
  /** Byte offset of the Local File Header within the zip File */
  localHeaderOffset: number;
  /** Compressed size in bytes */
  compressedSize: number;
  /** Uncompressed size in bytes */
  uncompressedSize: number;
}

// Sentinel value in ZIP32 fields indicating the real value is in a ZIP64 extra field.
const ZIP32_SENTINEL = 0xffffffff;

export class ZipFS implements IFileSystem {
  private readonly file: File;
  /** path → entry metadata */
  private readonly index: Map<string, ZipEntry> = new Map();
  /** path → cached Blob URL (for binary assets) */
  private readonly blobCache: Map<string, string> = new Map();

  private constructor(file: File) {
    this.file = file;
  }

  // ── Factory ──────────────────────────────────────────────────────────────────

  /**
   * Parse the Central Directory and build the path index.
   * This is the only time we read the end of the file; all subsequent reads
   * use byte-range slices.
   */
  static async mount(file: File): Promise<ZipFS> {
    const instance = new ZipFS(file);
    await instance._buildIndex();
    return instance;
  }

  // ── IFileSystem impl ─────────────────────────────────────────────────────────

  async readText(path: string): Promise<string> {
    const bytes = await this.readBytes(path);
    return new TextDecoder("utf-8").decode(bytes);
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const entry = this._resolve(path);
    const dataOffset = await this._dataOffset(entry);
    const slice = this.file.slice(
      dataOffset,
      dataOffset + entry.compressedSize,
    );
    const raw = new Uint8Array(await slice.arrayBuffer());

    if (entry.method === 0) {
      // STORE — no decompression needed
      return raw;
    }

    if (entry.method === 8) {
      // DEFLATE — use DecompressionStream (available in all modern browsers)
      return await this._inflate(raw);
    }

    throw new Error(
      `[ZipFS] Unsupported compression method ${entry.method} for "${path}"`,
    );
  }

  async resolveUrl(path: string): Promise<string> {
    const cached = this.blobCache.get(path);
    if (cached) return cached;

    const bytes = await this.readBytes(path);
    const mime = guessMime(path);
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mime });
    const url = URL.createObjectURL(blob);
    this.blobCache.set(path, url);
    return url;
  }

  async exists(path: string): Promise<boolean> {
    return this.index.has(normalisePath(path));
  }

  /**
   * Revoke all cached Blob URLs and clear internal state.
   * Call this before mounting a new zip.
   */
  dispose(): void {
    for (const url of this.blobCache.values()) {
      URL.revokeObjectURL(url);
    }
    this.blobCache.clear();
    this.index.clear();
  }

  // ── Internal helpers ─────────────────────────────────────────────────────────

  private _resolve(path: string): ZipEntry {
    const key = normalisePath(path);
    const entry = this.index.get(key);
    if (!entry) throw new Error(`[ZipFS] File not found in zip: "${path}"`);
    return entry;
  }

  /**
   * Read the Local File Header to find where the actual compressed data starts.
   * The local header has variable-length filename + extra fields that may
   * differ from the Central Directory, so we must read them fresh each time.
   *
   * Local header layout:
   *   0  signature        4 bytes  (0x04034b50)
   *   4  version needed   2 bytes
   *   6  general flags    2 bytes
   *   8  compression      2 bytes
   *   10 mod time         2 bytes
   *   12 mod date         2 bytes
   *   14 crc-32           4 bytes
   *   18 compressed sz    4 bytes
   *   22 uncompressed sz  4 bytes
   *   26 filename len     2 bytes
   *   28 extra field len  2 bytes
   *   30 filename         (variable)
   *   30+fnLen extra      (variable)
   *   data starts here
   */
  private async _dataOffset(entry: ZipEntry): Promise<number> {
    const headerSlice = this.file.slice(
      entry.localHeaderOffset,
      entry.localHeaderOffset + 30,
    );
    const header = new DataView(await headerSlice.arrayBuffer());

    const sig = header.getUint32(0, true);
    if (sig !== 0x04034b50) {
      throw new Error(
        `[ZipFS] Bad local file header signature at offset ${entry.localHeaderOffset}`,
      );
    }

    const fnLen = header.getUint16(26, true);
    const extraLen = header.getUint16(28, true);
    return entry.localHeaderOffset + 30 + fnLen + extraLen;
  }

  /**
   * Decompress raw DEFLATE bytes (without zlib/gzip wrapper).
   * DecompressionStream in browsers expects "deflate-raw" format, which is
   * exactly what ZIP stores.
   */
  private async _inflate(compressed: Uint8Array): Promise<Uint8Array> {
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();

    writer.write(compressed as unknown as Uint8Array<ArrayBuffer>);
    writer.close();

    const chunks: Uint8Array[] = [];
    let totalLen = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLen += value.length;
    }

    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  /**
   * Parse the ZIP Central Directory (ZIP32 and ZIP64).
   *
   * Algorithm:
   *   1. Read the last 65_558 bytes of the file and scan backward for the
   *      EOCD32 signature (0x06054b50).
   *   2. If EOCD32 cdOffset/cdSize fields are 0xFFFFFFFF (ZIP64 sentinel),
   *      locate the ZIP64 EOCD locator (0x07064b50) just before EOCD32, then
   *      read the ZIP64 EOCD record (0x06064b50) for the real 64-bit values.
   *   3. Slice the Central Directory and walk its entries.
   *   4. For each CD entry whose size/offset fields are 0xFFFFFFFF, parse the
   *      ZIP64 extra field (id=0x0001) to get the real 64-bit values.
   */
  private async _buildIndex(): Promise<void> {
    const fileSize = this.file.size;

    // ── Step 1: Find EOCD32 ───────────────────────────────────────────────────
    // Max search range: 65535-byte comment + 22-byte EOCD = 65557 bytes.
    const searchSize = Math.min(fileSize, 65_558);
    const searchStart = fileSize - searchSize; // absolute offset in file
    const searchSlice = this.file.slice(searchStart);
    const searchBuf = new Uint8Array(await searchSlice.arrayBuffer());

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
      throw new Error(
        "[ZipFS] Could not find End of Central Directory record. Is this a valid ZIP file?",
      );
    }

    const eocd32 = new DataView(searchBuf.buffer, eocd32RelOffset);
    const cdSize32 = eocd32.getUint32(12, true);
    const cdOffset32 = eocd32.getUint32(16, true);

    // ── Step 2: ZIP64 EOCD (when EOCD32 fields are sentinel 0xFFFFFFFF) ───────
    // When either cdOffset or cdSize is the ZIP32 sentinel, the real values
    // are stored in the ZIP64 EOCD record, pointed to by the ZIP64 locator
    // that sits immediately before the EOCD32 in the file.
    let cdOffset: number;
    let cdSize: number;

    if (cdOffset32 === ZIP32_SENTINEL || cdSize32 === ZIP32_SENTINEL) {
      // ZIP64 EOCD locator is 20 bytes, sits just before EOCD32.
      // Absolute offset of locator = searchStart + eocd32RelOffset - 20
      const locatorAbsOffset = searchStart + eocd32RelOffset - 20;
      if (locatorAbsOffset < 0) {
        throw new Error(
          "[ZipFS] ZIP64 EOCD locator not found (file too small).",
        );
      }
      const locatorSlice = this.file.slice(
        locatorAbsOffset,
        locatorAbsOffset + 20,
      );
      const locator = new DataView(await locatorSlice.arrayBuffer());
      if (locator.getUint32(0, true) !== 0x07064b50) {
        throw new Error(
          "[ZipFS] Expected ZIP64 EOCD locator signature (0x07064b50).",
        );
      }

      // Locator offset 8: 8-byte absolute offset of the ZIP64 EOCD record.
      // JS numbers lose precision above 2^53; use BigInt then convert safely.
      const zip64EocdOffsetBig = locator.getBigUint64(8, true);
      // ZIP64 EOCD record is at least 56 bytes.
      const zip64EocdOffset = Number(zip64EocdOffsetBig);
      const zip64EocdSlice = this.file.slice(
        zip64EocdOffset,
        zip64EocdOffset + 56,
      );
      const zip64Eocd = new DataView(await zip64EocdSlice.arrayBuffer());
      if (zip64Eocd.getUint32(0, true) !== 0x06064b50) {
        throw new Error("[ZipFS] Expected ZIP64 EOCD signature (0x06064b50).");
      }

      // ZIP64 EOCD offset 48: 8-byte CD offset; offset 40: 8-byte CD size.
      cdOffset = Number(zip64Eocd.getBigUint64(48, true));
      cdSize = Number(zip64Eocd.getBigUint64(40, true));
    } else {
      cdOffset = cdOffset32;
      cdSize = cdSize32;
    }

    // ── Step 3: Read and walk the Central Directory ───────────────────────────
    const cdSlice = this.file.slice(cdOffset, cdOffset + cdSize);
    const cdBuf = new DataView(await cdSlice.arrayBuffer());
    let pos = 0;

    while (pos + 46 <= cdBuf.byteLength) {
      const sig = cdBuf.getUint32(pos, true);
      if (sig !== 0x02014b50) break;

      const method = cdBuf.getUint16(pos + 10, true);
      let compressedSize = cdBuf.getUint32(pos + 20, true);
      let uncompressedSize = cdBuf.getUint32(pos + 24, true);
      const fnLen = cdBuf.getUint16(pos + 28, true);
      const extraLen = cdBuf.getUint16(pos + 30, true);
      const commentLen = cdBuf.getUint16(pos + 32, true);
      let localHeaderOffset = cdBuf.getUint32(pos + 42, true);

      // ── Step 4: ZIP64 extra field for this entry ──────────────────────────
      // Any field equal to 0xFFFFFFFF has its real value in the ZIP64 extra
      // field (id=0x0001) appended after the filename.
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
            // Fields appear in the order: uncompressedSize, compressedSize,
            // localHeaderOffset — but only for those that are 0xFFFFFFFF.
            let fp = ep + 4;
            if (
              uncompressedSize === ZIP32_SENTINEL &&
              fp + 8 <= ep + 4 + headerSize
            ) {
              uncompressedSize = Number(cdBuf.getBigUint64(fp, true));
              fp += 8;
            }
            if (
              compressedSize === ZIP32_SENTINEL &&
              fp + 8 <= ep + 4 + headerSize
            ) {
              compressedSize = Number(cdBuf.getBigUint64(fp, true));
              fp += 8;
            }
            if (
              localHeaderOffset === ZIP32_SENTINEL &&
              fp + 8 <= ep + 4 + headerSize
            ) {
              localHeaderOffset = Number(cdBuf.getBigUint64(fp, true));
            }
            break;
          }
          ep += 4 + headerSize;
        }
      }

      const nameBytes = new Uint8Array(
        cdBuf.buffer,
        cdBuf.byteOffset + pos + 46,
        fnLen,
      );
      const name = new TextDecoder("utf-8").decode(nameBytes);

      if (!name.endsWith("/") && name !== "") {
        this.index.set(normalisePath(name), {
          method,
          localHeaderOffset,
          compressedSize,
          uncompressedSize,
        });
      }

      pos += 46 + fnLen + extraLen + commentLen;
    }

    if (this.index.size === 0) {
      throw new Error(
        "[ZipFS] Central Directory parsed but no file entries found. ZIP may be empty or corrupt.",
      );
    }

    console.info(
      `[ZipFS] Mounted "${this.file.name}": ${this.index.size} entries indexed.`,
    );
  }
}

// ─── WebFetchFS ───────────────────────────────────────────────────────────────
//
// Reads files from a static HTTP server.  This is the fallback for self-hosted
// Web deployments where the game assets are served alongside the app.
//
// Path mapping:
//   "data/manifest.json"       → fetch("/assets/data/manifest.json")
//   "data/script.rrs"          → fetch("/assets/data/script.rrs")
//   "images/BGs/bg.jpg"        → fetch("/assets/images/BGs/bg.jpg")
//   "Audio/BGM/foo.ogg"        → fetch("/assets/Audio/BGM/foo.ogg")

export class WebFetchFS implements IFileSystem {
  private readonly base: string;

  /**
   * @param base  Base URL prefix for all asset requests.
   *              Defaults to "/assets" which matches the Vite dev-server
   *              middleware and production build layout.
   */
  constructor(base = "/assets") {
    this.base = base.replace(/\/$/, "");
  }

  async readText(path: string): Promise<string> {
    const url = this._url(path);
    const resp = await fetch(url, {
      cache: "no-store",
      headers: { Pragma: "no-cache" },
    });
    if (!resp.ok)
      throw new Error(`[WebFetchFS] HTTP ${resp.status} fetching ${url}`);
    return resp.text();
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const url = this._url(path);
    const resp = await fetch(url);
    if (!resp.ok)
      throw new Error(`[WebFetchFS] HTTP ${resp.status} fetching ${url}`);
    return new Uint8Array(await resp.arrayBuffer());
  }

  async resolveUrl(path: string): Promise<string> {
    return this._url(path);
  }

  async exists(path: string): Promise<boolean> {
    try {
      const resp = await fetch(this._url(path), { method: "HEAD" });
      return resp.ok;
    } catch {
      return false;
    }
  }

  private _url(path: string): string {
    const clean = normalisePath(path);
    return `${this.base}/${clean}`;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise a file path for use as a Map key:
 *   - Strip leading slashes
 *   - Collapse any backslashes to forward slashes
 *   - Preserve case (ZIP is case-sensitive by spec)
 */
function normalisePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** Best-effort MIME type from file extension. */
function guessMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    svg: "image/svg+xml",
    webm: "video/webm",
    mp4: "video/mp4",
    ogg: "audio/ogg",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    json: "application/json",
    rrs: "text/plain",
    txt: "text/plain",
  };
  return map[ext] ?? "application/octet-stream";
}
