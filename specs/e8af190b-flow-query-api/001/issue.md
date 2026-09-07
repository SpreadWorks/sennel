## Overview

As `[Flow Foundation Reorganization 11/12]`, add a read-only public query API that allows Workspace / Connector to retrieve Sennel's canonical Flow Version without depending on the internal filesystem layout.

The public entrypoint is `sennel flow query`. It does not return a Workspace-specific view model; instead, it returns the validated public schema projected directly from the canonical Store.

## Purpose

Rather than the previous proposal of returning a single snapshot, allow two resources with different use cases to be retrieved individually from the same command.

- `metadata`: current metadata for one selected Flow Version
- `activities`: confirmed Activity sequence for one selected Flow Version

Consumers retrieve and use the required resources separately.

## Prerequisites / Dependencies

- `597f` (4/12): artifact contract
- `b9b4` (7/12): canonical runtime
- `900a` (9/12): migration
- `eee7` (10/12): Git tracking boundary

## Public Boundary

- Production inputs are limited to the canonical Version Store, `flow.json`, `spec.json`, Activity ledger, and Artifact catalog
- Fresh Flows and migrated Flows go through the same reader / validator
- The query side must not directly parse the old layout, migration reports, raw logs, or temporary files
- Only `active` / `parked` / `finalized` are exposed as lifecycle values
- `blocked` is not a lifecycle value; it is derived from the current Attempt failure and `nextAction().operation === "blocked"`
- The start time of a fresh Flow uses the first `flow_created` Activity as the authority
- If a migrated Flow has no creation evidence, return `unavailable` with reason / provenance instead of inferring it
- Finalized Versions are immutable; active / parked Versions return the latest committed state at query start and the corresponding confirmed Activity prefix
- Query is read-only and must not modify the ledger / state / catalog / cache / Git working tree

## CLI / Request Contract

```console
sennel flow query < request.json
sennel flow query --request-file request.json
```

- Accept exactly one JSON object as the request
- stdin and `--request-file` cannot be specified together
- The request itself does not include a schema revision field
- stdout contains exactly one JSON response. Do not mix in diagnostics
- `resource` and `condition` are required
- Unknown fields, unknown resources, and fields inappropriate for the resource are boundary validation errors
- `condition.specId` is a required single string for both resources
- Multiple Specs, partial matches, and `in` searches are not supported
- `condition.flowVersion` is a positive safe integer. If omitted, select `1`; if it does not exist, do not implicitly fall back to another Version
- The request does not include `cardinality` / `order`; the response shape and order are fixed by the resource contract

## Resource Contract

### `metadata`

- If `flowVersion` is omitted, read Version 1
- Pagination / datetime conditions are not accepted
- A success response returns a single `item`
- `item` is projected to the public schema from the validated current Flow state, Spec record, and Artifact catalog
- Public fields:
  - `flowId`, `flowVersionId`, `runId`, `specId`, `flowVersion`
  - lifecycle, current location, structure, Step / Task relationships, issue references
  - derived blocked state, blocker, next action / recovery information
  - authority-backed timestamps for creation / update / finalize
  - capability and deterministic aggregate metrics at Flow Version scope
  - public Artifact IDs, schema-defined metadata, relations to Activity / node / Task
- Timestamps that cannot be proven return `unavailable` / provenance
- Do not expose the Artifact catalog itself, `relativePath`, internal file names, or Artifact bodies
- Public Artifact IDs are constructed deterministically from canonical information such as `logicalKey`, `memberId`, `hash`, and `activityId`
- Cost is returned only when the provider recorded an actual measured value; do not estimate it from token counts

### `activities`

- `page` is required
- `limit` is an integer from 1 to 100 inclusive; initial `after` is `null`
- `recordedAt` is optional and accepts either or both of `gte` / `lt`. If both are present, `gte < lt`
- Datetimes must be valid ISO 8601 with timezone
- `recordedAt` is the time when the Activity was recorded and confirmed in the ledger, and the public value uses `timing.finishedAt` as the authority
- Do not use filesystem timestamps
- `items` are always returned in ascending `confirmationOrder`
- Public fields:
  - Activity ID, type, operation
  - node / Task / attempt identity
  - sequence, confirmationOrder, timing, usage, outcome
  - failure / blocker / incomplete
  - metric / note, evaluation / finding / repair / Artifact references
- Do not return raw logs, prompt bodies, Artifact bodies, checkpoints, transactions, locks, or temp data
- Zero matching records is still success and returns `items: []`

## Pagination

