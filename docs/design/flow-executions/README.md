# Flow 実行観測 query

`cf81` は既存の revision 3 query に `executions` を追加する。`metadata` と
`activities` の既存情報を保持し、同じ保存世代に対応する実行情報を公開する。
Workspace の実装、同期コマンドや provider 内部 tool の新しい観測、push 通知、
自動 GC は含めない。

## 利用方法

最初に metadata を取得し、その snapshot ID を後続の読み取りに渡す。

```sh
printf '%s\n' '{"resource":"metadata","condition":{"specId":"sample"}}' | sennel flow query
```

実行一覧の request は stdin または `--request-file` で渡す。

```json
{
  "resource": "executions",
  "condition": { "specId": "sample", "flowVersion": 1 },
  "target": {
    "nodeId": "spec-review",
    "includeDescendants": true,
    "attemptId": null
  },
  "page": { "limit": 1, "after": null },
  "expectSnapshotId": "sha256:<metadata の snapshot.id>"
}
```

`target` 省略時は Version 全体を選ぶ。指定時は3項目をすべて渡す。
`after` には直前の `pageInfo.endCursor` を渡し、`hasNext=false` まで取得する。
世代が変わった場合は `SNAPSHOT_CHANGED` で停止するので metadata から取得し直す。
`expectSnapshotId` は保持済みの過去 snapshot を要求する指定ではない。

実行ページは `items` と、そのページの参照を解決する `relations`、`endpoints`、
`measurements` を返す。実行 ID の UTF-8 byte 昇順で取得し、ページ間の relation は
ID で統合する。`summary` はページだけでなく target 全体の観測値である。
完全な取得には全ページの成功、同じ snapshot、unique item 数と totalItems の一致、
参照の解決が必要になる。`coverage` が partial / observed-only の場合、失われた履歴
を含む全実行の取得を意味しない。

## 保存責務と既存 API の再利用

| 情報 | 正本・共通実装 | query の責務 |
| --- | --- | --- |
| Step Attempt と結果 | canonical state / confirmed Activity ledger、`CurrentFlowAttemptHistory` | 同じ canonical replay で確認した開始・Result 確定・Attempt 終了を分けて投影 |
| Outbox の試行 | `CurrentFlowOutboxAttemptHistory`。運用 status と履歴 query が共有 | 保存された起点 binding と実際の結果を公開 |
| 論理 Agent / provider 試行 | `FlowExecutionObservationSession` と immutable catalog artifacts | ID、開始 binding、観測値の整合性検証 |
| 物理 call | `ProcessExecutionRuntime.readHistoricalInventory()` | 検証済み入力を選び、公開欄だけを投影 |
| 応答の受信・検証 | 既存 Prompt journal と canonical reader | 保存済み完全 identity から received を公開 |
| 応答の採用 | 既存 worker publication と同一 transaction の adoption artifact | 完全 identity と実際の publication を結ぶ |
| catalog / bytes の読み取り | `FlowArtifactCatalogSnapshotReader`、`QueryArtifactCapture` | 同じ capture に含まれる入力だけを使用 |

新しい source manifest は観測開始 boundary と runtime checkout authority を保持する。
Agent 開始または managed call の durable reservation の直前に保存し、工程の admission
で拒否された操作だけでは catalog に追加しない。必要な観測の保存に失敗した場合は
外部実行を開始しない。
再開で別 checkout を使う場合は別の immutable source を追加する。観測終了時の現在
cursor で所属を書き換えない。Outbox の起点 Attempt と、復旧後の実行を開始した実際の
Step Attempt は別々に保持する。

runtime の top-level record version、stop receipt、canonical Result と Definition の
遷移 authority は変更しない。query は PID の生存判定、lock、archive 作成、状態修復を
実行しない。終了した runtime、別 owner、削除済み checkout は、保持された authority /
inventory / archive / receipt を既存 runtime 層で検証する。

Attempt 履歴への再公開後も、古い Result が参照した bytes の hash を保持済み prefix
から検証する。writer と共通の `FlowArtifactAttemptHistory.prefixThrough()` / `toBytes()`
を使い、元の node・Attempt と保存された publication identity が一致する場合だけ解決する。
capture が検証した同じ `ReferenceResolver` を全 projection で共有し、最新の本文への
置き換えや、未解決の参照を opaque とする扱いは行わない。

実行中の call は、登録済み launcher と同一 identity の保存済み観測から開始時刻を
読み取る。canonical な物理状態・停止 receipt は独立して保持し、観測だけで停止済みや
工程成功にしない。任意の launcher 記録が保持されていない場合は、その時刻を
`unavailable / LAUNCHER_OBSERVATION_NOT_RETAINED` とする。保存済み停止 receipt がある
call の読取りは、廃棄可能な launcher spool に依存しない。

## 表示上の区別

