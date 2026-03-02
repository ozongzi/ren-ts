// ─── ZIP builder command ──────────────────────────────────────────────────────
//
// Builds a ZIP archive from three kinds of entries:
//   • ZipEntry        – source file on disk  (abs_path + zip_path)
//   • RpaZipEntry     – file inside an RPA archive (rpa_path + entry_path + zip_path)
//   • VirtualZipEntry – inline UTF-8 content (content + zip_path)
//
// The archive is written directly to `output_path` on disk.  File bytes never
// cross the Tauri IPC boundary — Rust reads and writes everything natively.
//
// Progress is reported via Tauri events:
//   "zip://progress"  { index, total, zip_path, bytes_written }
//   "zip://skip"      { abs_path, zip_path, reason }

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::async_runtime::spawn_blocking;
use tauri::{AppHandle, Emitter};
use zip::write::{FileOptions, ZipWriter};
use zip::CompressionMethod;

// ─── Types shared with the JS side ───────────────────────────────────────────

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

// ─── Compression policy ───────────────────────────────────────────────────────

/// Returns true for file types that benefit from DEFLATE compression.
/// Already-compressed formats (images, audio, video) use STORE instead.
fn should_deflate(zip_path: &str) -> bool {
    let lower = zip_path.to_lowercase();
    matches!(
        lower.rsplit('.').next().unwrap_or(""),
        "rrs" | "json" | "txt" | "xml" | "html" | "css" | "js" | "svg"
    )
}

// ─── Tauri command ────────────────────────────────────────────────────────────

/// Build a ZIP archive from `entries` (disk files), `rpa_entries` (files
/// sourced from RPA archives) and `virtual_entries` (in-memory text),
/// writing directly to `output_path`.
///
/// Runs the blocking I/O work on a dedicated thread via `spawn_blocking` so
/// the async Tauri runtime is never blocked.
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

// ─── Blocking implementation ──────────────────────────────────────────────────

fn build_zip_blocking(
    app: AppHandle,
    output_path: String,
    entries: Vec<ZipEntry>,
    rpa_entries: Option<Vec<RpaZipEntry>>,
    virtual_entries: Option<Vec<VirtualZipEntry>>,
) -> Result<usize, String> {
    // Ensure the output directory exists before opening the file.
    let out = Path::new(&output_path);
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create output directory: {e}"))?;
    }

    // Open (or create/truncate) the output file with a 256 KiB write buffer
    // so small header writes are coalesced into fewer syscalls.
    let file = File::create(out).map_err(|e| format!("Failed to create output ZIP file: {e}"))?;
    let buf_writer = BufWriter::with_capacity(256 * 1024, file);
    let mut zip = ZipWriter::new(buf_writer);

    let rpa = rpa_entries.unwrap_or_default();
    let virt = virtual_entries.unwrap_or_default();
    let total = entries.len() + rpa.len() + virt.len();
    let mut written: usize = 0;
    let mut bytes_written: u64 = 0;

    // Single reusable read buffer — avoids a heap allocation per file.
    let mut buf = vec![0u8; 128 * 1024];

    // ── Disk entries ──────────────────────────────────────────────────────────
    write_disk_entries(
        &app,
        &mut zip,
        &entries,
        total,
        &mut buf,
        &mut written,
        &mut bytes_written,
    )?;

    // ── RPA-sourced entries ───────────────────────────────────────────────────
    //
    // We parse each RPA's index at most once per archive path by caching the
    // result in a local HashMap.  Binary assets use STORE; text-like files
    // (.rpy, .json, …) get DEFLATE — same policy as disk entries.
    write_rpa_entries(
        &app,
        &mut zip,
        &rpa,
        entries.len(),
        total,
        &mut buf,
        &mut written,
        &mut bytes_written,
    )?;

    // ── Virtual (in-memory text) entries ──────────────────────────────────────
    //
    // Always DEFLATE-compressed.  Emitted last so the progress index is
    // contiguous with the disk + RPA sequence.
    write_virtual_entries(
        &app,
        &mut zip,
        &virt,
        entries.len() + rpa.len(),
        total,
        &mut written,
        &mut bytes_written,
    )?;

    // Finalise — writes the Central Directory + End-of-Central-Directory record.
    zip.finish()
        .map_err(|e| format!("Failed to finalise ZIP: {e}"))?;

    Ok(written)
}

