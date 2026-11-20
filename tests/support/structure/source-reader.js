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

/** Regex source is data: keep escapes and flags without compiling the pattern. */
export class SourceRegexToken extends SourceToken {
  constructor(pattern, flags, offset, line, column) {
    if (typeof pattern !== "string" || typeof flags !== "string") throw new TypeError("regex source metadata required");
    super("<regex>", "literal", offset, line, column);
    this.pattern = pattern;
    this.flags = flags;
  }
  sameSource(other) {
    return other instanceof SourceRegexToken && this.pattern === other.pattern && this.flags === other.flags;
  }
}

/** Own the token order without changing the caller's array or token metadata. */
export function immutableSourceTokens(tokens) {
  if (!Array.isArray(tokens)) throw new TypeError("source tokens required");
  for (const token of tokens) if (!(token instanceof SourceToken)) throw new TypeError("source token required");
  return Object.isFrozen(tokens) ? tokens : Object.freeze([...tokens]);
}

/** Literal text and expressions retain their original coordinates in one lexer. */
export class SourceTemplateChunk extends SourceToken {
  constructor(value, raw, offset, line, column) {
    super(value, "template-chunk", offset, line, column);
    this.raw = raw;
  }
}

export class SourceTemplateInterpolation {
  constructor(token, tokens, endToken) {
    if (!(token instanceof SourceToken) || !Array.isArray(tokens) || !(endToken instanceof SourceToken)) {
      throw new TypeError("invalid template interpolation");
    }
    this.token = token;
    this.tokens = tokens;
    this.endToken = endToken;
  }
}

