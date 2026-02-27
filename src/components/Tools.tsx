import React from "react";

/**
 * Tools modal panel.
 * Currently empty, reserved for future tool features.
 */
import { useGameStore } from "../store";

export const Tools: React.FC = () => {
  const closeTools = useGameStore((s) => s.closeTools);

  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) closeTools();
  };

  return (
    <div
      className="modal-overlay"
      onClick={handleBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label="工具"
    >
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        {/* ── Header ── */}
        <div className="modal-header">
          <h2 className="modal-title">🛠️ 工具</h2>
          <button
            className="modal-close-btn"
            onClick={closeTools}
            aria-label="关闭工具"
          >
            ✕
          </button>
        </div>
        {/* ── 空白内容 ── */}
        <div
          style={{
            padding: "2rem",
            textAlign: "center",
            color: "var(--color-text-dim)",
          }}
        >
          工具面板，敬请期待...
        </div>
      </div>
    </div>
  );
};
