#!/usr/bin/env node
// Keep the main-thread bootstrap graph limited to Node builtins. Runtimes with
// registerHooks capture in an isolated Worker, then install the shared synchronous
// hooks; older runtimes use register and its isolated loader thread. Both capture
// before semantic modules enter this thread's cache. Also usable with node --import.
import * as nodeModule from "node:module";
import { MessageChannel, Worker } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync, writeSync, lstatSync, openSync, fstatSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve, join, isAbsolute, dirname, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { gunzipSync } from "node:zlib";

import { setTimeout as delay } from "node:timers/promises";

const rawArgs = process.argv.slice(2);
const entryPath = fileURLToPath(import.meta.url);
const capturedEntryRevision = new URL(import.meta.url).searchParams.get("sennel-runtime");
const isCli = process.argv[1] != null && (capturedEntryRevision === null
  ? realpathSync(resolve(process.argv[1])) : resolve(process.argv[1])) === entryPath;
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
    return { schemaRevision: 4, ok: false, snapshot: null, completeness: null,
      error: { code, path: "/bootstrap", message: explanation, reason: null, referenceId: null }, guidance };
  }
  return { ok: false, type: "run", key: "bootstrap", data: null,
    errors: [{ level: "fatal", code, messages: [explanation] }], guidance };
}