- `activities` uses opaque cursors
- Response `pageInfo` contains `limit`, `endCursor`, and `hasNext`
- The cursor is bound to the resource, `specId`, selected Flow Version, datetime conditions, and the last returned `confirmationOrder`
- Reusing or modifying a cursor for a different query is a machine-readable error
- Because the Activity ledger is append-only and `confirmationOrder` is contiguous within a Version, the position of already-read Activities does not change even if new Activities are added to an active Version
- Offset pagination, total count, and request-side sort specification are not provided

## Response / Error Contract

- The response uses a query-specific top-level schema, not the existing generic Flow Envelope
- Consumers inspect `schemaRevision` and reject unsupported revisions
- Success shape:
  - `metadata`: always `item`
  - `activities`: always `items` and `pageInfo`
  - `selectedFlowVersion`: the Version explicitly requested, or Version 1 selected by omission
  - `availableFlowVersions`: canonical Flow Version numbers for the target `specId`, returned as an ascending array
- active / parked / finalized are all eligible for success; derived blocked state must not make the response non-success
- Because the request does not support revision / as-of fields, consumers must tolerate the possibility that a new Activity is committed between separate metadata / activities queries
- Invalid JSON, missing required fields, unknown fields, nonexistent Spec / Version, unreadable or inconsistent canonical records, and invalid cursors return `ok: false` with machine-readable `error.code` / `path` / `message`
- CLI exits with code 0 on success and non-zero on `ok: false`
- When a Version does not exist, do not implicitly fall back; include the retrieved `availableFlowVersions` in the error response
- For resource-level errors, `metadata` returns `item: null`; `activities` returns `items: []`; keep the shape stable for valid resources
- Request validation errors where the resource cannot be determined do not return resource-specific payloads
- Do not mix partial metadata / partial Activity into a success response
- The error code set and JSON Schema are centrally managed in production code and shared by the CLI, fixtures, and tests

## Implementation Scope

- Command routing for `sennel flow query`, stdin / `--request-file` input, and JSON-only output
- Request value object and resource-specific validation
- Canonical Version discovery and Version selection
- metadata reader / projector, Activity projector, public Artifact ID, metrics aggregator
- Opaque cursor encode / validate and ascending `confirmationOrder` pagination
- Query-specific Response Schema Revision 1 and error taxonomy
- Contract fixtures for fresh / migrated, active / parked / blocked-derived / finalized, with / without Git
- Consumer compatibility test

## Out of Scope

- Workspace-specific view models or recomposition of metadata / activities
- Exposing Artifact bodies, raw logs, prompts, internal paths, or the Artifact catalog itself
- Cross-Spec search, full-text search, arbitrary sort, offset pagination, Activity aggregate queries
- Flow Version creation or increment
- Creation of Version 2 and later is handled by `acf3` (12/12)
- Old layout parser, migration classifier, migration report dependency, backward-compatible fallback
- Updating Flow state / Activity / Artifact / cache through query

## Acceptance Criteria

- `sennel flow query` accepts a request from stdin or `--request-file` and returns only JSON using query-specific Schema Revision 1 on stdout
- `metadata` returns a single `item`; `activities` returns an `items` array; the request does not require `cardinality` or `order`
- A single `specId` is required for both resources; omitted `flowVersion` selects Version 1; an explicit value reads only that Version; the response returns `selectedFlowVersion` and ascending `availableFlowVersions`
- active / parked / finalized fixtures succeed, and blocked is represented as derived data
- metadata returns current state, Spec, public Artifact metadata / relations, and aggregate metrics; activities returns the confirmed Activity prefix in ascending `confirmationOrder`
- Activity datetime filtering works as `gte` / `lt` against the recorded authority and does not depend on filesystem timestamps
- Cursor pagination retrieves Activities without gaps or duplicates and rejects cursor reuse outside the query
- Finalized Versions are stable when fetched again with the same conditions; for active Versions, the order of already-read Activities and cursor position do not change after appends
- Fresh Flow start time is obtained from `flow_created`; migrated Flows without creation evidence return explicit `unavailable`
- Public Artifact relations can be resolved without internal paths, and the response does not contain `relativePath`, raw catalog, or Artifact bodies
- Nonexistent Spec / Version, invalid request / cursor, and unreadable or inconsistent records do not produce partial success; they return a stable resource-appropriate error response shape and non-zero exit code
- Adding canonical fixtures for Version 2 and later can be queried without changing Version 1 hardcoding in query code / schema
- Canonical files and the Git working tree are unchanged before and after query execution

<details>
<summary>ja</summary>

[Flow基盤再編 11/12] Workspace向けFlow query APIを公開する

## 概要

