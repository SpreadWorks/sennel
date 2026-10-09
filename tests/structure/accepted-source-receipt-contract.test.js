import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { StagedExecutionSeed } from "../fixtures/structure/staged-execution.js";
import { StructureChecker } from "../support/structure/checker.js";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { SourceModule } from "../support/structure/source-reader.js";

// Static source fixtures copy the owning protocol, then rename the entry and
// replay capability. They never execute or manufacture canonical Flow evidence.
const protocolFile = "src/flow/lib/test-chain-transition-facts.js";
const protocolSource = fs.readFileSync(new URL(`../../${protocolFile}`, import.meta.url), "utf8");
const protocol = new SourceModule(protocolFile, protocolSource);
const declarationText = (name) => {
  const declaration = protocol.declaration(name);
  assert.ok(declaration, `owning protocol declaration ${name} is required`);
  return protocolSource.slice(declaration.tokens[0].offset, declaration.tokens.at(-1).offset + declaration.tokens.at(-1).value.length);
};
const helperNames = ["readCurrentTestChainSettlement", "authenticatedExecutionCompletion", "sourcePublication", "publication",
  "currentActivity", "testSourceRevision", "assertCurrentTestSourceRevision", "TestChainReceiptReplay"];
const helpers = helperNames.map(declarationText).join("\n");
const proofFile = "src/flow/lib/accepted-nonblocking-decision.js";
const proofSource = fs.readFileSync(new URL(`../../${proofFile}`, import.meta.url), "utf8");

