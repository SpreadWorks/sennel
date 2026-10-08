import assert from "node:assert/strict";
import { test } from "node:test";
import { StagedExecutionSeed } from "../fixtures/structure/staged-execution.js";
import { StructureChecker } from "../support/structure/checker.js";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { SourceModule, readInvocations } from "../support/structure/source-reader.js";

function fixture(phase, mode, additional = false) {
  const taskId = `${phase}-local`;
  const gateId = `${phase}-overall`;
  const reviewId = `${phase}-assessment`;
  const evidenceId = `${phase}-evidence`;
  const seed = new StagedExecutionSeed(phase, [taskId, gateId, reviewId, ...(additional ? [evidenceId] : [])]);
  const files = seed.files();
  const primary = files.get(seed.composition);
  const array = new SourceModule(seed.composition, primary).declaration("registrations");
  const values = readInvocations({ tokens: array.tokens }).filter((entry) => entry.constructed)
    .map((entry) => primary.slice(entry.token.offset - 4, entry.endToken.offset + 1));
  const prefix = primary.slice(0, primary.indexOf("export const registrations"));
  const owner = `src/flow/engine/composition/${phase}-owner.js`;
  const review = `src/flow/engine/composition/${phase}-review.js`;
  const barrel = `src/flow/engine/composition/${phase}-exports.js`;
  const consumer = `src/flow/engine/composition/${phase}-continue.js`;
  files.set("src/flow/engine/composition/step-registration.js", "export class StepRegistration {}\n");
  files.set(owner, `import { StepRegistration } from './step-registration.js';\n${prefix}
    const bounded = Object.freeze([${values.slice(0, 2).join(",")}]);
    const byId = new Map(bounded.map((registration) => [registration.stepId, registration]));
    export function findOriginal(stepId) { return byId.get(stepId) ?? null; }`);
  files.set(review, `import { StepRegistration } from './step-registration.js';\n${prefix}
    export const originalReview = ${values[2]};`);
  if (additional) files.set(`src/flow/engine/composition/${phase}-evidence.js`,
    `import { StepRegistration } from './step-registration.js';\n${prefix}
      const evidenceMembers = Object.freeze([${values[3]}]);
      export function originalEvidence(stepId) { return evidenceMembers.find((entry) => entry.stepId === stepId) ?? null; }`);
  files.set(barrel, `export { findOriginal as findRegistration } from './${phase}-owner.js';
    export { originalReview as reviewRegistration } from './${phase}-review.js';
    ${additional ? `export { originalEvidence as evidenceRegistration } from './${phase}-evidence.js';` : ''}`);
  files.set(seed.composition, `import { findRegistration, reviewRegistration${additional ? ', evidenceRegistration' : ''} } from './${phase}-exports.js';\n${prefix}
    export const registrations = Object.freeze([findRegistration('${taskId}'), findRegistration('${gateId}'), reviewRegistration${additional ? `, evidenceRegistration('${evidenceId}')` : ''}]);
    ${primary.slice(primary.indexOf("const byId"))}`);
  files.set("src/flow/engine/step-binding.js", "export class StepBinding {} export class StepBindingContinuation {}\n");
  files.set(`src/flow/engine/connectors/${phase}-bindings.js`, `import { StepBinding, StepBindingContinuation } from '../step-binding.js';
    export class LocalBinding extends StepBinding {} export class OverallBinding extends StepBinding {}
    export class ReceiptContinuation extends StepBindingContinuation {}`);
  files.set("src/flow/lib/observation.js", "export class Observation {}\n");
  files.set("src/lib/flow-manager.js", `export class FlowManager {
    prepareAcceptedNonblockingPublication(input = {}) {
      return this._store.prepareAcceptedNonblockingPublication({ ...input, specId: input.specId ?? this._boundSpecId });
    }
    prepareGateDeferralPublication(input) { return this._store.prepareGateDeferralPublication(input); }
  }`);
  const imports = `import { findRegistration as selectOriginal, reviewRegistration as selectedReview${additional ? ', evidenceRegistration as selectEvidence' : ''} } from './${phase}-exports.js';
    import { LocalBinding, OverallBinding, ReceiptContinuation } from '../connectors/${phase}-bindings.js';
    import { Input as GateInput, Input as ReviewInput${additional ? ', Input as EvidenceInput' : ''} } from '../../services/input.js';
    import { ServiceClass as LocalService, ServiceClass as OverallService } from '../../services/service.js';
    import { Observation } from '../../lib/observation.js';`;
  const start = mode === "acceptance" ? `
    const sourceBinding = input.record.sourceStep === '${taskId}'
      ? new LocalBinding({ flowManager, specId: input.specId, definitionStepId: '${taskId}', allowFailed: true })
      : new OverallBinding({ flowManager, specId: input.specId, stepId: input.record.sourceStep, allowFailed: true });
    const publication = flowManager.prepareAcceptedNonblockingPublication({ ...input, binding: sourceBinding });
    const continuation = new ReceiptContinuation({ sourceBinding, attempt: publication.attempt,
      continuation: publication.evidence.acceptedDecision, sourceResult: publication.source.result,
      sourceReceipt: publication.source.receipt, confirmationOrder: publication.confirmationOrder });
    const binding = sourceBinding.stepId === '${taskId}'
      ? new LocalBinding({ flowManager, specId: input.specId, definitionStepId: sourceBinding.stepId, continuation })
      : new OverallBinding({ flowManager, specId: input.specId, stepId: sourceBinding.stepId, continuation });
    const review = sourceBinding.stepId === '${reviewId}';
    ${additional ? `const evidenceReview = sourceBinding.stepId === '${evidenceId}';` : ''}
    const registration = ${additional ? 'evidenceReview ? selectEvidence(sourceBinding.stepId) : ' : ''}review ? selectedReview : selectOriginal(sourceBinding.stepId);
    const prepared = registration.create({ flowManager, binding, nonblockingPublication: publication,
      evidence: publication.evidence,
      ...(${additional ? 'evidenceReview ? { observed: new EvidenceInput({ evidence: publication.evidence }) } : ' : ''}review ? { observed: new ReviewInput({ evidence: publication.evidence }) }
        : sourceBinding.stepId === '${gateId}' ? { observed: new GateInput(new Observation(publication.evidence)) } : {}) });
    prepared.step.execute();
    return { receipt: prepared.dependency(registration.ServiceClass).settlementOutcome.receipt,
      record: publication.record.toJSON() };` : `
    const stepId = input.stepResult?.stepId;
    const task = stepId === '${taskId}';
    if (!task && stepId !== '${gateId}') throw new TypeError('saved Result required');
    const sourceBinding = task
      ? new LocalBinding({ flowManager, specId: input.specId, definitionStepId: stepId, allowFailed: true })
      : new OverallBinding({ flowManager, specId: input.specId, stepId, allowFailed: true });
    const publication = flowManager.prepareGateDeferralPublication({ ...input, binding: sourceBinding });
    const continuation = new ReceiptContinuation({ sourceBinding, attempt: publication.attempt,
      continuation: publication.evidence.continuation, sourceResult: publication.source.result,
      sourceReceipt: publication.source.receipt, confirmationOrder: publication.confirmationOrder });
    const binding = task
      ? new LocalBinding({ flowManager, specId: input.specId, definitionStepId: stepId, continuation })
      : new OverallBinding({ flowManager, specId: input.specId, stepId, continuation });
    const registration = selectOriginal(stepId);
    const prepared = registration.create({ flowManager, binding, evidence: publication.evidence,
      gateDeferralPublication: publication,
      ...(task ? {} : { observed: new GateInput(new Observation(publication.evidence)) }) });
    prepared.step.execute();
    const outcome = prepared.dependency(task ? LocalService : OverallService).settlementOutcome;
    return outcome.state ?? flowManager.canonicalState(sourceBinding.specId);`;
  files.set(consumer, `${imports}\nexport function acceptSelected(flowManager, input) {${start}\n}`);
  const inspect = () => new StructureChecker(seed.scope(), new MemorySourceRepository(files)).check();
  const clean = () => { const report = inspect(); assert.equal(report.ok, true, report.diagnostics.map(String).join("\n")); };
  return { files, consumer, owner, review, barrel, clean, inspect };
}

