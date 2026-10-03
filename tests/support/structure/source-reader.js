/** A deliberately small, fail-closed lexical reader for the JavaScript forms used by Flow. */
export class SourceReadError extends Error {
  constructor(file, offset, message, source = "") {
    super(`${file}:${offset}: ${message}`);
    this.file = file;
    this.offset = offset;
    const before = source.slice(0, offset).split("\n");
    this.line = before.length;
    this.column = before.at(-1).length + 1;
  }
}

export class SourceToken {
  constructor(value, kind, offset, line, column) {
    this.value = value;
    this.kind = kind;
    this.offset = offset;
    this.line = line;
    this.column = column;
  }
}

export class SourceReference {
  constructor(specifier, token, kind, bindings = new Map()) {
    this.specifier = specifier;
    this.token = token;
    this.kind = kind;
    this.bindings = bindings;
  }
}

export class SourceClass {
  constructor(name, parent, parentToken, token, dependencies, argumentTypes, exported) {
    this.name = name;
    this.parent = parent;
    this.parentToken = parentToken;
    this.token = token;
    this.dependencies = dependencies;
    this.argumentTypes = argumentTypes;
    this.exported = exported;
  }
}

export class SourceExport {
  constructor(name, local, reference = null, token = null) {
    this.name = name;
    this.local = local;
    this.reference = reference;
    this.token = token;
  }
}

export class SourceInvocation {
  constructor(name, token, arguments_, endToken = token, constructed = false) {
    if (!name || !(token instanceof SourceToken) || !Array.isArray(arguments_)
      || !(endToken instanceof SourceToken) || typeof constructed !== "boolean") throw new TypeError("invalid source invocation");
    this.name = name;
    this.token = token;
    this.arguments = arguments_;
    this.endToken = endToken;
    this.constructed = constructed;
  }
  identifiers() {
    return new Set(this.arguments.flat().filter((token) => token.kind === "identifier").map((token) => token.value));
  }
  literals() {
    return new Set(this.arguments.flat().filter((token) => token.kind === "string").map((token) => token.value));
  }
}

/** A module binding's identity without interpreting its initializer or body. */
export class SourceDeclarationHeader {
  constructor(name, token, prefix = []) {
    if (typeof name !== "string" || !name || !(token instanceof SourceToken)
      || token.kind !== "identifier" || !["class", "function", "const", "let", "var"].includes(token.value)
      || !Array.isArray(prefix) || prefix.some((entry) => !(entry instanceof SourceToken))) {
      throw new TypeError("invalid source declaration header");
    }
    this.name = name;
    this.token = token;
    this.prefix = prefix;
  }
}

export class SourceDeclaration {
  constructor(name, tokens, prefix = []) {
    if (!name || !Array.isArray(tokens) || tokens.length === 0) throw new TypeError("invalid source declaration");
    this.name = name;
    this.tokens = tokens;
    this.token = tokens[0];
    this.prefix = prefix;
  }
  get exported() { return this.prefix.some((token) => token.value === "export"); }
  get defaultExport() { return this.exported && this.prefix.some((token) => token.value === "default"); }
  uses(name) { return this.tokens.some((token) => token.kind === "identifier" && token.value === name); }
  matchesDeclaration(source) { return sameTokens(this.tokens, readTokens(source)); }
  matchesFunction(parameters, body) {
    return !this.prefix.some((token) => token.value === "async")
      && this.matchesDeclaration(`function ${this.name}(${parameters}) { ${body} }`);
  }
  get callable() {
    if (["function", "class"].includes(this.tokens[0].value)) return true;
    if (!["const", "let"].includes(this.tokens[0].value) || this.tokens[2]?.value !== "=") return false;
    const initializer = unwrapCondition(this.tokens.slice(3, -1));
    return initializer[0]?.value === "class" || isDeferredCallable(initializer);
  }
  referenceInitializer() {
    if (!["const", "let"].includes(this.tokens[0].value) || this.tokens[2]?.value !== "=") return null;
    const initializer = unwrapCondition(this.tokens.slice(3, -1));
    return initializer.length === 1 && initializer[0].kind === "identifier" ? initializer[0].value : null;
  }
  bodyTokens() {
    const open = this.tokens.findIndex((token) => token.value === "(");
    if (open < 0) return null;
    const close = matching(this.tokens, open, "(", ")");
    return this.tokens[close + 1]?.value === "{" ? this.tokens.slice(close + 2, -1) : null;
  }
  topLevelInitializer(name) {
    const body = this.bodyTokens();
    if (body === null) return null;
    let depth = 0;
    let found = null;
    for (let index = 0; index < body.length - 2; index++) {
      if (body[index].value === "{") depth++;
      if (body[index].value === "}") depth--;
      if (depth !== 0 || !["const", "let"].includes(body[index].value)
        || body[index + 1]?.value !== name || body[index + 2]?.value !== "=") continue;
      if (found !== null) return null;
      const start = index + 3;
      let nested = 0;
      let end = start;
      for (; end < body.length; end++) {
        if (["(", "[", "{"].includes(body[end].value)) nested++;
        if ([")", "]", "}"].includes(body[end].value)) nested--;
        if (nested === 0 && body[end].value === ";") break;
      }
      if (end === body.length) return null;
      found = new SourceInitializer(body[index], index, body.slice(start, end));
    }
    return found;
  }
  matchesBody(source) { return sameTokens(this.bodyTokens(), readTokens(source)); }
  bodyStartsWith(source) {
    const body = this.bodyTokens();
    const expected = readTokens(source);
    return body !== null && sameTokens(body.slice(0, expected.length), expected);
  }
  bodyEndsWith(source) {
    const body = this.bodyTokens();
    const expected = readTokens(source);
    return body !== null && sameTokens(body.slice(-expected.length), expected);
  }
  containsBodySequence(source) {
    const body = this.bodyTokens();
    const expected = readTokens(source);
    return body !== null && body.some((_, index) => sameTokens(body.slice(index, index + expected.length), expected));
  }
  returns() {
    const body = this.bodyTokens();
    if (body === null) return [];
    const result = [];
    for (let index = 0; index < body.length; index++) {
      if (body[index].value !== "return") continue;
      let depth = 0;
      let end = index + 1;
      for (; end < body.length; end++) {
        if (["(", "[", "{"].includes(body[end].value)) depth++;
        if ([")", "]", "}"].includes(body[end].value)) depth--;
        if (depth === 0 && body[end].value === ";") break;
      }
      if (end === body.length) return [];
      result.push(new SourceReturn(body[index], index, body.slice(index + 1, end)));
      index = end;
    }
    return result;
  }
}

export class SourceInitializer {
  constructor(token, index, tokens) {
    if (!token || !Number.isInteger(index) || !Array.isArray(tokens)) throw new TypeError("invalid source initializer");
    this.token = token;
    this.index = index;
    this.tokens = tokens;
  }
  matches(source) { return sameTokens(this.tokens, readTokens(source)); }
}

export class SourceReturn extends SourceInitializer {}

function sameTokens(actual, expected) {
  return actual !== null && actual.length === expected.length
    // Patterns may explicitly leave prose unconstrained, but never expressions,
    // calls, identifiers, or control literals such as Step IDs and action IDs.
    && actual.every((token, index) => expected[index].kind === "identifier" && expected[index].value === "$STRING_LITERAL"
      ? token.kind === "string"
      : token.value === expected[index].value && token.kind === expected[index].kind);
}

