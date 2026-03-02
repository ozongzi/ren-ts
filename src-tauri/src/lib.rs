// ─── Ren'Ts – Tauri v2 application library ────────────────────────────
//
// Plugins registered:
//   • tauri-plugin-dialog  – directory / file pickers
//   • tauri-plugin-fs      – text file read / write for save-game persistence
//
// Commands:
//   • commands::build_zip       – stream-write a ZIP archive entirely in Rust;
//                                 never sends file bytes across the IPC boundary.
//   • rpa::list_rpa             – parse an RPA-2/3 archive and return the list
//                                 of file paths stored inside it.
//   • rpa::read_rpa_entry       – read the raw bytes of one entry from an RPA
//                                 archive; returned as a Vec<u8> (base64-encoded
//                                 by Tauri's IPC layer automatically).
//
// build_zip accepts three kinds of entries:
//   • ZipEntry        – source file on disk  (abs_path + zip_path)
//   • RpaZipEntry     – file inside an RPA archive (rpa_path + entry_path + zip_path)
//   • VirtualZipEntry – inline UTF-8 content (content + zip_path)
//
// ─── RPA format notes ────────────────────────────────────────────────────────
//
// Ren'Py ships its game assets inside ".rpa" archive files.  The format is
// intentionally simple:
//
//   Line 1 (ASCII):
//     RPA-3.0  →  "RPA-3.0 <hex_offset> <hex_key>\n"
//     RPA-2.0  →  "RPA-2.0 <hex_offset>\n"          (key = 0)
//
//   At <hex_offset>: zlib-compressed Python pickle that deserialises to
//     { "path/inside/archive" : [(data_offset, data_length, prefix_bytes), …] }
//
//   Each file's real offset/length is recovered by XOR-ing with the key:
//     real_offset = stored_offset ^ key
//     real_length = stored_length ^ key
//
//   File bytes are stored raw (no further compression) and can be read with a
//   single seek + read.
//
// We implement a minimal pickle reader that handles only the opcodes that
// Ren'Py actually writes, rather than pulling in a full Python runtime.

// ─── ZIP builder ─────────────────────────────────────────────────────────────

mod commands {
    use std::fs::{self, File};
    use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
    use std::path::Path;

    use serde::{Deserialize, Serialize};
    use tauri::async_runtime::spawn_blocking;
    use tauri::{AppHandle, Emitter};
    use zip::write::{FileOptions, ZipWriter};
    use zip::CompressionMethod;

    // ─── Types shared with the JS side ───────────────────────────────────────

    /// A file that already exists on disk.
    #[derive(Debug, Deserialize)]
    pub struct ZipEntry {
        /// Absolute path of the source file on disk.
        pub abs_path: String,
        /// Path to store inside the ZIP archive (forward-slash, no leading slash).
        pub zip_path: String,
    }

    /// A file sourced from inside an RPA archive.
    /// Rust reads the bytes directly from the RPA — nothing crosses the IPC boundary.
    #[derive(Debug, Deserialize)]
    pub struct RpaZipEntry {
        /// Absolute path to the .rpa file on disk.
        pub rpa_path: String,
        /// In-archive path as returned by list_rpa (e.g. "images/bg/day.png").
        pub entry_path: String,
        /// Path to store inside the output ZIP archive.
        pub zip_path: String,
    }

    /// An in-memory text file – never touches the filesystem.
    #[derive(Debug, Deserialize)]
    pub struct VirtualZipEntry {
        /// UTF-8 text content to write directly into the archive.
        pub content: String,
        /// Path to store inside the ZIP archive (forward-slash, no leading slash).
        pub zip_path: String,
    }

    #[derive(Debug, Serialize, Clone)]
    pub struct ZipProgressPayload {
        /// 0-based index of the entry just written (disk + rpa + virtual combined).
        pub index: usize,
        pub total: usize,
        pub zip_path: String,
        /// Cumulative uncompressed bytes written so far.
        pub bytes_written: u64,
    }

    #[derive(Debug, Serialize, Clone)]
    pub struct ZipSkipPayload {
        pub abs_path: String,
        pub zip_path: String,
        pub reason: String,
    }

    // ─── Extensions that benefit from DEFLATE compression ────────────────────

    fn should_deflate(zip_path: &str) -> bool {
        let lower = zip_path.to_lowercase();
        matches!(
            lower.rsplit('.').next().unwrap_or(""),
            "rrs" | "json" | "txt" | "xml" | "html" | "css" | "js" | "svg"
        )
    }

    // ─── Tauri command ────────────────────────────────────────────────────────