function sourceFixture(phase, mode) {
  const built = fixture(phase, "deferral");
  built.files.set("src/flow/lib/flow-artifact-authority.js", "export function requiresWorkerSourceHandoff(stepId) { return stepId; }\n");
  built.files.set("src/flow/lib/worker-artifact-handoff-error.js", "export class WorkerArtifactHandoffError extends Error {}\n");
  const body = mode === "checkpoint" ? `
    createRequest({ ctx, state, invocation }) {
      const stepId = invocation?.action?.nextAction?.step;
      if (requiresWorkerSourceHandoff(stepId)) {
        const registration = selectOriginal(stepId);
        if (registration === null) throw new Error(\`Source Step registration is missing: \${stepId}\`);
        const prepared = registration.create({ ctx, flowManager: ctx.flowManager });
        const selected = prepared.step.execute();
        if (!(selected instanceof StepResult) || selected.kind !== \`\${stepId}-worker-required\`
          || prepared.dependency(SelectedService).settlementOutcome?.receipt == null) {
          throw new WorkerArtifactHandoffError('recovery-required', 'FLOW_SOURCE_STEP_EXECUTION_NOT_ADMITTED',
            'checkpoint required', { retryable: false });
        }
        state = ctx.flowManager.loadReadOnly(state.specId);
      }
      return state;
    }` : `
    reconcile({ ctx, request, submission, mutationAuthority = null }) {
      const preparation = this.prepareSourceStepHandoff({ ctx, request, submission, mutationAuthority });
      if (preparation.completed) return preparation;
      const registration = selectOriginal(request.stepId);
      if (registration === null) throw new Error(\`Source Step registration is missing: \${request.stepId}\`);
      const prepared = registration.create({ ctx, request, preparation, handoffCoordinator: this, mutationAuthority });
      prepared.step.execute();
      const outcome = prepared.dependency(SelectedService).settlementOutcome;
      if (outcome?.receipt == null) throw new Error('receipt required');
      return outcome;
    }`;
  built.files.set(built.consumer, `import { findRegistration as selectOriginal } from './${phase}-exports.js';
    import { ServiceClass as SelectedService } from '../../services/service.js';
    import { StepResult } from '../step-result.js';
    import { requiresWorkerSourceHandoff } from '../../lib/flow-artifact-authority.js';
    import { WorkerArtifactHandoffError } from '../../lib/worker-artifact-handoff-error.js';
    export class RenamedCoordinator { ${body} }`);
  return built;
}

