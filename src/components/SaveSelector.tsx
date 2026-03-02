import React, { useCallback, useEffect, useState } from "react";
import { useGameStore } from "../store";
import { getSaveStore, type SaveEntry } from "../saveStore";
import { formatTimestamp, formatLabel } from "../save";

export const SaveSelector: React.FC = () => {
  const show = useGameStore((s) => s.showSaveSelector);
  const close = useGameStore((s) => s.closeSaveSelector);
  const continueSave = useGameStore((s) => s.continueSave);
  const saveImport = useGameStore((s) => s.saveImport);
  const setSaveError = useGameStore((s) => s.setSaveError);

  const [entries, setEntries] = useState<SaveEntry[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setListLoading(true);
    setError(null);
    try {
      const result = await getSaveStore().list();
      setEntries(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    if (show) loadList();
  }, [show, loadList]);

  const handleSelect = (entry: SaveEntry) => {
    close();
    continueSave(entry);
  };

  const handleImport = async () => {
    try {
      await saveImport();
      // saveImport lands on SaveLoadedScreen on success, which closes this panel.
      // Refresh the list in case the import just added a file.
      loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setDeletingId(id);
    try {
      await getSaveStore().remove(id);
      setEntries((prev) => prev.filter((en) => en.id !== id));
    } catch (err) {
      setSaveError(
        `删除失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setDeletingId(null);
    }
  };

  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) close();
  };

  if (!show) return null;

  return (
    <div
      className="modal-overlay"
      onClick={handleBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label="继续游戏"
    >
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        {/* ── Header ── */}
        <div className="modal-header">
          <h2 className="modal-title">📂 继续游戏</h2>
          <button className="modal-close-btn" onClick={close} aria-label="关闭">
            ✕
          </button>
        </div>

        {/* ── Import button ── */}
        <div style={{ marginBottom: "1rem" }}>
          <button
            className="btn"
            style={{ width: "100%", textAlign: "center" }}
            onClick={handleImport}
          >
            📥 从文件导入存档 (.json)
          </button>
        </div>

        <div className="divider" />

        {/* ── Save list ── */}
        <div
          style={{
            maxHeight: "55vh",
            overflowY: "auto",
            marginTop: "0.75rem",
          }}
        >
          {listLoading ? (
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                padding: "2.5rem 0",
              }}
            >
              <div
                className="loading-spinner"
                style={{ width: 32, height: 32 }}
              />
            </div>
          ) : error ? (
            <p
              role="alert"
              style={{
                color: "var(--color-accent)",
                fontSize: "0.85rem",
                textAlign: "center",
                padding: "1.5rem 0",
              }}
            >
              ⚠️ {error}
            </p>
          ) : entries.length === 0 ? (
            <p
              style={{
                color: "var(--color-text-dim)",
                fontSize: "0.85rem",
                textAlign: "center",
                padding: "2.5rem 0",
              }}
            >
              暂无存档
            </p>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
              }}
            >
              {entries.map((entry, i) => (
                <div
                  key={entry.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                  }}
                >
                  <button
                    onClick={() => handleSelect(entry)}
                    style={{
                      flex: 1,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: "0.2rem",
                      padding: "0.7rem 0.9rem",
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.09)",
                      borderRadius: 8,
                      cursor: "pointer",
                      textAlign: "left",
                      transition: "background 0.15s, border-color 0.15s",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background =
                        "rgba(255,255,255,0.09)";
                      (e.currentTarget as HTMLButtonElement).style.borderColor =
                        "rgba(255,255,255,0.18)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background =
                        "rgba(255,255,255,0.04)";
                      (e.currentTarget as HTMLButtonElement).style.borderColor =
                        "rgba(255,255,255,0.09)";
                    }}
                  >
                    {/* Row 1: index + location */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.5rem",
                        width: "100%",
                      }}
                    >
                      <span
                        style={{
                          fontSize: "0.68rem",
                          fontWeight: 700,
                          color: "var(--color-text-dim)",
                          background: "rgba(255,255,255,0.07)",
                          borderRadius: 4,
                          padding: "0.1rem 0.4rem",
                          flexShrink: 0,
                        }}
                      >
                        {entries.length - i}
                      </span>
                      <span
                        style={{
                          fontSize: "0.9rem",
                          fontWeight: 600,
                          color: "var(--color-text)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {formatLabel(entry.label)}
                      </span>
                    </div>

                    {/* Row 2: timestamp */}
                    <span
                      style={{
                        fontSize: "0.75rem",
                        color: "var(--color-text-dim)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {formatTimestamp(entry.timestamp)}
                    </span>
                  </button>

                  {/* Delete button */}
                  <button
                    onClick={(e) => handleDelete(e, entry.id)}
                    disabled={deletingId === entry.id}
                    aria-label="删除此存档"
                    style={{
                      flexShrink: 0,
                      padding: "0.45rem 0.6rem",
                      background: "transparent",
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: 7,
                      color: "var(--color-text-dim)",
                      cursor: deletingId === entry.id ? "default" : "pointer",
                      fontSize: "0.85rem",
                      opacity: deletingId === entry.id ? 0.4 : 1,
                      transition: "background 0.15s, color 0.15s",
                    }}
                    onMouseEnter={(e) => {
                      if (deletingId === entry.id) return;
                      (e.currentTarget as HTMLButtonElement).style.background =
                        "rgba(220,60,60,0.15)";
                      (e.currentTarget as HTMLButtonElement).style.color =
                        "rgba(255,120,120,0.9)";
                      (e.currentTarget as HTMLButtonElement).style.borderColor =
                        "rgba(220,60,60,0.35)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background =
                        "transparent";
                      (e.currentTarget as HTMLButtonElement).style.color =
                        "var(--color-text-dim)";
                      (e.currentTarget as HTMLButtonElement).style.borderColor =
                        "rgba(255,255,255,0.08)";
                    }}
                  >
                    {deletingId === entry.id ? "…" : "✕"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