function fixture(phase) {
  const seed = new StagedExecutionSeed(phase, ["first", "second"], null, "acquired-adoption");
  const files = seed.files();
  const Replay = `${phase}Receipt`;
  const reader = `read${phase}Settlement`;
  files.set(proofFile, proofSource);
  for (const [file, text] of [
    ["src/flow/lib/non-gate-transition.js", "export class NonGateAttemptIdentity {} export class NonGateCatalogPublication {} export class NonGateSourcePublication {}"],
    ["src/flow/lib/gate-transition.js", "export class GateAttemptIdentity {} export class GateCatalogPublication {}"],
    ["src/flow/lib/non-gate-transition-application.js", "export function projectNonGateTransitionDecision() {}"],
    ["src/flow/lib/canonical-test-artifacts.js", "export class CanonicalTestSourceRevision {} export function canonicalRawEvidenceFingerprint() {}"],
    ["src/flow/lib/canonical-command-result.js", "export class CanonicalCommandAttemptArtifactHistory {}"],
    ["src/flow/lib/step-admission-refusal.js", "export class StepAdmissionRefusal extends Error {}"],
    ["src/flow/lib/test-chain-observation-values.js", "export class AuthenticatedTestExecutionCompletion {}"],
    ["src/flow/engine/step-result.js", "export class StepResult {} export function stepResultDigest() {}"],
  ]) files.set(file, text);
  files.set(seed.definition.module, files.get(seed.definition.module)
    + "\nexport class DraftStepSettlementReceipt {} export function settleImplStepResult() {}"
    + "\nexport { NonGateAttemptIdentity, NonGateCatalogPublication, NonGateSourcePublication } from './lib/non-gate-transition.js';");
  files.set(seed.adapter, `
    import { isDeepStrictEqual } from 'node:util';
    import { DraftStepSettlementReceipt, settleImplStepResult, NonGateAttemptIdentity, NonGateCatalogPublication, NonGateSourcePublication } from '../definition.js';
    import { projectNonGateTransitionDecision } from './non-gate-transition-application.js';
    import { CanonicalTestSourceRevision, canonicalRawEvidenceFingerprint } from './canonical-test-artifacts.js';
    import { CanonicalCommandAttemptArtifactHistory } from './canonical-command-result.js';
    import { StepAdmissionRefusal } from './step-admission-refusal.js';
    import { StepResult, stepResultDigest } from '../engine/step-result.js';
    import { AuthenticatedTestExecutionCompletion } from './test-chain-observation-values.js';
    class AdmissionSelection {
      constructor({ state, stepId, registration, binding, preparation, receipt }) {
        if (registration?.stepId !== stepId || registration.executionContract !== commandStepExecutionContract) {
          throw new StepAdmissionRefusal('registration identity');
        }
        this.runId = state.runId; this.specId = state.specId; this.stepId = stepId;
        this.registration = registration; this.binding = binding;
        this.preparation = preparation; this.receipt = receipt; Object.freeze(this);
      }
    }
    ${helpers.replaceAll('readCurrentTestChainSettlement', reader).replaceAll('TestChainReceiptReplay', Replay)}
    export { ${Replay} };
    export function selectCommand(input) {
      const receipt = input.receipt === null ? null : new ${Replay}({ flowManager: input.flowManager,
        specId: input.specId, stepId: input.stepId, receipt: input.receipt });
      return new AdmissionSelection({ ...input, receipt });
    }
    export function projectCommand(selection) { return selection; }
    export function executeCommand(selection, input) {
      if (!(selection instanceof AdmissionSelection) || selection.registration !== input.registration
        || selection.stepId !== input.registration.stepId) { throw new StepAdmissionRefusal('registration'); }
      if (selection.receipt !== null) { selection.receipt.assertCurrent(); return selection.receipt.receipt; }
      if (selection.binding === null || selection.preparation === null) { throw new StepAdmissionRefusal('evidence'); }
      selection.binding.assertCurrent();
      const prepared = input.registration.create({ flowManager: input.flowManager, binding: selection.binding,
        preparation: selection.preparation, commandResult: input.commandResult, });
      prepared.step.execute();
      return prepared.dependency(input.registration.ServiceClass).settledOutcome;
    }
    export const commandStepExecutionContract = new StepExecutionContract({
      select: selectCommand, project: projectCommand, execute: executeCommand });
  `);
  const service = "src/flow/services/service.js";
  files.set(service, files.get(service).replace("throw new TypeError(); } }",
    "throw new TypeError(); } get settledOutcome() { return null; } }"));
  const caller = seed.callers.find((entry) => entry.receiptReplayName !== null);
  files.set(caller.module, `import { ${Replay} } from './command-execution.js';\n`
    + files.get(caller.module).replace("function replayReceipt(receipt) { return receipt; }", `function replayReceipt(receipt) {
      if (!(receipt instanceof ${Replay})) throw new TypeError('receipt');
      receipt.assertCurrent(); return receipt.receipt;
    }`));
  const inspect = () => new StructureChecker(seed.scope(), new MemorySourceRepository(files)).check();
  const clean = () => { const report = inspect(); assert.equal(report.ok, true, report.diagnostics.map(String).join("\n")); };
  return { seed, files, caller, inspect, clean };
}

