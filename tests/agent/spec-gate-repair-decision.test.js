import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Agent } from "../../src/lib/agent.js";
import { ProviderRegistry } from "../../src/lib/provider.js";
import { Logger } from "../../src/lib/log.js";
import { SpecGateRepairContext } from "../../src/flow/lib/spec-gate-repair-context.js";
import { SpecGateRepairSource } from "../../src/flow/lib/spec-gate-repair-sources.js";
import { applySpecGateRepairOperations, SpecGateRepairAuthority } from "../../src/flow/lib/spec-repair-operations.js";
import { validWorkerHandoffTaskSpec } from "../support/infrastructure/worker-artifact.js";

test("real repair model resolves existing evidence and returns only missing choices to Draft", { timeout: 600_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-repair-decision-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const model = process.env.SENNEL_GATE_QUALITY_MODEL || "gpt-6-luna";
  const config = { agent: { default: "repair-quality", timeout: 240, retryCount: 0,
    providers: { "repair-quality": { command: "codex",
      args: ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-m", model, "{{PROMPT}}"],
      jsonOutputFlag: "--json" } } } };
  const agent = new Agent({ config, paths: { root, agentWorkDir: root },
    registry: new ProviderRegistry(config.agent.providers), logger: new Logger({ logDir: path.join(root, "logs"), enabled: false }) });
  const prompt = fs.readFileSync(new URL("../../src/flow/prompts/plan/spec-gate-repair.md", import.meta.url), "utf8");
  for (const known of [true, false]) {
    const spec = validWorkerHandoffTaskSpec();
    spec.requirements[0].desc = known
      ? "Determine later whether the shared help consumers require regression checks."
      : "Choose the data retention duration later.";
    const baseRevision = `sha256:${"a".repeat(64)}`;
    const finding = { identity: { sourceArtifact: "steps/spec-gate/result.json", sourceStep: "spec-gate",
      sourceFindingId: "unresolved-plan", fingerprint: "b".repeat(64) },
      requirementRef: "complete-plan", observed: "The requirement leaves a decision unresolved.",
      targets: [{ entity: "requirement", id: "R1", field: "desc" }],
      allowedTargets: [{ target: { entity: "requirement", id: "R1", field: "desc" }, operationKinds: ["edit-text-field"] }] };
    const ctx = new SpecGateRepairContext({ spec, baseRevision, findings: [finding],
      guardrails: [{ id: "complete-plan", title: "Complete plan", body: "Resolve the stated decision using the authorized request; never invent a missing user policy." }],
      sources: [new SpecGateRepairSource({ id: "issue", origin: "issue.md", revision: "original-request",
        content: known ? "The user explicitly requires regression checks for every direct shared help renderer consumer. Source investigation confirms docs, core and plugin import the shared renderer. Preserve their command semantics."
          : "Retention is a user policy choice between 30 and 365 days. Both are technically supported. The user has not selected a duration; neither project rules nor source defines a default." })] });
    const selection = ctx.select(ctx.units()[0].id).toJSON();
    fs.writeFileSync(path.join(root, "spec-gate-repair-context.json"), JSON.stringify({ mode: "repair", baseRevision, selections: [selection] }));
    const text = await agent.call(`${prompt}\nRead spec-gate-repair-context.json in the working directory. Return only the JSON response as your final output; do not write files.`,
      { commandId: "flow.spec-gate-repair", executionWorkDir: root, cacheMode: "bypass" });
    const response = JSON.parse(text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
    assert.equal(response.baseRevision, baseRevision);
    if (known) {
      assert.equal(response.stage, "spec-gate-repair", JSON.stringify(response));
      const authority = new SpecGateRepairAuthority({ spec, baseRevision, findings: [finding],
        expectedUnits: [{ findingIdentities: [finding.identity] }] });
      const applied = applySpecGateRepairOperations({ spec, authority, repair: response,
        inputRevision: baseRevision.slice(7) });
      assert.equal(applied.audit.acceptedGroups.length, 1, JSON.stringify({ response, audit: applied.audit }));
      assert.match(applied.spec.requirements[0].desc, /regression/i);
      assert.doesNotMatch(applied.spec.requirements[0].desc, /determine later/i);
    } else {
      assert.equal(response.stage, "spec-gate-repair-draft-return", JSON.stringify(response));
      assert.equal(response.unitId, selection.unit.id);
      for (const field of ["decision", "evidence", "unresolvedBecause"]) assert.equal(typeof response[field], "string");
      assert.match(JSON.stringify(response), /30|365/);
    }
    t.diagnostic(`${model}: ${known ? "existing evidence repaired" : "missing choice returned to Draft"}`);
  }
});
