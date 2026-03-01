// ─── Core game execution engine ───────────────────────────────────────────────
//
// This module implements the VN state machine. It is pure logic — no React,
// no DOM, no side-effects beyond returning a new GameState.
//
// The public entry-point is `advance()`:
//   - Given the current GameState and an action (click / choice selection)
//   - Executes as many "instant" steps as possible
//   - Stops when it reaches a step that needs user input (say / narrate /
//     menu) or a timed pause
//   - Returns the new GameState
//
// Debug logging is gated on `DBG` which resolves to `import.meta.env.DEV`.
// In production builds Vite replaces DEV with `false` and esbuild/terser
// tree-shakes all `if (DBG) { ... }` blocks — zero runtime overhead.

import type {
  GameState,
  Step,
  SpriteState,
  MenuOption,
  StackFrame,
  DialogueState,
} from "./types";
import { getLabel, getManifestStart, getDefineVars } from "./loader";
import { evaluateCondition } from "./evaluate";
import { resolveAsset } from "./assets";
import { VarStore } from "./vars";

// ─── Debug logging ────────────────────────────────────────────────────────────
const DBG = import.meta.env.DEV;

// ─── Maximum steps to execute per tick (safety limit) ────────────────────────
const MAX_STEPS_PER_TICK = 2000;

// ─── Sprite tag helpers ───────────────────────────────────────────────────────

/**
 * Extract the TAG from a sprite key.
 *
 * Mirrors Ren'Py's tag system: the TAG is the first dot-segment of the key,
 * or the whole key when there are no dots.
 *
 *   "keitaro.normal1"  → "keitaro"      (face sprite)
 *   "keitaro_casual"   → "keitaro_casual" (body sprite, no dot)
 *   "cg.arrival2"      → "cg"           (CG image)
 *   "hina.sick.normal1" → "hina"        (multi-attr face)
 *   "bg_entrance_day"  → "bg_entrance_day" (background, no dot)
 */
function spriteTag(key: string): string {
  const dotIdx = key.indexOf(".");
  return dotIdx >= 0 ? key.slice(0, dotIdx) : key;
}

// ─── Action types ─────────────────────────────────────────────────────────────

export type AdvanceAction =
  | { kind: "click" } // player clicked to advance
  | { kind: "choose"; index: number } // player selected a menu option
  | { kind: "jump"; label: string }; // internal: jump to label directly

// ─── Factory: initial game state ──────────────────────────────────────────────

export function createInitialState(): GameState {
  return {
    phase: "title",
    currentLabel: "start",
    stepIndex: 0,
    callStack: [],
    vars: VarStore.empty(),

    backgroundSrc: null,
    bgFilter: null,
    sprites: [],
    spriteCounter: 0,

    bgmSrc: null,
    sfxSrc: null,
    voiceSrc: null,

    dialogue: null,
    choices: null,

    waitingForInput: false,
    autoAdvanceDelay: null,
    loading: false,
    error: null,

    completedRoutes: [],
  };
}

// ─── Public: start a new game from label "start" ─────────────────────────────

/**
 * Resume execution from a restored save state.
 * When a save is loaded at a non-blocking step (e.g. just before a jump),
 * waitingForInput is false and clicks do nothing. Call this after applySave
 * to automatically run forward to the first blocking step (dialogue / menu).
 */
export function resumeFromSave(state: GameState): GameState {
  if (state.waitingForInput || state.choices) return state;
  return runUntilBlocked(state);
}

export function startNewGame(state: GameState): GameState {
  const startLabel = getManifestStart();
  const fresh: GameState = {
    ...createInitialState(),
    phase: "playing",
    // Seed vars with all .rrs defines so image/char/audio resolve at runtime.
    vars: VarStore.fromDefines(getDefineVars()),
    completedRoutes: state.completedRoutes,
    currentLabel: startLabel,
    stepIndex: 0,
  };

  return runUntilBlocked(fresh);
}

// ─── Public: advance the story (player click or choice) ──────────────────────

