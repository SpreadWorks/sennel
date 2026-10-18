import path from "node:path";
import { SourceStructureChecker, SourceStructureScope } from "./source-structure-checker.js";
import { SourceGraph } from "./source-graph.js";
import { readClassMember, readTokens, SourceToken, sourceContainsSequence } from "./source-reader.js";
import { OsIndependenceDiagnostic } from "./os-independence-checker.js";
import { classifyExecutable, OsSpecificExecutable, UnclassifiedExecutable } from "./os-command-policy.js";

/** An executable slot retains its producer and consumer-facing representation. */
export class InstructionProjection {
  constructor(file, text, token, representation, route = [file]) {
    if (typeof file !== "string" || typeof text !== "string" || !(token instanceof SourceToken)
      || !["shell-fence", "inline-command", "json-command", "json-invocation"].includes(representation)) throw new TypeError("invalid instruction projection");
    Object.assign(this, { file, text, token, representation, route });
    if (new.target === InstructionProjection) Object.freeze(this);
  }
}

/** Preserve argv as data; displaying it never grants shell parsing authority. */
export class InstructionInvocation extends InstructionProjection {
  constructor(file, executable, args, shell, token, route, executionBoundary = "native") {
    if (typeof executable !== "string" || !executable || executable.includes("\0")
      || !Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
      || typeof shell !== "boolean" || !["native", "registered-flow"].includes(executionBoundary)) throw new TypeError("instruction invocation requires a literal executable and string argv");
    super(file, [executable, ...args].join(" "), token, "json-invocation", route);
    this.executable = executable;
    this.args = Object.freeze([...args]);
    this.shell = shell;
    this.executionBoundary = executionBoundary;
    Object.freeze(this);
  }
}

export class InstructionAuditReport {
  constructor() {
    this.diagnostics = [];
    this.projections = [];
    this.coverage = {
      resources: [], projections: 0, includes: [], boundaries: [],
      contract: "Executable Markdown fences, positive inline command instructions, JSON command strings and literal executable/argv invocation objects, owned snapshot transport, and typed command serialization/readback/dispatch. Inline JavaScript and unknown executable invocation shapes remain incomplete. Arbitrary prose semantics and external plugin/user command internals are outside this static contract.",
    };
  }
  get ok() { return this.diagnostics.length === 0; }
  get complete() { return !this.diagnostics.some((entry) => entry.classification === "incomplete"); }
}

class ShellWord {
  constructor(value, expandable) {
    if (typeof value !== "string" || typeof expandable !== "boolean") throw new TypeError("shell word required");
    this.value = value;
    this.expandable = expandable;
    Object.freeze(this);
  }
}

/** Detect shell syntax and expose simple words from the same quote/escape walk. */
class ShellCompoundSyntax {
  constructor(command) {
    if (typeof command !== "string" || command.includes("\0")) throw new TypeError("shell command text required");
    this.words = [];
    this.operator = this.scan(command);
    Object.freeze(this.words);
    Object.freeze(this);
  }

  scan(command) {
    let quote = null;
    let wordStart = true;
    let word = "";
    let expandable = false;
    let active = false;
    const finishWord = () => {
      if (active) this.words.push(new ShellWord(word, expandable));
      word = "";
      expandable = false;
      active = false;
    };
    for (let index = 0; index < command.length; index++) {
      const character = command[index];
      if (character === "\\" && quote !== "'") {
        if (index + 1 === command.length) return "trailing escape";
        const next = command[index + 1];
        if (quote === '"' && !["$", "`", '"', "\\", "\n"].includes(next)) {
          word += character;
          active = true;
          wordStart = false;
          continue;
        }
        const escaped = command[++index];
        if (escaped !== "\n") {
          word += escaped;
          active = true;
          wordStart = false;
        }
        continue;
      }
      if (quote) {
        if (quote !== "'" && (character === "`" || character === "$" && command[index + 1] === "(")) return character === "`" ? "`" : "$(";
        if (quote !== "'" && character === "$") expandable = true;
        if (character === quote) quote = null;
        else word += character;
        continue;
      }
      if (character === "`" || character === "$" && command[index + 1] === "(") return character === "`" ? "`" : "$(";
      if ((character === "<" || character === ">") && command[index + 1] === "(") return `${character}(`;
      if (character === "'" || character === '"') { quote = character; active = true; wordStart = false; continue; }
      if (character === "\n") return "newline";
      if (character === "#" && wordStart) {
        finishWord();
        return command.includes("\n", index) ? "newline" : null;
      }
      if (/\s/.test(character)) { finishWord(); wordStart = true; continue; }
      if (character === ";" || character === "|" || character === "&") return character;
      if (character === "$") expandable = true;
      word += character;
      active = true;
      wordStart = false;
    }
    if (quote) return "unterminated quote";
    finishWord();
    return null;
  }

