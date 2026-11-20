#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class CiNodeMatrix {
  constructor(packageManifest) {
    const engineRange = packageManifest.engines?.node;
    const minimum = typeof engineRange === "string"
      ? engineRange.match(/^>=\s*(\d+\.\d+\.\d+)$/)?.[1]
      : undefined;
    if (!minimum) throw new TypeError("package.json engines.node must be a single >=MAJOR.MINOR.PATCH minimum");

    this.minimumNodeVersion = minimum;
    Object.freeze(this);
  }

  toJSON() {
    return {
      include: [
        { lane: "minimum", "node-version": this.minimumNodeVersion },
        { lane: "current-lts", "node-version": "lts/*" },
      ],
    };
  }
}

function writeOutput(value) {
  const output = process.env.GITHUB_OUTPUT;
  const serialized = JSON.stringify(value);
  if (output) fs.appendFileSync(output, `matrix=${serialized}\n`);
  else process.stdout.write(`${serialized}\n`);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && scriptPath === path.resolve(process.argv[1])) {
  const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  writeOutput(new CiNodeMatrix(manifest));
}
