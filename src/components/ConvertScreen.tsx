import React, { useState, useCallback, useEffect } from "react";
import {
  isTauri,
  pickDirectory,
  readDirectory,
  readTextFileTauri,
  pathExists,
  makeDirTauri,
  writeTextFileTauri,
} from "../tauri_bridge";
import {
  convertBatch,
  parseAssetMaps,
  parseTranslationBlocks,
  type BatchResult,
} from "../converter";

// ─── Types ────────────────────────────────────────────────────────────────────

type ConvertPhase = "idle" | "scanning" | "converting" | "done" | "error";

interface ScanResult {
  rpyFiles: string[]; // absolute paths of .rpy files in game dir
  scriptRpyPath: string | null;
  tlChinesePath: string | null; // tl/chinese dir if it exists
}

interface LogEntry {
  type: "info" | "ok" | "warn" | "error";
  msg: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SKIP_FILES = new Set([
  "options.rpy",
  "screens.rpy",
  "gui.rpy",
  "definitions.rpy",
  "customization.rpy",
]);

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

function stem(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 200,
    background: "rgba(0,0,0,0.82)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "flex-start",
    overflowY: "auto",
    padding: "2rem 1rem",
  },
  card: {
    width: "100%",
    maxWidth: "760px",
    background: "#161b22",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: "12px",
    padding: "1.5rem",
    boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
    display: "flex",
    flexDirection: "column",
    gap: "1.25rem",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    paddingBottom: "0.9rem",
  },
  title: {
    fontSize: "1.15rem",
    fontWeight: 700,
    color: "#e6edf3",
    margin: 0,
    letterSpacing: "0.02em",
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "rgba(255,255,255,0.4)",
    fontSize: "1.2rem",
    cursor: "pointer",
    padding: "0.2rem 0.4rem",
    borderRadius: "4px",
    lineHeight: 1,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "0.6rem",
  },
  sectionTitle: {
    fontSize: "0.72rem",
    fontWeight: 600,
    color: "rgba(255,255,255,0.4)",
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    margin: 0,
  },
  pathRow: {
    display: "flex",
    gap: "0.5rem",
    alignItems: "center",
  },
  pathDisplay: {
    flex: 1,
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: "6px",
    padding: "0.45rem 0.75rem",
    fontSize: "0.82rem",
    color: "rgba(255,255,255,0.6)",
    fontFamily: "monospace",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  pathDisplaySet: {
    color: "#e6edf3",
  },
  browseBtn: {
    background: "rgba(255,255,255,0.07)",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: "6px",
    color: "rgba(255,255,255,0.8)",
    fontSize: "0.82rem",
    padding: "0.45rem 0.9rem",
    cursor: "pointer",
    flexShrink: 0,
  },
  infoChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.35rem",
    fontSize: "0.75rem",
    background: "rgba(56,139,253,0.12)",
    border: "1px solid rgba(56,139,253,0.25)",
    borderRadius: "4px",
    padding: "0.2rem 0.55rem",
    color: "rgba(139,191,255,0.9)",
  },
  okChip: {
    background: "rgba(63,185,80,0.12)",
    border: "1px solid rgba(63,185,80,0.25)",
    color: "rgba(126,231,135,0.9)",
  },
  warnChip: {
    background: "rgba(210,153,34,0.12)",
    border: "1px solid rgba(210,153,34,0.3)",
    color: "rgba(255,213,100,0.9)",
  },
  optionRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.6rem",
    padding: "0.5rem 0.7rem",
    background: "rgba(255,255,255,0.03)",
    borderRadius: "6px",
    border: "1px solid rgba(255,255,255,0.06)",
  },
  optionLabel: {
    flex: 1,
    fontSize: "0.85rem",
    color: "rgba(255,255,255,0.8)",
    lineHeight: 1.4,
  },
  optionSub: {
    fontSize: "0.75rem",
    color: "rgba(255,255,255,0.35)",
    marginTop: "0.15rem",
    fontFamily: "monospace",
  },
  checkbox: {
    marginTop: "2px",
    cursor: "pointer",
    accentColor: "#58a6ff",
    flexShrink: 0,
  },
  textInput: {
    flex: 1,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: "5px",
    color: "#e6edf3",
    fontSize: "0.85rem",
    padding: "0.4rem 0.65rem",
    outline: "none",
  },
  actionRow: {
    display: "flex",
    gap: "0.6rem",
    flexWrap: "wrap",
  },
  primaryBtn: {
    background: "#238636",
    border: "none",
    borderRadius: "6px",
    color: "#fff",
    fontSize: "0.9rem",
    fontWeight: 600,
    padding: "0.55rem 1.2rem",
    cursor: "pointer",
    letterSpacing: "0.02em",
  },
  secondaryBtn: {
    background: "rgba(255,255,255,0.07)",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: "6px",
    color: "rgba(255,255,255,0.75)",
    fontSize: "0.85rem",
    padding: "0.5rem 0.9rem",
    cursor: "pointer",
  },
  disabledBtn: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
  progressBar: {
    height: "6px",
    background: "rgba(255,255,255,0.08)",
    borderRadius: "3px",
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    background: "#238636",
    borderRadius: "3px",
    transition: "width 0.2s ease",
  },
  progressLabel: {
    fontSize: "0.8rem",
    color: "rgba(255,255,255,0.45)",
  },
  logBox: {
    background: "rgba(0,0,0,0.3)",
    border: "1px solid rgba(255,255,255,0.07)",
    borderRadius: "6px",
    padding: "0.6rem 0.75rem",
    maxHeight: "220px",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "0.2rem",
  },
  logLine: {
    fontSize: "0.78rem",
    fontFamily: "monospace",
    lineHeight: 1.5,
  },
  resultSummary: {
    display: "flex",
    gap: "0.75rem",
    flexWrap: "wrap",
  },
  stat: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    background: "rgba(255,255,255,0.04)",
    borderRadius: "8px",
    padding: "0.6rem 1rem",
    minWidth: "80px",
  },
  statNum: {
    fontSize: "1.5rem",
    fontWeight: 700,
    color: "#7ee787",
    lineHeight: 1,
  },
  statLabel: {
    fontSize: "0.7rem",
    color: "rgba(255,255,255,0.4)",
    letterSpacing: "0.06em",
    marginTop: "0.25rem",
  },
  warningBox: {
    background: "rgba(210,153,34,0.08)",
    border: "1px solid rgba(210,153,34,0.25)",
    borderRadius: "6px",
    padding: "0.65rem 0.8rem",
    fontSize: "0.8rem",
    color: "rgba(255,213,100,0.85)",
    lineHeight: 1.6,
  },
  errorBox: {
    background: "rgba(248,81,73,0.08)",
    border: "1px solid rgba(248,81,73,0.3)",
    borderRadius: "6px",
    padding: "0.65rem 0.8rem",
    fontSize: "0.82rem",
    color: "rgba(255,130,120,0.95)",
  },
  cliBox: {
    background: "rgba(255,255,255,0.02)",
    border: "1px solid rgba(255,255,255,0.07)",
    borderRadius: "8px",
    padding: "0.9rem 1rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  },
  cliTitle: {
    fontSize: "0.78rem",
    color: "rgba(255,255,255,0.4)",
    fontWeight: 600,
    margin: 0,
  },
  cliCode: {
    fontFamily: "monospace",
    fontSize: "0.78rem",
    color: "#a5d6ff",
    background: "rgba(0,0,0,0.3)",
    borderRadius: "5px",
    padding: "0.6rem 0.75rem",
    margin: 0,
    overflowX: "auto",
    lineHeight: 1.6,
  },
  cliNote: {
    fontSize: "0.74rem",
    color: "rgba(255,255,255,0.3)",
    margin: 0,
    lineHeight: 1.5,
  },
};

