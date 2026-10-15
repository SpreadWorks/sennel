# GitHub provider configuration

Sennel selects its GitHub command through `.sennel/config.json`. With no `github` section, the built-in `gh` provider is selected. This default does not enable the pull request route: `commands.gh` continues to control that existing policy.

The built-in provider accepts process limits directly under `github`:

```json
{
  "github": {
    "provider": "gh",
    "timeout": 30000,
    "maxBuffer": 4194304,
    "maxAttempts": 2,
    "repository": {
      "host": "github.com",
      "name": "owner/repository"
    }
  }
}
```

Timeout is a positive integer number of milliseconds, up to Node.js's `2147483647` millisecond timer limit. `maxBuffer` is a positive safe integer byte limit and `maxAttempts` is an integer from 1 through 5. The defaults are 30000, 4194304, and 2.

An external provider is a named executable with an argv array. Its name is selected through `github.provider`; `gh` is reserved for the built-in adapter:

```json
{
  "github": {
    "provider": "my-github-bridge",
    "providers": {
      "my-github-bridge": {
        "command": "/usr/local/bin/github-bridge",
        "args": ["--stdio"],
        "timeout": 45000,
        "maxBuffer": 8388608,
        "maxAttempts": 3
      }
    },
    "repository": {
      "host": "github.com",
      "name": "owner/repository"
    }
  }
}
```

`command` must name a non-empty executable and every `args` item must be a string. The command is invoked with argv and without a shell. Provider credentials belong in the executable's normal credential source, never in this configuration. `repository` is optional and, when supplied, fixes the host and `owner/repository` identity for GitHub operations.

The existing Flow Git remote still controls where the feature branch is pushed. Configure that remote for the intended PR repository; selecting a provider or repository does not rewrite Git remotes.

An unknown selected provider, a `github.providers.gh` entry, invalid limits, or an invalid repository identity causes configuration validation to fail. Existing `commands.gh` pull request policy remains independent: unset or disabled keeps its current squash behavior, and enabling it selects the configured provider for the PR route.

## External command protocol

The external executable reads one JSON request from stdin and writes one JSON response to stdout. Revision 1 requests have this envelope:

```json
{
  "revision": 1,
  "requestId": "request identity",
  "operation": "issue.get",
  "context": {
    "cwd": "/absolute/execution/root",
    "repository": { "host": "github.com", "name": "owner/repository" }
  },
  "payload": { "number": 42 },
  "idempotencyKey": "optional for reads; required for writes"
}
```

`idempotencyKey` is omitted for operations that do not use it. Writes require it. The context pins both the execution directory and repository for the operation. Payload fields and accepted operation names are defined by the typed request classes in `src/lib/github/requests.js`.

Responses echo the revision, request ID, and operation exactly. A successful response has `{ "revision": 1, "requestId": "…", "operation": "…", "ok": true, "data": { ... } }`, where `data` is the operation's typed wire value from `src/lib/github/values.js`. A failed response has `{ "revision": 1, "requestId": "…", "operation": "…", "ok": false, "failure": { "code": "GITHUB_…" } }`. Failure codes are stable provider failure codes; diagnostic text, stderr, credentials, and tokens are not returned as domain data.

The public readiness check is `sennel flow get check github`. It returns a `github` preflight value along with the normal check result. `sennel flow get resolve-context` includes the same preflight JSON under its top-level `github` field. Both report provider readiness, authentication, repository access, resolved repository identity, or a stable failure code. These are preflight/readiness views; they do not change the existing PR route policy.

## Operations and identities

Core callers use `resolveGitHubProvider(config)` from `src/lib/github/provider.js`. This factory owns configuration assembly: explicit invocation config takes precedence over registered CLI config, and an absent config uses the defaults. The domain provider and configuration validator do not read CLI state. Callers pass an absolute `cwd` to every call, resolve preflight once for the operation, and pass its repository to subsequent calls. Every response is checked against the requested repository and resource number. The provider returns immutable domain classes; their `toJSON()` and strict `fromJSON()` methods define the same wire values for both adapters.

| Provider method | Protocol operation | Payload | Result |
| --- | --- | --- | --- |
| `preflight` | `provider.preflight` | empty | `GitHubPreflight` |
| `getIssue` | `issue.get` | `number` | `GitHubIssue` |
| `getPullRequest` | `pull-request.get` | `number` | `GitHubPullRequest` |
| `getPullRequestSources` | `pull-request.sources` | `number` | `GitHubPullRequestSources` |
| `findPullRequest` | `pull-request.search` | `base`, `head`, `expectedHeadOid` | complete collection of PRs, reconciled to one PR or absence |
| `createPullRequest` | `pull-request.create` | previous fields plus `title`, `body` | remotely confirmed `GitHubPullRequest` |
| `findComment` | `comment.search` | `number`, `target` | complete conversation comment collection, reconciled to one comment or absence |
| `deliverComment` | `comment.create` | previous fields plus `body` | remotely confirmed comment and delivery receipt |

Both search and create operations require `idempotencyKey` in the request envelope. Comment `target` is `issue` or `pull-request`; it refers to a conversation comment, not a review-thread reply. `deliverComment` returns a `GitHubCommentDelivery` with the comment identity, key, and `resumed` flag. Adapters return the comment itself for `comment.create`; the provider owns reconciliation and receipt construction.

