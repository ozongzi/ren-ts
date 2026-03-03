// ─── rpycReader.ts — Ren'Py compiled script (.rpyc) reader ───────────────────
//
// Supports two on-disk layouts:
//
// ── Legacy layout (Ren'Py ≤ 7.x, "line-based") ───────────────────────────────
//
//   Line 1 (ASCII, \n-terminated):  "RENPY RPC2\n"  or  "RENPY RPC1\n"
//
//   Followed by a sequence of slot records until slot_id == 0:
//     slot_id     : uint32 LE
//     compression : uint32 LE   (1=zlib, 2=bz2, 3=none)
//     length      : uint32 LE
//     data        : bytes[length]
//
// ── New layout (Ren'Py 8.x, "binary table") ──────────────────────────────────
//
//   Magic (exactly 10 bytes, NO trailing \n):  "RENPY RPC2"
//
//   Immediately after the magic:
//     slot_count  : uint16 LE
//     slot_table[slot_count]:
//       slot_id   : uint16 LE   (0-indexed; slot 0 = AST pickle)
//       offset    : uint32 LE   (absolute byte offset into file)
//       length    : uint32 LE   (byte length of compressed data)
//
//   Data at each slot is raw zlib-compressed bytes (no additional header).
//
// ── Slot semantics ────────────────────────────────────────────────────────────
//
//   Slot 0 / slot 1  — zlib-compressed Python pickle of the AST node list.
//   Slot 1 / slot 2  — canonical get_code() re-serialisation (NOT original
//                      source; absent in Ren'Py 8.1+; never used for conversion).
//
// Public API
// ──────────
//   readRpyc(buf)  →  RpycFile
//     .version     "RPC1" | "RPC2"
//     .rawSource   string | null   (second slot if present; debugging only)
//     .astPickle   PickleValue     (decoded first slot)

import { decodePickle, zlibDecompress, type PickleValue } from "../src/pickle";

// ─── Public types ─────────────────────────────────────────────────────────────

export type RpycVersion = "RPC1" | "RPC2";

