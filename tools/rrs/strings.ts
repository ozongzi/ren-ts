#!/usr/bin/env bun
/**
 * strings.ts
 *
 * CLI utility to extract and inject translation strings from .rrs files.
 *
 * Usage:
 *   bun run tools/rrs/strings.ts extract <dir> -o <out.json>
 *   bun run tools/rrs/strings.ts inject <dir> -i <in.json> [-o <out_dir>]
 *
 * Behavior:
 * - extract: walks <dir> recursively, finds all `.rrs` files (sorted),
 *   parses each file and extracts all speak-line texts and menu choice texts
 *   in deterministic order:
 *     for each file (lexicographic), for each top-level label in order,
 *     traverse statements in source order and collect speak lines then menu texts
 *   Writes a single JSON array (only) to the output file (or stdout if -o -).
 *
 * - inject: reads the JSON array and replaces the extracted strings in the
 *   same traversal order across all `.rrs` files found under <dir>.
 *   It parses each file, walks the AST and replaces the strings, then
 *   serializes the AST back to `.rrs` source (note: formatting and comments
 *   may be lost) and writes files back. If -o <out_dir> is provided, files
 *   are written into that directory preserving relative paths; otherwise
 *   source files are overwritten.
 *
 * NOTE: This tool relies on the project's .rrs parser (lexer/parser AST).
 * The serializer implemented here aims to produce valid .rrs but may differ
 * in whitespace/comments from the original source.
 */

import { stat, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import * as path from "node:path";

import { tokenize } from "../../rrs/lexer.ts";
import { parse } from "../../rrs/parser.ts";
import type {
  Program,
  Stmt,
  SpeakStmt,
  MenuStmt,
  DefineDecl,
  LabelDecl,
  SpeakLine,
  MenuChoice,
} from "../../rrs/ast.ts";

type CLIArgs = { cmd: string; dir: string; jsonPath?: string; outDir?: string };

async function main() {
  try {
    const args = process.argv.slice(2);
    if (args.length < 2) return usageAndExit();

    const cmd = args[0];
    const dir = args[1];

    if (cmd === "extract") {
      let out = findArgValue(args, "-o") ?? findArgValue(args, "--out");
      if (!out) {
        usageAndExit("extract requires -o <output.json> (use - for stdout)");
      }
      const files = await findRrsFiles(dir);
      const allStrings: string[] = [];
      for (const f of files) {
        const src = await readFile(f, "utf8");
        const program = parseScriptToProgram(src, f);
        collectStringsFromProgram(program, allStrings);
      }
      const json = JSON.stringify(allStrings, null, 2);
      if (out === "-") {
        console.log(json);
      } else {
        await writeFile(out, json, "utf8");
        console.log(`Wrote ${allStrings.length} strings to ${out}`);
      }
      return;
    } else if (cmd === "inject") {
      const jsonPath = findArgValue(args, "-i") ?? findArgValue(args, "--in");
      if (!jsonPath) usageAndExit("inject requires -i <strings.json>");
      const outDir = findArgValue(args, "-o") ?? findArgValue(args, "--out");

      const raw = await readFile(jsonPath, "utf8");
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr) || !arr.every((x) => typeof x === "string"))
        throw new Error("JSON input must be an array of strings");

      const files = await findRrsFiles(dir);
      let idx = 0;
      const modifiedFiles: { sourcePath: string; relPath: string; content: string }[] =
        [];

      for (const f of files) {
        const src = await readFile(f, "utf8");
        const program = parseScriptToProgram(src, f);
        idx = applyStringsToProgram(program, arr, idx);
        const outText = serializeProgram(program);
        const relPath = path.relative(dir, f);
        modifiedFiles.push({ sourcePath: f, relPath, content: outText });
      }

      if (idx !== arr.length) {
        throw new Error(
          `String count mismatch: consumed ${idx} strings but JSON has ${arr.length}`,
        );
      }

      // Write outputs
      if (outDir) {
        // write into outDir preserving relative paths
        for (const mf of modifiedFiles) {
          const dest = path.join(outDir, mf.relPath);
          await mkdir(path.dirname(dest), { recursive: true });
          await writeFile(dest, mf.content, "utf8");
          console.log(`Wrote ${dest}`);
        }
      } else {
        // overwrite original files
        for (const mf of modifiedFiles) {
          await writeFile(mf.sourcePath, mf.content, "utf8");
          console.log(`Updated ${mf.sourcePath}`);
        }
      }

      console.log(`Injected ${idx} strings.`);
      return;
    } else {
      usageAndExit();
    }
  } catch (err) {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function usageAndExit(msg?: string): never {
  if (msg) console.error(msg);
  console.error(`
Usage:
  bun run tools/rrs/strings.ts extract <dir> -o <out.json|->
    - extracts all speak/menu strings into a JSON array

  bun run tools/rrs/strings.ts inject <dir> -i <in.json> [-o <out_dir>]
    - injects strings from JSON into .rrs files (overwrite by default)
`);
  process.exit(1);
}

function findArgValue(args: string[], key: string): string | undefined {
  const i = args.indexOf(key);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return undefined;
}

async function findRrsFiles(root: string): Promise<string[]> {
  const st = await stat(root);
  const out: string[] = [];
  if (st.isFile()) {
    if (root.endsWith(".rrs")) return [root];
    throw new Error("Input file must be a .rrs when a file is provided");
  }
  await walkDir(root, out);
  out.sort(); // deterministic order
  return out;
}

async function walkDir(dir: string, out: string[]) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walkDir(p, out);
    } else if (e.isFile() && p.endsWith(".rrs")) {
      out.push(p);
    }
  }
}

