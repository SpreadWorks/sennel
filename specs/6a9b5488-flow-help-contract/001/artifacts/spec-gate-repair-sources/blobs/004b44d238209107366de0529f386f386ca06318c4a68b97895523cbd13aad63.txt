/**
 * sennel/lib/log.js
 *
 * Unified JSONL logger for sennel.
 *
 * Container-managed service. Construct once via `initContainer` with a
 * pre-resolved log directory and dependencies; retrieve through
 * `container.get("logger")`. No singleton / getInstance().
 *
 * Two-tier output:
 *   - Daily JSONL `<logDir>/sennel-YYYY-MM-DD.jsonl` (lightweight metadata)
 *   - Per-request prompt JSON `<logDir>/prompts/YYYY-MM-DD/<requestId>.json`
 *
 * Three domains exposed on the instance:
 *   - logger.agent({ phase: "start"|"end", requestId, ... })
 *   - logger.git({ cmd, exitCode, stderr })
 *   - logger.event(name, fields)
 *
 * When `enabled` is false the methods are no-ops (no I/O, no throws). Flow
 * context (spec, flowPhase) for agent end events is looked up through the
 * FlowManager passed at construction; metric accumulation is NOT the
 * logger's responsibility (it lives in the agent call path).
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

import { maskSensitive } from "./log-masking.js";
import { FlowAttributionPolicy } from "./flow-attribution.js";
import { PRODUCT } from "./product.js";

/** Absolute path of this module file, used to exclude own frames in extractCaller. */
const SELF_FILE = new URL(import.meta.url).pathname;

// ─── Internal helpers ──────────────────────────────────────────────────────

/** YYYY-MM-DD in local time, computed at write time. */
function todayLocal() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Generate an 8-character lowercase hex requestId. */
export function generateRequestId() {
  return crypto.randomBytes(4).toString("hex");
}

/** Character / line counts for a string (used for prompt stats). */
function textStats(s) {
  if (s == null) return { chars: 0, lines: 0 };
  const str = String(s);
  return {
    chars: str.length,
    lines: str.length === 0 ? 0 : str.split("\n").length,
  };
}

/**
 * Extract the first stack frame outside of this module.
 * Uses absolute-path equality against SELF_FILE so frame filters do not
 * depend on suffix matching, URL prefixes, or OS separators.
 */
function extractCaller() {
  const err = new Error();
  const stack = err.stack || "";
  const lines = stack.split("\n").slice(1);
  for (const line of lines) {
    const m = line.match(/\(([^()]+):(\d+):(\d+)\)\s*$/) || line.match(/at\s+([^\s()]+):(\d+):(\d+)\s*$/);
    if (!m) continue;
    let file = m[1];
    if (file.startsWith("file://")) {
      try {
        file = new URL(file).pathname;
      } catch (err) {
        process.stderr.write(`[sennel] extractCaller: URL parse failed for ${file}: ${err.message}\n`);
      }
    }
    if (path.resolve(file) === path.resolve(SELF_FILE)) continue;
    return { callerFile: file, callerLine: Number(m[2]) };
  }
  return { callerFile: null, callerLine: null };
}

/** Append a JSON object as one line to the given file with masking. */
async function appendJsonlMasked(file, obj, trustedRoots) {
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const masked = maskSensitive(obj, { trustedRoots });
    await fs.promises.appendFile(file, JSON.stringify(masked) + "\n", "utf8");
  } catch (err) {
    process.stderr.write(`[sennel] log write failed: ${err.message}\n`);
  }
}

/** Write a self-contained prompt JSON file with masking. Returns absolute path or null. */
async function writePromptFileMasked(promptDir, requestId, payload, trustedRoots) {
  const file = path.join(promptDir, `${requestId}.json`);
  try {
    await fs.promises.mkdir(promptDir, { recursive: true });
    const masked = maskSensitive(payload, { trustedRoots });
    await fs.promises.writeFile(file, JSON.stringify(masked, null, 2) + "\n", "utf8");
    return file;
  } catch (err) {
    process.stderr.write(`[sennel] prompt file write failed: ${err.message}\n`);
    return null;
  }
}

// ─── Logger ────────────────────────────────────────────────────────────────

/**
 * Constructed once by `initContainer`. When `enabled=false` all log methods
 * are no-ops, so Container always creates an instance even when logs are
 * disabled or config is missing.
 */
export class Logger {
  #logDir;
  #enabled;
  #entryCommand;
  #flowManager;
  #flowAttribution;
  #cwd;
  #pending = new Set();

