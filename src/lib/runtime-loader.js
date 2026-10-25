import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PRODUCT } from "./product.js";
import { resolveWorktreeLocalCli, worktreeCliFailure, worktreeCliSourceAvailable } from "./worktree-cli-execution.js";
import { RuntimePackageSnapshot } from "./runtime-package-snapshot.js";

const PROOF_PREFIX = "sennel:runtime-snapshot/";
const ENTRY_PREFIX = "sennel:runtime-entry/";
let selectedEntryPath = null;
let snapshot;
let inheritedBootstrapUrl = null;

export function initialize({ entryPath, argv, cwd, isCli, port, delivery = null, expectedRevision = null, bootstrapUrl = null,
  capturedEntryPath = null, includeDelivery = false }) {
  try {
    inheritedBootstrapUrl = bootstrapUrl;
    let selected = null;
    if (delivery === null && isCli && !(argv[0] === "flow" && argv[1] === "query")) {
      selected = resolveWorktreeLocalCli({ executionPath: entryPath, argv, cwd });
      if (selected !== null && !worktreeCliSourceAvailable(selected)) {
        port.postMessage({ exitCode: 1, diagnostic: worktreeCliFailure(selected, argv), failed: true });
        return;
      }
    }
    snapshot = delivery === null
      ? new RuntimePackageSnapshot(selected?.worktreeRoot ?? path.resolve(path.dirname(entryPath), ".."))
      : RuntimePackageSnapshot.fromDelivery(delivery);
    selectedEntryPath = selected?.localCliPath ?? capturedEntryPath;
    if (selectedEntryPath !== null) snapshot.read(selectedEntryPath);
    expectedRevision ??= process.env[PRODUCT.env("RUNTIME_EXPECTED_REVISION")];
    if (expectedRevision && expectedRevision !== snapshot.identity.revision) {
      throw new Error("RUNTIME_REVISION_MISMATCH: child runtime differs from its execution contract");
    }
    const captured = includeDelivery ? { delivery: { root: snapshot.root, identity: snapshot.identity.toJSON(), resources: snapshot.resourcePayload() } } : {};
    if (selectedEntryPath !== null) {
      const entry = pathToFileURL(selectedEntryPath);
      entry.searchParams.set("sennel-runtime", snapshot.identity.revision);
      port.postMessage({ ...captured, entryUrl: entry.href, selectedEntryPath, selectedRoot: snapshot.root });
    } else port.postMessage({ ...captured, entryUrl: pathToFileURL(path.join(snapshot.root, "src/cli-main.js")).href });
  } catch (error) {
    port.postMessage({ error: { name: error.name, code: error.code ?? null, message: error.message } });
  } finally {
    port.close();
  }
}

function fixedUrl(url) {
  // Re-importing the preload entry must reuse its completed bootstrap rather
  // than registering another loader or recapturing a changed working tree.
  if (fileURLToPath(url) === path.join(snapshot.root, "src/sennel.js")) return inheritedBootstrapUrl ?? url.href;
  url.searchParams.set("sennel-runtime", snapshot.identity.revision);
  return url.href;
}

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(ENTRY_PREFIX)) {
    const parent = new URL(context.parentURL);
    if (selectedEntryPath === null || specifier !== `${ENTRY_PREFIX}${snapshot.identity.revision}`
      || parent.searchParams.get("sennel-runtime") !== snapshot.identity.revision
      || fileURLToPath(parent) !== selectedEntryPath) throw new Error("RUNTIME_UNPROVEN: local entry context requires its captured source");
    return { url: specifier, shortCircuit: true };
  }
  if (specifier.startsWith(PROOF_PREFIX)) {
    const parent = new URL(context.parentURL);
    if (specifier !== `${PROOF_PREFIX}${snapshot.identity.revision}`
      || parent.searchParams.get("sennel-runtime") !== snapshot.identity.revision
      || fileURLToPath(parent) !== path.join(snapshot.root, "src/lib/runtime-package.js")) {
      throw new Error("RUNTIME_UNPROVEN: runtime proof requires a captured module");
    }
    return { url: specifier, shortCircuit: true };
  }
  let candidate;
  if (specifier.startsWith("file:") || specifier.startsWith(".") || specifier.startsWith("/")) {
    candidate = new URL(specifier, context.parentURL);
  }
  if (candidate?.protocol === "file:" && snapshot.owns(fileURLToPath(candidate))) {
    snapshot.read(fileURLToPath(candidate));
    return { url: fixedUrl(candidate), shortCircuit: true };
  }
  const result = nextResolve(specifier, context);
  return result instanceof Promise ? result.then(resolveCapturedResult) : resolveCapturedResult(result);
}

function resolveCapturedResult(result) {
  if (result.url.startsWith("file:") && snapshot.owns(fileURLToPath(result.url))) {
    snapshot.read(fileURLToPath(result.url));
    return { ...result, url: fixedUrl(new URL(result.url)) };
  }
  return result;
}

export function load(url, context, nextLoad) {
  if (url === `${ENTRY_PREFIX}${snapshot.identity.revision}` && selectedEntryPath !== null) {
    return { format: "module", shortCircuit: true, source: `export default ${JSON.stringify({
      entryUrl: pathToFileURL(path.join(snapshot.root, "src/cli-main.js")).href,
    })};` };
  }
  if (url === `${PROOF_PREFIX}${snapshot.identity.revision}`) {
    return { format: "module", shortCircuit: true, source: `export default ${JSON.stringify({
      root: snapshot.root, identity: snapshot.identity.toJSON(), resources: snapshot.resourcePayload(),
    })};` };
  }
  if (url.startsWith("file:") && snapshot.owns(fileURLToPath(url))) {
    const source = snapshot.read(fileURLToPath(url)).bytes;
    return { format: url.split("?")[0].endsWith(".json") ? "json" : "module", source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
