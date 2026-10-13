#!/usr/bin/env node
// Keep the main-thread bootstrap graph limited to Node builtins. Package
// resolution and capture run in the isolated loader thread before any semantic
// module enters this thread's ESM cache. Also usable with node --import.
import { register } from "node:module";
import { MessageChannel } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { realpathSync, writeSync } from "node:fs";
import { resolve } from "node:path";

const rawArgs = process.argv.slice(2);
const entryPath = fileURLToPath(import.meta.url);
const isCli = process.argv[1] != null && realpathSync(resolve(process.argv[1])) === entryPath;
const { port1, port2 } = new MessageChannel();
const acknowledgement = new Promise((resolve, reject) => {
  port1.once("message", (message) => {
    port1.close();
    if (message.error) reject(new Error(message.error));
    else resolve(message);
  });
});
register(new URL("./lib/runtime-loader.js", import.meta.url), {
  parentURL: import.meta.url,
  data: { entryPath, argv: rawArgs, cwd: process.cwd(), isCli, port: port2 },
  transferList: [port2],
});
const runtime = await acknowledgement;
if (runtime.diagnostic) writeSync(2, runtime.diagnostic);
if (runtime.exitCode != null) process.exit(runtime.exitCode);
if (isCli) await import(runtime.entryUrl);