export function advance(state: GameState, action: AdvanceAction): GameState {
  if (state.phase !== "playing") return state;

  // ── Handle menu choice ──
  if (action.kind === "choose") {
    if (!state.choices) return state;
    const option = state.choices[action.index];
    if (!option) return state;

    if (DBG) {
      console.log(
        `[engine-debug] choose action: index=${action.index} available=${state.choices.length} currentLabel=${state.currentLabel} stepIndex=${state.stepIndex}`,
      );
      for (let i = 0; i < state.choices.length; i++) {
        const ch = state.choices[i];
        console.log(
          `[engine-debug]   option[${i}] text=${JSON.stringify(ch.text)} steps=${(ch as { steps?: unknown[] }).steps?.length ?? 0}`,
        );
      }
    }

    // Inline the option's steps into a mini-label and start executing them.
    // When those steps are exhausted we fall through to the next step after
    // the menu.  We achieve this by pushing the "after-menu" position onto
    // the call stack and jumping to a synthetic continuation.
    const afterMenuStack: StackFrame = {
      label: state.currentLabel,
      stepIndex: state.stepIndex, // stepIndex is already menuIdx+1 (set by block() in executeStep)
    };
    const currentInline = _registerInlineSteps(option.steps);
    const next: GameState = {
      ...state,
      choices: null,
      waitingForInput: false,
      voiceSrc: null,
      dialogue: null,
      // We store the option steps as an "inline" label via the stack trick:
      // push current position, then execute option.steps inline.
      callStack: [...state.callStack, afterMenuStack],
      // Use a special synthetic label name to store inline steps.
      // We register it temporarily in the runtime store.
      currentLabel: currentInline,
      stepIndex: 0,
    };

    if (DBG)
      console.log(
        `[engine-debug] inlining choice index=${action.index} inlineLabel=${currentInline} returningTo=${afterMenuStack.label}@${afterMenuStack.stepIndex}`,
      );

    return runUntilBlocked(next);
  }

  // ── Handle jump action ──
  if (action.kind === "jump") {
    const next: GameState = {
      ...state,
      choices: null,
      waitingForInput: false,
      currentLabel: action.label,
      stepIndex: 0,
      callStack: [],
    };
    return runUntilBlocked(next);
  }

  // ── Handle click (advance past dialogue / pause) ──
  if (!state.waitingForInput) return state;

  const next: GameState = {
    ...state,
    waitingForInput: false,
    autoAdvanceDelay: null,
    voiceSrc: null, // stop voice on advance
    dialogue: null,
  };
  return runUntilBlocked(next);
}

// ─── Inline step registry ─────────────────────────────────────────────────────
/**
 * Returns true if the given step list contains at least one step that would
 * either block (dialogue / menu / pause) or transfer control elsewhere
 * (jump / call / return).  Labels that contain *only* non-blocking,
 * non-control-flow steps (scene, show, hide, play, set, …) will inevitably
 * fall through to the end of the label.  When such a label is reached via a
 * `jump` (which clears the call stack) the engine would transition to
 * `game_end` — almost certainly not the intended behaviour.  We check for
 * this condition before executing the jump so we can skip it instead.
 */
function labelHasBlockingOrControlFlow(steps: Step[]): boolean {
  for (const step of steps) {
    switch (step.type) {
      case "say":
      case "narrate":
      case "extend":
      case "menu":
      case "pause":
      case "return":
      case "jump":
      case "call":
        return true;
      case "if":
        // Recurse into every branch — if *any* branch has blocking/CF, the
        // label is considered non-trivial.
        for (const branch of step.branches) {
          if (labelHasBlockingOrControlFlow(branch.steps)) return true;
        }
        break;
      default:
        break;
    }
  }
  return false;
}

// We store "virtual" label bodies created at runtime (for menu option steps).

const _inlineRegistry: Map<string, Step[]> = new Map();
let _inlineCounter = 0;

function _registerInlineSteps(steps: Step[]): string {
  const name = `__inline_${_inlineCounter++}`;
  _inlineRegistry.set(name, steps);
  return name;
}

function _getSteps(label: string): Step[] | null {
  if (_inlineRegistry.has(label)) return _inlineRegistry.get(label)!;
  return getLabel(label);
}

/**
 * Remove all inline labels that are no longer reachable from the given call
 * stack.  Call this whenever the call stack is cleared (jump) or replaced
 * wholesale (applySave / startNewGame) so that accumulated __inline_N entries
 * from previous menus / if-branches do not leak indefinitely.
 *
 * The current execution label is also considered reachable so we never delete
 * a label that is actively being executed.
 */
export function pruneInlineRegistry(
  callStack: StackFrame[],
  currentLabel: string,
): void {
  if (_inlineRegistry.size === 0) return;
  const reachable = new Set<string>();
  reachable.add(currentLabel);
  for (const frame of callStack) {
    reachable.add(frame.label);
  }
  for (const key of _inlineRegistry.keys()) {
    if (!reachable.has(key)) {
      _inlineRegistry.delete(key);
    }
  }
}

