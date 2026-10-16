import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MigrationFlowIdentityIndex } from "../../src/lib/migration-flow-authority.js";

class IndexClaim {
  constructor(index, overrides = {}) {
    this.specId = `001-spec-${index}`;
    this.flowId = `flow-${index}`;
    this.version = 1;
    this.flowVersionId = `version-${index}`;
    this.runId = `run-${index}`;
    Object.assign(this, overrides);
  }
}

const codes = (index, identity, options) => index.collisionsFor(identity, options).map((error) => error.code);

describe("migration identity collision index", () => {
  it("allows one logical Flow across distinct physical Versions and excludes only the queried claim", () => {
    const claims = Array.from({ length: 128 }, (_, index) => new IndexClaim(index, {
      specId: "001-shared", flowId: "shared-flow", version: index + 1,
    }));
    const index = new MigrationFlowIdentityIndex(claims);
    for (const claim of claims) assert.deepEqual(codes(index, claim), []);
    const duplicate = new IndexClaim(200, { specId: "001-shared", runId: claims[0].runId });
    const withDuplicate = new MigrationFlowIdentityIndex([...claims, duplicate]);
    assert.deepEqual(codes(withDuplicate, claims[0]), ["RUN_ID_COLLISION"]);
    assert.deepEqual(codes(withDuplicate, duplicate), ["RUN_ID_COLLISION"]);
  });

  it("reports every affected identity and all collision dimensions in stable priority order", () => {
    const claims = Array.from({ length: 128 }, (_, index) => new IndexClaim(index, {
      flowId: "shared-flow", flowVersionId: "shared-version", runId: "shared-run",
    }));
    const index = new MigrationFlowIdentityIndex(claims);
    for (const claim of claims) assert.deepEqual(codes(index, claim), [
      "FLOW_ID_CROSS_SPEC_COLLISION", "FLOW_VERSION_TUPLE_COLLISION", "FLOW_VERSION_ID_COLLISION", "RUN_ID_COLLISION",
    ]);
  });

  it("finds foreign claims beyond a large selected-Spec group without excluding same-Spec collisions locally", () => {
    const selected = new IndexClaim(0);
    const own = Array.from({ length: 128 }, (_, index) => new IndexClaim(index, {
      specId: selected.specId, runId: selected.runId,
    }));
    const local = new MigrationFlowIdentityIndex(own);
    assert.deepEqual(codes(local, selected, { excludeSpecId: selected.specId }), []);
    assert.deepEqual(codes(local, own[0]), ["RUN_ID_COLLISION"]);
    const foreign = new IndexClaim(500, { runId: selected.runId });
    const neighbors = new MigrationFlowIdentityIndex([...own, foreign]);
    assert.deepEqual(codes(neighbors, selected, { excludeSpecId: selected.specId }), ["RUN_ID_COLLISION"]);
  });

  it("bounds identity-field access for both distinct and fully colliding inputs as their size grows", () => {
    for (const colliding of [false, true]) {
      const samples = [];
      for (const size of [64, 128, 256]) {
        let accesses = 0;
        const claims = Array.from({ length: size }, (_, ordinal) => new Proxy(new IndexClaim(ordinal, colliding ? {
          flowId: "shared-flow", flowVersionId: "shared-version", runId: "shared-run",
        } : {}), { get(target, key) { accesses++; return Reflect.get(target, key); } }));
        const index = new MigrationFlowIdentityIndex(claims);
        for (const claim of claims) assert.equal(index.collisionsFor(claim).length, colliding ? 4 : 0);
        samples.push(accesses);
      }
      assert.ok(samples[1] <= samples[0] * 2 + 32, JSON.stringify(samples));
      assert.ok(samples[2] <= samples[0] * 4 + 64, JSON.stringify(samples));
    }
  });
});