const identifierStart = /[A-Za-z_$]/;
const identifierPart = /[A-Za-z0-9_$]/;
const regexPrefixes = new Set(["(", "[", "{", "=", ":", ",", ";", "!", "?", "|", "&", "=>", "return", "throw", "case", "yield", "await", "of", "in"]);

export function readTokens(source, file = "<source>") {
  const tokens = [];
  let index = 0;
  let line = 1;
  let column = 1;
  function advance() {
    const char = source[index++];
    if (char === "\n") { line++; column = 1; } else column++;
    return char;
  }
  function error(message) { throw new SourceReadError(file, index, message, source); }
  function add(value, kind, offset, startLine, startColumn) {
    tokens.push(new SourceToken(value, kind, offset, startLine, startColumn));
  }
  function quoted(quote) {
    const offset = index; const startLine = line; const startColumn = column;
    advance();
    let value = "";
    while (index < source.length) {
      const char = advance();
      if (char === quote) { add(value, "string", offset, startLine, startColumn); return; }
      if (char === "\n") error("unterminated string");
      if (char === "\\") {
        if (index >= source.length) error("unterminated string escape");
        const escaped = advance();
        if (escaped === "u" || escaped === "x") {
          const count = escaped === "u" ? 4 : 2;
          const digits = source.slice(index, index + count);
          if (!new RegExp(`^[0-9a-fA-F]{${count}}$`).test(digits)) error("unsupported string escape");
          for (let i = 0; i < count; i++) advance();
          value += String.fromCodePoint(Number.parseInt(digits, 16));
        } else value += ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" })[escaped] ?? escaped;
      } else value += char;
    }
    error("unterminated string");
  }
  function regexp() {
    const offset = index; const startLine = line; const startColumn = column;
    advance();
    let inClass = false;
    while (index < source.length) {
      const char = advance();
      if (char === "\n") error("unterminated regular expression");
      if (char === "\\") { if (index >= source.length) error("unterminated regular expression"); advance(); continue; }
      if (char === "[") inClass = true;
      if (char === "]") inClass = false;
      if (char === "/" && !inClass) {
        while (identifierPart.test(source[index] ?? "")) advance();
        add("<regex>", "literal", offset, startLine, startColumn);
        return;
      }
    }
    error("unterminated regular expression");
  }
  function template() {
    const offset = index; const startLine = line; const startColumn = column;
    advance();
    add("<template>", "literal", offset, startLine, startColumn);
    while (index < source.length) {
      const char = advance();
      if (char === "\\") { if (index >= source.length) error("unterminated template escape"); advance(); continue; }
      if (char === "`") { add("<template-end>", "literal", index - 1, line, column - 1); return; }
      if (char === "$" && source[index] === "{") {
        advance();
        scan(true);
      }
    }
    error("unterminated template");
  }
  function scan(interpolation = false) {
    let braces = 0;
    const parens = [];
    const blockBraces = [];
    if (index === 0 && source.startsWith("#!")) while (index < source.length && source[index] !== "\n") advance();
    while (index < source.length) {
      const char = source[index];
      if (/\s/.test(char)) { advance(); continue; }
      if (char === "/" && source[index + 1] === "/") {
        advance(); advance(); while (index < source.length && source[index] !== "\n") advance(); continue;
      }
      if (char === "/" && source[index + 1] === "*") {
        advance(); advance();
        while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) advance();
        if (index >= source.length) error("unterminated block comment");
        advance(); advance(); continue;
      }
      if (char === "'" || char === '"') { quoted(char); continue; }
      if (char === "`") { template(); continue; }
      if (char === "/" && (regexPrefixes.has(tokens.at(-1)?.value ?? "=") || tokens.at(-1)?.controlClose || tokens.at(-1)?.blockClose)) { regexp(); continue; }
      const offset = index; const startLine = line; const startColumn = column;
      if (identifierStart.test(char) || (char === "#" && identifierStart.test(source[index + 1] ?? ""))) {
        let value = advance();
        while (identifierPart.test(source[index] ?? "")) value += advance();
        add(value, "identifier", offset, startLine, startColumn); continue;
      }
      if (/[0-9]/.test(char)) {
        let value = advance(); while (/[A-Za-z0-9_.]/.test(source[index] ?? "")) value += advance();
        add(value, "number", offset, startLine, startColumn); continue;
      }
      if (char === "}" && interpolation && braces === 0) { advance(); return; }
      if (char === "{") {
        braces++;
        const previous = tokens.at(-1);
        blockBraces.push(Boolean(previous?.controlClose || previous?.value === "=>"
          || ["else", "try", "finally", "do"].includes(previous?.value)));
      }
      if (char === "}") braces--;
      if (char === "=" && source[index + 1] === ">") { advance(); advance(); add("=>", "punctuation", offset, startLine, startColumn); continue; }
      if (!"{}[]().,;:=?!+-*%&|^~<>/@".includes(char)) error(`unsupported character ${char}`);
      if (char === "(") parens.push(["if", "for", "while", "with", "switch", "catch"].includes(tokens.at(-1)?.value));
      const punctuation = advance();
      add(punctuation, "punctuation", offset, startLine, startColumn);
      if (punctuation === ")") tokens.at(-1).controlClose = parens.pop() ?? false;
      if (punctuation === "}") tokens.at(-1).blockClose = blockBraces.pop() ?? false;
    }
    if (interpolation) error("unterminated template interpolation");
  }
  scan();
  return tokens;
}

function matching(tokens, open, left = "{", right = "}") {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].kind === "punctuation" && tokens[i].value === left) depth++;
    if (tokens[i].kind === "punctuation" && tokens[i].value === right && --depth === 0) return i;
  }
  throw new SourceReadError("<source>", tokens[open].offset, `unclosed ${left}`);
}

/** Account for every reference to a capability; unclassified uses remain errors.
 * Callers that inspect every binding can disable automatic binding acceptance
 * while retaining the same alias provenance and explicitly accepting checked uses.
 */