// ─── Main execution loop ──────────────────────────────────────────────────────

function runUntilBlocked(state: GameState): GameState {
  let s = state;
  let iterations = 0;

  while (iterations++ < MAX_STEPS_PER_TICK) {
    const steps = _getSteps(s.currentLabel);

    // ── End of label ──
    if (!steps || s.stepIndex >= steps.length) {
      // Try to return from a call
      if (s.callStack.length > 0) {
        const [frame] = [...s.callStack].reverse();
        // Capture the label that just ran out of steps BEFORE overwriting s
        const exhaustedLabel = s.currentLabel;
        s = {
          ...s,
          currentLabel: frame.label,
          stepIndex: frame.stepIndex,
          callStack: s.callStack.slice(0, s.callStack.length - 1),
        };
        // Clean up inline label if the exhausted block was an inline block
        if (exhaustedLabel.startsWith("__inline_")) {
          _inlineRegistry.delete(exhaustedLabel);
        }
        continue;
      }

      // No more script — transition to end screen
      s = {
        ...s,
        phase: "game_end",
        waitingForInput: false,
        dialogue: null,
      };
      break;
    }

    const step = steps[s.stepIndex];
    if (DBG)
      console.info(
        `[engine-debug] running step index=${s.stepIndex} type=${step.type} currentLabel=${s.currentLabel}`,
      );
    const result = executeStep(s, step);

    if (result.blocked) {
      // The step produced a blocking state; stop and wait for user action.
      s = result.state;
      if (DBG) {
        console.info(
          `[engine-debug] blocked on step index=${s.stepIndex} type=${step.type} currentLabel=${s.currentLabel} waitingForInput=${s.waitingForInput} choices=${s.choices ? s.choices.length : 0}`,
        );
        if (s.dialogue) {
          console.info(
            `[engine-debug]   dialogue who=${JSON.stringify(s.dialogue.who)} text=${JSON.stringify(s.dialogue.text).slice(0, 120)} voice=${s.dialogue.voice ?? "null"}`,
          );
        }
      }
      break;
    }

    s = result.state;
  }

  if (iterations >= MAX_STEPS_PER_TICK) {
    console.error(
      "[engine] MAX_STEPS_PER_TICK exceeded — possible infinite loop",
    );
  }

  return s;
}

// ─── Step execution ───────────────────────────────────────────────────────────

interface StepResult {
  state: GameState;
  blocked: boolean;
}

// ─── Runtime var resolvers ────────────────────────────────────────────────────
//
// All helpers accept VarStore so they can call .get() which checks gameVars
// first then defineVars, without merging the two into a plain object.

function resolveImageSrc(src: string, vars: VarStore): string {
  if (!src) return src;
  if (src.startsWith("#") || src.includes("/")) return src;
  const key = "image." + src;
  const resolved = vars.get(key);
  if (typeof resolved === "string") return resolved;
  console.error(`[engine] image var not found: ${key}`);
  return src;
}

function resolveCharName(who: string | null, vars: VarStore): string | null {
  if (!who) return null;
  const key = "char." + who;
  if (vars.has(key)) {
    const name = vars.get(key);
    if (name === "" || name === null || name === undefined) return null;
    return String(name);
  }
  return who;
}

function resolveAudioSrc(
  src: string | undefined,
  vars: VarStore,
): string | undefined {
  if (!src) return undefined;
  if (src.includes("/")) return src;
  const key = src.startsWith("audio.") ? src : "audio." + src;
  const resolved = vars.get(key);
  if (typeof resolved === "string") return resolved;
  console.error(`[engine] audio var not found: ${key}`);
  return undefined;
}

// ─── Step executor ────────────────────────────────────────────────────────────

