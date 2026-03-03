import React, { useEffect } from "react";
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
import { ZipRpyMigrateTool } from "../rpy-migrate-tool/zipRpyMigrateTool";

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
  // Show the zip picker when no filesystem is mounted yet (Tauri) or when
  // the manifest failed to load.  In web mode init() auto-mounts WebFetchFS
  // so manifestLoaded flips to true without user interaction.
  const manifestLoaded = useGameStore((s) => s.manifestLoaded);

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

  const showZipMigrate = useGameStore((s) => s.showZipMigrate);

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        background: "var(--color-bg)",
      }}
    >
      {/* Block all game UI until a zip is mounted and scripts are loaded. */}
      {!manifestLoaded ? (
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
        <IconButton
          icon="📦"
          label="ZIP 打包工具"
          title="从游戏 ZIP 提取资源并生成 assets.zip"
          disabled={showSettings || showTools || showZipMigrate}
          onClick={() => useGameStore.getState().openZipMigrate()}
        />
      </div>

      {/* ── Global modals (can appear over title/lobby screens too) ── */}
      {showGallery && <CGGallery />}
      {showSettings && <Settings />}
      {showTools && <Tools />}
      {showZipMigrate && (
        <ZipRpyMigrateTool
          onClose={() => useGameStore.getState().closeZipMigrate()}
        />
      )}

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
