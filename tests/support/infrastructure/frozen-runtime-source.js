import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NativeExecutableInvocation } from "../../../src/lib/command-invocation.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

/** Immutable product source only. No runtime state, owner lock or rebasing. */
export function materializeFrozenRuntimeSource(destination, fixtureDirectory, provenanceName) {
  const provenance = JSON.parse(fs.readFileSync(path.join(fixtureDirectory, provenanceName)));
  const compressed = fs.readFileSync(path.join(fixtureDirectory, provenance.asset));
  if (compressed.length !== provenance.bytes || hash(compressed) !== provenance.sha256) throw new Error("Frozen runtime archive differs from provenance");
  const decoded = gunzipSync(compressed, { maxOutputLength: provenance.delivery.decodedByteLength });
  if (decoded.length !== provenance.delivery.decodedByteLength || hash(decoded) !== provenance.delivery.digest) throw new Error("Frozen runtime decoded source differs from provenance");
  const delivery = JSON.parse(decoded);
  if (delivery.identity.revision !== provenance.sourcePackageRevision
    || JSON.stringify(delivery.identity.files) !== JSON.stringify(provenance.files)
    || delivery.resources.length !== provenance.sourceResourceCount) throw new Error("Frozen runtime identity differs from provenance");
  const resources = new Map(delivery.resources);
  if (resources.size !== delivery.resources.length || resources.size !== provenance.files.length) throw new Error("Frozen runtime resource inventory differs");
  fs.mkdirSync(destination, { recursive: false });
  for (const file of provenance.files) {
    new FrozenSourceFile(file, Buffer.from(resources.get(file.key), "base64"),
      key => key === "package.json" || key.startsWith("src/")).writeTo(destination);
  }
  return provenance;
}

export async function runFrozenRuntimeDriver({ nodePath = process.execPath, packageRoot, targetRoot, mainRoot = targetRoot, factsPath, logPath, onSpawn = () => {}, onReady = null, driverName, driverArgs = [] }) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !["NODE_OPTIONS", "SENNEL_PROCESS_EXECUTION_SCOPE", "SENNEL_WORK_ROOT", "SENNEL_SOURCE_ROOT", "SENNEL_RUNTIME_EXPECTED_REVISION"].includes(key.toUpperCase())));
  const log = fs.openSync(logPath, "wx");
  let child;
  let producerExit;
  try {
    const invocation = new NativeExecutableInvocation({ executable: nodePath,
      args: ["--import", pathToFileURL(path.join(packageRoot, "src/sennel.js")).href,
        path.join(here, driverName), packageRoot, targetRoot, factsPath, onReady === null ? "closed" : "hold", mainRoot, ...driverArgs],
      cwd: path.dirname(targetRoot), env: environment, stdio: ["ignore", log, log, ...(onReady === null ? [] : ["ipc"])],
    });
    child = spawn(invocation.executable, invocation.args, { ...invocation.processOptions(), shell: false });
    onSpawn(child.pid);
    let readinessFailure = null;
    child.on("message", async message => {
      if (message.event !== "ready") return;
      try { await onReady(message); } catch (cause) { readinessFailure = cause; }
      finally { child.send({ event: "release" }); }
    });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        producerExit = { pid: child.pid, code, signal };
        if (code === 0 && signal === null) resolve();
        else reject(new Error(`Frozen runtime producer failed: code=${code}, signal=${signal}; log=${logPath}`));
      });
    });
    if (readinessFailure !== null) throw readinessFailure;
  } finally { fs.closeSync(log); }
  return { ...JSON.parse(fs.readFileSync(factsPath)), producerExit };
}

/** A verified immutable source resource, written only into a caller-owned package. */
class FrozenSourceFile {
  #bytes;
  constructor(file, bytes, allowed) {
    if (typeof file.key !== "string" || !allowed(file.key) || file.key.includes("\\")
      || file.key.split("/").some(part => part === ".." || part === "." || part === "")) {
      throw new Error("Frozen source resource key is invalid");
    }
    if (bytes.length !== file.bytes || hash(bytes) !== file.digest) throw new Error(`Frozen source resource differs: ${file.key}`);
    this.key = file.key;
    this.#bytes = Buffer.from(bytes);
  }
  writeTo(destination) {
    const target = path.join(destination, this.key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, this.#bytes, { flag: "wx" });
  }
}

/** Original test support is separate from the frozen product identity. */
export function materializeFrozenProducerSupportSource(destination, fixtureDirectory, provenanceName, sourcePackageRevision) {
  const provenance = JSON.parse(fs.readFileSync(path.join(fixtureDirectory, provenanceName)));
  if (provenance.schemaVersion !== 1 || provenance.sourcePackageRevision !== sourcePackageRevision) {
    throw new Error("Frozen producer support belongs to a different product source");
  }
  for (const file of provenance.files) {
    if (typeof file.asset !== "string" || path.basename(file.asset) !== file.asset || file.asset.includes("\\")) {
      throw new Error("Frozen producer support asset is invalid");
    }
    new FrozenSourceFile(file, fs.readFileSync(path.join(fixtureDirectory, file.asset)),
      key => key.startsWith("tests/support/")).writeTo(destination);
  }
  return provenance;
}
