import React from "react";
import { parseRenpyText } from "./textParserUtils";

/**
 * Tiny React wrapper component that renders Ren'Py-marked-up text inline.
 *
 * Usage:
 *   <RenpyText text="{i}Hello{/i} world" />
 */
export function RenpyText({ text }: { text: string }): React.ReactElement {
  const nodes = parseRenpyText(text);
  return <span className="renpy-text">{nodes}</span>;
}
