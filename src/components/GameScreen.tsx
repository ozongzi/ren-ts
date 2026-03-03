import React, { useEffect, useCallback, useRef } from "react";
import { useGameStore } from "../store";
import { Background } from "./Background";
import { SpriteLayer } from "./SpriteLayer";
import { DialogueBox } from "./DialogueBox";
import { ChoiceMenu } from "./ChoiceMenu";
import { Toolbar } from "./Toolbar";

/**
 * Main game screen — orchestrates all visual layers and UI overlays.
 *
 * Layer order (bottom to top):
 *   0  Background (scene / CG background)
 *   1  Sprites (character bodies + faces, scene overlays)
 *   10 Dialogue box
 *   20 Choice menu overlay
 *   30 Toolbar HUD
 *   50 Modal overlays (gallery, settings)
 *
 * Keyboard handling:
 *   Space / Enter → advance dialogue
 *   Escape        → close topmost modal
 */
export const GameScreen: React.FC = () => {
  const backgroundSrc = useGameStore((s) => s.backgroundSrc);
  const bgFilter = useGameStore((s) => s.bgFilter);
  const sprites = useGameStore((s) => s.sprites);
  const dialogue = useGameStore((s) => s.dialogue);
  const choices = useGameStore((s) => s.choices);
  const waitingForInput = useGameStore((s) => s.waitingForInput);
  const autoAdvanceDelay = useGameStore((s) => s.autoAdvanceDelay);

  const showGallery = useGameStore((s) => s.showGallery);
  const showSettings = useGameStore((s) => s.showSettings);

  const click = useGameStore((s) => s.click);
  const choose = useGameStore((s) => s.choose);
  const closeGallery = useGameStore((s) => s.closeGallery);
  const closeSettings = useGameStore((s) => s.closeSettings);

  // ── Keyboard handler ────────────────────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Modal escape handling (highest priority)
      if (e.key === "Escape") {
        if (showSettings) {
          closeSettings();
          return;
        }
        if (showGallery) {
          closeGallery();
          return;
        }
        return;
      }

      // Don't intercept when a modal is open
      if (showGallery || showSettings) return;

      // Don't intercept when choices are shown (ChoiceMenu handles its own keys)
      if (choices) return;

      // Advance dialogue
      if (
        (e.key === " " || e.key === "Enter") &&
        waitingForInput &&
        !e.repeat
      ) {
        e.preventDefault();
        click();
      }
    },
    [
      choices,
      waitingForInput,
      showGallery,
      showSettings,
      click,
      closeGallery,
      closeSettings,
    ],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // ── Fallback auto-advance timer (fires when no dialogue box is rendered) ────
  // DialogueBox has its own timer, but it only exists when `dialogue` is set.
  // A plain `pause` step (e.g. wait(3) after a scene change) sets
  // autoAdvanceDelay with dialogue=null, so we need to handle it here.
  const prevAutoAdvanceDelay = useRef<number | null>(null);
  useEffect(() => {
    // Only take over when DialogueBox is NOT rendered
    if (dialogue) return;
    if (autoAdvanceDelay == null) return;

    // Avoid re-triggering if nothing changed
    if (autoAdvanceDelay === prevAutoAdvanceDelay.current) return;
    prevAutoAdvanceDelay.current = autoAdvanceDelay;

    const timer = setTimeout(() => {
      prevAutoAdvanceDelay.current = null;
      click();
    }, autoAdvanceDelay);

    return () => {
      clearTimeout(timer);
    };
  }, [autoAdvanceDelay, dialogue, click]);

  // ── Main click handler (advance dialogue on screen click) ───────────────────
  const handleScreenClick = () => {
    // Don't advance if any modal is open
    if (showGallery || showSettings) return;
    // Don't advance if choices are displayed (ChoiceMenu handles clicks)
    if (choices) return;
    // Only advance if waiting for input
    if (waitingForInput) {
      click();
    }
  };

  const anyModalOpen = showGallery || showSettings;

  return (
    <div
      className={`game-container${choices ? " has-choices" : ""}`}
      onClick={handleScreenClick}
      role="main"
      aria-label="游戏画面"
    >
      {/* ── Layer 0: Background ── */}
      <Background src={backgroundSrc} filter={bgFilter} />

      {/* ── Layer 1: Sprites ── */}
      <SpriteLayer sprites={sprites} />

      {/* ── Layer 10: Dialogue ── */}
      {dialogue && !choices && (
        <DialogueBox
          dialogue={dialogue}
          waitingForInput={waitingForInput}
          autoAdvanceDelay={autoAdvanceDelay}
          onAdvance={click}
        />
      )}

      {/* ── Layer 20: Choice Menu ── */}
      {choices && <ChoiceMenu choices={choices} onChoose={choose} />}

      {/* ── Layer 30: Toolbar HUD ── */}
      {!anyModalOpen && <Toolbar />}
    </div>
  );
};
