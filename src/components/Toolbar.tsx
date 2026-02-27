import React from "react";
import { useGameStore } from "../store";

/**
 * Top-right HUD toolbar shown during gameplay.
 *
 * When a FileSystemFileHandle is active (saveFileName !== null), progress is
 * auto-saved to that file on every dialogue step. The toolbar shows the file
 * name as a passive indicator.
 *
 * "另存为" always produces an independent download backup regardless of
 * whether auto-save is running.
 *
 * "返回" pauses the game and returns to the SaveLoadedScreen lobby so the
 * player can access CG gallery, settings, or re-select a save without
 * losing their place in the story.
 */
export const Toolbar: React.FC = () => {
  const phase = useGameStore((s) => s.phase);
  const openGallery = useGameStore((s) => s.openGallery);
  const backToSaveMenu = useGameStore((s) => s.backToSaveMenu);
  const saveExport = useGameStore((s) => s.saveExport);
  const saveFileName = useGameStore((s) => s.saveFileName);

  if (phase !== "playing") return null;

  const hasAutoSave = saveFileName !== null;

  return (
    <div className="toolbar" role="toolbar" aria-label="游戏菜单">
      {/* ── Auto-save indicator ── */}
      {hasAutoSave ? (
        <span
          className="toolbar-btn"
          style={{
            cursor: "default",
            color: "rgba(120,220,120,0.75)",
            borderColor: "rgba(120,220,120,0.2)",
            fontSize: "0.78rem",
            letterSpacing: "0.04em",
            pointerEvents: "none",
            userSelect: "none",
          }}
          title={`自动保存到：${saveFileName}`}
          aria-label={`自动保存中：${saveFileName}`}
        >
          💾 {saveFileName}
        </span>
      ) : (
        /* No auto-save — offer a manual download backup instead */
        <button
          className="toolbar-btn"
          onClick={(e) => {
            e.stopPropagation();
            saveExport();
          }}
          title="将当前进度导出为 .json 备份文件"
          aria-label="另存为文件"
        >
          💾 另存为
        </button>
      )}

      <button
        className="toolbar-btn"
        onClick={(e) => {
          e.stopPropagation();
          openGallery();
        }}
        title="CG 图鉴"
        aria-label="CG 图鉴"
      >
        🖼️ 图鉴
      </button>

      <button
        className="toolbar-btn danger"
        onClick={(e) => {
          e.stopPropagation();
          backToSaveMenu();
        }}
        title={
          hasAutoSave ? "暂停并返回菜单（进度已自动保存）" : "暂停并返回菜单"
        }
        aria-label="返回菜单"
      >
        ↩ 返回
      </button>
    </div>
  );
};
