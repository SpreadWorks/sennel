import fs from "node:fs";
import path from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { coreCommandRegistry } from "../../../src/lib/command-registry.js";
import { SourceModule, readTokens } from "../structure/source-reader.js";

export const FLOW_STOP_GUIDANCE_ERROR_OWNER_FILES = Object.freeze([
  "src/flow.js",
  "src/flow-main.js",
  "src/cli-main.js",
  "src/sennel.js",
  "src/lib/dispatcher.js",
  "src/lib/flow-envelope.js",
  "src/lib/flow-cli-failure.js",
  "src/lib/flow-stop-guidance.js",
  "src/lib/agent-failure.js",
  "src/lib/process-execution-values.js",
]);

export const FLOW_STOP_GUIDANCE_DYNAMIC_ERROR_FAMILIES = Object.freeze([
  Object.freeze({
    id: "nested-dispatch-error-code-forwarding",
    source: "src/flow/lib/run-dispatch.js",
    evidence: "error.code ||",
    scope: "Nested command, worker, and recovery failures preserve a selected error code or use the call site's stable fallback.",
  }),
  Object.freeze({
    id: "dispatcher-caught-error-code-forwarding",
    source: "src/lib/dispatcher.js",
    evidence: "err?.code",
    scope: "Dispatcher failures preserve the thrown error's code or use a lifecycle-stage fallback.",
  }),
  Object.freeze({
    id: "query-typed-error-code-forwarding",
    source: "src/flow/query.js",
    evidence: "error.code",
    scope: "The independent query adapter preserves QueryError codes and maps non-query errors to its canonical error code.",
  }),
]);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,}$/;

function walkJavaScript(directory, relativeDirectory = "") {
  return fs.readdirSync(path.join(ROOT, directory, relativeDirectory), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) return walkJavaScript(directory, relative);
      return entry.isFile() && entry.name.endsWith(".js")
        ? [`${directory}/${relative}`]
        : [];
    });
}

function errorCodeLocations(sourcePath) {
  const source = fs.readFileSync(path.join(ROOT, sourcePath), "utf8");
  const tokens = readTokens(source, sourcePath);
  const locations = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "string") continue;
    const inline = token.value.match(/^([A-Z][A-Z0-9_]{2,}):/);
    const candidate = inline?.[1] ?? token.value;
    if (!ERROR_CODE.test(candidate)) continue;

    const before = tokens.slice(Math.max(0, index - 16), index).map((entry) => entry.value);
    const codeProperty = before.at(-1) === ":" && before.at(-2) === "code"
      || before.at(-1) === "=" && before.at(-2) === "code";
    const errorConstructor = before.at(-1) === "(" && before.some((value) => value === "new")
      && before.some((value) => /Error$/.test(value));
    const mapStart = tokens.slice(0, index).findLastIndex((entry) => entry.kind === "identifier"
      && /ERROR_CODES$/.test(entry.value));
    const errorCodeMap = mapStart >= 0 && !tokens.slice(mapStart + 1, index).some((entry) => entry.value === ";");
    const inlineCode = inline !== null;
    const failureCall = before.some((value) => ["fail", "failure", "addFatal", "addWarning"].includes(value))
      && before.includes("(");
    if (!(codeProperty || errorConstructor || errorCodeMap || inlineCode || failureCall)) continue;

    const existing = locations.get(candidate) ?? new Set();
    existing.add(token.line);
    locations.set(candidate, existing);
  }
  return [...locations.keys()].map((code) => ({ code, source: sourcePath }));
}

function registryLeaves(registry, prefix = [], output = []) {
  for (const [name, entry] of Object.entries(registry)) {
    const route = [...prefix, name];
    if (typeof entry?.command === "function") output.push({ route, entry });
    else registryLeaves(entry, route, output);
  }
  return output;
}

