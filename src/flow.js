#!/usr/bin/env node
// Standalone Flow invocations enter the same builtin bootstrap as the package
// CLI. Registry dispatch imports flow-main.js after that proof is established.
import { fileURLToPath } from "node:url";
const bootstrap = new URL("./sennel.js", import.meta.url);
process.argv = [process.argv[0], fileURLToPath(bootstrap), "flow", ...process.argv.slice(2)];
await import(bootstrap.href);
// A --import preload may already have initialized the runtime without running
// CLI dispatch. Re-importing the fixed semantic entry is idempotent.
if (process.exitCode !== 1) await import("./cli-main.js");
