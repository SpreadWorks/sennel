// Builtin-only transport. The normal loader validates these bytes before
// acknowledging the child runtime; no application module executes in this phase.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as nodeModule from "node:module";
let root;
let resources;
let revision;
export function initialize(delivery) {
  root = delivery.root;
  resources = new Map(delivery.resources);
  revision = delivery.identity.revision;
}
function key(url) {
  if (!url.startsWith("file:")) return null;
  const relative = path.relative(root, fileURLToPath(url)).split(path.sep).join("/");
  return relative === "package.json" || relative.startsWith("src/") ? relative : null;
}
export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("file:") || specifier.startsWith(".") || specifier.startsWith("/")) {
    const url = new URL(specifier, context.parentURL);
    if (key(url.href) !== null) {
      url.searchParams.set("sennel-runtime", revision);
      return { url: url.href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
export function load(url, context, nextLoad) {
  const name = key(url);
  if (name === null) return nextLoad(url, context);
  if (!resources.has(name)) throw new Error(`RUNTIME_RESOURCE_UNAVAILABLE: ${name}`);
  return { format: name.endsWith(".json") ? "json" : "module",
    source: Buffer.from(resources.get(name), "base64"), shortCircuit: true };
}

/** Install the same fixed loader hooks on runtimes supporting in-thread hooks. */
export async function installRuntimeHooks(delivery, { bootstrapUrl = null, capturedEntryPath = null } = {}) {
  initialize(delivery);
  const transport = nodeModule.registerHooks({ resolve, load });
  try {
    const loader = await import(pathToFileURL(path.join(root, "src/lib/runtime-loader.js")));
    let acknowledgement;
    loader.initialize({ delivery, expectedRevision: revision, bootstrapUrl, capturedEntryPath,
      port: { postMessage(message) { acknowledgement = message; }, close() {} } });
    if (acknowledgement.error) {
      const error = new Error(acknowledgement.error.message);
      error.name = acknowledgement.error.name;
      error.code = acknowledgement.error.code;
      throw error;
    }
    nodeModule.registerHooks({ resolve: loader.resolve, load: loader.load });
    return acknowledgement;
  } finally { transport.deregister(); }
}
