use crate::rpy2rrs as core;

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Cursor, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;
use zip::write::ZipWriter;
use zip::ZipArchive;

use anyhow::{Context, Result};
use serde::Deserialize;

// ── Arg structs ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ConvertArgs {
    pub file: String,
    pub output: Option<String>,
    pub translate: Option<String>,
    pub game_dir: Option<String>,
}

#[derive(Deserialize)]
pub struct ConvertDirArgs {
    pub dir: String,
    pub output: Option<String>,
    pub translate: Option<String>,
}

#[derive(Deserialize)]
pub struct ExtractTlArgs {
    pub file: String,
    pub output: Option<String>,
    pub game_dir: Option<String>,
}

#[derive(Deserialize)]
pub struct ExportArgs {
    pub file: String,
    pub output: Option<String>,
    pub game_dir: Option<String>,
}

#[derive(Deserialize)]
pub struct ExportDirArgs {
    pub dir: String,
    pub output: Option<String>,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn find_game_dirs(archive: &mut ZipArchive<File>) -> Vec<String> {
    let mut dirs: Vec<String> = (0..archive.len())
        .filter_map(|i| {
            let f = archive.by_index(i).ok()?;
            let name = f.name().to_string();
            let trimmed = name.trim_end_matches('/');
            let last = trimmed.rsplit('/').next()?;
            if last == "game" { Some(trimmed.to_string()) } else { None }
        })
        .collect();
    dirs.push(String::new());
    dirs
}

fn load_translation(path: &str) -> Result<HashMap<String, String>> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("cannot read {}", path))?;
    let map: HashMap<String, String> = serde_json::from_str(&text)
        .with_context(|| format!("invalid JSON in {}", path))?;
    Ok(map)
}

fn select_game_dir(archive: &mut ZipArchive<File>, provided: Option<String>) -> Result<String> {
    if let Some(dir) = provided { return Ok(dir); }
    let dirs = find_game_dirs(archive);
    Ok(dirs.first().cloned().unwrap_or_default())
}

fn emit_log(app: &AppHandle, content: &str) {
    let _ = app.emit("log", content);
}

fn print_progress(app: &AppHandle, vpath: &str, status: &str) {
    let message: String = if status.starts_with("ERROR") {
        format!("  \u{2717} {} \u{2014} {}", vpath, status)
    } else if status.starts_with("converting rpy") {
        format!("  rpy {}", vpath)
    } else if status.starts_with("converting rpyc") {
        format!("  rpc {}", vpath)
    } else if matches!(status, "asset" | "tl" | "written") {
        return;
    } else {
        format!("  {} {}", status, vpath)
    };
    emit_log(app, &message);
}

fn is_asset_ext(ext: &str) -> bool {
    matches!(ext,
        "png"|"jpg"|"jpeg"|"gif"|"webp"|"bmp"|"tga"|"ico"
        |"ogg"|"mp3"|"wav"|"flac"|"opus"|"m4a"
        |"mp4"|"webm"|"avi"|"mkv"|"mov")
}

fn change_ext(p: &str, new_ext: &str) -> String {
    match p.rfind('.') {
        Some(i) => format!("{}.{}", &p[..i], new_ext),
        None => format!("{}.{}", p, new_ext),
    }
}

fn write_entry<W>(zip: &mut ZipWriter<W>, path: &str, data: &[u8],
    opts: zip::write::SimpleFileOptions) -> Result<()>
where W: std::io::Write + std::io::Seek {
    zip.start_file(path, opts)?;
    zip.write_all(data)?;
    Ok(())
}

// ── ZIP-based converter ───────────────────────────────────────────────────────

#[tauri::command]
pub fn converter(app: AppHandle, args: ConvertArgs) -> tauri::Result<String> {
    convert_zip_anyhow(app, args).map_err(tauri::Error::from)
}

