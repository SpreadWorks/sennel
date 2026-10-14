import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { LinuxProcessStat, ProcessIdentity, ProcessIdentityObservation, ProcessIdentitySource } from "../../src/lib/process-identity.js";

const ownerToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function statText({ pid = 73, state = "S", pgrp = 60, sessionId = 60, startFingerprint = 441 } = {}) {
  const fields = Array(20).fill("0");
  fields[0] = state;
  fields[1] = "1";
  fields[2] = String(pgrp);
  fields[3] = String(sessionId);
  fields[19] = String(startFingerprint);
  return `${pid} (command (with spaces)) ${fields.join(" ")}\n`;
}

function owner() {
  return new ProcessIdentity({ pid: 73, bootIdentity: "test-boot", startFingerprint: "441", ownerToken });
}

function source(options = {}) {
  return new ProcessIdentitySource({ platform: "linux", pid: 73, readBootIdentity: () => "test-boot", ...options });
}

function fakeStatFile(t, content) {
  let reads = 0;
  let closes = 0;
  t.mock.method(fs, "openSync", (file, mode) => {
    assert.equal(file, "/proc/73/stat");
    assert.equal(mode, "r");
    return 97;
  });
  t.mock.method(fs, "readSync", (descriptor, buffer, offset, length, position) => {
    assert.equal(descriptor, 97);
    assert.equal(offset, 0);
    assert.equal(position, 0);
    assert.ok(length <= 4097, "the OS read itself must be bounded");
    reads += 1;
    const current = typeof content === "function" ? content(reads) : content;
    if (current instanceof Error) throw current;
    return Buffer.from(current).copy(buffer, offset, 0, length);
  });
  t.mock.method(fs, "closeSync", (descriptor) => {
    assert.equal(descriptor, 97);
    closes += 1;
  });
  return { reads: () => reads, closes: () => closes };
}

test("LinuxProcessStat parses birth, state, process group and session from one stat value", () => {
  const stat = LinuxProcessStat.parse(statText({ state: "R", pgrp: 51, sessionId: 49 }));
  assert.ok(stat instanceof LinuxProcessStat);
  assert.deepEqual([stat.pid, stat.state, stat.pgrp, stat.sessionId, stat.startFingerprint], [73, "R", 51, 49, 441]);
  assert.equal(Object.isFrozen(stat), true);
  assert.throws(() => { stat.sessionId = 50; }, TypeError);
});

test("LinuxProcessStat rejects malformed or missing session identity", () => {
  for (const sessionId of ["-1", "session", "1.5", "9007199254740992"]) {
    assert.throws(() => LinuxProcessStat.parse(statText({ sessionId })));
  }
  assert.throws(() => new LinuxProcessStat({ pid: 73, state: "S", pgrp: 60, startFingerprint: 441 }));
});

test("a default observation retains exactly one bounded stat snapshot without a second fingerprint read", (t) => {
  const files = fakeStatFile(t, (read) => statText(read === 1
    ? { pgrp: 73, sessionId: 73 } : { startFingerprint: 442, pgrp: 99, sessionId: 99 }));
  const observed = source().observe(owner());
  assert.ok(observed instanceof ProcessIdentityObservation);
  assert.equal(observed.status, "live");
  assert.equal(observed.terminated, false);
  assert.deepEqual([observed.stat.startFingerprint, observed.stat.pgrp, observed.stat.sessionId], [441, 73, 73]);
  assert.equal(files.reads(), 1);
  assert.equal(files.closes(), 1);
});

test("an observation classifies the birth against a single boot identity read", () => {
  let bootReads = 0;
  const identities = source({
    readBootIdentity: () => (++bootReads === 1 ? "test-boot" : "another-boot"),
    readProcessStat: () => LinuxProcessStat.parse(statText()),
  });
  const observed = identities.observe(owner());
  assert.equal(observed.status, "live");
  assert.equal(observed.stat.startFingerprint, 441);
  assert.equal(bootReads, 1);
});

test("owner creation and observation share the stat reader while group and session can change for the same birth", () => {
  let current = LinuxProcessStat.parse(statText());
  let reads = 0;
  const identities = source({ readProcessStat(pid) { assert.equal(pid, 73); reads += 1; return current; } });
  const created = identities.createOwner(ownerToken);
  assert.equal(created.sameBirth(owner()), true);
  assert.equal(identities.observe(created).stat.pgrp, 60);
  current = LinuxProcessStat.parse(statText({ pgrp: 73, sessionId: 73 }));
  const moved = identities.observe(created);
  assert.equal(moved.status, "live");
  assert.equal(moved.terminated, false);
  assert.deepEqual([moved.stat.pgrp, moved.stat.sessionId], [73, 73]);
  assert.equal(identities.readProcessStartFingerprint(73), "441");
  assert.equal(reads, 4);
});

test("owner creation refuses stat bytes identifying another PID", (t) => {
  const files = fakeStatFile(t, statText({ pid: 74 }));
  assert.throws(() => source().createOwner(ownerToken), { code: "PROCESS_IDENTITY_UNAVAILABLE" });
  assert.equal(files.reads(), 1);
  assert.equal(files.closes(), 1);
});

