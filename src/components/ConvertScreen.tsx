import React, { useState, useRef, useCallback } from "react";
import { convertBatch, parseAssetMaps, type BatchResult } from "../converter";

// ─── Types ────────────────────────────────────────────────────────────────────

interface FileEntry {
  name: string;
  text: string;
}

type ConvertPhase =
  | "idle"
  | "files_selected"
  | "converting"
  | "done"
  | "error";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Read a File object as a UTF-8 string */
function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file, "utf-8");
  });
}

/** Trigger a browser download for a text blob */
function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Format bytes to human-readable string */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 200,
    background: "rgba(0,0,0,0.92)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "flex-start",
    overflowY: "auto",
    padding: "2rem 1rem",
  },
  card: {
    width: "100%",
    maxWidth: 720,
    background: "rgba(15,25,40,0.98)",
    border: "1px solid rgba(100,160,255,0.2)",
    borderRadius: 12,
    padding: "2rem",
    boxShadow: "0 8px 40px rgba(0,0,0,0.6)",
    display: "flex",
    flexDirection: "column",
    gap: "1.5rem",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottom: "1px solid rgba(100,160,255,0.15)",
    paddingBottom: "1rem",
  },
  title: {
    fontSize: "1.3rem",
    fontWeight: 700,
    color: "#a0c8ff",
    margin: 0,
    letterSpacing: "0.04em",
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "rgba(255,255,255,0.5)",
    fontSize: "1.4rem",
    cursor: "pointer",
    padding: "0.2rem 0.5rem",
    borderRadius: 4,
    lineHeight: 1,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
  },
  sectionTitle: {
    fontSize: "0.85rem",
    fontWeight: 600,
    color: "rgba(255,255,255,0.5)",
    letterSpacing: "0.1em",
    textTransform: "uppercase" as const,
    margin: 0,
  },
  dropZone: {
    border: "2px dashed rgba(100,160,255,0.3)",
    borderRadius: 8,
    padding: "2rem",
    textAlign: "center" as const,
    cursor: "pointer",
    color: "rgba(255,255,255,0.5)",
    fontSize: "0.9rem",
    transition: "border-color 0.2s, background 0.2s",
    background: "rgba(100,160,255,0.03)",
  },
  dropZoneActive: {
    borderColor: "rgba(100,160,255,0.7)",
    background: "rgba(100,160,255,0.08)",
  },
  fileInput: {
    display: "none",
  },
  fileList: {
    display: "flex",
    flexDirection: "column",
    gap: "0.4rem",
    maxHeight: 200,
    overflowY: "auto",
    padding: "0.5rem",
    background: "rgba(0,0,0,0.2)",
    borderRadius: 6,
    border: "1px solid rgba(255,255,255,0.08)",
  },
  fileItem: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    fontSize: "0.82rem",
    color: "rgba(255,255,255,0.7)",
    padding: "0.2rem 0.3rem",
  },
  fileIcon: {
    fontSize: "0.9rem",
    flexShrink: 0,
  },
  fileName: {
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  fileSize: {
    color: "rgba(255,255,255,0.3)",
    flexShrink: 0,
    fontSize: "0.75rem",
  },
  inputRow: {
    display: "flex",
    gap: "0.75rem",
    alignItems: "center",
  },
  label: {
    fontSize: "0.85rem",
    color: "rgba(255,255,255,0.6)",
    flexShrink: 0,
    minWidth: 80,
  },
  input: {
    flex: 1,
    background: "rgba(0,0,0,0.3)",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 6,
    color: "#fff",
    fontSize: "0.9rem",
    padding: "0.45rem 0.75rem",
    outline: "none",
  },
  actionRow: {
    display: "flex",
    gap: "0.75rem",
    flexWrap: "wrap" as const,
  },
  primaryBtn: {
    background: "linear-gradient(135deg,#2563eb,#1d4ed8)",
    border: "none",
    borderRadius: 8,
    color: "#fff",
    fontSize: "0.9rem",
    fontWeight: 600,
    padding: "0.6rem 1.4rem",
    cursor: "pointer",
    letterSpacing: "0.03em",
  },
  secondaryBtn: {
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.15)",
    borderRadius: 8,
    color: "rgba(255,255,255,0.7)",
    fontSize: "0.9rem",
    padding: "0.6rem 1.2rem",
    cursor: "pointer",
  },
  disabledBtn: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
  progressBar: {
    height: 6,
    background: "rgba(255,255,255,0.08)",
    borderRadius: 3,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    background: "linear-gradient(90deg,#2563eb,#60a5fa)",
    borderRadius: 3,
    transition: "width 0.3s ease",
  },
  resultSummary: {
    display: "flex",
    gap: "1rem",
    flexWrap: "wrap" as const,
  },
  stat: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    background: "rgba(0,0,0,0.25)",
    borderRadius: 8,
    padding: "0.6rem 1rem",
    minWidth: 80,
  },
  statNum: {
    fontSize: "1.6rem",
    fontWeight: 700,
    color: "#60a5fa",
    lineHeight: 1.1,
  },
  statLabel: {
    fontSize: "0.72rem",
    color: "rgba(255,255,255,0.45)",
    letterSpacing: "0.05em",
    marginTop: 2,
  },
  resultList: {
    display: "flex",
    flexDirection: "column",
    gap: "0.4rem",
    maxHeight: 220,
    overflowY: "auto",
    padding: "0.5rem",
    background: "rgba(0,0,0,0.2)",
    borderRadius: 6,
    border: "1px solid rgba(255,255,255,0.08)",
  },
  resultItem: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    fontSize: "0.82rem",
    padding: "0.25rem 0.3rem",
  },
  cliBox: {
    background: "rgba(0,0,0,0.4)",
    border: "1px solid rgba(100,160,255,0.15)",
    borderRadius: 8,
    padding: "1rem 1.25rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
  },
  cliTitle: {
    fontSize: "0.82rem",
    color: "#a0c8ff",
    fontWeight: 600,
    margin: 0,
  },
  cliCode: {
    fontFamily: '"Fira Code","Cascadia Code",monospace',
    fontSize: "0.78rem",
    color: "#7ee787",
    background: "rgba(0,0,0,0.3)",
    borderRadius: 6,
    padding: "0.6rem 0.9rem",
    margin: 0,
    overflowX: "auto" as const,
    lineHeight: 1.7,
  },
  cliNote: {
    fontSize: "0.78rem",
    color: "rgba(255,255,255,0.35)",
    margin: 0,
    lineHeight: 1.5,
  },
  errorBox: {
    background: "rgba(220,38,38,0.12)",
    border: "1px solid rgba(220,38,38,0.3)",
    borderRadius: 8,
    padding: "0.75rem 1rem",
    fontSize: "0.85rem",
    color: "#fca5a5",
  },
  warningBox: {
    background: "rgba(234,179,8,0.08)",
    border: "1px solid rgba(234,179,8,0.2)",
    borderRadius: 8,
    padding: "0.75rem 1rem",
    fontSize: "0.82rem",
    color: "#fde68a",
    lineHeight: 1.5,
  },
};

