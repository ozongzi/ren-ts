import React, { useState, useEffect, useRef } from "react";
import { useGameStore } from "../store";
import type { GalleryEntry } from "../types";
import {
  isTauri,
  pickDirectory,
  pickAndReadTextFile,
  readTextFileTauri,
  writeTextFileTauri,
  makeDirTauri,
  pathExists,
  walkDir,
} from "../tauri_bridge";
import { convertRpy } from "../../rpy-rrs-bridge/rpy2rrs-core";
import { parseTranslationBlocks } from "../../rpy-rrs-bridge/translation-extractor";
import { parseGalleryRpy } from "../../rpy-rrs-bridge/parse-gallery-core";
import {
  generateImageDefines,
  renderDefinesBlock,
} from "../../rpy-rrs-bridge/scan-assets-core";

/* ─── Inline Styles ───────────────────────────────────────────────────────── */

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Syne:wght@400;600;700;800&display=swap');

  .tools-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.72);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    font-family: 'JetBrains Mono', monospace;
  }

  .tools-panel {
    width: min(780px, calc(100vw - 2rem));
    max-height: calc(100vh - 3rem);
    overflow-y: auto;
    background: #0d0f10;
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 14px;
    box-shadow:
      0 0 0 1px rgba(255,255,255,0.04) inset,
      0 40px 80px rgba(0,0,0,0.7),
      0 0 60px rgba(110,231,183,0.03);
    position: relative;
    display: flex;
    flex-direction: column;
  }

  .tools-panel::-webkit-scrollbar { width: 4px; }
  .tools-panel::-webkit-scrollbar-track { background: transparent; }
  .tools-panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 4px; }

  /* ── Header ── */
  .tools-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.1rem 1.4rem;
    border-bottom: 1px solid rgba(255,255,255,0.05);
    position: sticky;
    top: 0;
    background: #0d0f10;
    z-index: 10;
    border-radius: 14px 14px 0 0;
  }

  .tools-title-wrap {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .tools-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    background: rgba(110,231,183,0.08);
    border: 1px solid rgba(110,231,183,0.18);
    border-radius: 6px;
    padding: 0.2rem 0.5rem;
    font-size: 0.65rem;
    color: #6ee7b7;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font-weight: 600;
  }

  .tools-title {
    font-family: 'Syne', sans-serif;
    font-size: 1.05rem;
    font-weight: 700;
    color: #f0f0f0;
    margin: 0;
    letter-spacing: -0.01em;
  }

  .tools-close {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.07);
    background: rgba(255,255,255,0.03);
    color: rgba(255,255,255,0.4);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    transition: all 180ms ease;
  }
  .tools-close:hover:not(:disabled) {
    background: rgba(255,100,100,0.1);
    border-color: rgba(255,100,100,0.25);
    color: #ff8a8a;
  }
  .tools-close:disabled { opacity: 0.3; cursor: not-allowed; }

  /* ── Body ── */
  .tools-body {
    padding: 1.2rem 1.4rem;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  /* ── Section ── */
  .tools-section {
    padding: 1rem 0;
    border-bottom: 1px solid rgba(255,255,255,0.04);
  }
  .tools-section:last-child { border-bottom: none; }

  .section-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.65rem;
  }

  .section-num {
    font-size: 0.6rem;
    font-weight: 700;
    color: #6ee7b7;
    letter-spacing: 0.1em;
    background: rgba(110,231,183,0.08);
    border: 1px solid rgba(110,231,183,0.15);
    border-radius: 4px;
    padding: 0.15rem 0.38rem;
    font-family: 'JetBrains Mono', monospace;
  }

  .section-title {
    font-family: 'Syne', sans-serif;
    font-size: 0.82rem;
    font-weight: 700;
    color: rgba(255,255,255,0.75);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .section-hint {
    font-size: 0.72rem;
    color: rgba(255,255,255,0.28);
    line-height: 1.5;
    margin-top: 0.45rem;
    padding-left: 0.05rem;
  }

  /* ── Path Row ── */
  .path-row {
    display: flex;
    gap: 0.45rem;
    align-items: center;
  }

  .path-input {
    flex: 1;
    padding: 0.5rem 0.7rem;
    border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.07);
    background: rgba(255,255,255,0.025);
    color: rgba(255,255,255,0.82);
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.78rem;
    outline: none;
    transition: border-color 180ms ease, background 180ms ease;
    min-width: 0;
  }
  .path-input::placeholder { color: rgba(255,255,255,0.2); }
  .path-input:focus {
    border-color: rgba(110,231,183,0.3);
    background: rgba(255,255,255,0.04);
  }
  .path-input:disabled { opacity: 0.4; cursor: not-allowed; }

  /* ── Status dot ── */
  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    transition: background 250ms ease, box-shadow 250ms ease;
  }
  .status-dot.ok {
    background: #6ee7b7;
    box-shadow: 0 0 6px rgba(110,231,183,0.5);
  }
  .status-dot.no {
    background: #f87171;
    box-shadow: 0 0 6px rgba(248,113,113,0.4);
  }
  .status-dot.checking {
    background: #fbbf24;
    box-shadow: 0 0 6px rgba(251,191,36,0.4);
    animation: pulse-dot 0.8s ease-in-out infinite;
  }
  .status-dot.idle { background: rgba(255,255,255,0.12); }

  @keyframes pulse-dot {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  /* ── Buttons ── */
  .btn {
    padding: 0.45rem 0.8rem;
    border-radius: 7px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.74rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 160ms ease;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .btn:disabled { opacity: 0.35; cursor: not-allowed; }

  .btn-ghost {
    border: 1px solid rgba(255,255,255,0.07);
    background: rgba(255,255,255,0.035);
    color: rgba(255,255,255,0.55);
  }
  .btn-ghost:hover:not(:disabled) {
    background: rgba(255,255,255,0.07);
    color: rgba(255,255,255,0.8);
    border-color: rgba(255,255,255,0.13);
  }

  .btn-ghost-sm {
    padding: 0.32rem 0.55rem;
    font-size: 0.68rem;
    border: 1px solid rgba(255,255,255,0.05);
    background: transparent;
    color: rgba(255,255,255,0.28);
  }
  .btn-ghost-sm:hover:not(:disabled) {
    background: rgba(255,80,80,0.08);
    border-color: rgba(255,80,80,0.2);
    color: #f87171;
  }

  .btn-primary {
    border: 1px solid rgba(59,130,246,0.4);
    background: linear-gradient(160deg, rgba(59,130,246,0.25), rgba(37,99,235,0.3));
    color: #93c5fd;
    letter-spacing: 0.03em;
    box-shadow: 0 0 16px rgba(59,130,246,0.08), 0 1px 2px rgba(0,0,0,0.3);
  }
  .btn-primary:hover:not(:disabled) {
    background: linear-gradient(160deg, rgba(59,130,246,0.38), rgba(37,99,235,0.45));
    border-color: rgba(59,130,246,0.6);
    color: #bfdbfe;
    box-shadow: 0 0 22px rgba(59,130,246,0.18);
  }
  .btn-primary.running {
    background: linear-gradient(160deg, rgba(59,130,246,0.14), rgba(37,99,235,0.18));
    color: rgba(147,197,253,0.5);
    animation: shimmer 1.8s ease-in-out infinite;
  }

  @keyframes shimmer {
    0%, 100% { box-shadow: 0 0 12px rgba(59,130,246,0.06); }
    50% { box-shadow: 0 0 22px rgba(59,130,246,0.18); }
  }

  /* ── Toggle Option ── */
  .toggle-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.6rem;
    cursor: pointer;
    width: fit-content;
    user-select: none;
  }

  .toggle-checkbox {
    appearance: none;
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    border: 1px solid rgba(255,255,255,0.18);
    border-radius: 4px;
    background: rgba(255,255,255,0.04);
    cursor: pointer;
    position: relative;
    flex-shrink: 0;
    transition: all 160ms ease;
  }
  .toggle-checkbox:checked {
    background: rgba(110,231,183,0.2);
    border-color: rgba(110,231,183,0.5);
  }
  .toggle-checkbox:checked::after {
    content: '';
    position: absolute;
    left: 3px;
    top: 1px;
    width: 5px;
    height: 8px;
    border: 1.5px solid #6ee7b7;
    border-top: none;
    border-left: none;
    transform: rotate(42deg);
    display: block;
  }
  .toggle-checkbox:disabled { opacity: 0.3; cursor: not-allowed; }

  .toggle-label {
    font-size: 0.76rem;
    color: rgba(255,255,255,0.5);
    letter-spacing: 0.01em;
  }
  .toggle-row:hover .toggle-label { color: rgba(255,255,255,0.7); }

  /* ── Progress Area ── */
  .progress-section {
    padding: 1rem 0 0.5rem;
  }

  .progress-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 0.55rem;
  }

  .progress-status {
    font-family: 'Syne', sans-serif;
    font-size: 0.78rem;
    font-weight: 700;
    color: rgba(255,255,255,0.6);
    text-transform: uppercase;
    letter-spacing: 0.07em;
  }
  .progress-status.running { color: #6ee7b7; }

  .progress-count {
    font-size: 0.72rem;
    color: rgba(255,255,255,0.25);
    font-family: 'JetBrains Mono', monospace;
  }

  .progress-bar-bg {
    height: 4px;
    background: rgba(255,255,255,0.05);
    border-radius: 99px;
    overflow: hidden;
    margin-bottom: 0.5rem;
  }

  .progress-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, #6ee7b7, #3b82f6);
    border-radius: 99px;
    transition: width 280ms ease;
    position: relative;
  }
  .progress-bar-fill::after {
    content: '';
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 20px;
    background: rgba(255,255,255,0.35);
    filter: blur(4px);
    animation: progress-glow 1.5s ease-in-out infinite;
  }

  @keyframes progress-glow {
    0%, 100% { opacity: 0; }
    50% { opacity: 1; }
  }

  .current-file-tag {
    font-size: 0.7rem;
    color: rgba(255,255,255,0.22);
    font-family: 'JetBrains Mono', monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0.3rem 0;
  }
  .current-file-tag span { color: rgba(110,231,183,0.5); margin-right: 0.4rem; }

  .action-row {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }

  /* ── Log ── */
  .log-section {
    padding-top: 1rem;
  }

  .log-title {
    font-family: 'Syne', sans-serif;
    font-size: 0.72rem;
    font-weight: 700;
    color: rgba(255,255,255,0.3);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .log-title::after {
    content: '';
    flex: 1;
    height: 1px;
    background: rgba(255,255,255,0.05);
  }

  .log-container {
    height: 180px;
    overflow-y: auto;
    background: rgba(0,0,0,0.4);
    border: 1px solid rgba(255,255,255,0.04);
    border-radius: 8px;
    padding: 0.65rem 0.75rem;
    font-family: 'JetBrains Mono', monospace;
  }
  .log-container::-webkit-scrollbar { width: 3px; }
  .log-container::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 3px; }

  .log-empty {
    color: rgba(255,255,255,0.15);
    font-size: 0.74rem;
  }

  .log-line {
    font-size: 0.72rem;
    line-height: 1.6;
    color: rgba(255,255,255,0.45);
  }
  .log-line:last-child { color: rgba(255,255,255,0.7); }

  .log-line::before {
    content: '›  ';
    color: rgba(110,231,183,0.35);
  }

  .log-line.err { color: rgba(248,113,113,0.7); }
  .log-line.err::before { color: rgba(248,113,113,0.4); }
