import React, { useEffect, useState } from "react";
import { useGameStore } from "../store";
import { getAppDocumentsDir, isIOS, pickDirectory } from "../tauri_bridge";

/**
 * Shown on first launch inside Tauri when no assets directory has been chosen,
 * AND whenever the previously-chosen directory fails to load (script data error).
 *
 * The user must pick the folder that contains the game's assets before
 * any game content can load.  The chosen path is stored in localStorage via
 * the store so subsequent launches skip this screen automatically.
 *
 * Expected folder layout:
 *   <chosen dir>/
 *     data/            ← .rrs game scripts + manifest.json
 *     images/          ← BGs, CGs, Sprites, UI, FX, …
 *     Audio/           ← Audio/BGM, Audio/SFX, Audio/Voice
 *     videos/          ← *.webm animated CGs  (optional)
 */
export const AssetsDirScreen: React.FC = () => {
  const setAssetsDir = useGameStore((s) => s.setAssetsDir);
  const storeLoading = useGameStore((s) => s.loading);
  const storeError = useGameStore((s) => s.error);

  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  useEffect(() => {
    if (isIOS) {
      // Calling this will create the placeholder file so the folder appears in the iOS Files app
      getAppDocumentsDir().catch(console.warn);
    }
  }, []);

  const handleIOSDocuments = async () => {
    if (picking || storeLoading) return;
    setPickError(null);
    setPicking(true);
    try {
      const dir = await getAppDocumentsDir();
      if (!dir) {
        throw new Error("无法获取应用文稿目录");
      }
      setAssetsDir(dir);
    } catch (err) {
      setPickError(
        err instanceof Error ? err.message : "获取文稿目录时发生未知错误",
      );
    } finally {
      setPicking(false);
    }
  };

  const handlePick = async () => {
    if (picking || storeLoading) return;
    setPickError(null);
    setPicking(true);
    try {
      const dir = await pickDirectory();
      if (!dir) {
        // User cancelled — just let them try again.
        return;
      }
      setAssetsDir(dir);
    } catch (err) {
      setPickError(
        err instanceof Error ? err.message : "选择文件夹时发生未知错误",
      );
    } finally {
      setPicking(false);
    }
  };

  const isLoading = storeLoading || picking;

  return (
    <>
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
      >
        {/* ── Icon ── */}
        <div style={{ fontSize: "4rem", lineHeight: 1 }}>🗂️</div>

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
          选择 Assets 文件夹
        </h1>

        {/* ── Load error banner (shown when a previous directory failed to load) ── */}
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
              请确认所选文件夹内存在{" "}
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

        {/* ── Explanation card ── */}
        <div
          style={{
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: "10px",
            padding: "1.2rem 1.8rem",
            maxWidth: "480px",
            width: "100%",
            lineHeight: 1.7,
            backdropFilter: "blur(6px)",
            WebkitBackdropFilter: "blur(6px)",
          }}
        >
          <p
            style={{
              margin: "0 0 0.8rem",
              fontSize: "0.92rem",
              color: "rgba(255,255,255,0.8)",
            }}
          >
            {isIOS
              ? "在 iOS 上，请打开系统自带的“文件”App，将资源复制到「我的 iPhone -> 此应用」文件夹内，然后点击下方按钮。"
              : "游戏的图片和音频文件存放在你的本地磁盘上，需要你指定它们的位置。"}
          </p>
          <p
            style={{
              margin: 0,
              fontSize: "0.85rem",
              color: "rgba(255,255,255,0.45)",
            }}
          >
            {isIOS
              ? "请确保该应用目录下直接包含以下子文件夹："
              : "请选择包含以下子文件夹的目录："}
          </p>
          <ul
            style={{
              margin: "0.5rem 0 0",
              paddingLeft: "1.4rem",
              fontSize: "0.82rem",
              color: "rgba(255,255,255,0.4)",
              lineHeight: 1.8,
            }}
          >
            <li>
              <code
                style={{
                  background: "rgba(255,255,255,0.08)",
                  borderRadius: "3px",
                  padding: "0 4px",
                  fontFamily: "monospace",
                  color: "rgba(180,220,255,0.8)",
                }}
              >
                data/
              </code>
              &nbsp;— 剧本脚本（.rrs）与 manifest.json
            </li>
            <li>
              <code
                style={{
                  background: "rgba(255,255,255,0.08)",
                  borderRadius: "3px",
                  padding: "0 4px",
                  fontFamily: "monospace",
                  color: "rgba(180,220,255,0.8)",
                }}
              >
                images/
              </code>
              &nbsp;— BG、CG、立绘、UI 等图片
            </li>
            <li>
              <code
                style={{
                  background: "rgba(255,255,255,0.08)",
                  borderRadius: "3px",
                  padding: "0 4px",
                  fontFamily: "monospace",
                  color: "rgba(180,220,255,0.8)",
                }}
              >
                Audio/
              </code>
              &nbsp;— BGM、SFX、配音
            </li>
          </ul>
        </div>

        {/* ── Loading indicator ── */}
        {isLoading && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              fontSize: "0.92rem",
              color: "rgba(255,230,128,0.7)",
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: "1.1em",
                height: "1.1em",
                border: "2px solid rgba(255,230,128,0.25)",
                borderTopColor: "rgba(255,230,128,0.8)",
                borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
              }}
            />
            {storeLoading && !picking ? "正在加载剧本数据…" : "选择中…"}
          </div>
        )}

        {/* ── Action buttons ── */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "0.75rem",
            width: "100%",
            maxWidth: "340px",
          }}
        >
          {/* Pick button */}
          {isIOS ? (
            <button
              onClick={handleIOSDocuments}
              disabled={isLoading}
              style={{
                width: "100%",
                padding: "0.75rem 2.2rem",
                fontSize: "1.05rem",
                fontWeight: 700,
                letterSpacing: "0.08em",
                background: isLoading
                  ? "rgba(69,150,233,0.25)"
                  : "rgba(69,150,233,0.85)",
                color: "#fff",
                border: "1px solid rgba(69,150,233,0.6)",
                borderRadius: "8px",
                cursor: isLoading ? "default" : "pointer",
                transition: "background 0.2s, transform 0.1s",
                boxShadow: isLoading
                  ? "none"
                  : "0 4px 20px rgba(69,150,233,0.3)",
              }}
              onMouseEnter={(e) => {
                if (!isLoading)
                  (e.currentTarget as HTMLButtonElement).style.background =
                    "rgba(69,150,233,1)";
              }}
              onMouseLeave={(e) => {
                if (!isLoading)
                  (e.currentTarget as HTMLButtonElement).style.background =
                    "rgba(69,150,233,0.85)";
              }}
              aria-label="从应用文稿目录加载"
            >
              {isLoading
                ? picking
                  ? "加载中…"
                  : "加载中…"
                : "📂 从“我的 iPhone”加载"}
            </button>
          ) : (
            <button
              onClick={handlePick}
              disabled={isLoading}
              style={{
                width: "100%",
                padding: "0.75rem 2.2rem",
                fontSize: "1.05rem",
                fontWeight: 700,
                letterSpacing: "0.08em",
                background: isLoading
                  ? "rgba(233,69,96,0.25)"
                  : "rgba(233,69,96,0.85)",
                color: "#fff",
                border: "1px solid rgba(233,69,96,0.6)",
                borderRadius: "8px",
                cursor: isLoading ? "default" : "pointer",
                transition: "background 0.2s, transform 0.1s",
                boxShadow: isLoading
                  ? "none"
                  : "0 4px 20px rgba(233,69,96,0.3)",
              }}
              onMouseEnter={(e) => {
                if (!isLoading)
                  (e.currentTarget as HTMLButtonElement).style.background =
                    "rgba(233,69,96,1)";
              }}
              onMouseLeave={(e) => {
                if (!isLoading)
                  (e.currentTarget as HTMLButtonElement).style.background =
                    "rgba(233,69,96,0.85)";
              }}
              aria-label="打开文件夹选择对话框"
            >
              {isLoading
                ? picking
                  ? "选择中…"
                  : "加载中…"
                : "📂 选择 Assets 文件夹"}
            </button>
          )}
        </div>

        {/* ── Pick error message (dialog/OS-level errors) ── */}
        {pickError && (
          <p
            role="alert"
            style={{
              fontSize: "0.85rem",
              color: "rgba(255,120,120,0.9)",
              background: "rgba(255,60,60,0.08)",
              border: "1px solid rgba(255,60,60,0.2)",
              borderRadius: "6px",
              padding: "0.5rem 1rem",
              maxWidth: "420px",
              textAlign: "center",
            }}
          >
            ⚠️ {pickError}
          </p>
        )}

        {/* ── Footer hint ── */}
        <p
          style={{
            fontSize: "0.7rem",
            color: "rgba(255,255,255,0.18)",
            letterSpacing: "0.04em",
            textAlign: "center",
            maxWidth: "360px",
          }}
        >
          所选路径仅保存在本设备的本地存储中，不会上传到任何服务器。
          如需更换位置，可在游戏设置中重新选择。
        </p>

        {/* ── Spinner keyframes (inline) ── */}
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </>
  );
};