  /**
   * @param {Object} opts
   * @param {string} opts.logDir        - Absolute log directory (pre-resolved).
   * @param {boolean} opts.enabled      - Whether logging I/O is active.
   * @param {string|null} [opts.entryCommand]  - Argv string for metadata.
   * @param {Object|null} [opts.flowManager]   - FlowManager for end-event context.
   * @param {"ambient"|"none"} [opts.flowAttribution] - Whether logs inherit Flow context.
   * @param {string|null} [opts.cwd]    - Cwd for relative promptFile paths.
   */
  constructor({ logDir, enabled, entryCommand = null, flowManager = null, flowAttribution = "ambient", cwd = null }) {
    this.#logDir = logDir;
    this.#enabled = enabled === true;
    this.#entryCommand = entryCommand ?? null;
    this.#flowManager = flowManager ?? null;
    this.#flowAttribution = new FlowAttributionPolicy(flowAttribution);
    this.#cwd = cwd ?? null;
  }

  get enabled() {
    return this.#enabled;
  }

  runtimeDirectories() {
    return [this.#logDir];
  }

  /** Wait until all in-flight log writes settle. */
  async flush() {
    while (this.#pending.size > 0) {
      const snapshot = [...this.#pending];
      await Promise.allSettled(snapshot);
    }
  }

  #track(p) {
    this.#pending.add(p);
    p.finally(() => this.#pending.delete(p));
    return p;
  }

  #commonFields() {
    return {
      ts: new Date().toISOString(),
      entryCommand: this.#entryCommand,
      pid: process.pid,
    };
  }

  #logFiles() {
    return {
      jsonl: path.join(this.#logDir, `${PRODUCT.machineName}-${todayLocal()}.jsonl`),
      promptDir: path.join(this.#logDir, "prompts", todayLocal()),
    };
  }

  /**
   * Build the trusted-root list for masking. Logger's own log directory
   * and cwd are trusted so their own path values (promptFile, callerFile
   * inside the project tree) survive masking.
   */
  #trustedRoots() {
    return [this.#logDir, this.#cwd].filter(Boolean);
  }

  #appendJsonl(file, obj) {
    return appendJsonlMasked(file, obj, this.#trustedRoots());
  }

  #writePromptFile(promptDir, requestId, payload) {
    return writePromptFileMasked(promptDir, requestId, payload, this.#trustedRoots());
  }

  /**
   * Resolve flow context via the injected FlowManager. Guards against
   * re-entry: FlowManager.resolveCurrentContext() may trigger git calls that
   * loop back through Logger.git(), so we skip context resolution while
   * already resolving.
   */
  #resolvingContext = false;

  #flowContext(entry) {
    if (Object.hasOwn(entry || {}, "flowContext")) {
      const ctx = entry.flowContext;
      return {
        specId: ctx?.specId ?? null,
        flowPhase: ctx?.flowPhase ?? null,
        taskId: ctx?.taskId ?? null,
      };
    }
    if (!this.#flowAttribution.usesFlowState || !this.#flowManager || this.#resolvingContext) {
      return { specId: null, flowPhase: null, taskId: null };
    }
    this.#resolvingContext = true;
    try {
      const ctx = this.#flowManager.resolveCurrentContext();
      return { specId: ctx.specId ?? null, flowPhase: ctx.flowPhase ?? null, taskId: ctx.taskId ?? null };
    } catch (err) {
      process.stderr.write(`[sennel] Logger: flow state read failed: ${err.message}\n`);
      return { specId: null, flowPhase: null, taskId: null };
    } finally {
      this.#resolvingContext = false;
    }
  }

  /**
   * Record an agent invocation event.
   *
   * @param {Object} entry
   * @param {"start"|"end"} entry.phase
   * @param {string} entry.requestId
   * @param {string} [entry.agentKey]
   * @param {string} [entry.model]
   * @param {{system?: string, user?: string}} [entry.prompt]
   * @param {{text?: string, stdout?: string|null, stderr?: string|null, exitCode?: number, error?: string|null}} [entry.response]
   * @param {number} [entry.durationSec]
   * @param {Object} [entry.usage]
   * @param {{spec?: string|null, flowPhase?: string|null, taskId?: string|null}|null} [entry.flowContext]
   */
  agent(entry) {
    return this.#track(this.#agentImpl(entry));
  }

  async #agentImpl(entry) {
    if (!this.#enabled) return;
    if (!entry || (entry.phase !== "start" && entry.phase !== "end")) return;

    const { jsonl, promptDir } = this.#logFiles();
    const caller = extractCaller();

    if (entry.phase === "start") {
      const startCtx = this.#flowContext(entry);
      await this.#appendJsonl(jsonl, {
        ...this.#commonFields(),
        type: "agent",
        phase: "start",
        requestId: entry.requestId,
        specId: startCtx.specId,
        flowPhase: startCtx.flowPhase,
        taskId: startCtx.taskId,
        callerFile: caller.callerFile,
        callerLine: caller.callerLine,
      });
      return;
    }

