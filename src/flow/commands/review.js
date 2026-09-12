#!/usr/bin/env node
/**
 * src/flow/commands/review.js
 *
 * sennel flow review — code quality review after implementation.
 * Phases: confirm → draft (propose) → approve → apply
 *
 * --phase test: bounded static test review before impl.
 * The test review writes requirement-to-test coverage evidence and structured
 * findings; it does not auto-fix tests.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { parseArgs, PKG_DIR } from "../../lib/cli.js";
import { PRODUCT } from "../../lib/product.js";
import {
  AgentFailure,
  AgentPermissionConfigurationFailure,
} from "../../lib/agent-failure.js";
import { DeferredAgentInvocationMetric } from "../../lib/agent-invocation-metric.js";
import { AgentRuntimeDirectorySet } from "../../lib/agent.js";
import { getSpecName } from "../../lib/flow-helpers.js";
import { relativeFlowSpecFile } from "../../lib/flow-workspace.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";
import { repairJson } from "../../lib/json-parse.js";
import { resolveIncludes } from "../../lib/include.js";
import {
  WorkUnitCheckpointStore,
  WorkUnitResumeDecision,
  WorkUnitToolingFailure,
  classifyWorkUnitFailure,
  createCrossCheckWorkUnitIdentity,
  createLoopChunkWorkUnitIdentity,
  planFallbackChildWorkUnits,
  shouldFallbackSplit,
} from "../lib/work-unit.js";
import {
  ImplReviewProposal,
  ImplReviewProposalBatch,
  ImplReviewProposalContract,
} from "../lib/impl-review-proposal.js";
import {
  DraftArtifactRecoveryError,
  DraftArtifactRevision,
  DraftArtifactSnapshot,
} from "../lib/draft-artifact-promotion.js";
import {
  CanonicalFileMap,
  CanonicalSourceRequirementAuthority,
  CanonicalSourceRequirementScope,
} from "../lib/canonical-file-map.js";
import { CanonicalTaskContext } from "../lib/task-canonical-context.js";
import { CanonicalReviewInputDescriptor } from "../lib/review-work-unit-input.js";
import {
  CanonicalSpecReview,
  SpecReviewDelta,
} from "../lib/spec-review-artifacts.js";
import {
  REVIEW_WORK_UNIT_MANIFEST_ENV,
  ReviewWorkUnit,
} from "../lib/review-work-unit.js";
import { container, initContainer } from "../../lib/container.js";
import { Command } from "../../lib/command.js";
import { PromptBuilder } from "../../lib/prompt-builder.js";
import {
  PromptExecutionBudget,
  PromptExecutionLimit,
  PromptBatchExecutor,
  PromptBatchingError,
  PromptBatchReducer,
  PromptReductionLevel,
  PromptReductionPlan,
  PromptProviderCallAdmission,
} from "../../lib/prompt-batching.js";
import { buildAcknowledgedRationaleSection } from "../lib/acknowledged-rationale.js";
import { validateSchema } from "../../lib/schema-validate.js";
import { ReviewFailure } from "../lib/review-failure.js";
import {
  DRAFT_REVIEW_ARTIFACT_LIMIT,
  draftReviewRouteForKey,
} from "../lib/draft-review-routes.js";
import {
  DraftReviewArtifactDocument,
  DraftReviewFinding,
  normalizeDraftReviewText,
} from "../lib/draft-review-artifacts.js";
import {
  contractFromImplReviewArtifact,
  contractFromTestReviewArtifact,
} from "../lib/flow-judgment-contract.js";
import { CanonicalCommandAttemptArtifactHistory } from "../lib/canonical-command-result.js";
import {
  FindingDispositionPolicy,
  MustFixDisposition,
  REVIEW_FINDING_CANONICAL_FIELD_MAX_CHARS,
  ReviewFindingCycle,
  ReviewFindingFingerprint,
} from "../lib/finding-disposition-policy.js";
import {
  buildRepairFingerprint,
} from "../lib/repair-fingerprint.js";
import { RepairArtifactRegistry } from "../lib/repair-state-identity.js";
import { ReviewToolingOutcome } from "../lib/review-convergence.js";
import {
  collectUntrackedDiff,
  MAX_IMPL_REQUIREMENT_BATCH_CHARS,
  renderCanonicalTaskSource,
} from "../lib/run-gate.js";
import {
  SourceMutationBaseline,
} from "../lib/worker-artifact-handoff.js";
import { TaskReviewExecutionIdentity } from "../lib/task-review-execution-identity.js";
import {
  ReviewProtocolContract,
  ReviewProtocolController,
  ReviewProtocolEffectEvidence,
  ReviewProtocolFailure,
  ReviewProtocolRetryPolicy,
  ReviewProtocolAttemptSettlement,
  ReviewProtocolTransportRetryPolicy,
} from "../lib/review-protocol.js";
import {
  TaskReviewPromptChunkContext,
  TaskReviewPromptPlan,
  TaskReviewPromptPlanningFailure,
} from "../lib/task-review-prompt-plan.js";
import { TestReviewPromptPlan } from "../lib/test-review-prompt-plan.js";
import {
  DraftSectionPromptElement,
  ReviewTextPromptPlan,
  SpecSectionPromptElement,
} from "../lib/review-text-prompt-plan.js";
import {
  ReviewCanonicalAuthorityElement,
  ReviewFindingSynthesisPlan,
  ReviewSynthesisEvidenceElement,
} from "../lib/review-finding-synthesis.js";

/**
 * Local helper for review-phase agent invocations. The Agent service handles
 * timeout and cwd internally; callers only provide the system prompt and
 * (optionally) commandId.
 */
const reviewAgentInvocationOptions = (prompt, commandId, systemPrompt, protocolOptions = {}) => ({
  commandId,
  systemPrompt: prompt && typeof prompt === "object" && "userPrompt" in prompt
    ? prompt.systemPrompt ?? systemPrompt
    : systemPrompt,
  jsonSchema: prompt && typeof prompt === "object" && "userPrompt" in prompt
    ? prompt.jsonSchema ?? null
    : null,
  fmtFallback: prompt && typeof prompt === "object" && "userPrompt" in prompt
    ? prompt.fmtFallback ?? null
    : null,
  ...protocolOptions,
    // Review is diagnostic and runs against the actual execution checkout.
    // The parent binds its result to the before/after source fingerprint and
    // canonical target-state digest before promoting any review evidence.
    executionWorkDir: container.get("root"),
    // The parent keeps the provider admission lease until descendants have
    // ended; otherwise a direct and dispatched review can overlap after the
    // provider's immediate process exits.
  waitForProcessTree: true,
});

const callReviewAgent = (agent, prompt, commandId, systemPrompt, protocolOptions = {}) => {
  const options = reviewAgentInvocationOptions(prompt, commandId, systemPrompt, protocolOptions);
  if (prompt && typeof prompt === "object" && "userPrompt" in prompt) {
    return agent.call(prompt.userPrompt, options);
  }
  return agent.call(prompt, options);
};

const projectReviewAgentInvocation = (agent, prompt, commandId, systemPrompt, protocolOptions = {}) => (
  agent.projectInvocation(
    prompt && typeof prompt === "object" && "userPrompt" in prompt ? prompt.userPrompt : prompt,
    reviewAgentInvocationOptions(prompt, commandId, systemPrompt, protocolOptions),
  )
);

async function synthesizeReviewFindings({
  initialItems,
  authorityElements = [],
  toText,
  buildRequest,
  parseResponse,
  responseItems,
  emptyResponse,
  maxChars,
  executionBudget,
  callAgent,
  projectInvocation,
  protocolPolicy = null,
  reductionProtocolPolicy = null,
}) {
  const authorityEvidence = authorityElements.map((element, sequence) => (
    ReviewSynthesisEvidenceElement.fromAuthority(element, sequence)
  ));
  const findingOffset = authorityEvidence.length;
  const findingEvidence = initialItems.map((item, index) => (
    ReviewSynthesisEvidenceElement.fromFinding(toText(item), findingOffset + index)
  ));
  const elements = [...authorityEvidence, ...findingEvidence];
  if (elements.length === 0) {
    elements.push(ReviewSynthesisEvidenceElement.fromFinding(JSON.stringify({ noFindings: true }), 0));
  }
  const coverageDigest = crypto.createHash("sha256")
    .update(JSON.stringify(elements.flatMap((element) => element.sourceRefs)))
    .digest("hex");
  const summaryRequest = (texts, _context, sourceRefs) => new PromptBuilder()
    .setRole("You are a bounded review evidence reducer. Preserve every normative fact, contradiction, dependency, and unresolved relation needed by a later global cross-check, even when the local map found no defect.")
    .setRules([
      "Return a strictly shorter plain-text semantic summary, not a verdict.",
      "Do not discard conflicting facts or resolve uncertainty.",
      "The parent retains the listed immutable source references and rejects missing execution coverage.",
    ])
    .addUserPrompt("## Covered Source References", sourceRefs.join("\n"))
    .addUserPrompt("## Authority and Validated Finding Evidence", texts.join("\n\n"))
    .build();
  const planFor = (levelElements, requestBuilder, revision) => ReviewFindingSynthesisPlan.create({
    elements: levelElements,
    buildRequest: requestBuilder,
    maxChars,
    revision,
  });
  let finalPlan = null;
  const reduction = new PromptReductionPlan({
    initialElements: elements,
    coverageDigest,
    executionBudget,
  });
  return reduction.execute({
    isComplete: (levelElements) => {
      try {
        const candidate = planFor(levelElements, buildRequest, "review-global-cross-check-v2");
        if (candidate.batches.length !== 1) return false;
        finalPlan = candidate;
        return true;
      } catch (error) {
        if (error instanceof PromptBatchingError && new Set([
          "PROMPT_ELEMENT_TOO_LARGE",
          "PROMPT_FIXED_CONTEXT_TOO_LARGE",
          "PROMPT_BATCH_OVERFLOW",
        ]).has(error.code)) return false;
        throw error;
      }
    },
    buildRound: (levelElements, depth) => planFor(
      levelElements,
      summaryRequest,
      `review-evidence-reduction-v2.${depth}`,
    ).corePlan,
    executeRound: (plan) => new PromptBatchExecutor({ executionBudget }).executeCompletions({
      plan,
      callAgent,
      responseContract: {
        parse: (rawResponse, batch) => {
          const text = typeof rawResponse === "string" ? rawResponse.trim() : JSON.stringify(rawResponse);
          if (!text) throw new PromptBatchingError("PROMPT_RESPONSE_INVALID", "Review evidence summary must be non-empty");
          const sourceRefs = [...new Set(batch.payloadElements.flatMap((element) => element.sourceRefs))];
          return ReviewSynthesisEvidenceElement.fromSummary({
            text,
            sequence: batch.index,
            sourceRefs,
            coverageDigest,
          });
        },
        itemCount: () => 1,
      },
      ...(projectInvocation ? { projectInvocation } : {}),
      ...(reductionProtocolPolicy ? { protocolPolicy: reductionProtocolPolicy } : {}),
    }),
    toNextLevel: (completions) => new PromptReductionLevel({
      elements: completions.map((completion) => completion.response),
      coverageDigest,
    }),
    finalize: async () => {
      executionBudget.consumeSynthesisCalls(1);
      const completions = await new PromptBatchExecutor({ executionBudget }).executeCompletions({
        plan: finalPlan.corePlan,
        callAgent,
        responseContract: {
          parse: parseResponse,
          itemCount: (response) => responseItems(response).length,
        },
        ...(projectInvocation ? { projectInvocation } : {}),
        ...(protocolPolicy ? { protocolPolicy } : {}),
      });
      return completions[0]?.response ?? emptyResponse();
    },
  });
}

function splitReviewTextAtHeadings(text, headingPattern) {
  const starts = [0];
  for (const match of text.matchAll(headingPattern)) {
    if (match.index > 0) starts.push(match.index);
  }
  return starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length));
}

class TaskReviewSourceObservation {
  constructor({ protocolAttempt, baseline } = {}) {
    this.protocolAttempt = protocolAttempt;
    if (!(baseline instanceof SourceMutationBaseline)) throw new Error("Task Review source observation requires a source baseline");
    this.baseline = baseline;
    Object.freeze(this);
  }
}

class TaskReviewSourceEffectDetail {
  constructor({ before, after } = {}) {
    if (!(before instanceof TaskReviewSourceObservation) || !(after instanceof TaskReviewSourceObservation)) {
      throw new Error("Task Review source effect detail requires source observations");
    }
    this.protocolAttempt = before.protocolAttempt.number;
    this.baselineDigest = before.baseline.digest;
    this.currentDigest = after.baseline.digest;
    this.changedPaths = Object.freeze(before.baseline.snapshot.allChangedPaths(after.baseline.snapshot).slice(0, 20));
    Object.freeze(this);
  }
}

export class TaskReviewSourceEffectObserver {
  constructor({ root, executionIdentity, agent = null } = {}) {
    this.root = path.resolve(root);
    if (!(executionIdentity instanceof TaskReviewExecutionIdentity)) {
      throw new Error("Task Review source observation requires its typed execution identity");
    }
    this.executionIdentity = executionIdentity;
    this.ignoredDirectories = taskReviewProtocolIgnoredDirectories({ root: this.root, agent });
    Object.freeze(this);
  }

  capture(protocolAttempt) {
    return new TaskReviewSourceObservation({
      protocolAttempt,
      baseline: SourceMutationBaseline.capture({
        root: this.root,
        attempt: this.executionIdentity.attempt,
        ignoredDirectories: this.ignoredDirectories,
      }),
    });
  }

  hasEffect(before, after) {
    return before.baseline.snapshot.allChangedPaths(after.baseline.snapshot).length > 0;
  }

  describe(before, after) {
    return new ReviewProtocolEffectEvidence({
      observer: "task-review-source",
      detail: new TaskReviewSourceEffectDetail({ before, after }),
    });
  }
}

function taskReviewProtocolIgnoredDirectories({ root, agent }) {
  // The provider's only expected runtime outputs live in its work-unit. The
  // two shared runtime stores can be written concurrently by Agent/leases and
  // must not become false source effects in a filesystem-snapshot fallback.
  // Do not exclude the whole managed directory: canonical/spec changes are
  // provider effects and must remain observable.
  const candidates = [
    reviewOutputDirectory(),
    path.join(root, PRODUCT.managedDirName, "agent-cache"),
    path.join(root, PRODUCT.managedDirName, "review-execution-locks"),
    ...taskReviewAgentRuntimeDirectories({ root, agent }),
  ];
  const directories = candidates.map((candidate) => {
    const relative = path.relative(root, candidate).split(path.sep).join("/");
    if (relative === "" || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
      throw new Error("Task Review source-effect observer directory escapes its execution checkout");
    }
    return relative;
  });
  return [...new Set(directories)];
}

function taskReviewAgentRuntimeDirectories({ root, agent }) {
  const runtimeDirectories = agent?.runtimeDirectories?.();
  if (runtimeDirectories == null) return [];
  if (!(runtimeDirectories instanceof AgentRuntimeDirectorySet)) {
    throw new Error("Task Review agent runtime directories must use AgentRuntimeDirectorySet");
  }
  return runtimeDirectories.toArray().filter((candidate) => {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
      throw new Error("Task Review agent runtime directory must be absolute");
    }
    const relative = path.relative(root, candidate);
    return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
}

function ensureAgent(commandId) {
  const agent = container.get("agent");
  if (!agent.resolve(commandId)) {
    throw new AgentPermissionConfigurationFailure({
      message: `no AI agent configured for ${commandId} (set agent.default in config.json)`,
    });
  }
  return agent;
}
import { resolveMergeBase, runGit } from "../../lib/git-helpers.js";
import { EXIT_ERROR } from "../../lib/constants.js";
import { VALID_PHASES } from "../../lib/constants.js";
import { loadMergedGuardrails, filterByPhase } from "../../lib/guardrail.js";
import { resolveMaxAttempts } from "../definition.js";
import { flattenSteps } from "../lib/step-tree.js";
import { WorkerArtifactRevision } from "../lib/worker-artifact-revision.js";
import { CanonicalSpecTestTopology } from "../lib/canonical-worker-artifacts.js";

const REVIEW_PHASE_NODE_MAP = {
  "draft-questions": "draft-questions-review",
  "draft-coverage": "draft-coverage-review",
  spec: "spec-review",
  test: "test-review",
};
const DRAFT_QA_RULES_PARTIAL_PATH = path.join(PKG_DIR, "flow", "prompts", "partials", "draft-qa-rules.md");
let cachedDraftQaRulesPartial = null;

class ReviewArtifactWritePolicy {
  constructor({ enabled }) {
    if (typeof enabled !== "boolean") throw new Error("review artifact write policy enabled must be boolean");
    this.enabled = enabled;
    Object.freeze(this);
  }
}

let reviewArtifactWritePolicy = new ReviewArtifactWritePolicy({ enabled: true });

// A Version-1 parent owns durable review evidence through its Store.  The
// worker command still produces exactly the same review JSON/Markdown shape,
// but writes it into the parent-created transient work unit.  Keeping this
// switch at the command boundary avoids changing any prompt or agent input.
const REVIEW_OUTPUT_DIRECTORY_ENV = PRODUCT.env("REVIEW_OUTPUT_DIR");
const REVIEW_TEST_SOURCE_DIRECTORY_ENV = PRODUCT.env("REVIEW_TEST_SOURCE_DIR");
const REVIEW_TEST_ARTIFACT_REVISION_ENV = PRODUCT.env("REVIEW_TEST_ARTIFACT_REVISION");
const REVIEW_TEST_TOPOLOGY_ENV = PRODUCT.env("REVIEW_TEST_TOPOLOGY");
const REVIEW_TASK_SPEC_SOURCE_ENV = PRODUCT.env("REVIEW_TASK_SPEC_SOURCE");
const REVIEW_TASK_CONTEXT_SOURCE_ENV = PRODUCT.env("REVIEW_TASK_CONTEXT_SOURCE");
const REVIEW_TASK_CURRENT_SOURCE_ENV = PRODUCT.env("REVIEW_TASK_CURRENT_SOURCE");
const REVIEW_TASK_EXECUTION_IDENTITY_ENV = PRODUCT.env("REVIEW_TASK_EXECUTION_IDENTITY");
const REVIEW_DRAFT_SOURCE_ENV = PRODUCT.env("REVIEW_DRAFT_SOURCE");
const REVIEW_SPEC_SOURCE_ENV = PRODUCT.env("REVIEW_SPEC_SOURCE");
const REVIEW_SPEC_REVIEW_SOURCE_ENV = PRODUCT.env("REVIEW_SPEC_REVIEW_SOURCE");
const REVIEW_FILE_MAP_SOURCE_ENV = PRODUCT.env("REVIEW_FILE_MAP_SOURCE");

function configuredReviewDirectory() {
  const value = process.env[REVIEW_OUTPUT_DIRECTORY_ENV];
  if (value == null || value.trim() === "") {
    throw new Error(`${REVIEW_OUTPUT_DIRECTORY_ENV} is required for a canonical review work unit`);
  }
  if (!path.isAbsolute(value)) {
    throw new Error(`${REVIEW_OUTPUT_DIRECTORY_ENV} must be an absolute directory`);
  }
  return path.resolve(value);
}

function canonicalDraftReviewSource(outputDirectory) {
  const serialized = process.env[REVIEW_DRAFT_SOURCE_ENV];
  if (serialized == null || serialized.trim() === "") {
    throw new Error(`${REVIEW_DRAFT_SOURCE_ENV} is required for draft review`);
  }
  let value;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`${REVIEW_DRAFT_SOURCE_ENV} must be JSON: ${error.message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${REVIEW_DRAFT_SOURCE_ENV} must be an object`);
  }
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["logicalPath", "revision", "sourcePath"])) {
    throw new Error(`${REVIEW_DRAFT_SOURCE_ENV} has invalid fields`);
  }
  if (value.logicalPath !== "draft.json" || typeof value.sourcePath !== "string" || !path.isAbsolute(value.sourcePath)) {
    throw new Error(`${REVIEW_DRAFT_SOURCE_ENV} has an invalid draft source`);
  }
  const sourcePath = path.resolve(value.sourcePath);
  if (path.dirname(sourcePath) !== outputDirectory || path.basename(sourcePath) !== "draft.json") {
    throw new Error(`${REVIEW_DRAFT_SOURCE_ENV} must bind draft.json inside the review work unit`);
  }
  return Object.freeze({
    logicalPath: value.logicalPath,
    sourcePath,
    revision: DraftArtifactRevision.from(value.revision),
  });
}

function canonicalDraftSnapshot(source, flow, phase) {
  const stat = fs.lstatSync(source.sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("canonical draft review source must be a regular unlinked file");
  }
  const snapshot = new DraftArtifactSnapshot({
    filePath: source.sourcePath,
    bytes: fs.readFileSync(source.sourcePath),
  });
  source.revision.assertFlow(flow);
  source.revision.assertReviewSource(phase);
  if (!source.revision.matchesSnapshot(snapshot)) {
    throw new DraftArtifactRecoveryError(
      "DRAFT_REVIEW_CANONICAL_STALE",
      "canonical draft work-unit input does not match its catalog revision",
    );
  }
  return snapshot;
}

function reviewOutputDirectory() {
  return configuredReviewDirectory();
}

function canonicalReviewWorkerUnit() {
  const manifestPath = process.env[REVIEW_WORK_UNIT_MANIFEST_ENV];
  if (manifestPath == null || manifestPath.trim() === "") return null;
  return ReviewWorkUnit.fromEnvironment().assertOutputDirectory(reviewOutputDirectory());
}

function sealCanonicalReviewWorkerUnit() {
  canonicalReviewWorkerUnit()?.seal();
}

function canonicalReviewInput({ variable, logicalKey, logicalPath, optional = false }) {
  return CanonicalReviewInputDescriptor.fromEnvironment(process.env[variable], {
    variable,
    logicalKey,
    logicalPath,
    workUnitDirectory: reviewOutputDirectory(),
    optional,
  });
}

function canonicalReviewSpec() {
  return canonicalReviewInput({
    variable: REVIEW_SPEC_SOURCE_ENV,
    logicalKey: "spec.record",
    logicalPath: "spec.json",
  }).readJsonObject();
}

function canonicalSpecReviewInput() {
  const source = canonicalReviewInput({
    variable: REVIEW_SPEC_REVIEW_SOURCE_ENV,
    logicalKey: "spec.review",
    logicalPath: "review.json",
    optional: true,
  });
  return source === null ? null : source.readJsonObject();
}

function canonicalReviewFileMap(spec, { required = false } = {}) {
  const source = canonicalReviewInput({
    variable: REVIEW_FILE_MAP_SOURCE_ENV,
    logicalKey: "file.map",
    logicalPath: "file-map.json",
    optional: !required,
  });
  if (source === null) return null;
  return CanonicalFileMap.fromBytes(source.readBytes()).assertAgainstSpec(spec).toJSON();
}

/**
 * Loop-review checkpoints are disposable worker state. The Version-1 parent
 * binds every child invocation to this transient directory, so loop retry
 * state cannot create a durable review-history tree beside catalog authority.
 */
export function canonicalLoopReviewCheckpointStore() {
  return new WorkUnitCheckpointStore({
    specDir: configuredReviewDirectory(),
    namespace: "impl-review",
  });
}

function reviewTestSourceDirectory() {
  const value = process.env[REVIEW_TEST_SOURCE_DIRECTORY_ENV];
  if (value == null || value.trim() === "") {
    throw new Error(`${REVIEW_TEST_SOURCE_DIRECTORY_ENV} is required for test review`);
  }
  if (!path.isAbsolute(value)) {
    throw new Error(`${REVIEW_TEST_SOURCE_DIRECTORY_ENV} must be an absolute directory`);
  }
  return path.resolve(value);
}

function reviewTestArtifactRevision() {
  const serialized = process.env[REVIEW_TEST_ARTIFACT_REVISION_ENV];
  if (serialized == null || serialized.trim() === "") {
    throw new Error(`${REVIEW_TEST_ARTIFACT_REVISION_ENV} is required for test review`);
  }
  let revision;
  try {
    revision = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`${REVIEW_TEST_ARTIFACT_REVISION_ENV} must be JSON: ${error.message}`);
  }
  return WorkerArtifactRevision.from(revision);
}

function reviewTestSourceTopology(repositoryRoot) {
  const serialized = process.env[REVIEW_TEST_TOPOLOGY_ENV];
  if (serialized == null || serialized.trim() === "") {
    throw new Error(`${REVIEW_TEST_TOPOLOGY_ENV} is required for test review`);
  }
  let topology;
  try {
    topology = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`${REVIEW_TEST_TOPOLOGY_ENV} must be JSON: ${error.message}`);
  }
  return CanonicalSpecTestTopology.fromJSON(topology, { repositoryRoot });
}

function reviewTaskSpecSource(logicalPath) {
  const serialized = process.env[REVIEW_TASK_SPEC_SOURCE_ENV];
  if (serialized == null || serialized.trim() === "") {
    throw new Error(`${REVIEW_TASK_SPEC_SOURCE_ENV} is required with --task-spec`);
  }
  let value;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`${REVIEW_TASK_SPEC_SOURCE_ENV} must be JSON: ${error.message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${REVIEW_TASK_SPEC_SOURCE_ENV} must be an object`);
  }
  if (value.logicalPath !== logicalPath || typeof value.sourcePath !== "string" || !path.isAbsolute(value.sourcePath)) {
    throw new Error(`${REVIEW_TASK_SPEC_SOURCE_ENV} does not match --task-spec`);
  }
  const outputDirectory = configuredReviewDirectory();
  const sourcePath = path.resolve(value.sourcePath);
  if (sourcePath !== outputDirectory && !sourcePath.startsWith(`${outputDirectory}${path.sep}`)) {
    throw new Error(`${REVIEW_TASK_SPEC_SOURCE_ENV} sourcePath escapes the review work unit`);
  }
  return sourcePath;
}

function canonicalTaskReviewInputs() {
  const contextDocument = canonicalReviewInput({
    variable: REVIEW_TASK_CONTEXT_SOURCE_ENV,
    logicalKey: "task.context",
    logicalPath: "task-context.json",
  }).readJsonObject();
  const source = canonicalReviewInput({
    variable: REVIEW_TASK_CURRENT_SOURCE_ENV,
    logicalKey: "task.source",
    logicalPath: "task-source.json",
  }).readJsonObject();
  const context = CanonicalTaskContext.fromReadOnlyInput(contextDocument);
  if (context.taskId !== source.taskId
    || context.sourceFingerprint !== source.fingerprint
    || source.fingerprint == null) {
    throw new Error("canonical Task Review inputs do not share one Task identity");
  }
  if (!Array.isArray(source.entries)) {
    throw new Error("canonical Task Review context or source is invalid");
  }
  return Object.freeze({ context: context.readOnlyInput(), source });
}

/** Build the worker-visible map only from canonical Task scope and source. */
function canonicalTaskReviewFileMap({ context, source } = {}) {
  return CanonicalSourceRequirementAuthority
    .fromTaskRequirements(context?.requirements)
    .bindPaths(source?.entries?.map((entry) => entry?.path))
    .toJSON();
}

function canonicalTaskReviewSourceScope({ context, source } = {}) {
  return CanonicalSourceRequirementAuthority
    .fromTaskRequirements(context?.requirements)
    .bindSourceScope(source?.entries?.map((entry) => entry?.path));
}

function taskReviewExecutionIdentity(taskId) {
  const serialized = process.env[REVIEW_TASK_EXECUTION_IDENTITY_ENV];
  if (serialized == null || serialized.trim() === "") {
    throw new Error(`${REVIEW_TASK_EXECUTION_IDENTITY_ENV} is required with --task-spec`);
  }
  let document;
  try {
    document = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`${REVIEW_TASK_EXECUTION_IDENTITY_ENV} must be JSON: ${error.message}`);
  }
  const identity = TaskReviewExecutionIdentity.fromJSON(document);
  identity.assertTask(taskId);
  return identity;
}

function getReviewMaxAttempts(phase, attemptContext) {
  const nodeId = REVIEW_PHASE_NODE_MAP[phase];
  if (!nodeId) throw new Error(`unsupported review maxAttempts phase: ${phase}`);
  if (!attemptContext || typeof attemptContext !== "object") {
    throw new Error(`review maxAttempts resolution requires explicit context for phase: ${phase}`);
  }
  return resolveMaxAttempts({ scope: "flow", stepId: nodeId, context: attemptContext });
}

function resolveDraftReviewStage(flow) {
  const steps = Array.isArray(flow?.steps) ? flattenSteps(flow.steps) : [];
  const byId = new Map(steps.map((step) => [step.id, step]));
  if (byId.get("draft-coverage-review")?.status === "in_progress") {
    return buildDraftReviewStage("coverage", {
      commandId: "flow.draft.review.coverage.propose",
      findingClassification: "blocking",
      countLabel: "findings",
      tag: "draft-review-coverage",
    });
  }
  return buildDraftReviewStage("questions", {
    commandId: "flow.draft.review.questions.propose",
    findingClassification: "repair_target",
    countLabel: "questions",
    tag: "draft-review-questions",
  });
}

const LOOP_REVIEW_THRESHOLD = 10;
const MAX_LOOP_CALLS = 16;

/** Supported review phases and their descriptions. */
const REVIEW_PHASES = {
  test: "test sufficiency",
  spec: "spec completeness",
  draft: "draft QA quality",
};

