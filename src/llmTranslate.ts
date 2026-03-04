// ─── llmTranslate.ts ──────────────────────────────────────────────────────────
//
// LLM-based translation pipeline for .rrs scripts.
//
// Three responsibilities:
//   1. extractTexts()     — pull every translatable string out of .rrs content
//                           (speak dialogue lines + menu choice labels)
//   2. translateAll()     — concurrently batch-translate a set of strings via
//                           any OpenAI-compatible chat API, writing results into
//                           a TranslationMap as each batch completes
//   3. applyTranslation() — replace translatable strings in .rrs content using
//                           a populated TranslationMap
//
// Design constraints
// ──────────────────
//  • No external dependencies — only the Fetch API.
//  • translateAll() mutates the map in-place so callers can persist it
//    incrementally (call saveCache after each onBatchDone).
//  • Strings absent from the map are left untouched in applyTranslation().
//    There is intentionally no "keep original" fallback written into the map —
//    every entry in the map is a confirmed translation.
//  • Batch wire format uses a numbered key-value object (not an array) so that
//    a missing key in the LLM response is detected per-entry rather than
//    causing an off-by-one misalignment.

// ─── Public types ─────────────────────────────────────────────────────────────

export type TranslationMap = Map<string, string>;

export interface LlmConfig {
  /** Base URL of an OpenAI-compatible API.  Default: https://api.openai.com/v1 */
  endpoint: string;
  /** Secret API key — never persisted to disk. */
  apiKey: string;
  /** Model identifier, e.g. "gpt-4o-mini". */
  model: string;
  /** Number of strings per API request.  Default: 30. */
  batchSize: number;
  /** Maximum number of concurrent in-flight requests.  Default: 32. */
  concurrency: number;
  /** Natural-language name of the target language, e.g. "中文". */
  targetLang: string;
  /**
   * System prompt sent to the LLM.  Use {targetLang} as a placeholder for
   * the target language name — it is substituted at request time.
   *
   * The prompt MUST instruct the model to return a JSON object whose keys
   * are the same numeric strings as the input (e.g. {"1": "...", "2": "..."}).
   * Changing this requirement will break response parsing.
   */
  systemPrompt: string;
}

/**
 * The built-in system prompt.  Exported so the UI can display it as the
 * "reset to default" target and so it can be tested independently.
 *
 * {targetLang} is replaced with config.targetLang at request time.
 */
export const DEFAULT_SYSTEM_PROMPT =
  `You are a professional visual novel translator. ` +
  `Translate the given JSON object values from English into {targetLang}. ` +
  `Rules:\n` +
  `1. Return ONLY a valid JSON object with the same numeric keys.\n` +
  `2. Translate every value. Do NOT omit any key.\n` +
  `3. Preserve all formatting tags like {i}, {/i}, {b}, {/b}, {color=...}, etc. verbatim.\n` +
  `4. Preserve leading/trailing ellipses and punctuation style.\n` +
  `5. Do NOT add explanations, markdown fences, or any text outside the JSON object.`;

export const DEFAULT_LLM_CONFIG: Omit<LlmConfig, "apiKey"> = {
  endpoint: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  batchSize: 30,
  concurrency: 32,
  targetLang: "中文",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
};

// ─── extractTexts ─────────────────────────────────────────────────────────────

/**
 * Extract every translatable string from a single .rrs file's content.
 *
 * Handles:
 *   speak WHO "text";
 *   speak WHO { "line1"; "line2"; }
 *   speak WHO { "line1" | "voice"; "line2" | "voice"; }
 *   "Choice label" => { ... }       ← menu options
 *
 * Returns strings in source order, with duplicates preserved (deduplication
 * is the caller's responsibility so per-file ordering is retained for
 * diagnostics).
 */
