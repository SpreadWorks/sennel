// Loader-thread transport only. The normal loader validates these bytes before
// acknowledging the child runtime; no application module executes in this phase.
import path from "node:path";
import { fileURLToPath } from "node:url";
let root;
let resources;
export function initialize(delivery) {
  root = delivery.root;
  resources = new Map(delivery.resources);
}
function key(url) {
  if (!url.startsWith("file:")) return null;
  const relative = path.relative(root, fileURLToPath(url)).split(path.sep).join("/");
  return relative === "package.json" || relative.startsWith("src/") ? relative : null;
}
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("file:") || specifier.startsWith(".") || specifier.startsWith("/")) {
    const url = new URL(specifier, context.parentURL).href;
    if (key(url) !== null) return { url, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  const name = key(url);
  if (name === null) return nextLoad(url, context);
  if (!resources.has(name)) throw new Error(`RUNTIME_RESOURCE_UNAVAILABLE: ${name}`);
  return { format: name.endsWith(".json") ? "json" : "module",
    source: Buffer.from(resources.get(name), "base64"), shortCircuit: true };
}
