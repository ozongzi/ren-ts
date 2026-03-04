use crate::rpy2rrs as core;

use std::collections::HashMap;
use std::fs::File;
use std::io::BufWriter;
use tauri::{AppHandle, Emitter};
use zip::write::ZipWriter;
use zip::ZipArchive;

use anyhow::{Context, Result};

use serde::Deserialize;

#[derive(Deserialize)]
pub struct ConvertArgs {
    pub file: String,
    pub output: Option<String>,
    pub translate: Option<String>,
    pub game_dir: Option<String>,
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

// ── Helpers ───────────────────────────────────────────────────────────────────

fn find_game_dirs(archive: &mut ZipArchive<File>) -> Vec<String> {
    let mut dirs: Vec<String> = (0..archive.len())
        .filter_map(|i| {
            let f = archive.by_index(i).ok()?;
            let name = f.name().to_string();
            let trimmed = name.trim_end_matches('/');
            let last = trimmed.rsplit('/').next()?;
            if last == "game" {
                Some(trimmed.to_string())
            } else {
                None
            }
        })
        .collect();
    dirs.push(String::new());
    dirs
}

fn load_translation(path: &str) -> Result<HashMap<String, String>> {
    let text = std::fs::read_to_string(path).with_context(|| format!("cannot read {}", path))?;
    let map: HashMap<String, String> =
        serde_json::from_str(&text).with_context(|| format!("invalid JSON in {}", path))?;
    Ok(map)
}

fn select_game_dir(archive: &mut ZipArchive<File>, provided: Option<String>) -> Result<String> {
    if let Some(dir) = provided {
        return Ok(dir);
    }
    let dirs = find_game_dirs(archive);
    Ok(dirs.get(0).cloned().unwrap_or_default())
}

fn emit_log(app: &AppHandle, content: &str) {
    app.emit("log", content).unwrap();
}

fn print_progress(app: &AppHandle, vpath: &str, status: &str) {
    let message = if status.starts_with("ERROR") {
        format!("  ✗ {} — {}", vpath, status)
    } else if status.starts_with("converting rpy") {
        format!("  rpy {}", vpath)
    } else if status.starts_with("converting rpyc") {
        format!("  rpc {}", vpath)
    } else if status == "asset" || status == "tl" {
        // silent
        format!("")
    } else {
        format!("  {} {}", status, vpath)
    };

    emit_log(app, &message);
}

// ── Tauri Commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn converter(app: AppHandle, args: ConvertArgs) -> tauri::Result<String> {
    convert_anyhow(app, args).map_err(|e| tauri::Error::from(e))
}

pub fn convert_anyhow(app: AppHandle, args: ConvertArgs) -> Result<String> {
    let tmap = match args.translate {
        Some(ref path) => Some(load_translation(path)?),
        None => None,
    };

    let f = File::open(&args.file)?;
    let mut archive = ZipArchive::new(f)?;
    let game_dir = select_game_dir(&mut archive, args.game_dir)?;

    let output = args.output.unwrap_or_else(|| "./output.zip".into());

    emit_log(&app, &format!("▶ converting…"));

    let out_file = File::create(&output)?;
    let mut zip = ZipWriter::new(BufWriter::new(out_file));

    let stats = core::scan_and_convert(
        &mut archive,
        &game_dir,
        tmap.as_ref(),
        &mut zip,
        |vpath, status| print_progress(&app, vpath, status),
    )?;

    zip.finish()?;

    emit_log(&app, &format!("\n✓ done"));
    emit_log(&app, &format!("  rpy  : {}", stats.rpy_count));
    emit_log(&app, &format!("  rpyc : {}", stats.rpyc_count));
    emit_log(&app, &format!("  asset: {}", stats.asset_count));
    emit_log(&app, &format!("  error: {}", stats.error_count));
    emit_log(&app, &format!("  out  : {}", &output));

    Ok(output)
}

#[tauri::command]
pub fn extract_tl(app: AppHandle, args: ExtractTlArgs) -> tauri::Result<String> {
    extract_tl_anyhow(&app, args).map_err(|e| tauri::Error::from(e))
}