fn convert_zip_anyhow(app: AppHandle, args: ConvertArgs) -> Result<String> {
    let tmap = args.translate.as_deref().map(load_translation).transpose()?;

    let f = File::open(&args.file)?;
    let mut archive = ZipArchive::new(f)?;
    let game_dir = select_game_dir(&mut archive, args.game_dir)?;
    let output = args.output.unwrap_or_else(|| "./output.zip".into());

    emit_log(&app, "\u{25b6} converting\u{2026}");

    let out_file = File::create(&output)?;
    let mut zip = ZipWriter::new(BufWriter::new(out_file));
    let stats = core::scan_and_convert(
        &mut archive, &game_dir, tmap.as_ref(), &mut zip,
        |vpath, status| print_progress(&app, vpath, status),
    )?;
    zip.finish()?;

    emit_log(&app, &format!("\u{2713} done  rpy:{} rpyc:{} asset:{} err:{} \u{2192} {}",
        stats.rpy_count, stats.rpyc_count, stats.asset_count, stats.error_count, &output));
    Ok(output)
}

// ── Directory-based converter ─────────────────────────────────────────────────

#[tauri::command]
pub fn converter_dir(app: AppHandle, args: ConvertDirArgs) -> tauri::Result<String> {
    convert_dir_anyhow(app, args).map_err(tauri::Error::from)
}

fn convert_dir_anyhow(app: AppHandle, args: ConvertDirArgs) -> Result<String> {
    let tmap = args.translate.as_deref().map(load_translation).transpose()?;
    let game_dir = PathBuf::from(&args.dir);
    let output = args.output.unwrap_or_else(|| "./output.zip".into());

    emit_log(&app, "\u{25b6} converting from directory\u{2026}");

    let out_file = File::create(&output)?;
    let mut zip = ZipWriter::new(BufWriter::new(out_file));
    let stats = scan_dir_and_convert(
        &game_dir, tmap.as_ref(), &mut zip,
        |vpath, status| print_progress(&app, vpath, status),
    )?;
    zip.finish()?;

    emit_log(&app, &format!("\u{2713} done  rpy:{} rpyc:{} asset:{} err:{} \u{2192} {}",
        stats.rpy_count, stats.rpyc_count, stats.asset_count, stats.error_count, &output));
    Ok(output)
}

fn scan_dir_and_convert<W, P>(
    game_dir: &Path,
    tmap: Option<&HashMap<String, String>>,
    out_zip: &mut ZipWriter<W>,
    mut on_progress: P,
) -> Result<core::ConvertStats>
where W: std::io::Write + std::io::Seek, P: FnMut(&str, &str) {
    let opts_d = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let opts_s = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored);

    let mut stats = core::ConvertStats::default();
    let mut script_files: Vec<String> = Vec::new();
    let mut written: std::collections::HashSet<String> = std::collections::HashSet::new();

    for entry in WalkDir::new(game_dir).into_iter().filter_map(|e| e.ok()).filter(|e| e.file_type().is_file()) {
        let abs = entry.path();
        let rel = abs.strip_prefix(game_dir).unwrap_or(abs)
            .to_string_lossy().replace('\\', "/");

        if rel.starts_with("tl/") { continue; }

        let ext = rel.rsplit('.').next().unwrap_or("").to_lowercase();

        match ext.as_str() {
            "rpy" => {
                on_progress(&rel, "converting rpy");
                match std::fs::read_to_string(abs) {
                    Err(_) => { stats.error_count += 1; on_progress(&rel, "ERROR: not valid UTF-8"); }
                    Ok(src) => {
                        let out = format!("data/{}", change_ext(&rel, "rrs"));
                        if written.contains(&out) { continue; }
                        let content = core::convert_rpy_str(&src, &rel, tmap);
                        match write_entry(out_zip, &out, content.as_bytes(), opts_d) {
                            Err(e) => { stats.error_count += 1; on_progress(&rel, &format!("ERROR write: {}", e)); }
                            Ok(()) => { written.insert(out.clone()); stats.rpy_count += 1; script_files.push(out); }
                        }
                    }
                }
            }
            "rpyc" => {
                on_progress(&rel, "converting rpyc");
                let out = format!("data/{}", change_ext(&rel, "rrs"));
                if written.contains(&out) { continue; }
                match std::fs::read(abs) {
                    Err(e) => { stats.error_count += 1; on_progress(&rel, &format!("ERROR read: {}", e)); }
                    Ok(data) => match core::decode_rpyc_and_convert(&data, &rel, tmap) {
                        Err(e) => { stats.error_count += 1; on_progress(&rel, &format!("ERROR: {}", e)); }
                        Ok(content) => match write_entry(out_zip, &out, content.as_bytes(), opts_d) {
                            Err(e) => { stats.error_count += 1; on_progress(&rel, &format!("ERROR write: {}", e)); }
                            Ok(()) => { written.insert(out.clone()); stats.rpyc_count += 1; script_files.push(out); }
                        }
                    }
                }
            }
            ref e if is_asset_ext(e) => {
                if written.contains(&rel) { continue; }
                on_progress(&rel, "asset");
                match std::fs::read(abs) {
                    Err(e) => { stats.error_count += 1; on_progress(&rel, &format!("ERROR read asset: {}", e)); }
                    Ok(data) => match write_entry(out_zip, &rel, &data, opts_s) {
                        Err(e) => { stats.error_count += 1; on_progress(&rel, &format!("ERROR write asset: {}", e)); }
                        Ok(()) => { written.insert(rel.clone()); stats.asset_count += 1; }
                    }
                }
            }
            _ => {}
        }
    }

    script_files.sort();
    let manifest_entries: Vec<String> = script_files.iter()
        .map(|f| f.strip_prefix("data/").unwrap_or(f).to_string()).collect();
    let manifest = core::build_manifest_pub(&manifest_entries);
    let _ = write_entry(out_zip, "data/manifest.json", manifest.as_bytes(), opts_d);

    Ok(stats)
}