// Validate REVIEW_PHASES keys are a subset of VALID_PHASES
for (const key of Object.keys(REVIEW_PHASES)) {
  if (!VALID_PHASES.includes(key)) {
    throw new Error(`REVIEW_PHASES key '${key}' is not in VALID_PHASES`);
  }
}

/**
 * Resolve review target files from spec scope or git diff fallback.
 *
 * @param {string} root - repo root
 * @param {object} flow - canonical projected Flow state
 * @param {string} mergeBase - merge-base SHA resolved by resolveMergeBase
 * @returns {Promise<{diff: string, touchedFiles: Set<string>, untrackedFiles: Set<string>}>} review target
 */
async function resolveReviewTarget(
  root,
  flow,
  mergeBase,
  spec,
  excludeMatcher = null,
  exclusions = REVIEW_EXCLUDE_PATHS,
  reviewTargetFiles = null,
) {
  const specPath = relativeFlowSpecFile(flow);
  const targetFiles = reviewTargetFiles ?? new ReviewTargetFileFilter({
    specPath,
    excludeMatcher,
  });
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("canonical review target requires the cataloged Spec object");
  }
  const scopeFiles = Array.isArray(spec.scope?.in)
    ? spec.scope.in
        .map((l) => l.replace(/`/g, "").trim())
        .filter((l) => /\.(js|ts|json|md)$/.test(l))
    : [];

  let trackedDiff = "";
  if (scopeFiles.length > 0) {
    const diffs = [];
    for (const f of scopeFiles) {
      const abs = path.resolve(root, f);
      if (!fs.existsSync(abs)) continue;
      diffs.push(...collectCommittedAndStagedDiff(root, mergeBase, f, exclusions, targetFiles));
    }
    trackedDiff = diffs.join("\n");
  }
  if (!trackedDiff) {
    trackedDiff = collectCommittedAndStagedDiff(
      root,
      mergeBase,
      undefined,
      exclusions,
      targetFiles,
    ).join("\n");
  }

  const scopedFiles = new Set(scopeFiles);
  const untrackedDiff = await collectUntrackedDiff(root, {
    excludeFile(file) {
      return targetFiles.excludesUntracked(file, scopedFiles);
    },
  });
  return {
    diff: [trackedDiff, untrackedDiff].filter(Boolean).join("\n"),
    touchedFiles: collectTouchedFiles(root, mergeBase, {
      excludeMatcher,
      excludeFile: (file) => targetFiles.excludes(file),
    }),
    untrackedFiles: collectDiffFilePaths(untrackedDiff),
  };
}

function collectDiffFilePaths(diff) {
  const files = new Set();
  for (const match of diff.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)) files.add(match[1]);
  return files;
}

/** Paths excluded from the fallback (whole-repo) diff in code review.
 *  These are auto-generated by sennel pipelines and overwritten on build. */
const REVIEW_EXCLUDE_PATHS = [
  "docs/",
  "README.md",
  "AGENTS.md",
  `${PRODUCT.managedPath("output")}/`,
  `${PRODUCT.managedPath("review-work-units")}/`,
];

function resolveReviewExcludePaths(config = {}) {
  const configured = config?.flow?.review?.excludePaths;
  return [...REVIEW_EXCLUDE_PATHS, ...(Array.isArray(configured) ? configured : [])];
}

function createReviewExcludeMatcher({ root, exclusions = REVIEW_EXCLUDE_PATHS }) {
  const normalizedRoot = root ? path.resolve(root) : null;
  const rules = exclusions.map((rule) => rule.split(path.sep).join("/").replace(/^\.\//, ""));
  const escapeRegexLiteral = (value) => value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  const toRepoPath = (input) => {
    let value = String(input).split(path.sep).join("/");
    if (normalizedRoot && path.isAbsolute(input)) value = path.relative(normalizedRoot, input).split(path.sep).join("/");
    return value.replace(/^\.\//, "");
  };
  const excludes = (input) => {
    const repoPath = toRepoPath(input);
    return rules.some((rule) => {
      if (rule.endsWith("/")) return repoPath.startsWith(rule);
      if (rule.includes("*")) {
        const re = new RegExp(`^${rule.split("*").map(escapeRegexLiteral).join(".*")}$`);
        return re.test(repoPath);
      }
      return repoPath === rule || repoPath.startsWith(`${rule}/`);
    });
  };
  return {
    excludes,
    filter: (files) => files.filter((file) => !excludes(file)),
  };
}

/**
 * Separates repository source from durable V1 Flow artifacts without treating
 * the canonical tests.source collection as disposable review output.
 */
class ReviewTargetFileFilter {
  constructor({ specPath, excludeMatcher = null } = {}) {
    this.registry = new RepairArtifactRegistry(specPath);
    this.excludeMatcher = excludeMatcher;
    Object.freeze(this);
  }

  #normalizedPath(value) {
    return String(value).split(path.sep).join("/").replace(/^\.\//, "");
  }

  #logicalKey(relativePath) {
    if (!relativePath.startsWith(`${this.registry.specDir}/`)) return null;
    const versionRelativePath = relativePath.slice(this.registry.specDir.length + 1);
    try {
      return FLOW_ARTIFACT_CONTRACTS.classify(versionRelativePath).logicalKey.toString();
    } catch {
      return null;
    }
  }

  excludes(value) {
    const relativePath = this.#normalizedPath(value);
    if (this.excludeMatcher?.excludes(relativePath)) return true;
    if (relativePath.startsWith(`${this.registry.specDir}/`)) {
      return this.#logicalKey(relativePath) !== "tests.source";
    }
    return this.registry.owns(relativePath);
  }

  excludesUntracked(value, scopedFiles) {
    const relativePath = this.#normalizedPath(value);
    if (this.excludes(relativePath)) return true;
    return scopedFiles.size > 0 && !scopedFiles.has(relativePath);
  }
}

/**
 * Build pathspec args for git diff.
 * When filePath is given, scopes to that single file.
 * Otherwise, includes all files except REVIEW_EXCLUDE_PATHS.
 * @param {string} [filePath]
 * @returns {string[]}
 */
function buildReviewPathspec(filePath, exclusions = REVIEW_EXCLUDE_PATHS) {
  if (filePath) return ["--", filePath];
  return ["--", ".", ...exclusions.map((p) => `:!${p}`)];
}

/**
 * Run git diff and return stdout, throwing on failure.
 * @param {string} root
 * @param {string[]} diffArgs - args between "diff" and pathspec
 * @param {string[]} pathspec - pathspec args from buildReviewPathspec
 * @param {string} label - human-readable label for error messages
 * @returns {string} trimmed stdout (may be empty)
 */
function runDiffOrThrow(root, diffArgs, pathspec, label) {
  const res = runGit(["-C", root, "diff", ...diffArgs, ...pathspec]);
  if (!res.ok) throw new Error(`${label} failed: ${res.stderr}`);
  return res.stdout.trim();
}

/**
 * Iterate the two review diff sources (committed vs baseRef, then staged)
 * and call `fn` for each. Keeps both `collectCommittedAndStagedDiff` and
 * `collectTouchedFiles` in sync when the set of sources changes.
 * @param {string} baseRef
 * @param {(source: { args: string[], label: string }) => void} fn
 */
function forEachReviewDiffSource(baseRef, fn) {
  fn({ args: [baseRef], label: `git diff ${baseRef}` });
  fn({ args: ["--cached"], label: "git diff --cached" });
}

/**
 * Collect non-empty committed (vs base) and staged diff outputs.
 * @param {string} root
 * @param {string} baseRef - diff starting point (merge-base SHA recommended)
 * @param {string} [filePath] - optional path to scope the diff to
 * @returns {string[]} array of non-empty diff outputs
 */
function filterReviewDiffFiles(diff, reviewTargetFiles = null) {
  if (reviewTargetFiles === null) return diff;
  return diff
    .split(/(?=^diff --git )/m)
    .filter((segment) => {
      const header = segment.match(/^diff --git a\/.+? b\/(.+)\r?$/m);
      return !header || !reviewTargetFiles.excludes(header[1]);
    })
    .join("");
}

function collectCommittedAndStagedDiff(
  root,
  baseRef,
  filePath,
  exclusions = REVIEW_EXCLUDE_PATHS,
  reviewTargetFiles = null,
) {
  const pathspec = buildReviewPathspec(filePath, exclusions);
  const out = [];
  forEachReviewDiffSource(baseRef, ({ args, label }) => {
    const text = filterReviewDiffFiles(runDiffOrThrow(root, args, pathspec, label), reviewTargetFiles);
    if (text) out.push(text);
  });
  return out;
}

/**
 * Build system prompt for the draft phase.
 * @param {Object[]} [guardrails=[]] - Pre-filtered guardrail articles (phase:review)
 */
function buildDraftSystemPrompt(guardrails = [], options = {}) {
  const pb = new PromptBuilder();
  pb.setRole("You are a code quality reviewer. Analyze the following code changes and propose improvements.");

  const rules = [
    "Focus on:",
    "- Duplicate code elimination",
    "- Naming improvements",
    "- Dead code removal",
    "- Design pattern consistency",
    "- Simplification opportunities",
    "",
    "Scope constraint (MANDATORY):",
    "- Propose changes ONLY for files that appear in the diff you are given (the touched files of this change set).",
    "- Do not propose changes to files outside the diff, even if you believe they could be improved.",
    "- Every proposal MUST include a '**File:** <path>' line pointing to a file present in the diff. Proposals without this line will be discarded.",
    "",
    "Output a numbered list of proposals in this format:",
    "### 1. <title>",
    "**File:** `<path>`",
    "**Issue:** <description of the problem>",
    "**Suggestion:** <concrete improvement>",
    "",
    "If no improvements are needed, output: NO_PROPOSALS",
  ].join("\n");
  pb.setRules(rules);

  if (guardrails.length > 0) {
    const guardrailLines = [
      "Also check the code against the following project-specific guardrail articles.",
      "If a violation is found, report it as a proposal using the same format above.",
      "",
    ];
    for (const g of guardrails) {
      guardrailLines.push(`- id: ${g.id}`);
      guardrailLines.push(`  title: ${g.title}`);
      guardrailLines.push(`  body: ${g.body.trim()}`);
    }
    pb.addSystemPrompt("## Additional Guardrail Review Perspectives", guardrailLines.join("\n"));
    if (options?.acknowledgedRationale?.markdown) {
      pb.addUserRaw(options.acknowledgedRationale.markdown);
    }
  }

  const built = pb.build();
  return built.systemPrompt + (built.userPrompt ? "\n\n" + built.userPrompt : "");
}

function buildReviewAcknowledgedRationale(spec, guardrails) {
  return {
    acknowledgedRationale: buildAcknowledgedRationaleSection({ spec, guardrails }),
  };
}

/**
 * Parse proposals from draft output.
 * Also extracts the first '**File:** <path>' marker in the body (if any).
 * @param {string} text
 * @param {{limit?: number}} [options]
 * @returns {{ title: string, body: string, file: string|null }[]}
 */
function stripProposalPreamble(text) {
  const proposalStart = text.indexOf("### ");
  return proposalStart >= 0 ? text.slice(proposalStart) : text;
}

function parseProposals(text, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit >= 0 ? options.limit : Infinity;
  const proposals = [];
  const proposalText = stripProposalPreamble(text);
  const parts = proposalText.split(/^### /m).filter(Boolean);
  for (const part of parts) {
    if (proposals.length >= limit) break;
    const nlIdx = part.indexOf("\n");
    const title = nlIdx >= 0 ? part.slice(0, nlIdx).trim() : part.trim();
    const body = nlIdx >= 0 ? part.slice(nlIdx + 1).trim() : "";
    proposals.push({ title, body, file: extractProposalFile(body) });
  }
  return proposals;
}

function formatCodebaseContextForPrompt(contextEntries) {
  const contextText = contextEntries.map((e) =>
    `- **${e.file}**: ${e.summary || "(no summary)"}`
  ).join("\n");
  return ["以下のファイルは spec との関連度順に並んでいます。", contextText].join("\n");
}

/**
 * Extract the file path from a proposal body's '**File:**' marker.
 * Accepts `**File:** `path`` or `**File:** path` forms.
 * @param {string} body
 * @returns {string|null}
 */
function extractProposalFile(body) {
  if (!body) return null;
  const m = body.match(/\*\*File:\*\*\s*`?([^`\n]+?)`?\s*$/m);
  if (!m) return null;
  const file = m[1].trim();
  return file || null;
}

/**
 * Collect the set of files touched by the current change set.
 * The "touched" set is the union of:
 *   - files changed in the committed diff against baseRef (`git diff <baseRef>`)
 *   - files changed in the staged (index) diff (`git diff --cached`)
 * Untracked files that are not staged are intentionally NOT included — this
 * matches the review pipeline's scope, which only considers changes that are
 * either committed on the feature branch or staged for commit.
 * @param {string} root
 * @param {string} baseRef - diff starting point (merge-base SHA recommended)
 * @returns {Set<string>}
 */
function collectTouchedFiles(root, baseRef, options = {}) {
  const touched = new Set();
  const matcher = options.excludeMatcher || null;
  const excludeFile = options.excludeFile || null;
  forEachReviewDiffSource(baseRef, ({ args, label }) => {
    const res = runGit(["-C", root, "diff", "--name-only", ...args]);
    if (!res.ok) throw new Error(`git diff --name-only (${label}) failed: ${res.stderr}`);
    for (const line of res.stdout.split("\n")) {
      const p = line.trim();
      if (p && !matcher?.excludes(p) && !excludeFile?.(p)) touched.add(p);
    }
  });
  return touched;
}

function prepareLoopReviewInputsWithExclusions({
  root,
  config = {},
  touchedFiles,
  perFileDiffs,
  fileToRequirements,
  maxLoopCalls = MAX_LOOP_CALLS,
}) {
  const matcher = createReviewExcludeMatcher({ root, exclusions: resolveReviewExcludePaths(config) });
  const scopedTouchedFiles = new Set(matcher.filter([...touchedFiles]));
  const rawPerFileDiffs = new Map(
    [...perFileDiffs].filter(([file]) => !matcher.excludes(file)),
  );
  const strippedDiffs = new Map();
  for (const [file, diff] of rawPerFileDiffs) {
    strippedDiffs.set(file, stripDiffFileHeaders(diff));
  }
  const groups = groupByDiffContent(strippedDiffs, fileToRequirements);
  const needsCrossCheck = groups.length > 1;
  const reviewChunks = createLoopReviewChunks(groups, needsCrossCheck ? Math.max(1, maxLoopCalls - 1) : maxLoopCalls);
  return { scopedTouchedFiles, rawPerFileDiffs, groups, reviewChunks };
}

/**
 * Filter proposals to keep only those whose 'file' is in the touched set.
 * Proposals without an extractable file are dropped as well.
 * @param {{title: string, body: string, file: string|null}[]} proposals
 * @param {Set<string>} touchedFiles
 * @returns {{kept: object[], excluded: {outOfScope: number, missingFile: number}}}
 */
function filterProposalsByScope(proposals, touchedFiles) {
  const kept = [];
  const excluded = { outOfScope: 0, missingFile: 0 };
  for (const p of proposals) {
    if (!p.file) {
      excluded.missingFile += 1;
      continue;
    }
    if (!touchedFiles.has(p.file)) {
      excluded.outOfScope += 1;
      continue;
    }
    kept.push(p);
  }
  return { kept, excluded };
}

/**
 * Write review.md for the current spec under specDir, using formatReviewMd
 * as the single source of truth for the on-disk format. Returns the absolute
 * path written.
 * @param {string} root
 * @param {object} flow
 * @param {object[]} results
 * @returns {string} absolute path of review.md
 */
function writeReviewMd(root, flow, results) {
  const specDir = reviewOutputDirectory();
  const reviewPath = path.join(specDir, "review.md");
  if (reviewArtifactWritePolicy.enabled) {
    fs.writeFileSync(reviewPath, formatReviewMd(results));
  }
  return reviewPath;
}

const NO_PROPOSALS_MARKER = "_No proposals generated for this spec._";

/**
 * Generate review.md content.
 */
function formatReviewMd(results) {
  const lines = ["# Code Review Results", ""];
  if (results.length === 0) {
    lines.push(NO_PROPOSALS_MARKER);
    lines.push("");
    return lines.join("\n");
  }
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`### ${i + 1}. ${r.title}`);
    lines.push(r.body);
    lines.push("");
  }
  return lines.join("\n");
}

const IMPL_REVIEW_BLOCKING_FAILURE_MODES = Object.freeze([
  "missing_acceptance_requirement",
  "spec_behavior_contradiction",
  "security_or_data_integrity_bug",
]);
const IMPL_REVIEW_DISPOSITIONS = Object.freeze(["must-fix", "deferred", "informational"]);
const IMPL_REVIEW_DISPOSITION_SET = new Set(IMPL_REVIEW_DISPOSITIONS);

function normalizeImplReviewRequirementIds(requirementIds) {
  if (!(requirementIds instanceof Set)) {
    throw new Error("impl review requirementIds must be a Set");
  }
  return new Set([...requirementIds].map((id) => String(id).trim()).filter(Boolean));
}

function buildImplReviewResponseSchema(requirementIds, { taskReview = false } = {}) {
  const allowedRequirementIds = [...normalizeImplReviewRequirementIds(requirementIds)].sort();
  const findingSchema = {
    type: "object",
    required: ["findingKey", "title", "failureMode", "file", "requirementId", "issue", "suggestion", "disposition", "rationale", ...(!taskReview ? ["priorRepairInsufficiency", "repairStrategy"] : [])],
    additionalProperties: false,
    properties: {
      findingKey: { type: "string", minLength: 1, maxLength: 100 },
      title: { type: "string", minLength: 1 },
      failureMode: { type: "string", minLength: 1 },
      file: { type: ["string", "null"] },
      requirementId: {
        type: ["string", "null"],
        enum: [...allowedRequirementIds, null],
      },
      issue: { type: "string", minLength: 1 },
      suggestion: { type: "string", minLength: 1 },
      disposition: { type: "string", enum: [...IMPL_REVIEW_DISPOSITIONS] },
      rationale: { type: "string", minLength: 1 },
      ...(!taskReview ? {
        priorRepairInsufficiency: { type: ["string", "null"] },
        repairStrategy: { type: ["string", "null"] },
      } : {}),
    },
    ...(!taskReview ? {
      oneOf: [{
        type: "object",
        required: ["priorRepairInsufficiency", "repairStrategy"],
        properties: { priorRepairInsufficiency: { type: "null" }, repairStrategy: { type: "null" } },
      }, {
        type: "object",
        required: ["priorRepairInsufficiency", "repairStrategy"],
        properties: { priorRepairInsufficiency: { type: "string", minLength: 1 }, repairStrategy: { type: "string", minLength: 1 } },
      }],
    } : {}),
  };
  return {
    type: "object",
    required: ["blockingFindings", "nonBlockingImprovements"],
    additionalProperties: false,
    properties: {
      blockingFindings: { type: "array", items: findingSchema },
      nonBlockingImprovements: { type: "array", items: findingSchema },
    },
  };
}

function buildImplReviewFmtFallback(schema) {
  return [
    "OUTPUT FORMAT - strictly required:",
    "Return only a JSON object. No markdown, no preamble, no commentary.",
    "Schema:",
    JSON.stringify(schema, null, 2),
    "Use empty arrays when there are no findings in a category.",
  ].join("\n");
}

function normalizeReviewPath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^`|`$/g, "");
}

class ImplReviewFinding {
  constructor(kind, item, requirementIds) {
    this.kind = kind;
    this.findingKey = String(item.findingKey || "").trim();
    this.title = String(item.title || "").trim();
    this.failureMode = String(item.failureMode || "").trim();
    this.file = normalizeReviewPath(item.file || "");
    this.requirementId = item.requirementId == null
      ? null
      : String(item.requirementId).trim();
    this.guardrailId = String(item.guardrailId || "").trim();
    this.issue = String(item.issue || "").trim();
    this.suggestion = String(item.suggestion || "").trim();
    this.disposition = String(item.disposition || "").trim();
    this.rationale = String(item.rationale || "").trim();
    this.priorRepairInsufficiency = item.priorRepairInsufficiency == null ? null : String(item.priorRepairInsufficiency).trim();
    this.repairStrategy = item.repairStrategy == null ? null : String(item.repairStrategy).trim();
    this.repeatCount = Number.isSafeInteger(item.repeatCount) && item.repeatCount > 0
      ? item.repeatCount
      : 1;
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(this.findingKey)) {
      throw new Error("findingKey must be a stable lowercase slug");
    }
    if (this.requirementId === "") {
      throw new Error("requirementId must be null or a non-empty string");
    }
    if (
      this.requirementId != null
      && !normalizeImplReviewRequirementIds(requirementIds).has(this.requirementId)
    ) {
      throw new Error(`requirementId is not present in the target spec: ${this.requirementId}`);
    }
    if (!IMPL_REVIEW_DISPOSITION_SET.has(this.disposition)) {
      throw new Error(`disposition must be one of ${IMPL_REVIEW_DISPOSITIONS.join(", ")}`);
    }
    if (!this.rationale) {
      throw new Error("rationale must be a non-empty string");
    }
    if ((this.priorRepairInsufficiency === null) !== (this.repairStrategy === null)
      || this.priorRepairInsufficiency === "" || this.repairStrategy === "") {
      throw new Error("recurrence explanation and repair strategy must be supplied together");
    }
    const fingerprint = ReviewFindingFingerprint.fromFinding({
      ...item,
      category: this.failureMode,
      failureMode: this.failureMode,
      requirementId: this.requirementId,
      ...(this.guardrailId ? { guardrailId: this.guardrailId } : {}),
      file: this.file || null,
      title: this.title,
      issue: this.issue,
    });
    this.fingerprint = fingerprint.value;
    this.findingId = String(item.findingId || fingerprint.value).trim();
    if (!this.findingId) throw new Error("findingId must be a non-empty string");
  }

  toJSON() {
    return {
      findingKey: this.findingKey,
      title: this.title,
      failureMode: this.failureMode,
      ...(this.file ? { file: this.file } : {}),
      requirementId: this.requirementId,
      ...(this.guardrailId ? { guardrailId: this.guardrailId } : {}),
      issue: this.issue,
      suggestion: this.suggestion,
      disposition: this.disposition,
      rationale: this.rationale,
      ...(this.priorRepairInsufficiency === null ? {} : {
        priorRepairInsufficiency: this.priorRepairInsufficiency,
        repairStrategy: this.repairStrategy,
      }),
      findingId: this.findingId,
      fingerprint: this.fingerprint,
      repeatCount: this.repeatCount,
    };
  }

  toPromptMemory() {
    return this.toJSON();
  }

  withDisposition(disposition, requirementIds) {
    return new ImplReviewFinding(this.kind, {
      ...this.toJSON(),
      disposition: disposition.disposition,
      findingId: disposition.findingId,
      fingerprint: disposition.fingerprint,
      repeatCount: disposition.repeatCount,
      guardrailId: disposition.guardrailId,
    }, requirementIds);
  }
}

class ImplReviewArtifact {
  constructor({ blockingFindings = [], nonBlockingImprovements = [], excluded = {}, generatedAt = new Date().toISOString(), requirementIds = null } = {}) {
    const allowedRequirementIds = requirementIds instanceof Set
      ? requirementIds
      : new Set([...blockingFindings, ...nonBlockingImprovements].map((item) => item.requirementId).filter(Boolean));
    this.version = 1;
    this.phase = "impl";
    this.generatedAt = generatedAt;
    this.blockingFindings = blockingFindings.map((item) =>
      item instanceof ImplReviewFinding ? item : new ImplReviewFinding("blocking", item, allowedRequirementIds),
    );
    this.nonBlockingImprovements = nonBlockingImprovements.map((item) =>
      item instanceof ImplReviewFinding ? item : new ImplReviewFinding("improvement", item, allowedRequirementIds),
    );
    this.verdict = this.blockingFindings.length > 0
      ? "REJECTED"
      : this.nonBlockingImprovements.length > 0
        ? "ADVISORY"
        : "PASS";
    this.summary = Object.freeze({
      blocking: this.blockingFindings.length,
      nonBlocking: this.nonBlockingImprovements.length,
      total: this.blockingFindings.length + this.nonBlockingImprovements.length,
    });
    this.excluded = Object.freeze({
      missingFile: Number(excluded.missingFile || 0),
      outOfScope: Number(excluded.outOfScope || 0),
    });
  }

  toPromptMemory() {
    return {
      verdict: this.verdict,
      counts: this.summary,
      previousBlockingFindings: this.blockingFindings
        .map((item) => item.toPromptMemory()),
      acknowledgedNonBlockingImprovements: this.nonBlockingImprovements
        .map((item) => item.toPromptMemory()),
    };
  }

  toJSON() {
    return {
      version: this.version,
      phase: this.phase,
      generatedAt: this.generatedAt,
      verdict: this.verdict,
      summary: this.summary,
      blockingFindings: this.blockingFindings.map((item) => item.toJSON()),
      nonBlockingImprovements: this.nonBlockingImprovements.map((item) => item.toJSON()),
      excluded: this.excluded,
    };
  }
}

function parseImplReviewJsonOutput(raw, requirementIds, { taskReview = false } = {}) {
  const candidate = extractJsonObjectCandidate(raw);
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (_) {
    try {
      parsed = JSON.parse(repairJson(candidate));
    } catch (err) {
      throw new Error(`impl review output failed schema validation: ${err.message}`);
    }
  }
  for (const bucket of ["blockingFindings", "nonBlockingImprovements"]) {
    if (!Array.isArray(parsed[bucket])) continue;
    for (const finding of parsed[bucket]) {
      if (finding && typeof finding === "object" && !Object.hasOwn(finding, "file")) {
        finding.file = null;
      }
      if (!taskReview && finding && typeof finding === "object" && !Object.hasOwn(finding, "priorRepairInsufficiency")) finding.priorRepairInsufficiency = null;
      if (!taskReview && finding && typeof finding === "object" && !Object.hasOwn(finding, "repairStrategy")) finding.repairStrategy = null;
    }
  }
  const errors = validateSchema(parsed, buildImplReviewResponseSchema(requirementIds, { taskReview }));
  if (errors.length > 0) {
    throw new Error(`impl review output failed schema validation: ${errors.join("; ")}`);
  }
  return parsed;
}

function parseImplReviewFindings(text, { requirementIds, taskReview = false } = {}) {
  const allowedRequirementIds = normalizeImplReviewRequirementIds(requirementIds);
  const parsed = parseImplReviewJsonOutput(text, allowedRequirementIds, { taskReview });
  try {
    return {
      blockingFindings: parsed.blockingFindings.map((item) => new ImplReviewFinding("blocking", item, allowedRequirementIds)),
      nonBlockingImprovements: parsed.nonBlockingImprovements.map((item) => new ImplReviewFinding("improvement", item, allowedRequirementIds)),
    };
  } catch (err) {
    throw new Error(`impl review output failed schema validation: ${err.message}`);
  }
}

function isValidRequirementId(requirementIds, id) {
  return id && requirementIds instanceof Set && requirementIds.has(id);
}

function shouldKeepImplReviewFinding(finding, touchedFiles, requirementIds, bucketKind = finding.kind) {
  if (
    bucketKind === "blocking"
    && finding.failureMode === "missing_acceptance_requirement"
    && isValidRequirementId(requirementIds, finding.requirementId)
    && !finding.file
  ) {
    return { keep: true };
  }
  if (!finding.file) return { keep: false, reason: "missingFile" };
  if (!touchedFiles.has(finding.file)) return { keep: false, reason: "outOfScope" };
  return { keep: true };
}

function filterImplReviewFindingsByScope({ parsed, touchedFiles, requirementIds }) {
  const excluded = { missingFile: 0, outOfScope: 0 };
  const filterBucket = (items, bucketKind) => {
    const kept = [];
    for (const item of items) {
      const decision = shouldKeepImplReviewFinding(item, touchedFiles, requirementIds, bucketKind);
      if (decision.keep) kept.push(item);
      else excluded[decision.reason] += 1;
    }
    return kept;
  };
  return {
    blockingFindings: filterBucket(parsed.blockingFindings || [], "blocking"),
    nonBlockingImprovements: filterBucket(parsed.nonBlockingImprovements || [], "improvement"),
    excluded,
  };
}

function formatImplReviewJson(input = {}) {
  const artifact = input instanceof ImplReviewArtifact ? input : new ImplReviewArtifact(input);
  return JSON.stringify(artifact, null, 2) + "\n";
}

