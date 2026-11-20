import { SourceModule, SourceToken, SourceInitializer, SourceMemberAccess, SourceTemplateToken,
  matching, optionalAccessEnd, readAssignmentTarget, readCommaSeparated, readMemberAccess, readInvocations } from "./source-reader.js";

const closing = { "(": ")", "[": "]", "{": "}" };

/** One syntactic member write. Receiver expressions do not establish heap identity. */
export class SourceMemberMutation {
  constructor(module, operatorTokens, operator, target, receivers, receiverTokens, member, reason = null) {
    if (!(module instanceof SourceModule) || !Array.isArray(operatorTokens) || operatorTokens.length === 0
      || operatorTokens.some(token => !(token instanceof SourceToken) || !module.tokens.includes(token))
      || typeof operator !== "string" || operator !== operatorTokens.map(token => token.value).join("") || !(target instanceof SourceInitializer)
      || target.tokens.length === 0 || target.tokens.some(token => !module.tokens.includes(token))
      || target.token !== target.tokens[0] || module.tokens[target.index] !== target.token
      || target.tokens.some((token, index) => module.tokens[target.index + index] !== token)
      || !Array.isArray(receivers) || receivers.some(receiver => !(receiver instanceof SourceInitializer)
        || receiver.tokens.length === 0 || receiver.tokens.some(token => !target.tokens.includes(token)))
      || !Array.isArray(receiverTokens) || receiverTokens.some(token => !target.tokens.includes(token))
      || (member !== null && (!(member instanceof SourceMemberAccess) || !target.tokens.includes(member.token)))
      || (reason === null ? member === null || receivers.length === 0 : typeof reason !== "string" || reason.length === 0)) {
      throw new TypeError("invalid source member mutation");
    }
    this.file = module.file;
    this.token = operatorTokens[0];
    this.operatorTokens = Object.freeze([...operatorTokens]);
    this.operator = operator;
    this.target = target;
    this.receivers = Object.freeze([...receivers]);
    this.receiverTokens = Object.freeze([...receiverTokens]);
    this.member = member;
    this.supported = reason === null;
    this.reason = reason;
    Object.freeze(this);
  }
}

/** A postfix expression's receiver ancestry, separate from its evaluated inputs. */
class SourceReceiverChain {
  constructor(tokens, end, receivers, spine, receiverTokens, member, reason = null) {
    if (!Array.isArray(tokens) || !Number.isInteger(end) || end < 0 || end > tokens.length
      || !Array.isArray(receivers) || !Array.isArray(spine) || !Array.isArray(receiverTokens)
      || (member !== null && !(member instanceof SourceMemberAccess))
      || (reason !== null && (typeof reason !== "string" || reason.length === 0))) {
      throw new TypeError("invalid source receiver chain");
    }
    this.tokens = tokens;
    this.end = end;
    this.receivers = receivers;
    this.spine = spine;
    this.receiverTokens = receiverTokens;
    this.member = member;
    this.reason = reason;
  }
}

/** Index exact token identities once; lexical names, aliases and OS policy are consumers' work. */
export class SourceMemberMutations {
  #byReceiver = new Map();
  #byTarget = new Map();
  #byOperator = new Map();

  constructor(module) {
    const reader = new SourceMemberMutationReader(module);
    this.module = module;
    this.entries = reader.entries;
    this.complete = this.entries.every(entry => entry.supported);
    for (const entry of this.entries) {
      this.#append(this.#byTarget, entry.target.token, entry);
      for (const token of entry.receiverTokens) this.#append(this.#byReceiver, token, entry);
      for (const token of entry.operatorTokens) this.#append(this.#byOperator, token, entry);
    }
  }