for (const phase of ["omega", "sigma"]) for (const mode of ["checkpoint", "adoption"]) {
  test(`bounded Source ${phase} ${mode} executes the selected Step and reads its own Service receipt`, () => sourceFixture(phase, mode).clean());
  const cases = [
    ["missing Step", mode === "checkpoint" ? "const selected = prepared.step.execute();" : "prepared.step.execute();", ""],
    ["wrong saved receipt", "settlementOutcome", "otherOutcome"],
    ["wrong Service", "dependency(SelectedService)", "dependency(input.ServiceClass)"],
    ["escaped registration", "const prepared =", "capture(registration); const prepared ="],
    ["early return", mode === "checkpoint" ? "const stepId =" : "const preparation =", mode === "checkpoint" ? "return state; const stepId =" : "return request; const preparation ="],
    ...(mode === "adoption" ? [
      ["missing acquired preparation", "ctx, request, preparation, handoffCoordinator", "ctx, request, handoffCoordinator"],
      ["discarded completed replay", "if (preparation.completed) return preparation;", ""],
    ] : [["omitted checkpoint receipt", "|| prepared.dependency(SelectedService).settlementOutcome?.receipt == null", ""]]),
  ];
  for (const [fault, before, after] of cases) test(`bounded Source ${phase} ${mode} rejects ${fault}`, () => {
    const built = sourceFixture(phase, mode);
    built.clean();
    const original = built.files.get(built.consumer);
    assert.ok(original.includes(before));
    built.files.set(built.consumer, original.replace(before, after));
    try {
      const report = built.inspect();
      const diagnostic = report.diagnostics.find((entry) => entry.rule === "A11" && entry.file === built.consumer);
      assert.ok(diagnostic, report.diagnostics.map(String).join("\n"));
      assert.ok(diagnostic.line > 0 && diagnostic.column > 0 && diagnostic.trace.includes(built.consumer));
    } finally { built.files.set(built.consumer, original); }
    assert.equal(built.files.get(built.consumer), original);
    built.clean();
  });
}