function formatImplReviewMd(input = {}) {
  const artifact = input instanceof ImplReviewArtifact ? input : new ImplReviewArtifact(input);
  const lines = ["# Code Review Results", ""];
  lines.push(`## Verdict: ${artifact.verdict}`, "");
  lines.push("## Blocking Findings", "");
  if (artifact.blockingFindings.length === 0) {
    lines.push("No blocking findings.");
  } else {
    for (let i = 0; i < artifact.blockingFindings.length; i++) {
      const item = artifact.blockingFindings[i];
      lines.push(`### ${i + 1}. ${item.title}`);
      lines.push(`**Finding key:** ${item.findingKey}`);
      lines.push(`**Failure mode:** ${item.failureMode}`);
      if (item.file) lines.push(`**File:** ${item.file}`);
      if (item.requirementId) lines.push(`**Requirement:** ${item.requirementId}`);
      if (item.guardrailId) lines.push(`**Guardrail:** ${item.guardrailId}`);
      lines.push(`**Issue:** ${item.issue}`);
      lines.push(`**Suggestion:** ${item.suggestion}`);
      lines.push(`**Disposition:** ${item.disposition}`);
      lines.push(`**Rationale:** ${item.rationale}`);
      lines.push("");
    }
  }
  lines.push("", "## Non-blocking Improvements", "");
  if (artifact.nonBlockingImprovements.length === 0) {
    lines.push("No non-blocking improvements.");
  } else {
    for (let i = 0; i < artifact.nonBlockingImprovements.length; i++) {
      const item = artifact.nonBlockingImprovements[i];
      lines.push(`### ${i + 1}. ${item.title}`);
      lines.push(`**Finding key:** ${item.findingKey}`);
      lines.push(`**Failure mode:** ${item.failureMode}`);
      if (item.file) lines.push(`**File:** ${item.file}`);
      lines.push(`**Requirement:** ${item.requirementId}`);
      if (item.guardrailId) lines.push(`**Guardrail:** ${item.guardrailId}`);
      lines.push(`**Issue:** ${item.issue}`);
      lines.push(`**Suggestion:** ${item.suggestion}`);
      lines.push(`**Disposition:** ${item.disposition}`);
      lines.push(`**Rationale:** ${item.rationale}`);
      lines.push("");
    }
  }
  lines.push("", "## Excluded Findings", "");
  lines.push(`- Missing file: ${artifact.excluded.missingFile}`);
  lines.push(`- Out of scope: ${artifact.excluded.outOfScope}`);
  lines.push("");
  return lines.join("\n");
}

function normalizedReviewTaskId(taskId) {
  return taskId == null ? null : String(taskId).trim();
}

function canonicalImplReviewAttemptHistory({ flowManager, flow, taskId = null } = {}) {
  if (!flowManager || typeof flowManager.readProducerArtifact !== "function") {
    throw new Error("canonical impl review history requires FlowManager.readProducerArtifact");
  }
  if (!flow || typeof flow.specId !== "string" || flow.specId === "") {
    throw new Error("canonical impl review history requires a Version-1 Flow state");
  }
  const normalizedTaskId = normalizedReviewTaskId(taskId);
  const logicalKey = normalizedTaskId === null ? "impl.review" : "task.review";
  const nodeId = normalizedTaskId === null ? "impl-review" : `${normalizedTaskId}-review`;
  const resolved = flowManager.readProducerArtifact({
    specId: flow.specId,
    nodeId,
    logicalKey,
    ...(normalizedTaskId === null ? {} : { parameters: { taskId: normalizedTaskId } }),
    optional: true,
  });
  if (resolved === null) return null;
  return CanonicalCommandAttemptArtifactHistory.fromBytes({
    logicalKey,
    bytes: resolved.bytes,
  });
}

function loadPreviousImplReviewMemory({ flowManager, flow, taskId = null } = {}) {
  const history = canonicalImplReviewAttemptHistory({ flowManager, flow, taskId });
  if (history === null) return null;
  const data = history.current.payload;
  const artifactTaskId = data.taskId == null ? null : String(data.taskId).trim();
  const expectedTaskId = normalizedReviewTaskId(taskId);
  if (artifactTaskId !== expectedTaskId) return null;
  return new ImplReviewArtifact({
    generatedAt: data.generatedAt,
    blockingFindings: Array.isArray(data.blockingFindings) ? data.blockingFindings : [],
    nonBlockingImprovements: Array.isArray(data.nonBlockingImprovements) ? data.nonBlockingImprovements : [],
    excluded: data.excluded || {},
  }).toPromptMemory();
}

function buildImplReviewPrompt({ requirementFileMap = {}, requirementSourceScope = null, requirementIds, diff = "", touchedFiles = [], previousReview = null, taskSpec = null, taskContext = null, taskReviewAttempt = null, taskNoChangeReasons = [], taskReviewChunk = null } = {}) {
  if (requirementSourceScope !== null && !(requirementSourceScope instanceof CanonicalSourceRequirementScope)) {
    throw new Error("requirementSourceScope must be a CanonicalSourceRequirementScope or null");
  }
  const allowedRequirementIds = normalizeImplReviewRequirementIds(requirementIds);
  const responseSchema = buildImplReviewResponseSchema(allowedRequirementIds, { taskReview: taskSpec !== null });
  const touched = Array.from(touchedFiles instanceof Set ? touchedFiles : new Set(touchedFiles)).sort();
  const modeList = IMPL_REVIEW_BLOCKING_FAILURE_MODES.map((mode) => `- ${mode}`).join("\n");
  const pb = new PromptBuilder()
    .setRole("You are an implementation reviewer. Report findings for the typed disposition policy to evaluate against requirements and guardrails.")
    .setRules([
      "Return JSON only.",
      "Every finding must include disposition and a non-empty rationale.",
      "Use disposition=must-fix when the finding is tied to a mandatory requirement or blocking guardrail.",
      "Use disposition=informational when no mandatory requirement or blocking guardrail requires repair.",
      "Do not emit disposition=deferred on a first report; the implementation assigns it when the same fingerprint reaches the retry bound.",
      "Maintainability, project-rule, naming, refactor, DRY, comment, and docs findings may be must-fix when requirement or guardrail evidence makes them mandatory.",
      "For a blocking guardrail finding, use the exact guardrail id as failureMode so the policy can resolve its authority.",
      "Assign findingKey as a stable lowercase slug. Reuse it for the same problem even when wording changes, and use a distinct key for a different problem tied to the same authority.",
      "The following are common must-fix failure modes, not a closed allowlist:",
      modeList,
      "Non-blocking improvements are optional. Do not generate one unless it names a touched file, describes an observable issue in that file, and provides a replacement action that names the affected function, branch, assertion, prompt sentence, or artifact field.",
      "File-specific findings must use a file from the touched file set.",
      "Implementation review is static. Do not require running tests or completing test-execute as a prerequisite; scenario-validity, test-execute, test-result-review, impl-gate, and final-regression own runtime verdicts.",
      "For task review, a task spec's Test Strategy describes the later spec-level execution plan, not evidence that must already exist during task-review.",
      "requirementId is always required and must use one of the allowed target requirement IDs.",
      "A missing_acceptance_requirement blocker may omit file only when its requirementId identifies the missing target requirement.",
      "Put must-fix findings in blockingFindings[]. Put informational findings in nonBlockingImprovements[].",
      ...(taskSpec === null ? ["Outside Task Review, set priorRepairInsufficiency and repairStrategy to null; they are reserved for exact Task recurrence evidence."] : []),
      "",
      "Return an object with:",
      taskSpec === null
        ? "- blockingFindings[] with findingKey, title, failureMode, file, requirementId, issue, suggestion, disposition, rationale, priorRepairInsufficiency, repairStrategy"
        : "- blockingFindings[] with findingKey, title, failureMode, file, requirementId, issue, suggestion, disposition, rationale",
      taskSpec === null
        ? "- nonBlockingImprovements[] with findingKey, title, failureMode, file, requirementId, issue, suggestion, disposition, rationale, priorRepairInsufficiency, repairStrategy"
        : "- nonBlockingImprovements[] with findingKey, title, failureMode, file, requirementId, issue, suggestion, disposition, rationale",
      ...(taskSpec === null ? ["- Set priorRepairInsufficiency and repairStrategy to null outside Task Review."] : []),
      "- file may be null only when the missing_acceptance_requirement rule applies.",
      "- requirementId must never be null; every finding must use an allowed target requirement ID.",
      "- Use empty arrays when there are no findings in a category.",
    ].join("\n"))
    .setJsonSchema(responseSchema)
    .setFmtFallback(buildImplReviewFmtFallback(responseSchema))
    .addUserPrompt("## Allowed Target Requirement IDs", [...allowedRequirementIds].sort().join("\n") || "(none)")
    .addUserPrompt("## Requirement-File Mapping", requirementSourceScope === null
      ? JSON.stringify(requirementFileMap, null, 2)
      : requirementSourceScope.toPromptText())
    .addUserPrompt("## Touched Files", touched.join("\n") || "(none)");

  pb.addUserPrompt(taskSpec ? "## Current Task Source" : "## Diff", diff || "(none)");

  if (taskSpec) {
    if (taskReviewChunk !== null && !(taskReviewChunk instanceof TaskReviewPromptChunkContext)) {
      throw new Error("Task Review prompt chunk context must be typed");
    }
    if (!Number.isSafeInteger(taskReviewAttempt) || taskReviewAttempt < 1 || taskReviewAttempt > 4) {
      throw new Error("Task Review prompt requires an Attempt between 1 and 4");
    }
    pb.addUserPrompt("## Task Review Scope", [
      `Task spec: ${taskSpec.relPath}`,
      `Review attempt: ${taskReviewAttempt}/4`,
      taskSpec.content || "",
    ].join("\n"));
    const noChange = Array.isArray(taskNoChangeReasons) && taskNoChangeReasons.length > 0 && touched.length === 0;
    pb.addUserPrompt("## Task Review Detection Contract", noChange
      ? [
        "This Task implementation declared no source mutation. Verify that declaration against the canonical Task context, mapped Requirements, stated reasons, and the empty current Task source.",
        "If the declaration is valid, return no findings. Do not invent a source edit.",
        "If a mapped Requirement is missing, emit a must-fix missing_acceptance_requirement blocker with file=null and the mapped requirementId. Do not edit source: the parent will route the Task to its bounded implementation correction round.",
        "Do not use another failure mode or a file-backed finding for an invalid no-change declaration.",
        "Do not run tests.",
      ].join("\n")
      : [
        "Review the supplied current Task source and report findings without modifying any source, test, spec, or artifact.",
        "Do not run tests. Task triage owns finding disposition and task repair owns all source changes and repair evidence.",
      ].join("\n"));
    if (taskReviewChunk !== null) {
      pb.addUserPrompt("## Task Review Source Chunk Contract", taskReviewChunk.toPromptText());
    }
    if (noChange) {
      pb.addUserPrompt("## Declared No-Change Reasons", taskNoChangeReasons.join("\n"));
    }
    pb.addUserPrompt("## Canonical Task Context", JSON.stringify(taskContext, null, 2));
  }
  if (previousReview) {
    pb.addUserPrompt("## Previous Impl Review Memory", JSON.stringify(previousReview, null, 2));
  }
  return pb.build();
}

export const TASK_REVIEW_PROMPT_CHAR_LIMIT = MAX_IMPL_REQUIREMENT_BATCH_CHARS;

function taskReviewProviderFinding(finding) {
  return {
    findingKey: finding.findingKey,
    title: finding.title,
    failureMode: finding.failureMode,
    file: finding.file || null,
    requirementId: finding.requirementId,
    issue: finding.issue,
    suggestion: finding.suggestion,
    disposition: finding.disposition,
    rationale: finding.rationale,
  };
}

function mergeTaskReviewParsedResponses(parsedResponses) {
  const selected = new Map();
  const dispositionStrength = new Map([["informational", 1], ["deferred", 2], ["must-fix", 3]]);
  for (const parsed of parsedResponses) {
    for (const [bucket, findings] of [
      ["blockingFindings", parsed.blockingFindings],
      ["nonBlockingImprovements", parsed.nonBlockingImprovements],
    ]) {
      for (const finding of findings) {
        const candidate = { bucket, finding };
        const previous = selected.get(finding.fingerprint) ?? null;
        const candidateStrength = dispositionStrength.get(finding.disposition) + (bucket === "blockingFindings" ? 10 : 0);
        const previousStrength = previous === null
          ? -1
          : dispositionStrength.get(previous.finding.disposition) + (previous.bucket === "blockingFindings" ? 10 : 0);
        if (previous === null || candidateStrength > previousStrength) selected.set(finding.fingerprint, candidate);
      }
    }
  }
  const merged = { blockingFindings: [], nonBlockingImprovements: [] };
  for (const { bucket, finding } of selected.values()) merged[bucket].push(taskReviewProviderFinding(finding));
  return JSON.stringify(merged);
}

class TaskReviewFindingReducer extends PromptBatchReducer {
  reduce(completions) {
    return mergeTaskReviewParsedResponses(completions.map((completion) => completion.response));
  }
}

function mergeTaskReviewChunkResponses(rawResponses, requirementIds) {
  return mergeTaskReviewParsedResponses(rawResponses.map((rawResponse) => (
    parseImplReviewFindings(rawResponse, { requirementIds, taskReview: true })
  )));
}

function buildTaskReviewSynthesisPrompt(seedPrompt, requirementIds, guardrails, findingTexts, sourceRefs = []) {
  return {
    systemPrompt: [
      seedPrompt.systemPrompt,
      "Final Task Review synthesis: all canonical source ranges completed. Resolve duplicate or contradictory findings and verify global Requirement/guardrail coverage before returning one result.",
      "Adjudicate every supplied map finding against the canonical authority. Omit a map finding only when that authority disproves or resolves it; the returned JSON is the final authoritative result.",
    ].filter(Boolean).join("\n\n"),
    userPrompt: [
      "## Complete Requirement IDs",
      [...requirementIds].sort().join("\n") || "(none)",
      "## Complete Review Guardrail IDs",
      guardrails.map((guardrail) => guardrail.id).filter(Boolean).sort().join("\n") || "(none)",
      "## Covered Evidence References",
      sourceRefs.join("\n") || "(none)",
      "## Canonical Authority and Validated Range Findings",
      findingTexts.join("\n\n"),
    ].join("\n\n"),
    jsonSchema: seedPrompt.jsonSchema,
    fmtFallback: seedPrompt.fmtFallback,
  };
}

function buildTaskReviewAuthorityElements(taskSpec, previousReview) {
  const elements = [new ReviewCanonicalAuthorityElement({
    id: `task-review-spec:${taskSpec.relPath}`,
    text: ["## Canonical Task Specification", taskSpec.content].join("\n"),
    sequence: 0,
  })];
  const memoryEntries = previousReview === null ? [] : [
    { kind: "metadata", value: { verdict: previousReview.verdict, counts: previousReview.counts } },
    ...(previousReview.previousBlockingFindings || []).map((value) => ({ kind: "blocking", value })),
    ...(previousReview.acknowledgedNonBlockingImprovements || []).map((value) => ({ kind: "advisory", value })),
  ];
  memoryEntries.forEach((entry, index) => elements.push(new ReviewCanonicalAuthorityElement({
    id: `task-review-prior-memory:${entry.kind}:${index}`,
    text: ["## Canonical Prior Review Memory", JSON.stringify(entry.value)].join("\n"),
    sequence: index + 1,
  })));
  return elements;
}

async function runTaskReviewPromptPlanWithDependencies({
  plan,
  requirementIds,
  callAgent,
  projectInvocation = null,
  protocolPolicy = null,
  synthesize = null,
  synthesizeWhenSingle = false,
}) {
  if (!(plan instanceof TaskReviewPromptPlan)) throw new Error("Task Review prompt execution requires its typed plan");
  if (!(requirementIds instanceof Set)) throw new Error("Task Review prompt execution requires requirementIds");
  if (typeof callAgent !== "function") throw new Error("Task Review prompt execution requires callAgent");
  if (projectInvocation !== null && typeof projectInvocation !== "function") {
    throw new Error("Task Review invocation projection must be a function or null");
  }
  if (protocolPolicy !== null && typeof protocolPolicy.execute !== "function") {
    throw new Error("Task Review protocol policy must implement execute()");
  }
  const protocolAttemptCount = protocolPolicy === null ? 1 : protocolPolicy.maxProviderCalls;
  if (!Number.isSafeInteger(protocolAttemptCount) || protocolAttemptCount < 1) {
    throw new Error("Task Review protocol policy requires maxProviderCalls");
  }
  const executionBudget = new PromptExecutionBudget(new PromptExecutionLimit({
      maxRequestCharacters: plan.maxChars,
      maxBatchCount: MAX_LOOP_CALLS,
      maxProviderCallCount: MAX_LOOP_CALLS,
      maxProtocolRetryCount: protocolAttemptCount - 1,
      maxSynthesisCallCount: MAX_LOOP_CALLS,
      maxAggregateCharacters: 1_000_000,
    }));
  const requiresSynthesis = (plan.chunks.length > 1 || synthesizeWhenSingle) && synthesize !== null;
  executionBudget.assertCanExecute(plan.chunks.length + (requiresSynthesis ? 1 : 0));
  const executor = new PromptBatchExecutor({ executionBudget });
  let completions;
  try {
    completions = await executor.executeCompletions({
      plan: plan.corePlan,
      callAgent: (request, batch, protocolRetryIndex, attemptContext, providerCallAdmission) => callAgent(
        request,
        plan.chunks[batch.index],
        protocolRetryIndex,
        attemptContext,
        providerCallAdmission,
      ),
      responseContract: {
        parse: (rawResponse) => parseImplReviewFindings(rawResponse, { requirementIds, taskReview: true }),
        itemCount: (response) => response.blockingFindings.length + response.nonBlockingImprovements.length,
      },
      ...(projectInvocation === null ? {} : {
        projectInvocation: (request, batch) => projectInvocation(request, plan.chunks[batch.index]),
      }),
      ...(protocolPolicy === null ? {} : { protocolPolicy }),
    });
  } catch (error) {
    if (error instanceof PromptBatchingError && error.cause) throw error.cause;
    throw error;
  }
  const merged = new TaskReviewFindingReducer().reduce(completions);
  return (completions.length > 1 || synthesizeWhenSingle) && synthesize
    ? synthesize({ completions, merged, executionBudget, protocolPolicy })
    : merged;
}

async function runImplReviewAgentWithDependencies({ prompt, taskReview = false, taskReviewPlan = null, requirementIds = null, callAgent, projectInvocation = null, protocolPolicy = null, synthesize = null, synthesizeWhenSingle = false }) {
  if (taskReviewPlan !== null) {
    if (!(taskReviewPlan instanceof TaskReviewPromptPlan)) throw new Error("Task Review requires its typed prompt plan");
    return runTaskReviewPromptPlanWithDependencies({ plan: taskReviewPlan, requirementIds, callAgent, projectInvocation, protocolPolicy, synthesize, synthesizeWhenSingle });
  }
  if (taskReview) throw new Error("Task Review requires its typed prompt plan");
  return callAgent(prompt);
}

function resolveRequirementIds(spec) {
  return new Set((Array.isArray(spec.requirements) ? spec.requirements : []).map((req) => req.id).filter(Boolean));
}

function loadImplReviewPolicyContext(root, spec) {
  const requirements = new Map(
    (Array.isArray(spec.requirements) ? spec.requirements : [])
      .filter((requirement) => requirement?.id)
      .map((requirement) => [requirement.id, requirement]),
  );
  const guardrails = new Map(
    filterByPhase(loadMergedGuardrails(root), "review")
      .filter((guardrail) => guardrail?.id)
      .map((guardrail) => [guardrail.id, { id: guardrail.id, severity: "blocking" }]),
  );
  return { requirements, guardrails };
}

function priorImplReviewFingerprintCounts({ flowManager, flow, taskId = null, cycle } = {}) {
  if (!(cycle instanceof ReviewFindingCycle)) {
    throw new Error("canonical prior impl review counts require an Activity-derived ReviewFindingCycle");
  }
  const counts = new Map();
  const history = canonicalImplReviewAttemptHistory({ flowManager, flow, taskId });
  if (history === null) return counts;
  const expectedTaskId = normalizedReviewTaskId(taskId);
  for (const { payload: artifact } of history.attempts) {
    const artifactTaskId = artifact.taskId == null ? null : String(artifact.taskId).trim();
    if (artifactTaskId !== expectedTaskId) continue;
    if (!cycle.matchesArtifact(artifact)) continue;
    const seen = new Set();
    for (const finding of [
      ...(Array.isArray(artifact.blockingFindings) ? artifact.blockingFindings : []),
      ...(Array.isArray(artifact.nonBlockingImprovements) ? artifact.nonBlockingImprovements : []),
    ]) {
      if (typeof finding?.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(finding.fingerprint)) continue;
      seen.add(finding.fingerprint);
    }
    for (const fingerprint of seen) counts.set(fingerprint, (counts.get(fingerprint) || 0) + 1);
  }
  return counts;
}

class ImplReviewPersistenceStrategy {
  constructor() {
    if (new.target === ImplReviewPersistenceStrategy) {
      throw new Error("ImplReviewPersistenceStrategy is abstract");
    }
  }

  persistWith(persistImplReview, reviewOutput) {
    if (typeof persistImplReview !== "function") {
      throw new Error("impl review persistence callback must be a function");
    }
    return persistImplReview(String(reviewOutput), this);
  }

  persist(context) {
    return runImplReviewWithPersistence(context, this);
  }

  resolveAuthority() {
    throw new Error("ImplReviewPersistenceStrategy.resolveAuthority must be implemented");
  }
}

const TRUSTED_LOOP_IMPL_REVIEW_OUTPUT_CAPABILITY = Symbol("trusted loop impl review output");
const TRUSTED_LOOP_IMPL_REVIEW_OUTPUTS = new WeakSet();

class TrustedLoopImplReviewOutput {
  #value;

  constructor(value, capability) {
    if (capability !== TRUSTED_LOOP_IMPL_REVIEW_OUTPUT_CAPABILITY) {
      throw new Error("trusted loop impl review output requires serializer creation capability");
    }
    if (typeof value !== "string" || value === "") {
      throw new Error("trusted loop impl review output must be a non-empty string");
    }
    this.#value = value;
    TRUSTED_LOOP_IMPL_REVIEW_OUTPUTS.add(this);
    Object.freeze(this);
  }

  static isAuthentic(value) {
    return TRUSTED_LOOP_IMPL_REVIEW_OUTPUTS.has(value);
  }

  toString() {
    return this.#value;
  }
}

class StrictImplReviewPersistence extends ImplReviewPersistenceStrategy {
  constructor() {
    super();
    Object.freeze(this);
  }

  resolveAuthority({ finding, requirements, guardrails }) {
    const guardrail = guardrails.get(finding.failureMode) || null;
    const requirement = guardrail ? null : requirements.get(finding.requirementId) || null;
    return { requirement, guardrail };
  }
}

class TrustedLoopImplReviewPersistence extends ImplReviewPersistenceStrategy {
  constructor() {
    super();
    Object.freeze(this);
  }

  resolveAuthority() {
    return { requirement: null, guardrail: null };
  }
}

const STRICT_IMPL_REVIEW_PERSISTENCE = new StrictImplReviewPersistence();
const TRUSTED_LOOP_IMPL_REVIEW_PERSISTENCE = new TrustedLoopImplReviewPersistence();

function applyImplReviewDispositionPolicy({
  root,
  flowManager,
  flow,
  spec,
  cycle,
  filtered,
  requirementIds,
  taskSpec,
  persistenceStrategy,
}) {
  if (!(persistenceStrategy instanceof ImplReviewPersistenceStrategy)) {
    throw new Error("impl review persistence strategy must be typed");
  }
  if (!(cycle instanceof ReviewFindingCycle)) {
    throw new Error("impl review finding cycle must be derived from the canonical Activity ledger");
  }
  const { requirements, guardrails } = loadImplReviewPolicyContext(root, spec);
  const taskId = taskSpec?.task?.id == null ? null : String(taskSpec.task.id).trim();
  const priorCounts = priorImplReviewFingerprintCounts({ flowManager, flow, taskId, cycle });
  const maxOccurrences = resolveMaxAttempts({
    scope: taskId === null ? "flow" : "task",
    stepId: taskId === null ? "impl-review" : "task-review",
    context: flow,
  }) ?? 1;
  const policy = new FindingDispositionPolicy({ maxOccurrences });
  const seen = new Map();
  const blockingFindings = [];
  const nonBlockingImprovements = [];
  const classify = (finding) => {
    const { requirement, guardrail } = persistenceStrategy.resolveAuthority({
      finding,
      requirements,
      guardrails,
    });
    const candidate = {
      ...finding.toJSON(),
      scope: taskId === null ? "flow" : "task",
      phase: taskId === null ? "impl-review" : "task-review",
      taskId,
      category: finding.failureMode,
      guardrailId: guardrail?.id || null,
    };
    delete candidate.findingId;
    delete candidate.fingerprint;
    delete candidate.repeatCount;
    const fingerprint = ReviewFindingFingerprint.fromFinding(candidate).value;
    if (seen.has(fingerprint)) {
      const previous = seen.get(fingerprint);
      if (previous.title !== finding.title || previous.issue !== finding.issue) {
        throw new Error(`findingKey collision for ${finding.findingKey}`);
      }
      return;
    }
    seen.set(fingerprint, finding);
    const disposition = policy.classify({
      finding: {
        ...candidate,
        findingId: fingerprint,
        fingerprint,
      },
      requirement,
      guardrail,
      repeatCount: (priorCounts.get(fingerprint) || 0) + 1,
    });
    const typed = finding.withDisposition(disposition, requirementIds);
    // The gate recomputes identities from the persisted review finding. Keep
    // the classified identity authoritative after reconstructing the typed
    // finding so loop-review provider payloads cannot reintroduce a stale ID.
    typed.findingId = fingerprint;
    typed.fingerprint = fingerprint;
    if (disposition instanceof MustFixDisposition || disposition.disposition === "deferred") {
      blockingFindings.push(typed);
    }
    else nonBlockingImprovements.push(typed);
  };
  filtered.blockingFindings.forEach(classify);
  filtered.nonBlockingImprovements.forEach(classify);
  return { blockingFindings, nonBlockingImprovements, excluded: filtered.excluded };
}

async function runImplReviewWithPersistence({
  root,
  executionRoot = root,
  flowManager,
  flow,
  spec,
  cycle,
  reviewOutput,
  touchedFiles,
  taskSpec = null,
}, persistenceStrategy) {
  const requirementIds = resolveRequirementIds(spec);
  const parsed = parseImplReviewFindings(reviewOutput, { requirementIds });
  const filtered = filterImplReviewFindingsByScope({
    parsed,
    touchedFiles,
    requirementIds,
  });
  const specPath = relativeFlowSpecFile(flow);
  const specDir = reviewOutputDirectory();
  const dispositioned = applyImplReviewDispositionPolicy({
    root,
    flowManager,
    flow,
    spec,
    cycle,
    filtered,
    requirementIds,
    specDir,
    taskSpec,
    persistenceStrategy,
  });
  const artifact = new ImplReviewArtifact({ ...dispositioned, requirementIds });
  const reviewJsonPath = path.join(specDir, "impl-review.json");
  const fingerprint = buildRepairFingerprint({ root: executionRoot, artifactRoot: root, specPath, state: flow });
  const artifactJson = { ...artifact.toJSON(), repairFingerprint: fingerprint.hash };
  const reviewedHead = runGit(["rev-parse", "HEAD"], { cwd: executionRoot });
  artifactJson.reviewedTree = fingerprint.hash;
  if (reviewedHead.ok) artifactJson.reviewedHead = reviewedHead.stdout.trim();
  Object.assign(artifactJson, cycle.toJSON());
  if (taskSpec) {
    artifactJson.taskId = taskSpec.task.id;
    artifactJson.target = taskSpec.relPath;
  }
  artifactJson.contractSummary = contractFromImplReviewArtifact(artifactJson, {
    artifactPath: path.relative(root, reviewJsonPath).split(path.sep).join("/"),
  }).summary.toJSON();
  const attemptNumber = reviewHistoryAttemptNumber(specDir, "impl");
  const reviewMdWrite = writeReviewAttemptHistory({
    specDir,
    phase: "impl",
    latestBasename: "review.md",
    attemptNumber,
    content: formatImplReviewMd(artifact),
    findings: [
      ...findingsWithSeverity(artifact.blockingFindings.map((finding) => finding.toJSON()), "blocking"),
      ...findingsWithSeverity(artifact.nonBlockingImprovements.map((finding) => finding.toJSON()), "non-blocking"),
    ],
  });
  const reviewJsonWrite = writeReviewAttemptHistory({
    specDir,
    phase: "impl",
    latestBasename: "impl-review.json",
    attemptNumber,
    artifact: artifactJson,
  });
  const triageFindings = [
    ...artifactJson.blockingFindings.map((finding) => ({
      ...finding,
      decision: finding.disposition === "must-fix" ? "apply" : "reject",
    })),
    ...artifactJson.nonBlockingImprovements.map((finding) => ({ ...finding, decision: "reject" })),
  ];
  return {
    result: "ok",
    changed: [
      path.relative(root, reviewMdWrite.latestPath),
      path.relative(root, reviewJsonWrite.latestPath),
    ],
    artifacts: {
      phase: "impl",
      verdict: artifact.verdict,
      blockingCount: artifact.summary.blocking,
      nonBlockingCount: artifact.summary.nonBlocking,
      repairFingerprint: fingerprint.hash,
      ...(taskSpec ? { taskId: taskSpec.task.id, target: taskSpec.relPath } : {}),
    },
    output: "",
  };
}

async function runImplReview(context) {
  return STRICT_IMPL_REVIEW_PERSISTENCE.persist(context);
}

/**
 * Build the apply prompt from approved proposals and diff.
 */