    /// Build a ZIP archive from `entries` (disk files), `rpa_entries` (files
    /// sourced from RPA archives) and `virtual_entries` (in-memory text),
    /// writing directly to `output_path`.
    #[tauri::command]
    pub async fn build_zip(
        app: AppHandle,
        output_path: String,
        entries: Vec<ZipEntry>,
        rpa_entries: Option<Vec<RpaZipEntry>>,
        virtual_entries: Option<Vec<VirtualZipEntry>>,
    ) -> Result<usize, String> {
        spawn_blocking(move || {
            build_zip_blocking(app, output_path, entries, rpa_entries, virtual_entries)
        })
        .await
        .map_err(|e| format!("spawn_blocking panicked: {e}"))?
    }

    fn build_zip_blocking(
        app: AppHandle,
        output_path: String,
        entries: Vec<ZipEntry>,
        rpa_entries: Option<Vec<RpaZipEntry>>,
        virtual_entries: Option<Vec<VirtualZipEntry>>,
    ) -> Result<usize, String> {
        // Ensure parent directory exists.
        let out = Path::new(&output_path);
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create output directory: {e}"))?;
        }

        // Open (create / truncate) the output file.
        let file =
            File::create(out).map_err(|e| format!("Failed to create output ZIP file: {e}"))?;
        // 256 KiB write buffer so small header writes are coalesced.
        let buf_writer = BufWriter::with_capacity(256 * 1024, file);
        let mut zip = ZipWriter::new(buf_writer);

        let rpa = rpa_entries.unwrap_or_default();
        let virt = virtual_entries.unwrap_or_default();
        let total = entries.len() + rpa.len() + virt.len();
        let mut written: usize = 0;
        let mut bytes_written: u64 = 0;

        // Single reusable read buffer — avoids per-file allocation.
        let mut buf = vec![0u8; 128 * 1024];

        // ── Disk entries ──────────────────────────────────────────────────────
        for (index, entry) in entries.iter().enumerate() {
            let src = Path::new(&entry.abs_path);

            // Open source file; skip on error and emit a skip event.
            let src_file = match File::open(src) {
                Ok(f) => f,
                Err(e) => {
                    let _ = app.emit(
                        "zip://skip",
                        ZipSkipPayload {
                            abs_path: entry.abs_path.clone(),
                            zip_path: entry.zip_path.clone(),
                            reason: e.to_string(),
                        },
                    );
                    continue;
                }
            };

            let method = if should_deflate(&entry.zip_path) {
                CompressionMethod::Deflated
            } else {
                CompressionMethod::Stored
            };

            let options: FileOptions<'_, ()> = FileOptions::default()
                .compression_method(method)
                .unix_permissions(0o644);

            if let Err(e) = zip.start_file(&entry.zip_path, options) {
                let _ = app.emit(
                    "zip://skip",
                    ZipSkipPayload {
                        abs_path: entry.abs_path.clone(),
                        zip_path: entry.zip_path.clone(),
                        reason: format!("zip::start_file failed: {e}"),
                    },
                );
                continue;
            }

            // Stream source → ZIP writer in 128 KiB chunks.
            let mut reader = BufReader::with_capacity(128 * 1024, src_file);
            let mut file_bytes: u64 = 0;
            loop {
                let n = reader
                    .read(&mut buf)
                    .map_err(|e| format!("Read error on {}: {e}", entry.abs_path))?;
                if n == 0 {
                    break;
                }
                zip.write_all(&buf[..n])
                    .map_err(|e| format!("Write error for {}: {e}", entry.zip_path))?;
                file_bytes += n as u64;
            }

            bytes_written += file_bytes;
            written += 1;

            let _ = app.emit(
                "zip://progress",
                ZipProgressPayload {
                    index,
                    total,
                    zip_path: entry.zip_path.clone(),
                    bytes_written,
                },
            );
        }

        // ── RPA-sourced entries ───────────────────────────────────────────────
        //
        // Each entry is read directly from the RPA file on disk via seek+read.
        // No bytes ever cross the IPC boundary — Rust does everything natively.
        // Binary assets (images, audio, video) are stored with STORE method;
        // text-like files (.rpy, .json, …) get DEFLATE, same as disk entries.
        //
        // We parse the RPA index once per unique rpa_path to avoid redundant
        // zlib+pickle work when several entries come from the same archive.
        let disk_count = entries.len();

        // Build a per-rpa-path index cache for this batch.
        let mut rpa_index_cache: std::collections::HashMap<String, crate::rpa::RpaIndex> =
            std::collections::HashMap::new();