export function extractTexts(rrsContent: string): string[] {
  const results: string[] = [];

  // Tokenise: we don't need a full parser — just find double-quoted strings
  // that appear in the right syntactic positions.
  const lines = rrsContent.split("\n");

  for (const raw of lines) {
    const line = raw.trim();

    // ── speak WHO "single line";
    // ── speak WHO "single line" | "voice";
    const speakSingle = line.match(
      /^speak\s+\S+\s+"((?:[^"\\]|\\.)*)"\s*(?:\|\s*(?:"[^"]*"|\S+))?\s*;/,
    );
    if (speakSingle) {
      const text = unescapeRrs(speakSingle[1]);
      if (text) results.push(text);
      continue;
    }

    // ── bare quoted string inside a speak { } block or at block level:
    //    "line text";
    //    "line text" | "voice";
    const blockLine = line.match(
      /^"((?:[^"\\]|\\.)*)"\s*(?:\|\s*(?:"[^"]*"|\S+))?\s*;/,
    );
    if (blockLine) {
      const text = unescapeRrs(blockLine[1]);
      if (text) results.push(text);
      continue;
    }

    // ── menu choice label: "Choice text" => {
    const menuChoice = line.match(/^"((?:[^"\\]|\\.)*)"(?:\s*\([^)]*\))?\s*=>/);
    if (menuChoice) {
      const text = unescapeRrs(menuChoice[1]);
      if (text) results.push(text);
      continue;
    }
  }

  return results;
}

// ─── translateAll ─────────────────────────────────────────────────────────────

export interface BatchResult {
  /** Number of strings successfully translated in this batch. */
  translated: number;
  /** Strings that could not be translated (API error or missing key). */
  failed: string[];
}

/**
 * Translate all strings in `texts` that are NOT already present in `map`,
 * using the given LLM config.
 *
 * Results are merged into `map` as each batch completes (mutates in-place).
 * `onBatchDone` is called after every batch so callers can persist the map
 * incrementally.
 *
 * Concurrency is bounded to `config.concurrency` simultaneous HTTP requests.
 * Each batch is retried up to 2 times on network / 5xx / 429 errors with
 * exponential back-off before being counted as failed.
 *
 * @param texts        All strings to translate (may include already-translated
 *                     ones; those are skipped automatically).
 * @param map          The translation map to populate.  Strings already in the
 *                     map are skipped; new translations are written here.
 * @param config       LLM endpoint, credentials and tuning parameters.
 * @param onBatchDone  Called after each batch with a summary.
 * @param signal       AbortSignal — when aborted, no new batches are started
 *                     and the function resolves with whatever has been
 *                     translated so far.
 */
export async function translateAll(
  texts: string[],
  map: TranslationMap,
  config: LlmConfig,
  onBatchDone: (
    result: BatchResult,
    doneTotal: number,
    grandTotal: number,
  ) => void,
  signal: AbortSignal,
): Promise<void> {
  // Deduplicate and exclude already-cached strings.
  const pending = [...new Set(texts)].filter((t) => !map.has(t));
  if (pending.length === 0) return;

  const { batchSize, concurrency } = config;

  // Split into batches.
  const batches: string[][] = [];
  for (let i = 0; i < pending.length; i += batchSize) {
    batches.push(pending.slice(i, i + batchSize));
  }

  const grandTotal = pending.length;
  let doneTotal = 0;

  // Worker-pool concurrency pattern — no external library needed.
  await runWithConcurrency(
    batches.map((batch) => async () => {
      if (signal.aborted) return;

      const result = await translateBatchWithRetry(batch, config, signal);

      if (signal.aborted) return;

      // Merge into map immediately so incremental saves capture progress.
      for (const [k, v] of result.translations) {
        map.set(k, v);
      }

      doneTotal += result.translations.size;
      onBatchDone(
        { translated: result.translations.size, failed: result.failed },
        doneTotal,
        grandTotal,
      );
    }),
    concurrency,
    signal,
  );
}

// ─── applyTranslation ─────────────────────────────────────────────────────────

