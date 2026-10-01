import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Agent } from "../../src/lib/agent.js";
import { ProviderRegistry } from "../../src/lib/provider.js";
import { Logger } from "../../src/lib/log.js";
import { ReviewTextPromptPlan } from "../../src/flow/lib/review-text-prompt-plan.js";
import { PromptBatchExecutor } from "../../src/lib/prompt-batching.js";
import { createTmpDir, removeTmpDir } from "../support/builders/tmp-dir.js";

// Expected identity comes from the frozen contract, independently of model output.
const responseSchema = { type: "object", additionalProperties: false, required: ["findingIds"],
  properties: { findingIds: { type: "array", items: { type: "string", enum: ["same-operation-timeout-conflict"] } } } };
const source = [
  "Review the complete planned specification. Return JSON with findingIds only. Report same-operation-timeout-conflict only when normative definitions of the same upload timeout conflict. Do not require executed evidence before implementation. An explicit justification referenced elsewhere resolves a non-testable exception.",
  "HEAD: R1 defines the upload timeout as exactly 10 seconds for every upload. Verification is planned: deterministic timers must reject at exactly 10 seconds and allow completion before it. R2 only renames glossary text and changes no runtime behavior. Non-testable justification: decision D2 at the end.",
  ...Array.from({ length: 150 }, (_, index) => `R${index + 3}: Export field-${index} exactly. Planned verification compares fixture field-${index} byte for byte. Unrelated Unicode metadata: 日本語 \\ escaped \" text 😀.`),
  "TAIL: The normative upload timeout for the same upload operation as R1 is exactly 20 seconds. D2: R2 changes explanatory glossary wording only; it has no runtime effect, output or API change. This document is pre-implementation; executed evidence belongs to later implementation and acceptance stages.",
].join("\n");

test("real reviewer reads complete Unicode authority and detects a head/tail contradiction", { timeout: 600_000 }, async (t) => {
  const root = createTmpDir("review-file-quality-", { parent: fileURLToPath(new URL("../../.tmp/", import.meta.url)) });
  t.after(() => removeTmpDir(root));
  const profile = "review-quality";
  const model = process.env.SENNEL_REVIEW_QUALITY_MODEL || "gpt-6-luna";
  const config = { agent: { default: profile, timeout: 240, retryCount: 0, promptCharacterLimit: 18_000,
    providers: { [profile]: { command: "codex", args: ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-m", model, "{{PROMPT}}"],
      jsonOutputFlag: "--json", jsonSchemaFlag: "--output-schema", jsonSchemaMode: "file" } } } };
  const agent = new Agent({ config, paths: { root, agentWorkDir: root }, registry: new ProviderRegistry(config.agent.providers),
    logger: new Logger({ logDir: path.join(root, "logs"), enabled: false }) });
  const plan = ReviewTextPromptPlan.create({ request: { userPrompt: source, jsonSchema: responseSchema }, maxChars: 6_000, projectRoot: root });
  t.after(() => plan.dispose());
  const parse = (raw) => {
    const value = JSON.parse(raw);
    assert.deepEqual(Object.keys(value), ["findingIds"]);
    assert.ok(Array.isArray(value.findingIds));
    return value.findingIds;
  };
  let calls = 0;
  const completions = await new PromptBatchExecutor().executeCompletions({ plan: plan.corePlan,
    protocolPolicy: plan.protocolPolicy(parse), responseContract: { parse, itemCount: (value) => value.length },
    projectInvocation: (request) => agent.projectInvocation(request.userPrompt, { ...request, executionWorkDir: root }),
    callAgent: async (request, _batch, _retry, attempt, providerCallAdmission) => {
      calls += 1;
      assert.equal(fs.readFileSync(plan.fileInput.filePath, "utf8"), source);
      let cacheDecision;
      const text = await agent.call(request.userPrompt, { ...request, ...attempt, providerCallAdmission, executionWorkDir: root,
        onCacheDecision: (decision) => { cacheDecision = decision; } });
      return { text, ...cacheDecision, fresh: cacheDecision?.fresh ?? attempt.cacheMode === "bypass" };
    } });
  assert.equal(calls, 1);
  assert.deepEqual(completions[0].response, ["same-operation-timeout-conflict"]);
});
