import React, { useCallback, useEffect, useRef, useState } from "react";

// ─── Lazy video hook ──────────────────────────────────────────────────────────

/**
 * Returns a ref to attach to a container element.
 * `inView` becomes true once the element enters the viewport (never resets),
 * so the video src is only assigned when the thumbnail is actually visible.
 */
function useInView(threshold = 0.1): [React.RefObject<HTMLElement>, boolean] {
  const ref = useRef<HTMLElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (inView) return; // already visible, no need to keep observing
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
import { useGameStore } from "../store";
import { resolveAsset } from "../assets";
import animatedSeqData from "../cg_animated_sequences.json";
import staticSeqData from "../cg_sequences.json";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CGEntry {
  name: string;
  /** All language-variant names that map to this same CG (including `name` itself). */
  aliases: string[];
  character: string;
  frames: string[]; // relative paths passed through resolveAsset()
  isAnimated: boolean; // true = webm, false = static jpg/png
}

// ─── Build combined entry list ────────────────────────────────────────────────

const STATIC_CHARACTER_MAP: Record<string, string> = {
  "Bondage Foreplay": "Yoichi",
  "Jugueteo bondage": "Yoichi",
  "Preliminares com Bondage": "Yoichi",
  "Journal Writing": "Keitaro",
  "Cabin Repairs": "Other",
  "Fundraiser Montage": "Other",
  Sportsfest: "Other",
};

// Collect animated entries from generated JSON
const animatedNames = new Set(
  (animatedSeqData as { entries: { name: string }[] }).entries.map(
    (e) => e.name,
  ),
);

const animatedEntries: CGEntry[] = (
  animatedSeqData as {
    entries: { name: string; character: string; frames: string[] }[];
  }
).entries.map((e) => ({
  name: e.name,
  aliases: [e.name],
  character: e.character,
  frames: e.frames,
  isAnimated: true,
}));

/** Frames that are pure placeholder images (fade-to-black, no real artwork). */
const PLACEHOLDER_FRAMES = new Set(["CGs/cg_fade.png"]);

/** Returns true if every frame in the entry is a known placeholder. */
function isPlaceholderEntry(frames: string[]): boolean {
  return frames.length > 0 && frames.every((f) => PLACEHOLDER_FRAMES.has(f));
}

// Add static-only fallback entries (no animated equivalent)
const staticEntries: CGEntry[] = Object.entries(
  staticSeqData as Record<string, string[]>,
)
  .filter(
    ([name, frames]) => !animatedNames.has(name) && !isPlaceholderEntry(frames),
  )
  .map(([name, frames]) => ({
    name,
    aliases: [name],
    character: STATIC_CHARACTER_MAP[name] ?? "Other",
    frames,
    isAnimated: false,
  }));

const CHARACTER_ORDER = [
  "Hiro",
  "Hunter",
  "Natsumi",
  "Yoichi",
  "Taiga",
  "Keitaro",
  "Other",
];

// Sort: character order first, then name
const _ALL_ENTRIES_SORTED: CGEntry[] = [
  ...animatedEntries,
  ...staticEntries,
].sort((a, b) => {
  const ci =
    CHARACTER_ORDER.indexOf(a.character) - CHARACTER_ORDER.indexOf(b.character);
  return ci !== 0 ? ci : a.name.localeCompare(b.name);
});

// Deduplicate entries that are multilingual aliases of the same CG scene
// (identical frame sets → merge into one entry, collecting all alias names).
const ALL_ENTRIES: CGEntry[] = (() => {
  const seen = new Map<string, CGEntry>();
  for (const entry of _ALL_ENTRIES_SORTED) {
    const key = entry.frames.join("|");
    const existing = seen.get(key);
    if (existing) {
      // Accumulate the alias so unlock checks can match any language variant.
      existing.aliases.push(entry.name);
    } else {
      seen.set(key, { ...entry, aliases: [...entry.aliases] });
    }
  }
  return Array.from(seen.values());
})();

// Collect characters that actually have entries
const ALL_CHARACTERS: string[] = CHARACTER_ORDER.filter((c) =>
  ALL_ENTRIES.some((e) => e.character === c),
);

// ─── Main component ───────────────────────────────────────────────────────────

export const CGGallery: React.FC = () => {
  const closeGallery = useGameStore((s) => s.closeGallery);
  const unlockedCGs = useGameStore((s) => s.unlockedCGs);
  const unlockedSet = new Set(unlockedCGs);
  /** Returns true if the entry or any of its multilingual aliases has been unlocked. */
  const isUnlocked = (e: CGEntry) => e.aliases.some((a) => unlockedSet.has(a));

  const [activeChar, setActiveChar] = useState<string>(
    ALL_CHARACTERS[0] ?? "Hiro",
  );
  const [viewerState, setViewerState] = useState<{
    entry: CGEntry;
    frameIdx: number;
  } | null>(null);

  // Entries visible in the active tab
  const tabEntries = ALL_ENTRIES.filter(
    (e) => e.character === activeChar && isUnlocked(e),
  );

  const totalUnlocked = ALL_ENTRIES.filter((e) => isUnlocked(e)).length;

  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) closeGallery();
  };

  const openViewer = (entry: CGEntry) => {
    setViewerState({ entry, frameIdx: 0 });
  };

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
            已解锁{" "}
            <span style={{ color: "var(--color-accent)", fontWeight: 700 }}>
              {totalUnlocked}
            </span>{" "}
            / {ALL_ENTRIES.length} 张 CG
          </p>

          {/* Character tabs */}
          <div
            style={{
              display: "flex",
              gap: "0.4rem",
              flexWrap: "wrap",
              marginBottom: "1rem",
              flexShrink: 0,
            }}
          >
            {ALL_CHARACTERS.map((char) => {
              const count = ALL_ENTRIES.filter(
                (e) => e.character === char && unlockedSet.has(e.name),
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
                      : "1.5px solid rgba(255,255,255,0.15)",
                    background: isActive
                      ? "rgba(var(--color-accent-rgb, 200,160,80), 0.18)"
                      : "rgba(255,255,255,0.04)",
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
                  <span
                    style={{
                      opacity: 0.7,
                      fontSize: "0.72rem",
                    }}
                  >
                    ({count})
                  </span>
                </button>
              );
            })}
          </div>

          {/* Grid */}
          <div style={{ overflowY: "auto", flex: 1 }}>
            {tabEntries.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  padding: "3rem 1rem",
                  color: "var(--color-text-dim)",
                }}
              >
                <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>🔒</div>
                <p style={{ fontSize: "0.9rem" }}>
                  {activeChar} 的 CG 尚未解锁
                </p>
              </div>
            ) : (
              <div className="gallery-grid">
                {tabEntries.map((entry) => (
                  <GalleryItem
                    key={entry.name}
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
  entry: CGEntry;
  onClick: () => void;
}

const GalleryItem: React.FC<GalleryItemProps> = ({ entry, onClick }) => {
  const [mediaLoaded, setMediaLoaded] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [containerRef, inView] = useInView(0.05);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Pick the first non-placeholder frame so entries whose sequence starts with
  // cg_fade.png (a solid black transition image) don't show a black thumbnail.
  const firstFrame =
    entry.frames.find((f) => !PLACEHOLDER_FRAMES.has(f)) ?? entry.frames[0];
  // Only assign src once the thumbnail scrolls into view, preventing
  // dozens of webm files from racing to decode simultaneously on tab open.
  const src = inView && firstFrame ? resolveAsset(firstFrame) : null;

  // Called by either onLoadedMetadata or onLoadedData — whichever fires first.
  const handleVideoReady = () => setMediaLoaded(true);

  // Play/pause the thumbnail video on hover (no autoPlay = no decoder race).
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || !entry.isAnimated) return;
    if (hovered && mediaLoaded) {
      vid.play().catch(() => {});
    } else {
      vid.pause();
      // Only reset to start when leaving hover so next hover restarts cleanly
      if (!hovered) vid.currentTime = 0;
    }
  }, [hovered, mediaLoaded, entry.isAnimated]);

  return (
    <button
      ref={containerRef as React.RefObject<HTMLButtonElement>}
      className="gallery-item"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={`查看 CG：${entry.name}`}
      title={`${entry.name}（${entry.frames.length} 帧）`}
      style={{
        cursor: "pointer",
        background: "none",
        border: "none",
        padding: 0,
        position: "relative",
      }}
    >
      {/* Media thumbnail */}
      {src && !mediaError ? (
        entry.isAnimated ? (
          <video
            ref={videoRef}
            src={src}
            preload="metadata"
            loop
            muted
            playsInline
            onLoadedMetadata={handleVideoReady}
            onLoadedData={handleVideoReady}
            onError={() => setMediaError(true)}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
              // Keep video in DOM once loaded so it's ready to play on hover;
              // hide it visually when not hovered so the play-icon overlay shows
              opacity: mediaLoaded && hovered ? 1 : 0,
              transition: "opacity 0.25s ease",
            }}
          />
        ) : (
          <img
            src={src}
            alt={entry.name}
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
        /* Placeholder shown before in-view or on error */
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(255,255,255,0.04)",
            gap: "0.4rem",
          }}
        >
          <span style={{ fontSize: "1.5rem" }}>
            {entry.isAnimated ? "▶" : "🖼️"}
          </span>
        </div>
      )}

      {/* Loading spinner – only for static images waiting to load;
          animated entries use metadata preload so spinner would be very brief,
          but we suppress it entirely to avoid flicker */}
      {src && !mediaLoaded && !mediaError && !entry.isAnimated && (
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
              border: "2px solid rgba(255,255,255,0.1)",
              borderTopColor: "var(--color-accent)",
              borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
            }}
          />
        </div>
      )}

      {/* Static poster overlay for animated entries – visible when loaded but
          not yet hovered. Gives the user a visual cue that it's an animation. */}
      {entry.isAnimated && mediaLoaded && !hovered && (
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
              background: "rgba(0,0,0,0.45)",
              borderRadius: "50%",
              width: 28,
              height: 28,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "0.75rem",
              color: "rgba(255,255,255,0.8)",
            }}
          >
            ▶
          </div>
        </div>
      )}

      {/* Animated badge */}
      {entry.isAnimated && mediaLoaded && (
        <div
          style={{
            position: "absolute",
            top: "0.3rem",
            right: "0.3rem",
            background: "rgba(0,0,0,0.6)",
            borderRadius: "4px",
            padding: "0.1rem 0.3rem",
            fontSize: "0.6rem",
            color: "rgba(255,255,255,0.8)",
            pointerEvents: "none",
          }}
        >
          ▶ {entry.frames.length}
        </div>
      )}

      {/* Label overlay */}
      {mediaLoaded && (
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            padding: "0.35rem 0.45rem",
            background: "linear-gradient(transparent, rgba(0,0,0,0.82))",
            fontSize: "0.65rem",
            color: "rgba(255,255,255,0.9)",
            textAlign: "left",
            wordBreak: "break-word",
            borderRadius: "0 0 8px 8px",
            pointerEvents: "none",
          }}
        >
          {entry.name}
        </div>
      )}
    </button>
  );
};

