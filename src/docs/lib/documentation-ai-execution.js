import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { AtomicJsonFile } from "../../lib/atomic-json-file.js";
import { createI18n } from "../../lib/i18n.js";
import { AgentProviderAttemptObserver, AgentProviderAttemptAdmission, AgentProviderAttemptRecord } from "../../lib/agent-provider-attempt.js";
import { DocumentationAgent } from "./documentation-agent.js";
import { collectFiles, getFileStats } from "./scanner.js";
import { resolveDocumentationScanPatterns } from "./scan-patterns.js";
import { resolveMultiChains } from "../../lib/presets.js";
import { managedOutputDir } from "../../lib/config.js";

export const DEFAULT_DOCUMENTATION_AI_CONFIRMATION_THRESHOLD = 1_000_000;
const TOKEN_FIELDS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"];

export class DocumentationAiExecutionStopped extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
  }
}

export class DocumentationAiCancelled extends DocumentationAiExecutionStopped {
  constructor(message = "Documentation AI execution cancelled") {
    super(message, "DOCS_AI_CANCELLED", "cancelled");
  }
}

export class DocumentationAiConfirmationRequired extends DocumentationAiExecutionStopped {
  constructor(message) {
    super(`DOCS_AI_CONFIRMATION_REQUIRED: ${message}`, "DOCS_AI_CONFIRMATION_REQUIRED", "confirmation-required");
  }
}

export class DocumentationAiAborted extends DocumentationAiExecutionStopped {
  constructor(signal) {
    super(`Documentation AI execution interrupted (${signal})`, "DOCS_AI_ABORTED", "aborted");
    this.signal = signal;
    this.exitCode = signal === "SIGINT" ? 130 : 143;
  }
}

class TokenUsageTotal {
  knownTotal = 0;
  unknownAttemptCount = 0;

  add(value) {
    if (value === null || value === undefined) this.unknownAttemptCount++;
    else this.knownTotal += value;
  }

  toJSON() {
    return { knownTotal: this.knownTotal, unknownAttemptCount: this.unknownAttemptCount, complete: this.unknownAttemptCount === 0 };
  }

  display(t) {
    const count = this.knownTotal.toLocaleString("en-US");
    return this.unknownAttemptCount === 0 ? count : t("docsAi.unknownTokens", { known: count, unknown: this.unknownAttemptCount });
  }
}

class DocumentationAiUsageGroup {
  constructor(commandId, provider = null, profileKey = null) {
    this.commandId = commandId;
    this.provider = provider;
    this.profileKey = profileKey;
    this.providerAttemptCount = 0;
    this.retryAttemptCount = 0;
    this.inputCharacters = 0;
    this.tokens = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, new TokenUsageTotal()]));
  }

  add(record, retry) {
    this.providerAttemptCount++;
    if (retry) this.retryAttemptCount++;
    this.inputCharacters += record.inputCharacters;
    for (const field of TOKEN_FIELDS) this.tokens[field].add(record.usage?.[field]);
  }

  toJSON() {
    return {
      commandId: this.commandId, provider: this.provider, profileKey: this.profileKey,
      providerAttemptCount: this.providerAttemptCount, retryAttemptCount: this.retryAttemptCount,
      observedAttemptInputCharacters: this.inputCharacters,
      tokens: Object.fromEntries(TOKEN_FIELDS.map((field) => [field, this.tokens[field].toJSON()])),
    };
  }
}

export class DocumentationAiUsageReport {
  #records = new Map();
  #groups = new Map();
  #stages = new Map();
  #total = new DocumentationAiUsageGroup("total");
  #problems = [];

