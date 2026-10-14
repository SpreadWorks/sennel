import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

import { SeedWorkRoot } from "../builders/seed-work-root.js";
import { CanonicalFlowFixture, canonicalDraftDocument, makeFlowManager } from "./flow-setup.js";
import { commitAll } from "./git-repo.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { ProcessExecutionRuntime } from "../../../src/lib/process-execution-runtime.js";
import { ProcessIdentity, ProcessIdentitySource } from "../../../src/lib/process-identity.js";
import { CandidateQuestion } from "../../../src/flow/lib/draft-question-ledger.js";
import { DraftLifecycle } from "../../../src/flow/lib/draft-lifecycle.js";
import { currentRuntimePackage, listRuntimeResources, readRuntimeResource,
  RuntimeChildExecution } from "../../../src/lib/runtime-package.js";

const CLI = path.resolve("src/sennel.js");
const SEMANTIC_CLI = path.resolve("src/cli-main.js");
const BOOTSTRAP = pathToFileURL(CLI).href;
const HANDOFF = pathToFileURL(path.resolve("src/flow/lib/worker-artifact-handoff.js")).href;
const GATE_FAKE = pathToFileURL(path.resolve("tests/support/infrastructure/flow-dispatch-scenario.js")).href;
const IDENTITY_SOURCE = pathToFileURL(path.resolve("src/lib/process-identity.js")).href;
const RUNTIME_PACKAGE = pathToFileURL(path.resolve("src/lib/runtime-package.js")).href;
const ATOMIC_FILE = pathToFileURL(path.resolve("src/lib/atomic-file.js")).href;
const FLOW_MANAGER = pathToFileURL(path.resolve("src/lib/flow-manager.js")).href;

/** Persist the exact parent bytes and Git context, separate from any fixture. */
export function recordProcessRuntimeFlowVerification() {
  const evidenceRoot = path.resolve(".tmp", "c2f6");
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(evidenceRoot, "runtime-flow-evidence-"));
  const hashes = [];
  const save = (relative) => {
    const absolute = path.resolve(relative);
    for (const entry of listRuntimeResources(absolute, { withFileTypes: true })) {
      const source = path.join(relative, entry.name);
      if (entry.isDirectory()) { save(source); continue; }
      const bytes = readRuntimeResource(path.resolve(source), null);
      const target = path.join(directory, source);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
      hashes.push({ path: source, hash: createHash("sha256").update(bytes).digest("hex") });
    }
  };
  save("src");
  const git = (args) => execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(directory, "parent-runtime.json"), JSON.stringify({
    runtime: currentRuntimePackage().toJSON(), head: git(["rev-parse", "HEAD"]).trim(),
    status: git(["status", "--short", "--untracked-files=all", "--", "src/", "tests/integration/flow-cli/process-runtime-admission.test.js",
      "tests/support/infrastructure/process-runtime-flow-scenario.js"]),
    sourceHashes: hashes,
  }, null, 2));
  fs.writeFileSync(path.join(directory, "source.diff"), git(["diff", "--no-ext-diff", "--", "src/"]));
  return directory;
}

/** Observe a persisted barrier; the timeout bounds failure, never orders work. */
export function awaitRuntimeBarrier(file, timeoutMs = 90_000, { signal = null } = {}) {
  if (fs.existsSync(file)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = fs.watch(path.dirname(file), () => {
      if (!fs.existsSync(file)) return;
      finish();
      resolve();
    });
    const timer = setTimeout(() => {
      finish();
      reject(new Error(`runtime scenario did not reach ${file}`));
    }, timeoutMs);
    const onAbort = () => { finish(); reject(signal.reason); };
    const finish = () => { clearTimeout(timer); watcher.close(); signal?.removeEventListener("abort", onAbort); };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    if (fs.existsSync(file)) { finish(); resolve(); }
  });
}