// ─── Section writers ──────────────────────────────────────────────────────────

fn write_disk_entries(
    app: &AppHandle,
    zip: &mut ZipWriter<BufWriter<File>>,
    entries: &[ZipEntry],
    total: usize,
    buf: &mut Vec<u8>,
    written: &mut usize,
    bytes_written: &mut u64,
) -> Result<(), String> {
    for (index, entry) in entries.iter().enumerate() {
        let src = Path::new(&entry.abs_path);

        let src_file = match File::open(src) {
            Ok(f) => f,
            Err(e) => {
                emit_skip(app, &entry.abs_path, &entry.zip_path, &e.to_string());
                continue;
            }
        };

        let method = compression_for(&entry.zip_path);
        let options: FileOptions<'_, ()> = FileOptions::default()
            .compression_method(method)
            .unix_permissions(0o644);

        if let Err(e) = zip.start_file(&entry.zip_path, options) {
            emit_skip(
                app,
                &entry.abs_path,
                &entry.zip_path,
                &format!("zip::start_file failed: {e}"),
            );
            continue;
        }

        let mut reader = BufReader::with_capacity(128 * 1024, src_file);
        let mut file_bytes: u64 = 0;
        loop {
            let n = reader
                .read(buf)
                .map_err(|e| format!("Read error on {}: {e}", entry.abs_path))?;
            if n == 0 {
                break;
            }
            zip.write_all(&buf[..n])
                .map_err(|e| format!("Write error for {}: {e}", entry.zip_path))?;
            file_bytes += n as u64;
        }

        *bytes_written += file_bytes;
        *written += 1;
        emit_progress(app, index, total, &entry.zip_path, *bytes_written);
    }
    Ok(())
}

