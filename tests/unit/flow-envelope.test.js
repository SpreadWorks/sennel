/**
 * Tests for the Envelope class (src/lib/flow-envelope.js).
 *
 * Envelope is the unified result type for flow get/set/run commands.
 * It encapsulates ok/fail/warn construction, JSON serialization,
 * and stdout output + process.exitCode side effects.
 *
 * Spec 187 R5: Envelope OOP化.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import * as envelopeModule from "../../src/lib/flow-envelope.js";

const { Envelope } = envelopeModule;

describe("Envelope", () => {
  it("does not expose the retired function API", () => {
    assert.equal(typeof envelopeModule.ok, "undefined");
    assert.equal(typeof envelopeModule.fail, "undefined");
    assert.equal(typeof envelopeModule.warn, "undefined");
    assert.equal(typeof envelopeModule.output, "undefined");
  });

  describe("static ok", () => {
    it("returns an Envelope instance with ok=true and empty errors", () => {
      const env = Envelope.ok("get", "status", { foo: 1 });
      assert.equal(env instanceof Envelope, true);
      const j = env.toJSON();
      assert.deepEqual(j, {
        ok: true,
        type: "get",
        key: "status",
        data: { foo: 1 },
        errors: [],
      });
    });
  });

  describe("static fail", () => {
    it("accepts a string message and wraps into errors[].messages", () => {
      const env = Envelope.fail("set", "step", "BAD_INPUT", "missing arg");
      const j = env.toJSON();
      assert.equal(j.ok, false);
      assert.equal(j.type, "set");
      assert.equal(j.key, "step");
      assert.equal(j.data.directive.kind, "single_user_action");
      assert.equal(j.guidance.code, "BAD_INPUT");
      assert.equal(j.errors.length, 1);
      assert.equal(j.errors[0].level, "fatal");
      assert.equal(j.errors[0].code, "BAD_INPUT");
      assert.deepEqual(j.errors[0].messages, ["missing arg"]);
    });

    it("accepts an array of messages without re-wrapping", () => {
      const env = Envelope.fail("run", "gate", "ERR", ["a", "b"]);
      assert.deepEqual(env.toJSON().errors[0].messages, ["a", "b"]);
    });
  });

  describe("static warn", () => {
    it("returns ok=true with warn-level entry in errors", () => {
      const env = Envelope.warn("run", "gate", { result: "pass" }, "POST_HOOK_FAIL", "hook x failed");
      const j = env.toJSON();
      assert.equal(j.ok, true);
      assert.deepEqual(j.data, { result: "pass" });
      assert.equal(j.errors.length, 1);
      assert.equal(j.errors[0].level, "warn");
      assert.equal(j.errors[0].code, "POST_HOOK_FAIL");
      assert.deepEqual(j.errors[0].messages, ["hook x failed"]);
    });
  });

  describe("addWarning", () => {
    it("appends a warn entry to an existing ok envelope", () => {
      const env = Envelope.ok("run", "gate", { result: "pass" });
      env.addWarning("POST_HOOK_FAIL", "hook x failed");
      const j = env.toJSON();
      assert.equal(j.ok, true);
      assert.equal(j.errors.length, 1);
      assert.equal(j.errors[0].level, "warn");
    });

    it("does not flip ok=false when added", () => {
      const env = Envelope.ok("run", "gate", {});
      env.addWarning("X", "y");
      assert.equal(env.toJSON().ok, true);
    });
  });

  describe("output", () => {
    let originalLog;
    let originalExitCode;
    let captured;

    beforeEach(() => {
      originalLog = console.log;
      originalExitCode = process.exitCode;
      captured = [];
      console.log = (...args) => captured.push(args.join(" "));
    });

    afterEach(() => {
      console.log = originalLog;
      process.exitCode = originalExitCode;
    });

    it("writes JSON to stdout and sets exitCode=0 for ok envelopes", () => {
      const env = Envelope.ok("get", "status", { x: 1 });
      env.output();
      assert.equal(captured.length, 1);
      const parsed = JSON.parse(captured[0]);
      assert.equal(parsed.ok, true);
      assert.deepEqual(parsed.data, { x: 1 });
      assert.equal(process.exitCode, 0);
    });

    it("writes JSON to stdout and sets exitCode=1 for fail envelopes", () => {
      const env = Envelope.fail("set", "step", "ERR", "bad");
      env.output();
      assert.equal(captured.length, 1);
      assert.equal(process.exitCode, 1);
    });

    it("preserves exitCode=0 for ok-with-warn envelopes", () => {
      const env = Envelope.warn("run", "gate", { result: "pass" }, "X", "y");
      env.output();
      assert.equal(process.exitCode, 0);
    });
  });
});
