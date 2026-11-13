import { matching, SourceClassMembers, SourceDeclaration, SourceTemplateToken } from "./source-reader.js";
import { supportedPlatforms } from "./os-command-policy.js";

/** Values are source-derived, never the analyzer host's OS. null means unknown. */
export class PlatformExpression {
  constructor(dependent, values) {
    if (typeof dependent !== "boolean" || values.length !== supportedPlatforms.length) throw new TypeError("three platform interpretations required");
    Object.assign(this, { dependent, values });
  }
  at(platform) { return this.values[supportedPlatforms.indexOf(platform)]; }
}

class Block {
  constructor(statements) { this.statements = statements; }
}
class Statement {
  constructor(tokens) { this.tokens = tokens; }
}
class Branch {
  constructor(token, condition, yes, no) { Object.assign(this, { token, condition, yes, no }); }
}
class SwitchBranch {
  constructor(token, selector, cases) { Object.assign(this, { token, selector, cases }); }
}
class SwitchCase {
  constructor(label, body) { Object.assign(this, { label, body }); }
}
class UnsupportedControl extends Statement {}
class DeferredDeclaration extends Statement {}

function punctuation(token, ...values) { return token?.kind === "punctuation" && values.includes(token.value); }
function keyword(token, ...values) { return token?.kind === "identifier" && values.includes(token.value); }

function skip(tokens, index) {
  if (tokens[index] instanceof SourceTemplateToken) return tokens.indexOf(tokens[index].endToken, index + 1);
  if (punctuation(tokens[index], "(", "[", "{")) return matching(tokens, index, tokens[index].value, { "(": ")", "[": "]", "{": "}" }[tokens[index].value]);
  return index;
}
function resultTokens(tokens) {
  return tokens.slice(1, tokens.at(-1)?.kind === "punctuation" && tokens.at(-1).value === ";" ? -1 : undefined);
}

/** A bounded statement walk layered on the shared lexer and delimiter reader. */
class Statements {
  constructor(tokens) { this.tokens = tokens; this.cursor = 0; }
  block() {
    const statements = [];
    while (this.cursor < this.tokens.length) statements.push(this.next());
    return new Block(statements);
  }
  next() {
    const t = this.tokens;
    const start = this.cursor++;
    const token = t[start];
    if (punctuation(token, "{")) {
      const end = matching(t, start);
      this.cursor = end + 1;
      return new Statements(t.slice(start + 1, end)).block();
    }
    if (keyword(token, "if") && punctuation(t[this.cursor], "(")) {
      const end = matching(t, this.cursor, "(", ")");
      const condition = t.slice(this.cursor + 1, end);
      this.cursor = end + 1;
      const yes = this.next();
      const no = keyword(t[this.cursor], "else") ? (this.cursor++, this.next()) : new Block([]);
      return new Branch(token, condition, yes, no);
    }
    if (keyword(token, "switch") && punctuation(t[this.cursor], "(")) {
      const end = matching(t, this.cursor, "(", ")");
      const selector = t.slice(this.cursor + 1, end);
      const open = end + 1;
      if (!punctuation(t[open], "{")) return new UnsupportedControl(t.slice(start, this.cursor));
      const close = matching(t, open);
      const cases = [];
      for (let index = open + 1; index < close;) {
        if (!keyword(t[index], "case", "default")) { index++; continue; }
        const labelStart = index++;
        while (index < close && !punctuation(t[index], ":")) index = skip(t, index) + 1;
        const label = t[labelStart].value === "default" ? null : t.slice(labelStart + 1, index);
        const bodyStart = ++index;
        while (index < close && !keyword(t[index], "case", "default")) index = skip(t, index) + 1;
        cases.push(new SwitchCase(label, new Statements(t.slice(bodyStart, index)).block()));
      }
      this.cursor = close + 1;
      return new SwitchBranch(token, selector, cases);
    }
    if (keyword(token, "function", "class")) {
      let open = this.cursor;
      while (open < t.length && !punctuation(t[open], "{")) open = skip(t, open) + 1;
      if (open < t.length) {
        const close = matching(t, open);
        this.cursor = close + 1;
        const tokens = t.slice(start, this.cursor);
        if (keyword(token, "function")) return new DeferredDeclaration(tokens);
        // A plain class's method bodies are deferred. Computed keys, static
        // initialization and inheritance can execute now and remain unmodeled.
        if (open === start + 2) {
          const members = new SourceClassMembers(new SourceDeclaration(t[start + 1].value, tokens));
          if (members.moduleInitializers.length === 0) return new DeferredDeclaration(tokens);
        }
        return new UnsupportedControl(tokens);
      }
    }
    while (this.cursor < t.length && !punctuation(t[this.cursor], ";")) this.cursor = skip(t, this.cursor) + 1;
    if (punctuation(t[this.cursor], ";")) this.cursor++;
    const tokens = t.slice(start, this.cursor);
    if (keyword(token, "return")) return this.returned(tokens);
    return keyword(token, "for", "while", "do", "try", "with", "function", "class") ? new UnsupportedControl(tokens) : new Statement(tokens);
  }
  returned(tokens) {
    let expression = resultTokens(tokens);
    while (punctuation(expression[0], "(") && matching(expression, 0, "(", ")") === expression.length - 1) expression = expression.slice(1, -1);
    for (let index = 0; index < expression.length; index++) {
      if (!punctuation(expression[index], "?") || punctuation(expression[index + 1], ".", "?")) { index = skip(expression, index); continue; }
      let nested = 0;
      for (let end = index + 1; end < expression.length; end++) {
        const skipped = skip(expression, end);
        if (skipped !== end) { end = skipped; continue; }
        if (punctuation(expression[end], "?")) nested++;
        if (!punctuation(expression[end], ":") || nested-- !== 0) continue;
        return new Branch(tokens[0], expression.slice(0, index), this.returned([tokens[0], ...expression.slice(index + 1, end)]), this.returned([tokens[0], ...expression.slice(end + 1)]));
      }
    }
    return new Statement(tokens);
  }
}

