#!/usr/bin/env node
// Keep the main-thread bootstrap graph limited to Node builtins. Package
// resolution and capture run in the isolated loader thread before any semantic
// module enters this thread's ESM cache. Also usable with node --import.
import { register } from "node:module";
import { MessageChannel } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { realpathSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const rawArgs = process.argv.slice(2);
const entryPath = fileURLToPath(import.meta.url);
const isCli = process.argv[1] != null && realpathSync(resolve(process.argv[1])) === entryPath;
// This emergency projection deliberately has no semantic imports. The fixed
// runtime's normal serializer may itself be the module that failed to load.
// Its shape is checked against the canonical query schema in boundary tests.
function bootstrapFailure(error = null) {
  const code = "FLOW_BOOTSTRAP_FAILED";
  const explanation = "Flow runtime initialization failed.";
  const [causeName, causeCode, causeMessage] = [error?.name, error?.code, error?.message]
    .map((value) => typeof value === "string" ? value.slice(0, 16_384) : null);
  const nodeCode = causeCode !== null && /^[A-Z][A-Z0-9_]{0,199}$/.test(causeCode)
    ? causeCode : new Map([["SyntaxError", "SYNTAX_ERROR"], ["TypeError", "TYPE_ERROR"],
      ["ReferenceError", "REFERENCE_ERROR"], ["RangeError", "RANGE_ERROR"], ["Error", "UNCLASSIFIED_ERROR"]]).get(causeName) ?? code;
  const diagnosticReference = `${code}:${createHash("sha256").update(JSON.stringify([
    causeName, causeCode, causeMessage,
  ])).digest("hex")}`;
  const guidance = {
    schemaVersion: 1, code, cause: { kind: "bootstrap", code: nodeCode, recoveryHint: "unconfirmed" }, explanation,
    currentState: {
      operation: "unconfirmed", completion: "unconfirmed", persistence: "unconfirmed", stop: "unconfirmed",
      attemptCount: "unconfirmed", maxAttempts: "unconfirmed", budgetMs: "unconfirmed", elapsedMs: "unconfirmed",
      acceptance: "unconfirmed", communicationAttempts: [],
    },
    nextAction: { kind: "external_work", instruction: `Request diagnosis and repair of the CLI runtime; include diagnostic reference ${diagnosticReference}.`, preconditions: [] },
    diagnosticReference,
  };
  // The semantic contract hashes this same public presentation projection.
  // At this boundary there is no execution directive or runtime authority.
  const canonical = (value) => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  guidance.presentationDigest = createHash("sha256")
    .update(JSON.stringify(canonical({ directive: null, nextAction: guidance.nextAction }))).digest("hex");
  if (rawArgs[1] === "query") {
    return { schemaRevision: 3, ok: false, snapshot: null, completeness: null,
      error: { code, path: "/bootstrap", message: explanation, reason: null, referenceId: null }, guidance };
  }
  return { ok: false, type: "run", key: "bootstrap", data: null,
    errors: [{ level: "fatal", code, messages: [explanation] }], guidance };
}

try {
  const { port1, port2 } = new MessageChannel();
  const acknowledgement = new Promise((resolve, reject) => {
    port1.once("message", (message) => {
      port1.close();
      if (message.error) {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        error.code = message.error.code;
        reject(error);
      }
      else resolve(message);
    });
  });
  try {
    register(new URL("./lib/runtime-loader.js", import.meta.url), {
      parentURL: import.meta.url,
      data: { entryPath, argv: rawArgs, cwd: process.cwd(), isCli, port: port2 },
      transferList: [port2],
    });
    const runtime = await acknowledgement;
    if (runtime.diagnostic && !(rawArgs[0] === "flow" && runtime.failed === true)) writeSync(2, runtime.diagnostic);
    if (runtime.exitCode != null) {
      if (rawArgs[0] === "flow" && runtime.exitCode !== 0 && runtime.failed === true) {
        writeSync(1, `${JSON.stringify(bootstrapFailure({ name: "Error", code: "FLOW_RUNTIME_HANDOFF_FAILED", message: runtime.diagnostic }))}\n`);
      }
      process.exit(runtime.exitCode);
    }
    if (isCli) await import(runtime.entryUrl);
  } finally {
    port1.close();
    port2.close();
  }
} catch (error) {
  if (!isCli || rawArgs[0] !== "flow") throw error;
  writeSync(1, `${JSON.stringify(bootstrapFailure(error))}\n`);
  process.exitCode = 1;
}
