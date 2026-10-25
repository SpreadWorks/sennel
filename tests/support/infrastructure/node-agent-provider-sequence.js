import fs from "node:fs";
import path from "node:path";
import { ClaudeProvider, ProviderRegistry } from "../../../src/lib/provider.js";

// Preserve the real provider parser and requested/reported identity while the
// executable itself is a deterministic Node program owned by the test.
class NodeFixtureClaudeProvider extends ClaudeProvider {
  systemPromptFlag() { return null; }
}

class NodeFixtureProviderRegistry extends ProviderRegistry {
  resolveByCommand(command) {
    return command === process.execPath ? new NodeFixtureClaudeProvider() : super.resolveByCommand(command);
  }
}

/** The caller owns the root and its quiescent cleanup. Each actual child consumes
 * one response; admission refusals and failed spawns cannot advance this count. */
export class NodeAgentProviderSequence {
  constructor(root, outputs, { profile = {} } = {}) {
    this.root = root;
    this.counterPath = path.join(root, "provider-start-count");
    this.sequencePath = path.join(root, "provider-sequence.json");
    this.scriptPath = path.join(root, "provider-sequence.cjs");
    this.releasePaths = outputs.map((output, index) => output.hold === true
      ? path.join(root, `provider-release-${index}`) : null);
    const sequence = outputs.map((output, index) => {
      if (output.error) throw new TypeError("A provider sequence cannot synthesize a spawn or control failure");
      return { stdout: output.stdout ?? JSON.stringify(output.response), code: output.code ?? 0,
        pending: output.pending === true, releasePath: this.releasePaths[index] };
    });
    fs.writeFileSync(this.sequencePath, JSON.stringify(sequence));
    fs.writeFileSync(this.scriptPath, `
      const fs = require("node:fs");
      const path = require("node:path");
      const counter = ${JSON.stringify(this.counterPath)};
      const sequence = JSON.parse(fs.readFileSync(${JSON.stringify(this.sequencePath)}, "utf8"));
      const index = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
      const output = sequence[index];
      fs.writeFileSync(counter, String(index + 1));
      if (!output) throw new Error("No provider response remains for this actual start");
      if (output.releasePath && !fs.existsSync(output.releasePath)) {
        const watcher = fs.watch(path.dirname(output.releasePath), () => {
          if (fs.existsSync(output.releasePath)) watcher.close();
        });
        // Cover release between the initial check and watch registration.
        if (fs.existsSync(output.releasePath)) watcher.close();
      }
      if (output.pending) setInterval(() => {}, 1000);
      process.exitCode = output.code;
      if (output.stdout) process.stdout.write(output.stdout);
    `);
    this.profile = Object.freeze({ ...profile, command: process.execPath,
      args: [this.scriptPath, ...(profile.args ?? ["{{PROMPT}}"])],
      jsonOutputFlag: profile.jsonOutputFlag ?? "--json" });
  }

  registry(profileKey) {
    return new NodeFixtureProviderRegistry({ [profileKey]: this.profile });
  }

  release(index) { fs.writeFileSync(this.releasePaths[index], "release"); }

  releaseAll() {
    for (const file of this.releasePaths) if (file !== null) fs.writeFileSync(file, "release");
  }

  starts() {
    return fs.existsSync(this.counterPath) ? Number(fs.readFileSync(this.counterPath, "utf8")) : 0;
  }
}
