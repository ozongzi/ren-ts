// ─── pickle.ts — Minimal Python pickle decoder ───────────────────────────────
//
// Extracted and generalised from rpaReader.ts.
//
// The original implementation in RpaReader._deserialiseIndex was tuned solely
// for the RPA index (a dict of {path: [(offset, length, prefix)]}).  This
// module exposes a generic decoder that can also handle the much richer pickle
// streams found in .rpyc files (renpy.ast node trees).
//
// Supported protocols: 0–5 (all opcodes that Ren'Py actually emits).
//
// Design decisions
// ──────────────────
//  • The decoder returns a typed PickleValue discriminated union instead of
//    `any`.  Callers that need specific shapes (RPA index, rpyc AST) perform
//    their own post-processing.
//
//  • GLOBAL / STACK_GLOBAL push a PickleObject whose className records the
//    "module.Name" string.  BUILD then fills in the __dict__ field.
//    REDUCE is handled generically: if the callable is a PickleObject with a
//    known className the result is another PickleObject, otherwise a raw
//    PickleCallResult.
//
//  • NEWOBJ / NEWOBJ_EX likewise produce PickleObjects.
//
//  • All memo operations (PUT/GET and their variants) are fully supported.
//
// Reference: https://github.com/python/cpython/blob/main/Lib/pickle.py

// ─── Public types ─────────────────────────────────────────────────────────────

/** A decoded Python object whose class name is known but whose fields may
 *  still be populated later (via BUILD). */
export interface PickleObject {
  readonly _type: "obj";
  /** "module.ClassName" exactly as written in the pickle stream. */
  className: string;
  /** Fields populated by the BUILD opcode (i.e. obj.__dict__). */
  fields: Record<string, PickleValue>;
  /** Positional constructor arguments (from REDUCE / NEWOBJ args tuple). */
  args: PickleValue[];
}

/** A tuple — represented as a JS array tagged so callers can distinguish it
 *  from a list when needed. */
export interface PickleTuple {
  readonly _type: "tuple";
  items: PickleValue[];
}

/** The result of a REDUCE call when the callable is not a recognised class. */
export interface PickleCallResult {
  readonly _type: "call";
  callable: PickleValue;
  args: PickleValue[];
}

export type PickleValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | PickleValue[] // list
  | PickleTuple
  | Map<PickleValue, PickleValue> // dict
  | PickleObject
  | PickleCallResult;

// ─── Internal sentinel ────────────────────────────────────────────────────────

const MARK = Symbol("MARK");
type StackItem = typeof MARK | PickleValue;

// ─── zlib decompression (browser built-in) ────────────────────────────────────

/**
 * Decompress a zlib-wrapped deflate stream using the browser's built-in
 * DecompressionStream.
 *
 * "deflate" mode in DecompressionStream accepts both raw deflate and the zlib
 * wrapper (RFC 1950), which is what Ren'Py uses.
 */
export async function zlibDecompress(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  const writePromise = writer
    .write(data as unknown as Uint8Array<ArrayBuffer>)
    .then(() => writer.close());

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

  const result = new Uint8Array(totalLen);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }
  return result;
}

// ─── Main decoder ─────────────────────────────────────────────────────────────

/**
 * Decode a Python pickle byte stream and return the root value.
 *
 * @param data  Raw pickle bytes (any protocol 0–5).
 * @returns     The decoded root PickleValue.
 * @throws      Error on malformed input or unsupported opcodes.
 */
