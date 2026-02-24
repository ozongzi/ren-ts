import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import { RenpyText } from "../textParser";
import { hasNoWait, stripRenpyTags } from "../textParser";
import type { DialogueState } from "../types";

// ─── Character colour map ─────────────────────────────────────────────────────
// Values are dark, semi-opaque colours so white text stays readable.
// The backdrop-filter blur on the box still applies on top of these.
//
// This map is intentionally empty — character colours should be loaded from
// the game's `define` declarations or an external config file.
// Falls back to FALLBACK_BG for all unknown speakers.
const CHARACTER_COLORS: Record<string, string> = {};

const FALLBACK_BG = "rgba(10, 10, 30, 0.88)";

/**
 * Given the `who` string (e.g. "Keitaro", "Keitaro & Hiro", "Keitaro and Hiro"),
 * return a CSS `background` value to apply to the dialogue box.
 */
function getDialogueBackground(who: string | null | undefined): string {
  if (!who) return FALLBACK_BG;

  // Split on " & " or " and " (case-insensitive)
  const parts = who
    .split(/\s*&\s*|\s+and\s+/i)
    .map((p) => p.trim().toLowerCase());

  if (parts.length === 1) {
    return CHARACTER_COLORS[parts[0]] ?? FALLBACK_BG;
  }

  // Two (or more) speakers — split the box left/right
  const left = CHARACTER_COLORS[parts[0]] ?? FALLBACK_BG;
  const right = CHARACTER_COLORS[parts[1]] ?? FALLBACK_BG;
  return `linear-gradient(to right, ${left} 50%, ${right} 50%)`;
}

interface DialogueBoxProps {
  dialogue: DialogueState;
  waitingForInput: boolean;
  autoAdvanceDelay: number | null;
  onAdvance: () => void;
}

const TYPEWRITER_SPEED_MS = 28; // ms per character

/**
 * Renders the dialogue box at the bottom of the screen.
 *
 * Features:
 * - Typewriter character-by-character reveal
 * - Click to skip typewriter (first click) or advance (second click)
 * - Auto-advance support via autoAdvanceDelay
 * - Speaker name plate with styling
 * - {nw} tag support (auto-advance on text complete)
 * - Narration mode (no speaker name)
 */
export const DialogueBox: React.FC<DialogueBoxProps> = ({
  dialogue,
  waitingForInput,
  autoAdvanceDelay,
  onAdvance,
}) => {
  const { who, text, voice: _voice } = dialogue;

  // ── Typewriter state ────────────────────────────────────────────────────────
  const [visibleLength, setVisibleLength] = useState(0);
  const [isTyping, setIsTyping] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoAdvanceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Plain text (tags stripped) for length measurement
  const plainText = stripRenpyTags(text);
  const totalLength = plainText.length;

  // Check for special tags
  const noWait = hasNoWait(text);

  // ── Start / restart typewriter when dialogue changes ────────────────────────
  //
  // useLayoutEffect fires synchronously after React's DOM mutations but BEFORE
  // the browser paints. This guarantees we reset visibleLength to 0 before the
  // user ever sees a frame — eliminating the "first frame shows full/partial
  // text then jumps back to 0" flicker that useEffect caused.
  useLayoutEffect(() => {
    // Clear any existing timers
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (autoAdvanceRef.current) {
      clearTimeout(autoAdvanceRef.current);
      autoAdvanceRef.current = null;
    }

    if (!text) {
      setVisibleLength(0);
      setIsTyping(false);
      return;
    }

    // Reset to 0 synchronously — React will re-render before painting, so the
    // old visibleLength applied to the new text string is never shown.
    setVisibleLength(0);
    setIsTyping(true);

    let current = 0;
    intervalRef.current = setInterval(() => {
      current++;
      setVisibleLength(current);

      if (current >= totalLength) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        setIsTyping(false);

        // Auto-advance if {nw} tag is present
        if (noWait) {
          autoAdvanceRef.current = setTimeout(() => {
            onAdvance();
          }, 120);
        }
      }
    }, TYPEWRITER_SPEED_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (autoAdvanceRef.current) {
        clearTimeout(autoAdvanceRef.current);
        autoAdvanceRef.current = null;
      }
    };
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-advance timer (for pause steps) ────────────────────────────────────
  useEffect(() => {
    if (autoAdvanceDelay == null || isTyping) return;

    const timer = setTimeout(() => {
      onAdvance();
    }, autoAdvanceDelay);

    return () => clearTimeout(timer);
  }, [autoAdvanceDelay, isTyping, onAdvance]);

  // ── Handle click ─────────────────────────────────────────────────────────────
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation(); // prevent click from bubbling to GameScreen

      if (isTyping) {
        // First click: skip typewriter, show full text immediately
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        setVisibleLength(totalLength);
        setIsTyping(false);

        // If {nw} tag, schedule auto-advance
        if (noWait) {
          autoAdvanceRef.current = setTimeout(() => {
            onAdvance();
          }, 120);
        }
        return;
      }

      // Second click (or single click when text is fully shown): advance
      if (waitingForInput) {
        onAdvance();
      }
    },
    [isTyping, waitingForInput, totalLength, noWait, onAdvance],
  );

  // ── Build the visible text slice ─────────────────────────────────────────────
  // We show the full original markup string but clip it by injecting a
  // custom renderer that only renders the first `visibleLength` plain-text
  // characters worth of content.
  const textToRender = isTyping ? sliceRenpyText(text, visibleLength) : text;

  const isNarration = !who;
  const dialogueBg = getDialogueBackground(who);

  return (
    <div
      className={`dialogue-box${isNarration ? " narration" : ""}`}
      onClick={handleClick}
      role="dialog"
      aria-live="polite"
      style={{ background: dialogueBg }}
    >
      {/* Speaker name */}
      {who && <div className="dialogue-speaker">{who}</div>}

      {/* Dialogue text with Ren'Py markup */}
      <div className="dialogue-text">
        <RenpyText text={textToRender} />
        {/* Blinking cursor while text is fully shown and waiting */}
        {!isTyping && waitingForInput && !noWait && (
          <span className="typewriter-cursor" aria-hidden="true" />
        )}
      </div>

      {/* Down-arrow advance indicator */}
      {!isTyping && waitingForInput && !noWait && (
        <div className="advance-indicator" aria-hidden="true" />
      )}
    </div>
  );
};

// ─── Typewriter text slicer ───────────────────────────────────────────────────
//
// Given a Ren'Py markup string and a maximum number of *visible* characters
// (i.e. characters outside of tags), return the shortest prefix of the
// original string that contains exactly `maxChars` visible characters.
//
// This is not a perfect solution for all edge cases (deeply nested tags,
// self-closing tags mid-word, etc.) but handles the common cases well.

function sliceRenpyText(markup: string, maxChars: number): string {
  if (maxChars <= 0) return "";

  let visible = 0;
  let i = 0;

  while (i < markup.length && visible < maxChars) {
    if (markup[i] === "{") {
      // Skip over the entire {tag} without counting it
      const close = markup.indexOf("}", i);
      if (close === -1) {
        // Malformed — treat rest as plain text
        visible++;
        i++;
      } else {
        i = close + 1;
      }
    } else {
      visible++;
      i++;
    }
  }

  return markup.slice(0, i);
}
