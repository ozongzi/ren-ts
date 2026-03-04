// ─── rpy-migrate-tool/Tools.tsx ───────────────────────────────────────────────
// Tauri-only converter panel.  dir / zip input modes.
// Translation: file-based JSON | tl/ extraction (JS-side parseTranslationBlocks) | LLM
// Problem fixes vs previous version:
//   1. UI no longer "freezes" — log events stream in via Tauri event listener
//   2. tl/ extraction: list langs → pick → read_tl_files → JS parse → write JSON
//   3. dir mode: same tl/ extraction flow
//   4. rpy minigame: handled Rust-side (detect_minigame_from_rpy in converter)

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useGameStore } from "../src/store";
import {
  isTauri,
  pickDirectory,
  pickZipFileTauri,
  pickSavePath,
  writeTextFileTauri,
  readTextFileTauri,
} from "../src/tauri_bridge";
import {
  translateAll,
  type TranslationMap,
  type LlmConfig,
  DEFAULT_LLM_CONFIG,
  DEFAULT_SYSTEM_PROMPT,
} from "./llmTranslate";
import {
  loadCache, saveCache, clearCache,
  exportMapAsJson, importMapFromJson, exportUntranslated,
} from "./translationCache";
import { parseTranslationBlocks } from "./rpy-rrs-bridge/translation-extractor";

// ─── Types ─────────────────────────────────────────────────────────────────────
type InputMode = "dir" | "zip";
type TlMode    = "none" | "tl_extract" | "tl_file" | "llm";
type Phase     = "idle" | "listing_langs" | "reading_tl" | "exporting" | "translating" | "converting" | "done";

// ─── LLM config persistence ────────────────────────────────────────────────────
const LLM_CFG_KEY = "rents_llm_config";
function loadLlmConfig(): Omit<LlmConfig, "apiKey"> {
  try {
    const raw = localStorage.getItem(LLM_CFG_KEY);
    if (!raw) return { ...DEFAULT_LLM_CONFIG };
    const p = JSON.parse(raw);
    return {
      endpoint:     typeof p.endpoint     === "string" ? p.endpoint     : DEFAULT_LLM_CONFIG.endpoint,
      model:        typeof p.model        === "string" ? p.model        : DEFAULT_LLM_CONFIG.model,
      batchSize:    typeof p.batchSize    === "number" ? p.batchSize    : DEFAULT_LLM_CONFIG.batchSize,
      concurrency:  typeof p.concurrency  === "number" ? p.concurrency  : DEFAULT_LLM_CONFIG.concurrency,
      targetLang:   typeof p.targetLang   === "string" ? p.targetLang   : DEFAULT_LLM_CONFIG.targetLang,
      systemPrompt: typeof p.systemPrompt === "string" && p.systemPrompt.trim()
                      ? p.systemPrompt : DEFAULT_LLM_CONFIG.systemPrompt,
    };
  } catch { return { ...DEFAULT_LLM_CONFIG }; }
}
function saveLlmConfig(cfg: Omit<LlmConfig, "apiKey">) {
  try { localStorage.setItem(LLM_CFG_KEY, JSON.stringify(cfg)); } catch {}
}

// ─── Tauri invoke helper ───────────────────────────────────────────────────────
async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args ?? {});
}