        for (rpa_idx, rentry) in rpa.iter().enumerate() {
            let index = disk_count + rpa_idx;

            // Fetch (or parse and cache) the index for this RPA file.
            let rpa_index = match rpa_index_cache.entry(rentry.rpa_path.clone()) {
                std::collections::hash_map::Entry::Occupied(o) => o.into_mut(),
                std::collections::hash_map::Entry::Vacant(v) => {
                    match crate::rpa::parse_rpa_index(&rentry.rpa_path) {
                        Ok(idx) => v.insert(idx),
                        Err(e) => {
                            let _ = app.emit(
                                "zip://skip",
                                ZipSkipPayload {
                                    abs_path: rentry.rpa_path.clone(),
                                    zip_path: rentry.zip_path.clone(),
                                    reason: format!("RPA index error: {e}"),
                                },
                            );
                            continue;
                        }
                    }
                }
            };

            // Look up the specific entry inside the index.
            let (offset, length) = match rpa_index.get(&rentry.entry_path) {
                Some(e) => (e.offset, e.length),
                None => {
                    let _ = app.emit(
                        "zip://skip",
                        ZipSkipPayload {
                            abs_path: rentry.rpa_path.clone(),
                            zip_path: rentry.zip_path.clone(),
                            reason: format!("entry {:?} not found in RPA", rentry.entry_path),
                        },
                    );
                    continue;
                }
            };

            // Open the RPA file and seek to the entry's data.
            let mut rpa_file = match File::open(&rentry.rpa_path) {
                Ok(f) => f,
                Err(e) => {
                    let _ = app.emit(
                        "zip://skip",
                        ZipSkipPayload {
                            abs_path: rentry.rpa_path.clone(),
                            zip_path: rentry.zip_path.clone(),
                            reason: format!("Cannot open RPA: {e}"),
                        },
                    );
                    continue;
                }
            };

            if let Err(e) = rpa_file.seek(SeekFrom::Start(offset)) {
                let _ = app.emit(
                    "zip://skip",
                    ZipSkipPayload {
                        abs_path: rentry.rpa_path.clone(),
                        zip_path: rentry.zip_path.clone(),
                        reason: format!("Seek failed: {e}"),
                    },
                );
                continue;
            }

            let method = if should_deflate(&rentry.zip_path) {
                CompressionMethod::Deflated
            } else {
                CompressionMethod::Stored
            };

            let options: FileOptions<'_, ()> = FileOptions::default()
                .compression_method(method)
                .unix_permissions(0o644);

            if let Err(e) = zip.start_file(&rentry.zip_path, options) {
                let _ = app.emit(
                    "zip://skip",
                    ZipSkipPayload {
                        abs_path: rentry.rpa_path.clone(),
                        zip_path: rentry.zip_path.clone(),
                        reason: format!("zip::start_file failed: {e}"),
                    },
                );
                continue;
            }

            // Stream exactly `length` bytes from the RPA into the ZIP.
            let mut remaining = length;
            let mut file_bytes: u64 = 0;
            while remaining > 0 {
                let to_read = (remaining as usize).min(buf.len());
                let n = match rpa_file.read(&mut buf[..to_read]) {
                    Ok(n) => n,
                    Err(e) => return Err(format!("Read error from RPA {}: {e}", rentry.rpa_path)),
                };
                if n == 0 {
                    // Premature EOF — entry will be truncated but we don't panic.
                    break;
                }
                zip.write_all(&buf[..n])
                    .map_err(|e| format!("Write error for RPA entry {}: {e}", rentry.zip_path))?;
                file_bytes += n as u64;
                remaining -= n as u64;
            }

            bytes_written += file_bytes;
            written += 1;

            let _ = app.emit(
                "zip://progress",
                ZipProgressPayload {
                    index,
                    total,
                    zip_path: rentry.zip_path.clone(),
                    bytes_written,
                },
            );
        }

        // ── Virtual (in-memory) entries ───────────────────────────────────────
        //
        // These are always text, so always DEFLATE-compressed.
        // They are emitted after all disk + RPA entries; the combined index
        // sequence is contiguous so the JS progress bar advances smoothly.
        let disk_and_rpa_count = entries.len() + rpa.len();
        for (virt_idx, ventry) in virt.iter().enumerate() {
            let index = disk_and_rpa_count + virt_idx;

            let options: FileOptions<'_, ()> = FileOptions::default()
                .compression_method(CompressionMethod::Deflated)
                .unix_permissions(0o644);

            if let Err(e) = zip.start_file(&ventry.zip_path, options) {
                let _ = app.emit(
                    "zip://skip",
                    ZipSkipPayload {
                        abs_path: String::new(),
                        zip_path: ventry.zip_path.clone(),
                        reason: format!("zip::start_file failed for virtual entry: {e}"),
                    },
                );
                continue;
            }

            let content_bytes = ventry.content.as_bytes();
            zip.write_all(content_bytes)
                .map_err(|e| format!("Write error for virtual {}: {e}", ventry.zip_path))?;

            bytes_written += content_bytes.len() as u64;
            written += 1;

            let _ = app.emit(
                "zip://progress",
                ZipProgressPayload {
                    index,
                    total,
                    zip_path: ventry.zip_path.clone(),
                    bytes_written,
                },
            );
        }

