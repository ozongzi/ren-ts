// ─── zip-rpy-migrate-tool/ZipRpyMigrateTool.tsx ──────────────────────────────
//
// Tool: read a game distribution ZIP (with nested .zip / .rpa), convert
// scripts to .rrs, copy media assets, and write assets.zip.
//
// Translation modes (mutually exclusive, both optional):
//   1. tl/ file-based  — user specifies a sub-dir under tl/, e.g. "chinese"
//                        → full path inside ZIP is tl/chinese/**/*.rpy
//   2. LLM             — same API/config/cache UI as Tools.tsx
//
// Output assets.zip layout:
//   <media paths>        — STORE copy of all image/audio/video
//   data/<n>.rrs         — converted + optionally translated scripts
//   data/manifest.json   — { files: string[], gallery?: GalleryEntry[] }

import React, { useState, useRef, useEffect, useCallback } from "react";
import type { GalleryEntry } from "../src/types";

import { convertRpy } from "./rpy-rrs-bridge/rpy2rrs-core";
import {
  convertRpyc,
  detectMinigameFromAst,
  unwrapAstNodes,
} from "./rpy-rrs-bridge/rpyc2rrs-core";
import { readRpyc } from "./rpycReader";
import { detectMinigame } from "./rpy-rrs-bridge/minigame-detect";
import { parseTranslationBlocks } from "./rpy-rrs-bridge/translation-extractor";
import { parseGalleryRpy } from "./rpy-rrs-bridge/parse-gallery-core";
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
import { CancelledError } from "./converterFs/types";
import {
  extractTexts,
  translateAll,
  applyTranslation,
  type TranslationMap,
  type LlmConfig,
  DEFAULT_LLM_CONFIG,
  DEFAULT_SYSTEM_PROMPT,
} from "./llmTranslate";
import {
  loadCache,
  saveCache,
  clearCache,
  exportMapAsJson,
  importMapFromJson,
  exportUntranslated,
} from "./translationCache";
import pako from "pako";
import { supportsConversionTools } from "../src/tauri_bridge";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScriptEntry {
  path: string; // relative to game root
  data: string | Uint8Array;
  isTl: boolean; // true = lives under tl/
}

type MediaSource =
  | { type: "zip"; file: Blob; meta: ZipEntryMeta }
  | { type: "rpa"; reader: RpaReader; entryPath: string };

interface MediaEntry {
  path: string; // destination path in assets.zip
  source: MediaSource;
}

// ─── LLM config localStorage persistence (mirrors Tools.tsx) ─────────────────

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
    /* ignore */
  }
}

// ─── Extension helpers ────────────────────────────────────────────────────────

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

function extOf(p: string): string {
  const base = p.split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i === -1 ? "" : base.slice(i + 1).toLowerCase();
}
function isMedia(ext: string) {
  return IMAGE_EXTS.has(ext) || AUDIO_EXTS.has(ext) || VIDEO_EXTS.has(ext);
}

// ─── Decompression ────────────────────────────────────────────────────────────

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
  // 浏览器 Fallback: pako
  const arrayBuffer = await blob.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);
  return pako.inflateRaw(uint8);
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

// ─── Game-dir detector ────────────────────────────────────────────────────────

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

// ─── Processor ────────────────────────────────────────────────────────────────

interface ProcessResult {
  gameDir: string;
  scripts: ScriptEntry[];
  media: MediaEntry[];
}

