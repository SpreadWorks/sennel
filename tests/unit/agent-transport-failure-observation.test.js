import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentTransportFailureObservation } from "../../src/lib/agent-transport-failure-observation.js";
import { AgentProviderCompletionEvidence, AgentProcessStopEvidence, AgentProviderStartupFailureEvidence,
  TemporaryRateLimitFailure, AgentTimeoutFailure, UnknownProviderFailure, AgentPermissionConfigurationFailure } from "../../src/lib/agent-failure.js";

const context = { providerKey: "test", profileKey: "test/exec", attempt: 1, maxAttempts: 2 };

it("only confirms transport failures with completion, confirmed stop, or actual startup evidence", () => {
  const completion = new AgentProviderCompletionEvidence({ provider: context.providerKey, profile: context.profileKey,
    exitCode: 1, stderr: "HTTP 429 rate limited", maxAttempts: 2 });
  const startup = AgentProviderStartupFailureEvidence.fromSpawnFailure(Object.assign(new Error("spawn failed"), { code: "ENOENT" }), context).withAttempts(1, 2);
  const confirmed = [
    new TemporaryRateLimitFailure({ providerCompletionEvidence: completion, maxAttempts: 2 }),
    new AgentTimeoutFailure({ message: "Timed out", stopEvidence: AgentProcessStopEvidence.confirmed("tree-death-observed"), maxAttempts: 2 }),
    new AgentPermissionConfigurationFailure({ message: "Startup failed", providerStartupEvidence: startup, maxAttempts: 2 }),
  ];
  for (const failure of confirmed) {
    const observation = AgentTransportFailureObservation.fromFailure(failure, context);
    assert.equal(observation.failureCode, failure.code);
    assert.equal(observation.retryable, failure.retryable);
    const restored = AgentTransportFailureObservation.fromJSON(JSON.parse(JSON.stringify(observation)));
    restored.assertFailure({ ...context, code: failure.code, retryable: failure.retryable });
    assert.deepEqual(restored.toJSON(), observation.toJSON());
  }
  assert.equal(AgentTransportFailureObservation.fromFailure(new UnknownProviderFailure({ message: "Unobserved", maxAttempts: 2 }), context), null);
  assert.equal(AgentTransportFailureObservation.fromFailure(new AgentTimeoutFailure({ message: "Unobserved stop", maxAttempts: 2 }), context), null);
  assert.equal(AgentProviderStartupFailureEvidence.fromSpawnFailure(Object.assign(new Error("unknown"), { code: "ENOENT" }), { ...context, child: { pid: 123 } }), null);
});

it("rejects foreign physical proof and proof-free serialized failures", () => {
  const completion = new AgentProviderCompletionEvidence({ provider: "foreign", profile: context.profileKey, exitCode: 1, maxAttempts: 2 });
  assert.throws(() => AgentTransportFailureObservation.fromFailure(new TemporaryRateLimitFailure({ providerCompletionEvidence: completion, maxAttempts: 2 }), context), TypeError);
  assert.throws(() => AgentTransportFailureObservation.fromJSON({ failureCode: "AGENT_UNKNOWN_PROVIDER_FAILURE", ...context,
    retryable: false, providerCompletionEvidence: null, stopEvidence: null, providerStartupEvidence: null }), TypeError);
});