function parseScriptToProgram(src: string, filename: string): Program {
  const tokens = tokenize(src);
  const prog = parse(tokens);
  return prog as Program;
}

/**
 * Traversal & extraction
 *
 * Deterministic order:
 *   - files sorted lexicographically
 *   - for each file: labels in program.labels order
 *   - statements traversed in order, recursively into If/Menu branches
 *   - for SpeakStmt: each line in order is appended
 *   - for MenuStmt: each choice.text in order is appended
 */
function collectStringsFromProgram(program: Program, out: string[]) {
  for (const label of program.labels) {
    traverseStmtsCollect(label.body, out);
  }
}

function traverseStmtsCollect(stmts: Stmt[], out: string[]) {
  for (const s of stmts) {
    switch (s.kind) {
      case "Speak": {
        const sp = s as SpeakStmt;
        for (const ln of sp.lines) out.push(ln.text);
        break;
      }
      case "Menu": {
        const m = s as MenuStmt;
        for (const c of m.choices) out.push(c.text);
        // Still need to traverse bodies to catch nested speaks/menus
        for (const c of m.choices) traverseStmtsCollect(c.body, out);
        break;
      }
      case "If": {
        // type is IfStmt: has branches: each has body
        // lazy type import to avoid TS errors
        const ib: any = s;
        for (const br of ib.branches) traverseStmtsCollect(br.body, out);
        break;
      }
      case "Label": {
        const lb: any = s;
        traverseStmtsCollect(lb.body, out);
        break;
      }
      default:
        // Many statements have no nested bodies; some (like Call/Jump/etc.) don't.
        // Assign/Scene/Music/Show/Hide/Wait/With/Jump/Call/Return -> nothing to collect
        break;
    }
  }
}

/**
 * Apply strings from array into program in the exact same traversal order
 * used by collectStringsFromProgram. Returns new index after consuming entries.
 */
function applyStringsToProgram(program: Program, arr: string[], startIdx: number): number {
  let idx = startIdx;
  for (const label of program.labels) {
    idx = traverseStmtsApply(label.body, arr, idx);
  }
  return idx;
}

