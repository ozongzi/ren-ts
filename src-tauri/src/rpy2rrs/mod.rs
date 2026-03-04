pub mod pickle;
pub mod rpy;
pub mod rpyc;

use anyhow::{anyhow, Context, Result};
use flate2::read::ZlibDecoder;
use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read, Seek, Write};
use zip::ZipArchive;

use pickle::PickleValue;
use rpy::convert_rpy;
use rpyc::{convert_rpyc, detect_minigame_from_ast, unwrap_ast_nodes};

// ── File classification ───────────────────────────────────────────────────────

pub enum FileKind {
    Rpy,
    Rpyc,
    Asset,
}

pub fn classify(path: &str) -> Option<FileKind> {
    let ext = path.rsplit('.').next()?.to_lowercase();
    match ext.as_str() {
        "rpy" => Some(FileKind::Rpy),
        "rpyc" => Some(FileKind::Rpyc),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tga" | "ico" | "ogg" | "mp3" | "wav"
        | "flac" | "opus" | "m4a" | "mp4" | "webm" | "avi" | "mkv" | "mov" => Some(FileKind::Asset),
        _ => None,
    }
}

// ── RPA parsing ───────────────────────────────────────────────────────────────

fn pickle_to_u64(v: &serde_pickle::Value) -> Result<u64> {
    use serde_pickle::Value;
    match v {
        Value::I64(n) => Ok(*n as u64),
        Value::F64(f) => Ok(*f as u64),
        _ => Err(anyhow!("expected number in RPA index, got {:?}", v)),
    }
}

/// Parse an RPA-3.0 archive, call `cb(virtual_path, data)` for each entry.
pub fn parse_rpa<R, F>(mut r: R, mut cb: F) -> Result<()>
where
    R: Read + Seek,
    F: FnMut(&str, Vec<u8>) -> Result<()>,
{
    let mut header = String::new();
    let mut byte = [0u8; 1];
    loop {
        r.read_exact(&mut byte)?;
        if byte[0] == b'\n' {
            break;
        }
        header.push(byte[0] as char);
    }
    let header_len = header.len() + 1;
    let parts: Vec<&str> = header.trim().split_whitespace().collect();
    if parts.len() < 3 || parts[0] != "RPA-3.0" {
        return Err(anyhow!(
            "unsupported RPA version: {}",
            parts.first().unwrap_or(&"?")
        ));
    }
    let index_offset = u64::from_str_radix(parts[1], 16)?;
    let key = u64::from_str_radix(parts[2], 16)?;

    let mut buf = Vec::new();
    r.read_to_end(&mut buf)?;

    let index_start = index_offset as usize - header_len;
    let mut decompressed = Vec::new();
    ZlibDecoder::new(&buf[index_start..]).read_to_end(&mut decompressed)?;

    use serde_pickle::{HashableValue, Value};
    let value: Value = serde_pickle::from_slice(&decompressed, Default::default())?;
    let map = match value {
        Value::Dict(m) => m,
        _ => return Err(anyhow!("RPA pickle root is not a dict")),
    };

    for (k, v) in map {
        let name = match k {
            HashableValue::String(s) => s,
            HashableValue::Bytes(b) => String::from_utf8_lossy(&b).into_owned(),
            _ => continue,
        };
        let first = match v {
            Value::List(mut l) if !l.is_empty() => l.remove(0),
            _ => continue,
        };
        let items = match first {
            Value::Tuple(t) => t,
            Value::List(l) => l,
            _ => continue,
        };
        if items.len() < 2 {
            continue;
        }

        let entry_offset = (pickle_to_u64(&items[0])? ^ key) as usize;
        let entry_length = (pickle_to_u64(&items[1])? ^ key) as usize;
        let prefix = match items.get(2) {
            Some(Value::Bytes(b)) if !b.is_empty() => Some(b.clone()),
            _ => None,
        };

        // entry_offset is absolute within the RPA file.
        // buf starts right after the header line (header_len bytes),
        // so we subtract header_len to get the buf-relative index.
        if entry_offset < header_len {
            return Err(anyhow!(
                "RPA entry offset {} < header_len {}",
                entry_offset,
                header_len
            ));
        }
        let buf_offset = entry_offset - header_len;
        if buf_offset + entry_length > buf.len() {
            return Err(anyhow!(
                "RPA entry out of bounds: buf_offset={} len={} buf={}",
                buf_offset,
                entry_length,
                buf.len()
            ));
        }
        let slice = &buf[buf_offset..buf_offset + entry_length];
        let data = if let Some(p) = prefix {
            let mut d = slice.to_vec();
            let plen = p.len().min(d.len());
            d[..plen].copy_from_slice(&p[..plen]);
            d
        } else {
            slice.to_vec()
        };
        cb(&name, data)?;
    }
    Ok(())
}

