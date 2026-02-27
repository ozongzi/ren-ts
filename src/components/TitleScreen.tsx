import React, { useState } from "react";
import { useGameStore } from "../store";
import { fsaAvailable } from "../save";
import { isTauri } from "../tauri_bridge";

/**
 * Title screen shown when phase === 'title'.
 *
 * Only two entry points:
 *   - 新游戏       start a fresh game, land on SaveLoadedScreen
 *   - 继续游戏     open file picker to load a .json save, land on SaveLoadedScreen
 */
export const TitleScreen: React.FC = () => {
  const newGame = useGameStore((s) => s.newGame);
  const saveImport = useGameStore((s) => s.saveImport);
  const loading = useGameStore((s) => s.loading);
  const error = useGameStore((s) => s.error);
  const manifestLoaded = useGameStore((s) => s.manifestLoaded);

  const gameTitle = useGameStore((s) => s.gameTitle);
  const displayTitle = gameTitle ?? "Ren'Ts";
  const [importing, setImporting] = useState(false);
  const [newGamePending, setNewGamePending] = useState(false);

  const handleNewGame = async () => {
    if (!manifestLoaded || newGamePending) return;
    setNewGamePending(true);
    try {
      await newGame();
    } catch {
      // errors surface via saveError toast in App
    } finally {
      setNewGamePending(false);
    }
  };

  const handleContinue = async () => {
    if (!manifestLoaded || importing) return;
    setImporting(true);
    try {
      await saveImport();
    } catch {
      // errors surface via saveError toast in App
    } finally {
      setImporting(false);
    }
  };

  // ── Loading state ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="title-screen">
        <div
          className="loading-screen"
          style={{ position: "relative", background: "transparent" }}
        >
          <div className="loading-spinner" />
          <p className="loading-text">正在加载剧本数据…</p>
        </div>
      </div>
    );
  }

  // ── Error state ───────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="title-screen">
        <div
          className="error-screen"
          style={{ position: "relative", background: "transparent" }}
        >
          <div style={{ fontSize: "2.5rem", marginBottom: "0.5rem" }}>⚠️</div>
          <p className="error-title">加载失败</p>
          <p className="error-message">{error}</p>
          <p
            className="error-message"
            style={{ marginTop: "0.5rem", fontSize: "0.8rem", opacity: 0.6 }}
          >
            请确保已启动 Vite 开发服务器（<code>npm run dev</code> 或{" "}
            <code>deno task dev</code>）， 且 data/ 目录中存在 manifest.json。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="title-screen">
      {/* Gradient overlay */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 0,
          background:
            "radial-gradient(ellipse at 20% 80%, rgba(233,69,96,0.08) 0%, transparent 60%)," +
            "radial-gradient(ellipse at 80% 20%, rgba(15,52,96,0.15) 0%, transparent 60%)",
          pointerEvents: "none",
        }}
      />

      {/* Content */}
      <div className="title-content">
        {/* Title */}
        <h1 className="title-fallback-text">{displayTitle}</h1>

        {/* Main menu */}
        <nav className="title-menu" aria-label="主菜单">
          <button
            className="title-btn"
            onClick={handleNewGame}
            disabled={!manifestLoaded || newGamePending || importing}
            aria-label="开始新游戏"
          >
            {newGamePending ? "选择保存位置…" : "▶ 新游戏"}
          </button>

          <button
            className="title-btn"
            onClick={handleContinue}
            disabled={!manifestLoaded || importing || newGamePending}
            aria-label="从文件读取存档以继续游戏"
            style={{ borderColor: "rgba(255,230,128,0.4)", color: "#ffe680" }}
          >
            {importing ? "读取中…" : "📂 继续游戏"}
          </button>
        </nav>

        {/* Auto-save capability hint */}
        <p
          style={{
            fontSize: "0.72rem",
            color: "rgba(255,255,255,0.25)",
            letterSpacing: "0.04em",
            marginTop: "-1rem",
            textAlign: "center",
            maxWidth: "280px",
          }}
        >
          {isTauri
            ? "💾 桌面版 · 支持自动保存到本地文件"
            : fsaAvailable
              ? "💾 支持自动保存到本地文件"
              : "⚠️ 当前浏览器不支持自动保存（请使用 Chrome / Edge）"}
        </p>

        {/* Version note */}
        {manifestLoaded && (
          <p
            style={{
              fontSize: "0.72rem",
              color: "rgba(255,255,255,0.2)",
              letterSpacing: "0.05em",
              marginTop: "0.5rem",
            }}
          >
            Web Engine — Deno + React
          </p>
        )}
      </div>
    </div>
  );
};
