import { SourceClassMembers, SourceDeclaration, SourceModule, readParameters } from "./source-reader.js";

const inspectedContract = Symbol("inspected native permission class");

function parameter(member) {
  const parameters = readParameters(member.tokens);
  return parameters.length === 1 && parameters[0].length === 1 && parameters[0][0].kind === "identifier"
    ? parameters[0][0].value : null;
}

function intrinsic(module, member, receiver, name, context) {
  const tokens = member.bodyTokens();
  const references = tokens.flatMap((token, index) => token.value === receiver && module.isUnbound(receiver, token)
    && (name === null ? tokens[index + 1]?.value === "(" : tokens[index + 1]?.value === "." && tokens[index + 2]?.value === name)
    ? [tokens.slice(index, index + (name === null ? 1 : 3))] : []);
  return references.length > 0 && references.every(reference => context.builtinCall(module, reference, receiver, name) === true);
}

/** Closed native metadata shape; application/readback obligations remain separate. */
export class SourceNativePermissionContract {
  constructor(authority, module, declaration, field, initialize, capture, apply, equal, afterWrite) {
    if (authority !== inspectedContract || !(module instanceof SourceModule) || !(declaration instanceof SourceDeclaration)
      || typeof field !== "string" || !field
      || [initialize, capture, apply, equal, afterWrite].some(member => !(member instanceof SourceDeclaration))) {
      throw new TypeError("an inspected native permission class contract is required");
    }
    Object.assign(this, { module, declaration, field, initialize, capture, apply, equal, afterWrite });
    Object.freeze(this);
  }

  acceptsNumber(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0o7777;
  }

  memberAt(token) {
    return [this.initialize, this.capture, this.apply, this.equal, this.afterWrite]
      .find(member => member.tokens.includes(token)) ?? null;
  }

  /** Required adapters resolve actual lexical/builtin identities and mutation
   * effects, including globals. Non-call references such as process.platform
   * use the same builtinCall adapter. No unknown adapter result grants a proof. */
  static inspect(module, declaration, context) {
    if (!(module instanceof SourceModule) || !(declaration instanceof SourceDeclaration)
      || declaration.token.value !== "class" || declaration.tokens[2]?.value !== "{"
      || module.declaration(declaration.name) !== declaration
      || typeof context?.stableClass !== "function" || typeof context?.builtinCall !== "function"
      || context.stableClass(module, declaration) !== true) return null;
    const name = declaration.name;
    const binding = module.moduleBinding(name);
    if (binding === null || binding !== module.bindingAt(declaration.tokens[1])) return null;
    const selfBinding = module.classSelfBinding(declaration);
    if (selfBinding === null) return null;
    const members = new SourceClassMembers(declaration);
    if (members.instanceMembers.size !== 4 || members.staticMembers.size !== 1
      || members.instanceInitializers.length || members.moduleInitializers.length
      || members.unresolvedInstanceMembers.length || members.unresolvedStaticMembers.length
      || members.memberNameTokens.length !== 5
      || new Set(members.memberNameTokens.map(token => token.value)).size !== 5) return null;
    const methods = [...members.instanceMembers.values(), ...members.staticMembers.values()];
    for (const member of methods) {
      const index = module.tokens.indexOf(member.token);
      if (index < 0 || ["get", "set", "async", "*"].includes(module.tokens[index - 1]?.value)) return null;
      const tokens = member.bodyTokens();
      if (tokens === null) return null;
      if (tokens.some((token, index) => ["new", "instanceof"].includes(tokens[index - 1]?.value)
        && token.value === name && module.bindingAt(token) !== selfBinding)) return null;
    }
    const initialize = members.instanceMembers.get("constructor");
    const input = initialize && parameter(initialize);
    if (!input) return null;
    const body = initialize.bodyTokens();
    const assignment = body.findIndex((token, index) => token.value === "this"
      && body[index + 1]?.value === "." && body[index + 2]?.kind === "identifier" && body[index + 3]?.value === "=");
    const field = body[assignment + 2]?.value;
    // The native __proto__ accessor does not create an own data property when
    // assigned this bounded primitive, so it cannot establish this invariant.
    if (!field || field === "__proto__" || !initialize.matchesBody(`
      if (!Number.isInteger(${input}) || ${input} < 0 || ${input} > 0o7777) throw new TypeError($STRING_LITERAL);
      this.${field} = ${input}; Object.freeze(this);
    `) || !intrinsic(module, initialize, "Number", "isInteger", context)
      || !intrinsic(module, initialize, "Object", "freeze", context)
      || !intrinsic(module, initialize, "TypeError", null, context)) return null;
    const capture = [...members.staticMembers.values()][0];
    const stat = parameter(capture);
    if (!stat || !capture.matchesBody(`return new ${name}(Number(${stat}.mode) & 0o7777);`)
      || !intrinsic(module, capture, "Number", null, context)) return null;
    const ordinary = [...members.instanceMembers.values()].filter(member => member !== initialize);
    let apply = null;
    for (const member of ordinary) {
      const descriptor = parameter(member), tokens = member.bodyTokens();
      const open = tokens.findIndex(token => token.value === "(");
      if (!descriptor || open < 1) continue;
      const callee = tokens.slice(0, open);
      if (context.builtinCall(module, callee, "fs", "fchmodSync") !== true) continue;
      if (member.matchesBody(`${callee.map(token => token.value).join("")}(${descriptor}, this.${field});`)) apply = member;
    }
    if (apply === null) return null;
    let equal = null;
    for (const member of ordinary.filter(member => member !== apply)) {
      const other = parameter(member);
      if (other && member.matchesBody(`
        if (!(${other} instanceof ${name})) return false;
        return process.platform === 'win32'
          ? (this.${field} & 0o200) === (${other}.${field} & 0o200)
          : this.${field} === ${other}.${field};
      `) && intrinsic(module, member, "process", "platform", context)) equal = member;
    }
    if (equal === null) return null;
    const afterWrite = ordinary.find(member => member !== apply && member !== equal);
    // A bounded own scalar must not shadow an operation used by this contract.
    if ([apply, equal, afterWrite].some(member => member.token.value === field)) return null;
    const other = parameter(afterWrite);
    if (!other || !afterWrite.matchesBody(`
      if (process.platform === 'win32') return this.${equal.token.value}(${other});
      return ${other} instanceof ${name}
        && (this.${field} & 0o1777) === (${other}.${field} & 0o1777)
        && (${other}.${field} & 0o6000 & ~this.${field}) === 0;
    `) || !intrinsic(module, afterWrite, "process", "platform", context)) return null;
    return new SourceNativePermissionContract(inspectedContract, module, declaration, field,
      initialize, capture, apply, equal, afterWrite);
  }
}
