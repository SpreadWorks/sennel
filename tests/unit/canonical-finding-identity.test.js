import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CanonicalFindingFingerprint,
  CanonicalFindingIdentity,
} from "../../src/flow/lib/canonical-finding-identity.js";
import { ReviewFindingFingerprint } from "../../src/flow/lib/finding-disposition-policy.js";

describe("canonical finding identity and fingerprint", () => {
  it("normalizes folded, case-preserving, and path fields independently", () => {
    const identity = new CanonicalFindingIdentity({
      semantic: "  Mixed\t  Case  ",
      observed: "  MiXeD\t  Case  ",
      file: "  src\\Flow\\finding.js  ",
    }, {
      caseFoldedFields: ["semantic"],
      casePreservingFields: ["observed"],
      pathFields: ["file"],
    });

    assert.deepEqual(identity.toJSON(), {
      semantic: "mixed case",
      observed: "MiXeD Case",
      file: "src/Flow/finding.js",
    });
  });

  it("keeps explicitly selected preserving fields byte-stable while collapsing no whitespace", () => {
    const identity = new CanonicalFindingIdentity({
      providerId: " Provider  ID ",
      title: " Provider  ID ",
    }, {
      casePreservingFields: ["providerId"],
      caseFoldedFields: ["title"],
      preserveWhitespaceFields: ["providerId"],
    });

    assert.deepEqual(identity.toJSON(), {
      providerId: "Provider  ID",
      title: "provider id",
    });
  });

  it("serializes fields in deterministic order and hashes the canonical value", () => {
    const first = new CanonicalFindingIdentity({ first: "One", second: "Two" });
    const second = new CanonicalFindingIdentity({ second: "Two", first: "One" });

    assert.equal(first.serialize(), '{"first":"one","second":"two"}');
    assert.equal(first.equals(second), true);
    assert.equal(CanonicalFindingFingerprint.fromIdentity(first).value,
      "57586a4461d89888bcf195b82076f50967c6d60d114cd37f850e254034d0dd12");
  });

  it("rejects invalid fingerprints", () => {
    assert.throws(() => new CanonicalFindingFingerprint("A".repeat(64)), /lowercase SHA-256/);
    assert.throws(() => new CanonicalFindingFingerprint("a".repeat(63)), /lowercase SHA-256/);
    assert.throws(() => CanonicalFindingFingerprint.fromIdentity({ serialize: () => "{}" }), /CanonicalFindingIdentity/);
  });

  it("preserves Review fingerprint acceptance, tuple hashing, and legacy finding hashing", () => {
    const supplied = "a".repeat(64);
    const accepted = ReviewFindingFingerprint.fromFinding({ fingerprint: supplied });
    assert.ok(accepted instanceof ReviewFindingFingerprint);
    assert.equal(accepted.toString(), supplied);
    assert.equal(accepted.toJSON(), supplied);
    assert.equal(accepted.equals(new ReviewFindingFingerprint(supplied)), true);
    assert.throws(
      () => new ReviewFindingFingerprint(new CanonicalFindingFingerprint(supplied)),
      /lowercase SHA-256/,
    );

    assert.equal(
      ReviewFindingFingerprint.fromCanonicalTuple(["target", "blocking", "title", "details"]).value,
      "6d750eabe7123b289a58cb4e976d8ee36cd03bc47d651c049ea7bc9d2871cfad",
    );
    assert.equal(
      ReviewFindingFingerprint.fromFinding({
        scope: " FLOW ",
        phase: "Impl  Review",
        taskId: " T-1 ",
        category: "Maintainability",
        failureMode: "Missing  Evidence",
        requirementId: "R1",
        guardrailId: null,
        findingKey: " Key ",
        file: "src\\flow\\gate.js",
        location: "Line 42",
        rootCause: "Cause",
      }).value,
      "6a99e044d4fc5a5526af68c35cb805a8211518e4cbfc543f4fd4d892308ad941",
    );
  });
});