  startingAt(token) { return [...(this.#byTarget.get(token) ?? [])]; }
  writesContaining(token) { return [...(this.#byReceiver.get(token) ?? [])]; }
  mutationFor(token) { return [...(this.#byOperator.get(token) ?? [])]; }

  #append(index, token, entry) {
    if (!index.has(token)) index.set(token, []);
    if (!index.get(token).includes(entry)) index.get(token).push(entry);
  }
}

/** Construction-only token indexes do not outlive the completed mutation entries. */
class SourceMemberMutationReader {
  #defaults = new Set();
  #indexes;
  #constructions;

  constructor(module) {
    if (!(module instanceof SourceModule)) throw new TypeError("source module required");
    this.module = module;
    this.entries = [];
    this.#indexes = new Map(module.tokens.map((token, index) => [token, index]));
    const tokens = module.tokens;
    this.#constructions = new Map(readInvocations(module).filter(call => call.constructed).map(call => [call.token, call]));
    // Read enclosing patterns before their default initializers. Defaults are
    // writes by the enclosing operation, rather than additional '=' operations.
    for (let index = tokens.length - 1; index >= 0; index--) {
      if (tokens[index].value !== "=" || this.#defaults.has(tokens[index])) continue;
      const target = readAssignmentTarget(tokens, index);
      if (target === null) continue;
      const start = this.#indexes.get(target.tokens.at(-1)) + 1;
      this.#targets(target.tokens, tokens.slice(start, index + 1),
        tokens.slice(start, index + 1).map(token => token.value).join(""));
    }
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token.kind === "identifier" && ["in", "of"].includes(token.value)) {
        const target = readAssignmentTarget(tokens, index);
        if (target !== null) this.#targets(target.tokens, [token], token.value);
      } else if (token.kind === "identifier" && token.value === "delete" && tokens[index - 1]?.value !== "."
        && ![":", "="].includes(tokens[index + 1]?.value)) {
        this.#targets(this.#forwardTarget(tokens.slice(index + 1)), [token], "delete");
      } else if (token.kind === "punctuation" && ["+", "-"].includes(token.value)
        && tokens[index + 1]?.value === token.value && token.offset + 1 === tokens[index + 1].offset) {
        const operatorTokens = tokens.slice(index, index + 2);
        const target = readAssignmentTarget(tokens, index);
        if (target !== null) this.#targets(target.tokens, operatorTokens, token.value.repeat(2));
        else {
          this.#targets(this.#forwardTarget(tokens.slice(index + 2)), operatorTokens, token.value.repeat(2));
        }
        index++;
      }
    }
    this.entries.sort((left, right) => left.token.offset - right.token.offset || left.target.token.offset - right.target.token.offset);
    Object.freeze(this.entries);
  }

  #initializer(tokens) { return new SourceInitializer(tokens[0], this.#indexes.get(tokens[0]), tokens); }

  #forwardTarget(tokens) {
    const chain = this.#chain(tokens);
    if (chain.reason === null) return tokens.slice(0, chain.end);
    let end = 0;
    for (; end < tokens.length; end++) {
      if (closing[tokens[end].value]) end = matching(tokens, end, tokens[end].value, closing[tokens[end].value]);
      else if ([";", ",", ")", "]", "}"].includes(tokens[end].value)) break;
    }
    return tokens.slice(0, end);
  }

  #unwrap(tokens) {
    while (tokens[0]?.value === "(" && matching(tokens, 0, "(", ")") === tokens.length - 1) tokens = tokens.slice(1, -1);
    return tokens;
  }

  #topLevel(tokens, value) {
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index] instanceof SourceTemplateToken) { index = tokens.indexOf(tokens[index].endToken, index + 1); continue; }
      if (tokens[index].kind !== "punctuation") continue;
      if (closing[tokens[index].value]) index = matching(tokens, index, tokens[index].value, closing[tokens[index].value]);
      else if (tokens[index].value === value) return index;
    }
    return -1;
  }

