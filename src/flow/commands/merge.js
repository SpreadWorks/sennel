import { CURRENT_FLOW_SCHEMA_REVISION } from "../../lib/flow-schema-revision.js";
/**
 * src/flow/commands/merge.js
 *
 * Squash merge or PR creation based on flow state.
 * Called by finalize.js with ctx containing root, flowState, worktreePath, mainRepoPath.
 *
 * Strategy is determined solely from config (`commands.gh`) and `gh` availability:
 *   commands.gh === "enable" AND gh available  → PR route
 *   otherwise                                   → squash merge route
 * No CLI escape hatch exists (spec 215 / issue #223).
 */

import { runCmd, assertOk } from "../../lib/process.js";
import path from "path";
import { container } from "../../lib/container.js";
import { isGhAvailable, runGit, fetchBranch, rebaseOnto, abortRebase } from "../../lib/git-helpers.js";
import {
  FinalizeMergeTransaction,
  FinalizeMergeTransactionError,
} from "../lib/finalize-merge-transaction.js";
import { FinalizeFlowArtifactRegistry } from "../lib/repair-state-identity.js";
import { relativeFlowSpecFile } from "../../lib/flow-workspace.js";
import { PRODUCT } from "../../lib/product.js";

const MAX_IMPLEMENTATION_SUBJECTS = 50;
const MAX_SUBJECT_INPUT_CHARS = 4000;
const MAX_SUBJECT_INPUT_LINES = 20;
const MAX_IMPLEMENTATION_SUBJECT_OUTPUT_CHARS = MAX_IMPLEMENTATION_SUBJECTS * (MAX_SUBJECT_INPUT_CHARS + 1);
const SQUASH_MESSAGE_IGNORED_SUBJECTS = new Set([
  "chore: record finalize metadata before merge",
]);

export class MergeRevalidationRequiredError extends Error {
  constructor({ beforeHead, afterHead }) {
    super("pre-merge synchronization changed the feature HEAD; verification must be refreshed");
    this.name = "MergeRevalidationRequiredError";
    this.code = "MERGE_REVALIDATION_REQUIRED";
    this.beforeHead = beforeHead;
    this.afterHead = afterHead;
  }
}

/**
 * Resolve push remote from config.
 * @param {Object} cfg - Spec-Driven Development config
 * @returns {string}
 */
function resolveRemote(cfg) {
  return cfg?.flow?.push?.remote || "origin";
}

/**
 * Extract the Goal / Scope / Requirements fields from a spec.json object as
 * structured data (spec 207 / T8). Pure data extraction with no formatting —
 * rendering lives in the formatter helpers below.
 *
 * @param {object|null} spec - parsed spec.json (or null)
 * @returns {{
 *   goal: string|null,
 *   scopeIn: string[],
 *   scopeOut: string[],
 *   requirements: Array<{id:string,desc:string,priority?:string}>
 * }}
 */
function parseSpec(spec) {
  if (!spec) return { goal: null, scopeIn: [], scopeOut: [], requirements: [] };
  return {
    goal: spec.goal ? spec.goal.trim() || null : null,
    scopeIn: Array.isArray(spec.scope?.in) ? structuredClone(spec.scope.in) : [],
    scopeOut: Array.isArray(spec.scope?.out) ? structuredClone(spec.scope.out) : [],
    requirements: Array.isArray(spec.requirements) ? structuredClone(spec.requirements) : [],
  };
}

function formatRequirementsBlock(reqs) {
  if (!reqs || reqs.length === 0) return null;
  return reqs.map((r) => `- ${r.id}${r.priority ? ` [${r.priority}]` : ""}: ${r.desc}`).join("\n");
}

function formatScopeBlock({ scopeIn, scopeOut }) {
  const parts = [];
  for (const item of scopeIn) parts.push(`- ${item}`);
  if (scopeOut.length) {
    parts.push("", "### Out of Scope");
    for (const item of scopeOut) parts.push(`- ${item}`);
  }
  return parts.length ? parts.join("\n") : null;
}

/**
 * Build PR title from parsed spec.
 * @param {{goal: string|null}|null} spec - parsed spec sections
 * @param {string} fallback - fallback title
 * @returns {string}
 */
function buildPrTitle(spec, fallback) {
  if (spec?.goal) {
    const firstLine = spec.goal.split("\n")[0].trim();
    if (firstLine) return firstLine;
  }
  return fallback;
}

/**
 * Build PR body from flow state and parsed spec structured data.
 * @param {Object} state - flow.json state
 * @param {ReturnType<typeof parseSpec>|null} spec - structured spec data
 * @returns {string}
 */