export class SourceOriginUsage {
  constructor(declaration, origins, { acceptBindings = true, bindings = null, mutableAliases = false } = {}) {
    if (!(declaration instanceof SourceDeclaration)) throw new TypeError("source declaration required");
    this.tokens = declaration.tokens;
    this.origins = new Set(origins);
    this.bindings = bindings;
    this.originBindings = bindings === null ? null : new Set([...this.origins]
      .map((name) => bindings.moduleBinding(name)).filter(Boolean));
    this.accepted = new Set();
    const transfers = [];
    for (let index = 0; index < this.tokens.length; index++) {
      const tokens = this.tokens;
      let target;
      let start;
      if ((tokens[index].value === "const" || mutableAliases && tokens[index].value === "let") && tokens[index - 1]?.value !== "export" && tokens[index + 1]?.kind === "identifier"
        && tokens[index + 2]?.value === "=") {
        target = tokens[index + 1]; start = index + 3;
      } else if (tokens[index].value === "this" && tokens[index + 1]?.value === "."
        && tokens[index + 2]?.value.startsWith("#") && tokens[index + 3]?.value === "=") {
        target = tokens[index + 2]; start = index + 4;
      } else continue;
      let end = start;
      while (end < tokens.length && tokens[end].value !== ";") end++;
      const source = tokens.slice(start, end);
      if (!SourceOriginUsage.isReference(source)) continue;
      transfers.push([target, source]);
    }
    let changed;
    do {
      changed = false;
      for (const [target, source] of transfers) {
        const origin = source.at(-1);
        if (!this.isOrigin(target) && !this.isOrigin(origin)) continue;
        for (const token of [target, origin]) {
          const binding = this.bindings?.bindingAt(token);
          if (this.bindings !== null && !binding) continue;
          const known = this.bindings === null ? this.origins.has(token.value) : this.originBindings.has(binding);
          if (known) continue;
          this.origins.add(token.value);
          this.originBindings?.add(binding);
          changed = true;
        }
        if (acceptBindings) this.accept([target, ...source]);
      }
    } while (changed);
    if (!acceptBindings) return;
    // Only binding positions are declarations. Defaults and destructured values
    // are not silently accepted as uses of the capability.
    const constructor = this.tokens.findIndex((token) => token.value === "constructor");
    const parameters = readParameters(constructor < 0 ? this.tokens : this.tokens.slice(constructor));
    for (const parameter of parameters) {
      if (parameter.length === 1 && parameter[0].kind === "identifier") this.accept(parameter);
      else if (parameter[0]?.value === "{" && parameter.at(-1)?.value === "}") {
        for (let index = 1; index < parameter.length - 1; index++) {
          if (["{", ","].includes(parameter[index - 1]?.value)
            && [",", "}"].includes(parameter[index + 1]?.value)) this.accept([parameter[index]]);
        }
      }
    }
    let depth = 0;
    const isClass = this.tokens.slice(0, 3).some((token) => token.value === "class");
    for (let index = 0; index < this.tokens.length; index++) {
      const token = this.tokens[index];
      if (token.value === "{") depth++;
      if (token.value === "}") depth--;
      if (isClass && depth === 1 && token.value.startsWith("#")
        && this.tokens[index + 1]?.value === ";") this.accept([token]);
    }
  }
  static isReference(tokens) {
    return tokens.length > 0 && tokens.length % 2 === 1
      && tokens.every((token, index) => index % 2 === 0 ? token.kind === "identifier"
        : token.kind === "punctuation" && token.value === ".");
  }
  isOrigin(token) {
    return token.kind === "identifier" && (this.bindings === null ? this.origins.has(token.value)
      : this.originBindings.has(this.bindings.bindingAt(token)));
  }
  isReference(tokens) { return SourceOriginUsage.isReference(tokens) && this.isOrigin(tokens.at(-1)); }
  accept(tokens) { for (const token of tokens) this.accepted.add(token.offset); }
  unresolved() { return this.tokens.filter((token) => this.isOrigin(token) && !this.accepted.has(token.offset)); }
}

/** Read constructor/function parameters without executing a declaration. */
export function readParameters(tokens) {
  const open = tokens.findIndex((token) => token.value === "(");
  if (open < 0) return [];
  const close = matching(tokens, open, "(", ")");
  return readCommaSeparated(tokens, open + 1, close);
}

export class SourceTypeInvariant {
  constructor(parameter, typeName, token, typeToken) {
    this.parameter = parameter;
    this.typeName = typeName;
    this.token = token;
    this.typeToken = typeToken;
    Object.freeze(this);
  }
}

function unwrapCondition(tokens) {
  while (tokens[0]?.value === "(" && tokens[0].kind === "punctuation"
    && matching(tokens, 0, "(", ")") === tokens.length - 1) tokens = tokens.slice(1, -1);
  return tokens;
}

function isDeferredCallable(tokens) {
  const initializer = unwrapCondition(tokens);
  let start = initializer[0]?.value === "async" ? 1 : 0;
  if (initializer[start]?.value === "function") return true;
  if (initializer[start]?.value === "(") start = matching(initializer, start, "(", ")");
  return initializer[start + 1]?.value === "=>";
}

function isGuardLiteral(token) {
  return token?.kind === "string" || token?.kind === "number"
    || token?.kind === "identifier" && ["true", "false", "null"].includes(token.value);
}

/** Every branch must belong to the supported condition grammar. Matching only
 * an instanceof fragment cannot prove that the enclosing condition rejects it.
 * Member predicates preserve the additional checks used by production Services,
 * but only a direct parameter check establishes its declared argument type.
 */
function readInvariantCondition(tokens, names) {
  tokens = unwrapCondition(tokens);
  if (tokens.length === 0) return null;
  const invariants = [];
  let start = 0;
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].kind !== "punctuation") continue;
    if (tokens[index].value === "(") { index = matching(tokens, index, "(", ")"); continue; }
    if (tokens[index].value !== "|" || tokens[index + 1]?.kind !== "punctuation" || tokens[index + 1].value !== "|") continue;
    const term = readInvariantCondition(tokens.slice(start, index), names);
    if (term === null) return null;
    invariants.push(...term);
    start = index + 2;
    index++;
  }
  if (start > 0) {
    const term = readInvariantCondition(tokens.slice(start), names);
    if (term === null) return null;
    invariants.push(...term);
    return invariants;
  }
  const parameterReference = (reference) => SourceOriginUsage.isReference(reference) && names.has(reference[0].value);
  if (tokens[0].kind === "punctuation" && tokens[0].value === "!"
    && tokens[1]?.kind === "punctuation" && tokens[1].value === "("
    && matching(tokens, 1, "(", ")") === tokens.length - 1) {
    const operand = unwrapCondition(tokens.slice(2, -1));
    const reference = operand.slice(0, -2);
    const type = operand.at(-1);
    if (operand.at(-2)?.value !== "instanceof" || operand.at(-2)?.kind !== "identifier"
      || type?.kind !== "identifier" || names.has(type.value) || !parameterReference(reference)) return null;
    return reference.length === 1 ? [new SourceTypeInvariant(reference[0].value, type.value, tokens[0], type)] : [];
  }
  if (tokens.length === 1 && isGuardLiteral(tokens[0])) return [];
  const reference = tokens.slice(0, -4);
  const comparison = tokens.slice(-4, -1);
  if (parameterReference(reference) && isGuardLiteral(tokens.at(-1))
    && comparison.every((token) => token.kind === "punctuation")
    && ["===", "!=="].includes(comparison.map((token) => token.value).join(""))) return [];
  return null;
}

/** The guard consequent is one immediate throw, with no intervening control or
 * binding changes. Restrict its expression too: an arbitrary call could mutate
 * operands or never reach the throw. Literal error arguments cover current guards.
 */
function readInvariantRejection(tokens, start) {
  const block = tokens[start]?.kind === "punctuation" && tokens[start].value === "{";
  let index = block ? start + 1 : start;
  if (tokens[index]?.kind !== "identifier" || tokens[index].value !== "throw"
    || tokens[index + 1]?.kind !== "identifier" || tokens[index + 1].value !== "new"
    || tokens[index + 2]?.kind !== "identifier"
    || tokens[index + 3]?.kind !== "punctuation" || tokens[index + 3].value !== "(") return null;
  const close = matching(tokens, index + 3, "(", ")");
  const arguments_ = readCommaSeparated(tokens, index + 4, close);
  if (arguments_.some((argument) => argument.length !== 1 || !isGuardLiteral(argument[0]))) return null;
  index = close + 1;
  if (tokens[index]?.kind === "punctuation" && tokens[index].value === ";") index++;
  else if (!block) return null;
  if (block) {
    if (tokens[index]?.kind !== "punctuation" || tokens[index].value !== "}") return null;
    index++;
  }
  return tokens[index]?.kind === "identifier" && tokens[index].value === "else" ? null : index;
}

/** Prove only leading unconditional rejection guards over original parameters.
 * Unknown prefixes stop inspection; guards after a binding change, early exit,
 * nested branch or caught throw cannot establish constructor input invariants.
 */
