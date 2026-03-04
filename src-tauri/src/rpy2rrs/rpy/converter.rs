use std::collections::HashMap;
use regex::Regex;
use lazy_static::lazy_static;

lazy_static! {
    static ref RE_0: Regex = Regex::new(r#"^Movie\s*\(\s*(?:play\s*=\s*)?"([^"]+\.webm)""#).unwrap();
    static ref RE_1: Regex = Regex::new(r#"^im\.\w+\s*\(\s*"([^"]+)""#).unwrap();
    static ref RE_2: Regex = Regex::new(r#"^"([^"]+)""#).unwrap();
    static ref RE_3: Regex = Regex::new(r#"^[\w_]+\s*""#).unwrap();
    static ref RE_4: Regex = Regex::new(r#"\s=\s*""#).unwrap();
    static ref RE_5: Regex = Regex::new(r#"^define\s+(audio\.\w+)\s*=\s*"([^"]+)""#).unwrap();
    static ref RE_6: Regex = Regex::new(r#"^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*(?:if\s+(.*?))?\s*:$"#).unwrap();
    static ref RE_7: Regex = Regex::new(r#"^([\w]+(?:_[\w]+)*)\s*"((?:[^"\\]|\\.)*)"\s*(?:with\s+\S+)?\s*$"#).unwrap();
    static ref RE_8: Regex = Regex::new(r#"^\$\s*persistent\.routes_completed\.append\s*\(\s*["'](\w+)["']\s*\)"#).unwrap();
    static ref RE_9: Regex = Regex::new(r#"^("(?:[^"\\]|\\.)*")(?:\s+with\s+(\S+.*))?$"#).unwrap();
    static ref RE_IGNORED_TRANS: Regex = Regex::new(
        r"(?i)^(movetransition|blinds|pixellate|vpunch|hpunch|wipe|ease|bounce|zoomin|zoomout|irisfade|squares)"
    ).unwrap();
    static ref RE_SKIP: Regex = Regex::new(
        r"^(\$\s*)?renpy\.free_memory|^show screen |^hide screen |^(\$\s*)?shuffle_menu|^window (hide|show)$|^define |^init:$|^init |^python:|^(zoom|xalign|yalign|xpos|ypos|alpha|ease|linear)\s"
    ).unwrap();
    static ref RE_11: Regex = Regex::new(r"[^A-Za-z0-9_]").unwrap();
    static ref RE_12: Regex = Regex::new(r"^[Dd]issolve\s*\(").unwrap();
    static ref RE_13: Regex = Regex::new(r"^Fade\s*\(").unwrap();
    static ref RE_14: Regex = Regex::new(r"\(.*\)").unwrap();
    static ref RE_15: Regex = Regex::new(r"\{[^{}]*\}").unwrap();
    static ref RE_16: Regex = Regex::new(r"\band\b").unwrap();
    static ref RE_17: Regex = Regex::new(r"\bor\b").unwrap();
    static ref RE_18: Regex = Regex::new(r"\bnot\s+").unwrap();
    static ref RE_19: Regex = Regex::new(r"\s=\s*Movie\s*\(").unwrap();
    static ref RE_20: Regex = Regex::new(r"\s=\s*im\.").unwrap();
    static ref RE_21: Regex = Regex::new(r"\s=\s*Composite\(").unwrap();
    static ref RE_22: Regex = Regex::new(r"^(?:define\s+|(?:\$\s*))(\w+)\s*=\s*Position\s*\(\s*xpos\s*=\s*([\d.]+)").unwrap();
    static ref RE_23: Regex = Regex::new(r"^default\s+([\w.]+)\s*=\s*(.+)$").unwrap();
    static ref RE_24: Regex = Regex::new(r"^\$\s*working\s*=").unwrap();
    static ref RE_25: Regex = Regex::new(r"^\$\s*time_transition_\w+\s*\(").unwrap();
    static ref RE_26: Regex = Regex::new(r"^\$\s*renpy\.save_persistent\s*\(").unwrap();
    static ref RE_27: Regex = Regex::new(r"^\$\s*renpy\.movie_cutscene\s*\(").unwrap();
    static ref RE_28: Regex = Regex::new(r"^label\s+(\w+)\s*:").unwrap();
    static ref RE_29: Regex = Regex::new(r"^if\s+(.*?)\s*:$").unwrap();
    static ref RE_30: Regex = Regex::new(r"^elif\s+(.*?)\s*:$").unwrap();
    static ref RE_31: Regex = Regex::new(r"^(?:play\s+)?voice\s+audio\.\s*(\w+)").unwrap();
    static ref RE_32: Regex = Regex::new(r"^\$\s*\w[\w.]*\s*[+\-*/%]").unwrap();
    static ref RE_33: Regex = Regex::new(r"^\$\s*renpy\.jump\s*\(\s*(\w+)\s*\)").unwrap();
    static ref RE_34: Regex = Regex::new(r"^\$\s*renpy\.call\s*\(\s*(\w+)\s*\)").unwrap();
    static ref RE_35: Regex = Regex::new(r"^\$\s*renpy\.pause\s*\(\s*([\d.]+)").unwrap();
    static ref RE_36: Regex = Regex::new(r"^\$\s*renpy\.pause\s*\(").unwrap();
    static ref RE_37: Regex = Regex::new(r"^\$\s*renpy\.music\.stop\s*\(.*?fadeout\s*=\s*([\d.]+)").unwrap();
    static ref RE_38: Regex = Regex::new(r"^\$\s*renpy\.music\.stop\s*\(").unwrap();
    static ref RE_39: Regex = Regex::new(r"^play\s+music\s+(\S+)(?:\s+fadein\s+([\d.]+))?(?:\s+loop)?(?:\s+fadein\s+([\d.]+))?").unwrap();
    static ref RE_40: Regex = Regex::new(r"^play\s+sound\s+(\S+)").unwrap();
    static ref RE_41: Regex = Regex::new(r"^play\s+audio\s+(\S+)").unwrap();
    static ref RE_42: Regex = Regex::new(r"^play\s+bgsound2?\s+(\S+)").unwrap();
    static ref RE_43: Regex = Regex::new(r"^stop\s+(music|bgsound2?|sound|audio)(?:\s+fadeout\s+([\d.]+))?").unwrap();
    static ref RE_44: Regex = Regex::new(r"\s+with\s+\S+.*$").unwrap();
    static ref RE_45: Regex = Regex::new(r"^with\s+(\S+.*)$").unwrap();
    static ref RE_46: Regex = Regex::new(r"^jump\s+(\w+)\s*$").unwrap();
    static ref RE_47: Regex = Regex::new(r"^call\s+(\w+)\s*$").unwrap();
    static ref RE_48: Regex = Regex::new(r"^\$\s*([\w.]+)\s*([+\-*/]?=)\s*([\s\S]+?)\s*$").unwrap();
    static ref RE_49: Regex = Regex::new(r"^gui\.init\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)").unwrap();
}


// ── Helpers ───────────────────────────────────────────────────────────────────

fn fmt_speaker(name: &str) -> String {
    let special = &*RE_11;
    if special.is_match(name) { format!("\"{}\"", name) } else { name.to_string() }
}

fn norm_transition(raw: &str) -> String {
    let t = raw.trim();
    let dissolve_call = &*RE_12;
    let fade_call = &*RE_13;
    let ignored = &*RE_IGNORED_TRANS;
    let strip_parens = &*RE_14;

    if dissolve_call.is_match(t) || t == "dissolve" { return "dissolve".to_string(); }
    if t == "fade" || t == "Fade" || fade_call.is_match(t) { return "fade".to_string(); }
    if t.to_lowercase().starts_with("flash") { return "flash".to_string(); }
    if t == "None" { return "".to_string(); }
    if ignored.is_match(t) { return "".to_string(); }
    strip_parens.replace(t, "").trim().to_lowercase()
}

fn esc_str(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn strip_rpy_tags(s: &str) -> String {
    let re = &*RE_15;
    re.replace_all(s, "").trim().to_string()
}

fn norm_condition(cond: &str) -> String {
    let and_re = &*RE_16;
    let or_re = &*RE_17;
    let not_re = &*RE_18;
    let s = and_re.replace_all(cond.trim(), "&&");
    let s = or_re.replace_all(&s, "||");
    not_re.replace_all(&s, "! ").to_string()
}

fn extract_py_str(raw: &str) -> String {
    let s = raw.trim();
    if s.len() >= 2 {
        let first = s.chars().next().unwrap();
        let last  = s.chars().last().unwrap();
        if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
            return s[1..s.len()-1].to_string();
        }
    }
    s.to_string()
}

fn get_indent(line: &str) -> usize {
    line.chars().take_while(|&c| c == ' ').count()
}

fn fmt_float(n: f64) -> String {
    if n == n.floor() { format!("{}", n as i64) } else { format!("{}", n) }
}

// ── Block / Speak types ───────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum BlockType { Label, If, Elif, Else, Menu, Choice }

#[derive(Debug, Clone)]
struct BlockInfo {
    rpy_col: usize,
    block_type: BlockType,
}

#[derive(Debug, Clone)]
struct SpeakLine {
    text: String,
    voice: Option<String>,
}

#[derive(Debug, Clone)]
struct SpeakBuffer {
    who: String,
    lines: Vec<SpeakLine>,
}

// ── Converter ─────────────────────────────────────────────────────────────────

pub struct Converter {
    lines: Vec<String>,
    pos: usize,
    out: Vec<String>,
    block_stack: Vec<BlockInfo>,
    pending_voice: Option<String>,
    speak_buf: Option<SpeakBuffer>,
    menu_preamble: bool,
    menu_open: bool,
    menu_preamble_col: i64,
    stub_map: HashMap<String, String>,
    filename: String,
    translation_map: Option<HashMap<String, String>>,
}

impl Converter {
    pub fn new(
        lines: Vec<String>,
        filename: String,
        translation_map: Option<HashMap<String, String>>,
        stubs: Option<Vec<(String, String)>>,
    ) -> Self {
        let stub_map = stubs.unwrap_or_default().into_iter().collect();
        Self {
            lines, pos: 0, out: Vec::new(),
            block_stack: Vec::new(),
            pending_voice: None, speak_buf: None,
            menu_preamble: false, menu_open: false, menu_preamble_col: -1,
            stub_map, filename, translation_map,
        }
    }

    fn translate(&self, text: &str) -> String {
        self.translation_map.as_ref()
            .and_then(|m| m.get(text))
            .cloned()
            .unwrap_or_else(|| text.to_string())
    }

    fn depth(&self) -> usize { self.block_stack.len() }

    fn pad(&self) -> String { "  ".repeat(self.depth()) }

    fn pad_extra(&self, extra: usize) -> String { "  ".repeat(self.depth() + extra) }

    fn emit(&mut self, line: String) { self.out.push(line); }

    // ── Block management ──────────────────────────────────────────────────────

    fn close_blocks_at(&mut self, at_col: usize) {
        if self.menu_preamble && self.menu_preamble_col >= 0
            && self.menu_preamble_col as usize >= at_col
        {
            self.menu_preamble = false;
            self.menu_preamble_col = -1;
        }
        loop {
            let top = match self.block_stack.last() { Some(t) => t.clone(), None => break };
            if top.rpy_col >= at_col {
                self.block_stack.pop();
                if !(top.block_type == BlockType::Menu && !self.menu_open) {
                    let pad = self.pad();
                    self.emit(format!("{}}}", pad));
                }
                if top.block_type == BlockType::Menu {
                    self.menu_open = false;
                    self.menu_preamble = false;
                    self.menu_preamble_col = -1;
                }
            } else { break; }
        }
    }

    fn close_sibling_at(&mut self, at_col: usize) {
        if self.menu_preamble && self.menu_preamble_col >= 0
            && self.menu_preamble_col as usize >= at_col
        {
            self.menu_preamble = false;
            self.menu_preamble_col = -1;
        }
        loop {
            let top = match self.block_stack.last() { Some(t) => t.clone(), None => break };
            if top.rpy_col > at_col {
                self.block_stack.pop();
                let pad = self.pad();
                self.emit(format!("{}}}", pad));
                if top.block_type == BlockType::Menu {
                    self.menu_open = false;
                    self.menu_preamble = false;
                    self.menu_preamble_col = -1;
                }
            } else { break; }
        }
        if let Some(top) = self.block_stack.last().cloned() {
            if top.rpy_col == at_col {
                self.block_stack.pop();
                if !(top.block_type == BlockType::Menu && !self.menu_open) {
                    let pad = self.pad();
                    self.emit(format!("{}}}", pad));
                }
                if top.block_type == BlockType::Menu {
                    self.menu_open = false;
                    self.menu_preamble = false;
                    self.menu_preamble_col = -1;
                }
            }
        }
    }

    // ── Speak buffering ───────────────────────────────────────────────────────

    fn flush_speak(&mut self) {
        let buf = match self.speak_buf.take() { Some(b) => b, None => return };
        let sp = fmt_speaker(&buf.who);
        let pad = self.pad();
        if buf.lines.len() == 1 {
            let l = &buf.lines[0];
            if let Some(ref v) = l.voice {
                self.emit(format!("{}speak {} \"{}\" | {};", pad, sp, esc_str(&l.text), v));
            } else {
                self.emit(format!("{}speak {} \"{}\";", pad, sp, esc_str(&l.text)));
            }
        } else {
            self.emit(format!("{}speak {} {{", pad, sp));
            let lines = buf.lines.clone();
            for l in lines {
                let inner = self.pad_extra(1);
                if let Some(ref v) = l.voice {
                    self.emit(format!("{}\"{}\" | {};", inner, esc_str(&l.text), v));
                } else {
                    self.emit(format!("{}\"{}\" ;", inner, esc_str(&l.text)));
                }
            }
            let pad = self.pad();
            self.emit(format!("{}}}", pad));
        }
    }

    fn add_speak_line(&mut self, who: &str, text: &str, voice: Option<String>) {
        let flush = self.speak_buf.as_ref().map_or(false, |b| b.who != who);
        if flush { self.flush_speak(); }
        if self.speak_buf.is_none() {
            self.speak_buf = Some(SpeakBuffer { who: who.to_string(), lines: Vec::new() });
        }
        self.speak_buf.as_mut().unwrap().lines.push(SpeakLine { text: text.to_string(), voice });
    }

    // ── Image key helpers ─────────────────────────────────────────────────────

    fn image_key(words: &[&str]) -> String { words.join(".") }

    fn parse_show_tail(tail: &str, for_scene: bool) -> (Vec<String>, String, String, String) {
        let parts: Vec<&str> = tail.trim().split_whitespace().collect();
        let mut words = Vec::new();
        let mut at = String::new();
        let mut trans = String::new();
        let mut filter = String::new();
        let filters = ["sepia"];
        let mut i = 0;
        while i < parts.len() {
            let p = parts[i];
            if p == "with" && i + 1 < parts.len() {
                trans = norm_transition(parts[i + 1]);
                i += 2;
                continue;
            }
            if p == "at" && i + 1 < parts.len() {
                at = parts[i + 1].to_string();
                i += 2;
                continue;
            }
            if for_scene && filters.contains(&p) {
                filter = p.to_string();
                i += 1;
                continue;
            }
            words.push(p.trim_end_matches(':').to_string());
            i += 1;
        }
        (words, at, trans, filter)
    }

    fn would_close_blocks(&self, indent: usize) -> bool {
        self.block_stack.last().map_or(false, |t| t.rpy_col >= indent)
    }

    // ── Image declaration ─────────────────────────────────────────────────────

    fn process_image_decl(&mut self, line: &str) {
        let eq_idx = match line.find('=') { Some(i) => i, None => return };
        let words_part = line["image".len()..eq_idx].trim();
        let value_part = line[eq_idx + 1..].trim();
        if value_part.starts_with("Composite(") { return; }

        let raw_words: Vec<&str> = words_part.split_whitespace().collect();
        if raw_words.is_empty() { return; }

        let known_filters = ["sepia"];
        let mut words = raw_words.clone();
        if words.len() > 1 && known_filters.contains(&words.last().unwrap().to_lowercase().as_str()) {
            words.pop();
        }
        let key = format!("image.{}", words.join("."));

        let movie_re = &*RE_0;
        let im_re = &*RE_1;
        let str_re = &*RE_2;

        if let Some(cap) = movie_re.captures(value_part) {
            self.emit(format!("{} = \"{}\";", key, esc_str(&cap[1])));
        } else if let Some(cap) = im_re.captures(value_part) {
            self.emit(format!("{} = \"{}\";", key, esc_str(&cap[1])));
        } else if let Some(cap) = str_re.captures(value_part) {
            self.emit(format!("{} = \"{}\";", key, esc_str(&cap[1])));
        }
    }

    // ── Line preprocessor ─────────────────────────────────────────────────────

    fn preprocess_lines(lines: Vec<String>) -> Vec<String> {
        let mut result = Vec::new();
        let mut i = 0;
        let speak_start = &*RE_3;
        while i < lines.len() {
            let raw = lines[i].trim_end_matches('\r').to_string();
            i += 1;

            let has_unclosed = {
                let t = raw.trim();
                if !speak_start.is_match(t) { false }
                else {
                    let mut in_str = false;
                    let mut chars = t.chars().peekable();
                    while let Some(c) = chars.next() {
                        if c == '\\' { chars.next(); continue; }
                        if c == '"' { in_str = !in_str; }
                    }
                    in_str
                }
            };

            if has_unclosed {
                let mut joined = raw.trim_end().to_string();
                loop {
                    if i >= lines.len() { break; }
                    let cont = lines[i].trim_end_matches('\r').to_string();
                    i += 1;
                    joined.push(' ');
                    joined.push_str(cont.trim());
                    let mut in_str = false;
                    let mut chars = joined.chars().peekable();
                    while let Some(c) = chars.next() {
                        if c == '\\' { chars.next(); continue; }
                        if c == '"' { in_str = !in_str; }
                    }
                    if !in_str { break; }
                }
                result.push(joined);
            } else {
                result.push(raw);
            }
        }
        result
    }

    // ── Main line processor ───────────────────────────────────────────────────

    fn process_line(&mut self, raw_line: &str) {
        let indent = get_indent(raw_line);
        let mut line = raw_line.trim().to_string();

        if line.is_empty() || line.starts_with('#') { return; }

        // Strip inline comments
        {
            let mut in_str = false;
            let mut str_char = ' ';
            let chars: Vec<char> = line.chars().collect();
            let mut ci = 0;
            let mut cut = None;
            while ci < chars.len() {
                let ch = chars[ci];
                if in_str {
                    if ch == '\\' { ci += 1; }
                    else if ch == str_char { in_str = false; }
                } else {
                    if ch == '"' || ch == '\'' { in_str = true; str_char = ch; }
                    else if ch == '#' { cut = Some(ci); break; }
                }
                ci += 1;
            }
            if let Some(c) = cut { line = line[..c].trim().to_string(); }
            if line.is_empty() || line == "\"" || line == "'" { return; }
        }

        // Image declarations
        let is_image_decl = line.starts_with("image ")
            && (line.contains(" = Movie(")
            || RE_19.is_match(&line)
            || RE_4.is_match(&line)
            || RE_20.is_match(&line)
            || RE_21.is_match(&line));
        if is_image_decl { self.process_image_decl(&line); return; }

        // define audio.VAR = "path"
        let audio_re = &*RE_5;
        if let Some(cap) = audio_re.captures(&line) {
            self.emit(format!("{} = \"{}\";", &cap[1], esc_str(&cap[2])));
            return;
        }

        // define/$ VAR = Position(xpos=...)
        let pos_re = &*RE_22;
        if let Some(cap) = pos_re.captures(&line) {
            self.emit(format!("position.{} = {};", &cap[1], &cap[2]));
            return;
        }

        // default VAR = VALUE
        let default_re = &*RE_23;
        if let Some(cap) = default_re.captures(&line) {
            let var = &cap[1];
            let val = cap[2].trim()
                .replace("True", "true").replace("False", "false");
            let pad = self.pad();
            self.emit(format!("{}{} = {};", pad, var, val));
            return;
        }

        if RE_SKIP.is_match(&line)
            || RE_24.is_match(&line)
            || RE_25.is_match(&line)
            || RE_26.is_match(&line)
            || RE_27.is_match(&line)
        { return; }

        // label X:
        let label_re = &*RE_28;
        if let Some(cap) = label_re.captures(&line) {
            self.flush_speak();
            self.close_blocks_at(indent);
            let label_name = cap[1].to_string();

            if let Some(exit) = self.stub_map.get(&label_name).cloned() {
                let pad = self.pad();
                self.emit(format!("{}label {} {{", pad, label_name));
                self.emit(format!("{}  jump {};", pad, exit));
                self.emit(format!("{}}}", pad));
                // skip body
                while self.pos < self.lines.len() {
                    let peek = self.lines[self.pos].clone();
                    if peek.trim().is_empty() { self.pos += 1; continue; }
                    if get_indent(&peek) <= indent { break; }
                    self.pos += 1;
                }
                return;
            }

            let pad = self.pad();
            self.emit(format!("{}label {} {{", pad, label_name));
            self.block_stack.push(BlockInfo { rpy_col: indent, block_type: BlockType::Label });
            return;
        }

        // if COND:
        let if_re = &*RE_29;
        if let Some(cap) = if_re.captures(&line) {
            self.flush_speak();
            self.close_blocks_at(indent);
            let pad = self.pad();
            self.emit(format!("{}if {} {{", pad, norm_condition(&cap[1])));
            self.block_stack.push(BlockInfo { rpy_col: indent, block_type: BlockType::If });
            return;
        }

        // elif COND:
        let elif_re = &*RE_30;
        if let Some(cap) = elif_re.captures(&line) {
            self.flush_speak();
            self.close_sibling_at(indent);
            let pad = self.pad();
            let expected_close = format!("{}}}", pad);
            let cond = norm_condition(&cap[1]);
            if self.out.last().map_or(false, |l| l == &expected_close) {
                let last = self.out.last_mut().unwrap();
                *last = format!("{}}} elif {} {{", pad, cond);
            } else {
                self.emit(format!("{}}} elif {} {{", pad, cond));
            }
            self.block_stack.push(BlockInfo { rpy_col: indent, block_type: BlockType::Elif });
            return;
        }

        // else:
        if line == "else:" {
            self.flush_speak();
            self.close_sibling_at(indent);
            let pad = self.pad();
            let expected_close = format!("{}}}", pad);
            if self.out.last().map_or(false, |l| l == &expected_close) {
                let last = self.out.last_mut().unwrap();
                *last = format!("{}}} else {{", pad);
            } else {
                self.emit(format!("{}}} else {{", pad));
            }
            self.block_stack.push(BlockInfo { rpy_col: indent, block_type: BlockType::Else });
            return;
        }

        // menu:
        if line == "menu:" || line == "menu :" {
            self.flush_speak();
            self.close_blocks_at(indent);
            self.menu_preamble = true;
            self.menu_open = false;
            self.menu_preamble_col = indent as i64;
            return;
        }

        // "CHOICE" [if COND]:
        let choice_re = &*RE_6;
        let in_menu = self.menu_preamble || self.block_stack.iter().any(|b| b.block_type == BlockType::Menu);
        if let Some(cap) = choice_re.captures(&line) {
            if in_menu {
                self.flush_speak();
                if !self.menu_open {
                    self.menu_open = true;
                    self.menu_preamble = false;
                    let col = if self.menu_preamble_col >= 0 {
                        self.menu_preamble_col as usize
                    } else if let Some(top) = self.block_stack.last() {
                        top.rpy_col + 4
                    } else {
                        indent.saturating_sub(4)
                    };
                    self.block_stack.push(BlockInfo { rpy_col: col, block_type: BlockType::Menu });
                    let menu_depth = self.block_stack.len() - 1;
                    self.emit(format!("{}menu {{", "  ".repeat(menu_depth)));
                    self.menu_preamble_col = -1;
                } else {
                    self.close_sibling_at(indent);
                }

                let raw_text = &cap[1];
                let raw_cond = cap.get(2).map(|m: regex::Match| m.as_str());
                let normalized_text = if raw_text.starts_with('\'') {
                    format!("\"{}\"", &raw_text[1..raw_text.len()-1].replace('"', "\\\""))
                } else {
                    raw_text.to_string()
                };
                let choice_text = self.translate(&extract_py_str(&normalized_text));
                let cond_part = raw_cond.map_or(String::new(), |c| format!(" if {}", norm_condition(c)));
                let pad = self.pad();
                self.emit(format!("{}\"{}\"{}  => {{", pad, esc_str(&choice_text), cond_part));
                self.block_stack.push(BlockInfo { rpy_col: indent, block_type: BlockType::Choice });
                return;
            }
        }

        // voice audio.VAR
        let voice_re = &*RE_31;
        if let Some(cap) = voice_re.captures(&line) {
            if self.menu_preamble { return; }
            if self.would_close_blocks(indent) {
                self.flush_speak();
                self.close_blocks_at(indent);
            }
            self.pending_voice = Some(format!("audio.{}", &cap[1]));
            return;
        }

        // CHAR "text"
        let dialog_re = &*RE_7;
        if let Some(cap) = dialog_re.captures(&line) {
            let char_key = cap[1].trim_end().to_string();
            if self.menu_preamble { return; }
            if self.would_close_blocks(indent) {
                self.flush_speak();
                self.close_blocks_at(indent);
            }
            let stripped = strip_rpy_tags(&cap[2]);
            let text = self.translate(&stripped);
            let voice = self.pending_voice.take();
            self.add_speak_line(&char_key, &text, voice);
            return;
        }

        // flush speak + close deeper blocks
        self.flush_speak();
        self.close_blocks_at(indent);

        // bare expression statements
        let bare_expr = &*RE_32;
        if bare_expr.is_match(&line) && !line.contains('=') { return; }

        // $ renpy.jump(VAR)
        let rpy_jump = &*RE_33;
        if let Some(cap) = rpy_jump.captures(&line) {
            let pad = self.pad(); self.emit(format!("{}jump {};", pad, &cap[1])); return;
        }

        // $ renpy.call(VAR)
        let rpy_call = &*RE_34;
        if let Some(cap) = rpy_call.captures(&line) {
            let pad = self.pad(); self.emit(format!("{}call {};", pad, &cap[1])); return;
        }

        // $ renpy.pause(X)
        let pause_re = &*RE_35;
        if let Some(cap) = pause_re.captures(&line) {
            let n: f64 = cap[1].parse().unwrap_or(0.0);
            let pad = self.pad(); self.emit(format!("{}wait({});", pad, fmt_float(n))); return;
        }
        if RE_36.is_match(&line) { return; }

        // $ renpy.music.stop(...fadeout=X)
        let music_stop_fade = &*RE_37;
        if let Some(cap) = music_stop_fade.captures(&line) {
            let s = fmt_float(cap[1].parse().unwrap_or(0.0));
            let pad = self.pad(); self.emit(format!("{}music::stop() | fadeout({});", pad, s)); return;
        }
        if RE_38.is_match(&line) {
            let pad = self.pad(); self.emit(format!("{}music::stop();", pad)); return;
        }

        // $persistent.routes_completed.append("ROUTE")
        let route_re = &*RE_8;
        if let Some(cap) = route_re.captures(&line) {
            let pad = self.pad(); self.emit(format!("{}// route_complete: {};", pad, &cap[1])); return;
        }

        // play music NAME [fadein X]
        let play_music = &*RE_39;
        if let Some(cap) = play_music.captures(&line) {
            let var_name = &cap[1];
            let fadein = cap.get(2).or_else(|| cap.get(3)).map(|m: regex::Match| m.as_str());
            let pad = self.pad();
            if let Some(fi) = fadein {
                let fi_f = fi.parse::<f64>().unwrap_or(0.0);
                self.emit(format!("{}music::play({}) | fadein({});", pad, var_name, fmt_float(fi_f)));
            } else {
                self.emit(format!("{}music::play({});", pad, var_name));
            }
            return;
        }

        // play sound/audio/bgsound NAME
        let play_sound = &*RE_40;
        if let Some(cap) = play_sound.captures(&line) {
            let pad = self.pad(); self.emit(format!("{}sound::play({});", pad, &cap[1])); return;
        }
        let play_audio = &*RE_41;
        if let Some(cap) = play_audio.captures(&line) {
            let pad = self.pad(); self.emit(format!("{}sound::play({});", pad, &cap[1])); return;
        }
        let play_bg = &*RE_42;
        if let Some(cap) = play_bg.captures(&line) {
            let pad = self.pad(); self.emit(format!("{}music::play({});", pad, &cap[1])); return;
        }

        // stop music/bgsound/sound/audio [fadeout X]
        let stop_re = &*RE_43;
        if let Some(cap) = stop_re.captures(&line) {
            let is_sound = cap[1] == *"sound" || cap[1] == *"audio";
            let fadeout = cap.get(2).map(|m: regex::Match| m.as_str());
            let pad = self.pad();
            if is_sound {
                self.emit(format!("{}sound::stop();", pad));
            } else if let Some(fo) = fadeout {
                let fo_f = fo.parse::<f64>().unwrap_or(0.0);
                self.emit(format!("{}music::stop() | fadeout({});", pad, fmt_float(fo_f)));
            } else {
                self.emit(format!("{}music::stop();", pad));
            }
            return;
        }

        // scene WORDS...
        if line.starts_with("scene ") {
            let tail = line["scene".len()..].trim();
            let lit_re = &*RE_9;
            if let Some(cap) = lit_re.captures(tail) {
                let trans = cap.get(2).map_or(String::new(), |m: regex::Match| norm_transition(m.as_str()));
                let trans_part = if !trans.is_empty() { format!(" | {}", trans) } else { String::new() };
                let pad = self.pad();
                self.emit(format!("{}scene {}{};", pad, &cap[1], trans_part));
                return;
            }
            let (words, at, trans, filter) = Self::parse_show_tail(tail, true);
            if words.is_empty() {
                let pad = self.pad(); self.emit(format!("{}// UNHANDLED scene: {}", pad, line)); return;
            }
            let key = Self::image_key(&words.iter().map(|s| s.as_str()).collect::<Vec<_>>());
            let filter_part = if !filter.is_empty() { format!(" {}", filter) } else { String::new() };
            let at_part = if !at.is_empty() { format!(" @ {}", at) } else { String::new() };
            let trans_part = if !trans.is_empty() { format!(" | {}", trans) } else { String::new() };
            let pad = self.pad();
            self.emit(format!("{}scene {}{}{}{};", pad, key, filter_part, at_part, trans_part));
            return;
        }

        // show WORDS...
        if line.starts_with("show ") {
            let tail = line["show".len()..].trim();
            let (words, at, trans, _) = Self::parse_show_tail(tail, false);
            let key_words: Vec<&str> = words.iter().filter(|w| w.as_str() != "sepia").map(|s| s.as_str()).collect();
            if key_words.is_empty() {
                let pad = self.pad(); self.emit(format!("{}// UNHANDLED show: {}", pad, line)); return;
            }
            let key = Self::image_key(&key_words);
            let at_part = if !at.is_empty() { format!(" @ {}", at) } else { String::new() };
            let trans_part = if !trans.is_empty() { format!(" | {}", trans) } else { String::new() };
            let pad = self.pad();
            self.emit(format!("{}show {}{}{};", pad, key, at_part, trans_part));
            return;
        }

        // hide WORDS...
        if line.starts_with("hide ") {
            let tail = &*RE_44
                .replace(&line["hide".len()..].trim(), "").trim().to_string();
            let tag = tail.split_whitespace().next().unwrap_or("").to_string();
            if !tag.is_empty() {
                let pad = self.pad(); self.emit(format!("{}hide {};", pad, tag));
            }
            return;
        }

        // with TRANS
        let with_re = &*RE_45;
        if let Some(cap) = with_re.captures(&line) {
            let trans = norm_transition(&cap[1]);
            if !trans.is_empty() {
                let pad = self.pad(); self.emit(format!("{}with {};", pad, trans));
            }
            return;
        }

        // jump LABEL
        let jump_re = &*RE_46;
        if let Some(cap) = jump_re.captures(&line) {
            let pad = self.pad(); self.emit(format!("{}jump {};", pad, &cap[1])); return;
        }

        // call LABEL
        let call_re = &*RE_47;
        if let Some(cap) = call_re.captures(&line) {
            let pad = self.pad(); self.emit(format!("{}call {};", pad, &cap[1])); return;
        }

        // return
        if line == "return" { return; }

        // $abbr = Character("Name", ...)  or  Character('Name', ...)
        if line.contains("= Character(") && line.starts_with('$') {
            if let Some(abbr_end) = line.find('=') {
                let abbr = line[1..abbr_end].trim().trim_start_matches('$').trim();
                // find the quoted name after Character(
                if let Some(paren) = line.find("Character(") {
                    let after = line[paren + "Character(".len()..].trim_start();
                    if let Some(q) = after.chars().next() {
                        if q == '"' || q == '\'' {
                            let inner = &after[1..];
                            if let Some(end) = inner.find(q) {
                                let full_name = &inner[..end];
                                if abbr != "narrator" && abbr != "nvl" && abbr != "k_foreplay" {
                                    let name = if full_name == "empty" { "" } else { full_name };
                                    self.emit(format!("char.{} = \"{}\";", abbr, name));
                                }
                                return;
                            }
                        }
                    }
                }
            }
        }

        // $ VAR op VALUE
        let assign_re = &*RE_48;
        if let Some(cap) = assign_re.captures(&line) {
            let var_name = &cap[1];
            let op = &cap[2];
            let val = cap[3].trim()
                .replace("True", "true").replace("False", "false");
            if var_name.starts_with("renpy.") || var_name.starts_with("persistent.")
                || var_name == "day" || var_name == "time" || var_name == "location"
            { return; }
            let pad = self.pad();
            self.emit(format!("{}{} {} {};", pad, var_name, op, val));
            return;
        }

        // gui.init(w, h)
        let gui_init = &*RE_49;
        if let Some(cap) = gui_init.captures(&line) {
            let pad = self.pad();
            self.emit(format!("{}config.screen_width = {};", pad, &cap[1]));
            self.emit(format!("{}config.screen_height = {};", pad, &cap[2]));
            return;
        }

        let pad = self.pad();
        self.emit(format!("{}// UNHANDLED: {}", pad, line));
    }

    // ── Entry point ───────────────────────────────────────────────────────────

    pub fn convert(mut self) -> String {
        self.emit(format!("// Source: data/{}", self.filename));
        self.emit(String::new());

        self.lines = Self::preprocess_lines(self.lines.clone());

        while self.pos < self.lines.len() {
            let raw_line = self.lines[self.pos].clone();
            self.pos += 1;
            self.process_line(&raw_line);
        }

        self.flush_speak();

        while !self.block_stack.is_empty() {
            let top = self.block_stack.pop().unwrap();
            if !(top.block_type == BlockType::Menu && !self.menu_open) {
                let pad = self.pad();
                self.emit(format!("{}}}", pad));
            }
            if top.block_type == BlockType::Menu {
                self.menu_open = false;
                self.menu_preamble = false;
                self.menu_preamble_col = -1;
            }
        }

        self.out.join("\n") + "\n"
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

pub fn convert_rpy(
    src: &str,
    filename: &str,
    translation_map: Option<HashMap<String, String>>,
    stubs: Option<Vec<(String, String)>>,
) -> String {
    // Strip UTF-8 BOM if present
    let src = src.strip_prefix('\u{feff}').unwrap_or(src);
    let lines: Vec<String> = src.split('\n').map(|s| s.to_string()).collect();
    let converter = Converter::new(lines, filename.to_string(), translation_map, stubs);
    converter.convert()
}