function buildPrBody(state, spec) {
  const lines = [];
  if (state.issue) {
    lines.push(`fixes #${state.issue}`);
    lines.push("");
  }
  const reqsBlock = spec ? formatRequirementsBlock(spec.requirements) : null;
  const scopeBlock = spec ? formatScopeBlock(spec) : null;
  if (spec?.goal) {
    lines.push("## Goal", "", spec.goal, "");
  }
  if (reqsBlock) {
    lines.push("## Requirements", "", reqsBlock, "");
  }
  if (scopeBlock) {
    lines.push("## Scope", "", scopeBlock, "");
  }
  if (!spec?.goal && !reqsBlock && !scopeBlock && state.request) {
    lines.push("## Summary", "", state.request);
  }
  return lines.join("\n").trim();
}

/** Catalog-authoritative Spec projection used by both finalize merge routes. */
export class CanonicalFinalizeMergeSpecSource {
  #document;

  constructor({ flowManager, state } = {}) {
    if (!flowManager || typeof flowManager.readArtifact !== "function") {
      throw new Error("finalize merge Spec source requires FlowManager.readArtifact");
    }
    if (state?.schemaRevision !== CURRENT_FLOW_SCHEMA_REVISION || typeof state.specId !== "string" || state.specId === "") {
      throw new Error("finalize merge Spec source requires a Version-1 Flow state");
    }
    const resolved = flowManager.readArtifact({
      specId: state.specId,
      logicalKey: "spec.record",
      consumerNodeId: "finalize-merge",
    });
    let document;
    try {
      document = JSON.parse(resolved.bytes.toString("utf8"));
    } catch (error) {
      throw new Error(`finalize merge cataloged Spec must be JSON: ${error.message}`);
    }
    if (document === null || typeof document !== "object" || Array.isArray(document)) {
      throw new Error("finalize merge cataloged Spec must be an object");
    }
    this.relativePath = resolved.relativePath;
    this.#document = structuredClone(document);
    Object.freeze(this);
  }