// ─── Fullscreen viewer ────────────────────────────────────────────────────────

interface CGViewerProps {
  entry: CGEntry;
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
      aria-label={`查看 CG：${entry.name}`}
      style={{ userSelect: "none" }}
    >
      {/* Media */}
      {entry.isAnimated ? (
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
          style={{
            maxWidth: "100%",
            maxHeight: "100%",
            objectFit: "contain",
          }}
        />
      ) : (
        <img
          src={currentSrc}
          alt={entry.name}
          draggable={false}
          onClick={(e) => e.stopPropagation()}
          style={{
            maxWidth: "100%",
            maxHeight: "100%",
            objectFit: "contain",
          }}
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
            background: "rgba(0,0,0,0.55)",
            border: "none",
            borderRadius: "50%",
            width: 44,
            height: 44,
            color: "white",
            fontSize: "1.3rem",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "background 0.15s",
          }}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.background =
              "rgba(0,0,0,0.85)")
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.background =
              "rgba(0,0,0,0.55)")
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
            background: "rgba(0,0,0,0.55)",
            border: "none",
            borderRadius: "50%",
            width: 44,
            height: 44,
            color: "white",
            fontSize: "1.3rem",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "background 0.15s",
          }}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.background =
              "rgba(0,0,0,0.85)")
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.background =
              "rgba(0,0,0,0.55)")
          }
        >
          ›
        </button>
      )}

      {/* Frame counter + label */}
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
            color: "rgba(255,255,255,0.9)",
            whiteSpace: "nowrap",
          }}
        >
          {entry.name}
        </div>
        {totalFrames > 1 && (
          <div
            style={{
              background: "rgba(0,0,0,0.55)",
              borderRadius: "12px",
              padding: "0.2rem 0.7rem",
              fontSize: "0.75rem",
              color: "rgba(255,255,255,0.7)",
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
            background: "rgba(0,0,0,0.45)",
            borderRadius: "6px",
            padding: "0.2rem 0.65rem",
            fontSize: "0.7rem",
            color: "rgba(255,255,255,0.5)",
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
