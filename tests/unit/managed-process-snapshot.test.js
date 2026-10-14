import assert from "node:assert/strict";
import { test } from "node:test";

import { ManagedProcessSnapshot } from "../../src/lib/managed-process-protocol.js";
import { LinuxProcessStat, ProcessIdentity, ProcessIdentitySource } from "../../src/lib/process-identity.js";
import { ProcessExecutionControlFailure, ProcessExecutionFailureDiagnostic } from "../../src/lib/process-execution-values.js";

const executionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const callId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ownerToken = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const pgid = 410;

function identity(pid, startFingerprint = String(pid * 10)) {
  return new ProcessIdentity({ pid, bootIdentity: "snapshot-test-boot", startFingerprint, ownerToken });
}

const launcher = identity(pgid);
const provider = identity(411);
const descendant = identity(412);

function stat(member, { state = "S", pgrp = pgid, sessionId = pgid, startFingerprint = Number(member.startFingerprint) } = {}) {
  return new LinuxProcessStat({ pid: member.pid, state, pgrp, sessionId, startFingerprint });
}

class SnapshotFixture {
  constructor(members = [descendant]) {
    this.record = { executionId, callId, pgid, launcherIdentity: launcher, members };
    this.group = [stat(launcher)];
    this.events = [];
    this.current = new Map([launcher, ...members].map((member) => [member.pid, stat(member)]));
    this.identitySource = new ProcessIdentitySource({
      platform: "linux", readBootIdentity: () => "snapshot-test-boot",
      readProcessStat: (pid) => {
        this.events.push(`observe:${pid}`);
        const current = this.current.get(pid);
        if (current instanceof Error) throw current;
        if (!current) throw Object.assign(new Error("process no longer exists"), { code: "ENOENT" });
        return current;
      },
    });
  }
  snapshot(options = {}) {
    return new ManagedProcessSnapshot(this.record, {
      identitySource: this.identitySource,
      groupReader: (groupId) => {
        assert.equal(groupId, pgid);
        this.events.push("enumerate");
        return this.group;
      },
      operation: "snapshot-test", ...options,
    });
  }
}

function diagnosticFailure(code, role, member, observedPgid = null, observedSid = null) {
  return (error) => {
    assert.ok(error instanceof ProcessExecutionControlFailure);
    assert.equal(error.code, code);
    assert.equal(error.executionId, executionId);
    assert.equal(error.callId, callId);
    assert.ok(error.diagnostic instanceof ProcessExecutionFailureDiagnostic);
    assert.deepEqual(error.diagnostic.toJSON(), {
      schemaVersion: 1, executionId, callId, operation: "snapshot-test", role,
      birth: { pid: member.pid, bootIdentity: member.bootIdentity, startFingerprint: member.startFingerprint },
      originalPgid: pgid, observedPgid, observedSid,
      primaryCause: { code, message: error.message },
    });
    assert.equal(error.retryable, false);
    assert.equal(JSON.stringify(error.diagnostic).includes(ownerToken), false);
    return true;
  };
}

test("a captured descendant moving before enumeration keeps its birth in an immutable snapshot", () => {
  const fixture = new SnapshotFixture();
  fixture.current.set(descendant.pid, stat(descendant, { pgrp: descendant.pid, sessionId: descendant.pid }));
  const snapshot = fixture.snapshot();
  assert.deepEqual(snapshot.members, [launcher, descendant]);
  assert.equal(snapshot.members.find((member) => member.pid === descendant.pid).sameBirth(descendant), true);
  assert.equal(snapshot.isStopped({ excludeLauncher: true }), false);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.members), true);
  assert.throws(() => snapshot.members.pop(), TypeError);
});

test("a descendant moving between the group scan and birth observation remains a running known member", () => {
  const fixture = new SnapshotFixture();
  fixture.group = [stat(launcher), stat(descendant)];
  const snapshot = fixture.snapshot({ groupReader(groupId) {
    assert.equal(groupId, pgid);
    const scanned = fixture.group;
    fixture.current.set(descendant.pid, stat(descendant, { pgrp: 600, sessionId: 600 }));
    return scanned;
  } });
  assert.deepEqual(snapshot.members, [launcher, descendant]);
  assert.equal(snapshot.isStopped({ excludeLauncher: true }), false);
});

