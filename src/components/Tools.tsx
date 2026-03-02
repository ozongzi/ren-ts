import React, { useState, useEffect, useRef } from "react";
import { useGameStore } from "../store";
import type { GalleryEntry } from "../types";
import {
  isTauri,
  fsaSupported,
  pickDirectory,
  pickAndReadTextFile,
  pathExists,
} from "../tauri_bridge";
import {
  pickConverterFs,
  tauriConverterFsFromPath,
  type IConverterFs,
  type ConverterId,
  CancelledError,
} from "../converterFs";
import { convertRpy } from "../../rpy-rrs-bridge/rpy2rrs-core";
import { parseTranslationBlocks } from "../../rpy-rrs-bridge/translation-extractor";
import { parseGalleryRpy } from "../../rpy-rrs-bridge/parse-gallery-core";
import {
  generateImageDefines,
  renderDefinesBlock,
} from "../../rpy-rrs-bridge/scan-assets-core";

// ─── Types ────────────────────────────────────────────────────────────────────

type PathStatus = "ok" | "no" | "checking" | null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Debounced path-existence check.
 * On Tauri: verifies the path on disk.
 * On FSA (Chrome/Edge): paths are virtual relative strings; we just mark them
 * as "ok" once non-empty (real validation happens when the fs handle is used).
 * Returns a cleanup function.
 */
function checkPath(
  value: string | null,
  setStatus: (s: PathStatus) => void,
  timerRef: React.MutableRefObject<number | null>,
  enabled = true,
) {
  if (!value || !enabled) {
    setStatus(null);
    return;
  }
  if (timerRef.current) window.clearTimeout(timerRef.current);
  setStatus("checking");
  timerRef.current = window.setTimeout(async () => {
    try {
      if (isTauri) {
        setStatus((await pathExists(value)) ? "ok" : "no");
      } else {
        // FSA mode: the path is a relative sub-path the user typed; we
        // cannot verify it without an active handle, so just accept it.
        setStatus(value.length > 0 ? "ok" : "no");
      }
    } catch {
      setStatus("no");
    }
    timerRef.current = null;
  }, 350);
}

// ─── StatusDot ────────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: PathStatus }) {
  if (!status || status === "checking") {
    return (
      <span
        className={`status-dot ${status === "checking" ? "status-dot--loading" : ""}`}
        title={status === "checking" ? "检查中…" : "未检查"}
        aria-hidden
      />
    );
  }
  return (
    <span
      className={`status-dot ${status === "ok" ? "status-dot--ok" : "status-dot--error"}`}
      title={status === "ok" ? "路径存在" : "路径不存在"}
      aria-hidden
    />
  );
}

// ─── PathRow ──────────────────────────────────────────────────────────────────

function PathRow({
  value,
  onChange,
  placeholder,
  status,
  onBrowse,
  onClear,
  disabled,
  browseLabel = "浏览",
  browseDisabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  status: PathStatus;
  onBrowse: () => void;
  onClear: () => void;
  disabled: boolean;
  browseLabel?: string;
  /** Override for whether the browse button is disabled (defaults to !isTauri). */
  browseDisabled?: boolean;
}) {
  const canBrowse = browseDisabled !== undefined ? !browseDisabled : isTauri;
  return (
    <div className="path-row">
      <StatusDot status={status} />
      <input
        className="path-row__input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
      {value && (
        <button
          className="path-row__btn"
          onClick={onClear}
          disabled={disabled}
          aria-label="清除"
        >
          ✕
        </button>
      )}
      <button
        className="btn path-row__btn"
        onClick={onBrowse}
        disabled={!canBrowse || disabled}
        title={!canBrowse ? "路径浏览仅在 Tauri 桌面端可用" : undefined}
      >
        {browseLabel}
      </button>
    </div>
  );
}

// ─── SectionLabel ─────────────────────────────────────────────────────────────

