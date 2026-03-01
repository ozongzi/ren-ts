import React, { useEffect } from "react";
import { useGameStore } from "./store";
import { TitleScreen } from "./components/TitleScreen";
import { GameScreen } from "./components/GameScreen";
import { CGGallery } from "./components/CGGallery";
import { Settings } from "./components/Settings";
import { Tools } from "./components/Tools";
import { SaveLoadedScreen } from "./components/SaveLoadedScreen";
import { EndScreen } from "./components/EndScreen";
import { AssetsDirScreen } from "./components/AssetsDirScreen";
import { SaveSelector } from "./components/SaveSelector";
import { isTauri } from "./tauri_bridge";

/**
 * Root application component.
 *
 * Responsibilities:
 *  1. Bootstrap: call store.init() on mount to load the manifest + all JSON
 *     script files.
 *  2. Route between the title screen and the game screen based on `phase`.
 *  3. Render global modal overlays that can appear over the title screen
 *     (gallery, settings).
 */
export const App: React.FC = () => {
  const init = useGameStore((s) => s.init);
  const phase = useGameStore((s) => s.phase);
  const showGallery = useGameStore((s) => s.showGallery);
  const showSettings = useGameStore((s) => s.showSettings);
  const showTools = useGameStore((s) => s.showTools);
  const saveError = useGameStore((s) => s.saveError);
  const clearSaveError = useGameStore((s) => s.clearSaveError);
  // Tauri: assetsDir is null until the user picks a folder on first launch.
  const assetsDir = useGameStore((s) => s.assetsDir);

  // Load all script data once on mount
  useEffect(() => {
    init();
  }, [init]);

  // Auto-dismiss save errors after 5 seconds
  useEffect(() => {
    if (!saveError) return;
    const timer = setTimeout(clearSaveError, 5000);
    return () => clearTimeout(timer);
  }, [saveError, clearSaveError]);

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        background: "#000",
      }}
    >
      {/* In Tauri mode, block all game UI until the user has chosen an assets folder. */}
      {isTauri && !assetsDir ? (
        <AssetsDirScreen />
      ) : (
        <>
          {/* ── Title screen ── */}
          {phase === "title" && <TitleScreen />}

          {/* ── Save-loaded lobby (after new game or file load, before play) ── */}
          {phase === "save_loaded" && <SaveLoadedScreen />}

          {/* ── Game screen ── */}
          {(phase === "playing" || phase === "game_end") && <GameScreen />}

          {/* ── End screen overlay (shown on top of the frozen game background) ── */}
          {phase === "game_end" && <EndScreen />}
        </>
      )}

      {/* ── 常驻左上角设置与工具按钮 ── */}
      <div
        style={{
          position: "fixed",
          top: "1.5rem",
          left: "2rem",
          zIndex: 1000,
          display: "flex",
          gap: "1rem",
        }}
      >
        <button
          style={{
            background:
              showSettings || showTools
                ? "rgba(255,255,255,0.04)"
                : "rgba(255,255,255,0.08)",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: "8px",
            width: "48px",
            height: "48px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "1.6rem",
            color:
              showSettings || showTools
                ? "rgba(255,255,255,0.4)"
                : "var(--color-text)",
            cursor: showSettings || showTools ? "not-allowed" : "pointer",
            boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
            transition: "background 0.15s",
            opacity: showSettings || showTools ? 0.6 : 1,
          }}
          aria-label="打开设置"
          disabled={showSettings || showTools}
          onClick={() => {
            if (!(showSettings || showTools)) {
              useGameStore.getState().openSettings();
            }
          }}
        >
          <span role="img" aria-label="设置">
            ⚙️
          </span>
        </button>
        <button
          style={{
            background:
              showSettings || showTools
                ? "rgba(255,255,255,0.04)"
                : "rgba(255,255,255,0.08)",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: "8px",
            width: "48px",
            height: "48px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "1.6rem",
            color:
              showSettings || showTools
                ? "rgba(255,255,255,0.4)"
                : "var(--color-text)",
            cursor: showSettings || showTools ? "not-allowed" : "pointer",
            boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
            transition: "background 0.15s",
            opacity: showSettings || showTools ? 0.6 : 1,
          }}
          aria-label="打开工具"
          disabled={showSettings || showTools}
          onClick={() => {
            if (!(showSettings || showTools)) {
              useGameStore.getState().openTools();
            }
          }}
        >
          <span role="img" aria-label="工具">
            🛠️
          </span>
        </button>
      </div>

      {/* ── Global modals (can appear over title/lobby screens too) ── */}
      {showGallery && <CGGallery />}
      {showSettings && <Settings />}
      {showTools && <Tools />}
      <SaveSelector />

      {/* ── Global error toast ── */}
      {saveError && (
        <div
          className="toast"
          onClick={clearSaveError}
          role="alert"
          aria-live="assertive"
        >
          ⚠️ {saveError}
          <span
            style={{
              marginLeft: "0.75rem",
              opacity: 0.5,
              fontSize: "0.8rem",
              cursor: "pointer",
            }}
          >
            ✕
          </span>
        </div>
      )}
    </div>
  );
};