test("an empty original group cannot confirm stop while a moved descendant is live", () => {
  const fixture = new SnapshotFixture();
  fixture.group = [];
  fixture.current.delete(launcher.pid);
  fixture.current.set(descendant.pid, stat(descendant, { pgrp: 600, sessionId: 600 }));
  const snapshot = fixture.snapshot();
  assert.equal(snapshot.isStopped(), false);
  assert.equal(snapshot.isStopped({ excludeLauncher: true }), false);
  assert.equal(snapshot.members.some((member) => member.sameBirth(descendant)), true);
});

for (const [role, member] of [["launcher", launcher], ["provider", provider], ["descendant", descendant]]) {
  test(`stop deadline identifies the observed surviving ${role} without another process read`, () => {
    const fixture = new SnapshotFixture([provider, descendant]);
    fixture.record.providerIdentity = provider;
    fixture.record.capability = "private-call-capability";
    fixture.group = [];
    fixture.current.clear();
    const observedPgid = role === "descendant" ? 600 : pgid;
    const observedSid = role === "descendant" ? 590 : pgid;
    fixture.current.set(member.pid, stat(member, { pgrp: observedPgid, sessionId: observedSid }));
    const snapshot = fixture.snapshot();
    const observations = [...fixture.events];
    const message = "Managed group termination could not be proved within the stop deadline";
    const failure = snapshot.stopFailure(message);
    assert.ok(failure instanceof ProcessExecutionControlFailure);
    assert.equal(failure.code, "PROCESS_EXECUTION_STOP_UNPROVEN");
    assert.equal(failure.executionId, executionId);
    assert.equal(failure.callId, callId);
    assert.equal(failure.retryable, false);
    assert.deepEqual(failure.diagnostic.toJSON(), {
      schemaVersion: 1, executionId, callId, operation: "stop-deadline", role,
      birth: { pid: member.pid, bootIdentity: member.bootIdentity, startFingerprint: member.startFingerprint },
      originalPgid: pgid, observedPgid, observedSid,
      primaryCause: { code: failure.code, message },
    });
    assert.deepEqual(failure.primaryCause.toJSON(), { code: failure.code, message, executionId, callId });
    const stored = failure.withContext({ executionId, callId }).toJSON();
    assert.deepEqual(stored, failure.toJSON());
    assert.deepEqual(ProcessExecutionControlFailure.fromStored(stored, { executionId, callId }).toJSON(), stored);
    assert.deepEqual(fixture.events, observations);
    for (const secret of [ownerToken, fixture.record.capability]) assert.equal(JSON.stringify(stored).includes(secret), false);
  });
}

test("stop deadline reports the moved live birth ahead of its still-live launcher and provider", () => {
  const fixture = new SnapshotFixture([provider, descendant]);
  fixture.record.providerIdentity = provider;
  fixture.current.set(descendant.pid, stat(descendant, { pgrp: 600, sessionId: 590 }));
  const snapshot = fixture.snapshot();
  const observations = [...fixture.events];
  const failure = snapshot.stopFailure("Managed launcher exceeded its finite stop deadline");
  assert.equal(failure.diagnostic.role, "descendant");
  assert.equal(failure.diagnostic.birth.pid, descendant.pid);
  assert.equal(failure.diagnostic.observedPgid, 600);
  assert.equal(failure.diagnostic.observedSid, 590);
  assert.deepEqual(fixture.events, observations);
});

test("a live group observation followed by a missing birth retains the original failed stop evidence", () => {
  const fixture = new SnapshotFixture();
  fixture.group = [stat(descendant, { pgrp: pgid, sessionId: 590 })];
  fixture.current.clear();
  const snapshot = fixture.snapshot();
  const observations = [...fixture.events];
  const failure = snapshot.stopFailure("Managed launcher exceeded its finite stop deadline");
  assert.equal(failure.code, "PROCESS_EXECUTION_STOP_UNPROVEN");
  assert.equal(failure.diagnostic.role, "descendant");
  assert.equal(failure.diagnostic.birth.pid, descendant.pid);
  assert.equal(failure.diagnostic.observedPgid, pgid);
  assert.equal(failure.diagnostic.observedSid, 590);
  assert.deepEqual(fixture.events, observations);
});