// ── rpyc decoding ─────────────────────────────────────────────────────────────

/// Decode a .rpyc file → PickleValue AST.
///
/// Two formats supported:
///   - Legacy: raw zlib( pickle )
///   - RPC2:   b"RENPY RPC2" + slot table + zlib chunks
///             slot table = repeated (u32 slot, u32 start, u32 length) terminated by (0,0,0)
///             start/length are absolute file offsets; slot 1 = AST
pub fn decode_rpyc(data: &[u8]) -> Result<PickleValue> {
    let pickle_bytes = if data.starts_with(b"RENPY RPC2") {
        decode_rpc2(data)?
    } else {
        // legacy: direct zlib
        let mut out = Vec::new();
        ZlibDecoder::new(data)
            .read_to_end(&mut out)
            .with_context(|| {
                format!(
                    "rpyc zlib decompress failed (first 12 bytes: {:02x?})",
                    &data[..data.len().min(12)]
                )
            })?;
        out
    };
    pickle::decode(&pickle_bytes).with_context(|| {
        format!(
            "pickle decode failed, first 8 bytes: {:02x?}",
            &pickle_bytes[..pickle_bytes.len().min(8)]
        )
    })
}

fn decode_rpc2(data: &[u8]) -> Result<Vec<u8>> {
    // parse slot table (starts at byte 10, terminates on slot==0)
    let mut pos = 10usize;
    let mut ast_start = None;
    let mut ast_length = None;
    loop {
        if pos + 12 > data.len() {
            return Err(anyhow!("RPC2 slot table truncated"));
        }
        let slot = u32::from_le_bytes(data[pos..pos + 4].try_into().unwrap());
        let start = u32::from_le_bytes(data[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let length = u32::from_le_bytes(data[pos + 8..pos + 12].try_into().unwrap()) as usize;
        pos += 12;
        if slot == 0 {
            break;
        }
        if slot == 1 {
            ast_start = Some(start);
            ast_length = Some(length);
        }
    }
    let start = ast_start.ok_or_else(|| anyhow!("RPC2: no slot 1 found"))?;
    let length = ast_length.unwrap();
    if start + length > data.len() {
        return Err(anyhow!(
            "RPC2 slot 1 out of bounds: start={} len={} file={}",
            start,
            length,
            data.len()
        ));
    }
    let mut out = Vec::new();
    ZlibDecoder::new(&data[start..start + length])
        .read_to_end(&mut out)
        .context("RPC2 slot 1 zlib decompress failed")?;
    Ok(out)
}

// ── Path helpers ──────────────────────────────────────────────────────────────

pub fn change_ext(p: &str, new_ext: &str) -> String {
    match p.rfind('.') {
        Some(i) => format!("{}.{}", &p[..i], new_ext),
        None => format!("{}.{}", p, new_ext),
    }
}

// ── Stats ─────────────────────────────────────────────────────────────────────

#[derive(Default, Debug)]
pub struct ConvertStats {
    pub rpy_count: usize,
    pub rpyc_count: usize,
    pub asset_count: usize,
    pub error_count: usize,
}

// ── ZIP helper ────────────────────────────────────────────────────────────────

fn read_zip_bytes<R: Read + Seek>(archive: &mut ZipArchive<R>, path: &str) -> Result<Vec<u8>> {
    let mut entry = archive
        .by_name(path)
        .with_context(|| format!("zip entry not found: {}", path))?;
    let mut buf = Vec::new();
    entry.read_to_end(&mut buf)?;
    Ok(buf)
}

// ── Write helpers ─────────────────────────────────────────────────────────────

fn write_text<W: Write + Seek>(
    zip: &mut zip::write::ZipWriter<W>,
    path: &str,
    text: &str,
) -> Result<()> {
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file(path, opts)?;
    zip.write_all(text.as_bytes())?;
    Ok(())
}

fn write_binary<W: Write + Seek>(
    zip: &mut zip::write::ZipWriter<W>,
    path: &str,
    data: &[u8],
) -> Result<()> {
    let opts =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file(path, opts)?;
    zip.write_all(data)?;
    Ok(())
}

// ── Per-file conversion + immediate write ─────────────────────────────────────

/// Returns the output path if a script was written, None for assets/skipped/duplicate.
fn process_and_write<W, P>(
    vpath: &str,
    data: Vec<u8>,
    tmap: Option<&HashMap<String, String>>,
    zip: &mut zip::write::ZipWriter<W>,
    written: &mut HashSet<String>,
    stats: &mut ConvertStats,
    on_progress: &mut P,
) -> Option<String>
where
    W: Write + Seek,
    P: FnMut(&str, &str),
{
    let ext = vpath.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "rpy" => {
            // skip tl/**/*.rpy
            if vpath.contains("/tl/") || vpath.starts_with("tl/") {
                return None;
            }

            on_progress(vpath, "converting rpy");
            match std::str::from_utf8(&data) {
                Err(_) => {
                    stats.error_count += 1;
                    on_progress(vpath, "ERROR: not valid UTF-8");
                    None
                }
                Ok(src) => {
                    let out = format!("data/{}", change_ext(vpath, "rrs"));
                    if written.contains(&out) {
                        return None;
                    }
                    let content = convert_rpy(src, vpath, tmap.cloned(), None);
                    if let Err(e) = write_text(zip, &out, &content) {
                        stats.error_count += 1;
                        on_progress(vpath, &format!("ERROR write: {}", e));
                        None
                    } else {
                        written.insert(out.clone());
                        stats.rpy_count += 1;
                        Some(out)
                    }
                }
            }
        }
        "rpyc" => {
            // skip tl/**/*.rpyc
            if vpath.contains("/tl/") || vpath.starts_with("tl/") {
                return None;
            }

            on_progress(vpath, "converting rpyc");
            let out = format!("data/{}", change_ext(vpath, "rrs"));
            if written.contains(&out) {
                return None;
            }
            match decode_rpyc(&data) {
                Err(e) => {
                    stats.error_count += 1;
                    on_progress(
                        vpath,
                        &format!(
                            "ERROR decode: {} [first 12: {:02x?}]",
                            e,
                            &data[..data.len().min(12)]
                        ),
                    );
                    None
                }
                Ok(ast) => {
                    let root_nodes = unwrap_ast_nodes(&ast);
                    let det = detect_minigame_from_ast(&root_nodes);
                    let stubs: Vec<(String, String)> = det
                        .stubs
                        .into_iter()
                        .map(|s| (s.entry_label, s.exit_label))
                        .collect();
                    let content = convert_rpyc(&ast, vpath, tmap.cloned(), Some(stubs));
                    if let Err(e) = write_text(zip, &out, &content) {
                        stats.error_count += 1;
                        on_progress(vpath, &format!("ERROR write: {}", e));
                        None
                    } else {
                        written.insert(out.clone());
                        stats.rpyc_count += 1;
                        Some(out)
                    }
                }
            }
        }
        _ => {
            if classify(vpath).is_some() {
                if !written.contains(vpath) {
                    on_progress(vpath, "asset");
                    if let Err(e) = write_binary(zip, vpath, &data) {
                        stats.error_count += 1;
                        on_progress(vpath, &format!("ERROR write asset: {}", e));
                    } else {
                        written.insert(vpath.to_string());
                        stats.asset_count += 1;
                    }
                }
            }
            None
        }
    }
}

// ── Main scanner ──────────────────────────────────────────────────────────────

/// Walk `archive` rooted at `game_dir`, convert every .rpy/.rpyc and copy
/// assets, writing everything directly into `out_zip`.
/// Scripts go under `data/`, assets keep their original relative path.
/// Appends `manifest.json` with `{ "files": [...] }` at the end.
pub fn scan_and_convert<R, W, P>(
    archive: &mut ZipArchive<R>,
    game_dir: &str,
    translation_map: Option<&HashMap<String, String>>,
    out_zip: &mut zip::write::ZipWriter<W>,
    mut on_progress: P,
) -> Result<ConvertStats>
where
    R: Read + Seek,
    W: Write + Seek,
    P: FnMut(&str, &str),
{
    let prefix = match game_dir {
        "" => String::new(),
        d => format!("{}/", d.trim_end_matches('/')),
    };

    let entries: Vec<(String, String)> = (0..archive.len())
        .filter_map(|i| {
            let f = archive.by_index(i).ok()?;
            if f.is_dir() {
                return None;
            }
            let full = f.name().to_string();
            let rel = if prefix.is_empty() {
                full.clone()
            } else {
                full.strip_prefix(&prefix)?.to_string()
            };
            if rel.is_empty() {
                return None;
            }
            Some((full, rel))
        })
        .collect();

    let mut stats = ConvertStats::default();
    let mut script_files: Vec<String> = Vec::new();
    let mut written: HashSet<String> = HashSet::new();

    for (full_path, rel_path) in &entries {
        let ext = rel_path.rsplit('.').next().unwrap_or("").to_lowercase();

        if ext == "rpa" {
            on_progress(rel_path, "reading rpa");
            let rpa_data = match read_zip_bytes(archive, full_path) {
                Ok(d) => d,
                Err(e) => {
                    stats.error_count += 1;
                    on_progress(rel_path, &format!("ERROR read rpa: {}", e));
                    continue;
                }
            };
            on_progress(rel_path, "walking rpa");

            // Use the directory containing the .rpa file, not the rpa name itself.
            // e.g. "path/to/a.rpa" -> base_dir = "path/to"
            let base_dir = rel_path
                .rfind('/')
                .map(|i| rel_path[..i].to_string())
                .unwrap_or_default();

            if let Err(e) = parse_rpa(Cursor::new(&rpa_data), |name, data| {
                // RPA entries often start with "/" — strip it
                let clean = name.trim_start_matches('/');

                let vpath = if base_dir.is_empty() {
                    clean.to_string()
                } else {
                    format!("{}/{}", base_dir, clean)
                };
                if let Some(out) = process_and_write(
                    &vpath,
                    data,
                    translation_map,
                    out_zip,
                    &mut written,
                    &mut stats,
                    &mut on_progress,
                ) {
                    script_files.push(out);
                }
                Ok(())
            }) {
                stats.error_count += 1;
                on_progress(rel_path, &format!("ERROR parse rpa: {}", e));
            }
        } else {
            // Skip tl/**/*.rpy in normal conversion mode

            let data = match read_zip_bytes(archive, full_path) {
                Ok(d) => d,
                Err(e) => {
                    stats.error_count += 1;
                    on_progress(rel_path, &format!("ERROR read: {}", e));
                    continue;
                }
            };
            if let Some(out) = process_and_write(
                rel_path,
                data,
                translation_map,
                out_zip,
                &mut written,
                &mut stats,
                &mut on_progress,
            ) {
                script_files.push(out);
            }
        }
    }

    // ── manifest.json ─────────────────────────────────────────────────────────
    script_files.sort();
    // Strip the "data/" prefix for the entries inside manifest
    let manifest_entries: Vec<String> = script_files
        .iter()
        .map(|f| f.strip_prefix("data/").unwrap_or(f).to_string())
        .collect();
    let manifest = build_manifest(&manifest_entries);
    if let Err(e) = write_text(out_zip, "data/manifest.json", &manifest) {
        on_progress("manifest.json", &format!("ERROR write manifest: {}", e));
    } else {
        on_progress("manifest.json", "written");
    }

    Ok(stats)
}

pub fn build_manifest(files: &[String]) -> String {
    let entries: Vec<String> = files
        .iter()
        .map(|f| format!("    \"{}\"", f.replace('\\', "/")))
        .collect();
    format!("{{\n  \"files\": [\n{}\n  ]\n}}\n", entries.join(",\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_hiro10() {
        let data = std::fs::read("Hiro_10.rpyc").unwrap();
        let result = decode_rpyc(&data);
        match &result {
            Ok(_) => println!("OK"),
            Err(e) => {
                println!("ERROR chain:");
                for cause in e.chain() {
                    println!("  - {}", cause);
                }
            }
        }
        assert!(result.is_ok());
    }
}