function buildApplyPrompt(approved, diff) {
  const proposalText = approved
    .map((p, i) => `### ${i + 1}. ${p.title}\n${p.body}`)
    .join("\n\n");

  return [
    "Apply the following approved refactoring proposals to the code.",
    "Make only the changes described. Do not add unrelated improvements.",
    "",
    "## Approved Proposals",
    proposalText,
    "",
    "## Current Diff (for context)",
    diff,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Loop review helpers (spec 242)
// ---------------------------------------------------------------------------

function shouldUseLoopReview(fileCount) {
  return fileCount >= LOOP_REVIEW_THRESHOLD;
}

function stripDiffFileHeaders(diff) {
  return diff.split("\n").filter((line) =>
    !line.startsWith("diff --git ") &&
    !line.startsWith("index ") &&
    !line.startsWith("--- ") &&
    !line.startsWith("+++ "),
  ).join("\n");
}

function groupByDiffContent(perFileDiffs, fileToReqs) {
  const keyToFiles = new Map();
  for (const [file, content] of perFileDiffs) {
    const reqs = fileToReqs ? (fileToReqs.get(file) || []) : [];
    const key = content + "\0" + reqs.slice().sort().join("\0");
    const existing = keyToFiles.get(key);
    if (existing) {
      existing.files.push(file);
    } else {
      keyToFiles.set(key, { files: [file], diff: content });
    }
  }
  return Array.from(keyToFiles.values()).map((g) => ({
    files: g.files,
    diff: g.diff,
    representative: g.files[0],
  }));
}

function buildPerFileReviewInput(filePath, diff, requirements) {
  const lines = [`## File: ${filePath}`, ""];
  if (requirements.length > 0) {
    lines.push("## Related Requirements");
    for (const r of requirements) lines.push(`- ${r}`);
    lines.push("");
  }
  lines.push("## Diff");
  lines.push(diff);
  return lines.join("\n");
}

function buildCrossCheckInput(summaries) {
  if (summaries.length === 0) return "No proposals were generated from individual file reviews.";
  const lines = ["## Individual File Review Summaries", ""];
  for (const s of summaries) {
    lines.push(`### ${s.files?.join(", ") || s.file}`);
    lines.push(s.proposals);
    lines.push("");
  }
  const authorities = [...new Set(summaries.map((summary) => summary.requirementAuthority).filter(Boolean))];
  lines.push("## Complete Related Requirement Authority", "");
  lines.push(...(authorities.length > 0 ? authorities : ["(none)"]));
  return lines.join("\n");
}

function buildChunkRequirementAuthority(chunk, fileToReqs) {
  const lines = [];
  for (const group of chunk) {
    const requirements = fileToReqs.get(group.representative) || [];
    lines.push(`### ${group.files.join(", ")}`);
    lines.push(...(requirements.length > 0 ? requirements : ["(no related requirement binding)"]));
  }
  return lines.join("\n");
}

function buildImplLoopSystemPrompt({ mode, guardrails = [], acknowledgedRationale = null }) {
  const crossCheck = mode === "cross-check";
  const pb = new PromptBuilder()
    .setRole(crossCheck
      ? "You are a cross-file implementation reviewer. Detect issues that only become visible across the supplied review results."
      : "You are an implementation reviewer. Analyze the supplied code changes for requirement-backed improvements.")
    .setRules([
      crossCheck
        ? "Focus on interface, duplication, and naming inconsistencies across files, and verify proposals against the complete related Requirement authority."
        : "Focus on duplication, naming, dead code, design consistency, and simplification.",
      "Only return proposals that are backed by an allowed active-spec requirement.",
      "Use the repository-relative file that contains the issue.",
      "Treat guardrails as rationale context only; never use a guardrail identifier as a requirement identifier.",
      "When no valid requirement-backed proposal exists, return an empty proposals array.",
      ...(crossCheck ? [
        "Adjudicate every supplied map proposal against all other proposals and Requirement authority.",
        "Return the complete distinct final proposal set. Omit proposals that are duplicated, contradicted, or disproved; this response replaces the map candidates.",
      ] : []),
      "The supplied JSON Schema is authoritative for the response structure.",
    ].join("\n"));

  if (guardrails.length > 0) {
    pb.addSystemPrompt("## Guardrail Rationale Context", guardrails.map((guardrail) => [
      `- id: ${guardrail.id}`,
      `  title: ${guardrail.title}`,
      `  body: ${guardrail.body.trim()}`,
    ].join("\n")).join("\n"));
  }
  if (acknowledgedRationale?.markdown) pb.addUserRaw(acknowledgedRationale.markdown);

  const built = pb.build();
  return built.systemPrompt + (built.userPrompt ? `\n\n${built.userPrompt}` : "");
}

function buildImplLoopReviewSystemPrompt(guardrails, options = {}) {
  return buildImplLoopSystemPrompt({
    mode: "per-chunk",
    guardrails,
    acknowledgedRationale: options.acknowledgedRationale,
  });
}

function buildImplLoopCrossCheckSystemPrompt(guardrails, options = {}) {
  return buildImplLoopSystemPrompt({
    mode: "cross-check",
    guardrails,
    acknowledgedRationale: options.acknowledgedRationale,
  });
}

function expandProposalsToGroup(proposals, groupFiles) {
  if (proposals.length === 0) return [];
  const representative = groupFiles[0];
  const expanded = [];
  for (const file of groupFiles) {
    for (const p of proposals) {
      if (!(p instanceof ImplReviewProposal)) {
        throw new Error("loop review expansion requires ImplReviewProposal values");
      }
      if (file === representative) {
        expanded.push(p);
      } else {
        expanded.push(p.retarget(file));
      }
    }
  }
  return expanded;
}

function expandChunkProposals(proposals, chunk, expandGroupProposals) {
  const expanded = [];
  for (const group of chunk) {
    const groupProposals = proposals.filter((proposal) => proposal.file && group.files.includes(proposal.file));
    const applicable = groupProposals.length > 0 ? groupProposals : proposals;
    expanded.push(...(group.files.length > 1
      ? expandGroupProposals(applicable, group.files)
      : applicable));
  }
  return expanded;
}

function invertFileMap(fileMap, requirements) {
  const reqById = new Map(requirements.map((r) => [r.id, r]));
  const result = new Map();
  for (const [reqId, files] of Object.entries(fileMap)) {
    const req = reqById.get(reqId);
    if (!req) continue;
    const reqText = `${req.id}${req.priority ? ` [${req.priority}]` : ""}: ${req.desc}`;
    for (const f of files) {
      if (!result.has(f)) result.set(f, []);
      result.get(f).push(reqText);
    }
  }
  return result;
}

function collectPerFileDiffs(root, mergeBase, touchedFiles) {
  const perFileDiffs = new Map();
  for (const file of touchedFiles) {
    const diffs = collectCommittedAndStagedDiff(root, mergeBase, file);
    if (diffs.length > 0) perFileDiffs.set(file, diffs.join("\n"));
  }
  return perFileDiffs;
}

function buildChunkReviewInput(chunk, rawPerFileDiffs, fileToReqs) {
  const parts = [];
  for (const g of chunk) {
    const diff = rawPerFileDiffs.get(g.representative) || g.diff;
    const reqs = fileToReqs.get(g.representative) || [];
    parts.push(buildPerFileReviewInput(g.representative, diff, reqs));
  }
  return parts.join("\n\n---\n\n");
}

function resolveTaskReviewSpec(taskSpecPath) {
  const relPath = String(taskSpecPath || "").trim();
  if (!relPath) return null;
  const absPath = reviewTaskSpecSource(relPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`task spec not found: ${relPath}`);
  }
  const content = fs.readFileSync(absPath, "utf8");
  const inputs = canonicalTaskReviewInputs();
  const sourceScope = canonicalTaskReviewSourceScope(inputs);
  const fileMap = canonicalTaskReviewFileMap(inputs);
  const entries = inputs.source.entries;
  const currentSource = renderCanonicalTaskSource(entries);
  return {
    relPath,
    task: { id: inputs.context.task.id },
    text: content,
    content,
    context: inputs.context,
    source: inputs.source,
    fileMap,
    sourceScope,
    currentSource,
    touchedFiles: new Set(entries.map((entry) => entry.path)),
  };
}

function buildTaskReviewInput(taskSpec, diff) {
  return [
    "## Task Specification",
    `Path: ${taskSpec.relPath}`,
    "",
    taskSpec.text,
    "",
    "## Diff",
    diff,
  ].join("\n");
}

function chunkLabel(chunk) {
  const primary = chunk[0];
  return chunk.length > 1
    ? `${primary.representative} +${chunk.length - 1} more`
    : `${primary.representative} (${primary.files.length} file(s))`;
}

function createLoopReviewChunks(groups, maxCalls = MAX_LOOP_CALLS) {
  if (groups.length <= maxCalls) return groups.map((g) => [g]);
  const chunkSize = Math.ceil(groups.length / maxCalls);
  const chunks = [];
  for (let i = 0; i < groups.length; i += chunkSize) {
    chunks.push(groups.slice(i, i + chunkSize));
  }
  return chunks;
}

function hashLoopReviewInput(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function proposalSuccessPayload(proposals) {
  return new ImplReviewProposalBatch(proposals).toJSON();
}

function persistLoopFinalArtifacts({ specDir, proposals, requirementIds }) {
  if (!specDir || !reviewArtifactWritePolicy.enabled) return;
  const jsonText = loopProposalsToImplReviewJson(proposals, requirementIds);
  fs.writeFileSync(path.join(specDir, "impl-review.json"), `${jsonText}\n`);
  fs.writeFileSync(path.join(specDir, "review.md"), formatImplReviewMd(new ImplReviewArtifact(JSON.parse(jsonText))));
}

function toolingFailureResult(failure) {
  return {
    toolingOutcome: new ReviewToolingOutcome({
      stage: ["parser_failure", "schema_failure"].includes(failure.failureKind)
        ? "parse"
        : "communication",
      attempt: 1,
      maxAttempts: 1,
      reason: failure.message || failure.failureKind,
      permissionRelated: /permission|EACCES|EPERM|sandbox/i.test(failure.message || ""),
    }),
    failureKind: failure.failureKind,
    failureCode: failure.failureCode || null,
    retryable: failure.retryable === true,
    recoveryHint: failure.recoveryHint || null,
    reviewRetryConsumed: false,
    proposals: [],
    summaries: [],
    reviewChunks: [],
    reviewCallCount: 0,
  };
}

async function executeWorkUnit({
  identity,
  checkpointStore,
  execute,
  proposalContract,
}) {
  if (!(proposalContract instanceof ImplReviewProposalContract)) {
    throw new Error("WorkUnit execution requires ImplReviewProposalContract");
  }
  const existing = checkpointStore?.load(identity);
  if (checkpointStore) {
    const resume = WorkUnitResumeDecision.fromCheckpoint(identity, existing);
    if (resume.action === "reuse") {
      const batch = proposalContract.fromJSON(existing.success);
      return {
        rawResponse: existing.rawResponse || "",
        proposals: batch.proposals,
        reused: true,
      };
    }
    if (resume.action === "blocked") {
      throw new WorkUnitToolingFailure({
        failureKind: existing.failure?.failureKind || "non_retryable_checkpoint",
        failureCode: existing.failure?.failureCode || "WORK_UNIT_NON_RETRYABLE_CHECKPOINT",
        retryable: false,
        recoveryHint: existing.failure?.recoveryHint
          || "Change the WorkUnit input or repair the external condition before creating new evidence.",
        message: existing.failure?.message
          || "WorkUnit is blocked by an unchanged non-retryable checkpoint",
        agentFailureKind: existing.failure?.agentFailureKind || null,
        attemptCount: existing.failure?.attemptCount ?? null,
        maxAttempts: existing.failure?.maxAttempts ?? null,
      });
    }
  }

  try {
    const rawResponse = await execute();
    const proposals = proposalContract.parse(rawResponse).proposals;
    checkpointStore?.saveSuccess({ identity, rawResponse, success: proposalSuccessPayload(proposals) });
    return { rawResponse, proposals, reused: false };
  } catch (err) {
    const failure = classifyWorkUnitFailure(err, { failureKind: err.failureKind });
    if (failure.commandFailure) throw err;
    checkpointStore?.saveFailed({ identity, failure });
    if (err instanceof AgentFailure) throw err;
    return toolingFailureResult(failure);
  }
}

async function executeWithProviderAttemptBudget(execute, executionBudget, { synthesis = false } = {}) {
  if (synthesis) executionBudget.consumeSynthesisCalls(1);
  const admission = new PromptProviderCallAdmission(executionBudget);
  try {
    return await execute(admission);
  } finally {
    if (!admission.settled) admission.settle();
  }
}

async function runLoopReviewWithDependencies({
  groups,
  maxLoopCalls = MAX_LOOP_CALLS,
  buildChunkInput,
  buildChunkAuthority = (_chunk, input) => input,
  reviewChunk,
  crossCheck,
  expandGroupProposals = expandProposalsToGroup,
  onBatch = null,
  onReviewChunk = null,
  checkpointStore = null,
  specDir = null,
  persistFinalArtifacts = false,
  providerIdentity = "default",
  promptVersion = "impl-review-loop-v1",
  requirementIds = new Set(),
  proposalContract = new ImplReviewProposalContract(requirementIds),
}) {
  if (!(proposalContract instanceof ImplReviewProposalContract)) {
    throw new Error("loop review requires ImplReviewProposalContract");
  }
  const needsCrossCheck = groups.length > 1;
  const reviewChunks = createLoopReviewChunks(groups, needsCrossCheck ? Math.max(1, maxLoopCalls - 1) : maxLoopCalls);
  const executionBudget = new PromptExecutionBudget(new PromptExecutionLimit({
    maxBatchCount: maxLoopCalls,
    maxProviderCallCount: maxLoopCalls,
    maxSynthesisCallCount: 1,
  }));
  executionBudget.assertCanExecute(reviewChunks.length + (needsCrossCheck ? 1 : 0));
  if (groups.length > maxLoopCalls && onBatch) onBatch({ groups, reviewChunks, maxLoopCalls });

  const allProposals = [];
  const summaries = [];
  const seen = new Map();
  let reviewCallCount = 0;

  for (let i = 0; i < reviewChunks.length; i++) {
    const chunk = reviewChunks[i];
    const input = buildChunkInput(chunk);
    const chunkHash = hashLoopReviewInput(input);

    let proposals = seen.get(chunkHash) || null;
    if (!seen.has(chunkHash)) {
      if (onReviewChunk) onReviewChunk({ chunk, index: reviewCallCount, total: reviewChunks.length });
      const identity = createLoopChunkWorkUnitIdentity({
        index: i,
        parentUnitId: null,
        targetFiles: chunk.flatMap((g) => g.files),
        input,
        providerIdentity,
        promptVersion,
        schemaVersion: proposalContract.schemaVersion,
        schemaDigest: proposalContract.schemaDigest,
        allowedRequirementIds: proposalContract.allowedRequirementIds,
      });
      const priorFailures = checkpointStore?.failuresForUnit(identity.unitId) || [];
      if (checkpointStore && shouldFallbackSplit(priorFailures)) {
        const children = planFallbackChildWorkUnits({
          parentIdentity: identity,
          parentChunk: chunk,
          priorFailures,
        });
        executionBudget.assertCanExecute(children.length);
        const childProposals = [];
        for (const child of children) {
          const childInput = buildChunkInput(child.groups);
          const childExecution = await executeWorkUnit({
            identity: child.identity,
            checkpointStore,
            execute: () => executeWithProviderAttemptBudget(
              (providerCallAdmission) => reviewChunk(child.groups, childInput, { providerCallAdmission }),
              executionBudget,
            ),
            proposalContract,
          });
          if (childExecution.toolingOutcome) return { ...childExecution, reviewCallCount: executionBudget.providerCallCount };
          childProposals.push(...expandChunkProposals(
            childExecution.proposals,
            child.groups,
            expandGroupProposals,
          ));
          if (!childExecution.reused) reviewCallCount += 1;
        }
        allProposals.push(...childProposals);
        summaries.push({
          file: chunk[0].representative,
          files: chunk.flatMap((group) => group.files),
          proposals: JSON.stringify(proposalSuccessPayload(childProposals)),
          requirementAuthority: buildChunkAuthority(chunk, input),
        });
        seen.set(chunkHash, childProposals);
        continue;
      }
      const execution = await executeWorkUnit({
        identity,
        checkpointStore,
        execute: () => executeWithProviderAttemptBudget(
          (providerCallAdmission) => reviewChunk(chunk, input, { providerCallAdmission }),
          executionBudget,
        ),
        proposalContract,
      });
      if (execution.toolingOutcome) return { ...execution, reviewCallCount: executionBudget.providerCallCount };
      proposals = execution.proposals;
      if (!execution.reused) reviewCallCount += 1;
    }
    const expandedProposals = seen.has(chunkHash)
      ? proposals
      : expandChunkProposals(proposals, chunk, expandGroupProposals);
    if (!seen.has(chunkHash)) seen.set(chunkHash, expandedProposals);
    summaries.push({
      file: chunk[0].representative,
      files: chunk.flatMap((group) => group.files),
      proposals: JSON.stringify(proposalSuccessPayload(expandedProposals)),
      requirementAuthority: buildChunkAuthority(chunk, input),
    });
    allProposals.push(...expandedProposals);
  }

  if (summaries.length > 1) {
    const identity = createCrossCheckWorkUnitIdentity({
      summaries,
      providerIdentity,
      promptVersion: `${promptVersion}:cross-check-v3-authoritative`,
      schemaVersion: proposalContract.schemaVersion,
      schemaDigest: proposalContract.schemaDigest,
      allowedRequirementIds: proposalContract.allowedRequirementIds,
    });
    const execution = await executeWorkUnit({
      identity,
      checkpointStore,
      execute: () => executeWithProviderAttemptBudget(
        (providerCallAdmission) => crossCheck(summaries, { providerCallAdmission }),
        executionBudget,
        { synthesis: true },
      ),
      proposalContract,
    });
    if (execution.toolingOutcome) return { ...execution, reviewCallCount: executionBudget.providerCallCount };
    if (!execution.reused) reviewCallCount += 1;
    allProposals.splice(0, allProposals.length, ...execution.proposals);
  }

  if (persistFinalArtifacts) {
    persistLoopFinalArtifacts({ specDir, proposals: allProposals, requirementIds });
  }
  return { proposals: allProposals, summaries, reviewChunks, reviewCallCount: executionBudget.providerCallCount };
}

function requireImplLoopRequirementId(proposal, requirementIds) {
  if (!(proposal instanceof ImplReviewProposal)) {
    throw new Error("impl review loop finding must be ImplReviewProposal");
  }
  if (!requirementIds.has(proposal.requirementId)) {
    throw new Error(`impl review loop finding has invalid requirementId: ${proposal.requirementId || "(missing)"}`);
  }
  return proposal.requirementId;
}

function loopProposalFindingKey(proposal, requirementId) {
  const identity = JSON.stringify({
    requirementId,
    file: proposal.file || null,
    title: proposal.title,
    issue: proposal.issue,
    suggestion: proposal.suggestion,
  });
  return `loop-${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

function loopProposalsToImplReviewJson(proposals, requirementIds = new Set()) {
  const allowedRequirementIds = normalizeImplReviewRequirementIds(requirementIds);
  return new TrustedLoopImplReviewOutput(JSON.stringify({
    blockingFindings: [],
    nonBlockingImprovements: proposals.map((proposal) => {
      const requirementId = requireImplLoopRequirementId(proposal, allowedRequirementIds);
      return {
        findingKey: loopProposalFindingKey(proposal, requirementId),
        title: proposal.title,
        failureMode: "refactor",
        ...(proposal.file ? { file: proposal.file } : {}),
        requirementId,
        issue: proposal.issue,
        suggestion: proposal.suggestion,
        disposition: "informational",
        rationale: "Loop review proposal.",
      };
    }),
  }), TRUSTED_LOOP_IMPL_REVIEW_OUTPUT_CAPABILITY);
}

async function runSingleShotImplReviewWithDependencies({ specDir, reviewText }) {
  if (!reviewArtifactWritePolicy.enabled) {
    return { changed: ["review.md", "impl-review.json"] };
  }
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, "impl-review.json"), `${reviewText}\n`);
  fs.writeFileSync(path.join(specDir, "review.md"), "# Code Review Results\n\n");
  return { changed: ["review.md", "impl-review.json"] };
}

async function runNonImplReviewWithDependencies({ phase, specDir, reviewText }) {
  if (!reviewArtifactWritePolicy.enabled) {
    return { changed: [`${phase}-review.json`] };
  }
  fs.mkdirSync(specDir, { recursive: true });
  const basename = `${phase}-review.json`;
  fs.writeFileSync(path.join(specDir, basename), `${reviewText}\n`);
  return { changed: [basename] };
}

async function runActiveImplReviewWithDependencies({
  touchedFiles,
  shouldUseLoopReview,
  runLoopReview,
  runSingleReview,
  persistImplReview,
}) {
  const useLoopReview = shouldUseLoopReview(touchedFiles.size);
  const reviewOutput = useLoopReview ? await runLoopReview() : await runSingleReview();
  if (reviewOutput?.toolingOutcome) return reviewOutput;
  const persistenceStrategy = useLoopReview && TrustedLoopImplReviewOutput.isAuthentic(reviewOutput)
    ? TRUSTED_LOOP_IMPL_REVIEW_PERSISTENCE
    : STRICT_IMPL_REVIEW_PERSISTENCE;
  return persistenceStrategy.persistWith(persistImplReview, reviewOutput);
}

async function runReviewWithDependencies(options) {
  const result = await runActiveImplReviewWithDependencies(options);
  if (result?.toolingOutcome) {
    return {
      result: "tooling-error",
      changed: [],
      artifacts: {
        phase: "impl",
        blockingCount: 0,
        nonBlockingCount: 0,
        failureKind: result.failureKind,
        toolingOutcome: result.toolingOutcome.toJSON(),
      },
      output: result.toolingOutcome.reason,
    };
  }
  return result;
}

async function runTaskReviewProtocol({
  root,
  executionIdentity,
  flowManager,
  requirementIds,
  agent,
  prompt,
  systemPrompt,
  callTransport = null,
  responseContract = null,
}) {
  const contract = responseContract ?? new ReviewProtocolContract({
      phase: "task-review",
      parse: (rawResponse) => parseImplReviewFindings(rawResponse, { requirementIds, taskReview: true }),
    });
  if (!(contract instanceof ReviewProtocolContract)) {
    throw new Error("Task Review protocol requires its typed response contract");
  }
  const transportRetryPolicy = taskReviewTransportRetryPolicy(agent);
  const controller = new ReviewProtocolController({
    contract,
    retryPolicy: new ReviewProtocolRetryPolicy({ maxAttempts: 2 }),
    transportRetryPolicy,
  });
  if (!(executionIdentity instanceof TaskReviewExecutionIdentity)) {
    throw new Error("Task Review protocol requires its typed execution identity");
  }
  const observer = new TaskReviewSourceEffectObserver({ root, executionIdentity, agent });
  const deferredMetrics = new Map();
  const metricSettlement = new ReviewProtocolAttemptSettlement({
    settle: async (attempt) => {
      const deferred = deferredMetrics.get(attempt) ?? null;
      if (deferred === null) return;
      deferredMetrics.delete(attempt);
      await deferred.flush();
    },
  });
  let latestTransportAttempt = null;
  let execution;
  try {
    execution = await controller.execute({
      observer,
      onAttempt: (attempt) => { latestTransportAttempt = attempt; },
      settlement: metricSettlement,
      callAgent: (attempt) => {
        const deferredMetric = new DeferredAgentInvocationMetric({ flowManager });
        deferredMetrics.set(attempt, deferredMetric);
        const protocolOptions = {
            cacheMode: attempt.cacheMode,
            // Source-effect observation encloses exactly one provider execution.
            retryCount: 0,
            deferredMetric,
            validateResponseForCache: (rawResponse) => {
              contract.accept(rawResponse);
              return true;
            },
          };
        return callTransport === null
          ? callReviewAgent(agent, prompt, "flow.impl.review.propose", systemPrompt, protocolOptions)
          : callTransport(prompt, protocolOptions);
      },
    });
  } catch (cause) {
    if (cause instanceof AgentFailure && latestTransportAttempt !== null) {
      cause.recordAttempts(
        latestTransportAttempt.transportNumber,
        transportRetryPolicy.retryCount + 1,
      );
    }
    throw cause;
  }
  return execution.rawResponse;
}

function taskReviewTransportRetryPolicy(agent) {
  const configured = agent.providerRetryPolicy();
  return new ReviewProtocolTransportRetryPolicy({
    retryCount: configured.retryCount,
    retryDelayMs: configured.retryDelayMs,
    backoffFactor: configured.backoffFactor,
  });
}

async function runLoopReview(executionRoot, flow, spec, mergeBase, fileMap, touchedFiles, guardrails, config = {}) {
  const requirementIds = new Set((spec.requirements || []).map((requirement) => requirement.id).filter(Boolean));
  const proposalContract = new ImplReviewProposalContract(requirementIds);
  const fileToReqs = invertFileMap(fileMap, spec.requirements || []);
  const checkpointStore = canonicalLoopReviewCheckpointStore();
  const workUnitDirectory = checkpointStore.specDir;
  const matcher = createReviewExcludeMatcher({ root: executionRoot, exclusions: resolveReviewExcludePaths(config) });
  const scopedFiles = new Set(matcher.filter([...touchedFiles]));
  const rawPerFileDiffs = collectPerFileDiffs(executionRoot, mergeBase, scopedFiles);
  const { groups } = prepareLoopReviewInputsWithExclusions({
    root: executionRoot,
    config,
    touchedFiles: scopedFiles,
    perFileDiffs: rawPerFileDiffs,
    fileToRequirements: fileToReqs,
    maxLoopCalls: MAX_LOOP_CALLS,
  });

  const draftAgent = ensureAgent("flow.impl.review.propose");
  const acknowledgedRationale = buildReviewAcknowledgedRationale(spec, guardrails);
  const systemPrompt = buildImplLoopReviewSystemPrompt(
    guardrails,
    acknowledgedRationale,
  );

  const result = await runLoopReviewWithDependencies({
    groups,
    maxLoopCalls: MAX_LOOP_CALLS,
    specDir: workUnitDirectory,
    checkpointStore,
    providerIdentity: "flow.impl.review.propose",
    promptVersion: "impl-review-loop-v1",
    requirementIds,
    proposalContract,
    buildChunkInput: (chunk) => buildChunkReviewInput(chunk, rawPerFileDiffs, fileToReqs),
    buildChunkAuthority: (chunk) => buildChunkRequirementAuthority(chunk, fileToReqs),
    reviewChunk: (chunk, input, invocationOptions = {}) => callReviewAgent(
      draftAgent,
      proposalContract.prompt({ userPrompt: input, systemPrompt }),
      "flow.impl.review.propose",
      null,
      invocationOptions,
    ),
    crossCheck: (summaries, invocationOptions = {}) => {
      console.error("  [loop-review] Running cross-check pass...");
      const crossCheckInput = buildCrossCheckInput(summaries);
      return callReviewAgent(
        draftAgent,
        proposalContract.prompt({
          userPrompt: crossCheckInput,
          systemPrompt: buildImplLoopCrossCheckSystemPrompt(guardrails, acknowledgedRationale),
        }),
        "flow.impl.review.propose",
        null,
        invocationOptions,
      );
    },
    onBatch: ({ reviewChunks }) => {
      console.error(`  [loop-review] ${groups.length} groups batched into ${reviewChunks.length} chunk(s) (limit ${MAX_LOOP_CALLS}).`);
    },
    onReviewChunk: ({ chunk, index, total }) => {
      console.error(`  [loop-review] Call ${index + 1}/${total}: ${chunkLabel(chunk)}...`);
    },
  });

  console.error(`  [loop-review] ${touchedFiles.size} files → ${groups.length} group(s) after compaction → ${result.reviewCallCount} AI call(s).`);

  console.error(`  [loop-review] ${result.proposals.length} total proposal(s).`);
  return result.toolingOutcome ? result : result.proposals;
}

// ---------------------------------------------------------------------------
// Common review loop
// ---------------------------------------------------------------------------

/**
 * Run a review-fix loop up to maxRetries times.
 * @param {Object} opts
 * @param {number} opts.maxRetries - Maximum iterations
 * @param {string} opts.label - Log label (e.g. "test-review", "spec-review")
 * @param {boolean} opts.dryRun - Skip fix phase if true
 * @param {() => Promise<{issues: Object[], raw: string}>} opts.detect - Detect issues. Return { issues, raw }.
 * @param {(raw: string) => Promise<void>} opts.fix - Apply fixes based on raw detection output.
 * @returns {Promise<{history: string[], finalIssues: Object[], verdict: string}>}
 */
async function runReviewLoop({ maxRetries, label, dryRun, detect, fix }) {
  const history = [];
  let finalIssues = [];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    console.error(`  [${label}] Analysis (attempt ${attempt + 1}/${maxRetries})...`);
    const { issues, raw } = await detect();
    history.push(raw);

    if (issues.length === 0) {
      console.error(`  [${label}] No issues found. PASS.`);
      finalIssues = [];
      break;
    }

    console.error(`  [${label}] ${issues.length} issue(s) found.`);
    finalIssues = issues;

    if (dryRun) {
      console.error(`  [${label}] (dry-run: skipping auto-fix)`);
      break;
    }

    console.error(`  [${label}] Applying fixes...`);
    await fix(raw);
  }

  // Verification detect: if loop ended with issues, run one more detect to check
  // whether the last fix resolved them. This handles the case where the previous
  // code skipped fix on the last iteration, missing fixes that resolved all issues.
  if (finalIssues.length > 0 && !dryRun) {
    console.error(`  [${label}] Verification detect...`);
    const { issues, raw } = await detect();
    history.push(raw);
    if (issues.length === 0) {
      console.error(`  [${label}] Verification PASS — all issues resolved.`);
      finalIssues = [];
    } else {
      console.error(`  [${label}] Verification: ${issues.length} issue(s) still remain.`);
      finalIssues = issues;
    }
  }

  const verdict = finalIssues.length === 0 ? "PASS" : "REJECTED";
  return { history, finalIssues, verdict };
}

// ---------------------------------------------------------------------------
// Test review pipeline (--phase test)
// ---------------------------------------------------------------------------

/**
 * Render spec.json.requirements as plain-text bullets for AI prompts. Post-T8
 * there is no regex-based spec.md Requirements extraction.
 */
function extractRequirements(spec) {
  const items = Array.isArray(spec?.requirements) ? spec.requirements : [];
  if (items.length === 0) return "";
  return items
    .map((r) => {
      const annotation = r.testable === false ? " (testing not required)" : "";
      return `- ${r.id}${r.priority ? ` [${r.priority}]` : ""}: ${r.desc}${annotation}`;
    })
    .join("\n");
}

const TEST_REVIEW_PROMPT_CHAR_LIMIT = MAX_IMPL_REQUIREMENT_BATCH_CHARS;

/**
 * Collect test files from the spec-local tests/ directory only.
 * Project-level tests/ are regression inputs for test-execute/impl-gate, not
 * semantic test-review prompt input.
 * @param {string} root
 * @param {string} specDir - relative spec directory
 * @returns {{ name: string, content: string, source: string }[]}
 */
function collectTestFiles(root, specDir, { sourceDirectory = null, sourceTopology = null } = {}) {
  const files = new Map();

  const specTestDir = sourceDirectory ?? path.resolve(root, specDir, "tests");
  const topology = sourceTopology ?? new CanonicalSpecTestTopology({
    repositoryRoot: path.resolve(root),
    canonicalTestRoot: path.resolve(root, specDir, "tests"),
  });
  if (!(topology instanceof CanonicalSpecTestTopology)) {
    throw new Error("test review source topology must be a CanonicalSpecTestTopology");
  }
  if (sourceDirectory !== null && sourceTopology === null) {
    throw new Error("materialized test review sources require their canonical topology");
  }
  if (fs.existsSync(specTestDir)) {
    collectTestsRecursive(specTestDir, specTestDir, files, topology);
  }

  return Array.from(files.values());
}

/**
 * Recursively collect test files from a directory.
 */
function collectTestsRecursive(dir, baseDir, fileMap, topology) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestsRecursive(full, baseDir, fileMap, topology);
    } else if (/\.(test|spec)\.(js|ts|mjs)$/.test(entry.name)) {
      const relName = path.relative(baseDir, full);
      const content = fs.readFileSync(full, "utf8");
      fileMap.set(relName, { name: relName, content, source: topology.sourcePath(relName) });
    }
  }
}

/**
 * Build the test design generation prompt.
 */
function buildTestDesignPrompt(requirements) {
  return [
    "You are a test design expert. Based on the following spec requirements, generate a comprehensive test design.",
    "List what should be tested, including:",
    "- Happy path scenarios",
    "- Edge cases and boundary conditions",
    "- Error paths and failure modes",
    "- Test type balance (unit / integration / acceptance)",
    "",
    "Output format:",
    "### Test Design",
    "For each test case:",
    "- **TC-N: <title>**",
    "  - Type: unit|integration|acceptance",
    "  - Input: <description>",
    "  - Expected: <description>",
    "",
    "## Requirements",
    requirements,
  ].join("\n");
}

/**
 * Serialize test files into markdown code blocks for prompts.
 */
function formatTestFilesForPrompt(testFiles) {
  if (testFiles.length === 0) return "(no test files found)";
  return testFiles
    .map((f) => `### ${f.source}\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");
}

/**
 * Build the gap analysis prompt.
 */
function buildGapAnalysisPrompt(testDesign, testFiles) {
  return new PromptBuilder()
    .setRole("You are a test quality reviewer. Compare the test design against actual test code and identify gaps.")
    .setRules([
      "For each gap, output:",
      "### GAP-N: <title>",
      "**Missing:** <what is not tested>",
      "**Severity:** HIGH|MEDIUM|LOW",
      "**Fix:** <concrete suggestion for test code>",
      "",
      "If all test cases are adequately covered, output: NO_GAPS",
    ].join("\n"))
    .addSystemPrompt("## Test Design", testDesign)
    .addUserPrompt("## Existing Test Code", formatTestFilesForPrompt(testFiles))
    .build();
}

/**
 * Build the test fix prompt.
 */
function buildTestFixPrompt(testDesign, gaps, testFiles) {
  return new PromptBuilder()
    .setRole("You are a test engineer. Fix the following gaps in the test code.")
    .setRules([
      "Output the complete updated test file(s) with fixes applied.",
      "For each file, output:",
      "### FILE: <path>",
      "```",
      "<complete file content>",
      "```",
      "",
      "Only modify files that need changes. Do not add unrelated tests.",
      "Note: constant definitions may be wrapped in Object.freeze(), Object.seal(), or similar. When writing regex patterns to match definitions, account for these wrappers (e.g. `=\\s*(?:Object\\.freeze\\()?\\[` instead of `=\\s*\\[`).",
    ].join("\n"))
    .addSystemPrompt("## Test Design", testDesign)
    .addUserPrompt("## Gaps to fix", gaps)
    .addUserPrompt("## Current test code", formatTestFilesForPrompt(testFiles))
    .build();
}

const TEST_REVIEW_JSON_FILE = "test-review.json";
const TEST_COVERAGE_JSON_FILE = "test-coverage.json";
const TEST_REVIEW_FINDING_KINDS = Object.freeze(["blocking", "advisory"]);
const TEST_REVIEW_TRUNCATION_SUFFIX = " [truncated]";

const TEST_REVIEW_BLOCKING_ITEM_SCHEMA = Object.freeze({
  type: "object",
  required: ["title", "target", "issue", "requiredChange", "whyBlocking", "origin", "failureKind"],
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1 },
    target: { type: "string", minLength: 1 },
    issue: { type: "string", minLength: 1 },
    requiredChange: { type: "string", minLength: 1 },
    whyBlocking: { type: "string", minLength: 1 },
    origin: { type: ["string", "null"] },
    failureKind: { type: ["string", "null"] },
    testPaths: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
    createTestPaths: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
  },
});