  get compound() { return this.operator !== null; }
}

const nodeInlineOptions = new Set(["-e", "-p", "-pe", "-ep", "--eval", "--print"]);
const nodeLoaderOptions = new Set(["-r", "--require", "--import"]);
const nodeNoOperandOptions = new Set(["-v", "--version", "-h", "--help", "-c", "--check", "-i", "--interactive", "--watch", "--test"]);

function nodeEvalCandidate(args) {
  for (let index = 0; index < args.length; index++) {
    const value = args[index] instanceof ShellWord ? args[index].value : args[index];
    if (value === "--") return false;
    if (nodeInlineOptions.has(value) || /^--(?:eval|print)=/.test(value)) return true;
  }
  return false;
}

/** The Node CLI authority ends at its first script operand or explicit `--`. */
class NodeExecutionBoundary {
  constructor(status, option = null) {
    if (!["script", "inline", "incomplete"].includes(status)) throw new TypeError("Node execution boundary status required");
    this.status = status;
    this.option = option;
    Object.freeze(this);
  }

  static inspect(executable, args) {
    const name = executable.replaceAll("\\", "/").split("/").at(-1).toLowerCase();
    if (name !== "node" && name !== "node.exe") return null;
    for (let index = 0; index < args.length; index++) {
      const argument = args[index] instanceof ShellWord ? args[index] : new ShellWord(args[index], false);
      const value = argument.value;
      if (argument.expandable) return new NodeExecutionBoundary("incomplete", value);
      if (value === "--") return new NodeExecutionBoundary("script");
      if (nodeInlineOptions.has(value) || /^--(?:eval|print)=/.test(value)) {
        return new NodeExecutionBoundary("inline", value);
      }
      if (nodeLoaderOptions.has(value)) {
        if (index + 1 >= args.length) return new NodeExecutionBoundary("incomplete", value);
        const operand = args[++index] instanceof ShellWord ? args[index] : new ShellWord(args[index], false);
        if (operand.expandable) return new NodeExecutionBoundary("incomplete", value);
        continue;
      }
      if (["--require", "--import"].some((option) => value.startsWith(`${option}=`))) continue;
      if (nodeNoOperandOptions.has(value)) continue;
      if (/^-[ep].+/.test(value)) continue;
      if (value.startsWith("-")) return nodeEvalCandidate(args.slice(index + 1))
        ? new NodeExecutionBoundary("incomplete", value) : new NodeExecutionBoundary("script");
      return new NodeExecutionBoundary("script");
    }
    return new NodeExecutionBoundary("script");
  }
}

function location(text, offset, value = "instruction") {
  const lines = text.slice(0, offset).split("\n");
  return new SourceToken(value, "string", offset, lines.length, lines.at(-1).length + 1);
}

function publicResource(file) {
  // Select producer directories, rather than interpreting inert fixtures or
  // every distributed Markdown paragraph as an execution instruction.
  return /\.(?:md|json|txt)$/.test(file) && (
    /^src\/(?:skills|templates)\//.test(file)
    || /^src\/flow\/prompts\//.test(file)
    || /^src\/presets\/[^/]+\/(?:templates\/|[^/]+\.(?:md|json)$)/.test(file)
    || /^src\/locale\/[^/]+\/prompts\.json$/.test(file)
  );
}

function diagnose(report, rule, file, token, trace, message, classification = "violation") {
  report.diagnostics.push(new OsIndependenceDiagnostic(rule, file, token, trace, message, classification));
}