test("a confirmed stopped snapshot has no stop deadline failure", () => {
  const fixture = new SnapshotFixture();
  fixture.group = [];
  fixture.current.clear();
  const snapshot = fixture.snapshot();
  assert.equal(snapshot.isStopped(), true);
  assert.equal(snapshot.stopFailure("Stop deadline elapsed"), null);
});

test("a fresh unknown observation keeps its typed cause after an earlier stopped snapshot", () => {
  const fixture = new SnapshotFixture();
  fixture.group = [];
  fixture.current.clear();
  assert.equal(fixture.snapshot().isStopped(), true);
  fixture.current.set(descendant.pid, Object.assign(new Error("stat permission denied"), { code: "EACCES" }));
  assert.throws(() => fixture.snapshot().stopFailure("Stop deadline elapsed"),
    diagnosticFailure("PROCESS_EXECUTION_OBSERVATION_UNKNOWN", "descendant", descendant));
});

for (const state of ["Z", "X"]) {
  test(`same-birth ${state} outside the group permits launcher drain but the coordinator still includes its live launcher`, () => {
    const fixture = new SnapshotFixture();
    fixture.current.set(descendant.pid, stat(descendant, { state, pgrp: 600, sessionId: 600 }));
    const snapshot = fixture.snapshot();
    assert.equal(snapshot.isStopped({ excludeLauncher: true }), true);
    assert.equal(snapshot.isStopped(), false);
    fixture.current.delete(launcher.pid);
    fixture.group = [];
    assert.equal(fixture.snapshot().isStopped(), true);
  });
}

for (const condition of ["missing", "reused"]) {
  test(`a ${condition} recorded birth outside the group terminates ownership without acquiring another birth`, () => {
    const fixture = new SnapshotFixture();
    if (condition === "missing") fixture.current.delete(descendant.pid);
    else fixture.current.set(descendant.pid, stat(descendant, { startFingerprint: 9999, pgrp: 600, sessionId: 600 }));
    const snapshot = fixture.snapshot();
    assert.equal(snapshot.isStopped({ excludeLauncher: true }), true);
    assert.deepEqual(snapshot.members, [launcher, descendant]);
    assert.equal(snapshot.members.some((member) => member.startFingerprint === "9999"), false);
    assert.equal(snapshot.isStopped(), false);
  });
}

test("unknown descendant observation rejects stop with birth and call diagnostics", () => {
  const fixture = new SnapshotFixture();
  fixture.current.set(descendant.pid, Object.assign(new Error("stat permission denied"), { code: "EACCES" }));
  assert.throws(() => fixture.snapshot(), diagnosticFailure("PROCESS_EXECUTION_OBSERVATION_UNKNOWN", "descendant", descendant));
});

for (const [role, member, members] of [["provider", provider, [provider, descendant]], ["launcher", launcher, [descendant]]]) {
  test(`${role} group escape remains refused with observed PGID and SID`, () => {
    const fixture = new SnapshotFixture(members);
    fixture.group = [];
    fixture.current.set(member.pid, stat(member, { pgrp: 600, sessionId: 590 }));
    assert.throws(() => fixture.snapshot({ providerIdentity: provider }),
      diagnosticFailure("PROCESS_EXECUTION_IDENTITY_UNKNOWN", role, member, 600, 590));
  });
}

for (const state of ["Z", "X"]) {
  for (const [role, member, members] of [["provider", provider, [provider, descendant]], ["launcher", launcher, [descendant]]]) {
    test(`${role} group escape is refused even when its observed same birth is ${state}`, () => {
      const fixture = new SnapshotFixture(members);
      fixture.group = [];
      fixture.current.set(member.pid, stat(member, { state, pgrp: 600, sessionId: 590 }));
      assert.throws(() => fixture.snapshot({ providerIdentity: provider }),
        diagnosticFailure("PROCESS_EXECUTION_IDENTITY_UNKNOWN", role, member, 600, 590));
    });
  }
}