export function readTypeInvariants(declaration) {
  const body = declaration?.bodyTokens() ?? [];
  const result = [];
  const parameters = readParameters(declaration?.tokens ?? []);
  if (parameters.some((parameter) => parameter.length !== 1 || parameter[0].kind !== "identifier")) return result;
  const names = new Set(parameters.map((parameter) => parameter[0].value));
  let index = 0;
  while (index < body.length) {
    if (body[index].kind === "punctuation" && body[index].value === ";") { index++; continue; }
    if (body[index].kind !== "identifier" || body[index].value !== "if"
      || body[index + 1]?.kind !== "punctuation" || body[index + 1].value !== "(") break;
    const close = matching(body, index + 1, "(", ")");
    const invariants = readInvariantCondition(body.slice(index + 2, close), names);
    const next = readInvariantRejection(body, close + 1);
    if (invariants === null || next === null) break;
    result.push(...invariants);
    index = next;
  }
  if (result.length === 0) return result;
  // Resolve all guard types together against the entire constructor scope.
  // Outer imports are unbound in this isolated declaration; local bindings,
  // including hoisted declarations after the guards, must not stand in for them.
  const outerTypeOffsets = new Set(unboundGlobals(declaration.tokens, [], declaration.name,
    new Set(result.map((invariant) => invariant.typeName))).map((token) => token.offset));
  return result.filter((invariant) => outerTypeOffsets.has(invariant.typeToken.offset));
}

function readCommaSeparated(tokens, start, end) {
  const parts = [];
  let depth = 0;
  for (let index = start; index < end; index++) {
    if (tokens[index].kind !== "punctuation") continue;
    if (["(", "[", "{"].includes(tokens[index].value)) depth++;
    else if ([")", "]", "}"].includes(tokens[index].value)) depth--;
    else if (tokens[index].value === "," && depth === 0) {
      parts.push(tokens.slice(start, index)); start = index + 1;
    }
  }
  if (start < end) parts.push(tokens.slice(start, end));
  return parts;
}

/** One member access after a known receiver; a null name is unresolved. */
export class SourceMemberAccess {
  constructor(token, name, called) {
    if (!(token instanceof SourceToken) || (name !== null && typeof name !== "string")
      || typeof called !== "boolean") throw new TypeError("invalid source member access");
    this.token = token;
    this.name = name;
    this.called = called;
  }
  isCallTo(methods) { return this.called && this.name !== null && methods.has(this.name); }
}

/** Normalize ordinary/optional member and call syntax before applying any policy.
 * Computed members deliberately remain unresolved, even for literal keys.
 * Parentheses wrapping the receiver are transparent, unlike a surrounding call.
 */
export function readMemberAccess(tokens, receiverIndex, receiverStart = receiverIndex) {
  let start = receiverStart;
  while (start >= 2 && tokens[start - 1].value === ".") {
    const receiver = tokens[start - 2].value === "?" ? start - 3 : start - 2;
    if (tokens[receiver]?.kind !== "identifier") break;
    start = receiver;
  }
  let cursor = receiverIndex + 1;
  while (tokens[start - 1]?.value === "(" && tokens[cursor]?.value === ")"
    && matching(tokens, start - 1, "(", ")") === cursor
    && (!(tokens[start - 2]?.kind === "identifier")
      || ["return", "await", "yield", "throw"].includes(tokens[start - 2]?.value))
    && tokens[start - 2]?.kind !== "string"
    && ![")", "]"].includes(tokens[start - 2]?.value)) {
    start--;
    cursor++;
  }
  const skipOptional = (index) => tokens[index]?.value === "?" && tokens[index + 1]?.value === "."
    ? index + 2 : index;
  const optionalEnd = skipOptional(cursor);
  if (optionalEnd !== cursor) cursor = optionalEnd;
  else if (tokens[cursor]?.value === ".") cursor++;
  else if (!["[", "("].includes(tokens[cursor]?.value)) return null;
  const token = tokens[cursor];
  if (!token) return new SourceMemberAccess(tokens[receiverIndex], null, false);
  if (token.kind !== "identifier") return new SourceMemberAccess(token, null, false);
  const call = skipOptional(cursor + 1);
  return new SourceMemberAccess(token, token.value, tokens[call]?.value === "(");
}

/** Read named calls without executing the composition module. */
export function readInvocations(module) {
  const tokens = module.tokens;
  const result = [];
  for (let index = 0; index < tokens.length - 1; index++) {
    const token = tokens[index];
    if (token.kind !== "identifier" || tokens[index + 1].value !== "(" || [".", "function"].includes(tokens[index - 1]?.value)) continue;
    const close = matching(tokens, index + 1, "(", ")");
    if (tokens[close + 1]?.value === "{" && tokens[index - 1]?.value !== "new") continue;
    const arguments_ = readCommaSeparated(tokens, index + 2, close);
    result.push(new SourceInvocation(token.value, token, arguments_, tokens[close], tokens[index - 1]?.value === "new"));
  }
  return result;
}

/** Index module declaration headers once; this also serves lexical-only callers. */
function readDeclarationHeaders(module) {
  const tokens = module.tokens;
  const headers = new Map();
  let depth = 0;
  for (let index = 0; index < tokens.length - 1; index++) {
    if (tokens[index].kind === "punctuation") {
      if (tokens[index].value === "{") depth++;
      if (tokens[index].value === "}") depth--;
    }
    if (depth !== 0 || tokens[index].kind !== "identifier"
      || !["class", "function", "const", "let", "var"].includes(tokens[index].value)
      || tokens[index + 1]?.kind !== "identifier") continue;
    const name = tokens[index + 1].value;
    if (headers.has(name)) continue;
    let prefixStart = index;
    while (["export", "default", "async"].includes(tokens[prefixStart - 1]?.value)) prefixStart--;
    headers.set(name, new SourceDeclarationHeader(name, tokens[index], tokens.slice(prefixStart, index)));
  }
  return headers;
}

/** Read the full supported declaration only after its binding has been selected. */
export function readDeclaration(module, name) {
  const header = module.declarationHeader(name);
  if (!header || header.token.value === "var") return null;
  const tokens = module.tokens;
  const index = tokens.findIndex((token) => token.offset === header.token.offset);
  if (header.token.value === "class" || header.token.value === "function") {
    let open = index + 2;
    if (header.token.value === "function") {
      while (open < tokens.length && tokens[open].value !== "(") open++;
      if (open === tokens.length) throw new SourceReadError(module.file, tokens[index].offset, `unsupported ${name} declaration`);
      open = matching(tokens, open, "(", ")") + 1;
    }
    while (open < tokens.length && tokens[open].value !== "{") open++;
    if (open === tokens.length) throw new SourceReadError(module.file, tokens[index].offset, `unclosed ${name} declaration`);
    const close = matching(tokens, open);
    return new SourceDeclaration(name, tokens.slice(index, close + 1), header.prefix);
  }
  let end = index + 2;
  const stack = [];
  for (; end < tokens.length; end++) {
    const value = tokens[end].value;
    if (value === ";" && stack.length === 0) break;
    if (["(", "[", "{"].includes(value)) stack.push(value);
    else if ([")", "]", "}"].includes(value)) stack.pop();
  }
  if (end === tokens.length) throw new SourceReadError(module.file, tokens[index].offset, `unterminated ${name} declaration`);
  return new SourceDeclaration(name, tokens.slice(index, end + 1), header.prefix);
}