function SectionLabel({
  children,
  optional,
}: {
  children: React.ReactNode;
  optional?: boolean;
}) {
  return (
    <div className="section-label">
      <span className="settings-label" style={{ marginBottom: 0 }}>
        {children}
      </span>
      {optional && <span className="tools-optional-tag">可选</span>}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export const Tools: React.FC = () => {
  const closeTools = useGameStore((s) => s.closeTools);

  // ── Game dir / fs handle ──────────────────────────────────────────────────
  // In Tauri mode: gameDir holds the absolute path string the user typed or
  // picked.  In FSA mode: gameDir holds the directory name (label) for display,
  // and gameFsRef holds the live IConverterFs rooted at that directory.
  const [gameDir, setGameDir] = useState<string | null>(null);
  const [gameDirStatus, setGameDirStatus] = useState<PathStatus>(null);
  const [converterKind, setConverterKind] = useState<ConverterId | null>(null);
  // Active IConverterFs for the chosen game dir (non-null once a dir is picked)
  const gameFsRef = useRef<IConverterFs | null>(null);

  // ── Optional features ─────────────────────────────────────────────────────
  const [enableTranslation, setEnableTranslation] = useState(false);
  const [translationDir, setTranslationDir] = useState<string | null>(null);
  const [translationDirStatus, setTranslationDirStatus] =
    useState<PathStatus>(null);

  const [enableGallery, setEnableGallery] = useState(false);
  const [galleryPath, setGalleryPath] = useState<string | null>(null);
  const [galleryPathStatus, setGalleryPathStatus] = useState<PathStatus>(null);

  // ── Run state ─────────────────────────────────────────────────────────────
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<
    "idle" | "converting" | "packing" | "done"
  >("idle");
  const [totalFiles, setTotalFiles] = useState(0);
  const [processedFiles, setProcessedFiles] = useState(0);
  const [zipProgress, setZipProgress] = useState(0);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [assetScanCount, setAssetScanCount] = useState<number | null>(null);

  const logRef = useRef<HTMLDivElement>(null);
  const gameDirTimer = useRef<number | null>(null);
  const translationDirTimer = useRef<number | null>(null);
  const galleryPathTimer = useRef<number | null>(null);

  const percent =
    totalFiles > 0 ? Math.round((processedFiles / totalFiles) * 100) : 0;

  // ── Path watchers ─────────────────────────────────────────────────────────
  useEffect(
    () => checkPath(gameDir, setGameDirStatus, gameDirTimer),
    [gameDir],
  );
  useEffect(
    () =>
      checkPath(
        translationDir,
        setTranslationDirStatus,
        translationDirTimer,
        enableTranslation,
      ),
    [translationDir, enableTranslation],
  );
  useEffect(
    () =>
      checkPath(
        galleryPath,
        setGalleryPathStatus,
        galleryPathTimer,
        enableGallery,
      ),
    [galleryPath, enableGallery],
  );

  useEffect(() => {
    return () => {
      [gameDirTimer, translationDirTimer, galleryPathTimer].forEach((r) => {
        if (r.current) window.clearTimeout(r.current);
      });
    };
  }, []);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const log = (s: string) => setLogs((l) => [...l, s]);

  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !running) closeTools();
  };

  // ── Apply chosen game dir ─────────────────────────────────────────────────
  /**
   * Called after the user picks a directory (either via Tauri dialog or FSA
   * picker).  `label` is the display string; `fs` is the ready IConverterFs.
   * Also pre-fills the optional sub-path fields.
   */
  function applyGameFs(label: string, fs: IConverterFs, kind: ConverterId) {
    setGameDir(label);
    setConverterKind(kind);
    gameFsRef.current = fs;
    // Pre-fill optional paths only when they are still empty
    if (!translationDir) setTranslationDir("tl/chinese");
    if (!galleryPath) setGalleryPath("gallery_images.rpy");
  }

  /**
   * Called when the user types a path manually in Tauri mode.
   * Builds a TauriConverterFs from the typed path and updates state.
   */
  function applyGameDirText(dir: string) {
    setGameDir(dir || null);
    setConverterKind(dir ? "tauri" : null);
    gameFsRef.current = dir ? tauriConverterFsFromPath(dir) : null;
    if (dir) {
      if (!translationDir) setTranslationDir("tl/chinese");
      if (!galleryPath) setGalleryPath("gallery_images.rpy");
    }
  }

  // ── Browse: pick game directory ───────────────────────────────────────────
  async function handleBrowseGameDir() {
    if (isTauri) {
      const path = await pickDirectory();
      if (!path) return;
      applyGameFs(path, tauriConverterFsFromPath(path), "tauri");
    } else if (fsaSupported) {
      const result = await pickConverterFs();
      if (!result) return;
      applyGameFs(result.fs.label, result.fs, result.kind);
    }
  }

  // ── Business logic ────────────────────────────────────────────────────────

  async function buildTranslationMap(
    fs: IConverterFs,
    dir: string,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      const files = await fs.walkDir(dir, (n) =>
        n.toLowerCase().endsWith(".rpy"),
      );
      for (const f of files) {
        const content = await fs.readText(f);
        if (!content) continue;
        try {
          const m = parseTranslationBlocks(content);
          for (const [k, v] of m.entries()) {
            if (!map.has(k)) map.set(k, v);
          }
          log(`已加载翻译：${f}`);
        } catch (err) {
          log(
            `解析翻译失败：${f} — ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      log(
        `构建翻译映射失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return map;
  }

  async function buildAssetDefinesBlock(
    fs: IConverterFs,
    dir: string,
  ): Promise<string | null> {
    try {
      const allFiles = await fs.walkDir(dir, () => true);
      const relativePaths = allFiles.map((f) => {
        // Strip the leading dir prefix to get the path relative to images/
        const prefix = dir ? dir + "/" : "";
        const rel = f.startsWith(prefix) ? f.slice(prefix.length) : f;
        return rel.replace(/\\/g, "/");
      });
      const result = generateImageDefines(relativePaths);
      setAssetScanCount(result.defines.length);
      for (const c of result.conflicts) {
        log(
          `  [资源扫描] key冲突 '${c.key}'：'${c.winner}' 优先于 '${c.loser}'`,
        );
      }
      log(
        `资源扫描：发现 ${result.defines.length} 个图片定义（跳过 ${result.skipped.length} 个非图片文件）`,
      );
      return renderDefinesBlock(
        result,
        "// Auto-generated image defines — do not edit manually",
      );
    } catch (err) {
      log(`资源扫描失败：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async function buildGalleryEntries(
    fs: IConverterFs,
    relPath: string,
  ): Promise<GalleryEntry[] | null> {
    try {
      const content = await fs.readText(relPath);
      if (!content) {
        log(`无法读取图鉴文件：${relPath}`);
        return null;
      }
      const entries = parseGalleryRpy(content);
      log(`解析到 ${entries.length} 个图鉴入口`);
      return entries;
    } catch (err) {
      log(`解析图鉴失败：${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async function runConversion(saveTarget?: unknown) {
    const fs = gameFsRef.current;
    if (running || !fs) return;

    const outDir = "data";
    const imagesDir = "images";

    setRunning(true);
    setPhase("converting");
    setLogs([]);
    setTotalFiles(0);
    setProcessedFiles(0);
    setCurrentFile(null);
    setAssetScanCount(null);
    setZipProgress(0);

    log(`开始扫描：${fs.label}`);

    try {
      // ── Translation ──────────────────────────────────────────────────────
      let translationMap: Map<string, string> | undefined;
      if (enableTranslation && translationDir) {
        log(`加载翻译目录：${translationDir}`);
        translationMap = await buildTranslationMap(fs, translationDir);
        log(`翻译映射大小：${translationMap.size}`);
      }

      // ── Gallery ───────────────────────────────────────────────────────────
      let galleryEntries: GalleryEntry[] | null = null;
      if (enableGallery && galleryPath) {
        log(`解析图鉴文件：${galleryPath}`);
        galleryEntries = await buildGalleryEntries(fs, galleryPath);
      }

      // ── Asset scan ────────────────────────────────────────────────────────
      let assetDefinesBlock: string | null = null;
      const imagesExists = await fs.exists(imagesDir);
      if (imagesExists) {
        log(`扫描资源目录：${imagesDir}`);
        assetDefinesBlock = await buildAssetDefinesBlock(fs, imagesDir);
      } else {
        log(`未找到 images 目录，跳过资源扫描`);
      }

      // ── Convert .rpy → .rrs ───────────────────────────────────────────────
      const rpyFiles = await fs.walkDir("", (n) =>
        n.toLowerCase().endsWith(".rpy"),
      );
      log(`发现 ${rpyFiles.length} 个 .rpy 文件`);
      setTotalFiles(rpyFiles.length);

      const writtenFiles: string[] = [];

      for (const relPath of rpyFiles) {
        setCurrentFile(relPath);
        try {
          const content = await fs.readText(relPath);
          if (content === null) {
            log(`读取失败：${relPath}`);
            setProcessedFiles((n) => n + 1);
            continue;
          }
          const rrsName = relPath.replace(/\.rpy$/i, ".rrs");
          const outPath = `${outDir}/${rrsName}`;
          const rrs = convertRpy(content, rrsName, translationMap);
          await fs.writeText(outPath, rrs);
          writtenFiles.push(rrsName);
          setProcessedFiles((n) => n + 1);
          log(`转换：${rrsName}`);
        } catch (err) {
          log(
            `失败：${relPath} — ${err instanceof Error ? err.message : String(err)}`,
          );
          setProcessedFiles((n) => n + 1);
        }
      }

      // ── Write image_defines.rrs ───────────────────────────────────────────
      if (assetDefinesBlock) {
        try {
          await fs.writeText(
            `${outDir}/image_defines.rrs`,
            `// Source: image_defines.rrs\n\n` + assetDefinesBlock,
          );
          log(`已生成资源定义文件：image_defines.rrs`);
        } catch (err) {
          log(
            `写入 image_defines.rrs 失败：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // ── Write manifest.json ───────────────────────────────────────────────
      setCurrentFile(null);
      try {
        const manifestPath = `${outDir}/manifest.json`;
        let manifest: Record<string, unknown> = {};
        const existingText = await fs.readText(manifestPath);
        if (existingText) {
          try {
            manifest = JSON.parse(existingText);
          } catch {
            manifest = {};
          }
        }
        manifest["files"] = writtenFiles;
        if (enableGallery && galleryEntries)
          manifest["gallery"] = galleryEntries;
        if (assetDefinesBlock) {
          const existing = Array.isArray(manifest["files"])
            ? (manifest["files"] as string[])
            : [];
          if (!existing.includes("image_defines.rrs")) {
            manifest["files"] = ["image_defines.rrs", ...existing];
          }
        }
        await fs.writeText(manifestPath, JSON.stringify(manifest, null, 2));
        log(`已更新 manifest.json（${writtenFiles.length} 个文件）`);
      } catch (err) {
        log(
          `写入 manifest.json 失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }

      setProcessedFiles((prev) => (totalFiles > prev ? totalFiles : prev));
      log("✓ 转换完成。");

      // ── Pack ZIP ──────────────────────────────────────────────────────────
      log("──────────────────────────");
      log("正在收集文件列表…");
      setPhase("packing");
      setZipProgress(0);

      try {
        // Collect data/ files to pack
        const dataFiles = await fs.walkDir(outDir, () => true);
        const filesToPack: string[] = dataFiles.map((f) => f);

        // Also collect game assets (images, audio, video) for the zip
        const IMAGE_EXT = /\.(png|jpg|jpeg|webp|gif|bmp|avif)$/i;
        const AUDIO_EXT = /\.(mp3|ogg|wav|flac|opus|m4a)$/i;
        const VIDEO_EXT = /\.(mp4|webm|ogv|mov)$/i;
        const isAsset = (name: string) =>
          IMAGE_EXT.test(name) || AUDIO_EXT.test(name) || VIDEO_EXT.test(name);

        const assetFiles = await fs.walkDir("", isAsset);
        for (const f of assetFiles) {
          filesToPack.push(f);
        }

        log(`共 ${filesToPack.length} 个文件待打包…`);

        let skippedCount = 0;
        await fs.buildZip(
          filesToPack,
          ({ index, total: tot }) => {
            setZipProgress(Math.round(((index + 1) / tot) * 95));
          },
          (relPath) => {
            log(`  跳过（读取失败）：${relPath}`);
            skippedCount++;
          },
          saveTarget,
        );

        setZipProgress(100);
        log(
          `✓ 打包完成${skippedCount > 0 ? `，${skippedCount} 个文件跳过` : ""}`,
        );
        setPhase("done");
      } catch (err) {
        if (err instanceof CancelledError) {
          log("已取消打包。");
          setPhase("idle");
        } else {
          log(`打包失败：${err instanceof Error ? err.message : String(err)}`);
          setPhase("idle");
        }
      }
    } catch (err) {
      log(`运行出错：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  }

  // ── Derived display ───────────────────────────────────────────────────────
  const statusLabel =
    phase === "converting"
      ? "转换中…"
      : phase === "packing"
        ? "打包中…"
        : phase === "done"
          ? "✓ 完成"
          : "就绪";

  const btnLabel = running
    ? phase === "packing"
      ? "◌  打包中…"
      : "◌  转换中…"
    : "▶  转换并打包";

  const canRun = !running && !!gameFsRef.current;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className="modal-overlay"
      onClick={handleBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label="工具"
    >
      <div
        className="modal-panel"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "min(640px, 94vw)" }}
      >
        {/* ── Header ── */}
        <div className="modal-header">
          <h2 className="modal-title">⚙️ Ren'Py → RRS 转换器</h2>
          <button
            className="modal-close-btn"
            onClick={closeTools}
            disabled={running}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        {/* ── Section 1: Game 目录 ── */}
        <div className="settings-group">
          <SectionLabel>Game 目录</SectionLabel>

          {/* FSA mode: single "pick directory" button replaces the path input */}
          {!isTauri && fsaSupported ? (
            <div
              style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}
            >
              <button
                className="btn"
                onClick={handleBrowseGameDir}
                disabled={running}
                style={{ flex: "0 0 auto" }}
              >
                📂 选择 Game 目录
              </button>
              {gameDir && (
                <>
                  <span
                    className="status-dot status-dot--ok"
                    title="目录已选择"
                    aria-hidden
                  />
                  <span
                    style={{
                      fontSize: "0.82rem",
                      color: "var(--color-text-dim)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={gameDir}
                  >
                    {gameDir}
                  </span>
                  <button
                    className="path-row__btn"
                    onClick={() => {
                      setGameDir(null);
                      setConverterKind(null);
                      gameFsRef.current = null;
                      setGameDirStatus(null);
                    }}
                    disabled={running}
                    aria-label="取消选择目录"
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          ) : (
            /* Tauri mode: path input + browse button */
            <PathRow
              value={gameDir ?? ""}
              onChange={(v) => applyGameDirText(v)}
              placeholder="选择包含 .rpy 文件的 game 目录"
              status={gameDirStatus}
              onBrowse={handleBrowseGameDir}
              onClear={() => {
                setGameDir(null);
                setConverterKind(null);
                gameFsRef.current = null;
                setGameDirStatus(null);
              }}
              disabled={running}
            />
          )}

          <p className="tools-hint">
            {isTauri ? (
              <>
                选择后自动推断输出目录（
                <code style={{ fontFamily: "var(--font-mono)" }}>
                  game/data/
                </code>
                ）、资源目录（
                <code style={{ fontFamily: "var(--font-mono)" }}>
                  game/images/
                </code>
                ）。
              </>
            ) : (
              <>
                授权后可读写该目录下的所有文件。转换结果写入{" "}
                <code style={{ fontFamily: "var(--font-mono)" }}>data/</code>{" "}
                子目录，打包后通过浏览器下载 ZIP。
              </>
            )}
            {assetScanCount !== null && (
              <span className="tools-asset-count">
                上次扫描：{assetScanCount} 个图片定义
              </span>
            )}
          </p>
        </div>

        <div className="divider" />

        {/* ── Section 2: 翻译 ── */}
        <div className="settings-group">
          <label className="tools-optional-row">
            <input
              type="checkbox"
              className="tools-optional-checkbox"
              checked={enableTranslation}
              onChange={(e) => setEnableTranslation(e.target.checked)}
              disabled={running}
            />
            <span className="settings-label" style={{ marginBottom: 0 }}>
              翻译目录
            </span>
            <span className="tools-optional-tag">可选</span>
          </label>
          <PathRow
            value={translationDir ?? ""}
            onChange={(v) => setTranslationDir(v || null)}
            placeholder={
              isTauri ? "game/tl/chinese（绝对路径）" : "tl/chinese（相对路径）"
            }
            status={translationDirStatus}
            onBrowse={async () => {
              if (!isTauri) return;
              const dir = await pickDirectory();
              if (dir) setTranslationDir(dir);
            }}
            onClear={() => {
              setTranslationDir(null);
              setTranslationDirStatus(null);
            }}
            disabled={running || !enableTranslation}
            browseLabel="浏览"
          />
          {!isTauri && fsaSupported && enableTranslation && (
            <p className="tools-hint">
              在 Chrome / Edge 中输入相对于 game 目录的路径，例如{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>tl/chinese</code>
              。
            </p>
          )}
        </div>

        <div className="divider" />

        {/* ── Section 3: 图鉴 ── */}
        <div className="settings-group">
          <label className="tools-optional-row">
            <input
              type="checkbox"
              className="tools-optional-checkbox"
              checked={enableGallery}
              onChange={(e) => setEnableGallery(e.target.checked)}
              disabled={running}
            />
            <span className="settings-label" style={{ marginBottom: 0 }}>
              图鉴文件
            </span>
            <span className="tools-optional-tag">可选</span>
          </label>
          <PathRow
            value={galleryPath ?? ""}
            onChange={(v) => setGalleryPath(v || null)}
            placeholder={
              isTauri
                ? "gallery_images.rpy 路径（绝对）"
                : "gallery_images.rpy（相对路径）"
            }
            status={galleryPathStatus}
            onBrowse={async () => {
              if (!isTauri) return;
              const res = await pickAndReadTextFile({
                title: "选择 gallery_images.rpy",
                filters: [
                  { name: "Ren'Py Script", extensions: ["rpy", "rpym"] },
                ],
              });
              if (res) {
                setGalleryPath(res.path);
                log(`选择图鉴文件：${res.path}`);
              }
            }}
            onClear={() => {
              setGalleryPath(null);
              setGalleryPathStatus(null);
            }}
            disabled={running || !enableGallery}
            browseLabel="浏览"
          />
          {!isTauri && fsaSupported && enableGallery && (
            <p className="tools-hint">
              输入相对于 game 目录的路径，例如{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>
                gallery_images.rpy
              </code>
              。
            </p>
          )}
        </div>

        <div className="divider" />

        {/* ── Progress ── */}
        <div className="settings-group" style={{ marginBottom: "0.75rem" }}>
          <div className="tools-progress-header">
            <span
              className={`tools-progress-label ${
                phase === "done"
                  ? "tools-progress-label--done"
                  : running
                    ? "tools-progress-label--running"
                    : "tools-progress-label--idle"
              }`}
            >
              {statusLabel}
            </span>
            <span className="tools-progress-count">
              {phase === "packing"
                ? `${zipProgress}%`
                : totalFiles > 0
                  ? `${processedFiles} / ${totalFiles} — ${percent}%`
                  : null}
            </span>
          </div>

          {/* Conversion progress bar */}
          {totalFiles > 0 && phase !== "packing" && (
            <div className="tools-progress-bar-wrap">
              <div
                className={`tools-progress-bar ${phase === "done" ? "tools-progress-bar--convert-done" : "tools-progress-bar--convert"}`}
                style={{ width: `${percent}%` }}
              />
            </div>
          )}

          {/* ZIP progress bar */}
          {phase === "packing" || (phase === "done" && zipProgress === 100) ? (
            <div className="tools-progress-bar-wrap">
              <div
                className={`tools-progress-bar ${zipProgress === 100 ? "tools-progress-bar--zip-done" : "tools-progress-bar--zip"}`}
                style={{ width: `${zipProgress}%` }}
              />
            </div>
          ) : null}

          {currentFile && running && (
            <p className="tools-current-file">› {currentFile}</p>
          )}
        </div>

        {/* ── Actions ── */}
        <div className="tools-actions">
          <button
            className="btn primary tools-run-btn"
            onClick={async () => {
              setPhase("idle");
              setZipProgress(0);
              // Pre-acquire the save-file target while still inside the user
              // gesture.  showSaveFilePicker (FSA) and the Tauri save dialog
              // both require a user gesture — calling them after multiple
              // awaits loses that context and throws a security error.
              const fs = gameFsRef.current;
              let saveTarget: unknown = undefined;
              if (fs) {
                try {
                  const target = await fs.pickZipSaveTarget();
                  if (target == null) return; // user cancelled the picker
                  saveTarget = target;
                } catch {
                  // On Tauri the dialog may not be needed at this stage;
                  // let runConversion handle any further errors.
                  saveTarget = undefined;
                }
              }
              runConversion(saveTarget);
            }}
            disabled={!canRun}
            title={
              !gameFsRef.current
                ? isTauri
                  ? "请先填写 Game 目录"
                  : "请先点击「选择 Game 目录」授权访问"
                : undefined
            }
          >
            {btnLabel}
          </button>
          <button
            className="btn"
            onClick={() => {
              setLogs([]);
              setPhase("idle");
              setZipProgress(0);
              setTotalFiles(0);
              setProcessedFiles(0);
              setCurrentFile(null);
              setAssetScanCount(null);
            }}
            disabled={running}
          >
            清空
          </button>
        </div>

        {/* ── Log ── */}
        <div>
          <div className="settings-label">输出日志</div>
          <div ref={logRef} className="tools-log-wrap">
            {logs.length === 0 ? (
              <span className="tools-log-empty">暂无输出</span>
            ) : (
              logs.map((l, i) => (
                <div
                  key={i}
                  className={`tools-log-line ${
                    l.startsWith("失败") || l.includes("失败")
                      ? "tools-log-line--error"
                      : l.startsWith("✓")
                        ? "tools-log-line--success"
                        : ""
                  }`}
                >
                  {l}
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── platform kind indicator (subtle footer) ── */}
        {converterKind && (
          <p
            style={{
              marginTop: "0.5rem",
              fontSize: "0.72rem",
              color: "rgba(255,255,255,0.2)",
              textAlign: "right",
            }}
          >
            {converterKind === "tauri"
              ? "模式：Tauri 原生"
              : "模式：浏览器 FSA"}
          </p>
        )}
      </div>
    </div>
  );
};