// ─── Main Component ────────────────────────────────────────────────────────────
export const Tools: React.FC = () => {
  const closeTools = useGameStore((s: any) => s.closeTools);

  // Input
  const [inputMode, setInputMode] = useState<InputMode>("dir");
  const [dirPath,   setDirPath]   = useState("");
  const [zipPath,   setZipPath]   = useState("");
  const [outputPath, setOutputPath] = useState("");

  // Translation mode
  const [tlMode, setTlMode] = useState<TlMode>("none");
  // tl_extract
  const [availLangs,   setAvailLangs]   = useState<string[]>([]);
  const [selectedLang, setSelectedLang] = useState("");
  const [tlExtractedPath, setTlExtractedPath] = useState(""); // written temp json
  // tl_file
  const [tlJsonPath, setTlJsonPath] = useState("");
  // llm
  const [llmApiKey,  setLlmApiKey]  = useState("");
  const [llmConfig,  setLlmConfig]  = useState<Omit<LlmConfig,"apiKey">>(() => loadLlmConfig());
  const llmMapRef  = useRef<TranslationMap>(new Map());
  const [llmCachedCount,      setLlmCachedCount]      = useState(0);
  const [llmTranslatedTotal,  setLlmTranslatedTotal]  = useState(0);
  const [llmGrandTotal,       setLlmGrandTotal]       = useState(0);
  const [llmFailedBatches,    setLlmFailedBatches]    = useState(0);
  const allExtractedTextsRef = useRef<string[]>([]);
  const llmAbortRef = useRef<AbortController | null>(null);
  const cacheKeyRef = useRef("");

  // Run state
  const [phase,   setPhase]   = useState<Phase>("idle");
  const running = phase !== "idle" && phase !== "done";
  const [logs,    setLogs]    = useState<string[]>([]);
  const logRef    = useRef<HTMLDivElement>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  // ── Tauri log event listener ───────────────────────────────────────────────
  useEffect(() => {
    if (!isTauri) return;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<string>("log", (e: any) => {
        const msg = String(e.payload ?? "").trim();
        if (msg) setLogs((l: string[]) => [...l, msg]);
      });
      unlistenRef.current = unlisten;
    })();
    return () => { unlistenRef.current?.(); unlistenRef.current = null; };
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const appendLog = useCallback((msg: string) => setLogs((l: string[]) => [...l, msg]), []);

  // ── Reload LLM cache when input changes ───────────────────────────────────
  useEffect(() => {
    const key = inputMode === "dir" ? dirPath : zipPath;
    if (!key) return;
    cacheKeyRef.current = key;
    loadCache(key).then((m: TranslationMap) => { llmMapRef.current = m; setLlmCachedCount(m.size); });
  }, [dirPath, zipPath, inputMode]);

  // ── Reset available langs when input/mode changes ─────────────────────────
  useEffect(() => {
    setAvailLangs([]);
    setSelectedLang("");
    setTlExtractedPath("");
  }, [dirPath, zipPath, inputMode]);

  const updateLlmConfig = useCallback((patch: Partial<Omit<LlmConfig,"apiKey">>) => {
    setLlmConfig((prev: any) => { const next = { ...prev, ...patch }; saveLlmConfig(next); return next; });
  }, []);

  // ── File pickers ───────────────────────────────────────────────────────────
  async function pickDir()    { const p = await pickDirectory().catch(() => null);                 if (p) setDirPath(p); }
  async function pickZip()    { const p = await pickZipFileTauri().catch(() => null);              if (p) setZipPath(p); }
  async function pickOutput() { const p = await pickSavePath({ defaultPath: "output.zip" }).catch(() => null); if (p) setOutputPath(p); }
  async function pickTlJson() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const p = await open({ filters: [{ name: "JSON", extensions: ["json"] }] }).catch(() => null);
    if (p && typeof p === "string") setTlJsonPath(p);
  }

  function reset() {
    setLogs([]); setPhase("idle");
    setLlmTranslatedTotal(0); setLlmGrandTotal(0); setLlmFailedBatches(0);
  }

  async function removeTmp(path: string) {
    try { const { remove } = await import("@tauri-apps/plugin-fs"); await remove(path); } catch {}
  }

  // ── List tl/ languages ─────────────────────────────────────────────────────
  async function loadLangs() {
    const input = inputMode === "dir" ? dirPath : zipPath;
    if (!input) return;
    setPhase("listing_langs");
    appendLog("▶ 查找 tl/ 语言目录…");
    try {
      const args: Record<string, unknown> = inputMode === "dir"
        ? { args: { dir: input } }
        : { args: { file: input } };
      const langs = await tauriInvoke<string[]>("list_tl_langs", args);
      setAvailLangs(langs);
      if (langs.length > 0) {
        setSelectedLang(langs[0]);
        appendLog(`✓ 找到语言: ${langs.join(", ")}`);
      } else {
        appendLog("⚠ 未找到 tl/ 子目录");
      }
    } catch (e: any) {
      appendLog(`✗ ${e?.message ?? e}`);
    } finally {
      setPhase("idle");
    }
  }

  // ── Extract tl/ → translate.json ──────────────────────────────────────────
  async function extractTlToJson(lang: string, finalOutput: string): Promise<string | null> {
    appendLog(`▶ 读取 tl/${lang}/*.rpy …`);
    setPhase("reading_tl");

    const input = inputMode === "dir" ? dirPath : zipPath;
    const args: Record<string, unknown> = inputMode === "dir"
      ? { args: { dir: input, lang } }
      : { args: { file: input, lang } };

    type TlEntry = { path: string; content: string };
    const files = await tauriInvoke<TlEntry[]>("read_tl_files", args);

    if (files.length === 0) {
      appendLog(`⚠ tl/${lang} 中没有找到 .rpy 文件`);
      return null;
    }

    appendLog(`  解析 ${files.length} 个翻译文件…`);
    const merged = new Map<string, string>();
    for (const { content } of files) {
      const m = parseTranslationBlocks(content);
      for (const [k, v] of m) {
        if (v && !merged.has(k)) merged.set(k, v);
      }
    }

    const nonEmpty = [...merged].filter(([, v]) => v.trim() !== "").length;
    appendLog(`✓ 解析完成：${nonEmpty} 条翻译`);

    if (nonEmpty === 0) {
      appendLog("⚠ 所有条目均为空，跳过注入");
      return null;
    }

    const obj: Record<string, string> = {};
    for (const [k, v] of merged) obj[k] = v;
    const tmpPath = finalOutput.replace(/\.zip$/i, `_tl_${lang}_tmp.json`);
    await writeTextFileTauri(tmpPath, JSON.stringify(obj, null, 2));
    return tmpPath;
  }

  // ── LLM translate ──────────────────────────────────────────────────────────
  async function runLlmTranslation(finalOutput: string): Promise<string | null> {
    if (!llmApiKey.trim()) { appendLog("⚠ 未填写 API Key，跳过 LLM 翻译"); return null; }

    setPhase("exporting");
    const exportTmp = finalOutput.replace(/\.zip$/i, "_export_tmp.json");
    const input = inputMode === "dir" ? dirPath : zipPath;
    if (inputMode === "dir") {
      await tauriInvoke("export_dir", { args: { dir: input, output: exportTmp } });
    } else {
      await tauriInvoke("export", { args: { file: input, output: exportTmp } });
    }

    const exportedJson = await readTextFileTauri(exportTmp);
    await removeTmp(exportTmp);
    if (!exportedJson) { appendLog("⚠ 无法读取对白文件"); return null; }
    const allTexts = Object.keys(JSON.parse(exportedJson) as Record<string, string>);
    allExtractedTextsRef.current = allTexts;
    appendLog(`✓ 提取 ${allTexts.length} 条对白`);

    setPhase("translating");
    const map = llmMapRef.current;
    const cached = allTexts.filter(t => map.has(t)).length;
    const need = allTexts.length - cached;
    appendLog(`已缓存 ${cached} 条，待翻译 ${need} 条`);
    setLlmGrandTotal(need); setLlmTranslatedTotal(0); setLlmFailedBatches(0);

    const abort = new AbortController();
    llmAbortRef.current = abort;
    const cacheKey = cacheKeyRef.current;

    await translateAll(
      allTexts, map, { ...llmConfig, apiKey: llmApiKey.trim() },
      async (batch: any, done: number, grand: number) => {
        setLlmTranslatedTotal(done); setLlmGrandTotal(grand);
        if (batch.failed.length > 0) { setLlmFailedBatches((n: number) => n + 1); appendLog(`  ⚠ 批次失败 ${batch.failed.length} 条`); }
        await saveCache(cacheKey, map); setLlmCachedCount(map.size);
      },
      abort.signal,
    );
    llmAbortRef.current = null;

    if (abort.signal.aborted) appendLog("⚠ 翻译已取消，使用已完成部分继续");
    else appendLog(`✓ 翻译完成，共 ${map.size} 条`);
    if (map.size === 0) { appendLog("⚠ 缓存为空，不注入翻译"); return null; }

    const tlTmp = finalOutput.replace(/\.zip$/i, "_tl_tmp.json");
    const obj: Record<string, string> = {};
    for (const [k, v] of map) obj[k] = v;
    await writeTextFileTauri(tlTmp, JSON.stringify(obj, null, 2));
    return tlTmp;
  }

  // ── Main run ───────────────────────────────────────────────────────────────
  async function run() {
    const input = inputMode === "dir" ? dirPath : zipPath;
    if (!input || running) return;
    reset();
    // Let React re-render first so the log panel shows "starting..."
    await new Promise(r => setTimeout(r, 50));

    const finalOutput = outputPath || "./output.zip";
    let tempTlPath: string | null = null;

    try {
      let translatePath: string | undefined;

      if (tlMode === "tl_extract" && selectedLang) {
        appendLog("──────────────────────────");
        appendLog(`▶ 提取 tl/${selectedLang} 翻译…`);
        tempTlPath = await extractTlToJson(selectedLang, finalOutput);
        if (tempTlPath) translatePath = tempTlPath;
      } else if (tlMode === "tl_file" && tlJsonPath) {
        translatePath = tlJsonPath;
        appendLog(`📄 使用翻译文件：${tlJsonPath}`);
      } else if (tlMode === "llm") {
        appendLog("──────────────────────────");
        appendLog("▶ 开始 LLM 翻译流程…");
        tempTlPath = await runLlmTranslation(finalOutput);
        if (tempTlPath) translatePath = tempTlPath;
      }

      setPhase("converting");
      appendLog("──────────────────────────");

      if (inputMode === "dir") {
        const a: Record<string, unknown> = { dir: dirPath, output: finalOutput };
        if (translatePath) a.translate = translatePath;
        await tauriInvoke("converter_dir", { args: a });
      } else {
        const a: Record<string, unknown> = { file: zipPath, output: finalOutput };
        if (translatePath) a.translate = translatePath;
        await tauriInvoke("converter", { args: a });
      }
      setPhase("done");
    } catch (err: unknown) {
      appendLog(`✗ 错误：${err instanceof Error ? err.message : String(err)}`);
      setPhase("idle");
    } finally {
      if (tempTlPath) await removeTmp(tempTlPath);
    }
  }

  async function handleExtractTlZip() {
    if (!zipPath) return; reset();
    await new Promise(r => setTimeout(r, 50));
    try {
      await tauriInvoke("extract_tl", { args: { file: zipPath, output: outputPath || "./tl.zip" } });
    } catch (e: any) { appendLog(`✗ ${e?.message ?? e}`); }
  }

  async function handleExport() {
    const input = inputMode === "dir" ? dirPath : zipPath;
    if (!input) return; reset();
    await new Promise(r => setTimeout(r, 50));
    try {
      const out = outputPath || "./export.json";
      if (inputMode === "dir") await tauriInvoke("export_dir", { args: { dir: dirPath, output: out } });
      else await tauriInvoke("export", { args: { file: zipPath, output: out } });
    } catch (e: any) { appendLog(`✗ ${e?.message ?? e}`); }
  }

  const canRun = !running && (inputMode === "dir" ? !!dirPath : !!zipPath);
  const phaseLabel =
    phase === "listing_langs" ? "查找语言中…" :
    phase === "reading_tl"    ? "读取翻译文件…" :
    phase === "exporting"     ? "提取对白中…" :
    phase === "translating"   ? "LLM 翻译中…" :
    phase === "converting"    ? "转换中…" :
    phase === "done"          ? "✓ 完成" : "就绪";
  const runBtnLabel = !running ? "▶  转换并打包" : `◌  ${phaseLabel}`;

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="modal-overlay" onClick={(e: any) => e.target === e.currentTarget && closeTools()}>
      <div className="modal-panel" style={{ maxWidth: "min(680px, 96vw)" }}>
        <div className="modal-header">
          <span className="modal-title">📦 RPY → RRS 转换工具</span>
          <button className="modal-close-btn" onClick={closeTools} disabled={running}>✕</button>
        </div>

        <div style={{ padding: "0.75rem 1rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>

          {/* ── 输入模式 ── */}
          <div className="settings-group">
            <div className="settings-label">输入源</div>
            <div className="tools-mode-toggle">
              <button className={`btn${inputMode === "dir" ? " primary" : ""}`} onClick={() => setInputMode("dir")} disabled={running}>目录</button>
              <button className={`btn${inputMode === "zip" ? " primary" : ""}`} onClick={() => setInputMode("zip")} disabled={running}>ZIP 文件</button>
            </div>
            {inputMode === "dir" && (
              <div className="path-row" style={{ marginTop: "0.4rem" }}>
                <input className="path-row__input" value={dirPath} onChange={(e: any) => setDirPath(e.target.value)} placeholder="game/ 目录（绝对路径）" disabled={running} />
                {dirPath && <button className="path-row__btn" onClick={() => setDirPath("")} disabled={running}>✕</button>}
                <button className="btn path-row__btn" onClick={pickDir} disabled={running}>浏览</button>
              </div>
            )}
            {inputMode === "zip" && (
              <div className="path-row" style={{ marginTop: "0.4rem" }}>
                <input className="path-row__input" value={zipPath} onChange={(e: any) => setZipPath(e.target.value)} placeholder="发行 ZIP 路径" disabled={running} />
                {zipPath && <button className="path-row__btn" onClick={() => setZipPath("")} disabled={running}>✕</button>}
                <button className="btn path-row__btn" onClick={pickZip} disabled={running}>浏览</button>
              </div>
            )}
          </div>

          {/* ── 输出路径 ── */}
          <div className="settings-group">
            <div className="settings-label" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              输出路径 <span className="tools-optional-tag">可选</span>
            </div>
            <div className="path-row">
              <input className="path-row__input" value={outputPath} onChange={(e: any) => setOutputPath(e.target.value)} placeholder="默认 ./output.zip" disabled={running} />
              {outputPath && <button className="path-row__btn" onClick={() => setOutputPath("")} disabled={running}>✕</button>}
              <button className="btn path-row__btn" onClick={pickOutput} disabled={running}>浏览</button>
            </div>
          </div>

          <div className="divider" />

          {/* ── 翻译选项 ── */}
          <div className="settings-group">
            <div className="settings-label" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              翻译注入 <span className="tools-optional-tag">可选</span>
            </div>

            {/* Radio group */}
            <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
              {/* 不翻译 */}
              <label className="tools-optional-row">
                <input type="radio" name="tlmode" checked={tlMode === "none"} onChange={() => setTlMode("none")} disabled={running} />
                <span>不注入翻译</span>
              </label>

              {/* tl/ 提取 */}
              <label className="tools-optional-row">
                <input type="radio" name="tlmode" checked={tlMode === "tl_extract"} onChange={() => setTlMode("tl_extract")} disabled={running} />
                <span>从 tl/ 目录提取翻译</span>
              </label>
              {tlMode === "tl_extract" && (
                <div style={{ marginLeft: "1.5rem", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                    <button className="btn" onClick={loadLangs}
                      disabled={running || !(inputMode === "dir" ? dirPath : zipPath)}>
                      检测语言
                    </button>
                    {availLangs.length > 0 && (
                      <select
                        value={selectedLang}
                        onChange={(e: any) => setSelectedLang(e.target.value)}
                        disabled={running}
                        style={{ padding: "0.25rem 0.5rem", borderRadius: "4px", border: "1px solid var(--border)", background: "var(--bg-card)", color: "var(--text)" }}
                      >
                        {availLangs.map(l => <option key={l} value={l}>{l}</option>)}
                      </select>
                    )}
                    {availLangs.length === 0 && <span style={{ fontSize: "0.8rem", opacity: 0.6 }}>先点「检测语言」</span>}
                  </div>
                  {selectedLang && (
                    <span style={{ fontSize: "0.8rem", opacity: 0.7 }}>
                      将解析 tl/{selectedLang}/*.rpy → translate.json → 注入转换
                    </span>
                  )}
                </div>
              )}

              {/* 文件翻译 JSON */}
              <label className="tools-optional-row">
                <input type="radio" name="tlmode" checked={tlMode === "tl_file"} onChange={() => setTlMode("tl_file")} disabled={running} />
                <span>使用翻译 JSON 文件</span>
              </label>
              {tlMode === "tl_file" && (
                <div className="path-row" style={{ marginLeft: "1.5rem" }}>
                  <input className="path-row__input" value={tlJsonPath} readOnly placeholder="translate.json 路径" />
                  <button className="btn path-row__btn" onClick={pickTlJson} disabled={running}>选择</button>
                </div>
              )}

              {/* LLM */}
              <label className="tools-optional-row">
                <input type="radio" name="tlmode" checked={tlMode === "llm"} onChange={() => setTlMode("llm")} disabled={running} />
                <span>LLM 自动翻译</span>
              </label>
              {tlMode === "llm" && (
                <div className="tools-llm-config" style={{ marginLeft: "1.5rem" }}>
                  <div className="tools-llm-row">
                    <span className="tools-llm-label">API 地址</span>
                    <input className="tools-llm-input tools-llm-input--wide" value={llmConfig.endpoint}
                      onChange={(e: any) => updateLlmConfig({ endpoint: e.target.value })} disabled={running} placeholder="https://api.openai.com/v1" />
                  </div>
                  <div className="tools-llm-row">
                    <span className="tools-llm-label">API Key</span>
                    <input className="tools-llm-input tools-llm-input--wide" type="password"
                      value={llmApiKey} onChange={(e: any) => setLlmApiKey(e.target.value)} disabled={running} placeholder="sk-..." autoComplete="off" />
                  </div>
                  <div className="tools-llm-row">
                    <span className="tools-llm-label">模型</span>
                    <input className="tools-llm-input" value={llmConfig.model}
                      onChange={(e: any) => updateLlmConfig({ model: e.target.value })} disabled={running} placeholder="gpt-4o-mini" />
                    <span className="tools-llm-label" style={{ marginLeft: "0.75rem" }}>目标语言</span>
                    <input className="tools-llm-input" value={llmConfig.targetLang}
                      onChange={(e: any) => updateLlmConfig({ targetLang: e.target.value })} disabled={running} placeholder="中文" />
                  </div>
                  <div className="tools-llm-row">
                    <span className="tools-llm-label">每批条数</span>
                    <input className="tools-llm-input tools-llm-input--num" type="number" min={1} max={200}
                      value={llmConfig.batchSize}
                      onChange={(e: any) => updateLlmConfig({ batchSize: Math.max(1, parseInt(e.target.value)||1) })} disabled={running} />
                    <span className="tools-llm-label" style={{ marginLeft: "0.75rem" }}>并发数</span>
                    <input className="tools-llm-input tools-llm-input--num" type="number" min={1} max={128}
                      value={llmConfig.concurrency}
                      onChange={(e: any) => updateLlmConfig({ concurrency: Math.max(1, parseInt(e.target.value)||1) })} disabled={running} />
                  </div>
                  <div className="tools-llm-prompt-section">
                    <div className="tools-llm-prompt-header">
                      <span className="tools-llm-label" style={{ minWidth: 0 }}>系统提示词</span>
                      <button className="btn tools-llm-cache-btn" disabled={running}
                        onClick={() => updateLlmConfig({ systemPrompt: DEFAULT_SYSTEM_PROMPT })}>恢复默认</button>
                    </div>
                    <textarea className="tools-llm-prompt-textarea" rows={3} spellCheck={false}
                      value={llmConfig.systemPrompt} onChange={(e: any) => updateLlmConfig({ systemPrompt: e.target.value })} disabled={running} />
                  </div>
                  <div className="tools-llm-cache-row">
                    <span className="tools-llm-cache-count">已缓存 {llmCachedCount} 条</span>
                    <button className="btn tools-llm-cache-btn" disabled={running || llmCachedCount === 0}
                      onClick={() => exportMapAsJson(llmMapRef.current, cacheKeyRef.current || "export")}>导出 JSON</button>
                    <button className="btn tools-llm-cache-btn" disabled={running}
                      onClick={async () => {
                        const n = await importMapFromJson(llmMapRef.current).catch(() => null);
                        if (n === null) return;
                        if (cacheKeyRef.current) await saveCache(cacheKeyRef.current, llmMapRef.current);
                        setLlmCachedCount(llmMapRef.current.size);
                        appendLog(`已导入 ${n} 条翻译`);
                      }}>导入 JSON</button>
                    <button className="btn tools-llm-cache-btn"
                      disabled={running || allExtractedTextsRef.current.length === 0}
                      onClick={() => exportUntranslated(allExtractedTextsRef.current, llmMapRef.current, cacheKeyRef.current || "export")}>导出未翻译</button>
                    <button className="btn danger tools-llm-cache-btn" disabled={running || llmCachedCount === 0}
                      onClick={async () => {
                        if (!cacheKeyRef.current || !window.confirm("确定清空翻译缓存？")) return;
                        await clearCache(cacheKeyRef.current);
                        llmMapRef.current = new Map(); allExtractedTextsRef.current = [];
                        setLlmCachedCount(0); appendLog("已清空翻译缓存");
                      }}>清空缓存</button>
                  </div>
                  {phase === "translating" && (
                    <div className="tools-llm-progress">
                      <span>已翻译 {llmTranslatedTotal} / {llmGrandTotal} 条
                        {llmFailedBatches > 0 && <span className="tools-llm-failed">，{llmFailedBatches} 批失败</span>}
                      </span>
                      <button className="btn danger" style={{ marginLeft:"0.75rem", padding:"0.25rem 0.7rem", fontSize:"0.8rem" }}
                        onClick={() => llmAbortRef.current?.abort()}>取消（直接转换）</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="divider" />

          {/* ── Actions ── */}
          <div className="tools-actions">
            <button className="btn primary tools-run-btn" onClick={run} disabled={!canRun}>{runBtnLabel}</button>
            {inputMode === "zip" && (
              <button className="btn" onClick={handleExtractTlZip} disabled={running || !zipPath} title="提取 ZIP 内 tl/*.rpy 到新 ZIP">提取 TL ZIP</button>
            )}
            <button className="btn" onClick={handleExport} disabled={running || !canRun} title="导出对白为 JSON（用于手动翻译或 LLM）">导出对白</button>
            <button className="btn" onClick={reset} disabled={running}>清空日志</button>
          </div>

          {/* ── Status ── */}
          {(running || phase === "done") && (
            <div>
              <span className={`tools-progress-label ${
                phase === "done" ? "tools-progress-label--done" :
                running ? "tools-progress-label--running" : "tools-progress-label--idle"}`}>
                {phaseLabel}
              </span>
            </div>
          )}

          {/* ── Log ── */}
          <div>
            <div className="settings-label">日志</div>
            <div ref={logRef} className="tools-log-wrap">
              {logs.length === 0
                ? <span className="tools-log-empty">暂无输出</span>
                : logs.map((l: string, i: number) => (
                  <div key={i} className={`tools-log-line ${
                    l.startsWith("✗") ? "tools-log-line--error" :
                    l.startsWith("✓") ? "tools-log-line--success" : ""
                  }`}>{l}</div>
                ))}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
};
