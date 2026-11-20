import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { ProcessExecutionStopReceipt } from "../../../src/lib/process-execution-values.js";
import { FlowProcessQueryReadback } from "../../support/infrastructure/flow-process-query-readback.js";
import { fixtureRepository } from "../../support/infrastructure/flow-dispatch-scenario.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { ProcessRuntimeFlowScenario } from "../../support/infrastructure/process-runtime-flow-scenario.js";

let seed;
before(() => {
  seed = fixtureRepository("registered-command-lineage-seed-");
  fs.mkdirSync(path.join(seed, ".sennel"), { recursive: true });
});
after(() => { if (seed) removeTmpDir(seed); });

function lineage(execution, leafScript) {
  const leaf = execution.calls.find(call => call.invocation.actualCommand?.args?.[0] === leafScript);
  assert.ok(leaf, "the leaf must have its own registered call");
  const chain = [leaf];
  while (chain.at(-1).parentCallId !== null) {
    const parent = execution.calls.find(call => call.callId === chain.at(-1).parentCallId);
    assert.ok(parent, "every registered parent must survive storage");
    chain.push(parent);
  }
  return chain;
}

for (const stop of [false, true]) {
  test(`public provider command with explicit 5s grace registers its child and grandchild with durable ${stop ? "leaf-first stop" : "completion"}, replay and query`,
    { timeout: 900000 }, async t => {
      const scenario = new ProcessRuntimeFlowScenario(seed, { test: t, sealed: true,
        commandLineage: true, stopLineage: stop });
      t.diagnostic(`Registered command fixture: ${scenario.root}`);
      const dispatcher = await scenario.startProvider();
      const initial = ProcessExecutionRuntime.inspect({ mainRoot: scenario.root });
      const pending = initial.executions.find(entry => entry.executionId === initial.slot);
      const pendingChain = lineage(pending, scenario.lineage.leaf);
      assert.equal(pendingChain.length, 4, "provider → public wrapper → child → registered grandchild are registered");
      assert.equal(pendingChain.at(-1).invocation.kind, "provider");
      for (const call of pendingChain) {
        assert.equal(call.receipt, null, "a registered descendant still runs before release");
        assert.deepEqual(call.binding, pendingChain.at(-1).binding);
      }
      assert.deepEqual(pendingChain[0].invocation.actualCommand.args,
        [scenario.lineage.leaf, ...scenario.lineage.argv]);
      assert.deepEqual(pendingChain[1].invocation.actualCommand.args, [scenario.lineage.child, ...scenario.lineage.argv]);
      assert.deepEqual(pendingChain[2].invocation.actualCommand.args, scenario.lineage.wrapperArgs);
      assert.equal(pendingChain[2].graceMs, 5000, "the producer chooses the public stop grace before launch");
      const before = scenario.snapshot();
      assert.equal(before.activities.some(activity => activity.result?.artifactRefs?.some(ref => ref.kind === "worker-handoff")), false);
      assert.deepEqual(fs.readFileSync(scenario.lineage.effect, "utf8").trimEnd().split("\n").map(JSON.parse), [scenario.lineage.argv]);

      if (!stop) scenario.releaseMember();
      scenario.releaseProvider();
      const completed = await dispatcher.result;
      if (!fs.existsSync(scenario.memberExited)) t.diagnostic(JSON.stringify({
        status: completed.status, errors: completed.envelope?.errors,
        evidenceDirectory: scenario.preserveFailureEvidence("lineage-missing-completion"),
      }));
      assert.equal(fs.existsSync(scenario.memberExited), true, "the actual command outcome must be recorded");
      const member = JSON.parse(fs.readFileSync(scenario.memberExited, "utf8"));
      if (member.failure || member.receipt === null) t.diagnostic(JSON.stringify({ failure: member.failure, causes: member.causes,
        evidenceDirectory: scenario.preserveFailureEvidence("lineage") }));
      assert.equal(member.failure, undefined, JSON.stringify(member.causes));
      assert.notEqual(member.receipt, null);
      assert.equal(member.errorCode, stop ? "ABORT_ERR" : null);
      assert.equal(completed.status, 0, JSON.stringify(completed.envelope?.errors));
      if (!stop) assert.equal(member.code, 0);
      const replay = JSON.parse(fs.readFileSync(scenario.lineage.replay, "utf8"));
      assert.deepEqual(replay.first, member.receipt);
      assert.deepEqual(replay.second, member.receipt);

      // Discard process-local state: the authoritative historical reader must
      // recover the same call tree, argv and typed receipts after owner close.
      const historical = ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: scenario.root });
      const saved = historical.executions.find(entry => entry.executionId === initial.slot);
      assert.equal(saved.status, "closed");
      const chain = lineage(saved, scenario.lineage.leaf);
      if (stop) {
        const initialStop = new ProcessExecutionStopReceipt(chain[2].receipt).stopOperation;
        assert.equal(initialStop.graceMs, 5000);
        assert.equal(initialStop.deadline, initialStop.startedAt + 12000,
          "the existing policy fixes the explicit 5s grace budget once, before replay");
      }
      assert.deepEqual(chain.map(call => [call.callId, call.parentCallId, call.binding]),
        pendingChain.map(call => [call.callId, call.parentCallId, call.binding]));
      assert.deepEqual(chain[0].invocation.actualCommand.args, [scenario.lineage.leaf, ...scenario.lineage.argv]);
      for (const [index, call] of chain.entries()) {
        const receipt = new ProcessExecutionStopReceipt(call.receipt);
        assert.equal(receipt.callId, call.callId);
        assert.equal(receipt.executionId, saved.executionId);
        assert.deepEqual(receipt.binding.toJSON(), call.binding);
        assert.equal(receipt.stopEvidence.confirmed, true);
        assert.equal(receipt.scope, "registered-executions");
        assert.ok(receipt.descendants.every(entry => saved.calls.some(registered => registered.callId === entry.callId)),
          "a receipt cannot claim closure of an unregistered external descendant");
        for (const event of saved.events.filter(entry => entry.callId === call.callId)) {
          assert.equal(event.parentCallId, call.parentCallId);
          assert.equal(event.rootCallId, chain.at(-1).callId);
          assert.deepEqual(event.binding, call.binding);
        }
        const finalized = saved.events.find(event => event.callId === call.callId && event.type === "result-finalized");
        assert.ok(finalized);
        if (index > 0) {
          const child = chain[index - 1];
          assert.ok(receipt.descendants.some(entry => entry.callId === child.callId));
          assert.ok(saved.events.find(event => event.callId === child.callId && event.type === "result-finalized").sequence < finalized.sequence,
            "the registered leaf closes before every parent");
        }
        if (stop && index < chain.length - 1) {
          assert.equal(receipt.stopOperation.reason, "abort");
          assert.equal(receipt.stopOperation.graceMs, 5000, "the original explicit grace propagates to every registered descendant");
          const requested = saved.events.filter(event => event.callId === call.callId && event.type === "stop-requested");
          assert.equal(requested.length, 1, "each registered command descendant receives one durable stop request");
          if (index > 0) {
            const childRequest = saved.events.find(event => event.callId === chain[index - 1].callId && event.type === "stop-requested");
            assert.ok(childRequest.sequence < requested[0].sequence, "stop requests reach the leaf before its registered parent");
          }
        }
      }
      const snapshot = scenario.snapshot();
      const events = saved.events.filter(event => chain.some(call => call.callId === event.callId));
      const activities = snapshot.activities.filter(activity => events.some(event => event.eventId === activity.processEvent?.eventId));
      assert.deepEqual(activities.map(activity => activity.processEvent.eventId), events.map(event => event.eventId));
      assert.equal(new Set(activities.map(activity => activity.id)).size, events.length);
      assert.equal(saved.eventAcknowledgements.filter(ack => events.some(event => event.eventId === ack.eventId)).length, events.length);
      const query = await FlowProcessQueryReadback.read(scenario.root, scenario.specId);
      for (const activity of activities) query.assertActivity(activity);
      assert.deepEqual(scenario.snapshot(), snapshot, "query and receipt readback must not publish again");
      assert.deepEqual(ProcessExecutionRuntime.readHistoricalInventory({ mainRoot: scenario.root }).executions.find(entry => entry.executionId === saved.executionId), saved);
      assert.equal(fs.readFileSync(scenario.count, "utf8"), "1");
      assert.deepEqual(fs.readFileSync(scenario.lineage.effect, "utf8").trimEnd().split("\n").map(JSON.parse), [scenario.lineage.argv]);
      scenario.assertAwaitingQuestionBoundary();
    });
}
