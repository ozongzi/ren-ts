// ─── Ren'Ts – Tauri v2 application library ────────────────────────────
//
// Plugins registered:
//   • tauri-plugin-dialog  – directory / file pickers
//   • tauri-plugin-fs      – text file read / write for save-game persistence
//
// Commands:
//   • commands::build_zip  – stream-write a ZIP archive entirely in Rust;
//                            never sends file bytes across the IPC boundary.
//
// build_zip now accepts two kinds of entries:
//   • ZipEntry         – source file on disk  (abs_path + zip_path)
//   • VirtualZipEntry  – inline UTF-8 content (content   + zip_path)
//
// Virtual entries are appended after all disk entries and are DEFLATE-
// compressed (they are always text). They never touch the filesystem, so
// the caller needs no write-path permissions for them.

mod commands {
    use std::fs::{self, File};
    use std::io::{BufReader, BufWriter, Read, Write};
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
        /// 0-based index of the entry just written (disk + virtual combined).
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

    /// Build a ZIP archive from `entries` (disk files) and `virtual_entries`
    /// (in-memory text), writing directly to `output_path`.
    ///
    /// • Runs entirely in a blocking Tauri thread — no file bytes ever cross
    ///   the IPC boundary, so JS heap pressure is zero regardless of archive
    ///   size.
    /// • Memory high-water mark ≈ one 128 KiB read buffer + ZipWriter state +
    ///   the sum of all virtual entry content (typically a few KiB of .rrs /
    ///   manifest text).
    /// • Emits `zip://progress` (after each successful entry) and `zip://skip`
    ///   (when a disk file cannot be opened) events so the UI can update in
    ///   real time.
    ///
    /// Returns the total number of entries successfully written (disk + virtual).
    #[tauri::command]
    pub async fn build_zip(
        app: AppHandle,
        output_path: String,
        entries: Vec<ZipEntry>,
        virtual_entries: Option<Vec<VirtualZipEntry>>,
    ) -> Result<usize, String> {
        spawn_blocking(move || build_zip_blocking(app, output_path, entries, virtual_entries))
            .await
            .map_err(|e| format!("spawn_blocking panicked: {e}"))?
    }

    fn build_zip_blocking(
        app: AppHandle,
        output_path: String,
        entries: Vec<ZipEntry>,
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

        let virt = virtual_entries.unwrap_or_default();
        let total = entries.len() + virt.len();
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

        // ── Virtual (in-memory) entries ───────────────────────────────────────
        //
        // These are always text, so always DEFLATE-compressed.
        // They are emitted after all disk entries; the combined index sequence
        // is contiguous so the JS progress bar advances smoothly.
        let disk_count = entries.len();
        for (virt_idx, ventry) in virt.iter().enumerate() {
            let index = disk_count + virt_idx;

            // Virtual entries are always text → always deflate.
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

// ─── App setup ───────────────────────────────────────────────────────────────

// Re-export at crate root so that `tauri::generate_handler!` can resolve the
// symbol without a module path — rust-analyzer struggles with
// `generate_handler![module::fn]` even though rustc accepts it fine.
use commands::build_zip;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![build_zip])
        .run(tauri::generate_context!())
        .expect("error while running Ren'Ts");
}