        // Finalise — writes Central Directory + End-of-Central-Directory.
        zip.finish()
            .map_err(|e| format!("Failed to finalise ZIP: {e}"))?;

        Ok(written)
    }
}

// ─── RPA archive parser ───────────────────────────────────────────────────────

mod rpa {
    use std::collections::HashMap;
    use std::fs::File;
    use std::io::{self, Read, Seek, SeekFrom};

    use flate2::read::ZlibDecoder;
    use tauri::async_runtime::spawn_blocking;

    // ─── Public entry type ────────────────────────────────────────────────────

    /// One file stored inside an RPA archive.
    #[derive(Debug, Clone)]
    #[allow(dead_code)]
    pub struct RpaEntry {
        /// Byte offset of the file's data within the RPA file.
        pub offset: u64,
        /// Number of bytes to read (after the optional prefix).
        pub length: u64,
        /// Bytes prepended by Ren'Py before the real file data (usually empty).
        pub prefix: Vec<u8>,
    }

    pub type RpaIndex = HashMap<String, RpaEntry>;

    // ─── Header parsing ───────────────────────────────────────────────────────

    fn parse_header(line: &str) -> Result<(u64, u64), String> {
        let line = line.trim_end_matches('\n').trim_end_matches('\r');

        if let Some(rest) = line.strip_prefix("RPA-3.0 ") {
            let parts: Vec<&str> = rest.split_whitespace().collect();
            if parts.len() < 2 {
                return Err(format!("Malformed RPA-3.0 header: {line:?}"));
            }
            let offset = u64::from_str_radix(parts[0], 16)
                .map_err(|e| format!("Bad RPA-3.0 offset: {e}"))?;
            let key =
                u64::from_str_radix(parts[1], 16).map_err(|e| format!("Bad RPA-3.0 key: {e}"))?;
            Ok((offset, key))
        } else if let Some(rest) = line.strip_prefix("RPA-2.0 ") {
            let hex = rest.split_whitespace().next().unwrap_or(rest);
            let offset =
                u64::from_str_radix(hex, 16).map_err(|e| format!("Bad RPA-2.0 offset: {e}"))?;
            Ok((offset, 0))
        } else {
            Err(format!("Unknown RPA format: {line:?}"))
        }
    }

    // ─── Minimal pickle reader ────────────────────────────────────────────────
    //
    // Ren'Py writes its RPA index with pickle protocol 2.  The structure is
    // always a dict whose values are lists of 2- or 3-tuples.  We only need
    // to handle the opcodes that actually appear in that output.

    #[derive(Debug, Clone)]
    enum Pv {
        Int(i64),
        Bytes(Vec<u8>),
        Str(String),
        List(Vec<Pv>),
        Tuple(Vec<Pv>),
        Dict(Vec<(Pv, Pv)>),
        None,
        Mark,
    }