class ImplementationRoute {
  constructor(platform) {
    this.platform = platform;
    this.tokens = [];
    this.terminal = null;
    this.unknown = false;
    this.result = [];
  }
}

export class PlatformImplementationBoundary {
  constructor(declaration, expression) {
    Object.assign(this, { declaration, expression });
    this.conditions = new Set();
    this.dependent = false;
    this.routes = supportedPlatforms.map((platform) => new ImplementationRoute(platform));
    const tokens = declaration.bodyTokens();
    this.modeled = tokens !== null;
    const body = new Statements(tokens ?? []).block();
    this.indexConditions(body);
    for (const route of this.routes) this.walk(body, route);
    this.classification = null;
    this.message = null;
  }
  classify(signature, platforms = supportedPlatforms, knownPlatforms = platforms) {
    if (!this.dependent) return;
    const routes = this.routes.filter((route) => platforms.includes(route.platform));
    const results = routes.map((route) => signature(route));
    const missing = routes.filter((route, index) => !route.unknown && (route.terminal === "throw" || results[index] === "empty"));
    const knownMissing = missing.filter((route) => knownPlatforms.includes(route.platform));
    if (knownMissing.length) {
      this.classification = "violation";
      this.message = `shared platform boundary has no normal implementation for ${knownMissing.map((route) => route.platform).join(", ")} (missing, rejection or no-op)`;
    } else if (missing.length || !routes.length || routes.some((route) => route.unknown) || results.includes("unknown") || new Set(results).size !== 1) {
      this.classification = "incomplete";
      this.message = "shared platform boundary cannot prove matching result/effect guarantees on Linux, macOS and Windows";
    }
  }
  contains(token) { return token.offset >= this.declaration.token.offset && token.offset <= this.declaration.tokens.at(-1).offset; }
  routesAt(token) { return this.routes.filter((route) => route.tokens.some((item) => item.offset === token.offset)); }
  indexConditions(node) {
    if (node instanceof Block) { node.statements.forEach((child) => this.indexConditions(child)); return; }
    if (!(node instanceof Branch || node instanceof SwitchBranch)) return;
    const tokens = node instanceof Branch ? node.condition : node.selector;
    node.interpretation = this.expression(tokens);
    if (node.interpretation.dependent) {
      this.dependent = true;
      for (const token of tokens) this.conditions.add(token.offset);
    }
    if (node instanceof Branch) { this.indexConditions(node.yes); this.indexConditions(node.no); }
    else node.cases.forEach((entry) => this.indexConditions(entry.body));
  }
  walk(node, route) {
    if (route.terminal) return;
    if (node instanceof DeferredDeclaration) return;
    if (node instanceof Block) {
      for (const child of node.statements) this.walk(child, route);
    } else if (node instanceof Branch) {
      const condition = node.interpretation;
      if (!condition.dependent) {
        const known = condition.at(route.platform);
        if (known !== null) { this.walk(known ? node.yes : node.no, route); return; }
        // Runtime input validation is not an OS implementation. Other runtime
        // control inside a platform boundary cannot prove a single static path.
        if (node.yes instanceof Statement && node.yes.tokens[0]?.value === "throw" && node.no instanceof Block && !node.no.statements.length) return;
        route.unknown = true;
        this.appendAll(node.yes, route);
        this.appendAll(node.no, route);
        return;
      }
      route.tokens.push(...node.condition);
      const value = condition.at(route.platform);
      if (value === null) { route.unknown = true; this.appendAll(node.yes, route); this.appendAll(node.no, route); }
      else this.walk(value ? node.yes : node.no, route);
    } else if (node instanceof SwitchBranch) {
      const selector = node.interpretation;
      if (!selector.dependent) { route.unknown = true; node.cases.forEach((entry) => this.appendAll(entry.body, route)); return; }
      route.tokens.push(...node.selector);
      const value = selector.at(route.platform);
      const labels = node.cases.map((entry) => entry.label === null ? undefined : this.expression(entry.label).at(route.platform));
      if (value === null || labels.includes(null)) { route.unknown = true; node.cases.forEach((entry) => this.appendAll(entry.body, route)); return; }
      let index = labels.indexOf(value);
      if (index < 0) index = labels.indexOf(undefined);
      for (; index >= 0 && index < node.cases.length && !route.terminal; index++) this.walk(node.cases[index].body, route);
      if (route.terminal === "break") route.terminal = null;
    } else {
      route.tokens.push(...node.tokens);
      if (node instanceof UnsupportedControl) route.unknown = true;
      if (keyword(node.tokens[0], "return", "throw", "break")) {
        route.terminal = node.tokens[0].value;
        route.result = resultTokens(node.tokens);
      }
    }
  }
  appendAll(node, route) {
    if (node instanceof Block) node.statements.forEach((child) => this.appendAll(child, route));
    else if (node instanceof Branch) { route.tokens.push(...node.condition); this.appendAll(node.yes, route); this.appendAll(node.no, route); }
    else if (node instanceof SwitchBranch) { route.tokens.push(...node.selector); node.cases.forEach((entry) => this.appendAll(entry.body, route)); }
    else route.tokens.push(...node.tokens);
  }
}