const TEST_REVIEW_ADVISORY_ITEM_SCHEMA = Object.freeze({
  type: "object",
  required: ["title", "target", "improvement", "whyNonBlocking"],
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1 },
    target: { type: "string", minLength: 1 },
    improvement: { type: "string", minLength: 1 },
    whyNonBlocking: { type: "string", minLength: 1 },
  },
});

const TEST_REVIEW_RESPONSE_SCHEMA = Object.freeze({
  type: "object",
  required: ["blockingFindings", "advisoryFindings"],
  additionalProperties: false,
  properties: {
    blockingFindings: {
      type: "array",
      items: TEST_REVIEW_BLOCKING_ITEM_SCHEMA,
    },
    advisoryFindings: {
      type: "array",
      items: TEST_REVIEW_ADVISORY_ITEM_SCHEMA,
    },
  },
});

const TEST_REVIEW_FMT_FALLBACK = [
  "OUTPUT FORMAT - strictly required:",
  "Return only a JSON object. No markdown, no preamble, no commentary.",
  "Schema:",
  JSON.stringify(TEST_REVIEW_RESPONSE_SCHEMA, null, 2),
  "Use empty arrays when there are no findings in a category.",
].join("\n");

function normalizeTestReviewText(value, fallback) {
  const text = typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
  return text.length > REVIEW_FINDING_CANONICAL_FIELD_MAX_CHARS
    ? `${text.slice(0, REVIEW_FINDING_CANONICAL_FIELD_MAX_CHARS - TEST_REVIEW_TRUNCATION_SUFFIX.length)}${TEST_REVIEW_TRUNCATION_SUFFIX}`
    : text;
}

class TestReviewFinding {
  constructor(kind, item) {
    if (!TEST_REVIEW_FINDING_KINDS.includes(kind)) {
      throw new Error(`invalid test review finding kind: ${kind}`);
    }
    this.kind = kind;
    this.title = normalizeTestReviewText(item.title, "Untitled test review finding");
    this.target = normalizeTestReviewText(item.target, "GLOBAL").replaceAll("\\", "/");
    this.testPaths = item.testPaths == null ? null : new TestReviewFindingPaths(item.testPaths, "testPaths");
    this.createTestPaths = item.createTestPaths == null ? null : new TestReviewFindingPaths(item.createTestPaths, "createTestPaths");
    if (this.testPaths !== null && this.createTestPaths !== null) {
      throw new Error("test review finding cannot both modify and create canonical test paths");
    }
    if (kind === "blocking") {
      this.issue = normalizeTestReviewText(item.issue, "Blocking test issue.");
      this.requiredChange = normalizeTestReviewText(item.requiredChange, "Fix the blocking test issue.");
      this.whyBlocking = normalizeTestReviewText(item.whyBlocking, "Implementation cannot proceed with this test issue unresolved.");
      this.origin = typeof item.origin === "string" && item.origin.trim() !== "" ? item.origin.trim() : null;
      this.failureKind = typeof item.failureKind === "string" && item.failureKind.trim() !== "" ? item.failureKind.trim() : null;
    } else {
      this.improvement = normalizeTestReviewText(item.improvement, "Advisory test improvement.");
      this.whyNonBlocking = normalizeTestReviewText(item.whyNonBlocking, "Implementation can proceed without this improvement.");
    }
    this.disposition = kind === "blocking" ? "must-fix" : "informational";
    this.rationale = kind === "blocking" ? this.whyBlocking : this.whyNonBlocking;
    this.fingerprint = ReviewFindingFingerprint.fromFinding({
      category: this.failureKind || kind,
      requirementId: this.target,
      file: this.target.includes("/") ? this.target : null,
      title: this.title,
      issue: kind === "blocking" ? this.issue : this.improvement,
    }).value;
    this.findingId = this.fingerprint;
  }

  toJSON() {
    const base = {
      kind: this.kind,
      title: this.title,
      target: this.target,
      findingId: this.findingId,
      fingerprint: this.fingerprint,
      disposition: this.disposition,
      rationale: this.rationale,
      ...(this.testPaths !== null && { testPaths: this.testPaths.toJSON() }),
      ...(this.createTestPaths !== null && { createTestPaths: this.createTestPaths.toJSON() }),
    };
    if (this.kind === "blocking") {
      return {
        ...base,
        issue: this.issue,
        requiredChange: this.requiredChange,
        whyBlocking: this.whyBlocking,
        ...(this.origin && { origin: this.origin }),
        ...(this.failureKind && { failureKind: this.failureKind }),
      };
    }
    return {
      ...base,
      improvement: this.improvement,
      whyNonBlocking: this.whyNonBlocking,
    };
  }
}

/** A validated, deterministic canonical test-path capability in review output. */
class TestReviewFindingPaths {
  constructor(value, field) {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`test review finding ${field} must contain canonical test paths`);
    }
    const paths = value.map((candidate) => {
      if (typeof candidate !== "string" || candidate.trim() === "") {
        throw new Error(`test review finding ${field} paths must be non-empty strings`);
      }
      return candidate.trim().replaceAll("\\", "/");
    });
    if (new Set(paths).size !== paths.length) {
      throw new Error(`test review finding ${field} paths must be unique`);
    }
    this.paths = Object.freeze([...paths].sort());
    Object.freeze(this);
  }

  toJSON() { return [...this.paths]; }
}

class RequirementCoverageEntry {
  constructor(requirement, files) {
    this.id = requirement.id;
    this.desc = requirement.desc;
    this.testable = requirement.testable !== false;
    this.files = Object.freeze([...files].sort());
    this.status = this.testable
      ? (this.files.length > 0 ? "covered" : "uncovered")
      : "not_testable";
  }

  toJSON() {
    return {
      id: this.id,
      desc: this.desc,
      testable: this.testable,
      status: this.status,
      files: this.files,
    };
  }
}

class TestFileCoverageEntry {
  constructor(specDir, file, info) {
    this.file = path.relative(specDir, file).split(path.sep).join("/");
    this.headerIds = Object.freeze([...(info.headerIds || [])]);
    this.testNameIds = Object.freeze([...(info.testNameIds || [])]);
    this.headerStatus = info.scan?.kind || "unknown";
  }

  toJSON() {
    return {
      file: this.file,
      headerStatus: this.headerStatus,
      headerIds: this.headerIds,
      testNameIds: this.testNameIds,
    };
  }
}

class TestCoverageArtifact {
  constructor({
    spec,
    specDir,
    headerResult,
    fileHeaders,
    sourceTestArtifactRevision,
    generatedAt = new Date().toISOString(),
  }) {
    this.version = 1;
    this.phase = "test-review";
    this.generatedAt = generatedAt;
    this.sourceTestArtifactRevision = WorkerArtifactRevision.from(sourceTestArtifactRevision);
    this.validation = Object.freeze({
      ok: headerResult.ok === true,
      messages: headerResult.messages || [],
    });
    const reqToFiles = new Map();
    for (const [file, info] of fileHeaders) {
      for (const id of info.headerIds || []) {
        if (!reqToFiles.has(id)) reqToFiles.set(id, []);
        reqToFiles.get(id).push(path.relative(specDir, file).split(path.sep).join("/"));
      }
    }
    this.requirements = Object.freeze(
      (Array.isArray(spec?.requirements) ? spec.requirements : [])
        .map((req) => new RequirementCoverageEntry(req, reqToFiles.get(req.id) || [])),
    );
    this.files = Object.freeze(
      [...fileHeaders.entries()].map(([file, info]) => new TestFileCoverageEntry(specDir, file, info)),
    );
  }

  toPromptSummary() {
    return {
      version: this.version,
      phase: this.phase,
      sourceTestArtifactRevision: this.sourceTestArtifactRevision.toJSON(),
      validation: this.validation,
      requirements: this.requirements.map((entry) => entry.toJSON()),
      files: this.files.map((entry) => entry.toJSON()),
    };
  }

  toJSON() {
    return this.toPromptSummary();
  }
}

class TestCoverageFailureArtifact {
  constructor(message, sourceTestArtifactRevision) {
    this.message = normalizeTestReviewText(message, "coverage artifact generation failed");
    this.sourceTestArtifactRevision = WorkerArtifactRevision.from(sourceTestArtifactRevision);
  }

  toPromptSummary() {
    return {
      version: 1,
      phase: "test-review",
      sourceTestArtifactRevision: this.sourceTestArtifactRevision.toJSON(),
      validation: {
        ok: false,
        messages: [this.message],
      },
      requirements: [],
      files: [],
    };
  }

  toJSON() {
    return this.toPromptSummary();
  }
}

class TestReviewArtifact {
  constructor({
    verdict = null,
    coverageArtifact,
    sourceTestArtifactRevision,
    blocking = [],
    advisory = [],
    toolingOutcome = null,
    generatedAt = new Date().toISOString(),
  }) {
    this.version = 1;
    this.phase = "test";
    this.generatedAt = generatedAt;
    this.coverageArtifact = coverageArtifact;
    this.sourceTestArtifactRevision = WorkerArtifactRevision.from(sourceTestArtifactRevision);
    this.blockingFindings = blocking.map((item) => item instanceof TestReviewFinding ? item : new TestReviewFinding("blocking", item));
    this.advisoryFindings = advisory.map((item) => item instanceof TestReviewFinding ? item : new TestReviewFinding("advisory", item));
    this.toolingOutcome = toolingOutcome == null
      ? null
      : toolingOutcome instanceof ReviewToolingOutcome
        ? toolingOutcome
        : new ReviewToolingOutcome(toolingOutcome);
    if (this.toolingOutcome) {
      if (verdict != null) throw new Error("test review tooling outcome cannot also contain a verdict");
      if (this.blockingFindings.length > 0 || this.advisoryFindings.length > 0) {
        throw new Error("test review tooling outcome cannot contain findings");
      }
    } else {
      if (!["PASS", "ADVISORY", "REJECTED"].includes(verdict)) {
        throw new Error(`invalid test review verdict: ${verdict}`);
      }
      this.verdict = verdict;
    }
    this.counts = Object.freeze({
      blocking: this.blockingFindings.length,
      advisory: this.advisoryFindings.length,
      total: this.blockingFindings.length + this.advisoryFindings.length,
    });
  }

  toJSON() {
    return {
      version: this.version,
      phase: this.phase,
      generatedAt: this.generatedAt,
      ...(this.verdict && { verdict: this.verdict }),
      ...(this.toolingOutcome && { toolingOutcome: this.toolingOutcome.toJSON() }),
      counts: this.counts,
      coverageArtifact: this.coverageArtifact,
      sourceTestArtifactRevision: this.sourceTestArtifactRevision.toJSON(),
      blockingFindings: this.blockingFindings.map((item) => item.toJSON()),
      advisoryFindings: this.advisoryFindings.map((item) => item.toJSON()),
    };
  }
}

function buildTestReviewPrompt(requirements, coverageArtifact, testFiles) {
  return new PromptBuilder()
    .setRole("You are a bounded static test review mapper. Classify only test design and static anti-pattern issues before implementation.")
    .setRules([
      "This map reviews its supplied canonical test ranges and does not auto-fix tests; final cross-file synthesis runs only after every range completes.",
      "PASS means blockingFindings[] and advisoryFindings[] are both empty.",
      "ADVISORY means blockingFindings[] is empty and advisoryFindings[] has useful non-blocking improvements.",
      "REJECTED means blockingFindings[] has at least one issue that blocks implementation.",
      "Use blockingFindings[] only for concrete blockers:",
      "- an acceptance requirement has no corresponding spec-local test coverage",
      "- a critical risk has no regression test",
      "- a test is not executable or clearly contradicts the target API",
      "- a test encodes an incorrect implementation premise",
      "- a test invents a module path, export, function, constant, method, or artifact shape not fixed by the spec or an existing public API",
      "- the requirement coverage artifact contradicts the actual test files",
      "- the test has a static anti-pattern that would pass without exercising production behavior",
      "Use advisoryFindings[] for non-blocking improvements:",
      "- naming or TC numbering improvements",
      "- helpful extra boundary cases",
      "- duplicate coverage from another useful viewpoint",
      "- wording drift in test design notes that does not affect executable tests",
      "Do not fail for advisory findings.",
      "Do not ask for a review/fix/re-review loop.",
      "Do not rewrite tests. Report the smallest requiredChange for blocking findings.",
      "Runtime pass/fail belongs to scenario-validity, test-execute, test-result-review, impl-gate, and final-regression.",
      "",
      "Return JSON only. The response object must contain:",
      "- blockingFindings[] with title, target, issue, requiredChange, whyBlocking, origin, failureKind, plus testPaths[] for existing canonical spec tests or createTestPaths[] for required new canonical spec tests",
      "- advisoryFindings[] with title, target, improvement, whyNonBlocking",
      "- testPaths[] and createTestPaths[] are optional but mutually exclusive. testPaths[] must contain exact existing paths from the supplied test inventory; createTestPaths[] must contain explicit new canonical spec-relative test paths that are absent from that inventory. Never use source paths or prose.",
      "- Use null for origin or failureKind when it does not apply.",
      "- Use empty arrays when there are no findings in a category.",
    ].join("\n"))
    .setJsonSchema(TEST_REVIEW_RESPONSE_SCHEMA)
    .setFmtFallback(TEST_REVIEW_FMT_FALLBACK)
    .addUserPrompt("## Requirements", requirements)
    .addUserPrompt("## Requirement-to-Test Coverage Artifact", JSON.stringify(coverageArtifact.toPromptSummary(), null, 2))
    .addUserPrompt("## Spec-local Test Code", formatTestFilesForPrompt(testFiles))
    .build();
}

function buildTestReviewSynthesisPrompt(findingTexts, sourceRefs = []) {
  return new PromptBuilder()
    .setRole("You are the final cross-file test review synthesizer. Resolve duplicate or contradictory map findings only after all canonical test ranges were reviewed.")
    .setRules([
      "Return JSON only with blockingFindings[] and advisoryFindings[].",
      "Prefer blocking when the same fingerprint has contradictory dispositions.",
      "Check requirement coverage and cross-file header/test-name consistency globally.",
      "Adjudicate every supplied map finding; omit one only when canonical authority disproves or resolves it. The returned JSON is authoritative.",
      "Do not invent a finding merely because a source range is absent; all ranges were completed before this synthesis.",
    ])
    .setJsonSchema(TEST_REVIEW_RESPONSE_SCHEMA)
    .setFmtFallback(TEST_REVIEW_FMT_FALLBACK)
    .addUserPrompt("## Covered Canonical Evidence References", sourceRefs.join("\n") || "(none)")
    .addUserPrompt("## Reduced Canonical Authority and Validated Map Evidence", findingTexts.join("\n\n"))
    .build();
}

function parseTestReviewJsonOutput(raw) {
  const candidate = extractJsonObjectCandidate(raw);
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    parsed = JSON.parse(repairJson(candidate));
  }
  parsed = normalizeReviewResponseArrays(parsed, ["blockingFindings", "advisoryFindings"]);
  for (const item of parsed.blockingFindings) {
    if (item && typeof item === "object") {
      if (!Object.prototype.hasOwnProperty.call(item, "origin")) item.origin = null;
      if (!Object.prototype.hasOwnProperty.call(item, "failureKind")) item.failureKind = null;
    }
  }
  const errors = validateSchema(parsed, TEST_REVIEW_RESPONSE_SCHEMA);
  if (errors.length > 0) {
    throw new Error(`test review output failed schema validation: ${errors.join("; ")}`);
  }
  return parsed;
}

function parseTestReviewFindings(raw) {
  const parsed = parseTestReviewJsonOutput(raw);
  return {
    blocking: parsed.blockingFindings.map((item) => new TestReviewFinding("blocking", item)),
    advisory: parsed.advisoryFindings.map((item) => new TestReviewFinding("advisory", item)),
  };
}

function mergeTestReviewFindingBatches(batches) {
  const selected = new Map();
  for (const batch of batches) {
    for (const finding of [...batch.advisory, ...batch.blocking]) {
      const previous = selected.get(finding.fingerprint);
      if (previous === undefined || (previous.kind === "advisory" && finding.kind === "blocking")) {
        selected.set(finding.fingerprint, finding);
      }
    }
  }
  return {
    blocking: [...selected.values()].filter((finding) => finding.kind === "blocking"),
    advisory: [...selected.values()].filter((finding) => finding.kind === "advisory"),
  };
}

class TestReviewFindingReducer extends PromptBatchReducer {
  reduce(completions) {
    return mergeTestReviewFindingBatches(completions.map((completion) => completion.response));
  }
}

function buildHeaderBlockingFindings(headerResult) {
  const findings = [];
  const headerFinding = (failureKind, item) => new TestReviewFinding("blocking", {
    origin: "test-coverage",
    failureKind,
    ...item,
  });
  for (const file of headerResult.missingHeaders || []) {
    findings.push(headerFinding("missing_header", {
      title: "Missing spec header",
      target: file,
      issue: "A spec-local test file lacks the required `// spec: R1 R2 ...` header.",
      requiredChange: "Add a valid spec header before the first non-comment code line.",
      whyBlocking: "Requirement coverage cannot be audited without a header-to-test mapping.",
    }));
  }
  for (const req of headerResult.uncoveredRequirements || []) {
    findings.push(headerFinding("uncovered_requirement", {
      title: "Uncovered requirement",
      target: req.id,
      issue: `${req.id} is testable but no spec-local test header declares it.`,
      requiredChange: `Add or update a spec-local test with a header covering ${req.id}.`,
      whyBlocking: "Implementation would proceed without required acceptance coverage.",
    }));
  }
  for (const entry of headerResult.unknownIds || []) {
    findings.push(headerFinding("unknown_requirement_id", {
      title: "Unknown requirement id in test header",
      target: `${entry.file}:${entry.id}`,
      issue: `The test header declares ${entry.id}, which is not in spec.json requirements.`,
      requiredChange: "Replace the header id with a valid requirement id or update the spec before reviewing tests.",
      whyBlocking: "The requirement coverage artifact contradicts the executable test files.",
    }));
  }
  for (const entry of headerResult.malformedHeaders || []) {
    findings.push(headerFinding("malformed_header", {
      title: "Malformed spec header",
      target: `${entry.file}:${entry.line}`,
      issue: entry.reason || "The spec header does not match the required strict form.",
      requiredChange: "Use the exact `// spec: R1 R2 ...` header form.",
      whyBlocking: "Malformed coverage markers make requirement-to-test evidence unreliable.",
    }));
  }
  for (const entry of headerResult.duplicateIds || []) {
    findings.push(headerFinding("duplicate_requirement_id", {
      title: "Duplicate requirement id in spec header",
      target: `${entry.file}:${entry.id}`,
      issue: `The spec header repeats ${entry.id}.`,
      requiredChange: "Keep each requirement id only once in the file header.",
      whyBlocking: "Duplicate coverage markers make the coverage artifact ambiguous.",
    }));
  }
  for (const entry of headerResult.duplicateHeaders || []) {
    findings.push(headerFinding("duplicate_header", {
      title: "Multiple spec headers in one test file",
      target: `${entry.file}:${entry.lineNumber}`,
      issue: "The test file contains more than one spec header.",
      requiredChange: "Merge requirement ids into the first header and remove duplicate headers.",
      whyBlocking: "Multiple header sources make the coverage artifact ambiguous.",
    }));
  }
  for (const entry of headerResult.notTestableInHeader || []) {
    findings.push(headerFinding("not_testable_in_header", {
      title: "Non-testable requirement declared as covered",
      target: `${entry.file}:${entry.id}`,
      issue: `${entry.id} is marked testable=false but appears in a test header.`,
      requiredChange: "Remove the requirement id from the test header or make the requirement testable in spec.json.",
      whyBlocking: "The coverage artifact contradicts the spec's testability contract.",
    }));
  }
  for (const entry of headerResult.mismatchedMarker || []) {
    findings.push(headerFinding("wrong_header_marker", {
      title: "Wrong spec header marker",
      target: `${entry.file}:${entry.lineNumber}`,
      issue: `JS-like test files must use // spec headers, but this file uses ${entry.found}.`,
      requiredChange: "Use `// spec: R1 R2 ...` for JS-like test files.",
      whyBlocking: "The header parser cannot trust mismatched marker syntax.",
    }));
  }
  for (const entry of headerResult.headerNoTest || []) {
    findings.push(headerFinding("header_without_test_name", {
      title: "Header id has no matching test name",
      target: `${entry.file}:${entry.id}`,
      issue: `The header declares ${entry.id}, but the file has no '${entry.id}: ...' test name.`,
      requiredChange: `Add a '${entry.id}: ...' test name or remove ${entry.id} from the header.`,
      whyBlocking: "The coverage artifact claims requirement coverage that the test body does not expose.",
    }));
  }
  for (const entry of headerResult.testNoHeader || []) {
    findings.push(headerFinding("test_name_without_header", {
      title: "Test name lacks matching header id",
      target: `${entry.file}:${entry.id}`,
      issue: `The file has a '${entry.id}: ...' test name but the header does not declare ${entry.id}.`,
      requiredChange: `Add ${entry.id} to the file header or rename the test.`,
      whyBlocking: "The coverage artifact omits a requirement referenced by executable tests.",
    }));
  }
  return findings;
}

async function runTestReviewWithDependencies({
  buildReviewPrompt,
  callAgent,
  testFiles = null,
  requirementEntries = null,
  coverageSummary = null,
  maxChars = TEST_REVIEW_PROMPT_CHAR_LIMIT,
  parseResponse = null,
  projectInvocation = null,
  synthesize = null,
}) {
  if (!Array.isArray(testFiles)) throw new Error("Test Review requires typed planner inputs");
  const plan = TestReviewPromptPlan.create({
      testFiles,
      buildPrompt: buildReviewPrompt,
      maxChars,
      requirementEntries,
      coverageSummary,
    });
    const executionBudget = new PromptExecutionBudget(new PromptExecutionLimit({
        maxRequestCharacters: maxChars,
        maxBatchCount: Math.max(plan.batches.length, 16),
        maxProviderCallCount: plan.batches.length + 16,
        maxSynthesisCallCount: 16,
        maxAggregateCharacters: 1_000_000,
      }));
    const executor = new PromptBatchExecutor({ executionBudget });
    const completions = await executor.executeCompletions({
      plan: plan.corePlan,
      callAgent,
      responseContract: {
        parse: parseResponse,
        itemCount: (response) => response.blocking.length + response.advisory.length,
      },
      ...(projectInvocation === null ? {} : { projectInvocation }),
    });
    const merged = new TestReviewFindingReducer().reduce(completions);
  return completions.length > 1 && synthesize
    ? synthesize({ completions, merged, executionBudget, plan })
    : merged;
}