`;

/* ─── StatusDot ─────────────────────────────────────────────────────────── */

function StatusDot({ status }: { status: "ok" | "no" | "checking" | null }) {
  const cls =
    status === "ok"
      ? "ok"
      : status === "no"
        ? "no"
        : status === "checking"
          ? "checking"
          : "idle";
  const tip =
    status === "ok"
      ? "路径存在"
      : status === "no"
        ? "路径不存在"
        : status === "checking"
          ? "检查中…"
          : "未检查";
  return <div className={`status-dot ${cls}`} title={tip} aria-hidden />;
}

/* ─── PathRow ────────────────────────────────────────────────────────────── */

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
  status: "ok" | "no" | "checking" | null;
  onBrowse: () => void;
  onClear: () => void;
  disabled: boolean;
  browseLabel?: string;
}) {
  return (
    <div className="path-row">
      <input
        className="path-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
      />
      <StatusDot status={status} />
      <button
        className="btn btn-ghost"
        onClick={onBrowse}
        disabled={!isTauri || disabled}
      >
        {browseLabel}
      </button>
      <button
        className="btn btn-ghost-sm"
        onClick={onClear}
        disabled={disabled || !value}
        aria-label="清除"
      >
        ✕
      </button>
    </div>
  );
}

/* ─── Main Component ─────────────────────────────────────────────────────── */

export const Tools: React.FC = () => {
  const closeTools = useGameStore((s) => s.closeTools);

  const [gameDir, setGameDir] = useState<string | null>(null);
  const [gameDirStatus, setGameDirStatus] = useState<
    "ok" | "no" | "checking" | null
  >(null);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [outputDirStatus, setOutputDirStatus] = useState<
    "ok" | "no" | "checking" | null
  >(null);
  const [enableTranslation, setEnableTranslation] = useState(false);
  const [translationDir, setTranslationDir] = useState<string | null>(null);
  const [translationDirStatus, setTranslationDirStatus] = useState<
    "ok" | "no" | "checking" | null
  >(null);
  const [enableGallery, setEnableGallery] = useState(false);
  const [galleryPath, setGalleryPath] = useState<string | null>(null);
  const [galleryPathStatus, setGalleryPathStatus] = useState<
    "ok" | "no" | "checking" | null
  >(null);
  const [enableAssetScan, setEnableAssetScan] = useState(false);
  const [assetScanDir, setAssetScanDir] = useState<string | null>(null);
  const [assetScanDirStatus, setAssetScanDirStatus] = useState<
    "ok" | "no" | "checking" | null
  >(null);
  const [assetScanCount, setAssetScanCount] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [totalFiles, setTotalFiles] = useState<number>(0);
  const [processedFiles, setProcessedFiles] = useState<number>(0);
  const [currentFile, setCurrentFile] = useState<string | null>(null);

  const logRef = useRef<HTMLDivElement>(null);
  const percent =
    totalFiles > 0 ? Math.round((processedFiles / totalFiles) * 100) : 0;

  const gameDirTimer = useRef<number | null>(null);
  const outputDirTimer = useRef<number | null>(null);
  const translationDirTimer = useRef<number | null>(null);
  const galleryPathTimer = useRef<number | null>(null);
  const assetScanDirTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      [
        gameDirTimer,
        outputDirTimer,
        translationDirTimer,
        galleryPathTimer,
        assetScanDirTimer,
      ].forEach((r) => {
        if (r.current) window.clearTimeout(r.current);
      });
    };
  }, []);

  function makePathEffect(
    value: string | null,
    setStatus: (s: "ok" | "no" | "checking" | null) => void,
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

  useEffect(
    () => makePathEffect(gameDir, setGameDirStatus, gameDirTimer),
    [gameDir],
  );

  useEffect(
    () => makePathEffect(outputDir, setOutputDirStatus, outputDirTimer),
    [outputDir],
  );

  useEffect(
    () =>
      makePathEffect(
        translationDir,
        setTranslationDirStatus,
        translationDirTimer,
        enableTranslation,
      ),
    [translationDir, enableTranslation],
  );

  useEffect(
    () =>
      makePathEffect(
        galleryPath,
        setGalleryPathStatus,
        galleryPathTimer,
        enableGallery,
      ),
    [galleryPath, enableGallery],
  );

  useEffect(
    () =>
      makePathEffect(
        assetScanDir,
        setAssetScanDirStatus,
        assetScanDirTimer,
        enableAssetScan,
      ),
    [assetScanDir, enableAssetScan],
  );

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const log = (s: string) => setLogs((l) => [...l, s]);

  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !running) closeTools();
  };

  async function buildTranslationMap(
    dir: string,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!isTauri) return map;
    try {
      const files = await walkDir(dir, (name) =>
        name.toLowerCase().endsWith(".rpy"),
      );
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

  /**
   * Walk `dir`, collect all image file paths relative to `dir`, run
   * `generateImageDefines`, and return the rendered RRS block string.
   * Returns null on error (errors are logged via `log`).
   */
  async function buildAssetDefinesBlock(dir: string): Promise<string | null> {
    if (!isTauri) return null;
    try {
      const allFiles = await walkDir(dir, () => true);
      // Make paths relative to dir and normalise separators
      const relativePaths = allFiles.map((f) => {
        const rel = f.startsWith(dir)
          ? f.slice(dir.length).replace(/^\/+/, "")
          : (f.split("/").pop() ?? f);
        return rel.replace(/\\/g, "/");
      });
      const result = generateImageDefines(relativePaths);
      setAssetScanCount(result.defines.length);
      if (result.conflicts.length > 0) {
        for (const c of result.conflicts) {
          log(
            `  [资源扫描] key冲突 '${c.key}'：'${c.winner}' 优先于 '${c.loser}'`,
          );
        }
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

  async function buildGalleryEntries(path: string) {
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
    if (running) return;
    if (!isTauri) {
      log("仅在 Tauri 环境下支持文件系统操作。");
      return;
    }
    if (!gameDir) {
      log("请先选择 Ren'Py game 目录。");
      return;
    }
    const outDir = outputDir || gameDir;
    setRunning(true);
    setLogs([]);
    setTotalFiles(0);
    setProcessedFiles(0);
    setCurrentFile(null);
    setAssetScanCount(null);
    log(`开始扫描：${gameDir}`);
    try {
      let translationMap: Map<string, string> | undefined;
      if (enableTranslation && translationDir) {
        log(`加载翻译目录：${translationDir}`);
        translationMap = await buildTranslationMap(translationDir);
        log(`翻译映射大小：${translationMap.size}`);
      }

      let galleryEntries: GalleryEntry[] | null = null;
      if (enableGallery && galleryPath) {
        log(`解析图鉴文件：${galleryPath}`);
        galleryEntries = await buildGalleryEntries(galleryPath);
      }

      // ── Asset scan: generate image defines block ──
      let assetDefinesBlock: string | null = null;
      if (enableAssetScan && assetScanDir) {
        log(`扫描资源目录：${assetScanDir}`);
        assetDefinesBlock = await buildAssetDefinesBlock(assetScanDir);
      }

      const rpyFiles = await walkDir(gameDir, (name) =>
        name.toLowerCase().endsWith(".rpy"),
      );
      log(`发现 ${rpyFiles.length} 个 .rpy 文件`);
      setTotalFiles(rpyFiles.length);
      const writtenFiles: string[] = [];
      setProcessedFiles(0);

      for (const fullPath of rpyFiles) {
        const relPreview = fullPath.startsWith(gameDir)
          ? fullPath.slice(gameDir.length).replace(new RegExp("^/+", "g"), "")
          : fullPath.split("/").pop() || fullPath;
        setCurrentFile(relPreview);
        try {
          const content = await readTextFileTauri(fullPath);
          if (content === null) {
            log(`读取失败：${fullPath}`);
            setProcessedFiles((n) => n + 1);
            continue;
          }
          const rel = fullPath.startsWith(gameDir)
            ? fullPath.slice(gameDir.length).replace(new RegExp("^/+", "g"), "")
            : fullPath.split("/").pop() || fullPath;
          const rrsName = rel.replace(/\.rpy$/i, ".rrs");
          const outPath = `${outDir}/${rrsName}`;
          const outParent = outPath.replace(new RegExp("/[^/]+$"), "");
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

      // ── Write standalone asset defines file ──
      if (enableAssetScan && assetDefinesBlock) {
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
        // Add image_defines.rrs to manifest if scan produced it
        if (enableAssetScan && assetDefinesBlock) {
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
    } catch (err) {
      log(`运行出错：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <style>{CSS}</style>
      <div
        className="tools-overlay"
        onClick={handleBackdrop}
        role="dialog"
        aria-modal="true"
        aria-label="工具"
      >
        <div className="tools-panel" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="tools-header">
            <div className="tools-title-wrap">
              <div className="tools-badge">
                <span>⚙</span> TOOL
              </div>
              <h2 className="tools-title">Ren'Py → RRS 转换器</h2>
            </div>
            <button
              className="tools-close"
              onClick={closeTools}
              aria-label="关闭"
              disabled={running}
            >
              ✕
            </button>
          </div>

          {/* Body */}
          <div className="tools-body">
            {/* Section 1 — Game Dir */}
            <div className="tools-section">
              <div className="section-label">
                <span className="section-num">01</span>
                <span className="section-title">Game 目录</span>
              </div>
              <PathRow
                value={gameDir ?? ""}
                onChange={(v) => setGameDir(v || null)}
                placeholder="选择或输入 Ren'Py game 目录路径"
                status={gameDirStatus}
                onBrowse={async () => {
                  if (!isTauri) return;
                  const dir = await pickDirectory();
                  if (dir) {
                    setGameDir(dir);
                    if (!outputDir) setOutputDir(dir);
                    if (!translationDir) setTranslationDir(`${dir}/tl/chinese`);
                    if (!galleryPath)
                      setGalleryPath(`${dir}/gallery_images.rpy`);
                  }
                }}
                onClear={() => {
                  setGameDir(null);
                  setGameDirStatus(null);
                }}
                disabled={running}
              />
              <div className="section-hint">
                包含 .rpy 文件的目录，如{" "}
                <code style={{ opacity: 0.6 }}>script.rpy</code>。非 Tauri
                环境下可手动粘贴路径。
              </div>
            </div>

            {/* Section 2 — Output Dir */}
            <div className="tools-section">
              <div className="section-label">
                <span className="section-num">02</span>
                <span className="section-title">输出目录</span>
                <span
                  style={{
                    fontSize: "0.67rem",
                    color: "rgba(255,255,255,0.2)",
                    marginLeft: "0.25rem",
                  }}
                >
                  可选
                </span>
              </div>
              <PathRow
                value={outputDir ?? ""}
                onChange={(v) => setOutputDir(v || null)}
                placeholder="默认同 game 目录"
                status={outputDirStatus}
                onBrowse={async () => {
                  if (!isTauri) return;
                  const dir = await pickDirectory();
                  if (dir) setOutputDir(dir);
                }}
                onClear={() => {
                  setOutputDir(null);
                  setOutputDirStatus(null);
                }}
                disabled={running}
              />
            </div>

            {/* Section 3 — Translation */}
            <div className="tools-section">
              <div className="section-label">
                <span className="section-num">03</span>
                <span className="section-title">翻译</span>
                <span
                  style={{
                    fontSize: "0.67rem",
                    color: "rgba(255,255,255,0.2)",
                    marginLeft: "0.25rem",
                  }}
                >
                  可选
                </span>
              </div>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  className="toggle-checkbox"
                  checked={enableTranslation}
                  onChange={(e) => setEnableTranslation(e.target.checked)}
                  disabled={running}
                />
                <span className="toggle-label">
                  启用翻译（从 tl/chinese 目录导入）
                </span>
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

            {/* Section 4 — Gallery */}
            <div className="tools-section">
              <div className="section-label">
                <span className="section-num">04</span>
                <span className="section-title">图鉴解析</span>
                <span
                  style={{
                    fontSize: "0.67rem",
                    color: "rgba(255,255,255,0.2)",
                    marginLeft: "0.25rem",
                  }}
                >
                  可选
                </span>
              </div>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  className="toggle-checkbox"
                  checked={enableGallery}
                  onChange={(e) => setEnableGallery(e.target.checked)}
                  disabled={running}
                />
                <span className="toggle-label">
                  从 gallery_images.rpy 提取图鉴条目
                </span>
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

            {/* Section 5 — Asset Scan */}
            <div className="tools-section">
              <div className="section-label">
                <span className="section-num">05</span>
                <span className="section-title">资源扫描</span>
                <span
                  style={{
                    fontSize: "0.67rem",
                    color: "rgba(255,255,255,0.2)",
                    marginLeft: "0.25rem",
                  }}
                >
                  可选
                </span>
              </div>
              <label className="toggle-row">
                <input
                  type="checkbox"
                  className="toggle-checkbox"
                  checked={enableAssetScan}
                  onChange={(e) => {
                    setEnableAssetScan(e.target.checked);
                    if (!e.target.checked) setAssetScanCount(null);
                  }}
                  disabled={running}
                />
                <span className="toggle-label">
                  自动扫描资源目录，生成 image.XX 定义
                </span>
              </label>
              <PathRow
                value={assetScanDir ?? ""}
                onChange={(v) => setAssetScanDir(v || null)}
                placeholder="选择包含图片资源的目录（如 assets/images）"
                status={assetScanDirStatus}
                onBrowse={async () => {
                  if (!isTauri) return;
                  const dir = await pickDirectory();
                  if (dir) setAssetScanDir(dir);
                }}
                onClear={() => {
                  setAssetScanDir(null);
                  setAssetScanDirStatus(null);
                  setAssetScanCount(null);
                }}
                disabled={running || !enableAssetScan}
                browseLabel="浏览"
              />
              {enableAssetScan && (
                <div className="section-hint">
                  扫描所选目录中的所有图片文件（.jpg/.png/.webp/.webm 等），
                  为每个文件生成{" "}
                  <code style={{ opacity: 0.7 }}>image.文件名 = "路径";</code>{" "}
                  定义，注入所有转换后的 .rrs 文件，并额外写出{" "}
                  <code style={{ opacity: 0.7 }}>image_defines.rrs</code>。
                  {assetScanCount !== null && (
                    <span
                      style={{
                        display: "inline-block",
                        marginLeft: "0.5rem",
                        color: "#6ee7b7",
                        fontWeight: 600,
                      }}
                    >
                      上次扫描：{assetScanCount} 个定义
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Progress + Actions */}
            <div className="progress-section">
              <div className="progress-header">
                <span className={`progress-status ${running ? "running" : ""}`}>
                  {running ? "▶ 转换中" : "就绪"}
                </span>
                <span className="progress-count">
                  {processedFiles}/{totalFiles} — {percent}%
                </span>
              </div>
              <div className="progress-bar-bg">
                <div
                  className="progress-bar-fill"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <div className="current-file-tag">
                <span>›</span>
                {currentFile ?? (running ? "初始化..." : "尚未开始")}
              </div>
              <div className="action-row">
                <button
                  className={`btn btn-primary ${running ? "running" : ""}`}
                  onClick={runConversion}
                  disabled={running || !isTauri}
                  aria-label="开始转换"
                >
                  {running ? "◌  正在转换…" : "▶  开始转换"}
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => setLogs([])}
                  disabled={running}
                >
                  清空日志
                </button>
              </div>
            </div>

            {/* Log */}
            <div className="log-section">
              <div className="log-title">输出日志</div>
              <div className="log-container" ref={logRef}>
                {logs.length === 0 ? (
                  <div className="log-empty">暂无输出</div>
                ) : (
                  logs.map((l, i) => (
                    <div
                      key={i}
                      className={`log-line${l.startsWith("失败") || (l.startsWith("解析") && l.includes("失败")) ? " err" : ""}`}
                    >
                      {l}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