  #targets(tokens, operatorTokens, operator, pattern = false) {
    let targetTokens = tokens;
    tokens = this.#unwrap(tokens);
    if (tokens.length === 0) return;
    if (["const", "let", "var"].includes(tokens[0].value)
      || tokens[0].value === "export" && ["const", "let", "var"].includes(tokens[1]?.value)
      || tokens.length === 2 && tokens[0].value === "static" && tokens[1].kind === "identifier") return;
    if (pattern) {
      if (tokens.slice(0, 3).every(token => token.value === ".") && tokens.length > 3) tokens = tokens.slice(3);
      const defaultIndex = this.#topLevel(tokens, "=");
      if (defaultIndex >= 0) {
        this.#defaults.add(tokens[defaultIndex]);
        tokens = tokens.slice(0, defaultIndex);
      }
      targetTokens = tokens;
      tokens = this.#unwrap(tokens);
    }
    if (tokens.length === 1 && tokens[0].kind === "identifier") return;
    if (["{", "["].includes(tokens[0]?.value) && matching(tokens, 0, tokens[0].value, closing[tokens[0].value]) === tokens.length - 1) {
      for (let part of readCommaSeparated(tokens, 1, tokens.length - 1)) {
        if (tokens[0].value === "{") {
          const colon = this.#topLevel(part, ":");
          if (colon >= 0) part = part.slice(colon + 1);
        }
        this.#targets(part, operatorTokens, operator, true);
      }
      return;
    }
    const chain = this.#chain(targetTokens);
    const reason = ["in", "of"].includes(operator) ? "unsupported iteration member mutation"
      : chain.reason ?? (chain.end !== targetTokens.length || chain.member === null ? "unsupported member mutation target" : null);
    this.entries.push(new SourceMemberMutation(this.module, operatorTokens, operator, this.#initializer(targetTokens),
      chain.receivers, chain.receiverTokens, chain.member, reason));
  }

  #chain(tokens) {
    if (tokens.length === 0) return new SourceReceiverChain(tokens, 0, [], [], [], null, "missing mutation target");
    let end = 1;
    let receivers = [];
    let spine = [];
    let receiverTokens = [];
    let member = null;
    if (tokens[0].kind === "identifier" && !["new", "function", "class", "return", "throw"].includes(tokens[0].value)) spine = [tokens[0]];
    else if (tokens[0].value === "new" && tokens[1]?.kind === "identifier") {
      const construction = this.#constructions.get(tokens[1]);
      if (construction && tokens.includes(construction.endToken)) end = tokens.indexOf(construction.endToken) + 1;
      else {
        let open = 2;
        while (tokens[open]?.value === "." && tokens[open + 1]?.kind === "identifier") {
          const access = readMemberAccess(tokens, open - 1, 0);
          if (access === null || access.name === null) break;
          open = tokens.indexOf(access.token) + 1;
        }
        if (tokens[open]?.value !== "(") return new SourceReceiverChain(tokens, 1, [], [], [], null, "construction mutation requires an explicit argument list");
        end = matching(tokens, open, "(", ")") + 1;
      }
      // Constructor/callee/argument references remain reads. Only postfix
      // members of the constructed result become mutation receiver ancestors.
    } else if (closing[tokens[0].value]) {
      end = matching(tokens, 0, tokens[0].value, closing[tokens[0].value]) + 1;
      if (tokens[0].value === "(") {
        const inner = this.#chain(tokens.slice(1, end - 1));
        if (inner.end === end - 2 && inner.reason === null) {
          receivers = [...inner.receivers]; spine = [...inner.spine]; member = inner.member;
          receiverTokens = [...inner.receiverTokens];
        }
      }
    } else if (["string", "number"].includes(tokens[0].kind)) spine = [tokens[0]];
    else return new SourceReceiverChain(tokens, 1, [], [], [], null, "unsupported mutation receiver primary");
    while (end < tokens.length) {
      const optionalEnd = optionalAccessEnd(tokens, end);
      let cursor = optionalEnd;
      if (optionalEnd === end && tokens[end]?.value === ".") cursor++;
      if (cursor !== end && tokens[cursor]?.kind === "identifier") {
        member = readMemberAccess(tokens, end - 1, 0);
        receivers.push(this.#initializer(tokens.slice(0, end)));
        receiverTokens = [...spine];
        spine.push(tokens[cursor]);
        end = cursor + 1;
      } else if (tokens[cursor]?.value === "[") {
        member = readMemberAccess(tokens, end - 1, 0);
        receivers.push(this.#initializer(tokens.slice(0, end)));
        receiverTokens = [...spine];
        end = matching(tokens, cursor, "[", "]") + 1;
      } else if (tokens[cursor]?.value === "(") {
        end = matching(tokens, cursor, "(", ")") + 1;
        // A call returns a new expression identity; its callee and arguments
        // remain reads, regardless of references within their token range.
        receivers = []; spine = []; receiverTokens = []; member = null;
      } else break;
    }
    return new SourceReceiverChain(tokens, end, receivers, spine, receiverTokens, member);
  }
}
