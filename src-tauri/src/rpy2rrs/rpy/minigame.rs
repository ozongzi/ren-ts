// ── minigame.rs ───────────────────────────────────────────────────────────────
//
// Rust port of rpy-migrate-tool/rpy-rrs-bridge/minigame-detect.ts
//
// Detects whether a .rpy file is a "minigame" — a pure screen-interaction
// sequence with no character dialogue.  When detected, the converter emits
// stub labels instead of converting line-by-line.
//
// Public API:
//   detect_minigame_from_rpy(src: &str) -> MinigameDetectResult
//
// (MinigameDetectResult / MinigameStub are re-exported from rpyc/converter.rs
//  so we define local equivalents and return the same types.)

use std::collections::{HashMap, HashSet};

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Default)]
struct LabelInfo {
    /// Local jump/call targets (to be reclassified after full scan)
    jumps_to: HashSet<String>,
    /// External (file-outside) jump targets
    external_jumps: HashSet<String>,
    /// Whether this label has `call screen` / `show screen` / `renpy.pause()`
    calls_screen: bool,
    /// Whether this label has any dialogue line
    has_dialogue: bool,
}

type ScreenJumps = HashMap<String, HashSet<String>>;

pub struct MinigameStub {
    pub entry_label: String,
    pub exit_label: String,
}

pub struct MinigameDetectResult {
    pub stubs: Vec<MinigameStub>,
    pub warnings: Vec<String>,
}

// ── Reserved labels ────────────────────────────────────────────────────────────

fn is_reserved(name: &str) -> bool {
    matches!(
        name,
        "start" | "splashscreen" | "main_menu" | "after_load"
            | "quit" | "after_warp" | "hide_windows"
    )
}

// ── Dialogue detection ────────────────────────────────────────────────────────

