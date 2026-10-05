/** Typed ownership of one definition-owned parent command failure boundary. */

function requireKind(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("definition failure ownership kind must be a non-empty string");
  }
  return value;
}

export class DefinitionFailureOwnership {
  constructor(kind) {
    if (new.target === DefinitionFailureOwnership) {
      throw new TypeError("DefinitionFailureOwnership is abstract");
    }
    this.kind = requireKind(kind);
    Object.freeze(this);
  }

  allowsDispatcherFallback() { return false; }

  equals(other) {
    return other instanceof DefinitionFailureOwnership && other.kind === this.kind;
  }

  toJSON() { return this.kind; }

  static from(value) {
    if (value instanceof DefinitionFailureOwnership) return value;
    switch (value) {
      case "dispatcher-primary": return new DispatcherPrimaryFailureOwnership();
      case "command-primary-dispatcher-fallback": return new CommandPrimaryDispatcherFallbackFailureOwnership();
      case "command-self": return new CommandExclusiveFailureOwnership();
      case "lifecycle-outbox": return new LifecycleOutboxFailureOwnership();
      default: throw new TypeError(`invalid definition failure ownership: ${value}`);
    }
  }

  static dispatcherPrimary() { return new DispatcherPrimaryFailureOwnership(); }
  static commandPrimaryWithDispatcherFallback() { return new CommandPrimaryDispatcherFallbackFailureOwnership(); }
  static commandExclusive() { return new CommandExclusiveFailureOwnership(); }
  static lifecycleOutbox() { return new LifecycleOutboxFailureOwnership(); }
}

export class DispatcherPrimaryFailureOwnership extends DefinitionFailureOwnership {
  constructor() { super("dispatcher-primary"); }
  allowsDispatcherFallback() { return true; }
}

export class CommandPrimaryDispatcherFallbackFailureOwnership extends DefinitionFailureOwnership {
  constructor() { super("command-primary-dispatcher-fallback"); }
  allowsDispatcherFallback() { return true; }
}

export class CommandExclusiveFailureOwnership extends DefinitionFailureOwnership {
  constructor() { super("command-self"); }
}

export class LifecycleOutboxFailureOwnership extends DefinitionFailureOwnership {
  constructor() { super("lifecycle-outbox"); }
}