pub fn extract_tl_anyhow(app: &AppHandle, args: ExtractTlArgs) -> Result<String> {
    let f = File::open(&args.file)?;
    let mut archive = ZipArchive::new(f)?;
    let game_dir = select_game_dir(&mut archive, args.game_dir)?;

    let prefix = if game_dir.is_empty() {
        String::new()
    } else {
        format!("{}/", game_dir.trim_end_matches('/'))
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
            let is_tl_rpy =
                (rel.starts_with("tl/") || rel.starts_with("tl\\")) && rel.ends_with(".rpy");
            if is_tl_rpy {
                Some((full, rel))
            } else {
                None
            }
        })
        .collect();

    emit_log(
        &app,
        &format!("▶ extracting {} tl rpy files", entries.len()),
    );

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
        std::io::Write::write_all(&mut zip, &buf)?;
        emit_log(&app, &format!("  tl {}", rel_path));
    }
    zip.finish()?;

    emit_log(&app, &format!("\n✓ {} files → {}", entries.len(), &output));
    Ok(output)
}

#[tauri::command]
pub fn export(app: AppHandle, args: ExportArgs) -> tauri::Result<String> {
    export_anyhow(&app, args).map_err(|e| tauri::Error::from(e))
}

pub fn export_anyhow(app: &AppHandle, args: ExportArgs) -> Result<String> {
    let f = File::open(&args.file)?;
    let mut archive = ZipArchive::new(f)?;
    let game_dir = select_game_dir(&mut archive, args.game_dir)?;

    emit_log(&app, &format!("▶ scanning for speak lines…"));

    use std::io::Cursor;
    let mut dummy = ZipWriter::new(Cursor::new(Vec::<u8>::new()));

    core::scan_and_convert(
        &mut archive,
        &game_dir,
        None,
        &mut dummy,
        |_vpath, _status| {},
    )?;

    let inner = dummy.finish()?;
    let mut out_archive = ZipArchive::new(inner)?;
    let speak_re = regex::Regex::new(r#"speak \S+ "([^"\\](?:[^"\\]|\\.)*)""#).unwrap();
    let multi_re = regex::Regex::new(r#""([^"\\](?:[^"\\]|\\.)*)" ;"#).unwrap();

    let mut speak_lines: Vec<String> = Vec::new();
    for i in 0..out_archive.len() {
        let mut entry = out_archive.by_index(i)?;
        if !entry.name().ends_with(".rrs") {
            continue;
        }
        let mut text = String::new();
        std::io::Read::read_to_string(&mut entry, &mut text)?;
        for cap in speak_re.captures_iter(&text) {
            let s = cap[1].replace("\\\"", "\"").replace("\\\\", "\\");
            if !s.is_empty() {
                speak_lines.push(s);
            }
        }
        for cap in multi_re.captures_iter(&text) {
            let s = cap[1].replace("\\\"", "\"").replace("\\\\", "\\");
            if !s.is_empty() {
                speak_lines.push(s);
            }
        }
    }

    speak_lines.sort();
    speak_lines.dedup();

    let map: serde_json::Map<String, serde_json::Value> = speak_lines
        .iter()
        .map(|s| (s.clone(), serde_json::Value::String(String::new())))
        .collect();
    let json = serde_json::to_string_pretty(&serde_json::Value::Object(map))?;

    let output = args.output.unwrap_or_else(|| "./export.json".into());
    std::fs::write(&output, &json)?;

    emit_log(
        &app,
        &format!("✓ {} speak lines → {}", speak_lines.len(), &output),
    );
    Ok(output)
}

// ── Dir-based commands ────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ConvertDirArgs {
    pub dir: String,
    pub output: Option<String>,
    pub translate: Option<String>,
}

#[derive(Deserialize)]
pub struct ExportDirArgs {
    pub dir: String,
    pub output: Option<String>,
}

#[tauri::command]
pub fn converter_dir(app: AppHandle, args: ConvertDirArgs) -> tauri::Result<String> {
    converter_dir_anyhow(app, args).map_err(tauri::Error::from)
}

pub fn converter_dir_anyhow(app: AppHandle, args: ConvertDirArgs) -> Result<String> {
    use std::io::Write;
    use walkdir::WalkDir;

    let tmap = match args.translate {
        Some(ref path) => Some(load_translation(path)?),
        None => None,
    };

    let game_dir = std::path::PathBuf::from(&args.dir);
    let output = args.output.unwrap_or_else(|| "./output.zip".into());

    emit_log(&app, "▶ converting directory…");

    let out_file = File::create(&output)?;
    let mut zip = ZipWriter::new(BufWriter::new(out_file));
    let opts_store =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let opts_deflate = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let mut stats = core::ConvertStats::default();
    let mut script_files: Vec<String> = Vec::new();
    let mut written: std::collections::HashSet<String> = std::collections::HashSet::new();

    for entry in WalkDir::new(&game_dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let abs = entry.path();
        let rel = abs
            .strip_prefix(&game_dir)
            .unwrap_or(abs)
            .to_string_lossy()
            .replace('\\', "/");

        // Skip tl/
        if rel.starts_with("tl/") {
            continue;
        }

        let ext = rel.rsplit('.').next().unwrap_or("").to_lowercase();

        match ext.as_str() {
            "rpy" => {
                print_progress(&app, &rel, "converting rpy");
                match std::fs::read_to_string(abs) {
                    Err(_) => {
                        stats.error_count += 1;
                        print_progress(&app, &rel, "ERROR: not valid UTF-8");
                    }
                    Ok(src) => {
                        let out = format!("data/{}", core::change_ext(&rel, "rrs"));
                        if written.contains(&out) {
                            continue;
                        }
                        let content = core::rpy::convert_rpy(&src, &rel, tmap.clone(), None);
                        zip.start_file(&out, opts_deflate)?;
                        zip.write_all(content.as_bytes())?;
                        written.insert(out.clone());
                        stats.rpy_count += 1;
                        script_files.push(out);
                    }
                }
            }
            "rpyc" => {
                print_progress(&app, &rel, "converting rpyc");
                let out = format!("data/{}", core::change_ext(&rel, "rrs"));
                if written.contains(&out) {
                    continue;
                }
                match std::fs::read(abs) {
                    Err(e) => {
                        stats.error_count += 1;
                        print_progress(&app, &rel, &format!("ERROR read: {}", e));
                    }
                    Ok(data) => match core::decode_rpyc(&data) {
                        Err(e) => {
                            stats.error_count += 1;
                            print_progress(&app, &rel, &format!("ERROR decode: {}", e));
                        }
                        Ok(ast) => {
                            use core::rpyc::{
                                convert_rpyc, detect_minigame_from_ast, unwrap_ast_nodes,
                            };
                            let nodes = unwrap_ast_nodes(&ast);
                            let det = detect_minigame_from_ast(&nodes);
                            let stubs: Vec<(String, String)> = det
                                .stubs
                                .into_iter()
                                .map(|s| (s.entry_label, s.exit_label))
                                .collect();
                            let content = convert_rpyc(&ast, &rel, tmap.clone(), Some(stubs));
                            zip.start_file(&out, opts_deflate)?;
                            zip.write_all(content.as_bytes())?;
                            written.insert(out.clone());
                            stats.rpyc_count += 1;
                            script_files.push(out);
                        }
                    },
                }
            }
            e if is_media_ext(e) => {
                if written.contains(&rel) {
                    continue;
                }
                match std::fs::read(abs) {
                    Err(e2) => {
                        stats.error_count += 1;
                        print_progress(&app, &rel, &format!("ERROR read asset: {}", e2));
                    }
                    Ok(data) => {
                        zip.start_file(&rel, opts_store)?;
                        zip.write_all(&data)?;
                        written.insert(rel.clone());
                        stats.asset_count += 1;
                    }
                }
            }
            _ => {}
        }
    }

    // manifest
    script_files.sort();
    let manifest_entries: Vec<String> = script_files
        .iter()
        .map(|f| f.strip_prefix("data/").unwrap_or(f).to_string())
        .collect();
    let manifest = core::build_manifest(&manifest_entries);
    zip.start_file("data/manifest.json", opts_deflate)?;
    zip.write_all(manifest.as_bytes())?;
    zip.finish()?;

    emit_log(&app, "\n✓ done");
    emit_log(&app, &format!("  rpy  : {}", stats.rpy_count));
    emit_log(&app, &format!("  rpyc : {}", stats.rpyc_count));
    emit_log(&app, &format!("  asset: {}", stats.asset_count));
    emit_log(&app, &format!("  error: {}", stats.error_count));
    emit_log(&app, &format!("  out  : {}", &output));
    Ok(output)
}

#[tauri::command]
pub fn export_dir(app: AppHandle, args: ExportDirArgs) -> tauri::Result<String> {
    export_dir_anyhow(&app, args).map_err(tauri::Error::from)
}

pub fn export_dir_anyhow(app: &AppHandle, args: ExportDirArgs) -> Result<String> {
    use std::io::{Cursor, Write};
    use walkdir::WalkDir;

    let game_dir = std::path::PathBuf::from(&args.dir);
    emit_log(app, "▶ scanning for speak lines (dir)…");

    let mut dummy = ZipWriter::new(Cursor::new(Vec::<u8>::new()));
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    for entry in WalkDir::new(&game_dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let abs = entry.path();
        let rel = abs
            .strip_prefix(&game_dir)
            .unwrap_or(abs)
            .to_string_lossy()
            .replace('\\', "/");
        if rel.starts_with("tl/") {
            continue;
        }
        let ext = rel.rsplit('.').next().unwrap_or("").to_lowercase();
        if ext == "rpy" {
            if let Ok(src) = std::fs::read_to_string(abs) {
                let out = format!("data/{}", core::change_ext(&rel, "rrs"));
                let content = core::rpy::convert_rpy(&src, &rel, None, None);
                dummy.start_file(&out, opts).ok();
                dummy.write_all(content.as_bytes()).ok();
            }
        } else if ext == "rpyc" {
            if let Ok(data) = std::fs::read(abs) {
                if let Ok(ast) = core::decode_rpyc(&data) {
                    use core::rpyc::{convert_rpyc, detect_minigame_from_ast, unwrap_ast_nodes};
                    let nodes = unwrap_ast_nodes(&ast);
                    let det = detect_minigame_from_ast(&nodes);
                    let stubs: Vec<(String, String)> = det
                        .stubs
                        .into_iter()
                        .map(|s| (s.entry_label, s.exit_label))
                        .collect();
                    let content = convert_rpyc(&ast, &rel, None, Some(stubs));
                    let out = format!("data/{}", core::change_ext(&rel, "rrs"));
                    dummy.start_file(&out, opts).ok();
                    dummy.write_all(content.as_bytes()).ok();
                }
            }
        }
    }

    let speak_lines = collect_speak_lines(dummy)?;
    let output = args.output.unwrap_or_else(|| "./export.json".into());
    write_speak_json(&speak_lines, &output)?;

    emit_log(
        app,
        &format!("✓ {} speak lines → {}", speak_lines.len(), &output),
    );
    Ok(output)
}

fn is_media_ext(ext: &str) -> bool {
    matches!(
        ext,
        "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "bmp"
            | "tga"
            | "ico"
            | "ogg"
            | "mp3"
            | "wav"
            | "flac"
            | "opus"
            | "m4a"
            | "mp4"
            | "webm"
            | "avi"
            | "mkv"
            | "mov"
    )
}

fn collect_speak_lines(writer: ZipWriter<std::io::Cursor<Vec<u8>>>) -> Result<Vec<String>> {
    let inner = writer.finish()?;
    let mut arc = ZipArchive::new(inner)?;
    let speak_re = regex::Regex::new(r#"speak \S+ "([^"\\](?:[^"\\]|\\.)*)""#).unwrap();
    let multi_re = regex::Regex::new(r#""([^"\\](?:[^"\\]|\\.)*)" ;"#).unwrap();
    let mut lines: Vec<String> = Vec::new();
    for i in 0..arc.len() {
        let mut entry = arc.by_index(i)?;
        if !entry.name().ends_with(".rrs") {
            continue;
        }
        let mut text = String::new();
        std::io::Read::read_to_string(&mut entry, &mut text)?;
        for cap in speak_re.captures_iter(&text) {
            let s = cap[1].replace("\\\"", "\"").replace("\\\\", "\\");
            if !s.is_empty() {
                lines.push(s);
            }
        }
        for cap in multi_re.captures_iter(&text) {
            let s = cap[1].replace("\\\"", "\"").replace("\\\\", "\\");
            if !s.is_empty() {
                lines.push(s);
            }
        }
    }
    lines.sort();
    lines.dedup();
    Ok(lines)
}

fn write_speak_json(lines: &[String], output: &str) -> Result<()> {
    let map: serde_json::Map<String, serde_json::Value> = lines
        .iter()
        .map(|s| (s.clone(), serde_json::Value::String(String::new())))
        .collect();
    let json = serde_json::to_string_pretty(&serde_json::Value::Object(map))?;
    std::fs::write(output, json)?;
    Ok(())
}
