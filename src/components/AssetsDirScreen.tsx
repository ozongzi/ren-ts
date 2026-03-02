import React, { useEffect, useRef, useState } from "react";
import { useGameStore } from "../store";
import {
  isTauri,
  fsaSupported,
  pickZipFileTauri,
  pickZipFileWeb,
  openTauriFileShim,
  persistZipPath,
  getStoredZipPath,
} from "../tauri_bridge";

/**
 * Full-screen zip picker shown whenever no assets.zip is mounted.
 *
 * All platforms use the same UI. The difference is under the hood:
 *   - Tauri:  native file-open dialog → read bytes via plugin-fs →
 *             persist path to localStorage for auto-restore on next launch.
 *   - Web:    <input type="file"> → bytes come from the File object →
 *             assetsSlice.mountZip() copies them into OPFS automatically.
 */
export const AssetsDirScreen: React.FC = () => {
  const mountZip = useGameStore((s) => s.mountZip);
  const mountZipFromHandle = useGameStore((s) => s.mountZipFromHandle);
  const storeLoading = useGameStore((s) => s.loading);
  const storeError = useGameStore((s) => s.error);

  const inputRef = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Show the previously remembered path/name as a hint.
  const [rememberedPath, setRememberedPath] = useState<string | null>(null);
  useEffect(() => {
    if (isTauri) setRememberedPath(getStoredZipPath());
  }, []);

  const isLoading = storeLoading || picking;

  // ── File handling ─────────────────────────────────────────────────────────

  const handleFile = async (file: File | undefined | null) => {
    if (!file || isLoading) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
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

  // Web fallback: driven by <input type="file"> (Firefox/Safari)
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFile(e.target.files?.[0]);
    e.target.value = "";
  };

  // Tauri: native dialog, then read bytes and persist path
  const handleTauriPick = async () => {
    if (isLoading) return;
    setPicking(true);
    try {
      const path = await pickZipFileTauri();
      if (!path) return;
      // openTauriFileShim returns a File-API-compatible shim that reads byte
      // ranges on demand via plugin-fs seek+read — the full file is never
      // copied into JS heap, which is essential for archives > 4 GB.
      const shim = await openTauriFileShim(path);
      if (!shim) {
        alert("无法读取所选文件，请重试。");
        return;
      }
      // Persist the path BEFORE mounting so init() can restore it next launch.
      persistZipPath(path);
      setRememberedPath(path);
      await mountZip(shim as unknown as File);
    } finally {
      setPicking(false);
    }
  };

  // Web FSA: showOpenFilePicker → FileSystemFileHandle (Chrome/Edge)
  // No bytes are copied — the handle is persisted in IndexedDB.
  const handleFsaPick = async () => {
    if (isLoading) return;
    setPicking(true);
    try {
      const handle = await pickZipFileWeb();
      if (!handle) return;
      setRememberedPath(handle.name);
      await mountZipFromHandle(handle);
    } finally {
      setPicking(false);
    }
  };

  const handlePick = () => {
    if (isLoading) return;
    if (isTauri) {
      handleTauriPick();
    } else if (fsaSupported) {
      handleFsaPick();
    } else {
      inputRef.current?.click();
    }
  };

  // ── Drag-and-drop (non-FSA web only) ────────────────────────────────────────

  const handleDragOver = (e: React.DragEvent) => {
    if (isTauri || fsaSupported) return;
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
    if (isTauri || fsaSupported || isLoading) return;
    handleFile(e.dataTransfer.files?.[0]);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      className="modal-overlay"
      style={{
        position: "fixed",
        flexDirection: "column",
        gap: "1.25rem",
        padding: "2rem",
        overflowY: "auto",
        // Not a modal — covers the whole screen before any game UI exists.
        background: "var(--color-bg)",
        animation: "none",
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Hidden file input — only needed as fallback on Firefox/Safari */}
      {!isTauri && !fsaSupported && (
        <input
          ref={inputRef}
          type="file"
          accept=".zip"
          style={{ display: "none" }}
          onChange={handleInputChange}
        />
      )}

      {/* ── Icon + title ── */}
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: "3rem", marginBottom: "0.5rem" }}>📦</div>
        <h1 className="modal-title" style={{ fontSize: "1.4rem" }}>
          载入游戏包
        </h1>
      </div>

      {/* ── Error banner ── */}
      {storeError && (
        <div
          role="alert"
          style={{
            background: "rgba(180,30,30,0.15)",
            border: "1px solid rgba(220,60,60,0.35)",
            borderRadius: 10,
            padding: "0.9rem 1.2rem",
            maxWidth: 480,
            width: "100%",
          }}
        >
          <p
            style={{
              fontWeight: 700,
              color: "rgba(255,140,120,0.95)",
              marginBottom: "0.35rem",
              fontSize: "0.9rem",
            }}
          >
            ⚠️ 加载失败
          </p>
          <p
            style={{
              fontSize: "0.82rem",
              color: "rgba(255,160,140,0.8)",
              lineHeight: 1.6,
              wordBreak: "break-word",
            }}
          >
            {storeError}
          </p>
          <p
            style={{
              marginTop: "0.4rem",
              fontSize: "0.76rem",
              color: "var(--color-text-dim)",
              lineHeight: 1.5,
            }}
          >
            请确认 zip 根目录下包含{" "}
            <code style={{ fontFamily: "var(--font-mono)", opacity: 0.8 }}>
              data/manifest.json
            </code>{" "}
            及对应的{" "}
            <code style={{ fontFamily: "var(--font-mono)", opacity: 0.8 }}>
              .rrs
            </code>{" "}
            脚本文件。
          </p>
        </div>
      )}

      {/* ── Pick zone ── */}
      <div
        role="button"
        tabIndex={isLoading ? -1 : 0}
        aria-label={
          isTauri || fsaSupported
            ? "点击选择 assets.zip"
            : "点击或拖拽 zip 文件"
        }
        onClick={handlePick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") handlePick();
        }}
        style={{
          maxWidth: 460,
          width: "100%",
          border: dragOver
            ? "2px dashed var(--color-accent)"
            : "2px dashed rgba(255,255,255,0.15)",
          borderRadius: 12,
          background: dragOver
            ? "rgba(233,69,96,0.07)"
            : "rgba(255,255,255,0.03)",
          padding: "2rem 1.5rem",
          textAlign: "center",
          cursor: isLoading ? "default" : "pointer",
          transition: "border-color 0.15s, background 0.15s",
        }}
      >
        {isLoading ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "0.75rem",
            }}
          >
            <div
              className="loading-spinner"
              style={{ width: 36, height: 36 }}
            />
            <span
              style={{ fontSize: "0.9rem", color: "var(--color-text-dim)" }}
            >
              {picking ? "正在解析 ZIP 索引…" : "正在加载剧本数据…"}
            </span>
          </div>
        ) : (
          <>
            <div style={{ fontSize: "2.2rem", marginBottom: "0.5rem" }}>
              {dragOver ? "🎯" : "📂"}
            </div>
            <p
              style={{
                fontSize: "0.95rem",
                fontWeight: 600,
                color: "var(--color-text)",
                marginBottom: "0.3rem",
              }}
            >
              {dragOver
                ? "松开以载入"
                : isTauri || fsaSupported
                  ? "点击选择 assets.zip"
                  : "点击选择  或  拖拽文件到这里"}
            </p>
            <p style={{ fontSize: "0.8rem", color: "var(--color-text-dim)" }}>
              接受 <code style={{ fontFamily: "var(--font-mono)" }}>.zip</code>{" "}
              格式
            </p>
          </>
        )}
      </div>

      {/* ── Remembered path/name hint ── */}
      {rememberedPath && !isLoading && (
        <p
          style={{
            fontSize: "0.73rem",
            color: "rgba(255,255,255,0.25)",
            fontFamily: "var(--font-mono)",
            maxWidth: 460,
            wordBreak: "break-all",
            textAlign: "center",
            lineHeight: 1.6,
          }}
        >
          上次使用：{rememberedPath}
        </p>
      )}

      {/* ── Zip structure hint ── */}
      {!isLoading && (
        <div
          style={{
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: 10,
            padding: "0.9rem 1.2rem",
            maxWidth: 460,
            width: "100%",
          }}
        >
          <p className="settings-label" style={{ marginBottom: "0.5rem" }}>
            zip 内部结构
          </p>
          <ul
            style={{
              margin: 0,
              paddingLeft: "1.1rem",
              fontSize: "0.8rem",
              color: "var(--color-text-dim)",
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
                    fontFamily: "var(--font-mono)",
                    background: "rgba(255,255,255,0.07)",
                    borderRadius: 3,
                    padding: "0 4px",
                    color: "rgba(180,220,255,0.75)",
                    marginRight: "0.45em",
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

      {/* ── Footer note ── */}
      {!isLoading && (
        <p
          style={{
            fontSize: "0.68rem",
            color: "rgba(255,255,255,0.15)",
            textAlign: "center",
            maxWidth: 360,
            lineHeight: 1.6,
          }}
        >
          {isTauri
            ? "文件路径将保存在本地，下次启动自动加载。"
            : fsaSupported
              ? "文件句柄将保存在本地，下次启动只需点击确认授权即可自动加载。"
              : "zip 文件仅在本设备本地读取，当前浏览器不支持记住文件位置，每次需重新选择。"}
        </p>
      )}
    </div>
  );
};