function commandModulePath(command) {
  const match = command.toString().match(/import\(\s*(["'])([^"']+)\1\s*\)/);
  if (!match) throw new Error(`Flow registry command does not expose a literal module loader: ${command}`);
  const relative = path.posix.normalize(path.posix.join("src/flow", match[2]));
  const absolute = path.join(ROOT, relative);
  if (!fs.existsSync(absolute)) throw new Error(`Flow command module is missing: ${relative}`);
  return relative;
}

function routeAdapter(route) {
  return route.join(" ") === "query" ? "query-wire" : "dispatcher-envelope";
}

export function deriveFlowStopGuidanceInventory() {
  const firstRouteForCommand = new Map();
  const leaves = registryLeaves(FLOW_COMMANDS).map(({ route, entry }) => {
    const commandPath = ["flow", ...route];
    const definition = coreCommandRegistry.find(commandPath);
    if (!definition?.command || definition.command !== entry.command) {
      throw new Error(`Flow registry leaf is not connected to the production command registry: ${commandPath.join(" ")}`);
    }
    if (definition.outputMode !== "envelope") {
      throw new Error(`Flow registry leaf does not use the envelope output boundary: ${commandPath.join(" ")}`);
    }
    const routePath = commandPath.join(" ");
    const aliasOf = firstRouteForCommand.get(entry.command) ?? null;
    firstRouteForCommand.set(entry.command, aliasOf ?? routePath);
    return {
      path: routePath,
      commandModule: commandModulePath(entry.command),
      adapter: routeAdapter(route),
      ...(aliasOf === null ? {} : { aliasOf }),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));

  const sources = [...new Set([
    ...walkJavaScript("src/flow"),
    ...FLOW_STOP_GUIDANCE_ERROR_OWNER_FILES,
  ])].sort();
  const codeSources = new Map();
  for (const location of sources.flatMap(errorCodeLocations)) {
    const codeOwners = codeSources.get(location.code) ?? new Set();
    codeOwners.add(location.source);
    codeSources.set(location.code, codeOwners);
  }
  const errorCodes = [...codeSources].map(([code, owners]) => ({
    code,
    sources: [...owners].sort(),
  })).sort((left, right) => left.code.localeCompare(right.code));

  return {
    schemaVersion: 1,
    registry: "src/flow/registry.js#FLOW_COMMANDS",
    routes: leaves,
    errorCodeInventory: {
      sourceScope: ["all JavaScript under src/flow/", ...FLOW_STOP_GUIDANCE_ERROR_OWNER_FILES],
      literalCodes: errorCodes,
      dynamicFamilies: FLOW_STOP_GUIDANCE_DYNAMIC_ERROR_FAMILIES,
      completenessNote: "Literal code extraction is lexical evidence only. Dynamic forwarding, generated codes, and paths without a recognizable literal are represented by the declared dynamic families and are not claimed complete by this scan.",
    },
    adapters: {
      "dispatcher-envelope": {
        router: "src/flow-main.js#run",
        producer: "src/lib/flow-envelope.js#Envelope.attachStopGuidance",
        boundary: "src/lib/dispatcher.js#DispatchPublication",
        output: "src/lib/dispatcher.js#dispatch",
      },
      "query-wire": {
        router: "src/cli-main.js#bootstrapFlowQueryCli and src/flow-main.js#bootstrapFlowQueryCli",
        producer: "src/lib/flow-stop-guidance.js#buildFlowStopGuidance",
        boundary: "src/flow/query.js#serializeQueryResponse",
        output: "src/flow/query.js#runFlowQueryCli",
      },
    },
    bootstrap: {
      route: "flow bootstrap failures before semantic modules are available",
      fixedRuntimeProducer: "src/sennel.js#bootstrapFailure",
      semanticProducer: "src/lib/flow-cli-failure.js#flowCliFailure",
      output: "src/sennel.js#writeSync(JSON.stringify(bootstrapFailure()))",
      queryProjection: "schemaRevision 3 query response with top-level guidance",
    },
  };
}

export function assertFlowStopGuidanceAdapters(inventory) {
  const module = (relative) => new SourceModule(relative,
    fs.readFileSync(path.join(ROOT, relative), "utf8"), { lexicalOnly: true });
  const dependencies = (relative) => module(relative).references
    .filter((reference) => reference.specifier.startsWith("."))
    .map((reference) => path.posix.normalize(path.posix.join(path.posix.dirname(relative), reference.specifier)));
  // Check module ownership without asserting private helper names, expression
  // spelling, or incidental finalizer order. Runtime tests exercise publication
  // order and the actual dispatch/StepAttempt producer connections.
  for (const [from, to] of [
    ["src/flow-main.js", "src/lib/dispatcher.js"],
    ["src/flow-main.js", "src/flow/query.js"],
    ["src/cli-main.js", "src/flow/query.js"],
    ["src/lib/dispatcher.js", "src/lib/flow-envelope.js"],
    ["src/lib/flow-envelope.js", "src/lib/flow-stop-guidance.js"],
    ["src/flow/query.js", "src/lib/flow-stop-guidance.js"],
    ["src/flow-main.js", "src/lib/flow-cli-failure.js"],
    ["src/cli-main.js", "src/lib/flow-cli-failure.js"],
    ["src/lib/flow-cli-failure.js", "src/lib/flow-envelope.js"],
  ]) {
    if (!dependencies(from).includes(to)) throw new Error(`Flow output adapter is disconnected: ${from} -> ${to}`);
  }
  for (const relative of ["src/sennel.js", "src/flow.js"]) {
    if (module(relative).references.some((reference) => reference.kind === "import"
      && !reference.specifier.startsWith("node:"))) {
      throw new Error(`Pre-semantic bootstrap imported a non-builtin module: ${relative}`);
    }
  }
  for (const family of inventory.errorCodeInventory.dynamicFamilies) {
    const owner = fs.readFileSync(path.join(ROOT, family.source), "utf8");
    if (!owner.includes(family.evidence)) throw new Error(`Dynamic error-code family evidence moved: ${family.id}`);
  }
  for (const route of inventory.routes) {
    if (!Object.hasOwn(inventory.adapters, route.adapter)) throw new Error(`Flow route has no declared output adapter: ${route.path}`);
  }
  return true;
}
