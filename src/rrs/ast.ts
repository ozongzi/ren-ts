// ── AST types for .rrs source files ──────────────────────────────────────────

export type Program = {
  defines: DefineDecl[];
  labels: LabelDecl[];
};

// ── Top-level define declaration ──────────────────────────────────────────────

/**
 * Top-level define declaration.  May appear before (or interleaved with)
 * label blocks, but never *inside* a label body.
 *
 * All top-level bare assignments go in a single flat dictionary:
 *   image.cg.arrival2   = "CGs/cg1_arrival2.jpg";
 *   image.keitaro.grin1 = "Sprites/Faces/keitaro1_f_grin1.png";
 *   char.k              = "Keitaro";
 *   audio.bgm_main      = "Audio/BGM/main.ogg";
 *   position.p5_3       = 0.5;
 *   CAMP_NAME           = "Camp Buddy";
 *
 * Image keys use the `image.` prefix followed by the Ren'Py image name with
 * spaces replaced by dots:
 *   `image cg arrival2`       → key "image.cg.arrival2"
 *   `image keitaro_casual`    → key "image.keitaro_casual"
 *   `image keitaro grin1`     → key "image.keitaro.grin1"
 *   `image hina sick normal1` → key "image.hina.sick.normal1"
 */
export type DefineDecl = {
  kind: "Define";
  /** Full key exactly as written, e.g. "image.cg.arrival2", "char.k", "audio.bgm_main" */
  key: string;
  /** Raw value string (the quoted string content, numeric literal, or bare identifier) */
  value: string;
};

export type LabelDecl = {
  name: string;
  body: Stmt[];
};

// ── Statements ────────────────────────────────────────────────────────────────

export type Stmt =
  | AssignStmt
  | SceneStmt
  | MusicStmt
  | SoundStmt
  | ShowStmt
  | HideStmt
  | WithStmt
  | SpeakStmt
  | WaitStmt
  | IfStmt
  | MenuStmt
  | JumpStmt
  | CallStmt
  | ReturnStmt
  | LabelStmt;

/**
 * A nested label declaration found inside a label body.
 * These are hoisted to top-level labels by the codegen's hoistNestedLabels()
 * pre-pass, so the engine sees them as ordinary top-level labels.
 */
export type LabelStmt = {
  kind: "Label";
  name: string;
  body: Stmt[];
};

/** Variable assignment: name op value ;
 *  e.g.  day_num = "Day 1";
 *        hiro_affection += 1;
 */
export type AssignStmt = {
  kind: "Assign";
  name: string;
  /** "=" | "+=" | "-=" | "*=" | "/=" */
  op: string;
  /** Raw expression string (everything between op and ;) */
  value: string;
};

/**
 * scene key | transition ;
 * scene key filter | transition ;
 * scene #000000 ;
 *
 * `src` is either:
 *   - A dot-joined Ren'Py image key: "bg_entrance_day", "cg.black"
 *     (looked up as "image.<src>" in the defines dict)
 *   - A hex colour literal: "#000000"
 */
export type SceneStmt = {
  kind: "Scene";
  /**
   * Dot-joined image key or hex colour.
   * e.g. "bg_entrance_day", "cg.black", "#000000"
   */
  src: string;
  /**
   * True when `src` was a quoted string literal in the source file
   * (e.g. `scene "BGs/foo.jpg"` or `scene #000000`).
   * False / absent when `src` is an identifier variable reference
   * (e.g. `scene bg_entrance_day`) that must be resolved via the imageMap.
   */
  srcIsLiteral?: boolean;
  transition?: string;
  /**
   * Optional visual filter applied to the background.
   * Currently only "sepia" is recognised.
   */
  filter?: string;
};

/** music::play("Audio/BGM/foo.ogg") ;
 *  music::stop() | fadeout(3.0) ;
 */
export type MusicStmt = {
  kind: "Music";
  action: "play" | "stop";
  src?: string;
  fadeout?: number;
  fadein?: number;
};