/**
 * Replace translatable strings in `rrsContent` with their translations from
 * `map`.  Lines whose strings are not found in the map are left unchanged.
 *
 * The replacement is purely textual — it re-quotes the translated string and
 * preserves surrounding syntax (speaker name, voice pipe, semicolon, etc.).
 */
export function applyTranslation(
  rrsContent: string,
  map: TranslationMap,
): string {
  if (map.size === 0) return rrsContent;

  const lines = rrsContent.split("\n");
  const out: string[] = [];

  for (const raw of lines) {
    out.push(translateLine(raw, map));
  }

  return out.join("\n");
}

// ─── Internal: line-level translation ─────────────────────────────────────────

function translateLine(raw: string, map: TranslationMap): string {
  const line = raw.trim();

  // speak WHO "text";
  // speak WHO "text" | "voice";
  {
    const m = line.match(
      /^(speak\s+\S+\s+)"((?:[^"\\]|\\.)*)"(\s*(?:\|\s*(?:"[^"]*"|\S+))?\s*;.*)$/,
    );
    if (m) {
      const orig = unescapeRrs(m[2]);
      const translated = map.get(orig);
      if (translated !== undefined) {
        const indent = raw.slice(0, raw.length - raw.trimStart().length);
        return indent + m[1] + `"${escapeRrs(translated)}"` + m[3];
      }
      return raw;
    }
  }

  // "text";  or  "text" | "voice";   (inside a speak block)
  {
    const m = line.match(
      /^(")((?:[^"\\]|\\.)*)(")(\s*(?:\|\s*(?:"[^"]*"|\S+))?\s*;.*)$/,
    );
    if (m) {
      const orig = unescapeRrs(m[2]);
      const translated = map.get(orig);
      if (translated !== undefined) {
        const indent = raw.slice(0, raw.length - raw.trimStart().length);
        return indent + `"${escapeRrs(translated)}"` + m[4];
      }
      return raw;
    }
  }

  // "Choice text" => {
  {
    const m = line.match(/^(")((?:[^"\\]|\\.)*)(")(\s*(?:\([^)]*\))?\s*=>.*)$/);
    if (m) {
      const orig = unescapeRrs(m[2]);
      const translated = map.get(orig);
      if (translated !== undefined) {
        const indent = raw.slice(0, raw.length - raw.trimStart().length);
        return indent + `"${escapeRrs(translated)}"` + m[4];
      }
      return raw;
    }
  }

  return raw;
}

// ─── Internal: string escaping ────────────────────────────────────────────────

/** Unescape \" and \\ sequences inside a double-quoted .rrs string literal. */
function unescapeRrs(s: string): string {
  return s.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** Escape a plain string for embedding inside double quotes in .rrs. */
function escapeRrs(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ─── Internal: batch translation ─────────────────────────────────────────────

interface BatchTranslationResult {
  translations: Map<string, string>;
  failed: string[];
}

/**
 * Translate one batch of strings with up to 2 retries on transient errors.
 * Returns whatever translations succeeded; strings that ultimately fail are
 * listed in `failed` and NOT written into the returned map.
 */
async function translateBatchWithRetry(
  batch: string[],
  config: LlmConfig,
  signal: AbortSignal,
): Promise<BatchTranslationResult> {
  const MAX_RETRIES = 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal.aborted) break;

    if (attempt > 0) {
      // Exponential back-off: 1s, 2s
      await sleep(2 ** (attempt - 1) * 1000, signal);
      if (signal.aborted) break;
    }

    try {
      const result = await translateBatchOnce(batch, config, signal);
      return result;
    } catch (err) {
      lastError = err;
      // Only retry on transient errors (network, 429, 5xx).
      // Don't retry on auth errors (401/403) or cancelled requests.
      if (signal.aborted) break;
      if (
        err instanceof LlmApiError &&
        (err.status === 401 || err.status === 403)
      ) {
        break;
      }
      // Continue to next attempt.
    }
  }

  // All retries exhausted.
  console.warn("[llmTranslate] Batch failed after retries:", lastError);
  return { translations: new Map(), failed: batch };
}

