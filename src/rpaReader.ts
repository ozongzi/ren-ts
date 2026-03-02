// ─── RPA Archive Reader (pure TypeScript) ────────────────────────────────────
//
// Parses Ren'Py Archive (.rpa) files versions 2.0 and 3.0.
//
// Design goals:
//   • Zero-copy random access — uses File.slice() + arrayBuffer() so the
//     browser never holds more than one entry's bytes in memory at a time.
//   • No dependencies — zlib via DecompressionStream (browser built-in,
//     Chromium 80+, Firefox 113+, Safari 16.4+).  Pickle parsing is a
//     hand-rolled minimal implementation covering only the opcodes that
//     Ren'Py actually emits.
//   • Works in both FSA (FileSystemFileHandle → File) and plain File contexts.
//
// ─── RPA format recap ────────────────────────────────────────────────────────
//
//   Line 1 (ASCII, terminated by \n):
//     RPA-3.0  →  "RPA-3.0 <hex_offset> <hex_key>\n"
//     RPA-2.0  →  "RPA-2.0 <hex_offset>\n"           (key = 0)
//
//   At byte <hex_offset>:
//     zlib-compressed (deflate with zlib wrapper) Python pickle that
//     deserialises to:
//       { "path/in/archive": [(data_offset, data_length, prefix_bytes?), …] }
//
//   XOR key (RPA-3.0 only):
//     real_offset = stored_offset ^ key
//     real_length = stored_length ^ key
//
//   File data is stored raw (no additional compression) starting at
//   real_offset.  The optional prefix_bytes are prepended by Ren'Py before
//   the actual file data and must be skipped when reading.

// ─── Public types ─────────────────────────────────────────────────────────────

/** One file stored inside an RPA archive. */
export interface RpaEntry {
  /** Byte offset of the file's data within the .rpa file (after any prefix). */
  offset: number;
  /** Number of bytes to read. */
  length: number;
}

/** Maps in-archive paths to their location metadata. */
export type RpaIndex = Map<string, RpaEntry>;

// ─── RpaReader ────────────────────────────────────────────────────────────────

export class RpaReader {
  private constructor(
    private readonly file: File,
    private readonly index: RpaIndex,
  ) {}

  // ── Factory ──────────────────────────────────────────────────────────────

