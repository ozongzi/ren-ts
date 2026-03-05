// ─── VarStore ─────────────────────────────────────────────────────────────────
//
// applySet() is the preferred way to apply a `set` step — it operates directly
// on the _game layer without the toRecord() + replaceGameVars() round-trip.
//
// Two-layer variable store that separates read-only define vars from mutable
// game vars.
//
//   defineVars  — all top-level defines collected from every .rrs file
//                 (image.*, char.*, audio.*, persistent.*, arbitrary constants…)
//                 Injected at game start, never written to save files.
//
//   gameVars    — variables written during gameplay ($ x = 1, menu choices, …)
//                 This is the only part that gets persisted to disk.
//
// Lookup order: gameVars first, then defineVars (game vars override).
// All writes go to gameVars only.
//
// Engine code works with VarStore directly.
// evaluate.ts / applySetStep receive a plain merged Record via toRecord() so
// their internal logic requires zero changes.

// Imported here rather than in evaluate.ts to break the potential circular
// dependency: evaluate.ts → vars.ts is fine; vars.ts → evaluate.ts is also
// fine because resolveSetValue does not import from vars.ts.
import { resolveSetValue } from "./evaluate";
import type { Step } from "./types";

export class VarStore {
  private readonly _game: Record<string, unknown>;
  private readonly _defines: Record<string, unknown>;

  constructor(
    game: Record<string, unknown> = {},
    defines: Record<string, unknown> = {},
  ) {
    this._game = game;
    this._defines = defines;
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  /** Look up a key, checking gameVars first then defineVars. */
  get(key: string): unknown {
    if (key in this._game) return this._game[key];
    return this._defines[key]; // undefined when absent
  }

  /** Returns true when key exists in either layer. */
  has(key: string): boolean {
    return key in this._game || key in this._defines;
  }

  /**
   * Return the value of the first key that starts with `prefix`, or undefined.
   * Checks defineVars (image defines live there). Used for Ren'Py tag-fallback:
   * when "image.sayori" isn't defined but "image.sayori.1a" is, return that.
   */
  firstWithPrefix(prefix: string): unknown {
    for (const k of Object.keys(this._defines)) {
      if (k.startsWith(prefix)) return this._defines[k];
    }
    for (const k of Object.keys(this._game)) {
      if (k.startsWith(prefix)) return this._game[k];
    }
    return undefined;
  }

  // ── Write (game vars only) ─────────────────────────────────────────────────

  /**
   * Return a new VarStore with `key` set in the game-vars layer.
   * Define vars are unchanged.
   */
  set(key: string, value: unknown): VarStore {
    return new VarStore({ ...this._game, [key]: value }, this._defines);
  }

  /**
   * Query both layers explicitly and return their values separately.
   * - stored: value present in the game-vars layer (may be undefined)
   * - define: value present in the define-vars layer (may be undefined)
   *
   * Use this when you need to know where a value is coming from.
   */
  queryBoth(key: string): { stored: unknown; define: unknown | undefined } {
    const stored = Object.prototype.hasOwnProperty.call(this._game, key)
      ? this._game[key]
      : undefined;
    const define = Object.prototype.hasOwnProperty.call(this._defines, key)
      ? this._defines[key]
      : undefined;
    return { stored, define };
  }

  /**
   * Set the value in the stored (game) layer. This is an explicit alias to
   * `set` but named to emphasize that it writes only the serialised layer.
   */
  setStored(key: string, value: unknown): VarStore {
    return this.set(key, value);
  }

  /**
   * Return the stored (game) layer value for a single key.
   * Equivalent to accessing the game-vars map directly.
   */
  getStored(key: string): unknown {
    return Object.prototype.hasOwnProperty.call(this._game, key)
      ? this._game[key]
      : undefined;
  }

  /**
   * Return the entire stored (game) map — convenience alias for gameVars().
   */
  stored(): Record<string, unknown> {
    return this.gameVars();
  }

  // ── Apply a set step (preferred path — no full Record copy) ───────────────

  /**
   * Apply a `set` step directly on the game-vars layer and return a new
   * VarStore.  This is the fast path used by the engine: it skips the
   * toRecord() + replaceGameVars() round-trip and never touches _defines.
   *
   * The RHS is resolved via resolveSetValue() which handles:
   *   - Numeric / boolean JSON literals (returned as-is)
   *   - Variable references (looked up in the merged view)
   *   - Function calls like renpy.random.randint(a, b)
   *   - Plain string / number literals
   */
  applySet(step: Extract<Step, { type: "set" }>): VarStore {
    // Resolve the RHS against the merged view so variable references work.
    const merged = this.toRecord();
    let value = resolveSetValue(step.value, merged);
    const current = merged[step.var] ?? 0;

    switch (step.op) {
      case "=":
        break;
      case "+=":
        value = (current as number) + (value as number);
        break;
      case "-=":
        value = (current as number) - (value as number);
        break;
      case "*=":
        value = (current as number) * (value as number);
        break;
      case "/=": {
        const d = value as number;
        value = d !== 0 ? (current as number) / d : 0;
        break;
      }
    }

    return new VarStore({ ...this._game, [step.var]: value }, this._defines);
  }

  // ── Bulk replace (used by applySetStep result merging) ─────────────────────

  /**
   * Return a new VarStore whose game-vars layer is replaced by `game`.
   * Define vars are unchanged.
   *
   * Used when evaluate.ts / applySetStep returns a plain Record that may have
   * been produced from toRecord(); we only want to keep the keys that belong
   * in the game-vars layer (i.e. exclude define keys that were merged in).
   */
  replaceGameVars(game: Record<string, unknown>): VarStore {
    // Strip keys that are purely from defines and haven't been overridden.
    // Any key present in the incoming record but not originally in _game AND
    // present in _defines with the exact same value is a define passthrough —
    // we drop it so it stays in the defines layer and doesn't bloat saves.
    const nextGame: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(game)) {
      if (
        !(k in this._defines) ||
        this._game[k] !== undefined ||
        this._defines[k] !== v
      ) {
        nextGame[k] = v;
      }
    }
    return new VarStore(nextGame, this._defines);
  }

  // ── Views ──────────────────────────────────────────────────────────────────

  /**
   * Merged plain Record — defines first so gameVars overrides.
   *
   * Pass this to evaluateCondition() and applySetStep() which expect a plain
   * Record.  The result of applySetStep() should then be fed back via
   * replaceGameVars() to strip out define pass-throughs.
   */
  toRecord(): Record<string, unknown> {
    return { ...this._defines, ...this._game };
  }

  /**
   * Game vars only — the subset serialised to save files.
   * Define vars are intentionally absent; they are re-injected at load time.
   */
  gameVars(): Record<string, unknown> {
    return { ...this._game };
  }

  /** Read-only view of the define vars layer. */
  defineVars(): Record<string, unknown> {
    return { ...this._defines };
  }

  // ── Factories ─────────────────────────────────────────────────────────────

  /** Empty store — no defines, no game vars.  Used before scripts are loaded. */
  static empty(): VarStore {
    return new VarStore({}, {});
  }

  /**
   * Fresh game store: defineVars from the loader, empty game vars.
   * Call this when starting a new game.
   */
  static fromDefines(defines: Record<string, unknown>): VarStore {
    return new VarStore({}, defines);
  }

  /**
   * Restore from a saved game.
   * Reattaches the define vars (which were not serialised) around the saved
   * game vars.
   */
  static fromSave(
    savedGameVars: Record<string, unknown>,
    defines: Record<string, unknown>,
  ): VarStore {
    return new VarStore(savedGameVars, defines);
  }
}