function traverseStmtsApply(stmts: Stmt[], arr: string[], idx: number): number {
  for (const s of stmts) {
    switch (s.kind) {
      case "Speak": {
        const sp = s as SpeakStmt;
        for (let i = 0; i < sp.lines.length; i++) {
          if (idx >= arr.length)
            throw new Error("Ran out of strings while injecting (too few items in JSON)");
          sp.lines[i].text = arr[idx++];
        }
        break;
      }
      case "Menu": {
        const m = s as MenuStmt;
        for (let i = 0; i < m.choices.length; i++) {
          if (idx >= arr.length)
            throw new Error("Ran out of strings while injecting (too few items in JSON)");
          m.choices[i].text = arr[idx++];
        }
        // traverse bodies
        for (const c of m.choices) idx = traverseStmtsApply(c.body, arr, idx);
        break;
      }
      case "If": {
        const ib: any = s;
        for (const br of ib.branches) idx = traverseStmtsApply(br.body, arr, idx);
        break;
      }
      case "Label": {
        const lb: any = s;
        idx = traverseStmtsApply(lb.body, arr, idx);
        break;
      }
      default:
        break;
    }
  }
  return idx;
}

/**
 * Serializer: converts Program AST back into .rrs source text.
 * This is a best-effort pretty-printer that produces valid .rrs source.
 * It intentionally omits comments and may differ in whitespace from the original.
 */

function serializeProgram(prog: Program): string {
  const out: string[] = [];

  // defines
  for (const d of prog.defines) {
    const line = serializeDefine(d);
    if (line) out.push(line);
  }
  if (prog.defines.length > 0) out.push(""); // spacer

  for (const lbl of prog.labels) {
    out.push(serializeLabel(lbl));
    out.push("");
  }

  return out.join("\n").trimEnd() + "\n";
}

function serializeDefine(d: DefineDecl): string | null {
  if (!d || !d.key) return null;
  // d.value can be "" sentinel or object
  if (d.value === "" || d.value === undefined) {
    // unknown/complex value: skip emitting to avoid accidental invalid source
    return null;
  }
  // value can be DefineValueToken or string (older forms)
  // If it's an object with kind/raw use those
  // If it's a primitive, print as raw
  // Strings need quoting
  // We'll handle the common kinds Str/Num/Ident/HexColor/Other
  const valAny: any = d.value;
  if (typeof valAny === "string") {
    // uncertain kind: emit raw
    return `${d.key} = ${valAny};`;
  } else if (typeof valAny === "object" && "raw" in valAny) {
    const kind = valAny.kind;
    const raw = String(valAny.raw);
    if (kind === "Str") {
      return `${d.key} = "${escapeStr(raw)}";`;
    } else {
      return `${d.key} = ${raw};`;
    }
  } else {
    // fallback
    return `${d.key} = ${String(valAny)};`;
  }
}

function serializeLabel(lbl: LabelDecl): string {
  const lines: string[] = [];
  lines.push(`label ${lbl.name} {`);
  lines.push(...serializeStmts(lbl.body, 1));
  lines.push(`}`);
  return lines.join("\n");
}

function serializeStmts(stmts: Stmt[], indentLevel: number): string[] {
  const out: string[] = [];
  for (const s of stmts) {
    out.push(...serializeStmt(s, indentLevel));
  }
  return out;
}

function indent(n: number): string {
  return "  ".repeat(n);
}

