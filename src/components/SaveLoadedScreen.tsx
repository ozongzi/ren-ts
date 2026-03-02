import React from "react";
import { useGameStore } from "../store";
import { formatLabel } from "../save";

/**
 * "Lobby" screen shown when phase === 'save_loaded'.
 *
 * The player arrives here after either:
 *   - creating a new game (via TitleScreen → 新游戏), or
 *   - loading a save file from disk (via TitleScreen → 继续游戏).
 *
 * From here they can:
 *   - 进入游戏        → actually start / resume gameplay
 *   - CG 图鉴         → open gallery overlay
 *   - 设置            → open settings overlay
 *   - 重新选择存档    → discard loaded state and return to title screen
 */
export const SaveLoadedScreen: React.FC = () => {
  const enterGame = useGameStore((s) => s.enterGame);
  const openGallery = useGameStore((s) => s.openGallery);
  const goToTitle = useGameStore((s) => s.goToTitle);
  const gameTitle = useGameStore((s) => s.gameTitle);
  const displayTitle = gameTitle ?? "Ren'Ts";

  // Read the snapshot info for the "save info" badge
  const currentLabel = useGameStore((s) => s.currentLabel);
  const dialogue = useGameStore((s) => s.dialogue);
  const saveId = useGameStore((s) => s.saveId);
  const saveFileName = useGameStore((s) => s.saveFileName);

  // Build a short human-readable description of where we are in the story.
  const locationLabel = formatLabel(currentLabel);
  const snippetText = dialogue?.text
    ? dialogue.text.slice(0, 60) + (dialogue.text.length > 60 ? "…" : "")
    : null;

  // Auto-save is active whenever we have a persisted save entry.
  const autoSaveActive = saveId !== null && saveFileName !== null;

  return (
    <div className="title-screen">
      {/* ── Gradient overlay ── */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 0,
          background:
            "radial-gradient(ellipse at 20% 80%, rgba(37,99,235,0.08) 0%, transparent 60%)," +
            "radial-gradient(ellipse at 80% 20%, rgba(214,58,90,0.07) 0%, transparent 60%)",
          pointerEvents: "none",
        }}
      />

      {/* ── Content ── */}
      <div className="title-content" style={{ gap: "1.5rem" }}>
        {/* Title */}
        <h1 className="title-fallback-text">{displayTitle}</h1>

        {/* ── Save info badge ── */}
        <div
          style={{
            background: "rgba(255,255,255,0.82)",
            border: "1px solid rgba(0,0,0,0.1)",
            borderRadius: "8px",
            padding: "0.5rem 1.2rem",
            textAlign: "center",
            backdropFilter: "blur(6px)",
            WebkitBackdropFilter: "blur(6px)",
            maxWidth: "340px",
            width: "100%",
            flexShrink: 0,
          }}
        >
          <p
            style={{
              fontSize: "0.78rem",
              color: "rgba(26,26,46,0.45)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              marginBottom: "0.25rem",
            }}
          >
            存档已就绪
          </p>

          {/* Auto-save badge */}
          {autoSaveActive ? (
            <p
              style={{
                fontSize: "0.75rem",
                color: "rgba(22,163,74,0.9)",
                marginBottom: "0.4rem",
              }}
            >
              💾 自动保存 · {saveFileName}
            </p>
          ) : (
            <p
              style={{
                fontSize: "0.75rem",
                color: "rgba(180,100,0,0.75)",
                marginBottom: "0.4rem",
              }}
            >
              ⚠️ 无自动保存
            </p>
          )}

          <p
            style={{
              fontSize: "0.95rem",
              color: "#b03060",
              fontWeight: 600,
              marginBottom: snippetText ? "0.3rem" : 0,
            }}
          >
            📍 {locationLabel}
          </p>
          {snippetText && (
            <p
              style={{
                fontSize: "0.78rem",
                color: "rgba(26,26,46,0.45)",
                fontStyle: "italic",
                lineHeight: 1.4,
              }}
            >
              "{snippetText}"
            </p>
          )}
        </div>

        {/* ── Menu ── */}
        <nav
          className="title-menu"
          aria-label="存档菜单"
          style={{ gap: "0.6rem", flexShrink: 0 }}
        >
          {/* Primary CTA */}
          <button
            className="title-btn"
            onClick={enterGame}
            style={{
              borderColor: "rgba(214,58,90,0.45)",
              background: "rgba(214,58,90,0.1)",
              fontSize: "1.1rem",
              fontWeight: 700,
              letterSpacing: "0.1em",
            }}
            aria-label="进入游戏"
          >
            ▶ 进入游戏
          </button>

          <button
            className="title-btn"
            onClick={openGallery}
            aria-label="CG 图鉴"
          >
            🖼️ CG 图鉴
          </button>

          <button
            className="title-btn"
            onClick={() => useGameStore.getState().openSettings()}
            aria-label="设置"
          >
            ⚙️ 设置
          </button>

          {/* Divider */}
          <div
            style={{
              borderTop: "1px solid rgba(0,0,0,0.08)",
              margin: "0.2rem 0",
            }}
          />

          <button
            className="title-btn"
            onClick={goToTitle}
            style={{
              fontSize: "0.9rem",
              color: "rgba(26,26,46,0.5)",
              borderColor: "rgba(0,0,0,0.1)",
            }}
            aria-label="重新选择存档，返回标题界面"
          >
            ← 重新选择存档
          </button>
        </nav>

        <p
          style={{
            fontSize: "0.72rem",
            color: "rgba(26,26,46,0.25)",
            letterSpacing: "0.05em",
          }}
        >
          Web Engine — Tauri + React
        </p>
      </div>
    </div>
  );
};
