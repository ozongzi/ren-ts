import React, {
  useState,
  useLayoutEffect,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import type { SpriteState } from "../types";
import { isVideoPath, atToLeftPercent, resolveAssetAsync } from "../assets";
import { useGameStore } from "../store";

function isExpressionSprite(key: string): boolean {
  const spaceIdx = key.indexOf(" ");
  return spaceIdx > 0 && !key.toLowerCase().startsWith("cg ");
}

function isFxOverlay(key: string, at: string | undefined): boolean {
  if (at === "fx_pos" || at === "truecenter") return true;
  if (key.toLowerCase().startsWith("fx_")) return true;
  return false;
}

const FACE_ZINDEX_BONUS = 1000;

interface SpriteLayerProps {
  sprites: SpriteState[];
}

export const SpriteLayer: React.FC<SpriteLayerProps> = ({ sprites }) => {
  const [loadedMap, setLoadedMap] = useState<Map<number, boolean>>(new Map());

  const onLoaded = useCallback((zIndex: number) => {
    setLoadedMap((prev) => {
      if (prev.get(zIndex)) return prev;
      const next = new Map(prev);
      next.set(zIndex, true);
      return next;
    });
  }, []);

  const atGroups = useMemo(() => {
    const groups = new Map<string, number[]>();
    for (const s of sprites) {
      // at 未指定时视为 "center"
      const pos = s.at ?? "center";
      const list = groups.get(pos) ?? [];
      list.push(s.zIndex);
      groups.set(pos, list);
    }
    return groups;
  }, [sprites]);

  if (sprites.length === 0) return null;

  return (
    <div className="sprite-layer">
      {sprites.map((sprite) => {
        const pos = sprite.at ?? "center";
        const groupZIndices = atGroups.get(pos) ?? [sprite.zIndex];
        const groupReady = groupZIndices.every(
          (zi) => loadedMap.get(zi) === true,
        );

        return (
          <SpriteElement
            key={sprite.zIndex}
            sprite={sprite}
            groupReady={groupReady}
            onLoaded={onLoaded}
          />
        );
      })}
    </div>
  );
};

// ─── Individual sprite element ─────────────────────────────────────────────────

interface SpriteElementProps {
  sprite: SpriteState;
  groupReady: boolean;
  onLoaded: (zIndex: number) => void;
}

interface NaturalSize {
  width: number;
  height: number;
}

const SpriteElement: React.FC<SpriteElementProps> = ({
  sprite,
  groupReady,
  onLoaded,
}) => {
  const { zIndex, src, at } = sprite;

  const vars = useGameStore((s) => s.vars);
  const screenWidth = (vars.get("config.screen_width") as number) ?? 1920;
  const screenHeight = (vars.get("config.screen_height") as number) ?? 1080;

  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
  const [displaySrc, setDisplaySrc] = useState<string | null>(null);
  // Natural pixel dimensions of the loaded image (null until loaded)
  const [naturalSize, setNaturalSize] = useState<NaturalSize | null>(null);

  // ── Step 1: resolve raw path → Blob URL ────────────────────────────────────
  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    resolveAssetAsync(src).then((url) => {
      if (!cancelled) setResolvedSrc(url || null);
    });
    return () => {
      cancelled = true;
    };
  }, [src]);

  // ── Step 2: preload image, capture naturalWidth/Height ─────────────────────
  useLayoutEffect(() => {
    if (!resolvedSrc) return;
    let cancelled = false;

    if (isVideoPath(resolvedSrc)) {
      Promise.resolve().then(() => {
        if (cancelled) return;
        setDisplaySrc(resolvedSrc);
        // Videos: assume logical screen size as natural size so scale = 1
        setNaturalSize({ width: screenWidth, height: screenHeight });
        onLoaded(zIndex);
      });
      return () => {
        cancelled = true;
      };
    }

    const img = new Image();

    const finish = (w: number, h: number) => {
      if (cancelled) return;
      setDisplaySrc(resolvedSrc);
      setNaturalSize({ width: w, height: h });
      onLoaded(zIndex);
    };

    img.onload = () => finish(img.naturalWidth, img.naturalHeight);
    img.onerror = () => finish(0, 0); // still unblock the group

    img.src = resolvedSrc;

    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
      try {
        img.src = "";
      } catch {
        /* ignore */
      }
    };
  }, [resolvedSrc, zIndex, onLoaded, screenWidth, screenHeight]);

  if (displaySrc === null) return null;

  // ── Compute display size from logical screen dimensions ────────────────────
  //
  // We want the sprite to fit inside the logical canvas (screenWidth ×
  // screenHeight) at its natural pixel size, scaled down if it would overflow.
  // The container (.sprite-layer) is stretched to 100% of the viewport via CSS,
  // so we express dimensions as percentages of the logical size.
  //
  //   scale = min(1, screenW / natW, screenH / natH)
  //   displayW = natW * scale   →   as % of screenW
  //   displayH = natH * scale   →   as % of screenH
  //
  const computeSizeStyle = (): React.CSSProperties => {
    if (!naturalSize || naturalSize.width === 0 || naturalSize.height === 0) {
      // Fallback: fill height like the old behaviour
      return { height: "95%", width: "auto" };
    }
    const { width: natW, height: natH } = naturalSize;
    const scale = Math.min(1, screenWidth / natW, screenHeight / natH);
    const displayW = natW * scale;
    const displayH = natH * scale;
    return {
      width: `${(displayW / screenWidth) * 100}%`,
      height: `${(displayH / screenHeight) * 100}%`,
    };
  };

  const sizeStyle = computeSizeStyle();
  const opacityStyle: React.CSSProperties = {
    opacity: groupReady ? 1 : 0,
    transition: "opacity 0.12s ease",
  };

  // ── FX / overlay sprite ────────────────────────────────────────────────────
  if (isFxOverlay(sprite.key, at)) {
    const fxStyle: React.CSSProperties = {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      objectFit: "contain",
      objectPosition: "center",
      zIndex: 2 + zIndex,
      pointerEvents: "none",
      ...opacityStyle,
    };

    if (isVideoPath(displaySrc)) {
      return (
        <video
          autoPlay
          loop
          muted
          playsInline
          src={displaySrc}
          style={fxStyle}
        />
      );
    }
    return (
      <img
        src={displaySrc}
        alt=""
        draggable={false}
        style={fxStyle}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    );
  }

  // ── Positioned character sprite (at 有值，或默认 center) ──────────────────
  // `at` 未指定时默认居中，等同于传 "center"
  const effectiveAt = at ?? "center";
  const leftPct = atToLeftPercent(effectiveAt);
  const cssZIndex = isExpressionSprite(sprite.key)
    ? 2 + zIndex + FACE_ZINDEX_BONUS
    : 2 + zIndex;

  const charStyle: React.CSSProperties = {
    position: "absolute",
    bottom: 0,
    left: leftPct ?? "50%",
    transform: "translateX(-50%)",
    zIndex: cssZIndex,
    objectFit: "fill", // ← 改这里，不让浏览器再做额外缩放
    objectPosition: "bottom center",
    pointerEvents: "none",
    ...sizeStyle,
    ...opacityStyle,
  };

  if (isVideoPath(displaySrc)) {
    return (
      <video
        autoPlay
        loop
        muted
        playsInline
        src={displaySrc}
        style={charStyle}
      />
    );
  }
  return (
    <img
      src={displaySrc}
      alt=""
      draggable={false}
      style={charStyle}
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.display = "none";
      }}
    />
  );
};