  /**
   * Parse the RPA archive represented by `file` and return an RpaReader
   * whose index is fully populated.
   *
   * Throws a descriptive string if the file is not a recognised RPA archive
   * or if the index cannot be decoded.
   */
  static async open(file: File): Promise<RpaReader> {
    // Read enough bytes for the header line (max ~80 bytes in practice).
    const headerBuf = await file.slice(0, 256).arrayBuffer();
    const headerBytes = new Uint8Array(headerBuf);

    const nlPos = headerBytes.indexOf(0x0a); // '\n'
    if (nlPos === -1) {
      throw new Error("RPA header has no newline — not a valid RPA file");
    }

    const headerLine = new TextDecoder("ascii").decode(
      headerBytes.slice(0, nlPos),
    );

    const { indexOffset, key } = RpaReader._parseHeader(headerLine);

    // Read from indexOffset to end of file (the zlib-compressed pickle).
    const compressedBuf = await file.slice(indexOffset).arrayBuffer();

    // Decompress via browser's built-in DecompressionStream.
    const pickleBytes = await RpaReader._zlibDecompress(
      new Uint8Array(compressedBuf),
    );

    // Decode the pickle into a raw index map.
    const index = RpaReader._deserialiseIndex(pickleBytes, key);

    return new RpaReader(file, index);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** All in-archive paths, sorted lexicographically. */
  get paths(): string[] {
    return Array.from(this.index.keys()).sort();
  }

  /** Return true if the archive contains the given path. */
  has(entryPath: string): boolean {
    return this.index.has(entryPath);
  }

  /**
   * Read the raw bytes of a single entry.
   * Returns null if the path does not exist in the archive.
   */
  async read(entryPath: string): Promise<Uint8Array | null> {
    const entry = this.index.get(entryPath);
    if (!entry) return null;

    const buf = await this.file
      .slice(entry.offset, entry.offset + entry.length)
      .arrayBuffer();
    return new Uint8Array(buf);
  }

  /**
   * Return a ReadableStream<Uint8Array> over the raw bytes of a single entry.
   * This avoids materialising the full entry in memory — useful for large
   * binary assets piped directly into a ZIP writer.
   * Returns null if the path does not exist.
   */
  stream(entryPath: string): ReadableStream<Uint8Array> | null {
    const entry = this.index.get(entryPath);
    if (!entry) return null;

    // File.slice returns a Blob; Blob.stream() is a ReadableStream<Uint8Array>.
    return this.file
      .slice(entry.offset, entry.offset + entry.length)
      .stream() as ReadableStream<Uint8Array>;
  }

  // ── Header parsing ────────────────────────────────────────────────────────

  private static _parseHeader(line: string): {
    indexOffset: number;
    key: number;
  } {
    const trimmed = line.trimEnd();

    if (trimmed.startsWith("RPA-3.0 ")) {
      const rest = trimmed.slice("RPA-3.0 ".length);
      const parts = rest.split(/\s+/);
      if (parts.length < 2) {
        throw new Error(`Malformed RPA-3.0 header: ${JSON.stringify(trimmed)}`);
      }
      const indexOffset = parseInt(parts[0], 16);
      const key = parseInt(parts[1], 16);
      if (!Number.isFinite(indexOffset) || !Number.isFinite(key)) {
        throw new Error(`Bad numeric values in RPA-3.0 header: ${trimmed}`);
      }
      return { indexOffset, key };
    }

    if (trimmed.startsWith("RPA-2.0 ")) {
      const rest = trimmed.slice("RPA-2.0 ".length).split(/\s+/)[0];
      const indexOffset = parseInt(rest, 16);
      if (!Number.isFinite(indexOffset)) {
        throw new Error(`Bad offset in RPA-2.0 header: ${trimmed}`);
      }
      return { indexOffset, key: 0 };
    }

    throw new Error(
      `Unrecognised RPA format: ${JSON.stringify(trimmed.slice(0, 32))}`,
    );
  }

  // ── zlib decompression ────────────────────────────────────────────────────

  private static async _zlibDecompress(data: Uint8Array): Promise<Uint8Array> {
    const ds = new DecompressionStream("deflate");
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();

    // Feed compressed data and close the writable end.
    const writePromise = writer
      .write(data as unknown as Uint8Array<ArrayBuffer>)
      .then(() => writer.close());

    // Drain the readable end, collecting all chunks.
    const chunks: Uint8Array[] = [];
    let totalLen = 0;

    const readPromise = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalLen += value.length;
      }
    })();

    await Promise.all([writePromise, readPromise]);

    // Concatenate chunks into one contiguous buffer.
    const result = new Uint8Array(totalLen);
    let pos = 0;
    for (const chunk of chunks) {
      result.set(chunk, pos);
      pos += chunk.length;
    }
    return result;
  }

  // ─── Minimal pickle reader ──────────────────────────────────────────────
  //
  // Ren'Py writes the RPA index using Python's pickle protocol 2.  The
  // structure is always a dict whose values are lists of 2- or 3-tuples.
  //
  // We implement only the opcodes that actually appear in that output.
  // Reference: https://github.com/python/cpython/blob/main/Lib/pickle.py
  //
  // Opcodes handled:
  //   0x80 PROTO          – protocol byte, ignored
  //   (    MARK           – push sentinel
  //   )    EMPTY_TUPLE    – push ()
  //   ]    EMPTY_LIST     – push []
  //   }    EMPTY_DICT     – push {}
  //   t    TUPLE          – pop to MARK, push tuple
  //   0x85 TUPLE1         – pop 1 → (a,)
  //   0x86 TUPLE2         – pop 2 → (a,b)
  //   0x87 TUPLE3         – pop 3 → (a,b,c)
  //   l    LIST           – pop to MARK, push list
  //   a    APPEND         – list.append
  //   e    APPITEMS       – list.extend from MARK
  //   d    DICT           – pop pairs from MARK, push dict
  //   s    SETITEM        – dict[k]=v
  //   u    SETITEMS       – dict.update from MARK
  //   K    BININT1        – 1-byte uint
  //   M    BININT2        – 2-byte LE uint
  //   J    BININT         – 4-byte LE signed int
  //   I    INT            – decimal ASCII line
  //   L    LONG           – decimal ASCII + 'L' line
  //   0x8a LONG1          – 1-byte-len LE signed bigint
  //   0x8b LONG4          – 4-byte-len LE signed bigint
  //   T    SHORT_BINSTRING – 4-byte-len + latin-1 bytes
  //   U    SHORT_BINUNICODE – 1-byte-len + UTF-8
  //   X    BINUNICODE     – 4-byte-len + UTF-8
  //   S    STRING         – quoted ASCII line
  //   C    SHORT_BINBYTES – 1-byte-len + raw bytes
  //   B    BINBYTES       – 4-byte-len + raw bytes
  //   N    NONE
  //   0x88 NEWTRUE  / 0x89 NEWFALSE
  //   p    PUT  / q BINPUT  / r LONG_BINPUT   – memo store
  //   g    GET  / h BINGET  / j LONG_BINGET   – memo fetch
  //   0    POP
  //   2    DUP
  //   c    GLOBAL    – push None placeholder
  //   R    REDUCE    – callable(args) → produce dict for OrderedDict
  //   b    BUILD     – ignore (pop state)
  //   0x81 NEWOBJ   – cls(*args) → produce empty dict
  //   0x92 NEWOBJ_EX – cls(*args,**kw) → produce empty dict
  //   0x93 STACK_GLOBAL – pop name+module, push None
  //   0x95 FRAME    – 8-byte frame length, skip
  //   .    STOP      – return top of stack

  // Pickle value discriminated union
  private static readonly _MARK = Symbol("MARK");

  private static _deserialiseIndex(data: Uint8Array, key: number): RpaIndex {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let pos = 0;

    // ── low-level readers ──────────────────────────────────────────────────

    const readByte = (): number => {
      if (pos >= data.length)
        throw new Error("Unexpected end of pickle stream");
      return data[pos++];
    };

    const readBytes = (n: number): Uint8Array => {
      if (pos + n > data.length)
        throw new Error(
          `Need ${n} bytes at pos ${pos} but only ${data.length - pos} remain`,
        );
      const slice = data.subarray(pos, pos + n);
      pos += n;
      return slice;
    };

    const readLine = (): string => {
      const start = pos;
      while (pos < data.length && data[pos] !== 0x0a) pos++;
      const line = new TextDecoder("utf-8").decode(data.subarray(start, pos));
      if (pos < data.length) pos++; // consume '\n'
      return line;
    };

    const readU16LE = (): number => {
      const v = view.getUint16(pos, true);
      pos += 2;
      return v;
    };

    const readU32LE = (): number => {
      const v = view.getUint32(pos, true);
      pos += 4;
      return v;
    };

    const readI32LE = (): number => {
      const v = view.getInt32(pos, true);
      pos += 4;
      return v;
    };

    /** Decode a little-endian signed integer of arbitrary byte width. */
    const readLeSigned = (n: number): number => {
      if (n === 0) return 0;
      const bytes = readBytes(n);
      let v = 0;
      for (let i = 0; i < n; i++) v += bytes[i] * Math.pow(256, i);
      // Sign-extend if the MSB is set.
      if (bytes[n - 1] & 0x80) v -= Math.pow(256, n);
      return v;
    };

    // ── stack machine ──────────────────────────────────────────────────────

    type PV =
      | typeof RpaReader._MARK
      | number
      | string
      | Uint8Array
      | PV[] // list or tuple (we don't distinguish at runtime)
      | Map<PV, PV>
      | null;

    const stack: PV[] = [];
    const memo = new Map<number, PV>();

    const pop = (): PV => {
      if (stack.length === 0) throw new Error("Pickle stack underflow");
      return stack.pop()!;
    };

    const popToMark = (): PV[] => {
      const items: PV[] = [];
      for (;;) {
        const v = pop();
        if (v === RpaReader._MARK) break;
        items.unshift(v);
      }
      return items;
    };

    const peekDict = (): Map<PV, PV> => {
      const top = stack[stack.length - 1];
      if (!(top instanceof Map))
        throw new Error("Expected Map on top of pickle stack");
      return top;
    };

    const peekList = (): PV[] => {
      const top = stack[stack.length - 1];
      if (!Array.isArray(top))
        throw new Error("Expected Array on top of pickle stack");
      return top;
    };

    // ── main decode loop ───────────────────────────────────────────────────

    for (;;) {
      const op = readByte();

      switch (op) {
        // ── Protocol / no-op ──────────────────────────────────────────────
        case 0x80: // PROTO
          readByte(); // version byte, ignore
          break;

        case 0x95: // FRAME (protocol 4+): 8-byte payload length, skip header
          readBytes(8);
          break;

        // ── Stack manipulation ─────────────────────────────────────────────
        case 0x28: // '(' MARK
          stack.push(RpaReader._MARK);
          break;

        case 0x29: // ')' EMPTY_TUPLE
          stack.push([]);
          break;

        case 0x5d: // ']' EMPTY_LIST
          stack.push([]);
          break;

        case 0x7d: // '}' EMPTY_DICT
          stack.push(new Map());
          break;

        case 0x30: // '0' POP
          pop();
          break;

        case 0x32: // '2' DUP
          stack.push(stack[stack.length - 1]);
          break;

        // ── Tuples ────────────────────────────────────────────────────────
        case 0x74: {
          // 't' TUPLE
          const items = popToMark();
          stack.push(items);
          break;
        }
        case 0x85: {
          // TUPLE1
          const a = pop();
          stack.push([a]);
          break;
        }
        case 0x86: {
          // TUPLE2
          const b = pop();
          const a = pop();
          stack.push([a, b]);
          break;
        }
        case 0x87: {
          // TUPLE3
          const c = pop();
          const b = pop();
          const a = pop();
          stack.push([a, b, c]);
          break;
        }

        // ── Lists ──────────────────────────────────────────────────────────
        case 0x6c: {
          // 'l' LIST
          const items = popToMark();
          stack.push(items);
          break;
        }
        case 0x61: {
          // 'a' APPEND
          const item = pop();
          peekList().push(item);
          break;
        }

        case 0x65: {
          // 'e' APPITEMS
          const items = popToMark();
          peekList().push(...items);
          break;
        }

        // ── Dicts ──────────────────────────────────────────────────────────
        case 0x64: {
          // 'd' DICT
          const items = popToMark();
          const m = new Map<PV, PV>();
          for (let i = 0; i + 1 < items.length; i += 2)
            m.set(items[i], items[i + 1]);
          stack.push(m);
          break;
        }
        case 0x73: {
          // 's' SETITEM
          const v = pop();
          const k = pop();
          peekDict().set(k, v);
          break;
        }
        case 0x75: {
          // 'u' SETITEMS
          const items = popToMark();
          const d = peekDict();
          for (let i = 0; i + 1 < items.length; i += 2)
            d.set(items[i], items[i + 1]);
          break;
        }

        // ── Integers ──────────────────────────────────────────────────────
        case 0x4b: // 'K' BININT1
          stack.push(readByte());
          break;

        case 0x4d: // 'M' BININT2
          stack.push(readU16LE());
          break;

        case 0x4a: // 'J' BININT
          stack.push(readI32LE());
          break;

        case 0x49: {
          // 'I' INT (decimal line)
          const s = readLine().trim();
          stack.push(Number(s));
          break;
        }

        case 0x4c: {
          // 'L' LONG (decimal + optional 'L')
          const s = readLine().trim().replace(/L$/, "");
          stack.push(Number(s));
          break;
        }

        case 0x8a: {
          // LONG1: 1-byte length + LE signed bytes
          const n = readByte();
          stack.push(readLeSigned(n));
          break;
        }

        case 0x8b: {
          // LONG4: 4-byte LE length + LE signed bytes
          const n = readU32LE();
          stack.push(readLeSigned(n));
          break;
        }

        // ── Strings / bytes ───────────────────────────────────────────────
        case 0x54: {
          // 'T' SHORT_BINSTRING (4-byte len, latin-1)
          const n = readU32LE();
          const raw = readBytes(n);
          stack.push(
            Array.from(raw)
              .map((b) => String.fromCharCode(b))
              .join(""),
          );
          break;
        }

        case 0x55: {
          // 'U' SHORT_BINUNICODE (1-byte len, UTF-8)
          const n = readByte();
          stack.push(new TextDecoder("utf-8").decode(readBytes(n)));
          break;
        }

        case 0x58: {
          // 'X' BINUNICODE (4-byte LE len, UTF-8)
          const n = readU32LE();
          stack.push(new TextDecoder("utf-8").decode(readBytes(n)));
          break;
        }

        case 0x53: {
          // 'S' STRING (quoted ASCII line)
          let s = readLine().trim();
          if (
            (s.startsWith("'") && s.endsWith("'")) ||
            (s.startsWith('"') && s.endsWith('"'))
          ) {
            s = s.slice(1, -1);
          }
          stack.push(s);
          break;
        }

        case 0x43: {
          // 'C' SHORT_BINBYTES (1-byte len)
          const n = readByte();
          stack.push(readBytes(n).slice()); // copy so it owns its buffer
          break;
        }

        case 0x42: {
          // 'B' BINBYTES (4-byte LE len)
          const n = readU32LE();
          stack.push(readBytes(n).slice());
          break;
        }

        // ── None / booleans ───────────────────────────────────────────────
        case 0x4e: // 'N' NONE
          stack.push(null);
          break;

        case 0x88: // NEWTRUE
          stack.push(1);
          break;

        case 0x89: // NEWFALSE
          stack.push(0);
          break;

        // ── Memo ──────────────────────────────────────────────────────────
        case 0x70: {
          // 'p' PUT (decimal line)
          const id = parseInt(readLine().trim(), 10);
          memo.set(id, stack[stack.length - 1]);
          break;
        }
        case 0x71: {
          // 'q' BINPUT (1-byte id)
          const id = readByte();
          memo.set(id, stack[stack.length - 1]);
          break;
        }
        case 0x72: {
          // 'r' LONG_BINPUT (4-byte LE id)
          const id = readU32LE();
          memo.set(id, stack[stack.length - 1]);
          break;
        }
        case 0x67: {
          // 'g' GET (decimal line)
          const id = parseInt(readLine().trim(), 10);
          const v = memo.get(id);
          if (v === undefined) throw new Error(`GET: memo id ${id} not found`);
          stack.push(v);
          break;
        }
        case 0x68: {
          // 'h' BINGET (1-byte id)
          const id = readByte();
          const v = memo.get(id);
          if (v === undefined)
            throw new Error(`BINGET: memo id ${id} not found`);
          stack.push(v);
          break;
        }
        case 0x6a: {
          // 'j' LONG_BINGET (4-byte LE id)
          const id = readU32LE();
          const v = memo.get(id);
          if (v === undefined)
            throw new Error(`LONG_BINGET: memo id ${id} not found`);
          stack.push(v);
          break;
        }

        // ── Global / object construction ───────────────────────────────────
        case 0x63: // 'c' GLOBAL: module\nname\n → push None placeholder
          readLine(); // module
          readLine(); // name
          stack.push(null);
          break;

        case 0x52: {
          // 'R' REDUCE: callable(*args)
          const args = pop();
          pop(); // callable — discarded
          // Produce a Map for OrderedDict() or OrderedDict([(k,v),...])
          if (Array.isArray(args) && args.length === 0) {
            stack.push(new Map());
          } else if (
            Array.isArray(args) &&
            args.length === 1 &&
            Array.isArray(args[0])
          ) {
            const m = new Map<PV, PV>();
            for (const pair of args[0] as PV[]) {
              if (Array.isArray(pair) && pair.length === 2)
                m.set(pair[0], pair[1]);
            }
            stack.push(m);
          } else {
            stack.push(new Map());
          }
          break;
        }

        case 0x62: // 'b' BUILD: pop state, ignore
          pop();
          break;

        case 0x81: // NEWOBJ: cls(*args) → empty Map
          pop();
          pop();
          stack.push(new Map());
          break;

        case 0x92: // NEWOBJ_EX: cls(*args,**kw) → empty Map
          pop();
          pop();
          pop();
          stack.push(new Map());
          break;

        case 0x93: // STACK_GLOBAL: pop name+module, push None
          pop();
          pop();
          stack.push(null);
          break;

        // ── Stop ──────────────────────────────────────────────────────────
        case 0x2e: {
          // '.' STOP
          const root = pop();
          if (!(root instanceof Map)) {
            throw new Error(`Expected dict at pickle root, got ${typeof root}`);
          }
          // Deserialise into RpaIndex
          const index: RpaIndex = new Map();

          for (const [k, v] of root) {
            // Key is the in-archive path string.
            let path: string;
            if (typeof k === "string") {
              path = k;
            } else if (k instanceof Uint8Array) {
              path = new TextDecoder("latin1").decode(k);
            } else {
              continue; // skip unexpected key types
            }

            // Value is a list of tuples; we only use the first one.
            if (!Array.isArray(v) || v.length === 0) continue;
            const first = v[0];
            if (!Array.isArray(first) || first.length < 2) continue;

            const rawOffset = Number(first[0]);
            const rawLength = Number(first[1]);

            // Prefix bytes (3rd tuple element, usually empty "").
            const prefix = first[2];
            let prefixLen = 0;
            if (typeof prefix === "string") {
              prefixLen = prefix.length;
            } else if (prefix instanceof Uint8Array) {
              prefixLen = prefix.length;
            }

            // XOR-decode with the archive key.
            const realOffset = (rawOffset ^ key) + prefixLen;
            const realLength = (rawLength ^ key) - prefixLen;

            if (realLength < 0) continue; // malformed entry

            index.set(path, { offset: realOffset, length: realLength });
          }

          return index;
        }

        default:
          throw new Error(
            `Unsupported pickle opcode 0x${op.toString(16).padStart(2, "0")} ` +
              `at position ${pos - 1}`,
          );
      }
    }
  }
}