const mutations = [
  ["missing current authentication", "projectNonGateTransitionDecision(saved);", ""],
  ["ignored captured proof", "captured ?? flowManager.readCurrentStepSettlement", "input ?? flowManager.readCurrentStepSettlement"],
  ["wrong nominal Attempt", "new NonGateAttemptIdentity({ id: binding.attemptId, sequence: binding.attemptSequence })", "new NonGateAttemptIdentity({ id: binding.attemptId, sequence: 1 })"],
  ["missing latest source generation", 'if (latestOriginal !== original)', 'if (false)'],
  ["missing original receipt validation", "DraftStepSettlementReceipt.assertStored(originalReceipt.toJSON?.() ?? originalReceipt,", "otherReceipt(originalReceipt.toJSON?.() ?? originalReceipt,"],
  ["changed source Result digest", "resultDigest: stepResultDigest(originalResult)", "resultDigest: stepResultDigest(saved.result)"],
  ["missing source proof", "accepted.assertOriginalSource({", "accepted.otherMethod({"],
  ["wrong producer binding", "producerBinding = originalReceipt.binding;", "producerBinding = binding;"],
  ["lost lineage", "evidence.lineage.sourceFingerprint !== evidence.source.fingerprint", "false"],
  ["lost raw authentication", "canonicalRawEvidenceFingerprint(raw.bytes) !== payload.rawEvidenceFingerprint", "false"],
  ["stale early return", "if (saved === null) return null;", "if (saved === null) return null; return saved;"],
  ["unchecked execution replay", "selection.receipt.assertCurrent(); return selection.receipt.receipt;", "return selection.receipt.receipt;"],
];
for (const phase of ["Theta", "Kappa"]) {
  test(`accepted source receipt ${phase} authenticates the original and current generation`, () => fixture(phase).clean());
  for (const [name, before, after] of mutations) test(`accepted source receipt ${phase} rejects ${name}`, () => {
    const built = fixture(phase); built.clean();
    const file = built.seed.adapter; const original = built.files.get(file);
    assert.ok(original.includes(before)); built.files.set(file, original.replace(before, after));
    try {
      const report = built.inspect();
      const diagnostic = report.diagnostics.find((entry) => entry.rule === "A10" && entry.file === file);
      assert.ok(diagnostic, report.diagnostics.map(String).join("\n"));
      assert.ok(diagnostic.line > 0 && diagnostic.column > 0 && diagnostic.trace.includes(file));
    } finally { built.files.set(file, original); }
    assert.equal(built.files.get(file), original); built.clean();
  });
  for (const [name, before, after] of [
    ["source operand parameters", "{ receipt, resultDigest, evidence, originalEvidence }", "{ receipt, resultDigest, otherEvidence, originalEvidence }"],
    ["identity operand parameter", "assertEvidence(evidence) {", "assertEvidence(other) {"],
    ["source receipt digest", "receipt.resultDigest !== this.sourceResultDigest", "false"],
    ["original evidence equality", "!isDeepStrictEqual(expected, originalEvidence)", "false"],
    ["source identity", "this.assertEvidence(evidence);", ""],
  ]) test(`accepted source receipt ${phase} rejects a weakened shared ${name} owner`, () => {
    const built = fixture(phase); built.clean(); const original = built.files.get(proofFile);
    assert.ok(original.includes(before)); built.files.set(proofFile, original.replace(before, after));
    try {
      const report = built.inspect();
      const diagnostic = report.diagnostics.find((entry) => entry.rule === "A10" && entry.file === built.seed.adapter);
      assert.ok(diagnostic, report.diagnostics.map(String).join("\n"));
      assert.ok(diagnostic.line > 0 && diagnostic.column > 0 && diagnostic.trace.includes(built.seed.adapter));
    } finally { built.files.set(proofFile, original); }
    assert.equal(built.files.get(proofFile), original); built.clean();
  });
}

const normalization = `    if (originalEvidence.acceptedDecision != null) {
      throw new TypeError("Accepted decision requires its original unaccepted evidence");
    }
    originalEvidence = { ...originalEvidence };
    delete originalEvidence.acceptedDecision;
`;
test("accepted source receipt recognizes the original exact proof without normalization", () => {
  const built = fixture("OriginalProof"); built.clean();
  const original = built.files.get(proofFile);
  assert.ok(original.includes(normalization));
  built.files.set(proofFile, original.replace(normalization, ""));
  built.clean();
  built.files.set(proofFile, original); built.clean();
});
for (const [name, before, after] of [
  ["nonnull acceptance rejection", "originalEvidence.acceptedDecision != null", "false"],
  ["original operand preservation", "originalEvidence = { ...originalEvidence };", "originalEvidence = { ...evidence };"],
  ["exact nullable field normalization", "delete originalEvidence.acceptedDecision;", "delete originalEvidence.identity;"],
]) test(`accepted source receipt normalization rejects weakened ${name}`, () => {
  const built = fixture("NormalizedProof"); built.clean();
  const original = built.files.get(proofFile);
  assert.ok(original.includes(before)); built.files.set(proofFile, original.replace(before, after));
  try {
    const report = built.inspect();
    const diagnostic = report.diagnostics.find((entry) => entry.rule === "A10" && entry.file === built.seed.adapter);
    assert.ok(diagnostic, report.diagnostics.map(String).join("\n"));
    assert.ok(diagnostic.line > 0 && diagnostic.column > 0 && diagnostic.trace.includes(built.seed.adapter));
  } finally { built.files.set(proofFile, original); }
  assert.equal(built.files.get(proofFile), original); built.clean();
});