function serializeStmt(s: Stmt, indentLevel: number): string[] {
  const id = indent(indentLevel);
  switch (s.kind) {
    case "Assign": {
      const st: any = s;
      return [`${id}${st.name} ${st.op} ${st.value};`];
    }
    case "Scene": {
      const st: any = s;
      let base = `${id}scene `;
      if (st.srcIsLiteral) base += `"${escapeStr(st.src)}"`;
      else base += `${st.src}`;
      if (st.filter) base += ` ${st.filter}`;
      if (st.transition) base += ` | ${st.transition}`;
      base += ";";
      return [base];
    }
    case "Music": {
      const st: any = s;
      if (st.action === "play") {
        const src = st.src ? `("${escapeStr(st.src)}")` : "()";
        let m = `${id}music::play${src}`;
        if (st.fadein !== undefined) m += ` | fadein(${st.fadein})`;
        m += ";";
        return [m];
      } else {
        let m = `${id}music::stop()`;
        if (st.fadeout !== undefined) m += ` | fadeout(${st.fadeout})`;
        m += ";";
        return [m];
      }
    }
    case "Sound": {
      const st: any = s;
      if (st.action === "play") {
        return [`${id}sound::play("${escapeStr(st.src ?? "")}");`];
      } else {
        return [`${id}sound::stop();`];
      }
    }
    case "Show": {
      const st: any = s;
      let line = `${id}show ${st.key}`;
      if (st.at) line += ` @ ${st.at}`;
      if (st.transition) line += ` | ${st.transition}`;
      line += ";";
      return [line];
    }
    case "Hide": {
      const st: any = s;
      return [`${id}hide ${st.tag};`];
    }
    case "With": {
      const st: any = s;
      return [`${id}with ${st.transition};`];
    }
    case "Speak": {
      const st: SpeakStmt = s as SpeakStmt;
      // Decide whether to emit inline or block form
      if (st.lines.length === 1) {
        const line = st.lines[0];
        const who = nameNeedsQuoting(st.who) ? `"${escapeStr(st.who)}"` : st.who;
        if (line.voice) {
          return [
            `${id}speak ${who} "${escapeStr(line.text)}" | "${escapeStr(
              line.voice,
            )}";`,
          ];
        } else {
          return [`${id}speak ${who} "${escapeStr(line.text)}";`];
        }
      } else {
        const who = nameNeedsQuoting(st.who) ? `"${escapeStr(st.who)}"` : st.who;
        const lines = [`${id}speak ${who} {`];
        for (const ln of st.lines) {
          if (ln.voice) {
            lines.push(
              `${id}  "${escapeStr(ln.text)}" | "${escapeStr(ln.voice)}";`,
            );
          } else {
            lines.push(`${id}  "${escapeStr(ln.text)}";`);
          }
        }
        lines.push(`${id}}`);
        return lines;
      }
    }
    case "Wait": {
      const st: any = s;
      return [`${id}wait(${st.duration});`];
    }
    case "If": {
      const st: any = s;
      const out: string[] = [];
      for (let i = 0; i < st.branches.length; i++) {
        const br = st.branches[i];
        if (i === 0) {
          out.push(`${id}if ${br.condition ?? ""} {`);
        } else if (br.condition !== null) {
          out.push(`${id}elif ${br.condition} {`);
        } else {
          out.push(`${id}else {`);
        }
        out.push(...serializeStmts(br.body, indentLevel + 1));
        out.push(`${id}}`);
      }
      return out;
    }
    case "Menu": {
      const st: MenuStmt = s as MenuStmt;
      const out: string[] = [];
      out.push(`${id}menu {`);
      for (const choice of st.choices) {
        let line = `${id}  "${escapeStr(choice.text)}"`;
        if (choice.condition) line += ` if ${choice.condition}`;
        line += ` => {`;
        out.push(line);
        out.push(...serializeStmts(choice.body, indentLevel + 2));
        out.push(`${id}  }`);
      }
      out.push(`${id}}`);
      return out;
    }
    case "Jump": {
      const st: any = s;
      return [`${id}jump ${st.target};`];
    }
    case "Call": {
      const st: any = s;
      return [`${id}call ${st.target};`];
    }
    case "Return": {
      return [`${id}return;`];
    }
    case "Label": {
      const st: any = s;
      // nested label - emit as nested label block (parser may hoist, but keep it)
      const lines: string[] = [];
      lines.push(`${id}label ${st.name} {`);
      lines.push(...serializeStmts(st.body, indentLevel + 1));
      lines.push(`${id}}`);
      return lines;
    }
    default:
      return [`${id}// <unhandled stmt kind=${(s as any).kind}>`];
  }
}

function nameNeedsQuoting(name: string): boolean {
  if (!name) return true;
  // Ident: letters/numbers/_ only and not starting with digit
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return true;
  return false;
}

function escapeStr(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

// Run
if (import.meta.main) {
  main();
}