function markdownProjections(file, text, report, origin = text, baseOffset = 0, route = [file]) {
  const lines = text.split("\n");
  let offset = baseOffset;
  let fence = null;
  for (const line of lines) {
    const opening = /^\s*(`{3,}|~{3,})([\w-]*)\s*$/.exec(line);
    if (opening) {
      if (fence && opening[1][0] === fence.marker[0] && opening[1].length >= fence.marker.length) fence = null;
      else if (!fence) fence = { marker: opening[1], executable: /^(?:sh|shell|bash|console|powershell|ps1|cmd|bat)$/.test(opening[2]) };
      offset += line.length + 1;
      continue;
    }
    if (fence?.executable && line.trim() && !/^\s*#/.test(line)) {
      report.projections.push(new InstructionProjection(file, line.trim().replace(/^\$ /, ""), location(origin, offset), "shell-fence", route));
    } else if (!fence && !/\b(?:never|must not|do not|don't|forbid(?:den)?)\b|禁止|してはなら|実行しない/i.test(line)) {
      for (const match of line.matchAll(/`([^`\n]+)`/g)) {
        const prefix = line.slice(0, match.index);
        if (/\b(?:run|execute|invoke)\s*(?:(?:the|this|following|command)\s+)*[:：]?\s*$|(?:実行|呼び出)\s*[:：]?\s*$/i.test(prefix)
          || /^(?:sennel|node|npm|npx|pnpm|bash|sh|powershell|pwsh|cmd|kill|pkill|ps|chmod|mktemp)\s/.test(match[1])) {
          report.projections.push(new InstructionProjection(file, match[1], location(origin, offset + match.index + 1), "inline-command", route));
        }
      }
    }
    offset += line.length + 1;
  }
  if (fence?.executable) diagnose(report, "OS00", file, location(origin, offset), route, "unterminated executable instruction fence", "incomplete");
}