`[Flow基盤再編 11/12]` として、Workspace / Connector から Sennel の canonical Flow Version を内部 filesystem layout に依存せず取得できる read-only の公開 query API を追加する。

公開 entrypoint は `sennel flow query` とし、Workspace 固有の view model は返さず、canonical Store を検証した公開 schema をそのまま返す。

## 目的

単一 snapshot を返す従来案ではなく、同一 command から用途の異なる 2 つの resource を個別取得できるようにする。

- `metadata`: 選択した 1 Flow Version の現在メタデータ
- `activities`: 選択した 1 Flow Version に確定済みの Activity 列

consumer は必要な resource を別々に取得して利用する。

## 前提 / 依存

- `597f` (4/12): artifact contract
- `b9b4` (7/12): canonical runtime
- `900a` (9/12): migration
- `eee7` (10/12): Git 追跡境界

## 公開境界

- production input は canonical Version Store、`flow.json`、`spec.json`、Activity ledger、Artifact catalog のみ
- fresh Flow / migrated Flow は同じ reader / validator を通す
- 旧 layout、migration report、raw log、一時 file は query 側で直接解析しない
- lifecycle は `active` / `parked` / `finalized` のみを公開する
- `blocked` は lifecycle ではなく、現在 Attempt の failure と `nextAction().operation === "blocked"` から導出する
- fresh Flow の開始時刻は最初の `flow_created` Activity を authority とする
- migration で作成 evidence がない場合は推測せず、reason / provenance 付き `unavailable` を返す
- finalized Version は不変、active / parked Version は query 開始時点の最新 commit 済み state と対応する確定済み Activity prefix を返す
- query は read-only とし、ledger / state / catalog / cache / Git working tree を変更しない

## CLI / request contract

```console
sennel flow query < request.json
sennel flow query --request-file request.json
```

- request は JSON object 1 つのみ受け取る
- stdin と `--request-file` の同時指定は不可
- request 自体に schema revision 指定は持たせない
- stdout は JSON response 1 つのみ。診断文を混在させない
- `resource` と `condition` は必須
- 未知 field、未知 resource、resource に不適切な field は境界 validation error
- `condition.specId` は両 resource で必須の単一文字列
- 複数 Spec、部分一致、`in` 検索は行わない
- `condition.flowVersion` は正の safe integer。省略時は `1` を選択し、存在しない場合も他 Version へ暗黙 fallback しない
- request に `cardinality` / `order` は設けず、返却形と順序は resource contract で固定する

## Resource contract

### `metadata`

- `flowVersion` 省略時は Version 1 を読む
- pagination / 日時条件は受理しない
- success response は単一 `item` を返す
- `item` は検証済み current Flow state、Spec record、Artifact catalog から公開 schema へ project する
- 公開対象:
  - `flowId`、`flowVersionId`、`runId`、`specId`、`flowVersion`
  - lifecycle、current location、構造、Step / Task 関係、issue 参照
  - derived blocked 状態、blocker、next action / recovery information
  - 作成 / 更新 / finalize に関する authority 付き時刻
  - capability、Flow Version 単位の deterministic aggregate metrics
  - public Artifact ID、schema-defined metadata、Activity / node / Task との relation
- 証明できない時刻は `unavailable` / provenance を返す
- Artifact catalog 自体、`relativePath`、内部 file 名、Artifact 本文は公開しない
- public Artifact ID は `logicalKey`、`memberId`、`hash`、`activityId` など canonical 情報から決定的に構成する
- cost は provider が実測値を記録した場合のみ返し、token 数から推計しない

### `activities`

- `page` は必須
- `limit` は 1 以上 100 以下の整数、初回 `after` は `null`
- `recordedAt` は任意で、`gte` / `lt` の片方または両方を受理する。両方ある場合は `gte < lt`
- datetime は timezone を含む有効な ISO 8601 とする
- `recordedAt` は Activity が ledger へ記録・確定された日時であり、公開値は `timing.finishedAt` を authority とする
- filesystem timestamp は使わない
- `items` は常に `confirmationOrder` 昇順で返す
- 公開対象:
  - Activity ID、type、operation
  - node / Task / attempt identity
  - sequence、confirmationOrder、timing、usage、outcome
  - failure / blocker / incomplete
  - metric / note、evaluation / finding / repair / Artifact 参照
- raw log、prompt 本文、Artifact 本文、checkpoint、transaction、lock、temp は返さない
- 条件一致 0 件でも success とし、`items: []` を返す

## Pagination

