import { AtomicFile } from "./atomic-file.js";
import { captureRegularFile, DEFAULT_MAX_FILE_BYTES } from "./regular-file-snapshot.js";
import fs from "node:fs";
import path from "node:path";
import { TemporaryPaths } from "./temporary-paths.js";
import { ReadOnlyProcessRuntimeStorage } from "./readonly-invocation-workspace.js";
import { fileURLToPath } from "node:url";
import { RuntimePackageLocation } from "./runtime-package-location.js";
import { RuntimePackageIdentity } from "./runtime-package-identity.js";
import { RuntimePackageWireDelivery } from "./runtime-package-wire-delivery.js";
import { runCmd, runManagedCmdAsync } from "./process.js";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { ProcessExecutionStopReceipt } from "./process-execution-values.js";
import { immutableCommandEnvironment } from "./command-invocation.js";

export { RuntimePackageIdentity } from "./runtime-package-identity.js";

// This decision belongs to module evaluation. A module loaded before bootstrap
// stays unproven forever; later disk hashing or registration cannot bless it.
let proof = null;
try {
  const revision = new URL(import.meta.url).searchParams.get("sennel-runtime");
  if (revision) proof = (await import(`sennel:runtime-snapshot/${revision}`)).default;
}
catch (error) {
  if (!["ERR_UNSUPPORTED_ESM_URL_SCHEME", "ERR_MODULE_NOT_FOUND"].includes(error.code)
    && !error.message.startsWith("RUNTIME_UNPROVEN:")) throw error;
}
const identity = proof ? new RuntimePackageIdentity(proof.identity) : null;
const resources = new Map(proof?.resources || []);
const location = new RuntimePackageLocation(proof?.root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
proof = null;
let childDelivery = null;
let childWireDelivery = null;

export function currentRuntimePackage() {
  if (!identity) throw new Error("RUNTIME_UNPROVEN: start through the Sennel bootstrap before importing runtime modules");
  return identity;
}

export function isRuntimeResource(input) {
  return location.owns(input);
}

export function runtimeResourceExists(input) {
  if (!isRuntimeResource(input)) return fs.existsSync(input);
  currentRuntimePackage();
  const key = location.key(input);
  return resources.has(key) || [...resources.keys()].some((entry) => entry.startsWith(`${key}/`));
}

function capturedRuntimeDeliveryJSON() {
  const runtime = currentRuntimePackage();
  childDelivery ??= JSON.stringify({ root: location.root, identity: runtime.toJSON(), resources: [...resources] });
  return childDelivery;
}

/** Authenticated coordinator delivery; always the active captured bytes, never a disk recapture. */
export function currentRuntimeDelivery() {
  return JSON.parse(capturedRuntimeDeliveryJSON());
}

function capturedRuntimeWireDelivery() {
  const runtime = currentRuntimePackage();
  childWireDelivery ??= new RuntimePackageWireDelivery(capturedRuntimeDeliveryJSON(), runtime.revision);
  return childWireDelivery;
}

/** RPC keeps its existing frame bound; owned files share the same compressed capture. */
export function currentRuntimeWireDelivery() {
  return capturedRuntimeWireDelivery().toJSON();
}

/** Only package-owned resources are pinned; target project inputs stay live. */
export function readRuntimeResource(input, encoding = "utf8") {
  if (!isRuntimeResource(input)) {
    const bytes = captureRegularFile(input, { label: "runtime resource", maxBytes: DEFAULT_MAX_FILE_BYTES }).bytes;
    return encoding === null ? bytes : bytes.toString(encoding);
  }
  currentRuntimePackage();
  const key = location.key(input);
  const encoded = resources.get(key);
  if (encoded === undefined) {
    const error = new Error(`RUNTIME_RESOURCE_UNAVAILABLE: ${key} is outside the fixed package set`);
    error.code = "ENOENT";
    throw error;
  }
  const bytes = Buffer.from(encoded, "base64");
  return encoding === null ? bytes : bytes.toString(encoding);
}

class RuntimeResourceDirectoryEntry {
  constructor(name, directory) {
    this.name = name;
    this.directory = directory;
    Object.freeze(this);
  }
  isDirectory() { return this.directory; }
  isFile() { return !this.directory; }
}

export function listRuntimeResources(input, { withFileTypes = false } = {}) {
  if (!isRuntimeResource(input)) return fs.readdirSync(input, { withFileTypes });
  currentRuntimePackage();
  const prefix = `${location.key(input)}/`;
  const entries = new Map();
  for (const key of resources.keys()) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const [name, child] = rest.split("/");
    entries.set(name, new RuntimeResourceDirectoryEntry(name, child !== undefined));
  }
  return [...entries.values()].map((entry) => withFileTypes ? entry : entry.name);
}

