// ─── Audio Manager ────────────────────────────────────────────────────────────
//
// Manages three independent audio channels:
//   bgm   — background music (looping, cross-fades)
//   sfx   — sound effects (one-shot)
//   voice — character voice lines (one-shot, interrupted on advance)
//
// Usage:
//   audioManager.playBGM('/assets/Audio/BGM/Outdoors.ogg', { fadein: 1 })
//   audioManager.stopBGM({ fadeout: 1 })
//   audioManager.playSFX('/assets/Audio/SFX/sfx_door.ogg')
//   audioManager.playVoice('/assets/Audio/Voice/...')
//   audioManager.stopVoice()

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BGMOptions {
  fadein?: number; // seconds
  fadeout?: number; // seconds for the *previous* track to fade out before starting
  loop?: boolean; // default: true
}

export interface StopOptions {
  fadeout?: number; // seconds
}

// ─── Volume settings (user-controllable) ──────────────────────────────────────

export interface VolumeSettings {
  master: number; // 0–1
  bgm: number; // 0–1
  sfx: number; // 0–1
  voice: number; // 0–1
}

const DEFAULT_VOLUME: VolumeSettings = {
  master: 1,
  bgm: 0.7,
  sfx: 0.8,
  voice: 1.0,
};

// ─── Fade utility ─────────────────────────────────────────────────────────────

interface FadeHandle {
  cancel: () => void;
}

/**
 * Linearly fade an HTMLAudioElement's volume from `from` to `to` over
 * `durationMs` milliseconds.  Calls `onComplete` when done (or cancelled).
 */
function fadeVolume(
  el: HTMLAudioElement,
  from: number,
  to: number,
  durationMs: number,
  onComplete?: () => void,
): FadeHandle {
  let cancelled = false;
  const steps = Math.max(1, Math.round(durationMs / 50));
  const stepMs = durationMs / steps;
  const delta = (to - from) / steps;
  let current = from;
  let step = 0;

  el.volume = Math.max(0, Math.min(1, from));

  const interval = setInterval(() => {
    if (cancelled) {
      clearInterval(interval);
      return;
    }
    step++;
    current += delta;
    el.volume = Math.max(0, Math.min(1, current));
    if (step >= steps) {
      clearInterval(interval);
      el.volume = Math.max(0, Math.min(1, to));
      onComplete?.();
    }
  }, stepMs);

  return {
    cancel: () => {
      cancelled = true;
      clearInterval(interval);
    },
  };
}

// ─── AudioManager class ───────────────────────────────────────────────────────

class AudioManager {
  private volumes: VolumeSettings = { ...DEFAULT_VOLUME };

  // BGM channel
  private bgmEl: HTMLAudioElement | null = null;
  private bgmSrc: string | null = null;
  private bgmFade: FadeHandle | null = null;

  // SFX channel — small pool so overlapping effects don't cut each other off
  private sfxPool: HTMLAudioElement[] = [];
  private readonly SFX_POOL_SIZE = 4;

  // Voice channel
  private voiceEl: HTMLAudioElement | null = null;

  // Whether user has interacted (browsers block autoplay until interaction)
  private unlocked = false;

  // ─── Volume control ─────────────────────────────────────────────────────────

  getVolumes(): VolumeSettings {
    return { ...this.volumes };
  }

  setVolumes(v: Partial<VolumeSettings>): void {
    this.volumes = { ...this.volumes, ...v };
    this._applyBGMVolume();
    const sfxVol = this._effectiveVolume("sfx");
    for (const el of this.sfxPool) el.volume = sfxVol;
    if (this.voiceEl) this.voiceEl.volume = this._effectiveVolume("voice");
  }

  private _effectiveVolume(channel: "bgm" | "sfx" | "voice"): number {
    return Math.max(
      0,
      Math.min(1, this.volumes.master * this.volumes[channel]),
    );
  }

  private _applyBGMVolume(): void {
    if (this.bgmEl && !this.bgmFade) {
      this.bgmEl.volume = this._effectiveVolume("bgm");
    }
  }

  // ─── Unlock (call on first user gesture) ────────────────────────────────────

  unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    // Resume any suspended audio contexts (not needed for plain <audio>)
    // If we had a pending BGM play, resume it
  }

  // ─── BGM ────────────────────────────────────────────────────────────────────

  /**
   * Play a BGM track.  If the same track is already playing, this is a no-op.
   * If a different track is playing it cross-fades: fades out the current
   * one then fades in the new one (if fadein is set).
   */
  playBGM(src: string, opts: BGMOptions = {}): void {
    if (!src) return;
    if (this.bgmSrc === src && this.bgmEl && !this.bgmEl.paused) return;

    const fadein = (opts.fadein ?? 0) * 1000;
    const fadeout = (opts.fadeout ?? 0) * 1000;
    const loop = opts.loop !== false;

    const startNew = () => {
      // Cancel any running fade
      this.bgmFade?.cancel();
      this.bgmFade = null;

      // Dispose old element
      if (this.bgmEl) {
        this.bgmEl.pause();
        this.bgmEl.src = "";
        this.bgmEl.onended = null;
      }

      const el = new Audio(src);
      el.loop = loop;
      el.volume = fadein > 0 ? 0 : this._effectiveVolume("bgm");
      el.preload = "auto";
      this.bgmEl = el;
      this.bgmSrc = src;

      el.play().catch((err) => {
        // Autoplay was blocked — retry after interaction
        console.warn("[audio] BGM autoplay blocked:", err);
      });

      if (fadein > 0) {
        this.bgmFade = fadeVolume(
          el,
          0,
          this._effectiveVolume("bgm"),
          fadein,
          () => {
            this.bgmFade = null;
          },
        );
      }
    };

    if (this.bgmEl && !this.bgmEl.paused && fadeout > 0) {
      // Fade out current track, then start new
      const currentEl = this.bgmEl;
      this.bgmFade?.cancel();
      this.bgmFade = fadeVolume(
        currentEl,
        currentEl.volume,
        0,
        fadeout,
        startNew,
      );
    } else {
      startNew();
    }
  }

  /** Stop the currently playing BGM, optionally with a fade-out. */
  stopBGM(opts: StopOptions = {}): void {
    if (!this.bgmEl) return;
    const fadeout = (opts.fadeout ?? 0) * 1000;

    if (fadeout > 0) {
      this.bgmFade?.cancel();
      const el = this.bgmEl;
      this.bgmFade = fadeVolume(el, el.volume, 0, fadeout, () => {
        el.pause();
        el.src = "";
        this.bgmFade = null;
        if (this.bgmEl === el) {
          this.bgmEl = null;
          this.bgmSrc = null;
        }
      });
    } else {
      this.bgmFade?.cancel();
      this.bgmFade = null;
      this.bgmEl.pause();
      this.bgmEl.src = "";
      this.bgmEl = null;
      this.bgmSrc = null;
    }
  }

  /** Return the src of the currently playing BGM track, or null. */
  currentBGM(): string | null {
    return this.bgmSrc;
  }

  // ─── SFX ────────────────────────────────────────────────────────────────────

  /**
   * Play a one-shot sound effect.
   *
   * Uses a small pool of HTMLAudioElement instances so that rapid or
   * overlapping sound effects don't cut each other off.  When all pool
   * slots are busy the oldest one is reused.
   */
  playSFX(src: string): void {
    if (!src) return;

    // Find a free slot (paused or already ended).
    let el = this.sfxPool.find((e) => e.paused || e.ended);

    if (!el) {
      if (this.sfxPool.length < this.SFX_POOL_SIZE) {
        // Grow the pool.
        el = new Audio();
        this.sfxPool.push(el);
      } else {
        // Pool is full — reuse the first slot (oldest playing effect).
        el = this.sfxPool[0];
        el.pause();
      }
    }

    el.src = src;
    el.volume = this._effectiveVolume("sfx");
    el.preload = "auto";
    el.play().catch((err) => {
      console.warn("[audio] SFX autoplay blocked:", err);
    });
  }

  stopSFX(): void {
    for (const el of this.sfxPool) {
      el.pause();
      el.src = "";
    }
  }

  // ─── Voice ──────────────────────────────────────────────────────────────────

  /**
   * Play a voice line.  Stops any currently playing voice.
   */
  playVoice(src: string): void {
    if (!src) return;
    this.stopVoice();
    const el = new Audio(src);
    el.volume = this._effectiveVolume("voice");
    el.preload = "auto";
    this.voiceEl = el;
    el.play().catch((err) => {
      console.warn("[audio] Voice autoplay blocked:", err);
    });
    el.onended = () => {
      if (this.voiceEl === el) {
        this.voiceEl = null;
      }
    };
  }

  stopVoice(): void {
    if (!this.voiceEl) return;
    this.voiceEl.pause();
    this.voiceEl.src = "";
    this.voiceEl.onended = null;
    this.voiceEl = null;
  }

  // ─── Global controls ────────────────────────────────────────────────────────

  /** Stop all audio immediately and release pool elements. */
  stopAll(): void {
    this.stopBGM();
    this.stopSFX();
    this.stopVoice();
  }

  /** Pause BGM (e.g. when window loses focus). */
  pauseBGM(): void {
    this.bgmEl?.pause();
  }

  /** Resume BGM (e.g. when window regains focus). */
  resumeBGM(): void {
    if (this.bgmEl && this.bgmEl.paused && this.bgmSrc) {
      this.bgmEl.play().catch(() => {});
    }
  }
}

// ─── Singleton export ──────────────────────────────────────────────────────────

export const audioManager = new AudioManager();

// Auto-unlock on first interaction
if (typeof document !== "undefined") {
  const unlock = () => {
    audioManager.unlock();
    document.removeEventListener("click", unlock);
    document.removeEventListener("keydown", unlock);
  };
  document.addEventListener("click", unlock);
  document.addEventListener("keydown", unlock);
}

// Pause BGM when tab is hidden, resume when visible
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      audioManager.pauseBGM();
    } else {
      audioManager.resumeBGM();
    }
  });
}
