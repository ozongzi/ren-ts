pub mod helpers;

use std::collections::HashMap;
use std::io;
use std::sync::Arc;

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PickleObject {
    pub class_name: String,
    pub fields: HashMap<String, PickleValue>,
    pub args: Vec<PickleValue>,
}

#[derive(Debug, Clone)]
pub enum PickleValue {
    None,
    Bool(bool),
    Int(i64),
    Float(f64),
    String(String),
    Bytes(Vec<u8>),
    List(Vec<PickleValue>),
    Tuple(Vec<PickleValue>),
    Dict(Vec<(PickleValue, PickleValue)>),
    Object(Box<PickleObject>),
    Call { callable: Box<PickleValue>, args: Vec<PickleValue> },
}

impl PickleValue {
    pub fn as_object(&self) -> Option<&PickleObject> {
        match self { PickleValue::Object(o) => Some(o), _ => None }
    }
    pub fn as_object_mut(&mut self) -> Option<&mut PickleObject> {
        match self { PickleValue::Object(o) => Some(o), _ => None }
    }
}

// ── Decoder ───────────────────────────────────────────────────────────────────

#[allow(dead_code)]
const MARK: u8 = 0xff;

// Stack items: None = MARK, Some(Arc<V>) = value
// Arc lets memo hold a reference to the same allocation without cloning the tree.
struct Decoder<'a> {
    data:  &'a [u8],
    pos:   usize,
    stack: Vec<Option<Arc<PickleValue>>>,
    memo:  HashMap<u64, Arc<PickleValue>>,
}

