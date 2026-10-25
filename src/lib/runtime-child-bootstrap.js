// This source is supplied by the active parent's fixed runtime as a data URL.
// It must import only Node builtins: even the on-disk bootstrap may have changed.
import * as nodeModule from "node:module";
import { MessageChannel } from "node:worker_threads";
import { readSync, closeSync, openSync, lstatSync, fstatSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
const configuration = JSON.parse(Buffer.from(new URL(import.meta.url).hash.slice(1), "base64url"));
// This is the minimal builtin-only trust boundary: package captureRegularFile is
// unavailable until the bytes containing that implementation have been verified.
const sameIdentity = (stat, expected) => String(stat.dev) === String(expected.dev) && String(stat.ino) === String(expected.ino);
const checkFile = (stat) => {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
    || stat.size !== BigInt(configuration.byteLength) || !sameIdentity(stat, configuration.identity)) {
    throw new Error("RUNTIME_DELIVERY_INVALID: inherited delivery file changed");
  }
};
const directory = path.dirname(configuration.file);
const directoryStat = lstatSync(directory, { bigint: true });
if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
  || !sameIdentity(directoryStat, configuration.directoryIdentity) || realpathSync(configuration.file) !== configuration.file) {
  throw new Error("RUNTIME_DELIVERY_INVALID: inherited delivery directory changed");
}
checkFile(lstatSync(configuration.file, { bigint: true }));
const descriptor = openSync(configuration.file, "r");
let bytes;
try {
  checkFile(fstatSync(descriptor, { bigint: true }));
  bytes = Buffer.alloc(configuration.byteLength + 1);
  let length = 0;
  while (length < bytes.length) {
    const count = readSync(descriptor, bytes, length, bytes.length - length, length);
    if (count === 0) break;
    length += count;
  }
  bytes = bytes.subarray(0, length);
  checkFile(fstatSync(descriptor, { bigint: true }));
  checkFile(lstatSync(configuration.file, { bigint: true }));
} finally { closeSync(descriptor); }
if (bytes.length !== configuration.byteLength || createHash("sha256").update(bytes).digest("hex") !== configuration.digest) {
  throw new Error("RUNTIME_DELIVERY_DIGEST_MISMATCH: inherited delivery bytes differ from the parent proof");
}
const delivery = JSON.parse(bytes);
if (delivery.identity.revision !== configuration.revision) {
  throw new Error("RUNTIME_REVISION_MISMATCH: inherited runtime differs from its execution contract");
}
const flag = `--import=${import.meta.url}`;
process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || "").replace(flag, "").trim();
const transportSource = new Map(delivery.resources).get("src/lib/runtime-bootstrap-loader.js");
if (!transportSource) throw new Error("RUNTIME_UNPROVEN: child transport loader is unavailable");
if (typeof nodeModule.registerHooks === "function") {
  const transport = await import(`data:text/javascript;base64,${transportSource}`);
  await transport.installRuntimeHooks(delivery, { bootstrapUrl: import.meta.url });
} else {
  nodeModule.register(`data:text/javascript;base64,${transportSource}`, { parentURL: import.meta.url, data: delivery });
  const { port1, port2 } = new MessageChannel();
  const acknowledged = new Promise((resolve, reject) => {
    port1.once("message", (message) => {
      port1.close();
      if (message.error) {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        error.code = message.error.code;
        reject(error);
      } else resolve(message);
    });
  });
  try {
    nodeModule.register(pathToFileURL(path.join(delivery.root, "src/lib/runtime-loader.js")), {
      parentURL: import.meta.url,
      data: { delivery, expectedRevision: configuration.revision, bootstrapUrl: import.meta.url, port: port2 }, transferList: [port2],
    });
    await acknowledged;
  } finally { port1.close(); port2.close(); }
}

// Package code is now verified and pinned. Reuse the common writer for the
// acknowledgement; the receiving parent retains the cleanup capability.
const { AtomicFile } = await import(pathToFileURL(path.join(delivery.root, "src/lib/atomic-file.js")));
const { RealDirectoryAuthority } = await import(pathToFileURL(path.join(delivery.root, "src/lib/real-directory-authority.js")));
const authority = new RealDirectoryAuthority(directory);
if (!sameIdentity(authority.identity, configuration.directoryIdentity)) {
  throw new Error("RUNTIME_DELIVERY_INVALID: acknowledgement directory changed");
}
new AtomicFile(path.join(directory, "acknowledgement.json"), { directoryAuthority: authority }).write(
  JSON.stringify({ revision: configuration.revision, digest: configuration.digest }), { exclusive: true });

// The main CLI entry is mapped back to this completed preload to prevent a
// second capture. Dispatch its first invocation here after the fixed loader
// is ready; importing sennel.js from another entry remains side-effect free.
const cliEntry = path.join(delivery.root, "src/sennel.js");
const requestedEntry = process.argv[1] == null ? null : path.resolve(process.argv[1]);
let canonicalEntry = requestedEntry;
if (requestedEntry !== null && requestedEntry !== cliEntry) {
  try { canonicalEntry = realpathSync(requestedEntry); }
  catch { /* Loader resolution remains authoritative for other entry modules. */ }
}
if (canonicalEntry === cliEntry) await import(pathToFileURL(path.join(delivery.root, "src/cli-main.js")));