function classifyReviewCommandError(err, phase) {
  while (err instanceof PromptBatchingError && err.cause) err = err.cause;
  if (err instanceof PromptBatchingError) {
    const promptFailure = ReviewFailure.fromPromptBatchingFailure({
      phase: phase || "impl",
      failure: err,
    });
    if (promptFailure) return promptFailure;
  }
  if (err instanceof ReviewProtocolFailure) {
    const resolvedPhase = phase || "impl";
    const sourceEffect = err.kind === "effect_observed";
    const observationUnavailable = err.kind === "observation_unavailable";
    const detail = typeof err.cause?.message === "string" && err.cause.message.trim() !== ""
      ? ` ${err.cause.message.trim()}`
      : "";
    return ReviewFailure.providerFailure({
      phase: resolvedPhase,
      reason: sourceEffect
        ? `Task Review observed source effects before a complete response was accepted at protocol attempt ${err.attempt.number}/${err.maxAttempts}.${detail}`
        : observationUnavailable
          ? `Task Review could not verify whether the provider changed source at protocol attempt ${err.attempt.number}/${err.maxAttempts}.${detail}`
        : `Task Review provider output did not satisfy its complete phase contract after protocol attempt ${err.attempt.number}/${err.maxAttempts}.${detail}`,
      recoveryHint: sourceEffect
        ? "Do not retry Review until the definition-selected recovery route has verified the source."
        : observationUnavailable
          ? "Do not retry Review until the definition-selected tooling recovery route restores source observation."
        : "The provider returned invalid review output; follow the definition-selected tooling recovery route.",
      recoveryCommand: resolvedPhase === "impl"
        ? "sennel flow run review"
        : `sennel flow run review --phase ${resolvedPhase}`,
      failureCode: sourceEffect
        ? "TASK_REVIEW_SOURCE_EFFECT_OBSERVED"
        : observationUnavailable
          ? "TASK_REVIEW_SOURCE_OBSERVATION_UNAVAILABLE"
        : "TASK_REVIEW_PROTOCOL_INVALID_RESPONSE",
      retryable: false,
      agentFailureKind: "review_protocol",
      attemptCount: err.attempt.number,
      maxAttempts: err.maxAttempts,
    });
  }
  if (err instanceof AgentFailure) {
    const resolvedPhase = phase || "impl";
    return ReviewFailure.fromAgentFailure({
      phase: resolvedPhase,
      failure: err,
      recoveryCommand: resolvedPhase === "impl"
        ? "sennel flow run review"
        : `sennel flow run review --phase ${resolvedPhase}`,
    });
  }
  if (err instanceof WorkUnitToolingFailure && err.failureCode) {
    const resolvedPhase = phase || "impl";
    return ReviewFailure.providerFailure({
      phase: resolvedPhase,
      reason: err.message,
      recoveryHint: err.recoveryHint
        || "Change the WorkUnit input or repair the external condition before starting new review evidence.",
      recoveryCommand: resolvedPhase === "impl"
        ? "sennel flow run review"
        : `sennel flow run review --phase ${resolvedPhase}`,
      failureCode: err.failureCode,
      retryable: err.retryable === true,
      agentFailureKind: err.agentFailureKind || "work_unit_checkpoint",
      attemptCount: err.attemptCount,
      maxAttempts: err.maxAttempts,
    });
  }
  const message = String(err?.message || err || "");
  const schemaFailure = message.match(/impl review output failed schema validation:\s*([^\n]+)/i);
  if ((phase == null || phase === "impl") && schemaFailure) {
    return ReviewFailure.schemaFailure({
      phase: "impl",
      targetReview: "impl-review",
      validationError: schemaFailure[1].trim(),
      currentAttempt: 1,
      maximumAttempts: 2,
    });
  }
  const recoveryCommand = phase ? `sennel flow run review --phase ${phase}` : "sennel flow run review";
  return ReviewFailure.fromMessage({ phase: phase || "impl", message, recoveryCommand });
}

function parseReviewCliArgsForError(rawArgs) {
  try {
    const cli = parseArgs(rawArgs, {
      flags: ["--dry-run", "--skip-confirm"],
      options: ["--phase"],
      defaults: { phase: null },
    });
    return { ...cli, phase: VALID_PHASES.includes(cli.phase) ? cli.phase : null };
  } catch (_) {
    return { phase: null };
  }
}

/**
 * Parse gap analysis output.
 * @param {string} text
 * @returns {{ title: string, body: string }[]}
 */
