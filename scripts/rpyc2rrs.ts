#!/usr/bin/env bun
// Usage: bun scripts/rpyc2rrs.ts <file.rpyc> [output.rrs]
// 转换单个 .rpyc 文件为 .rrs，输出到文件或 stdout

import { readFile, writeFile } from "fs/promises";
import { basename } from "path";
import { readRpyc } from "../src/rpycReader";
import { convertRpyc } from "../rpy-rrs-bridge/rpyc2rrs-core";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: bun scripts/rpyc2rrs.ts <file.rpyc> [output.rrs]");
  process.exit(1);
}
const outputPath = process.argv[3] ?? null;

const buf = await readFile(inputPath);
const uint8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

const rpyc = await readRpyc(uint8);
const rrs = convertRpyc(rpyc.astPickle, basename(inputPath));

if (outputPath) {
  await writeFile(outputPath, rrs);
  console.error(`已写入 ${outputPath}`);
} else {
  process.stdout.write(rrs);
}
