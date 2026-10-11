import assert from "node:assert/strict";
import { test } from "node:test";
import { GitRefObservation, GitRefProbeError } from "../../src/lib/git-helpers.js";

const ref = "refs/heads/feature";
const oid = "a".repeat(40);

test("a successful inventory proves the exact ref OID and excludes descendants", () => {
  const observation = GitRefObservation.fromResult(ref, {
    ok: true, stdout: `${ref}/child ${"b".repeat(40)}\n${ref} ${oid}\n`,
  });
  assert.equal(observation.ref, ref);
  assert.equal(observation.oid, oid);
  assert.equal(observation.present, true);
  assert.equal(observation.absent, false);
  assert.equal(Object.isFrozen(observation), true);
});

test("successful empty and descendant-only inventories prove exact absence", () => {
  for (const stdout of ["", `${ref}/child ${oid}\n`]) {
    const observation = GitRefObservation.fromResult(ref, { ok: true, stdout });
    assert.equal(observation.oid, null);
    assert.equal(observation.absent, true);
    assert.equal(observation.present, false);
  }
});

test("failed inventory retains the Git failure instead of proving absence", () => {
  const result = { ok: false, status: 128, stdout: "", stderr: "ref database IO failure", signal: null };
  assert.throws(() => GitRefObservation.fromResult(ref, result), (error) => {
    assert.ok(error instanceof GitRefProbeError);
    assert.equal(error.code, "GIT_REF_PROBE_FAILED");
    assert.equal(error.ref, ref);
    assert.equal(error.result, result);
    assert.match(error.message, /ref database IO failure/);
    return true;
  });
});

test("malformed or duplicate exact inventory entries cannot certify an observation", () => {
  for (const stdout of [`${ref} invalid\n`, `${ref} ${oid}\n${ref} ${oid}\n`, "truncated\n"]) {
    const result = { ok: true, stdout, stderr: "" };
    assert.throws(() => GitRefObservation.fromResult(ref, result), (error) => {
      assert.ok(error instanceof GitRefProbeError);
      assert.equal(error.code, "GIT_REF_PROBE_FAILED");
      assert.equal(error.result, result);
      return true;
    });
  }
});

test("a ref observation enforces a full name and Git object ID", () => {
  assert.throws(() => new GitRefObservation({ ref: "feature", oid }));
  assert.throws(() => new GitRefObservation({ ref, oid: "invalid" }));
  const sha256 = GitRefObservation.fromResult(ref, { ok: true, stdout: `${ref} ${"b".repeat(64)}\n` });
  assert.equal(sha256.oid, "b".repeat(64));
});
