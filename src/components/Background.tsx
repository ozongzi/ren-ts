import React, { useEffect, useRef, useState } from "react";
import { isCssColor, isVideoPath } from "../assets";

interface BackgroundProps {
  src: string | null;
  filter?: string | null;
}

/**
 * Renders the scene background layer.
 *
 * Supports:
 *  - CSS colour strings like "#000000" or "#ffffff"
 *  - Static image files (jpg/png/webp)
 *  - Looping video files (.webm — used for animated CGs)
 *
 * Cross-fade is implemented by:
 *  - Keeping the OLD background fully visible underneath (z-index 0)
 *  - Mounting the NEW background with a CSS fade-in animation (z-index 1)
 *  - After the animation completes, discarding the old background
 *
 * CSS transitions don't work for newly-mounted elements (there is no
 * "previous" value to transition from), so we use a @keyframes animation
 * instead — it fires immediately on mount regardless of prior state.
 */
export const Background: React.FC<BackgroundProps> = ({ src, filter }) => {
  const [displaySrc, setDisplaySrc] = useState<string | null>(src);
  const [prevSrc, setPrevSrc] = useState<string | null>(null);
  const [entering, setEntering] = useState(false);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleRef = useRef<number | null>(null);

  useEffect(() => {
    if (src === displaySrc) return;

    // Defer state updates to an async task so they do not run synchronously
    // inside the effect body. This avoids cascading renders caused by
    // immediate setState() calls while still preserving the visible update
    // ordering (old background kept underneath while new one fades in).
    if (scheduleRef.current) {
      clearTimeout(scheduleRef.current);
    }
    scheduleRef.current = window.setTimeout(() => {
      setPrevSrc(displaySrc);
      setDisplaySrc(src);
      setEntering(true);

      if (fadeTimer.current) clearTimeout(fadeTimer.current);
      // Clear the old layer slightly after the animation ends (0.5s)
      fadeTimer.current = setTimeout(() => {
        setPrevSrc(null);
        setEntering(false);
      }, 600);

      scheduleRef.current = null;
    }, 0);

    return () => {
      if (scheduleRef.current) {
        clearTimeout(scheduleRef.current);
        scheduleRef.current = null;
      }
      if (fadeTimer.current) {
        clearTimeout(fadeTimer.current);
        fadeTimer.current = null;
      }
    };
  }, [src, displaySrc]);

  return (
    <div
      className="bg-layer-container"
      style={{ position: "absolute", inset: 0, zIndex: 0 }}
    >
      {/* Old background — stays fully opaque underneath while new one fades in */}
      {prevSrc && (
        <BgLayer
          key={`prev-${prevSrc}`}
          src={prevSrc}
          style={{ opacity: 1, zIndex: 0 }}
        />
      )}

      {/* New / current background — animates from transparent to opaque on mount */}
      {displaySrc && (
        <BgLayer
          key={`cur-${displaySrc}`}
          src={displaySrc}
          filter={filter}
          style={{
            zIndex: 1,
            animation: entering ? "bg-fade-in 0.5s ease forwards" : "none",
            opacity: 1,
          }}
        />
      )}

      {/* Fallback solid black when no background is set */}
      {!displaySrc && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "#000",
            zIndex: 0,
          }}
        />
      )}
    </div>
  );
};

// ─── BgLayer ──────────────────────────────────────────────────────────────────

interface BgLayerProps {
  src: string;
  filter?: string | null;
  style?: React.CSSProperties;
}

const BgLayer: React.FC<BgLayerProps> = ({ src, filter, style }) => {
  const cssFilter = filter === "sepia" ? "sepia(1)" : (filter ?? undefined);
  const baseStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    filter: cssFilter,
    ...style,
  };

  // CSS colour (e.g. "#000000")
  if (isCssColor(src)) {
    return (
      <div
        className="bg-layer color-bg"
        style={{ ...baseStyle, background: src }}
      />
    );
  }

  // Animated video (.webm)
  if (isVideoPath(src)) {
    return (
      <div className="bg-layer" style={baseStyle}>
        <VideoBackground src={src} />
      </div>
    );
  }

  // Static image
  return (
    <div
      className="bg-layer"
      style={{
        ...baseStyle,
        backgroundImage: `url(${JSON.stringify(src)})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      }}
    />
  );
};

// ─── VideoBackground ──────────────────────────────────────────────────────────

const VideoBackground: React.FC<{ src: string }> = ({ src }) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.src = src;
    el.load();
    el.play().catch(() => {
      // Autoplay may be blocked; user interaction will resume it
    });
  }, [src]);

  return (
    <video
      ref={videoRef}
      autoPlay
      loop
      muted
      playsInline
      style={{
        width: "100%",
        height: "100%",
        objectFit: "cover",
        objectPosition: "center",
      }}
    />
  );
};
