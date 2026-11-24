import fs from "node:fs";
import path from "node:path";
import { shellQuote } from "./shell-argument.js";

/** Install the ordinary CLI route inside a caller-owned fixture, independent of
 * its package type and the globally installed Sennel revision. */
export function installSennelTestLauncher(root, { entryPath }) {
  const bin = path.join(root, ".test-bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "sennel"),
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(entryPath)} "$@"\n`, { mode: 0o755 });
  // Quoted Windows paths cannot contain double quotes. Escape percent expansion
  // in the batch file and disable delayed expansion so literal ! survives.
  const batchPath = (value) => `"${value.replaceAll("%", "%%")}"`;
  fs.writeFileSync(path.join(bin, "sennel.cmd"),
    `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${batchPath(process.execPath)} ${batchPath(entryPath)} %*\r\nexit /b %errorlevel%\r\n`);
  return bin;
}
