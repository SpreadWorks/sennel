import { normalizeAgentMetricDimension } from "./agent-metrics.js";

function requireFlowManager(value) {
  if (
    !value
    || typeof value.resolveCurrentContext !== "function"
  ) {
    throw new Error("agent invocation metric requires a Flow manager");
  }
  return value;
}

function requireFlowMetricCapability(flowManager, method) {
  if (typeof flowManager[method] !== "function") {
    throw new Error(`agent invocation metric requires FlowManager.${method}()`);
  }
  return flowManager;
}

function requireDuration(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("agent invocation metric durationMs must be a non-negative safe integer");
  }
  return value;
}

function buildMetricEntry(phase, { usage, responseChars, model, durationMs, provider, profileKey }) {
  return {
    phase,
    kind: "agent",
    provider: normalizeAgentMetricDimension(provider),
    profileKey: normalizeAgentMetricDimension(profileKey),
    callCount: 1,
    responseChars: responseChars || 0,
    durationMs,
    ...(model && { model }),
    ...(usage && {
      tokens: {
        input: usage.input_tokens || 0,
        output: usage.output_tokens || 0,
        cacheRead: usage.cache_read_tokens || 0,
        cacheCreation: usage.cache_creation_tokens || 0,
      },
      ...(usage.cost_usd != null && { cost: usage.cost_usd }),
    }),
  };
}

function shouldPersistFinalizeMetricToSidecar(flowManager, context) {
  if (!context?.specId || !String(context.flowPhase || "").startsWith("finalize-")) return false;
  try {
    const state = flowManager.loadReadOnly(context.specId);
    return state?.worktree === true;
  } catch (_) {
    return false;
  }
}

async function persistFinalizeMetricToSidecar(flowManager, context, metric) {
  const { recordFinalizeCleanupPostCommandMetadata } = await import("../flow/lib/run-finalize-cleanup.js");
  recordFinalizeCleanupPostCommandMetadata({
    flowManager,
    specId: context.specId,
    metrics: [metric],
  });
}

class FlowAgentMetric {
  constructor({ flowManager, context }) {
    this.flowManager = requireFlowManager(flowManager);
    this.context = Object.freeze({ ...context });
  }

  async persist() {
    if (shouldPersistFinalizeMetricToSidecar(this.flowManager, this.context)) {
      await persistFinalizeMetricToSidecar(this.flowManager, this.context, this.entry);
      return;
    }
    this.persistToFlow();
  }
}

export class AgentInvocationMetric extends FlowAgentMetric {
  constructor({ flowManager, context, provider, profileKey, usage, responseChars, model, durationMs }) {
    super({ flowManager, context });
    requireFlowMetricCapability(flowManager, "accumulateAgentMetrics");
    this.phase = String(context.flowPhase);
    this.options = Object.freeze({
      provider,
      profileKey,
      usage,
      responseChars,
      model,
      durationMs: requireDuration(durationMs),
    });
    this.entry = Object.freeze(buildMetricEntry(this.phase, this.options));
    Object.freeze(this);
  }

  static capture({ flowManager, ...options }) {
    const manager = requireFlowManager(flowManager);
    const context = manager.resolveCurrentContext();
    if (!context?.flowPhase) return null;
    return new AgentInvocationMetric({ flowManager: manager, context, ...options });
  }

  bind(flowManager, context) {
    return new AgentInvocationMetric({ flowManager, context, ...this.options });
  }

  persistToFlow() {
    this.flowManager.accumulateAgentMetrics(this.phase, this.options);
  }
}

class PromptCacheHitMetric extends FlowAgentMetric {
  constructor({ flowManager, context, provider, profileKey, responseChars }) {
    super({ flowManager, context });
    requireFlowMetricCapability(flowManager, "appendMetric");
    this.options = Object.freeze({ provider, profileKey, responseChars });
    this.entry = Object.freeze({
      phase: String(context.flowPhase),
      kind: "agent-cache",
      provider: normalizeAgentMetricDimension(provider),
      profileKey: normalizeAgentMetricDimension(profileKey),
      callCount: 0,
      cachedResponse: true,
      responseChars,
    });
    Object.freeze(this);
  }

  static capture({ flowManager, context, ...options }) {
    const manager = requireFlowManager(flowManager);
    if (!context?.flowPhase) return null;
    return new PromptCacheHitMetric({ flowManager: manager, context, ...options });
  }

  bind(flowManager, context) {
    return new PromptCacheHitMetric({ flowManager, context, ...this.options });
  }

  persistToFlow() {
    this.flowManager.appendMetric(this.entry, {
      specId: this.context.specId,
      taskId: this.context.taskId ?? null,
    });
  }
}

export class DeferredAgentInvocationMetric {
  #metric = null;
  #captured = false;
  #flushed = false;
  #flowManager = null;
  #context = null;
  #startedAt = 0;

  constructor({ flowManager = null, startedAt = Date.now() } = {}) {
    this.#flowManager = flowManager == null ? null : requireFlowManager(flowManager);
    this.#context = this.#flowManager
      ? Object.freeze({ ...this.#flowManager.resolveCurrentContext() })
      : null;
    this.#startedAt = requireDuration(startedAt);
  }

  capture(metric) {
    if (!(metric instanceof FlowAgentMetric)) {
      throw new Error("deferred agent invocation metric requires a FlowAgentMetric");
    }
    if (this.#captured) throw new Error("agent invocation metric was already captured");
    if (this.#flushed) throw new Error("agent invocation metric was already flushed");
    this.#metric = this.#flowManager && this.#context?.flowPhase
      ? metric.bind(this.#flowManager, this.#context)
      : metric;
    this.#captured = true;
  }

  async flush() {
    if (this.#flushed) throw new Error("agent invocation metric was already flushed");
    this.#flushed = true;
    try {
      const metric = this.#metric ?? (this.#flowManager && this.#context?.flowPhase
        ? new AgentInvocationMetric({
            flowManager: this.#flowManager,
            context: this.#context,
            provider: null,
            profileKey: null,
            usage: null,
            responseChars: 0,
            model: null,
            durationMs: Math.max(0, Date.now() - this.#startedAt),
          })
        : null);
      if (!metric) return false;
      await metric.persist();
      return true;
    } catch (error) {
      process.stderr.write(`[sennel] agent: metric accumulation failed: ${error.message}\n`);
      return false;
    }
  }

  discard() {
    if (this.#flushed) throw new Error("agent invocation metric was already finalized");
    this.#flushed = true;
    this.#metric = null;
    return false;
  }
}

async function persistCapturedMetric({ capture, options, deferred, failureMessage }) {
  try {
    const metric = capture(options);
    if (!metric) return false;
    if (deferred != null) {
      if (!(deferred instanceof DeferredAgentInvocationMetric)) {
        throw new Error("agent deferred metric must be a DeferredAgentInvocationMetric");
      }
      deferred.capture(metric);
      return true;
    }
    await metric.persist();
    return true;
  } catch (error) {
    process.stderr.write(`[sennel] agent: ${failureMessage}: ${error.message}\n`);
    return false;
  }
}

export async function persistAgentInvocationMetric(options, deferred = null) {
  return persistCapturedMetric({
    capture: (input) => AgentInvocationMetric.capture(input),
    options,
    deferred,
    failureMessage: "metric accumulation failed",
  });
}

export async function persistPromptCacheHitMetric(options, deferred = null) {
  return persistCapturedMetric({
    capture: (input) => PromptCacheHitMetric.capture(input),
    options,
    deferred,
    failureMessage: "cache-hit metric failed",
  });
}