  add(record, stage = record.commandId) {
    if (!(record instanceof AgentProviderAttemptRecord)) throw new TypeError("Documentation report requires a typed provider attempt");
    if (this.#records.has(record.attemptId)) {
      this.problem("duplicate-provider-attempt");
      return;
    }
    this.#records.set(record.attemptId, record);
    if (!record.providerStarted) return;
    const command = stage || "unknown";
    const retry = record.attemptIndex > 0 || (record.invocation?.protocolAttemptIndex ?? 0) > 0;
    const key = JSON.stringify([command, record.provider, record.profileKey]);
    if (!this.#groups.has(key)) this.#groups.set(key, new DocumentationAiUsageGroup(command, record.provider, record.profileKey));
    if (!this.#stages.has(command)) this.#stages.set(command, new DocumentationAiUsageGroup(command));
    this.#groups.get(key).add(record, retry);
    this.#stages.get(command).add(record, retry);
    this.#total.add(record, retry);
  }

  problem(reason) { this.#problems.push(reason); }

  get observedAttemptInputCharacters() { return this.#total.inputCharacters; }
  get providerAttemptCount() { return this.#total.providerAttemptCount; }

  toJSON() {
    return {
      ...this.#total.toJSON(),
      observationComplete: this.#problems.length === 0,
      observationProblems: [...this.#problems],
      stages: [...this.#stages.values()].map((group) => group.toJSON()),
      groups: [...this.#groups.values()].map((group) => group.toJSON()),
      notStartedAttemptCount: [...this.#records.values()].filter((record) => !record.providerStarted).length,
    };
  }

  toText(t, status) {
    const lines = [t("docsAi.reportTitle", { status, calls: this.#total.providerAttemptCount, retries: this.#total.retryAttemptCount }), t("docsAi.reportColumns")];
    for (const group of [...this.#stages.values(), this.#total]) {
      const label = group.commandId === "total" ? t("docsAi.total") : group.commandId;
      lines.push(`${label}\t${TOKEN_FIELDS.map((field) => group.tokens[field].display(t)).join("\t")}`);
    }
    if (this.#problems.length > 0) lines.push(t("docsAi.observationIncomplete"));
    return lines.join("\n");
  }
}

class DocumentationAiAdmission extends AgentProviderAttemptAdmission {
  constructor(session, commandId) { super(); this.session = session; this.commandId = commandId; }
  admit(prepared) { return this.session.admit(prepared, this.commandId); }
  beforeProviderAttempt(context) { return this.session.beforeProviderAttempt(context, this.commandId); }
}

function askYesNo(prompt, { input, output, signal }) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    let settled = false;
    const finish = (accepted) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", close);
      rl.close();
      resolve(accepted);
    };
    const close = () => finish(false);
    rl.once("close", close);
    signal.addEventListener("abort", close, { once: true });
    const question = () => rl.question(prompt, (answer) => {
      const value = answer.trim().toLowerCase();
      if (["y", "yes"].includes(value)) finish(true);
      else if (["", "n", "no"].includes(value)) finish(false);
      else question();
    });
    question();
  });
}

function hashFile(file) { return getFileStats(file).hash; }

class DocumentationAiSourceRevision {
  constructor(file) {
    this.file = file;
    this.hash = fs.existsSync(file) ? hashFile(file) : null;
    Object.freeze(this);
  }

  current() {
    const current = new DocumentationAiSourceRevision(this.file);
    return current.hash === this.hash ? this : current;
  }
}

function initialDocumentationInputs(ctx, commandId) {
  const files = new Set();
  if (ctx.config?.scan || ctx.type) {
    const patterns = resolveDocumentationScanPatterns({ config: ctx.config || {}, type: ctx.type, root: ctx.root });
    for (const file of collectFiles(ctx.srcRoot || ctx.root, patterns.include, patterns.exclude)) files.add(file.absPath);
  }
  for (const directory of [ctx.docsDir || path.join(ctx.root, "docs"), path.join(ctx.root, ".sennel", "templates")]) {
    for (const file of collectFiles(directory, ["**/*.md"])) files.add(file.absPath);
  }
  if (ctx.type && ["docs.build", "docs.init", "docs.readme", "docs.forge"].includes(commandId)) {
    const seen = new Set();
    for (const chain of resolveMultiChains(ctx.type, ctx.root)) {
      for (const preset of chain) {
        if (seen.has(preset.dir)) continue;
        seen.add(preset.dir);
        for (const file of collectFiles(path.join(preset.dir, "templates"), ["**/*.md"])) files.add(file.absPath);
      }
    }
  }
  for (const name of ["README.md", "AGENTS.md", "CLAUDE.md", "package.json"]) {
    const file = path.join(ctx.root, name);
    if (fs.existsSync(file)) files.add(file);
  }
  const analysisPath = path.join(managedOutputDir(ctx.root), "analysis.json");
  if (fs.existsSync(analysisPath)) files.add(analysisPath);
  return [...files];
}

function shellArgument(value) {
  return /^[a-zA-Z0-9_./:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** One CLI invocation owns approval, its attempt ledger, and one final report. */
export class DocumentationAiExecutionSession extends AgentProviderAttemptObserver {
  #approved;
  #approvalMethod;
  #stopError = null;
  #tail = Promise.resolve();
  #occurrences = new Set();
  #attempts = new Set();
  #stageByOccurrence = new Map();
  #stageByAttempt = new Map();
  #files = new Map();
  #sourceFiles = new Map();
  #ownedFiles = new Set();
  #pendingScopeChange = false;
  #configRevisions = new Map();
  #partial = false;
  #failed = false;
  #finished = null;
  #unknownPhases = new Set();
  #externalCommands = new Set();
  #controller = new AbortController();

  constructor({ root, sourceRoot = root, commandId, args = [], initialInputs = [], config = {}, yes = false, dryRun = false, input = process.stdin,
    output = process.stderr, ask = askYesNo, t = createI18n(config.lang || "en", { domain: "messages" }), now = () => new Date(), runId = randomUUID() } = {}) {
    super();
    const threshold = config.docs?.ai?.confirmationThresholdCharacters;
    this.threshold = threshold === undefined ? DEFAULT_DOCUMENTATION_AI_CONFIRMATION_THRESHOLD : threshold;
    if (!Number.isSafeInteger(this.threshold) || this.threshold < 1) throw new TypeError("docs.ai.confirmationThresholdCharacters must be a positive safe integer");
    this.root = root;
    this.sourceRoot = sourceRoot;
    this.commandId = commandId;
    this.approvalCommand = ["sennel", ...commandId.split("."), ...args.filter((arg) => arg !== "--yes"), "--yes"].map(shellArgument).join(" ");
    this.runId = runId;
    this.startedAt = now().toISOString();
    this.now = now;
    this.input = input;
    this.output = output;
    this.ask = ask;
    this.t = t;
    this.dryRun = dryRun;
    this.plannedInputCharacters = 0;
    this.plannedBatchCount = 0;
    this.report = new DocumentationAiUsageReport();
    this.#approved = yes;
    this.#approvalMethod = yes ? "--yes" : "not-required";
    for (const name of ["config.json", "config.local.json"]) {
      const configPath = path.join(root, ".sennel", name);
      this.#configRevisions.set(configPath, fs.existsSync(configPath) ? hashFile(configPath) : null);
    }
    this.registerInputs(initialInputs);
  }

  get stopped() { return this.#stopError !== null; }
  get stopError() { return this.#stopError; }
  get abortSignal() { return this.#controller.signal; }
  get approved() { return this.#approved; }

  assertActive() { if (this.#stopError) throw this.#stopError; }

  stop(error) {
    if (!this.#stopError) this.#stopError = error;
    if (!this.#controller.signal.aborted) this.#controller.abort(this.#stopError);
    return this.#stopError;
  }

  abort(signal) { this.stop(new DocumentationAiAborted(signal)); }
  markPartialError() { this.#partial = true; }
  markFailed() { this.#failed = true; }
  markUnknownPhase(commandId) { this.#unknownPhases.add(commandId); }
  markExternalCommand() { this.#externalCommands.add("review-cmd"); }

  createExecutionLimit(options = {}) { return DocumentationAgent.createExecutionLimit(options); }
  createExecutionAdmission(commandId) { return new DocumentationAiAdmission(this, commandId); }

  registerFiles(commandId, files) {
    if (files.length === 0) return;
    if (!this.#files.has(commandId)) this.#files.set(commandId, new Set());
    for (const file of files) this.#files.get(commandId).add(file);
  }

  registerInputs(files) {
    for (const file of files) {
      const absolute = path.resolve(this.root, file);
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile() || this.#sourceFiles.has(absolute)) continue;
      if (this.#approved && this.#occurrences.size > 0 && !this.#ownedFiles.has(absolute)) this.#pendingScopeChange = true;
      this.#sourceFiles.set(absolute, new DocumentationAiSourceRevision(absolute));
    }
  }

  recordGeneratedFiles(files) {
    for (const file of files) {
      const absolute = path.resolve(this.root, file);
      this.#ownedFiles.add(absolute);
      if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) this.#sourceFiles.set(absolute, new DocumentationAiSourceRevision(absolute));
    }
  }

  #serialize(operation) {
    const pending = this.#tail.then(operation);
    this.#tail = pending.catch(() => {});
    return pending;
  }

  #captureSources(prepared, commandId) {
    const files = [];
    for (const invocation of prepared.invocations) {
      for (const element of invocation.batch.payloadElements) {
        if (typeof element.file !== "string") continue;
        files.push(element.file);
        // Ranged analysis is immutable evidence; generated documents are not
        // external source revisions and can change within the approved run.
        if (typeof element.category !== "string") continue;
        this.registerInputs([path.resolve(this.sourceRoot, element.file)]);
      }
    }
    if (!this.#files.has(commandId)) this.registerFiles(commandId, files);
  }

  async admit(prepared, commandId = this.commandId) {
    return this.#serialize(async () => {
      this.assertActive();
      if (this.#occurrences.has(prepared.occurrenceId)) return;
      this.#occurrences.add(prepared.occurrenceId);
      this.#stageByOccurrence.set(prepared.occurrenceId, commandId);
      this.#captureSources(prepared, commandId);
      this.plannedInputCharacters += prepared.inputCharacters;
      this.plannedBatchCount += prepared.batchCount;
      const fileCount = this.#files.get(commandId)?.size || 0;
      if (this.dryRun) {
        this.output.write(`${this.t("docsAi.preview", { command: commandId, files: fileCount, characters: prepared.inputCharacters, batches: prepared.batchCount, confirmation: this.plannedInputCharacters >= this.threshold ? "yes" : "no" })}\n`);
        return;
      }
      const changed = this.#scopeChanged();
      if (changed) this.#approved = false;
      await this.#authorize(commandId, fileCount, prepared.inputCharacters, prepared.batchCount, changed);
    });
  }

  async #authorize(commandId, files, characters, batches, changed = false) {
    this.assertActive();
    if (this.#approved && !changed) return;
    if (!changed && this.plannedInputCharacters < this.threshold) return;
    const description = this.t("docsAi.confirmationDetails", {
      command: commandId, files, characters, batches,
      total: this.plannedInputCharacters, consumed: this.report.observedAttemptInputCharacters,
      run: this.commandId,
    });
    this.output.write(`${description}\n`);
    if (changed) this.output.write(`${this.t("docsAi.scopeChanged")}\n`);
    if (!this.input.isTTY || !this.output.isTTY) {
      throw this.stop(new DocumentationAiConfirmationRequired(this.t("docsAi.confirmationRequired", { command: this.approvalCommand })));
    }
    const accepted = await this.ask(this.t("docsAi.question", { command: this.commandId }), { input: this.input, output: this.output, signal: this.abortSignal });
    this.assertActive();
    if (!accepted) throw this.stop(new DocumentationAiCancelled(this.t("docsAi.cancelled")));
    this.#approved = true;
    this.#approvalMethod = "interactive";
  }

  #scopeChanged() {
    let changed = this.#pendingScopeChange;
    this.#pendingScopeChange = false;
    for (const [file, revision] of this.#configRevisions) {
      const current = fs.existsSync(file) ? hashFile(file) : null;
      if (current !== revision) changed = true;
      this.#configRevisions.set(file, current);
    }
    for (const [file, revision] of this.#sourceFiles) {
      const current = revision.current();
      if (current.hash !== revision.hash) changed = true;
      this.#sourceFiles.set(file, current);
    }
    return changed;
  }

  async beforeProviderAttempt(context, commandId = context.commandId || this.commandId) {
    return this.#serialize(async () => {
      this.assertActive();
      if (this.dryRun) throw new Error("Documentation dry-run cannot start a provider");
      if (this.#attempts.has(context.attemptId)) return;
      this.#attempts.add(context.attemptId);
      const invocation = context.invocation;
      commandId = this.#stageByOccurrence.get(invocation?.occurrenceId) || commandId;
      this.#stageByAttempt.set(context.attemptId, commandId);
      const initialPlanned = invocation?.initialPlannedAttempt === true && context.attemptIndex === 0;
      if (!initialPlanned) this.plannedInputCharacters += context.inputCharacters;
      const changed = this.#scopeChanged();
      if (changed) this.#approved = false;
      await this.#authorize(commandId,
        this.#files.get(commandId)?.size || 0, context.inputCharacters, 1, changed);
    });
  }

  observe(record) { this.report.add(record, this.#stageByAttempt.get(record.attemptId) || this.#stageByOccurrence.get(record.invocation?.occurrenceId) || record.commandId); }
  observationFailed() { this.report.problem("provider-attempt-observation-failed"); }

  async finish(error = null) {
    if (this.#finished) return this.#finished;
    this.#finished = this.#finish(error);
    return this.#finished;
  }

  async #finish(error) {
    if (this.dryRun) {
      if (this.#unknownPhases.size > 0) this.output.write(`${this.t("docsAi.unknownPhases", { phases: [...this.#unknownPhases].join(", ") })}\n`);
      return null;
    }
    const stopped = this.#stopError || (error instanceof DocumentationAiExecutionStopped ? error : null);
    const status = stopped?.status || (error || this.#failed ? "failed" : this.#partial ? "partial-error" : "completed");
    const report = {
      version: 1, runId: this.runId, command: this.commandId,
      startedAt: this.startedAt, finishedAt: this.now().toISOString(), status,
      approvalMethod: this.#approvalMethod, plannedInputCharacters: this.plannedInputCharacters,
      plannedBatchCount: this.plannedBatchCount, unobservedExternalCommands: [...this.#externalCommands],
      ...this.report.toJSON(),
    };
    this.output.write(`${this.report.toText(this.t, status)}\n`);
    if (this.#externalCommands.size > 0) this.output.write(`${this.t("docsAi.externalUnobserved")}\n`);
    const reportPath = path.join(this.root, ".sennel", "output", "docs-ai-usage", `${this.runId}.json`);
    try {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      new AtomicJsonFile(reportPath).write(report);
      this.output.write(`${this.t("docsAi.reportPath", { path: reportPath })}\n`);
    } catch (failure) {
      this.output.write(`${this.t("docsAi.reportSaveFailed", { message: failure.message })}\n`);
    }
    return report;
  }
}

export function rethrowDocumentationAiStop(error, agentOrSession) {
  const session = agentOrSession?.session || agentOrSession?.aiSession || agentOrSession;
  if (session?.stopped) throw session.stopError;
  if (error instanceof DocumentationAiExecutionStopped) throw error;
}

export async function runDocumentationAiCommand(ctx, rawArgs, commandId, execute) {
  const inherited = ctx.aiSession || ctx.agent?.session;
  const session = inherited || new DocumentationAiExecutionSession({
    root: ctx.root, sourceRoot: ctx.srcRoot || ctx.root, config: ctx.config, commandId, args: rawArgs,
    yes: ctx.yes || rawArgs.includes("--yes"), dryRun: ctx.dryRun || rawArgs.includes("--dry-run"),
  });
  ctx.aiSession = session;
  ctx.agent = DocumentationAgent.from(ctx.agent || ctx.container.get("agent")).withSession(session).forCommand(commandId);
  if (inherited) { session.assertActive(); return execute(); }
  const onInterrupt = () => session.abort("SIGINT");
  const onTerminate = () => session.abort("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  let error = null;
  try {
    session.registerInputs(initialDocumentationInputs(ctx, commandId));
    const result = await execute();
    session.assertActive();
    if (result?.errors?.length) session.markPartialError();
    return result;
  } catch (caught) {
    error = session.stopError || caught;
    if (error instanceof DocumentationAiAborted) process.exitCode = error.exitCode;
    throw error;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    await session.finish(error);
  }
}
