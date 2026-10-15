import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PRODUCT } from "./product.js";
import { executeWorktreeLocalCli } from "./worktree-cli-execution.js";
import { RuntimePackageSnapshot } from "./runtime-package-snapshot.js";

const PROOF_PREFIX = "sennel:runtime-snapshot/";
let snapshot;
let inheritedBootstrapUrl = null;

export function initialize({ entryPath, argv, cwd, isCli, port, delivery = null, expectedRevision = null, bootstrapUrl = null }) {
  try {
    inheritedBootstrapUrl = bootstrapUrl;
    if (isCli && !(argv[0] === "flow" && argv[1] === "query")) {
      let diagnostic = "";
      const exitCode = executeWorktreeLocalCli({ argv, cwd, writeError: (message) => { diagnostic += message; } });
      if (exitCode !== null) {
        port.postMessage({ exitCode, diagnostic, failed: diagnostic.length > 0 });
        return;
      }
    }
    snapshot = delivery === null
      ? new RuntimePackageSnapshot(path.resolve(path.dirname(entryPath), ".."))
      : RuntimePackageSnapshot.fromDelivery(delivery);
    expectedRevision ??= process.env[PRODUCT.env("RUNTIME_EXPECTED_REVISION")];
    if (expectedRevision && expectedRevision !== snapshot.identity.revision) {
      throw new Error("RUNTIME_REVISION_MISMATCH: child runtime differs from its execution contract");
    }
    port.postMessage({ entryUrl: pathToFileURL(path.join(snapshot.root, "src/cli-main.js")).href });
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

export async function resolve(specifier, context, nextResolve) {
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
  const result = await nextResolve(specifier, context);
  if (result.url.startsWith("file:") && snapshot.owns(fileURLToPath(result.url))) {
    snapshot.read(fileURLToPath(result.url));
    return { ...result, url: fixedUrl(new URL(result.url)) };
  }
  return result;
}

export async function load(url, context, nextLoad) {
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