function parseGaps(text) {
  if (/NO_GAPS/i.test(text)) return [];
  const gaps = [];
  const parts = text.split(/^### GAP-/m).filter(Boolean);
  for (const part of parts) {
    const nlIdx = part.indexOf("\n");
    const title = nlIdx >= 0 ? part.slice(0, nlIdx).trim() : part.trim();
    const body = nlIdx >= 0 ? part.slice(nlIdx + 1).trim() : "";
    gaps.push({ title, body });
  }
  return gaps;
}

/**
 * Parse file fix output and apply to disk.
 * @param {string} text - AI output with ### FILE: <path> blocks
 * @param {string} root
 * @param {string} specDir
 * @returns {string[]} paths of files written
 */
function applyTestFixes(text, root, specDir) {
  const written = [];
  const allowedRoot = path.resolve(root, specDir, "tests");
  const fileParts = text.split(/^### FILE:\s*/m).filter(Boolean);
  for (const part of fileParts) {
    const nlIdx = part.indexOf("\n");
    if (nlIdx < 0) continue;
    const filePath = part.slice(0, nlIdx).trim();
    const codeMatch = part.match(/```(?:\w*)\n([\s\S]*?)```/);
    if (!codeMatch) continue;
    const absPath = path.resolve(root, filePath);
    const relToAllowedRoot = path.relative(allowedRoot, absPath);
    if (relToAllowedRoot.startsWith("..") || path.isAbsolute(relToAllowedRoot)) {
      throw new Error(`test review fix attempted to write outside ${path.relative(root, allowedRoot)}: ${filePath}`);
    }
    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absPath, codeMatch[1]);
    written.push(filePath);
  }
  return written;
}

/**
 * Format test-review.md content.
 */
function formatTestReviewMd(reviewArtifact) {
  const lines = ["# Test Review Results", ""];
  if (reviewArtifact.toolingOutcome) {
    lines.push(`## Tooling Outcome: ${reviewArtifact.toolingOutcome.kind}`, "");
  } else {
    lines.push(`## Verdict: ${reviewArtifact.verdict}`, "");
  }
  lines.push(`Coverage artifact: \`${reviewArtifact.coverageArtifact}\``, "");

  if (reviewArtifact.toolingOutcome) {
    const outcome = reviewArtifact.toolingOutcome;
    lines.push("## Tooling Outcome", "");
    lines.push(`- kind: ${outcome.kind}`);
    lines.push(`- stage: ${outcome.stage}`);
    lines.push(`- attempt: ${outcome.attempt}/${outcome.maxAttempts}`);
    lines.push(`- reason: ${outcome.reason}`);
    lines.push("- recovery: Recover the test-review tooling error or register finalized independent evidence.");
    lines.push("");
  }

  lines.push("## Blocking Findings", "");
  if (reviewArtifact.blockingFindings.length === 0) {
    lines.push("No blocking findings.");
  } else {
    for (let i = 0; i < reviewArtifact.blockingFindings.length; i++) {
      const finding = reviewArtifact.blockingFindings[i];
      lines.push(`### ${i + 1}. ${finding.title}`);
      lines.push(`**Target:** ${finding.target}`);
      lines.push(`**Issue:** ${finding.issue}`);
      lines.push(`**Required change:** ${finding.requiredChange}`);
      lines.push(`**Why blocking:** ${finding.whyBlocking}`);
      lines.push("");
    }
  }

  lines.push("", "## Advisory Findings", "");
  if (reviewArtifact.advisoryFindings.length === 0) {
    lines.push("No advisory findings.");
  } else {
    for (let i = 0; i < reviewArtifact.advisoryFindings.length; i++) {
      const finding = reviewArtifact.advisoryFindings[i];
      lines.push(`### ${i + 1}. ${finding.title}`);
      lines.push(`**Target:** ${finding.target}`);
      lines.push(`**Improvement:** ${finding.improvement}`);
      lines.push(`**Why non-blocking:** ${finding.whyNonBlocking}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

function writeTestReviewArtifacts({ root, specDir, reviewArtifact, coverageArtifact }) {
  const reviewDir = path.resolve(root, specDir);
  if (reviewArtifactWritePolicy.enabled) fs.mkdirSync(reviewDir, { recursive: true });
  const coveragePath = path.join(reviewDir, TEST_COVERAGE_JSON_FILE);
  const reviewJsonPath = path.join(reviewDir, TEST_REVIEW_JSON_FILE);
  const reviewMdPath = path.join(reviewDir, "test-review.md");
  const reviewJson = reviewArtifact.toJSON();
  if (reviewJson.verdict) {
    reviewJson.contractSummary = contractFromTestReviewArtifact(reviewJson, {
      artifactPath: path.relative(root, reviewJsonPath).split(path.sep).join("/"),
    }).summary.toJSON();
  }
  const attemptNumber = reviewHistoryAttemptNumber(reviewDir, "test");
  writeJsonArtifact(coveragePath, coverageArtifact);
  writeReviewAttemptHistory({
    specDir: reviewDir,
    phase: "test",
    latestBasename: "test-review.md",
    attemptNumber,
    content: formatTestReviewMd(reviewArtifact),
    findings: [
      ...findingsWithSeverity(reviewArtifact.blockingFindings, "blocking"),
      ...findingsWithSeverity(reviewArtifact.advisoryFindings, "non-blocking"),
    ],
  });
  writeReviewAttemptHistory({
    specDir: reviewDir,
    phase: "test",
    latestBasename: TEST_REVIEW_JSON_FILE,
    attemptNumber,
    artifact: reviewJson,
  });
  return {
    coveragePath: path.relative(root, coveragePath).split(path.sep).join("/"),
    reviewJsonPath: path.relative(root, reviewJsonPath).split(path.sep).join("/"),
    reviewMdPath: path.relative(root, reviewMdPath).split(path.sep).join("/"),
  };
}

function writeTestCoverageArtifact({ root, specDir, coverageArtifact }) {
  const reviewDir = path.resolve(root, specDir);
  if (reviewArtifactWritePolicy.enabled) fs.mkdirSync(reviewDir, { recursive: true });
  const coveragePath = path.join(reviewDir, TEST_COVERAGE_JSON_FILE);
  writeJsonArtifact(coveragePath, coverageArtifact);
  return path.relative(root, coveragePath).split(path.sep).join("/");
}

function buildToolingFailureReview({ kind, err, coverageRelPath, sourceTestArtifactRevision }) {
  const message = err?.message || String(err);
  const toolingOutcome = new ReviewToolingOutcome({
    stage: kind === "coverage_error" || kind === "parser_error" ? "parse" : "communication",
    attempt: 1,
    maxAttempts: 1,
    reason: normalizeTestReviewText(message, kind),
    permissionRelated: /permission|EACCES|EPERM|sandbox/i.test(message),
  });
  return new TestReviewArtifact({
    coverageArtifact: coverageRelPath || TEST_COVERAGE_JSON_FILE,
    sourceTestArtifactRevision,
    blocking: [],
    advisory: [],
    toolingOutcome,
  });
}

/**
 * Run the test review pipeline.
 */
async function runTestReview(root, flow, spec, config, dryRun) {
  const specPath = relativeFlowSpecFile(flow);
  const specDir = path.dirname(specPath);
  const outputDirectory = reviewOutputDirectory();
  const testSourceDirectory = reviewTestSourceDirectory();
  const testSourceTopology = reviewTestSourceTopology(root);
  const sourceTestArtifactRevision = reviewTestArtifactRevision();
  sourceTestArtifactRevision.assertFlow(flow);
  if (sourceTestArtifactRevision.stepId !== "test") {
    throw new Error("test-review requires a canonical test-step artifact revision");
  }

  const requirements = extractRequirements(spec);
  if (!requirements) {
    console.error("Error: no requirements defined in spec.json");
    process.exit(EXIT_ERROR);
  }

  let coverageArtifact;
  let headerBlockingFindings = [];
  let artifactPaths;
  try {
    const { validateTestHeaders, collectFileHeaders, formatValidationMessages } = await import("../lib/test-headers.js");
    const absoluteSpecDir = testSourceDirectory;
    const headerResult = validateTestHeaders({
      specDir: absoluteSpecDir,
      spec,
    });
    headerResult.messages = formatValidationMessages(headerResult);
    coverageArtifact = new TestCoverageArtifact({
      spec,
      specDir: absoluteSpecDir,
      headerResult,
      fileHeaders: collectFileHeaders(absoluteSpecDir),
      sourceTestArtifactRevision,
    });
    artifactPaths = {
      coveragePath: writeTestCoverageArtifact({ root, specDir: outputDirectory, coverageArtifact }),
    };
    headerBlockingFindings = buildHeaderBlockingFindings(headerResult);
    if (headerBlockingFindings.length > 0) {
      console.error(`  [test-review] header validation: ${headerBlockingFindings.length} blocking finding(s)`);
    }
  } catch (err) {
    coverageArtifact = new TestCoverageFailureArtifact(err.message, sourceTestArtifactRevision);
    const coverageRelPath = `${specDir}/${TEST_COVERAGE_JSON_FILE}`.split(path.sep).join("/");
    const reviewArtifact = buildToolingFailureReview({
      kind: "coverage_error",
      err,
      coverageRelPath,
      sourceTestArtifactRevision,
    });
    artifactPaths = writeTestReviewArtifacts({ root, specDir: outputDirectory, reviewArtifact, coverageArtifact });
    console.error(`  [test-review] Results saved to ${artifactPaths.reviewMdPath}`);
    console.error(`  [test-review] JSON saved to ${artifactPaths.reviewJsonPath}`);
    console.error(`  [test-review] Coverage saved to ${artifactPaths.coveragePath}`);
    console.error("  [test-review] outcome=TOOLING_ERROR stage=parse attempt=1 maxAttempts=1 toolingKind=coverage_error blocking=0 advisory=0");
    console.log("Test review TOOLING_ERROR. Coverage artifact generation failed; see test-review.json.");
    return;
  }

  const testFiles = collectTestFiles(root, specDir, {
    sourceDirectory: path.join(testSourceDirectory, "tests"),
    sourceTopology: testSourceTopology,
  });
  let aiFindings;
  try {
    const agent = ensureAgent("flow.test.review");
    console.error("  [test-review] Running bounded static review...");
    if (dryRun) console.error("  [test-review] dry-run has no auto-fix phase; detection still runs once.");
    aiFindings = await runTestReviewWithDependencies({
      buildReviewPrompt: (selectedTestFiles = testFiles, authority = null) => buildTestReviewPrompt(
        authority?.requirements ?? requirements,
        authority === null ? coverageArtifact : { toPromptSummary: () => authority.coverage },
        selectedTestFiles,
      ),
      callAgent: (reviewPrompt, _batch, _protocolRetryIndex, _attemptContext, providerCallAdmission) => callReviewAgent(
        agent, reviewPrompt, "flow.test.review",
        "You are a bounded static test review mapper. Return JSON with blockingFindings and advisoryFindings.",
        { providerCallAdmission },
      ),
      testFiles,
      requirementEntries: (spec.requirements || []).map((requirement) => ({
        id: requirement.id,
        text: extractRequirements({ requirements: [requirement] }),
      })),
      coverageSummary: coverageArtifact.toPromptSummary(),
      maxChars: Math.min(TEST_REVIEW_PROMPT_CHAR_LIMIT, agent.promptCharacterLimit ?? TEST_REVIEW_PROMPT_CHAR_LIMIT),
      parseResponse: parseTestReviewFindings,
      projectInvocation: typeof agent.projectInvocation === "function"
        ? (reviewPrompt) => projectReviewAgentInvocation(
          agent,
          reviewPrompt,
          "flow.test.review",
          "You are a bounded static test review mapper. Return JSON with blockingFindings and advisoryFindings.",
        )
        : null,
      synthesize: async ({ completions, merged, executionBudget, plan }) => {
        const synthesized = await synthesizeReviewFindings({
          initialItems: completions.flatMap((completion) => [
            ...completion.response.blocking,
            ...completion.response.advisory,
          ]),
          authorityElements: plan.corePlan.collection.elements,
          toText: (finding) => JSON.stringify(typeof finding.toJSON === "function" ? finding.toJSON() : finding),
          buildRequest: (findingTexts, _context, sourceRefs) => buildTestReviewSynthesisPrompt(findingTexts, sourceRefs),
          parseResponse: parseTestReviewFindings,
          responseItems: (response) => [...response.blocking, ...response.advisory],
          emptyResponse: () => ({ blocking: [], advisory: [] }),
          maxChars: Math.min(TEST_REVIEW_PROMPT_CHAR_LIMIT, agent.promptCharacterLimit ?? TEST_REVIEW_PROMPT_CHAR_LIMIT),
          executionBudget,
          callAgent: (request, _batch, _retry, _context, providerCallAdmission) => callReviewAgent(
            agent,
            request,
            "flow.test.review",
            "You are the final cross-file test review synthesizer. Return JSON only.",
            { retryCount: 0, providerCallAdmission },
          ),
          projectInvocation: typeof agent.projectInvocation === "function"
            ? (request) => projectReviewAgentInvocation(
              agent,
              request,
              "flow.test.review",
              "You are the final cross-file test review synthesizer. Return JSON only.",
              { retryCount: 0 },
            )
            : null,
        });
        return synthesized;
      },
    });
  } catch (err) {
    const kind = /JSON|schema|parse|Unexpected token/i.test(err?.message || "") ? "parser_error" : "agent_error";
    const reviewArtifact = buildToolingFailureReview({
      kind,
      err,
      coverageRelPath: artifactPaths.coveragePath,
      sourceTestArtifactRevision,
    });
    artifactPaths = writeTestReviewArtifacts({ root, specDir: outputDirectory, reviewArtifact, coverageArtifact });
    console.error(`  [test-review] Results saved to ${artifactPaths.reviewMdPath}`);
    console.error(`  [test-review] JSON saved to ${artifactPaths.reviewJsonPath}`);
    console.error(`  [test-review] Coverage saved to ${artifactPaths.coveragePath}`);
    const stage = kind === "parser_error" ? "parse" : "communication";
    console.error(`  [test-review] outcome=TOOLING_ERROR stage=${stage} attempt=1 maxAttempts=1 toolingKind=${kind} blocking=0 advisory=0`);
    console.log("Test review TOOLING_ERROR. Static review tooling failed; see test-review.json.");
    return;
  }

  const blockingFindings = [...headerBlockingFindings, ...aiFindings.blocking];
  const advisoryFindings = aiFindings.advisory;
  const verdict = blockingFindings.length > 0
    ? "REJECTED"
    : advisoryFindings.length > 0
      ? "ADVISORY"
      : "PASS";
  const reviewArtifact = new TestReviewArtifact({
    verdict,
    coverageArtifact: artifactPaths.coveragePath,
    sourceTestArtifactRevision,
    blocking: blockingFindings,
    advisory: advisoryFindings,
  });
  artifactPaths = writeTestReviewArtifacts({ root, specDir: outputDirectory, reviewArtifact, coverageArtifact });
  console.error(`  [test-review] Results saved to ${artifactPaths.reviewMdPath}`);
  console.error(`  [test-review] JSON saved to ${artifactPaths.reviewJsonPath}`);
  console.error(`  [test-review] Coverage saved to ${artifactPaths.coveragePath}`);
  console.error(`  [test-review] verdict=${verdict} blocking=${blockingFindings.length} advisory=${advisoryFindings.length}`);

  if (verdict === "PASS") {
    console.log("Test review PASS. No blocking or advisory findings.");
  } else if (verdict === "ADVISORY") {
    console.log(`Test review ADVISORY. ${advisoryFindings.length} non-blocking finding(s) recorded; implementation may proceed.`);
  } else {
    console.log(`Test review REJECTED. ${blockingFindings.length} blocking finding(s) recorded; fix tests before implementation.`);
  }
}

// ---------------------------------------------------------------------------
// Spec review pipeline (--phase spec)
// ---------------------------------------------------------------------------

import { minify } from "../../docs/lib/minify.js";

function canonicalSpecReviewValue(value) {
  if (value == null) return "";
  return String(value);
}

function formatSpecReviewSimpleList(values) {
  if (!Array.isArray(values) || values.length === 0) return "";
  return values.map((value) => `- ${canonicalSpecReviewValue(value)}`).join("\n");
}

function formatSpecReviewDecision(decision) {
  const text = canonicalSpecReviewValue(decision?.text ?? decision);
  const details = [];
  if (decision?.evidence) {
    details.push(`evidence: ${canonicalSpecReviewValue(decision.evidence)}`);
  }
  if (decision?.consideredAlternatives) {
    details.push(`alternatives: ${canonicalSpecReviewValue(decision.consideredAlternatives)}`);
  }
  return details.length > 0
    ? `- ${text}\n  ${details.join("\n  ")}`
    : `- ${text}`;
}

function formatSpecReviewTask(task) {
  const lines = [`- ${task.id}: ${canonicalSpecReviewValue(task.title)}`];
  lines.push(`  status: ${task.status || "unknown"}`);
  lines.push(`  goal: ${canonicalSpecReviewValue(task.goal)}`);
  if (Array.isArray(task.acceptance) && task.acceptance.length > 0) {
    lines.push(`  acceptance: ${task.acceptance.map((item) => canonicalSpecReviewValue(item)).join(" | ")}`);
  }
  if (task.test_strategy) {
    lines.push(`  test_strategy: ${canonicalSpecReviewValue(task.test_strategy)}`);
  }
  return lines.join("\n");
}

function buildSpecSummaryMarkdown(spec) {
  const lines = [];
  if (spec.goal) lines.push(`# Goal\n${spec.goal}`);
  if (spec.background) lines.push(`# Background\n${spec.background}`);
  if (spec.scope) {
    lines.push("# Scope");
    if (Array.isArray(spec.scope.in)) lines.push(`## In\n${spec.scope.in.map((s) => `- ${s}`).join("\n")}`);
    if (Array.isArray(spec.scope.out)) lines.push(`## Out\n${spec.scope.out.map((s) => `- ${s}`).join("\n")}`);
  }
  if (Array.isArray(spec.constraints)) lines.push(`# Constraints\n${spec.constraints.map((c) => `- ${c}`).join("\n")}`);
  if (Array.isArray(spec.design_principles)) lines.push(`# Design Principles\n${spec.design_principles.map((d) => `- ${d}`).join("\n")}`);
  if (spec.overview) {
    lines.push("# Overview");
    if (Array.isArray(spec.overview.modules)) lines.push(`## Modules\n${spec.overview.modules.map((m) => `- ${m.text}`).join("\n")}`);
    if (Array.isArray(spec.overview.data_flow)) lines.push(`## Data Flow\n${spec.overview.data_flow.map((d) => `- ${d.text}`).join("\n")}`);
    if (Array.isArray(spec.overview.decisions)) lines.push(`## Decisions\n${spec.overview.decisions.map(formatSpecReviewDecision).join("\n")}`);
  }
  if (Array.isArray(spec.requirements)) {
    lines.push("# Requirements");
    for (const r of spec.requirements) {
      const testable = r.testable === false ? " testable=false" : "";
      lines.push(`- ${r.id} [${r.priority || "unknown"}${testable}]: ${r.desc}`);
    }
  }
  const acceptance = formatSpecReviewSimpleList(spec.acceptance_criteria);
  if (acceptance) lines.push(`# Acceptance Criteria\n${acceptance}`);
  if (Array.isArray(spec.clarifications) && spec.clarifications.length > 0) {
    lines.push(`# Clarifications\n${spec.clarifications.map((c) => [
      `- Q: ${canonicalSpecReviewValue(c.q)}`,
      `  A: ${canonicalSpecReviewValue(c.a)}`,
    ].join("\n")).join("\n")}`);
  }
  if (Array.isArray(spec.alternatives_considered) && spec.alternatives_considered.length > 0) {
    lines.push(`# Alternatives Considered\n${spec.alternatives_considered.map((a) => [
      `- Option: ${canonicalSpecReviewValue(a.option)}`,
      `  Reason: ${canonicalSpecReviewValue(a.reason)}`,
    ].join("\n")).join("\n")}`);
  }
  const openQuestions = formatSpecReviewSimpleList(spec.open_questions);
  if (openQuestions) lines.push(`# Open Questions\n${openQuestions}`);
  if (Array.isArray(spec.tasks) && spec.tasks.length > 0) {
    lines.push(`# Tasks\n${spec.tasks.map(formatSpecReviewTask).join("\n")}`);
  }
  const md = lines.join("\n\n");
  return minify(md, "spec-summary.md");
}

/**
 * Build a context-search query from a spec.json object.
 */
function extractGoalAndScope(spec) {
  if (Array.isArray(spec?.keywords) && spec.keywords.length > 0) {
    return spec.keywords.join(" ");
  }
  const parts = [];
  if (spec?.goal) parts.push(spec.goal);
  if (Array.isArray(spec?.scope?.in) && spec.scope.in.length) {
    parts.push(spec.scope.in.join("\n"));
  }
  return parts.join("\n");
}

function extractScopePaths(spec) {
  if (!Array.isArray(spec?.scope?.in)) return [];
  const paths = [];
  const re = /`([^`]+\.[a-zA-Z0-9]+)`/g;
  for (const item of spec.scope.in) {
    let m;
    while ((m = re.exec(item)) !== null) {
      paths.push(m[1]);
    }
  }
  return paths;
}

const SPEC_REVIEW_BLOCKING_ITEM_SCHEMA = Object.freeze({
  type: "object",
  required: ["title", "target", "issue", "requiredChange", "whyBlocking"],
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1 },
    target: { type: "string", minLength: 1 },
    issue: { type: "string", minLength: 1 },
    requiredChange: { type: "string", minLength: 1 },
    whyBlocking: { type: "string", minLength: 1 },
  },
});

const SPEC_REVIEW_IMPROVEMENT_ITEM_SCHEMA = Object.freeze({
  type: "object",
  required: ["title", "target", "improvement", "whyNonBlocking"],
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1 },
    target: { type: "string", minLength: 1 },
    improvement: { type: "string", minLength: 1 },
    whyNonBlocking: { type: "string", minLength: 1 },
  },
});

const SPEC_REVIEW_RESPONSE_SCHEMA = Object.freeze({
  type: "object",
  required: ["blockingFindings", "nonBlockingImprovements"],
  additionalProperties: false,
  properties: {
    blockingFindings: {
      type: "array",
      items: SPEC_REVIEW_BLOCKING_ITEM_SCHEMA,
    },
    nonBlockingImprovements: {
      type: "array",
      items: SPEC_REVIEW_IMPROVEMENT_ITEM_SCHEMA,
    },
  },
});

const SPEC_REVIEW_FMT_FALLBACK = [
  "OUTPUT FORMAT - strictly required:",
  "Return only a JSON object. No markdown, no preamble, no commentary.",
  "Always include both top-level arrays: blockingFindings[] and nonBlockingImprovements[].",
  "Schema:",
  JSON.stringify(SPEC_REVIEW_RESPONSE_SCHEMA, null, 2),
  "Use empty arrays when there are no findings in a category.",
].join("\n");

/**
 * Build the spec review prompt.
 * @param {string} specText - Minified spec summary from spec.json fields
 * @param {Object[]} contextEntries - Related codebase entries from contextSearch
 * @returns {{systemPrompt: string|null, userPrompt: string}}
 */
function buildSpecReviewPrompt(specText, contextEntries, previousReview = null) {
  const pb = new PromptBuilder()
    .setRole("You are a codebase-context spec reviewer. Find design, implementation-target, and existing-behavior gaps that gate cannot determine mechanically.")
    .setRules([
      "Focus on:",
      "- Blocking findings: codebase-context gaps that make the spec impossible or unsafe to implement or test correctly.",
      "- Treat a concern as blocking only when at least one of these concrete failure modes applies:",
      "  1. The spec contradicts verified existing codebase behavior or omits an impact on existing behavior that must be preserved.",
      "  2. The required behavior has no implementation target or integration point, and codebase context shows one is necessary.",
      "  3. The required behavior has no observable acceptance/test basis, so tests cannot be designed.",
      "  4. The spec omits a required error path, data path, or compatibility path that existing interfaces make mandatory.",
      "  5. Two spec fields conflict in a way that changes what should be implemented, and the conflict is not a gate-owned mechanical issue.",
      "- Do not classify a concern as blocking merely because wording could be clearer, extra rationale would help, another related file could be mentioned, or a design alternative could be documented.",
      "- Non-blocking improvements: helpful clarifications, extra related-file mentions, wording improvements, broader context, or nice-to-have completeness that does not block implementation/test/gate.",
      "- Gate-owned checks are not blocking findings for this review: JSON schema, required/empty fields, unresolved markers, tasks missing/empty/depth structure, and guardrail compliance are handled by the downstream gate.",
      "- If a concern can be decided mechanically from spec.json shape or guardrail articles without codebase context, leave it to gate instead of reporting it here.",
      "- This review is diagnostic. Do not rewrite the spec, do not produce a repair plan, and do not broaden scope.",
      "- For blocking findings, requiredChange must name the smallest spec-level correction needed to remove the blocker.",
      "- For blocking findings, whyBlocking must name the concrete implementation, testing, safety, or compatibility failure that occurs if the spec is left unchanged.",
      "- If a concern is gate-owned, omit it entirely rather than reporting it as a finding or improvement.",
      "- Do not fail the review for non-blocking improvements.",
      "- Do not require every issue to map to a file. Use Target for a spec section, requirement id, file path, or GLOBAL.",
      "- When previous review memory is provided, do not repeat acknowledged non-blocking improvements unless the current spec has changed so the issue is now blocking.",
      "- Re-report previous blocking findings only if they are still blocking in the current spec.",
      "",
      "Return JSON only. The response object must contain:",
      "- Always include both top-level arrays, even when one or both categories have no findings.",
      "- blockingFindings[] with title, target, issue, requiredChange, whyBlocking",
      "- nonBlockingImprovements[] with title, target, improvement, whyNonBlocking",
      "- Use empty arrays when there are no findings in a category.",
    ].join("\n"))
    .setJsonSchema(SPEC_REVIEW_RESPONSE_SCHEMA)
    .setFmtFallback(SPEC_REVIEW_FMT_FALLBACK)
    .addUserPrompt("## Spec", specText)
    .addUserPrompt(
      "## Codebase Context (related files)",
      formatCodebaseContextForPrompt(contextEntries),
    );

  if (previousReview) {
    pb.addUserPrompt(
      "## Previous Spec Review Memory",
      JSON.stringify(previousReview.toPromptMemory(), null, 2),
    );
  }

  return pb.build();
}

function buildSpecReviewSynthesisPrompt(findingTexts, _context, sourceRefs = []) {
  return new PromptBuilder()
    .setRole("You are the final spec review synthesizer. Cross-check findings only after every bounded spec and code-context range was reviewed.")
    .setRules([
      "Return JSON only with blockingFindings[] and nonBlockingImprovements[].",
      "Resolve duplicate and contradictory findings globally.",
      "Check requirement relationships and contradictions spanning bounded source ranges.",
      "Preserve a blocker when any validated range establishes its concrete failure mode.",
      "Adjudicate every supplied map finding; omit one only when canonical authority disproves or resolves it. The returned JSON is authoritative.",
    ])
    .setJsonSchema(SPEC_REVIEW_RESPONSE_SCHEMA)
    .setFmtFallback(SPEC_REVIEW_FMT_FALLBACK)
    .addUserPrompt("## Covered Canonical Evidence References", sourceRefs.join("\n") || "(none)")
    .addUserPrompt("## Reduced Canonical Authority and Validated Map Evidence", findingTexts.join("\n\n"))
    .build();
}

function extractMarkdownField(body, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(body || "").match(new RegExp(`^\\*\\*${escaped}:\\*\\*\\s*(.+)$`, "im"));
  if (!match) return "";
  return match[1].trim().replace(/^`(.+)`$/, "$1");
}

class SpecReviewItem {
  constructor(kind, item) {
    this.kind = kind;
    this.title = item.title;
    this.target = item.target || extractMarkdownField(item.body, "Target") || extractMarkdownField(item.body, "File") || "GLOBAL";
    if (kind === "blocking") {
      this.issue = item.issue || extractMarkdownField(item.body, "Issue");
      this.requiredChange = item.requiredChange || extractMarkdownField(item.body, "Required change") || extractMarkdownField(item.body, "Suggestion");
      this.whyBlocking = item.whyBlocking || extractMarkdownField(item.body, "Why blocking");
      this.body = item.body || [
        `**Target:** ${this.target}`,
        `**Issue:** ${this.issue}`,
        `**Required change:** ${this.requiredChange}`,
        `**Why blocking:** ${this.whyBlocking}`,
      ].join("\n");
    } else {
      this.improvement = item.improvement || extractMarkdownField(item.body, "Improvement") || extractMarkdownField(item.body, "Suggestion");
      this.whyNonBlocking = item.whyNonBlocking || extractMarkdownField(item.body, "Why non-blocking");
      this.body = item.body || [
        `**Target:** ${this.target}`,
        `**Improvement:** ${this.improvement}`,
        `**Why non-blocking:** ${this.whyNonBlocking}`,
      ].join("\n");
    }
    this.findingId = typeof item.findingId === "string" && item.findingId.trim() !== ""
      ? item.findingId.trim()
      : specReviewFindingId(kind, this);
  }

  toPromptMemory() {
    const base = {
      findingId: this.findingId,
      title: this.title,
      target: this.target,
    };
    if (this.kind === "blocking") {
      return {
        ...base,
        issue: this.issue,
        requiredChange: this.requiredChange,
      };
    }
    return {
      ...base,
      improvement: this.improvement,
      whyNonBlocking: this.whyNonBlocking,
    };
  }

  toJSON() {
    const base = {
      kind: this.kind,
      findingId: this.findingId,
      title: this.title,
      target: this.target,
      body: this.body,
    };
    if (this.kind === "blocking") {
      return {
        ...base,
        issue: this.issue,
        requiredChange: this.requiredChange,
        whyBlocking: this.whyBlocking,
      };
    }
    return {
      ...base,
      improvement: this.improvement,
      whyNonBlocking: this.whyNonBlocking,
    };
  }
}

function specReviewFindingId(kind, item) {
  const identity = {
    kind,
    title: String(item?.title || "").trim(),
    target: String(item?.target || "GLOBAL").trim(),
    ...(kind === "blocking"
      ? {
          issue: String(item?.issue || "").trim(),
          requiredChange: String(item?.requiredChange || "").trim(),
        }
      : {
          improvement: String(item?.improvement || "").trim(),
        }),
  };
  const digest = crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return `spec-review-${digest.slice(0, 32)}`;
}

function extractJsonObjectCandidate(raw) {
  let text = String(raw || "").trim();
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) text = fenceMatch[1].trim();
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }
  return text;
}

class SpecReviewSchemaValidationError extends Error {
  constructor(errors, parsed) {
    super(`spec review output failed schema validation: ${errors.join("; ")}`);
    this.name = "SpecReviewSchemaValidationError";
    this.errors = errors;
    this.parsed = parsed;
  }
}

function normalizeReviewResponseArrays(parsed, fields) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const normalized = { ...parsed };
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(normalized, field)) {
      normalized[field] = [];
    }
  }
  return normalized;
}

function normalizeSpecReviewResponseShape(parsed) {
  return normalizeReviewResponseArrays(parsed, ["blockingFindings", "nonBlockingImprovements"]);
}

function parseSpecReviewJsonOutput(raw) {
  const candidate = extractJsonObjectCandidate(raw);
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    parsed = JSON.parse(repairJson(candidate));
  }
  parsed = normalizeSpecReviewResponseShape(parsed);
  const errors = validateSchema(parsed, SPEC_REVIEW_RESPONSE_SCHEMA);
  if (errors.length > 0) {
    throw new SpecReviewSchemaValidationError(errors, parsed);
  }
  return parsed;
}

function parseSpecReviewFindings(text) {
  const parsed = parseSpecReviewJsonOutput(text);
  return {
    blocking: parsed.blockingFindings.map((item) => new SpecReviewItem("blocking", item)),
    improvements: parsed.nonBlockingImprovements.map((item) => new SpecReviewItem("improvement", item)),
  };
}

function mergeSpecReviewFindingBatches(batches) {
  const selected = new Map();
  for (const batch of batches) {
    for (const finding of [...batch.blocking, ...batch.improvements]) {
      const previous = selected.get(finding.findingId);
      if (previous === undefined || (previous.kind !== "blocking" && finding.kind === "blocking")) {
        selected.set(finding.findingId, finding);
      }
    }
  }
  return {
    blocking: [...selected.values()].filter((finding) => finding.kind === "blocking"),
    improvements: [...selected.values()].filter((finding) => finding.kind !== "blocking"),
  };
}

class SpecReviewFindingReducer extends PromptBatchReducer {
  reduce(completions) {
    return mergeSpecReviewFindingBatches(completions.map((completion) => completion.response));
  }
}

/** Build the sole worker result for spec-review.  The provider response is
 * transient parser input; this V2 delta is bound to the immutable canonical
 * review snapshot that the parent materialized for this Attempt. */
function formatSpecReviewDelta({ review, blocking = [], improvements = [] } = {}) {
  const current = review instanceof CanonicalSpecReview ? review : new CanonicalSpecReview(review);
  return new SpecReviewDelta({
    version: 2,
    stage: "spec-review",
    identity: current.identity.toJSON(),
    baseReviewDigest: current.digest,
    findings: [
      ...blocking.map((item) => item instanceof SpecReviewItem ? item.toJSON() : new SpecReviewItem("blocking", item).toJSON()),
      ...improvements.map((item) => item instanceof SpecReviewItem ? item.toJSON() : new SpecReviewItem("improvement", item).toJSON()),
    ],
    operations: [],
  }).toJSON();
}

function formatPhaseReviewMd(title, history, verdict, finalIssues) {
  const lines = [`# ${title}`, ""];
  lines.push("## Review Iterations");
  for (let i = 0; i < history.length; i++) {
    if (history.length > 1) lines.push(`### Iteration ${i + 1}`);
    lines.push(history[i]);
    lines.push("");
  }
  lines.push(`## Verdict: ${verdict}`);
  if (verdict === "REJECTED" && finalIssues.length > 0) {
    lines.push("");
    lines.push("### Remaining Issues");
    for (const p of finalIssues) {
      lines.push(`- ${p.title}`);
      if (p.body) lines.push(`  ${p.body}`);
    }
  }
  return lines.join("\n");
}

function formatSpecReviewMd(input = {}) {
  const normalized = Array.isArray(input)
    ? { blocking: input, improvements: [], verdict: input.length > 0 ? "REJECTED" : "PASS" }
    : input;
  const { blocking = [], improvements = [], verdict = "PASS" } = normalized;
  const lines = ["# Spec Review Results", ""];
  lines.push(`## Verdict: ${verdict}`, "");

  lines.push("## Blocking Findings", "");
  if (blocking.length === 0) {
    lines.push("No blocking findings.");
  } else {
    for (let i = 0; i < blocking.length; i++) {
      lines.push(`### ${i + 1}. ${blocking[i].title}`);
      if (blocking[i].body) lines.push(blocking[i].body);
      lines.push("");
    }
  }

  lines.push("", "## Non-blocking Improvements", "");
  if (improvements.length === 0) {
    lines.push("No non-blocking improvements.");
  } else {
    for (let i = 0; i < improvements.length; i++) {
      lines.push(`### ${i + 1}. ${improvements[i].title}`);
      if (improvements[i].body) lines.push(improvements[i].body);
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * Run the spec review pipeline (propose-only, 1 AI call).
 */
async function runSpecReview(root, flow, spec, config, dryRun) {
  const specPath = relativeFlowSpecFile(flow);
  const specDir = path.dirname(specPath);
  const reviewDir = reviewOutputDirectory();
  // Validate the immutable child input before loading context or resolving an
  // Agent. A missing, rebound, or modified descriptor must never reach the
  // reviewer or create a delta/seal side effect.
  const canonicalReviewDocument = canonicalSpecReviewInput();
  if (canonicalReviewDocument === null) {
    throw new Error("spec-review requires an immutable revision-scoped canonical review input");
  }
  const canonicalReview = new CanonicalSpecReview(canonicalReviewDocument);

  let analysisData = null;
  try {
    const { loadAnalysisEntries, contextSearch: ctxSearch } = await import("../lib/get-context.js");
    analysisData = { ...loadAnalysisEntries(root), ctxSearch };
  } catch (e) {
    console.error(`  [spec-review] Warning: failed to load codebase context: ${e.message}`);
  }

  const proposeAgent = ensureAgent("flow.spec.review.propose");


  console.error("  [spec-review] Proposing...");
  const specSummary = buildSpecSummaryMarkdown(spec);
  let contextEntries = [];
  if (analysisData) {
    const searchQuery = extractGoalAndScope(spec);
    if (searchQuery) {
      const scopePaths = extractScopePaths(spec);
      contextEntries = await analysisData.ctxSearch(
        analysisData.entries, analysisData.analysis, searchQuery, root, "ngram",
        { scopePaths, expandImports: true },
      );
    }
  }
  const reviewDeltaPath = path.join(reviewDir, "review.delta.json");
  let previousReview = null;
  // The response parser remains transient worker implementation detail; the
  // reviewer receives canonical review bytes, never a local prior artifact.
  previousReview = Object.freeze({ toPromptMemory: () => canonicalReview.toJSON() });
  const proposePrompt = buildSpecReviewPrompt(specSummary, contextEntries, previousReview);
  const promptLimit = Math.min(TASK_REVIEW_PROMPT_CHAR_LIMIT, proposeAgent.promptCharacterLimit ?? TASK_REVIEW_PROMPT_CHAR_LIMIT);
  const promptPlan = ReviewTextPromptPlan.create({
    request: proposePrompt,
    maxChars: promptLimit,
    ElementClass: SpecSectionPromptElement,
    id: "spec-review-document",
    sections: splitReviewTextAtHeadings(proposePrompt.userPrompt, /^#{1,2}\s/gm),
  });
  const executionBudget = new PromptExecutionBudget(new PromptExecutionLimit({
      maxRequestCharacters: promptLimit,
      maxBatchCount: Math.max(promptPlan.batches.length, 16),
      maxProviderCallCount: promptPlan.batches.length + 16,
      maxSynthesisCallCount: 16,
      maxAggregateCharacters: 1_000_000,
    }));
  const executor = new PromptBatchExecutor({ executionBudget });
  const completions = await executor.executeCompletions({
    plan: promptPlan.corePlan,
    callAgent: (request, _batch, _protocolRetryIndex, _attemptContext, providerCallAdmission) => callReviewAgent(
      proposeAgent,
      request,
      "flow.spec.review.propose",
      null,
      { providerCallAdmission },
    ),
    responseContract: {
      parse: parseSpecReviewFindings,
      itemCount: (response) => response.blocking.length + response.improvements.length,
    },
    ...(typeof proposeAgent.projectInvocation === "function" ? {
      projectInvocation: (request) => projectReviewAgentInvocation(proposeAgent, request, "flow.spec.review.propose"),
    } : {}),
  });
  let findings = new SpecReviewFindingReducer().reduce(completions);
  if (completions.length > 1) {
    const synthesized = await synthesizeReviewFindings({
      initialItems: [...findings.blocking, ...findings.improvements],
      authorityElements: promptPlan.corePlan.collection.elements,
      toText: (finding) => JSON.stringify(finding.toJSON ? finding.toJSON() : finding),
      buildRequest: buildSpecReviewSynthesisPrompt,
      parseResponse: parseSpecReviewFindings,
      responseItems: (response) => [...response.blocking, ...response.improvements],
      emptyResponse: () => ({ blocking: [], improvements: [] }),
      maxChars: promptLimit,
      executionBudget,
      callAgent: (request, _batch, _retry, _context, providerCallAdmission) => callReviewAgent(
        proposeAgent,
        request,
        "flow.spec.review.propose",
        null,
        { retryCount: 0, providerCallAdmission },
      ),
      projectInvocation: typeof proposeAgent.projectInvocation === "function"
        ? (request) => projectReviewAgentInvocation(
          proposeAgent,
          request,
          "flow.spec.review.propose",
          null,
          { retryCount: 0 },
        )
        : null,
    });
    findings = synthesized;
  }
  const blockingCount = findings.blocking.length;
  const improvementCount = findings.improvements.length;
  const proposalCount = blockingCount + improvementCount;
  const verdict = blockingCount > 0 ? "REJECTED" : improvementCount > 0 ? "ADVISORY" : "PASS";

  const delta = formatSpecReviewDelta({ review: canonicalReview, ...findings });
  writeJsonArtifact(reviewDeltaPath, delta);
  console.error(`  [spec-review] Delta saved to ${path.relative(root, reviewDeltaPath)}`);
  console.error(`  [spec-review] blockingCount=${blockingCount} improvementCount=${improvementCount} proposalCount=${proposalCount}`);

  console.error(`  [spec-review] verdict=${verdict} proposalCount=${proposalCount}`);
  if (verdict === "PASS") {
    console.log("NO_PROPOSALS");
  } else if (verdict === "ADVISORY") {
    console.log(`Spec review ADVISORY. ${improvementCount} non-blocking improvement(s) recorded. See spec-review.md.`);
  } else {
    console.log(`Spec review REJECTED. ${blockingCount} blocking finding(s) found. See spec-review.md.`);
  }
}

// ---------------------------------------------------------------------------
// Draft review pipeline (--phase draft)
// ---------------------------------------------------------------------------

function formatDraftQuestionReviewEntry(q, i) {
  return [
    `### ${q.id || `Q${i + 1}`} [${q.state || "unknown"} / ${q.category || "unknown"}]`,
    `**Question:** ${q.question}`,
  ].join("\n");
}

function formatDraftQaMarkdownFieldLine(label, value, fallback) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  const text = trimmed !== "" ? value : fallback;
  return `**${label}:** ${text}`;
}

function formatDraftCoverageReviewEntry(q, i) {
  return [
    `### ${q.id || `Q${i + 1}`} [${q.state || "unknown"} / ${q.category || "unknown"}]`,
    `**Question:** ${q.question}`,
    formatDraftQaMarkdownFieldLine("Answer", q.answer, "(empty)"),
    formatDraftQaMarkdownFieldLine("Evidence digest", q.evidenceDigest, "(none)"),
    formatDraftQaMarkdownFieldLine("Why", q.why, "(none)"),
    formatDraftQaMarkdownFieldLine("Considered", q.considered, "(none)"),
    formatDraftQaMarkdownFieldLine("Discarded reason", q.reason, "(none)"),
  ].join("\n");
}

function selectDraftQuestionReviewEntries(entries) {
  return entries.filter((q) => q.state === "CandidateQuestion" || q.state === "AwaitingUserAnswer");
}

function selectDraftCoverageReviewEntries(entries) {
  return entries.filter((q) => ["ResolvedByExistingInformation", "AnsweredQuestion", "DiscardedQuestion"].includes(q.state));
}

function summarizeDraftQaStatuses(draftJson) {
  const counts = { total: 0, CandidateQuestion: 0, ResolvedByExistingInformation: 0, AwaitingUserAnswer: 0, AnsweredQuestion: 0, DiscardedQuestion: 0, other: 0 };
  const questions = draftJson?.questionLedger?.questions;
  if (!Array.isArray(questions)) return counts;
  counts.total = questions.length;
  for (const q of questions) {
    if (Object.hasOwn(counts, q.state)) counts[q.state] += 1;
    else counts.other += 1;
  }
  return counts;
}

function formatDraftQaStatusSummary(draftJson) {
  const counts = summarizeDraftQaStatuses(draftJson);
  return [
    `- total: ${counts.total}`,
    `- candidates: ${counts.CandidateQuestion}`,
    `- resolved by existing information: ${counts.ResolvedByExistingInformation}`,
    `- awaiting user answer: ${counts.AwaitingUserAnswer}`,
    `- answered: ${counts.AnsweredQuestion}`,
    `- discarded: ${counts.DiscardedQuestion}`,
    `- other: ${counts.other}`,
  ].join("\n");
}

function formatDraftDecisionMap(draftJson) {
  const map = draftJson?.decisionMap;
  if (!map || typeof map !== "object" || Array.isArray(map)) return "(no decisionMap)";

  return [
    ["Known facts", map.knownFacts],
    ["Decision points", map.decisionPoints],
    ["Resolved by project rules", map.resolvedByProjectRules],
    ["Requires user judgment", map.requiresUserJudgment],
    ["Deferred to spec", map.deferredToSpec],
  ].map(([label, values]) => {
    const items = Array.isArray(values) && values.length
      ? values.map((value) => `- ${value}`).join("\n")
      : "- (none)";
    return `### ${label}\n${items}`;
  }).join("\n\n");
}

function formatDraftReviewQaEntries(draftJson, stage) {
  const questions = draftJson?.questionLedger?.questions;
  if (!Array.isArray(questions)) return "(no draft question ledger entries)";

  if (stage.key === "questions") {
    const entries = selectDraftQuestionReviewEntries(questions);
    if (entries.length === 0) return "(no candidate or awaiting question entries)";
    return entries.map(formatDraftQuestionReviewEntry).join("\n\n");
  }

  const entries = selectDraftCoverageReviewEntries(questions);
  if (entries.length === 0) return "(no resolved, answered, or discarded question entries)";
  return entries.map(formatDraftCoverageReviewEntry).join("\n\n");
}

function buildDraftQuestionReviewPrompt(draftJson, requestText) {
  const qaText = Array.isArray(draftJson?.questionLedger?.questions)
    ? formatDraftReviewQaEntries(draftJson, { key: "questions" })
    : "(no QA entries)";

  return [
    "You are a draft question boundary review mapper. Check the supplied bounded range of the persisted user-decision list.",
    "This is not a question generation task. An empty question ledger is valid when the supplied authorities resolve every requirement.",
    "Check only these finite defects in shown candidate entries:",
    "- The question is empty, duplicated, not self-contained, or asks for internal implementation details that project patterns should decide",
    "- The authoritative Request / Issue, Decision Map, project rules, or supplied context already determines the answer, making the question a redundant confirmation",
    "- The question includes an answer, rationale, evidence, or instruction instead of only the question text",
    "Do not identify missing first-pass questions.",
    "Do not propose NEW QA entries.",
    "Do not add questions for category coverage or because a category label is absent.",
    "If no listed finite defect is present, output: NO_PROPOSALS",
    "",
    "Output a numbered list of issues in this format:",
    "### 1. <title>",
    "**QA:** q<N> (the ledger question id)",
    "**Classification:** repair_target",
    "**Issue:** <which finite user-boundary defect is present>",
    "**Suggestion:** <answer or drop the existing QA entry using the cited existing evidence>",
    "",
    "If no issues are found, output: NO_PROPOSALS",
    "",
    "## Request / Issue",
    "Treat this as authoritative for deciding whether a shown question merely reconfirms an existing requirement. Do not derive missing questions from it.",
    requestText || "(no request text)",
    "",
    "## Draft QA Status Summary",
    formatDraftQaStatusSummary(draftJson),
    "",
    "## Candidate / Awaiting Draft Ledger Entries",
    qaText,
    "",
    "## Decision Map",
    formatDraftDecisionMap(draftJson),
  ].join("\n");
}

function loadDraftQaRulesPartial() {
  if (cachedDraftQaRulesPartial !== null) return cachedDraftQaRulesPartial;
  cachedDraftQaRulesPartial = resolveIncludes(fs.readFileSync(DRAFT_QA_RULES_PARTIAL_PATH, "utf8"), {
    baseDir: path.dirname(DRAFT_QA_RULES_PARTIAL_PATH),
    pkgDir: PKG_DIR,
    sourceFile: DRAFT_QA_RULES_PARTIAL_PATH,
  });
  return cachedDraftQaRulesPartial;
}

function buildDraftReviewPrompt(draftJson, requestText, contextEntries, stage) {
  const effectiveStage = stage || { key: "coverage" };
  if (effectiveStage.key === "questions") {
    return buildDraftQuestionReviewPrompt(draftJson, requestText);
  }

  const qaText = Array.isArray(draftJson?.questionLedger?.questions)
    ? formatDraftReviewQaEntries(draftJson, effectiveStage)
    : "(no QA entries)";

  const contextText = contextEntries.map((e) =>
    `- **${e.file}**: ${e.summary || "(no summary)"}`
  ).join("\n");

  return [
    "You are a draft coverage gate mapper. Check the supplied bounded range of answered and dropped draft QA before spec writing.",
    "",
    loadDraftQaRulesPartial(),
    "",
    "Review limits:",
    "- Report every evidenced blocking gap in this bounded map input; final synthesis ranks the complete candidate set.",
    "- Do not append ledger entries.",
    "- Treat existing answers as authoritative. Do not grade answer clarity, support, wording quality, or propose edits to existing QA.",
    "",
    "Output a numbered list of blocking gaps in this format:",
    "### 1. <title>",
    "**QA:** q<N> (related ledger question id, or 'GLOBAL' if no single question applies)",
    "**Classification:** blocking",
    "**Blocking decision:** <the user decision that is still required>",
    "**Why blocking:** <why the spec cannot be written without this decision>",
    "",
    "If no blocking user decision is required, output: NO_PROPOSALS",
    "",
    "## Request / Issue",
    requestText || "(no request text)",
    "",
    "## Draft QA Status Summary",
    formatDraftQaStatusSummary(draftJson),
    "",
    "## Draft QA Entries",
    qaText,
    "",
    "## Decision Map",
    formatDraftDecisionMap(draftJson),
    "",
    "## Codebase Context (related files)",
    "These files are ordered by relevance to the spec.",
    contextText,
  ].join("\n");
}

function buildDraftReviewSynthesisPrompt(findingTexts, stage, sourceRefs = []) {
  return [
    "You are the final draft review synthesizer. All bounded question, decision, request, and context ranges have completed.",
    "Resolve duplicates, findings already answered by authoritative information, and cross-range dependencies.",
    "Adjudicate every map candidate; omit one only when canonical authority disproves or resolves it. This final response is authoritative.",
    stage.key === "coverage"
      ? "Rank the complete candidate set by impact and return at most 3 blocking user decisions."
      : `Return at most ${DRAFT_REVIEW_ARTIFACT_LIMIT} distinct repair targets.`,
    "Use the same numbered finding format as the map review. Output NO_PROPOSALS when none remain.",
    "",
    "## Covered Canonical Evidence References",
    sourceRefs.join("\n") || "(none)",
    "## Reduced Canonical Authority and Validated Map Evidence",
    ...findingTexts,
  ].join("\n\n");
}

function buildDraftReviewAuthorityText(flow, stage, flowManager) {
  if (flow.issue == null) return flow.request || "";
  const source = flowManager.readArtifact({
    specId: flow.specId,
    logicalKey: "issue.snapshot",
    consumerNodeId: stage.artifactPhase,
  });
  return `Issue #${flow.issue}\n${source.bytes.toString("utf8").trim()}`;
}

function buildDraftReviewStage(key, overrides) {
  const route = draftReviewRouteForKey(key);
  return {
    key,
    retryPhase: route.retryPhase,
    artifact: route.reviewArtifact,
    artifactPhase: route.reviewStepId,
    ...overrides,
  };
}

function resolveDraftReviewClassification(issue, fallbackClassification) {
  const rawClassification =
    extractMarkdownField(issue.body, "Classification")
    || extractMarkdownField(issue.body, "Severity")
    || extractMarkdownField(issue.body, "Verdict")
    || "";
  const normalized = rawClassification.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (normalized === "blocking" || normalized === "fail") return "blocking";
  if (normalized === "advisory" || normalized === "non_blocking" || normalized === "warning") return "advisory";
  if (normalized === "repair_target" || normalized === "repair") return "repair_target";
  return fallbackClassification;
}

function issueToDraftReviewFinding(issue, fallbackClassification) {
  const classification = resolveDraftReviewClassification(issue, fallbackClassification);
  const qa = extractMarkdownField(issue.body, "QA");
  const issueText = extractMarkdownField(issue.body, "Issue")
    || extractMarkdownField(issue.body, "Blocking decision")
    || issue.body
    || "Draft review finding.";
  const suggestion = extractMarkdownField(issue.body, "Suggestion")
    || extractMarkdownField(issue.body, "Why blocking")
    || issueText;
  return new DraftReviewFinding({
    title: issue.title,
    target: qa || issue.file || "GLOBAL",
    rationale: suggestion,
    evidence: issueText,
    classification,
  });
}

function addDraftReviewFindingToBucket(buckets, finding) {
  if (finding.classification === "blocking") {
    buckets.blockingFindings.push(finding);
  } else if (finding.classification === "advisory") {
    buckets.advisoryFindings.push(finding);
  } else {
    buckets.repairTargets.push(finding);
  }
}

function buildDraftReviewArtifact({ raw, draftPath, draftRevision, proposals, stage }) {
  const buckets = {
    blockingFindings: [],
    advisoryFindings: [],
    repairTargets: [],
  };
  if (!raw.includes("NO_PROPOSALS")) {
    for (const proposal of proposals) {
      const finding = issueToDraftReviewFinding(proposal, stage.findingClassification);
      addDraftReviewFindingToBucket(buckets, finding);
    }
  }
  return new DraftReviewArtifactDocument({
    phase: stage.retryPhase,
    sourceDraft: draftPath,
    sourceDraftRevision: draftRevision,
    ...buckets,
  });
}

export class DraftReviewCandidateReducer extends PromptBatchReducer {
  constructor({ finalLimit = Infinity } = {}) {
    super();
    this.finalLimit = finalLimit;
    Object.freeze(this);
  }

  reduce(completions) {
    const ranked = new Map();
    for (const proposal of completions.flatMap((completion) => completion.response)) {
      const key = crypto.createHash("sha256")
        .update(JSON.stringify([proposal.title, proposal.body, proposal.file || null]))
        .digest("hex");
      if (!ranked.has(key)) ranked.set(key, proposal);
    }
    const proposals = [...ranked.values()];
    return Object.freeze(Number.isFinite(this.finalLimit) ? proposals.slice(0, this.finalLimit) : proposals);
  }
}

function writeJsonArtifact(filePath, artifact) {
  if (reviewArtifactWritePolicy.enabled) {
    fs.writeFileSync(filePath, JSON.stringify(artifact, null, 2) + "\n");
  }
}

function reviewHistoryAttemptNumber(specDir, phase) {
  const historyDir = path.join(specDir, "review-history");
  if (!fs.existsSync(historyDir)) return 1;
  let max = 0;
  const prefix = `${phase}-attempt-`;
  for (const name of fs.readdirSync(historyDir)) {
    if (!name.startsWith(prefix)) continue;
    const match = /^(.+)-attempt-(\d{3})\./.exec(name);
    if (!match) continue;
    max = Math.max(max, Number(match[2]));
  }
  return max + 1;
}

function normalizedFindingId(phase, attempt, severity, index) {
  return `${phase}-${String(attempt).padStart(3, "0")}-${severity}-${String(index).padStart(3, "0")}`;
}

function normalizeFindingSeverity(value, fallback = "blocking") {
  const text = String(value || "").trim().toLowerCase();
  if (text === "blocking") return "blocking";
  if (text === "non-blocking" || text === "advisory" || text === "improvement") return "non-blocking";
  return fallback === "non-blocking" ? "non-blocking" : "blocking";
}

function findingsWithSeverity(findings, severity) {
  return (findings || []).map((finding) => ({ ...finding, severity }));
}

function findingText(item) {
  return String(item.body || item.issue || item.rationale || item.evidence || item.suggestion || item.title || "").trim();
}

function findingCategory(phase, item) {
  if (phase === "impl") return String(item.failureMode || "unknown").trim() || "unknown";
  if (phase.startsWith("draft-")) return String(item.classification || "unknown").trim() || "unknown";
  return String(item.category || item.failureMode || item.classification || "unknown").trim() || "unknown";
}

function normalizeReviewFindingRecords({ phase, sourceArtifact, attempt, artifact = {}, findings = [] }) {
  const records = [];
  const push = (item, severity, { repairTarget = false } = {}) => {
    const normalizedSeverity = normalizeFindingSeverity(severity);
    const idx = records.length + 1;
    records.push({
      id: item.findingId || item.id || normalizedFindingId(phase, attempt, normalizedSeverity, idx),
      findingId: item.findingId || item.id || normalizedFindingId(phase, attempt, normalizedSeverity, idx),
      phase,
      sourceArtifact,
      attempt,
      severity: normalizedSeverity,
      title: String(item.title || "Untitled finding").trim(),
      body: findingText(item),
      category: findingCategory(phase, item),
      ...(repairTarget && {
        target: normalizeDraftReviewText(item.target, "GLOBAL"),
        evidence: normalizeDraftReviewText(item.evidence, "Draft review output."),
      }),
      ...(item.fingerprint && { fingerprint: item.fingerprint }),
      ...(item.disposition && { disposition: item.disposition }),
      ...(item.rationale && { rationale: item.rationale }),
      ...(item.requirementId && { requirementId: item.requirementId }),
      ...(item.guardrailId && { guardrailId: item.guardrailId }),
      ...(item.repeatCount && { repeatCount: item.repeatCount }),
    });
  };
  for (const item of findings) push(item, item.severity || "blocking");
  for (const item of artifact.blockingFindings || []) push(item, "blocking");
  for (const item of artifact.nonBlockingImprovements || []) push(item, "non-blocking");
  for (const item of artifact.advisoryFindings || []) push(item, "non-blocking");
  const isDraftRepairPhase =
    phase === "draft-questions" || phase === "draft-coverage";
  for (const item of artifact.repairTargets || []) {
    push(item, isDraftRepairPhase ? "non-blocking" : "blocking", {
      repairTarget: isDraftRepairPhase,
    });
  }
  return records;
}

export function writeReviewAttemptHistory({ specDir, phase, latestBasename, artifact = null, content = null, attemptNumber = null, findings = [] }) {
  const attempt = attemptNumber || reviewHistoryAttemptNumber(specDir, phase);
  const ext = latestBasename.endsWith(".md") ? "md" : "json";
  const historyDir = path.join(specDir, "review-history");
  if (reviewArtifactWritePolicy.enabled) fs.mkdirSync(historyDir, { recursive: true });
  const latestPath = path.join(specDir, latestBasename);
  const historyPath = path.join(historyDir, `${phase}-attempt-${String(attempt).padStart(3, "0")}.${ext}`);
  const normalizedHistoryPath = path.join(historyDir, `${phase}-attempt-${String(attempt).padStart(3, "0")}.json`);
  if (ext === "json") {
    const payload = {
      ...(artifact || {}),
      version: artifact?.version || 1,
      phase,
      sourceArtifact: latestBasename,
      attempt,
      findings: normalizeReviewFindingRecords({ phase, sourceArtifact: latestBasename, attempt, artifact: artifact || {}, findings }),
    };
    writeJsonArtifact(latestPath, artifact || payload);
    writeJsonArtifact(historyPath, payload);
    return { latestPath, historyPath, historyJsonPath: historyPath, normalizedHistoryPath: historyPath };
  }
  const text = content == null ? "" : String(content);
  if (reviewArtifactWritePolicy.enabled) {
    fs.writeFileSync(latestPath, text);
    fs.writeFileSync(historyPath, text);
  }
  writeJsonArtifact(normalizedHistoryPath, {
    version: 1,
    phase,
    sourceArtifact: latestBasename,
    attempt,
    findings: normalizeReviewFindingRecords({ phase, sourceArtifact: latestBasename, attempt, findings }),
  });
  return { latestPath, historyPath, historyJsonPath: normalizedHistoryPath, normalizedHistoryPath };
}

async function runDraftReview(root, flow, config, dryRun) {
  const outputDirectory = configuredReviewDirectory();
  const source = canonicalDraftReviewSource(outputDirectory);
  const draftPath = source.sourcePath;
  const stage = resolveDraftReviewStage(flow);
  const draftInspection = canonicalDraftSnapshot(source, flow, stage.retryPhase);
  const draftJson = draftInspection.document;

  const requestText = buildDraftReviewAuthorityText(
    flow,
    stage,
    container.get("flowManager"),
  );

  let analysisData = null;
  try {
    const { loadAnalysisEntries, contextSearch: ctxSearch } = await import("../lib/get-context.js");
    analysisData = { ...loadAnalysisEntries(root), ctxSearch };
  } catch (e) {
    console.error(`  [${stage.tag}] Warning: failed to load codebase context: ${e.message}`);
  }

  const agent = ensureAgent(stage.commandId);

  console.error(`  [${stage.tag}] Detecting issues...`);
  let contextEntries = [];
  if (analysisData) {
    const searchQuery = draftJson.goal || requestText;
    if (searchQuery) {
      contextEntries = await analysisData.ctxSearch(analysisData.entries, analysisData.analysis, searchQuery, root);
    }
  }
  const detectPrompt = buildDraftReviewPrompt(draftJson, requestText, contextEntries, stage);
  const fallbackSystemPrompt = stage.key === "questions"
    ? "You are a draft question boundary reviewer. Remove redundant confirmations using supplied authority; do not generate new questions."
    : "You are a draft coverage gate reviewer. Follow the current bounded map or final synthesis request; do not generate follow-up loops.";
  const promptLimit = Math.min(TASK_REVIEW_PROMPT_CHAR_LIMIT, agent.promptCharacterLimit ?? TASK_REVIEW_PROMPT_CHAR_LIMIT);
  const draftAuthorityStart = detectPrompt.search(/^## Request \/ Issue$/m);
  const repeatedDraftInstructions = draftAuthorityStart < 0 ? "" : detectPrompt.slice(0, draftAuthorityStart);
  const draftAuthorityText = draftAuthorityStart < 0 ? detectPrompt : detectPrompt.slice(draftAuthorityStart);
  const promptPlan = ReviewTextPromptPlan.create({
    request: {
      systemPrompt: fallbackSystemPrompt,
      userPrompt: detectPrompt,
      jsonSchema: null,
      fmtFallback: null,
    },
    maxChars: promptLimit,
    ElementClass: DraftSectionPromptElement,
    id: `draft-review-${stage.key}`,
    repeatedPrefix: repeatedDraftInstructions,
    sections: splitReviewTextAtHeadings(draftAuthorityText, /^##\s/gm),
  });
  const proposalLimit = stage.key === "coverage" ? 3 : DRAFT_REVIEW_ARTIFACT_LIMIT;
  const executionBudget = new PromptExecutionBudget(new PromptExecutionLimit({
      maxRequestCharacters: promptLimit,
      maxBatchCount: Math.max(promptPlan.batches.length, 16),
      maxProviderCallCount: promptPlan.batches.length + 16,
      maxSynthesisCallCount: 16,
      maxAggregateCharacters: 1_000_000,
    }));
  const executor = new PromptBatchExecutor({ executionBudget });
  const completions = await executor.executeCompletions({
    plan: promptPlan.corePlan,
    callAgent: (request, _batch, _protocolRetryIndex, _attemptContext, providerCallAdmission) => callReviewAgent(
      agent,
      request,
      stage.commandId,
      fallbackSystemPrompt,
      { providerCallAdmission },
    ),
    responseContract: {
      parse: (batchRaw) => batchRaw.includes("NO_PROPOSALS")
        ? []
        : parseProposals(batchRaw),
      itemCount: (response) => response.length,
    },
    ...(typeof agent.projectInvocation === "function" ? {
      projectInvocation: (request) => projectReviewAgentInvocation(agent, request, stage.commandId, fallbackSystemPrompt),
    } : {}),
  });
  let proposals = new DraftReviewCandidateReducer().reduce(completions);
  if (stage.key === "coverage" || completions.length > 1) {
    proposals = await synthesizeReviewFindings({
      initialItems: proposals,
      authorityElements: promptPlan.corePlan.collection.elements,
      toText: (proposal) => JSON.stringify({ title: proposal.title, body: proposal.body, file: proposal.file || null }),
      buildRequest: (findingTexts, _context, sourceRefs) => buildDraftReviewSynthesisPrompt(
        findingTexts,
        stage,
        sourceRefs,
      ),
      parseResponse: (batchRaw) => batchRaw.includes("NO_PROPOSALS")
        ? []
        : parseProposals(batchRaw, { limit: DRAFT_REVIEW_ARTIFACT_LIMIT }),
      responseItems: (response) => response,
      emptyResponse: () => [],
      maxChars: promptLimit,
      executionBudget,
      callAgent: (request, _batch, _retry, _context, providerCallAdmission) => callReviewAgent(
        agent,
        request,
        stage.commandId,
        fallbackSystemPrompt,
        { retryCount: 0, providerCallAdmission },
      ),
      projectInvocation: typeof agent.projectInvocation === "function"
        ? (request) => projectReviewAgentInvocation(
          agent,
          request,
          stage.commandId,
          fallbackSystemPrompt,
          { retryCount: 0 },
        )
        : null,
    });
  }
  proposals = proposals.slice(0, proposalLimit);
  const raw = proposals.length === 0 ? "NO_PROPOSALS" : "BATCHED_PROPOSALS";

  canonicalDraftSnapshot(source, container.get("flowManager").load(), stage.retryPhase);

  const reviewPath = path.join(outputDirectory, stage.artifact);
  const reviewArtifact = buildDraftReviewArtifact({
    raw,
    draftPath: source.logicalPath,
    draftRevision: source.revision,
    proposals,
    stage,
  });
  writeReviewAttemptHistory({
    specDir: outputDirectory,
    phase: stage.retryPhase,
    latestBasename: stage.artifact,
    artifact: reviewArtifact.toJSON(),
  });

  console.error(`  [${stage.tag}] Results saved to ${path.relative(root, reviewPath)}`);
  console.error(`  [${stage.tag}] verdict=${reviewArtifact.verdict} ${stage.countLabel}=${proposals.length} retryPhase=${stage.retryPhase}`);

  if (reviewArtifact.verdict === "PASS") {
    console.log("Draft review PASS. QA entries are adequate.");
  } else {
    console.log(`Draft review ${reviewArtifact.verdict}. ${proposals.length} finding(s) recorded for triage.`);
  }
}

async function runReview(rawArgs) {
  const root = container.get("root");
  const artifactRoot = container.get("mainRoot");
  const cli = parseArgs(rawArgs, {
    flags: ["--dry-run", "--skip-confirm"],
    options: ["--phase", "--task-spec"],
    defaults: { dryRun: false, skipConfirm: false, phase: null, taskSpec: null },
  });
  reviewArtifactWritePolicy = new ReviewArtifactWritePolicy({ enabled: !cli.dryRun });

  if (cli.help) {
    const phaseDesc = Object.entries(REVIEW_PHASES).map(([k, v]) => `'${k}' for ${v}`).join(", ");
    console.log([
      "Usage: sennel flow review [options]",
      "",
      "Options:",
      `  --phase <type>   Review phase: ${phaseDesc}`,
      "  --task-spec <path>  Use rendered task spec markdown as impl review input",
      "  --dry-run        Show proposals without applying",
      "  --skip-confirm   Skip initial confirmation prompt",
    ].join("\n"));
    return;
  }

  if (cli.phase && !REVIEW_PHASES[cli.phase]) {
    const supported = Object.keys(REVIEW_PHASES).join(", ");
    console.error(`Error: unknown phase '${cli.phase}'. Supported: ${supported}`);
    process.exit(EXIT_ERROR);
  }

  const flowManager = container.get("flowManager");
  const flow = flowManager.load();
  if (!flow) {
    console.error("Error: no active flow (flow.json not found)");
    process.exit(EXIT_ERROR);
  }

  const config = container.get("config");
  if (!config || Object.keys(config).length === 0) {
    console.error("Error: failed to load config.json");
    process.exit(EXIT_ERROR);
  }
  const spec = canonicalReviewSpec();

  // Draft review pipeline
  if (cli.phase === "draft") {
    await runDraftReview(artifactRoot, flow, config, cli.dryRun);
    sealCanonicalReviewWorkerUnit();
    return;
  }

  // Test review pipeline
  if (cli.phase === "test") {
    await runTestReview(artifactRoot, flow, spec, config, cli.dryRun);
    sealCanonicalReviewWorkerUnit();
    return;
  }

  // Spec review pipeline
  if (cli.phase === "spec") {
    await runSpecReview(artifactRoot, flow, spec, config, cli.dryRun);
    sealCanonicalReviewWorkerUnit();
    return;
  }

  const cycle = ReviewFindingCycle.fromActivityLedger({
    runId: flow.runId,
    activities: flowManager.activityLedger(flow.specId),
  });

  const reviewExclusions = resolveReviewExcludePaths(config);
  const reviewExcludeMatcher = createReviewExcludeMatcher({ root, exclusions: reviewExclusions });
  const reviewTargetFiles = new ReviewTargetFileFilter({
    specPath: relativeFlowSpecFile(flow),
    excludeMatcher: reviewExcludeMatcher,
  });
  const taskSpec = resolveTaskReviewSpec(cli.taskSpec);
  const taskReviewExecution = taskSpec === null ? null : taskReviewExecutionIdentity(taskSpec.task.id);
  // Task Review consumes the parent-materialized current source allow-list.
  // Only flow-level Review resolves a repository-wide merge base and diff.
  const mergeBase = taskSpec ? null : resolveMergeBase(root, flow.baseBranch);
  const resolvedReviewTarget = taskSpec
    ? { diff: taskSpec.currentSource, touchedFiles: taskSpec.touchedFiles, untrackedFiles: [] }
    : await resolveReviewTarget(
      root,
      flow,
      mergeBase,
      spec,
      reviewExcludeMatcher,
      reviewExclusions,
      reviewTargetFiles,
    );
  const reviewTarget = resolvedReviewTarget;
  const { diff } = reviewTarget;
  if (!diff && taskSpec === null) {
    const result = await runImplReview({
      root: artifactRoot,
      executionRoot: root,
      flowManager,
      flow,
      spec,
      cycle,
      reviewOutput: JSON.stringify({ blockingFindings: [], nonBlockingImprovements: [] }),
      touchedFiles: new Set(),
    });
    console.error(`  [review] Results saved to ${result.changed[0]}`);
    console.error(`  [review] JSON saved to ${result.changed[1]}`);
    console.error("  [review] verdict=PASS blocking=0 nonBlocking=0");
    console.log("Impl review PASS. No changes detected.");
    sealCanonicalReviewWorkerUnit();
    return;
  }

  const touchedFiles = taskSpec ? new Set(taskSpec.touchedFiles) : new Set(resolvedReviewTarget.touchedFiles);
  for (const file of reviewTarget.untrackedFiles) touchedFiles.add(file);
  const reviewGuardrails = filterByPhase(loadMergedGuardrails(root), "review");

  let fileMap = {};
  if (taskSpec) {
    console.error(`  [task-review] Reviewing ${taskSpec.relPath}...`);
    fileMap = taskSpec.fileMap;
  } else {
    fileMap = canonicalReviewFileMap(spec, { required: true });
  }
  const previousReview = loadPreviousImplReviewMemory({
    flowManager,
    flow,
    taskId: taskSpec?.task?.id ?? null,
  });
  const taskReviewAttempt = taskSpec ? taskReviewExecution.reviewAttempt : null;
  const requirementIds = taskSpec
    ? new Set(taskSpec.context.requirements.map((requirement) => requirement.id))
    : resolveRequirementIds(spec);
  const result = await runReviewWithDependencies({
    touchedFiles,
    shouldUseLoopReview: (fileCount) => (
      reviewArtifactWritePolicy.enabled
      && !taskSpec
      && shouldUseLoopReview(fileCount)
    ),
    runLoopReview: async () => {
      const proposals = await runLoopReview(root, flow, spec, mergeBase, fileMap, touchedFiles, reviewGuardrails, config);
      return proposals?.toolingOutcome
        ? proposals
        : loopProposalsToImplReviewJson(proposals, requirementIds);
    },
    runSingleReview: async () => {
      const reviewAgent = ensureAgent("flow.impl.review.propose");
      const systemPrompt = buildDraftSystemPrompt(
        reviewGuardrails,
        buildReviewAcknowledgedRationale(spec, reviewGuardrails),
      );
      const buildReviewPrompt = ({ sourceText = diff, chunkContext = null, priorReview = previousReview } = {}) => buildImplReviewPrompt({
        requirementFileMap: fileMap,
        requirementSourceScope: taskSpec?.sourceScope ?? null,
        requirementIds,
        diff: sourceText,
        touchedFiles,
        previousReview: priorReview,
        taskSpec: taskSpec ? {
          relPath: taskSpec.relPath,
          content: taskSpec.content,
        } : null,
        taskContext: taskSpec?.context ?? null,
        taskReviewAttempt,
        taskNoChangeReasons: taskSpec?.source?.noChangeReasons ?? [],
        taskReviewChunk: chunkContext,
      });
      let taskReviewMemoryDeferred = false;
      let taskReviewPlan = null;
      if (taskSpec !== null) {
        const planOptions = {
          sourceEntries: taskSpec.source.entries,
          maxChars: Math.min(
            TASK_REVIEW_PROMPT_CHAR_LIMIT,
            reviewAgent.promptCharacterLimit ?? TASK_REVIEW_PROMPT_CHAR_LIMIT,
          ),
        };
        try {
          taskReviewPlan = TaskReviewPromptPlan.create({ ...planOptions, buildPrompt: buildReviewPrompt });
        } catch (error) {
          const hasPriorMemory = ((previousReview?.previousBlockingFindings?.length || 0)
            + (previousReview?.acknowledgedNonBlockingImprovements?.length || 0)) > 0;
          if (!(error instanceof TaskReviewPromptPlanningFailure) || !hasPriorMemory) throw error;
          const deferredMemory = {
            verdict: previousReview.verdict,
            counts: previousReview.counts,
            previousBlockingFindings: [],
            acknowledgedNonBlockingImprovements: [],
          };
          taskReviewPlan = TaskReviewPromptPlan.create({
            ...planOptions,
            buildPrompt: (input) => buildReviewPrompt({ ...input, priorReview: deferredMemory }),
          });
          taskReviewMemoryDeferred = true;
        }
      }
      const reviewPrompt = taskReviewPlan?.chunks[0]?.prompt ?? buildReviewPrompt();
      const taskProtocolPolicyFor = (responseContract = null) => ({
        maxProviderCalls: 2 * (taskReviewTransportRetryPolicy(reviewAgent).retryCount + 1),
        execute: ({ request, call }) => runTaskReviewProtocol({
          root,
          executionIdentity: taskReviewExecution,
          flowManager,
          requirementIds,
          agent: reviewAgent,
          prompt: request,
          systemPrompt,
          callTransport: (currentPrompt, protocolOptions) => call(currentPrompt, protocolOptions),
          responseContract,
        }),
      });
      const taskProtocolPolicy = taskSpec ? taskProtocolPolicyFor() : null;
      const taskSummaryProtocolPolicy = taskSpec ? taskProtocolPolicyFor(new ReviewProtocolContract({
        phase: "task-review-evidence-summary",
        parse: (rawResponse) => {
          if (typeof rawResponse !== "string" || rawResponse.trim() === "") {
            throw new Error("Task Review evidence summary must be non-empty text");
          }
          return rawResponse.trim();
        },
      })) : null;
      return runImplReviewAgentWithDependencies({
        prompt: reviewPrompt,
        taskReview: taskSpec !== null,
        taskReviewPlan,
        requirementIds,
        callAgent: (currentPrompt, _chunk, _protocolRetryIndex, protocolOptions = {}, providerCallAdmission) => (
          callReviewAgent(
            reviewAgent,
            currentPrompt,
            "flow.impl.review.propose",
            systemPrompt,
            { ...protocolOptions, providerCallAdmission },
          )
        ),
        projectInvocation: taskSpec && typeof reviewAgent.projectInvocation === "function"
          ? (currentPrompt) => projectReviewAgentInvocation(
            reviewAgent,
            currentPrompt,
            "flow.impl.review.propose",
            systemPrompt,
          )
          : null,
        protocolPolicy: taskProtocolPolicy,
        synthesizeWhenSingle: taskReviewMemoryDeferred,
        synthesize: taskSpec ? async ({ completions, executionBudget, protocolPolicy }) => {
          const synthesized = await synthesizeReviewFindings({
            initialItems: completions.flatMap((completion) => [
              ...completion.response.blockingFindings,
              ...completion.response.nonBlockingImprovements,
            ]),
            authorityElements: [
              ...taskReviewPlan.corePlan.collection.elements,
              ...buildTaskReviewAuthorityElements(taskSpec, previousReview),
            ],
            toText: (finding) => JSON.stringify(taskReviewProviderFinding(finding)),
            buildRequest: (findingTexts, _context, sourceRefs) => buildTaskReviewSynthesisPrompt(
              taskReviewPlan.chunks[0].prompt,
              requirementIds,
              reviewGuardrails,
              findingTexts,
              sourceRefs,
            ),
            parseResponse: (rawResponse) => parseImplReviewFindings(rawResponse, { requirementIds, taskReview: true }),
            responseItems: (response) => [...response.blockingFindings, ...response.nonBlockingImprovements],
            emptyResponse: () => ({ blockingFindings: [], nonBlockingImprovements: [] }),
            maxChars: taskReviewPlan.maxChars,
            executionBudget,
            callAgent: (request, _batch, _retry, protocolOptions = {}, providerCallAdmission) => callReviewAgent(
              reviewAgent,
              request,
              "flow.impl.review.propose",
              systemPrompt,
              { ...protocolOptions, providerCallAdmission },
            ),
            projectInvocation: typeof reviewAgent.projectInvocation === "function"
              ? (request) => projectReviewAgentInvocation(
                reviewAgent,
                request,
                "flow.impl.review.propose",
                systemPrompt,
              )
              : null,
            protocolPolicy,
            reductionProtocolPolicy: taskSummaryProtocolPolicy,
          });
          return mergeTaskReviewParsedResponses([synthesized]);
        } : null,
      });
    },
    persistImplReview: (reviewOutput, persistenceStrategy) => persistenceStrategy.persist({
      root: artifactRoot,
      executionRoot: root,
      flowManager,
      flow,
      spec,
      cycle,
      reviewOutput,
      touchedFiles,
      taskSpec,
    }),
  });
  if (result.artifacts.toolingOutcome) {
    const outcome = result.artifacts.toolingOutcome;
    console.error([
      "  [review] outcome=TOOLING_ERROR",
      `stage=${outcome.stage}`,
      `attempt=${outcome.attempt}`,
      `maxAttempts=${outcome.maxAttempts}`,
      ...(result.artifacts.taskId ? [`taskId=${result.artifacts.taskId}`, `target=${result.artifacts.target}`] : []),
    ].join(" "));
    console.log("Impl review TOOLING_ERROR. Review tooling failed before a disposition was produced.");
    return;
  }
  console.error(`  [review] Results saved to ${result.changed[0]}`);
  console.error(`  [review] JSON saved to ${result.changed[1]}`);
  console.error([
    `  [review] verdict=${result.artifacts.verdict}`,
    `blocking=${result.artifacts.blockingCount}`,
    `nonBlocking=${result.artifacts.nonBlockingCount}`,
    ...(result.artifacts.taskId ? [`taskId=${result.artifacts.taskId}`, `target=${result.artifacts.target}`] : []),
  ].join(" "));
  if (result.artifacts.verdict === "PASS") {
    console.log("Impl review PASS. No blocking findings or non-blocking improvements recorded. See review.md.");
  } else if (result.artifacts.verdict === "ADVISORY") {
    console.log(`Impl review ADVISORY. ${result.artifacts.nonBlockingCount} non-blocking improvement(s) recorded. See review.md.`);
  } else {
    console.log(`Impl review REJECTED. ${result.artifacts.blockingCount} blocking finding(s) recorded. See review.md.`);
  }
  sealCanonicalReviewWorkerUnit();
}

/**
 * Strip AI preamble text that appears before the actual spec content.
 * Also removes markdown fences wrapping the spec.
 * @param {string} text
 * @returns {string}
 */
function stripPreamble(text) {
  if (!text) return text;

  // Strip markdown fences first
  let cleaned = text.replace(/^```(?:markdown)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

  // Find the first spec header
  const headerMatch = cleaned.match(/^(#\s+Feature Specification|##\s+Goal)/m);
  if (!headerMatch) return cleaned;

  // Remove everything before the header
  const headerIdx = cleaned.indexOf(headerMatch[0]);
  if (headerIdx > 0) {
    cleaned = cleaned.slice(headerIdx);
  }

  return cleaned;
}

/**
 * Validate that AI output looks like spec content, not garbage text.
 * @param {string} text
 * @returns {boolean}
 */
function isValidSpecOutput(text) {
  if (!text || !text.trim()) return false;
  return /^#\s+Feature Specification/m.test(text) || /^##\s+Goal/m.test(text);
}

export {
  parseProposals, formatReviewMd, resolveReviewTarget,
  resolveMergeBase,
  buildDraftSystemPrompt,
  NO_PROPOSALS_MARKER,
  collectTouchedFiles, filterProposalsByScope, extractProposalFile,
  createReviewExcludeMatcher, resolveReviewExcludePaths, prepareLoopReviewInputsWithExclusions,
  getReviewMaxAttempts, REVIEW_PHASES, extractRequirements, collectTestFiles, parseGaps,
  applyTestFixes, formatTestReviewMd, runReviewLoop,
  buildTestReviewPrompt, parseTestReviewFindings,
  TEST_REVIEW_PROMPT_CHAR_LIMIT, runTestReviewWithDependencies,
  extractGoalAndScope, buildSpecSummaryMarkdown, buildSpecReviewPrompt,
  formatSpecReviewMd, formatSpecReviewDelta, parseSpecReviewFindings,
  buildImplReviewPrompt, parseImplReviewFindings, filterImplReviewFindingsByScope,
  formatImplReviewMd, formatImplReviewJson, loadPreviousImplReviewMemory, priorImplReviewFingerprintCounts,
  runImplReview,
  isValidSpecOutput, stripPreamble, buildGapAnalysisPrompt, buildTestFixPrompt,
  buildDraftReviewPrompt,
  buildDraftReviewAuthorityText,
  buildDraftReviewArtifact,
  shouldUseLoopReview, groupByDiffContent, buildPerFileReviewInput,
  buildCrossCheckInput, expandProposalsToGroup,
  createLoopReviewChunks, runLoopReviewWithDependencies,
  runActiveImplReviewWithDependencies, runReviewWithDependencies,
  runSingleShotImplReviewWithDependencies, runNonImplReviewWithDependencies,
  runTaskReviewProtocol,
  runTaskReviewPromptPlanWithDependencies,
  runImplReviewAgentWithDependencies,
  synthesizeReviewFindings,
  canonicalTaskReviewFileMap,
  mergeTaskReviewChunkResponses,
  loopProposalsToImplReviewJson,
  classifyReviewCommandError,
  LOOP_REVIEW_THRESHOLD, MAX_LOOP_CALLS,
};

export default class FlowReviewCommand extends Command {
  static outputMode = "raw";
  async execute(ctx) {
    return runReview(ctx._rawArgs || []);
  }
}

// Direct-invocation entrypoint: `node src/flow/commands/review.js ...args`.
// Used by RunReviewCommand (src/flow/lib/run-review.js) as a subprocess so
// AI review can run with its own timeout.
if (import.meta.url === `file://${process.argv[1]}`) {
  initContainer();
  runReview(process.argv.slice(2)).catch((err) => {
    const cli = parseReviewCliArgsForError(process.argv.slice(2));
    const failure = classifyReviewCommandError(err, cli.phase);
    if (failure) console.error(failure.toMarkerLine());
    if (err instanceof DraftArtifactRecoveryError) console.error(err.toMarkerLine());
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}
