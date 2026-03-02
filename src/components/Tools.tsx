import React, { useState, useEffect, useRef, useCallback } from "react";
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
  type VirtualZipEntry,
  CancelledError,
} from "../converterFs";
import { convertRpy } from "../../rpy-rrs-bridge/rpy2rrs-core";
import {
  convertRpyc,
  detectMinigameFromAst,
  unwrapAstNodes,
} from "../../rpy-rrs-bridge/rpyc2rrs-core";
import { readRpyc } from "../rpycReader";
import {
  detectMinigame,
  renderMinigameStubs,
} from "../../rpy-rrs-bridge/minigame-detect";
import { parseTranslationBlocks } from "../../rpy-rrs-bridge/translation-extractor";
import { parseGalleryRpy } from "../../rpy-rrs-bridge/parse-gallery-core";
import {
  generateImageDefines,
  renderDefinesBlock,
} from "../../rpy-rrs-bridge/scan-assets-core";
import {
  extractTexts,
  translateAll,
  applyTranslation,
  type TranslationMap,
  type LlmConfig,
  DEFAULT_LLM_CONFIG,
} from "../llmTranslate";
import {
  loadCache,
  saveCache,
  clearCache,
  exportMapAsJson,
  importMapFromJson,
  exportUntranslated,
} from "../translationCache";

// ─── Types ────────────────────────────────────────────────────────────────────

type PathStatus = "ok" | "no" | "checking" | null;

// ─── LLM config persistence (localStorage, API key excluded) ─────────────────

const LLM_CONFIG_KEY = "rents_llm_config";

function loadLlmConfigFromStorage(): Omit<LlmConfig, "apiKey"> {
  try {
    const raw = localStorage.getItem(LLM_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_LLM_CONFIG };
    const parsed = JSON.parse(raw);
    return {
      endpoint:
        typeof parsed.endpoint === "string"
          ? parsed.endpoint
          : DEFAULT_LLM_CONFIG.endpoint,
      model:
        typeof parsed.model === "string"
          ? parsed.model
          : DEFAULT_LLM_CONFIG.model,
      batchSize:
        typeof parsed.batchSize === "number"
          ? parsed.batchSize
          : DEFAULT_LLM_CONFIG.batchSize,
      concurrency:
        typeof parsed.concurrency === "number"
          ? parsed.concurrency
          : DEFAULT_LLM_CONFIG.concurrency,
      targetLang:
        typeof parsed.targetLang === "string"
          ? parsed.targetLang
          : DEFAULT_LLM_CONFIG.targetLang,
    };
  } catch {
    return { ...DEFAULT_LLM_CONFIG };
  }
}