function jsonProjections(file, text, report) {
  let parsed;
  let values;
  try {
    parsed = JSON.parse(text);
    const tokens = readTokens(text, file);
    values = tokens.filter((token, index) => token.kind === "string" && tokens[index + 1]?.value !== ":");
  }
  catch (error) { diagnose(report, "OS00", file, null, [file], `instruction JSON cannot be read: ${error.message}`, "incomplete"); return; }
  const used = new Set();
  const sourceToken = (value, key = "command") => {
    const token = values.find((entry) => entry.value === value && !used.has(entry.offset));
    if (token) used.add(token.offset);
    return token || location(text, Math.max(0, text.indexOf(JSON.stringify(key))));
  };
  const invocation = (value, keys) => {
    const executableKeys = ["executable", "program", "command"].filter((key) => Object.hasOwn(value, key));
    const typedFlow = Object.hasOwn(value, "group") && Object.hasOwn(value, "subcommand");
    const structured = typedFlow || Object.hasOwn(value, "executable") || Object.hasOwn(value, "program")
      || Object.hasOwn(value, "command") && (Object.hasOwn(value, "args") || Object.hasOwn(value, "argv") || Object.hasOwn(value, "shell") || Object.hasOwn(value, "options"));
    if (!structured) {
      if (["command", "invocation"].includes(keys.at(-1))) {
        diagnose(report, "OS04", file, sourceToken(undefined, keys.at(-1)), [file, keys.join(".")], "structured executable instruction has an unknown invocation shape", "incomplete");
      }
      return null;
    }
    const route = [file, keys.join(".") || "invocation"];
    const executable = typedFlow ? "sennel" : value[executableKeys[0]];
    const token = sourceToken(typedFlow ? value.group : executable, executableKeys[0]);
    const args = value.args ?? value.argv ?? [];
    const shell = value.shell ?? value.options?.shell ?? false;
    const handled = new Set(["executable", "program", "command", "args", "argv", "shell", "group", "subcommand"]);
    const malformed = (!typedFlow && executableKeys.length !== 1) || typeof executable !== "string"
      || !executable || executable.includes("\0") || /\$\{|\{\{|^<[^>]+>$/.test(executable) || !Array.isArray(args)
      || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
      || Object.hasOwn(value, "args") && Object.hasOwn(value, "argv")
      || typedFlow && (!["run", "set"].includes(value.group) || typeof value.subcommand !== "string" || !value.subcommand || /[\s\0]/.test(value.subcommand));
    if (shell === true || typeof shell === "string") diagnose(report, "OS02", file, token, route, "public structured execution instruction enables a shell");
    else if (typeof shell !== "boolean") diagnose(report, "OS04", file, token, route, "structured execution shell option cannot be proven", "incomplete");
    if (malformed) diagnose(report, "OS04", file, token, route, "structured executable instruction requires one literal executable and string argv", "incomplete");
    else {
      for (const arg of args) sourceToken(arg, "args");
      if (typedFlow) sourceToken(value.subcommand, "subcommand");
      report.projections.push(new InstructionInvocation(file, executable,
        typedFlow ? ["flow", value.group, value.subcommand, ...args] : args,
        shell === true || typeof shell === "string", token, route, typedFlow ? "registered-flow" : "native"));
      report.coverage.boundaries.push({ producer: file, projection: route.at(-1), consumer: "literal executable and argv", inspected: true });
    }
    return handled;
  };
  const visit = (value, keys) => {
    if (Array.isArray(value)) { value.forEach((entry, index) => visit(entry, [...keys, String(index)])); return; }
    if (value && typeof value === "object") {
      const handled = invocation(value, keys);
      for (const [key, entry] of Object.entries(value)) if (!handled?.has(key)) visit(entry, [...keys, key]);
      return;
    }
    if (typeof value !== "string") return;
    const key = keys.at(-1);
    const token = values.find((entry) => entry.value === value && !used.has(entry.offset));
    if (!token) {
      diagnose(report, "OS00", file, null, [file, keys.join(".")], "instruction JSON value has no source projection", "incomplete");
      return;
    }
    used.add(token.offset);
    const route = [file, keys.join(".")];
    if (["command", "executable", "script"].includes(key)) report.projections.push(new InstructionProjection(file, value, token, "json-command", route));
    else if (["body", "instruction", "instructions", "prompt", "text"].includes(key) || /\/prompts\.json$/.test(file)) {
      const start = report.projections.length;
      markdownProjections(file, value, report, value, 0, route);
      // Escaped newlines belong to the rendered value. Diagnostics point back
      // to its JSON source token, rather than inventing physical source lines.
      for (let index = start; index < report.projections.length; index++) {
        const entry = report.projections[index];
        report.projections[index] = new InstructionProjection(file, entry.text, token, entry.representation, route);
      }
    }
  };
  visit(parsed, []);
}

function inspectSyntax(projection, report) {
  const { text, file, token, route } = projection;
  const command = text.replace(/^\s*(?:[A-Za-z_]\w*=\S+\s+)*/, "");
  const shellAuthority = !(projection instanceof InstructionInvocation) || projection.shell;
  const syntax = shellAuthority ? new ShellCompoundSyntax(command) : null;
  if (syntax?.compound) {
    const rule = ["$(", "`", "<(", ">("].includes(syntax.operator) ? "OS04" : "OS02";
    diagnose(report, rule, file, token, route, `public shell instruction contains uninspected compound syntax (${syntax.operator})`, "incomplete");
  }
  const executable = projection instanceof InstructionInvocation ? projection.executable : /^\S+/.exec(command)?.[0];
  const shellSyntax = /^(?:set\s+-[a-z]*[euo]|[A-Za-z_]\w*=\S+\s)/.test(text);
  if (shellSyntax) diagnose(report, "OS02", file, token, route, "public executable instruction requires shell-specific grammar");
  else if (executable) {
    const representation = projection instanceof InstructionInvocation && projection.executionBoundary === "native" && !projection.shell ? "native" : "instruction";
    const classification = classifyExecutable(executable, { representation });
    if (classification instanceof OsSpecificExecutable) diagnose(report, "OS02", file, token, route, "public executable instruction requires an OS-specific command or shell");
    else if (classification instanceof UnclassifiedExecutable) diagnose(report, "OS02", file, token, route, "public executable instruction has no classified portable executable identity", "incomplete");
  }
  const nodeBoundary = projection instanceof InstructionInvocation
    ? projection.shell ? null : NodeExecutionBoundary.inspect(projection.executable, projection.args)
    : syntax?.compound || shellSyntax ? null : NodeExecutionBoundary.inspect(syntax?.words[0]?.value || "", syntax?.words.slice(1) || []);
  if (nodeBoundary?.status === "inline") {
    // Do not grep executable JavaScript strings for effects. The module
    // checker has no module boundary for these inline programs, so fail closed.
    diagnose(report, "OS04", file, token, route, "inline JavaScript execution has no inspected module boundary", "incomplete");
    return;
  }
  if (nodeBoundary?.status === "incomplete") {
    diagnose(report, "OS04", file, token, route, `Node option boundary cannot be proven before the script entry (${nodeBoundary.option})`, "incomplete");
    return;
  }
  if (/(?:^|[\s'"=])\/(?:proc|sys|dev\/shm)(?:\/|\b)|\b(?:TMPDIR|XDG_RUNTIME_DIR)=\/|\b(?:kill|process\.kill)\s*\(?\s*-/.test(command)) {
    diagnose(report, "OS01", file, token, route, "public executable instruction requires a pseudo-filesystem or process-group operation");
  }
  if (!(projection instanceof InstructionInvocation) || projection.shell) {
    if (/^(?:eval|Invoke-Expression)\b/.test(command)) diagnose(report, "OS04", file, token, route, "public executable instruction reparses executable shell text");
  }
}

function inspectIncludes(file, text, scope, report) {
  for (const match of text.matchAll(/<!--\s*include\("([^"]+)"\)\s*-->/g)) {
    const value = match[1];
    const malformedPreset = value.startsWith("@presets/") && !/^@presets\/[^/]+\/.+/.test(value);
    const relative = value.startsWith("@skills/") ? `src/skills/${value.slice(8)}`
      : value.startsWith("@presets/") ? `src/presets/${value.slice(9)}`
        : value.startsWith("/") ? `src/${value.slice(1)}` : path.posix.join(path.posix.dirname(file), value);
    const target = path.posix.normalize(relative);
    const edge = { producer: file, projection: "include", consumer: target };
    report.coverage.includes.push(edge);
    if (malformedPreset) diagnose(report, "OS00", file, location(text, match.index), [file, target], "preset instruction include requires a registered preset key and child path", "incomplete");
    else if (!target.startsWith("src/") || value.includes("../")) diagnose(report, "OS00", file, location(text, match.index), [file, target], "instruction include escapes the owned source boundary", "incomplete");
    else if (!scope.resources.includes(target)) diagnose(report, "OS00", file, location(text, match.index), [file, target], "instruction include has no inspected owned producer or declared external contribution", "incomplete");
  }
}

function requireMember(graph, report, file, className, memberName, sequences, options = {}) {
  try {
    const member = readClassMember(graph.module(file), className, memberName, options);
    const missing = !member || sequences.some((sequence) => !member.containsBodySequence(sequence));
    report.coverage.boundaries.push({ file, className, memberName, inspected: !missing });
    if (missing) diagnose(report, "OS04", file, member?.token, [file, `${className}.${memberName}`], "structured instruction/snapshot boundary has an unproven producer-to-consumer connection", "incomplete");
  } catch (error) { diagnose(report, "OS00", file, error, [file], `boundary cannot be inspected: ${error.message}`, "incomplete"); }
}

/** Static producer/projection/readback contracts; never imports target modules. */
export function inspectInstructions(scope, graph = new SourceGraph(scope.repository)) {
  const report = new InstructionAuditReport();
  for (const file of scope.resources.filter(publicResource)) {
    report.coverage.resources.push(file);
    try {
      const text = scope.repository.read(file);
      if (file.endsWith(".json")) jsonProjections(file, text, report);
      else { markdownProjections(file, text, report); inspectIncludes(file, text, scope, report); }
    } catch (error) { diagnose(report, "OS00", file, error, [file], `instruction producer unreadable: ${error.message}`, "incomplete"); }
  }
  for (const projection of report.projections) inspectSyntax(projection, report);
  report.coverage.projections = report.projections.length;
  const commandFile = "src/flow/lib/flow-execution-command.js";
  if (scope.files.includes(commandFile)) {
    try {
      // The established recovery checker owns aliases, helpers, registry
      // selection and typed dispatch. Reuse that judgment rather than adding
      // a parallel origin resolver for instruction producers.
      const checker = new SourceStructureChecker(new SourceStructureScope(scope.repository.root || ".", "src/flow", []), scope.repository);
      const result = checker.checkRecoveryCommands();
      for (const entry of result.diagnostics) {
        diagnose(report, "OS04", entry.file, entry, entry.trace, entry.message, "incomplete");
      }
      report.coverage.boundaries.push({ producer: "FlowExecutionCommand", projection: "ExecuteCommandDirective", consumer: "RunDispatchCommand.runRegisteredFlowCommand", inspected: result.ok });
    } catch (error) { diagnose(report, "OS00", commandFile, error, [commandFile], `structured command path cannot be inspected: ${error.message}`, "incomplete"); }
    requireMember(graph, report, commandFile, "FlowExecutionCommand", "toJSON", ["group: this.group", "subcommand: this.subcommand", "args: [...this.args]"]);
    requireMember(graph, report, commandFile, "FlowExecutionCommand", "fromStored", ["return new FlowExecutionCommand(value)"], { static: true });
    const directive = "src/flow/lib/next-action-directive.js";
    requireMember(graph, report, directive, "ExecuteCommandDirective", "toJSON", ["command: this.command.toJSON()"]);
    requireMember(graph, report, directive, "ExecuteCommandDirective", "fromStored", ["FlowExecutionCommand.fromStored(value?.command)", "return new ExecuteCommandDirective({ ...value, command })"], { static: true });
  }
  const snapshotFile = "src/lib/runtime-package-snapshot.js";
  if (scope.files.includes(snapshotFile)) {
    requireMember(graph, report, snapshotFile, "RuntimePackageSnapshot", "constructor", [
      "delivery.resources.map", "Buffer.from(encoded, \"base64\")", "new RuntimePackageIdentity",
      "expected.revision !== this.identity.revision", 'visit("src")',
    ]);
    requireMember(graph, report, snapshotFile, "RuntimePackageSnapshot", "resourcePayload", ["[...this.#files]", "snapshot.bytes.toString(\"base64\")"]);
    requireMember(graph, report, snapshotFile, "RuntimePackageSnapshot", "fromDelivery", ["return new RuntimePackageSnapshot(delivery.root, delivery)"], { static: true });
    requireMember(graph, report, snapshotFile, "RuntimePackageSnapshot", "read", ["this.#files.get(key)", "return snapshot"]);
    // Loader and resource-reader files themselves remain in the full source
    // graph. These lexical edges bind the saved representation to consumption.
    for (const [file, sequences] of [
      ["src/lib/runtime-loader.js", ["snapshot.read(fileURLToPath(url)).bytes", "resources: snapshot.resourcePayload()"]],
      ["src/lib/runtime-package.js", ["new Map(proof?.resources || [])", "resources.get(key)", "Buffer.from(encoded, \"base64\")"]],
      ["src/lib/runtime-bootstrap-loader.js", ["new Map(delivery.resources)", "Buffer.from(resources.get(name), \"base64\")"]],
    ]) {
      try {
        const module = graph.module(file);
        const inspected = sequences.every((sequence) => sourceContainsSequence(module.tokens, sequence));
        report.coverage.boundaries.push({ producer: snapshotFile, projection: "key/base64 resources", consumer: file, inspected });
        if (!inspected) diagnose(report, "OS04", file, null, [snapshotFile, file], "fixed snapshot bytes are not proven to reach the owned loader/resource consumer", "incomplete");
      } catch (error) { diagnose(report, "OS00", file, error, [snapshotFile, file], `snapshot consumer cannot be inspected: ${error.message}`, "incomplete"); }
    }
  }
  return report;
}