// An inherited wrapper authenticates before importing the on-disk loader.
// This boundary intentionally uses only Node builtins until the parent bytes
// have been matched to their advertised revision.
async function inheritedCommandDelivery() {
  const serialized = process.env.SENNEL_PROCESS_EXECUTION_SCOPE;
  if (serialized === undefined) {
    const error = new Error("Run sennel command from an active Sennel execution context");
    error.code = "COMMAND_CONTEXT_REQUIRED"; throw error;
  }
  let grant;
  try { grant = JSON.parse(serialized); }
  catch { const error = new Error("Inherited execution context is malformed"); error.code = "COMMAND_CONTEXT_INVALID"; throw error; }
  if (grant.version !== 3 || !/^[a-f0-9]{64}$/.test(grant.runtimeRevision ?? "")
    || grant.endpoint === null || typeof grant.endpoint !== "object" || Object.keys(grant.endpoint).length !== 4
    || !["host", "port", "mailbox", "storage"].every((key) => Object.hasOwn(grant.endpoint, key))
    || grant.endpoint.mailbox === null || typeof grant.endpoint.mailbox !== "object" || Object.keys(grant.endpoint.mailbox).length !== 2
    || !["requests", "responses"].every((key) => Object.hasOwn(grant.endpoint.mailbox, key))
    || !isAbsolute(grant.endpoint?.mailbox?.requests ?? "") || !isAbsolute(grant.endpoint?.mailbox?.responses ?? "")) {
    const error = new Error("Inherited execution context has no authenticated coordinator endpoint");
    error.code = "COMMAND_CONTEXT_INVALID"; throw error;
  }
  const payload = { grant, data: {} };
  const request = { executionId: grant.executionId, callId: grant.callId, ownerToken: grant.ownerToken,
    capability: grant.capability, operation: "runtime-snapshot", payload, requestId: randomUUID(),
    payloadDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
  const mailbox = grant.endpoint.mailbox;
  const directories = [mailbox.requests, mailbox.responses].map((directory) => {
    const identity = lstatSync(directory, { bigint: true });
    if (!identity.isDirectory() || identity.isSymbolicLink() || realpathSync(directory) !== directory) throw new Error("Inherited mailbox directory is not a real directory");
    return { directory, identity };
  });
  const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
  const assertDirectories = () => {
    for (const { directory, identity } of directories) {
      const current = lstatSync(directory, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, identity) || realpathSync(directory) !== directory) throw new Error("Inherited mailbox directory changed");
    }
  };
  let pendingResponsePublication = null;
  const readFrame = (file, { response = false } = {}) => {
    assertDirectories();
    let before;
    try { before = lstatSync(file, { bigint: true }); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.size > 32n * 1024n * 1024n) throw new Error("Inherited mailbox frame is invalid");
    const exclusive = (stat) => {
      if (stat.nlink === 1n) return true;
      const error = new Error("Inherited mailbox response is still multiply linked and cannot be read");
      error.code = "COMMAND_BOOTSTRAP_RESPONSE_PUBLICATION_PENDING";
      if (response && stat.nlink > 1n) { pendingResponsePublication = error; return false; }
      throw new Error("Inherited mailbox frame is invalid");
    };
    // Only a response may be between the coordinator's exclusive link and its
    // owned stage unlink. Marker reads remain strict; no bytes cross this bound.
    if (!exclusive(before)) return null;
    const fd = openSync(file, "r");
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!sameIdentity(opened, before)) throw new Error("Inherited mailbox frame changed");
      if (!exclusive(opened)) return null;
      const bytes = readFileSync(fd);
      const after = fstatSync(fd, { bigint: true });
      const current = lstatSync(file, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(current, before)) throw new Error("Inherited mailbox frame changed during read");
      if (!exclusive(after) || !exclusive(current)) return null;
      if (bytes.length !== Number(before.size) || after.size !== before.size || after.mtimeNs !== before.mtimeNs
        || after.ctimeNs !== before.ctimeNs) throw new Error("Inherited mailbox frame changed during read");
      assertDirectories();
      return bytes;
    } finally { closeSync(fd); }
  };
  // The coordinator authenticates the capability when it receives the request.
  // Before either transport, constrain mailbox writes to its checkout namespace.
  for (const root of [grant.mainRoot, grant.executionRoot]) {
    if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root) throw new Error("Inherited checkout root is invalid");
  }
  // Both authorities use the same workspace contract. Inventory storage and
  // transport storage remain independent; only transport storage is writable
  // by an inherited read-only invocation.
  const validateStorage = (storage) => {
    const fields = ["schemaVersion", "kind", "workspaceRoot", "workspaceGeneration", "directory", "token", "workspaceIdentity", "directoryIdentity"];
    if (!storage || typeof storage !== "object" || Object.keys(storage).length !== fields.length
      || fields.some((field) => !Object.hasOwn(storage, field)) || storage.schemaVersion !== 1 || storage.kind !== "readonly-invocation"
      || !/^[0-9a-f-]{36}$/.test(storage.workspaceGeneration) || !/^[0-9a-f-]{36}$/.test(storage.token)
      || !isAbsolute(storage.workspaceRoot ?? "") || storage.directory !== join(storage.workspaceRoot, "control", "process-runtime")) throw new Error("Inherited read-only storage authority is invalid");
    for (const [directory, expected] of [[storage.workspaceRoot, storage.workspaceIdentity], [storage.directory, storage.directoryIdentity]]) {
      if (!expected || typeof expected !== "object" || Object.keys(expected).length !== 2
        || ["dev", "ino"].some((field) => !Object.hasOwn(expected, field) || typeof expected[field] !== "string" || expected[field].length === 0)) throw new Error("Inherited read-only storage identity is malformed");
      const actual = lstatSync(directory, { bigint: true });
      if (!actual.isDirectory() || actual.isSymbolicLink() || realpathSync(directory) !== directory
        || String(actual.dev) !== expected?.dev || String(actual.ino) !== expected?.ino) throw new Error("Inherited read-only storage identity changed");
    }
    const marker = readFrame(join(storage.directory, "storage-authority.json"));
    if (marker === null || marker.length > 64 * 1024 || marker.toString("utf8") !== JSON.stringify(storage)) throw new Error("Inherited read-only storage authority differs from its marker");
    return storage.directory;
  };
  if (grant.storage !== null && grant.storage !== undefined) validateStorage(grant.storage);
  const storageDirectory = validateStorage(grant.endpoint.storage);
  const checkoutDigest = createHash("sha256").update(JSON.stringify(grant.executionRoot)).digest("hex");
  const namespace = join(storageDirectory, "control", checkoutDigest);
  const session = dirname(mailbox.requests);
  if (dirname(session) !== namespace || !/^session-[0-9a-f-]{36}$/.test(basename(session))
    || mailbox.requests !== join(session, "requests") || mailbox.responses !== join(session, "responses")) throw new Error("Inherited mailbox is outside its coordinator namespace");
  if (grant.endpoint.host !== "127.0.0.1" || grant.endpoint.port !== null
    && (!Number.isInteger(grant.endpoint.port) || grant.endpoint.port < 1 || grant.endpoint.port > 65535)
    || grant.transport !== undefined && grant.transport !== "mailbox") throw new Error("Inherited coordinator transport is invalid");
  const deadlines = grant.controlResponseDeadlinesMs;
  if (!Array.isArray(deadlines) || deadlines.length < 1 || deadlines.length > 3
    || deadlines.some((value, index) => !Number.isSafeInteger(value) || value <= (deadlines[index - 1] ?? 0) || value > 14000)) {
    throw new Error("Inherited coordinator response policy is invalid");
  }
  const requestFile = join(mailbox.requests, request.requestId + ".json");
  const requestBytes = Buffer.from(JSON.stringify(request));
  let mailboxPublished = false;
  const publishMailboxRequest = () => {
    if (mailboxPublished) return;
    const stage = join(mailbox.requests, request.requestId + "." + randomUUID() + ".tmp");
    const descriptor = openSync(stage, "wx");
    const stageIdentity = fstatSync(descriptor, { bigint: true });
    try {
      writeFileSync(descriptor, requestBytes);
      assertDirectories();
      if (!sameIdentity(lstatSync(stage, { bigint: true }), stageIdentity)) throw new Error("Inherited mailbox request stage changed");
      closeSync(descriptor);
      renameSync(stage, requestFile);
      mailboxPublished = true;
    } catch (error) {
      try { closeSync(descriptor); } catch { /* The descriptor may already be closed before rename. */ }
      try { if (sameIdentity(lstatSync(stage, { bigint: true }), stageIdentity)) unlinkSync(stage); }
      catch (cleanupError) { if (cleanupError.code !== "ENOENT") throw new AggregateError([error, cleanupError], "Mailbox request and cleanup failed"); }
      throw error;
    }
  };
  // This pre-proof frame reader has no semantic imports. After authentication,
  // managedRequest owns all operations and their normal transport policy.
  let connectionFailure = null;
  const readSocketFrame = (timeoutMs) => new Promise((resolveResponse, reject) => {
    const socket = createConnection({ host: grant.endpoint.host, port: grant.endpoint.port });
    let complete = false;
    let received = Buffer.alloc(0);
    let timer;
    const finish = (error, value = null) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolveResponse(value);
    };
    timer = setTimeout(() => finish(null), Math.max(1, timeoutMs));
    socket.on("error", (error) => { connectionFailure = error; finish(null); });
    socket.on("end", () => finish(null));
    socket.on("close", () => finish(null));
    socket.on("connect", () => socket.write(Buffer.concat([requestBytes, Buffer.from("\n")])));
    socket.on("data", (bytes) => {
      received = Buffer.concat([received, bytes]);
      if (received.length > 32 * 1024 * 1024) return finish(new Error("Inherited coordinator response exceeds its byte bound"));
      const newline = received.indexOf(10);
      if (newline < 0) return;
      try { finish(null, JSON.parse(received.subarray(0, newline).toString("utf8"))); }
      catch (error) { finish(error); }
    });
  });
  const responseFile = join(mailbox.responses, request.requestId + ".json");
  const started = performance.now();
  let response = null;
  // The bootstrap shares the normal protocol's three cumulative response slots.
  // One immutable request is reused; elapsed time never authorizes another call.
  for (const deadline of deadlines) {
    const remaining = deadline - (performance.now() - started);
    if (remaining <= 0) continue;
    // Match the shared protocol's TCP -> mailbox choice within the same slot.
    // Read-only callers can authenticate over TCP without publishing any file.
    if (grant.transport !== "mailbox" && grant.endpoint.port !== null) {
      response = await readSocketFrame(remaining);
      if (response !== null) break;
    }
    if (performance.now() - started >= deadline) continue;
    try { publishMailboxRequest(); }
    catch (error) {
      if (connectionFailure === null) throw error;
      const failure = new AggregateError([connectionFailure, error],
        `Inherited coordinator TCP failed (${connectionFailure.code ?? connectionFailure.name}); mailbox publication failed (${error.code ?? error.name})`,
        { cause: connectionFailure });
      failure.code = "PROCESS_EXECUTION_ENDPOINT_UNAVAILABLE";
      throw failure;
    }
    while (performance.now() - started < deadline) {
      const bytes = readFrame(responseFile, { response: true });
      if (bytes !== null) { response = JSON.parse(bytes); break; }
      await delay(Math.min(10, Math.max(1, deadline - (performance.now() - started))));
    }
    if (response !== null) break;
  }
  if (response === null) {
    if (pendingResponsePublication !== null) throw pendingResponsePublication;
    throw new Error("Inherited coordinator did not return its runtime snapshot within three response slots");
  }
  for (const key of ["executionId", "callId", "ownerToken", "capability", "operation", "requestId", "payloadDigest"]) {
    if (response[key] !== request[key]) throw new Error("Inherited runtime proof belongs to another request");
  }
  if (response.payload?.ok !== true) {
    const error = new Error(response.payload?.error?.message ?? "Inherited runtime request was refused");
    error.code = response.payload?.error?.code ?? "COMMAND_CONTEXT_REFUSED"; throw error;
  }
  const envelope = response.payload.value;
  const fields = ["schemaVersion", "encoding", "revision", "decodedByteLength", "digest", "body"];
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)
    || Object.keys(envelope).length !== fields.length || fields.some((field) => !Object.hasOwn(envelope, field))
    || envelope.schemaVersion !== 1 || envelope.encoding !== "gzip-base64"
    || envelope.revision !== grant.runtimeRevision
    || !Number.isSafeInteger(envelope.decodedByteLength) || envelope.decodedByteLength <= 0
    || envelope.decodedByteLength > 32 * 1024 * 1024
    || typeof envelope.digest !== "string" || !/^[a-f0-9]{64}$/.test(envelope.digest)
    || typeof envelope.body !== "string") throw new Error("Inherited runtime delivery envelope is invalid");
  const compressed = Buffer.from(envelope.body, "base64");
  if (compressed.toString("base64") !== envelope.body) throw new Error("Inherited runtime delivery base64 is invalid");
  let decoded;
  try { decoded = gunzipSync(compressed, { maxOutputLength: envelope.decodedByteLength }); }
  catch (cause) { throw new Error("Inherited runtime delivery decompression failed", { cause }); }
  if (decoded.length !== envelope.decodedByteLength
    || createHash("sha256").update(decoded).digest("hex") !== envelope.digest) {
    throw new Error("Inherited runtime delivery bytes differ from their envelope");
  }
  const delivery = JSON.parse(decoded.toString("utf8"));
  if (!delivery || !isAbsolute(delivery.root) || !Array.isArray(delivery.resources)
    || !Array.isArray(delivery.identity?.files) || delivery.identity.revision !== grant.runtimeRevision) {
    throw new Error("Inherited runtime delivery has no matching revision");
  }
  const resources = new Map(delivery.resources);
  if (resources.size !== delivery.resources.length || resources.size !== delivery.identity.files.length) throw new Error("Inherited runtime delivery has duplicate or missing resources");
  const revision = createHash("sha256").update("runtime-package\0");
  let previous = "";
  for (const file of delivery.identity.files) {
    if (typeof file.key !== "string" || file.key <= previous || /(?:^|\/)\.\.(?:\/|$)|\\/.test(file.key)
      || !(file.key === "package.json" || file.key.startsWith("src/")) || typeof resources.get(file.key) !== "string") {
      throw new Error("Inherited runtime resource inventory is invalid");
    }
    previous = file.key;
    const content = Buffer.from(resources.get(file.key), "base64");
    if (content.length !== file.bytes || createHash("sha256").update(content).digest("hex") !== file.digest) throw new Error("Inherited runtime resource bytes differ from their proof");
    revision.update("runtime-module\0").update(file.key).update("\0").update(file.digest).update("\0").update(String(file.bytes)).update("\0");
  }
  if (revision.digest("hex") !== grant.runtimeRevision) throw new Error("Inherited runtime revision differs from its bytes");
  return delivery;
}