/** Closed owned delivery for one Sennel Node child or worker. No live-source fallback. */
export class RuntimeChildExecution {
  #directory = null;
  #snapshot = null;
  #revision;
  #bootstrapFlag;
  #acknowledged = false;
  #executionStopped = false;
  #ownedExecution = null;
  constructor({ root = process.cwd(), temporaryRoot = null, environment = process.env, storagePolicy = null } = {}) {
    const runtime = currentRuntimePackage();
    const inheritedEnvironment = { ...immutableCommandEnvironment(environment) };
    const nodeOptionsKey = Object.keys(inheritedEnvironment).find((key) => key.toUpperCase() === "NODE_OPTIONS");
    const nodeOptions = nodeOptionsKey === undefined ? "" : inheritedEnvironment[nodeOptionsKey];
    if (nodeOptionsKey !== undefined) delete inheritedEnvironment[nodeOptionsKey];
    this.#revision = runtime.revision;
    if (storagePolicy !== null && !(storagePolicy instanceof ReadOnlyProcessRuntimeStorage)) throw new TypeError("Runtime child storage must be a minted read-only policy");
    const delivery = capturedRuntimeWireDelivery();
    const temporaryPaths = storagePolicy ?? new TemporaryPaths(root);
    this.#directory = temporaryPaths.createOwnedDirectory(temporaryRoot ?? temporaryPaths.runtime("runtime-delivery"), "child-");
    const file = path.join(this.#directory.path, "delivery.json.gz");
    try {
      this.#snapshot = new AtomicFile(file, { directoryAuthority: this.#directory.authority }).write(delivery.compressedBytes(), { exclusive: true }).snapshot;
    } catch (cause) {
      if (cause.cleanupFailed) throw cause;
      try { this.#directory.cleanup(); }
      catch (cleanupError) { throw new AggregateError([cause, cleanupError], "runtime delivery creation and cleanup both failed", { cause }); }
      throw cause;
    }
    const bootstrap = resources.get("src/lib/runtime-child-bootstrap.js");
    const configuration = Buffer.from(JSON.stringify({ file, digest: this.#snapshot.digest,
      byteLength: this.#snapshot.byteLength, decodedByteLength: delivery.decodedByteLength, revision: runtime.revision,
      identity: { dev: String(this.#snapshot.identity.dev), ino: String(this.#snapshot.identity.ino) },
      directoryIdentity: { dev: String(this.#directory.authority.identity.dev), ino: String(this.#directory.authority.identity.ino) },
    })).toString("base64url");
    this.#bootstrapFlag = `--import=data:text/javascript;base64,${bootstrap}#${configuration}`;
    this.environment = immutableCommandEnvironment({ ...inheritedEnvironment,
      NODE_OPTIONS: `${nodeOptions} ${this.#bootstrapFlag}`.trim(),
    });
  }
  static runSync(script, args, options = {}, runCommand = runCmd) {
    const child = new RuntimeChildExecution({ root: options.repositoryRoot || options.cwd || process.cwd(), temporaryRoot: options.temporaryRoot, environment: options.env, storagePolicy: options.storagePolicy });
    let result, failure;
    try { return result = runCommand(process.execPath, [script, ...args], child.options(options), child); }
    catch (cause) { failure = cause; throw cause; }
    finally { child.#closeResult(result ?? failure); }
  }
  static async runAsync(script, args, options = {}, runCommand = runManagedCmdAsync) {
    const child = new RuntimeChildExecution({ root: options.repositoryRoot || options.cwd || process.cwd(), temporaryRoot: options.temporaryRoot, environment: options.env, storagePolicy: options.storagePolicy });
    let result, failure;
    try { return result = await runCommand(process.execPath, [script, ...args], child.options(options), child); }
    catch (cause) { failure = cause; throw cause; }
    finally { child.#closeResult(result ?? failure); }
  }
  #closeResult(result) {
    const receipt = result?.processExecutionStopReceipt;
    if (receipt !== undefined) this.closeAfterExecution(receipt);
    else this.close(); // A rejected runner or lost response is not an exit proof.
  }
  /** Creates and observes the actual unregistered owned Node control handle. */
  spawnNode(script, args = [], options = {}) {
    this.#assertOpen();
    if (this.#ownedExecution !== null) throw new Error("Runtime delivery already belongs to an owned execution");
    const child = spawn(process.execPath, [script, ...args], this.options(options));
    this.#ownedExecution = child;
    let spawned = false;
    child.once("spawn", () => { spawned = true; });
    child.once("error", () => { if (!spawned) this.#executionStopped = true; });
    child.once("exit", () => { this.#executionStopped = true; });
    return child;
  }
  createWorker(script, options = {}) {
    this.#assertOpen();
    if (this.#ownedExecution !== null) throw new Error("Runtime delivery already belongs to an owned execution");
    const worker = new Worker(script, this.workerOptions(options));
    this.#ownedExecution = worker;
    worker.once("exit", () => { this.#executionStopped = true; });
    return worker;
  }
  #assertOpen() {
    if (this.#directory === null) throw new Error("Runtime child delivery is closed");
    this.#directory.authority.assertStable();
  }
  options(options = {}) {
    this.#assertOpen();
    return { ...options, env: this.environment, stdio: options.stdio ?? ["pipe", "pipe", "pipe"] };
  }
  /** Workers must not inherit the parent's test/preload argv or a shared environment. */
  workerOptions(options = {}) {
    this.#assertOpen();
    return { ...options, env: { ...this.environment,
      NODE_OPTIONS: this.environment.NODE_OPTIONS.replace(this.#bootstrapFlag, "").trim() },
    execArgv: [...(options.execArgv ?? []), this.#bootstrapFlag] };
  }
  #readAcknowledgement() {
    const snapshot = captureRegularFile(path.join(this.#directory.path, "acknowledgement.json"), {
      label: "runtime delivery acknowledgement", maxBytes: 4096, requireSingleLink: true,
      directoryAuthority: this.#directory.authority, allowMissing: true,
    });
    if (snapshot === null) return false;
    const ack = JSON.parse(snapshot.text());
    if (ack.revision !== this.#revision || ack.digest !== this.#snapshot.digest) {
      throw new Error("RUNTIME_DELIVERY_ACKNOWLEDGEMENT_INVALID: child acknowledgement differs from its delivery");
    }
    return true;
  }
  /** Nonblocking; works after a blocked parent resumes. Cleans only the minted directory. */
  consumeAcknowledgement() {
    if (this.#acknowledged) return true;
    this.#assertOpen();
    if (!this.#readAcknowledgement()) return false;
    this.close();
    return true;
  }
  /** A premature close retains the payload until its reader acknowledges it. */
  close() { return this.#close(false); }
  /** Registered completion must bind this exact delivery to its actual child. */
  closeAfterExecution(receipt) {
    if (this.#directory === null) return true;
    if (receipt !== undefined) {
      if (!(receipt instanceof ProcessExecutionStopReceipt)) throw new TypeError("Runtime delivery cleanup requires a typed child exit receipt");
      if (!receipt.invocation?.executionIdentity?.matchesRuntimeDelivery(process.execPath, this.#bootstrapFlag)) throw new Error("RUNTIME_DELIVERY_COMPLETION_MISMATCH: exit receipt belongs to another delivery");
      this.#executionStopped = true;
    }
    if (!this.#executionStopped) throw new Error("RUNTIME_DELIVERY_COMPLETION_UNKNOWN: no actual owned child exit or launch failure was observed");
    return this.#close(true);
  }
  #close(executionFinished) {
    if (this.#directory === null) return true;
    const acknowledged = this.#readAcknowledgement();
    // Preserve evidence and foreign content when the delivery name/bytes changed.
    captureRegularFile(this.#snapshot.filePath, { label: "runtime delivery", maxBytes: this.#snapshot.byteLength,
      requireSingleLink: true, directoryAuthority: this.#directory.authority, expectedIdentity: this.#snapshot.identity,
      validateSnapshot: (actual) => {
        if (actual.digest !== this.#snapshot.digest) throw new Error("RUNTIME_DELIVERY_CHANGED: cleanup refused changed delivery bytes");
      },
    });
    if (!acknowledged && !executionFinished && !this.#executionStopped) return false;
    this.#directory.cleanup();
    this.#directory = null;
    this.#acknowledged = acknowledged;
    return true;
  }
}
