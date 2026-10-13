import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { container, initContainer } from "../../../../src/lib/container.js";
import { PromptBatchExecutor, PromptExecutionLimit } from "../../../../src/lib/prompt-batching.js";
import DocsScanCommand from "../../../../src/docs/commands/scan.js";
import DocsEnrichCommand, { prepareDocumentationEnrichment } from "../../../../src/docs/commands/enrich.js";
import { resolveDocsContext } from "../../../../src/docs/lib/docs-context.js";
import { loadFullAnalysis } from "../../../../src/docs/lib/command-context.js";
import { DocumentationEnrichmentResponseContract } from "../../../../src/docs/lib/documentation-enrich-batching.js";
import { createTmpDir, removeTmpDir, writeFile, writeJson } from "../../../support/builders/tmp-dir.js";

const FILE_COUNT = 80;
const SOURCE_PAYLOAD = "0123456789abcdef".repeat(500);
const providerSource = [
  "const fs = require('node:fs'); const crypto = require('node:crypto');",
  "const prompt = process.argv[2] ?? fs.readFileSync(0, 'utf8');",
  "const entries = [...prompt.matchAll(/^### \\[([^\\]]+)\\] entry=([^:]+):(\\d+) file=/gm)].map(match => ({",
  "elementId: match[1], category: match[2], index: Number(match[3]),",
  "summary: `Summary ${match[2]} ${Number(match[3])}.`,",
  "detail: `Detail ${match[2]} ${Number(match[3])}. Source payload remains complete.`,",
  "chapter: 'overview', role: 'lib', keywords: ['source', 'immutable', 'fixture'], app: null }));",
  "if (entries.length === 0) throw new Error('No target identities supplied');",
  "const response = JSON.stringify({ entries });",
  "fs.appendFileSync('provider-calls.jsonl', JSON.stringify({ elementIds: entries.map(entry => entry.elementId),",
  "inputCharacters: prompt.length, responseCharacters: response.length,",
  "promptHash: crypto.createHash('sha256').update(prompt).digest('hex'),",
  "responseHash: crypto.createHash('sha256').update(response).digest('hex'), response }) + '\\n');",
  "process.stdout.write(response);",
].join("\n");

function sourceDigest(root) {
  const hash = createHash("sha256");
  for (const file of fs.readdirSync(path.join(root, "src")).sort()) {
    hash.update(`${file}\0`).update(fs.readFileSync(path.join(root, "src", file)));
  }
  return hash.digest("hex");
}

function copyEvidence(root, name) {
  const destination = process.env.SENNEL_LARGE_ENRICH_EVIDENCE_DIR;
  if (!destination) return;
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(root, path.join(destination, name), { recursive: true, errorOnExist: true, force: false });
}

