import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildDraftReviewArtifact, buildDraftReviewPrompt, parseProposals } from "../../src/flow/commands/review.js";
import { Agent } from "../../src/lib/agent.js";
import { Logger } from "../../src/lib/log.js";
import { ProviderRegistry } from "../../src/lib/provider.js";
import { createTmpDir, removeTmpDir } from "../support/builders/tmp-dir.js";
import { canonicalDraftDocument } from "../support/infrastructure/flow-setup.js";

test("real Draft question reviewer resolves supplied authority and preserves an unresolved user choice", { timeout: 300_000 }, async (t) => {
  const root = createTmpDir("draft-question-context-quality-");
  t.after(() => removeTmpDir(root));
  const model = process.env.SENNEL_REVIEW_QUALITY_MODEL || "gpt-6-luna";
  const profile = "draft-question-quality";
  const config = { agent: { default: profile, timeout: 240, retryCount: 0,
    providers: { [profile]: { command: "codex",
      args: ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-m", model, "{{PROMPT}}"],
      jsonOutputFlag: "--json" } } } };
  const agent = new Agent({ config, paths: { root, agentWorkDir: root },
    registry: new ProviderRegistry(config.agent.providers),
    logger: new Logger({ logDir: path.join(root, "logs"), enabled: false }) });
  const questions = [
    "Should existing exit codes be preserved?",
    "Should export errors be written to stderr?",
    "Should omitted output format preserve the existing structured response?",
    "Should progress reporting remain disabled unless --progress is enabled?",
    "Should exported records be retained for 30 days or 90 days?",
  ];
  const draft = canonicalDraftDocument({ goal: "Add optional export progress and choose a retention policy.",
    questions: questions.map((question, index) => ({
      id: `q${index + 1}`, state: "CandidateQuestion", category: "user-visible-behavior", question,
      revision: 0, provenance: { producer: "draft" }, evidenceDigest: "a".repeat(64),
    })) });
  // The derived map deliberately claims all five questions require a user.
  // The independent authorities resolve q1-q4; only q5 remains a user choice.
  const request = "Add optional export progress and a retention policy. Preserve existing exit codes. The retention period is still undecided.";
  const context = [
    { file: "AGENTS.md", summary: "Project rule: every CLI error is written to stderr; stdout is reserved for data." },
    { file: "src/response-format.js", summary: "The existing CLI preserves structured JSON output when no format is requested." },
    { file: "docs/export.md", summary: "The documented progress behavior is disabled by default and enabled only with --progress. No retention period is specified." },
  ];
  const prompt = buildDraftReviewPrompt(draft, request, context, { key: "questions" });
  const report = { version: 1, model, expectedRepairTargets: ["q1", "q2", "q3", "q4"],
    retainedUserQuestion: "q5", promptDigest: createHash("sha256").update(prompt).digest("hex"), prompt };
  try {
    const raw = await agent.call(prompt, { commandId: "flow.draft.review.questions.propose",
      executionWorkDir: root, cacheMode: "bypass" });
    report.response = raw;
    const bytes = Buffer.from(JSON.stringify(draft));
    const artifact = buildDraftReviewArtifact({ draftPath: "draft.json", draftRevision: {
      version: 1, runId: "run-draft-question-quality", specId: "draft-question-quality", sourceStepId: "draft",
      digest: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length,
      finalizedAt: "2026-10-11T00:00:00.000Z",
    }, proposals: parseProposals(raw), stage: { retryPhase: "draft-questions", findingClassification: "repair_target" } }).toJSON();
    report.artifact = artifact;
    assert.equal(artifact.verdict, "ADVISORY", raw);
    assert.deepEqual(artifact.blockingFindings, [], raw);
    assert.deepEqual(artifact.advisoryFindings, [], raw);
    assert.deepEqual(artifact.repairTargets.map((finding) => finding.target).sort(), report.expectedRepairTargets, raw);
    report.result = "passed";
  } finally {
    if (process.env.SENNEL_DRAFT_QUESTION_REVIEW_EVIDENCE) {
      fs.writeFileSync(process.env.SENNEL_DRAFT_QUESTION_REVIEW_EVIDENCE, `${JSON.stringify(report, null, 2)}\n`);
    }
  }
});
