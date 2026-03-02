import React, { useRef, useState } from "react";
import { useGameStore } from "../store";
import {
  isTauri,
  pickZipFileTauri,
  readBinaryFileTauri,
  persistZipPath,
} from "../tauri_bridge";

/**
 * Settings modal panel.
 * Currently exposes volume controls for BGM, SFX, voice, and master.
 */
export const Settings: React.FC = () => {
  const closeSettings = useGameStore((s) => s.closeSettings);
  const volumeMaster = useGameStore((s) => s.volumeMaster);
  const volumeBGM = useGameStore((s) => s.volumeBGM);
  const volumeSFX = useGameStore((s) => s.volumeSFX);
  const volumeVoice = useGameStore((s) => s.volumeVoice);
  const setVolumeMaster = useGameStore((s) => s.setVolumeMaster);
  const setVolumeBGM = useGameStore((s) => s.setVolumeBGM);
  const setVolumeSFX = useGameStore((s) => s.setVolumeSFX);
  const setVolumeVoice = useGameStore((s) => s.setVolumeVoice);

  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) closeSettings();
  };

  const pct = (v: number) => `${Math.round(v * 100)}%`;

  return (
    <div
      className="modal-overlay"
      onClick={handleBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label="设置"
    >
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        {/* ── Header ── */}
        <div className="modal-header">
          <h2 className="modal-title">⚙️ 设置</h2>
          <button
            className="modal-close-btn"
            onClick={closeSettings}
            aria-label="关闭设置"
          >
            ✕
          </button>
        </div>

        {/* ── Volume controls ── */}
        <div className="settings-group">
          <div className="settings-label">音量</div>

          <VolumeRow
            label="总音量"
            value={volumeMaster}
            onChange={setVolumeMaster}
            display={pct(volumeMaster)}
          />
          <VolumeRow
            label="背景音乐"
            value={volumeBGM}
            onChange={setVolumeBGM}
            display={pct(volumeBGM)}
          />
          <VolumeRow
            label="音效"
            value={volumeSFX}
            onChange={setVolumeSFX}
            display={pct(volumeSFX)}
          />
          <VolumeRow
            label="语音"
            value={volumeVoice}
            onChange={setVolumeVoice}
            display={pct(volumeVoice)}
          />
        </div>

        <div className="divider" />

        {/* ── Zip file ── */}
        {isTauri && <ZipRow />}

        {isTauri && <div className="divider" />}

        {/* ── About ── */}
        <div className="settings-group">
          <div className="settings-label">关于</div>
          <p
            style={{
              fontSize: "0.85rem",
              color: "var(--color-text-dim)",
              lineHeight: 1.7,
            }}
          >
            Ren'Ts — 基于 Tauri + React 构建。
            <br />
            Github项目地址： https://github.com/ozongzi/ren-ts
            <br />
          </p>
        </div>

        {/* ── Keyboard shortcuts ── */}
        <div className="settings-group">
          <div className="settings-label">键盘快捷键</div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              gap: "0.4rem 1.2rem",
              fontSize: "0.85rem",
            }}
          >
            {[
              ["空格 / Enter", "推进对话"],
              ["方向键 ↑↓", "选择选项"],
              ["1 – 9", "直接选择选项编号"],
              ["Escape", "关闭弹窗 / 查看器"],
            ].map(([key, desc]) => (
              <React.Fragment key={key}>
                <kbd
                  style={{
                    background: "rgba(255,255,255,0.08)",
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: "4px",
                    padding: "0.15rem 0.5rem",
                    fontFamily: "monospace",
                    fontSize: "0.8rem",
                    color: "var(--color-text)",
                    whiteSpace: "nowrap",
                    alignSelf: "center",
                  }}
                >
                  {key}
                </kbd>
                <span
                  style={{
                    color: "var(--color-text-dim)",
                    alignSelf: "center",
                  }}
                >
                  {desc}
                </span>
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Zip row (Tauri only) ─────────────────────────────────────────────────────

const ZipRow: React.FC = () => {
  const zipFileName = useGameStore((s) => s.zipFileName);
  const mountZip = useGameStore((s) => s.mountZip);
  const unmountZip = useGameStore((s) => s.unmountZip);
  const inputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On Tauri: use the native dialog so the path is persisted for auto-restore.
  const handleTauriPick = async () => {
    setError(null);
    setLoading(true);
    try {
      const path = await pickZipFileTauri();
      if (!path) return;
      const bytes = await readBinaryFileTauri(path);
      if (!bytes) {
        setError("无法读取所选文件，请重试。");
        return;
      }
      const fileName = path.split(/[/\\]/).pop() ?? "assets.zip";
      const file = new File([bytes.buffer as ArrayBuffer], fileName, {
        type: "application/zip",
      });
      // Persist path BEFORE mounting so init() can restore it next launch.
      persistZipPath(path);
      await mountZip(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : "未知错误");
    } finally {
      setLoading(false);
    }
  };

  // Fallback for non-Tauri (should not normally be shown, but kept for safety).
  const handleFile = async (file: File | undefined | null) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setError("请选择 .zip 格式的文件");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await mountZip(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : "未知错误");
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFile(e.target.files?.[0]);
    e.target.value = "";
  };

  const handlePick = () => {
    if (loading) return;
    if (isTauri) {
      handleTauriPick();
    } else {
      inputRef.current?.click();
    }
  };

  return (
    <div className="settings-group">
      <div className="settings-label">游戏包 (.zip)</div>

      {/* Hidden file input */}
      <input
        ref={inputRef}
        type="file"
        accept=".zip"
        style={{ display: "none" }}
        onChange={handleInputChange}
      />

      {/* Current zip display */}
      <p
        style={{
          fontSize: "0.78rem",
          color: "var(--color-text-dim)",
          fontFamily: "monospace",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: "5px",
          padding: "0.45rem 0.75rem",
          wordBreak: "break-all",
          margin: "0 0 0.6rem",
          lineHeight: 1.5,
        }}
      >
        {zipFileName ?? (
          <span
            style={{ color: "rgba(255,160,80,0.8)", fontFamily: "inherit" }}
          >
            ⚠️ 尚未选择
          </span>
        )}
      </p>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button
          onClick={handlePick}
          disabled={loading}
          style={{
            padding: "0.4rem 1rem",
            fontSize: "0.85rem",
            fontWeight: 600,
            background: loading
              ? "rgba(255,255,255,0.05)"
              : "rgba(255,255,255,0.08)",
            color: loading ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.8)",
            border: "1px solid rgba(255,255,255,0.14)",
            borderRadius: "6px",
            cursor: loading ? "default" : "pointer",
            transition: "background 0.15s",
          }}
          aria-label="重新选择 zip 文件"
        >
          {loading ? "加载中…" : "📦 更换 zip"}
        </button>
        {zipFileName && (
          <button
            onClick={unmountZip}
            disabled={loading}
            style={{
              padding: "0.4rem 1rem",
              fontSize: "0.85rem",
              fontWeight: 600,
              background: "rgba(200,40,40,0.12)",
              color: "rgba(255,140,130,0.85)",
              border: "1px solid rgba(255,80,80,0.2)",
              borderRadius: "6px",
              cursor: loading ? "default" : "pointer",
              transition: "background 0.15s",
            }}
            aria-label="卸载当前 zip"
          >
            卸载
          </button>
        )}
      </div>

      <p
        style={{
          fontSize: "0.72rem",
          color: "rgba(255,255,255,0.2)",
          marginTop: "0.4rem",
          lineHeight: 1.5,
        }}
      >
        更换后路径将自动保存，下次启动直接加载。
      </p>

      {error && (
        <p
          role="alert"
          style={{
            marginTop: "0.4rem",
            fontSize: "0.8rem",
            color: "rgba(255,120,120,0.9)",
          }}
        >
          ⚠️ {error}
        </p>
      )}
    </div>
  );
};

// ─── Volume row ───────────────────────────────────────────────────────────────

interface VolumeRowProps {
  label: string;
  value: number;
  display: string;
  onChange: (v: number) => void;
}

const VolumeRow: React.FC<VolumeRowProps> = ({
  label,
  value,
  display,
  onChange,
}) => (
  <div className="volume-row">
    <span className="volume-name">{label}</span>
    <input
      type="range"
      className="volume-slider"
      min={0}
      max={1}
      step={0.01}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      aria-label={`${label}音量`}
      aria-valuetext={display}
    />
    <span className="volume-value">{display}</span>
  </div>
);
