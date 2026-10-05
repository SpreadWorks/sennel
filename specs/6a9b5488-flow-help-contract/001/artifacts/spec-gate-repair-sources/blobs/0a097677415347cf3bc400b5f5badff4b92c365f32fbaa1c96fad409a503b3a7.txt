import fs from "fs";
import path from "path";

export const MAX_MAKEFILE_BYTES = 1024 * 1024;

const TEST_TARGET_RE = /^test\s*:/m;
const TARGET_RE = /^[^\s#][^:]*:/;

export function readMakefile(filePath, { ignoreTooLarge = false } = {}) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_MAKEFILE_BYTES) {
    if (ignoreTooLarge) return null;
    throw new Error(`${path.basename(filePath)} is too large to inspect: ${stat.size} bytes`);
  }
  return fs.readFileSync(filePath, "utf8");
}

export function hasMakeTestTarget(text) {
  return typeof text === "string" && TEST_TARGET_RE.test(text);
}

export function extractMakeTestTarget(text) {
  if (!hasMakeTestTarget(text)) return null;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^test\s*:/.test(line));
  const targetLines = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (TARGET_RE.test(line)) break;
    if (/^\s/.test(line) || line.trim() === "" || line.trim().startsWith("#")) {
      targetLines.push(line);
    } else {
      break;
    }
  }
  return targetLines.join("\n").trimEnd();
}