/** Members and eager class expressions share one balanced extraction pass. */
export class SourceClassMembers {
  constructor(declaration) {
    if (!(declaration instanceof SourceDeclaration) || declaration.token.value !== "class") throw new TypeError("class declaration required");
    this.instanceMembers = new Map();
    this.staticMembers = new Map();
    this.instanceInitializers = [];
    this.moduleInitializers = [];
    this.unresolvedInstanceMembers = [];
    this.unresolvedStaticMembers = [];
    const tokens = declaration.tokens;
    const open = tokens.findIndex((token) => token.kind === "punctuation" && token.value === "{");
    let index = open + 1;
    while (index < tokens.length - 1) {
      if (tokens[index].value === ";") { index++; continue; }
      let isStatic = tokens[index].value === "static" && !["(", "=", ";", "}"].includes(tokens[index + 1]?.value);
      const members = isStatic ? this.staticMembers : this.instanceMembers;
      if (isStatic) index++;
      if (isStatic && tokens[index]?.value === "{") {
        const end = matching(tokens, index);
        this.moduleInitializers.push(new SourceDeclaration(`${declaration.name}.<static:${tokens[index].offset}>`, tokens.slice(index, end + 1)));
        index = end + 1;
        continue;
      }
      if (["get", "set", "async"].includes(tokens[index]?.value)
        && (tokens[index + 1]?.kind === "identifier" || ["*", "["].includes(tokens[index + 1]?.value))) index++;
      if (tokens[index]?.value === "*") index++;
      const start = index;
      let name = tokens[index]?.value;
      if (name === "[") {
        const end = matching(tokens, index, "[", "]");
        const expression = tokens.slice(index + 1, end);
        const key = unwrapCondition(expression);
        name = key.length === 1 && isGuardLiteral(key[0]) ? key[0].value : null;
        if (name !== null && key[0].kind === "number") {
          const number = Number(name.replaceAll("_", ""));
          name = Number.isNaN(number) ? null : String(number);
        }
        if (name === null) (isStatic ? this.unresolvedStaticMembers : this.unresolvedInstanceMembers).push(tokens[index]);
        this.moduleInitializers.push(new SourceDeclaration(`${declaration.name}.<key:${tokens[index].offset}>`, expression));
        index = end;
      }
      index++;
      if (tokens[index]?.value === "(") {
        const close = matching(tokens, index, "(", ")");
        if (tokens[close + 1]?.value !== "{") throw new SourceReadError(declaration.name, tokens[start].offset, "unsupported class member");
        const end = matching(tokens, close + 1);
        if (name !== null && !members.has(name)) members.set(name,
          new SourceDeclaration(`${declaration.name}.${name}`, tokens.slice(start, end + 1)));
        index = end + 1;
        continue;
      }
      if (tokens[index]?.value !== "=") continue;
      const valueStart = ++index;
      while (index < tokens.length - 1 && tokens[index].value !== ";") {
        if (index > valueStart && tokens[index].line > tokens[index - 1].line
          && tokens[index].kind === "identifier" && ["=", "(", ";"].includes(tokens[index + 1]?.value)
          && !["=", ".", "+", "-", "*", "/", "?", ":", "&", "|", ","].includes(tokens[index - 1].value)) break;
        if (["(", "[", "{"].includes(tokens[index].value) && tokens[index].kind === "punctuation") {
          index = matching(tokens, index, tokens[index].value, { "(": ")", "[": "]", "{": "}" }[tokens[index].value]);
        }
        index++;
      }
      const value = tokens.slice(valueStart, index);
      if (value.length === 0) throw new SourceReadError(declaration.name, tokens[start].offset, "missing field initializer");
      if (isDeferredCallable(value)) {
        if (name !== null && !members.has(name)) members.set(name,
          new SourceDeclaration(`${declaration.name}.${name}`, tokens.slice(start, index)));
      } else (isStatic ? this.moduleInitializers : this.instanceInitializers).push(
        new SourceDeclaration(`${declaration.name}.${name ?? "[computed]"}`, value));
    }
  }
  member(name, { isStatic = null } = {}) {
    if (isStatic !== null) return (isStatic ? this.staticMembers : this.instanceMembers).get(name) ?? null;
    const candidates = [this.instanceMembers.get(name), this.staticMembers.get(name)].filter(Boolean);
    return candidates.sort((left, right) => left.token.offset - right.token.offset)[0] ?? null;
  }
  unresolvedMember(isStatic) {
    return (isStatic ? this.unresolvedStaticMembers : this.unresolvedInstanceMembers)[0] ?? null;
  }
}

function readClassMembers(module, className) {
  let parent = module.declaration(className);
  if (!parent) {
    const classEntry = module.classes.find((entry) => entry.name === className);
    const start = module.tokens.findIndex((token) => token.offset === classEntry?.token.offset);
    if (start >= 0) {
      let open = start + 2;
      while (open < module.tokens.length && module.tokens[open].value !== "{") open++;
      if (open < module.tokens.length) {
        const close = matching(module.tokens, open);
        parent = new SourceDeclaration(className, module.tokens.slice(start, close + 1));
      }
    }
  }
  return parent ? new SourceClassMembers(parent) : null;
}

export function readClassMember(module, className, memberName, options = {}) {
  return module.classMembers(className)?.member(memberName, options) ?? null;
}

function bindingsOf(tokens, start, end) {
  const bindings = new Map();
  if (tokens[start]?.kind === "identifier" && tokens[start].value !== "type") bindings.set(tokens[start].value, "default");
  for (let i = start; i < end; i++) {
    if (tokens[i].value === "*") {
      if (tokens[i + 1]?.value === "as" && tokens[i + 2]?.kind === "identifier") bindings.set(tokens[i + 2].value, "*");
    }
    if (tokens[i].value !== "{") continue;
    const close = matching(tokens, i);
    for (let j = i + 1; j < close; j++) {
      if (tokens[j].kind !== "identifier" || tokens[j].value === "as") continue;
      const imported = tokens[j].value;
      const local = tokens[j + 1]?.value === "as" ? tokens[j + 2]?.value : imported;
      bindings.set(local, imported);
      j += local === imported ? 0 : 2;
    }
    i = close;
  }
  return bindings;
}

class SourceLexicalBinding {
  constructor(name) {
    if (typeof name !== "string" || name.length === 0) throw new TypeError("lexical binding name required");
    this.name = name;
    Object.freeze(this);
  }
}

class SourceLexicalScope {
  constructor(parent, start, end) {
    this.parent = parent;
    this.start = start;
    this.end = end;
    this.bindings = new Map();
  }
  bind(name) {
    if (!this.bindings.has(name)) this.bindings.set(name, new SourceLexicalBinding(name));
    return this.bindings.get(name);
  }
  resolve(name) { return this.bindings.get(name) ?? this.parent?.resolve(name) ?? null; }
}

/** A write to one lexically resolved binding, never to an object member. */
export class SourceBindingWrite {
  constructor(token, binding) {
    if (!(token instanceof SourceToken) || !(binding instanceof SourceLexicalBinding)) throw new TypeError("resolved binding write required");
    this.token = token;
    this.binding = binding;
    Object.freeze(this);
  }
}

