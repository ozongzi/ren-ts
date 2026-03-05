// ─── Ren'Py step types (mirrors the JSON schema) ────────────────────────────
import type { VarStore } from "./vars";

export interface SetStep {
  type: "set";
  var: string;
  op: "=" | "+=" | "-=" | "*=" | "/=";
  /** Raw value from JSON — may be a string, number, or boolean literal. */
  value: string | number | boolean;
}

export interface SceneStep {
  type: "scene";
  src: string; // CSS color like "#000000" or image path like "BGs/..."
  transition?: string;
  filter?: string; // optional CSS filter, e.g. "sepia" for flashback scenes
}

export interface ShowStep {
  type: "show";
  sprite: string; // sprite key, e.g. "keitaro body", "cg arrival1"
  src?: string; // image path (optional if sprite already known)
  at?: string; // position: left | center | right | truecenter | ...
  transition?: string;
}

export interface HideStep {
  type: "hide";
  sprite: string;
  transition?: string;
}

export interface WithStep {
  type: "with";
  transition: string;
}

export interface SayStep {
  type: "say";
  who: string | null;
  text: string;
  voice?: string;
}

export interface NarrateStep {
  type: "narrate";
  text: string;
  voice?: string;
}

export interface ExtendStep {
  type: "extend";
  text: string;
  voice?: string;
}

export interface MusicStep {
  type: "music";
  action: "play" | "stop";
  src?: string;
  fadein?: number;
  fadeout?: number;
}

export interface SoundStep {
  type: "sound";
  action: "play" | "stop";
  src?: string;
}

export interface MenuOption {
  text: string;
  steps: Step[];
  condition?: string | null;
}

export interface MenuStep {
  type: "menu";
  options: MenuOption[];
}

export interface IfBranch {
  condition: string | null;
  steps: Step[];
}

export interface IfStep {
  type: "if";
  branches: IfBranch[];
}

export interface JumpStep {
  type: "jump";
  target: string;
}

export interface CallStep {
  type: "call";
  target: string;
}

export interface ReturnStep {
  type: "return";
}

export interface PauseStep {
  type: "pause";
  duration?: number;
}

export interface InputStep {
  type: "input";
  varName: string;
  prompt: string;
}

export type Step =
  | SetStep
  | SceneStep
  | ShowStep
  | HideStep
  | WithStep
  | SayStep
  | NarrateStep
  | ExtendStep
  | MusicStep
  | SoundStep
  | MenuStep
  | IfStep
  | JumpStep
  | CallStep
  | ReturnStep
  | PauseStep
  | InputStep;

// ─── Script data (mirrors JSON file structure) ───────────────────────────────

export interface ScriptFile {
  source: string;
  labels: Record<string, Step[]>;
  /** Flat key→value map of all top-level defines in this file (image.*, char.*, audio.*, etc.) */
  defines: Record<string, unknown>;
}

// ─── Gallery types ────────────────────────────────────────────────────────────

/**
 * A single gallery entry representing one animated scene for a character.
 * The `id` is derived from {character}_{groupId} (e.g. "hiro_g1").
 * Each entry holds an ordered list of webm asset paths that form the sequence.
 */
export interface GalleryEntry {
  /** Unique scene ID derived from "{charKey}_{groupSegment}", e.g. "char_g1" */
  id: string;
  /**
   * Display name of the character, derived automatically from the image-name
   * prefix (first letter capitalised).  No hardcoded name map is used.
   */
  character: string;
  /** Ordered asset paths relative to the game's images/ directory */
  frames: string[];
}

export interface Manifest {
  /** Entry-point label name. Defaults to "start" (Ren'Py convention). */
  start?: string;
  /** Display name of the game (optional, shown on title screen). */
  game?: string;
  files: string[];
  /**
   * Gallery entries parsed from gallery_images.rpy via parse_gallery.ts.
   * Each entry is one animated scene (grouped by character + scene ID).
   */
  gallery?: GalleryEntry[];
}

// ─── Sprite display state ────────────────────────────────────────────────────

export interface SpriteState {
  key: string;
  src: string;
  at?: string; // position tag
  zIndex: number; // insertion order
}

// ─── Dialogue display state ──────────────────────────────────────────────────

export interface DialogueState {
  who: string | null; // speaker name, null = narration
  text: string;
  voice?: string;
}

// ─── Call stack frame ────────────────────────────────────────────────────────

export interface StackFrame {
  label: string;
  stepIndex: number;
}

// ─── Audio state ─────────────────────────────────────────────────────────────

export interface AudioState {
  bgmSrc: string | null;
  sfxSrc: string | null;
  voiceSrc: string | null;
}

// ─── Position constants ──────────────────────────────────────────────────────

export const SPRITE_POSITIONS: Record<string, React.CSSProperties> = {
  left: { left: "15%", bottom: "0", transform: "translateX(-50%)" },
  cleft: { left: "27%", bottom: "0", transform: "translateX(-50%)" },
  center: { left: "50%", bottom: "0", transform: "translateX(-50%)" },
  cright: { left: "73%", bottom: "0", transform: "translateX(-50%)" },
  right: { left: "85%", bottom: "0", transform: "translateX(-50%)" },
  truecenter: { left: "50%", top: "50%", transform: "translate(-50%, -50%)" },
  offscreenleft: { left: "-20%", bottom: "0", transform: "translateX(-50%)" },
  offscreenright: { left: "120%", bottom: "0", transform: "translateX(-50%)" },
  // fallbacks
  topleft: { left: "15%", top: "5%" },
  topright: { right: "15%", top: "5%" },
};

// ─── Game phases ─────────────────────────────────────────────────────────────

export type GamePhase =
  | "title"
  | "save_loaded"
  | "playing"
  | "game_end"
  | "gallery"
  | "settings"
  | "saves";

// ─── Save file format ────────────────────────────────────────────────────────

export interface SaveData {
  version: 1;
  timestamp: string;
  currentLabel: string;
  stepIndex: number;
  callStack: StackFrame[];
  vars: Record<string, unknown>;
  completedRoutes: string[];
  // snapshot of visible state — restored on load
  backgroundSrc: string | null;
  bgFilter: string | null;
  sprites: SpriteState[];
  bgmSrc: string | null;
  dialogue: DialogueState | null;
}

// ─── Full game state (stored in Zustand) ─────────────────────────────────────

export interface GameState {
  phase: GamePhase;

  // ── Execution context ──
  currentLabel: string;
  stepIndex: number;
  callStack: StackFrame[];
  /** Game vars only — serialised to disk (define vars excluded). */
  /**
   * Two-layer variable store.
   * - defineVars: image.*, char.*, audio.*, persistent.* defaults — NOT saved
   * - gameVars:   written during play — the only part persisted to save files
   */
  vars: VarStore;

  // ── Visual state ──
  backgroundSrc: string | null; // CSS color or resolved asset URL
  bgFilter: string | null; // optional CSS filter on the background (e.g. "sepia")
  sprites: SpriteState[]; // ordered list of visible sprites
  spriteCounter: number; // for z-index assignment

  // ── Audio state ──
  bgmSrc: string | null;
  sfxSrc: string | null;
  voiceSrc: string | null;

  // ── Dialogue state ──
  dialogue: DialogueState | null;
  choices: MenuOption[] | null;

  // ── Input prompt state ──
  inputState: { varName: string; prompt: string } | null;

  // ── Engine flags ──
  waitingForInput: boolean; // blocking on say/narrate/extend
  autoAdvanceDelay: number | null; // ms to wait for pause steps
  loading: boolean;
  error: string | null;

  // ── Progression ──
  completedRoutes: string[];
}