    const ctx = this.#flowContext(entry);
    const promptObj = entry.prompt || {};
    const responseObj = entry.response || {};
    const systemStats = textStats(promptObj.system);
    const userStats = textStats(promptObj.user);
    const totalChars = systemStats.chars + userStats.chars;
    const totalLines = systemStats.lines + userStats.lines;
    const responseStats = textStats(responseObj.text);

    const promptPayload = {
      requestId: entry.requestId,
      ts: new Date().toISOString(),
      context: {
        entryCommand: this.#entryCommand,
        specId: ctx.specId,
        flowPhase: ctx.flowPhase,
        taskId: ctx.taskId,
        callerFile: caller.callerFile,
        callerLine: caller.callerLine,
      },
      agent: {
        key: entry.agentKey ?? null,
        model: entry.model ?? null,
      },
      prompt: {
        system: promptObj.system ?? null,
        user: promptObj.user ?? null,
        stats: {
          systemChars: systemStats.chars,
          userChars: userStats.chars,
          totalChars,
          totalLines,
        },
      },
      response: {
        text: responseObj.text ?? null,
        stdout: responseObj.stdout ?? null,
        stderr: responseObj.stderr ?? null,
        stats: {
          chars: responseStats.chars,
          lines: responseStats.lines,
        },
        exitCode: responseObj.exitCode ?? null,
        error: responseObj.error ?? null,
      },
      execution: {
        durationSec: entry.durationSec ?? null,
      },
      usage: entry.usage ?? null,
    };

    const promptFileAbs = await this.#writePromptFile(promptDir, entry.requestId, promptPayload);
    const promptFileRel = promptFileAbs && this.#cwd
      ? path.relative(this.#cwd, promptFileAbs).split(path.sep).join("/")
      : promptFileAbs;

    await this.#appendJsonl(jsonl, {
      ...this.#commonFields(),
      type: "agent",
      phase: "end",
      requestId: entry.requestId,
      specId: ctx.specId,
      flowPhase: ctx.flowPhase,
      taskId: ctx.taskId,
      callerFile: caller.callerFile,
      callerLine: caller.callerLine,
      agentKey: entry.agentKey ?? null,
      model: entry.model ?? null,
      promptChars: totalChars,
      systemChars: systemStats.chars,
      userChars: userStats.chars,
      promptLines: totalLines,
      responseChars: responseStats.chars,
      responseLines: responseStats.lines,
      durationSec: entry.durationSec ?? null,
      exitCode: responseObj.exitCode ?? null,
      promptFile: promptFileRel,
      ...(entry.usage != null && {
        cacheReadTokens: entry.usage.cache_read_tokens,
        cacheCreationTokens: entry.usage.cache_creation_tokens,
        inputTokens: entry.usage.input_tokens,
        outputTokens: entry.usage.output_tokens,
        costUsd: entry.usage.cost_usd,
      }),
    });
    return promptFileAbs;
  }

  /**
   * Record a git command execution.
   * @param {Object} entry
   * @param {string[]} entry.cmd
   * @param {number} entry.exitCode
   * @param {string} [entry.stderr]
   */
  git(entry) {
    return this.#track(this.#gitImpl(entry));
  }

  async #gitImpl(entry) {
    if (!this.#enabled) return;
    const { jsonl } = this.#logFiles();
    const caller = extractCaller();
    const ctx = this.#flowContext();
    await this.#appendJsonl(jsonl, {
      ...this.#commonFields(),
      type: "git",
      cmd: entry?.cmd ?? null,
      exitCode: entry?.exitCode ?? null,
      stderr: entry?.stderr ?? "",
      taskId: ctx.taskId,
      callerFile: caller.callerFile,
      callerLine: caller.callerLine,
    });
  }

  /**
   * Record an arbitrary named event with free-form fields.
   * @param {string} name
   * @param {Object} [fields]
   */
  event(name, fields = {}) {
    return this.#track(this.#eventImpl(name, fields));
  }

  async #eventImpl(name, fields = {}) {
    if (!this.#enabled) return;
    const { jsonl } = this.#logFiles();
    const caller = extractCaller();
    const ctx = this.#flowContext();
    await this.#appendJsonl(jsonl, {
      ...this.#commonFields(),
      type: "event",
      name,
      ...fields,
      taskId: ctx.taskId,
      callerFile: caller.callerFile,
      callerLine: caller.callerLine,
    });
  }
}
