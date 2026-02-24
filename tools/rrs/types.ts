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
 * Three flavours:
 *   define char.<abbr>  = "Full Name";   → character alias
 *   define audio.<alias> = "path/to.ogg"; → audio path alias
 *   define <VAR>        = <value>;        → generic constant
 */
export type DefineDecl = {
  kind: "Define";
  /** Full dotted key exactly as written, e.g. "char.k", "audio.bgm_main", "CAMP_NAME" */
  key: string;
  /** Raw value string (unquoted for strings, numeric literal for numbers, etc.) */
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
  | ExprStmt
  | HideStmt
  | WithStmt
  | SpeakStmt
  | WaitStmt
  | IfStmt
  | MenuStmt
  | JumpStmt
  | CallStmt
  | ReturnStmt;

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

/** scene "path/bg.jpg" | dissolve ;
 *  scene #000000 ;
 */
export type SceneStmt = {
  kind: "Scene";
  /** File path string OR hex colour like "#000000" */
  src: string;
  transition?: string;
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

/** show body_sprite::face_expr @ pos | transition ;
 *  show body_sprite @ pos ;
 *  show cg_name | dissolve { src: "CGs/cg.jpg" }
 *
 *  When faceExpr is present the codegen emits two JSON show steps
 *  (one for the body sprite, one for the face sprite) with derived srcs.
 *  When faceExpr is absent and an explicit src block is provided it emits
 *  a single show step with that src (used for CGs / overlays).
 */
export type ShowStmt = {
  kind: "Show";
  /** Key for the body sprite, e.g. "hiro_casual", "hiro2_camp", "cg_arrival1" */
  bodyKey: string;
  /** Expression/face name after ::, e.g. "laugh1". Absent for CGs/body-only shows. */
  faceExpr?: string;
  /** Stage position, e.g. "right2", "p5_3" */
  at?: string;
  transition?: string;
  /** Explicit src override – required for CGs, optional for body sprites */
  src?: string;
  /**
   * Verbatim JSON sprite key override – written as  key: "cg_fade"  inside the
   * show block.  When present the codegen uses this exact string as the JSON
   * sprite key instead of deriving it from bodyKey.  Used for special overlay
   * sprites whose JSON key contains underscores (e.g. "cg_fade", "cg_blur").
   */
  spriteKeyOverride?: string;
  /**
   * Explicit face-sprite src override – written as  src_face: "..."  inside the
   * show block.  When present the codegen uses this for the face show step's src
   * instead of the derived path.  Useful for multi-word face expressions whose
   * file path uses underscores while the derived path would use spaces.
   */
  faceSrc?: string;
};

/** expr char::face_expr ;
 *  expr char::face_expr @ pos ;
 *  expr char::face_expr @ pos | transition ;
 *  Change only the face expression for a character already on screen.
 *  The codegen looks up the character's current position from sprite state,
 *  but an explicit `@ pos` overrides the tracked position (needed when the
 *  face step originates from a different label or the state is unknown).
 *  e.g.  expr hiro::grin1;
 *        expr hiro::grin1 @ right2;
 *        expr hiro::grin1 | dissolve;
 *        expr hiro::grin1 @ right2 | dissolve;
 */
export type ExprStmt = {
  kind: "Expr";
  /** Character name, may include version digit, e.g. "hiro", "keitaro21" */
  char: string;
  /** Face expression name, e.g. "grin1".  May be multi-word, e.g. "sick normal1". */
  expr: string;
  /**
   * Explicit stage position override.  When present the codegen uses this
   * value for the `at` field instead of looking it up from sprite state.
   */
  at?: string;
  /** Optional transition to apply when changing the face expression */
  transition?: string;
};

/** hide body_sprite, char::face_expr, char::* ;
 *  Multiple comma-separated targets are allowed.
 *  char::* expands to the currently-tracked face for that character.
 */
export type HideStmt = {
  kind: "Hide";
  targets: HideTarget[];
};

export type HideTarget =
  | { type: "body"; key: string }
  | { type: "face"; char: string; expr: string | "*" };

/** with dissolve ; */
export type WithStmt = {
  kind: "With";
  transition: string;
};

/** Multi-line block form:
 *    speak Hiro {
 *        "text1" | "voice1.ogg";
 *        "text2" | "voice2.ogg";
 *    }
 *
 *  Inline with voice:
 *    speak Hiro "text" | "voice.ogg";
 *
 *  Inline without voice:
 *    speak ??? "text";
 *
 *  Voice-before-block (legacy compat):
 *    speak Hiro "voice.ogg" { "text1"; "text2"; }
 */
export type SpeakStmt = {
  kind: "Speak";
  /** Speaker name or abbreviation, e.g. "Hiro", "hi", "???" */
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

/** menu {
 *    "Choice A" => { … }
 *    "Choice B" => { … }
 *  }
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

/** return ; — used in stub labels */
export type ReturnStmt = {
  kind: "Return";
};

// ── JSON output types (must match engine Step expectations) ───────────────────

// deno-lint-ignore no-explicit-any
export type JsonStep = Record<string, any>;

export type JsonLabel = JsonStep[];

export type JsonFile = {
  source: string;
  labels: Record<string, JsonLabel>;
};