async function initializeRuntime(delivery) {
  const input = { entryPath, argv: rawArgs, cwd: process.cwd(), isCli };
  if (typeof nodeModule.registerHooks === "function") {
    let capturedEntryPath = null;
    if (delivery === null) {
      // Package policy cannot be imported before capture. This builtin boundary
      // uses a finite startup window, independently of coordinator admission.
      const captureStarted = performance.now();
      const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "NODE_OPTIONS"));
      const worker = new Worker(new URL("./lib/runtime-capture-worker.js", import.meta.url), {
        workerData: input, execArgv: [], env: environment,
      });
      const captured = await new Promise((resolveCapture, reject) => {
        let result;
        let failure;
        let finished = false;
        const finish = (error, value) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          if (error) reject(error); else resolveCapture(value);
        };
        const timer = setTimeout(() => {
          const error = new Error("Runtime capture did not acknowledge and exit within its finite startup window", { cause: failure });
          error.code = "RUNTIME_CAPTURE_EXIT_UNCONFIRMED";
          // Requesting termination is not an observed exit. Never await an
          // unbounded termination promise or publish runtime proof after cutoff.
          const termination = worker.terminate();
          worker.unref();
          termination.catch((cause) => { error.cause ??= cause; });
          finish(error);
        }, Math.max(1, 30000 - (performance.now() - captureStarted)));
        worker.once("message", (message) => {
          result = message;
          if (message.error && failure === undefined) {
            failure = new Error(message.error.message);
            failure.name = message.error.name; failure.code = message.error.code;
          }
        });
        worker.once("error", (error) => { failure ??= error; });
        worker.once("exit", (code) => {
          if (failure) finish(failure);
          else if (code !== 0 || result === undefined) finish(new Error("Runtime capture worker exited without its snapshot"));
          else finish(null, result);
        });
      });
      if (captured.error) {
        const error = new Error(captured.error.message);
        error.name = captured.error.name; error.code = captured.error.code; throw error;
      }
      if (captured.exitCode != null) return captured;
      delivery = captured.delivery;
      capturedEntryPath = captured.selectedEntryPath ?? null;
    }
    const source = new Map(delivery.resources).get("src/lib/runtime-bootstrap-loader.js");
    if (typeof source !== "string") throw new Error("Inherited runtime transport is missing");
    const transport = await import(`data:text/javascript;base64,${source}`);
    return transport.installRuntimeHooks(delivery, { capturedEntryPath });
  }
  if (delivery !== null) {
    const source = new Map(delivery.resources).get("src/lib/runtime-bootstrap-loader.js");
    if (typeof source !== "string") throw new Error("Inherited runtime transport is missing");
    nodeModule.register(`data:text/javascript;base64,${source}`, { parentURL: import.meta.url, data: delivery });
  }
  const { port1, port2 } = new MessageChannel();
  const acknowledgement = new Promise((resolveRuntime, reject) => {
    port1.once("message", (message) => {
      port1.close();
      if (message.error) {
        const error = new Error(message.error.message);
        error.name = message.error.name; error.code = message.error.code; reject(error);
      } else resolveRuntime(message);
    });
  });
  try {
    nodeModule.register(delivery === null ? new URL("./lib/runtime-loader.js", import.meta.url) : pathToFileURL(join(delivery.root, "src/lib/runtime-loader.js")), {
      parentURL: import.meta.url,
      data: { ...input, port: port2, delivery, expectedRevision: delivery?.identity.revision ?? null },
      transferList: [port2],
    });
    return await acknowledgement;
  } finally { port1.close(); port2.close(); }
}

