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
  constructor(name, parent, parentToken, token, dependencies, exported) {
    this.name = name;
    this.parent = parent;
    this.parentToken = parentToken;
    this.token = token;
    this.dependencies = dependencies;
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
        let depth = 1;
        for (let j = open + 1; j < close; j++) {
          if (t[j].kind === "punctuation" && t[j].value === "{") { depth++; continue; }
          if (t[j].kind === "punctuation" && t[j].value === "}") { depth--; continue; }
          if (depth !== 1) continue;
          if (t[j].value !== "static" || t[j + 1]?.value !== "dependencies") continue;
          if (t[j + 2]?.value !== "=" || t[j + 3]?.value !== "[") throw new SourceReadError(this.file, t[j].offset, "unsupported dependencies declaration");
          const end = matching(t, j + 3, "[", "]");
          for (let k = j + 4; k < end; k++) {
            if (t[k].value === ",") continue;
            if (t[k].kind !== "identifier") throw new SourceReadError(this.file, t[k].offset, "dependencies must be static identifiers");
            dependencies.push(t[k].value);
          }
        }
        const exported = t[i - 1]?.value === "export" || (t[i - 2]?.value === "export" && t[i - 1]?.value === "default");
        this.classes.push(new SourceClass(name, parent, hasParent ? t[cursor + 1] : null, token, dependencies, exported));
        if (exported) this.exports.push(new SourceExport(t[i - 1]?.value === "default" ? "default" : name, name));
      }
    }
    if (!lexicalOnly) this.globals = unboundGlobals(t, this.references, this.file);
  }
}
