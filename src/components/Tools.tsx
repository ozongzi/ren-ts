import React, { useState, useEffect, useRef } from "react";
import { useGameStore } from "../store";
import type { GalleryEntry } from "../types";
import {
  isTauri,
  pickDirectory,
  pickAndReadTextFile,
  pickSavePath,
  readTextFileTauri,
  writeTextFileTauri,
  makeDirTauri,
  pathExists,
  walkDir,
  streamingBuildZip,
  type ZipFileEntry,
} from "../tauri_bridge";
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

/** Debounced path existence check. Returns a cleanup fn. */
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
      setStatus(!isTauri ? null : (await pathExists(value)) ? "ok" : "no");
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
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  status: PathStatus;
  onBrowse: () => void;
  onClear: () => void;
  disabled: boolean;
  browseLabel?: string;
}) {
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
        disabled={!isTauri || disabled}
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

  // ── Required ──────────────────────────────────────────────────────────────
  const [gameDir, setGameDir] = useState<string | null>(null);
  const [gameDirStatus, setGameDirStatus] = useState<PathStatus>(null);

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

  // ── Auto-fill helpers from gameDir ────────────────────────────────────────
  function applyGameDir(dir: string) {
    setGameDir(dir);
    if (!translationDir) setTranslationDir(`${dir}/tl/chinese`);
    if (!galleryPath) setGalleryPath(`${dir}/gallery_images.rpy`);
  }

  // ── Business logic ────────────────────────────────────────────────────────

  async function buildTranslationMap(
    dir: string,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!isTauri) return map;
    try {
      const files = await walkDir(dir, (n) => n.toLowerCase().endsWith(".rpy"));
      for (const f of files) {
        const content = await readTextFileTauri(f);
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

  async function buildAssetDefinesBlock(dir: string): Promise<string | null> {
    if (!isTauri) return null;
    try {
      const allFiles = await walkDir(dir, () => true);
      const relativePaths = allFiles.map((f) => {
        const rel = f.startsWith(dir)
          ? f.slice(dir.length).replace(/^\/+/, "")
          : (f.split("/").pop() ?? f);
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
    path: string,
  ): Promise<GalleryEntry[] | null> {
    if (!isTauri) return null;
    try {
      const content = await readTextFileTauri(path);
      if (!content) {
        log(`无法读取图鉴文件：${path}`);
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

  async function runConversion() {
    if (running || !gameDir) return;
    if (!isTauri) {
      log("仅在 Tauri 环境下支持文件系统操作。");
      return;
    }

    const outDir = `${gameDir}/data`;
    // Images dir for asset defines
    const imagesDir = `${gameDir}/images`;

    setRunning(true);
    setPhase("converting");
    setLogs([]);
    setTotalFiles(0);
    setProcessedFiles(0);
    setCurrentFile(null);
    setAssetScanCount(null);
    setZipProgress(0);

    log(`开始扫描：${gameDir}`);

    try {
      // ── Translation ──────────────────────────────────────────────────────
      let translationMap: Map<string, string> | undefined;
      if (enableTranslation && translationDir) {
        log(`加载翻译目录：${translationDir}`);
        translationMap = await buildTranslationMap(translationDir);
        log(`翻译映射大小：${translationMap.size}`);
      }

      // ── Gallery ───────────────────────────────────────────────────────────
      let galleryEntries: GalleryEntry[] | null = null;
      if (enableGallery && galleryPath) {
        log(`解析图鉴文件：${galleryPath}`);
        galleryEntries = await buildGalleryEntries(galleryPath);
      }

      // ── Asset scan (always from game/images) ──────────────────────────────
      let assetDefinesBlock: string | null = null;
      const imagesExists = await pathExists(imagesDir);
      if (imagesExists) {
        log(`扫描资源目录：${imagesDir}`);
        assetDefinesBlock = await buildAssetDefinesBlock(imagesDir);
      } else {
        log(`未找到 images 目录，跳过资源扫描：${imagesDir}`);
      }

      // ── Convert .rpy → .rrs ───────────────────────────────────────────────
      const rpyFiles = await walkDir(gameDir, (n) =>
        n.toLowerCase().endsWith(".rpy"),
      );
      log(`发现 ${rpyFiles.length} 个 .rpy 文件`);
      setTotalFiles(rpyFiles.length);

      const writtenFiles: string[] = [];

      for (const fullPath of rpyFiles) {
        const relPreview = fullPath.startsWith(gameDir)
          ? fullPath.slice(gameDir.length).replace(/^\/+/, "")
          : (fullPath.split("/").pop() ?? fullPath);
        setCurrentFile(relPreview);
        try {
          const content = await readTextFileTauri(fullPath);
          if (content === null) {
            log(`读取失败：${fullPath}`);
            setProcessedFiles((n) => n + 1);
            continue;
          }
          const rel = fullPath.startsWith(gameDir)
            ? fullPath.slice(gameDir.length).replace(/^\/+/, "")
            : (fullPath.split("/").pop() ?? fullPath);
          const rrsName = rel.replace(/\.rpy$/i, ".rrs");
          const outPath = `${outDir}/${rrsName}`;
          const outParent = outPath.replace(/\/[^/]+$/, "");
          if (!(await pathExists(outParent))) await makeDirTauri(outParent);
          const rrs = convertRpy(content, rrsName, translationMap);
          await writeTextFileTauri(outPath, rrs);
          writtenFiles.push(rrsName);
          setProcessedFiles((n) => n + 1);
          log(`转换：${rrsName}`);
        } catch (err) {
          log(
            `失败：${fullPath} — ${err instanceof Error ? err.message : String(err)}`,
          );
          setProcessedFiles((n) => n + 1);
        }
      }

      // ── Write image_defines.rrs ───────────────────────────────────────────
      if (assetDefinesBlock) {
        const definesPath = `${outDir}/image_defines.rrs`;
        try {
          await writeTextFileTauri(
            definesPath,
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
        const existingText = await readTextFileTauri(manifestPath);
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
        await writeTextFileTauri(
          manifestPath,
          JSON.stringify(manifest, null, 2),
        );
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
      log("请选择 ZIP 输出位置…");

      const zipOutputPath = await pickSavePath({
        title: "保存 assets.zip",
        defaultPath: `assets.zip`,
        filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
      });

      if (!zipOutputPath) {
        log("已取消打包。");
        setPhase("idle");
        setRunning(false);
        return;
      }

      log("开始打包 ZIP…");
      setPhase("packing");
      setZipProgress(0);

      try {
        // Collect data/ files
        const dataFiles = await walkDir(outDir, () => true);
        type FileToPack = { absPath: string; zipPath: string };
        const filesToPack: FileToPack[] = [];

        for (const abs of dataFiles) {
          const rel = abs.startsWith(outDir)
            ? abs.slice(outDir.length).replace(/^\/+/, "")
            : (abs.split("/").pop() ?? abs);
          filesToPack.push({ absPath: abs, zipPath: `data/${rel}` });
        }

        // Collect all top-level subdirectories of gameDir as asset dirs
        // (images/, Audio/, videos/, BGM/, SE/, …)
        const IMAGE_EXT = /\.(png|jpg|jpeg|webp|gif|bmp|avif)$/i;
        const AUDIO_EXT = /\.(mp3|ogg|wav|flac|opus|m4a)$/i;
        const VIDEO_EXT = /\.(mp4|webm|ogv|mov)$/i;
        const isAsset = (name: string) =>
          IMAGE_EXT.test(name) || AUDIO_EXT.test(name) || VIDEO_EXT.test(name);

        const assetFiles = await walkDir(gameDir, isAsset);
        for (const abs of assetFiles) {
          const rel = abs.startsWith(gameDir)
            ? abs.slice(gameDir.length).replace(/^\/+/, "")
            : (abs.split("/").pop() ?? abs);
          filesToPack.push({ absPath: abs, zipPath: rel });
        }

        log(`共 ${filesToPack.length} 个文件待打包…`);

        const zipDir = zipOutputPath.replace(/\/[^/]+$/, "");
        if (!(await pathExists(zipDir))) await makeDirTauri(zipDir);

        log("正在流式写入 ZIP…");
        const zipFilesToPack: ZipFileEntry[] = filesToPack;
        let skippedCount = 0;
        const writtenCount = await streamingBuildZip(
          zipOutputPath,
          zipFilesToPack,
          ({ index, total: tot, zipPath: zp }) => {
            setZipProgress(Math.round(((index + 1) / tot) * 95));
            setCurrentFile(zp);
          },
          (absPath, zipPath) => {
            log(`  跳过（读取失败）：${zipPath} (${absPath})`);
            skippedCount++;
          },
        );
        setZipProgress(100);
        log(
          `✓ 打包完成：${zipOutputPath}  (${writtenCount} 文件写入${skippedCount > 0 ? `，${skippedCount} 个跳过` : ""})`,
        );
        setPhase("done");
      } catch (err) {
        log(`打包失败：${err instanceof Error ? err.message : String(err)}`);
        setPhase("idle");
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
          <PathRow
            value={gameDir ?? ""}
            onChange={(v) => applyGameDir(v || "")}
            placeholder="选择包含 .rpy 文件的 game 目录"
            status={gameDirStatus}
            onBrowse={async () => {
              if (!isTauri) return;
              const dir = await pickDirectory();
              if (dir) applyGameDir(dir);
            }}
            onClear={() => {
              setGameDir(null);
              setGameDirStatus(null);
            }}
            disabled={running}
          />
          <p className="tools-hint">
            选择后自动推断输出目录（
            <code style={{ fontFamily: "var(--font-mono)" }}>game/data/</code>
            ）、 资源目录（
            <code style={{ fontFamily: "var(--font-mono)" }}>game/images/</code>
            ）。
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
            placeholder="game/tl/chinese"
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
            placeholder="gallery_images.rpy 路径"
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
            onClick={() => {
              setPhase("idle");
              setZipProgress(0);
              runConversion();
            }}
            disabled={running || !gameDir || !isTauri}
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
      </div>
    </div>
  );
};
