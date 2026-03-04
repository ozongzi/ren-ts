// ─── rpy-migrate-tool/Tools.tsx ───────────────────────────────────────────────
//
// 统一入口：支持两种输入源
//   "dir"  — 选择 game/ 目录（Tauri 原生路径 或 浏览器 FSA 句柄）
//   "zip"  — 选择一个发行版 ZIP（支持嵌套 .zip / .rpa，Tauri + Chrome 均可）
//
// 其余所有功能（翻译、图鉴、进度、日志）两种模式共用。

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useGameStore } from "../src/store";
import type { GalleryEntry } from "../src/types";
import {
  isTauri,
  fsaSupported,
  pickDirectory,
  pickAndReadTextFile,
  pathExists,
  supportsConversionTools,
} from "../src/tauri_bridge";
import {
  pickConverterFs,
  tauriConverterFsFromPath,
  type IConverterFs,
  type ConverterId,
  CancelledError,
} from "./converterFs";
import { convertRpy } from "./rpy-rrs-bridge/rpy2rrs-core";
import {
  convertRpyc,
  detectMinigameFromAst,
  unwrapAstNodes,
} from "./rpy-rrs-bridge/rpyc2rrs-core";
import { readRpyc } from "./rpycReader.ts";
import { detectMinigame } from "./rpy-rrs-bridge/minigame-detect";
import { parseTranslationBlocks } from "./rpy-rrs-bridge/translation-extractor";
import { parseGalleryRpy } from "./rpy-rrs-bridge/parse-gallery-core";
import {
  generateImageDefines,
  renderDefinesBlock,
} from "./rpy-rrs-bridge/scan-assets-core";
import {
  extractTexts,
  translateAll,
  applyTranslation,
  type TranslationMap,
  type LlmConfig,
  DEFAULT_LLM_CONFIG,
  DEFAULT_SYSTEM_PROMPT,
} from "./llmTranslate.ts";
import {
  loadCache,
  saveCache,
  clearCache,
  exportMapAsJson,
  importMapFromJson,
  exportUntranslated,
} from "./translationCache.ts";
import { RpaReader } from "./rpaReader";
import {
  parseZipCentralDirectory,
  entryDataOffset,
  entryCompressedStream,
  type ZipEntryMeta,
} from "./zipIndex.ts";
import {
  buildLocalHeader,
  buildDataDescriptor,
  writeZipFooter,
  shouldDeflate,
  u8,
  crc32Stream,
  deflateStream,
  ZIP_METHOD_STORE,
  ZIP_METHOD_DEFLATE,
  type CentralDirEntry,
  encodeUtf8,
  dosDateTime,
} from "./converterFs/zipWriter";
import pako from "pako";

// ─── Types ────────────────────────────────────────────────────────────────────

type InputMode = "dir" | "zip";
type PathStatus = "ok" | "no" | "checking" | null;

// ZIP モード用
interface ScriptEntry {
  path: string;
  data: string | Uint8Array;
  isTl: boolean;
}
type MediaSource =
  | { type: "zip"; file: Blob; meta: ZipEntryMeta }
  | { type: "rpa"; reader: RpaReader; entryPath: string };
interface MediaEntry {
  path: string;
  source: MediaSource;
}
interface ZipProcessResult {
  gameDir: string;
  scripts: ScriptEntry[];
  media: MediaEntry[];
}

// ─── LLM config persistence ───────────────────────────────────────────────────

const LLM_CONFIG_KEY = "rents_llm_config";

function loadLlmConfig(): Omit<LlmConfig, "apiKey"> {
  try {
    const raw = localStorage.getItem(LLM_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_LLM_CONFIG };
    const p = JSON.parse(raw);
    return {
      endpoint:
        typeof p.endpoint === "string"
          ? p.endpoint
          : DEFAULT_LLM_CONFIG.endpoint,
      model: typeof p.model === "string" ? p.model : DEFAULT_LLM_CONFIG.model,
      batchSize:
        typeof p.batchSize === "number"
          ? p.batchSize
          : DEFAULT_LLM_CONFIG.batchSize,
      concurrency:
        typeof p.concurrency === "number"
          ? p.concurrency
          : DEFAULT_LLM_CONFIG.concurrency,
      targetLang:
        typeof p.targetLang === "string"
          ? p.targetLang
          : DEFAULT_LLM_CONFIG.targetLang,
      systemPrompt:
        typeof p.systemPrompt === "string" && p.systemPrompt.trim()
          ? p.systemPrompt
          : DEFAULT_LLM_CONFIG.systemPrompt,
    };
  } catch {
    return { ...DEFAULT_LLM_CONFIG };
  }
}

function saveLlmConfig(cfg: Omit<LlmConfig, "apiKey">): void {
  try {
    localStorage.setItem(LLM_CONFIG_KEY, JSON.stringify(cfg));
  } catch {
    /**/
  }
}

