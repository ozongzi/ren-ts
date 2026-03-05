#!/usr/bin/env bun
// Usage: bun scripts/rpy2rrs.ts <file.rpy> [output.rrs]
// 转换单个 .rpy 文件为 .rrs，输出到文件或 stdout

import { readFile, writeFile } from "fs/promises";
import { basename } from "path";
import { convertRpy } from "../rpy-rrs-bridge/rpy2rrs-core";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: bun scripts/rpy2rrs.ts <file.rpy> [output.rrs]");
  process.exit(1);
}
const outputPath = process.argv[3] ?? null;

const src = await readFile(inputPath, "utf-8");
const rrs = convertRpy(src, basename(inputPath));

if (outputPath) {
  await writeFile(outputPath, rrs);
  console.error(`已写入 ${outputPath}`);
} else {
  process.stdout.write(rrs);
}