/** One lexical index serves global reads and opt-in module binding accounting. */
class SourceLexicalBindings {
  constructor(root, tokens, scopes, declarationBindings, references, globalReferences, exports) {
    this.root = root;
    this.tokens = tokens;
    this.declarations = declarationBindings;
    this.references = new Map();
    for (const index of references) this.references.set(tokens[index].offset, scopes[index].resolve(tokens[index].value));
    this.exports = exports;
    this.globalReferences = globalReferences;
    this.writes = null;
  }
  moduleBinding(name) { return this.root.bindings.get(name) ?? null; }
  bindingAt(token) {
    return this.declarations.get(token.offset) ?? this.references.get(token.offset) ?? this.exports.get(token.offset) ?? null;
  }
  bindingWrites(names) {
    if (this.writes === null) this.writes = this.#readWrites();
    const selected = new Set([...names].map((name) => this.moduleBinding(name)).filter(Boolean));
    return this.writes.filter((write) => selected.has(write.binding));
  }
  #readWrites() {
    const tokens = this.tokens;
    const pairs = new Map();
    const stack = [];
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index].kind !== "punctuation") continue;
      if (["(", "[", "{"].includes(tokens[index].value)) stack.push(index);
      else if ([")", "]", "}"].includes(tokens[index].value)) {
        const start = stack.pop();
        pairs.set(index, start);
        pairs.set(start, index);
      }
    }
    const offsets = new Set();
    const add = (token) => {
      if (token && this.references.has(token.offset) && this.references.get(token.offset)) offsets.add(token.offset);
    };
    // Assignment patterns share the reader's balanced/comma grammar. Member
    // targets mutate an object, so they must not be mistaken for binding writes.
    const targets = (part) => {
      part = unwrapCondition(part);
      while (part[0]?.value === ".") part = part.slice(1);
      let end = part.length;
      for (let index = 0; index < part.length; index++) {
        if (["(", "[", "{"].includes(part[index].value)) {
          index = matching(part, index, part[index].value, { "(": ")", "[": "]", "{": "}" }[part[index].value]);
        } else if (part[index].value === "=") { end = index; break; }
      }
      part = part.slice(0, end);
      if (part.length === 1 && part[0].kind === "identifier") { add(part[0]); return; }
      if (!["[", "{"].includes(part[0]?.value)) return;
      const object = part[0].value === "{";
      for (let item of readCommaSeparated(part, 1, part.length - 1)) {
        if (object) for (let index = 0; index < item.length; index++) {
          if (["(", "[", "{"].includes(item[index].value)) {
            index = matching(item, index, item[index].value, { "(": ")", "[": "]", "{": "}" }[item[index].value]);
          } else if (item[index].value === ":") { item = item.slice(index + 1); break; }
        }
        targets(item);
      }
    };
    const assignmentAt = (index) => {
      let operator = "";
      while (index < tokens.length && tokens[index].kind === "punctuation" && "=+-*/%&|^<>?".includes(tokens[index].value)) {
        const value = tokens[index++].value;
        operator += value;
        if (value === "=") {
          if (tokens[index]?.value === "=") return false;
          break;
        }
        if (["++", "--"].includes(operator)) break;
      }
      return ["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=", "??=", "++", "--"].includes(operator);
    };
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (this.references.has(token.offset)) {
        let start = index;
        let end = index;
        while (tokens[start - 1]?.value === "(" && pairs.get(start - 1) === end + 1) { start--; end++; }
        if (assignmentAt(end + 1) || ![".", "[", "?"].includes(tokens[end + 1]?.value)
          && ["++", "--"].includes(tokens.slice(start - 2, start).map((entry) => entry.value).join(""))) add(token);
      }
      if (token.value === "=" ? token.kind !== "punctuation" : token.kind !== "identifier" || !["of", "in"].includes(token.value)) continue;
      if (token.value === "=" && (tokens[index + 1]?.value === "=" || ["=", "!", "<", ">"].includes(tokens[index - 1]?.value))) continue;
      if (token.value !== "=") {
        let open = index - 1;
        while (open >= 0 && !["(", ";"].includes(tokens[open].value)) {
          if ([")", "]", "}"].includes(tokens[open].value)) open = pairs.get(open);
          open--;
        }
        if (tokens[open - 1]?.value !== "for" && !(tokens[open - 1]?.value === "await" && tokens[open - 2]?.value === "for")) continue;
      }
      const end = index - 1;
      const start = pairs.get(end) ?? end;
      if (start > end) continue;
      const previous = tokens[start - 1];
      if (previous?.kind === "identifier" && !["return", "yield", "await"].includes(previous.value)
        || [")", "]", "."].includes(previous?.value)) continue;
      targets(tokens.slice(start, end + 1));
    }
    return tokens.filter((token) => offsets.has(token.offset)).map((token) => new SourceBindingWrite(token, this.references.get(token.offset)));
  }
  unbound(watched) {
    return this.tokens.filter((token) => watched.has(token.value) && this.globalReferences.has(token.offset)
      && this.references.get(token.offset) === null);
  }
}

const watchedGlobals = new Set(["require", "createRequire", "eval", "Function", "fetch", "process", "globalThis", "global"]);

function unboundGlobals(tokens, references, file, watched = watchedGlobals) {
  return readLexicalBindings(tokens, references, file).unbound(watched);
}