/** The decoded contents of a single .rpyc file. */
export interface RpycFile {
  /** Which magic version was found in the file header. */
  version: RpycVersion;
  /**
   * The canonical get_code() text rebuilt from the AST, if a second slot was
   * present.  This is NOT the original .rpy source — it lacks comments, has
   * normalised whitespace, and is absent in Ren'Py 8.1+.
   * Exposed only for debugging; conversion should always use astPickle instead.
   */
  rawSource: string | null;
  /**
   * The decoded pickle value from the first slot.
   * For Ren'Py 7/8 this is a list of renpy.ast.* PickleObjects.
   */
  astPickle: PickleValue;
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface RpycSlot {
  /** 0-based slot index (new layout) or 1-based slot id (legacy layout). */
  id: number;
  /** 1 = zlib, 2 = bz2, 3 = none  (legacy layout only; new layout is always zlib) */
  compression: number;
  data: Uint8Array;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAGIC_BYTES = "RENPY RPC2"; // 10 bytes, no trailing newline
const MAGIC_RPC1 = "RENPY RPC1";

const COMPRESSION_ZLIB = 1;
const COMPRESSION_BZ2 = 2;
const COMPRESSION_NONE = 3;

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Parse a .rpyc file from its raw bytes and return the decoded contents.
 *
 * Supports both the legacy line-based layout (Ren'Py ≤ 7.x) and the new
 * binary-table layout (Ren'Py 8.x).
 *
 * @param buf  The complete file contents as an ArrayBuffer or Uint8Array.
 * @throws     Error if the file is not a recognised .rpyc file, if a required
 *             slot uses unsupported bz2 compression, or if the pickle in the
 *             first slot cannot be decoded.
 */
export async function readRpyc(
  buf: ArrayBuffer | Uint8Array,
): Promise<RpycFile> {
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);

  if (data.length < 10) {
    throw new Error("[rpycReader] File too short to be a .rpyc file");
  }

  const magic10 = new TextDecoder("ascii").decode(data.subarray(0, 10));

  // ── Detect layout ──────────────────────────────────────────────────────────

  if (magic10 === MAGIC_BYTES) {
    // Check whether byte 10 is '\n' (legacy) or a binary value (new table).
    if (data[10] === 0x0a) {
      return parseLineBased(data, "RPC2", 11);
    } else {
      return parseTableBased(data);
    }
  }

  // Try legacy RPC1 / RPC2 with \n after a longer magic line.
  const nlPos = data.indexOf(0x0a, 0);
  if (nlPos !== -1 && nlPos < 32) {
    const headerLine = new TextDecoder("ascii")
      .decode(data.subarray(0, nlPos))
      .trimEnd();
    if (headerLine === "RENPY RPC2") {
      return parseLineBased(data, "RPC2", nlPos + 1);
    }
    if (headerLine === MAGIC_RPC1) {
      return parseLineBased(data, "RPC1", nlPos + 1);
    }
  }

  throw new Error(
    `[rpycReader] Unrecognised file header — not a .rpyc file ` +
      `(first 10 bytes: ${Array.from(data.subarray(0, 10))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ")})`,
  );
}

// ─── Layout: new binary table (Ren'Py 8.x) ───────────────────────────────────
//
//   [10]  slot_count : u16 LE
//   [12]  slot_table : slot_count × { id:u16, offset:u32, length:u32 } (10 bytes each)
//   data at absolute offsets, raw zlib

async function parseTableBased(data: Uint8Array): Promise<RpycFile> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  if (data.length < 12) {
    throw new Error("[rpycReader] File too short for slot table header");
  }

  const slotCount = view.getUint16(10, true);
  const tableEnd = 12 + slotCount * 10;

  if (data.length < tableEnd) {
    throw new Error(
      `[rpycReader] File too short for slot table (need ${tableEnd} bytes, have ${data.length})`,
    );
  }

  const slots = new Map<number, RpycSlot>();

  for (let i = 0; i < slotCount; i++) {
    const base = 12 + i * 10;
    const slotId = view.getUint16(base, true);
    const offset = view.getUint32(base + 2, true);
    const length = view.getUint32(base + 6, true);

    if (offset + length > data.length) {
      throw new Error(
        `[rpycReader] Slot ${slotId} data out of bounds ` +
          `(offset=${offset}, length=${length}, fileSize=${data.length})`,
      );
    }

    slots.set(slotId, {
      id: slotId,
      compression: COMPRESSION_ZLIB, // new layout is always zlib
      data: data.subarray(offset, offset + length),
    });
  }

  return decodeSlots(slots, "RPC2");
}

// ─── Layout: legacy line-based (Ren'Py ≤ 7.x) ────────────────────────────────
//
//   Slot records starting at `startPos`:
//     slot_id(u32) + compression(u32) + length(u32) + data[length]
//   Terminated by slot_id == 0.

async function parseLineBased(
  data: Uint8Array,
  version: RpycVersion,
  startPos: number,
): Promise<RpycFile> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = startPos;
  const slots = new Map<number, RpycSlot>();

  while (pos + 12 <= data.length) {
    const slotId = view.getUint32(pos, true);
    const compression = view.getUint32(pos + 4, true);
    const length = view.getUint32(pos + 8, true);
    pos += 12;

    if (slotId === 0) break;

    if (pos + length > data.length) {
      throw new Error(
        `[rpycReader] Slot ${slotId} claims ${length} bytes but only ` +
          `${data.length - pos} remain`,
      );
    }

    slots.set(slotId, {
      id: slotId,
      compression,
      data: data.subarray(pos, pos + length),
    });

    pos += length;
  }

  return decodeSlots(slots, version);
}

// ─── Shared slot decoding ─────────────────────────────────────────────────────
//
// In the legacy layout slots are 1-indexed (slot 1 = AST, slot 2 = source).
// In the new layout slots are 0-indexed (slot 0 = AST, slot 1 = source).
// We normalise by trying both indices.

async function decodeSlots(
  slots: Map<number, RpycSlot>,
  version: RpycVersion,
): Promise<RpycFile> {
  // AST slot: prefer id=1 (legacy), fall back to id=0 (new layout).
  const astSlot = slots.get(1) ?? slots.get(0);
  if (!astSlot) {
    throw new Error(
      `[rpycReader] AST slot not found. Available slot ids: [${[...slots.keys()].join(", ")}]`,
    );
  }

  const astBytes = await decompressSlot(astSlot);
  const astPickle = decodePickle(astBytes);

  // Source slot: prefer id=2 (legacy), fall back to id=1 when slot 0 was AST.
  const sourceSlot = slots.get(2) ?? (slots.has(0) ? slots.get(1) : undefined);

  let rawSource: string | null = null;
  if (sourceSlot) {
    try {
      const srcBytes = await decompressSlot(sourceSlot);
      rawSource = new TextDecoder("utf-8").decode(srcBytes);
    } catch (err) {
      console.warn("[rpycReader] Could not decode source slot:", err);
    }
  }

  return { version, rawSource, astPickle };
}

// ─── Decompression ────────────────────────────────────────────────────────────

async function decompressSlot(slot: RpycSlot): Promise<Uint8Array> {
  switch (slot.compression) {
    case COMPRESSION_ZLIB:
      return zlibDecompress(slot.data);

    case COMPRESSION_NONE:
      return slot.data;

    case COMPRESSION_BZ2:
      throw new Error(
        `[rpycReader] Slot ${slot.id} uses bz2 compression which is not ` +
          "supported in this runtime. Please use the .rpy source file instead.",
      );

    default:
      // New-layout slots are always zlib; this branch handles unknown values.
      // Attempt zlib first as a best-effort fallback.
      try {
        return await zlibDecompress(slot.data);
      } catch {
        throw new Error(
          `[rpycReader] Slot ${slot.id} has unknown compression type ` +
            `${slot.compression} and zlib fallback also failed.`,
        );
      }
  }
}
