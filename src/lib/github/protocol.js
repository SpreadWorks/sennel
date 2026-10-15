import { GitHubFailure } from "./failure.js";
import { GITHUB_PROTOCOL_REVISION } from "./requests.js";
import { validateSchema } from "../schema-validate.js";
import { GitHubPreflight, GitHubIssue, GitHubPullRequest, GitHubPullRequestSources,
  GitHubCollection, GitHubComment } from "./values.js";

const ENVELOPE_FIELDS = { revision: { type: "integer", enum: [GITHUB_PROTOCOL_REVISION] },
  requestId: { type: "string", minLength: 1 }, operation: { type: "string", minLength: 1 } };
export const GITHUB_RESPONSE_SCHEMA = {
  oneOf: [
    { type: "object", additionalProperties: false, required: [...Object.keys(ENVELOPE_FIELDS), "ok", "data"],
      properties: { ...ENVELOPE_FIELDS, ok: { type: "boolean", enum: [true] }, data: { type: "object" } } },
    { type: "object", additionalProperties: false, required: [...Object.keys(ENVELOPE_FIELDS), "ok", "failure"],
      properties: { ...ENVELOPE_FIELDS, ok: { type: "boolean", enum: [false] },
        failure: { type: "object", additionalProperties: false, required: ["code"], properties: { code: { type: "string", minLength: 1 } } } } },
  ],
};

export function decodeGitHubResult(request, data) {
  try {
    let result;
    switch (request.operation) {
      case "provider.preflight": result = GitHubPreflight.fromJSON(data); break;
      case "issue.get": result = GitHubIssue.fromJSON(data); break;
      case "pull-request.get":
      case "pull-request.create": result = GitHubPullRequest.fromJSON(data); break;
      case "pull-request.search": result = data instanceof GitHubCollection ? data : GitHubCollection.decode(data, GitHubPullRequest); break;
      case "comment.search": result = data instanceof GitHubCollection ? data : GitHubCollection.decode(data, GitHubComment); break;
      case "comment.create": result = GitHubComment.fromJSON(data); break;
      case "pull-request.sources": result = GitHubPullRequestSources.fromJSON(data); break;
      default: throw new TypeError("Unsupported GitHub operation");
    }
    const expected = request.context.repository;
    if (expected !== null && result.repository !== null && !expected.equals(result.repository)) throw new TypeError("Repository identity differs");
    if (request.number !== undefined && result.number !== undefined && request.number !== result.number) throw new TypeError("Resource number differs");
    if (result instanceof GitHubPreflight && result.failureCode !== null && !GitHubFailure.supports(result.failureCode)) throw new TypeError("Unknown preflight failure");
    if (result instanceof GitHubCollection) {
      const Entry = request.operation === "pull-request.search" ? GitHubPullRequest : GitHubComment;
      if (result.entries.some((entry) => !(entry instanceof Entry) || !result.repository.equals(entry.repository)
        || (request.number !== undefined && entry.number !== request.number))) throw new TypeError("Collection identity differs");
    }
    return result;
  } catch (error) {
    if (error instanceof GitHubFailure) throw error;
    throw new GitHubFailure("GITHUB_INVALID_OUTPUT", request.operation);
  }
}

export function decodeGitHubResponse(request, stdout) {
  try {
    const response = JSON.parse(stdout);
    if (validateSchema(response, GITHUB_RESPONSE_SCHEMA).length || response.requestId !== request.requestId
      || response.operation !== request.operation) throw new TypeError("Invalid response envelope");
    if (response.ok) return decodeGitHubResult(request, response.data);
    if (!response.failure || typeof response.failure !== "object" || Array.isArray(response.failure)
      || Object.keys(response.failure).length !== 1 || !GitHubFailure.supports(response.failure.code)) throw new TypeError("Invalid failure envelope");
    throw new GitHubFailure(response.failure.code, request.operation);
  } catch (error) {
    if (error instanceof GitHubFailure) throw error;
    throw new GitHubFailure("GITHUB_INVALID_OUTPUT", request.operation);
  }
}