function readLexicalBindings(tokens, references, file) {
  const root = new SourceLexicalScope(null, 0, tokens.length);
  const scopes = Array(tokens.length).fill(root);
  const stack = [root];
  const braceScopes = new Map();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind === "punctuation" && tokens[i].value === "{") {
      const scope = new SourceLexicalScope(stack.at(-1), i, matching(tokens, i));
      braceScopes.set(i, scope);
      stack.push(scope);
    }
    scopes[i] = stack.at(-1);
    if (tokens[i].kind === "punctuation" && tokens[i].value === "}") stack.pop();
  }
  // A lexical for binding belongs to its header and body, not the enclosing
  // module. Reparent existing brace scopes so nested captures resolve through it.
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value !== "for") continue;
    const open = index + (tokens[index + 1]?.value === "await" ? 2 : 1);
    if (tokens[open]?.value !== "(") continue;
    const close = matching(tokens, open, "(", ")");
    if (!["let", "const"].includes(tokens[open + 1]?.value)) continue;
    let end = close + 1;
    if (tokens[end]?.value === "{") end = matching(tokens, end);
    else while (end < tokens.length && tokens[end].value !== ";") {
      if (["(", "[", "{"].includes(tokens[end].value)) end = matching(tokens, end, tokens[end].value,
        { "(": ")", "[": "]", "{": "}" }[tokens[end].value]);
      end++;
    }
    const parent = scopes[index];
    const loop = new SourceLexicalScope(parent, open, end);
    for (let cursor = open; cursor <= end && cursor < tokens.length; cursor++) {
      if (scopes[cursor] === parent) scopes[cursor] = loop;
      const nested = braceScopes.get(cursor);
      if (nested?.parent === parent) nested.parent = loop;
    }
  }
  for (const reference of references.filter((entry) => entry.kind === "import")) {
    for (const local of reference.bindings.keys()) root.bind(local);
  }
  const declarations = new Set();
  const declarationBindings = new Map();
  const bindingIndexes = (start, end) => {
    const indexes = [];
    for (let j = start; j < end; j++) {
      if (tokens[j].value === "[") {
        const close = matching(tokens, j, "[", "]");
        if (tokens[close + 1]?.value === ":") { j = close; continue; }
      }
      if (tokens[j].value === "=") {
        while (++j < end && tokens[j].value !== ",") {
          if (["(", "[", "{"].includes(tokens[j].value)) j = matching(tokens, j, tokens[j].value, { "(": ")", "[": "]", "{": "}" }[tokens[j].value]);
        }
        continue;
      }
      if (tokens[j].kind === "identifier" && tokens[j + 1]?.value !== ":") indexes.push(j);
    }
    return indexes;
  };
  const bindParameters = (open, close, scope) => {
    for (const j of bindingIndexes(open + 1, close)) {
      declarationBindings.set(tokens[j].offset, scope.bind(tokens[j].value));
      declarations.add(j);
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "identifier" && ["const", "let", "var"].includes(token.value)
      && tokens[i - 1]?.value !== "."
      && (tokens[i + 1]?.kind === "identifier" || ["{", "["].includes(tokens[i + 1]?.value))) {
      // This reader models block bindings, not var's function/static-block scope.
      if (token.value === "var") throw new SourceReadError(file, token.offset, "unsupported var declaration");
      let cursor = i + 1;
      while (cursor < tokens.length) {
        let bindings;
        if (tokens[cursor].kind === "identifier") bindings = [cursor++];
        else if (["{", "["].includes(tokens[cursor].value)) {
          const close = matching(tokens, cursor, tokens[cursor].value, tokens[cursor].value === "{" ? "}" : "]");
          bindings = bindingIndexes(cursor + 1, close);
          cursor = close + 1;
        } else break;
        for (const j of bindings) {
          declarationBindings.set(tokens[j].offset, scopes[i].bind(tokens[j].value));
          declarations.add(j);
        }
        if (tokens[cursor]?.value === "=") {
          cursor++;
          while (cursor < tokens.length && ![",", ";"].includes(tokens[cursor].value)) {
            if (["(", "[", "{"].includes(tokens[cursor].value)) cursor = matching(tokens, cursor, tokens[cursor].value, { "(": ")", "[": "]", "{": "}" }[tokens[cursor].value]);
            cursor++;
          }
        }
        if (tokens[cursor]?.value !== ",") break;
        cursor++;
      }
    }
    if (token.kind === "identifier" && token.value === "class" && tokens[i + 1]?.kind === "identifier") {
      const name = tokens[i + 1].value;
      declarations.add(i + 1);
      let body = i + 2;
      while (body < tokens.length && tokens[body].value !== "{" && tokens[body].value !== ";") body++;
      const local = braceScopes.get(body)?.bind(name);
      const binding = !["=", "(", ",", ":", "return"].includes(tokens[i - 1]?.value) ? scopes[i].bind(name) : local;
      declarationBindings.set(tokens[i + 1].offset, binding);
    }
    if (token.value === "catch" && tokens[i + 1]?.value === "(") {
      const close = matching(tokens, i + 1, "(", ")");
      const body = braceScopes.get(close + 1);
      if (body) bindParameters(i + 1, close, body);
    }
    if (token.kind === "identifier" && token.value === "function") {
      let open = i + 1;
      if (tokens[open]?.value === "*") open++;
      const name = tokens[open]?.kind === "identifier" ? tokens[open++].value : null;
      if (tokens[open]?.value !== "(") continue;
      const close = matching(tokens, open, "(", ")");
      const body = braceScopes.get(close + 1);
      const declared = name && !["=", "(", ",", ":", "return"].includes(tokens[i - 1]?.value);
      if (body) {
        bindParameters(open, close, body);
        if (name && !declared) declarationBindings.set(tokens[open - 1].offset, body.bind(name));
      }
      if (declared) {
        declarationBindings.set(tokens[open - 1].offset, scopes[i].bind(name));
        declarations.add(open - 1);
      }
    }
    if (token.value === "(" && tokens[i - 1]?.kind === "identifier" && !["if", "for", "while", "switch", "with", "catch", "function"].includes(tokens[i - 1].value)) {
      const close = matching(tokens, i, "(", ")");
      const body = braceScopes.get(close + 1);
      if (body) bindParameters(i, close, body);
    }
    if (token.value === "=>") {
      let open = i - 1;
      let close = i;
      if (tokens[open]?.value === ")") {
        close = open;
        let depth = 1;
        while (depth && open > 0) {
          open--;
          if (tokens[open].value === ")") depth++;
          if (tokens[open].value === "(") depth--;
        }
      } else if (tokens[open]?.kind === "identifier") open--;
      else continue;
      const body = braceScopes.get(i + 1);
      if (body) bindParameters(open, close, body);
      else {
        let end = i + 1;
        let depth = 0;
        while (end < tokens.length) {
          const value = tokens[end].value;
          if (depth === 0 && [";", ",", ")", "}"].includes(value)) break;
          if (["(", "[", "{"].includes(value)) depth++;
          if ([")", "]", "}"].includes(value)) depth--;
          end++;
        }
        const arrow = new SourceLexicalScope(scopes[i], i + 1, end);
        bindParameters(open, close, arrow);
        for (let j = i + 1; j < end; j++) scopes[j] = arrow;
      }
    }
  }
  const referenceIndexes = [];
  const globalReferences = new Set();
  const exportedBindings = new Map();
  let declarationEnd = -1;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "identifier" && ["import", "export"].includes(token.value) && tokens[i + 1]?.value === "{") {
      declarationEnd = matching(tokens, i + 1);
      // Local exports transfer the binding even without a call. Re-exported
      // names belong to their source module, not an identically named local.
      if (token.value === "export" && tokens[declarationEnd + 1]?.value !== "from") {
        for (let j = i + 2; j < declarationEnd; j++) {
          if (tokens[j].value === ",") continue;
          exportedBindings.set(tokens[j].offset, root.resolve(tokens[j].value));
          if (tokens[j + 1]?.value === "as") j += 2;
        }
      }
    }
    if (i <= declarationEnd) continue;
    if (token.kind !== "identifier" || declarations.has(i)) continue;
    const previous = tokens[i - 1]?.value;
    const spread = previous === "." && tokens[i - 2]?.value === "." && tokens[i - 3]?.value === ".";
    if (previous === "." && !spread || previous === "#") continue;
    const beforeColon = tokens[i + 1]?.value === ":";
    if (beforeColon && ["{", ","].includes(previous)) continue;
    const call = tokens[i + 1]?.value === "(";
    if (call && tokens[matching(tokens, i + 1, "(", ")") + 1]?.value === "{") continue;
    referenceIndexes.push(i);
    // Preserve the existing global-read contract; module binding accounting
    // additionally recognizes the reference in a conditional's middle arm.
    if (!beforeColon && !spread) globalReferences.add(token.offset);
  }
  return new SourceLexicalBindings(root, tokens, scopes, declarationBindings, referenceIndexes, globalReferences, exportedBindings);
}

export class SourceModule {
  constructor(file, source, { lexicalOnly = false } = {}) {
    this.file = file;
    this.tokens = readTokens(source, file);
    this.references = [];
    this.exports = [];
    this.classes = [];
    this.dynamic = [];
    this.globals = [];
    this.unboundNames = new Map();
    this.declarations = new Map();
    this.declarationHeaders = null;
    this.classMemberIndex = new Map();
    this.lexicalBindings = null;
    try { this.#read(lexicalOnly); }
    catch (error) {
      if (error instanceof SourceReadError) {
        const before = source.slice(0, error.offset).split("\n");
        error.line = before.length;
        error.column = before.at(-1).length + 1;
      }
      throw error;
    }
  }

  isUnbound(name, token) {
    if (!this.unboundNames.has(name)) {
      this.unboundNames.set(name, new Set(this.#bindings().unbound(new Set([name]))
        .map((entry) => entry.offset)));
    }
    return this.unboundNames.get(name).has(token.offset);
  }

  classMembers(name) {
    if (!this.classMemberIndex.has(name)) this.classMemberIndex.set(name, readClassMembers(this, name));
    return this.classMemberIndex.get(name);
  }

  declarationHeader(name) {
    if (this.declarationHeaders === null) this.declarationHeaders = readDeclarationHeaders(this);
    return this.declarationHeaders.get(name) ?? null;
  }

  declaration(name) {
    if (!this.declarations.has(name)) this.declarations.set(name, readDeclaration(this, name));
    return this.declarations.get(name);
  }

  #bindings() {
    if (this.lexicalBindings === null) {
      try { this.lexicalBindings = readLexicalBindings(this.tokens, this.references, this.file); }
      catch (error) {
        if (error instanceof SourceReadError) {
          const token = this.tokens.find((entry) => entry.offset === error.offset);
          if (token) { error.line = token.line; error.column = token.column; }
        }
        throw error;
      }
    }
    return this.lexicalBindings;
  }

