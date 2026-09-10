import { writeFileSync, chmodSync } from "fs";
import { join } from "path";

/**
 * Write a small Node.js script that echoes a deterministic JSON response on
 * stdout (ignoring any input), and return the config.agent section that
 * references it via the `echo` command pattern used by existing e2e tests.
 *
 * The stub script writes `jsonResponse` to stdout so the Agent layer parses it
 * as the AI evaluation response (`{ evaluations: [...] }`). Because all flow
 * gate tests that reach the AI path need only a fixed pass response, the
 * script is parameterless — callers choose the response by passing it in.
 */
export function writeStubAgentScript(dir, relPath, jsonResponse) {
  const scriptPath = join(dir, relPath);
  const body = [
    "#!/usr/bin/env node",
    `process.stdout.write(${JSON.stringify(jsonResponse)});`,
    "",
  ].join("\n");
  writeFileSync(scriptPath, body);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/**
 * Write a stub agent script that records the prompt (passed via argv) to
 * `capturePath` before emitting `jsonResponse` on stdout. Useful for tests
 * that need to assert the prompt text (e.g. auto-check input source).
 */
export function writeCapturingStubAgentScript(dir, relPath, capturePath, jsonResponse) {
  const scriptPath = join(dir, relPath);
  const body = [
    "#!/usr/bin/env node",
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(capturePath)}, process.argv.slice(2).join('\\n'));`,
    `process.stdout.write(${JSON.stringify(jsonResponse)});`,
    "",
  ].join("\n");
  writeFileSync(scriptPath, body);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/**
 * Write a prompt-routing stub that records only the primary evaluation prompt.
 * Gate tests issue a required guardrail evaluation after the requirement
 * evaluation; that secondary prompt uses a different output schema.
 */
export function writeCapturingGateStubAgentScript(dir, relPath, capturePath, requirementResponse) {
  const scriptPath = join(dir, relPath);
  const body = [
    "#!/usr/bin/env node",
    "const fs = require('fs');",
    "const prompt = process.argv.slice(2).join('\\n');",
    "const guardrailPrompt = prompt.includes('## Guardrail Articles');",
    `if (!guardrailPrompt) fs.writeFileSync(${JSON.stringify(capturePath)}, prompt);`,
    `process.stdout.write(guardrailPrompt ? ${JSON.stringify('{"observations":[]}')} : ${JSON.stringify(requirementResponse)});`,
    "",
  ].join("\n");
  writeFileSync(scriptPath, body);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/**
 * Write a deterministic stub that selects a response from prompt markers.
 * Cases are checked in order; the fallback is emitted when none match.
 */
export function writePromptDispatchStubAgentScript(dir, relPath, cases, fallbackResponse) {
  const scriptPath = join(dir, relPath);
  const routes = cases.map(({ includes, response }) => ({
    includes: String(includes),
    response: String(response),
  }));
  const body = [
    "#!/usr/bin/env node",
    `const routes = ${JSON.stringify(routes)};`,
    `const fallback = ${JSON.stringify(String(fallbackResponse))};`,
    "const prompt = process.argv.slice(2).join('\\n');",
    "const route = routes.find((candidate) => prompt.includes(candidate.includes));",
    "process.stdout.write(route ? route.response : fallback);",
    "",
  ].join("\n");
  writeFileSync(scriptPath, body);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

export function stubAgentConfig(scriptPath) {
  return {
    default: "stub-agent",
    providers: {
      "stub-agent": {
        name: "stub-agent",
        command: "node",
        args: [scriptPath],
      },
    },
  };
}

/**
 * Default PASS response for task-impl requirement evaluation — the spec's
 * fallback REQ-SPEC id (used when no **REQ-XXX** markers exist in spec.md).
 */
export function defaultPassResponse() {
  return JSON.stringify({
    evaluations: [
      { guardrail_id: "REQ-SPEC", result: "pass", reason: "stub pass" },
    ],
  });
}

class SchemaAwareStubProvider {
  enrich(prompt = "", { jsonSchema } = {}) {
    if (jsonSchema?.properties?.entry) {
      const elementId = String(prompt).match(/^elementId:\s*(.+)$/m)?.[1] || "analysis:unknown:0";
      const category = String(prompt).match(/^category:\s*(.+)$/m)?.[1] || "modules";
      const index = Number(String(prompt).match(/^index:\s*(\d+)$/m)?.[1] || 0);
      return JSON.stringify({
        entry: {
          elementId,
          category,
          index,
          summary: `Stub synthesized summary for ${elementId}`,
          detail: `Deterministic synthesized enrichment for ${elementId}.`,
          chapter: "overview",
          role: "other",
          keywords: ["stub", "synthesis", category],
          app: null,
        },
      });
    }
    const chapters = parseAvailableChapters(prompt);
    const entries = parseEnrichTargets(prompt).map(({ elementId, category, index, file }) => ({
      elementId,
      category,
      index,
      summary: `Stub summary for ${file}`,
      detail: `Deterministic CI enrichment for ${file}.`,
      chapter: chapters[0] || "overview",
      role: "other",
      keywords: ["stub", "ci", category],
      app: null,
    }));
    return JSON.stringify(entries.length > 0 ? { entries } : { entries, chapters });
  }

  text(_prompt = "", { jsonSchema } = {}) {
    const keys = Array.isArray(jsonSchema?.required)
      ? jsonSchema.required
      : Object.keys(jsonSchema?.properties || {});
    if (keys.length === 0) return JSON.stringify({ text: "stub text" });
    return JSON.stringify(Object.fromEntries(keys.map((key) => [key, `stub text for ${key}`])));
  }

  init(_prompt = "", { jsonSchema } = {}) {
    const chapters = jsonSchema?.properties?.chapters?.items?.enum;
    return JSON.stringify({ chapters: Array.isArray(chapters) ? chapters : [] });
  }

  quality() {
    return JSON.stringify({ verdict: "pass", evaluations: [] });
  }

  respond(options = {}, prompt = "") {
    if (options.commandId === "docs.enrich") return this.enrich(prompt, options);
    if (options.commandId === "docs.init") return this.init(prompt, options);
    if (options.commandId === "docs.text") return this.text(prompt, options);
    return this.quality();
  }
}

class StubAgent {
  constructor(provider) {
    this.provider = provider;
  }

  resolve() {
    return { provider: "stub" };
  }

  call(prompt, options) {
    return Promise.resolve(this.provider.respond(options, prompt));
  }
}

export function createSchemaAwareStubProvider() {
  return new SchemaAwareStubProvider();
}

export function createStubAgent(provider) {
  return new StubAgent(provider);
}

function parseEnrichTargets(prompt) {
  return [...String(prompt).matchAll(/^### \[([^\]]+)\] entry=([^:]+):(\d+) file=(.+?) range=/gm)].map((match) => ({
    elementId: match[1],
    category: match[2],
    index: Number(match[3]),
    file: match[4],
  }));
}

function parseAvailableChapters(prompt) {
  const section = String(prompt).match(/## Available chapters\s*\n([\s\S]*?)(?=\n## |$)/)?.[1] || "";
  return [...section.matchAll(/^- ([^:\n]+?)(?:: .*)?$/gm)]
    .map((match) => match[1].trim().replace(/\.md$/, ""));
}
