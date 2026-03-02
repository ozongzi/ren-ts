import React from "react";

// Utilities for parsing and rendering Ren'Py-style inline text markup.
// This module provides a tokeniser, parser and high-level helpers that
// produce React nodes for inlined dialogue rendering.

// ─── Token types ─────────────────────────────────────────────────────────────

export type Token =
  | { kind: "text"; value: string }
  | { kind: "open"; tag: string; attr?: string }
  | { kind: "close"; tag: string }
  | { kind: "self"; tag: string; attr?: string };

// ─── Tokeniser ────────────────────────────────────────────────────────────────

export function tokenise(input: string): Token[] {
  const tokens: Token[] = [];
  const tagRegex = /\{([^}]+)\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(input)) !== null) {
    // text before this tag
    if (match.index > lastIndex) {
      tokens.push({ kind: "text", value: input.slice(lastIndex, match.index) });
    }

    const raw = match[1].trim();

    if (raw.startsWith("/")) {
      // closing tag: {/i}, {/color}, …
      tokens.push({ kind: "close", tag: raw.slice(1).toLowerCase() });
    } else if (raw.includes("=")) {
      // tag with attribute: {color=#fff}, {size=24}, {alpha=0.5}
      const eqIdx = raw.indexOf("=");
      const tag = raw.slice(0, eqIdx).toLowerCase();
      const attr = raw.slice(eqIdx + 1).replace(/^["']|["']$/g, "");
      tokens.push({ kind: "open", tag, attr });
    } else {
      // self-closing or bare open: {w}, {nw}, {fast}, {i}, {b}, …
      const tag = raw.toLowerCase();
      // Treat known self-closing markers specially
      if (
        tag === "w" ||
        tag === "p" ||
        tag === "nw" ||
        tag === "fast" ||
        tag === "cps" ||
        tag.startsWith("cps=") ||
        tag === "vspace" ||
        tag.startsWith("image=") ||
        tag.startsWith("k=")
      ) {
        tokens.push({ kind: "self", tag });
      } else {
        tokens.push({ kind: "open", tag });
      }
    }

    lastIndex = tagRegex.lastIndex;
  }

  // remaining text
  if (lastIndex < input.length) {
    tokens.push({ kind: "text", value: input.slice(lastIndex) });
  }

  return tokens;
}

// ─── Tree node types ──────────────────────────────────────────────────────────

export type TextNode = { type: "text"; value: string };
export type ElementNode = {
  type: "element";
  tag: string;
  attr?: string;
  children: TreeNode[];
};
export type TreeNode = TextNode | ElementNode;

// ─── Parser: tokens → tree ────────────────────────────────────────────────────

export function parse(tokens: Token[]): TreeNode[] {
  const root: TreeNode[] = [];
  const stack: { tag: string; attr?: string; children: TreeNode[] }[] = [];

  function current(): TreeNode[] {
    return stack.length > 0 ? stack[stack.length - 1].children : root;
  }

  for (const tok of tokens) {
    if (tok.kind === "text") {
      current().push({ type: "text", value: tok.value });
    } else if (tok.kind === "self") {
      // self-closing tags are simply ignored (stripped from output)
    } else if (tok.kind === "open") {
      stack.push({ tag: tok.tag, attr: tok.attr, children: [] });
    } else if (tok.kind === "close") {
      if (stack.length > 0 && stack[stack.length - 1].tag === tok.tag) {
        const { tag, attr, children } = stack.pop()!;
        current().push({ type: "element", tag, attr, children });
      } else {
        // Mismatched close tag — treat as plain text
        current().push({ type: "text", value: `{/${tok.tag}}` });
      }
    }
  }

  // Flush unclosed tags: wrap remaining content under the unclosed tag nodes
  while (stack.length > 0) {
    const { tag, attr, children } = stack.pop()!;
    current().push({ type: "element", tag, attr, children });
  }

  return root;
}

// ─── Renderer: tree → React nodes ────────────────────────────────────────────

function makeKeyGen() {
  let counter = 0;
  return () => `rp-${counter++}`;
}

// Tags to silently strip (keep their children rendered)
const STRIP_TAGS = new Set(["a", "plain", "outlinecolor", "font", "kerning"]);

export function renderTree(
  nodes: TreeNode[],
  nextKey: () => string,
): React.ReactNode[] {
  return nodes.map((node): React.ReactNode => {
    if (node.type === "text") {
      // Preserve newlines as <br />
      const parts = node.value.split("\n");
      if (parts.length === 1) return node.value;
      return (
        <span key={nextKey()}>
          {parts.map((part, i) => (
            <React.Fragment key={i}>
              {i > 0 && <br />}
              {part}
            </React.Fragment>
          ))}
        </span>
      );
    }

    const children = renderTree(node.children, nextKey);

    switch (node.tag) {
      case "i":
        return <em key={nextKey()}>{children}</em>;

      case "b":
        return <strong key={nextKey()}>{children}</strong>;

      case "u":
        return <u key={nextKey()}>{children}</u>;

      case "s":
        return <s key={nextKey()}>{children}</s>;

      case "color": {
        const color = node.attr ?? "inherit";
        return (
          <span key={nextKey()} style={{ color }}>
            {children}
          </span>
        );
      }

      case "size": {
        // Ren'Py sizes are in pixels
        const px = node.attr ? parseInt(node.attr, 10) : undefined;
        const style: React.CSSProperties = px ? { fontSize: `${px}px` } : {};
        return (
          <span key={nextKey()} style={style}>
            {children}
          </span>
        );
      }

      case "alpha": {
        const opacity = node.attr ? parseFloat(node.attr) : 1;
        return (
          <span key={nextKey()} style={{ opacity }}>
            {children}
          </span>
        );
      }

      case "noalt":
      case "alt":
        // accessibility tags — keep children
        return <React.Fragment key={nextKey()}>{children}</React.Fragment>;

      default: {
        if (STRIP_TAGS.has(node.tag)) {
          return <React.Fragment key={nextKey()}>{children}</React.Fragment>;
        }
        // Unknown tag — render children only
        return <React.Fragment key={nextKey()}>{children}</React.Fragment>;
      }
    }
  });
}

// ─── High-level helpers ──────────────────────────────────────────────────────

/**
 * Parse a Ren'Py markup string and return an array of React nodes.
 * Each call gets its own isolated key generator, so concurrent renders
 * never share state.
 */
export function parseRenpyText(text: string): React.ReactNode[] {
  const nextKey = makeKeyGen();
  const tokens = tokenise(text);
  const tree = parse(tokens);
  return renderTree(tree, nextKey);
}

/**
 * Strip all Ren'Py markup tags and return plain text.
 * Useful for voice-over cue matching, tooltips, etc.
 */
export function stripRenpyTags(text: string): string {
  return text.replace(/\{[^}]+\}/g, "").trim();
}

/**
 * Returns true if the text contains the {nw} (no-wait) tag.
 * When present, the dialogue should auto-advance without a click.
 */
export function hasNoWait(text: string): boolean {
  return /\{nw\}/i.test(text);
}

/**
 * Returns true if the text contains a {fast} tag (skip typewriter effect).
 */
export function hasFast(text: string): boolean {
  return /\{fast\}/i.test(text);
}