// ── extract_tl (ZIP only) ─────────────────────────────────────────────────────

#[tauri::command]
pub fn extract_tl(app: AppHandle, args: ExtractTlArgs) -> tauri::Result<String> {
    extract_tl_anyhow(&app, args).map_err(tauri::Error::from)
}

fn extract_tl_anyhow(app: &AppHandle, args: ExtractTlArgs) -> Result<String> {
    let f = File::open(&args.file)?;
    let mut archive = ZipArchive::new(f)?;
    let game_dir = select_game_dir(&mut archive, args.game_dir)?;

    let prefix = if game_dir.is_empty() { String::new() }
        else { format!("{}/", game_dir.trim_end_matches('/')) };

    let entries: Vec<(String, String)> = (0..archive.len()).filter_map(|i| {
        let f = archive.by_index(i).ok()?;
        if f.is_dir() { return None; }
        let full = f.name().to_string();
        let rel = if prefix.is_empty() { full.clone() }
            else { full.strip_prefix(&prefix)?.to_string() };
        if rel.is_empty() { return None; }
        let is_tl = (rel.starts_with("tl/") || rel.starts_with("tl\\")) && rel.ends_with(".rpy");
        if is_tl { Some((full, rel)) } else { None }
    }).collect();

    emit_log(app, &format!("\u{25b6} extracting {} tl rpy files", entries.len()));
    let output = args.output.unwrap_or_else(|| "./tl.zip".into());
    let out_file = File::create(&output)?;
    let mut zip = ZipWriter::new(BufWriter::new(out_file));
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for (full_path, rel_path) in &entries {
        let mut entry = archive.by_name(full_path)?;
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut buf)?;
        zip.start_file(rel_path, opts)?;
        zip.write_all(&buf)?;
        emit_log(app, &format!("  tl {}", rel_path));
    }
    zip.finish()?;
    emit_log(app, &format!("\n\u{2713} {} files \u{2192} {}", entries.len(), &output));
    Ok(output)
}

// ── export speak lines (ZIP) ──────────────────────────────────────────────────

#[tauri::command]
pub fn export(app: AppHandle, args: ExportArgs) -> tauri::Result<String> {
    export_anyhow(&app, args).map_err(tauri::Error::from)
}

fn export_anyhow(app: &AppHandle, args: ExportArgs) -> Result<String> {
    let f = File::open(&args.file)?;
    let mut archive = ZipArchive::new(f)?;
    let game_dir = select_game_dir(&mut archive, args.game_dir)?;
    emit_log(app, "\u{25b6} scanning for speak lines\u{2026}");

    let mut dummy = ZipWriter::new(Cursor::new(Vec::<u8>::new()));
    core::scan_and_convert(&mut archive, &game_dir, None, &mut dummy, |_, _| {})?;
    let speak_lines = extract_speak_from_zip_writer(dummy)?;
    let output = args.output.unwrap_or_else(|| "./export.json".into());
    write_speak_json(&speak_lines, &output)?;
    emit_log(app, &format!("\u{2713} {} speak lines \u{2192} {}", speak_lines.len(), &output));
    Ok(output)
}

