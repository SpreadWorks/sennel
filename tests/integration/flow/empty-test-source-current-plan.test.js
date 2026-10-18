import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { FlowArtifactCatalog } from "../../../src/lib/flow-version.js";
import { CanonicalTestSourceRevision, CanonicalTestSourceProvenanceError } from "../../../src/flow/lib/canonical-test-artifacts.js";

class ProducedEmptyTestSource {
  constructor(label) {
    this.fixture = JSON.parse(fs.readFileSync(new URL(`./fixtures/empty-test-source-current-plan-${label}.json`, import.meta.url)));
    for (const file of Object.values(this.fixture.files)) {
      assert.equal(createHash("sha256").update(file.text).digest("hex"), file.sha256);
    }
    this.state = JSON.parse(this.fixture.files["flow.json"].text);
    this.catalog = new FlowArtifactCatalog(JSON.parse(this.fixture.files["artifact-catalog.json"].text));
    this.activities = this.fixture.files["activities.jsonl"].text.trim().split("\n").map(line => JSON.parse(line));
    this.plan = this.catalog.artifacts.find(entry => entry.logicalKey === "test.requirement.plan");
    this.producer = this.activities.find(entry => entry.id === this.plan.activityId);
  }
  revision({ catalog = this.catalog, activities = this.activities, replacements = {} } = {}) {
    return CanonicalTestSourceRevision.fromCatalog({ state: this.state, catalog, activities,
      readCatalogedArtifact: descriptor => {
        const bytes = Buffer.from(replacements[descriptor.relativePath] ?? this.fixture.files[descriptor.relativePath].text);
        if (!Object.hasOwn(replacements, descriptor.relativePath)) {
          assert.equal(createHash("sha256").update(bytes).digest("hex"), descriptor.hash);
          assert.equal(bytes.length, descriptor.size);
        }
        return bytes;
      } });
  }
}
const unavailable = error => error instanceof CanonicalTestSourceProvenanceError
  && error.code === "CANONICAL_TEST_SOURCE_REVISION_UNAVAILABLE";
for (const label of ["reopened", "deferred"]) {
  test(`the genuine ${label} plan finalizes its empty source through its exact current producer`, () => {
    const input = new ProducedEmptyTestSource(label);
    const before = JSON.stringify(input);
    const revision = input.revision();
    assert.equal(revision.members.length, 0);
    assert.equal(revision.finalizedAt, input.producer.result.confirmedAt);
    assert.deepEqual(input.revision().toJSON(), revision.toJSON());
    assert.equal(JSON.stringify(input), before);
  });
  test(`the ${label} plan cannot borrow a missing or duplicate producer`, () => {
    const input = new ProducedEmptyTestSource(label);
    assert.throws(() => input.revision({ activities: input.activities.filter(entry => entry.id !== input.producer.id) }), unavailable);
    assert.throws(() => input.revision({ activities: [...input.activities, input.producer] }), unavailable);
    assert.throws(() => input.revision({ catalog: { artifacts: input.catalog.artifacts.filter(entry => entry !== input.plan) } }), unavailable);
  });
}
test("an all-deferred plan requires every real deferred receipt", () => {
  const input = new ProducedEmptyTestSource("deferred");
  assert.throws(() => input.revision({ catalog: { artifacts: input.catalog.artifacts.filter(entry => entry.logicalKey !== "test.requirement.deferred") } }), unavailable);
});
test("a promoted Requirement cannot disappear into an empty catalog", () => {
  const input = new ProducedEmptyTestSource("deferred");
  const plan = JSON.parse(input.fixture.files[input.plan.relativePath].text);
  plan.plan.workItems[0].status = "promoted";
  assert.throws(() => input.revision({ catalog: { artifacts: input.catalog.artifacts.filter(entry => entry.logicalKey !== "test.requirement.deferred") },
    replacements: { [input.plan.relativePath]: JSON.stringify(plan) } }), unavailable);
});