/**
 * Single attempt at translating a batch.
 * Sends a numbered key-value object so key presence can be verified
 * independently per entry even if the model omits some.
 */
async function translateBatchOnce(
  batch: string[],
  config: LlmConfig,
  signal: AbortSignal,
): Promise<BatchTranslationResult> {
  // Build numbered input object: { "1": "Hello", "2": "World", ... }
  const input: Record<string, string> = {};
  for (let i = 0; i < batch.length; i++) {
    input[String(i + 1)] = batch[i];
  }

  const systemPrompt = config.systemPrompt.replace(
    /\{targetLang\}/g,
    config.targetLang,
  );

  const userPrompt = JSON.stringify(input, null, 0);

  const url = `${config.endpoint.replace(/\/$/, "")}/chat/completions`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        response_format: { type: "json_object" },
      }),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new LlmApiError(
      0,
      `Network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new LlmApiError(response.status, body);
  }

  let rawBody: string;
  try {
    rawBody = await response.text();
  } catch (err) {
    throw new LlmApiError(0, `Failed to read response body: ${err}`);
  }

  // Parse the OpenAI response envelope.
  let envelope: unknown;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    throw new LlmApiError(
      0,
      `Response is not valid JSON: ${rawBody.slice(0, 200)}`,
    );
  }

  const content: string =
    (envelope as { choices?: { message?: { content?: string } }[] })
      ?.choices?.[0]?.message?.content ?? "";

  if (!content) {
    throw new LlmApiError(0, "Empty content in LLM response");
  }

  // Parse the translated key-value object.
  let translated: Record<string, unknown>;
  try {
    translated = JSON.parse(content);
    if (
      typeof translated !== "object" ||
      translated === null ||
      Array.isArray(translated)
    ) {
      throw new Error("Not an object");
    }
  } catch {
    throw new LlmApiError(
      0,
      `LLM returned invalid JSON: ${content.slice(0, 300)}`,
    );
  }

  // Match translated values back to original strings by numeric key.
  const translations = new Map<string, string>();
  const failed: string[] = [];

  for (let i = 0; i < batch.length; i++) {
    const key = String(i + 1);
    const value = translated[key];
    if (typeof value === "string" && value.trim() !== "") {
      translations.set(batch[i], value);
    } else {
      failed.push(batch[i]);
    }
  }

  return { translations, failed };
}

// ─── Internal: worker pool ────────────────────────────────────────────────────

/**
 * Run an array of async task factories with a maximum of `concurrency`
 * tasks running simultaneously.  Resolves when all tasks have completed
 * (or been skipped due to abort).
 */
async function runWithConcurrency(
  tasks: Array<() => Promise<void>>,
  concurrency: number,
  signal: AbortSignal,
): Promise<void> {
  const queue = [...tasks];
  let active = 0;

  return new Promise<void>((resolve, reject) => {
    function pump() {
      while (active < concurrency && queue.length > 0) {
        if (signal.aborted) {
          resolve();
          return;
        }
        const task = queue.shift()!;
        active++;
        task().then(
          () => {
            active--;
            if (queue.length > 0) {
              pump();
            } else if (active === 0) {
              resolve();
            }
          },
          (err) => {
            active--;
            // Individual tasks swallow their own errors and report via
            // onBatchDone; this branch only fires on unexpected throws.
            reject(err);
          },
        );
      }
      if (active === 0 && queue.length === 0) resolve();
    }
    pump();
  });
}

// ─── Internal: helpers ────────────────────────────────────────────────────────

class LlmApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`[LLM API ${status}] ${message}`);
    this.name = "LlmApiError";
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const id = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        resolve();
      },
      { once: true },
    );
  });
}
