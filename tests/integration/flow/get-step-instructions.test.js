/**
 * tests/integration/flow/get-step-instructions.test.js
 *
 * Contract tests for getStepInstructions(instructionsKey) loader (spec 203 / cac6/T6).
 *
 * The loader resolves a registered instructions_key (from
 * src/flow/schemas/context-rules.json) to the markdown content stored at
 * src/flow/prompts/<phase>/<step>.md.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { getStepInstructions } from "../../../src/flow/lib/get-step-instructions.js";

const PKG_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../../src");
const PROMPTS_DIR = path.join(PKG_DIR, "flow", "prompts");
const INCLUDE_DIRECTIVE_PATTERN = /<!--\s*include\("[^"]+"\)\s*-->/;

describe("getStepInstructions (loader contract)", () => {
  describe("happy path", () => {
    it("returns non-empty string content for a known key", () => {
      // plan.draft is a registered instructions_key in context-rules.json.
      const content = getStepInstructions("plan.draft");
      assert.equal(typeof content, "string");
      assert.ok(content.length > 0, "content is non-empty");
    });

    it("returns content for keys in both flow and task scopes", () => {
      const flowContent = getStepInstructions("plan.spec");
      assert.ok(flowContent.length > 0, "flow-scope key resolves");

      const taskContent = getStepInstructions("task.task-impl");
      assert.ok(taskContent.length > 0, "task-scope key resolves");
    });

    it("returns expanded prompt content (not just a placeholder)", () => {
      const expandedPrompt = getStepInstructions("plan.draft");
      const filePath = path.join(PROMPTS_DIR, "plan", "draft.md");
      const rawPrompt = fs.readFileSync(filePath, "utf8");
      assert.match(rawPrompt, INCLUDE_DIRECTIVE_PATTERN);
      assert.match(expandedPrompt, /## Draft Question Ledger Rules/);
      assert.doesNotMatch(expandedPrompt, INCLUDE_DIRECTIVE_PATTERN);
    });

    it("keeps dispatcher-owned plan workers on immutable handoff inputs and parent completion", () => {
      const keys = [
        "plan.draft",
        "plan.draft-questions-triage",
        "plan.draft-questions-repair",
        "plan.draft-refine",
        "plan.draft-coverage-triage",
        "plan.draft-coverage-repair",
        "plan.spec",
        "plan.spec-triage",
        "plan.spec-repair",
        "plan.test",
      ];
      for (const key of keys) {
        const content = getStepInstructions(key);
        assert.match(content, /worker artifact handoff contract as the complete authority/, key);
        assert.match(content, /exact `payloads\[\]\.payloadPath`/, key);
        assert.match(content, /exact (?:handoff )?`sealCommand` once/, key);
        assert.doesNotMatch(content, /sennel flow set step .* done/, key);
      }
    });

    it("keeps changed-file authority with the parent for every source worker", () => {
      for (const key of [
        "impl.implement",
        "impl.impl-triage",
        "impl.impl-repair",
        "task.task-impl",
        "task.task-triage",
        "task.task-repair",
      ]) {
        const content = getStepInstructions(key);
        assert.match(content, /do not generate a mutation manifest, report a changed-file list, or run a seal command/, key);
        assert.match(content, /parent captures the immutable Attempt manifest and maps every observed mutation to every canonical Requirement/, key);
      }
    });

    it("spec-triage emits a bounded V2 classification delta for canonical findings", () => {
      const content = getStepInstructions("plan.spec-triage");

      assert.match(content, /immutable `spec\.json` snapshot and the one canonical `review\.json` only from `inputs\[\]\.document`/);
      assert.match(content, /Write one delta, and only one delta, to the exact handoff `payloadPath`/);
      assert.match(content, /`version: 2`, `stage: "spec-triage"`, the exact immutable `identity`, and `findings\[\]`/);
      assert.doesNotMatch(content, /specs\/<spec-id>/);
      assert.doesNotMatch(content, /active Flow's configured spec directory/);
      assert.doesNotMatch(content, /sennel flow set step spec-triage done/);
      assert.match(content, /run the exact handoff `sealCommand` once/);
      assert.match(content, /Never edit canonical files/);
      assert.match(content, /one stable `findingId`, a disposition \(`apply`, `invalid`, `already_resolved`, or `downgraded_to_non_blocking`\), evidence/);
      assert.match(content, /Classify only findings supplied in the immutable canonical review/);
      assert.match(content, /Do not require a finding to be classified, do not invent findings, and do not remove unhandled findings/);
      assert.match(content, /permissions are explicit `\{ target, operationKinds \}` capabilities/);
      assert.match(content, /valid empty delta is a semantic no-op and the Flow continues/);
      assert.doesNotMatch(content, /spec-triage\.json/);
    });

    it("spec-repair emits only immutable-input-bound V2 operations", () => {
      const content = getStepInstructions("plan.spec-repair");

      assert.match(content, /immutable `spec\.json` snapshot and the one canonical `review\.json` only from `inputs\[\]\.document`/);
      assert.match(content, /Write only `review\.delta\.json`, one immutable-input-bound delta, to the exact handoff `payloadPath`/);
      assert.match(content, /Never edit `spec\.json`, `review\.json`, or any canonical Flow file/);
      assert.doesNotMatch(content, /specs\/<spec-id>/);
      assert.doesNotMatch(content, /active Flow's configured spec directory/);
      assert.doesNotMatch(content, /sennel flow set step spec-repair done/);
      assert.match(content, /run the exact handoff `sealCommand` once/);
      assert.match(content, /`version: 2`, `stage: "spec-repair"`, the exact immutable `identity` copied from `review\.json`/);
      assert.match(content, /`baseReviewDigest` copied from the `digest` of the handoff `inputs\[\]` entry named `review\.json`, `findings: \[\]`/);
      assert.match(content, /non-empty unique `findingIds`/);
      assert.match(content, /canonical stable ascending order/);
      assert.match(content, /explicit canonical `apply` permission for that target and kind/);
      assert.match(content, /`review\.delta\.json`/);
      assert.match(content, /Valid operations may be partial/);
      assert.match(content, /empty operation list is a semantic no-op and the Flow continues/);
      assert.match(content, /Do not reclassify findings or widen scope/);
      assert.doesNotMatch(content, /spec-repair\.json/);
      assert.doesNotMatch(content, /requiredTargets/);
    });

    it("draft repair prompts request operation proposals, never a replacement draft", () => {
      for (const key of ["plan.draft-questions-repair", "plan.draft-coverage-repair"]) {
        const content = getStepInstructions(key);
        assert.match(content, /Write only `draft-(?:questions|coverage)-repair\.json`/);
        assert.match(content, /never write `draft\.json`/);
        assert.match(content, /`replace-value`/);
        assert.match(content, /`allowedFieldPaths`/);
        assert.match(content, /ignore(?:s|d) and audit(?:s|ed)/i);
        assert.match(content, /draft schema has no approval field/i);
      }
    });

    it("keeps coverage review and repair responsibilities separate", () => {
      const content = getStepInstructions("plan.draft-coverage-review");
      assert.match(content, /parent publishes the derived draft/);
      assert.match(content, /draft-gate.*strict structural validation/);
      assert.doesNotMatch(content, /draft-coverage-repair.*responsible for setting draft approval/);
    });

    it("spec-repair prompt preserves V2 operation and immutable-base array semantics", () => {
      const content = getStepInstructions("plan.spec-repair");

      assert.match(content, /`version: 2`, `stage: "spec-repair"`/);
      assert.match(content, /structured `target`, `kind`, `expectedDigest`/);
      assert.match(content, /findingIds/);
      assert.match(content, /replace-field/);
      assert.match(content, /replace-entity-field/);
      assert.match(content, /add-array-element/);
      assert.match(content, /replace-array-element/);
      assert.match(content, /delete-array-element/);
      assert.match(content, /replacement/);
      assert.match(content, /position/);
      assert.match(content, /immutable-base `position`/);
      assert.match(content, /`findings: \[\]`/);
      assert.match(content, /`baseReviewDigest`/);
      assert.doesNotMatch(content, /"version": 1/);
    });

    it("spec-review prompt rejects retired post-hook and semantic retry language", () => {
      const content = getStepInstructions("plan.spec-review");
      assert.match(content, /Parent confirmation advances a valid delta/);
      assert.match(content, /malformed JSON.*missing or unreadable handoff.*at most one fresh worker invocation/i);
      assert.match(content, /There is no semantic completeness retry/);
      assert.doesNotMatch(content, /CLI post-hook/);
      assert.doesNotMatch(content, /retry reset/);
      assert.doesNotMatch(content, /semantic review limit/);
    });

    it("spec funnel worker prompts share the bounded transport retry contract", () => {
      for (const key of ["plan.spec-review", "plan.spec-triage", "plan.spec-repair"]) {
        const content = getStepInstructions(key);
        assert.match(content, /malformed JSON.*missing or unreadable handoff.*(?:at most one fresh worker invocation|retryable once with a fresh worker invocation)/i, key);
        if (key === "plan.spec-review") {
          assert.match(content, /schema, identity, authority, and atomic-publication failures are terminal/i, key);
        } else {
          assert.match(content, /payload-format\/schema failure.*retryable (?:once|with at most one)/i, key);
          assert.match(content, /identity\/revision binding, authority, lineage, and atomic-publication failures are terminal/i, key);
        }
      }
    });

    it("spec gate instructions keep gate fixes separate from design review", () => {
      const content = getStepInstructions("plan.spec-gate");

      assert.match(content, /readiness gate, not a design review/);
      assert.match(content, /Fix only schema\/static issues, spec-triage \/ spec-repair audit issues, and explicit guardrail article violations/);
      assert.match(content, /Do not use gate FAIL as a reason to search for new design gaps/);
      assert.match(content, /Codebase-context design gaps belong to `spec-review` \/ `spec-triage` \/ `spec-repair`/);
    });

    it("requires typed finding disposition policy in flow and task implementation review", () => {
      for (const key of ["impl.impl-review", "task.task-review"]) {
        const content = getStepInstructions(key);

        assert.match(content, /typed disposition/i, key);
        assert.match(content, /rationale/i, key);
        assert.match(content, /must[- ]fix/i, key);
        assert.match(content, /requirement.*guardrail|guardrail.*requirement/i, key);
        assert.match(content, /fingerprint/i, key);
        assert.match(content, /findingKey/, key);
        assert.match(content, /informational.*deferred|deferred.*informational/i, key);
        assert.doesNotMatch(
          content,
          /project-rule violations, naming proposals, refactor proposals, DRY proposals[^\n]+non-blocking or out of scope/i,
          key,
        );
      }
    });

    it("flow skill source documents runtime log options instead of env prefixes", () => {
      const content = fs.readFileSync(path.join(PKG_DIR, "skills", "sennel.flow", "SKILL.md"), "utf8");
      const removedLogOption = `--log-${"file"}`;
      assert.match(content, /--agent-work-dir/);
      assert.match(content, /flow get runtime-log/);
      assert.ok(!content.includes(removedLogOption));
      assert.doesNotMatch(content, /SENNEL_WORK_DIR/);
      assert.doesNotMatch(content, />\s*\S+\s+2>&1/);
    });
  });

  describe("error path: unknown key", () => {
    it("throws Error when key has no <phase>.<step> shape", () => {
      assert.throws(
        () => getStepInstructions("not-a-valid-key"),
        (err) => err instanceof Error && /not-a-valid-key/.test(err.message),
      );
    });

    it("throws Error when phase exists but step file missing", () => {
      // plan.__nonexistent__ — well-formed key but no file.
      assert.throws(
        () => getStepInstructions("plan.__nonexistent__"),
        (err) => err instanceof Error && /__nonexistent__/.test(err.message),
      );
    });

    it("throws Error when phase directory does not exist", () => {
      assert.throws(
        () => getStepInstructions("__no_such_phase__.draft"),
        (err) => err instanceof Error && /__no_such_phase__/.test(err.message),
      );
    });

    it("error message identifies the offending key", () => {
      try {
        getStepInstructions("plan.__missing__");
        assert.fail("should have thrown");
      } catch (err) {
        assert.ok(/plan.__missing__|plan\/__missing__/.test(err.message),
          `error message should reference the offending key/path: ${err.message}`);
      }
    });
  });

  describe("input validation", () => {
    it("throws when called with empty string", () => {
      assert.throws(() => getStepInstructions(""));
    });

    it("throws when called with non-string", () => {
      assert.throws(() => getStepInstructions(null));
      assert.throws(() => getStepInstructions(undefined));
      assert.throws(() => getStepInstructions(42));
    });
  });
});