fn is_dialogue_line(line: &str) -> bool {
    if line.is_empty() { return false; }
    // Fast negative checks
    for prefix in &[
        "$", "call ", "jump ", "scene ", "show ", "hide ", "play ", "stop ",
        "with ", "if ", "elif ", "else:", "while ", "menu:", "menu ", "return",
        "pass", "label ", "screen ", "python", "image ", "define ", "default ",
        "init ", "#", "window ", "nvl ", "pause",
    ] {
        if line.starts_with(prefix) { return false; }
    }
    // Bare quoted string → narration
    if line.starts_with('"') || line.starts_with('\'') { return true; }
    // identifier/quoted-name followed by a quoted string:  k "Hello"
    let char_say = regex::Regex::new(r#"^(?:[A-Za-z_]\w*|"[^"]+"|'[^']+')[\s]+"#).unwrap();
    char_say.is_match(line)
}

// ── Strip inline comment ──────────────────────────────────────────────────────

fn strip_comment(line: &str) -> String {
    let mut in_str = false;
    let mut str_char = '\0';
    let chars: Vec<char> = line.chars().collect();
    for (i, &ch) in chars.iter().enumerate() {
        if in_str {
            if ch == '\\' { continue; }
            if ch == str_char { in_str = false; }
        } else {
            match ch {
                '"' | '\'' => { in_str = true; str_char = ch; }
                '#' => return line[..i].trim().to_string(),
                _ => {}
            }
        }
    }
    line.trim().to_string()
}

// ── Phase 1: scan ─────────────────────────────────────────────────────────────

struct ScanResult {
    local_labels: HashSet<String>,
    label_infos: HashMap<String, LabelInfo>,
    screen_jumps: ScreenJumps,
    top_level_jumps: HashSet<String>,
}

#[derive(Clone)]
enum Ctx {
    Top,
    Label(String),
    Screen(String),
}

fn scan_file(src: &str) -> ScanResult {
    let mut local_labels: HashSet<String> = HashSet::new();
    let mut label_infos: HashMap<String, LabelInfo> = HashMap::new();
    let mut screen_jumps: ScreenJumps = HashMap::new();
    let mut top_level_jumps: HashSet<String> = HashSet::new();

    let mut ctx = Ctx::Top;

    // Regexes compiled once
    let re_label     = regex::Regex::new(r"^label\s+(\w+)\s*(?:\(.*\))?\s*:").unwrap();
    let re_screen    = regex::Regex::new(r"^screen\s+(\w+)\s*(?:\(.*\))?\s*:").unwrap();
    let re_cs        = regex::Regex::new(r"^(?:call|show)\s+screen\s+(\w+)").unwrap();
    let re_rpy_pause = regex::Regex::new(r"renpy\.pause\s*\(").unwrap();
    let re_jump      = regex::Regex::new(r"^jump\s+(\w+)").unwrap();
    let re_call      = regex::Regex::new(r"^call\s+(\w+)(?:\s|$)").unwrap();
    let re_rpy_jump_str  = regex::Regex::new(r#"renpy\.jump\s*\(\s*['"](\w+)['"]\s*\)"#).unwrap();
    let re_rpy_jump_bare = regex::Regex::new(r"renpy\.jump\s*\(\s*([A-Za-z_]\w*)\s*\)").unwrap();
    let re_jump_call_str = regex::Regex::new(r#"\bJump\s*\(\s*['"](\w+)['"]\s*\)"#).unwrap();
    let re_jump_call_bare= regex::Regex::new(r"\bJump\s*\(\s*([A-Za-z_]\w*)\s*\)").unwrap();
    let re_new_block = regex::Regex::new(
        r"^(?:label\s+\w+|screen\s+\w+|init\b|python\b|image\s|define\s|default\s|transform\s|style\s)"
    ).unwrap();

    for raw_line in src.lines() {
        let indent = raw_line.chars().take_while(|c| *c == ' ').count();
        let trimmed = strip_comment(raw_line.trim());
        if trimmed.is_empty() { continue; }

        // Context switch back to top at indent 0
        if indent == 0 {
            if let Ctx::Label(_) | Ctx::Screen(_) = &ctx {
                if re_new_block.is_match(&trimmed) {
                    ctx = Ctx::Top;
                }
            }
        }

        // label declaration
        if let Some(cap) = re_label.captures(&trimmed) {
            let name = cap[1].to_string();
            local_labels.insert(name.clone());
            label_infos.entry(name.clone()).or_default();
            ctx = Ctx::Label(name);
            continue;
        }

        // screen declaration
        if let Some(cap) = re_screen.captures(&trimmed) {
            let name = cap[1].to_string();
            screen_jumps.entry(name.clone()).or_default();
            ctx = Ctx::Screen(name);
            continue;
        }

        // Inside a label
        if let Ctx::Label(ref lname) = ctx.clone() {
            let info = label_infos.entry(lname.clone()).or_default();

            if re_cs.is_match(&trimmed) {
                info.calls_screen = true;
                continue;
            }
            if re_rpy_pause.is_match(&trimmed) {
                info.calls_screen = true;
                continue;
            }
            if let Some(cap) = re_jump.captures(&trimmed) {
                info.jumps_to.insert(cap[1].to_string());
                continue;
            }
            if let Some(cap) = re_call.captures(&trimmed) {
                if &cap[1] != "screen" {
                    info.jumps_to.insert(cap[1].to_string());
                }
                continue;
            }
            for cap in re_rpy_jump_str.captures_iter(&trimmed) {
                info.jumps_to.insert(cap[1].to_string());
            }
            for cap in re_rpy_jump_bare.captures_iter(&trimmed) {
                info.jumps_to.insert(cap[1].to_string());
            }
            if is_dialogue_line(&trimmed) {
                info.has_dialogue = true;
            }
            continue;
        }

        // Inside a screen
        if let Ctx::Screen(ref sname) = ctx.clone() {
            let targets = screen_jumps.entry(sname.clone()).or_default();
            for cap in re_jump_call_str.captures_iter(&trimmed) { targets.insert(cap[1].to_string()); }
            for cap in re_jump_call_bare.captures_iter(&trimmed) { targets.insert(cap[1].to_string()); }
            for cap in re_rpy_jump_str.captures_iter(&trimmed) { targets.insert(cap[1].to_string()); }
            for cap in re_rpy_jump_bare.captures_iter(&trimmed) { targets.insert(cap[1].to_string()); }
            if let Some(cap) = re_jump.captures(&trimmed) { targets.insert(cap[1].to_string()); }
            continue;
        }

        // Top level — collect any renpy.jump / Jump() calls
        for cap in re_rpy_jump_str.captures_iter(&trimmed) { top_level_jumps.insert(cap[1].to_string()); }
        for cap in re_rpy_jump_bare.captures_iter(&trimmed) { top_level_jumps.insert(cap[1].to_string()); }
        for cap in re_jump_call_str.captures_iter(&trimmed) { top_level_jumps.insert(cap[1].to_string()); }
        for cap in re_jump_call_bare.captures_iter(&trimmed) { top_level_jumps.insert(cap[1].to_string()); }
    }

    ScanResult { local_labels, label_infos, screen_jumps, top_level_jumps }
}

// ── Phase 2: classify ─────────────────────────────────────────────────────────

fn classify_and_merge(src: &str, result: &mut ScanResult) {
    let local_labels = &result.local_labels.clone();
    let screen_jumps = &result.screen_jumps.clone();
    let top_level_jumps = &result.top_level_jumps.clone();

    // Reclassify jump targets: local vs external
    for info in result.label_infos.values_mut() {
        let mut to_move: Vec<String> = Vec::new();
        for t in info.jumps_to.iter() {
            if !local_labels.contains(t) {
                to_move.push(t.clone());
            }
        }
        for t in to_move {
            info.jumps_to.remove(&t);
            info.external_jumps.insert(t);
        }
    }

    // Merge screen jump targets into labels that call those screens
    let re_label  = regex::Regex::new(r"^label\s+(\w+)").unwrap();
    let re_cs     = regex::Regex::new(r"^(?:call|show)\s+screen\s+(\w+)").unwrap();
    let re_new    = regex::Regex::new(r"^(?:init\b|python\b|image\s|define\s|default\s|transform\s|style\s)").unwrap();

    let mut cur_label: Option<String> = None;
    for raw_line in src.lines() {
        let indent = raw_line.chars().take_while(|c| *c == ' ').count();
        let trimmed = strip_comment(raw_line.trim());
        if trimmed.is_empty() { continue; }

        if indent == 0 {
            if let Some(cap) = re_label.captures(&trimmed) {
                cur_label = Some(cap[1].to_string());
                continue;
            }
            if re_new.is_match(&trimmed) {
                cur_label = None;
            }
        }

        if let Some(ref lname) = cur_label {
            if let Some(cap) = re_cs.captures(&trimmed) {
                let sname = &cap[1];
                if let Some(targets) = screen_jumps.get(sname) {
                    if let Some(info) = result.label_infos.get_mut(lname) {
                        for t in targets {
                            if local_labels.contains(t) {
                                info.jumps_to.insert(t.clone());
                            } else {
                                info.external_jumps.insert(t.clone());
                            }
                        }
                    }
                }
            }
        }
    }

    // Inject top-level jumps into minigame candidates with no external exits
    for info in result.label_infos.values_mut() {
        if info.external_jumps.is_empty() && info.calls_screen && !info.has_dialogue {
            for t in top_level_jumps.iter() {
                if !local_labels.contains(t) {
                    info.external_jumps.insert(t.clone());
                }
            }
        }
    }
}

// ── Phase 3: find entry candidates ───────────────────────────────────────────

fn find_entry_candidates(result: &ScanResult) -> Vec<String> {
    let mut referenced: HashSet<String> = HashSet::new();
    for info in result.label_infos.values() {
        for t in &info.jumps_to { referenced.insert(t.clone()); }
    }
    for (_, targets) in &result.screen_jumps {
        for t in targets {
            if result.local_labels.contains(t) { referenced.insert(t.clone()); }
        }
    }

    result.local_labels.iter()
        .filter(|name| {
            if referenced.contains(*name) { return false; }
            if is_reserved(name) { return false; }
            result.label_infos.get(*name)
                .map(|i| i.calls_screen && !i.has_dialogue)
                .unwrap_or(false)
        })
        .cloned()
        .collect()
}

// ── Phase 4: BFS external exits ───────────────────────────────────────────────

fn collect_external_exits(entry: &str, result: &ScanResult) -> HashSet<String> {
    let mut visited: HashSet<String> = HashSet::new();
    let mut queue: Vec<String> = vec![entry.to_string()];
    let mut exits: HashSet<String> = HashSet::new();

    while let Some(cur) = queue.pop() {
        if visited.contains(&cur) { continue; }
        visited.insert(cur.clone());

        if let Some(info) = result.label_infos.get(&cur) {
            for e in &info.external_jumps { exits.insert(e.clone()); }
            for l in &info.jumps_to {
                if !visited.contains(l) { queue.push(l.clone()); }
            }
        }
    }
    exits
}

// ── Public API ─────────────────────────────────────────────────────────────────

/// Analyse a `.rpy` source string and return minigame stubs.
/// Returns empty stubs when the file is not a minigame.
pub fn detect_minigame_from_rpy(src: &str) -> MinigameDetectResult {
    let mut warnings: Vec<String> = Vec::new();

    let mut result = scan_file(src);
    classify_and_merge(src, &mut result);

    // Early-out: any label with dialogue → normal script
    for info in result.label_infos.values() {
        if info.has_dialogue {
            return MinigameDetectResult { stubs: vec![], warnings };
        }
    }

    let candidates = find_entry_candidates(&result);
    if candidates.is_empty() {
        return MinigameDetectResult { stubs: vec![], warnings };
    }

    let mut stubs: Vec<MinigameStub> = Vec::new();
    for entry in candidates {
        let exits = collect_external_exits(&entry, &result);
        if exits.is_empty() { continue; }
        if exits.len() > 1 {
            warnings.push(format!(
                "minigame-detect: entry \"{}\" has {} exits: {}. Skipping.",
                entry, exits.len(),
                exits.iter().cloned().collect::<Vec<_>>().join(", ")
            ));
            continue;
        }
        stubs.push(MinigameStub {
            entry_label: entry,
            exit_label: exits.into_iter().next().unwrap(),
        });
    }

    MinigameDetectResult { stubs, warnings }
}
