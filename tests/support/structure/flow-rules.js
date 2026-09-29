import { builtinModules } from "node:module";

const contracts = new Set([
  "src/flow/engine/step.js", "src/flow/engine/step-result.js", "src/flow/engine/flow-execution-error.js",
]);
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const allowedBuiltins = new Set(["path", "util", "crypto"]);

/** Flow-specific path roles and dependency policy; the reader and graph remain reusable. */
export class FlowStructureRules {
  get sourceRoot() { return "src"; }
  isComposition(file) { return file.startsWith("src/flow/engine/composition/"); }
  isService(file) { return file.startsWith("src/flow/services/"); }
  isDefinitionBoundary(file) { return file === "src/flow/definition.js" || file === "src/flow/engine/step-result.js"; }
  isSettlementWriter(file) { return /^src\/flow\/services\/[a-z-]+-settlement-writer\.js$/.test(file); }
  isStepBase(file, exportName) { return file === "src/flow/engine/step.js" && exportName === "Step"; }
  isWithinEntry(file, entry) { return file.startsWith(`${entry}/`); }
  isClosureRole(role) { return role === "step" || role === "helper" || role === "contract"; }
  isServiceBoundary(role) { return role === "service"; }
  canTraverse(fromRole, toRole) {
    return this.isClosureRole(fromRole) && (toRole === "helper" || toRole === "contract");
  }
  builtin(specifier) {
    const name = specifier.replace(/^node:/, "");
    return builtins.has(name) ? name : null;
  }
  allowsBuiltin(name) { return allowedBuiltins.has(name); }
  role(file, module, isStepClass) {
    if (this.isComposition(file)) return "composition";
    if (contracts.has(file)) return "contract";
    if (module.classes.some(isStepClass)) return "step";
    if (this.isService(file)) return "service";
    if (file === "src/flow/definition.js" || file === "src/flow/registry.js" || file.startsWith("src/flow/engine/")
      || /^src\/flow\/lib\/(?:run-|get-|set-|current-flow-state\.js$|.*-store\.js$)/.test(file)) return "forbidden";
    if (file.startsWith("src/flow/steps/") || file.startsWith("src/lib/") || /^src\/.+\/lib\//.test(file)) return "helper";
    return "unknown";
  }
  violationRule(fromRole, toRole) {
    if (this.isServiceBoundary(toRole)) return fromRole === "step" ? "A02" : "A04";
    return fromRole === "step" ? "A02" : "A03";
  }
}
