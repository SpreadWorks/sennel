import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";

import { PromptLogicalFootprint } from "../../../../src/lib/prompt-batching.js";
import { ArtifactViewService } from "../../../../src/flow/lib/artifact-view-service.js";
import { ArtifactViewLocalizer } from "../../../../src/flow/lib/artifact-view-renderer.js";
import { CanonicalFlowFixture, makeFlowManager } from "../../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../../support/builders/tmp-dir.js";

const SENNEL = path.resolve("src/sennel.js");
const SPECIMEN = path.resolve("specs/6a9b5488-flow-help-contract/001/spec.json");
const SPECIMEN_HASH = "df142f1dd06136fdfe83763037bc53d338d135943844cb533002d42497a238bc";
const LIMIT = 60_000;
const SUMMARY_KINDS = ["purpose", "scope", "constraints", "openQuestions", "requirement", "task"];

function canonicalSnapshot(directory, current = directory, snapshot = new Map()) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(directory, absolute).split(path.sep).join("/");
    if (relative === ".runtime/views" || relative.endsWith("/.runtime/views")) continue;
    if (entry.isDirectory()) canonicalSnapshot(directory, absolute, snapshot);
    else if (entry.isFile()) snapshot.set(relative, fs.readFileSync(absolute));
  }
  return snapshot;
}

function createScenario(t, mode) {
  const directory = createTmpDir("sennel-artifact-original-spec-");
  t.after(() => removeTmpDir(directory));
  const bytes = fs.readFileSync(SPECIMEN);
  assert.equal(bytes.length, 84_467);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SPECIMEN_HASH);
  t.after(() => assert.deepEqual(fs.readFileSync(SPECIMEN), bytes));
  const original = JSON.parse(bytes);
  const flowManager = makeFlowManager(directory);
  const fixture = new CanonicalFlowFixture({ flowManager,
    specId: "6a9b5488-flow-help-contract", runId: "run-original-spec-summary",
    specRecord: { ...original, tasks: [] },
  }).create().addTasks(original.tasks).registerActive();
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.location().specFile, "utf8")), original);
  const config = { lang: "ja", type: "base", docs: { languages: ["ja"], defaultLanguage: "ja" },
    agent: { default: "fixture-summary", promptCharacterLimit: LIMIT,
    providers: { "fixture-summary": { command: process.execPath,
      args: [path.join(directory, "summary-provider.cjs"), "{{PROMPT}}"] } } } };
  fs.writeFileSync(path.join(directory, ".sennel", "config.json"), JSON.stringify(config));
  const full = new ArtifactViewService({ flowManager, config, root: directory }).full({
    logicalKey: "spec.record", activeState: fixture.state(),
  });
  fs.writeFileSync(path.join(directory, "source-units.json"), JSON.stringify(full.fullView.semanticUnits));
  fs.writeFileSync(path.join(directory, "provider-mode"), mode);
  fs.writeFileSync(path.join(directory, "summary-provider.cjs"), providerScript(directory));
  const action = invokeCli(directory, ["next-action"]);
  assert.equal(action.status, 0, action.stderr + action.stdout);
  assert.equal(action.envelope.ok, true);
  const binding = action.envelope.data.binding;
  assert.equal(typeof binding, "string");
  return { directory, fixture, full, config, binding };
}

// Only the external provider is replaced. It returns the exact sections carried
// by the actual request, including any production-selected fragment boundaries.
function providerScript(directory) {
  return `
const fs = require('node:fs');
const path = require('node:path');
const root = ${JSON.stringify(directory)};
const prompt = process.argv[2];
const boundary = prompt.indexOf('\\n\\n');
const fmtFallback = prompt.slice(0, boundary);
const userPrompt = prompt.slice(boundary + 2);
const jsonSchema = JSON.parse(fmtFallback.split('\\n')[1]);
const marker = 'Source sections (JSON):\\n';
const sourceIndex = userPrompt.indexOf(marker);
const units = sourceIndex < 0
  ? JSON.parse(fs.readFileSync(path.join(root, 'source-units.json'), 'utf8')).map(u => ({
      sourceRef: u.id, kind: u.kind, identity: u.identity, excerpt: u.markdown }))
  : JSON.parse(userPrompt.slice(sourceIndex + marker.length));
const response = {};
for (const [property, schema] of Object.entries(jsonSchema.properties)) {
  const item = schema.type === 'array' ? schema.items : schema;
  const refs = item.properties.sourceRefs.items.enum;
  const values = units.filter(u => refs.includes(u.sourceRef)).map(u => {
    const value = {sourceRefs: [u.sourceRef], excerpt: u.excerpt};
    if (item.properties.requirementId) value.requirementId = u.identity;
    if (item.properties.taskId) value.taskId = u.identity;
    return value;
  });
  response[property] = schema.type === 'array' ? values : values[0];
}
const mode = fs.readFileSync(path.join(root, 'provider-mode'), 'utf8');
if (mode === 'disabled') throw new Error('cache hit must not invoke provider');
if (mode === 'malformed') {
  const value = Object.values(response).flat()[0];
  if (value) value.excerpt += 'not source text';
}
fs.appendFileSync(path.join(root, 'provider-calls.jsonl'), JSON.stringify({
  request: {systemPrompt: null, userPrompt, jsonSchema, fmtFallback}, response
}) + '\\n');
process.stdout.write(JSON.stringify(response));
`;
}

