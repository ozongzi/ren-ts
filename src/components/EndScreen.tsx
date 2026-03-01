import React, { useEffect, useState } from "react";
import { useGameStore } from "../store";

/**
 * EndScreen — shown when phase === "game_end".
 *
 * Rendered as a full-screen overlay on top of the frozen game background so
 * the last scene still shows through. A single click anywhere (or pressing
 * Space / Enter) returns the player to the title screen.
 */
export const EndScreen: React.FC = () => {
  const goToTitle = useGameStore((s) => s.goToTitle);

  // Trigger fade-in once the component mounts.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Keyboard handler
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        goToTitle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goToTitle]);

  return (
    <div
      className={`end-screen${visible ? " end-screen--visible" : ""}`}
      onClick={goToTitle}
      role="button"
      tabIndex={0}
      aria-label="故事已结束，点击回到标题页"
    >
      {/* Radial glow behind the text */}
      <div className="end-screen__glow" aria-hidden="true" />

      {/* Main "完" marker */}
      <p className="end-screen__fin" aria-hidden="true">── 完 ──</p>

      {/* Prompt */}
      <p className="end-screen__hint">点击任意处回到标题页</p>
    </div>
  );
};
