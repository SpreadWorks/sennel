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
    throw new Error("Usage: sennel migrate <layout|specs> --to <revision> [--dry-run]");
  }
  let to = null;
  let dryRun = false;
  let help = false;
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
    throw new Error(`Unknown option: ${argument}`);
  }
  return Object.freeze({ component, to: help ? to : parseTarget(to), dryRun, help });
}

function printHelp(component = null) {
  if (component === "layout") {
    console.log("Usage: sennel migrate layout --to 1 [--dry-run]\n\nMigrate the managed project layout to a target revision.");
    return;
  }
  if (component === "specs") {
    console.log("Usage: sennel migrate specs --to 3 [--dry-run]\n\nMigrate Flow specifications to a target revision.");
    return;
  }
  console.log("Usage: sennel migrate <layout|specs> --to 1 [--dry-run]");
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
      apply: async ({ root, dryRun, output, targetRevision = 1 }) => {
        const { SpecsMigrationRevisionOne } = await import("./lib/specs-migration.js");
        return new SpecsMigrationRevisionOne(root, { dryRun, logger: output, targetRevision }).run();
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
    apply: async ({ root, dryRun, output }) => {
      const { SpecsMigrationRevisionThree } = await import("./lib/specs-migration.js");
      return new SpecsMigrationRevisionThree(root, { dryRun, logger: output }).run();
    },
  });
  const executeSpecsRoute = ({ plan, ...context }) => specsRevision.apply({
    ...context,
    targetRevision: plan.toRevision,
  });
  return new MigrationRegistry({
    revisions: [layoutRevision, specsRevision, specsRevisionTwo, specsRevisionThree],
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
        executePlan: ({ plan, ...context }) => plan.toRevision === 3
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
  const outcome = {
    complete: true,
    ...((await migrations.execute(plan, { root: repoRoot(), dryRun: cli.dryRun, output }) || {})),
  };
  output.flushErrors();
  if (outcome.requiresRecovery || outcome.complete === false) {
    if (!cli.dryRun && output.errors.length === 0) console.error(`migrate ${cli.component} did not reach revision ${cli.to}`);
    process.exitCode = 1;
    return;
  }
  if (!cli.dryRun) console.log(migrationSuccessLine(cli.component, cli.to));
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