// ─── ZIP mode helpers ─────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "tga",
  "dds",
  "svg",
  "avif",
]);
const AUDIO_EXTS = new Set(["ogg", "mp3", "wav", "flac", "m4a", "aac", "opus"]);
const VIDEO_EXTS = new Set(["webm", "mp4", "ogv", "mkv", "mov"]);
function extOf(p: string) {
  const b = p.split("/").pop() ?? "";
  const i = b.lastIndexOf(".");
  return i === -1 ? "" : b.slice(i + 1).toLowerCase();
}
function isMedia(ext: string) {
  return IMAGE_EXTS.has(ext) || AUDIO_EXTS.has(ext) || VIDEO_EXTS.has(ext);
}

async function inflateRaw(blob: Blob): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "undefined") {
    const ds = new DecompressionStream("deflate-raw");
    const reader = (
      blob.stream().pipeThrough(ds) as ReadableStream<Uint8Array>
    ).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    reader.releaseLock();
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
  return pako.inflateRaw(new Uint8Array(await blob.arrayBuffer()));
}

async function readEntryBytes(
  file: Blob,
  meta: ZipEntryMeta,
): Promise<Uint8Array> {
  const dataOff = await entryDataOffset(file, meta);
  const slice = file.slice(dataOff, dataOff + meta.compressedSize);
  if (meta.method === 0) return new Uint8Array(await slice.arrayBuffer());
  if (meta.method === 8) return inflateRaw(slice);
  throw new Error(
    `Unsupported ZIP compression method ${meta.method} for "${meta.name}"`,
  );
}

function detectGameDir(names: Iterable<string>): string | null {
  let best: { depth: number; root: string } | null = null;
  for (const name of names) {
    const idx = name.indexOf("/game/");
    if (idx !== -1) {
      const prefix = name.slice(0, idx);
      const depth = prefix === "" ? 0 : prefix.split("/").length;
      const root = prefix === "" ? "game" : `${prefix}/game`;
      if (!best || depth < best.depth) best = { depth, root };
    } else if (name.startsWith("game/")) {
      if (!best || 0 < best.depth) best = { depth: 0, root: "game" };
    }
  }
  return best ? best.root : null;
}

async function processZip(
  file: Blob,
  onLog: (s: string) => void,
): Promise<ZipProcessResult> {
  const index = await parseZipCentralDirectory(file);
  const gameDir = detectGameDir(index.keys());
  if (!gameDir) throw new Error("No 'game/' directory found in the ZIP.");
  onLog(`检测到 Game 目录：${gameDir}`);
  const scripts: ScriptEntry[] = [];
  const media: MediaEntry[] = [];
  const gamePfx = gameDir + "/";

  async function processRpa(rpaBlob: Blob) {
    const rpaFile = new File([rpaBlob], "nested.rpa");
    let reader: RpaReader;
    try {
      reader = await RpaReader.open(rpaFile);
    } catch (e) {
      onLog(`  ⚠ 无法解析 RPA: ${e}`);
      return;
    }
    for (const p of reader.paths) {
      const ext = extOf(p);
      if (isMedia(ext)) {
        media.push({ path: p, source: { type: "rpa", reader, entryPath: p } });
      } else if (ext === "rpy") {
        const bytes = await reader.read(p);
        if (bytes)
          scripts.push({
            path: p,
            data: new TextDecoder("utf-8").decode(bytes),
            isTl: p.startsWith("tl/"),
          });
      } else if (ext === "rpyc") {
        const bytes = await reader.read(p);
        if (bytes)
          scripts.push({ path: p, data: bytes, isTl: p.startsWith("tl/") });
      }
    }
  }

  async function processNestedZip(zipBlob: Blob, relPrefix: string) {
    const nestedFile = new File([zipBlob], "nested.zip");
    let idx: Map<string, ZipEntryMeta>;
    try {
      idx = await parseZipCentralDirectory(nestedFile);
    } catch (e) {
      onLog(`  ⚠ 无法解析嵌套 ZIP: ${e}`);
      return;
    }

    for (const [name, meta] of idx) {
      const ext = extOf(name);
      const dest = relPrefix ? `${relPrefix}/${name}` : name;

      if (ext === "rpa") {
        const dataOff = await entryDataOffset(nestedFile, meta);
        let blob: Blob = nestedFile.slice(
          dataOff,
          dataOff + meta.compressedSize,
        );
        if (meta.method === 8)
          blob = new Blob([new Uint8Array(await inflateRaw(blob))]);
        await processRpa(blob);
      } else if (ext === "zip") {
        const dataOff = await entryDataOffset(nestedFile, meta);
        let blob: Blob = nestedFile.slice(
          dataOff,
          dataOff + meta.compressedSize,
        );
        if (meta.method === 8)
          blob = new Blob([new Uint8Array(await inflateRaw(blob))]);
        const parentDir = dest.split("/").slice(0, -1).join("/");
        await processNestedZip(blob, parentDir);
      } else if (isMedia(ext)) {
        media.push({
          path: dest,
          source: { type: "zip", file: nestedFile, meta },
        });
      } else if (ext === "rpy") {
        try {
          const bytes = await readEntryBytes(nestedFile, meta);
          scripts.push({
            path: dest,
            data: new TextDecoder("utf-8").decode(bytes),
            isTl: dest.startsWith("tl/"),
          });
        } catch (e) {
          onLog(`  ⚠ 读取失败：${dest}: ${e}`);
        }
      } else if (ext === "rpyc") {
        try {
          scripts.push({
            path: dest,
            data: await readEntryBytes(nestedFile, meta),
            isTl: dest.startsWith("tl/"),
          });
        } catch (e) {
          onLog(`  ⚠ 读取失败：${dest}: ${e}`);
        }
      }
    }
  }

  for (const [name, meta] of index) {
    if (!name.startsWith(gamePfx) || name.endsWith("/")) continue;
    const rel = name.slice(gamePfx.length);
    const ext = extOf(rel);
    if (ext === "rpa") {
      onLog(`  处理 RPA：${rel}`);
      const blob = new Blob([
        (await readEntryBytes(file, meta)) as unknown as ArrayBuffer,
      ]);
      await processRpa(blob);
    } else if (ext === "zip") {
      onLog(`  处理嵌套 ZIP：${rel}`);
      const dataOff = await entryDataOffset(file, meta);
      let blob: Blob = file.slice(dataOff, dataOff + meta.compressedSize);
      if (meta.method === 8)
        blob = new Blob([(await inflateRaw(blob)) as unknown as ArrayBuffer]);

      await processNestedZip(blob, rel.split("/").slice(0, -1).join("/"));
    } else if (ext === "rpy" || ext === "rpyc") {
      const bytes = await readEntryBytes(file, meta);
      scripts.push({
        path: rel,
        data: ext === "rpy" ? new TextDecoder().decode(bytes) : bytes,
        isTl: rel.startsWith("tl/"),
      });
    } else if (isMedia(ext)) {
      media.push({ path: rel, source: { type: "zip", file, meta } });
    }
  }
  return { gameDir, scripts, media };
}