function invokeCli(directory, args) {
  const result = spawnSync(process.execPath, [SENNEL, "flow", "get", ...args], {
    cwd: directory, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, SENNEL_WORK_ROOT: directory, SENNEL_SOURCE_ROOT: directory, SENNEL_PROFILE: "" },
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.stdout.trim(), "", result.stderr);
  return { ...result, envelope: JSON.parse(result.stdout) };
}

function invoke(scenario) {
  return invokeCli(scenario.directory, ["artifact", "spec.record", "--mode", "summary",
    "--expect-binding", scenario.binding]);
}

function protectedSnapshot(scenario) {
  return {
    catalog: canonicalSnapshot(path.join(scenario.directory, ".sennel")),
    version: canonicalSnapshot(scenario.fixture.location().directory),
  };
}

function calls(scenario) {
  return fs.readFileSync(path.join(scenario.directory, "provider-calls.jsonl"), "utf8")
    .trim().split("\n").map(line => JSON.parse(line));
}

function expectedMarkdown(scenario) {
  const localizer = new ArtifactViewLocalizer({ config: scenario.config, root: scenario.directory });
  const units = scenario.full.fullView.semanticUnits;
  const excerpts = kind => units.filter(unit => unit.kind === kind).map(unit => unit.markdown).join("");
  return `# ${localizer.message("titleSpec")}\n\n`
    + ["purpose", "scope", "constraints", "openQuestions"].map(excerpts).join("")
    + `## ${localizer.message("requirements")}\n\n` + excerpts("requirement")
    + `## ${localizer.message("tasks")}\n\n` + excerpts("task");
}

it("summarizes the original Spec within 60000 characters and reloads the exact cached view across CLI processes without canonical writes", t => {
  const scenario = createScenario(t, "exact");
  const before = protectedSnapshot(scenario);
  const first = invoke(scenario);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.equal(first.envelope.ok, true);
  assert.equal(first.envelope.data.markdown, expectedMarkdown(scenario));
  assert.deepEqual(protectedSnapshot(scenario), before);
  const recorded = calls(scenario);
  assert.ok(recorded.length > 0);
  for (const call of recorded) assert.ok(PromptLogicalFootprint.measure(call.request).total <= LIMIT);
  const returned = recorded.flatMap(call => Object.values(call.response).flat());
  const sources = scenario.full.fullView.semanticUnits.filter(unit => SUMMARY_KINDS.includes(unit.kind));
  for (const source of sources) {
    const fragments = returned.filter(item => item.sourceRefs[0] === source.id
      || item.sourceRefs[0].startsWith(source.id + "@"));
    assert.ok(fragments.length > 0, source.id);
    assert.equal(fragments.map(item => item.excerpt).join(""), source.markdown);
    for (const item of fragments) {
      if (source.kind === "requirement") assert.equal(item.requirementId, source.identity);
      if (source.kind === "task") assert.equal(item.taskId, source.identity);
    }
  }
  const cache = path.join(scenario.fixture.location().directory, ".runtime", "views", "spec.record.summary.md");
  assert.equal(fs.existsSync(cache), true);
  const saved = fs.readFileSync(cache);
  fs.writeFileSync(path.join(scenario.directory, "provider-mode"), "disabled");
  const reloaded = invoke(scenario);
  assert.equal(reloaded.status, 0, reloaded.stderr + reloaded.stdout);
  assert.equal(reloaded.envelope.ok, true);
  assert.equal(reloaded.envelope.data.markdown, first.envelope.data.markdown);
  assert.deepEqual(fs.readFileSync(cache), saved);
  assert.deepEqual(calls(scenario), recorded);
  assert.deepEqual(protectedSnapshot(scenario), before);
});

it("rejects a changed source excerpt without saving a summary or modifying canonical Flow, Spec, Review, or Gate artifacts", t => {
  const scenario = createScenario(t, "malformed");
  const before = protectedSnapshot(scenario);
  const result = invoke(scenario);
  assert.notEqual(result.status, 0);
  assert.equal(result.envelope.ok, false);
  assert.equal(result.envelope.errors[0].code, "ARTIFACT_VIEW_SUMMARY_INVALID");
  assert.ok(calls(scenario).length > 0);
  assert.equal(fs.existsSync(path.join(scenario.fixture.location().directory,
    ".runtime", "views", "spec.record.summary.md")), false);
  assert.deepEqual(protectedSnapshot(scenario), before);
});