async function processZip(
  file: Blob,
  onLog: (s: string) => void,
): Promise<ProcessResult> {
  const index = await parseZipCentralDirectory(file);
  const gameDir = detectGameDir(index.keys());
  if (!gameDir) throw new Error("No 'game/' directory found in the ZIP.");
  onLog(`检测到 Game 目录：${gameDir}`);

  const scripts: ScriptEntry[] = [];
  const media: MediaEntry[] = [];
  const gamePfx = gameDir + "/";

  // RPA internal paths are already game-root-relative — no prefix needed
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
        if (meta.method === 8) blob = new Blob([new Uint8Array(await inflateRaw(blob))]);
        await processRpa(blob);
      } else if (ext === "zip") {
        const dataOff = await entryDataOffset(nestedFile, meta);
        let blob: Blob = nestedFile.slice(
          dataOff,
          dataOff + meta.compressedSize,
        );
        if (meta.method === 8) blob = new Blob([new Uint8Array(await inflateRaw(blob))]);
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
    if (!name.startsWith(gamePfx)) continue;
    const rel = name.slice(gamePfx.length);
    if (!rel || rel.endsWith("/")) continue;
    const ext = extOf(rel);

    if (ext === "rpa") {
      onLog(`  解析 RPA：${rel}`);
      const dataOff = await entryDataOffset(file, meta);
      let blob: Blob = file.slice(dataOff, dataOff + meta.compressedSize);
      if (meta.method === 8) {
        try {
          blob = new Blob([new Uint8Array(await inflateRaw(blob))]);
        } catch (e) {
          onLog(`  ⚠ 解压失败：${rel}: ${e}`);
          continue;
        }
      }
      await processRpa(blob);
    } else if (ext === "zip") {
      onLog(`  解析嵌套 ZIP：${rel}`);
      const dataOff = await entryDataOffset(file, meta);
      let blob: Blob = file.slice(dataOff, dataOff + meta.compressedSize);
      if (meta.method === 8) {
        try {
          blob = new Blob([new Uint8Array(await inflateRaw(blob))]);
        } catch (e) {
          onLog(`  ⚠ 解压失败：${rel}: ${e}`);
          continue;
        }
      }
      const parentDir = rel.split("/").slice(0, -1).join("/");
      await processNestedZip(blob, parentDir);
    } else if (isMedia(ext)) {
      media.push({ path: rel, source: { type: "zip", file, meta } });
    } else if (ext === "rpy") {
      try {
        const bytes = await readEntryBytes(file, meta);
        scripts.push({
          path: rel,
          data: new TextDecoder("utf-8").decode(bytes),
          isTl: rel.startsWith("tl/"),
        });
      } catch (e) {
        onLog(`  ⚠ 读取失败：${rel}: ${e}`);
      }
    } else if (ext === "rpyc") {
      try {
        scripts.push({
          path: rel,
          data: await readEntryBytes(file, meta),
          isTl: rel.startsWith("tl/"),
        });
      } catch (e) {
        onLog(`  ⚠ 读取失败：${rel}: ${e}`);
      }
    }
  }

  return { gameDir, scripts, media };
}

// ─── ZIP writer ───────────────────────────────────────────────────────────────

interface WriterOpts {
  scriptsMap: Map<string, string>;
  mediaEntries: MediaEntry[];
  gallery?: GalleryEntry[];
  onProgress?: (written: number, total: number, current: string) => void;
}

