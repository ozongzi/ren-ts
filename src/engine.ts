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

import type {
  GameState,
  Step,
  SpriteState,
  MenuOption,
  StackFrame,
  DialogueState,
} from "./types";
import { getLabel, getManifestStart } from "./loader";
import { evaluateCondition, applySetStep, defaultVars } from "./evaluate";
import { resolveAsset, isCharacterSprite, isFaceSprite } from "./assets";

// ─── Maximum steps to execute per tick (safety limit) ────────────────────────
const MAX_STEPS_PER_TICK = 2000;

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
    vars: defaultVars(),

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
  // Read the entry-point label from the manifest (defaults to "start" per
  // Ren'Py convention if the manifest does not specify one).
  const startLabel = getManifestStart();
  const fresh: GameState = {
    ...createInitialState(),
    phase: "playing",
    // Preserve completed routes across new games
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

    // Inline the option's steps into a mini-label and start executing them.
    // When those steps are exhausted we fall through to the next step after
    // the menu.  We achieve this by pushing the "after-menu" position onto
    // the call stack and jumping to a synthetic continuation.
    const afterMenuStack: StackFrame = {
      label: state.currentLabel,
      stepIndex: state.stepIndex, // stepIndex is already menuIdx+1 (set by block() in executeStep)
    };
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
      currentLabel: _registerInlineSteps(option.steps),
      stepIndex: 0,
    };
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
        const [frame, ...rest] = [...s.callStack].reverse();
        s = {
          ...s,
          currentLabel: frame.label,
          stepIndex: frame.stepIndex,
          callStack: s.callStack.slice(0, s.callStack.length - 1),
        };
        // Clean up inline label if this was an inline block
        if (s.currentLabel.startsWith("__inline_")) {
          _inlineRegistry.delete(s.currentLabel);
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
    const result = executeStep(s, step);

    if (result.blocked) {
      // The step produced a blocking state; stop and wait for user action.
      s = result.state;
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
      const vars = applySetStep(state.vars, step);
      return advance({ ...state, vars });
    }

    // ── Scene (background swap) ─────────────────────────────────────────────
    case "scene": {
      const backgroundSrc = resolveAsset(step.src);
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
    case "show": {
      if (!step.src) {
        // src-less show: just update position of an already-shown sprite
        const sprites = state.sprites.map((sp) =>
          sp.key === step.sprite ? { ...sp, at: step.at ?? sp.at } : sp,
        );
        return advance({ ...state, sprites });
      }

      const src = resolveAsset(step.src);
      const existing = state.sprites.find((sp) => sp.key === step.sprite);

      // If this is a face sprite, inherit the body's `at` position if not
      // given explicitly.
      let at = step.at;
      if (!at && isFaceSprite(step.sprite)) {
        const charName = step.sprite.toLowerCase().split(" face")[0];
        const bodySprite = state.sprites.find(
          (sp) => sp.key.toLowerCase() === `${charName} body`,
        );
        if (bodySprite) at = bodySprite.at;
      }

      if (existing) {
        // Update existing sprite (same key — just swap src/position)
        const sprites = state.sprites.map((sp) =>
          sp.key === step.sprite ? { ...sp, src, at: at ?? sp.at } : sp,
        );
        return advance({ ...state, sprites });
      }

      // ── Character expression replacement ──────────────────────────────────
      // Sprite keys for body slots use underscores (e.g. "keitaro_casual"),
      // while expression sprites use a space separator
      // (e.g. "keitaro grin1", "hiro laugh2").
      // When a new expression sprite is shown for the same character we
      // replace the old expression in-place instead of stacking a new layer.
      // CG sprites also contain a space ("cg arrival1") but always start with
      // "cg " so we explicitly exclude them.
      const spaceIdx = step.sprite.indexOf(" ");
      const isExpressionSprite =
        spaceIdx > 0 && !step.sprite.toLowerCase().startsWith("cg ");

      if (isExpressionSprite) {
        const charPrefix = step.sprite.substring(0, spaceIdx).toLowerCase();

        // Pass 1 — exact prefix match (e.g. "hiro" → "hiro").
        let oldFaceIdx = state.sprites.findIndex((sp) => {
          const si = sp.key.indexOf(" ");
          return (
            si > 0 &&
            !sp.key.toLowerCase().startsWith("cg ") &&
            sp.key.substring(0, si).toLowerCase() === charPrefix
          );
        });

        // Pass 2 — position-based fallback.
        // Handles body-variant swaps where the prefix changes between steps
        // (e.g. the script hides "hiro2 pout3" but the live sprite is
        // "hiro2 pout2", leaving an orphaned face; then "hiro pout1" is shown
        // at the same `at` position).  Without this fallback both faces would
        // stack on top of each other.
        if (oldFaceIdx < 0 && at) {
          oldFaceIdx = state.sprites.findIndex((sp) => {
            const si = sp.key.indexOf(" ");
            return (
              si > 0 && !sp.key.toLowerCase().startsWith("cg ") && sp.at === at
            );
          });
        }

        if (oldFaceIdx >= 0) {
          // Replace the old expression in-place, keeping its z-index slot
          const sprites = state.sprites.map((sp, i) =>
            i === oldFaceIdx
              ? { ...sp, key: step.sprite, src, at: at ?? sp.at }
              : sp,
          );
          return advance({ ...state, sprites });
        }
      }

      // Add new sprite (no existing sprite of this character/key found)
      // If this is an expression (face) sprite being added fresh, ensure its
      // zIndex is above any body sprite already at the same `at` position.
      // This prevents a body shown before its face from covering the face.
      let newZIndex = state.spriteCounter;
      if (isExpressionSprite && at) {
        const maxBodyZAtPos = state.sprites.reduce((max, sp) => {
          const si = sp.key.indexOf(" ");
          const isBody = si < 0 || sp.key.toLowerCase().startsWith("cg ");
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

    // ── Hide (remove sprite) ────────────────────────────────────────────────
    case "hide": {
      const sprites = state.sprites.filter((sp) => sp.key !== step.sprite);
      return advance({ ...state, sprites });
    }

    // ── With (transition — we just skip the transition itself) ──────────────
    case "with": {
      return advance(state);
    }

    // ── Say (character dialogue) ─────────────────────────────────────────────
    case "say": {
      const dialogue: DialogueState = {
        who: step.who,
        text: step.text,
        voice: step.voice,
      };
      return block({
        ...state,
        stepIndex: state.stepIndex + 1,
        dialogue,
        voiceSrc: step.voice ? resolveAsset(step.voice) : null,
        waitingForInput: true,
        autoAdvanceDelay: null,
      });
    }

    // ── Narrate (no speaker) ─────────────────────────────────────────────────
    case "narrate": {
      const dialogue: DialogueState = {
        who: null,
        text: step.text,
        voice: step.voice,
      };
      return block({
        ...state,
        stepIndex: state.stepIndex + 1,
        dialogue,
        voiceSrc: step.voice ? resolveAsset(step.voice) : null,
        waitingForInput: true,
        autoAdvanceDelay: null,
      });
    }

    // ── Extend (append to previous dialogue) ────────────────────────────────
    case "extend": {
      const prev = state.dialogue;
      const dialogue: DialogueState = {
        who: prev?.who ?? null,
        text: (prev?.text ?? "") + step.text,
        voice: step.voice ?? prev?.voice,
      };
      return block({
        ...state,
        stepIndex: state.stepIndex + 1,
        dialogue,
        voiceSrc: step.voice
          ? resolveAsset(step.voice)
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
        return advance({ ...state, bgmSrc: resolveAsset(step.src) });
      }
      if (step.action === "stop") {
        return advance({ ...state, bgmSrc: null });
      }
      return advance(state);
    }

    // ── Sound ───────────────────────────────────────────────────────────────
    case "sound": {
      if (step.action === "play" && step.src) {
        return advance({ ...state, sfxSrc: resolveAsset(step.src) });
      }
      if (step.action === "stop") {
        return advance({ ...state, sfxSrc: null });
      }
      return advance(state);
    }

    // ── Menu (player choice) ─────────────────────────────────────────────────
    case "menu": {
      // Filter options by condition
      const choices: MenuOption[] = step.options.filter((opt) => {
        if (!opt.condition) return true;
        return evaluateCondition(opt.condition, state.vars);
      });

      if (choices.length === 0) {
        // No valid choices — skip the menu entirely
        return advance(state);
      }

      if (choices.length === 1) {
        // Auto-select the only available option
        const option = choices[0];
        const afterMenuStack: StackFrame = {
          label: state.currentLabel,
          stepIndex: state.stepIndex + 1,
        };
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
        if (evaluateCondition(branch.condition, state.vars)) {
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
      // Resolve target: if no static label exists, treat the target string as a
      // variable name and use its value (Ren'Py-style dynamic jump via variable).
      let target = step.target;
      if (!_getSteps(target)) {
        const varVal = state.vars[target];
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
        return advance(state);
      }

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
      // Same variable-resolution logic as jump.
      let target = step.target;
      if (!_getSteps(target)) {
        const varVal = state.vars[target];
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
