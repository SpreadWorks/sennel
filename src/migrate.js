#!/usr/bin/env node
/** Public, revisioned project migrations. */

import { repoRoot } from "./lib/cli.js";
import {
  MigrationRegistry,
  MigrationComponentExecutor,
  MigrationRevision,
  MigrationPlan,
  migrationSuccessLine,
} from "./lib/migration.js";
import { LayoutMigrationRevisionOne } from "./lib/layout-migration.js";
import { FlowSpecId } from "./lib/flow-spec-id.js";

const COMPONENTS = new Set(["layout", "specs"]);

class MigrationCommandOutput {
  constructor({ dryRun }) {
    this.dryRun = dryRun;
    this.lines = [];
    this.errors = [];
  }

  log(message = "") {
    const text = String(message);
    if (this.dryRun) console.log(text);
    else this.lines.push(text);
  }

  error(message = "") {
    const text = String(message);
    if (this.dryRun) console.error(text);
    else this.errors.push(text);
  }

  flushErrors() {
    for (const line of this.errors) console.error(line);
  }
}

function parseTarget(value) {
  if (value == null) throw new Error("Missing required option: --to");
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("--to must be a positive revision number");
  return Number(value);
}

/** Parses only the intentionally narrow public CLI surface. */
export function parseMigrateArgs(argv) {
  const [component, ...rest] = argv;
  if (!COMPONENTS.has(component)) {
    throw new Error("Usage: sennel migrate <layout|specs> --to <revision> [--spec <specId>] [--dry-run]");
  }
  let to = null;
  let dryRun = false;
  let help = false;
  let specId = null;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "-h" || argument === "--help") {
      help = true;
      continue;
    }
    if (argument === "--dry-run") {
      if (dryRun) throw new Error("--dry-run may only be supplied once");
      dryRun = true;
      continue;
    }
    if (argument === "--to") {
      if (to !== null) throw new Error("--to may only be supplied once");
      to = parseTarget(rest[index + 1]);
      index += 1;
      continue;
    }
    if (argument === "--spec") {
      if (component !== "specs") throw new Error("--spec is only available for specs migrations");
      if (specId !== null) throw new Error("--spec may only be supplied once");
      const value = rest[index + 1];
      if (value == null || value.startsWith("-")) throw new Error("Missing required value: --spec");
      specId = FlowSpecId.from(value).toString();
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return Object.freeze({ component, to: help ? to : parseTarget(to), specId, dryRun, help });
}

function printHelp(component = null) {
  if (component === "layout") {
    console.log("Usage: sennel migrate layout --to 1 [--dry-run]\n\nMigrate the managed project layout to a target revision.");
    return;
  }
  if (component === "specs") {
    console.log("Usage: sennel migrate specs --to <revision> [--spec <specId>] [--dry-run]\n\nMigrate Flow specifications to a target revision. --spec selects one literal spec ID; omit it to migrate all specs in the configured root. Apply revisions 2, 3, and 4 in order when required.");
    return;
  }
  console.log("Usage: sennel migrate <layout|specs> --to <revision> [--spec <specId>] [--dry-run]");
}

function registry() {
  const layoutRevision = new MigrationRevision({
      component: "layout",
      revision: 1,
      apply({ root, dryRun, output }) {
        const migration = new LayoutMigrationRevisionOne(root, { dryRun, logger: output });
        return migration.run();
      },
    });
  const specsRevision = new MigrationRevision({
      component: "specs",
      revision: 1,
      apply: async ({ root, dryRun, output, specId, targetRevision = 1 }) => {
        const { SpecsMigrationRevisionOne } = await import("./lib/specs-migration.js");
        return new SpecsMigrationRevisionOne(root, { dryRun, logger: output, specId, targetRevision }).run();
      },
    });
  const specsRevisionTwo = new MigrationRevision({
    component: "specs",
    revision: 2,
    apply: async () => ({ complete: true }),
  });
  const specsRevisionThree = new MigrationRevision({
    component: "specs",
    revision: 3,
    apply: async ({ root, dryRun, output, specId }) => {
      const { SpecsMigrationRevisionThree } = await import("./lib/specs-migration.js");
      return new SpecsMigrationRevisionThree(root, { dryRun, logger: output, specId }).run();
    },
  });
  const specsRevisionFour = new MigrationRevision({
    component: "specs",
    revision: 4,
    apply: async ({ root, dryRun, output, specId }) => {
      const { SpecsMigrationRevisionFour } = await import("./lib/specs-migration.js");
      return new SpecsMigrationRevisionFour(root, { dryRun, logger: output, specId }).run();
    },
  });
  const executeSpecsRoute = ({ plan, ...context }) => specsRevision.apply({
    ...context,
    targetRevision: plan.toRevision,
  });
  return new MigrationRegistry({
    revisions: [layoutRevision, specsRevision, specsRevisionTwo, specsRevisionThree, specsRevisionFour],
    executors: [
      new MigrationComponentExecutor({
        component: "layout",
        executePlan: ({ plan, ...context }) => {
          if (plan.revisions.length !== 1 || plan.revisions[0] !== layoutRevision) throw new Error("layout migration executor only supports revision 1");
          return layoutRevision.apply(context);
        },
      }),
      new MigrationComponentExecutor({
        component: "specs",
        executePlan: ({ plan, ...context }) => plan.toRevision === 4
          ? specsRevisionFour.apply(context)
          : plan.toRevision === 3
            ? specsRevisionThree.apply(context)
            : executeSpecsRoute({ plan, ...context }),
      }),
    ],
  });
}

async function execute(cli) {
  const migrations = registry();
  const route = migrations.route(cli.component, { toRevision: cli.to });
  const plan = new MigrationPlan({
    component: cli.component,
    fromRevision: 0,
    toRevision: cli.to,
    revisions: route,
  });
  const output = new MigrationCommandOutput({ dryRun: cli.dryRun });
  const { container } = await import("./lib/container.js");
  const root = cli.component === "specs" ? container.get("mainRoot") : repoRoot();
  const outcome = {
    complete: true,
    ...((await migrations.execute(plan, { root, dryRun: cli.dryRun, specId: cli.specId, output }) || {})),
  };
  output.flushErrors();
  if (outcome.requiresRecovery || outcome.complete === false) {
    if (!cli.dryRun && output.errors.length === 0) console.error(`migrate ${cli.component} did not reach revision ${cli.to}`);
    process.exitCode = 1;
    return;
  }
  if (!cli.dryRun) {
    for (const assessment of outcome.assessments ?? []) console.log(JSON.stringify({
      component: cli.component, appliedMigrationRevision: cli.to, remaining: assessment,
    }));
    console.log(migrationSuccessLine(cli.component, cli.to));
  }
}

export async function main() {
  let cli;
  try {
    cli = parseMigrateArgs(process.argv.slice(2));
    if (cli.help) {
      printHelp(cli.component);
      return;
    }
    await execute(cli);
  } catch (error) {
    console.error(`migrate failed: ${error.message}`);
    process.exitCode = 1;
  }
}