const common = [
  ["missing source receipt", "sourceReceipt: publication.source.receipt,", ""],
  ["changed source receipt", "sourceReceipt: publication.source.receipt", "sourceReceipt: input.receipt"],
  ["changed source Result", "sourceResult: publication.source.result", "sourceResult: input.result"],
  ["changed confirmation", "confirmationOrder: publication.confirmationOrder", "confirmationOrder: input.confirmationOrder"],
  ["changed next Attempt", "attempt: publication.attempt", "attempt: sourceBinding.attempt"],
  ["dropped continuation", "stepId, continuation", "stepId"],
  ["discarded publication evidence", "evidence: publication.evidence", "evidence: input.evidence"],
  ["missing Step execution", "prepared.step.execute();", ""],
  ["direct save instead of Step", "prepared.step.execute();", "flowManager.commitSpecStepResult(input);"],
  ["early return", "const sourceBinding =", "if (input.skip) return input; const sourceBinding ="],
  ["changed registration", "registration.create(", "selectedReview.create("],
  ["missing preparation", "const prepared = registration.create(", "const prepared = input.prepare("],
  ["registration escape", "prepared.step.execute();", "input.capture(registration); prepared.step.execute();"],
];

for (const phase of ["omega", "sigma"]) for (const mode of ["acceptance", "deferral"]) {
  test(`bounded continuation ${phase} ${mode} preserves its original registration and acquired source proof`, () => fixture(phase, mode).clean());
  const cases = [...common.map(([name, before, after]) => [name, before, after]),
    ["opaque acquisition", mode === "acceptance" ? "prepareAcceptedNonblockingPublication" : "prepareGateDeferralPublication", "prepareOpaquePublication"],
    ["wrong saved receipt", mode === "acceptance" ? "settlementOutcome.receipt" : "return outcome.state", mode === "acceptance" ? "settlementOutcome.otherReceipt" : "return input.state"],
    ["wrong Service", mode === "acceptance" ? "dependency(registration.ServiceClass)" : "dependency(task ? LocalService : OverallService)", "dependency(input.ServiceClass)"],
  ];
  for (const [name, before, after] of cases) test(`bounded continuation ${phase} ${mode} rejects ${name}`, () => {
    const built = fixture(phase, mode);
    built.clean();
    const original = built.files.get(built.consumer);
    assert.ok(original.includes(before), `mutation anchor missing: ${before}`);
    built.files.set(built.consumer, original.replace(before, after));
    try {
      const report = built.inspect();
      const diagnostic = report.diagnostics.find((entry) => entry.rule === "A11" && entry.file === built.consumer
        && entry.message.startsWith("unregistered bounded registration consumer"));
      assert.ok(diagnostic, report.diagnostics.map(String).join("\n"));
      assert.ok(diagnostic.line > 0 && diagnostic.column > 0 && diagnostic.trace.includes(built.consumer));
    } finally { built.files.set(built.consumer, original); }
    assert.equal(built.files.get(built.consumer), original);
    built.clean();
  });
  test(`bounded continuation ${phase} ${mode} refuses an unregistered caller through a re-export alias`, () => {
    const built = fixture(phase, mode);
    built.clean();
    const rogue = `src/flow/lib/${phase}-escape.js`;
    built.files.set(rogue, `import { findRegistration as escaped } from '../engine/composition/${phase}-exports.js';
      export function bypass(input) { const registration = escaped(input.stepId); return registration.create(input); }`);
    try {
      const report = built.inspect();
      const diagnostic = report.diagnostics.find((entry) => entry.rule === "A11" && entry.file === rogue);
      assert.ok(diagnostic, report.diagnostics.map(String).join("\n"));
      assert.ok(diagnostic.line > 0 && diagnostic.column > 0 && diagnostic.trace.includes(rogue));
    } finally { built.files.delete(rogue); }
    assert.equal(built.files.has(rogue), false);
    built.clean();
  });
  for (const fault of ["unregistered owner", "wrong binding ancestry", "wrong continuation ancestry", "wrong input owner", "opaque same-named facade"]) {
    test(`bounded continuation ${phase} ${mode} refuses ${fault}`, () => {
      const built = fixture(phase, mode);
      built.files.set(`src/flow/engine/composition/${phase}-unknown.js`, "export function findRegistration() {} export const reviewRegistration = null;");
      built.files.set("src/flow/services/other-input.js", "export class Input {}\n");
      built.clean();
      const bindingFile = `src/flow/engine/connectors/${phase}-bindings.js`;
      const path = fault.includes("ancestry") ? bindingFile
        : fault === "opaque same-named facade" ? "src/lib/flow-manager.js" : built.consumer;
      const original = built.files.get(path);
      const replacements = {
        "unregistered owner": [`'./${phase}-exports.js'`, `'./${phase}-unknown.js'`],
        "wrong binding ancestry": ["class LocalBinding extends StepBinding", "class LocalBinding extends StepBindingContinuation"],
        "wrong continuation ancestry": ["class ReceiptContinuation extends StepBindingContinuation", "class ReceiptContinuation extends StepBinding"],
        "wrong input owner": ["'../../services/input.js'", "'../../services/other-input.js'"],
        "opaque same-named facade": [mode === "acceptance" ? "this._store.prepareAcceptedNonblockingPublication" : "this._store.prepareGateDeferralPublication", "this._store.otherPublication"],
      };
      const [before, after] = replacements[fault];
      assert.ok(original.includes(before));
      built.files.set(path, original.replace(before, after));
      try {
        const report = built.inspect();
        const diagnostic = report.diagnostics.find((entry) => entry.rule === "A11" && entry.file === built.consumer);
        assert.ok(diagnostic, report.diagnostics.map(String).join("\n"));
        assert.ok(diagnostic.line > 0 && diagnostic.column > 0 && diagnostic.trace.includes(built.consumer));
      } finally { built.files.set(path, original); }
      assert.equal(built.files.get(path), original);
      built.clean();
    });
  }
  if (mode === "acceptance") test(`bounded registration ${phase} refuses an unregistered caller in its original owner`, () => {
    const built = fixture(phase, mode);
    built.clean();
    const original = built.files.get(built.owner);
    built.files.set(built.owner, original + "\nexport function bypass(input) { return findOriginal(input.stepId).create(input); }");
    try {
      const report = built.inspect();
      const diagnostic = report.diagnostics.find((entry) => entry.rule === "A11" && entry.file === built.owner);
      assert.ok(diagnostic, report.diagnostics.map(String).join("\n"));
      assert.ok(diagnostic.line > 0 && diagnostic.column > 0 && diagnostic.trace.includes(built.owner));
    } finally { built.files.set(built.owner, original); }
    assert.equal(built.files.get(built.owner), original);
    built.clean();
  });
}