impl<'a> Decoder<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0, stack: Vec::new(), memo: HashMap::new() }
    }

    // ── raw I/O ──────────────────────────────────────────────────────────────

    fn read_byte(&mut self) -> io::Result<u8> {
        if self.pos >= self.data.len() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "unexpected end of pickle"));
        }
        let b = self.data[self.pos];
        self.pos += 1;
        Ok(b)
    }

    fn read_bytes(&mut self, n: usize) -> io::Result<&[u8]> {
        if self.pos + n > self.data.len() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "not enough bytes"));
        }
        let s = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    fn read_line(&mut self) -> io::Result<&str> {
        let start = self.pos;
        while self.pos < self.data.len() && self.data[self.pos] != b'\n' {
            self.pos += 1;
        }
        let s = std::str::from_utf8(&self.data[start..self.pos])
            .unwrap_or("");
        if self.pos < self.data.len() { self.pos += 1; }
        Ok(s)
    }

    fn read_u16_le(&mut self) -> io::Result<u16> {
        let b = self.read_bytes(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }
    fn read_u32_le(&mut self) -> io::Result<u32> {
        let b = self.read_bytes(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn read_i32_le(&mut self) -> io::Result<i32> {
        let b = self.read_bytes(4)?;
        Ok(i32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn read_le_signed(&mut self, n: usize) -> io::Result<i64> {
        if n == 0 { return Ok(0); }
        let bytes = self.read_bytes(n)?.to_vec();
        let mut v: i64 = 0;
        for (i, &b) in bytes.iter().enumerate() { v |= (b as i64) << (8 * i); }
        if bytes[n - 1] & 0x80 != 0 { v -= 1i64 << (8 * n); }
        Ok(v)
    }

    // ── stack helpers ────────────────────────────────────────────────────────

    fn push(&mut self, v: PickleValue) {
        self.stack.push(Some(Arc::new(v)));
    }
    fn push_arc(&mut self, v: Arc<PickleValue>) {
        self.stack.push(Some(v));
    }
    fn push_mark(&mut self) { self.stack.push(None); }

    // pop and unwrap the Arc (cheap if refcount==1, else clone)
    fn pop_value(&mut self) -> io::Result<PickleValue> {
        match self.stack.pop() {
            Some(Some(arc)) => Ok(Arc::try_unwrap(arc).unwrap_or_else(|a| (*a).clone())),
            Some(None) => Err(io::Error::new(io::ErrorKind::InvalidData, "unexpected MARK on stack")),
            None => Err(io::Error::new(io::ErrorKind::InvalidData, "stack underflow")),
        }
    }

    fn pop_to_mark(&mut self) -> io::Result<Vec<PickleValue>> {
        let mut items = Vec::new();
        loop {
            match self.stack.pop() {
                Some(None) => break,
                Some(Some(arc)) => items.push(Arc::try_unwrap(arc).unwrap_or_else(|a| (*a).clone())),
                None => return Err(io::Error::new(io::ErrorKind::InvalidData, "MARK not found")),
            }
        }
        items.reverse();
        Ok(items)
    }

    fn peek_top_mut(&mut self) -> io::Result<&mut PickleValue> {
        // If the Arc has refcount > 1 (it's in memo), make_mut() clones it.
        match self.stack.last_mut() {
            Some(Some(arc)) => Ok(Arc::make_mut(arc)),
            _ => Err(io::Error::new(io::ErrorKind::InvalidData, "no value on stack")),
        }
    }

    // ── memo ops — O(1), just clone the Arc pointer ──────────────────────────

    fn memo_put(&mut self, id: u64) {
        if let Some(Some(arc)) = self.stack.last() {
            self.memo.insert(id, Arc::clone(arc));
        }
    }
    fn memo_get(&mut self, id: u64) -> io::Result<()> {
        let arc = self.memo.get(&id)
            .map(Arc::clone)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData,
                format!("memo miss for id {}", id)))?;
        self.push_arc(arc);
        Ok(())
    }

    // ── dict/object mutation ─────────────────────────────────────────────────

    fn dict_set(top: &mut PickleValue, k: PickleValue, v: PickleValue) {
        match top {
            PickleValue::Dict(pairs) => pairs.push((k, v)),
            PickleValue::Object(obj) => {
                if let PickleValue::String(s) = k { obj.fields.insert(s, v); }
            }
            _ => {}
        }
    }

    // ── main decode loop ─────────────────────────────────────────────────────

    pub fn decode(&mut self) -> io::Result<PickleValue> {
        loop {
            let op = self.read_byte()?;
            match op {
                0x80 => { self.read_byte()?; }          // PROTO n
                0x95 => { self.read_bytes(8)?; }         // FRAME (8-byte len)

                // constants
                0x4e => self.push(PickleValue::None),
                0x54 => self.push(PickleValue::Bool(true)),   // 'T' NEWTRUE (old)
                0x46 => self.push(PickleValue::Bool(false)),  // 'F' NEWFALSE (old)
                0x88 => self.push(PickleValue::Bool(true)),
                0x89 => self.push(PickleValue::Bool(false)),

                // integers
                0x49 => {
                    let line = self.read_line()?.to_string();
                    if line == "00" { self.push(PickleValue::Bool(false)); }
                    else if line == "01" { self.push(PickleValue::Bool(true)); }
                    else { self.push(PickleValue::Int(line.trim().parse().unwrap_or(0))); }
                }
                0x4b => { let b = self.read_byte()?; self.push(PickleValue::Int(b as i64)); }
                0x4d => { let v = self.read_u16_le()?; self.push(PickleValue::Int(v as i64)); }
                0x4a => { let v = self.read_i32_le()?; self.push(PickleValue::Int(v as i64)); }
                0x4c => {
                    let line = self.read_line()?;
                    let n: i64 = line.trim().trim_end_matches('L').parse().unwrap_or(0);
                    self.push(PickleValue::Int(n));
                }
                0x8a => { let n = self.read_byte()? as usize; let v = self.read_le_signed(n)?; self.push(PickleValue::Int(v)); }
                0x8b => { let n = self.read_u32_le()? as usize; let v = self.read_le_signed(n)?; self.push(PickleValue::Int(v)); }

                // float
                0x47 => {
                    let b = self.read_bytes(8)?.to_vec();
                    self.push(PickleValue::Float(f64::from_be_bytes(b.try_into().unwrap())));
                }

                // strings
                0x53 => { let line = self.read_line()?.to_string(); self.push(PickleValue::String(unescape_py_string(line.trim()))); }
                0x55 => { // SHORT_BINSTRING 1-byte len
                    let n = self.read_byte()? as usize;
                    let b = self.read_bytes(n)?.to_vec();
                    self.push(PickleValue::String(String::from_utf8_lossy(&b).into_owned()));
                }
                0x56 => { let line = self.read_line()?.to_string(); self.push(PickleValue::String(line.trim().to_string())); }
                0x58 => { // BINUNICODE 4-byte len
                    let n = self.read_u32_le()? as usize;
                    let b = self.read_bytes(n)?.to_vec();
                    self.push(PickleValue::String(String::from_utf8_lossy(&b).into_owned()));
                }
                0x8c => { // SHORT_BINUNICODE 1-byte len
                    let n = self.read_byte()? as usize;
                    let b = self.read_bytes(n)?.to_vec();
                    self.push(PickleValue::String(String::from_utf8_lossy(&b).into_owned()));
                }
                0x8d => { // BINUNICODE8
                    let n = u64::from_le_bytes(self.read_bytes(8)?.try_into().unwrap()) as usize;
                    let b = self.read_bytes(n)?.to_vec();
                    self.push(PickleValue::String(String::from_utf8_lossy(&b).into_owned()));
                }

                // bytes
                0x42 => { let n = self.read_u32_le()? as usize; let b = self.read_bytes(n)?.to_vec(); self.push(PickleValue::Bytes(b)); }
                0x43 => { let n = self.read_byte()? as usize;   let b = self.read_bytes(n)?.to_vec(); self.push(PickleValue::Bytes(b)); }
                0x8e => { let n = u64::from_le_bytes(self.read_bytes(8)?.try_into().unwrap()) as usize; let b = self.read_bytes(n)?.to_vec(); self.push(PickleValue::Bytes(b)); }
                0x8f => { let n = u64::from_le_bytes(self.read_bytes(8)?.try_into().unwrap()) as usize; let b = self.read_bytes(n)?.to_vec(); self.push(PickleValue::Bytes(b)); }

                // mark / collections
                0x28 => self.push_mark(),
                0x5d => self.push(PickleValue::List(Vec::new())),
                0x6c => { let items = self.pop_to_mark()?; self.push(PickleValue::List(items)); }
                0x61 => { // APPEND
                    let v = self.pop_value()?;
                    if let Some(Some(arc)) = self.stack.last_mut() {
                        if let Some(PickleValue::List(list)) = Arc::get_mut(arc).map(|x| x) {
                            list.push(v);
                        } else {
                            // arc is shared (in memo); make_mut clones it
                            if let PickleValue::List(list) = Arc::make_mut(arc) { list.push(v); }
                        }
                    }
                }
                0x65 => { // APPENDS
                    let items = self.pop_to_mark()?;
                    if let Some(Some(arc)) = self.stack.last_mut() {
                        if let PickleValue::List(list) = Arc::make_mut(arc) { list.extend(items); }
                    }
                }
                0x29 => self.push(PickleValue::Tuple(Vec::new())),
                0x74 => { let items = self.pop_to_mark()?; self.push(PickleValue::Tuple(items)); }
                0x85 => { let a = self.pop_value()?; self.push(PickleValue::Tuple(vec![a])); }
                0x86 => { let b = self.pop_value()?; let a = self.pop_value()?; self.push(PickleValue::Tuple(vec![a,b])); }
                0x87 => { let c = self.pop_value()?; let b = self.pop_value()?; let a = self.pop_value()?; self.push(PickleValue::Tuple(vec![a,b,c])); }

                0x7d => self.push(PickleValue::Dict(Vec::new())),
                0x64 => {
                    let items = self.pop_to_mark()?;
                    let pairs = items.chunks(2).filter(|c| c.len()==2).map(|c| (c[0].clone(), c[1].clone())).collect();
                    self.push(PickleValue::Dict(pairs));
                }
                0x73 => { let v = self.pop_value()?; let k = self.pop_value()?; let top = self.peek_top_mut()?; Self::dict_set(top, k, v); }
                0x75 => {
                    let items = self.pop_to_mark()?;
                    let top = self.peek_top_mut()?;
                    for chunk in items.chunks(2) {
                        if chunk.len() == 2 { Self::dict_set(top, chunk[0].clone(), chunk[1].clone()); }
                    }
                }
                0x90 => { let items = self.pop_to_mark()?; self.push(PickleValue::List(items)); } // FROZENSET → list

                // globals / objects
                0x63 => {
                    let module = self.read_line()?.trim().to_string();
                    let name   = self.read_line()?.trim().to_string();
                    self.push(PickleValue::Object(Box::new(PickleObject { class_name: format!("{}.{}", module, name), fields: HashMap::new(), args: vec![] })));
                }
                0x93 => {
                    let name   = self.pop_value()?;
                    let module = self.pop_value()?;
                    self.push(PickleValue::Object(Box::new(PickleObject { class_name: format!("{}.{}", val_to_str(&module), val_to_str(&name)), fields: HashMap::new(), args: vec![] })));
                }
                0x52 => { // REDUCE
                    let args_val = self.pop_value()?;
                    let callable = self.pop_value()?;
                    let args = match args_val { PickleValue::Tuple(t) => t, _ => vec![] };
                    if let Some(obj) = callable.as_object() {
                        let cn = obj.class_name.clone();
                        self.push(PickleValue::Object(Box::new(PickleObject { class_name: cn, fields: HashMap::new(), args })));
                    } else {
                        self.push(PickleValue::Call { callable: Box::new(callable), args });
                    }
                }
                0x81 => { // NEWOBJ
                    let args_val = self.pop_value()?;
                    let cls = self.pop_value()?;
                    let args = match args_val { PickleValue::Tuple(t) => t, _ => vec![] };
                    let cn = cls.as_object().map(|o| o.class_name.clone()).unwrap_or_default();
                    self.push(PickleValue::Object(Box::new(PickleObject { class_name: cn, fields: HashMap::new(), args })));
                }
                0x92 => { // NEWOBJ_EX
                    self.pop_value()?; // kwargs
                    let args_val = self.pop_value()?;
                    let cls = self.pop_value()?;
                    let args = match args_val { PickleValue::Tuple(t) => t, _ => vec![] };
                    let cn = cls.as_object().map(|o| o.class_name.clone()).unwrap_or_default();
                    self.push(PickleValue::Object(Box::new(PickleObject { class_name: cn, fields: HashMap::new(), args })));
                }
                0x6f => { // OBJ
                    let items = self.pop_to_mark()?;
                    if items.is_empty() { self.push(PickleValue::None); continue; }
                    let cn = items[0].as_object().map(|o| o.class_name.clone()).unwrap_or_default();
                    self.push(PickleValue::Object(Box::new(PickleObject { class_name: cn, fields: HashMap::new(), args: items[1..].to_vec() })));
                }
                0x69 => { // INST
                    let module = self.read_line()?.trim().to_string();
                    let name   = self.read_line()?.trim().to_string();
                    let args   = self.pop_to_mark()?;
                    self.push(PickleValue::Object(Box::new(PickleObject { class_name: format!("{}.{}", module, name), fields: HashMap::new(), args })));
                }
                0x62 => { let state = self.pop_value()?; let top = self.peek_top_mut()?; build_state(top, state); } // BUILD

                // memo — O(1) Arc clone
                0x70 => { let line = self.read_line()?; let id: u64 = line.trim().parse().unwrap_or(0); self.memo_put(id); }
                0x71 => { let id = self.read_byte()? as u64;    self.memo_put(id); }
                0x72 => { let id = self.read_u32_le()? as u64;  self.memo_put(id); }
                0x94 => { let id = self.memo.len() as u64;      self.memo_put(id); }
                0x67 => { let line = self.read_line()?; let id: u64 = line.trim().parse().unwrap_or(0); self.memo_get(id)?; }
                0x68 => { let id = self.read_byte()? as u64;    self.memo_get(id)?; }
                0x6a => { let id = self.read_u32_le()? as u64;  self.memo_get(id)?; }

                0x32 => { // DUP
                    let v = match self.stack.last() {
                        Some(Some(arc)) => Arc::clone(arc),
                        _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "DUP on empty stack")),
                    };
                    self.push_arc(v);
                }
                0x30 => { self.stack.pop(); }           // POP
                0x31 => { while let Some(item) = self.stack.pop() { if item.is_none() { break; } } } // POP_MARK
                0x50 => { self.read_line()?; self.push(PickleValue::None); }   // PERSID
                0x51 => { self.stack.pop(); self.push(PickleValue::None); }    // BINPERSID

                0x2e => return self.pop_value(), // STOP

                other => return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("unsupported pickle opcode 0x{:02x} at pos {}", other, self.pos - 1),
                )),
            }
        }
    }
}