- `activities` は opaque cursor 方式
- response の `pageInfo` は `limit`、`endCursor`、`hasNext` を持つ
- cursor は resource、`specId`、選択 Flow Version、日時条件、最後に返した `confirmationOrder` に binding する
- 異なる query への cursor 再利用や改変は機械可読 error
- Activity ledger は append-only かつ `confirmationOrder` が Version 内で連続するため、active Version に新規 Activity が追加されても既読 Activity の位置は変化しない
- offset pagination、total count、request 側 sort 指定は設けない

## Response / error contract

- response は既存の汎用 Flow Envelope ではなく、query 専用 top-level schema を持つ
- consumer は `schemaRevision` を検査し、未対応 revision を拒否する
- success shape:
  - `metadata`: 常に `item`
  - `activities`: 常に `items` と `pageInfo`
  - `selectedFlowVersion`: request で明示した Version、または省略時に選択された Version 1
  - `availableFlowVersions`: 対象 `specId` に存在する canonical Flow Version 番号を昇順配列で返す
- active / parked / finalized はすべて success 対象であり、derived blocked を理由に non-success にしない
- request に revision / as-of 指定は設けないため、metadata / activities を別 query した間に新 Activity が commit されうることは consumer 側で許容する
- invalid JSON、必須 field 不足、未知 field、存在しない Spec / Version、読取不能または不整合な canonical record、不正 cursor は `ok: false` と機械可読な `error.code` / `path` / `message` で返す
- CLI は success で exit code 0、`ok: false` で non-zero
- Version 不存在時も暗黙 fallback はせず、取得できた `availableFlowVersions` を error response に含める
- `metadata` の resource-level error では `item: null`、`activities` では `items: []` を返し、valid resource については shape を安定させる
- resource を確定できない request validation error では resource 固有 payload を返さない
- partial metadata / partial Activity を success に混在させない
- error code 集合と JSON Schema は production code で一元管理し、CLI・fixture・test で共有する

## 実装対象

- `sennel flow query` の command routing、stdin / `--request-file` 入力、JSON-only 出力
- request value object と resource ごとの validation
- canonical Version discovery と Version 選択
- metadata reader / projector、Activity projector、public Artifact ID、metrics aggregator
- opaque cursor の encode / validate と `confirmationOrder` 昇順 pagination
- query 専用 Response Schema Revision 1 と error taxonomy
- fresh / migrated、active / parked / blocked-derived / finalized、Git あり / なしの contract fixture
- consumer compatibility test

## 非対象

- Workspace 固有 view model や metadata / activities の再合成
- Artifact 本文、raw log、prompt、内部 path、Artifact catalog 自体の公開
- 複数 Spec 横断検索、全文検索、任意 sort、offset pagination、Activity 集計 query
- Flow Version の作成や増分
- Version 2 以降の作成は `acf3` (12/12) が担当
- 旧 layout parser、migration classifier、migration report 依存、後方互換 fallback
- query による Flow state / Activity / Artifact / cache 更新

## 受け入れ条件

- `sennel flow query` が stdin または `--request-file` から request を受け、stdout に query 専用 Schema Revision 1 の JSON のみを返す
- `metadata` は単一 `item`、`activities` は配列 `items` を返し、request に `cardinality` や `order` を要求しない
- 両 resource で単一 `specId` が必須、`flowVersion` 省略時は Version 1、明示時はその Version のみを読み、response に `selectedFlowVersion` と昇順 `availableFlowVersions` を返す
- active / parked / finalized fixture は success になり、blocked は derived data として表現される
- metadata は current state、Spec、公開 Artifact metadata / relation、aggregate metrics を返し、activities は確定済み Activity prefix を `confirmationOrder` 昇順で返す
- Activity 日時 filter が recorded authority に対する `gte` / `lt` として機能し、filesystem timestamp に依存しない
- cursor pagination で欠落・重複なく Activity を取得でき、cursor の query 外再利用を拒否する
- finalized Version は同条件の再取得で stable、active Version は append 後も既読 Activity の順序と cursor 位置が変化しない
- fresh Flow の開始時刻は `flow_created` から取得し、creation evidence のない migrated Flow は明示 `unavailable` を返す
- public Artifact relation を内部 path なしで解決でき、response に `relativePath`、raw catalog、Artifact 本文が現れない
- 不存在 Spec / Version、不正 request / cursor、読取不能・不整合 record は partial success にせず、resource に応じた安定 shape の error response と non-zero exit code を返す
- Version 2 以降の canonical fixture を追加しても、query code / schema の Version 1 hardcode を変更せず取得できる
- query 実行前後で canonical files および Git working tree に変更がない

</details>