for (const phase of ["eta", "rho"]) {
  test(`bounded continuation ${phase} includes an original acquired-evidence registration`, () => fixture(phase, "acceptance", true).clean());
  const cases = [
    ...common,
    ["wrong additional lookup", "evidenceReview ? selectEvidence(sourceBinding.stepId)", "evidenceReview ? selectOriginal(sourceBinding.stepId)"],
    ["changed additional selection", "selectEvidence(sourceBinding.stepId)", "selectEvidence(input.stepId)"],
    ["missing additional branch", "evidenceReview ? selectEvidence(sourceBinding.stepId) : ", ""],
    ["wrong additional Input", "new EvidenceInput({ evidence: publication.evidence })", "new EvidenceInput({ evidence: input.evidence })"],
    ["wrong source kind branch", "const evidenceReview = sourceBinding.stepId", "const evidenceReview = input.stepId"],
    ["wrong additional receipt", "settlementOutcome.receipt", "settlementOutcome.otherReceipt"],
  ];
  for (const [name, before, after] of cases) test(`bounded continuation ${phase} acquired-evidence branch rejects ${name}`, () => {
    const built = fixture(phase, "acceptance", true);
    built.clean();
    const original = built.files.get(built.consumer);
    assert.ok(original.includes(before));
    built.files.set(built.consumer, original.replace(before, after));
    try {
      const report = built.inspect();
      const diagnostic = report.diagnostics.find((entry) => entry.rule === "A11" && entry.file === built.consumer);
      assert.ok(diagnostic, report.diagnostics.map(String).join("\n"));
      assert.ok(diagnostic.line > 0 && diagnostic.column > 0 && diagnostic.trace.includes(built.consumer));
    } finally { built.files.set(built.consumer, original); }
    assert.equal(built.files.get(built.consumer), original);
    built.clean();
  });
}