    struct PickleReader<'a> {
        buf: &'a [u8],
        pos: usize,
        stack: Vec<Pv>,
        memo: HashMap<u32, Pv>,
    }

    impl<'a> PickleReader<'a> {
        fn new(buf: &'a [u8]) -> Self {
            PickleReader {
                buf,
                pos: 0,
                stack: Vec::new(),
                memo: HashMap::new(),
            }
        }

        fn read_byte(&mut self) -> Result<u8, String> {
            if self.pos >= self.buf.len() {
                return Err("Unexpected end of pickle stream".into());
            }
            let b = self.buf[self.pos];
            self.pos += 1;
            Ok(b)
        }

        fn read_exact(&mut self, n: usize) -> Result<&[u8], String> {
            if self.pos + n > self.buf.len() {
                return Err(format!(
                    "Need {n} bytes at pos {} but only {} remain",
                    self.pos,
                    self.buf.len() - self.pos
                ));
            }
            let slice = &self.buf[self.pos..self.pos + n];
            self.pos += n;
            Ok(slice)
        }

        fn read_line(&mut self) -> Result<Vec<u8>, String> {
            let start = self.pos;
            while self.pos < self.buf.len() && self.buf[self.pos] != b'\n' {
                self.pos += 1;
            }
            let end = self.pos;
            if self.pos < self.buf.len() {
                self.pos += 1; // consume '\n'
            }
            Ok(self.buf[start..end].to_vec())
        }

        fn pop(&mut self) -> Result<Pv, String> {
            self.stack
                .pop()
                .ok_or_else(|| "Pickle stack underflow".to_string())
        }

        fn pop_to_mark(&mut self) -> Result<Vec<Pv>, String> {
            let mut items = Vec::new();
            loop {
                match self.stack.pop() {
                    None => return Err("No MARK on pickle stack".into()),
                    Some(Pv::Mark) => break,
                    Some(v) => items.push(v),
                }
            }
            items.reverse();
            Ok(items)
        }

        fn peek_top_as_dict_mut(&mut self) -> Result<&mut Vec<(Pv, Pv)>, String> {
            match self.stack.last_mut() {
                Some(Pv::Dict(d)) => Ok(d),
                _ => Err("Expected dict on top of pickle stack".into()),
            }
        }

        fn peek_top_as_list_mut(&mut self) -> Result<&mut Vec<Pv>, String> {
            match self.stack.last_mut() {
                Some(Pv::List(l)) => Ok(l),
                _ => Err("Expected list on top of pickle stack".into()),
            }
        }

        fn read_value(&mut self) -> Result<Pv, String> {
            loop {
                let op = self.read_byte()?;
                match op {
                    // ── Protocol / no-op ─────────────────────────────────────
                    0x80 => {
                        self.read_byte()?;
                    } // PROTO

                    // ── Stack manipulation ────────────────────────────────────
                    b'(' => self.stack.push(Pv::Mark),
                    b')' => self.stack.push(Pv::Tuple(vec![])),
                    b']' => self.stack.push(Pv::List(vec![])),
                    b'}' => self.stack.push(Pv::Dict(vec![])),
                    b'0' => {
                        self.pop()?;
                    } // POP
                    b'2' => {
                        // DUP
                        let top = self.pop()?;
                        let dup = top.clone();
                        self.stack.push(top);
                        self.stack.push(dup);
                    }

                    // ── Tuples ────────────────────────────────────────────────
                    b't' => {
                        let items = self.pop_to_mark()?;
                        self.stack.push(Pv::Tuple(items));
                    }
                    0x85 => {
                        let a = self.pop()?;
                        self.stack.push(Pv::Tuple(vec![a]));
                    }
                    0x86 => {
                        let b = self.pop()?;
                        let a = self.pop()?;
                        self.stack.push(Pv::Tuple(vec![a, b]));
                    }
                    0x87 => {
                        let c = self.pop()?;
                        let b = self.pop()?;
                        let a = self.pop()?;
                        self.stack.push(Pv::Tuple(vec![a, b, c]));
                    }

                    // ── Lists ─────────────────────────────────────────────────
                    b'l' => {
                        let items = self.pop_to_mark()?;
                        self.stack.push(Pv::List(items));
                    }
                    b'a' => {
                        let item = self.pop()?;
                        self.peek_top_as_list_mut()?.push(item);
                    }
                    b'e' => {
                        let items = self.pop_to_mark()?;
                        let list = self.peek_top_as_list_mut()?;
                        list.extend(items);
                    }

                    // ── Dicts ─────────────────────────────────────────────────
                    b'd' => {
                        let mut items = self.pop_to_mark()?;
                        let mut pairs = Vec::new();
                        while items.len() >= 2 {
                            let v = items.pop().unwrap();
                            let k = items.pop().unwrap();
                            pairs.push((k, v));
                        }
                        pairs.reverse();
                        self.stack.push(Pv::Dict(pairs));
                    }
                    b's' => {
                        let val = self.pop()?;
                        let key = self.pop()?;
                        self.peek_top_as_dict_mut()?.push((key, val));
                    }
                    b'u' => {
                        let mut items = self.pop_to_mark()?;
                        let mut pairs = Vec::new();
                        while items.len() >= 2 {
                            let v = items.pop().unwrap();
                            let k = items.pop().unwrap();
                            pairs.push((k, v));
                        }
                        pairs.reverse();
                        self.peek_top_as_dict_mut()?.extend(pairs);
                    }

                    // ── Integers ─────────────────────────────────────────────
                    b'K' => {
                        let b = self.read_byte()?;
                        self.stack.push(Pv::Int(b as i64));
                    }
                    b'M' => {
                        let raw = self.read_exact(2)?.to_vec();
                        let v = u16::from_le_bytes([raw[0], raw[1]]) as i64;
                        self.stack.push(Pv::Int(v));
                    }
                    b'J' => {
                        let raw = self.read_exact(4)?.to_vec();
                        let v = i32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]) as i64;
                        self.stack.push(Pv::Int(v));
                    }
                    b'I' => {
                        let line = self.read_line()?;
                        let s = std::str::from_utf8(&line)
                            .map_err(|e| format!("INT decode: {e}"))?
                            .trim()
                            .to_string();
                        let v: i64 = s.parse().map_err(|e| format!("INT parse {s:?}: {e}"))?;
                        self.stack.push(Pv::Int(v));
                    }
                    b'L' => {
                        let line = self.read_line()?;
                        let s = std::str::from_utf8(&line)
                            .map_err(|e| format!("LONG decode: {e}"))?
                            .trim_end_matches('L')
                            .trim()
                            .to_string();
                        let v: i64 = s.parse().map_err(|e| format!("LONG parse {s:?}: {e}"))?;
                        self.stack.push(Pv::Int(v));
                    }
                    0x8a => {
                        let n = self.read_byte()? as usize;
                        let raw = self.read_exact(n)?.to_vec();
                        let v = read_le_signed(&raw);
                        self.stack.push(Pv::Int(v));
                    }
                    0x8b => {
                        let len_bytes = self.read_exact(4)?.to_vec();
                        let n = u32::from_le_bytes([
                            len_bytes[0],
                            len_bytes[1],
                            len_bytes[2],
                            len_bytes[3],
                        ]) as usize;
                        let raw = self.read_exact(n)?.to_vec();
                        let v = read_le_signed(&raw);
                        self.stack.push(Pv::Int(v));
                    }

                    // ── Strings / bytes ───────────────────────────────────────
                    b'T' => {
                        let len_bytes = self.read_exact(4)?.to_vec();
                        let n = u32::from_le_bytes([
                            len_bytes[0],
                            len_bytes[1],
                            len_bytes[2],
                            len_bytes[3],
                        ]) as usize;
                        let raw = self.read_exact(n)?.to_vec();
                        let s: String = raw.iter().map(|&b| b as char).collect();
                        self.stack.push(Pv::Str(s));
                    }
                    b'U' => {
                        let n = self.read_byte()? as usize;
                        let raw = self.read_exact(n)?.to_vec();
                        let s = String::from_utf8(raw)
                            .map_err(|e| format!("SHORT_BINUNICODE UTF-8: {e}"))?;
                        self.stack.push(Pv::Str(s));
                    }
                    b'X' => {
                        let len_bytes = self.read_exact(4)?.to_vec();
                        let n = u32::from_le_bytes([
                            len_bytes[0],
                            len_bytes[1],
                            len_bytes[2],
                            len_bytes[3],
                        ]) as usize;
                        let raw = self.read_exact(n)?.to_vec();
                        let s =
                            String::from_utf8(raw).map_err(|e| format!("BINUNICODE UTF-8: {e}"))?;
                        self.stack.push(Pv::Str(s));
                    }
                    b'S' => {
                        let line = self.read_line()?;
                        let s = std::str::from_utf8(&line)
                            .map_err(|e| format!("STRING decode: {e}"))?
                            .trim()
                            .trim_start_matches(|c| c == '\'' || c == '"')
                            .trim_end_matches(|c| c == '\'' || c == '"')
                            .to_string();
                        self.stack.push(Pv::Str(s));
                    }
                    b'C' => {
                        let n = self.read_byte()? as usize;
                        let raw = self.read_exact(n)?.to_vec();
                        self.stack.push(Pv::Bytes(raw));
                    }
                    b'B' => {
                        let len_bytes = self.read_exact(4)?.to_vec();
                        let n = u32::from_le_bytes([
                            len_bytes[0],
                            len_bytes[1],
                            len_bytes[2],
                            len_bytes[3],
                        ]) as usize;
                        let raw = self.read_exact(n)?.to_vec();
                        self.stack.push(Pv::Bytes(raw));
                    }

                    // ── None / booleans ───────────────────────────────────────
                    b'N' => self.stack.push(Pv::None),
                    0x88 => self.stack.push(Pv::Int(1)), // NEWTRUE
                    0x89 => self.stack.push(Pv::Int(0)), // NEWFALSE

                    // ── Memo ──────────────────────────────────────────────────
                    b'p' => {
                        let line = self.read_line()?;
                        let id: u32 = std::str::from_utf8(&line)
                            .ok()
                            .and_then(|s| s.trim().parse().ok())
                            .unwrap_or(0);
                        if let Some(top) = self.stack.last() {
                            self.memo.insert(id, top.clone());
                        }
                    }
                    b'q' => {
                        let id = self.read_byte()? as u32;
                        if let Some(top) = self.stack.last() {
                            self.memo.insert(id, top.clone());
                        }
                    }
                    b'r' => {
                        let raw = self.read_exact(4)?.to_vec();
                        let id = u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]);
                        if let Some(top) = self.stack.last() {
                            self.memo.insert(id, top.clone());
                        }
                    }
                    b'g' => {
                        let line = self.read_line()?;
                        let id: u32 = std::str::from_utf8(&line)
                            .ok()
                            .and_then(|s| s.trim().parse().ok())
                            .unwrap_or(0);
                        let v = self
                            .memo
                            .get(&id)
                            .cloned()
                            .ok_or_else(|| format!("GET: memo id {id} not found"))?;
                        self.stack.push(v);
                    }
                    b'h' => {
                        let id = self.read_byte()? as u32;
                        let v = self
                            .memo
                            .get(&id)
                            .cloned()
                            .ok_or_else(|| format!("BINGET: memo id {id} not found"))?;
                        self.stack.push(v);
                    }
                    b'j' => {
                        let raw = self.read_exact(4)?.to_vec();
                        let id = u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]);
                        let v = self
                            .memo
                            .get(&id)
                            .cloned()
                            .ok_or_else(|| format!("LONG_BINGET: memo id {id} not found"))?;
                        self.stack.push(v);
                    }

                    // ── Global / object construction ──────────────────────────
                    b'c' => {
                        self.read_line()?; // module
                        self.read_line()?; // name
                        self.stack.push(Pv::None); // placeholder for REDUCE
                    }
                    b'R' => {
                        let args = self.pop()?;
                        let _callable = self.pop()?;
                        match args {
                            Pv::Tuple(ref items) if items.is_empty() => {
                                self.stack.push(Pv::Dict(vec![]));
                            }
                            Pv::Tuple(ref items) if items.len() == 1 => {
                                if let Pv::List(ref pairs) = items[0] {
                                    let dict: Vec<(Pv, Pv)> = pairs
                                        .iter()
                                        .filter_map(|p| {
                                            if let Pv::Tuple(ref kv) = p {
                                                if kv.len() == 2 {
                                                    return Some((kv[0].clone(), kv[1].clone()));
                                                }
                                            }
                                            None
                                        })
                                        .collect();
                                    self.stack.push(Pv::Dict(dict));
                                } else {
                                    self.stack.push(Pv::Dict(vec![]));
                                }
                            }
                            _ => self.stack.push(Pv::Dict(vec![])),
                        }
                    }
                    b'b' => {
                        self.pop()?;
                    } // BUILD — ignore state
                    0x81 => {
                        // NEWOBJ
                        let _args = self.pop()?;
                        let _cls = self.pop()?;
                        self.stack.push(Pv::Dict(vec![]));
                    }
                    0x92 => {
                        // NEWOBJ_EX
                        let _kwargs = self.pop()?;
                        let _args = self.pop()?;
                        let _cls = self.pop()?;
                        self.stack.push(Pv::Dict(vec![]));
                    }
                    0x93 => {
                        // STACK_GLOBAL
                        let _name = self.pop()?;
                        let _module = self.pop()?;
                        self.stack.push(Pv::None);
                    }

                    // ── Frame (protocol 4+) ───────────────────────────────────
                    0x95 => {
                        self.read_exact(8)?;
                    } // FRAME header

                    // ── End ───────────────────────────────────────────────────
                    b'.' => return self.pop(), // STOP

                    other => {
                        return Err(format!(
                            "Unsupported pickle opcode 0x{other:02X} at pos {}",
                            self.pos - 1
                        ));
                    }
                }
            }
        }
    }

    fn read_le_signed(bytes: &[u8]) -> i64 {
        if bytes.is_empty() {
            return 0;
        }
        let mut v: i64 = 0;
        for (i, &b) in bytes.iter().enumerate() {
            v |= (b as i64) << (i * 8);
        }
        let bits = bytes.len() * 8;
        if bits < 64 && (v >> (bits - 1)) & 1 == 1 {
            v |= !0i64 << bits;
        }
        v
    }

    // ─── Index deserialisation ────────────────────────────────────────────────

    fn deserialise_index(data: &[u8], key: u64) -> Result<RpaIndex, String> {
        let mut reader = PickleReader::new(data);
        let root = reader.read_value()?;

        let pairs = match root {
            Pv::Dict(pairs) => pairs,
            other => return Err(format!("Expected dict at pickle root, got {other:?}")),
        };

        let mut index = HashMap::new();

        for (k, v) in pairs {
            let path = match k {
                Pv::Str(s) => s,
                Pv::Bytes(b) => String::from_utf8_lossy(&b).into_owned(),
                other => return Err(format!("Expected string key in RPA index, got {other:?}")),
            };

            let tuples = match v {
                Pv::List(items) => items,
                other => {
                    return Err(format!(
                        "Expected list for RPA entry {path:?}, got {other:?}"
                    ))
                }
            };

            if tuples.is_empty() {
                continue;
            }

            let first = match &tuples[0] {
                Pv::Tuple(t) => t.clone(),
                other => {
                    return Err(format!(
                        "Expected tuple in RPA entry list for {path:?}, got {other:?}"
                    ))
                }
            };

            if first.len() < 2 {
                return Err(format!(
                    "RPA entry tuple for {path:?} has only {} element(s)",
                    first.len()
                ));
            }

            let raw_offset = pv_to_u64(&first[0])
                .ok_or_else(|| format!("Bad offset in RPA entry for {path:?}"))?;
            let raw_length = pv_to_u64(&first[1])
                .ok_or_else(|| format!("Bad length in RPA entry for {path:?}"))?;

            let prefix = if first.len() >= 3 {
                match &first[2] {
                    Pv::Bytes(b) => b.clone(),
                    Pv::Str(s) => s.bytes().collect(),
                    _ => vec![],
                }
            } else {
                vec![]
            };

            let offset = raw_offset ^ key;
            let prefix_len = prefix.len() as u64;
            let length = (raw_length ^ key).saturating_sub(prefix_len);

            index.insert(
                path,
                RpaEntry {
                    offset: offset + prefix_len,
                    length,
                    prefix,
                },
            );
        }

        Ok(index)
    }

    fn pv_to_u64(v: &Pv) -> Option<u64> {
        match v {
            Pv::Int(n) => Some(*n as u64),
            _ => None,
        }
    }

    // ─── Public: parse an RPA file and return its index ───────────────────────

    pub fn parse_rpa_index(path: &str) -> Result<RpaIndex, String> {
        let mut file = File::open(path).map_err(|e| format!("Cannot open {path:?}: {e}"))?;

        let mut header_buf = vec![0u8; 256];
        let n = file
            .read(&mut header_buf)
            .map_err(|e| format!("Read header error: {e}"))?;
        header_buf.truncate(n);

        let newline_pos = header_buf
            .iter()
            .position(|&b| b == b'\n')
            .ok_or("RPA header has no newline")?;
        let header_line = std::str::from_utf8(&header_buf[..newline_pos])
            .map_err(|e| format!("Header not UTF-8: {e}"))?;

        let (index_offset, key) = parse_header(header_line)?;

        file.seek(SeekFrom::Start(index_offset))
            .map_err(|e| format!("Seek to index failed: {e}"))?;

        let mut compressed = Vec::new();
        file.read_to_end(&mut compressed)
            .map_err(|e| format!("Read index block failed: {e}"))?;

        let mut decoder = ZlibDecoder::new(compressed.as_slice());
        let mut pickle_data = Vec::new();
        decoder
            .read_to_end(&mut pickle_data)
            .map_err(|e| format!("zlib decompress failed: {e}"))?;

        deserialise_index(&pickle_data, key)
    }

    // ─── Tauri commands ───────────────────────────────────────────────────────

    #[tauri::command]
    pub async fn list_rpa(path: String) -> Result<Vec<String>, String> {
        spawn_blocking(move || {
            let index = parse_rpa_index(&path)?;
            let mut paths: Vec<String> = index.into_keys().collect();
            paths.sort_unstable();
            Ok(paths)
        })
        .await
        .map_err(|e| format!("spawn_blocking panicked: {e}"))?
    }

    #[tauri::command]
    pub async fn read_rpa_entry(rpa_path: String, entry_path: String) -> Result<Vec<u8>, String> {
        spawn_blocking(move || read_rpa_entry_blocking(&rpa_path, &entry_path))
            .await
            .map_err(|e| format!("spawn_blocking panicked: {e}"))?
    }

    fn read_rpa_entry_blocking(rpa_path: &str, entry_path: &str) -> Result<Vec<u8>, String> {
        let index = parse_rpa_index(rpa_path)?;

        let entry = index
            .get(entry_path)
            .ok_or_else(|| format!("Entry {entry_path:?} not found in {rpa_path:?}"))?;

        let mut file =
            File::open(rpa_path).map_err(|e| format!("Cannot open {rpa_path:?}: {e}"))?;

        file.seek(SeekFrom::Start(entry.offset))
            .map_err(|e| format!("Seek to entry data failed: {e}"))?;

        let mut buf = vec![0u8; entry.length as usize];
        read_exact_from(&mut file, &mut buf).map_err(|e| format!("Read entry data failed: {e}"))?;

        Ok(buf)
    }

    fn read_exact_from(file: &mut File, buf: &mut [u8]) -> io::Result<()> {
        let mut offset = 0;
        while offset < buf.len() {
            let n = file.read(&mut buf[offset..])?;
            if n == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "RPA entry data ended early",
                ));
            }
            offset += n;
        }
        Ok(())
    }
}

// ─── App setup ───────────────────────────────────────────────────────────────

use commands::build_zip;
use rpa::{list_rpa, read_rpa_entry};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            build_zip,
            list_rpa,
            read_rpa_entry
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ren'Ts");
}