export class SourceTemplateToken extends SourceToken {
  constructor(offset, line, column) {
    super("<template>", "literal", offset, line, column);
    this.chunks = [];
    this.interpolations = [];
    this.endToken = null;
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
  constructor(name, heritage, token, dependencies, argumentTypes, exported) {
    if (heritage !== null && !(heritage instanceof SourceClassHeritage)) throw new TypeError("source class heritage required");
    this.name = name;
    this.heritage = heritage;
    this.parent = heritage?.identifier ?? null;
    this.parentToken = heritage?.token ?? null;
    this.token = token;
    this.dependencies = dependencies;
    this.argumentTypes = argumentTypes;
    this.exported = exported;
  }
}

/** Preserve an extends expression without pretending it is a simple type binding. */
export class SourceClassHeritage {
  constructor(tokens) {
    if (!Array.isArray(tokens) || tokens.length === 0) throw new TypeError("source heritage expression required");
    this.tokens = immutableSourceTokens(tokens);
    this.token = this.tokens[0];
    Object.freeze(this);
  }
  get identifier() { return this.tokens.length === 1 && this.token.kind === "identifier" ? this.token.value : null; }
  toString() { return this.tokens.map(token => token.value).join(" "); }
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
  #bodyOwnership = null;
  constructor(name, tokens, prefix = []) {
    if (!name || !Array.isArray(tokens) || tokens.length === 0) throw new TypeError("invalid source declaration");
    this.name = name;
    this.tokens = immutableSourceTokens(tokens);
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
  get lexicalThis() { return topLevelArrow(this.tokens) >= 0; }
  expressionBodyTokens() {
    const arrow = topLevelArrow(this.tokens);
    return arrow >= 0 && this.tokens[arrow + 1]?.value !== "{" ? this.tokens.slice(arrow + 1) : null;
  }
  bodyTokens() {
    const arrow = topLevelArrow(this.tokens);
    let open;
    if (arrow >= 0) open = arrow + 1;
    else {
      const parameters = this.tokens.findIndex((token) => token.value === "(");
      if (parameters < 0) return null;
      open = matching(this.tokens, parameters, "(", ")") + 1;
    }
    return this.tokens[open]?.value === "{" ? this.tokens.slice(open + 1, matching(this.tokens, open)) : null;
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
    return body !== null && sourceContainsSequence(body, source);
  }
  #ownedBody() {
    return this.#bodyOwnership ??= readLexicalBindings(this.tokens, [], this.name).bodyOwnership();
  }
  ownsBodyToken(token) {
    const body = this.bodyTokens();
    if (body === null || body.length === 0) return false;
    return this.#ownedBody().ownsToken(body, token);
  }
  returns() {
    const body = this.bodyTokens();
    if (body === null) return [];
    const owned = new Set(this.#ownedBody().returnTokens(body));
    const result = [];
    for (let index = 0; index < body.length; index++) {
      if (!owned.has(body[index]) || body[index].kind !== "identifier" || body[index].value !== "return"
        || body[index - 1]?.value === "." || body[index + 1]?.value === ":") continue;
      let depth = 0;
      let end = index + 1;
      const restrictedLineBreak = body[end]?.line > body[index].line;
      for (; !restrictedLineBreak && end < body.length; end++) {
        if (body[end].kind !== "punctuation") continue;
        if (["(", "[", "{"].includes(body[end].value)) depth++;
        if ([")", "]", "}"].includes(body[end].value)) {
          if (depth === 0) break;
          depth--;
        }
        if (depth === 0 && body[end].value === ";") break;
      }
      result.push(new SourceReturn(body[index], index, body.slice(index + 1, end)));
      index = restrictedLineBreak ? index : end;
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

/** One recognized CommonJS assignment and the exports produced by that syntax. */
export class SourceCommonJsExport {
  constructor(module, target, token, value, exports) {
    if (!(module instanceof SourceModule) || !(target instanceof SourceInitializer)
      || !(value instanceof SourceInitializer) || !(token instanceof SourceToken)
      || token.kind !== "punctuation" || token.value !== "="
      || target.tokens.length === 0 || value.tokens.length === 0
      || target.token !== target.tokens[0] || value.token !== value.tokens[0]
      || module.tokens[target.index + target.tokens.length] !== token
      || module.tokens[value.index - 1] !== token
      || target.tokens.some((entry, index) => module.tokens[target.index + index] !== entry)
      || value.tokens.some((entry, index) => module.tokens[value.index + index] !== entry)
      || !Array.isArray(exports) || exports.some(entry => !(entry instanceof SourceExport) || !module.exports.includes(entry))) {
      throw new TypeError("invalid source CommonJS export assignment");
    }
    this.file = module.file;
    this.target = target;
    this.token = token;
    this.value = value;
    this.exports = Object.freeze([...exports]);
    Object.freeze(this);
  }
}

export class SourceReturn extends SourceInitializer {}

function sameTokens(actual, expected) {
  return actual !== null && actual.length === expected.length
    // Patterns may explicitly leave prose unconstrained, but never expressions,
    // calls, identifiers, or control literals such as Step IDs and action IDs.
    && actual.every((token, index) => expected[index].kind === "identifier" && expected[index].value === "$STRING_LITERAL"
      ? token.kind === "string"
      : token.value === expected[index].value && token.kind === expected[index].kind
        && (!(token instanceof SourceRegexToken || expected[index] instanceof SourceRegexToken)
          || token instanceof SourceRegexToken && token.sameSource(expected[index])));
}

/** Match source grammar using the shared lexer, never source-text substring rules. */
export function sourceContainsSequence(tokens, source) {
  const expected = readTokens(source);
  return tokens.some((_, index) => sameTokens(tokens.slice(index, index + expected.length), expected));
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
        const pattern = source.slice(offset + 1, index - 1);
        const flagsStart = index;
        while (identifierPart.test(source[index] ?? "")) advance();
        tokens.push(new SourceRegexToken(pattern, source.slice(flagsStart, index), offset, startLine, startColumn));
        return;
      }
    }
    error("unterminated regular expression");
  }
  function template() {
    const opener = new SourceTemplateToken(index, line, column);
    advance();
    tokens.push(opener);
    let offset = index; let startLine = line; let startColumn = column;
    let value = "";
    const chunk = () => opener.chunks.push(new SourceTemplateChunk(value, source.slice(offset, index), offset, startLine, startColumn));
    while (index < source.length) {
      const char = source[index];
      if (char === "\\") {
        advance();
        if (index >= source.length) error("unterminated template escape");
        const escaped = advance();
        if (escaped === "u" || escaped === "x") {
          const count = escaped === "u" ? 4 : 2;
          const digits = source.slice(index, index + count);
          if (!new RegExp(`^[0-9a-fA-F]{${count}}$`).test(digits)) error("unsupported template escape");
          for (let i = 0; i < count; i++) advance();
          value += String.fromCodePoint(Number.parseInt(digits, 16));
        } else value += ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0", "\n": "" })[escaped] ?? escaped;
        continue;
      }
      if (char === "`") {
        chunk();
        opener.endToken = new SourceToken("<template-end>", "literal", index, line, column);
        advance(); tokens.push(opener.endToken); return;
      }
      if (char === "$" && source[index + 1] === "{") {
        chunk();
        const token = new SourceToken("${", "template-boundary", index, line, column);
        advance(); advance();
        const start = tokens.length;
        scan(true);
        opener.interpolations.push(new SourceTemplateInterpolation(token, tokens.slice(start),
          new SourceToken("}", "template-boundary", index - 1, line, column - 1)));
        offset = index; startLine = line; startColumn = column; value = "";
        continue;
      }
      value += advance();
    }
    error("unterminated template");
  }
  function scan(interpolation = false) {
    const firstToken = tokens.length;
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
      if (char === "/" && (interpolation && tokens.length === firstToken
        || regexPrefixes.has(tokens.at(-1)?.value ?? "=") || tokens.at(-1)?.controlClose || tokens.at(-1)?.blockClose)) { regexp(); continue; }
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

export function matching(tokens, open, left = "{", right = "}") {
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
 * Token origins seed acquired local capabilities in their exact lexical scope.
 */
export class SourceOriginUsage {
  constructor(declaration, origins, { acceptBindings = true, bindings = null, mutableAliases = false, originTokens = [] } = {}) {
    if (!(declaration instanceof SourceDeclaration)) throw new TypeError("source declaration required");
    this.tokens = declaration.tokens;
    this.origins = new Set([...origins, ...originTokens.map((token) => token.value)]);
    this.bindings = bindings;
    this.originBindings = bindings === null ? null : new Set([
      ...[...origins].map((name) => bindings.moduleBinding(name)),
      ...originTokens.map((token) => bindings.bindingAt(token)),
    ].filter(Boolean));
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
function topLevelArrow(tokens) {
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value === "=>") return index;
    if (tokens[index].kind === "punctuation" && ["(", "[", "{"].includes(tokens[index].value)) {
      index = matching(tokens, index, tokens[index].value, { "(": ")", "[": "]", "{": "}" }[tokens[index].value]);
    }
  }
  return -1;
}

export function readParameters(tokens) {
  const arrow = topLevelArrow(tokens);
  if (arrow >= 0) {
    if (tokens[arrow - 1]?.kind === "identifier") return [[tokens[arrow - 1]]];
    if (tokens[arrow - 1]?.value !== ")") return [];
    const open = tokens.findIndex((token, index) => token.value === "(" && matching(tokens, index, "(", ")") === arrow - 1);
    return open < 0 ? [] : readCommaSeparated(tokens, open + 1, arrow - 1);
  }
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
  const bindings = parameters.map((parameter) => {
    if (parameter.length === 1 && parameter[0].kind === "identifier") return [parameter[0].value];
    if (parameter[0]?.value !== "{" || parameter.at(-1)?.value !== "}") return null;
    const members = readCommaSeparated(parameter, 1, parameter.length - 1);
    return members.every((member) => member.length === 1 && member[0].kind === "identifier")
      ? members.map((member) => member[0].value) : null;
  });
  if (bindings.some((binding) => binding === null)) return result;
  const names = new Set(bindings.flat());
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

export function readCommaSeparated(tokens, start, end) {
  const parts = [];
  let depth = 0;
  for (let index = start; index < end; index++) {
    if (tokens[index] instanceof SourceTemplateToken) {
      const close = tokens.indexOf(tokens[index].endToken, index + 1);
      if (close < 0 || close >= end) throw new SourceReadError("<source>", tokens[index].offset, "incomplete template literal");
      index = close;
      continue;
    }
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

/** The tokenizer retains the two punctuation tokens of optional access. */
export function optionalAccessEnd(tokens, index) {
  return tokens[index]?.value === "?" && tokens[index + 1]?.value === "."
    && tokens[index + 1].offset === tokens[index].offset + 1 ? index + 2 : index;
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
  const optionalEnd = optionalAccessEnd(tokens, cursor);
  if (optionalEnd !== cursor) cursor = optionalEnd;
  else if (tokens[cursor]?.value === ".") cursor++;
  else if (!["[", "("].includes(tokens[cursor]?.value)) return null;
  const token = tokens[cursor];
  if (!token) return new SourceMemberAccess(tokens[receiverIndex], null, false);
  if (token.kind !== "identifier") return new SourceMemberAccess(token, null, false);
  const call = optionalAccessEnd(tokens, cursor + 1);
  return new SourceMemberAccess(token, token.value, tokens[call]?.value === "(");
}

/** Read the lvalue before '=', a postfix update, or a for-in/of separator.
 * An arrow-valued RHS cannot hide its receiver; compound punctuation is contiguous.
 */
export function readAssignmentTarget(tokens, index) {
  const first = tokens[index];
  const iteration = first?.kind === "identifier" && ["in", "of"].includes(first.value);
  if (!iteration && first?.kind !== "punctuation" || iteration && tokens[index - 1]?.value === ".") return null;
  let end = index;
  if (!iteration && first.value === "=") {
    if (["=", ">"].includes(tokens[index + 1]?.value)) return null;
    while (tokens[end - 1]?.kind === "punctuation" && "=!-+*/%&|^?<>".includes(tokens[end - 1].value)
      && tokens[end - 1].offset + tokens[end - 1].value.length === tokens[end].offset) end--;
    const operator = tokens.slice(end, index + 1).map(token => token.value).join("");
    if (!["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=", "??="].includes(operator)
      || tokens[end - 1]?.kind === "punctuation" && "=!-+*/%&|^?<>".includes(tokens[end - 1].value)) return null;
  } else if (!iteration && (!["+", "-"].includes(first.value) || tokens[index + 1]?.value !== first.value
    || first.offset + 1 !== tokens[index + 1].offset
    || tokens[index - 1]?.line !== first.line)) return null;
  let start = end, depth = 0;
  for (let cursor = end - 1; cursor >= 0; cursor--) {
    const token = tokens[cursor];
    if (depth === 0 && [";", "{", "}", "(", "[", "=", ",", ":", "?", "return", "throw", "yield"].includes(token.value)
      && !(token.value === "}" && cursor === end - 1)) break;
    if (token.kind === "punctuation" && [")", "]", "}"].includes(token.value)) depth++;
    else if (token.kind === "punctuation" && ["(", "[", "{"].includes(token.value)) depth--;
    start = cursor;
  }
  if (start === end) return null;
  if (iteration && (tokens[start - 1]?.value !== "(" || tokens[start - 2]?.value !== "for"
    && !(tokens[start - 2]?.value === "await" && tokens[start - 3]?.value === "for"))) return null;
  return new SourceInitializer(tokens[start], start, tokens.slice(start, end));
}

/** Shared for-header bounds; lexical scope and iteration read the same delimiters. */
class SourceForHead {
  constructor(startIndex, openIndex, closeIndex, asynchronous) {
    if (!Number.isInteger(startIndex) || openIndex <= startIndex || closeIndex <= openIndex
      || typeof asynchronous !== "boolean") throw new TypeError("source for-header required");
    Object.assign(this, { startIndex, openIndex, closeIndex, asynchronous });
    Object.freeze(this);
  }
  static read(tokens, start = 0) {
    if (tokens[start]?.kind !== "identifier" || tokens[start].value !== "for" || tokens[start - 1]?.value === ".") return null;
    const asynchronous = tokens[start + 1]?.value === "await";
    const open = start + (asynchronous ? 2 : 1);
    if (tokens[open]?.value !== "(") return null;
    return new this(start, open, matching(tokens, open, "(", ")"), asynchronous);
  }
}

/** A braced for-of keeps binding, iterable and body identities without proving its iterator. */
export class SourceForOf {
  constructor(header, separator, target, iterable, bodyIndex, endIndex, bodyTokens) {
    if (!(header instanceof SourceForHead) || !(separator instanceof SourceToken) || separator.value !== "of"
      || !(target instanceof SourceInitializer) || !(iterable instanceof SourceInitializer)
      || bodyIndex !== header.closeIndex + 1 || endIndex <= bodyIndex || !Array.isArray(bodyTokens)) {
      throw new TypeError("source for-of statement required");
    }
    Object.assign(this, { header, separator, target, iterable, bodyIndex, endIndex, bodyTokens });
    Object.freeze(this);
  }
  get asynchronous() { return this.header.asynchronous; }
  get declarationKind() { return ["const", "let", "var"].includes(this.target.tokens[0]?.value) ? this.target.tokens[0].value : null; }
  get bindingTokens() { return this.declarationKind === null ? this.target.tokens : this.target.tokens.slice(1); }
  static read(tokens, start = 0) {
    const header = SourceForHead.read(tokens, start);
    if (header === null || tokens[header.closeIndex + 1]?.value !== "{") return null;
    for (let index = header.openIndex + 1; index < header.closeIndex; index++) {
      const token = tokens[index];
      if (token instanceof SourceTemplateToken) { index = tokens.indexOf(token.endToken, index + 1); continue; }
      if (token.kind === "punctuation" && ["(", "[", "{"].includes(token.value)) {
        index = matching(tokens, index, token.value, { "(": ")", "[": "]", "{": "}" }[token.value]);
        continue;
      }
      if (token.value === ";" || token.kind === "identifier" && token.value === "in") return null;
      if (token.kind !== "identifier" || token.value !== "of") continue;
      const target = readAssignmentTarget(tokens, index);
      if (target === null || target.tokens.length === 1 && ["const", "let", "var"].includes(target.tokens[0].value)) continue;
      if (index + 1 === header.closeIndex) return null;
      const body = header.closeIndex + 1, end = matching(tokens, body);
      return new this(header, token, target,
        new SourceInitializer(tokens[index + 1], index + 1, tokens.slice(index + 1, header.closeIndex)),
        body, end, tokens.slice(body + 1, end));
    }
    return null;
  }
}

/** A balanced object-method signature, independent of whether its body is modeled. */
export class SourceObjectMethod {
  constructor(tokens, nameIndex, parametersEnd) {
    if (!Array.isArray(tokens) || !Number.isInteger(nameIndex) || !Number.isInteger(parametersEnd)
      || !(tokens[nameIndex] instanceof SourceToken)) throw new TypeError("source object method required");
    this.tokens = immutableSourceTokens(tokens);
    this.nameIndex = nameIndex;
    this.parametersEnd = parametersEnd;
    this.token = tokens[nameIndex];
    this.prefix = nameIndex > 0 && tokens[0].kind === "identifier" ? tokens[0] : null;
    this.generator = tokens[nameIndex - 1]?.value === "*";
    Object.freeze(this);
  }
  get declarationTokens() { return this.tokens.slice(0, this.nameIndex + 1); }
  declaration() {
    if (this.generator) return null;
    if (this.prefix && ["get", "set"].includes(this.prefix.value)) {
      return SourceObjectAccessor.isAccessor(this.tokens)
        ? new SourceObjectAccessor(this.token.value, this.tokens, this.prefix.value) : null;
    }
    return new SourceDeclaration(this.token.value, this.tokens.slice(this.nameIndex), this.prefix === null ? [] : [this.prefix]);
  }
  static read(part) {
    const prefix = part[0]?.kind === "identifier" && ["async", "get", "set"].includes(part[0].value)
      && (["identifier", "string", "number"].includes(part[1]?.kind)
        || part[0].value === "async" && part[1]?.kind === "punctuation" && part[1].value === "*") ? part[0] : null;
    let start = prefix === null ? 0 : 1;
    if (part[start]?.kind === "punctuation" && part[start].value === "*") start++;
    if (!["identifier", "string", "number"].includes(part[start]?.kind)
      || part[start + 1]?.kind !== "punctuation" || part[start + 1].value !== "(") return null;
    const end = matching(part, start + 1, "(", ")");
    if (part[end + 1]?.kind !== "punctuation" || part[end + 1].value !== "{"
      || matching(part, end + 1) !== part.length - 1) return null;
    return new this(part, start, end);
  }
}

/** Read one statically named object property or method, rejecting duplicate slots. */
export function readObjectProperty(tokens, name) {
  const open = tokens.findIndex((token) => token.kind === "punctuation" && token.value === "{");
  if (open < 0) return null;
  const matches = [];
  for (const part of readCommaSeparated(tokens, open + 1, matching(tokens, open))) {
    const token = part[0];
    if (["identifier", "string", "number"].includes(token?.kind) && token.value === name
      && part[1]?.kind === "punctuation" && part[1].value === ":") {
      matches.push(new SourceInitializer(token, tokens.indexOf(token), part.slice(2)));
    } else if (part.length === 1 && token.kind === "identifier" && token.value === name) {
      matches.push(new SourceInitializer(token, tokens.indexOf(token), [token]));
    } else {
      const method = SourceObjectMethod.read(part);
      // Every same-name slot counts, including unsupported generators/accessors.
      if (method?.token.value === name) matches.push(method.declaration());
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

/** An object spread carries expressions; it is not computed member access. */
export class SourceObjectSpread extends SourceInitializer {}

/** Accessor bodies remain inspectable without treating their slots as data. */
export class SourceObjectAccessor extends SourceDeclaration {
  constructor(name, tokens, kind) {
    if (!Array.isArray(tokens) || !SourceObjectAccessor.isAccessor(tokens)
      || tokens[0].value !== kind || tokens[1].value !== name) throw new TypeError("invalid source object accessor");
    super(name, tokens);
    this.kind = kind;
  }
  static isAccessor(tokens) {
    if (tokens[0]?.kind !== "identifier" || !["get", "set"].includes(tokens[0].value)
      || !["identifier", "string"].includes(tokens[1]?.kind) || tokens[2]?.value !== "(") return false;
    const parametersEnd = matching(tokens, 2, "(", ")");
    return tokens[parametersEnd + 1]?.value === "{" && matching(tokens, parametersEnd + 1) === tokens.length - 1
      && readCommaSeparated(tokens, 3, parametersEnd).length === (tokens[0].value === "get" ? 0 : 1);
  }
}

/** Ordered data/method slots. Accessor slots stay opaque, with inspectable bodies. */
export class SourceObjectMembers {
  constructor(tokens) {
    this.entries = [];
    this.callableDeclarationTokens = [];
    this.accessors = [];
    this.unresolvedEntries = [];
    this.complete = true;
    const unresolved = (part) => {
      this.complete = false;
      if (part.length > 0) this.unresolvedEntries.push(new SourceInitializer(part[0], tokens.indexOf(part[0]), part));
    };
    const open = tokens.findIndex((token) => token.kind === "punctuation" && token.value === "{");
    if (open < 0) { unresolved(tokens); return; }
    const names = new Set();
    for (const part of readCommaSeparated(tokens, open + 1, matching(tokens, open))) {
      const method = SourceObjectMethod.read(part);
      if (method !== null) this.callableDeclarationTokens.push(...method.declarationTokens);
      if (["get", "set"].includes(part[0]?.value) && ["identifier", "string"].includes(part[1]?.kind)
        && part[2]?.value === "(") {
        if (SourceObjectAccessor.isAccessor(part)) {
          this.accessors.push(new SourceObjectAccessor(part[1].value, part, part[0].value));
        } else unresolved(part);
        this.complete = false;
        continue;
      }
      if (part.length > 3 && part.slice(0, 3).every((token) => token.kind === "punctuation" && token.value === ".")) {
        this.entries.push(new SourceObjectSpread(part[0], tokens.indexOf(part[0]), part.slice(3)));
        continue;
      }
      const key = part[0]?.value === "async" && part[1]?.kind === "identifier" ? part[1] : part[0];
      const name = key?.value;
      const property = key && ["identifier", "string"].includes(key.kind) && name !== "__proto__"
        ? readObjectProperty(tokens, name) : null;
      if (property === null || names.has(name)) { unresolved(part); continue; }
      names.add(name);
      this.entries.push(property);
    }
  }
}

/** Object-copy reads, distinguished from declaration/assignment rest targets. */
export class SourceObjectCopies {
  #copies = new Map();
  constructor(module) {
    if (!(module instanceof SourceModule)) throw new TypeError("source module required");
    const tokens = module.tokens;
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index].kind !== "punctuation" || tokens[index].value !== "{") continue;
      const end = matching(tokens, index);
      // The right-hand side owns destructuring effects; rest is a write here.
      if (tokens[end + 1]?.value === "=") continue;
      for (const member of new SourceObjectMembers(tokens.slice(index, end + 1)).entries) {
        if (!(member instanceof SourceObjectSpread)) continue;
        const leaf = member.tokens.length === 1 ? member.tokens[0] : null;
        const binding = leaf?.kind === "identifier" ? module.bindingAt(leaf) : null;
        if (binding && (!module.bindingReferences(binding).includes(leaf)
          || module.bindingWrites([binding]).some(write => write.token === leaf))) continue;
        this.#copies.set(member.token, member);
      }
    }
  }
  get entries() { return [...this.#copies.values()]; }
  at(token) { return this.#copies.get(token); }
}

/** Syntax-only callable ownership shared by complete modules and token views. */
class SourceCallableDeclarations {
  constructor(tokens) {
    this.callableTokens = new Set();
    this.classMemberTokens = new Set();
    const nestedObjects = new Set();
    const alternateColons = new Set();
    for (let index = 0; index < tokens.length; index++) {
      const alternate = SourceConditionalExpression.matchingAlternate(tokens, index);
      if (alternate >= 0) alternateColons.add(tokens[alternate]);
    }
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const object = token.kind === "punctuation" && token.value === "{"
        ? nestedObjects.has(token) ? new SourceObjectPrimary(i, matching(tokens, i)) : SourceObjectPrimary.read(tokens, i, alternateColons) : null;
      if (object !== null) {
        const members = new SourceObjectMembers(tokens.slice(i, object.endIndex + 1));
        for (const declarationToken of members.callableDeclarationTokens) this.callableTokens.add(declarationToken);
        for (const property of members.entries) if (property instanceof SourceInitializer && !(property instanceof SourceObjectSpread)) {
          const expression = unwrapCondition(property.tokens);
          if (expression[0]?.kind === "punctuation" && expression[0].value === "{") nestedObjects.add(expression[0]);
        }
      }
      if (token.kind !== "identifier") continue;
      if (token.value === "class" && tokens[i - 1]?.value !== "."
        && (tokens[i + 1]?.kind === "identifier" || tokens[i + 1]?.value === "{")) {
        const primary = SourceBodyPrimary.read(tokens, i);
        if (primary !== null) {
          const members = new SourceClassMembers(primary.declaration);
          for (const member of members.memberNameTokens) this.classMemberTokens.add(member);
          for (const member of members.callableDeclarationTokens) this.callableTokens.add(member);
        }
      }
      if (token.value === "function") {
        const primary = SourceBodyPrimary.read(tokens, i);
        const name = tokens[i + (tokens[i + 1]?.value === "*" ? 2 : 1)];
        if (primary !== null && name?.kind === "identifier") this.callableTokens.add(name);
      }
    }
  }
}

/** Read named calls without executing the composition module. */
export function readInvocations(module) {
  const tokens = module.tokens;
  const declarations = new SourceCallableDeclarations(tokens);
  const result = [];
  for (let index = 0; index < tokens.length - 1; index++) {
    const token = tokens[index];
    if (token.kind !== "identifier" || tokens[index + 1].value !== "(" || [".", "function"].includes(tokens[index - 1]?.value)) continue;
    const close = matching(tokens, index + 1, "(", ")");
    if (declarations.callableTokens.has(token) || tokens[close].controlClose || SourceBodyPrimary.read(tokens, index) !== null) continue;
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

/** A field initializer retains its lexical property identity separately from its value. */
export class SourceClassFieldInitializer extends SourceDeclaration {
  constructor(owner, name, token, tokens, isStatic) {
    if (typeof owner !== "string" || name !== null && typeof name !== "string"
      || !(token instanceof SourceToken) || typeof isStatic !== "boolean") throw new TypeError("source class field identity required");
    super(`${owner}.${name ?? "[computed]"}`, tokens);
    this.fieldName = name;
    this.fieldToken = token;
    this.isStatic = isStatic;
  }
}

export class SourceClassAccessor extends SourceDeclaration {
  constructor(owner, name, tokens, kind) {
    if (typeof owner !== "string" || typeof name !== "string" || !["get", "set"].includes(kind)) throw new TypeError("source class accessor required");
    super(`${owner}.${name}`, tokens);
    this.fieldName = name;
    this.kind = kind;
  }
}

/** Members and eager class expressions share one balanced extraction pass. */
export class SourceClassMembers {
  constructor(declaration) {
    if (!(declaration instanceof SourceDeclaration) || declaration.token.value !== "class") throw new TypeError("class declaration required");
    this.instanceMembers = new Map();
    this.staticMembers = new Map();
    this.instanceAccessors = [];
    this.staticAccessors = [];
    this.memberNameTokens = [];
    this.callableDeclarationTokens = [];
    this.instanceInitializers = [];
    this.moduleInitializers = [];
    this.unresolvedInstanceMembers = [];
    this.unresolvedStaticMembers = [];
    const tokens = declaration.tokens;
    const primary = SourceBodyPrimary.read(tokens);
    if (primary === null) throw new SourceReadError(declaration.name, declaration.token.offset, "class body required");
    const open = primary.bodyIndex;
    let index = open + 1;
    while (index < tokens.length - 1) {
      if (tokens[index].value === ";") { index++; continue; }
      const declarationStart = index;
      let isStatic = tokens[index].value === "static" && !["(", "=", ";", "}"].includes(tokens[index + 1]?.value);
      const members = isStatic ? this.staticMembers : this.instanceMembers;
      if (isStatic) index++;
      if (isStatic && tokens[index]?.value === "{") {
        const end = matching(tokens, index);
        this.moduleInitializers.push(new SourceDeclaration(`${declaration.name}.<static:${tokens[index].offset}>`, tokens.slice(index, end + 1)));
        index = end + 1;
        continue;
      }
      const accessorKind = ["get", "set"].includes(tokens[index]?.value) && tokens[index + 1]?.kind === "identifier"
        && tokens[index + 2]?.value === "(" ? tokens[index].value : null;
      if (["get", "set", "async"].includes(tokens[index]?.value)
        && (tokens[index + 1]?.kind === "identifier" || ["*", "["].includes(tokens[index + 1]?.value))) index++;
      if (tokens[index]?.value === "*") index++;
      const start = index;
      if (tokens[index]?.kind === "identifier") this.memberNameTokens.push(tokens[index]);
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
        this.callableDeclarationTokens.push(...tokens.slice(declarationStart, start));
        if (tokens[start].kind === "identifier") this.callableDeclarationTokens.push(tokens[start]);
        if (name !== null) {
          const member = accessorKind === null ? new SourceDeclaration(`${declaration.name}.${name}`, tokens.slice(start, end + 1))
            : new SourceClassAccessor(declaration.name, name, tokens.slice(start, end + 1), accessorKind);
          if (accessorKind !== null) (isStatic ? this.staticAccessors : this.instanceAccessors).push(member);
          if (!members.has(name)) members.set(name, member);
        }
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
        new SourceClassFieldInitializer(declaration.name, name, tokens[start], value, isStatic));
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

/** Runtime inputs are supplied by a caller or a caught exception, not an initializer. */
export class SourceInputBinding extends SourceLexicalBinding {}

class SourceLexicalScope {
  constructor(parent, start, end) {
    this.parent = parent;
    this.start = start;
    this.end = end;
    this.bindings = new Map();
    this.callable = false;
  }
  bind(name, Binding = SourceLexicalBinding) {
    if (!this.bindings.has(name)) this.bindings.set(name, new Binding(name));
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

/** A write to a lexical reference with no local/module binding. */
export class SourceUnboundWrite {
  constructor(token) {
    if (!(token instanceof SourceToken) || token.kind !== "identifier") throw new TypeError("unbound write token required");
    this.token = token;
    this.name = token.value;
    Object.freeze(this);
  }
}

/** Nominal callable ownership, without retaining a lexical scope or its bindings. */
class SourceBodyOwner {
  constructor() { Object.freeze(this); }
}

/** The existing lexical reader supplies every ownership decision. This projection
 * retains only token identities and owner equality for body/return queries. */
class SourceBodyOwnership {
  #tokens;
  #owners;
  #root;
  #returns;
  constructor(tokens, scopes, root) {
    if (!(root instanceof SourceLexicalScope) || scopes.length !== tokens.length
      || scopes.some(scope => !(scope instanceof SourceLexicalScope))) throw new TypeError("lexical body owners required");
    const owners = new Map();
    const identity = scope => {
      if (!owners.has(scope)) owners.set(scope, new SourceBodyOwner());
      return owners.get(scope);
    };
    this.#tokens = immutableSourceTokens(tokens);
    this.#root = identity(root);
    this.#owners = Object.freeze(scopes.map(identity));
    this.#returns = new Map(tokens.flatMap((token, index) => token.value === "return" ? [[token, this.#owners[index]]] : []));
    Object.freeze(this);
  }
  #owner(index) { return this.#owners[index] ?? this.#root; }
  returnTokens(body) {
    if (body.length === 0) return [];
    const owner = this.#owner(this.#tokens.indexOf(body[0]));
    return body.filter(token => this.#returns.get(token) === owner);
  }
  ownsToken(body, token) {
    const index = this.#tokens.indexOf(token);
    return index >= 0 && body.includes(token)
      && this.#owner(index) === this.#owner(this.#tokens.indexOf(body[0]));
  }
}

/** One lexical index serves global reads and opt-in module binding accounting. */
class SourceLexicalBindings {
  #bodyOwnership = null;
  constructor(root, tokens, scopes, declarationBindings, references, globalReferences, exports, classSelfBindings, callableDeclarationTokens) {
    this.root = root;
    this.tokens = tokens;
    this.scopes = scopes;
    this.declarations = declarationBindings;
    this.classSelfBindings = classSelfBindings;
    this.callableDeclarationTokens = callableDeclarationTokens;
    this.references = new Map();
    for (const index of references) this.references.set(tokens[index].offset, scopes[index].resolve(tokens[index].value));
    this.exports = exports;
    this.globalReferences = globalReferences;
    this.writes = null;
    this.writesByBinding = null;
    this.globalWrites = null;
  }
  #returnScope(index) {
    let scope = this.scopes[index];
    while (scope?.parent && !scope.callable) scope = scope.parent;
    return scope ?? this.root;
  }
  bodyOwnership() {
    return this.#bodyOwnership ??= new SourceBodyOwnership(this.tokens,
      this.tokens.map((_, index) => this.#returnScope(index)), this.root);
  }
  returnTokens(body) { return this.bodyOwnership().returnTokens(body); }
  ownsToken(body, token) { return this.bodyOwnership().ownsToken(body, token); }
  moduleBinding(name) { return this.root.bindings.get(name) ?? null; }
  bindingAt(token) {
    return this.declarations.get(token.offset) ?? this.references.get(token.offset) ?? this.exports.get(token.offset) ?? null;
  }
  bindingWrites(selectors) {
    if (this.writes === null) {
      this.writes = this.#readWrites();
      this.writesByBinding = new Map();
      for (const write of this.writes) {
        if (!this.writesByBinding.has(write.binding)) this.writesByBinding.set(write.binding, []);
        this.writesByBinding.get(write.binding).push(write);
      }
    }
    const selected = new Set([...selectors].map((selector) => selector instanceof SourceLexicalBinding
      ? selector : this.moduleBinding(selector)).filter(Boolean));
    if (selected.size === 1) return [...(this.writesByBinding.get([...selected][0]) ?? [])];
    return this.writes.filter((write) => selected.has(write.binding));
  }
  unboundWrites() {
    if (this.writes === null) this.bindingWrites([]);
    return [...this.globalWrites];
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
    const globals = new Set();
    const add = (token) => {
      if (!token || !this.references.has(token.offset)) return;
      if (this.references.get(token.offset)) offsets.add(token.offset);
      else if (this.globalReferences.has(token.offset)) globals.add(token.offset);
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
        const target = readAssignmentTarget(tokens, index);
        if (target !== null && !["const", "let", "var"].includes(target.tokens[0]?.value)) targets(target.tokens);
        continue;
      }
      const end = index - 1;
      const start = pairs.get(end) ?? end;
      if (start > end) continue;
      const previous = tokens[start - 1];
      if (previous?.kind === "identifier" && !["return", "yield", "await"].includes(previous.value)
        || [")", "]", "."].includes(previous?.value)) continue;
      targets(tokens.slice(start, end + 1));
    }
    this.globalWrites = tokens.filter(token => globals.has(token.offset)).map(token => new SourceUnboundWrite(token));
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
  const classSelfBindings = new Map();
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
    const header = SourceForHead.read(tokens, index);
    if (header === null) continue;
    const { openIndex: open, closeIndex: close } = header;
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
  const memberNames = new Set();
  const syntax = new SourceCallableDeclarations(tokens);
  const callableDeclarationTokens = syntax.callableTokens;
  for (const token of syntax.classMemberTokens) memberNames.add(token.offset);
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
  const parameterScopes = new Map();
  const bindParameters = (open, close, scope, callable = true) => {
    scope.callable = callable;
    // Defaults can reference formal inputs but cannot see body declarations.
    // Keep nested initializer scopes, linking them through this same header.
    let parameters = parameterScopes.get(open);
    if (!parameters) {
      const parent = scope.parent;
      parameters = new SourceLexicalScope(parent, open + 1, close);
      parameterScopes.set(open, parameters);
      for (let cursor = open + 1; cursor < close; cursor++) {
        if (scopes[cursor] === parent) scopes[cursor] = parameters;
        const nested = braceScopes.get(cursor);
        if (nested?.parent === parent) nested.parent = parameters;
      }
      scope.parent = parameters;
    }
    for (const j of bindingIndexes(open + 1, close)) {
      declarationBindings.set(tokens[j].offset, parameters.bind(tokens[j].value, SourceInputBinding));
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
    if (token.kind === "identifier" && token.value === "class" && tokens[i - 1]?.value !== "."
      && (tokens[i + 1]?.kind === "identifier" || tokens[i + 1]?.value === "{")) {
      const primary = SourceBodyPrimary.read(tokens, i);
      if (primary !== null) {
        if (tokens[i + 1]?.kind === "identifier" && tokens[i + 1].value !== "extends") {
          const name = tokens[i + 1].value;
          declarations.add(i + 1);
          const local = braceScopes.get(primary.bodyIndex)?.bind(name);
          if (local) classSelfBindings.set(token, local);
          const binding = primary.isDeclaration(tokens) ? scopes[i].bind(name) : local;
          declarationBindings.set(tokens[i + 1].offset, binding);
        }
      }
    }
    if (token.value === "catch" && tokens[i + 1]?.value === "(") {
      const close = matching(tokens, i + 1, "(", ")");
      const body = braceScopes.get(close + 1);
      if (body) bindParameters(i + 1, close, body, false);
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
    if (token.value === "(" && callableDeclarationTokens.has(tokens[i - 1])) {
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
    if (token.kind !== "identifier" || declarations.has(i) || memberNames.has(token.offset)) continue;
    const previous = tokens[i - 1]?.value;
    const spread = previous === "." && tokens[i - 2]?.value === "." && tokens[i - 3]?.value === ".";
    if (previous === "." && !spread || previous === "#") continue;
    const beforeColon = tokens[i + 1]?.value === ":";
    if (beforeColon && ["{", ","].includes(previous)) continue;
    if (callableDeclarationTokens.has(token)) continue;
    referenceIndexes.push(i);
    // Preserve the existing global-read contract; module binding accounting
    // additionally recognizes the reference in a conditional's middle arm.
    if (!beforeColon) globalReferences.add(token.offset);
  }
  return new SourceLexicalBindings(root, tokens, scopes, declarationBindings, referenceIndexes, globalReferences, exportedBindings, classSelfBindings, callableDeclarationTokens);
}

export class SourceModule {
  constructor(file, source, { lexicalOnly = false } = {}) {
    this.file = file;
    this.tokens = Object.freeze(readTokens(source, file));
    this.references = [];
    this.templates = this.tokens.filter((token) => token instanceof SourceTemplateToken);
    this.exports = [];
    this.commonJsExports = [];
    this.classes = [];
    this.dynamic = [];
    this.globals = [];
    this.unboundNames = new Map();
    this.declarations = new Map();
    this.declarationHeaders = null;
    this.classMemberIndex = new Map();
    this.lexicalBindings = null;
    this.bindingReferenceTokens = new Map();
    this.bindingDeclarationTokens = new Map();
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
    this.declarationNames();
    return this.declarationHeaders.get(name) ?? null;
  }

  declarationNames() {
    if (this.declarationHeaders === null) this.declarationHeaders = readDeclarationHeaders(this);
    return this.declarationHeaders.keys();
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

  isCallableDeclarationToken(token) { return this.#bindings().callableDeclarationTokens.has(token); }
  bindingAt(token) { return this.#bindings().bindingAt(token); }
  moduleBinding(name) { return this.#bindings().moduleBinding(name); }
  classSelfBinding(declaration) {
    if (!(declaration instanceof SourceDeclaration) || declaration.token.value !== "class") throw new TypeError("source class declaration required");
    return this.#bindings().classSelfBindings.get(declaration.token) ?? null;
  }
  bindingReferences(name) {
    const binding = typeof name === "string" ? this.moduleBinding(name) : name;
    if (binding === null) return [];
    if (!this.bindingReferenceTokens.has(binding)) this.bindingReferenceTokens.set(binding,
      this.tokens.filter(token => this.#bindings().references.get(token.offset) === binding));
    return [...this.bindingReferenceTokens.get(binding)];
  }
  bindingWrites(selectors) { return this.#bindings().bindingWrites(selectors); }
  bindingDeclarations(binding) {
    if (!this.bindingDeclarationTokens.has(binding)) this.bindingDeclarationTokens.set(binding,
      this.tokens.filter(token => this.#bindings().declarations.get(token.offset) === binding));
    return [...this.bindingDeclarationTokens.get(binding)];
  }
  unboundWrites() { return this.#bindings().unboundWrites(); }

  originUsage(origins, { moduleBindings = false, ...options } = {}) {
    return new SourceOriginUsage(new SourceDeclaration(this.file, this.tokens), origins,
      { ...options, bindings: moduleBindings ? this.#bindings() : null });
  }

  referenceTokens(reference) {
    const start = this.tokens.findIndex((token) => token.offset === reference.token.offset);
    const specifier = this.tokens.findIndex((token, index) => index > start && token.kind === "string" && token.value === reference.specifier);
    return start >= 0 && specifier > start ? this.tokens.slice(start, specifier + 1) : [];
  }

  #readCommonJs() {
    const t = this.tokens;
    const requirements = new Map();
    for (let i = 0; i < t.length; i++) {
      const token = t[i];
      if (token.kind !== "identifier" || token.value !== "require" || !this.isUnbound("require", token)
        || t[i + 1]?.value !== "(") continue;
      const close = matching(t, i + 1, "(", ")");
      if (close !== i + 3 || t[i + 2]?.kind !== "string") { this.dynamic.push(token); continue; }
      const bindings = new Map();
      let imported = "*";
      if (t[close + 1]?.value === "." && t[close + 2]?.kind === "identifier") imported = t[close + 2].value;
      if (t[i - 1]?.value === "=") {
        if (t[i - 2]?.kind === "identifier" && ["const", "let"].includes(t[i - 3]?.value)) {
          bindings.set(t[i - 2].value, imported);
        } else if (t[i - 2]?.value === "}") {
          let open = i - 3;
          while (open >= 0 && t[open].value !== "{") open--;
          if (["const", "let"].includes(t[open - 1]?.value)) {
            for (const part of readCommaSeparated(t, open + 1, i - 2)) {
              if (part.length === 1 && part[0].kind === "identifier") bindings.set(part[0].value, part[0].value);
              else if (part.length === 3 && part[0].kind === "identifier" && part[1].value === ":"
                && part[2].kind === "identifier") bindings.set(part[2].value, part[0].value);
              else throw new SourceReadError(this.file, token.offset, "unsupported require binding");
            }
          }
        }
      }
      const reference = new SourceReference(t[i + 2].value, token, "require", bindings);
      this.references.push(reference);
      requirements.set(i, reference);
    }
    const exportValue = (name, start, end, token) => {
      const value = unwrapCondition(t.slice(start, end));
      if (value.length === 1 && value[0].kind === "identifier") {
        this.exports.push(new SourceExport(name, value[0].value, null, token));
      } else if (value[0]?.value === "require" && requirements.has(t.indexOf(value[0]))
        && value.length === 4) {
        const reference = requirements.get(t.indexOf(value[0]));
        this.exports.push(new SourceExport(name, "*", reference, token));
        if (name === "default") this.exports.push(new SourceExport("*", "*", reference, token));
      } else if (name === "default" && value[0]?.value === "{" && value.at(-1)?.value === "}") {
        for (const part of readCommaSeparated(value, 1, value.length - 1)) {
          if (part.length === 1 && part[0].kind === "identifier") this.exports.push(new SourceExport(part[0].value, part[0].value, null, part[0]));
          else if (part.length === 3 && ["identifier", "string"].includes(part[0].kind)
            && part[1].value === ":" && part[2].kind === "identifier") this.exports.push(new SourceExport(part[0].value, part[2].value, null, part[0]));
          else throw new SourceReadError(this.file, token.offset, "unsupported CommonJS export property");
        }
      } else throw new SourceReadError(this.file, token.offset, "unsupported CommonJS export value");
    };
    for (let i = 0; i < t.length; i++) {
      const token = t[i];
      let cursor = i;
      let name;
      if (token.value === "module" && this.isUnbound("module", token) && t[i + 1]?.value === "." && t[i + 2]?.value === "exports") {
        cursor = i + 3; name = "default";
      } else if (token.value === "exports" && this.isUnbound("exports", token)) { cursor = i + 1; }
      else continue;
      if (t[cursor]?.value === "." && t[cursor + 1]?.kind === "identifier") { name = t[cursor + 1].value; cursor += 2; }
      if (name === undefined || t[cursor]?.value !== "=" || t[cursor + 1]?.value === "=") continue;
      let end = cursor + 1;
      while (end < t.length && t[end].value !== ";") {
        if (["(", "[", "{"].includes(t[end].value)) end = matching(t, end, t[end].value,
          { "(": ")", "[": "]", "{": "}" }[t[end].value]);
        end++;
      }
      const firstExport = this.exports.length;
      exportValue(name, cursor + 1, end, token);
      this.commonJsExports.push(new SourceCommonJsExport(this,
        new SourceInitializer(token, i, t.slice(i, cursor)), t[cursor],
        new SourceInitializer(t[cursor + 1], cursor + 1, t.slice(cursor + 1, end)), this.exports.slice(firstExport)));
    }
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
        const primary = SourceBodyPrimary.read(t, i);
        if (primary === null) throw new SourceReadError(this.file, token.offset, "unsupported class declaration");
        const name = t[i + 1]?.kind === "identifier" && t[i + 1].value !== "extends" ? t[i + 1].value : null;
        const heritage = primary.heritageTokens;
        if (heritage?.length === 0) throw new SourceReadError(this.file, token.offset, "unsupported class heritage");
        const parent = heritage === null ? null : new SourceClassHeritage(heritage);
        const open = primary.bodyIndex, close = primary.endIndex;
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
        this.classes.push(new SourceClass(name, parent, token, dependencies, argumentTypes, exported));
      }
    }
    this.#readCommonJs();
    if (!lexicalOnly) this.globals = this.#bindings().unbound(watchedGlobals);
  }
}


/** Balanced conditional-expression boundaries shared by ownership and evaluation. */
export class SourceConditionalExpression {
  constructor(tokens, questionIndex, alternateIndex) {
    if (!Number.isInteger(questionIndex) || !Number.isInteger(alternateIndex) || questionIndex < 0
      || alternateIndex <= questionIndex || !SourceConditionalExpression.isQuestion(tokens, questionIndex)
      || tokens[alternateIndex]?.kind !== "punctuation" || tokens[alternateIndex]?.value !== ":") {
      throw new TypeError("source conditional expression required");
    }
    this.tokens = immutableSourceTokens(tokens);
    Object.assign(this, { questionIndex, alternateIndex });
    Object.freeze(this);
  }
  get condition() { return this.tokens.slice(0, this.questionIndex); }
  get consequent() { return this.tokens.slice(this.questionIndex + 1, this.alternateIndex); }
  get alternate() { return this.tokens.slice(this.alternateIndex + 1); }
  static isQuestion(tokens, index) {
    return tokens[index]?.kind === "punctuation" && tokens[index].value === "?"
      && ![".", "?"].includes(tokens[index + 1]?.value) && tokens[index - 1]?.value !== "?";
  }
  static matchingAlternate(tokens, question) {
    if (!this.isQuestion(tokens, question)) return -1;
    let depth = 0;
    for (let index = question + 1; index < tokens.length; index++) {
      if (tokens[index] instanceof SourceTemplateToken) { index = tokens.indexOf(tokens[index].endToken, index + 1); if (index < 0) return -1; continue; }
      if (tokens[index].kind !== "punctuation") continue;
      if (["(", "[", "{"].includes(tokens[index].value)) {
        index = matching(tokens, index, tokens[index].value, { "(": ")", "[": "]", "{": "}" }[tokens[index].value]); continue;
      }
      if ([";", ")", "]", "}"].includes(tokens[index].value)) return -1;
      if (this.isQuestion(tokens, index)) depth++;
      if (tokens[index].value === ":" && depth-- === 0) return index;
    }
    return -1;
  }
  static read(tokens) {
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index] instanceof SourceTemplateToken) { index = tokens.indexOf(tokens[index].endToken, index + 1); if (index < 0) return null; continue; }
      if (tokens[index].kind === "punctuation" && ["(", "[", "{"].includes(tokens[index].value)) {
        index = matching(tokens, index, tokens[index].value, { "(": ")", "[": "]", "{": "}" }[tokens[index].value]); continue;
      }
      const alternate = this.matchingAlternate(tokens, index);
      if (alternate >= 0) return new this(tokens, index, alternate);
    }
    return null;
  }
}

/** Preserve the existing evaluator's operator extent without assigning value semantics. */
export class SourceOperator {
  constructor(tokens, startIndex, endIndex) {
    if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || startIndex < 0 || endIndex <= startIndex
      || endIndex > tokens.length) throw new TypeError("source operator boundary required");
    Object.assign(this, { startIndex, endIndex, operator: tokens.slice(startIndex, endIndex).map(token => token.value).join("") });
    Object.freeze(this);
  }
  static isPunctuation(token) { return token?.kind === "punctuation" && ",=!-*/%&|^<>?+".includes(token.value); }
  static isKeyword(token) { return ["instanceof", "in"].includes(token?.value); }
  static read(tokens, start) {
    let end = start;
    while (end < tokens.length && this.isPunctuation(tokens[end])) end++;
    if (end === start && this.isKeyword(tokens[end])) end++;
    return end === start ? null : new this(tokens, start, end);
  }
  static before(tokens, end) {
    let start = end;
    while (start > 0 && this.isPunctuation(tokens[start - 1])) start--;
    if (start === end && this.isKeyword(tokens[start - 1])) start--;
    const operator = this.read(tokens, start);
    return operator?.endIndex === end ? operator : null;
  }
}

/** Shared delimiter primary extent, excluding call/member continuations. */
class SourceDelimitedPrimary {
  constructor(startIndex, endIndex) {
    if (!Number.isInteger(startIndex) || endIndex <= startIndex) throw new TypeError("source delimited primary required");
    Object.assign(this, { startIndex, endIndex });
    Object.freeze(this);
  }
  static read(tokens, start, opening, closing, knownExpression = false) {
    if (tokens[start]?.kind !== "punctuation" || tokens[start].value !== opening) return null;
    const previous = tokens[start - 1];
    const afterDeclaration = previous?.value === "}" && tokens.some((token, index) => {
      if (index >= start || !["class", "function"].includes(token.value)) return false;
      const primary = SourceBodyPrimary.read(tokens, index);
      return primary !== null && primary.endIndex === start - 1 && primary.isDeclaration(tokens);
    });
    if (!knownExpression && !afterDeclaration && previous && (previous.kind === "identifier"
      && !["return", "throw", "yield", "await", "case", "typeof", "void", "delete"].includes(previous.value)
      || ["string", "number", "literal"].includes(previous.kind)
      || [")", "]", "}", "."].includes(previous.value))) return null;
    return new this(start, matching(tokens, start, opening, closing));
  }
}
/** A brace primary only at an established expression position, never a statement block. */
export class SourceObjectPrimary extends SourceDelimitedPrimary {
  static read(tokens, start = 0, alternateColons = null) {
    const previous = tokens[start - 1];
    const exported = previous?.kind === "identifier" && previous.value === "default"
      && tokens[start - 2]?.kind === "identifier" && tokens[start - 2].value === "export";
    const alternate = previous?.kind === "punctuation" && previous.value === ":"
      && (alternateColons === null ? tokens.some((_, index) => index < start
        && SourceConditionalExpression.matchingAlternate(tokens, index) === start - 1) : alternateColons.has(previous));
    const operator = SourceOperator.before(tokens, start);
    const expression = exported || alternate || operator !== null && ["||", "&&", "??"].includes(operator.operator)
      || previous?.kind === "punctuation" && ["=", "(", "[", ",", "?"].includes(previous.value)
      || previous?.kind === "identifier" && ["return", "throw", "yield"].includes(previous.value)
        && previous.line === tokens[start]?.line;
    return expression ? super.read(tokens, start, "{", "}", exported) : null;
  }
}
/** An array literal primary, excluding computed access and binding patterns. */
export class SourceArrayPrimary extends SourceDelimitedPrimary {
  static read(tokens, start = 0) {
    const primary = super.read(tokens, start, "[", "]");
    return primary !== null && tokens[primary.endIndex + 1]?.value !== "=" ? primary : null;
  }
}
/** Parentheses form an expression primary, never a parameter/control head. */
export class SourceGroupPrimary extends SourceDelimitedPrimary {
  static read(tokens, start = 0) {
    const primary = super.read(tokens, start, "(", ")");
    return primary !== null && !["=>", "{"].includes(tokens[primary.endIndex + 1]?.value) ? primary : null;
  }
}

/** One function/class primary's lexical extent, separate from its postfix uses. */
export class SourceBodyPrimary {
  constructor(declaration, startIndex, endIndex, bodyIndex) {
    if (!(declaration instanceof SourceDeclaration) || !Number.isInteger(startIndex) || endIndex < startIndex
      || !Number.isInteger(bodyIndex) || bodyIndex <= startIndex || bodyIndex >= endIndex) {
      throw new TypeError("source body primary required");
    }
    Object.assign(this, { declaration, startIndex, endIndex, bodyIndex });
    Object.freeze(this);
  }
  isDeclaration(tokens) {
    const head = this.declaration.token;
    const index = tokens.indexOf(head);
    const named = tokens[index + 1]?.kind === "identifier" && tokens[index + 1].value !== "extends";
    const previous = tokens[index - (head.value === "function" && tokens[index - 1]?.value === "async" ? 2 : 1)];
    return named && !["=", "(", ",", ":", "return", "new", "=>", "?", "["].includes(previous?.value);
  }
  get heritageTokens() {
    if (this.declaration.token.value !== "class") return null;
    const header = this.declaration.tokens.slice(0, this.bodyIndex - this.startIndex);
    const keyword = header.findIndex(token => token.value === "extends");
    return keyword < 0 ? null : header.slice(keyword + 1);
  }
  static read(tokens, start = 0) {
    const first = tokens[start];
    if (first?.kind !== "identifier") return null;
    const head = first.value === "async" && tokens[start + 1]?.value === "function" ? start + 1 : start;
    const token = tokens[head];
    if (!["function", "class"].includes(token.value)) return null;
    let body = head + 1;
    if (token.value === "function") {
      if (tokens[body]?.value === "*") body++;
      if (tokens[body]?.kind === "identifier") body++;
      if (tokens[body]?.value !== "(") return null;
      body = matching(tokens, body, "(", ")") + 1;
    } else {
      while (body < tokens.length && tokens[body].value !== "{") {
        if (["(", "["].includes(tokens[body].value)) body = matching(tokens, body, tokens[body].value, tokens[body].value === "(" ? ")" : "]");
        body++;
      }
    }
    if (tokens[body]?.value !== "{") return null;
    const end = matching(tokens, body);
    const previous = tokens[head - 1];
    const prefix = token.value === "function" && previous?.kind === "identifier" && previous.value === "async" ? [previous] : [];
    const named = tokens[head + 1]?.kind === "identifier" ? tokens[head + 1].value : `<${token.value}:${token.offset}>`;
    return new this(new SourceDeclaration(named, tokens.slice(head, end + 1), prefix), start, end, body);
  }
}
