import React, { useEffect, useState, useCallback } from "react";
import { useGameStore } from "./store";
import { IconButton } from "./components/IconButton";
import { supportsConversionTools } from "./tauri_bridge";
import { TitleScreen } from "./components/TitleScreen";
import { GameScreen } from "./components/GameScreen";
import { CGGallery } from "./components/CGGallery";
import { Settings } from "./components/Settings";
import { Tools } from "./components/Tools";
import { SaveLoadedScreen } from "./components/SaveLoadedScreen";
import { EndScreen } from "./components/EndScreen";
import { AssetsDirScreen } from "./components/AssetsDirScreen";
import { SaveSelector } from "./components/SaveSelector";

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
const LOGICAL_W = 1280;
const LOGICAL_H = 720;

export const App: React.FC = () => {
  const init = useGameStore((s) => s.init);
  const phase = useGameStore((s) => s.phase);
  const showGallery = useGameStore((s) => s.showGallery);
  const showSettings = useGameStore((s) => s.showSettings);
  const showTools = useGameStore((s) => s.showTools);
  const saveError = useGameStore((s) => s.saveError);
  const clearSaveError = useGameStore((s) => s.clearSaveError);
  // Show the zip picker when no filesystem is mounted yet (Tauri) or when
  // the manifest failed to load.  In web mode init() auto-mounts WebFetchFS
  // so manifestLoaded flips to true without user interaction.
  const manifestLoaded = useGameStore((s) => s.manifestLoaded);

  // ── Responsive scale: fit 1280×720 into the browser window ───────────────
  const calcLayout = useCallback(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const s = Math.min(vw / LOGICAL_W, vh / LOGICAL_H);
    return {
      scale: s,
      offsetX: Math.round((vw - LOGICAL_W * s) / 2),
      offsetY: Math.round((vh - LOGICAL_H * s) / 2),
    };
  }, []);

  const [layout, setLayout] = useState(calcLayout);

  useEffect(() => {
    const onResize = () => setLayout(calcLayout());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [calcLayout]);

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
    // Viewport: fills the whole browser window, shows letterbox/pillarbox
    <div className="game-viewport">
      {/* AssetsDirScreen lives outside the scaled canvas — it covers the
          full viewport before any game canvas exists, so it must not be
          affected by the transform/scale applied to the game canvas. */}
      {!manifestLoaded && <AssetsDirScreen />}

      {/* Canvas: fixed 1280×720 logical resolution, scaled uniformly.
          Only rendered once the manifest is loaded so it never competes
          with the full-viewport AssetsDirScreen above. */}
      {manifestLoaded && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: LOGICAL_W,
            height: LOGICAL_H,
            transform: `translate(${layout.offsetX}px, ${layout.offsetY}px) scale(${layout.scale})`,
            transformOrigin: "top left",
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

          {/* ── 常驻左上角设置与工具按钮 ── */}
          <div className="app-icon-btns">
            <IconButton
              icon="⚙️"
              label="打开设置"
              disabled={showSettings || showTools}
              onClick={() => useGameStore.getState().openSettings()}
            />
            <IconButton
              icon="🛠️"
              label="打开工具"
              title={
                supportsConversionTools
                  ? "打开 Ren'Py → RRS 转换工具"
                  : "转换工具仅支持 Tauri 桌面端（macOS / Windows / Linux）以及 Chrome / Edge 浏览器"
              }
              disabled={showSettings || showTools}
              onClick={() => useGameStore.getState().openTools()}
            />
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
      )}
    </div>
  );
};