// ─── Component ────────────────────────────────────────────────────────────────

/** Build the equivalent CLI command string for display */
function buildCliCommand(
  gameDirArg: string,
  outputDirArg: string,
  gameNameArg: string,
  tlDirArg: string | null,
): string {
  let cmd = `# 基础批量转换\ndeno task rpy2rrs ${gameDirArg} -o ${outputDirArg} --manifest`;
  if (gameNameArg.trim()) {
    cmd += ` \\\n  --game "${gameNameArg.trim()}"`;
  }
  if (tlDirArg) {
    cmd += ` \\\n  --tl ${tlDirArg}`;
  }
  return cmd;
}

interface ConvertScreenProps {
  onClose: () => void;
}

export const ConvertScreen: React.FC<ConvertScreenProps> = ({ onClose }) => {
  // ── Directory state ─────────────────────────────────────────────────────────
  const [gameDir, setGameDir] = useState<string>("");
  const [outputDir, setOutputDir] = useState<string>("");
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);

  // ── Options ─────────────────────────────────────────────────────────────────
  const [gameName, setGameName] = useState("");
  const [includeTl, setIncludeTl] = useState(true);

  // ── Conversion state ────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<ConvertPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const logRef = React.useRef<HTMLDivElement>(null);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log]);

  // ── Log helper ──────────────────────────────────────────────────────────────
  const addLog = useCallback((type: LogEntry["type"], msg: string) => {
    setLog((prev) => [...prev, { type, msg }]);
  }, []);

  // ── Scan game directory ─────────────────────────────────────────────────────
  const scanGameDir = useCallback(async (dir: string) => {
    setPhase("scanning");
    setScanResult(null);

    try {
      const entries = await readDirectory(dir);
      const rpyFiles: string[] = [];

      for (const e of entries) {
        if (e.isFile && e.name.endsWith(".rpy")) {
          if (!SKIP_FILES.has(e.name)) {
            rpyFiles.push(`${dir}/${e.name}`);
          }
        }
      }
      rpyFiles.sort();

      // Auto-detect script.rpy
      const scriptRpyPath = (await pathExists(`${dir}/script.rpy`))
        ? `${dir}/script.rpy`
        : null;

      // Auto-detect tl/chinese
      const tlChinesePath = (await pathExists(`${dir}/tl/chinese`))
        ? `${dir}/tl/chinese`
        : null;

      setScanResult({ rpyFiles, scriptRpyPath, tlChinesePath });
      setIncludeTl(tlChinesePath !== null);
    } catch (e) {
      setScanResult({ rpyFiles: [], scriptRpyPath: null, tlChinesePath: null });
    }

    setPhase("idle");
  }, []);

  // ── Pick directories ────────────────────────────────────────────────────────
  const pickGameDir = useCallback(async () => {
    const dir = await pickDirectory();
    if (!dir) return;
    setGameDir(dir);
    setResult(null);
    setLog([]);
    setErrorMsg(null);
    await scanGameDir(dir);
  }, [scanGameDir]);

  const pickOutputDir = useCallback(async () => {
    const dir = await pickDirectory();
    if (!dir) return;
    setOutputDir(dir);
  }, []);

  // ── Run Conversion ──────────────────────────────────────────────────────────
  const runConversion = useCallback(async () => {
    if (!gameDir || !outputDir || !scanResult) return;
    if (scanResult.rpyFiles.length === 0) return;

    setPhase("converting");
    setProgress(0);
    setLog([]);
    setResult(null);
    setErrorMsg(null);

    try {
      // 1. Load script.rpy for asset maps
      let scriptText: string | undefined;
      if (scanResult.scriptRpyPath) {
        addLog("info", `加载资源映射：${basename(scanResult.scriptRpyPath)}`);
        scriptText =
          (await readTextFileTauri(scanResult.scriptRpyPath)) ?? undefined;
      } else {
        addLog("warn", "未找到 script.rpy，角色名和资源路径可能无法解析");
      }
      const maps = scriptText
        ? parseAssetMaps(scriptText)
        : {
            audio: new Map(),
            bg: new Map(),
            cg: new Map(),
            sx: new Map(),
            misc: new Map(),
            charMap: new Map(),
          };

      // 2. Load Chinese translations if requested
      const translations = new Map<string, Map<string, string>>();
      const effectiveTlDir =
        includeTl && scanResult.tlChinesePath ? scanResult.tlChinesePath : null;

      if (effectiveTlDir) {
        addLog("info", `加载中文翻译：${effectiveTlDir}`);
        const tlEntries = await readDirectory(effectiveTlDir);
        for (const e of tlEntries) {
          if (e.isFile && e.name.endsWith(".rpy")) {
            const fileStem = stem(e.name);
            const content = await readTextFileTauri(
              `${effectiveTlDir}/${e.name}`,
            );
            if (content) {
              const tlMap = parseTranslationBlocks(content);
              if (tlMap.size > 0) {
                translations.set(fileStem, tlMap);
                addLog("ok", `  翻译：${e.name}（${tlMap.size} 条）`);
              }
            }
          }
        }
        addLog(
          "info",
          `翻译加载完成：${translations.size} 个文件，共 ${[...translations.values()].reduce((n, m) => n + m.size, 0)} 条`,
        );
      }

      // 3. Read all .rpy files
      addLog("info", `读取 ${scanResult.rpyFiles.length} 个 .rpy 文件…`);
      const inputs: Array<{ name: string; text: string }> = [];

      for (const filePath of scanResult.rpyFiles) {
        const text = await readTextFileTauri(filePath);
        if (text !== null) {
          inputs.push({ name: basename(filePath), text });
        } else {
          addLog("warn", `  无法读取：${basename(filePath)}`);
        }
      }

      // Also include script.rpy if not already included
      if (scriptText && scanResult.scriptRpyPath) {
        const scriptName = basename(scanResult.scriptRpyPath);
        if (!inputs.some((i) => i.name === scriptName)) {
          inputs.unshift({ name: scriptName, text: scriptText });
        }
      }

      // 4. Convert
      addLog("info", `开始转换 ${inputs.length} 个文件…`);
      setProgressLabel(`转换中…`);

      // Run conversion with a simulated progress tick
      const tickInterval = setInterval(() => {
        setProgress((p) => Math.min(p + 3, 88));
      }, 80);
      await new Promise<void>((r) => setTimeout(r, 20));

      const batchResult = convertBatch(inputs, scriptText, {
        game: gameName.trim() || undefined,
        start: "start",
        translations: translations.size > 0 ? translations : undefined,
      });

      clearInterval(tickInterval);
      setProgress(90);

      addLog(
        "ok",
        `转换完成：${batchResult.files.length} 个文件，跳过 ${batchResult.skipped.length} 个`,
      );
      if (batchResult.skipped.length > 0) {
        addLog(
          "info",
          `  已跳过（无 label）：${batchResult.skipped.join(", ")}`,
        );
      }

      // Collect all warnings
      const allWarnings = batchResult.files.flatMap((f) =>
        f.warnings.map((w) => `[${f.name}] ${w}`),
      );
      for (const w of allWarnings.slice(0, 8)) {
        addLog("warn", w);
      }
      if (allWarnings.length > 8) {
        addLog("warn", `  …还有 ${allWarnings.length - 8} 条警告`);
      }

      // 5. Ensure output data directory exists
      const dataDir = `${outputDir}/data`;
      await makeDirTauri(dataDir);

      // 6. Write .rrs files
      setProgressLabel("写入 .rrs 文件…");
      for (const f of batchResult.files) {
        const outPath = `${dataDir}/${f.name}`;
        await writeTextFileTauri(outPath, f.rrs);
        addLog(
          "ok",
          `  ✓ ${f.name}（${fmtBytes(new TextEncoder().encode(f.rrs).length)}）`,
        );
      }

      // 7. Write manifest.json
      const manifestText = JSON.stringify(batchResult.manifest, null, 2) + "\n";
      await writeTextFileTauri(`${dataDir}/manifest.json`, manifestText);
      addLog("ok", `  ✓ manifest.json`);

      setProgress(95);
      setResult(batchResult);

      setProgress(100);
      setProgressLabel("完成");
      setPhase("done");
      addLog("ok", "🎉 全部完成！");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMsg(msg);
      addLog("error", `错误：${msg}`);
      setPhase("error");
    }
  }, [gameDir, outputDir, scanResult, gameName, includeTl, addLog]);

  // ── Reset ────────────────────────────────────────────────────────────────────
  const reset = useCallback(() => {
    setResult(null);
    setLog([]);
    setErrorMsg(null);
    setProgress(0);
    setProgressLabel("");
    setPhase("idle");
  }, []);

  // ── Derived state ────────────────────────────────────────────────────────────
  const isRunning = phase === "converting" || phase === "scanning";
  const isDone = phase === "done";
  const canConvert =
    !isRunning &&
    !isDone &&
    !!gameDir &&
    !!outputDir &&
    !!scanResult &&
    scanResult.rpyFiles.length > 0;

  const allWarnings = result
    ? result.files.flatMap((f) => f.warnings.map((w) => `[${f.name}] ${w}`))
    : [];

  // ─── Non-Tauri fallback ──────────────────────────────────────────────────────
  if (!isTauri) {
    return (
      <div
        style={s.overlay}
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        <div style={s.card}>
          <div style={s.header}>
            <h2 style={s.title}>🔄 Ren'Py → .rrs 批量转换</h2>
            <button style={s.closeBtn} onClick={onClose}>
              ✕
            </button>
          </div>
          <div style={s.errorBox}>
            此功能需要在 Tauri
            桌面端运行，浏览器环境不支持直接读写本地文件系统。
          </div>
          <div style={s.cliBox}>
            <p style={s.cliTitle}>💡 请使用命令行工具进行批量转换：</p>
            <pre
              style={s.cliCode}
            >{`deno task rpy2rrs /path/to/game/ -o assets/data/ --manifest
# 带中文翻译
deno task rpy2rrs /path/to/game/ -o assets/data/ --manifest
# 指定游戏名称
deno task rpy2rrs /path/to/game/ -o assets/data/ --manifest --game "MyGame"`}</pre>
          </div>
        </div>
      </div>
    );
  }

  // ─── Main render ─────────────────────────────────────────────────────────────
  return (
    <div
      style={s.overlay}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={s.card}>
        {/* ── Header ── */}
        <div style={s.header}>
          <h2 style={s.title}>🔄 Ren'Py → .rrs 批量转换</h2>
          <button style={s.closeBtn} onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        {/* ── Step 1: Game Directory ── */}
        <div style={s.section}>
          <p style={s.sectionTitle}>第一步 · 选择 game 目录</p>
          <div style={s.pathRow}>
            <div
              style={{
                ...s.pathDisplay,
                ...(gameDir ? s.pathDisplaySet : {}),
              }}
              title={gameDir || undefined}
            >
              {gameDir || "未选择目录（点击右侧按钮选择 game/ 文件夹）"}
            </div>
            <button
              style={s.browseBtn}
              onClick={pickGameDir}
              disabled={isRunning}
            >
              📂 浏览…
            </button>
          </div>

          {/* Scan info chips */}
          {scanResult && (
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <span
                style={{
                  ...s.infoChip,
                  ...(scanResult.rpyFiles.length > 0 ? s.okChip : s.warnChip),
                }}
              >
                {scanResult.rpyFiles.length > 0
                  ? `✓ ${scanResult.rpyFiles.length} 个 .rpy 文件`
                  : "⚠ 未找到 .rpy 文件"}
              </span>
              <span
                style={{
                  ...s.infoChip,
                  ...(scanResult.scriptRpyPath ? s.okChip : s.warnChip),
                }}
              >
                {scanResult.scriptRpyPath
                  ? "✓ script.rpy"
                  : "⚠ 未找到 script.rpy"}
              </span>
              <span
                style={{
                  ...s.infoChip,
                  ...(scanResult.tlChinesePath ? s.okChip : {}),
                }}
              >
                {scanResult.tlChinesePath
                  ? "✓ tl/chinese 翻译目录"
                  : "— 无 tl/chinese"}
              </span>
            </div>
          )}
        </div>

        {/* ── Step 2: Output Directory ── */}
        <div style={s.section}>
          <p style={s.sectionTitle}>第二步 · 选择输出目录</p>
          <div style={s.pathRow}>
            <div
              style={{
                ...s.pathDisplay,
                ...(outputDir ? s.pathDisplaySet : {}),
              }}
              title={outputDir || undefined}
            >
              {outputDir || "未选择输出目录（.rrs 和 manifest.json 写入此处）"}
            </div>
            <button
              style={s.browseBtn}
              onClick={pickOutputDir}
              disabled={isRunning}
            >
              📂 浏览…
            </button>
          </div>
        </div>

        {/* ── Step 3: Options ── */}
        <div style={s.section}>
          <p style={s.sectionTitle}>第三步 · 转换选项</p>

          {/* Game name */}
          <div style={s.optionRow}>
            <div style={s.optionLabel}>
              游戏名称
              <div style={s.optionSub}>
                写入 manifest.json 的 game 字段（可留空）
              </div>
            </div>
            <input
              style={{ ...s.textInput, maxWidth: "240px" }}
              type="text"
              placeholder="例：My VN Game"
              value={gameName}
              onChange={(e) => setGameName(e.target.value)}
              disabled={isRunning || isDone}
            />
          </div>

          {/* Chinese TL toggle */}
          <div style={s.optionRow}>
            <input
              id="opt-tl"
              type="checkbox"
              style={s.checkbox}
              checked={includeTl}
              onChange={(e) => setIncludeTl(e.target.checked)}
              disabled={isRunning || isDone || !scanResult?.tlChinesePath}
            />
            <label
              htmlFor="opt-tl"
              style={{
                ...s.optionLabel,
                cursor: scanResult?.tlChinesePath ? "pointer" : "not-allowed",
                opacity: scanResult?.tlChinesePath ? 1 : 0.45,
              }}
            >
              合并中文翻译
              <div style={s.optionSub}>
                {scanResult?.tlChinesePath
                  ? `自动检测到：${scanResult.tlChinesePath}`
                  : "未检测到 tl/chinese 目录，选项不可用"}
              </div>
            </label>
          </div>
        </div>

        {/* ── Action buttons ── */}
        {!isDone && (
          <div style={s.actionRow}>
            <button
              style={{
                ...s.primaryBtn,
                ...(!canConvert || isRunning ? s.disabledBtn : {}),
              }}
              onClick={runConversion}
              disabled={!canConvert || isRunning}
            >
              {isRunning ? "⏳ 处理中…" : "▶ 开始转换"}
            </button>
            {(gameDir || result) && !isRunning && (
              <button style={s.secondaryBtn} onClick={reset}>
                重置
              </button>
            )}
          </div>
        )}

        {/* ── Progress ── */}
        {(isRunning || (progress > 0 && progress < 100)) && (
          <div style={s.section}>
            <div style={s.progressBar}>
              <div style={{ ...s.progressFill, width: `${progress}%` }} />
            </div>
            <span style={s.progressLabel}>{progressLabel}</span>
          </div>
        )}

        {/* ── Log ── */}
        {log.length > 0 && (
          <div style={s.logBox} ref={logRef}>
            {log.map((entry, i) => (
              <div
                key={i}
                style={{
                  ...s.logLine,
                  color:
                    entry.type === "ok"
                      ? "#7ee787"
                      : entry.type === "warn"
                        ? "#e3b341"
                        : entry.type === "error"
                          ? "#ff7b72"
                          : "rgba(255,255,255,0.55)",
                }}
              >
                {entry.msg}
              </div>
            ))}
          </div>
        )}

        {/* ── Error ── */}
        {phase === "error" && errorMsg && (
          <div style={s.errorBox}>
            <strong>转换出错：</strong> {errorMsg}
          </div>
        )}

        {/* ── Results ── */}
        {isDone && result && (
          <div style={s.section}>
            <p style={s.sectionTitle}>转换结果</p>
            <div style={s.resultSummary}>
              <div style={s.stat}>
                <span style={s.statNum}>{result.files.length}</span>
                <span style={s.statLabel}>已转换</span>
              </div>
              <div style={s.stat}>
                <span style={s.statNum}>{result.skipped.length}</span>
                <span style={s.statLabel}>已跳过</span>
              </div>
            </div>

            {allWarnings.length > 0 && (
              <div style={s.warningBox}>
                <strong>⚠ {allWarnings.length} 条转换警告</strong>
                <ul
                  style={{
                    margin: "0.35rem 0 0 1rem",
                    padding: 0,
                    lineHeight: 1.7,
                  }}
                >
                  {allWarnings.slice(0, 6).map((w, i) => (
                    <li key={i} style={{ fontSize: "0.77rem" }}>
                      {w}
                    </li>
                  ))}
                  {allWarnings.length > 6 && (
                    <li style={{ fontSize: "0.77rem" }}>
                      …还有 {allWarnings.length - 6} 条
                    </li>
                  )}
                </ul>
              </div>
            )}

            <div style={s.actionRow}>
              <button style={s.primaryBtn} onClick={reset}>
                🔄 重新转换
              </button>
            </div>
          </div>
        )}

        {/* ── CLI reference ── */}
        <div style={s.cliBox}>
          <p style={s.cliTitle}>💡 对应命令行等效操作</p>
          <pre style={s.cliCode}>
            {buildCliCommand(
              gameDir || "/path/to/game/",
              outputDir || "assets/data/",
              gameName,
              includeTl ? (scanResult?.tlChinesePath ?? null) : null,
            )}
          </pre>
          <p style={s.cliNote}>
            命令行工具支持更多高级选项（--skip、--stub-exit、--dry-run）。资源复制请使用操作系统的
            cp -r 命令。
          </p>
        </div>
      </div>
    </div>
  );
};