try {
  if (capturedEntryRevision !== null) {
    // Only the active loader can grant this context to its captured local entry.
    // The local source has executed; reuse the established snapshot without a
    // second capture or an unmanaged CLI subprocess.
    const context = (await import(`sennel:runtime-entry/${capturedEntryRevision}`)).default;
    if (isCli) await import(context.entryUrl);
  } else {
    const inheritedCommand = isCli && rawArgs[0] === "command" && !["--help", "-h"].includes(rawArgs[1]);
    const delivery = inheritedCommand ? await inheritedCommandDelivery() : null;
    const runtime = await initializeRuntime(delivery);
    if (runtime.diagnostic && !(rawArgs[0] === "flow" && runtime.failed === true)) writeSync(2, runtime.diagnostic);
    if (runtime.exitCode != null) {
      if (rawArgs[0] === "flow" && runtime.exitCode !== 0 && runtime.failed === true) {
        writeSync(1, `${JSON.stringify(bootstrapFailure({ name: "Error", code: "FLOW_RUNTIME_HANDOFF_FAILED", message: runtime.diagnostic }))}\n`);
      }
      process.exit(runtime.exitCode);
    }
    if (runtime.selectedEntryPath !== undefined) {
      process.argv[1] = runtime.selectedEntryPath;
      process.env.SENNEL_WORK_ROOT = runtime.selectedRoot;
      process.env.SENNEL_SOURCE_ROOT = runtime.selectedRoot;
    }
    if (isCli) await import(runtime.entryUrl);

  }
} catch (error) {
  if (isCli && rawArgs[0] === "command") {
    writeSync(2, `sennel command: ${error.code ?? "COMMAND_BOOTSTRAP_FAILED"}: ${error.message}\n`);
    process.exitCode = 125;
  } else if (!isCli || rawArgs[0] !== "flow") throw error;
  else {
    writeSync(1, `${JSON.stringify(bootstrapFailure(error))}\n`);
    process.exitCode = 1;
  }
}
