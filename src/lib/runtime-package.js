import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { RuntimePackageLocation } from "./runtime-package-location.js";
import { RuntimePackageIdentity } from "./runtime-package-identity.js";
import { runCmd, runManagedCmdAsync } from "./process.js";

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

/** Only package-owned resources are pinned; target project inputs stay live. */
export function readRuntimeResource(input, encoding = "utf8") {
  if (!isRuntimeResource(input)) return fs.readFileSync(input, encoding);
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

/** One direct child inherits the active runtime through an unlinked file descriptor. */
export class RuntimeChildExecution {
  #descriptor;
  constructor({ environment = process.env } = {}) {
    const runtime = currentRuntimePackage();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-runtime-child-"));
    const file = path.join(directory, "delivery.json");
    try {
      childDelivery ??= JSON.stringify({ root: location.root, identity: runtime.toJSON(), resources: [...resources] });
      fs.writeFileSync(file, childDelivery, { flag: "wx", mode: 0o600 });
      this.#descriptor = fs.openSync(file, "r");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    const bootstrap = resources.get("src/lib/runtime-child-bootstrap.js");
    this.environment = Object.freeze({ ...environment,
      NODE_OPTIONS: `${environment.NODE_OPTIONS || ""} --import=data:text/javascript;base64,${bootstrap}`.trim(),
    });
  }
  /**
   * Execute one package script using the parent's fixed bytes and runtime root.
   * The target project's cwd/environment stay caller-owned. Each call needs a
   * fresh delivery descriptor because the child consumes its shared file offset.
   */
  static runSync(script, args, options = {}, runCommand = runCmd) {
    const child = new RuntimeChildExecution({ environment: options.env });
    try { return runCommand(process.execPath, [script, ...args], child.options(options)); }
    finally { child.close(); }
  }
  static async runAsync(script, args, options = {}, runCommand = runManagedCmdAsync) {
    const child = new RuntimeChildExecution({ environment: options.env });
    try { return await runCommand(process.execPath, [script, ...args], child.options(options)); }
    finally { child.close(); }
  }
  options(options = {}) {
    if (this.#descriptor === null) throw new Error("Runtime child delivery is closed");
    return { ...options, env: this.environment, stdio: ["pipe", "pipe", "pipe", this.#descriptor] };
  }
  close() {
    if (this.#descriptor !== null) fs.closeSync(this.#descriptor);
    this.#descriptor = null;
  }
}