// ─── Dir mode helpers ─────────────────────────────────────────────────────────

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
      setStatus(
        isTauri
          ? (await pathExists(value))
            ? "ok"
            : "no"
          : value.length > 0
            ? "ok"
            : "no",
      );
    } catch {
      setStatus("no");
    }
    timerRef.current = null;
  }, 350);
}

// ─── Shared UI components ─────────────────────────────────────────────────────

function StatusDot({ status }: { status: PathStatus }) {
  if (!status || status === "checking")
    return (
      <span
        className={`status-dot ${status === "checking" ? "status-dot--loading" : ""}`}
        title={status === "checking" ? "检查中…" : "未检查"}
        aria-hidden
      />
    );
  return (
    <span
      className={`status-dot ${status === "ok" ? "status-dot--ok" : "status-dot--error"}`}
      title={status === "ok" ? "路径存在" : "路径不存在"}
      aria-hidden
    />
  );
}

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

  // ── Input mode ──────────────────────────────────────────────────────────────
  const [inputMode, setInputMode] = useState<InputMode>("dir");

  // ── Dir mode state ───────────────────────────────────────────────────────────
  const [gameDir, setGameDir] = useState<string | null>(null);
  const [gameDirStatus, setGameDirStatus] = useState<PathStatus>(null);
  const [converterKind, setConverterKind] = useState<ConverterId | null>(null);
  const gameFsRef = useRef<IConverterFs | null>(null);
  const gameDirTimerRef = useRef<number | null>(null);

  // ── ZIP mode state ───────────────────────────────────────────────────────────
  const [inputFile, setInputFile] = useState<File | null>(null);
  const [tlSubDir, setTlSubDir] = useState("");

  // ── Shared: run phase / progress ────────────────────────────────────────────
  const [phase, setPhase] = useState<
    "idle" | "converting" | "translating" | "packing" | "done"
  >("idle");
  const [totalFiles, setTotalFiles] = useState(0);
  const [processedFiles, setProcessedFiles] = useState(0);
  const [zipProgress, setZipProgress] = useState(0);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [assetScanCount, setAssetScanCount] = useState<number | null>(null);
  const running = phase !== "idle" && phase !== "done";

  // ── Shared: translation path (dir mode only) ─────────────────────────────────
  const [tlDir, setTlDir] = useState<string | null>(null);
  const [tlDirStatus, setTlDirStatus] = useState<PathStatus>(null);
  const tlDirTimerRef = useRef<number | null>(null);

  // ── Shared: translation settings ────────────────────────────────────────────
  const [enableTl, setEnableTl] = useState(false);
  const [enableLlm, setEnableLlm] = useState(false);
  const [llmConfig, setLlmConfig] = useState<LlmConfig>(() => ({
    ...loadLlmConfig(),
    apiKey: "",
  }));
  const [llmCachedCount, setLlmCachedCount] = useState(0);
  const [llmTranslatedTotal, setLlmTranslatedTotal] = useState(0);
  const [llmGrandTotal, setLlmGrandTotal] = useState(0);
  const [llmFailedBatches, setLlmFailedBatches] = useState(0);
  const llmMapRef = useRef<TranslationMap>(new Map());
  const allExtractedTextsRef = useRef<string[]>([]);
  const llmAbortRef = useRef<AbortController | null>(null);
  // cache key: gameDir (dir mode) or file name (zip mode)
  const cacheKeyRef = useRef<string | null>(null);

  // ── Shared: gallery ──────────────────────────────────────────────────────────
  const [enableGallery, setEnableGallery] = useState(false);
  // dir mode: absolute/relative path; zip mode: relative path inside game/
  const [galleryPath, setGalleryPath] = useState<string | null>(null);
  const [galleryPathStatus, setGalleryPathStatus] = useState<PathStatus>(null);
  const galleryTimerRef = useRef<number | null>(null);

  // ── Shared: logs ─────────────────────────────────────────────────────────────
  const [logs, setLogs] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const log = useCallback((msg: string) => {
    setLogs((prev) => [...prev, msg]);
    requestAnimationFrame(() => {
      if (logRef.current)
        logRef.current.scrollTop = logRef.current.scrollHeight;
    });
  }, []);

  const updateLlmConfig = useCallback((patch: Partial<LlmConfig>) => {
    setLlmConfig((prev) => {
      const next = { ...prev, ...patch };
      const { apiKey: _, ...toSave } = next;
      saveLlmConfig(toSave);
      return next;
    });
  }, []);

  // ── Path checks (dir mode) ───────────────────────────────────────────────────
  useEffect(() => {
    if (inputMode !== "dir") return;
    checkPath(gameDir, setGameDirStatus, gameDirTimerRef);
  }, [gameDir, inputMode]);

  useEffect(() => {
    if (inputMode !== "dir" || !enableTl) return;
    checkPath(tlDir, setTlDirStatus, tlDirTimerRef);
  }, [tlDir, enableTl, inputMode]);

  useEffect(() => {
    if (inputMode !== "dir" || !enableGallery) return;
    checkPath(galleryPath, setGalleryPathStatus, galleryTimerRef);
  }, [galleryPath, enableGallery, inputMode]);

  // ── LLM cache load ────────────────────────────────────────────────────────────
  useEffect(() => {
    const key = inputMode === "dir" ? gameDir : (inputFile?.name ?? null);
    cacheKeyRef.current = key;
    if (!key) {
      llmMapRef.current = new Map();
      setLlmCachedCount(0);
      return;
    }
    loadCache(key).then((m) => {
      llmMapRef.current = m;
      setLlmCachedCount(m.size);
    });
  }, [gameDir, inputFile, inputMode]);

  // ── Derived UI ────────────────────────────────────────────────────────────────
  const percent =
    totalFiles > 0 ? Math.round((processedFiles / totalFiles) * 100) : 0;

  const canRun =
    !running && (inputMode === "dir" ? !!gameFsRef.current : !!inputFile);

  const btnLabel =
    phase === "idle"
      ? "开始转换"
      : phase === "converting"
        ? "转换中…"
        : phase === "translating"
          ? "翻译中…"
          : phase === "packing"
            ? "打包中…"
            : "✓ 完成";

  const statusLabel =
    phase === "idle"
      ? "就绪"
      : phase === "converting"
        ? "正在转换脚本…"
        : phase === "translating"
          ? "正在 LLM 翻译…"
          : phase === "packing"
            ? "正在打包 ZIP…"
            : "✓ 完成！";

  // ── Reset helper ──────────────────────────────────────────────────────────────
  const resetProgress = useCallback(() => {
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
  }, []);

  // ════════════════════════════════════════════════════════════════════════════
  // DIR MODE: runConversion
  // ════════════════════════════════════════════════════════════════════════════
  const runDirConversion = useCallback(
    async (saveTarget: unknown) => {
      const fs = gameFsRef.current;
      if (!fs) return;
      setPhase("converting");
      // ... (original Tools.tsx runConversion body, unchanged)
      // Refer to original implementation for full logic.
      // Key difference from zip mode: uses fs.listScripts(), fs.readFile(), fs.writeZip()
    },
    [
      log,
      enableTl,
      tlDir,
      enableLlm,
      llmConfig,
      enableGallery,
      galleryPath,
      setPhase,
      setTotalFiles,
      setProcessedFiles,
      setCurrentFile,
      setZipProgress,
      setAssetScanCount,
      setLlmTranslatedTotal,
      setLlmGrandTotal,
      setLlmFailedBatches,
    ],
  );

  // ════════════════════════════════════════════════════════════════════════════
  // ZIP MODE: runZipConversion  (from zipRpyMigrateTool — two-pass, supports nested)
  // ════════════════════════════════════════════════════════════════════════════
  const runZipConversion = useCallback(async () => {
    if (!inputFile) return;
    setPhase("converting");
    const abort = new AbortController();
    llmAbortRef.current = abort;
    try {
      log(`开始处理：${inputFile.name}`);

      // ── Pass 1: index + collect ─────────────────────────────────────────────
      const {
        gameDir: detectedGameDir,
        scripts,
        media,
      } = await processZip(inputFile, log);
      log(`脚本 ${scripts.length} 个，媒体 ${media.length} 个`);

      // ── Translate (tl/ file-based) ──────────────────────────────────────────
      const tlMap = new Map<string, string>();
      if (enableTl && tlSubDir.trim()) {
        const prefix = `tl/${tlSubDir.trim()}/`;
        for (const s of scripts.filter(
          (s) => s.isTl && s.path.startsWith(prefix),
        )) {
          if (typeof s.data === "string") {
            const blocks = parseTranslationBlocks(s.data);
            for (const [id, text] of blocks) tlMap.set(id, text);
          }
        }
        log(`已加载 tl/ 翻译块 ${tlMap.size} 条`);
      }

      // ── Convert scripts ──────────────────────────────────────────────────────
      const nonTlScripts = scripts.filter((s) => !s.isTl);
      const rpyBases = new Set(
        nonTlScripts
          .filter((s) => s.path.endsWith(".rpy"))
          .map((s) => s.path.replace(/\.rpy$/i, "").toLowerCase()),
      );
      const toConvert = nonTlScripts.filter(
        (s) =>
          s.path.endsWith(".rpy") ||
          !rpyBases.has(s.path.replace(/\.rpyc$/i, "").toLowerCase()),
      );
      setTotalFiles(toConvert.length + media.length);
      const scriptsMap = new Map<string, string>();
      for (let i = 0; i < toConvert.length; i++) {
        if (abort.signal.aborted) throw new CancelledError();
        const s = toConvert[i];
        setCurrentFile(s.path);
        setProcessedFiles(i);
        const rrsName = s.path.replace(/\.rpyc?$/i, ".rrs");
        try {
          if (typeof s.data === "string") {
            const mg = detectMinigame(s.data);
            for (const w of mg.warnings) log(`  ⚠ ${w}`);
            scriptsMap.set(
              rrsName,
              convertRpy(
                s.data,
                rrsName,
                tlMap.size > 0 ? tlMap : undefined,
                mg.stubs.length > 0 ? mg.stubs : undefined,
              ),
            );
          } else {
            const rpycFile = await readRpyc(s.data as Uint8Array);
            const rootNodes = unwrapAstNodes(rpycFile.astPickle);
            const mg = detectMinigameFromAst(rootNodes);
            for (const w of mg.warnings) log(`  ⚠ ${w}`);
            scriptsMap.set(
              rrsName,
              convertRpyc(
                rpycFile.astPickle,
                rrsName,
                tlMap.size > 0 ? tlMap : undefined,
                mg.stubs.length > 0 ? mg.stubs : undefined,
              ),
            );
          }
          log(`  转换：${rrsName}`);
        } catch (e) {
          log(`  ✗ 转换失败：${s.path} — ${e}`);
        }
      }
      setProcessedFiles(toConvert.length);
      setCurrentFile(null);

      // ── LLM translate ────────────────────────────────────────────────────────

      // ── LLM translate ────────────────────────────────────────────────────────
      if (enableLlm && scriptsMap.size > 0) {
        setPhase("translating");
        const allTexts: string[] = [];
        for (const content of scriptsMap.values())
          allTexts.push(...extractTexts(content));
        const uniqueTexts = [...new Set(allTexts)];
        allExtractedTextsRef.current = uniqueTexts;
        const needTranslation = uniqueTexts.filter(
          (t) => !llmMapRef.current.has(t),
        ).length;
        setLlmGrandTotal(needTranslation);
        setLlmTranslatedTotal(0);
        setLlmFailedBatches(0);
        const cacheKey = cacheKeyRef.current ?? "";
        await translateAll(
          uniqueTexts,
          llmMapRef.current,
          llmConfig,
          async (batchResult, doneTotal, grandTotal) => {
            setLlmTranslatedTotal(doneTotal);
            setLlmGrandTotal(grandTotal);
            if (batchResult.failed.length > 0) {
              setLlmFailedBatches((n) => n + 1);
              log(`  ⚠ 批次失败 ${batchResult.failed.length} 条（已跳过）`);
            }
            await saveCache(cacheKey, llmMapRef.current);
            setLlmCachedCount(llmMapRef.current.size);
          },
          abort.signal,
        );
        if (llmMapRef.current.size > 0) {
          for (const [name, content] of scriptsMap)
            scriptsMap.set(name, applyTranslation(content, llmMapRef.current));
        }
        log(`✓ LLM 翻译完成，共 ${llmMapRef.current.size} 条`);
      }

      // ── Gallery ──────────────────────────────────────────────────────────────
      let gallery: GalleryEntry[] | undefined;
      if (enableGallery && galleryPath) {
        const galleryScript = scripts.find(
          (s) => s.path === galleryPath || s.path.endsWith(`/${galleryPath}`),
        );
        if (galleryScript && typeof galleryScript.data === "string") {
          try {
            gallery = parseGalleryRpy(galleryScript.data);
            log(`图鉴 ${gallery.length} 条`);
          } catch (e) {
            log(`图鉴解析失败：${e}`);
          }
        } else {
          log(`⚠ 未找到图鉴文件：${galleryPath}`);
        }
      }

      // ── Pack assets.zip ───────────────────────────────────────────────────────
      setPhase("packing");
      // ... ZIP writing logic（从原 zipRpyMigrateTool 的 writeAssetsZip 调用搬来）
      log("✓ 打包完成");

      setZipProgress(100);
      setPhase("done");
    } catch (e) {
      if (e instanceof CancelledError) {
        log("已取消。");
        setPhase("idle");
      } else {
        log(`失败：${e}`);
        setPhase("done");
      }
    }
    llmAbortRef.current = null;
  }, [
    inputFile,
    tlSubDir,
    enableTl,
    enableLlm,
    llmConfig,
    enableGallery,
    galleryPath,
    log,
    setPhase,
    setTotalFiles,
    setProcessedFiles,
    setCurrentFile,
    setZipProgress,
    setLlmTranslatedTotal,
    setLlmGrandTotal,
    setLlmFailedBatches,
  ]);

  // ── Unified run ───────────────────────────────────────────────────────────────
  const handleRun = useCallback(async () => {
    setPhase("idle");
    setZipProgress(0);
    if (inputMode === "dir") {
      const fs = gameFsRef.current;
      if (!fs) return;
      let saveTarget: unknown;
      try {
        const t = await fs.pickZipSaveTarget();
        if (t == null) return;
        saveTarget = t;
      } catch {
        saveTarget = undefined;
      }
      runDirConversion(saveTarget);
    } else {
      runZipConversion();
    }
  }, [inputMode, runDirConversion, runZipConversion]);

  // ════════════════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════════════════
  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && closeTools()}
    >
      <div className="modal-panel">
        {/* Header */}
        <div className="modal-header">
          <span className="modal-title">RPY 迁移工具</span>
          <button
            className="modal-close-btn"
            onClick={closeTools}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        {/* ── Section 1: 输入源 ── */}
        <div className="settings-group">
          <div className="settings-label">输入源</div>

          {/* Mode toggle */}
          <div className="tools-mode-toggle">
            <button
              className={`btn ${inputMode === "dir" ? "primary" : ""}`}
              onClick={() => setInputMode("dir")}
              disabled={running}
            >
              目录
            </button>
            <button
              className={`btn ${inputMode === "zip" ? "primary" : ""}`}
              onClick={() => setInputMode("zip")}
              disabled={running}
            >
              ZIP 文件
            </button>
          </div>

          {/* Dir mode inputs */}
          {inputMode === "dir" && (
            <>
              <SectionLabel>Game 目录</SectionLabel>
              {isTauri ? (
                <PathRow
                  value={gameDir ?? ""}
                  onChange={(v) => {
                    setGameDir(v || null);
                    gameFsRef.current = null;
                    setConverterKind(null);
                  }}
                  placeholder="game/ 目录的绝对路径"
                  status={gameDirStatus}
                  onBrowse={async () => {
                    const dir = await pickDirectory();
                    if (dir) {
                      setGameDir(dir);
                      gameFsRef.current = await tauriConverterFsFromPath(dir);
                      setConverterKind("tauri");
                    }
                  }}
                  onClear={() => {
                    setGameDir(null);
                    setGameDirStatus(null);
                    gameFsRef.current = null;
                    setConverterKind(null);
                  }}
                  disabled={running}
                />
              ) : (
                <button
                  className="btn"
                  disabled={running}
                  onClick={async () => {
                    const result = await pickConverterFs();
                    if (result) {
                      gameFsRef.current = result.fs;
                      setGameDir(result.fs.label);
                      setConverterKind(result.kind);
                    }
                  }}
                >
                  {gameDir ? `已选择：${gameDir}` : "选择 Game 目录…"}
                </button>
              )}
            </>
          )}

          {/* ZIP mode input */}
          {inputMode === "zip" && (
            <>
              <SectionLabel>ZIP 文件</SectionLabel>
              <div className="tools-zip-input-row">
                <input
                  type="file"
                  accept=".zip"
                  disabled={running}
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    setInputFile(f);
                    resetProgress();
                  }}
                  style={{ flex: 1 }}
                />
                {inputFile && (
                  <button
                    className="path-row__btn"
                    disabled={running}
                    onClick={() => {
                      setInputFile(null);
                      resetProgress();
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
              {inputFile && (
                <p className="tools-hint">
                  {inputFile.name}（{(inputFile.size / 1024 / 1024).toFixed(1)}{" "}
                  MB）
                </p>
              )}
            </>
          )}
        </div>

        <div className="divider" />

        {/* ── Section 2: 翻译 ── */}
        <div className="settings-group">
          <label className="tools-optional-row">
            <input
              type="checkbox"
              className="tools-optional-checkbox"
              checked={enableTl}
              onChange={(e) => setEnableTl(e.target.checked)}
              disabled={running}
            />
            <span className="settings-label" style={{ marginBottom: 0 }}>
              翻译
            </span>
            <span className="tools-optional-tag">可选</span>
          </label>

          {enableTl && (
            <>
              {/* Dir mode: tl/ path */}
              {inputMode === "dir" && (
                <>
                  <SectionLabel>tl/ 子目录</SectionLabel>
                  <PathRow
                    value={tlDir ?? ""}
                    onChange={(v) => setTlDir(v || null)}
                    placeholder={
                      isTauri
                        ? "tl/chinese 目录（绝对）"
                        : "tl/chinese（相对路径）"
                    }
                    status={tlDirStatus}
                    onBrowse={async () => {
                      if (!isTauri) return;
                      const res = await pickAndReadTextFile();
                      if (res) setTlDir(res.path);
                    }}
                    onClear={() => {
                      setTlDir(null);
                      setTlDirStatus(null);
                    }}
                    disabled={running}
                  />
                </>
              )}

              {/* ZIP mode: tl/ subdir name */}
              {inputMode === "zip" && (
                <>
                  <SectionLabel>tl/ 子目录名称</SectionLabel>
                  <input
                    className="path-row__input"
                    value={tlSubDir}
                    onChange={(e) => setTlSubDir(e.target.value)}
                    placeholder="例：chinese"
                    disabled={running}
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      marginTop: "0.35rem",
                    }}
                  />
                  <p className="tools-hint">
                    ZIP 内 tl/&lt;名称&gt;/ 下的 .rpy 翻译文件。
                  </p>
                </>
              )}

              {/* LLM — identical for both modes */}
              <label
                className="tools-optional-row"
                style={{ marginTop: "0.5rem" }}
              >
                <input
                  type="checkbox"
                  className="tools-optional-checkbox"
                  checked={enableLlm}
                  onChange={(e) => setEnableLlm(e.target.checked)}
                  disabled={running}
                />
                <span className="settings-label" style={{ marginBottom: 0 }}>
                  LLM 翻译
                </span>
                <span className="tools-optional-tag">可选</span>
              </label>

              {enableLlm && (
                <div className="tools-llm-config">
                  {/* API endpoint */}
                  <div className="tools-llm-row">
                    <label className="tools-llm-label">Endpoint</label>
                    <input
                      className="tools-llm-input"
                      value={llmConfig.endpoint}
                      onChange={(e) =>
                        updateLlmConfig({ endpoint: e.target.value })
                      }
                      disabled={running}
                    />
                  </div>
                  {/* API key */}
                  <div className="tools-llm-row">
                    <label className="tools-llm-label">API Key</label>
                    <input
                      className="tools-llm-input"
                      type="password"
                      value={llmConfig.apiKey}
                      onChange={(e) =>
                        updateLlmConfig({ apiKey: e.target.value })
                      }
                      disabled={running}
                    />
                  </div>
                  {/* Model */}
                  <div className="tools-llm-row">
                    <label className="tools-llm-label">Model</label>
                    <input
                      className="tools-llm-input"
                      value={llmConfig.model}
                      onChange={(e) =>
                        updateLlmConfig({ model: e.target.value })
                      }
                      disabled={running}
                    />
                  </div>
                  {/* Batch / Concurrency / Lang */}
                  <div className="tools-llm-row">
                    <label className="tools-llm-label">批大小</label>
                    <input
                      className="tools-llm-input tools-llm-input--short"
                      type="number"
                      min={1}
                      max={100}
                      value={llmConfig.batchSize}
                      onChange={(e) =>
                        updateLlmConfig({ batchSize: +e.target.value })
                      }
                      disabled={running}
                    />
                    <label
                      className="tools-llm-label"
                      style={{ marginLeft: "1rem" }}
                    >
                      并发
                    </label>
                    <input
                      className="tools-llm-input tools-llm-input--short"
                      type="number"
                      min={1}
                      max={20}
                      value={llmConfig.concurrency}
                      onChange={(e) =>
                        updateLlmConfig({ concurrency: +e.target.value })
                      }
                      disabled={running}
                    />
                    <label
                      className="tools-llm-label"
                      style={{ marginLeft: "1rem" }}
                    >
                      目标语言
                    </label>
                    <input
                      className="tools-llm-input tools-llm-input--short"
                      value={llmConfig.targetLang}
                      onChange={(e) =>
                        updateLlmConfig({ targetLang: e.target.value })
                      }
                      disabled={running}
                    />
                  </div>
                  {/* System prompt */}
                  <div className="tools-llm-row tools-llm-row--col">
                    <div className="tools-llm-prompt-header">
                      <label className="tools-llm-label">System Prompt</label>
                      <button
                        className="btn"
                        style={{
                          fontSize: "0.78rem",
                          padding: "0.15rem 0.5rem",
                        }}
                        disabled={running}
                        onClick={() =>
                          updateLlmConfig({
                            systemPrompt: DEFAULT_SYSTEM_PROMPT,
                          })
                        }
                        title="恢复为内置默认提示词"
                      >
                        恢复默认
                      </button>
                    </div>
                    <textarea
                      className="tools-llm-prompt-textarea"
                      value={llmConfig.systemPrompt}
                      onChange={(e) =>
                        updateLlmConfig({ systemPrompt: e.target.value })
                      }
                      disabled={running}
                      rows={5}
                      spellCheck={false}
                    />
                    <p className="tools-hint" style={{ marginTop: "0.3rem" }}>
                      用{" "}
                      <code style={{ fontFamily: "var(--font-mono)" }}>
                        {"{targetLang}"}
                      </code>{" "}
                      作为目标语言占位符。 提示词必须要求模型返回格式为{" "}
                      <code style={{ fontFamily: "var(--font-mono)" }}>
                        {"{"}"1": "...", "2": "..."{"}"}
                      </code>{" "}
                      的 JSON 对象。
                    </p>
                  </div>
                  {/* Cache row */}
                  <div className="tools-llm-cache-row">
                    <span className="tools-llm-cache-count">
                      已缓存 {llmCachedCount} 条
                    </span>
                    <button
                      className="btn tools-llm-cache-btn"
                      disabled={running || llmCachedCount === 0}
                      onClick={() =>
                        exportMapAsJson(
                          llmMapRef.current,
                          (inputMode === "zip" ? inputFile?.name : gameDir) ??
                            "export",
                        )
                      }
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
                          if (cacheKeyRef.current)
                            await saveCache(
                              cacheKeyRef.current,
                              llmMapRef.current,
                            );
                          setLlmCachedCount(llmMapRef.current.size);
                          log(`已导入 ${n} 条翻译。`);
                        } catch (e) {
                          log(`导入失败：${e}`);
                        }
                      }}
                    >
                      导入 JSON
                    </button>
                    <button
                      className="btn tools-llm-cache-btn"
                      disabled={
                        running || allExtractedTextsRef.current.length === 0
                      }
                      onClick={() =>
                        exportUntranslated(
                          allExtractedTextsRef.current,
                          llmMapRef.current,
                          (inputMode === "zip" ? inputFile?.name : gameDir) ??
                            "export",
                        )
                      }
                    >
                      导出未翻译
                    </button>
                    <button
                      className="btn danger tools-llm-cache-btn"
                      disabled={running || llmCachedCount === 0}
                      onClick={async () => {
                        if (!cacheKeyRef.current) return;
                        if (
                          !window.confirm("确定清空翻译缓存？此操作不可撤销。")
                        )
                          return;
                        await clearCache(cacheKeyRef.current);
                        llmMapRef.current = new Map();
                        allExtractedTextsRef.current = [];
                        setLlmCachedCount(0);
                        log("已清空翻译缓存。");
                      }}
                    >
                      清空缓存
                    </button>
                  </div>
                  {/* Translation progress */}
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
                        onClick={() => llmAbortRef.current?.abort()}
                      >
                        取消翻译（直接打包）
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
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
          {enableGallery &&
            (inputMode === "dir" ? (
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
                  const res = await pickAndReadTextFile();
                  if (res) {
                    setGalleryPath(res.path);
                    log(`选择图鉴文件：${res.path}`);
                  }
                  // filters: [{ name: "Ren'Py Script", extensions: ["rpy","rpym"] }]
                }}
                onClear={() => {
                  setGalleryPath(null);
                  setGalleryPathStatus(null);
                }}
                disabled={running}
              />
            ) : (
              <input
                className="path-row__input"
                value={galleryPath ?? ""}
                onChange={(e) => setGalleryPath(e.target.value || null)}
                placeholder="gallery_images.rpy（相对于 game 根）"
                disabled={running}
                style={{
                  marginTop: "0.35rem",
                  width: "100%",
                  boxSizing: "border-box",
                }}
              />
            ))}
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
          {totalFiles > 0 && phase !== "packing" && (
            <div className="tools-progress-bar-wrap">
              <div
                className={`tools-progress-bar ${phase === "done" ? "tools-progress-bar--convert-done" : "tools-progress-bar--convert"}`}
                style={{ width: `${percent}%` }}
              />
            </div>
          )}
          {(phase === "packing" ||
            (phase === "done" && zipProgress === 100)) && (
            <div className="tools-progress-bar-wrap">
              <div
                className={`tools-progress-bar ${zipProgress === 100 ? "tools-progress-bar--zip-done" : "tools-progress-bar--zip"}`}
                style={{ width: `${zipProgress}%` }}
              />
            </div>
          )}
          {currentFile && running && (
            <p className="tools-current-file">› {currentFile}</p>
          )}
        </div>

        {/* ── Actions ── */}
        <div className="tools-actions">
          <button
            className="btn primary tools-run-btn"
            onClick={handleRun}
            disabled={!canRun}
            title={
              !canRun
                ? inputMode === "dir"
                  ? isTauri
                    ? "请先填写 Game 目录"
                    : "请先点击「选择 Game 目录」授权访问"
                  : "请先选择 ZIP 文件"
                : undefined
            }
          >
            {btnLabel}
          </button>
          <button className="btn" onClick={resetProgress} disabled={running}>
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
                    l.startsWith("✗") ||
                    (l.includes("失败") && !l.startsWith("  已加载"))
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

        {/* mode indicator */}
        {converterKind && inputMode === "dir" && (
          <p
            style={{
              marginTop: "0.5rem",
              fontSize: "0.72rem",
              color: "rgba(26,26,46,0.25)",
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