test("a persisted plain provider identity restores its direct role without an explicit provider option", () => {
  const fixture = new SnapshotFixture([provider, descendant]);
  fixture.record = JSON.parse(JSON.stringify({ ...fixture.record, providerIdentity: provider }));
  fixture.current.set(provider.pid, stat(provider, { pgrp: 600, sessionId: 590 }));
  assert.throws(() => fixture.snapshot(),
    diagnosticFailure("PROCESS_EXECUTION_IDENTITY_UNKNOWN", "provider", provider, 600, 590));
});

test("a foreign birth reusing a recorded PID inside the owned group is refused before persistence", () => {
  const fixture = new SnapshotFixture();
  fixture.group = [stat(launcher), stat(descendant, { startFingerprint: 9999 })];
  let persisted = false;
  assert.throws(() => fixture.snapshot({ persistMembers() { persisted = true; } }),
    diagnosticFailure("PROCESS_EXECUTION_IDENTITY_UNKNOWN", "descendant", descendant));
  assert.equal(persisted, false);
  assert.deepEqual(fixture.events, ["enumerate"]);
});

for (const failure of ["null", "reported-unavailable"]) {
  test(`${failure} group enumeration cannot confirm stop`, () => {
    const fixture = new SnapshotFixture();
    assert.throws(() => fixture.snapshot({ groupReader(groupId, reportUnavailable) {
      assert.equal(groupId, pgid);
      if (failure === "null") return null;
      reportUnavailable(Object.assign(new Error("proc enumeration denied"), { code: "EACCES" }));
      return [];
    } }), (error) => {
      assert.ok(error instanceof ProcessExecutionControlFailure);
      assert.equal(error.code, "PROCESS_EXECUTION_OBSERVATION_UNKNOWN");
      return true;
    });
    assert.deepEqual(fixture.events, []);
  });
}

test("a newly captured member is persisted before a later member observation fails", () => {
  const discovered = identity(413);
  const fixture = new SnapshotFixture();
  fixture.group = [stat(launcher), stat(discovered)];
  fixture.current.set(descendant.pid, Object.assign(new Error("stat unreadable"), { code: "EACCES" }));
  let persisted = null;
  assert.throws(() => fixture.snapshot({ persistMembers(members) {
    fixture.events.push("persist");
    persisted = [...members];
  } }), diagnosticFailure("PROCESS_EXECUTION_OBSERVATION_UNKNOWN", "descendant", descendant));
  assert.deepEqual(persisted, [launcher, descendant, discovered]);
  assert.ok(fixture.events.indexOf("persist") < fixture.events.indexOf(`observe:${descendant.pid}`));
});

test("a typed member-save failure prevents observation and propagates the refusal", () => {
  const discovered = identity(413);
  const fixture = new SnapshotFixture();
  fixture.group = [stat(launcher), stat(discovered)];
  const failure = new ProcessExecutionControlFailure("record-save-failed", "member publication failed", { executionId, callId });
  let attemptedMembers = null;
  assert.throws(() => fixture.snapshot({ persistMembers(members) {
    attemptedMembers = [...members];
    throw failure;
  } }), (error) => {
    assert.equal(error, failure);
    assert.equal(error.code, "PROCESS_EXECUTION_RECORD_SAVE_FAILED");
    return true;
  });
  assert.deepEqual(attemptedMembers, [launcher, descendant, discovered]);
  assert.deepEqual(fixture.events, ["enumerate"]);
});

test("birth-only live observations refuse membership and termination decisions", () => {
  const fixture = new SnapshotFixture();
  const identitySource = new ProcessIdentitySource({
    platform: "linux", readBootIdentity: () => "snapshot-test-boot",
    readProcessStartFingerprint: () => launcher.startFingerprint,
    readProcessStat: () => assert.fail("birth-only DI must not add a second stat snapshot"),
  });
  assert.throws(() => fixture.snapshot({ identitySource }),
    diagnosticFailure("PROCESS_EXECUTION_OBSERVATION_UNKNOWN", "launcher", launcher));
});