function executeStep(state: GameState, step: Step): StepResult {
  const advance = (s: GameState): StepResult => ({
    state: { ...s, stepIndex: s.stepIndex + 1 },
    blocked: false,
  });
  const block = (s: GameState): StepResult => ({
    state: s,
    blocked: true,
  });

  switch (step.type) {
    // ── Variable assignment ─────────────────────────────────────────────────
    case "set": {
      // applySet operates directly on the game-vars layer — no toRecord() copy.
      return advance({ ...state, vars: state.vars.applySet(step) });
    }

    // ── Scene (background swap) ─────────────────────────────────────────────
    case "scene": {
      const backgroundSrc = resolveAsset(resolveImageSrc(step.src, state.vars));
      // A `scene` command hides all sprites
      return advance({
        ...state,
        backgroundSrc,
        bgFilter: step.filter ?? null,
        sprites: [],
        spriteCounter: state.spriteCounter,
      });
    }

    // ── Show (display sprite / CG / overlay) ────────────────────────────────
    //
    // Sprite keys use the Ren'Py tag system with dots as separators:
    //   "keitaro_casual"   — body sprite, tag = "keitaro_casual"
    //   "keitaro.normal1"  — face sprite, tag = "keitaro"
    //   "cg.arrival2"      — CG image,    tag = "cg"
    //   "bg_entrance_day"  — background overlay, tag = "bg_entrance_day"
    //
    // TAG = first dot-segment of the key, or the whole key if no dots.
    // When showing a new sprite, any existing sprite with the same TAG is
    // replaced in-place (preserving z-index and position).
    case "show": {
      const newTag = spriteTag(step.sprite);
      // Resolve sprite src via vars["image." + sprite]; step.src is no longer
      // pre-resolved at compile time.
      const src = resolveAsset(resolveImageSrc(step.sprite, state.vars));

      // Inherit position from existing same-tag sprite when not specified
      const existingIdx = state.sprites.findIndex(
        (sp) => spriteTag(sp.key) === newTag,
      );
      let at = step.at;
      if (!at && existingIdx >= 0) {
        at = state.sprites[existingIdx].at;
      }

      if (existingIdx >= 0) {
        // Replace existing sprite with same tag in-place (keeps z-index slot)
        const sprites = state.sprites.map((sp, i) =>
          i === existingIdx
            ? { ...sp, key: step.sprite, src: src || sp.src, at: at ?? sp.at }
            : sp,
        );
        return advance({ ...state, sprites });
      }

      // No existing sprite with this tag — add a new one.
      // If this is a dot-key sprite (face/expression/CG), ensure its zIndex
      // is above any no-dot sprite (body) at the same position so faces
      // always render on top of their body sprites.
      const hasDot = step.sprite.includes(".");
      let newZIndex = state.spriteCounter;
      if (hasDot && at) {
        const maxBodyZAtPos = state.sprites.reduce((max, sp) => {
          const isBody = !sp.key.includes(".");
          return isBody && sp.at === at ? Math.max(max, sp.zIndex) : max;
        }, -1);
        if (maxBodyZAtPos >= newZIndex) {
          newZIndex = maxBodyZAtPos + 1;
        }
      }

      const newSprite: SpriteState = {
        key: step.sprite,
        src,
        at,
        zIndex: newZIndex,
      };
      return advance({
        ...state,
        sprites: [...state.sprites, newSprite],
        spriteCounter: Math.max(state.spriteCounter, newZIndex) + 1,
      });
    }

    // ── Hide (remove sprite by tag) ─────────────────────────────────────────
    //
    // Removes all sprites whose TAG matches step.sprite.
    // TAG = first dot-segment, so:
    //   hide keitaro       → removes "keitaro.normal1", "keitaro.grin1", …
    //   hide keitaro_casual → removes exactly "keitaro_casual" (no dot → tag = whole key)
    //   hide cg            → removes "cg.arrival2", etc.
    case "hide": {
      const hideTag = step.sprite;
      const sprites = state.sprites.filter(
        (sp) => spriteTag(sp.key) !== hideTag,
      );
      return advance({ ...state, sprites });
    }

    // ── With (transition — we just skip the transition itself) ──────────────
    case "with": {
      return advance(state);
    }

    // ── Say (character dialogue) ─────────────────────────────────────────────
    case "say": {
      const resolvedVoice = resolveAudioSrc(step.voice, state.vars);
      const dialogue: DialogueState = {
        who: resolveCharName(step.who, state.vars),
        text: step.text,
        voice: resolvedVoice,
      };
      if (DBG)
        console.info(
          `[engine-debug] say: who=${JSON.stringify(dialogue.who)} text=${JSON.stringify(dialogue.text).slice(0, 120)} voice=${dialogue.voice ?? "null"} currentLabel=${state.currentLabel} stepIndex=${state.stepIndex}`,
        );
      return block({
        ...state,
        stepIndex: state.stepIndex + 1,
        dialogue,
        voiceSrc: resolvedVoice ? resolveAsset(resolvedVoice) : null,
        waitingForInput: true,
        autoAdvanceDelay: null,
      });
    }

    // ── Narrate (no speaker) ─────────────────────────────────────────────────
    case "narrate": {
      const resolvedVoice = resolveAudioSrc(step.voice, state.vars);
      const dialogue: DialogueState = {
        who: null,
        text: step.text,
        voice: resolvedVoice,
      };
      return block({
        ...state,
        stepIndex: state.stepIndex + 1,
        dialogue,
        voiceSrc: resolvedVoice ? resolveAsset(resolvedVoice) : null,
        waitingForInput: true,
        autoAdvanceDelay: null,
      });
    }

    // ── Extend (append to previous dialogue) ────────────────────────────────
    case "extend": {
      const prev = state.dialogue;
      const resolvedVoice = resolveAudioSrc(step.voice, state.vars);
      const dialogue: DialogueState = {
        who: prev?.who ?? null,
        text: (prev?.text ?? "") + step.text,
        voice: resolvedVoice ?? prev?.voice,
      };
      return block({
        ...state,
        stepIndex: state.stepIndex + 1,
        dialogue,
        voiceSrc: resolvedVoice
          ? resolveAsset(resolvedVoice)
          : prev?.voice
            ? resolveAsset(prev.voice)
            : state.voiceSrc,
        waitingForInput: true,
        autoAdvanceDelay: null,
      });
    }

    // ── Music ───────────────────────────────────────────────────────────────
    case "music": {
      if (step.action === "play" && step.src) {
        const resolved = resolveAudioSrc(step.src, state.vars);
        return advance({
          ...state,
          bgmSrc: resolved ? resolveAsset(resolved) : null,
        });
      }
      if (step.action === "stop") {
        return advance({ ...state, bgmSrc: null });
      }
      return advance(state);
    }

    // ── Sound ───────────────────────────────────────────────────────────────
    case "sound": {
      if (step.action === "play" && step.src) {
        const resolved = resolveAudioSrc(step.src, state.vars);
        return advance({
          ...state,
          sfxSrc: resolved ? resolveAsset(resolved) : null,
        });
      }
      if (step.action === "stop") {
        return advance({ ...state, sfxSrc: null });
      }
      return advance(state);
    }

    // ── Menu (player choice) ─────────────────────────────────────────────────
    case "menu": {
      const choices: MenuOption[] = step.options.filter((opt) => {
        if (!opt.condition) return true;
        return evaluateCondition(opt.condition, state.vars.toRecord());
      });

      if (DBG) {
        console.log(
          `[engine-debug] menu at ${state.currentLabel}@${state.stepIndex} rawOptions=${step.options.length} filtered=${choices.length}`,
        );
        for (let i = 0; i < choices.length; i++) {
          console.log(
            `[engine-debug]   menu option[${i}] text=${JSON.stringify(choices[i].text)} steps=${choices[i].steps.length}`,
          );
        }
      }

      if (choices.length === 0) {
        // No valid choices — skip the menu entirely
        if (DBG) console.log(`[engine-debug] menu: no valid choices, skipping`);
        return advance(state);
      }

      if (choices.length === 1) {
        // Auto-select the only available option
        const option = choices[0];
        const afterMenuStack: StackFrame = {
          label: state.currentLabel,
          stepIndex: state.stepIndex + 1,
        };
        if (DBG)
          console.log(
            `[engine-debug] menu: auto-select single choice -> inlining ${afterMenuStack.label}@${afterMenuStack.stepIndex}`,
          );
        return {
          state: {
            ...state,
            choices: null,
            callStack: [...state.callStack, afterMenuStack],
            currentLabel: _registerInlineSteps(option.steps),
            stepIndex: 0,
          },
          blocked: false,
        };
      }

      if (DBG)
        console.log(
          `[engine-debug] menu: presenting ${choices.length} choices to player`,
        );

      return block({
        ...state,
        stepIndex: state.stepIndex + 1,
        choices,
        waitingForInput: false, // choices don't use waitingForInput
        dialogue: state.dialogue, // keep last dialogue visible behind choices
      });
    }

    // ── If / else-if / else ──────────────────────────────────────────────────
    case "if": {
      for (const branch of step.branches) {
        if (evaluateCondition(branch.condition, state.vars.toRecord())) {
          if (branch.steps.length === 0) {
            // Empty branch — advance past the if block
            return advance(state);
          }
          // Push continuation, execute branch steps
          const afterIfStack: StackFrame = {
            label: state.currentLabel,
            stepIndex: state.stepIndex + 1,
          };
          return {
            state: {
              ...state,
              callStack: [...state.callStack, afterIfStack],
              currentLabel: _registerInlineSteps(branch.steps),
              stepIndex: 0,
            },
            blocked: false,
          };
        }
      }
      // No branch matched
      return advance(state);
    }

    // ── Jump ─────────────────────────────────────────────────────────────────
    case "jump": {
      if (DBG)
        console.log(
          `[engine-debug] jump requested to "${step.target}" from ${state.currentLabel}@${state.stepIndex}`,
        );

      let target = step.target;
      if (!_getSteps(target)) {
        const varVal = state.vars.get(target);
        if (typeof varVal === "string" && _getSteps(varVal)) {
          target = varVal;
        } else {
          console.warn(
            "[engine] jump to unknown label:",
            target,
            "(var value:",
            varVal,
            ")",
          );
          if (DBG)
            console.log(
              `[engine-debug] jump -> unknown label "${target}", advancing instead`,
            );
          return advance(state);
        }
      }

      // Safety check: if the target label contains no blocking steps and no
      // control-flow (return / jump / call), executing it would exhaust all its
      // steps and — because `jump` clears the call stack — transition the engine
      // directly to `game_end`.  This happens with "stub" labels that only do
      // visual bookkeeping (scene, show, set …) with no dialogue or explicit
      // return.  Skip such jumps so the current narrative flow can continue.
      const targetSteps = _getSteps(target);
      if (!targetSteps || !labelHasBlockingOrControlFlow(targetSteps)) {
        console.warn(
          "[engine] jump to dead-end label (no blocking/CF steps), skipping:",
          target,
        );
        if (DBG)
          console.log(
            `[engine-debug] jump -> dead-end label "${target}", skipping jump`,
          );
        return advance(state);
      }

      if (DBG)
        console.log(
          `[engine-debug] performing jump -> "${target}" (clearing call stack)`,
        );

      // Prune inline labels that were on the old call stack — they are no
      // longer reachable after the stack is cleared by this jump.
      pruneInlineRegistry(state.callStack, target);

      return {
        state: {
          ...state,
          currentLabel: target,
          stepIndex: 0,
          // jump clears the call stack (unlike call)
          callStack: [],
        },
        blocked: false,
      };
    }

    // ── Call ─────────────────────────────────────────────────────────────────
    case "call": {
      let target = step.target;
      if (!_getSteps(target)) {
        const varVal = state.vars.get(target);
        if (typeof varVal === "string" && _getSteps(varVal)) {
          target = varVal;
        } else {
          console.warn(
            "[engine] call to unknown label:",
            target,
            "(var value:",
            varVal,
            ")",
          );
          return advance(state);
        }
      }
      const returnFrame: StackFrame = {
        label: state.currentLabel,
        stepIndex: state.stepIndex + 1,
      };
      return {
        state: {
          ...state,
          callStack: [...state.callStack, returnFrame],
          currentLabel: target,
          stepIndex: 0,
        },
        blocked: false,
      };
    }

    // ── Return ───────────────────────────────────────────────────────────────
    case "return": {
      if (state.callStack.length === 0) {
        // Return at top level — end of script
        return block({
          ...state,
          waitingForInput: false,
          dialogue: { who: null, text: "── 完 ──" },
        });
      }
      const stack = [...state.callStack];
      const frame = stack.pop()!;
      return {
        state: {
          ...state,
          callStack: stack,
          currentLabel: frame.label,
          stepIndex: frame.stepIndex,
        },
        blocked: false,
      };
    }

    // ── Pause ────────────────────────────────────────────────────────────────
    case "pause": {
      const duration = step.duration;
      if (duration != null && duration > 0) {
        // Timed pause: auto-advance after `duration` seconds
        return block({
          ...state,
          stepIndex: state.stepIndex + 1,
          waitingForInput: true,
          autoAdvanceDelay: Math.round(duration * 1000),
        });
      }
      // Infinite pause: wait for click
      return block({
        ...state,
        stepIndex: state.stepIndex + 1,
        waitingForInput: true,
        autoAdvanceDelay: null,
      });
    }

    default: {
      // Unknown step type — skip it
      const unknown = step as { type: string };
      console.warn("[engine] Unknown step type:", unknown.type);
      return advance(state);
    }
  }
}
