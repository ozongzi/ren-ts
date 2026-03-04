use lazy_static::lazy_static;
use regex::Regex;
use std::collections::{HashMap, HashSet, VecDeque};

use super::super::pickle::helpers::{as_list, as_string, short_class};
use super::super::pickle::{PickleObject, PickleValue};

lazy_static! {
    static ref RC_0: Regex = Regex::new(r#"^renpy\.jump\s*\(\s*["']?(\w+)["']?\s*\)"#).unwrap();
    static ref RC_1: Regex = Regex::new(r#"^renpy\.call\s*\(\s*["']?(\w+)["']?\s*\)"#).unwrap();
    static ref RC_2: Regex = Regex::new(r#"Character\s*\(\s*(?:name\s*=\s*)?["']([^"']+)["']"#).unwrap();
    static ref RC_3: Regex = Regex::new(r#"^["']([^"']+)["']$"#).unwrap();
    static ref RC_4: Regex = Regex::new(r#"Movie\s*\(\s*(?:play\s*=\s*)?["']([^"']+)["']"#).unwrap();
    static ref RC_5: Regex = Regex::new(r#"^(?:play\s+)?voice\s+["']([^"']+)["']"#).unwrap();
    static ref RC_6: Regex = Regex::new(r#"\bJump\s*\(\s*['"]?(\w+)['"]?\s*\)"#).unwrap();
    static ref RC_7: Regex = Regex::new(r#"renpy\.jump\s*\(\s*['"]?(\w+)['"]?\s*\)"#).unwrap();
    static ref RC_8: Regex = Regex::new(r#"renpy\.jump\s*\(\s*['"]?([A-Za-z_]\w*)['"]?\s*\)"#).unwrap();
    static ref RC_9: Regex = Regex::new(r"[^A-Za-z0-9_]").unwrap();
    static ref RC_10: Regex = Regex::new(r"^[Dd]issolve\s*\(").unwrap();
    static ref RC_11: Regex = Regex::new(r"^Fade\s*\(").unwrap();
    static ref RC_12: Regex = Regex::new(r"(?i)^(movetransition|blinds|pixellate|vpunch|hpunch|wipe|ease|bounce|zoomin|zoomout|irisfade|squares)").unwrap();
    static ref RC_13: Regex = Regex::new(r"\(.*\)").unwrap();
    static ref RC_14: Regex = Regex::new(r"\band\b").unwrap();
    static ref RC_15: Regex = Regex::new(r"\bor\b").unwrap();
    static ref RC_16: Regex = Regex::new(r"\bnot\s+").unwrap();
    static ref RC_17: Regex = Regex::new(r"\{[^{}]*\}").unwrap();
    static ref RC_18: Regex = Regex::new(r"^[a-z_][a-z0-9_]*$").unwrap();
    static ref RC_19: Regex = Regex::new(r"^gui\.init\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)").unwrap();
    static ref RC_20: Regex = Regex::new(r"^renpy\.pause\s*\(\s*([\d.]+)").unwrap();
    static ref RC_21: Regex = Regex::new(r"^renpy\.pause\s*\(").unwrap();
    static ref RC_22: Regex = Regex::new(r"^renpy\.music\.stop\s*\(.*?fadeout\s*=\s*([\d.]+)").unwrap();
    static ref RC_23: Regex = Regex::new(r"^renpy\.music\.stop\s*\(").unwrap();
    static ref RC_24: Regex = Regex::new(r"^(\w+)\s*=\s*Position\s*\(\s*xpos\s*=\s*([\d.]+)").unwrap();
    static ref RC_25: Regex = Regex::new(r"^([\w.]+)\s*(=|\+=|-=|\*=|/=)\s*(.+)$").unwrap();
    static ref RC_26: Regex = Regex::new(r"Position\s*\(\s*xpos\s*=\s*([\d.]+)").unwrap();
    static ref RC_27: Regex = Regex::new(r"^(?:play\s+)?voice\s+audio\.(\w+)").unwrap();
    static ref RC_28: Regex = Regex::new(r"^(?:call|show)\s+screen\s+\w+").unwrap();
    static ref RC_29: Regex = Regex::new(r"renpy\.pause\s*\(").unwrap();
}

// ── Shared helpers ────────────────────────────────────────────────────────────

fn esc_str(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn fmt_speaker(name: &str) -> String {
    let special = &*RC_9;
    if special.is_match(name) {
        format!("\"{}\"", esc_str(name))
    } else {
        name.to_string()
    }
}

fn norm_transition(raw: &str) -> String {
    let t = raw.trim();
    if RC_10.is_match(t) || t == "dissolve" {
        return "dissolve".to_string();
    }
    if t == "fade" || t == "Fade" || RC_11.is_match(t) {
        return "fade".to_string();
    }
    if t.to_lowercase().starts_with("flash") {
        return "flash".to_string();
    }
    if t == "None" || t == "none" {
        return "".to_string();
    }
    if RC_12.is_match(t) {
        return "".to_string();
    }
    RC_13.replace(t, "").trim().to_lowercase()
}

fn norm_condition(cond: &str) -> String {
    let s = RC_14.replace_all(cond.trim(), "&&");
    let s = RC_15.replace_all(&s, "||");
    RC_16.replace_all(&s, "! ").to_string()
}

fn fmt_float(n: f64) -> String {
    if n == n.floor() {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

fn strip_rpy_tags(s: &str) -> String {
    RC_17.replace_all(s, "").trim().to_string()
}

// ── imspec ────────────────────────────────────────────────────────────────────

const KNOWN_POSITIONS: &[&str] = &[
    "left",
    "cleft",
    "center",
    "cright",
    "right",
    "truecenter",
    "left1",
    "left2",
    "left3",
    "left4",
    "right1",
    "right2",
    "right3",
    "right4",
];

struct ImspecResult {
    key: String,
    #[allow(dead_code)]
    tag: String,
    pos: Option<String>,
}

fn parse_imspec(imspec: &PickleValue) -> ImspecResult {
    let items = match as_list(imspec) {
        Some(l) if !l.is_empty() => l,
        _ => {
            return ImspecResult {
                key: "unknown".to_string(),
                tag: "unknown".to_string(),
                pos: None,
            }
        }
    };

    let name_parts: Vec<String> = match as_list(&items[0]) {
        Some(l) => l.iter().filter_map(|p| as_string(p)).collect(),
        None => as_string(&items[0]).map(|s| vec![s]).unwrap_or_default(),
    };

    let key = name_parts.join("_");
    let tag = name_parts
        .first()
        .cloned()
        .unwrap_or_else(|| "unknown".to_string());

    let at_list_raw = if items.len() == 3 {
        Some(&items[1])
    } else if items.len() >= 6 {
        Some(&items[3])
    } else {
        None
    };

    let pos = at_list_raw.and_then(|raw| {
        as_list(raw)?.iter().find_map(|at_item| {
            let s = as_string(at_item)?;
            let low = s.to_lowercase();
            let low = low.trim();
            if KNOWN_POSITIONS.contains(&low) {
                return Some(low.to_string());
            }
            if RC_18.is_match(low) {
                return Some(low.to_string());
            }
            None
        })
    });

    ImspecResult { key, tag, pos }
}

// ── SpeakBuffer ───────────────────────────────────────────────────────────────

struct SpeakLine {
    text: String,
    voice: Option<String>,
}
struct SpeakBuffer {
    who: String,
    lines: Vec<SpeakLine>,
}

// ── AstConverter ─────────────────────────────────────────────────────────────

pub struct AstConverter {
    out: Vec<String>,
    depth: usize,
    speak_buf: Option<SpeakBuffer>,
    pending_voice: Option<String>,
    pending_with: Option<String>,
    stub_map: HashMap<String, String>,
    filename: String,
    translation_map: Option<HashMap<String, String>>,
}

impl AstConverter {
    pub fn new(
        filename: String,
        translation_map: Option<HashMap<String, String>>,
        stubs: Option<Vec<(String, String)>>,
    ) -> Self {
        Self {
            out: Vec::new(),
            depth: 0,
            speak_buf: None,
            pending_voice: None,
            pending_with: None,
            stub_map: stubs.unwrap_or_default().into_iter().collect(),
            filename,
            translation_map,
        }
    }

    fn pad(&self) -> String {
        "  ".repeat(self.depth)
    }

    fn emit(&mut self, line: String) {
        self.out.push(line);
    }

    fn translate(&self, text: &str) -> String {
        self.translation_map
            .as_ref()
            .and_then(|m| m.get(text))
            .cloned()
            .unwrap_or_else(|| text.to_string())
    }

    // ── speak buffer ──────────────────────────────────────────────────────────

    fn flush_speak(&mut self) {
        let buf = match self.speak_buf.take() {
            Some(b) => b,
            None => return,
        };
        let pad = self.pad();
        let sp = fmt_speaker(&buf.who);
        if buf.lines.len() == 1 {
            let l = &buf.lines[0];
            let voice_part = l
                .voice
                .as_ref()
                .map_or(String::new(), |v| format!(" | \"{}\"", esc_str(v)));
            self.emit(format!(
                "{}speak {} \"{}\"{};",
                pad,
                sp,
                esc_str(&l.text),
                voice_part
            ));
        } else {
            self.emit(format!("{}speak {} {{", pad, sp));
            let lines: Vec<_> = buf.lines.into_iter().collect();
            for l in lines {
                let inner = format!("{}  ", self.pad());
                let voice_part = l
                    .voice
                    .as_ref()
                    .map_or(String::new(), |v| format!(" | \"{}\"", esc_str(v)));
                self.emit(format!("{}\"{}\" {};", inner, esc_str(&l.text), voice_part));
            }
            let pad = self.pad();
            self.emit(format!("{}}}", pad));
        }
    }

    fn add_speak_line(&mut self, who: &str, text: &str, voice: Option<String>) {
        let flush = self.speak_buf.as_ref().map_or(false, |b| b.who != who);
        if flush {
            self.flush_speak();
        }
        if self.speak_buf.is_none() {
            self.speak_buf = Some(SpeakBuffer {
                who: who.to_string(),
                lines: Vec::new(),
            });
        }
        self.speak_buf.as_mut().unwrap().lines.push(SpeakLine {
            text: text.to_string(),
            voice,
        });
    }

    // ── node dispatcher ───────────────────────────────────────────────────────

    pub fn process_nodes(&mut self, nodes: &[PickleValue]) {
        for (i, node) in nodes.iter().enumerate() {
            if let Some(obj) = node.as_object() {
                // Skip Return that immediately follows a Jump (Ren'Py appends
                // an unconditional Return after every Jump in the AST).
                if short_class(obj) == "Return" {
                    let prev_is_jump = i > 0
                        && nodes[i - 1]
                            .as_object()
                            .map(|p| short_class(p) == "Jump")
                            .unwrap_or(false);
                    // Also skip if it's the very last node in the list AND
                    // the last emitted line already ends with return; or jump;
                    let last_is_terminal = self
                        .out
                        .last()
                        .map(|l| {
                            let t = l.trim();
                            t.ends_with("return;")
                                || t.ends_with(';') && {
                                    let w = t.split_whitespace().next().unwrap_or("");
                                    w == "jump" || w == "return"
                                }
                        })
                        .unwrap_or(false);
                    if prev_is_jump || (i == nodes.len() - 1 && last_is_terminal) {
                        continue;
                    }
                }
                self.process_node(obj);
            }
        }
    }

    fn process_node(&mut self, node: &PickleObject) {
        match short_class(node) {
            "Label" => {
                let n = node.clone();
                self.process_label(&n);
            }
            "Say" | "TranslateSay" => {
                let n = node.clone();
                self.process_say(&n);
            }
            "Show" => {
                let n = node.clone();
                self.process_show(&n);
            }
            "Scene" => {
                let n = node.clone();
                self.process_scene(&n);
            }
            "Hide" => {
                let n = node.clone();
                self.process_hide(&n);
            }
            "With" => {
                let n = node.clone();
                self.process_with_node(&n);
            }
            "Jump" => {
                let n = node.clone();
                self.process_jump(&n);
            }
            "Call" => {
                let n = node.clone();
                self.process_call(&n);
            }
            "Return" => self.process_return(),
            "Menu" => {
                let n = node.clone();
                self.process_menu(&n);
            }
            "If" => {
                let n = node.clone();
                self.process_if(&n);
            }
            "While" => {
                let n = node.clone();
                self.process_while(&n);
            }
            "Python" | "EarlyPython" => {
                let n = node.clone();
                self.process_python(&n);
            }
            "Define" => {
                let n = node.clone();
                self.process_define(&n);
            }
            "Default" => {
                let n = node.clone();
                self.process_default(&n);
            }
            "Init" => {
                let n = node.clone();
                self.process_init(&n);
            }
            "UserStatement" => {
                let n = node.clone();
                self.process_user_statement(&n);
            }
            "Image" => {
                let n = node.clone();
                self.process_image(&n);
            }
            "Pass"
            | "EndTranslate"
            | "TranslateBlock"
            | "TranslateEarlyBlock"
            | "TranslatePython"
            | "TranslateString"
            | "Translate" => {}
            cls => {
                let pad = self.pad();
                self.emit(format!(
                    "{}// [rpyc skip] {} ({})",
                    pad, cls, node.class_name
                ));
            }
        }
    }

    // ── Label ─────────────────────────────────────────────────────────────────

    fn process_label(&mut self, node: &PickleObject) {
        self.flush_speak();

        let name = node
            .fields
            .get("name")
            .and_then(|v| as_string(v))
            .unwrap_or_else(|| "unknown".to_string());
        let hide = node.fields.get("hide");
        if matches!(
            hide,
            Some(PickleValue::Bool(true)) | Some(PickleValue::Int(1))
        ) {
            return;
        }

        if self.depth > 0 {
            self.depth -= 1;
            let pad = self.pad();
            self.emit(format!("{}}}", pad));
        }

        if let Some(exit) = self.stub_map.get(&name).cloned() {
            self.emit(format!("label {} {{", name));
            self.emit(format!("  jump {};", exit));
            self.emit("}".to_string());
            return;
        }

        self.emit(format!("label {} {{", name));
        self.depth = 1;

        if let Some(block) = node.fields.get("block").and_then(|v| as_list(v)) {
            let block = block.to_vec();
            self.process_nodes(&block);
        }
    }

    // ── Say ───────────────────────────────────────────────────────────────────

    fn process_say(&mut self, node: &PickleObject) {
        let who = node
            .fields
            .get("who")
            .and_then(|v| as_string(v))
            .unwrap_or_default();
        let raw_what = node
            .fields
            .get("what")
            .and_then(|v| as_string(v))
            .unwrap_or_default();
        let what = self.translate(&strip_rpy_tags(&raw_what));

        let voice = self.pending_voice.take();
        let speaker = if who.is_empty() {
            "narrator".to_string()
        } else {
            who
        };
        self.add_speak_line(&speaker, &what, voice);

        if let Some(with_expr) = node.fields.get("with_").and_then(|v| as_string(v)) {
            if with_expr != "None" {
                let trans = norm_transition(&with_expr);
                if !trans.is_empty() {
                    self.pending_with = Some(trans);
                }
            }
        }
    }

    // ── Show ──────────────────────────────────────────────────────────────────

    fn process_show(&mut self, node: &PickleObject) {
        self.flush_speak();
        let imspec = match node.fields.get("imspec") {
            Some(v) => v,
            None => return,
        };
        let ImspecResult { key, pos, .. } = parse_imspec(imspec);

        let trans = node
            .fields
            .get("with_")
            .and_then(|v| as_string(v))
            .filter(|s| s != "None")
            .map(|s| norm_transition(&s))
            .filter(|s| !s.is_empty());

        let effective_trans = self.pending_with.take().or(trans);
        let pos_part = pos.as_ref().map_or(String::new(), |p| format!(" @ {}", p));
        let trans_part = effective_trans
            .as_ref()
            .map_or(String::new(), |t| format!(" | {}", t));
        let pad = self.pad();
        self.emit(format!("{}show {}{}{};", pad, key, pos_part, trans_part));
    }

    // ── Scene ─────────────────────────────────────────────────────────────────

    fn process_scene(&mut self, node: &PickleObject) {
        self.flush_speak();

        let with_trans = node
            .fields
            .get("with_")
            .and_then(|v| as_string(v))
            .filter(|s| s != "None")
            .map(|s| norm_transition(&s))
            .filter(|s| !s.is_empty());
        let effective_trans = self.pending_with.take().or(with_trans);
        let trans_part = effective_trans
            .as_ref()
            .map_or(String::new(), |t| format!(" | {}", t));
        let pad = self.pad();

        match node.fields.get("imspec") {
            None => {
                self.emit(format!("{}scene #000000{};", pad, trans_part));
                return;
            }
            Some(imspec) => {
                let ImspecResult { key, .. } = parse_imspec(imspec);
                match key.as_str() {
                    "black" => self.emit(format!("{}scene #000000{};", pad, trans_part)),
                    "white" => self.emit(format!("{}scene #ffffff{};", pad, trans_part)),
                    _ => self.emit(format!("{}scene \"{}\"{};", pad, key, trans_part)),
                }
            }
        }
    }

    // ── Hide ──────────────────────────────────────────────────────────────────

    fn process_hide(&mut self, node: &PickleObject) {
        self.flush_speak();
        let imspec = match node.fields.get("imspec") {
            Some(v) => v,
            None => return,
        };
        let ImspecResult { key, .. } = parse_imspec(imspec);
        let pad = self.pad();
        self.emit(format!("{}hide {};", pad, key));
    }

    // ── With ──────────────────────────────────────────────────────────────────

    fn process_with_node(&mut self, node: &PickleObject) {
        let expr = match node.fields.get("expr").and_then(|v| as_string(v)) {
            Some(e) => e,
            None => return,
        };
        if expr == "None" {
            return;
        }
        let trans = norm_transition(&expr);
        if trans.is_empty() {
            return;
        }
        self.flush_speak();
        self.pending_with = Some(trans.clone());
        let pad = self.pad();
        self.emit(format!("{}with {};", pad, trans));
        self.pending_with = None;
    }

    // ── Jump ──────────────────────────────────────────────────────────────────

    fn process_jump(&mut self, node: &PickleObject) {
        self.flush_speak();
        let target = node
            .fields
            .get("target")
            .and_then(|v| as_string(v))
            .unwrap_or_else(|| "unknown".to_string());
        let pad = self.pad();
        self.emit(format!("{}jump {};", pad, target));
    }

    // ── Call ──────────────────────────────────────────────────────────────────

    fn process_call(&mut self, node: &PickleObject) {
        self.flush_speak();
        let label = node
            .fields
            .get("label")
            .and_then(|v| as_string(v))
            .unwrap_or_else(|| "unknown".to_string());
        let pad = self.pad();
        self.emit(format!("{}call {};", pad, label));
    }

    // ── Return ────────────────────────────────────────────────────────────────

    fn process_return(&mut self) {
        self.flush_speak();
        let pad = self.pad();
        self.emit(format!("{}return;", pad));
    }

    // ── Menu ──────────────────────────────────────────────────────────────────

    fn process_menu(&mut self, node: &PickleObject) {
        self.flush_speak();
        let items_raw = match node.fields.get("items").and_then(|v| as_list(v)) {
            Some(l) if !l.is_empty() => l.to_vec(),
            _ => return,
        };
        let pad = self.pad();
        self.emit(format!("{}menu {{", pad));
        self.depth += 1;

        for item in &items_raw {
            let item_arr = match as_list(item) {
                Some(a) if a.len() >= 2 => a.to_vec(),
                _ => continue,
            };
            let label_str = match as_string(&item_arr[0]) {
                Some(s) => s,
                None => continue,
            };
            let cond_raw = as_string(&item_arr[1]);
            let block_raw = item_arr.get(2).cloned();

            let translated = self.translate(&strip_rpy_tags(&label_str));
            let cond_part = cond_raw
                .as_ref()
                .filter(|c| *c != "True" && c.trim() != "True")
                .map_or(String::new(), |c| format!(" if {}", norm_condition(c)));

            match block_raw.as_ref().and_then(|v| as_list(v)) {
                None => {
                    let pad = self.pad();
                    self.emit(format!("{}// [caption] \"{}\"", pad, esc_str(&translated)));
                }
                Some(block_nodes) => {
                    let block_nodes = block_nodes.to_vec();
                    let pad = self.pad();
                    self.emit(format!(
                        "{}\"{}\"{}  => {{",
                        pad,
                        esc_str(&translated),
                        cond_part
                    ));
                    self.depth += 1;
                    self.process_nodes(&block_nodes);
                    self.flush_speak();
                    self.depth -= 1;
                    let pad = self.pad();
                    self.emit(format!("{}}}", pad));
                }
            }
        }

        self.depth -= 1;
        let pad = self.pad();
        self.emit(format!("{}}}", pad));
    }

    // ── If ────────────────────────────────────────────────────────────────────

    fn process_if(&mut self, node: &PickleObject) {
        self.flush_speak();
        let entries = match node.fields.get("entries").and_then(|v| as_list(v)) {
            Some(e) if !e.is_empty() => e.to_vec(),
            _ => return,
        };

        for (i, entry) in entries.iter().enumerate() {
            let pair = match as_list(entry) {
                Some(p) if p.len() >= 2 => p.to_vec(),
                _ => continue,
            };
            let cond_raw = as_string(&pair[0]).unwrap_or_else(|| "True".to_string());
            let block_nodes = match as_list(&pair[1]) {
                Some(b) => b.to_vec(),
                None => continue,
            };
            let is_else = cond_raw == "True";

            if i == 0 {
                let pad = self.pad();
                self.emit(format!("{}if {} {{", pad, norm_condition(&cond_raw)));
            } else {
                let pad = self.pad();
                let close = format!("{}}}", pad);
                if is_else {
                    if self.out.last().map_or(false, |l| l == &close) {
                        *self.out.last_mut().unwrap() = format!("{}}} else {{", pad);
                    } else {
                        self.emit(format!("{}}} else {{", pad));
                    }
                } else {
                    let elif_str = format!("{}}} elif {} {{", pad, norm_condition(&cond_raw));
                    if self.out.last().map_or(false, |l| l == &close) {
                        *self.out.last_mut().unwrap() = elif_str;
                    } else {
                        self.emit(elif_str);
                    }
                }
            }

            self.depth += 1;
            self.process_nodes(&block_nodes);
            self.flush_speak();
            self.depth -= 1;
            let pad = self.pad();
            self.emit(format!("{}}}", pad));
        }
    }

    // ── While ─────────────────────────────────────────────────────────────────

    fn process_while(&mut self, node: &PickleObject) {
        self.flush_speak();
        let cond = node
            .fields
            .get("condition")
            .and_then(|v| as_string(v))
            .unwrap_or_else(|| "True".to_string());
        let pad = self.pad();
        self.emit(format!(
            "{}// [while {}] — not converted",
            pad,
            norm_condition(&cond)
        ));
    }

    // ── Python ────────────────────────────────────────────────────────────────

    fn process_python(&mut self, node: &PickleObject) {
        let code_obj = node.fields.get("code");
        let src = code_obj.and_then(|v| {
            if let Some(obj) = v.as_object() {
                obj.fields.get("source").and_then(|s| as_string(s))
            } else {
                as_string(v)
            }
        });
        let src = match src {
            Some(s) => s,
            None => return,
        };
        for raw_line in src.split('\n') {
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            self.process_python_line(line);
        }
    }

    fn process_python_line(&mut self, line: &str) {
        let pad = self.pad();

        let gui_init = &*RC_19;
        if let Some(cap) = gui_init.captures(line) {
            self.flush_speak();
            self.emit(format!("{}config.screen_width = {};", pad, &cap[1]));
            self.emit(format!("{}config.screen_height = {};", pad, &cap[2]));
            return;
        }
        let pause_re = &*RC_20;
        if let Some(cap) = pause_re.captures(line) {
            self.flush_speak();
            self.emit(format!(
                "{}wait({});",
                pad,
                fmt_float(cap[1].parse().unwrap_or(0.0))
            ));
            return;
        }
        if RC_21.is_match(line) {
            return;
        }

        let jump_re = &*RC_0;
        if let Some(cap) = jump_re.captures(line) {
            self.flush_speak();
            self.emit(format!("{}jump {};", pad, &cap[1]));
            return;
        }
        let call_re = &*RC_1;
        if let Some(cap) = call_re.captures(line) {
            self.flush_speak();
            self.emit(format!("{}call {};", pad, &cap[1]));
            return;
        }
        let music_fade = &*RC_22;
        if let Some(cap) = music_fade.captures(line) {
            self.flush_speak();
            self.emit(format!(
                "{}music::stop() | fadeout({});",
                pad,
                fmt_float(cap[1].parse().unwrap_or(0.0))
            ));
            return;
        }
        if RC_23.is_match(line) {
            self.flush_speak();
            self.emit(format!("{}music::stop();", pad));
            return;
        }
        let pos_re = &*RC_24;
        if let Some(cap) = pos_re.captures(line) {
            self.emit(format!("position.{} = {};", &cap[1], &cap[2]));
            return;
        }
        let assign_re = &*RC_25;
        if let Some(cap) = assign_re.captures(line) {
            let var_name = &cap[1];
            if var_name.starts_with("renpy.")
                || var_name.starts_with("persistent.")
                || var_name.starts_with("config.")
            {
                return;
            }
            let op = &cap[2];
            let mut val = cap[3].trim().to_string();
            val = val.replace("True", "true").replace("False", "false");
            if let Some(ci) = val.find('#') {
                val = val[..ci].trim().to_string();
            }
            self.flush_speak();
            self.emit(format!("{}{} {} {};", pad, var_name, op, val));
            return;
        }

        self.emit(format!("{}// [py] {}", pad, line));
    }

    // ── Define ────────────────────────────────────────────────────────────────

    fn process_define(&mut self, node: &PickleObject) {
        let store = node
            .fields
            .get("store")
            .and_then(|v| as_string(v))
            .unwrap_or_else(|| "store".to_string());
        let varname = node
            .fields
            .get("varname")
            .and_then(|v| as_string(v))
            .unwrap_or_default();

        let src = node.fields.get("code").and_then(|v| {
            if let Some(obj) = v.as_object() {
                obj.fields.get("source").and_then(|s| as_string(s))
            } else {
                as_string(v)
            }
        });
        let src = match src {
            Some(s) => s,
            None => return,
        };

        let key = if store == "store" {
            varname.clone()
        } else {
            format!("{}.{}", store.trim_start_matches("store."), varname)
        };

        if key.starts_with("audio.") {
            self.emit(format!("{} = {};", key, src.trim()));
            return;
        }
        let char_re = &*RC_2;
        if let Some(cap) = char_re.captures(&src) {
            self.emit(format!("char.{} = \"{}\";", varname, esc_str(&cap[1])));
            return;
        }
        let pos_re = &*RC_26;
        if let Some(cap) = pos_re.captures(&src) {
            self.emit(format!("position.{} = {};", varname, &cap[1]));
            return;
        }
        if self.depth == 0 {
            let mut val = src.trim().to_string();
            val = val.replace("True", "true").replace("False", "false");
            self.emit(format!("{} = {};", key, val));
        }
    }

    // ── Default ───────────────────────────────────────────────────────────────

    fn process_default(&mut self, node: &PickleObject) {
        let varname = node
            .fields
            .get("varname")
            .and_then(|v| as_string(v))
            .unwrap_or_default();
        let src = node.fields.get("code").and_then(|v| {
            if let Some(obj) = v.as_object() {
                obj.fields.get("source").and_then(|s| as_string(s))
            } else {
                as_string(v)
            }
        });
        if let (Some(src), false) = (src, varname.is_empty()) {
            let mut val = src.trim().to_string();
            val = val.replace("True", "true").replace("False", "false");
            let pad = self.pad();
            self.emit(format!("{}{} = {};", pad, varname, val));
        }
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    fn process_init(&mut self, node: &PickleObject) {
        if let Some(block) = node.fields.get("block").and_then(|v| as_list(v)) {
            let block = block.to_vec();
            self.process_nodes(&block);
        }
    }

    // ── Image ─────────────────────────────────────────────────────────────────

    fn process_image(&mut self, node: &PickleObject) {
        let imgname = match node.fields.get("imgname") {
            Some(v) => v,
            None => return,
        };
        let name_parts: Vec<String> = match as_list(imgname) {
            Some(l) => l.iter().filter_map(|p| as_string(p)).collect(),
            None => return,
        };
        if name_parts.is_empty() {
            return;
        }

        let key = name_parts
            .join("_")
            .to_lowercase()
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect::<String>();

        let src = node.fields.get("code").and_then(|v| {
            if let Some(obj) = v.as_object() {
                obj.fields.get("source").and_then(|s| as_string(s))
            } else {
                as_string(v)
            }
        });

        if let Some(src) = src {
            let str_re = &*RC_3;
            let movie_re = &*RC_4;
            if let Some(cap) = str_re.captures(src.trim()) {
                self.emit(format!("image.{} = \"{}\";", key, esc_str(&cap[1])));
                return;
            }
            if let Some(cap) = movie_re.captures(&src) {
                self.emit(format!("image.{} = \"{}\";", key, esc_str(&cap[1])));
                return;
            }
        }

        self.emit(format!(
            "// [image] {} (path not resolved)",
            name_parts.join(" ")
        ));
    }

    // ── UserStatement ─────────────────────────────────────────────────────────

    fn process_user_statement(&mut self, node: &PickleObject) {
        let line = node
            .fields
            .get("line")
            .and_then(|v| as_string(v))
            .unwrap_or_default();
        let voice_str = &*RC_5;
        let voice_audio = &*RC_27;
        if let Some(cap) = voice_str.captures(&line) {
            self.pending_voice = Some(cap[1].to_string());
        } else if let Some(cap) = voice_audio.captures(&line) {
            self.pending_voice = Some(format!("audio.{}", &cap[1]));
        }
    }

    // ── Entry point ───────────────────────────────────────────────────────────

    pub fn convert(mut self, root_nodes: &[PickleValue]) -> String {
        self.emit(format!("// Source: {}", self.filename));
        self.emit(String::new());

        self.process_nodes(root_nodes);
        self.flush_speak();

        if self.depth > 0 {
            self.depth = 0;
            self.emit("}".to_string());
        }

        self.out.join("\n") + "\n"
    }
}

// ── unwrapAstNodes ────────────────────────────────────────────────────────────

pub fn unwrap_ast_nodes(ast_pickle: &PickleValue) -> Vec<PickleValue> {
    match ast_pickle {
        PickleValue::List(l) => l.clone(),
        PickleValue::Tuple(items) => {
            if items.len() == 2 {
                if let PickleValue::List(nodes) = &items[1] {
                    return nodes.clone();
                }
            }
            if items.len() == 1 {
                if let PickleValue::List(nodes) = &items[0] {
                    return nodes.clone();
                }
            }
            items.clone()
        }
        v if v.as_object().is_some() => vec![v.clone()],
        _ => vec![],
    }
}

// ── Minigame detection ────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct MinigameStub {
    pub entry_label: String,
    pub exit_label: String,
}

#[derive(Debug)]
pub struct MinigameDetectResult {
    pub stubs: Vec<MinigameStub>,
    pub warnings: Vec<String>,
}

struct AstLabelInfo {
    jumps_to: HashSet<String>,
    external_jumps: HashSet<String>,
    calls_screen: bool,
    has_dialogue: bool,
}

fn fresh_info() -> AstLabelInfo {
    AstLabelInfo {
        jumps_to: HashSet::new(),
        external_jumps: HashSet::new(),
        calls_screen: false,
        has_dialogue: false,
    }
}

fn scan_ast_nodes(
    nodes: &[PickleValue],
    info: &mut AstLabelInfo,
    local_labels: &HashSet<String>,
    screen_jumps: &mut HashMap<String, HashSet<String>>,
    in_screen: bool,
) {
    for raw in nodes {
        let obj = match raw.as_object() {
            Some(o) => o,
            None => continue,
        };
        let cls = short_class(obj);

        match cls {
            "Jump" => {
                if let Some(target) = obj.fields.get("target").and_then(|v| as_string(v)) {
                    if !in_screen {
                        info.jumps_to.insert(target);
                    }
                }
            }
            "Call" => {
                if let Some(target) = obj.fields.get("label").and_then(|v| as_string(v)) {
                    info.jumps_to.insert(target);
                }
            }
            "Say" | "TranslateSay" => {
                if !in_screen {
                    info.has_dialogue = true;
                }
            }
            "UserStatement" => {
                let line = obj
                    .fields
                    .get("line")
                    .and_then(|v| as_string(v))
                    .unwrap_or_default();
                if !in_screen {
                    if RC_28.is_match(&line) || RC_29.is_match(&line) {
                        info.calls_screen = true;
                    }
                }
                if in_screen {
                    for cap in RC_6.captures_iter(&line) {
                        info.jumps_to.insert(cap[1].to_string());
                    }
                    for cap in RC_7.captures_iter(&line) {
                        info.jumps_to.insert(cap[1].to_string());
                    }
                }
            }
            "Python" | "EarlyPython" => {
                let src = obj
                    .fields
                    .get("code")
                    .and_then(|v| {
                        if let Some(o) = v.as_object() {
                            o.fields.get("source").and_then(|s| as_string(s))
                        } else {
                            as_string(v)
                        }
                    })
                    .unwrap_or_default();
                for cap in RC_8.captures_iter(&src) {
                    info.jumps_to.insert(cap[1].to_string());
                }
            }
            "If" => {
                if let Some(entries) = obj.fields.get("entries").and_then(|v| as_list(v)) {
                    let entries = entries.to_vec();
                    for entry in &entries {
                        if let Some(pair) = as_list(entry) {
                            if pair.len() >= 2 {
                                if let Some(block) = as_list(&pair[1]) {
                                    let block = block.to_vec();
                                    scan_ast_nodes(
                                        &block,
                                        info,
                                        local_labels,
                                        screen_jumps,
                                        in_screen,
                                    );
                                }
                            }
                        }
                    }
                }
            }
            "Menu" => {
                if let Some(items) = obj.fields.get("items").and_then(|v| as_list(v)) {
                    let items = items.to_vec();
                    for item in &items {
                        if let Some(arr) = as_list(item) {
                            if arr.len() >= 3 {
                                if let Some(block) = as_list(&arr[2]) {
                                    let block = block.to_vec();
                                    scan_ast_nodes(
                                        &block,
                                        info,
                                        local_labels,
                                        screen_jumps,
                                        in_screen,
                                    );
                                }
                            }
                        }
                    }
                }
            }
            "While" => {
                if let Some(block) = obj.fields.get("block").and_then(|v| as_list(v)) {
                    let block = block.to_vec();
                    scan_ast_nodes(&block, info, local_labels, screen_jumps, in_screen);
                }
            }
            _ => {}
        }
    }
}

fn scan_ast_file(
    root_nodes: &[PickleValue],
) -> (
    HashSet<String>,
    HashMap<String, AstLabelInfo>,
    HashMap<String, HashSet<String>>,
) {
    let mut local_labels = HashSet::new();
    let mut label_infos: HashMap<String, AstLabelInfo> = HashMap::new();
    let mut screen_jumps: HashMap<String, HashSet<String>> = HashMap::new();

    for raw in root_nodes {
        let obj = match raw.as_object() {
            Some(o) => o,
            None => continue,
        };
        let cls = short_class(obj);

        if cls == "Label" {
            let hide = obj.fields.get("hide");
            if matches!(
                hide,
                Some(PickleValue::Bool(true)) | Some(PickleValue::Int(1))
            ) {
                continue;
            }
            let name = match obj.fields.get("name").and_then(|v| as_string(v)) {
                Some(n) => n,
                None => continue,
            };
            local_labels.insert(name.clone());
            let info = label_infos.entry(name).or_insert_with(fresh_info);
            if let Some(block) = obj.fields.get("block").and_then(|v| as_list(v)) {
                let block = block.to_vec();
                scan_ast_nodes(&block, info, &local_labels, &mut screen_jumps, false);
            }
        } else if cls == "Init" {
            if let Some(block) = obj.fields.get("block").and_then(|v| as_list(v)) {
                let block = block.to_vec();
                let mut sink = fresh_info();
                scan_ast_nodes(&block, &mut sink, &local_labels, &mut screen_jumps, false);
                for t in sink.jumps_to {
                    for info in label_infos.values_mut() {
                        info.jumps_to.insert(t.clone());
                    }
                }
            }
        }
    }

    (local_labels, label_infos, screen_jumps)
}

fn classify_and_merge(
    local_labels: &HashSet<String>,
    label_infos: &mut HashMap<String, AstLabelInfo>,
    screen_jumps: &HashMap<String, HashSet<String>>,
) {
    for info in label_infos.values_mut() {
        let mut new_jumps = HashSet::new();
        for t in info.jumps_to.drain() {
            if local_labels.contains(&t) {
                new_jumps.insert(t);
            } else {
                info.external_jumps.insert(t);
            }
        }
        info.jumps_to = new_jumps;
    }
    let screen_targets: Vec<String> = screen_jumps
        .values()
        .flat_map(|s| s.iter().cloned())
        .collect();
    for info in label_infos.values_mut() {
        if !info.calls_screen || info.has_dialogue {
            continue;
        }
        for t in &screen_targets {
            if local_labels.contains(t) {
                info.jumps_to.insert(t.clone());
            } else {
                info.external_jumps.insert(t.clone());
            }
        }
    }
}

const RESERVED_LABELS: &[&str] = &[
    "start",
    "splashscreen",
    "main_menu",
    "after_load",
    "quit",
    "after_warp",
    "hide_windows",
];

fn find_entry_candidates(
    local_labels: &HashSet<String>,
    label_infos: &HashMap<String, AstLabelInfo>,
) -> Vec<String> {
    let mut referenced = HashSet::new();
    for info in label_infos.values() {
        referenced.extend(info.jumps_to.iter().cloned());
    }
    local_labels
        .iter()
        .filter(|name| {
            !referenced.contains(*name)
                && !RESERVED_LABELS.contains(&name.as_str())
                && label_infos
                    .get(*name)
                    .map_or(false, |i| i.calls_screen && !i.has_dialogue)
        })
        .cloned()
        .collect()
}

fn collect_external_exits(
    entry_label: &str,
    label_infos: &HashMap<String, AstLabelInfo>,
) -> HashSet<String> {
    let mut visited = HashSet::new();
    let mut queue = VecDeque::new();
    let mut external_exits = HashSet::new();
    queue.push_back(entry_label.to_string());
    while let Some(current) = queue.pop_front() {
        if visited.contains(&current) {
            continue;
        }
        visited.insert(current.clone());
        if let Some(info) = label_infos.get(&current) {
            external_exits.extend(info.external_jumps.iter().cloned());
            for local in &info.jumps_to {
                if !visited.contains(local) {
                    queue.push_back(local.clone());
                }
            }
        }
    }
    external_exits
}

pub fn detect_minigame_from_ast(root_nodes: &[PickleValue]) -> MinigameDetectResult {
    let mut warnings = Vec::new();
    let (local_labels, mut label_infos, screen_jumps) = scan_ast_file(root_nodes);
    classify_and_merge(&local_labels, &mut label_infos, &screen_jumps);

    for info in label_infos.values() {
        if info.has_dialogue {
            return MinigameDetectResult {
                stubs: vec![],
                warnings,
            };
        }
    }

    let candidates = find_entry_candidates(&local_labels, &label_infos);
    if candidates.is_empty() {
        return MinigameDetectResult {
            stubs: vec![],
            warnings,
        };
    }

    let mut stubs = Vec::new();
    for entry_label in candidates {
        let exits = collect_external_exits(&entry_label, &label_infos);
        if exits.is_empty() {
            continue;
        }
        if exits.len() > 1 {
            warnings.push(format!(
                "minigame-detect(ast): entry label \"{}\" has {} external exit(s): {}. Skipping stub.",
                entry_label, exits.len(), exits.iter().cloned().collect::<Vec<_>>().join(", ")
            ));
            continue;
        }
        stubs.push(MinigameStub {
            entry_label,
            exit_label: exits.into_iter().next().unwrap(),
        });
    }

    MinigameDetectResult { stubs, warnings }
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn convert_rpyc(
    ast_pickle: &PickleValue,
    filename: &str,
    translation_map: Option<HashMap<String, String>>,
    stubs: Option<Vec<(String, String)>>,
) -> String {
    let root_nodes = unwrap_ast_nodes(ast_pickle);
    let converter = AstConverter::new(filename.to_string(), translation_map, stubs);
    converter.convert(&root_nodes)
}
