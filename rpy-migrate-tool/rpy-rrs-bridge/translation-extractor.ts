// ── translation-extractor.ts ──────────────────────────────────────────────────
//
// Parses Ren'Py `tl/chinese/*.rpy` translation files and returns a
// Map<english, translated> suitable for passing to convertRpy().
//
// No file I/O, no side effects — accepts raw file content as a string.

/**
 * Parse a Ren'Py translation `.rpy` file and return a map of
 * english dialogue text → translated dialogue text.
 *
 * Handles both `old/new` style and commented-source style blocks:
 *
 *   translate chinese block_id:
 *       # k "Hello"
 *       k "你好"
 *
 *   translate chinese block_id:
 *       old "Hello"
 *       new "你好"
 */
export function parseTranslationBlocks(content: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (/^translate\s+\w+\s+\w+\s*:/.test(trimmed)) {
      i++;
      let englishText: string | null = null;
      let chineseText: string | null = null;

      while (i < lines.length) {
        const innerRaw = lines[i];
        const inner = innerRaw.trim();

        if (!inner) {
          if (englishText !== null) break;
          i++;
          continue;
        }

        // Non-indented line → end of block
        if (innerRaw[0] !== " " && innerRaw[0] !== "\t") break;

        if (inner.startsWith("#")) {
          // Commented-out source line (not a voice comment)
          if (!inner.match(/^#\s+voice\b/)) {
            const cm = inner.match(
              /^#\s+[\w_]+\s+"((?:[^"\\]|\\.)*)"\s*(?:with\s+\S+)?\s*$/,
            );
            if (cm) englishText = cm[1].replace(/\{[^{}]*\}/g, "").trim();
          }
          i++;
          continue;
        }

        if (/^voice\s+audio\./.test(inner)) {
          i++;
          continue;
        }

        // old/new style
        if (inner.startsWith("old ") || inner.startsWith("new ")) {
          const om = inner.match(/^old\s+"((?:[^"\\]|\\.)*)"\s*$/);
          if (om) {
            englishText = om[1].replace(/\{[^{}]*\}/g, "").trim();
            i++;
            continue;
          }
          const nm = inner.match(/^new\s+"((?:[^"\\]|\\.)*)"\s*$/);
          if (nm && englishText !== null) {
            chineseText = nm[1];
            i++;
            if (!out.has(englishText)) out.set(englishText, chineseText);
            englishText = null;
            chineseText = null;
            continue;
          }
          i++;
          continue;
        }

        // Translation line: `CHAR "translated text"`
        const dm = inner.match(
          /^[\w_]+\s+"((?:[^"\\]|\\.)*)"\s*(?:with\s+\S+)?\s*$/,
        );
        if (dm) {
          chineseText = dm[1];
          i++;
          break;
        }

        break;
      }

      if (englishText !== null && chineseText !== null) {
        if (!out.has(englishText)) out.set(englishText, chineseText);
      }
    } else {
      i++;
    }
  }

  return out;
}