  summary() {
    return parseSpec(this.#document);
  }
}

function finalizationFeatureArtifactRegistry(state) {
  if (typeof state.specId !== "string" || state.specId === "") return null;
  return new FinalizeFlowArtifactRegistry(relativeFlowSpecFile(state));
}

function firstNonEmptySubjectLine(value) {
  const text = String(value || "").slice(0, MAX_SUBJECT_INPUT_CHARS);
  let lineStart = 0;
  let inspectedLines = 0;
  for (let i = 0; i <= text.length && inspectedLines < MAX_SUBJECT_INPUT_LINES; i += 1) {
    if (i < text.length && text[i] !== "\n") continue;
    const line = text.slice(lineStart, i).trim();
    if (line) return line;
    inspectedLines += 1;
    lineStart = i + 1;
  }
  return null;
}

function collectImplementationSubjects({
  cwd,
  baseBranch,
  featureBranch,
  limit = MAX_IMPLEMENTATION_SUBJECTS,
}) {
  const parsedLimit = Number(limit);
  const effectiveLimit = Number.isFinite(parsedLimit) ? parsedLimit : MAX_IMPLEMENTATION_SUBJECTS;
  const boundedLimit = Math.trunc(Math.max(0, Math.min(effectiveLimit, MAX_IMPLEMENTATION_SUBJECTS)));
  if (!cwd || !baseBranch || !featureBranch || boundedLimit === 0) return [];
  const res = runGit(["-C", cwd, "log", `--max-count=${boundedLimit}`, "--format=%s", `${baseBranch}..${featureBranch}`]);
  if (!res.ok) {
    process.stderr.write(`[sennel] warning: failed to collect implementation commit subjects: ${res.stderr || res.stdout}\n`);
    return [];
  }
  return String(res.stdout || "")
    .slice(0, MAX_IMPLEMENTATION_SUBJECT_OUTPUT_CHARS)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((subject) => !SQUASH_MESSAGE_IGNORED_SUBJECTS.has(subject));
}

function buildSquashCommitMessage({
  state,
  spec,
  fallbackTitle,
  implementationSubjects = [],
  idempotencyKey = null,
}) {
  let implementationSubject = null;
  for (const candidate of implementationSubjects) {
    implementationSubject = firstNonEmptySubjectLine(candidate);
    if (implementationSubject) break;
  }
  const subject = firstNonEmptySubjectLine(spec?.goal)
    || implementationSubject
    || firstNonEmptySubjectLine(fallbackTitle)
    || "finalize-merge";
  const paragraphs = [subject];
  if (state.issue) paragraphs.push(`fixes #${state.issue}`);
  if (idempotencyKey) paragraphs.push(`${PRODUCT.artifactMarker("outbox")}: ${idempotencyKey}`);
  return paragraphs.join("\n\n");
}

/**
 * Resolve the merge strategy from flow state and config alone. Pure function —
 * used by both the live merge path and finalize's dry-run reporting so that
 * the dry-run `strategy` value matches what would actually be executed.
 *
 * @param {{ baseBranch: string, featureBranch: string }} state
 * @param {Object} config - Spec-Driven Development config
 * @param {() => boolean} [ghAvailable=isGhAvailable]
 * @returns {"skip"|"pr"|"squash"}
 */
function resolveMergeStrategy(state, config, ghAvailable = isGhAvailable) {
  if (state.featureBranch === state.baseBranch) return "skip";
  const ghEnabled = config?.commands?.gh === "enable";
  return ghEnabled && ghAvailable() ? "pr" : "squash";
}

function fallbackTitleFromSpecId(specId, featureBranch) {
  if (!specId) return featureBranch;
  const separator = specId.indexOf("-");
  return separator < 0 ? specId : specId.slice(separator + 1);
}

/**
 * Execute merge operation.
 * @param {Object} ctx
 * @param {string} ctx.root - project root (worktree or main repo)
 * @param {Object} ctx.flowState - flow.json state
 * @param {string|null} ctx.worktreePath - worktree path (null if not worktree mode)
 * @param {string|null} ctx.mainRepoPath - main repo path (null if not worktree mode)
 * @returns {{ strategy: string }} - the resolved strategy
 */
function runMerge(ctx) {
  const { flowState: state, mainRepoPath, idempotencyKey = null } = ctx;
  const artifactRoot = ctx.root || container.get("root");
  const executionRoot = ctx.executionRoot || ctx.worktreePath || artifactRoot;
  const { baseBranch, featureBranch, worktree } = state;

  const cfg = container.get("config");
  const strategy = resolveMergeStrategy(state, cfg);

  if (strategy === "skip") {
    return { strategy: "skip" };
  }
  const spec = new CanonicalFinalizeMergeSpecSource({
    flowManager: ctx.flowManager,
    state,
  }).summary();

  // PR route
  if (strategy === "pr") {
    const remote = resolveRemote(cfg);
    const fallbackTitle = fallbackTitleFromSpecId(state.specId, featureBranch);
    const title = buildPrTitle(spec, fallbackTitle);
    const marker = idempotencyKey ? `<!-- sennel:${idempotencyKey} -->` : null;
    const body = [buildPrBody(state, spec), marker].filter(Boolean).join("\n\n");

    if (idempotencyKey) {
      const existing = runCmd("gh", [
        "pr", "list",
        "--base", baseBranch,
        "--head", featureBranch,
        "--state", "all",
        "--limit", "1",
        "--json", "number",
      ]);
      assertOk(existing, "failed to inspect existing pull requests before resume");
      const matches = JSON.parse(existing.stdout || "[]");
      if (matches.length > 0) return { strategy: "pr", resumed: true };
    }

    const pushRes = runGit(["-C", executionRoot, "push", "-u", remote, featureBranch]);
    assertOk(pushRes, "git push failed");
    const prRes = runCmd("gh", [
      "pr", "create",
      "--base", baseBranch,
      "--head", featureBranch,
      "--title", title,
      ...(body ? ["--body", body] : []),
    ]);
    assertOk(prRes, "gh pr create failed");
    return { strategy: "pr" };
  }

  // Squash merge route
  const fallbackTitle = fallbackTitleFromSpecId(state.specId, featureBranch);

  if (worktree && mainRepoPath) {
    const cfg = container.get("config");
    const remote = resolveRemote(cfg);
    const beforeSync = runGit(["-C", mainRepoPath, "rev-parse", featureBranch]);
    assertOk(beforeSync, "failed to capture feature HEAD before pre-merge synchronization");
    const syncResult = runPreSync({ worktreePath: executionRoot, baseBranch, featureBranch, remote });
    if (syncResult.ok === false) {
      if (syncResult.dirty) {
        throw new FinalizeMergeTransactionError({
          code: "MERGE_PRE_SYNC_DIRTY",
          message: syncResult.recoveryHint,
          data: { recoveryHint: syncResult.recoveryHint },
        });
      }
      throw new FinalizeMergeTransactionError({
        code: "MERGE_PRE_SYNC_CONFLICT",
        message: `Pre-merge rebase detected conflicts in ${syncResult.conflictFiles.join(", ")}. Worktree has been restored. ${syncResult.recoveryHint}`,
        data: {
          conflictFiles: syncResult.conflictFiles,
          recoveryHint: syncResult.recoveryHint,
          recovery: syncResult.recovery,
        },
      });
    }

    const afterSync = runGit(["-C", mainRepoPath, "rev-parse", featureBranch]);
    assertOk(afterSync, "failed to capture feature HEAD after pre-merge synchronization");
    if (
      ctx.requireRevalidationAfterSync === true
      && beforeSync.stdout.trim() !== afterSync.stdout.trim()
    ) {
      throw new MergeRevalidationRequiredError({
        beforeHead: beforeSync.stdout.trim(),
        afterHead: afterSync.stdout.trim(),
      });
    }

  }

  const implementationSubjects = collectImplementationSubjects({
    cwd: executionRoot,
    baseBranch,
    featureBranch,
  });
  const commitMessage = buildSquashCommitMessage({
    state,
    spec,
    fallbackTitle,
    implementationSubjects,
    idempotencyKey,
  });
  return new FinalizeMergeTransaction({
    featureRoot: executionRoot,
    mainRoot: mainRepoPath || artifactRoot,
    baseBranch,
    featureBranch,
    commitMessage,
    idempotencyKey,
    operationOwnerToken: ctx.repositoryOperationOwnerToken || null,
    flowArtifactRegistry: finalizationFeatureArtifactRegistry(state),
    promoteFeatureWorktreeToBase: worktree !== true
      && path.resolve(mainRepoPath || artifactRoot) === path.resolve(executionRoot),
  }).execute();
}

/**
 * Pre-merge sync: fetch base from remote and rebase the worktree's feature branch
 * onto it. Runs only in worktree + squash route; PR route and spec-only mode skip.
 *
 * Returns one of:
 *   { ok: true }                                            — rebase succeeded (or fast-forward / no-op).
 *   { ok: false, conflictFiles: string[], recoveryHint }    — rebase conflicted; worktree restored via --abort.
 *   { skipped: "pr-route" | "spec-only" }                   — not applicable to this route.
 */
function runPreSync({ worktreePath, baseBranch, featureBranch, remote = "origin", usePr = false }) {
  if (usePr) return { skipped: "pr-route" };
  if (featureBranch && featureBranch === baseBranch) return { skipped: "spec-only" };

  const fetchRes = fetchBranch(remote, baseBranch, { cwd: worktreePath });
  if (!fetchRes.ok) {
    const err = new Error(
      `pre-merge fetch failed: git fetch ${remote} ${baseBranch} exited ${fetchRes.status}: ${fetchRes.stderr || fetchRes.stdout}`,
    );
    err.code = "MERGE_PRE_SYNC_FETCH_FAILED";
    err.fetchFailed = true;
    throw err;
  }
  const rebaseRef = `${remote}/${baseBranch}`;
  const baseHeadRes = runGit(["-C", worktreePath, "rev-parse", rebaseRef]);
  if (!baseHeadRes.ok) {
    const err = new Error(
      `pre-merge base resolution failed: git rev-parse ${rebaseRef} exited ${baseHeadRes.status}: ${baseHeadRes.stderr || baseHeadRes.stdout}`,
    );
    err.code = "MERGE_PRE_SYNC_BASE_UNAVAILABLE";
    throw err;
  }
  const recovery = {
    baseRef: rebaseRef,
    baseHead: baseHeadRes.stdout.trim(),
  };

  // finalize-merge records its pending outbox before this side effect. Keep
  // that Flow-owned change through pre-merge synchronization without masking
  // unrelated dirty files (which are rejected by the lifecycle preflight).
  const rebaseRes = rebaseOnto(rebaseRef, { cwd: worktreePath, autostash: true });
  if (rebaseRes.ok) return { ok: true };

  if (rebaseRes.reason === "dirty") {
    return {
      ok: false,
      dirty: true,
      conflictFiles: [],
      recoveryHint:
        "Pre-merge rebase failed: working tree has uncommitted changes. Commit or discard changes in the worktree before retrying finalize.",
    };
  }

  abortRebase({ cwd: worktreePath });
  const recoveryHint =
    `Run 'git rebase ${rebaseRef}' in the worktree, resolve conflicts, then 'git rebase --continue' and refresh the Flow directive.`;
  return { ok: false, conflictFiles: rebaseRes.conflictFiles, recoveryHint, recovery };
}

export {
  runMerge,
  resolveMergeStrategy,
  parseSpec,
  buildPrTitle,
  buildPrBody,
  buildSquashCommitMessage,
  collectImplementationSubjects,
  fallbackTitleFromSpecId,
  runPreSync,
};