Repository identity consists of a host and `owner/repository`, normalized to lowercase. PR values include the base and head repositories separately, including fork identity and deleted head branches. Non-merged PRs have `mergeOid: null`. `fetchLocator` pins the base repository, read-only PR head ref, and observed `headOid`. `getPullRequest` checks that ref through the GitHub API: an absent or inaccessible ref returns `state: "unavailable"` with a safe failure code; a changed OID returns reason `HEAD_CHANGED`. Head branch deletion is reported separately and does not imply that the base repository's PR ref is deleted. Actual Git transfer and verification of the fetched OID remain the Git caller's responsibility because the ref can move after it is observed.

## Completeness and head observations

`GitHubPullRequestSources` contains ordered collections for timeline events, reviews, conversation comments, review threads, commits, PR file diffs, and per-commit diffs. Each collection carries its repository, observation head OID, `complete`, `cursor`, and `reason`. Thread comments have their own collection so a truncated reply connection cannot be hidden by a complete outer thread list. Per-commit diffs similarly retain file-level availability.

The built-in adapter traverses REST pagination and each GraphQL connection independently. It validates connection counts, advancing cursors, and duplicate identities. File limits, omitted patches, and unavailable sources remain incomplete with explicit reasons. An empty incomplete collection does not mean that there were no changes or feedback. External adapters must return the same fields, including `complete: false` and a reason whenever retrieval is incomplete.

Fetch, collection and file-diff reasons accept only stable provider failure codes or `HEAD_CHANGED`, `HEAD_LINEAGE_CHANGED`, `FILE_LIMIT_REACHED`, `PATCH_OMITTED`, `COMMITS_UNAVAILABLE`, and `PAGE_LIMIT`. Multiple reasons use commas without spaces. Unknown codes and free-form diagnostic messages are rejected at the shared value boundary so external stderr or secret diagnostic text cannot enter these fields.

Source acquisition observes PR head before and after reading all collections. Different OIDs produce `consistent: false`; a commit inventory that does not reach its observed head is incomplete. A complete commit inventory requires a matching per-commit diff inventory. The aggregate `complete` getter requires consistent observations, complete collections and replies, and available patches. Historical review/comment commit OIDs may differ from the current head; those associations are retained for later analysis.

## Write recovery and failures

Writes use the exact marker `<!-- sennel:<idempotencyKey> -->`. A search must prove complete absence before creating a PR or comment. PR candidates must match the submitted base, head repository/branch, marker, and expected head OID. Multiple candidates or foreign identities fail with `GITHUB_CONFLICT`. A reused comment must have the exact intended body.

After a successful response, the provider independently reads remote evidence and verifies its identity and body. After a lost or failed write response, it performs the same readback before considering another write. Unreadable or incomplete evidence results in `GITHUB_WRITE_OUTCOME_UNKNOWN`; it does not authorize a blind retry. A confirmed remote write is reused across provider reconstruction with the same key. This guarantee assumes the caller's existing operation lock/outbox serializes writes with that key. Markers are reconciliation evidence and do not provide an atomic lock against unrelated external writers.

Read retries are limited by `maxAttempts` and retain the request identity. Only `GITHUB_TRANSPORT`, `GITHUB_RATE_LIMIT`, and `GITHUB_TIMEOUT` are retryable. Other stable codes are `GITHUB_UNAVAILABLE`, `GITHUB_AUTHENTICATION`, `GITHUB_REPOSITORY_ACCESS`, `GITHUB_NOT_FOUND`, `GITHUB_CONFLICT`, `GITHUB_SIGNAL`, `GITHUB_CANCELLED`, `GITHUB_PROCESS_FAILURE`, `GITHUB_INVALID_OUTPUT`, `GITHUB_OUTPUT_LIMIT`, `GITHUB_WRITE_OUTCOME_UNKNOWN`, and `GITHUB_INVALID_REQUEST`. Failure messages are fixed safe text. External failure envelopes contain only a supported code; arbitrary diagnostic text is rejected. Existing process-control failures propagate through the shared process boundary.

Finalization obtains the expected submitted OID from persisted `FinalizationExecutionIdentity.expectedFeatureSha`. Its existing outbox/evidence stores repository, PR number, URL, and confirmed head OID. Provider readiness is checked before Git push on the enabled PR route. PR failure preserves the submitted Git HEAD while recording canonical failure and audit state; Definition selects conflict metadata commits only for squash recovery. PR submission continues to produce the existing PR-opened Await result. Linked Issue report delivery continues to publish pending state before posting and to stop on final delivery failure; recovery reuses the same canonical outbox key.

## Focused verification

The ordinary tests use deterministic adapters and local Git repositories, without network, GitHub writes, or AI execution:

```sh
node tests/run.js --file tests/unit/github-provider.test.js tests/unit/github-gh-adapter.test.js tests/integration/github-command-provider.test.js tests/integration/lib/github-config.test.js tests/integration/flow/github-consumer-routing.test.js
```

Existing finalization and report scenarios additionally exercise actual local push, PR response-loss recovery, durable repository/number/head OID readback, PR Await, and pending report delivery. The Draft and Spec artifact scenarios cover the existing immutable Issue snapshot's downstream use. `npm test` runs the full deterministic suite.