fn write_rpa_entries(
    app: &AppHandle,
    zip: &mut ZipWriter<BufWriter<File>>,
    rpa_entries: &[RpaZipEntry],
    index_offset: usize,
    total: usize,
    buf: &mut Vec<u8>,
    written: &mut usize,
    bytes_written: &mut u64,
) -> Result<(), String> {
    // Cache parsed RPA indices to avoid redundant zlib+pickle work when
    // multiple entries come from the same archive.
    let mut rpa_index_cache: HashMap<String, crate::rpa::RpaIndex> = HashMap::new();

    for (rpa_idx, rentry) in rpa_entries.iter().enumerate() {
        let index = index_offset + rpa_idx;

        // Fetch (or parse and cache) the index for this RPA archive.
        let rpa_index = match rpa_index_cache.entry(rentry.rpa_path.clone()) {
            std::collections::hash_map::Entry::Occupied(o) => o.into_mut(),
            std::collections::hash_map::Entry::Vacant(v) => {
                match crate::rpa::parse_rpa_index(&rentry.rpa_path) {
                    Ok(idx) => v.insert(idx),
                    Err(e) => {
                        emit_skip(
                            app,
                            &rentry.rpa_path,
                            &rentry.zip_path,
                            &format!("RPA index error: {e}"),
                        );
                        continue;
                    }
                }
            }
        };

        // Look up the specific entry within the index.
        let (offset, length) = match rpa_index.get(&rentry.entry_path) {
            Some(e) => (e.offset, e.length),
            None => {
                emit_skip(
                    app,
                    &rentry.rpa_path,
                    &rentry.zip_path,
                    &format!("entry {:?} not found in RPA", rentry.entry_path),
                );
                continue;
            }
        };

        // Open the RPA file and seek to the entry's data offset.
        let mut rpa_file = match File::open(&rentry.rpa_path) {
            Ok(f) => f,
            Err(e) => {
                emit_skip(
                    app,
                    &rentry.rpa_path,
                    &rentry.zip_path,
                    &format!("Cannot open RPA: {e}"),
                );
                continue;
            }
        };

        if let Err(e) = rpa_file.seek(SeekFrom::Start(offset)) {
            emit_skip(
                app,
                &rentry.rpa_path,
                &rentry.zip_path,
                &format!("Seek failed: {e}"),
            );
            continue;
        }

        let method = compression_for(&rentry.zip_path);
        let options: FileOptions<'_, ()> = FileOptions::default()
            .compression_method(method)
            .unix_permissions(0o644);

        if let Err(e) = zip.start_file(&rentry.zip_path, options) {
            emit_skip(
                app,
                &rentry.rpa_path,
                &rentry.zip_path,
                &format!("zip::start_file failed: {e}"),
            );
            continue;
        }

        // Stream exactly `length` bytes from the RPA into the ZIP writer.
        let mut remaining = length;
        let mut file_bytes: u64 = 0;
        while remaining > 0 {
            let to_read = (remaining as usize).min(buf.len());
            let n = match rpa_file.read(&mut buf[..to_read]) {
                Ok(n) => n,
                Err(e) => return Err(format!("Read error from RPA {}: {e}", rentry.rpa_path)),
            };
            if n == 0 {
                // Premature EOF — entry will be truncated; we don't panic.
                break;
            }
            zip.write_all(&buf[..n])
                .map_err(|e| format!("Write error for RPA entry {}: {e}", rentry.zip_path))?;
            file_bytes += n as u64;
            remaining -= n as u64;
        }

        *bytes_written += file_bytes;
        *written += 1;
        emit_progress(app, index, total, &rentry.zip_path, *bytes_written);
    }
    Ok(())
}

fn write_virtual_entries(
    app: &AppHandle,
    zip: &mut ZipWriter<BufWriter<File>>,
    virt_entries: &[VirtualZipEntry],
    index_offset: usize,
    total: usize,
    written: &mut usize,
    bytes_written: &mut u64,
) -> Result<(), String> {
    for (virt_idx, ventry) in virt_entries.iter().enumerate() {
        let index = index_offset + virt_idx;

        // Virtual entries are always text — always DEFLATE.
        let options: FileOptions<'_, ()> = FileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644);

        if let Err(e) = zip.start_file(&ventry.zip_path, options) {
            emit_skip(
                app,
                "",
                &ventry.zip_path,
                &format!("zip::start_file failed for virtual entry: {e}"),
            );
            continue;
        }

        let content_bytes = ventry.content.as_bytes();
        zip.write_all(content_bytes)
            .map_err(|e| format!("Write error for virtual {}: {e}", ventry.zip_path))?;

        *bytes_written += content_bytes.len() as u64;
        *written += 1;
        emit_progress(app, index, total, &ventry.zip_path, *bytes_written);
    }
    Ok(())
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn compression_for(zip_path: &str) -> CompressionMethod {
    if should_deflate(zip_path) {
        CompressionMethod::Deflated
    } else {
        CompressionMethod::Stored
    }
}

fn emit_progress(app: &AppHandle, index: usize, total: usize, zip_path: &str, bytes_written: u64) {
    let _ = app.emit(
        "zip://progress",
        ZipProgressPayload {
            index,
            total,
            zip_path: zip_path.to_owned(),
            bytes_written,
        },
    );
}

fn emit_skip(app: &AppHandle, abs_path: &str, zip_path: &str, reason: &str) {
    let _ = app.emit(
        "zip://skip",
        ZipSkipPayload {
            abs_path: abs_path.to_owned(),
            zip_path: zip_path.to_owned(),
            reason: reason.to_owned(),
        },
    );
}