// ── BUILD ─────────────────────────────────────────────────────────────────────

fn build_state(top: &mut PickleValue, state: PickleValue) {
    let obj = match top {
        PickleValue::Object(o) => o,
        PickleValue::Dict(pairs) => {
            if let PickleValue::Dict(new_pairs) = state { pairs.extend(new_pairs); }
            return;
        }
        _ => return,
    };
    match state {
        PickleValue::Dict(pairs) => {
            for (k, v) in pairs {
                if let PickleValue::String(s) = k { obj.fields.insert(s, v); }
            }
        }
        PickleValue::Tuple(ref items) if items.len() == 2 => {
            let dict_state = items[1].clone();
            let slot_state = items[0].clone();
            if let PickleValue::Dict(pairs) = dict_state {
                for (k, v) in pairs { if let PickleValue::String(s) = k { obj.fields.insert(s, v); } }
            } else if !matches!(dict_state, PickleValue::None) {
                obj.fields.insert("_dictstate".to_string(), dict_state);
            }
            if let PickleValue::Dict(pairs) = slot_state {
                for (k, v) in pairs { if let PickleValue::String(s) = k { obj.fields.insert(s, v); } }
            }
        }
        other => { if !matches!(other, PickleValue::None) { obj.fields.insert("_state".to_string(), other); } }
    }
}

// ── helpers ───────────────────────────────────────────────────────────────────

fn unescape_py_string(s: &str) -> String {
    let inner = if s.len() >= 2 && ((s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\''))) {
        &s[1..s.len()-1]
    } else { s };
    let mut result = String::with_capacity(inner.len());
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n')  => result.push('\n'),
                Some('t')  => result.push('\t'),
                Some('r')  => result.push('\r'),
                Some('\\') => result.push('\\'),
                Some('\'') => result.push('\''),
                Some('"')  => result.push('"'),
                Some(o)    => { result.push('\\'); result.push(o); }
                None       => result.push('\\'),
            }
        } else { result.push(c); }
    }
    result
}

fn val_to_str(v: &PickleValue) -> &str {
    match v { PickleValue::String(s) => s, _ => "" }
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn decode(data: &[u8]) -> io::Result<PickleValue> {
    Decoder::new(data).decode()
}
