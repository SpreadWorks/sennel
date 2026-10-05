import childProcess from "node:child_process";
import { loadConfig } from "./config.js";
import { repoRoot } from "./cli.js";

export const HOOK_TIMEOUT_MS = 600000;

export const HOOKS = Object.freeze([
  Object.freeze({
    name: "PostWorktree",
    description: "Runs immediately after a flow worktree is created.",
    placeholders: Object.freeze(["CWD"]),
  }),
]);

function hookDefinition(hookName) {
  return HOOKS.find((hook) => hook.name === hookName) || null;
}

function hookConfigFor(context = {}) {
  const root = context.CWD || repoRoot();
  return loadConfig(root).flow?.hooks || {};
}

function warn(message) {
  console.warn(`[sennel] ${message}`);
}

export function replaceHookPlaceholders(command, context = {}) {
  const missing = new Set();
  const rendered = String(command).replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (token, key) => {
    if (Object.prototype.hasOwnProperty.call(context, key)) return String(context[key]);
    missing.add(key);
    return token;
  });
  return { command: rendered, missing: [...missing] };
}

function successfulNoop() {
  return { ok: true, output: "", stderr: "", status: 0 };
}

function normalizeOutput(value) {
  if (value == null) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

export async function onHook(hookName, context = {}) {
  const definition = hookDefinition(hookName);
  if (!definition) return successfulNoop();

  const hooks = hookConfigFor(context);
  const rawCommand = hooks[hookName];
  if (rawCommand == null || rawCommand === "") return successfulNoop();

  const { command, missing } = replaceHookPlaceholders(rawCommand, context);
  if (missing.length > 0) {
    warn(`hook ${hookName} has unresolved placeholder(s): ${missing.map((key) => `{{${key}}}`).join(", ")}`);
  }

  const result = childProcess.spawnSync(command, [], {
    cwd: context.CWD,
    shell: true,
    timeout: HOOK_TIMEOUT_MS,
    encoding: "utf8",
  });
  const status = result.status == null ? 1 : result.status;
  const envelope = {
    ok: !result.error && status === 0,
    output: normalizeOutput(result.stdout),
    stderr: normalizeOutput(result.stderr || result.error?.message),
    status,
  };
  if (!envelope.ok) warn(`hook ${hookName} failed with status ${envelope.status}: ${envelope.stderr}`.trim());
  return envelope;
}

export function listHooks(config = {}) {
  const configured = config.flow?.hooks || {};
  return HOOKS.map((hook) => ({
    name: hook.name,
    description: hook.description,
    placeholders: [...hook.placeholders],
    command: configured[hook.name] || "",
  }));
}