for (const state of ["Z", "X"]) {
  test(`same-birth ${state} proves process termination while keeping the lock owner live`, () => {
    const identities = source({ readProcessStat: () => LinuxProcessStat.parse(statText({ state })) });
    const observed = identities.observe(owner());
    assert.equal(observed.status, "live");
    assert.equal(observed.terminated, true);
    assert.equal(observed.stat.state, state);
    assert.equal(identities.assess(owner()).status, "live");
  });
}

test("observations enforce immutable status and stat ownership invariants", () => {
  const stat = LinuxProcessStat.parse(statText());
  const observed = new ProcessIdentityObservation("live", "same birth", stat);
  assert.equal(Object.isFrozen(observed), true);
  assert.throws(() => { observed.status = "stale"; }, TypeError);
  for (const invalid of [
    () => new ProcessIdentityObservation("other", "reason"),
    () => new ProcessIdentityObservation("live", " "),
    () => new ProcessIdentityObservation("live", "reason", {}),
    () => new ProcessIdentityObservation("stale", "reason", stat),
    () => new ProcessIdentityObservation("unknown", "reason", stat),
  ]) assert.throws(invalid);
  assert.equal(new ProcessIdentityObservation("unknown", "unreadable").terminated, false);
  assert.equal(new ProcessIdentityObservation("stale", "missing").terminated, true);
});

test("another boot is stale without observing the PID in that boot", () => {
  let reads = 0;
  const identities = source({ readBootIdentity: () => "another-boot", readProcessStat() { reads += 1; return LinuxProcessStat.parse(statText()); } });
  const observed = identities.observe(owner());
  assert.equal(observed.status, "stale");
  assert.equal(observed.terminated, true);
  assert.equal(observed.stat, null);
  assert.equal(reads, 0);
  assert.equal(identities.assess(owner()).status, "stale");
});

test("a reused PID is stale and never exposes its new birth as owned stat", () => {
  const identities = source({ readProcessStat: () => LinuxProcessStat.parse(statText({ startFingerprint: 442 })) });
  const observed = identities.observe(owner());
  assert.equal(observed.status, "stale");
  assert.equal(observed.terminated, true);
  assert.equal(observed.stat, null);
  assert.equal(identities.assess(owner()).status, "stale");
});

for (const code of ["ENOENT", "ESRCH"]) {
  test(`${code} confirms the recorded birth is stale`, (t) => {
    const files = fakeStatFile(t, Object.assign(new Error("no process"), { code }));
    const observed = source().observe(owner());
    assert.equal(observed.status, "stale");
    assert.equal(observed.terminated, true);
    assert.equal(observed.stat, null);
    assert.equal(files.closes(), 1);
  });
}

for (const [name, content] of [
  ["unreadable", Object.assign(new Error("permission denied"), { code: "EACCES" })],
  ["oversized", "x".repeat(4097)],
  ["truncated", "73 (command) S 1 60 60"],
  ["invalid fingerprint", statText({ startFingerprint: "bad" })],
  ["invalid session", statText({ sessionId: "bad" })],
  ["another PID", statText({ pid: 74 })],
]) {
  test(`${name} stat is unknown and cannot confirm termination`, (t) => {
    const files = fakeStatFile(t, content);
    const observed = source().observe(owner());
    assert.equal(observed.status, "unknown");
    assert.equal(observed.terminated, false);
    assert.equal(observed.stat, null);
    assert.equal(files.reads(), 1);
    assert.equal(files.closes(), 1);
  });
}

test("unknown boot and unsupported platforms do not inspect process membership", () => {
  for (const identities of [
    source({ readBootIdentity() { throw new Error("boot unavailable"); } }),
    source({ platform: "other" }),
  ]) {
    identities.readProcessStat = () => assert.fail("must not inspect a process without boot identity");
    assert.equal(identities.observe(owner()).status, "unknown");
    assert.equal(identities.observe(owner()).terminated, false);
    assert.equal(identities.assess(owner()).status, "unknown");
  }
});

test("injected fingerprint-only identities retain lock semantics without mixing in membership reads", () => {
  let fingerprint = "441";
  const identities = source({
    readProcessStartFingerprint: () => fingerprint,
    readProcessStat: () => assert.fail("birth-only DI must not read independent membership"),
  });
  const created = identities.createOwner(ownerToken);
  assert.equal(created.sameBirth(owner()), true);
  assert.equal(identities.assess(created).status, "live");
  assert.equal(identities.observe(created).stat, null);
  assert.equal(identities.observe(created).terminated, false);
  fingerprint = "442";
  assert.equal(identities.assess(created).status, "stale");
  assert.equal(identities.observe(created).terminated, true);
});

test("fingerprint-only DI keeps missing and unreadable births distinct for locks", () => {
  for (const [code, status] of [["ENOENT", "stale"], ["ESRCH", "stale"], ["EACCES", "unknown"]]) {
    const identities = source({
      readProcessStartFingerprint() { throw Object.assign(new Error("unavailable"), { code }); },
      readProcessStat: () => assert.fail("birth-only DI must not inspect independent stat"),
    });
    const assessment = identities.assess(owner());
    assert.equal(assessment.status, status);
    assert.equal(assessment.stat, null);
    assert.equal(assessment.terminated, status === "stale");
  }
});
