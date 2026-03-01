import React, {
  useState,
  useLayoutEffect,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import type { SpriteState } from "../types";
import { isVideoPath, atToLeftPercent, resolveAssetAsync } from "../assets";

/**
 * Returns true when a sprite key represents a face / expression layer.
 *
 * Expression keys contain a space separator (e.g. "yoichi playful1",
 * "hiro laugh2") while body keys use underscores (e.g. "yoichi_camp").
 * CG sprites also contain a space but always start with "cg ", so they are
 * explicitly excluded so they don't get the face bonus.
 */
function isExpressionSprite(key: string): boolean {
  const spaceIdx = key.indexOf(" ");
  return spaceIdx > 0 && !key.toLowerCase().startsWith("cg ");
}

/**
 * Returns true when the sprite should be rendered as a full-screen overlay
 * rather than a positioned character sprite.
 *
 * This covers:
 *  - Sprites explicitly placed at `fx_pos` (e.g. fx_natsumi, fx_yoichi)
 *  - Sprites placed at `truecenter` (e.g. cg_fade dimmer overlay)
 *  - Any sprite whose key starts with "fx_" regardless of position
 */
function isFxOverlay(key: string, at: string | undefined): boolean {
  if (at === "fx_pos" || at === "truecenter") return true;
  if (key.toLowerCase().startsWith("fx_")) return true;
  return false;
}

/**
 * Extra CSS z-index added to expression (face) sprites so they always render
 * above the body sprite at the same `at` position, regardless of the
 * insertion-order zIndex stored in the sprite state.
 */
const FACE_ZINDEX_BONUS = 1000;

interface SpriteLayerProps {
  sprites: SpriteState[];
}

/**
 * Renders all visible sprites (character bodies + faces, CGs, overlays).
 *
 * Loading strategy:
 * - Each sprite preloads its image before rendering (displaySrc starts null).
 * - Positioned character sprites are grouped by their `at` position. A group
 *   only becomes visible when every sprite in the group has finished loading.
 *   This prevents the body-without-face / face-without-body flicker on initial
 *   character appearance.
 * - React keys use sprite.zIndex (stable slot identity) rather than sprite.key
 *   so that expression changes (key name swap, same z-slot) keep the component
 *   alive. The component then preloads the new src and swaps displaySrc only
 *   after the new image is ready — old expression stays visible during the load,
 *   giving a seamless expression change with no gap.
 */
export const SpriteLayer: React.FC<SpriteLayerProps> = ({ sprites }) => {
  // zIndex → true once that sprite's current src is loaded
  const [loadedMap, setLoadedMap] = useState<Map<number, boolean>>(new Map());

  const onLoaded = useCallback((zIndex: number) => {
    setLoadedMap((prev) => {
      if (prev.get(zIndex)) return prev; // already marked, skip re-render
      const next = new Map(prev);
      next.set(zIndex, true);
      return next;
    });
  }, []);

  // Group positioned sprites by their `at` value so we can check whole-group readiness
  const atGroups = useMemo(() => {
    const groups = new Map<string, number[]>(); // at → [zIndex, ...]
    for (const s of sprites) {
      if (s.at) {
        const list = groups.get(s.at) ?? [];
        list.push(s.zIndex);
        groups.set(s.at, list);
      }
    }
    return groups;
  }, [sprites]);

  if (sprites.length === 0) return null;

  return (
    <div className="sprite-layer">
      {sprites.map((sprite) => {
        // A positioned sprite is only shown once ALL sprites at its position
        // have loaded (prevents body-only or face-only flash on first appear).
        // Full-screen / overlay sprites each show independently.
        let groupReady: boolean;
        if (sprite.at) {
          const groupZIndices = atGroups.get(sprite.at) ?? [sprite.zIndex];
          groupReady = groupZIndices.every((zi) => loadedMap.get(zi) === true);
        } else {
          groupReady = loadedMap.get(sprite.zIndex) === true;
        }

        return (
          <SpriteElement
            // Use zIndex as the React key (stable slot identity).
            // When a face expression changes the sprite.key changes but
            // zIndex stays the same, so this component is NOT remounted —
            // it smoothly preloads the next src while keeping the old one visible.
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
  /** True when every sprite in this element's position-group has loaded. */
  groupReady: boolean;
  onLoaded: (zIndex: number) => void;
}

const SpriteElement: React.FC<SpriteElementProps> = ({
  sprite,
  groupReady,
  onLoaded,
}) => {
  const { zIndex, src, at } = sprite;

  // resolvedSrc is the Blob URL (or video path) returned by the filesystem.
  // It is populated asynchronously; until then it is null.
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);

  // The src that is actually rendered. Starts null (nothing shown) and only
  // advances to a new src value after that image has finished loading.
  // This means:
  //   • Initial mount: invisible until loaded (displaySrc === null → return null)
  //   • src change (expression swap): keeps old src visible while preloading new
  const [displaySrc, setDisplaySrc] = useState<string | null>(null);

  // ── Step 1: resolve raw path → Blob URL via ZipFS / WebFetchFS ─────────────
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

  // ── Step 2: preload image once Blob URL is available ────────────────────────
  // Ensure we do not call setState synchronously inside the effect body.
  // For video paths we still want to avoid image preloading, but defer the
  // state update to a microtask so the linter rule is satisfied while the
  // visible behavior (old src stays until new is set) is preserved.
  useLayoutEffect(() => {
    if (!resolvedSrc) return;
    let cancelled = false;

    if (isVideoPath(resolvedSrc)) {
      // Videos do not require Image preloading. Schedule the state update on a
      // microtask so it's not synchronous within the effect body.
      Promise.resolve().then(() => {
        if (cancelled) return;
        setDisplaySrc(resolvedSrc);
        onLoaded(zIndex);
      });
      return () => {
        cancelled = true;
      };
    }

    const img = new Image();

    img.onload = () => {
      if (cancelled) return;
      setDisplaySrc(resolvedSrc);
      onLoaded(zIndex);
    };

    img.onerror = () => {
      if (cancelled) return;
      // Still mark as loaded so the rest of the group isn't blocked forever.
      setDisplaySrc(resolvedSrc);
      onLoaded(zIndex);
    };

    // Assign src after handlers are installed
    img.src = resolvedSrc;

    return () => {
      // Prevent handlers from running after cleanup
      cancelled = true;
      img.onload = null;
      img.onerror = null;
      // Clear the src to help the browser release the resource where possible.
      try {
        // Some environments may be strict about assigning an empty string;
        // guard to avoid throwing during unmount.
        img.src = "";
      } catch {
        // ignore
      }
    };
  }, [resolvedSrc, zIndex, onLoaded]);

  // Nothing to render until we have at least one loaded src
  if (displaySrc === null) return null;

  // FX / overlay sprite (fx_pos, truecenter, or key starts with "fx_") ───────
  // These are full-screen centered images (fire-lighting effects, dimmer
  // overlays, etc.) that must fill the whole viewport rather than being
  // treated as a positioned character sprite.  Rendered with objectFit:
  // "contain" so the entire image is visible, and at a z-index that keeps
  // them above regular character sprites but below the dialogue box (z 10)
  // and choice menu (z 20), so the dialogue text remains readable.
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
      opacity: groupReady ? 1 : 0,
      transition: "opacity 0.12s ease",
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

  // Positioned character sprite ──────────────────────────────────────────────
  if (at) {
    const leftPct = atToLeftPercent(at);
    // Expression (face) sprites must always render above body sprites at the
    // same position.  Add a large offset so the CSS stacking order is correct
    // even if the stored zIndex values are inverted (e.g. from a save file
    // that was created before the ordering was fixed).
    const cssZIndex = isExpressionSprite(sprite.key)
      ? 2 + zIndex + FACE_ZINDEX_BONUS
      : 2 + zIndex;

    const style: React.CSSProperties = {
      position: "absolute",
      bottom: 0,
      left: leftPct ?? "50%",
      transform: "translateX(-50%)",
      zIndex: cssZIndex,
      height: "95%",
      width: "auto",
      maxWidth: "45%",
      objectFit: "contain",
      objectPosition: "bottom center",
      pointerEvents: "none",
      // Fade in when the whole group (body + face) becomes ready together.
      // While groupReady is false we render with opacity 0 so layout is
      // reserved but nothing is visible.
      opacity: groupReady ? 1 : 0,
      transition: "opacity 0.12s ease",
    };

    if (isVideoPath(displaySrc)) {
      return (
        <video autoPlay loop muted playsInline src={displaySrc} style={style} />
      );
    }

    return (
      <img
        src={displaySrc}
        alt=""
        draggable={false}
        style={style}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    );
  }

  // Full-screen / overlay sprite (CG, scene element) ─────────────────────────
  const fullStyle: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",
    objectPosition: "center",
    zIndex: 2 + zIndex,
    pointerEvents: "none",
    opacity: groupReady ? 1 : 0,
    transition: "opacity 0.12s ease",
  };

  if (isVideoPath(displaySrc)) {
    return (
      <video
        autoPlay
        loop
        muted
        playsInline
        src={displaySrc}
        style={fullStyle}
      />
    );
  }

  return (
    <img
      src={displaySrc}
      alt=""
      draggable={false}
      style={fullStyle}
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.display = "none";
      }}
    />
  );
};
