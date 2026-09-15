import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  AgentAuthenticationFailure,
  AgentFailure,
  AgentPermissionConfigurationFailure,
  AgentProviderCompletionEvidence,
  AgentProcessStopEvidence,
  AgentTimeoutFailure,
  AgentUsageLimitFailure,
  MAX_DURABLE_AGENT_FAILURE_MESSAGE_BYTES,
  MAX_DURABLE_AGENT_FAILURE_MESSAGE_SERIALIZED_BYTES,
  EmptyAgentResponseFailure,
  PermanentNetworkFailure,
  TemporaryNetworkFailure,
  TemporaryProviderUnavailableFailure,
  TemporaryRateLimitFailure,
  UnclassifiedProviderExitFailure,
  UnknownProviderFailure,
} from "../../../src/lib/agent-failure.js";
import {
  DEFAULT_DURABLE_STREAM_EVIDENCE_BYTES,
  MAX_DURABLE_STREAM_EVIDENCE_BYTES,
  MAX_DURABLE_STREAM_EVIDENCE_SERIALIZED_BYTES,
} from "../../../src/lib/bounded-stream-evidence.js";
import {
  FlowOutboxStore,
  finalizationOutboxIdentity,
} from "../../../src/flow/lib/flow-outbox.js";
import {
  WorkUnitCheckpoint,
  WorkUnitIdentity,
  WorkUnitResumeDecision,
} from "../../../src/flow/lib/work-unit.js";
import { ReviewFailure } from "../../../src/flow/lib/review-failure.js";
import { runCmdWithRetry } from "../../../src/flow/lib/run-review.js";
import { ActivityFailure } from "../../../src/flow/lib/current-flow-state.js";
import {
  ExternalBlockedOutcome,
  StepOutcome,
} from "../../../src/flow/lib/step-outcome.js";
import { FlowAtStepFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";

function providerError(message, fields = {}) {
  return Object.assign(new Error(message), fields);
}

function completedProviderError(message, fields = {}) {
  const stdout = fields.stdout ?? "";
  const stderr = fields.stderr ?? message;
  const evidence = new AgentProviderCompletionEvidence({
    provider: "test",
    profile: "review",
    exitCode: Object.hasOwn(fields, "exitCode") ? fields.exitCode : 1,
    signal: fields.signal ?? null,
    stdout,
    stderr,
    processTreeQuiescence: fields.processTreeQuiescence ?? "confirmed",
  });
  return providerError(message, {
    code: evidence.exitCode,
    signal: evidence.signal,
    stdout,
    stderr,
    providerCompletionEvidence: evidence,
  });
}

function workUnitIdentity(inputHash = "same-input") {
  return new WorkUnitIdentity({
    phase: "impl-review",
    kind: "loop-chunk",
    stableOrderKey: "chunk-0001",
    parentUnitId: null,
    targetFiles: ["src/example.js"],
    inputHash,
    commandId: "flow.impl.review.propose",
    providerIdentity: "test/provider",
    promptVersion: "review-v1",
    schemaVersion: "review-schema-v1",
  });
}

describe("typed agent failure boundaries", () => {
  it("retries only explicit transient provider failures", () => {
    assert.ok(AgentFailure.from(providerError("HTTP 429 rate limited")) instanceof TemporaryRateLimitFailure);
    assert.ok(AgentFailure.from(providerError("temporary DNS", { code: "EAI_AGAIN" })) instanceof TemporaryNetworkFailure);
    const unexplainedExit = AgentFailure.from(providerError("provider=demo | exit=1", {
      code: 1,
      stdout: "",
      stderr: "",
    }));
    assert.ok(unexplainedExit instanceof UnknownProviderFailure);
    assert.equal(unexplainedExit.retryable, false);
    assert.ok(AgentFailure.from(providerError("empty response")) instanceof EmptyAgentResponseFailure);
  });

  it("classifies temporary provider capacity and service availability only from typed completion evidence", () => {
    for (const message of [
      "Selected model is at capacity",
      "provider overloaded",
      "temporarily unavailable",
      "HTTP status 503",
      "API 503",
      "api_error_status=529",
    ]) {
      const failure = AgentFailure.from(completedProviderError(message));
      assert.ok(failure instanceof TemporaryProviderUnavailableFailure, message);
      assert.equal(failure.retryable, true);
      assert.equal(failure.providerCompletionEvidence.confirmedQuiescence, true);
    }
    assert.ok(AgentFailure.from(providerError("Selected model is at capacity")) instanceof UnknownProviderFailure);
  });

  it("classifies a typed signal-free non-zero provider exit as retryable while signals remain terminal", () => {
    const failure = AgentFailure.from(completedProviderError("provider exited without a known classification"));
    assert.ok(failure instanceof UnclassifiedProviderExitFailure);
    assert.equal(failure.retryable, true);

    const signaled = AgentFailure.from(completedProviderError("provider overloaded", {
      exitCode: null,
      signal: "SIGKILL",
    }));
    assert.ok(signaled instanceof UnknownProviderFailure);
    assert.equal(signaled.retryable, false);

    const signaledRateLimit = AgentFailure.from(completedProviderError("HTTP 429 rate limited", {
      exitCode: null,
      signal: "SIGKILL",
    }));
    assert.ok(signaledRateLimit instanceof UnknownProviderFailure);
    assert.equal(signaledRateLimit.retryable, false);
  });

  it("fails closed for authentication, configuration, quota, permanent DNS, and unknown failures", () => {
    const failures = [
      AgentFailure.from(providerError("api_error_status=401 OAuth token expired")),
      AgentFailure.from(providerError("spawn agent ENOENT", { code: "ENOENT" })),
      AgentFailure.from(providerError("HTTP 429 session limit reached")),
      AgentFailure.from(providerError("getaddrinfo ENOTFOUND provider.invalid", { code: "ENOTFOUND" })),
      AgentFailure.from(providerError("provider=demo | exit=2 | unexplained failure", {
        code: 2,
        stdout: "",
        stderr: "unexplained failure",
      })),
    ];

    assert.ok(failures[0] instanceof AgentAuthenticationFailure);
    assert.ok(failures[1] instanceof AgentPermissionConfigurationFailure);
    assert.ok(failures[2] instanceof AgentUsageLimitFailure);
    assert.ok(failures[3] instanceof PermanentNetworkFailure);
    assert.ok(failures[4] instanceof UnknownProviderFailure);
    assert.ok(failures.every((failure) => failure.retryable === false));
    assert.deepEqual(
      failures.map((failure) => failure.requiresExternalIntervention),
      [true, true, true, false, false],
    );
    assert.ok(failures.every((failure) => failure.code && failure.recoveryHint));
  });

  it("keeps terminal classifications ahead of temporary completion messages", () => {
    const cases = [
      ["HTTP 401 Unauthorized while provider overloaded", AgentAuthenticationFailure],
      ["permission denied while provider temporarily unavailable", AgentPermissionConfigurationFailure],
      ["usage quota exhausted while model is at capacity", AgentUsageLimitFailure],
      ["could not resolve host while API 503", PermanentNetworkFailure],
      ["could not resolve host; HTTP 429 rate limited", PermanentNetworkFailure],
    ];
    for (const [message, ExpectedFailure] of cases) {
      const failure = AgentFailure.from(completedProviderError(message));
      assert.ok(failure instanceof ExpectedFailure, message);
      assert.equal(failure.retryable, false);
      assert.deepEqual(failure.providerCompletionEvidence.toJSON(), completedProviderError(message).providerCompletionEvidence.toJSON());
    }
  });

  it("records bounded attempt metadata on the typed error", () => {
    const failure = AgentFailure.from(providerError("HTTP 429 rate limited"))
      .recordAttempts(2, 3);
    assert.deepEqual(failure.toJSON(), {
      kind: "temporary_rate_limit",
      code: "AGENT_TEMPORARY_RATE_LIMIT",
      retryable: true,
      recoveryHint: "Wait for the provider rate-limit window, then retry the same input.",
      attemptCount: 2,
      maxAttempts: 3,
      message: "HTTP 429 rate limited",
    });
  });

  it("round-trips provider completion evidence and keeps its attempt metadata aligned", () => {
    const source = AgentFailure.from(completedProviderError("Selected model is at capacity"))
      .recordAttempts(2, 3);
    const restored = AgentFailure.from(source.toJSON());
    assert.ok(restored instanceof TemporaryProviderUnavailableFailure);
    assert.equal(restored.attemptCount, 2);
    assert.equal(restored.maxAttempts, 3);
    assert.deepEqual(restored.providerCompletionEvidence.toJSON(), source.providerCompletionEvidence.toJSON());

    const review = ReviewFailure.fromMarkerLine(
      ReviewFailure.fromAgentFailure({ phase: "spec", failure: restored }).toMarkerLine(),
    );
    const canonical = new ActivityFailure({
      category: "tooling",
      code: review.failureCode,
      message: review.reason,
      retryable: review.retryable,
      retryKind: "tooling",
      agentFailureKind: review.agentFailureKind,
      agentProviderCompletionEvidence: review.agentProviderCompletionEvidence,
      attemptCount: review.attemptCount,
      maxAttempts: review.maxAttempts,
    });
    const reloaded = new ActivityFailure(JSON.parse(JSON.stringify(canonical)));
    assert.equal(reloaded.code, "AGENT_TEMPORARY_PROVIDER_UNAVAILABLE");
    assert.equal(reloaded.agentFailureKind, "temporary_provider_unavailable");
    assert.equal(reloaded.agentProviderCompletionEvidence.provider, "test");
    assert.equal(reloaded.agentProviderCompletionEvidence.profile, "review");
    assert.equal(reloaded.agentProviderCompletionEvidence.exitCode, 1);
    assert.equal(reloaded.agentProviderCompletionEvidence.signal, null);
    assert.equal(reloaded.agentProviderCompletionEvidence.stdout.head, "");
    assert.equal(reloaded.agentProviderCompletionEvidence.stderr.head, "Selected model is at capacity");
    assert.equal(
      reloaded.agentProviderCompletionEvidence.stderr.sha256,
      crypto.createHash("sha256").update("Selected model is at capacity", "utf8").digest("hex"),
    );
    assert.equal(reloaded.agentProviderCompletionEvidence.confirmedQuiescence, true);
    assert.equal(reloaded.attemptCount, 2);
    assert.equal(reloaded.maxAttempts, 3);
  });

  it("bounds multibyte provider output in durable marker and Activity evidence while retaining raw diagnostics", () => {
    const stdout = `stdout-head-${"\0".repeat(12_000)}-stdout-tail`;
    const stderr = `Selected model is at capacity\n${"🦊".repeat(4_000)}\nstderr-tail`;
    const failure = AgentFailure.from(completedProviderError("Selected model is at capacity", { stdout, stderr }));
    const evidence = failure.providerCompletionEvidence;

    assert.equal(failure.stdout, stdout);
    assert.equal(failure.stderr, stderr);
    for (const [stream, raw] of [[evidence.stdout, stdout], [evidence.stderr, stderr]]) {
      assert.equal(stream.captureLimitBytes, DEFAULT_DURABLE_STREAM_EVIDENCE_BYTES);
      assert.equal(stream.captureLimitBytes, MAX_DURABLE_STREAM_EVIDENCE_BYTES);
      assert.equal(stream.truncated, true);
      assert.ok(stream.capturedByteLength <= stream.captureLimitBytes);
      assert.equal(Buffer.byteLength(stream.head, "utf8") + Buffer.byteLength(stream.tail, "utf8"), stream.capturedByteLength);
      assert.equal(stream.sha256, crypto.createHash("sha256").update(raw, "utf8").digest("hex"));
      assert.ok(Buffer.byteLength(JSON.stringify(stream.toJSON()), "utf8") <= MAX_DURABLE_STREAM_EVIDENCE_SERIALIZED_BYTES);
    }
    assert.ok(Buffer.byteLength(failure.message, "utf8") <= MAX_DURABLE_AGENT_FAILURE_MESSAGE_BYTES);

    const review = ReviewFailure.fromAgentFailure({ phase: "impl", failure });
    const marker = review.toMarkerLine();
    const canonical = new ActivityFailure({
      category: "tooling",
      code: review.failureCode,
      message: review.reason,
      retryable: review.retryable,
      retryKind: "tooling",
      agentFailureKind: review.agentFailureKind,
      agentProviderCompletionEvidence: review.agentProviderCompletionEvidence,
      attemptCount: review.attemptCount,
      maxAttempts: review.maxAttempts,
    });
    const markerAndActivityMaximum = (2 * MAX_DURABLE_STREAM_EVIDENCE_SERIALIZED_BYTES)
      + MAX_DURABLE_AGENT_FAILURE_MESSAGE_SERIALIZED_BYTES + 4096;

    assert.ok(Buffer.byteLength(marker, "utf8") <= markerAndActivityMaximum);
    assert.ok(Buffer.byteLength(JSON.stringify(canonical.toJSON()), "utf8") <= markerAndActivityMaximum);
    const reloaded = new ActivityFailure(JSON.parse(JSON.stringify(canonical)));
    assert.deepEqual(reloaded.agentProviderCompletionEvidence.toJSON(), evidence.toJSON());
  });

  it("restores the legacy unknown-provider stable contract without changing retryability", () => {
    const restored = AgentFailure.from({
      kind: "unknown_provider",
      code: "AGENT_UNKNOWN_PROVIDER_FAILURE",
      retryable: false,
      recoveryHint: "legacy",
      attemptCount: 1,
      maxAttempts: 1,
      message: "Selected model is at capacity",
    });
    assert.ok(restored instanceof UnknownProviderFailure);
    assert.equal(restored.retryable, false);
    assert.equal(restored.providerCompletionEvidence, null);
  });

  it("restores a stable temporary-provider code before conflicting diagnostic text", () => {
    const source = AgentFailure.from(completedProviderError("Selected model is at capacity")).toJSON();
    source.message = "HTTP 401 Unauthorized";
    source.stderr = "permission denied";
    const restored = AgentFailure.from(source);
    assert.ok(restored instanceof TemporaryProviderUnavailableFailure);
    assert.equal(restored.code, "AGENT_TEMPORARY_PROVIDER_UNAVAILABLE");
    assert.equal(restored.retryable, true);
  });

  it("rejects retryable stable, marker, and canonical facts carrying a signaled completion", () => {
    const evidence = new AgentProviderCompletionEvidence({
      provider: "test",
      profile: "review",
      exitCode: null,
      signal: "SIGKILL",
      stderr: "HTTP 429 rate limited",
    });
    assert.throws(() => AgentFailure.from({
      code: "AGENT_TEMPORARY_RATE_LIMIT",
      message: "HTTP 429 rate limited",
      retryable: true,
      attemptCount: 1,
      maxAttempts: 1,
      providerCompletionEvidence: evidence.toJSON(),
    }), /signaled provider completion evidence cannot be retryable/);
    assert.throws(() => new ReviewFailure({
      phase: "spec",
      classification: "provider_failure",
      reason: "HTTP 429 rate limited",
      failureCode: "AGENT_TEMPORARY_RATE_LIMIT",
      retryable: true,
      agentFailureKind: "temporary_rate_limit",
      agentProviderCompletionEvidence: evidence,
      attemptCount: 1,
      maxAttempts: 1,
    }), /signaled provider completion evidence cannot be retryable/);
    assert.throws(() => new ActivityFailure({
      category: "tooling",
      code: "AGENT_TEMPORARY_RATE_LIMIT",
      message: "HTTP 429 rate limited",
      retryable: true,
      retryKind: "tooling",
      agentFailureKind: "temporary_rate_limit",
      agentProviderCompletionEvidence: evidence,
      attemptCount: 1,
      maxAttempts: 1,
    }), /signaled provider completion evidence cannot be retryable/);
  });

  it("rejects forged retryable completion evidence for terminal and unknown stable codes", () => {
    const evidence = new AgentProviderCompletionEvidence({
      provider: "test",
      profile: "review",
      exitCode: 1,
      signal: null,
      stderr: "forged terminal completion",
      attemptCount: 1,
      maxAttempts: 1,
      processTreeQuiescence: "confirmed",
    });
    for (const [code, kind] of [
      ["AGENT_AUTHENTICATION_FAILED", "authentication"],
      ["AGENT_PERMISSION_CONFIGURATION_FAILED", "permission_configuration"],
      ["AGENT_USAGE_LIMIT_REACHED", "usage_limit"],
      ["AGENT_PERMANENT_NETWORK_FAILURE", "permanent_network"],
      ["AGENT_UNKNOWN_PROVIDER_FAILURE", "unknown_provider"],
    ]) {
      const markerFacts = {
        phase: "spec",
        classification: "provider_failure",
        reason: "forged terminal completion",
        failureCode: code,
        retryable: true,
        agentFailureKind: kind,
        agentProviderCompletionEvidence: evidence,
        attemptCount: 1,
        maxAttempts: 1,
      };
      assert.throws(
        () => new ReviewFailure(markerFacts),
        /retryability contradicts its stable AgentFailure policy/,
        code,
      );
      assert.throws(
        () => new ActivityFailure({
          category: "tooling",
          code,
          message: markerFacts.reason,
          retryable: true,
          retryKind: "tooling",
          agentFailureKind: kind,
          agentProviderCompletionEvidence: evidence,
          attemptCount: 1,
          maxAttempts: 1,
        }),
        /retryability contradicts its stable AgentFailure policy/,
        code,
      );
    }
    assert.throws(() => new ReviewFailure({
      phase: "spec",
      classification: "provider_failure",
      reason: "forged unknown completion",
      failureCode: "AGENT_FORGED_RETRYABLE",
      retryable: true,
      agentFailureKind: "forged",
      agentProviderCompletionEvidence: evidence,
      attemptCount: 1,
      maxAttempts: 1,
    }), /recognized stable AgentFailure code/);
    assert.throws(() => new ActivityFailure({
      category: "tooling",
      code: "AGENT_FORGED_RETRYABLE",
      message: "forged unknown completion",
      retryable: true,
      retryKind: "tooling",
      agentFailureKind: "forged",
      agentProviderCompletionEvidence: evidence,
      attemptCount: 1,
      maxAttempts: 1,
    }), /recognized stable AgentFailure code/);
  });

  it("round-trips confirmed and uncertain timeout stop evidence without inferring from an empty member list", () => {
    for (const [stopEvidence, retryable] of [
      [AgentProcessStopEvidence.confirmed(), true],
      [AgentProcessStopEvidence.uncertain("process-tree-members-unavailable"), false],
    ]) {
      const source = new AgentTimeoutFailure({ message: "provider timed out", stopEvidence });
      const restoredAgent = AgentFailure.from(source.toJSON());
      assert.equal(restoredAgent.retryable, retryable);
      assert.deepEqual(restoredAgent.stopEvidence.toJSON(), stopEvidence.toJSON());

      const marker = ReviewFailure.fromAgentFailure({ phase: "test", failure: restoredAgent }).toMarkerLine();
      const restoredReview = ReviewFailure.fromMarkerLine(marker);
      assert.equal(restoredReview.retryable, retryable);
      assert.deepEqual(restoredReview.agentStopEvidence.toJSON(), stopEvidence.toJSON());

      const canonical = new ActivityFailure({
        category: "tooling",
        code: restoredReview.failureCode,
        message: restoredReview.reason,
        retryable: restoredReview.retryable,
        retryKind: retryable ? "tooling" : null,
        agentStopEvidence: restoredReview.agentStopEvidence,
      });
      assert.deepEqual(canonical.agentStopEvidence.toJSON(), stopEvidence.toJSON());
    }
  });

  it("keeps non-Review AGENT_TIMEOUT canonical failures valid without Review stop evidence", () => {
    const failure = new ActivityFailure({
      category: "tooling",
      code: "AGENT_TIMEOUT",
      message: "A non-Review command reached its existing Agent deadline.",
      retryable: true,
      retryKind: "tooling",
    });
    const restored = new ActivityFailure(JSON.parse(JSON.stringify(failure)));

    assert.equal(restored.code, "AGENT_TIMEOUT");
    assert.equal(restored.retryable, true);
    assert.equal(restored.retryKind, "tooling");
    assert.equal(restored.agentStopEvidence, null);
  });

  it("restores stable timeout JSON before classifying conflicting provider text", () => {
    for (const conflict of ["HTTP 429 rate limited", "OAuth login required", "usage quota exhausted"]) {
      const source = new AgentTimeoutFailure({
        message: `provider timed out: ${conflict}`,
        stopEvidence: AgentProcessStopEvidence.confirmed(),
      }).toJSON();
      source.stdout = conflict;
      source.stderr = conflict;

      const restored = AgentFailure.from(source);

      assert.ok(restored instanceof AgentTimeoutFailure);
      assert.equal(restored.code, "AGENT_TIMEOUT");
      assert.equal(restored.retryable, true);
      assert.deepEqual(restored.stopEvidence.toJSON(), source.stopEvidence);
    }
  });
});

describe("terminal replay guards", () => {
  it("does not create retryable provider failures from raw or malformed subprocess diagnostics", () => {
    for (const stderr of [
      "Selected model is at capacity",
      `${ReviewFailure.fromAgentFailure({
        phase: "spec",
        failure: new TemporaryProviderUnavailableFailure({
          message: "Selected model is at capacity",
          providerCompletionEvidence: new AgentProviderCompletionEvidence({
            provider: "test",
            profile: "review",
            exitCode: 1,
            stderr: "Selected model is at capacity",
            processTreeQuiescence: "confirmed",
          }),
        }),
      }).toMarkerLine().slice(0, -1)}`,
    ]) {
      const failure = ReviewFailure.fromSubprocessResult({
        phase: "spec",
        result: { status: 1, signal: null, killed: false, stderr },
      });
      assert.equal(failure.classification, "subprocess_failure");
      assert.equal(failure.retryable, false);
      assert.equal(failure.agentProviderCompletionEvidence, null);
    }
  });

  it("limits schema failures to two total review subprocess attempts", async () => {
    const failure = ReviewFailure.schemaFailure({
      phase: "impl",
      targetReview: "impl-review",
      validationError: "blockingFindings must be an array",
      maximumAttempts: 1,
    });
    let calls = 0;
    const result = await runCmdWithRetry(
      () => {
        calls += 1;
        return { ok: false, status: 1, stdout: "", stderr: failure.toMarkerLine() };
      },
      { phase: "impl", retryCount: 0, retryDelayMs: 0 },
    );

    assert.equal(calls, 2);
    const restored = ReviewFailure.fromSubprocessResult({ phase: "impl", result });
    assert.equal(restored.classification, "schema_failure");
    assert.equal(restored.currentAttempt, 2);
    assert.equal(restored.maximumAttempts, 2);
    assert.equal(restored.shouldRetrySubprocess({ attempt: 2, maxAttempts: 2 }), false);
  });

  it("keeps the ordinary subprocess retry count unchanged", async () => {
    let calls = 0;
    await runCmdWithRetry(
      () => {
        calls += 1;
        return { ok: false, status: 1, stdout: "", stderr: "temporary subprocess failure" };
      },
      { phase: "impl", retryCount: 2, retryDelayMs: 0 },
    );

    assert.equal(calls, 3);
  });

  it("preserves typed failure data through review markers and stored StepOutcomes", () => {
    const source = new AgentAuthenticationFailure({ message: "OAuth token expired" })
      .recordAttempts(1, 3);
    const review = ReviewFailure.fromAgentFailure({ phase: "impl", failure: source });
    const restoredReview = ReviewFailure.fromMarkerLine(review.toMarkerLine());
    assert.equal(restoredReview.failureCode, "AGENT_AUTHENTICATION_FAILED");
    assert.equal(restoredReview.retryable, false);
    assert.equal(restoredReview.attemptCount, 1);
    assert.equal(restoredReview.maxAttempts, 3);

    const outcome = new ExternalBlockedOutcome({
      reason: source.kind,
      resumeInstruction: source.recoveryHint,
      failureCode: source.code,
      retryable: source.retryable,
      recoveryHint: source.recoveryHint,
    });
    const restoredOutcome = StepOutcome.fromStored(outcome.toJSON());
    assert.ok(restoredOutcome instanceof ExternalBlockedOutcome);
    assert.equal(restoredOutcome.failureCode, "AGENT_AUTHENTICATION_FAILED");
    assert.equal(restoredOutcome.retryable, false);
  });

  it("blocks an unchanged non-retryable WorkUnit checkpoint and permits changed input", () => {
    const identity = workUnitIdentity();
    const checkpoint = new WorkUnitCheckpoint({
      identity,
      status: "failed",
      failure: {
        failureKind: "provider_failure",
        failureCode: "AGENT_AUTHENTICATION_FAILED",
        retryable: false,
        message: "authentication failed",
      },
    });

    assert.equal(WorkUnitResumeDecision.fromCheckpoint(identity, checkpoint).action, "blocked");
    assert.equal(WorkUnitResumeDecision.fromCheckpoint(workUnitIdentity("changed-input"), checkpoint).action, "execute");
  });

  it("blocks direct begin of a failed outbox entry without changing it", () => {
    const root = createTmpDir("agent-failure-outbox-v1-");
    try {
      const manager = makeFlowManager(root);
      const fixture = new FlowAtStepFixture({
        flowManager: manager,
        specId: "487-outbox",
        runId: "run-487",
        targetStep: "finalize-sync",
      }).create();
      const store = new FlowOutboxStore(manager, { specId: fixture.state().specId });
      const identity = finalizationOutboxIdentity({ runId: "run-487" }, "finalize-sync");
      store.begin(identity);
      store.fail(identity, new Error("push permission denied"));
      const before = store.status(identity).toJSON();

      assert.throws(
        () => store.beginCommand(identity),
        (error) => error.code === "FINALIZATION_OUTBOX_RECOVERY_REQUIRED" && error.retryable === false,
      );
      assert.deepEqual(store.status(identity).toJSON(), before);
      assert.equal(store.status(identity).status, "failed");
    } finally {
      removeTmpDir(root);
    }
  });
});
