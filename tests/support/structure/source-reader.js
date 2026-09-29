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
  constructor(name, local, reference = null) {
    this.name = name;
    this.local = local;
    this.reference = reference;
  }
}

export class SourceInvocation {
  constructor(name, token, arguments_) {
    if (!name || !token || !Array.isArray(arguments_)) throw new TypeError("invalid source invocation");
    this.name = name;
    this.token = token;
    this.arguments = arguments_;
  }
  identifiers() {
    return new Set(this.arguments.flat().filter((token) => token.kind === "identifier").map((token) => token.value));
  }
  literals() {
    return new Set(this.arguments.flat().filter((token) => token.kind === "string").map((token) => token.value));
  }
}

export class SourceDeclaration {
  constructor(name, tokens) {
    if (!name || !Array.isArray(tokens) || tokens.length === 0) throw new TypeError("invalid source declaration");
    this.name = name;
    this.tokens = tokens;
    this.token = tokens[0];
  }
  uses(name) { return this.tokens.some((token) => token.kind === "identifier" && token.value === name); }
  matchesDeclaration(source) { return sameTokens(this.tokens, readTokens(source)); }
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

/** Account for every reference to a capability; unclassified uses remain errors. */
export class SourceOriginUsage {
  constructor(declaration, origins) {
    if (!(declaration instanceof SourceDeclaration)) throw new TypeError("source declaration required");
    this.tokens = declaration.tokens;
    this.origins = new Set(origins);
    this.accepted = new Set();
    const transfers = [];
    for (let index = 0; index < this.tokens.length; index++) {
      const tokens = this.tokens;
      let target;
      let start;
      if (tokens[index].value === "const" && tokens[index + 1]?.kind === "identifier"
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
        if (!this.origins.has(target.value) && !this.origins.has(origin.value)) continue;
        for (const token of [target, origin]) if (!this.origins.has(token.value)) {
          this.origins.add(token.value); changed = true;
        }
        this.accept([target, ...source]);
      }
    } while (changed);
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
      && tokens.every((token, index) => index % 2 === 0 ? token.kind === "identifier" : token.value === ".");
  }
  isOrigin(token) { return token.kind === "identifier" && this.origins.has(token.value); }
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

function readCommaSeparated(tokens, start, end) {
  const parts = [];
  let depth = 0;
  for (let index = start; index < end; index++) {
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
export function readMemberAccess(tokens, receiverIndex) {
  let start = receiverIndex;
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
    result.push(new SourceInvocation(token.value, token, arguments_));
  }
  return result;
}

/** Resolve a static local class, function, or value declaration by name. */
export function readDeclaration(module, name) {
  const tokens = module.tokens;
  let depth = 0;
  for (let index = 0; index < tokens.length - 1; index++) {
    if (tokens[index].value === "{") depth++;
    if (tokens[index].value === "}") depth--;
    if (depth !== 0) continue;
    if (!["class", "function", "const", "let"].includes(tokens[index].value) || tokens[index + 1]?.value !== name) continue;
    if (tokens[index].value === "class" || tokens[index].value === "function") {
      let open = index + 2;
      if (tokens[index].value === "function") {
        while (open < tokens.length && tokens[open].value !== "(") open++;
        if (open === tokens.length) throw new SourceReadError(module.file, tokens[index].offset, `unsupported ${name} declaration`);
        open = matching(tokens, open, "(", ")") + 1;
      }
      while (open < tokens.length && tokens[open].value !== "{") open++;
      if (open === tokens.length) throw new SourceReadError(module.file, tokens[index].offset, `unclosed ${name} declaration`);
      const close = matching(tokens, open);
      return new SourceDeclaration(name, tokens.slice(index, close + 1));
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
    return new SourceDeclaration(name, tokens.slice(index, end + 1));
  }
  return null;
}

export function readClassMember(module, className, memberName) {
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
  if (!parent) return null;
  const tokens = parent.tokens;
  let depth = 0;
  for (let index = 0; index < tokens.length - 1; index++) {
    if (tokens[index].value === "{") depth++;
    if (tokens[index].value === "}") depth--;
    if (depth !== 1 || tokens[index].value !== memberName || tokens[index + 1]?.value !== "(") continue;
    const close = matching(tokens, index + 1, "(", ")");
    if (tokens[close + 1]?.value !== "{") continue;
    const end = matching(tokens, close + 1);
    return new SourceDeclaration(`${className}.${memberName}`, tokens.slice(index, end + 1));
  }
  return null;
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

class SourceLexicalScope {
  constructor(parent, start, end) {
    this.parent = parent;
    this.start = start;
    this.end = end;
    this.bindings = new Set();
  }
  has(name) { return this.bindings.has(name) || Boolean(this.parent?.has(name)); }
}

const watchedGlobals = new Set(["require", "createRequire", "eval", "Function", "fetch", "process", "globalThis", "global"]);

function unboundGlobals(tokens, references, file, watched = watchedGlobals) {
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
  for (const reference of references.filter((entry) => entry.kind === "import")) {
    for (const local of reference.bindings.keys()) root.bindings.add(local);
  }
  const declarations = new Set();
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
      scope.bindings.add(tokens[j].value);
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
          scopes[i].bindings.add(tokens[j].value);
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
      braceScopes.get(body)?.bindings.add(name);
      if (!["=", "(", ",", ":", "return"].includes(tokens[i - 1]?.value)) scopes[i].bindings.add(name);
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
      if (body) {
        bindParameters(open, close, body);
        if (name) body.bindings.add(name);
      }
      if (name && !["=", "(", ",", ":", "return"].includes(tokens[i - 1]?.value)) {
        scopes[i].bindings.add(name);
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
  const globals = [];
  let declarationEnd = -1;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "identifier" && ["import", "export"].includes(token.value) && tokens[i + 1]?.value === "{") {
      declarationEnd = matching(tokens, i + 1);
    }
    if (i <= declarationEnd) continue;
    if (token.kind !== "identifier" || !watched.has(token.value) || declarations.has(i)) continue;
    const previous = tokens[i - 1]?.value;
    if (previous === "." || previous === "#" || tokens[i + 1]?.value === ":") continue;
    const call = tokens[i + 1]?.value === "(";
    if (call && tokens[matching(tokens, i + 1, "(", ")") + 1]?.value === "{") continue;
    if (!scopes[i].has(token.value)) globals.push(token);
  }
  return globals;
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
      this.unboundNames.set(name, new Set(unboundGlobals(this.tokens, this.references, this.file, new Set([name]))
        .map((entry) => entry.offset)));
    }
    return this.unboundNames.get(name).has(token.offset);
  }

  declaration(name) {
    if (!this.declarations.has(name)) this.declarations.set(name, readDeclaration(this, name));
    return this.declarations.get(name);
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
            this.exports.push(new SourceExport(alias, local, reference));
            j += alias === local ? 0 : 2;
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
        if (exported) this.exports.push(new SourceExport(t[i - 1]?.value === "default" ? "default" : name, name));
      }
    }
    if (!lexicalOnly) this.globals = unboundGlobals(t, this.references, this.file);
  }
}