it("enriches and persists every valid source entry when internal cumulative results exceed one million characters", async (t) => {
  const root = createTmpDir("docs-large-enrichment-");
  const previous = { work: process.env.SENNEL_WORK_ROOT, source: process.env.SENNEL_SOURCE_ROOT };
  t.after(() => {
    container.reset();
    if (previous.work === undefined) delete process.env.SENNEL_WORK_ROOT;
    else process.env.SENNEL_WORK_ROOT = previous.work;
    if (previous.source === undefined) delete process.env.SENNEL_SOURCE_ROOT;
    else process.env.SENNEL_SOURCE_ROOT = previous.source;
    removeTmpDir(root);
  });
  writeJson(root, ".sennel/config.json", {
    lang: "en", type: "sample-node-command", chapters: [{ chapter: "overview.md" }], concurrency: 1,
    scan: { include: ["src/**/*.js"], exclude: [] },
    docs: { languages: ["en"], defaultLanguage: "en", ai: { confirmationThresholdCharacters: 1_000_000 } },
    agent: { default: "fixture", promptCharacterLimit: 120_000, retryCount: 1,
      providers: { fixture: { command: process.execPath, args: ["provider.cjs", "{{PROMPT}}"] } } },
    logs: { enabled: false },
  });
  writeJson(root, "package.json", { name: "immutable-large-enrichment", version: "1.0.0", type: "module" });
  writeFile(root, "provider.cjs", providerSource);
  for (let index = 0; index < FILE_COUNT; index++) {
    const number = String(index).padStart(3, "0");
    writeFile(root, `src/source-${number}.js`, `export const source_${number} = "${SOURCE_PAYLOAD}";\n`);
  }
  process.env.SENNEL_WORK_ROOT = root;
  process.env.SENNEL_SOURCE_ROOT = root;
  container.reset();
  initContainer({ flowAttribution: "none" });
  await new DocsScanCommand().run(container, { _rawArgs: [] });
  const scanned = loadFullAnalysis(root);
  assert.equal(scanned.modules.entries.length, FILE_COUNT);
  assert.equal(scanned.commands.entries.length, FILE_COUNT);
  const digest = sourceDigest(root);
  copyEvidence(root, "seed");

  const context = resolveDocsContext(container, { yes: true }, { commandId: "docs.enrich" });
  const prepared = prepareDocumentationEnrichment(context);
  assert.equal(prepared.pending.length, FILE_COUNT * 2);
  assert.ok(prepared.pending.every(entry => entry.essential.includes(SOURCE_PAYLOAD)), "normal essential extraction preserves each complete exported value");
  await new DocsEnrichCommand().run(container, { _rawArgs: ["--yes"] });

  const calls = fs.readFileSync(path.join(root, "provider-calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(calls.length, prepared.plan.batches.length);
  const defaults = new PromptExecutionLimit();
  const contract = new DocumentationEnrichmentResponseContract();
  const byIdentity = new Map(calls.map(call => [JSON.stringify(call.elementIds), call]));
  const replyFor = batch => {
    const record = byIdentity.get(JSON.stringify(batch.payloadElements.map(element => element.id)));
    assert.ok(record, "every actual provider response corresponds to a selected batch");
    return record.response;
  };
  const typedCharacters = prepared.plan.batches.map(batch => JSON.stringify(contract.parse(replyFor(batch), batch)).length);
  const aggregateCharacters = typedCharacters.reduce((total, count) => total + count, 0);
  assert.ok(aggregateCharacters > 1_000_000);
  assert.ok(typedCharacters.every(count => count < defaults.maxAggregateCharacters));
  assert.ok(calls.every(call => call.inputCharacters <= defaults.maxRequestCharacters));
  assert.ok(calls.every(call => call.responseCharacters < defaults.maxResponseCharacters));
  await assert.rejects(new PromptBatchExecutor().executeCompletions({ plan: prepared.plan,
    callAgent: (_request, batch) => replyFor(batch), responseContract: contract,
  }), error => error.code === "PROMPT_BATCH_EXECUTION_INCOMPLETE" && error.cause.code === "PROMPT_RESPONSE_TOO_LARGE");

  // Recreate the command's container and read the persisted analysis through
  // its production reader; no in-memory enrichment result is carried forward.
  container.reset();
  initContainer({ flowAttribution: "none" });
  const enriched = loadFullAnalysis(root);
  for (const category of ["modules", "commands"]) {
    assert.equal(enriched[category].entries.length, FILE_COUNT);
    for (const [index, entry] of enriched[category].entries.entries()) {
      assert.equal(entry.file, `src/source-${String(index).padStart(3, "0")}.js`);
      assert.equal(entry.summary, `Summary ${category} ${index}.`);
      assert.equal(entry.detail, `Detail ${category} ${index}. Source payload remains complete.`);
      assert.equal(entry.chapter, "overview");
      assert.equal(entry.role, "lib");
      assert.deepEqual(entry.keywords, ["source", "immutable", "fixture"]);
      assert.equal(entry.enrich.attempts, 1);
      assert.ok(entry.enrich.processedAt);
    }
  }
  assert.equal(sourceDigest(root), digest, "enrichment preserves every source byte");
  const reportFiles = fs.readdirSync(path.join(root, ".sennel/output/docs-ai-usage"));
  assert.equal(reportFiles.length, 1);
  const report = JSON.parse(fs.readFileSync(path.join(root, ".sennel/output/docs-ai-usage", reportFiles[0]), "utf8"));
  assert.equal(report.status, "completed");
  assert.equal(report.approvalMethod, "--yes");
  assert.equal(report.providerAttemptCount, calls.length);
  assert.equal(report.retryAttemptCount, 0);
  assert.equal(report.observedAttemptInputCharacters, calls.reduce((total, call) => total + call.inputCharacters, 0));
  assert.equal(report.plannedInputCharacters, report.observedAttemptInputCharacters);
  assert.ok(report.plannedInputCharacters > 1_000_000);
  assert.equal(report.tokens.input_tokens.unknownAttemptCount, calls.length);
  const evidence = { sourceFiles: FILE_COUNT, entries: FILE_COUNT * 2, sourceDigest: digest,
    batches: calls.length, internalAggregateCharacters: aggregateCharacters,
    largestTypedBatchCharacters: Math.max(...typedCharacters),
    inputCharacters: report.observedAttemptInputCharacters,
    largestInputCharacters: Math.max(...calls.map(call => call.inputCharacters)),
    responseCharacters: calls.reduce((total, call) => total + call.responseCharacters, 0),
    largestResponseCharacters: Math.max(...calls.map(call => call.responseCharacters)),
    responseHashes: calls.map(call => call.responseHash), promptHashes: calls.map(call => call.promptHash) };
  t.diagnostic(JSON.stringify(evidence));
  copyEvidence(root, "current");
  if (process.env.SENNEL_LARGE_ENRICH_EVIDENCE_DIR) {
    fs.writeFileSync(path.join(process.env.SENNEL_LARGE_ENRICH_EVIDENCE_DIR, "current-evidence.json"), JSON.stringify(evidence, null, 2));
  }
});
