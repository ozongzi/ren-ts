import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useGameStore } from "../store";
import { resolveAsset } from "../assets";
import { getGallery } from "../loader";
import type { GalleryEntry } from "../types";

// ─── Lazy-load hook ───────────────────────────────────────────────────────────

/**
 * Returns [ref, inView].  `inView` flips to true once the element scrolls
 * into the viewport and stays true (never resets), so the video src is only
 * assigned once the thumbnail is actually visible.
 */
function useInView(threshold = 0.05): [React.RefObject<HTMLElement>, boolean] {
  const ref = useRef<HTMLElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [inView, threshold]);

  return [ref as React.RefObject<HTMLElement>, inView];
}

// ─── Main gallery component ───────────────────────────────────────────────────

export const CGGallery: React.FC = () => {
  const closeGallery = useGameStore((s) => s.closeGallery);

  // All gallery entries come from manifest.json (injected by parse_gallery.ts).
  // No game-specific data is hardcoded here.
  const allEntries: GalleryEntry[] = useMemo(() => getGallery(), []);

  // Derive the unique ordered character list from the entries themselves.
  // Order is determined by first appearance in the entries array (which
  // preserves the insertion order from gallery_images.rpy).
  const characters: string[] = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const e of allEntries) {
      if (!seen.has(e.character)) {
        seen.add(e.character);
        result.push(e.character);
      }
    }
    return result;
  }, [allEntries]);

  const [activeChar, setActiveChar] = useState<string>(
    () => characters[0] ?? "",
  );

  // Reset active tab if entries change (e.g. on hot-reload)
  // Defer the state update to the next macrotask so we do not call setState
  // synchronously inside an effect (ESLint rule: react-hooks/set-state-in-effect).
  // Deferring preserves the intended visual behavior (old tab kept until new
  // one is installed) while satisfying the linter by avoiding immediate
  // synchronous state updates during the effect.
  useEffect(() => {
    if (characters.length > 0 && !characters.includes(activeChar)) {
      const t = window.setTimeout(() => {
        setActiveChar(characters[0]);
      }, 0);
      return () => window.clearTimeout(t);
    }
    return;
  }, [characters, activeChar]);

  const [viewerState, setViewerState] = useState<{
    entry: GalleryEntry;
    frameIdx: number;
  } | null>(null);

  const tabEntries = useMemo(
    () => allEntries.filter((e) => e.character === activeChar),
    [allEntries, activeChar],
  );

  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) closeGallery();
  };

  const openViewer = (entry: GalleryEntry) =>
    setViewerState({ entry, frameIdx: 0 });

  const closeViewer = () => setViewerState(null);

  const navigateViewer = useCallback((delta: number) => {
    setViewerState((prev) => {
      if (!prev) return null;
      const total = prev.entry.frames.length;
      const next = (prev.frameIdx + delta + total) % total;
      return { ...prev, frameIdx: next };
    });
  }, []);

  return (
    <>
      {/* ── Gallery modal ── */}
      <div
        className="modal-overlay"
        onClick={handleBackdrop}
        role="dialog"
        aria-modal="true"
        aria-label="CG 图鉴"
      >
        <div
          className="modal-panel"
          onClick={(e) => e.stopPropagation()}
          style={{
            display: "flex",
            flexDirection: "column",
            maxHeight: "90vh",
          }}
        >
          {/* Header */}
          <div className="modal-header">
            <h2 className="modal-title">🖼️ CG 图鉴</h2>
            <button
              className="modal-close-btn"
              onClick={closeGallery}
              aria-label="关闭图鉴"
            >
              ✕
            </button>
          </div>

          {/* Stats */}
          <p
            style={{
              fontSize: "0.82rem",
              color: "var(--color-text-dim)",
              marginBottom: "0.8rem",
              flexShrink: 0,
            }}
          >
            共{" "}
            <span style={{ color: "var(--color-accent)", fontWeight: 700 }}>
              {allEntries.length}
            </span>{" "}
            个场景
          </p>

          {/* Character tabs */}
          {characters.length > 1 && (
            <div
              style={{
                display: "flex",
                gap: "0.4rem",
                flexWrap: "wrap",
                marginBottom: "1rem",
                flexShrink: 0,
              }}
            >
              {characters.map((char) => {
                const count = allEntries.filter(
                  (e) => e.character === char,
                ).length;
                const isActive = char === activeChar;
                return (
                  <button
                    key={char}
                    onClick={() => setActiveChar(char)}
                    style={{
                      padding: "0.3rem 0.75rem",
                      borderRadius: "20px",
                      border: isActive
                        ? "1.5px solid var(--color-accent)"
                        : "1.5px solid rgba(0,0,0,0.13)",
                      background: isActive
                        ? "rgba(214,58,90,0.1)"
                        : "rgba(0,0,0,0.04)",
                      color: isActive
                        ? "var(--color-accent)"
                        : "var(--color-text-dim)",
                      fontSize: "0.8rem",
                      fontWeight: isActive ? 700 : 400,
                      cursor: "pointer",
                      transition: "all 0.15s ease",
                    }}
                  >
                    {char}{" "}
                    <span style={{ opacity: 0.7, fontSize: "0.72rem" }}>
                      ({count})
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Grid */}
          <div style={{ overflowY: "auto", flex: 1 }}>
            {allEntries.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  padding: "3rem 1rem",
                  color: "var(--color-text-dim)",
                }}
              >
                <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>🖼️</div>
                <p style={{ fontSize: "0.9rem" }}>
                  暂无图鉴数据。请先运行 parse_gallery.ts 将图鉴数据注入
                  manifest.json。
                </p>
              </div>
            ) : tabEntries.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  padding: "3rem 1rem",
                  color: "var(--color-text-dim)",
                }}
              >
                <p style={{ fontSize: "0.9rem" }}>{activeChar} 暂无场景</p>
              </div>
            ) : (
              <div className="gallery-grid">
                {tabEntries.map((entry) => (
                  <GalleryItem
                    key={entry.id}
                    entry={entry}
                    onClick={() => openViewer(entry)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Fullscreen viewer ── */}
      {viewerState && (
        <CGViewer
          entry={viewerState.entry}
          frameIdx={viewerState.frameIdx}
          onNavigate={navigateViewer}
          onClose={closeViewer}
        />
      )}
    </>
  );
};

// ─── Gallery item ─────────────────────────────────────────────────────────────

interface GalleryItemProps {
  entry: GalleryEntry;
  onClick: () => void;
}

const GalleryItem: React.FC<GalleryItemProps> = ({ entry, onClick }) => {
  const [mediaLoaded, setMediaLoaded] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [containerRef, inView] = useInView(0.05);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Use the first frame as the thumbnail
  const firstFrame = entry.frames[0];
  // Only assign the src once the item scrolls into view to avoid decoding
  // dozens of webm files simultaneously on tab open.
  const src = inView && firstFrame ? resolveAsset(firstFrame) : null;

  // Detect whether the entry contains video frames
  const isAnimated = firstFrame?.endsWith(".webm") ?? false;

  // Play/pause the thumbnail video on hover
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || !isAnimated) return;
    if (hovered && mediaLoaded) {
      vid.play().catch(() => {});
    } else {
      vid.pause();
      if (!hovered) vid.currentTime = 0;
    }
  }, [hovered, mediaLoaded, isAnimated]);

  return (
    <button
      ref={containerRef as React.RefObject<HTMLButtonElement>}
      className="gallery-item"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={`查看：${entry.id}`}
      title={`${entry.id}（${entry.frames.length} 帧）`}
      style={{
        cursor: "pointer",
        background: "none",
        border: "none",
        padding: 0,
        position: "relative",
      }}
    >
      {/* Thumbnail media */}
      {src && !mediaError ? (
        isAnimated ? (
          <video
            ref={videoRef}
            src={src}
            preload="metadata"
            loop
            muted
            playsInline
            onLoadedMetadata={() => setMediaLoaded(true)}
            onLoadedData={() => setMediaLoaded(true)}
            onError={() => setMediaError(true)}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
              opacity: mediaLoaded && hovered ? 1 : 0,
              transition: "opacity 0.25s ease",
            }}
          />
        ) : (
          <img
            src={src}
            alt={entry.id}
            loading="lazy"
            onLoad={() => setMediaLoaded(true)}
            onError={() => setMediaError(true)}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
              opacity: mediaLoaded ? 1 : 0,
              transition: "opacity 0.3s ease",
            }}
          />
        )
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.04)",
            gap: "0.4rem",
          }}
        >
          <span style={{ fontSize: "1.5rem" }}>{isAnimated ? "▶" : "🖼️"}</span>
        </div>
      )}

      {/* Loading spinner for static images */}
      {src && !mediaLoaded && !mediaError && !isAnimated && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.3)",
          }}
        >
          <div
            style={{
              width: 22,
              height: 22,
              border: "2px solid rgba(0,0,0,0.08)",
              borderTopColor: "var(--color-accent)",
              borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
            }}
          />
        </div>
      )}

      {/* Play-icon overlay for loaded animated entries not yet hovered */}
      {isAnimated && mediaLoaded && !hovered && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              background: "rgba(0,0,0,0.35)",
              borderRadius: "50%",
              width: 28,
              height: 28,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "0.75rem",
              color: "rgba(255,255,255,0.9)",
            }}
          >
            ▶
          </div>
        </div>
      )}

      {/* Animated badge: frame count */}
      {isAnimated && mediaLoaded && (
        <div
          style={{
            position: "absolute",
            top: "0.3rem",
            right: "0.3rem",
            background: "rgba(0,0,0,0.5)",
            borderRadius: "4px",
            padding: "0.1rem 0.3rem",
            fontSize: "0.6rem",
            color: "rgba(255,255,255,0.9)",
            pointerEvents: "none",
          }}
        >
          ▶ {entry.frames.length}
        </div>
      )}

      {/* Scene ID label at the bottom */}
      {mediaLoaded && (
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            padding: "0.35rem 0.45rem",
            background: "linear-gradient(transparent, rgba(0,0,0,0.72))",
            fontSize: "0.65rem",
            color: "rgba(255,255,255,0.95)",
            textAlign: "left",
            wordBreak: "break-word",
            borderRadius: "0 0 8px 8px",
            pointerEvents: "none",
          }}
        >
          {entry.id}
        </div>
      )}
    </button>
  );
};