  bindingWrites(names) { return this.#bindings().bindingWrites(names); }

  originUsage(origins, { moduleBindings = false, ...options } = {}) {
    return new SourceOriginUsage(new SourceDeclaration(this.file, this.tokens), origins,
      { ...options, bindings: moduleBindings ? this.#bindings() : null });
  }

  referenceTokens(reference) {
    const start = this.tokens.findIndex((token) => token.offset === reference.token.offset);
    const specifier = this.tokens.findIndex((token, index) => index > start && token.kind === "string" && token.value === reference.specifier);
    return start >= 0 && specifier > start ? this.tokens.slice(start, specifier + 1) : [];
  }

  #read(lexicalOnly) {
    const t = this.tokens;
    for (let i = 0; i < t.length; i++) {
      const token = t[i];
      const previous = t[i - 1]?.value;
      if (token.kind === "identifier" && token.value === "import" && previous !== ".") {
        if (t[i + 1]?.value === "(") {
          if (t[matching(t, i + 1, "(", ")") + 1]?.value === "{") continue;
          const literal = t[i + 2]?.kind === "string" && [")", ","].includes(t[i + 3]?.value);
          this.dynamic.push(token);
          if (literal) this.references.push(new SourceReference(t[i + 2].value, token, "dynamic"));
          continue;
        }
        if (t[i + 1]?.value === ".") continue;
        if (t[i + 1]?.kind === "string") { this.references.push(new SourceReference(t[i + 1].value, token, "import")); continue; }
        let from = i + 1;
        while (from < t.length && t[from].value !== "from" && t[from].value !== ";") from++;
        if (t[from]?.value !== "from" || t[from + 1]?.kind !== "string") throw new SourceReadError(this.file, token.offset, "unsupported import declaration");
        this.references.push(new SourceReference(t[from + 1].value, token, "import", bindingsOf(t, i + 1, from)));
        continue;
      }
      if (token.kind === "identifier" && token.value === "export" && previous !== "." && ["{", "*"].includes(t[i + 1]?.value)) {
        let end = i + 1;
        if (t[end].value === "{") end = matching(t, end) + 1;
        else { end++; if (t[end]?.value === "as") end += 2; }
        let reference = null;
        if (t[end]?.value === "from" && t[end + 1]?.kind === "string") {
          reference = new SourceReference(t[end + 1].value, token, "reexport", bindingsOf(t, i + 1, end));
          this.references.push(reference);
        }
        if (t[i + 1].value === "*") {
          if (t[i + 2]?.value === "as") this.exports.push(new SourceExport(t[i + 3].value, "*", reference));
          else this.exports.push(new SourceExport("*", "*", reference));
        } else {
          const close = end - 1;
          for (let j = i + 2; j < close; j++) {
            if (t[j].value === ",") continue;
            if (t[j].kind !== "identifier") throw new SourceReadError(this.file, t[j].offset, "unsupported export binding");
            const local = t[j].value;
            const alias = t[j + 1]?.value === "as" ? t[j + 2]?.value : local;
            this.exports.push(new SourceExport(alias, local, reference, t[j]));
            j += t[j + 1]?.value === "as" ? 2 : 0;
          }
        }
      }
      if (token.kind === "identifier" && token.value === "export" && previous !== ".") {
        let start = i + 1;
        const isDefault = t[start]?.value === "default";
        if (isDefault) start++;
        if (t[start]?.value === "async") start++;
        if (["class", "function"].includes(t[start]?.value)) {
          const nameToken = t[start + (t[start + 1]?.value === "*" ? 2 : 1)];
          if (nameToken?.kind === "identifier") this.exports.push(new SourceExport(isDefault ? "default" : nameToken.value,
            nameToken.value, null, nameToken));
        } else if (["const", "let", "var"].includes(t[start]?.value) && t[start + 1]?.kind === "identifier") {
          let end = start + 1;
          while (end < t.length && t[end].value !== ";") {
            if (["(", "[", "{"].includes(t[end].value)) end = matching(t, end, t[end].value,
              { "(": ")", "[": "]", "{": "}" }[t[end].value]);
            end++;
          }
          for (const part of readCommaSeparated(t, start + 1, end)) if (part[0]?.kind === "identifier") {
            this.exports.push(new SourceExport(part[0].value, part[0].value, null, part[0]));
          }
        }
      }
      if (!lexicalOnly && token.kind === "identifier" && token.value === "class") {
        let cursor = i + 1;
        const name = t[cursor]?.kind === "identifier" && t[cursor].value !== "extends" ? t[cursor++].value : null;
        const hasParent = t[cursor]?.value === "extends";
        const parent = hasParent ? t[cursor + 1]?.value : null;
        if (hasParent && (t[cursor + 1]?.kind !== "identifier" || t[cursor + 2]?.value !== "{")) throw new SourceReadError(this.file, token.offset, "unsupported class heritage");
        let open = hasParent ? cursor + 2 : cursor;
        while (open < t.length && t[open].value !== "{" && t[open].value !== ";") open++;
        if (t[open]?.value !== "{") throw new SourceReadError(this.file, token.offset, "unsupported class declaration");
        const close = matching(t, open);
        const dependencies = [];
        const argumentTypes = [];
        let depth = 1;
        for (let j = open + 1; j < close; j++) {
          if (t[j].kind === "punctuation" && t[j].value === "{") { depth++; continue; }
          if (t[j].kind === "punctuation" && t[j].value === "}") { depth--; continue; }
          if (depth !== 1) continue;
          if (t[j].value !== "static" || !["dependencies", "argumentTypes"].includes(t[j + 1]?.value)) continue;
          const target = t[j + 1].value === "dependencies" ? dependencies : argumentTypes;
          if (t[j + 2]?.value !== "=" || t[j + 3]?.value !== "[") throw new SourceReadError(this.file, t[j].offset, `unsupported ${t[j + 1].value} declaration`);
          const end = matching(t, j + 3, "[", "]");
          for (let k = j + 4; k < end; k++) {
            if (t[k].value === ",") continue;
            if (t[k].kind !== "identifier") throw new SourceReadError(this.file, t[k].offset, `${t[j + 1].value} must be static identifiers`);
            target.push(t[k].value);
          }
        }
        const exported = t[i - 1]?.value === "export" || (t[i - 2]?.value === "export" && t[i - 1]?.value === "default");
        this.classes.push(new SourceClass(name, parent, hasParent ? t[cursor + 1] : null, token, dependencies, argumentTypes, exported));
      }
    }
    if (!lexicalOnly) this.globals = this.#bindings().unbound(watchedGlobals);
  }
}