// ── export speak lines (Dir) ──────────────────────────────────────────────────

#[tauri::command]
pub fn export_dir(app: AppHandle, args: ExportDirArgs) -> tauri::Result<String> {
    export_dir_anyhow(&app, args).map_err(tauri::Error::from)
}

fn export_dir_anyhow(app: &AppHandle, args: ExportDirArgs) -> Result<String> {
    let game_dir = PathBuf::from(&args.dir);
    emit_log(app, "\u{25b6} scanning for speak lines (dir)\u{2026}");

    let mut dummy = ZipWriter::new(Cursor::new(Vec::<u8>::new()));
    scan_dir_and_convert(&game_dir, None, &mut dummy, |_, _| {})?;
    let speak_lines = extract_speak_from_zip_writer(dummy)?;
    let output = args.output.unwrap_or_else(|| "./export.json".into());
    write_speak_json(&speak_lines, &output)?;
    emit_log(app, &format!("\u{2713} {} speak lines \u{2192} {}", speak_lines.len(), &output));
    Ok(output)
}

// ── shared speak-line helpers ─────────────────────────────────────────────────

fn extract_speak_from_zip_writer(writer: ZipWriter<Cursor<Vec<u8>>>) -> Result<Vec<String>> {
    let inner = writer.finish()?;
    let mut out_archive = ZipArchive::new(inner)?;
    let speak_re = regex::Regex::new(r#"speak \S+ "([^"\\](?:[^"\\]|\\.)*)""#).unwrap();
    let multi_re = regex::Regex::new(r#""([^"\\](?:[^"\\]|\\.)*)" ;"#).unwrap();

    let mut speak_lines: Vec<String> = Vec::new();
    for i in 0..out_archive.len() {
        let mut entry = out_archive.by_index(i)?;
        if !entry.name().ends_with(".rrs") { continue; }
        let mut text = String::new();
        std::io::Read::read_to_string(&mut entry, &mut text)?;
        for cap in speak_re.captures_iter(&text) {
            let s = cap[1].replace("\\\"", "\"").replace("\\\\", "\\");
            if !s.is_empty() { speak_lines.push(s); }
        }
        for cap in multi_re.captures_iter(&text) {
            let s = cap[1].replace("\\\"", "\"").replace("\\\\", "\\");
            if !s.is_empty() { speak_lines.push(s); }
        }
    }
    speak_lines.sort();
    speak_lines.dedup();
    Ok(speak_lines)
}

fn write_speak_json(speak_lines: &[String], output: &str) -> Result<()> {
    let map: serde_json::Map<String, serde_json::Value> = speak_lines.iter()
        .map(|s| (s.clone(), serde_json::Value::String(String::new()))).collect();
    let json = serde_json::to_string_pretty(&serde_json::Value::Object(map))?;
    std::fs::write(output, &json)?;
    Ok(())
}

// ── read_tl_files: return tl/*.rpy file contents for JS-side parsing ──────────

#[derive(Deserialize)]
pub struct ReadTlArgs {
    /// ZIP file path (zip mode)
    pub file: Option<String>,
    /// Game directory path (dir mode)
    pub dir: Option<String>,
    /// e.g. "chinese", "schinese", "japanese"
    pub lang: String,
    pub game_dir: Option<String>,
}

#[derive(serde::Serialize)]
pub struct TlFileEntry {
    pub path: String,
    pub content: String,
}

#[tauri::command]
pub fn read_tl_files(app: AppHandle, args: ReadTlArgs) -> tauri::Result<Vec<TlFileEntry>> {
    read_tl_files_anyhow(&app, args).map_err(tauri::Error::from)
}

fn read_tl_files_anyhow(app: &AppHandle, args: ReadTlArgs) -> Result<Vec<TlFileEntry>> {
    let lang = args.lang.trim().to_string();
    let prefix = format!("tl/{}/", lang);

    if let Some(ref zip_path) = args.file {
        // ZIP mode
        let f = File::open(zip_path)?;
        let mut archive = ZipArchive::new(f)?;
        let game_dir = {
            let provided = args.game_dir.clone();
            select_game_dir(&mut archive, provided)?
        };
        let game_prefix = if game_dir.is_empty() {
            String::new()
        } else {
            format!("{}/", game_dir.trim_end_matches('/'))
        };

        let mut entries: Vec<TlFileEntry> = Vec::new();
        let names: Vec<String> = (0..archive.len())
            .filter_map(|i| archive.by_index(i).ok().map(|e| e.name().to_string()))
            .collect();

        for full_name in names {
            let rel = if game_prefix.is_empty() {
                full_name.clone()
            } else {
                match full_name.strip_prefix(&game_prefix) {
                    Some(r) => r.to_string(),
                    None => continue,
                }
            };
            if !rel.starts_with(&prefix) || !rel.ends_with(".rpy") {
                continue;
            }
            let mut entry = archive.by_name(&full_name)?;
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut buf)?;
            match String::from_utf8(buf) {
                Ok(content) => entries.push(TlFileEntry { path: rel, content }),
                Err(_) => emit_log(app, &format!("  ⚠ skip non-UTF8: {}", rel)),
            }
        }
        emit_log(app, &format!("✓ read {} tl/{} files from ZIP", entries.len(), lang));
        return Ok(entries);
    }

    if let Some(ref dir_path) = args.dir {
        // Dir mode
        use walkdir::WalkDir;
        let base = std::path::PathBuf::from(dir_path);
        let tl_dir = base.join("tl").join(&lang);

        if !tl_dir.exists() {
            emit_log(app, &format!("⚠ tl/{} not found in {}", lang, dir_path));
            return Ok(vec![]);
        }

        let mut entries: Vec<TlFileEntry> = Vec::new();
        for entry in WalkDir::new(&tl_dir)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
        {
            let abs = entry.path();
            if abs.extension().and_then(|x| x.to_str()) != Some("rpy") { continue; }
            let rel = abs.strip_prefix(&base).unwrap_or(abs)
                .to_string_lossy().replace('\\', "/");
            match std::fs::read_to_string(abs) {
                Ok(content) => entries.push(TlFileEntry { path: rel, content }),
                Err(_) => emit_log(app, &format!("  ⚠ skip non-UTF8: {}", rel)),
            }
        }
        emit_log(app, &format!("✓ read {} tl/{} files from dir", entries.len(), lang));
        return Ok(entries);
    }

    Err(anyhow::anyhow!("must provide either `file` or `dir`"))
}

// ── list_tl_langs: list available tl/ language sub-dirs ──────────────────────

#[derive(Deserialize)]
pub struct ListTlLangsArgs {
    pub file: Option<String>,
    pub dir: Option<String>,
    pub game_dir: Option<String>,
}

#[tauri::command]
pub fn list_tl_langs(_app: AppHandle, args: ListTlLangsArgs) -> tauri::Result<Vec<String>> {
    list_tl_langs_anyhow(args).map_err(tauri::Error::from)
}

fn list_tl_langs_anyhow(args: ListTlLangsArgs) -> Result<Vec<String>> {
    if let Some(ref zip_path) = args.file {
        let f = File::open(zip_path)?;
        let mut archive = ZipArchive::new(f)?;
        let game_dir = select_game_dir(&mut archive, args.game_dir)?;
        let prefix = if game_dir.is_empty() {
            String::new()
        } else {
            format!("{}/", game_dir.trim_end_matches('/'))
        };

        let mut langs: std::collections::HashSet<String> = std::collections::HashSet::new();
        for i in 0..archive.len() {
            if let Ok(entry) = archive.by_index(i) {
                let full = entry.name().to_string();
                let rel = if prefix.is_empty() { full } else {
                    match full.strip_prefix(&prefix) { Some(r) => r.to_string(), None => continue }
                };
                // rel like "tl/chinese/script.rpy"
                if rel.starts_with("tl/") {
                    let parts: Vec<&str> = rel.splitn(3, '/').collect();
                    if parts.len() >= 2 && !parts[1].is_empty() {
                        langs.insert(parts[1].to_string());
                    }
                }
            }
        }
        let mut v: Vec<String> = langs.into_iter().collect();
        v.sort();
        return Ok(v);
    }

    if let Some(ref dir_path) = args.dir {
        let tl_dir = std::path::PathBuf::from(dir_path).join("tl");
        if !tl_dir.exists() { return Ok(vec![]); }
        let mut langs: Vec<String> = std::fs::read_dir(&tl_dir)?
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        langs.sort();
        return Ok(langs);
    }

    Err(anyhow::anyhow!("must provide either `file` or `dir`"))
}
