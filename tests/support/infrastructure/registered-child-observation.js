import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { ProcessExecutorIdentity, ChildExitObservation } from "../../../src/lib/process-execution-values.js";
import { CommandInvocation } from "../../../src/lib/command-invocation.js";

/** One real registered handle, its launch authority and observed output/exit.
 * Request identity, fault policy, finalization and cleanup belong to the scenario. */
export class RegisteredChildObservation {
  constructor(runtime, invocation) {
    if (!(invocation instanceof CommandInvocation)) throw new TypeError("Registered child requires its typed invocation");
    this.runtime = runtime;
    this.invocation = invocation;
    this.executor = new ProcessExecutorIdentity({ executorId: randomUUID(), executorSession: randomUUID(), launchClaim: randomUUID() });
  }
  static async produce(runtime, invocation, observeStarted) {
    const producer = new this(runtime, invocation);
    producer.call = await runtime.reserveCall({ invocation: invocation.toJSON() });
    producer.permit = await runtime.claimLaunch(producer.call, { executor: producer.executor });
    producer.child = spawn(invocation.executable, invocation.args, { ...invocation.processOptions(), shell: false });
    const terminal = once(producer.child, "exit").then(([code, signal]) => new ChildExitObservation({
      executor: producer.executor, kind: "exited", code, signal, observedAt: new Date().toISOString() }));
    const drained = once(producer.child, "close"), stdout = [], stderr = [];
    producer.child.stdout.on("data", bytes => stdout.push(bytes));
    producer.child.stderr.on("data", bytes => stderr.push(bytes));
    await once(producer.child, "spawn");
    await observeStarted(producer.call, { type: "started", executor: producer.executor.toJSON(), startedAt: new Date().toISOString() });
    producer.observation = await terminal;
    await drained;
    producer.stdout = Buffer.concat(stdout);
    producer.stderr = Buffer.concat(stderr);
    return producer;
  }
}