export function decodePickle(data: Uint8Array): PickleValue {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 0;

  // ── Low-level byte readers ─────────────────────────────────────────────────

  const readByte = (): number => {
    if (pos >= data.length) throw new Error("Unexpected end of pickle stream");
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

  const readI64LE = (): number => {
    // JS can't represent all 64-bit integers precisely, but pickle offsets
    // in rpyc files fit comfortably in 53-bit mantissa for any real game.
    const lo = view.getUint32(pos, true);
    const hi = view.getInt32(pos + 4, true);
    pos += 8;
    return hi * 0x1_0000_0000 + lo;
  };

  const readLeSigned = (n: number): number => {
    if (n === 0) return 0;
    const bytes = readBytes(n);
    let v = 0;
    for (let i = 0; i < n; i++) v += bytes[i] * Math.pow(256, i);
    if (bytes[n - 1] & 0x80) v -= Math.pow(256, n);
    return v;
  };

  // ── Stack machine ──────────────────────────────────────────────────────────

  const stack: StackItem[] = [];
  const memo = new Map<number, PickleValue>();

  const pop = (): StackItem => {
    if (stack.length === 0) throw new Error("Pickle stack underflow");
    return stack.pop()!;
  };

  const popValue = (): PickleValue => {
    const v = pop();
    if (v === MARK) throw new Error("Unexpected MARK on stack");
    return v;
  };

  const popToMark = (): PickleValue[] => {
    const items: PickleValue[] = [];
    for (;;) {
      const v = pop();
      if (v === MARK) break;
      items.unshift(v as PickleValue);
    }
    return items;
  };

  // A minimal write-only dict-like interface returned by peekDict.
  // Callers only ever call .set() on it (SETITEM / SETITEMS).
  interface DictProxy {
    set(k: PickleValue, v: PickleValue): void;
  }

  /**
   * Return a dict-like proxy for the top-of-stack value.
   *
   * Accepts:
   *  • Map<PickleValue, PickleValue>  — plain dict (the normal case)
   *  • PickleObject                   — dict subclass (e.g. RevertableDict,
   *    OrderedDict).  String keys are written into `fields`; non-string keys
   *    are collected into a special `_entries` list for downstream access.
   *
   * Throws if the top of stack is anything else (or MARK / undefined).
   */
  const peekDict = (): DictProxy => {
    const top = stack[stack.length - 1];
    if (top instanceof Map) {
      // Plain Map — return it directly (Map already has .set()).
      return top as Map<PickleValue, PickleValue>;
    }
    if (
      top !== null &&
      top !== undefined &&
      (top as PickleObject)._type === "obj"
    ) {
      // Dict subclass pickled as a PickleObject.  We expose a shim that
      // stores string keys in .fields and everything else in ._entries.
      const pObj = top as PickleObject;
      if (!Array.isArray(pObj.fields["_entries"])) {
        pObj.fields["_entries"] = [] as unknown as PickleValue;
      }
      return {
        set(k: PickleValue, v: PickleValue): void {
          if (typeof k === "string") {
            pObj.fields[k] = v;
          } else {
            // Non-string key — store as [key, value] pair in _entries.
            (pObj.fields["_entries"] as unknown as PickleValue[]).push({
              _type: "tuple",
              items: [k, v],
            } satisfies PickleTuple);
          }
        },
      };
    }
    throw new Error(
      `Expected Map or PickleObject (dict subclass) on top of pickle stack, ` +
        `got: ${top === MARK ? "MARK" : JSON.stringify(top, null, 0).slice(0, 80)}`,
    );
  };

  /**
   * Return the array on top of the stack for APPEND / APPITEMS.
   *
   * Accepts:
   *  • PickleValue[]  — plain list (the normal case)
   *  • PickleObject   — list subclass (e.g. RevertableList).  Items are
   *    appended to a `_items` field on the object.
   */
  const peekList = (): PickleValue[] => {
    const top = stack[stack.length - 1];
    if (Array.isArray(top)) return top as PickleValue[];
    if (
      top !== null &&
      top !== undefined &&
      (top as PickleObject)._type === "obj"
    ) {
      // List subclass — lazily create a _items array in fields.
      const pObj = top as PickleObject;
      if (!Array.isArray(pObj.fields["_items"])) {
        pObj.fields["_items"] = [] as unknown as PickleValue;
      }
      return pObj.fields["_items"] as unknown as PickleValue[];
    }
    throw new Error(
      `Expected Array or PickleObject (list subclass) on top of pickle stack, ` +
        `got: ${top === MARK ? "MARK" : JSON.stringify(top, null, 0).slice(0, 80)}`,
    );
  };

  // Memo helpers
  const memoize = (id: number): void => {
    const top = stack[stack.length - 1];
    if (top === MARK) throw new Error("Cannot memoize MARK");
    memo.set(id, top as PickleValue);
  };

  const memoGet = (id: number): PickleValue => {
    if (!memo.has(id)) throw new Error(`Memo id ${id} not found`);
    return memo.get(id)!;
  };

  // ── Main decode loop ───────────────────────────────────────────────────────

  for (;;) {
    const op = readByte();

    switch (op) {
      // ── Protocol / frame ────────────────────────────────────────────────
      case 0x80: // PROTO: version byte, ignore
        readByte();
        break;

      case 0x95: // FRAME (protocol 4+): 8-byte payload length header, skip
        readI64LE();
        break;

      // ── Stack sentinels ─────────────────────────────────────────────────
      case 0x28: // '(' MARK
        stack.push(MARK);
        break;

      case 0x30: // '0' POP
        pop();
        break;

      case 0x32: // '2' DUP
        stack.push(stack[stack.length - 1]);
        break;

      // ── Empty containers ─────────────────────────────────────────────────
      case 0x29: // ')' EMPTY_TUPLE
        stack.push({ _type: "tuple", items: [] });
        break;

      case 0x5d: // ']' EMPTY_LIST
        stack.push([]);
        break;

      case 0x7d: // '}' EMPTY_DICT
        stack.push(new Map());
        break;

      // ── Tuples ─────────────────────────────────────────────────────────
      case 0x74: {
        // 't' TUPLE — pop to MARK
        const items = popToMark();
        stack.push({ _type: "tuple", items });
        break;
      }
      case 0x85: {
        // TUPLE1
        const a = popValue();
        stack.push({ _type: "tuple", items: [a] });
        break;
      }
      case 0x86: {
        // TUPLE2
        const b = popValue();
        const a = popValue();
        stack.push({ _type: "tuple", items: [a, b] });
        break;
      }
      case 0x87: {
        // TUPLE3
        const c = popValue();
        const b = popValue();
        const a = popValue();
        stack.push({ _type: "tuple", items: [a, b, c] });
        break;
      }

      // ── Lists ─────────────────────────────────────────────────────────
      case 0x6c: {
        // 'l' LIST — pop to MARK
        const items = popToMark();
        stack.push(items);
        break;
      }
      case 0x61: {
        // 'a' APPEND
        const item = popValue();
        peekList().push(item);
        break;
      }
      case 0x65: {
        // 'e' APPITEMS — extend list from MARK
        const items = popToMark();
        peekList().push(...items);
        break;
      }

      // ── Dicts ─────────────────────────────────────────────────────────
      case 0x64: {
        // 'd' DICT — pop pairs from MARK
        const items = popToMark();
        const m = new Map<PickleValue, PickleValue>();
        for (let i = 0; i + 1 < items.length; i += 2)
          m.set(items[i], items[i + 1]);
        stack.push(m);
        break;
      }
      case 0x73: {
        // 's' SETITEM
        const v = popValue();
        const k = popValue();
        peekDict().set(k, v);
        break;
      }
      case 0x75: {
        // 'u' SETITEMS — update dict from MARK pairs
        const items = popToMark();
        const d = peekDict();
        for (let i = 0; i + 1 < items.length; i += 2)
          d.set(items[i], items[i + 1]);
        break;
      }

      // ── Integers ──────────────────────────────────────────────────────
      case 0x4b: // 'K' BININT1 — 1-byte unsigned
        stack.push(readByte());
        break;

      case 0x4d: // 'M' BININT2 — 2-byte LE unsigned
        stack.push(readU16LE());
        break;

      case 0x4a: // 'J' BININT — 4-byte LE signed
        stack.push(readI32LE());
        break;

      case 0x49: {
        // 'I' INT — decimal ASCII line; also handles 00/01 booleans
        const s = readLine().trim();
        if (s === "00") {
          stack.push(false);
          break;
        }
        if (s === "01") {
          stack.push(true);
          break;
        }
        stack.push(Number(s));
        break;
      }

      case 0x4c: {
        // 'L' LONG — decimal ASCII + optional trailing 'L'
        const s = readLine().trim().replace(/L$/, "");
        stack.push(Number(s));
        break;
      }

      case 0x8a: {
        // LONG1 — 1-byte length, LE signed bytes
        const n = readByte();
        stack.push(readLeSigned(n));
        break;
      }

      case 0x8b: {
        // LONG4 — 4-byte LE length, LE signed bytes
        const n = readU32LE();
        stack.push(readLeSigned(n));
        break;
      }

      // ── Floats ────────────────────────────────────────────────────────
      case 0x47: {
        // 'G' BINFLOAT — 8-byte big-endian IEEE 754 double
        const hi = view.getUint32(pos, false);
        const lo = view.getUint32(pos + 4, false);
        pos += 8;
        // Reconstruct IEEE 754 double via DataView in big-endian
        const buf = new ArrayBuffer(8);
        const dv = new DataView(buf);
        dv.setUint32(0, hi, false);
        dv.setUint32(4, lo, false);
        stack.push(dv.getFloat64(0, false));
        break;
      }

      case 0x46: {
        // 'F' FLOAT — ASCII decimal line
        stack.push(parseFloat(readLine().trim()));
        break;
      }

      // ── Strings / bytes ───────────────────────────────────────────────
      case 0x54: {
        // 'T' SHORT_BINSTRING — 4-byte LE len, latin-1
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
        // 'U' SHORT_BINUNICODE — 1-byte len, UTF-8
        const n = readByte();
        stack.push(new TextDecoder("utf-8").decode(readBytes(n)));
        break;
      }

      case 0x58: {
        // 'X' BINUNICODE — 4-byte LE len, UTF-8
        const n = readU32LE();
        stack.push(new TextDecoder("utf-8").decode(readBytes(n)));
        break;
      }

      case 0x8c: {
        // SHORT_BINUNICODE8 — alias used in protocol 4: 1-byte len, UTF-8
        // (same encoding as 'U' but different opcode)
        const n = readByte();
        stack.push(new TextDecoder("utf-8").decode(readBytes(n)));
        break;
      }

      case 0x8d: {
        // BINUNICODE8 — 8-byte LE len, UTF-8
        const n = readI64LE();
        stack.push(new TextDecoder("utf-8").decode(readBytes(n)));
        break;
      }

      case 0x53: {
        // 'S' STRING — quoted ASCII line
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

      case 0x56: {
        // 'V' UNICODE — raw unicode escape line
        const raw = readLine();
        // Python unicode escapes like \uXXXX; use JSON parse trick
        try {
          stack.push(JSON.parse('"' + raw.replace(/"/g, '\\"') + '"'));
        } catch {
          stack.push(raw);
        }
        break;
      }

      case 0x43: {
        // 'C' SHORT_BINBYTES — 1-byte len, raw bytes
        const n = readByte();
        stack.push(readBytes(n).slice());
        break;
      }

      case 0x42: {
        // 'B' BINBYTES — 4-byte LE len, raw bytes
        const n = readU32LE();
        stack.push(readBytes(n).slice());
        break;
      }

      case 0x8e: {
        // BINBYTES8 — 8-byte LE len, raw bytes
        const n = readI64LE();
        stack.push(readBytes(n).slice());
        break;
      }

      case 0x96: {
        // BYTEARRAY8 — 8-byte LE len, raw bytes (protocol 5)
        const n = readI64LE();
        stack.push(readBytes(n).slice());
        break;
      }

      // ── None / booleans ───────────────────────────────────────────────
      case 0x4e: // 'N' NONE
        stack.push(null);
        break;

      case 0x88: // NEWTRUE
        stack.push(true);
        break;

      case 0x89: // NEWFALSE
        stack.push(false);
        break;

      // ── Memo ──────────────────────────────────────────────────────────
      case 0x70: {
        // 'p' PUT — decimal id line
        const id = parseInt(readLine().trim(), 10);
        memoize(id);
        break;
      }
      case 0x71: {
        // 'q' BINPUT — 1-byte id
        memoize(readByte());
        break;
      }
      case 0x72: {
        // 'r' LONG_BINPUT — 4-byte LE id
        memoize(readU32LE());
        break;
      }
      case 0x67: {
        // 'g' GET — decimal id line
        stack.push(memoGet(parseInt(readLine().trim(), 10)));
        break;
      }
      case 0x68: {
        // 'h' BINGET — 1-byte id
        stack.push(memoGet(readByte()));
        break;
      }
      case 0x6a: {
        // 'j' LONG_BINGET — 4-byte LE id
        stack.push(memoGet(readU32LE()));
        break;
      }

      // ── Globals / class objects ────────────────────────────────────────
      case 0x63: {
        // 'c' GLOBAL — "module\nname\n"
        const module_ = readLine().trim();
        const name = readLine().trim();
        const obj: PickleObject = {
          _type: "obj",
          className: `${module_}.${name}`,
          fields: {},
          args: [],
        };
        stack.push(obj);
        break;
      }

      case 0x93: {
        // STACK_GLOBAL — pop name then module from stack
        const name = popValue();
        const module_ = popValue();
        const className =
          typeof module_ === "string" && typeof name === "string"
            ? `${module_}.${name}`
            : "<unknown>";
        const obj: PickleObject = {
          _type: "obj",
          className,
          fields: {},
          args: [],
        };
        stack.push(obj);
        break;
      }

      // ── Object construction ────────────────────────────────────────────
      case 0x52: {
        // 'R' REDUCE — callable(*args)
        const argsVal = popValue();
        const callable = popValue();
        const argsList: PickleValue[] =
          argsVal && (argsVal as PickleTuple)._type === "tuple"
            ? (argsVal as PickleTuple).items
            : Array.isArray(argsVal)
              ? (argsVal as PickleValue[])
              : [];

        if (callable && (callable as PickleObject)._type === "obj") {
          // Class instantiation
          const cls = callable as PickleObject;
          const newObj: PickleObject = {
            _type: "obj",
            className: cls.className,
            fields: {},
            args: argsList,
          };
          stack.push(newObj);
        } else {
          // Generic call result (e.g. OrderedDict([...]))
          const result: PickleCallResult = {
            _type: "call",
            callable,
            args: argsList,
          };
          stack.push(result);
        }
        break;
      }

      case 0x6f: {
        // 'o' OBJ — MARK cls *args → instance
        const items = popToMark();
        if (items.length === 0) {
          stack.push(null);
          break;
        }
        const [cls, ...args] = items;
        if (cls && (cls as PickleObject)._type === "obj") {
          const newObj: PickleObject = {
            _type: "obj",
            className: (cls as PickleObject).className,
            fields: {},
            args,
          };
          stack.push(newObj);
        } else {
          stack.push(null);
        }
        break;
      }

      case 0x81: {
        // NEWOBJ — cls(*args) where args is a tuple on stack
        const argsVal = popValue();
        const cls = popValue();
        const argsList: PickleValue[] =
          argsVal && (argsVal as PickleTuple)._type === "tuple"
            ? (argsVal as PickleTuple).items
            : [];
        if (cls && (cls as PickleObject)._type === "obj") {
          const newObj: PickleObject = {
            _type: "obj",
            className: (cls as PickleObject).className,
            fields: {},
            args: argsList,
          };
          stack.push(newObj);
        } else {
          stack.push(null);
        }
        break;
      }

      case 0x92: {
        // NEWOBJ_EX — cls(*args, **kwargs)
        popValue(); // kwargs
        const argsVal = popValue();
        const cls = popValue();
        const argsList: PickleValue[] =
          argsVal && (argsVal as PickleTuple)._type === "tuple"
            ? (argsVal as PickleTuple).items
            : [];
        if (cls && (cls as PickleObject)._type === "obj") {
          const newObj: PickleObject = {
            _type: "obj",
            className: (cls as PickleObject).className,
            fields: {},
            args: argsList,
          };
          stack.push(newObj);
        } else {
          stack.push(null);
        }
        break;
      }

      case 0x69: {
        // 'i' INST — "module\nname\n" then pop to MARK as args
        const module_ = readLine().trim();
        const name = readLine().trim();
        const args = popToMark();
        const newObj: PickleObject = {
          _type: "obj",
          className: `${module_}.${name}`,
          fields: {},
          args,
        };
        stack.push(newObj);
        break;
      }

      case 0x62: {
        // 'b' BUILD — set obj.__dict__ or call __setstate__
        //
        // CPython pickle protocol:
        //   • If state is a Map (dict), merge it into obj.__dict__.
        //   • If state is a 2-tuple (slotstate, dictstate):
        //       - dictstate (index 1) is merged into obj.__dict__   if it is a Map / null.
        //       - slotstate (index 0) is merged into obj.__slots__  if it is a Map (rare).
        //   • Ren'Py's Node.__getstate__ returns (None, self.__dict__), so index 0 is
        //     always None and index 1 is the real field dict.  We unpack that here so
        //     that all node fields end up directly in pObj.fields without an extra hop
        //     through a _state key.
        const state = popValue();
        const obj = stack[stack.length - 1];

        // Helper: merge a Map<PickleValue,PickleValue> into a PickleObject's fields.
        const mergeMapIntoObj = (
          m: Map<PickleValue, PickleValue>,
          target: PickleObject,
        ): void => {
          for (const [k, v] of m) {
            if (typeof k === "string") target.fields[k] = v;
          }
        };

        if (obj && (obj as PickleObject)._type === "obj") {
          const pObj = obj as PickleObject;

          if (state instanceof Map) {
            // Plain dict state — merge directly.
            mergeMapIntoObj(state, pObj);
          } else if (
            state !== null &&
            (state as PickleTuple)._type === "tuple"
          ) {
            const tup = state as PickleTuple;
            if (tup.items.length === 2) {
              // Standard (slotstate, dictstate) / (None, __dict__) form.
              const dictState = tup.items[1];
              const slotState = tup.items[0];
              if (dictState instanceof Map) {
                mergeMapIntoObj(dictState, pObj);
              } else if (dictState !== null) {
                // Unusual dictstate — keep as _dictstate for diagnostics.
                pObj.fields["_dictstate"] = dictState;
              }
              if (slotState instanceof Map) {
                // Rare: slots dict — merge in too.
                mergeMapIntoObj(slotState, pObj);
              }
              // slotState === null is the overwhelmingly common case; ignore it.
            } else {
              // Non-standard tuple length — keep as _state for downstream.
              pObj.fields["_state"] = state;
            }
          } else if (state !== null) {
            pObj.fields["_state"] = state;
          }
        } else if (obj instanceof Map) {
          // BUILD on a dict — merge state into it.
          if (state instanceof Map) {
            for (const [k, v] of state)
              (obj as Map<PickleValue, PickleValue>).set(k, v);
          }
        }
        // If obj is null / primitive, discard state silently.
        break;
      }

      case 0x50: {
        // 'P' PERSID — persistent id as ASCII line (rarely used)
        readLine(); // discard
        stack.push(null);
        break;
      }

      case 0x51: {
        // 'Q' BINPERSID — persistent id from stack (rarely used)
        pop(); // discard
        stack.push(null);
        break;
      }

      // ── Stop ──────────────────────────────────────────────────────────
      case 0x2e: {
        // '.' STOP
        return popValue();
      }

      default:
        throw new Error(
          `Unsupported pickle opcode 0x${op.toString(16).padStart(2, "0")} ` +
            `at position ${pos - 1}`,
        );
    }
  }
}

// ─── Convenience accessors ────────────────────────────────────────────────────

/** Type-guard: is this value a PickleObject? */
export function isPickleObject(v: PickleValue): v is PickleObject {
  return (
    v !== null && typeof v === "object" && (v as PickleObject)._type === "obj"
  );
}

/** Type-guard: is this value a PickleTuple? */
export function isPickleTuple(v: PickleValue): v is PickleTuple {
  return (
    v !== null && typeof v === "object" && (v as PickleTuple)._type === "tuple"
  );
}

/**
 * Read a named field from a PickleObject.
 * Returns `undefined` if the object is null/non-object or the field is absent.
 */
export function getField(
  obj: PickleValue,
  key: string,
): PickleValue | undefined {
  if (!isPickleObject(obj)) return undefined;
  return obj.fields[key];
}

/**
 * Return the className short suffix (everything after the last ".").
 * e.g. "renpy.ast.Say" → "Say"
 */
export function shortClass(obj: PickleObject): string {
  const dot = obj.className.lastIndexOf(".");
  return dot >= 0 ? obj.className.slice(dot + 1) : obj.className;
}

/**
 * Coerce a PickleValue to a plain JS string, or return null if impossible.
 */
export function asString(v: PickleValue): string | null {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return new TextDecoder("utf-8").decode(v);
  return null;
}

/**
 * Coerce a PickleValue to a number, or return null if impossible.
 */
export function asNumber(v: PickleValue): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
}

/**
 * Unwrap a PickleValue that is either a raw list or a PickleTuple into a
 * plain JS array.  Returns null if neither.
 */
export function asList(v: PickleValue): PickleValue[] | null {
  if (Array.isArray(v)) return v as PickleValue[];
  if (isPickleTuple(v)) return v.items;
  return null;
}