class RuntimeScenarioChild {
  constructor(command, args, options) {
    const delivery = new RuntimeChildExecution({ environment: options.env });
    try {
      const delivered = delivery.options(options);
      this.child = spawn(command, args, { ...delivered, stdio: ["ignore", "pipe", "pipe", ...delivered.stdio.slice(3)] });
    } finally { delivery.close(); }
    this.stdout = "";
    this.stderr = "";
    this.child.stdout.on("data", (chunk) => { this.stdout += chunk; });
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.result = new Promise((resolve, reject) => {
      this.child.once("error", reject);
      this.child.once("close", (status, signal) => resolve({ status, signal,
        stdout: this.stdout, stderr: this.stderr,
        envelope: this.stdout.trim().startsWith("{") ? JSON.parse(this.stdout) : null }));
    });
  }

  kill(signal = "SIGKILL") { return this.child.kill(signal); }
}

/** A production-created Flow plus an actual deterministic external provider. */
export class ProcessRuntimeFlowScenario {
  constructor(seed, { test, specId = "runtime-admission", runId = "runtime-admission-run", step = "draft", sealed = false,
    descendant = false, sourceMutation = false, nestedUpgrade = false } = {}) {
    this.work = new SeedWorkRoot(seed, { prefix: "sennel-runtime-flow-" });
    this.root = this.work.root;
    this.specId = specId;
    this.runId = runId;
    this.children = [];
    test.after(() => this.cleanup());
    const initialDraft = sealed ? canonicalDraftDocument({
      questions: [new CandidateQuestion({ id: "q1", category: "user-visible-behavior",
        question: "Which public recovery outcome should the specification require?", revision: 0,
        provenance: { producer: "fixture" }, evidenceDigest: "a".repeat(64) }).toJSON()],
    }) : null;
    if (sealed) assert.deepEqual(new DraftLifecycle(initialDraft).validateForWriterCompletion(), [],
      "the provider seed must meet the initial Draft writer contract before any process starts");
    this.started = path.join(this.root, ".tmp", "provider-started.json");
    this.release = path.join(this.root, ".tmp", "provider-release");
    this.request = path.join(this.root, ".tmp", "provider-request.json");
    this.count = path.join(this.root, ".tmp", "provider-count");
    this.calls = path.join(this.root, ".tmp", "provider-calls.jsonl");
    this.nestedUpgrade = path.join(this.root, ".tmp", "nested-upgrade.json");
    this.nestedUpgradeStarted = path.join(this.root, ".tmp", "nested-upgrade-started.json");
    this.reviewSource = path.join(this.root, ".tmp", "review-source.json");
    this.reviewInput = path.join(this.root, ".tmp", "review-input.json");
    const worker = path.join(this.root, ".tmp", "runtime-provider.mjs");
    fs.mkdirSync(path.dirname(worker), { recursive: true });
    fs.writeFileSync(worker, [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'import { spawn } from "node:child_process";',
      'import { randomUUID } from "node:crypto";',
      `await import(${JSON.stringify(BOOTSTRAP)});`,
      `const { sealWorkerArtifactHandoff }=await import(${JSON.stringify(HANDOFF)});`,
      `const { ProcessIdentitySource }=await import(${JSON.stringify(IDENTITY_SOURCE)});`,
      `const { RuntimeChildExecution }=await import(${JSON.stringify(RUNTIME_PACKAGE)});`,
      `const { AtomicFile }=await import(${JSON.stringify(ATOMIC_FILE)});`,
      'const writeMarker=(file,value)=>new AtomicFile(file).write(JSON.stringify(value));',
      `const root=${JSON.stringify(this.root)};`,
      'if(process.env.SENNEL_REVIEW_DRAFT_SOURCE){',
      `const {FlowManager}=await import(${JSON.stringify(FLOW_MANAGER)});`,
      `const manager=new FlowManager({root,mainRoot:root,inWorktree:false,specId:${JSON.stringify(specId)}});`,
      `const input=manager.readArtifact({specId:${JSON.stringify(specId)},logicalKey:"draft",consumerNodeId:"draft-questions-review"});`,
      `writeMarker(${JSON.stringify(this.reviewInput)},{descriptor:input.descriptor,bytes:input.bytes.toString("utf8")});`,
      `fs.writeFileSync(${JSON.stringify(this.reviewSource)},process.env.SENNEL_REVIEW_DRAFT_SOURCE);`,
      'process.stdout.write("NO_PROPOSALS");process.exit(0);}',
      'const requestPath=process.env.SENNEL_FLOW_HANDOFF_REQUEST;',
      'if(!requestPath){',
      `const {passingGateProviderResponse}=await import(${JSON.stringify(GATE_FAKE)});`,
      'const schemaIndex=process.argv.indexOf("--schema");',
      'const jsonSchema=schemaIndex<0?null:JSON.parse(process.argv[schemaIndex+1]);',
      'process.stdout.write(passingGateProviderResponse("",{jsonSchema}));process.exit(0);}',
      'const request=JSON.parse(fs.readFileSync(requestPath,"utf8"));',
      `fs.appendFileSync(${JSON.stringify(this.calls)},JSON.stringify({stepId:request.stepId,executionContractId:request.executionContractId,attemptId:request.executionContract.attemptId,dispatchInvocationId:request.dispatchInvocationId})+"\\n");`,
      `const count=${JSON.stringify(this.count)};`,
      `if(request.stepId===${JSON.stringify(step ?? "draft")}){`,
      `fs.copyFileSync(requestPath,${JSON.stringify(this.request)});`,
      'fs.writeFileSync(count,String((fs.existsSync(count)?Number(fs.readFileSync(count,"utf8")):0)+1));}',
      ...(sealed ? [
        'const payload=request.payloads.find((entry)=>entry.logicalName==="draft.json");',
        `fs.writeFileSync(payload.payloadPath,${JSON.stringify(`${JSON.stringify(initialDraft)}\n`)});`,
        'const sealedOutput=sealWorkerArtifactHandoff({requestPath,invocationId:process.env.SENNEL_FLOW_DISPATCH_INVOCATION_ID});',
        `if(request.stepId!==${JSON.stringify(step ?? "draft")}){process.stdout.write(JSON.stringify(sealedOutput));process.exit(0);}`,
      ] : []),
      ...(sourceMutation ? [
        'fs.writeFileSync(path.join(root,"source.txt"),"partial worker edit\\n");',
        'fs.writeFileSync(path.join(root,".sennel","process-runtime-lookalike.txt"),"worker source outside the runtime prefix\\n");',
      ] : []),
      descendant ? 'const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});' : 'const child=null;',
      'const providerIdentity=new ProcessIdentitySource().createOwner(randomUUID());',
      'const descendantIdentity=child===null?null:new ProcessIdentitySource({pid:child.pid}).createOwner(randomUUID());',
      `writeMarker(${JSON.stringify(this.started)},{pid:process.pid,descendantPid:child?.pid??null,providerIdentity,descendantIdentity,sealed:${sealed},sealedOutput:${sealed ? "sealedOutput" : "null"}});`,
      ...(nestedUpgrade ? [
        'const upgradeDelivery=new RuntimeChildExecution({environment:process.env});',
        `const upgrade=spawn(process.execPath,[${JSON.stringify(SEMANTIC_CLI)},"upgrade"],upgradeDelivery.options({cwd:root}));`,
        'upgradeDelivery.close();',
        `writeMarker(${JSON.stringify(this.nestedUpgradeStarted)},new ProcessIdentitySource({pid:upgrade.pid}).createOwner(randomUUID()));`,
        'let upgradeOut="",upgradeErr="";',
        `upgrade.stdout.on("data",(chunk)=>{upgradeOut+=chunk;fs.appendFileSync(${JSON.stringify(`${this.nestedUpgrade}.stdout`)},chunk);});`,
        `upgrade.stderr.on("data",(chunk)=>{upgradeErr+=chunk;fs.appendFileSync(${JSON.stringify(`${this.nestedUpgrade}.stderr`)},chunk);});`,
        'const upgradeStatus=await new Promise((resolve,reject)=>{upgrade.once("error",reject);upgrade.once("close",resolve);});',
        `writeMarker(${JSON.stringify(this.nestedUpgrade)},{status:upgradeStatus,stdout:upgradeOut,stderr:upgradeErr});`,
      ] : []),
      `const release=${JSON.stringify(this.release)};`,
      'await new Promise((resolve)=>{const watcher=fs.watch(path.dirname(release),()=>{if(fs.existsSync(release)){watcher.close();resolve();}});if(fs.existsSync(release)){watcher.close();resolve();}});',
      'process.stdout.write(JSON.stringify({sealed:!!requestPath}));process.exit(0);',
    ].join("\n"));
    fs.writeFileSync(path.join(this.root, ".sennel", "config.json"), JSON.stringify({
      lang: "ja", type: "base", docs: { languages: ["ja"], defaultLanguage: "ja" },
      agent: { default: "runtime-fixture", workDir: ".tmp", timeout: 120,
        providers: { "runtime-fixture": { command: process.execPath, args: [worker, "{{PROMPT}}"],
          jsonSchemaFlag: "--schema", jsonSchemaMode: "inline" } } },
    }, null, 2));
    commitAll(this.root, "runtime provider fixture");
    this.fixture = new CanonicalFlowFixture({ flowManager: this.manager(), specId, runId,
      request: "Check process admission before canonical execution.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null } })
      .create().registerActive();
    if (step !== null) this.fixture.activate(step);
  }

  manager(options = {}) { return makeFlowManager(this.root, options); }

  context(extra = {}) {
    const flowManager = this.manager();
    return { root: this.root, mainRoot: this.root, executionRoot: this.root,
      specId: this.specId, flowManager, flowState: flowManager.loadReadOnly(this.specId),
      config: JSON.parse(fs.readFileSync(path.join(this.root, ".sennel", "config.json"))), ...extra };
  }

  snapshot() {
    const manager = this.manager();
    return { state: manager.canonicalState(this.specId).toJSON(),
      catalog: manager.artifactCatalog(this.specId).toJSON(), activities: manager.activityLedger(this.specId) };
  }

  assertAwaitingQuestionBoundary() {
    const manager = this.manager();
    const state = manager.canonicalState(this.specId);
    assert.equal(state.current.at(-1), "draft-refine");
    const latest = manager.readArtifact({ specId: this.specId, logicalKey: "draft", consumerNodeId: "draft-refine" });
    const awaiting = new DraftLifecycle(JSON.parse(latest.bytes)).questionLedger.awaiting();
    assert.equal(awaiting.length, 1);
    assert.equal(awaiting[0].id, "q1");
    assert.equal(awaiting[0].revision, 1);
    const settlement = manager.activityLedger(this.specId).findLast((entry) => entry.nodeId === "draft-refine"
      && entry.result?.draftSettlementReceipt?.resultKind === "draft-refine-awaiting-answer");
    assert.ok(settlement, "the dispatcher must persist the lawful user-answer boundary");
    assert.equal(settlement.result.draftSettlementReceipt.settlementKind, "await");
    assert.equal(settlement.result.draftSettlementReceipt.awaitQuestion.sourceDigest, latest.descriptor.hash);
    return latest;
  }

  start(args = ["run", "dispatch"], { target = true } = {}) {
    return this.startCommand(["flow", ...args,
      ...(target ? ["--expect-spec", this.specId, "--expect-run-id", this.runId] : [])]);
  }

  startCommand(args) {
    // Child bootstrap already installs the immutable runtime. Re-importing
    // sennel.js intentionally reuses that bootstrap, so invoke the same
    // semantic entrypoint that the public bootstrap normally dispatches.
    const child = new RuntimeScenarioChild(process.execPath, [SEMANTIC_CLI, ...args], {
      cwd: this.root, env: { ...process.env, SENNEL_WORK_ROOT: this.root },
    });
    this.children.push(child);
    return child;
  }

  invoke(args, options) { return this.start(args, options).result; }

  async startProvider() {
    const dispatcher = this.start();
    const waiting = new AbortController();
    try {
      await Promise.race([awaitRuntimeBarrier(this.started, 90_000, { signal: waiting.signal }),
        dispatcher.result.then((result) => {
          throw new Error(`dispatcher exited before provider barrier: ${JSON.stringify(result)}`);
        })]);
    } catch (cause) {
      const details = { stdout: dispatcher.stdout, stderr: dispatcher.stderr,
        requestExists: fs.existsSync(this.request), providerCountExists: fs.existsSync(this.count),
        runtime: ProcessExecutionRuntime.inspect({ mainRoot: this.root }),
        evidenceDirectory: this.preserveFailureEvidence("startup") };
      throw new Error(`${cause.message}\nstartup diagnostic: ${JSON.stringify(details)}`, { cause });
    } finally { waiting.abort(new Error("provider barrier observation finished")); }
    assert.equal(Number(fs.readFileSync(this.count, "utf8")), 1);
    return dispatcher;
  }

  releaseProvider() { fs.writeFileSync(this.release, "release\n"); }

  preserveFailureEvidence(label) {
    const evidence = fs.mkdtempSync(path.resolve(".tmp", "c2f6", `runtime-flow-failure-${label}-`));
    fs.cpSync(path.join(this.root, ".sennel"), path.join(evidence, ".sennel"), { recursive: true });
    const manager = this.manager();
    const location = manager.specLocation(this.specId);
    fs.cpSync(location.directory, path.join(evidence, "canonical-version"), { recursive: true });
    fs.writeFileSync(path.join(evidence, "canonical-readback.json"), JSON.stringify(this.snapshot(), null, 2));
    for (const file of [this.started, this.request, this.count, this.calls, this.nestedUpgrade,
      this.nestedUpgradeStarted, `${this.nestedUpgrade}.stdout`, `${this.nestedUpgrade}.stderr`, this.reviewSource, this.reviewInput,
      path.join(this.root, "source.txt")]) {
      if (fs.existsSync(file)) fs.copyFileSync(file, path.join(evidence, path.basename(file)));
    }
    fs.writeFileSync(path.join(evidence, "original-root.json"), JSON.stringify({
      root: this.root, runtime: currentRuntimePackage().toJSON(),
    }, null, 2));
    fs.writeFileSync(path.join(evidence, "children.json"), JSON.stringify(this.children.map((child) => ({
      pid: child.child.pid, exitCode: child.child.exitCode, signalCode: child.child.signalCode,
      stdout: child.stdout, stderr: child.stderr,
    })), null, 2));
    return evidence;
  }

  createIndependentCheckout() {
    const checkout = path.join(this.root, ".tmp", "parallel-checkout");
    execFileSync("git", ["-C", this.root, "worktree", "add", "-q", "-b", "runtime-independent", checkout],
      { stdio: ["ignore", "pipe", "pipe"] });
    const manager = new FlowManager({ root: checkout, mainRoot: this.root, inWorktree: true });
    const fixture = new CanonicalFlowFixture({ flowManager: manager,
      specId: "runtime-independent-spec", runId: "runtime-independent-run",
      execution: { mode: "worktree", featureBranch: "runtime-independent", baseBranch: "main" } })
      .create().registerActive().settleBefore("draft");
    return { root: checkout, mainRoot: this.root, executionRoot: checkout,
      specId: fixture.specId, flowManager: manager, flowState: manager.loadReadOnly(fixture.specId), config: {} };
  }

  async cleanup() {
    for (const child of this.children) if (child.child.exitCode === null && child.child.signalCode === null) child.kill();
    await Promise.allSettled(this.children.map((child) => child.result));
    // These are test-owned provider handles, used only to clean up a failing
    // scenario. Product recovery must prove identity through its own registry.
    if (fs.existsSync(this.started)) {
      const pids = JSON.parse(fs.readFileSync(this.started, "utf8"));
      const identities = new ProcessIdentitySource();
      for (const value of [pids.descendantIdentity, pids.providerIdentity]) {
        if (value === null) continue;
        const owned = new ProcessIdentity(value);
        if (identities.assess(owned).status !== "live") continue;
        try { process.kill(owned.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }
    try {
      const inventory = ProcessExecutionRuntime.inspect({ mainRoot: this.root });
      if (inventory !== null && inventory.slot !== null) {
        const recovery = await ProcessExecutionRuntime.acquire({ mainRoot: this.root });
        await recovery.close();
      }
    } finally { this.work.cleanup(); }
  }
}
