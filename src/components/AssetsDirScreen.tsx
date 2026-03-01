import React, { useRef, useState } from "react";
import { useGameStore } from "../store";

/**
 * Shown on first launch (Tauri) or whenever the zip fails to load.
 *
 * The user selects a single assets.zip file via a native file picker.
 * This works on all platforms:
 *   - macOS / Windows / Linux (Tauri)
 *   - iOS Safari (File picker supports single-file selection)
 *   - Android (same)
 *   - Web / Chrome / Firefox / Safari
 *
 * Expected zip layout:
 *   assets.zip
 *     data/            ← manifest.json + .rrs script files
 *     images/          ← BGs, CGs, Sprites, UI, FX, …
 *     Audio/           ← Audio/BGM, Audio/SFX, Audio/Voice
 *     videos/          ← *.webm animated CGs (optional)
 */
export const AssetsDirScreen: React.FC = () => {
  const mountZip = useGameStore((s) => s.mountZip);
  const storeLoading = useGameStore((s) => s.loading);
  const storeError = useGameStore((s) => s.error);

  const inputRef = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const isLoading = storeLoading || picking;

  // ── File handling ─────────────────────────────────────────────────────────

  const handleFile = async (file: File | undefined | null) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      // surface a friendly error without going through the store
      alert("请选择 .zip 格式的文件");
      return;
    }
    setPicking(true);
    try {
      await mountZip(file);
    } finally {
      setPicking(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFile(e.target.files?.[0]);
    // Reset so re-selecting the same file still fires onChange
    e.target.value = "";
  };

  const handleButtonClick = () => {
    if (isLoading) return;
    inputRef.current?.click();
  };

  // ── Drag-and-drop ─────────────────────────────────────────────────────────

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (isLoading) return;
    const file = e.dataTransfer.files?.[0];
    handleFile(file);
  };

  // ── Styles ────────────────────────────────────────────────────────────────

  const dropZoneBorder = dragOver
    ? "2px dashed rgba(233,69,96,0.9)"
    : "2px dashed rgba(255,255,255,0.15)";

  const dropZoneBg = dragOver
    ? "rgba(233,69,96,0.08)"
    : "rgba(255,255,255,0.03)";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #0a0a1a 0%, #1a0a0a 100%)",
        color: "#fff",
        fontFamily: "system-ui, sans-serif",
        padding: "2rem",
        gap: "1.5rem",
        overflowY: "auto",
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* ── Hidden file input ── */}
      <input
        ref={inputRef}
        type="file"
        accept=".zip"
        style={{ display: "none" }}
        onChange={handleInputChange}
      />

      {/* ── Icon ── */}
      <div style={{ fontSize: "4rem", lineHeight: 1 }}>📦</div>

      {/* ── Title ── */}
      <h1
        style={{
          fontSize: "1.6rem",
          fontWeight: 700,
          letterSpacing: "0.06em",
          margin: 0,
          textAlign: "center",
          color: "rgba(255,230,128,0.95)",
        }}
      >
        载入游戏包
      </h1>

      {/* ── Load error banner ── */}
      {storeError && (
        <div
          role="alert"
          style={{
            background: "rgba(200,40,40,0.12)",
            border: "1px solid rgba(255,80,80,0.35)",
            borderRadius: "10px",
            padding: "1rem 1.4rem",
            maxWidth: "500px",
            width: "100%",
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              fontSize: "0.95rem",
              fontWeight: 700,
              color: "rgba(255,150,130,0.95)",
            }}
          >
            ⚠️ 加载失败
          </div>
          <p
            style={{
              margin: 0,
              fontSize: "0.85rem",
              color: "rgba(255,160,140,0.85)",
              lineHeight: 1.6,
              wordBreak: "break-word",
            }}
          >
            {storeError}
          </p>
          <p
            style={{
              margin: "0.25rem 0 0",
              fontSize: "0.78rem",
              color: "rgba(255,255,255,0.35)",
              lineHeight: 1.5,
            }}
          >
            请确认 zip 根目录下包含{" "}
            <code
              style={{
                background: "rgba(255,255,255,0.08)",
                borderRadius: "3px",
                padding: "0 4px",
                fontFamily: "monospace",
                color: "rgba(180,220,255,0.7)",
              }}
            >
              data/manifest.json
            </code>{" "}
            以及对应的{" "}
            <code
              style={{
                background: "rgba(255,255,255,0.08)",
                borderRadius: "3px",
                padding: "0 4px",
                fontFamily: "monospace",
                color: "rgba(180,220,255,0.7)",
              }}
            >
              .rrs
            </code>{" "}
            脚本文件。
          </p>
        </div>
      )}

      {/* ── Drag-and-drop zone / explanation ── */}
      <div
        style={{
          background: dropZoneBg,
          border: dropZoneBorder,
          borderRadius: "12px",
          padding: "1.6rem 2rem",
          maxWidth: "480px",
          width: "100%",
          lineHeight: 1.7,
          textAlign: "center",
          transition: "background 0.15s, border-color 0.15s",
          cursor: isLoading ? "default" : "pointer",
        }}
        onClick={handleButtonClick}
        role="button"
        aria-label="点击或拖拽 zip 文件到此处"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") handleButtonClick();
        }}
      >
        {isLoading ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "0.75rem",
              color: "rgba(255,230,128,0.75)",
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: "2rem",
                height: "2rem",
                border: "3px solid rgba(255,230,128,0.2)",
                borderTopColor: "rgba(255,230,128,0.85)",
                borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
              }}
            />
            <span style={{ fontSize: "0.95rem" }}>
              {picking ? "正在解析 ZIP 索引…" : "正在加载剧本数据…"}
            </span>
          </div>
        ) : (
          <>
            <div style={{ fontSize: "2.5rem", marginBottom: "0.6rem" }}>
              {dragOver ? "🎯" : "📂"}
            </div>
            <p
              style={{
                margin: "0 0 0.5rem",
                fontSize: "1rem",
                fontWeight: 600,
                color: "rgba(255,255,255,0.85)",
              }}
            >
              {dragOver ? "松开以载入" : "点击选择 或 拖拽文件到这里"}
            </p>
            <p
              style={{
                margin: 0,
                fontSize: "0.82rem",
                color: "rgba(255,255,255,0.35)",
              }}
            >
              接受 <code style={{ fontFamily: "monospace" }}>.zip</code> 格式
            </p>
          </>
        )}
      </div>

      {/* ── Zip structure hint ── */}
      {!isLoading && (
        <div
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: "10px",
            padding: "1rem 1.4rem",
            maxWidth: "480px",
            width: "100%",
          }}
        >
          <p
            style={{
              margin: "0 0 0.6rem",
              fontSize: "0.82rem",
              fontWeight: 600,
              color: "rgba(255,255,255,0.45)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            zip 内部结构
          </p>
          <ul
            style={{
              margin: 0,
              paddingLeft: "1.2rem",
              fontSize: "0.82rem",
              color: "rgba(255,255,255,0.38)",
              lineHeight: 2,
            }}
          >
            {[
              ["data/", "manifest.json 和 .rrs 脚本"],
              ["images/", "BG、CG、立绘、UI 等图片"],
              ["Audio/", "BGM、SFX、配音"],
              ["videos/", "（可选）.webm 动态 CG"],
            ].map(([dir, desc]) => (
              <li key={dir}>
                <code
                  style={{
                    background: "rgba(255,255,255,0.08)",
                    borderRadius: "3px",
                    padding: "0 4px",
                    fontFamily: "monospace",
                    color: "rgba(180,220,255,0.75)",
                    marginRight: "0.5em",
                  }}
                >
                  {dir}
                </code>
                {desc}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Footer ── */}
      {!isLoading && (
        <p
          style={{
            fontSize: "0.7rem",
            color: "rgba(255,255,255,0.18)",
            letterSpacing: "0.04em",
            textAlign: "center",
            maxWidth: "360px",
            margin: 0,
          }}
        >
          zip 文件只在本设备本地读取，不会上传到任何服务器。
        </p>
      )}

      {/* ── Spinner keyframes ── */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
};