async function writeAssetsZip(
  writable: FileSystemWritableFileStream,
  opts: WriterOpts,
): Promise<void> {
  const { scriptsMap, mediaEntries, gallery, onProgress } = opts;
  const centralDir: CentralDirEntry[] = [];
  let archiveOffset = 0;
  let written = 0;
  const total = mediaEntries.length + scriptsMap.size + 1; // +1 manifest

  async function writeChunk(chunk: Uint8Array) {
    await writable.write(u8(chunk));
    archiveOffset += chunk.length;
  }

  async function writeMedia(entry: MediaEntry) {
    const nameBytes = encodeUtf8(entry.path);
    const now = new Date();
    const { modTime, modDate } = dosDateTime(now);
    const localHeaderOffset = archiveOffset;
    await writeChunk(
      buildLocalHeader(nameBytes, ZIP_METHOD_STORE, modTime, modDate),
    );

    let readable: ReadableStream<Uint8Array>;
    if (entry.source.type === "zip") {
      const { file, meta } = entry.source;
      const compStream = await entryCompressedStream(file, meta);
      readable =
        meta.method === 0
          ? compStream
          : (compStream.pipeThrough(new DecompressionStream("deflate-raw") as any) as ReadableStream<Uint8Array>);
    } else {
      const s = entry.source.reader.stream(entry.source.entryPath);
      if (!s) throw new Error(`RPA entry not found: ${entry.source.entryPath}`);
      readable = s;
    }

    const { crc, size: uncompressedSize } = await crc32Stream(
      readable,
      async (chunk) => {
        await writeChunk(chunk);
      },
    );
    await writeChunk(
      buildDataDescriptor(crc, uncompressedSize, uncompressedSize),
    );
    centralDir.push({
      nameBytes,
      method: ZIP_METHOD_STORE,
      modTime,
      modDate,
      crc,
      compressedSize: uncompressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    written++;
    onProgress?.(written, total, entry.path);
  }

  async function writeVirtual(zipPath: string, content: string) {
    const nameBytes = encodeUtf8(zipPath);
    const now = new Date();
    const { modTime, modDate } = dosDateTime(now);
    const method = shouldDeflate(zipPath)
      ? ZIP_METHOD_DEFLATE
      : ZIP_METHOD_STORE;
    const localHeaderOffset = archiveOffset;
    await writeChunk(buildLocalHeader(nameBytes, method, modTime, modDate));

    const bytes = new TextEncoder().encode(content);
    const readable = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(bytes);
        ctrl.close();
      },
    });

    let crc = 0,
      compressedSize = 0,
      uncompressedSize = 0;
    if (method === ZIP_METHOD_STORE) {
      const res = await crc32Stream(readable, async (chunk) => {
        await writeChunk(chunk);
      });
      crc = res.crc;
      uncompressedSize = res.size;
      compressedSize = res.size;
    } else {
      const res = await deflateStream(readable, writable, (n) => {
        archiveOffset += n;
        compressedSize += n;
      });
      crc = res.crc;
      uncompressedSize = res.uncompressedSize;
      if (compressedSize === 0) compressedSize = res.compressedSize;
    }

    await writeChunk(
      buildDataDescriptor(crc, compressedSize, uncompressedSize),
    );
    centralDir.push({
      nameBytes,
      method,
      modTime,
      modDate,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    written++;
    onProgress?.(written, total, zipPath);
  }

  for (const entry of mediaEntries) await writeMedia(entry);
  for (const [rrsName, content] of scriptsMap)
    await writeVirtual(`data/${rrsName}`, content);
  const manifest: Record<string, unknown> = {
    files: Array.from(scriptsMap.keys()),
  };
  if (gallery !== undefined) manifest.gallery = gallery;
  await writeVirtual("data/manifest.json", JSON.stringify(manifest, null, 2));
  await writeZipFooter(writable, centralDir, archiveOffset);
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

type PathStatus = "ok" | "no" | "checking" | null;

function StatusDot({ status }: { status: PathStatus }) {
  if (!status || status === "checking")
    return (
      <span
        className={`status-dot ${status === "checking" ? "status-dot--loading" : ""}`}
        aria-hidden
      />
    );
  return (
    <span
      className={`status-dot ${status === "ok" ? "status-dot--ok" : "status-dot--error"}`}
      aria-hidden
    />
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

export const ZipRpyMigrateTool: React.FC<{ onClose: () => void }> = ({
  onClose,
}) => {
  // ── Input file ────────────────────────────────────────────────────────────
  const [inputFile, setInputFile] = useState<File | null>(null);
  const inputFileRef = useRef<HTMLInputElement>(null);

  // ── File-based translation ────────────────────────────────────────────────
  const [enableTranslation, setEnableTranslation] = useState(false);
  // User types just the sub-dir name under tl/, e.g. "chinese" → tl/chinese/
  const [tlSubDir, setTlSubDir] = useState("chinese");

  // ── LLM translation ───────────────────────────────────────────────────────
  const [enableLlm, setEnableLlm] = useState(false);
  const [llmApiKey, setLlmApiKey] = useState("");
  const [llmConfig, setLlmConfig] = useState<Omit<LlmConfig, "apiKey">>(() =>
    loadLlmConfig(),
  );
  const llmMapRef = useRef<TranslationMap>(new Map());
  const [llmCachedCount, setLlmCachedCount] = useState(0);
  const [llmTranslatedTotal, setLlmTranslatedTotal] = useState(0);
  const [llmGrandTotal, setLlmGrandTotal] = useState(0);
  const [llmFailedBatches, setLlmFailedBatches] = useState(0);
  const allExtractedTextsRef = useRef<string[]>([]);
  const llmAbortRef = useRef<AbortController | null>(null);
  // Cache key = input zip filename, set when file is picked
  const cacheKeyRef = useRef<string>("");

  // ── Gallery ───────────────────────────────────────────────────────────────
  const [enableGallery, setEnableGallery] = useState(false);
  const [galleryRelPath, setGalleryRelPath] = useState("gallery_images.rpy");

  // ── Run state ─────────────────────────────────────────────────────────────
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<
    "idle" | "scanning" | "converting" | "translating" | "packing" | "done"
  >("idle");
  const [progress, setProgress] = useState(0);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const log = useCallback((s: string) => setLogs((l) => [...l, s]), []);

  // ── LLM config updater ────────────────────────────────────────────────────
  const updateLlmConfig = useCallback(
    (patch: Partial<Omit<LlmConfig, "apiKey">>) => {
      setLlmConfig((prev) => {
        const next = { ...prev, ...patch };
        saveLlmConfig(next);
        return next;
      });
    },
    [],
  );

  // ── Mutual exclusivity ────────────────────────────────────────────────────
  const handleEnableTranslation = (v: boolean) => {
    setEnableTranslation(v);
    if (v) setEnableLlm(false);
  };
  const handleEnableLlm = (v: boolean) => {
    setEnableLlm(v);
    if (v) setEnableTranslation(false);
  };

  // ── File pick: also load LLM cache keyed by filename ─────────────────────
  function handleFileChange(f: File) {
    setInputFile(f);
    cacheKeyRef.current = f.name;
    loadCache(f.name).then((map) => {
      llmMapRef.current = map;
      setLlmCachedCount(map.size);
    });
  }

  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !running) onClose();
  };

  // ── Main run ──────────────────────────────────────────────────────────────
  async function run() {
    if (!inputFile || running) return;

    // Require platform support (Tauri or File System Access API). If not
    // available, refuse to proceed to avoid Blob-based fallbacks that OOM.
    if (!supportsConversionTools) {
      alert(
        "当前环境不支持本工具（需要 Tauri 或支持 File System Access API 的浏览器）。\n已中止。",
      );
      return;
    }

    // Pre-acquire save target inside user gesture
    let saveHandle: FileSystemFileHandle | null = null;
    let tauriSavePath: string | null = null;
    try {
      if ((window as any).__TAURI_INTERNALS__) {
        // Tauri: use native save dialog provided by pickSavePath (see TauriConverterFs)
        const { pickSavePath } = await import("../src/tauri/fs");
        tauriSavePath = await pickSavePath({
          title: "保存 assets.zip",
          defaultPath: "assets.zip",
          filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
        });
        if (!tauriSavePath) return;
      } else {
        saveHandle = await (window as any).showSaveFilePicker({
          suggestedName: "assets.zip",
          types: [
            {
              description: "ZIP Archive",
              accept: { "application/zip": [".zip"] },
            },
          ],
        });
        if (!saveHandle) return;
      }
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      alert("无法打开保存对话框，已中止。请在受支持的环境中运行此工具。");
      return;
    }

    setRunning(true);
    setPhase("scanning");
    setLogs([]);
    setProgress(0);
    setCurrentFile(null);
    setLlmTranslatedTotal(0);
    setLlmGrandTotal(0);
    setLlmFailedBatches(0);

    try {
      // ── 1. Scan ZIP ───────────────────────────────────────────────────────
      log(`正在解析 ZIP：${inputFile.name}`);
      const result = await processZip(inputFile, log);
      log(
        `扫描完成：${result.scripts.length} 个脚本，${result.media.length} 个媒体文件`,
      );

      // ── 2. File-based translation map ─────────────────────────────────────
      let translationMap: Map<string, string> | undefined;
      if (enableTranslation && tlSubDir.trim()) {
        const tlPrefix = `tl/${tlSubDir.trim()}/`;
        const tlScripts = result.scripts.filter(
          (s) =>
            s.isTl && s.path.startsWith(tlPrefix) && typeof s.data === "string",
        );
        if (tlScripts.length > 0) {
          log(`加载翻译：${tlPrefix}（${tlScripts.length} 个文件）`);
          translationMap = new Map();
          for (const s of tlScripts) {
            try {
              const m = parseTranslationBlocks(s.data as string);
              for (const [k, v] of m)
                if (!translationMap.has(k)) translationMap.set(k, v);
              log(`  已加载：${s.path}`);
            } catch {
              log(`  ⚠ 解析翻译失败：${s.path}`);
            }
          }
          log(`翻译映射大小：${translationMap.size}`);
        } else {
          log(`⚠ ${tlPrefix} 下未找到 .rpy 翻译文件`);
        }
      }

      // ── 3. Gallery ────────────────────────────────────────────────────────
      let galleryEntries: GalleryEntry[] | undefined;
      if (enableGallery) {
        const galleryScript = result.scripts.find(
          (s) =>
            s.path === galleryRelPath ||
            s.path.endsWith("/" + galleryRelPath.replace(/^.*\//, "")),
        );
        if (galleryScript && typeof galleryScript.data === "string") {
          try {
            galleryEntries = parseGalleryRpy(galleryScript.data);
            log(`解析到 ${galleryEntries.length} 个图鉴入口`);
          } catch (e) {
            log(`  ⚠ 图鉴解析失败：${e}`);
          }
        } else {
          log(`  ⚠ 未找到图鉴文件：${galleryRelPath}`);
        }
      }

      // ── 4. Convert scripts → .rrs ─────────────────────────────────────────
      setPhase("converting");
      const nonTlScripts = result.scripts.filter((s) => !s.isTl);
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

      log(`开始转换 ${toConvert.length} 个脚本…`);
      const scriptsMap = new Map<string, string>();

      for (let i = 0; i < toConvert.length; i++) {
        const s = toConvert[i];
        setCurrentFile(s.path);
        setProgress(Math.round((i / toConvert.length) * 55));
        const rrsName = s.path.replace(/\.rpyc?$/i, ".rrs");
        try {
          if (typeof s.data === "string") {
            const mgResult = detectMinigame(s.data);
            for (const w of mgResult.warnings) log(`  ⚠ ${w}`);
            const rrs = convertRpy(
              s.data,
              rrsName,
              translationMap,
              mgResult.stubs.length > 0 ? mgResult.stubs : undefined,
            );
            scriptsMap.set(rrsName, rrs);
            log(`  转换：${rrsName}`);
          } else {
            const rpycFile = await readRpyc(s.data as Uint8Array);
            const rootNodes = unwrapAstNodes(rpycFile.astPickle);
            const mgResult = detectMinigameFromAst(rootNodes);
            for (const w of mgResult.warnings) log(`  ⚠ ${w}`);
            const rrs = convertRpyc(
              rpycFile.astPickle,
              rrsName,
              translationMap,
              mgResult.stubs.length > 0 ? mgResult.stubs : undefined,
            );
            scriptsMap.set(rrsName, rrs);
            log(`  转换（rpyc）：${rrsName}`);
          }
        } catch (e) {
          log(`  ✗ 转换失败：${s.path} — ${e}`);
        }
      }
      log(`✓ 转换完成，共 ${scriptsMap.size} 个 .rrs 文件`);
      setProgress(55);
      setCurrentFile(null);

      // ── 5. LLM translation phase ──────────────────────────────────────────
      if (enableLlm && llmApiKey.trim()) {
        setPhase("translating");
        log("──────────────────────────");
        log("开始 LLM 翻译…");

        const allTexts: string[] = [];
        for (const content of scriptsMap.values())
          allTexts.push(...extractTexts(content));
        const uniqueTexts = [...new Set(allTexts)];
        allExtractedTextsRef.current = uniqueTexts;

        const map = llmMapRef.current;
        const alreadyCached = uniqueTexts.filter((t) => map.has(t)).length;
        const needTranslation = uniqueTexts.length - alreadyCached;
        log(
          `共提取 ${uniqueTexts.length} 条文本，已缓存 ${alreadyCached} 条，待翻译 ${needTranslation} 条`,
        );

        setLlmGrandTotal(needTranslation);
        setLlmTranslatedTotal(0);
        setLlmFailedBatches(0);

        const abortCtrl = new AbortController();
        llmAbortRef.current = abortCtrl;
        const cacheKey = cacheKeyRef.current;

        await translateAll(
          uniqueTexts,
          map,
          { ...llmConfig, apiKey: llmApiKey.trim() },
          async (batchResult, doneTotal, grandTotal) => {
            setLlmTranslatedTotal(doneTotal);
            setLlmGrandTotal(grandTotal);
            if (batchResult.failed.length > 0) {
              setLlmFailedBatches((n) => n + 1);
              log(`  ⚠ 批次失败 ${batchResult.failed.length} 条（已跳过）`);
            }
            await saveCache(cacheKey, map);
            setLlmCachedCount(map.size);
          },
          abortCtrl.signal,
        );
        llmAbortRef.current = null;

        if (abortCtrl.signal.aborted) {
          log("⚠ 翻译已取消，使用已翻译部分继续打包。");
        } else {
          log(`✓ 翻译完成，共 ${map.size} 条。`);
        }
      }

      // ── 6. Apply LLM cache ────────────────────────────────────────────────
      if (enableLlm) {
        const map = llmMapRef.current;
        if (map.size > 0) {
          for (const [name, content] of scriptsMap) {
            scriptsMap.set(name, applyTranslation(content, map));
          }
          log(
            `已将翻译应用到 ${scriptsMap.size} 个脚本（缓存 ${map.size} 条）。`,
          );
        } else {
          log("⚠ LLM 翻译已启用但缓存为空，输出为原文。");
        }
      }

      // ── 7. Pack assets.zip ────────────────────────────────────────────────
      setPhase("packing");
      setCurrentFile(null);
      log("──────────────────────────");
      log(
        `开始打包：${result.media.length} 个媒体 + ${scriptsMap.size} 个脚本…`,
      );

      const writerOpts: WriterOpts = {
        scriptsMap,
        mediaEntries: result.media,
        gallery: galleryEntries,
        onProgress(written, total, current) {
          setProgress(55 + Math.round((written / total) * 45));
          setCurrentFile(current);
        },
      };

      if (saveHandle) {
        const writable = await saveHandle.createWritable();
        try {
          await writeAssetsZip(writable, writerOpts);
        } finally {
          await writable.close();
        }
        log(`✓ 已保存：${(saveHandle as any).name ?? "assets.zip"}`);
      } else if (tauriSavePath) {
        // Tauri: open a native file handle and stream writes to it to avoid
        // allocating the whole archive in JS heap.
        try {
          const { open } = await import("@tauri-apps/plugin-fs");
          const fh = await open(tauriSavePath, { write: true, create: true, truncate: true });
          const tauriWritable = {
            async write(data: Uint8Array | BufferSource) {
              const buf = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
              // Tauri's fh.write accepts a Uint8Array
              await fh.write(buf);
            },
            async close() {
              await fh.close();
            },
            async abort() {
              try { await fh.close(); } catch (e) {}
            },
            async seek(_pos?: number) {
              // Not implemented; streaming writer writes sequentially.
            },
            async truncate(_size?: number) {
              // Not implemented.
            },
          } as unknown as FileSystemWritableFileStream;

          try {
            await writeAssetsZip(tauriWritable, writerOpts);
          } finally {
            try { await tauriWritable.close(); } catch (e) {}
          }
          log(`✓ 已保存：${tauriSavePath}`);
        } catch (err) {
          log(`✗ 保存失败（Tauri）：${err instanceof Error ? err.message : String(err)}`);
          throw err;
        }
      } else {
        // Blob fallback for environments without showSaveFilePicker
        const chunks: Uint8Array[] = [];
        const fakeWritable = {
          write(data: Uint8Array | BufferSource) {
            chunks.push(
              data instanceof Uint8Array
                ? data
                : new Uint8Array(data as ArrayBuffer),
            );
            return Promise.resolve();
          },
          close() {
            return Promise.resolve();
          },
          abort() {
            return Promise.resolve();
          },
          seek() {
            return Promise.resolve();
          },
          truncate() {
            return Promise.resolve();
          },
        } as unknown as FileSystemWritableFileStream;
        await writeAssetsZip(fakeWritable, writerOpts);
        // TypeScript strict: ensure ArrayBuffer[]
        const abChunks = chunks.map(chunk =>
          (chunk instanceof Uint8Array ? new Uint8Array(chunk) : new Uint8Array(chunk))
        );
        const blob = new Blob(abChunks, { type: "application/zip" });
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement("a"), {
          href: url,
          download: "assets.zip",
        });
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          URL.revokeObjectURL(url);
          a.remove();
        }, 2000);
        log("✓ 已触发下载：assets.zip");
      }

      setProgress(100);
      setPhase("done");
      setCurrentFile(null);
    } catch (e) {
      if (e instanceof CancelledError) {
        log("已取消。");
        setPhase("idle");
      } else {
        log(`✗ 错误：${e instanceof Error ? e.message : String(e)}`);
        setPhase("idle");
      }
    } finally {
      setRunning(false);
    }
  }

  // ── Derived labels ────────────────────────────────────────────────────────
  const statusLabel =
    phase === "scanning"
      ? "扫描中…"
      : phase === "converting"
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

  const canRun = !running && !!inputFile;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className="modal-overlay"
      onClick={handleBackdrop}
      role="dialog"
      aria-modal="true"
      aria-label="ZIP 迁移工具"
    >
      <div
        className="modal-panel"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "min(640px, 94vw)" }}
      >
        {/* ── Header ── */}
        <div className="modal-header">
          <h2 className="modal-title">📦 ZIP → Assets 打包工具</h2>
          <button
            className="modal-close-btn"
            onClick={onClose}
            disabled={running}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        {/* ── Section 1: 源 ZIP ── */}
        <div className="settings-group">
          <SectionLabel>源 ZIP 文件</SectionLabel>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <button
              className="btn"
              onClick={() => inputFileRef.current?.click()}
              disabled={running}
              style={{ flex: "0 0 auto" }}
            >
              📂 选择 ZIP
            </button>
            <StatusDot status={inputFile ? "ok" : null} />
            {inputFile ? (
              <>
                <span
                  style={{
                    fontSize: "0.82rem",
                    color: "var(--color-text-dim)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                  }}
                  title={inputFile.name}
                >
                  {inputFile.name}
                </span>
                <button
                  className="path-row__btn"
                  onClick={() => setInputFile(null)}
                  disabled={running}
                  aria-label="清除"
                >
                  ✕
                </button>
              </>
            ) : (
              <span
                style={{ fontSize: "0.82rem", color: "var(--color-text-dim)" }}
              >
                未选择
              </span>
            )}
          </div>
          <input
            ref={inputFileRef}
            type="file"
            accept=".zip"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFileChange(f);
              e.target.value = "";
            }}
          />
          <p className="tools-hint">
            选择游戏发行 ZIP。工具自动定位最外层{" "}
            <code style={{ fontFamily: "var(--font-mono)" }}>game/</code>
            ，递归解析所有嵌套 .zip / .rpa。
          </p>
        </div>

        <div className="divider" />

        {/* ── Section 2: 翻译 ── */}
        <div className="settings-group">
          {/* 2a. 文件翻译 */}
          <label className="tools-optional-row">
            <input
              type="checkbox"
              className="tools-optional-checkbox"
              checked={enableTranslation}
              onChange={(e) => handleEnableTranslation(e.target.checked)}
              disabled={running}
            />
            <span className="settings-label" style={{ marginBottom: 0 }}>
              tl/ 翻译目录
            </span>
            <span className="tools-optional-tag">可选</span>
          </label>

          {enableTranslation && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.4rem",
                marginTop: "0.35rem",
              }}
            >
              <code
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.85rem",
                  color: "var(--color-text-dim)",
                  whiteSpace: "nowrap",
                }}
              >
                tl /
              </code>
              <input
                className="path-row__input"
                value={tlSubDir}
                onChange={(e) => setTlSubDir(e.target.value)}
                placeholder="chinese"
                disabled={running}
                style={{ flex: 1 }}
              />
              <code
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.85rem",
                  color: "var(--color-text-dim)",
                  whiteSpace: "nowrap",
                }}
              >
                / *.rpy
              </code>
            </div>
          )}

          <div className="tools-llm-or-divider">── 或 ──</div>

          {/* 2b. LLM 翻译 */}
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

              {/* 系统提示词 */}
              <div className="tools-llm-prompt-section">
                <div className="tools-llm-prompt-header">
                  <span className="tools-llm-label" style={{ minWidth: 0 }}>
                    系统提示词
                  </span>
                  <button
                    className="btn tools-llm-cache-btn"
                    disabled={running}
                    onClick={() =>
                      updateLlmConfig({ systemPrompt: DEFAULT_SYSTEM_PROMPT })
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
                  作为目标语言占位符。提示词必须要求模型返回格式为{" "}
                  <code style={{ fontFamily: "var(--font-mono)" }}>
                    {"{"}"1": "...", "2": "..."{"}"}
                  </code>{" "}
                  的 JSON 对象。
                </p>
              </div>

              {/* 缓存操作行 */}
              <div className="tools-llm-cache-row">
                <span className="tools-llm-cache-count">
                  已缓存 {llmCachedCount} 条
                </span>
                <button
                  className="btn tools-llm-cache-btn"
                  disabled={running || llmCachedCount === 0}
                  onClick={() =>
                    exportMapAsJson(llmMapRef.current, inputFile?.name ?? "zip")
                  }
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
                      if (cacheKeyRef.current)
                        await saveCache(cacheKeyRef.current, llmMapRef.current);
                      setLlmCachedCount(llmMapRef.current.size);
                      log(`已导入 ${n} 条翻译。`);
                    } catch (e) {
                      log(`导入失败：${e}`);
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
                  onClick={() =>
                    exportUntranslated(
                      allExtractedTextsRef.current,
                      llmMapRef.current,
                      inputFile?.name ?? "zip",
                    )
                  }
                  title="导出尚未翻译的条目"
                >
                  导出未翻译
                </button>
                <button
                  className="btn danger tools-llm-cache-btn"
                  disabled={running || llmCachedCount === 0}
                  onClick={async () => {
                    if (!cacheKeyRef.current) return;
                    if (!window.confirm("确定清空翻译缓存？此操作不可撤销。"))
                      return;
                    await clearCache(cacheKeyRef.current);
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

              {/* 翻译中实时进度 */}
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
          {enableGallery && (
            <input
              className="path-row__input"
              value={galleryRelPath}
              onChange={(e) => setGalleryRelPath(e.target.value)}
              placeholder="gallery_images.rpy（相对于 game 根）"
              disabled={running}
              style={{
                marginTop: "0.35rem",
                width: "100%",
                boxSizing: "border-box",
              }}
            />
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
            {running && (
              <span className="tools-progress-count">{progress}%</span>
            )}
          </div>
          {(running || phase === "done") && (
            <div className="tools-progress-bar-wrap">
              <div
                className={`tools-progress-bar ${phase === "done" ? "tools-progress-bar--zip-done" : "tools-progress-bar--zip"}`}
                style={{ width: `${progress}%` }}
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
            onClick={run}
            disabled={!canRun}
            title={!inputFile ? "请先选择源 ZIP 文件" : undefined}
          >
            {btnLabel}
          </button>
          <button
            className="btn"
            disabled={running}
            onClick={() => {
              setLogs([]);
              setPhase("idle");
              setProgress(0);
              setCurrentFile(null);
              setLlmTranslatedTotal(0);
              setLlmGrandTotal(0);
              setLlmFailedBatches(0);
            }}
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
                    l.includes("✗") ||
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
      </div>
    </div>
  );
};
