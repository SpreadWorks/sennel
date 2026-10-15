import { runCmd } from "../process.js";
import { classifyProcessFailure } from "./failure.js";
import { decodeGitHubResponse } from "./protocol.js";

/** One protocol invocation, using the existing process boundary and no shell. */
export class CommandGitHubAdapter {
  constructor(settings, { runner = runCmd } = {}) { this.settings = settings; this.runner = runner; }
  execute(request) {
    const result = this.runner(this.settings.command, this.settings.args, { cwd: request.context.cwd,
      input: `${JSON.stringify(request.toJSON())}\n`, timeout: this.settings.timeout, maxBuffer: this.settings.maxBuffer });
    if (!result.ok) throw classifyProcessFailure(result, request.operation);
    return decodeGitHubResponse(request, result.stdout);
  }
}