// ─── Component ────────────────────────────────────────────────────────────────

interface ConvertScreenProps {
  onClose: () => void;
}

export const ConvertScreen: React.FC<ConvertScreenProps> = ({ onClose }) => {
  // ── File state ──────────────────────────────────────────────────────────────
  const [rpyFiles, setRpyFiles] = useState<FileEntry[]>([]);
  const [scriptFile, setScriptFile] = useState<FileEntry | null>(null);
  const [gameName, setGameName] = useState("");
  const [startLabel, setStartLabel] = useState("start");

  // ── Conversion state ────────────────────────────────────────────────────────
  const [phase, setPhase] = useState<ConvertPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // ── Drag state ──────────────────────────────────────────────────────────────
  const [dragging, setDragging] = useState(false);
  const rpyInputRef = useRef<HTMLInputElement>(null);
  const scriptInputRef = useRef<HTMLInputElement>(null);

  // ── File reading helpers ────────────────────────────────────────────────────

  const readFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter(
      (f) =>
        f.name.toLowerCase().endsWith(".rpy") ||
        f.name.toLowerCase().endsWith(".rpyc"),
    );
    if (files.length === 0) return;

    const entries: FileEntry[] = await Promise.all(
      files.map(async (f) => ({ name: f.name, text: await readFileText(f) })),
    );

    // Separate script.rpy from the rest
    const scriptEntry = entries.find((e) =>
      e.name.toLowerCase() === "script.rpy",
    );
    if (scriptEntry && !scriptFile) {
      setScriptFile(scriptEntry);
    }

    setRpyFiles((prev) => {
      const existing = new Set(prev.map((e) => e.name));
      const fresh = entries.filter((e) => !existing.has(e.name));
      return [...prev, ...fresh];
    });
    setPhase("files_selected");
  }, [scriptFile]);

  // ── Drag & drop handlers ────────────────────────────────────────────────────

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  };
  const onDragLeave = () => setDragging(false);
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length > 0) {
      await readFiles(e.dataTransfer.files);
    }
  };

  const onRpyInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await readFiles(e.target.files);
    }
    // Reset so the same files can be re-added
    e.target.value = "";
  };

  const onScriptInputChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      const text = await readFileText(file);
      setScriptFile({ name: file.name, text });
    }
    e.target.value = "";
  };

  // ── Conversion ──────────────────────────────────────────────────────────────

  const runConversion = useCallback(async () => {
    if (rpyFiles.length === 0) return;
    setPhase("converting");
    setProgress(0);
    setErrorMsg(null);

    try {
      // Simulate progress ticks while conversion runs synchronously
      const tickInterval = setInterval(() => {
        setProgress((p) => Math.min(p + 5, 90));
      }, 60);

      // Yield to the event loop so the progress bar renders before the heavy work
      await new Promise<void>((resolve) => setTimeout(resolve, 20));

      const scriptText = scriptFile?.text;
      const batchResult = convertBatch(rpyFiles, scriptText, {
        game: gameName.trim() || undefined,
        start: startLabel.trim() || "start",
      });

      clearInterval(tickInterval);
      setProgress(100);
      setResult(batchResult);
      setPhase("done");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [rpyFiles, scriptFile, gameName, startLabel]);

  // ── Downloads ───────────────────────────────────────────────────────────────

  const downloadAll = useCallback(() => {
    if (!result) return;
    for (const f of result.files) {
      downloadText(f.name, f.rrs);
    }
    downloadText(
      "manifest.json",
      JSON.stringify(result.manifest, null, 2) + "\n",
    );
  }, [result]);

  const downloadManifest = useCallback(() => {
    if (!result) return;
    downloadText(
      "manifest.json",
      JSON.stringify(result.manifest, null, 2) + "\n",
    );
  }, [result]);

  // ── Reset ───────────────────────────────────────────────────────────────────
  const reset = () => {
    setRpyFiles([]);
    setScriptFile(null);
    setResult(null);
    setErrorMsg(null);
    setProgress(0);
    setPhase("idle");
  };

  // ── Render helpers ──────────────────────────────────────────────────────────

  const allWarnings = result
    ? result.files.flatMap((f) => f.warnings.map((w) => `[${f.name}] ${w}`))
    : [];

  const isConverting = phase === "converting";
  const isDone = phase === "done";
  const hasFiles = rpyFiles.length > 0;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={styles.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={styles.card}>
        {/* Header */}
        <div style={styles.header}>
          <h2 style={styles.title}>🔄 Ren'Py → .rrs 转换器</h2>
          <button style={styles.closeBtn} onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        {/* ── Step 1: File selection ── */}
        <div style={styles.section}>
          <p style={styles.sectionTitle}>第一步 · 选择 .rpy 文件</p>

          {/* Drop zone */}
          <div
            style={{
              ...styles.dropZone,
              ...(dragging ? styles.dropZoneActive : {}),
            }}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={() => rpyInputRef.current?.click()}
            role="button"
            tabIndex={0}
            aria-label="选择 .rpy 文件"
            onKeyDown={(e) => e.key === "Enter" && rpyInputRef.current?.click()}
          >
            <div style={{ fontSize: "1.8rem", marginBottom: "0.4rem" }}>📂</div>
            <div>
              点击选择或拖放 <code>.rpy</code> 文件（可多选）
            </div>
            <div
              style={{
                fontSize: "0.75rem",
                marginTop: "0.3rem",
                opacity: 0.5,
              }}
            >
              如包含 script.rpy，会自动提取角色定义和资源映射
            </div>
          </div>

          <input
            ref={rpyInputRef}
            type="file"
            accept=".rpy"
            multiple
            style={styles.fileInput}
            onChange={onRpyInputChange}
          />

          {/* File list */}
          {rpyFiles.length > 0 && (
            <div style={styles.fileList}>
              {rpyFiles.map((f) => (
                <div key={f.name} style={styles.fileItem}>
                  <span style={styles.fileIcon}>
                    {f.name.toLowerCase() === "script.rpy" ? "⚙️" : "📄"}
                  </span>
                  <span style={styles.fileName}>{f.name}</span>
                  <span style={styles.fileSize}>
                    {fmtBytes(new TextEncoder().encode(f.text).length)}
                  </span>
                  {!isDone && (
                    <button
                      style={{
                        background: "none",
                        border: "none",
                        color: "rgba(255,255,255,0.3)",
                        cursor: "pointer",
                        padding: "0 0.2rem",
                        fontSize: "0.8rem",
                      }}
                      onClick={() =>
                        setRpyFiles((prev) =>
                          prev.filter((x) => x.name !== f.name),
                        )
                      }
                      aria-label={`移除 ${f.name}`}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Step 2: Script.rpy (optional) ── */}
        <div style={styles.section}>
          <p style={styles.sectionTitle}>第二步 · 指定 script.rpy（可选）</p>
          <div style={styles.inputRow}>
            <span style={styles.label}>script.rpy</span>
            {scriptFile ? (
              <span
                style={{
                  flex: 1,
                  fontSize: "0.85rem",
                  color: "#7ee787",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                ✓ {scriptFile.name}
              </span>
            ) : (
              <span
                style={{
                  flex: 1,
                  fontSize: "0.82rem",
                  color: "rgba(255,255,255,0.3)",
                }}
              >
                未指定（角色名和资源路径将无法解析）
              </span>
            )}
            <button
              style={styles.secondaryBtn}
              onClick={() => scriptInputRef.current?.click()}
              disabled={isDone}
            >
              {scriptFile ? "更换" : "选择"}
            </button>
          </div>
          <input
            ref={scriptInputRef}
            type="file"
            accept=".rpy"
            style={styles.fileInput}
            onChange={onScriptInputChange}
          />
        </div>

        {/* ── Step 3: Options ── */}
        <div style={styles.section}>
          <p style={styles.sectionTitle}>第三步 · 选项</p>
          <div style={styles.inputRow}>
            <span style={styles.label}>游戏名称</span>
            <input
              style={styles.input}
              type="text"
              placeholder="写入 manifest.json 的 game 字段（可留空）"
              value={gameName}
              onChange={(e) => setGameName(e.target.value)}
              disabled={isDone}
            />
          </div>
          <div style={styles.inputRow}>
            <span style={styles.label}>起始 label</span>
            <input
              style={styles.input}
              type="text"
              placeholder="start"
              value={startLabel}
              onChange={(e) => setStartLabel(e.target.value)}
              disabled={isDone}
            />
          </div>
        </div>

        {/* ── Convert button ── */}
        {!isDone && (
          <div style={styles.actionRow}>
            <button
              style={{
                ...styles.primaryBtn,
                ...(!hasFiles || isConverting ? styles.disabledBtn : {}),
              }}
              onClick={runConversion}
              disabled={!hasFiles || isConverting}
            >
              {isConverting ? "⏳ 转换中…" : "▶ 开始转换"}
            </button>
            {hasFiles && (
              <button style={styles.secondaryBtn} onClick={reset}>
                清除
              </button>
            )}
          </div>
        )}

        {/* ── Progress ── */}
        {isConverting && (
          <div style={styles.section}>
            <div style={styles.progressBar}>
              <div
                style={{ ...styles.progressFill, width: `${progress}%` }}
              />
            </div>
            <span
              style={{ fontSize: "0.8rem", color: "rgba(255,255,255,0.4)" }}
            >
              正在转换 {rpyFiles.length} 个文件…
            </span>
          </div>
        )}

        {/* ── Error ── */}
        {phase === "error" && errorMsg && (
          <div style={styles.errorBox}>
            <strong>转换出错：</strong> {errorMsg}
          </div>
        )}

        {/* ── Results ── */}
        {isDone && result && (
          <div style={styles.section}>
            <p style={styles.sectionTitle}>转换结果</p>

            {/* Stats */}
            <div style={styles.resultSummary}>
              <div style={styles.stat}>
                <span style={styles.statNum}>{result.files.length}</span>
                <span style={styles.statLabel}>已转换</span>
              </div>
              <div style={styles.stat}>
                <span style={styles.statNum}>{result.skipped.length}</span>
                <span style={styles.statLabel}>已跳过</span>
              </div>
              <div style={styles.stat}>
                <span style={{ ...styles.statNum, color: "#7ee787" }}>
                  {result.files.length + 1}
                </span>
                <span style={styles.statLabel}>可下载</span>
              </div>
            </div>

            {/* File list */}
            <div style={styles.resultList}>
              {result.files.map((f) => (
                <div key={f.name} style={styles.resultItem}>
                  <span style={{ color: "#7ee787" }}>✓</span>
                  <span
                    style={{
                      flex: 1,
                      fontSize: "0.82rem",
                      color: "rgba(255,255,255,0.75)",
                      fontFamily: "monospace",
                    }}
                  >
                    {f.name}
                  </span>
                  <span
                    style={{ fontSize: "0.75rem", color: "rgba(255,255,255,0.3)" }}
                  >
                    {fmtBytes(new TextEncoder().encode(f.rrs).length)}
                  </span>
                  <button
                    style={{
                      ...styles.secondaryBtn,
                      padding: "0.2rem 0.6rem",
                      fontSize: "0.75rem",
                    }}
                    onClick={() => downloadText(f.name, f.rrs)}
                  >
                    ↓
                  </button>
                </div>
              ))}
              {/* manifest.json entry */}
              <div style={styles.resultItem}>
                <span style={{ color: "#7ee787" }}>✓</span>
                <span
                  style={{
                    flex: 1,
                    fontSize: "0.82rem",
                    color: "rgba(255,255,255,0.75)",
                    fontFamily: "monospace",
                  }}
                >
                  manifest.json
                </span>
                <span />
                <button
                  style={{
                    ...styles.secondaryBtn,
                    padding: "0.2rem 0.6rem",
                    fontSize: "0.75rem",
                  }}
                  onClick={downloadManifest}
                >
                  ↓
                </button>
              </div>
            </div>

            {/* Warnings */}
            {allWarnings.length > 0 && (
              <div style={styles.warningBox}>
                <strong>⚠ {allWarnings.length} 条警告：</strong>
                <ul
                  style={{
                    margin: "0.4rem 0 0 1rem",
                    padding: 0,
                    lineHeight: 1.7,
                  }}
                >
                  {allWarnings.slice(0, 10).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                  {allWarnings.length > 10 && (
                    <li>…以及 {allWarnings.length - 10} 条更多</li>
                  )}
                </ul>
              </div>
            )}

            {/* Download all button */}
            <div style={styles.actionRow}>
              <button style={styles.primaryBtn} onClick={downloadAll}>
                ⬇ 全部下载（{result.files.length} 个 .rrs + manifest.json）
              </button>
              <button style={styles.secondaryBtn} onClick={reset}>
                重新开始
              </button>
            </div>
          </div>
        )}

        {/* ── CLI instructions ── */}
        <div style={styles.cliBox}>
          <p style={styles.cliTitle}>💡 批量转换推荐使用命令行工具</p>
          <pre style={styles.cliCode}>{`# 批量转换整个游戏目录（含资源路径解析）
deno task rpy2rrs /path/to/game/ -o assets/data/ --manifest

# 带中文翻译合并
deno task rpy2rrs /path/to/game/ -o assets/data/ --manifest \\
  --tl /path/to/game/tl/chinese/

# 指定游戏名称
deno task rpy2rrs /path/to/game/ -o assets/data/ --manifest \\
  --game "My VN Game"`}</pre>
          <p style={styles.cliNote}>
            命令行工具支持完整的资源路径解析、多文件角色映射、翻译合并等功能。
            浏览器内转换器适合快速预览单个文件，无法解析跨文件资源引用。
          </p>
        </div>
      </div>
    </div>
  );
};