- Step Attempt の `startedAt` は保存済みの開始時刻、`resultConfirmedAt` と `resultRef`
  はその Attempt の最新の確定済み Result を示す。実行 checkpoint、claim、publication、
  Await、park の Result が確定しても、同じ Attempt が継続中なら `timing.finishedAt`
  は `null` のまま。終了は canonical reducer が適用した前後の exact Attempt identity
  から確認し、失敗または別 Attempt への交代・完了の最初の保存境界を使う。境界の
  Result 確定時刻、Result がない場合は Activity の保存済み終了時刻を使い、欠測を
  別 Attempt の開始時刻や読取り時刻で補わない。同じ identity を再開する正規 recovery
  では終了を取り消し、過去の失敗 Result の確定と参照は保持する。新しい identity の
  retry や同じ node の再開では、以前の Attempt の終了時刻を変更しない。
- `response-ready` は Agent が返却可能な結果を記録した状態。受信側の journal 記録を
  確認できると `received` になる。採用は完全な応答 identity と publication の別の事実。
  標準 artifact worker と Acceptance の既存 journal を利用する。Acceptance の集約では
  reducer が実際に使用した completion の参照と、変換後の公開成果物の digest を保存する。
  canonical journal を使わない直接 Source worker や既存 custom command では、通常の
  Promise 返却だけから received / accepted を補わず、対応欄を `not-recorded` とする。
- OS の exit code と停止確認は Flow の成功を示さない。開始予約、実起動、停止、結果確定
  を分けて表示する。
- provider retry は同じ logical invocation 内の別試行。protocol retry は別の logical ID。
  semantic retry は正規に生成された別 Step Attempt。
- cache hit は論理呼び出しだけであり、架空の provider / process を作らない。
- requested model / effort と reported model / effort は別欄。報告のない値を profile 名で
  埋めない。
- `null` と測定された `0` は異なる。provider usage と最終 logical response metric は別
  scope であり、集計で足し合わせない。
- command descriptor は実際の launcher 入力に由来する。秘匿した引数位置を残し、絶対
  program path や引数本文を公開しない。`complete=false` を再実行可能コマンドと扱わない。
- 未記録・保持を証明できない情報・公開不可・管理対象外・該当なしを coverage で区別する。
  参照済み source の欠落や不一致は成功の空配列へ変換しない。

## 検証対応

| 保証する結果 | 正規 producer と保存・読み戻しの検証 |
| --- | --- |
| Attempt の開始・中間 Result 確定・終了、Await / park、retry・同一 identity recovery | `tests/integration/flow/query-execution-attempt-lifecycle.test.js` |
| Agent / provider / process の exact binding、モデル欠測、0 と null | `tests/integration/lib/agent-execution-observations.test.js`、`tests/integration/flow/query-executions.test.js` |
| ready、durable receiver、採用の区別 | `tests/integration/flow/execution-response-adoption.test.js`、`tests/integration/flow-cli/acceptance-response-adoption.test.js` と query 実行シナリオ |
| cache、metric / diagnostic 参照、保存失敗で副作用を再実行しない | Agent 観測シナリオと既存 provider / journal テスト |
| immutable source、別 checkout、固定 Outbox binding、終了時の保存 | `tests/integration/flow/execution-observation-storage.test.js` |
| 物理開始・停止、owner 交代、archive、checkout 削除、破損拒否 | `tests/integration/lib/process-execution-history.test.js` |
| admission 拒否時の非変更、観測保存前の起動拒否、managed call 単独の保存 | 同じ process history シナリオ |
| 観測の追記を許し、実際の source / 既存 catalog の変更を拒否 | `tests/integration/flow/task-review-execution-observations.test.js`、既存 Review protocol と storage シナリオ |
| Outbox 復旧後の実際の実行主体 | `tests/integration/flow-cli/finalization-phase-scenario.test.js` の `F09 exact Outbox recovery` |
| limit=1 の参照閉包、全ページの件数・世代、target 選択 | query 実行シナリオ |
| provider / protocol / semantic retry と並列・論理 / 物理の入れ子 | query 実行シナリオ、`protocol-execution-observations.test.js`、既存 Acceptance provider シナリオ |
| 3 resource の snapshot、runtime-only 更新、query 前後の bytes 一致 | query 実行シナリオと既存 query snapshot テスト |
| stdin / request-file / JSON / exit と source 破損 | query 実行シナリオの公開 CLI 呼び出し |
| 既存の詳細公開・Schema・具体値クラス | `tests/unit/flow-query-contract.test.js`、既存 query integration 群 |
| 再公開後の履歴 hash、元 Attempt / publisher の一致、参照の破損拒否 | `tests/unit/query-history-reference.test.js`、Acceptance の再公開 query シナリオ |

工程の生成・後続利用は既存の Draft / Spec 専用シナリオを実行する。Agent 関連の変更は
`npm run test:agent` で確認する。実行結果と比較基準は作業 worktree の `.tmp/cf81/`
に保持し、既存障害と新しい回帰を区別する。

既存の [query revision 3 の詳細公開契約](../flow-query-revision-3/README.md) と
その source bytes / detail examples は維持する。execution 欄がない旧例は観測不足を
明示する値に更新し、元の Review / Finding / Repair の意味や source bytes を変更しない。
