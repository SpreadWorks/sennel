import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { RuntimePackageWireDelivery } from "../../src/lib/runtime-package-wire-delivery.js";

test("compressed runtime bytes preserve content and immutable RPC fields", () => {
  const serialized = JSON.stringify({ resources: [["sample", "captured bytes"]] });
  const revision = "a".repeat(64);
  const delivery = new RuntimePackageWireDelivery(serialized, revision);
  const compressed = delivery.compressedBytes();
  assert.equal(gunzipSync(compressed, { maxOutputLength: delivery.decodedByteLength }).toString(), serialized);
  assert.deepEqual(delivery.toJSON(), {
    schemaVersion: 1, encoding: "gzip-base64", revision,
    decodedByteLength: Buffer.byteLength(serialized),
    digest: createHash("sha256").update(serialized).digest("hex"),
    body: compressed.toString("base64"),
  });
  compressed.fill(0);
  assert.equal(gunzipSync(delivery.compressedBytes()).toString(), serialized);
});

test("owned compressed bytes retain capacity beyond the separate RPC frame bound", () => {
  const serialized = JSON.stringify({ resources: ["x".repeat(33 * 1024 * 1024)] });
  const delivery = new RuntimePackageWireDelivery(serialized, "b".repeat(64));
  assert.equal(gunzipSync(delivery.compressedBytes(), { maxOutputLength: delivery.decodedByteLength }).toString(), serialized);
  assert.throws(() => delivery.toJSON(), /existing decoded byte bound/);
});
