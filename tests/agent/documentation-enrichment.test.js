import assert from "node:assert/strict";
import path from "node:path";
import { it } from "node:test";
import { Agent } from "../../src/lib/agent.js";
import { Logger } from "../../src/lib/log.js";
import { ProviderRegistry } from "../../src/lib/provider.js";
import { DocumentationAgent } from "../../src/docs/lib/documentation-agent.js";
import {
  DocumentationEnrichPromptEnvelope, DocumentationEnrichmentResponseContract,
  reduceDocumentationEnrichment,
} from "../../src/docs/lib/documentation-enrich-batching.js";
import { DocumentationAnalysisPromptElement, documentationSourceRevision } from "../../src/docs/lib/prompt-elements.js";
import {
  LinearPromptBatchTopology, PromptBatchExecutor, PromptBatchPlan,
  PromptInputBuilder, PromptRequestLimit,
} from "../../src/lib/prompt-batching.js";
import { createTmpDir, removeTmpDir } from "../support/builders/tmp-dir.js";
import { initGitRepo } from "../support/infrastructure/git-repo.js";

it("real provider preserves enrichment range identities through canonical synthesis", { timeout: 240000 }, async (t) => {
  const root = createTmpDir();
  t.after(() => removeTmpDir(root));
  initGitRepo(root);
  const agent = new DocumentationAgent(new Agent({
    config: { agent: {
      useProfile: process.env.SENNEL_AGENT_TEST_PROFILE || "codex-only",
      timeout: 90, retryCount: 0,
    } },
    paths: { root, agentWorkDir: path.join(root, ".tmp") },
    registry: new ProviderRegistry(),
    logger: new Logger({ logDir: path.join(root, ".tmp", "logs"), enabled: false }),
  }));
  const first = "export function add(a, b) { return a + b; }\n";
  const source = `${first}${"// Arithmetic helpers.\n".repeat(300)}export function subtract(a, b) { return a - b; }\n`;
  const element = new DocumentationAnalysisPromptElement({
    id: "analysis:modules:297", category: "modules", index: 297,
    sourceRevision: documentationSourceRevision(source), sequence: 0,
    file: "arithmetic.js", text: source,
  });
  const envelope = new DocumentationEnrichPromptEnvelope({ chapters: ["overview.md"] });
  const limit = new PromptRequestLimit({ maxCharacters: 6500 });
  const builder = new PromptInputBuilder({ envelope, limit });
  builder.add(element);
  const plan = PromptBatchPlan.create({ collection: builder.build(), envelope, limit, topology: new LinearPromptBatchTopology() });
  const ranges = plan.batches.flatMap((batch) => batch.payloadElements);
  assert.ok(ranges.length > 1);
  assert.equal(ranges.map((range) => range.text).join(""), source);
  const executor = new PromptBatchExecutor();
  const callOptions = (request) => ({ commandId: "docs.enrich", systemPrompt: request.systemPrompt,
    jsonSchema: request.jsonSchema, fmtFallback: request.fmtFallback });
  const completions = await executor.executeCompletions({ plan,
    responseContract: new DocumentationEnrichmentResponseContract(),
    callAgent: (request, _batch, _retry, _context, providerCallAdmission) => agent.call(request.userPrompt, {
      ...callOptions(request), providerCallAdmission,
    }),
  });
  assert.deepEqual(completions.flatMap((completion) => completion.response.map((result) => result.value.elementId)), ranges.map((range) => range.id));
  const result = await reduceDocumentationEnrichment({ completions, agent, executor, limit, lang: "en", callOptions });
  assert.deepEqual(Object.keys(result), ["modules"]);
  assert.equal(result.modules.length, 1);
  assert.equal(result.modules[0].index, 297);
  assert.ok(result.modules[0].summary.trim().length > 0);
  assert.ok(result.modules[0].detail.trim().length > 0);
});
