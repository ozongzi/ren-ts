import React, { useEffect } from "react";
import { useGameStore } from "./store";
import { TitleScreen } from "./components/TitleScreen";
import { GameScreen } from "./components/GameScreen";
import { CGGallery } from "./components/CGGallery";
import { Settings } from "./components/Settings";
import { SaveLoadedScreen } from "./components/SaveLoadedScreen";
import { EndScreen } from "./components/EndScreen";
import { AssetsDirScreen } from "./components/AssetsDirScreen";
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

  // In Tauri mode, block all game UI until the user has chosen an assets folder.
  if (isTauri && !assetsDir) {
    return <AssetsDirScreen />;
  }

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
      {/* ── Title screen ── */}
      {phase === "title" && <TitleScreen />}

      {/* ── Save-loaded lobby (after new game or file load, before play) ── */}
      {phase === "save_loaded" && <SaveLoadedScreen />}

      {/* ── Game screen ── */}
      {(phase === "playing" || phase === "game_end") && <GameScreen />}

      {/* ── End screen overlay (shown on top of the frozen game background) ── */}
      {phase === "game_end" && <EndScreen />}

      {/* ── Global modals (can appear over title/lobby screens too) ── */}
      {showGallery && <CGGallery />}
      {showSettings && <Settings />}

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