/** sound::play("Audio/SFX/foo.ogg") ; */
export type SoundStmt = {
  kind: "Sound";
  action: "play" | "stop";
  src?: string;
};

/**
 * show key @ pos | transition ;
 *
 * Mirrors Ren'Py's tag-based image management.  The key is the Ren'Py image
 * name with spaces replaced by dots:
 *   show cg arrival2 with dissolve  →  show cg.arrival2 | dissolve;
 *   show keitaro_casual at center   →  show keitaro_casual @ center;
 *   show keitaro normal1 at center  →  show keitaro.normal1 @ center;
 *   show hina sick normal1 at right →  show hina.sick.normal1 @ right;
 *
 * The engine resolves the image src by looking up "image.<key>" in the flat
 * defines dictionary.  The TAG is the portion before the first dot (or the
 * whole key if there are no dots).  When showing a new sprite, the engine
 * replaces any existing sprite with the same tag, mirroring Ren'Py behaviour.
 */
export type ShowStmt = {
  kind: "Show";
  /**
   * Dot-joined Ren'Py image key.
   * e.g. "cg.arrival2", "keitaro.normal1", "keitaro_casual", "hina.sick.normal1"
   */
  key: string;
  /** Stage position, e.g. "right2", "center" */
  at?: string;
  transition?: string;
};

/**
 * hide tag ;
 *
 * Removes all sprites whose TAG equals the given tag.
 * The tag is the first dot-segment of the sprite key (or the whole key when
 * there are no dots):
 *   hide keitaro;        → removes "keitaro.normal1", "keitaro.grin1", etc.
 *   hide keitaro_casual; → removes exactly the "keitaro_casual" sprite
 *   hide cg;             → removes "cg.arrival2", etc.
 *
 * In Ren'Py, `hide` operates by tag and ignores attributes, so the converter
 * always emits just the first word:
 *   hide keitaro grin1  →  hide keitaro;
 */
export type HideStmt = {
  kind: "Hide";
  /** The tag to match for removal */
  tag: string;
};

/** with dissolve ; */
export type WithStmt = {
  kind: "With";
  transition: string;
};

/**
 * Multi-line block form:
 *   speak Hiro {
 *       "text1" | "voice1.ogg";
 *       "text2" | "voice2.ogg";
 *   }
 *
 * Inline with voice:
 *   speak Hiro "text" | "voice.ogg";
 *
 * Inline without voice:
 *   speak ??? "text";
 */
export type SpeakStmt = {
  kind: "Speak";
  /** Speaker name or abbreviation, e.g. "Hiro", "k", "???" */
  who: string;
  lines: SpeakLine[];
};

export type SpeakLine = {
  text: string;
  /** Raw voice file string as written by the author (may be filename or full path) */
  voice?: string;
};

/** wait(1.5) ; */
export type WaitStmt = {
  kind: "Wait";
  duration: number;
};

/** if condition { … } else if condition { … } else { … } */
export type IfStmt = {
  kind: "If";
  branches: IfBranch[];
};

export type IfBranch = {
  /** Raw condition string, or null for the else branch */
  condition: string | null;
  body: Stmt[];
};

/**
 * menu {
 *   "Choice A" => { … }
 *   "Choice B" => { … }
 * }
 */
export type MenuStmt = {
  kind: "Menu";
  choices: MenuChoice[];
};

export type MenuChoice = {
  text: string;
  /** Optional raw condition string (guards the choice) */
  condition?: string;
  body: Stmt[];
};

/** jump label_name ; */
export type JumpStmt = {
  kind: "Jump";
  target: string;
};

/** call label_name ; */
export type CallStmt = {
  kind: "Call";
  target: string;
};

/** return ; */
export type ReturnStmt = {
  kind: "Return";
};

// ── JSON output types (must match engine Step expectations) ───────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonStep = Record<string, any>;

export type JsonLabel = JsonStep[];

export type JsonFile = {
  source: string;
  /** Flat key→value map of all top-level defines (image.*, char.*, audio.*, position.*, etc.) */
  defines: Record<string, string>;
  labels: Record<string, JsonLabel>;
};