// ─── Fullscreen viewer ────────────────────────────────────────────────────────

interface CGViewerProps {
  entry: GalleryEntry;
  frameIdx: number;
  onNavigate: (delta: number) => void;
  onClose: () => void;
}

const CGViewer: React.FC<CGViewerProps> = ({
  entry,
  frameIdx,
  onNavigate,
  onClose,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const totalFrames = entry.frames.length;
  const currentSrc = resolveAsset(entry.frames[frameIdx]);
  const isAnimated = entry.frames[frameIdx]?.endsWith(".webm") ?? false;
  const hasPrev = frameIdx > 0;
  const hasNext = frameIdx < totalFrames - 1;

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") onNavigate(-1);
      else if (e.key === "ArrowRight" || e.key === "ArrowDown") onNavigate(1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, onNavigate]);

  // Restart video when frame changes
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.currentTime = 0;
      videoRef.current.play().catch(() => {});
    }
  }, [frameIdx]);

  return (
    <div
      className="cg-viewer"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`查看：${entry.id}`}
      style={{ userSelect: "none" }}
    >
      {/* Media */}
      {isAnimated ? (
        <video
          ref={videoRef}
          key={currentSrc}
          src={currentSrc}
          autoPlay
          loop
          muted
          playsInline
          draggable={false}
          onClick={(e) => e.stopPropagation()}
          style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
        />
      ) : (
        <img
          src={currentSrc}
          alt={entry.id}
          draggable={false}
          onClick={(e) => e.stopPropagation()}
          style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
        />
      )}

      {/* Prev button */}
      {hasPrev && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onNavigate(-1);
          }}
          aria-label="上一帧"
          style={{
            position: "absolute",
            left: "1rem",
            top: "50%",
            transform: "translateY(-50%)",
            background: "rgba(0,0,0,0.45)",
            border: "none",
            borderRadius: "50%",
            width: 44,
            height: 44,
            color: "#ffffff",
            fontSize: "1.3rem",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "background 0.15s",
          }}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.background =
              "rgba(0,0,0,0.72)")
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.background =
              "rgba(0,0,0,0.45)")
          }
        >
          ‹
        </button>
      )}

      {/* Next button */}
      {hasNext && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onNavigate(1);
          }}
          aria-label="下一帧"
          style={{
            position: "absolute",
            right: "1rem",
            top: "50%",
            transform: "translateY(-50%)",
            background: "rgba(255,255,255,0.88)",
            border: "none",
            borderRadius: "50%",
            width: 44,
            height: 44,
            color: "#1a1a2e",
            fontSize: "1.3rem",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "background 0.15s",
          }}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.background =
              "rgba(0,0,0,0.72)")
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.background =
              "rgba(0,0,0,0.45)")
          }
        >
          ›
        </button>
      )}

      {/* Frame counter + scene ID */}
      <div
        style={{
          position: "absolute",
          bottom: "1rem",
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "0.3rem",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            background: "rgba(0,0,0,0.65)",
            borderRadius: "6px",
            padding: "0.3rem 0.85rem",
            fontSize: "0.82rem",
            color: "rgba(26,26,46,0.75)",
            whiteSpace: "nowrap",
          }}
        >
          {entry.id}
        </div>
        {totalFrames > 1 && (
          <div
            style={{
              background: "rgba(255,255,255,0.88)",
              borderRadius: "12px",
              padding: "0.2rem 0.7rem",
              fontSize: "0.75rem",
              color: "rgba(26,26,46,0.75)",
              whiteSpace: "nowrap",
            }}
          >
            {frameIdx + 1} / {totalFrames}
          </div>
        )}
      </div>

      {/* Close button */}
      <button
        className="cg-viewer-close"
        onClick={onClose}
        aria-label="关闭查看器"
        title="关闭（ESC）"
      >
        ✕
      </button>

      {/* Keyboard hint */}
      {totalFrames > 1 && (
        <div
          style={{
            position: "absolute",
            top: "1rem",
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(255,255,255,0.88)",
            borderRadius: "6px",
            padding: "0.2rem 0.65rem",
            fontSize: "0.7rem",
            color: "rgba(26,26,46,0.65)",
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          ← → 切换帧 · ESC 关闭
        </div>
      )}
    </div>
  );
};
