import React, { useEffect, useState } from "react";
import { useGameStore } from "../store";
import { isTauri } from "../tauri_bridge";
import { listTauriSaves, importTauriSave } from "../save";
import type { SaveData } from "../types";

export const SaveSelector: React.FC = () => {
  const show = useGameStore((s) => s.showSaveSelector);
  const close = useGameStore((s) => s.closeSaveSelector);
  const continueSave = useGameStore((s) => s.continueSave);

  const [saves, setSaves] = useState<
    { path: string; save: SaveData; fileName: string }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (show && isTauri) {
      loadSaves();
    }
  }, [show]);

  const loadSaves = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listTauriSaves();
      setSaves(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = (path: string, save: SaveData) => {
    close();
    continueSave({ save, handle: null, savePath: path });
  };

  const handleImport = async () => {
    try {
      const imported = await importTauriSave();
      if (imported) {
        close();
        continueSave(imported);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) close();
  };

  if (!show || !isTauri) return null;

  return (
    <div
      className="modal-overlay"
      onClick={handleBackdrop}
      role="dialog"
      aria-modal="true"
    >
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">继续游戏</h2>
          <button className="modal-close" onClick={close} aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="modal-content" style={{ maxHeight: "60vh", overflowY: "auto" }}>
          <button
            onClick={handleImport}
            style={{
              width: "100%",
              padding: "0.8rem",
              background: "rgba(255,255,255,0.1)",
              border: "1px dashed rgba(255,255,255,0.3)",
              borderRadius: "8px",
              color: "#fff",
              cursor: "pointer",
              marginBottom: "1rem",
              fontSize: "0.9rem",
              fontWeight: 600,
            }}
          >
            📂 导入外部存档 (.json)
          </button>

          {loading ? (
            <div style={{ textAlign: "center", padding: "2rem" }}>
              加载中...
            </div>
          ) : error ? (
            <div style={{ color: "red", textAlign: "center", padding: "1rem" }}>
              {error}
            </div>
          ) : saves.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: "2rem",
                color: "rgba(255,255,255,0.5)",
              }}
            >
              没有找到存档
            </div>
          ) : (
            <div
              style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
            >
              {saves.map((s, i) => (
                <button
                  key={s.path}
                  onClick={() => handleSelect(s.path, s.save)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    padding: "0.8rem 1rem",
                    background: "rgba(0,0,0,0.3)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: "6px",
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "background 0.2s",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "rgba(255,255,255,0.1)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "rgba(0,0,0,0.3)";
                  }}
                >
                  <div
                    style={{
                      fontSize: "1rem",
                      color: "#fff",
                      fontWeight: "bold",
                    }}
                  >
                    存档 {saves.length - i}
                  </div>
                  <div
                    style={{
                      fontSize: "0.8rem",
                      color: "rgba(255,255,255,0.6)",
                      marginTop: "0.2rem",
                    }}
                  >
                    {new Date(s.save.timestamp).toLocaleString()}
                  </div>
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "rgba(255,255,255,0.4)",
                      fontFamily: "monospace",
                      marginTop: "0.2rem",
                    }}
                  >
                    {s.fileName}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