function saveLlmConfigToStorage(cfg: Omit<LlmConfig, "apiKey">): void {
  try {
    localStorage.setItem(LLM_CONFIG_KEY, JSON.stringify(cfg));
  } catch {
    // localStorage might be unavailable (private browsing, storage full, etc.)
  }
}

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

  // ── LLM translation state ─────────────────────────────────────────────────
  const [enableLlm, setEnableLlm] = useState(false);
  const [llmApiKey, setLlmApiKey] = useState("");
  const [llmConfig, setLlmConfig] = useState<Omit<LlmConfig, "apiKey">>(() =>
    loadLlmConfigFromStorage(),
  );
  // In-memory translation map; loaded from OPFS when game dir is picked.
  const llmMapRef = useRef<TranslationMap>(new Map());
  const [llmCachedCount, setLlmCachedCount] = useState(0);
  // Running totals shown during the translating phase.
  const [llmTranslatedTotal, setLlmTranslatedTotal] = useState(0);
  const [llmGrandTotal, setLlmGrandTotal] = useState(0);
  const [llmFailedBatches, setLlmFailedBatches] = useState(0);
  // All texts extracted across all files (for exportUntranslated).
  const allExtractedTextsRef = useRef<string[]>([]);
  // AbortController for the translating phase.
  const llmAbortRef = useRef<AbortController | null>(null);

  const [enableGallery, setEnableGallery] = useState(false);
  const [galleryPath, setGalleryPath] = useState<string | null>(null);
  const [galleryPathStatus, setGalleryPathStatus] = useState<PathStatus>(null);

  // ── Run state ─────────────────────────────────────────────────────────────
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<
    "idle" | "converting" | "translating" | "packing" | "done"
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

  // ── LLM config field updater ──────────────────────────────────────────────
  const updateLlmConfig = useCallback(
    (patch: Partial<Omit<LlmConfig, "apiKey">>) => {
      setLlmConfig((prev) => {
        const next = { ...prev, ...patch };
        saveLlmConfigToStorage(next);
        return next;
      });
    },
    [],
  );

  // ── LLM mutual exclusivity ────────────────────────────────────────────────
  const handleEnableTranslation = (checked: boolean) => {
    setEnableTranslation(checked);
    if (checked) setEnableLlm(false);
  };
  const handleEnableLlm = (checked: boolean) => {
    setEnableLlm(checked);
    if (checked) setEnableTranslation(false);
  };

  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !running) closeTools();
  };

  // ── Apply chosen game dir ─────────────────────────────────────────────────
  /**
   * Called after the user picks a directory (either via Tauri dialog or FSA
   * picker).  `label` is the display string; `fs` is the ready IConverterFs.
   * Also pre-fills the optional sub-path fields and loads the LLM cache.
   */
  function applyGameFs(label: string, fs: IConverterFs, kind: ConverterId) {
    setGameDir(label);
    setConverterKind(kind);
    gameFsRef.current = fs;
    // Pre-fill optional paths only when they are still empty
    if (!translationDir) setTranslationDir("tl/chinese");
    if (!galleryPath) setGalleryPath("gallery_images.rpy");
    // Load the LLM translation cache for this game directory.
    const cacheKey = label;
    loadCache(cacheKey).then((map) => {
      llmMapRef.current = map;
      setLlmCachedCount(map.size);
    });
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
      // ── Translation (file-based) ─────────────────────────────────────────
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

      // ── Collect script files: .rpy (primary) + .rpyc (fallback) ──────────
      const rpyFiles = await fs.walkDir("", (n) =>
        n.toLowerCase().endsWith(".rpy"),
      );

      // Build a set of base paths that already have a .rpy source file so we
      // can skip the corresponding .rpyc (rpy always wins, matching Ren'Py).
      const rpyBaseNames = new Set(
        rpyFiles.map((p) => p.replace(/\.rpy$/i, "").toLowerCase()),
      );

      const rpycFiles = await fs.walkDir("", (n) =>
        n.toLowerCase().endsWith(".rpyc"),
      );

      // Only keep .rpyc files that have NO matching .rpy companion.
      const rpycOnly = rpycFiles.filter(
        (p) => !rpyBaseNames.has(p.replace(/\.rpyc$/i, "").toLowerCase()),
      );

      const allScriptFiles: Array<{ relPath: string; kind: "rpy" | "rpyc" }> = [
        ...rpyFiles.map((p) => ({ relPath: p, kind: "rpy" as const })),
        ...rpycOnly.map((p) => ({ relPath: p, kind: "rpyc" as const })),
      ];

      log(
        `发现 ${rpyFiles.length} 个 .rpy 文件` +
          (rpycOnly.length > 0 ? `，${rpycOnly.length} 个纯 .rpyc 文件` : ""),
      );
      setTotalFiles(allScriptFiles.length);

      // Collect generated .rrs content as virtual entries (never written to disk)
      const virtualEntries: VirtualZipEntry[] = [];
      const writtenFiles: string[] = [];

      for (const { relPath, kind } of allScriptFiles) {
        setCurrentFile(relPath);
        try {
          if (kind === "rpy") {
            // ── .rpy path (existing logic) ──────────────────────────────────
            const content = await fs.readText(relPath);
            if (content === null) {
              log(`读取失败：${relPath}`);
              setProcessedFiles((n) => n + 1);
              continue;
            }
            const rrsName = relPath.replace(/\.rpy$/i, ".rrs");

            // Check for minigame before full conversion
            const mgResult = detectMinigame(content);
            for (const w of mgResult.warnings) log(`⚠ ${w}`);

            let rrs: string;
            if (mgResult.stubs.length > 0) {
              rrs = renderMinigameStubs(mgResult.stubs, rrsName);
              const labels = mgResult.stubs.map((s) => s.entryLabel).join(", ");
              log(`跳过 minigame：${rrsName} → stub [${labels}]`);
            } else {
              rrs = convertRpy(content, rrsName, translationMap);
              log(`转换：${rrsName}`);
            }

            virtualEntries.push({ zipPath: `data/${rrsName}`, content: rrs });
            writtenFiles.push(rrsName);
          } else {
            // ── .rpyc path ──────────────────────────────────────────────────
            const rrsName = relPath.replace(/\.rpyc$/i, ".rrs");

            // Read as raw bytes — rpyc is binary and must not be UTF-8 decoded.
            let rrs: string;
            try {
              const bytes = await fs.readBinary(relPath);
              if (bytes === null) {
                log(`读取失败（rpyc）：${relPath}`);
                setProcessedFiles((n) => n + 1);
                continue;
              }

              const rpycFile = await readRpyc(bytes);

              // Always decode from the AST pickle (slot 1).
              // slot 2, if present, is a canonical re-serialisation of the AST
              // via get_code() — not the original .rpy source — and is absent
              // in Ren'Py 8.1+. The AST is the most reliable information source.

              const rootNodes = unwrapAstNodes(rpycFile.astPickle);

              const mgResult = detectMinigameFromAst(rootNodes);
              for (const w of mgResult.warnings) log(`⚠ ${w}`);

              if (mgResult.stubs.length > 0) {
                rrs = renderMinigameStubs(mgResult.stubs, rrsName);
                const labels = mgResult.stubs
                  .map((s) => s.entryLabel)
                  .join(", ");
                log(`跳过 minigame（rpyc AST）：${rrsName} → stub [${labels}]`);
              } else {
                rrs = convertRpyc(rpycFile.astPickle, rrsName, translationMap);
                log(`转换（rpyc AST）：${rrsName}`);
              }
            } catch (rpycErr) {
              log(
                `rpyc 解析失败：${relPath} — ${rpycErr instanceof Error ? rpycErr.message : String(rpycErr)}`,
              );
              setProcessedFiles((n) => n + 1);
              continue;
            }

            virtualEntries.push({ zipPath: `data/${rrsName}`, content: rrs });
            writtenFiles.push(rrsName);
          }

          setProcessedFiles((n) => n + 1);
        } catch (err) {
          log(
            `失败：${relPath} — ${err instanceof Error ? err.message : String(err)}`,
          );
          setProcessedFiles((n) => n + 1);
        }
      }

      // ── Build image_defines.rrs virtual entry ─────────────────────────────
      if (assetDefinesBlock) {
        const definesContent =
          `// Source: image_defines.rrs\n\n` + assetDefinesBlock;
        virtualEntries.push({
          zipPath: `data/image_defines.rrs`,
          content: definesContent,
        });
        log(`已生成资源定义文件：image_defines.rrs`);
      }

      // ── Build manifest.json virtual entry ─────────────────────────────────
      setCurrentFile(null);
      try {
        const manifest: Record<string, unknown> = {};
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
        const manifestContent = JSON.stringify(manifest, null, 2);
        virtualEntries.push({
          zipPath: `data/manifest.json`,
          content: manifestContent,
        });
        log(`已生成 manifest.json（${writtenFiles.length} 个文件）`);
      } catch (err) {
        log(
          `生成 manifest.json 失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }

      setProcessedFiles((prev) => (totalFiles > prev ? totalFiles : prev));
      log("✓ 转换完成。");

      // ── LLM translation phase ─────────────────────────────────────────────
      if (enableLlm && llmApiKey.trim() !== "") {
        setPhase("translating");
        log("──────────────────────────");
        log("开始 LLM 翻译…");

        // Collect all texts from every generated .rrs entry.
        const allTexts: string[] = [];
        for (const entry of virtualEntries) {
          if (
            entry.zipPath.startsWith("data/") &&
            entry.zipPath.endsWith(".rrs")
          ) {
            allTexts.push(...extractTexts(entry.content));
          }
        }
        // Deduplicate for display, keep full list for export.
        const uniqueTexts = [...new Set(allTexts)];
        allExtractedTextsRef.current = uniqueTexts;

        const map = llmMapRef.current;
        const alreadyCached = uniqueTexts.filter((t) => map.has(t)).length;
        const needTranslation = uniqueTexts.length - alreadyCached;

        log(
          `共提取 ${uniqueTexts.length} 条文本，已缓存 ${alreadyCached} 条，` +
            `待翻译 ${needTranslation} 条`,
        );

        setLlmGrandTotal(needTranslation);
        setLlmTranslatedTotal(0);
        setLlmFailedBatches(0);

        const abortCtrl = new AbortController();
        llmAbortRef.current = abortCtrl;

        const fullConfig: LlmConfig = {
          ...llmConfig,
          apiKey: llmApiKey.trim(),
        };

        const cacheKey = fs.label;

        await translateAll(
          uniqueTexts,
          map,
          fullConfig,
          async (batchResult, doneTotal, grandTotal) => {
            setLlmTranslatedTotal(doneTotal);
            setLlmGrandTotal(grandTotal);
            if (batchResult.failed.length > 0) {
              setLlmFailedBatches((n) => n + 1);
              log(
                `  ⚠ 批次失败 ${batchResult.failed.length} 条（已跳过，不写入翻译）`,
              );
            }
            // Persist after every batch so progress is not lost on abort.
            await saveCache(cacheKey, map);
            setLlmCachedCount(map.size);
          },
          abortCtrl.signal,
        );

        llmAbortRef.current = null;

        if (abortCtrl.signal.aborted) {
          log("⚠ 翻译已取消，使用已翻译的部分继续打包。");
        } else {
          log(`✓ 翻译完成，共 ${map.size} 条。`);
        }

        // Apply the translation map to all generated .rrs entries.
        if (map.size > 0) {
          for (let i = 0; i < virtualEntries.length; i++) {
            const entry = virtualEntries[i];
            if (
              entry.zipPath.startsWith("data/") &&
              entry.zipPath.endsWith(".rrs")
            ) {
              virtualEntries[i] = {
                ...entry,
                content: applyTranslation(entry.content, map),
              };
            }
          }
          log(
            `已将翻译应用到 ${virtualEntries.filter((e) => e.zipPath.endsWith(".rrs")).length} 个脚本文件。`,
          );
        }
      }

      // ── Pack ZIP ──────────────────────────────────────────────────────────
      log("──────────────────────────");
      log("正在收集文件列表…");
      setPhase("packing");
      setZipProgress(0);

      try {
        // Collect game assets (images, audio, video) from disk
        const IMAGE_EXT = /\.(png|jpg|jpeg|webp|gif|bmp|avif)$/i;
        const AUDIO_EXT = /\.(mp3|ogg|wav|flac|opus|m4a)$/i;
        const VIDEO_EXT = /\.(mp4|webm|ogv|mov)$/i;
        const isAsset = (name: string) =>
          IMAGE_EXT.test(name) || AUDIO_EXT.test(name) || VIDEO_EXT.test(name);

        const assetFiles = await fs.walkDir("", isAsset);

        log(
          `共 ${assetFiles.length} 个资源文件 + ${virtualEntries.length} 个生成文件待打包…`,
        );

        let skippedCount = 0;
        await fs.buildZip(
          assetFiles,
          ({ index, total: tot }) => {
            setZipProgress(Math.round(((index + 1) / tot) * 95));
          },
          (relPath) => {
            log(`  跳过（读取失败）：${relPath}`);
            skippedCount++;
          },
          saveTarget,
          virtualEntries,
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
      : phase === "translating"
        ? "翻译中…"
        : phase === "packing"
          ? "打包中…"
          : phase === "done"
            ? "✓ 完成"
            : "就绪";

  const btnLabel = running
    ? phase === "packing"
      ? "◌  打包中…"
      : phase === "translating"
        ? "◌  翻译中…"
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
              onChange={(e) => handleEnableTranslation(e.target.checked)}
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

          {/* ── 或：LLM 自动翻译 ── */}
          <div className="tools-llm-or-divider">── 或 ──</div>

          <label className="tools-optional-row" style={{ marginTop: "0.5rem" }}>
            <input
              type="checkbox"
              className="tools-optional-checkbox"
              checked={enableLlm}
              onChange={(e) => handleEnableLlm(e.target.checked)}
              disabled={running}
            />
            <span className="settings-label" style={{ marginBottom: 0 }}>
              LLM 自动翻译
            </span>
            <span className="tools-optional-tag">可选</span>
          </label>

          {enableLlm && (
            <div className="tools-llm-config">
              {/* API 地址 */}
              <div className="tools-llm-row">
                <span className="tools-llm-label">API 地址</span>
                <input
                  className="tools-llm-input tools-llm-input--wide"
                  type="text"
                  value={llmConfig.endpoint}
                  onChange={(e) =>
                    updateLlmConfig({ endpoint: e.target.value })
                  }
                  disabled={running}
                  placeholder="https://api.openai.com/v1"
                />
              </div>

              {/* API Key */}
              <div className="tools-llm-row">
                <span className="tools-llm-label">API Key</span>
                <input
                  className="tools-llm-input tools-llm-input--wide"
                  type="password"
                  value={llmApiKey}
                  onChange={(e) => setLlmApiKey(e.target.value)}
                  disabled={running}
                  placeholder="sk-..."
                  autoComplete="off"
                />
              </div>

              {/* 模型 + 目标语言 */}
              <div className="tools-llm-row">
                <span className="tools-llm-label">模型</span>
                <input
                  className="tools-llm-input"
                  type="text"
                  value={llmConfig.model}
                  onChange={(e) => updateLlmConfig({ model: e.target.value })}
                  disabled={running}
                  placeholder="gpt-4o-mini"
                />
                <span
                  className="tools-llm-label"
                  style={{ marginLeft: "0.75rem" }}
                >
                  目标语言
                </span>
                <input
                  className="tools-llm-input"
                  type="text"
                  value={llmConfig.targetLang}
                  onChange={(e) =>
                    updateLlmConfig({ targetLang: e.target.value })
                  }
                  disabled={running}
                  placeholder="中文"
                />
              </div>

              {/* 每批条数 + 并发数 */}
              <div className="tools-llm-row">
                <span className="tools-llm-label">每批条数</span>
                <input
                  className="tools-llm-input tools-llm-input--num"
                  type="number"
                  min={1}
                  max={200}
                  value={llmConfig.batchSize}
                  onChange={(e) =>
                    updateLlmConfig({
                      batchSize: Math.max(1, parseInt(e.target.value) || 1),
                    })
                  }
                  disabled={running}
                />
                <span
                  className="tools-llm-label"
                  style={{ marginLeft: "0.75rem" }}
                >
                  并发数
                </span>
                <input
                  className="tools-llm-input tools-llm-input--num"
                  type="number"
                  min={1}
                  max={128}
                  value={llmConfig.concurrency}
                  onChange={(e) =>
                    updateLlmConfig({
                      concurrency: Math.max(1, parseInt(e.target.value) || 1),
                    })
                  }
                  disabled={running}
                />
              </div>

              {/* 缓存状态 + 操作按钮 */}
              <div className="tools-llm-cache-row">
                <span className="tools-llm-cache-count">
                  已缓存 {llmCachedCount} 条
                </span>
                <button
                  className="btn tools-llm-cache-btn"
                  disabled={running || llmCachedCount === 0}
                  onClick={() => {
                    exportMapAsJson(llmMapRef.current, gameDir ?? "game");
                  }}
                  title="导出完整翻译 JSON"
                >
                  导出 JSON
                </button>
                <button
                  className="btn tools-llm-cache-btn"
                  disabled={running}
                  onClick={async () => {
                    try {
                      const n = await importMapFromJson(llmMapRef.current);
                      if (n === null) return;
                      if (gameDir) await saveCache(gameDir, llmMapRef.current);
                      setLlmCachedCount(llmMapRef.current.size);
                      log(`已导入 ${n} 条翻译。`);
                    } catch (err) {
                      log(
                        `导入失败：${err instanceof Error ? err.message : String(err)}`,
                      );
                    }
                  }}
                  title="从 JSON 文件导入并合并翻译"
                >
                  导入 JSON
                </button>
                <button
                  className="btn tools-llm-cache-btn"
                  disabled={
                    running || allExtractedTextsRef.current.length === 0
                  }
                  onClick={() => {
                    exportUntranslated(
                      allExtractedTextsRef.current,
                      llmMapRef.current,
                      gameDir ?? "game",
                    );
                  }}
                  title="导出尚未翻译的条目，供手动填写后导入"
                >
                  导出未翻译
                </button>
                <button
                  className="btn danger tools-llm-cache-btn"
                  disabled={running || llmCachedCount === 0}
                  onClick={async () => {
                    if (!gameDir) return;
                    if (!window.confirm("确定清空翻译缓存？此操作不可撤销。"))
                      return;
                    await clearCache(gameDir);
                    llmMapRef.current = new Map();
                    allExtractedTextsRef.current = [];
                    setLlmCachedCount(0);
                    log("已清空翻译缓存。");
                  }}
                  title="清空 OPFS 中的翻译缓存"
                >
                  清空缓存
                </button>
              </div>

              {/* 翻译中进度 */}
              {phase === "translating" && (
                <div className="tools-llm-progress">
                  <span>
                    已翻译 {llmTranslatedTotal} / {llmGrandTotal} 条
                    {llmFailedBatches > 0 && (
                      <span className="tools-llm-failed">
                        ，{llmFailedBatches} 批失败
                      </span>
                    )}
                  </span>
                  <button
                    className="btn danger"
                    style={{
                      marginLeft: "0.75rem",
                      padding: "0.25rem 0.7rem",
                      fontSize: "0.8rem",
                    }}
                    onClick={() => {
                      llmAbortRef.current?.abort();
                    }}
                  >
                    取消翻译（直接打包）
                  </button>
                </div>
              )}
            </div>
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
              setLlmTranslatedTotal(0);
              setLlmGrandTotal(0);
              setLlmFailedBatches(0);
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
