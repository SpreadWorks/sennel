import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runLoopReviewWithDependencies } from "../../../src/flow/commands/review.js";
import { createMemoryWorkUnitCheckpointStore } from "../../../src/flow/lib/work-unit.js";

function groups(count = 15) {
  return Array.from({ length: count }, (_, index) => ({
    files: [`src/file-${index}.js`],
    representative: `src/file-${index}.js`,
    diff: `+ change ${index}`,
  }));
}

function emptyProposalResponse() {
  return JSON.stringify({ proposals: [] });
}

function proposal(file, title) {
  return { title, file, issue: `${title} issue`, suggestion: `${title} fix`, requirementId: "R-1" };
}

function consumeAttempts(providerCallAdmission, count = 1) {
  providerCallAdmission.claim();
  for (let index = 0; index < count; index++) providerCallAdmission.beforeProviderAttempt();
}

function options(overrides = {}) {
  return {
    groups: groups(),
    maxLoopCalls: 16,
    buildChunkInput: (chunk) => `review ${chunk[0].representative}`,
    requirementIds: new Set(["R-1"]),
    ...overrides,
  };
}

describe("implementation-loop bounded execution", () => {
  it("executes fifteen map calls and one mandatory cross-check within the sixteen-attempt limit", async () => {
    let mapCalls = 0;
    let crossCheckCalls = 0;
    const result = await runLoopReviewWithDependencies(options({
      reviewChunk: async (_chunk, _input, { providerCallAdmission }) => {
        consumeAttempts(providerCallAdmission);
        mapCalls += 1;
        return emptyProposalResponse();
      },
      crossCheck: async (summaries, { providerCallAdmission }) => {
        consumeAttempts(providerCallAdmission);
        crossCheckCalls += 1;
        assert.equal(summaries.length, 15);
        return emptyProposalResponse();
      },
    }));

    assert.equal(mapCalls, 15);
    assert.equal(crossCheckCalls, 1);
    assert.equal(result.reviewCallCount, 16);
    assert.equal(result.summaries.length, 15);
  });

  it("fails closed before a seventeenth attempt when a map transport retry consumes the reserved slot", async () => {
    let admittedAttempts = 0;
    let mapCalls = 0;
    let crossCheckCalls = 0;
    const result = await runLoopReviewWithDependencies(options({
      reviewChunk: async (_chunk, _input, { providerCallAdmission }) => {
        const attemptCount = mapCalls === 0 ? 2 : 1;
        providerCallAdmission.claim();
        for (let index = 0; index < attemptCount; index++) {
          providerCallAdmission.beforeProviderAttempt();
          admittedAttempts += 1;
        }
        mapCalls += 1;
        return emptyProposalResponse();
      },
      crossCheck: async (_summaries, { providerCallAdmission }) => {
        consumeAttempts(providerCallAdmission);
        admittedAttempts += 1;
        crossCheckCalls += 1;
        return emptyProposalResponse();
      },
    }));

    assert.equal(admittedAttempts, 16);
    assert.equal(mapCalls, 15);
    assert.equal(crossCheckCalls, 0);
    assert.equal(result.reviewCallCount, 16);
    assert.ok(result.toolingOutcome);
    assert.equal(result.proposals.length, 0);
  });

  it("reuses complete map and cross-check checkpoints but invalidates both when the prompt version changes", async () => {
    const checkpointStore = createMemoryWorkUnitCheckpointStore();
    let mapCalls = 0;
    let crossCheckCalls = 0;
    const run = (promptVersion) => runLoopReviewWithDependencies(options({
      checkpointStore,
      promptVersion,
      reviewChunk: async (_chunk, _input, { providerCallAdmission }) => {
        consumeAttempts(providerCallAdmission);
        mapCalls += 1;
        return emptyProposalResponse();
      },
      crossCheck: async (_summaries, { providerCallAdmission }) => {
        consumeAttempts(providerCallAdmission);
        crossCheckCalls += 1;
        return emptyProposalResponse();
      },
    }));

    const first = await run("impl-review-prompt-v1");
    const reused = await run("impl-review-prompt-v1");
    const invalidated = await run("impl-review-prompt-v2");

    assert.equal(first.reviewCallCount, 16);
    assert.equal(reused.reviewCallCount, 0);
    assert.equal(invalidated.reviewCallCount, 16);
    assert.equal(mapCalls, 30);
    assert.equal(crossCheckCalls, 2);
  });

  it("carries Requirement descriptions into the cross-check and invalidates only that checkpoint when authority changes", async () => {
    const checkpointStore = createMemoryWorkUnitCheckpointStore();
    let requirementBody = "R-1: original behavior";
    let mapCalls = 0;
    let crossCheckCalls = 0;
    const run = () => runLoopReviewWithDependencies(options({
      groups: groups(2),
      checkpointStore,
      buildChunkAuthority: (chunk) => `${chunk[0].representative}\n${requirementBody}`,
      reviewChunk: async (_chunk, _input, { providerCallAdmission }) => {
        consumeAttempts(providerCallAdmission);
        mapCalls += 1;
        return emptyProposalResponse();
      },
      crossCheck: async (summaries, { providerCallAdmission }) => {
        consumeAttempts(providerCallAdmission);
        crossCheckCalls += 1;
        assert.ok(summaries.every((summary) => summary.requirementAuthority.includes(requirementBody)));
        return emptyProposalResponse();
      },
    }));

    await run();
    requirementBody = "R-1: changed normative behavior";
    const changed = await run();

    assert.equal(mapCalls, 2, "unchanged map inputs reuse their checkpoints");
    assert.equal(crossCheckCalls, 2, "changed Requirement authority invalidates the cross-check");
    assert.equal(changed.reviewCallCount, 1);
  });

  it("uses the cross-check as the authoritative proposal set without losing compacted group files", async () => {
    const compacted = [{
      files: ["src/a.js", "src/a-copy.js"],
      representative: "src/a.js",
      diff: "+ shared change",
    }, {
      files: ["src/b.js"],
      representative: "src/b.js",
      diff: "+ conflicting change",
    }];
    const result = await runLoopReviewWithDependencies(options({
      groups: compacted,
      buildChunkAuthority: (chunk) => `R-1 authority for ${chunk[0].files.join(",")}`,
      reviewChunk: async (chunk, _input, { providerCallAdmission }) => {
        consumeAttempts(providerCallAdmission);
        return JSON.stringify({ proposals: [proposal(chunk[0].representative, `map-${chunk[0].representative}`)] });
      },
      crossCheck: async (summaries, { providerCallAdmission }) => {
        consumeAttempts(providerCallAdmission);
        const candidates = summaries.flatMap((summary) => JSON.parse(summary.proposals).proposals);
        assert.deepEqual(candidates.map((candidate) => candidate.file), ["src/a.js", "src/a-copy.js", "src/b.js"]);
        return JSON.stringify({ proposals: candidates.filter((candidate) => candidate.file !== "src/b.js") });
      },
    }));

    assert.deepEqual(result.proposals.map((candidate) => candidate.file), ["src/a.js", "src/a-copy.js"]);
    assert.equal(result.reviewCallCount, 3);
  });
});
