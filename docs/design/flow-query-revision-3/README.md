# Flow query revision 3 の公開契約

`sennel flow query` の revision 3 は、保存済みの木構造、評価・指摘・修正の詳細、成果物情報を同じ snapshot 世代として返す。入力と resource は既存の `metadata` / `activities` を維持する。CLI の実装は [query.js](../../../src/flow/query.js)、公開契約の正本は [query-contract.js](../../../src/flow/query-contract.js) と [runtime Schema](../../../src/flow/schemas/query-response.schema.json) にある。

このディレクトリの Schema は対応する公開契約の資料、JSON 例は wire 形式と digest の規則を示す合成データである。例の source fixtures は現行 producer の完全な保存形式ではない。実際の保存・読み戻し・CLI 取得は [query.test.js](../../../tests/integration/flow/query.test.js) と [query-details.test.js](../../../tests/integration/flow/query-details.test.js) で別途検証する。過去に保存されなかった観測本文は復元しない。

## 成果物と確認方法

| 成果物 | 内容 |
| --- | --- |
| [request.schema.json](request.schema.json) | 既存 request と同じ型・値・必須条件を持つ Draft 2020-12 Schema 案 |
| [response.schema.json](response.schema.json) | revision 3 の成功・失敗 variant、必須プロパティ、閉じた詳細型 |
| [examples](examples/) | metadata、2ページの activities、snapshot 変更、詳細未保持、artifact 不整合、応答上限超過の JSON 例 |
| [契約検証](../../../tests/integration/flow/query-revision-3-design.test.js) | Schema、参照閉包、木構造、ID、hash、cursor、ページ併合、coverage と null の検証 |
| [実 CLI 検証](../../../tests/integration/flow/query.test.js) | 正規 producer の保存結果、再読み込み、標準入力 / request file、ページングと安全な拒否 |
| [producer シナリオ検証](../../../tests/integration/flow/query-producer-scenario.test.js) | 正規 producer、保存・再読み込み、query と consumer の接続 |
| [snapshot 境界検証](../../../tests/integration/flow/query-snapshot.test.js) | 保存 Version 一覧が変化したときの再取得と有限 retry 後の停止 |

リポジトリルートで次を実行する。

```sh
node --test tests/integration/flow/query-revision-3-design.test.js
node --test tests/integration/flow/query.test.js tests/integration/flow/query-details.test.js tests/integration/flow/query-snapshot.test.js tests/unit/flow-query-contract.test.js
node --test tests/integration/flow/query-producer-scenario.test.js
```

JSON 例は設計上の wire 形式を示す合成データである。例に付属する source bytes と digest 入力は ID 計算を検証するための資料であり、実 Flow の正規保存成果物ではない。

worktree またはインストール済み package の CLI では、次のように同じ入力を渡す。

```sh
node src/sennel.js flow query --request-file docs/design/flow-query-revision-3/examples/request-metadata.json
```

`example-flow` は形式例の ID なので、利用時には保存済みの specId と flowVersion に置き換える。標準入力から同じ JSON を渡してもよい。失敗時も1つの JSON 応答を stdout に返し、終了コードは `1` とする。

revision 3 の失敗応答は必須の `guidance` に説明、確認済み状態、次の行動を返す。未確認の状態は `unconfirmed` とし、query は実行認可や復旧 command を付与しない。bootstrap 失敗も同じ閉じた失敗 Schema で検証する。 `guidance.presentationDigest` は共通 producer が公開 directive と次の行動の表示から生成する SHA-256 であり、実行認可や復旧 binding ではない。bootstrap の directive は null として計算する。

## 入出力と取得手順

request の `condition.specId` は必須、`condition.flowVersion` は任意で、未指定時は既存どおり Version `1` を選択する。activities の `page` は `limit` と `after` を持ち、`limit=1..100`、初回の `after=null` とする。新しい必須パラメータ、resource、検索条件は追加しない。

```json
{"resource":"metadata","condition":{"specId":"example-flow","flowVersion":1}}
```

```json
{"resource":"activities","condition":{"specId":"example-flow","flowVersion":1},"page":{"limit":1,"after":null}}
```

1. metadata の `schemaRevision=3` と `ok=true` を確認し、snapshot ID を保存する。
2. 同条件の activities の先頭ページを取得し、snapshot ID を比較する。異なる場合は双方を破棄して metadata から取得し直す。
3. `endCursor` を次の `after` に渡し、全ページの snapshot ID を比較する。変化した場合は `SNAPSHOT_CHANGED` として途中のページを採用しない。
4. `ok=true` かつ `hasNext=false` まで走査する。`returnedItems` の合計と `totalItems`、Activity ID の重複、entity の同一性、参照閉包、coverage を確認してから結果を採用する。
5. 最終取得時点でも同じ世代であることが必要なら、metadata の snapshot ID を最後に再確認する。

初回 metadata と activities を結ぶ request パラメータはないため、初回の比較は consumer が行う。旧 snapshot を保持するサーバーは作らない。更新し続ける active Version で取得完了を保証しない。

## 保存情報の投影

`metadata.item.structure.nodes` は保存済み node の ID、key、kind、status、attemptSequence と順序付き親子関係を保持する。`rootNodeId`、`phaseIds`、従来の `stepIds` / `taskIds`、`relationships.stepTasks` / `taskNodes` は同じ木と整合させる。`stepIds` は phase / group を含む全 `kind=step` ID である。Task node の ID と Definition Step ID を混同しない。

role は `flow` / `phase` / `step` / `task` / `group`。phase は保存 kind ではないため、対応する Definition に分類根拠がある場合だけ `phase` にする。過去の Definition が不明なら `group` と `coverage.phaseClassification=not-recorded` を返す。親の状態は再計算しない。

displayName は保存済み spec title、明示 Definition label、key の順で選ぶ。`displayNameSource=key` の場合は `coverage.displayName=key-fallback` とする。保存元のない title や過去 Definition を推測しない。node result は outcome、confirmedAt、summary、公開 artifactRefs だけを返す。

`metadata.item.history` は origin、ledgerCoverage、execution、保存済み continuation を投影する。native の完全履歴と historical import の partial 履歴を区別する。移行時に存在しなかった Activity、Attempt、PASS 結果を補作しない。

## 詳細と参照閉包

適用済み Repair item の `change` は、保存済み操作の `replacement` または `edits` を返す。
`edits` は元の UTF-8 本文に対する `startByte` / `endByte` / `replacement` の配列であり、
現在の文書から変更内容を推測しない。削除操作は両値が null で、対象と操作種類が削除内容を示す。
discarded / skipped item は `change=null` とし、適用していない操作を修正結果へ昇格しない。
公開型は追加の `change` property を許可し、実queryはその値を明示する。
保存本文をそのまま返し、既存の response byte 上限を超える場合は従来の拒否契約を使う。

activities の items は保存済み confirmed Activity であり、details はその Activity 当時の観測である。各 entity は source と supportingSources、関連 Activity / evaluation / finding / repair ID を持つ。source には artifact の公開 ID と key、相対 path、hash、producer Activity、node、attempt、source entry、observation、format、JSON pointer を記録する。

JSON source は pointer で record を選択する。JSONL source は `sourceEntryId` を confirmed Activity ID とし、pointer は null。複数の正本を合成した場合は、使用した全出典を supportingSources に保持する。

Evaluation は producer の outcome と nativeCode、判定項目ごとの期待・観測・根拠を返し、再評価しない。Spec Review の terminal Result に保存された typed `StepResult` (`spec-review-passed` / `spec-review-advisory` / `spec-review-rejected`) は正本 ledger から Evaluation として返す。同一 Attempt・generation の retained Review publication は supporting source および Finding の依存元として結び付ける。publication 側 Finding は後から書き換えず、terminal Evaluation から Finding への一方向依存にするため、各ページで同じ ID と JSON を返す。generic な untyped confirmation に実 verdict がない場合は、元の `not-recorded` を維持する。Finding は完全 identity、本文、期待・観測・理由・推奨・根拠を返す。Repair は対象、操作、採用・破棄理由、根拠、関連 finding を返す。全文の old/new、diff、raw log、内部 receipt は含めない。

正規 Spec Review の checkpoint / claimed 実行制御 Activity は、保存された execution-required Result と typed receipt の exact binding を確認できる場合、全 detail を `not-applicable` とする。validated typed publication は findings を `available`、evaluations を `not-applicable` とし、terminal Activity は保存済み verdict の evaluation を `available` とする。このため、正常な checkpoint → claimed → publication → terminal の activities page 全体を `details=complete` とできる。generic な untyped confirmation に verdict が記録されていない場合は引き続き `not-recorded` とする。

Spec Review / Triage / Repair の正規 publication は、当時の canonical Review 記録を既存 `activity.evidence` の専用型へ保存する。現行 `review.json` は後続工程の authority として更新し、不変な証跡には各 Activity の指摘・分類・repair audit を保持する。query は同じ capture 内の証跡を Activity / owner / 選択 Flow / generation / identity / digest / audit stage に結び付けて読む。Finding の完全 identity は元の canonical Review path を維持し、実際の保存位置は不変証跡の `/review` 以下を source pointer とする。terminal Result は既存の pure Result factory と保存 publication の対応を検証し、publication の Finding を書き換えない。普通 Repair は audit の `inputDigest` が結び付く先行 Triage / Review の指摘を参照する。

不変証跡がない記録も、現行本文がその Activity の owner / generation / digest / 選択 Flow に完全一致する場合は既存の正規本文から読める。上書きで失われた過去本文を最新本文や audit から補作しない。不正な専用証跡を無視して本文へ fallback せず、複数候補も拒否する。追加する保存は Review の意味記録であり、任意日時の Flow 全体復元や文書全文・Git差分の公開ではない。

正規 Draft questions / coverage Review の checkpoint / claimed も、concrete Result と保存 receipt の binding を確認して全 detail を `not-applicable` とする。publication は保存本文の verdict / summary を Evaluation、blocking / advisory / repair target を Finding として返し、指摘が0件でも findings は `available` とする。terminal は同じ Attempt の publication の entity IDとJSONを参照する。coverage PASS の `complete_draft_completion` は保存済み `StepConnectionReceipt` に結び付く terminal として扱う。checkpoint を評価済みへ昇格せず、修正候補を適用済み Repair として返さない。

Draft publication の内部 `workerOutput` / `canonicalEvidence` / `canonicalTarget` は既存の保存型で検証するが、公開JSONへコピーしない。本文とEvidenceの対応、execution target、保存 command result を含む正規 publication intent の digest を、writer と共通の生成処理で保存 receipt に照合する。terminal は manifestDigest / inputDigest / target / generation / claim を含む完全な lifecycle binding と、保存 verdict に対応する既存 Result factory の結果を検証する。raw output、runtime seal、未保存の時刻は再生成しない。

Draft Attempt history は各 record の保存位置から source pointer を作り、実際の publication Activity を producer とする。history ファイル全体の descriptor は最新 publication を示すため、過去 Attempt に最新 producer を代入したり、過去 producer と最新 descriptor のActivity ID一致を要求したりしない。保持済みの各 record と exact publication receipt を検証し、terminal から読んでも publication から読んでも同じ entity を返す。正規 producer の Activity.timing が null の場合、recordedAt filter は既存契約どおりその Activity を除外し、result.confirmedAt を代用しない。

specific は `schemaId` で選択する閉じた型とする。Spec Review finding、Draft finding、Gate finding、Gate evaluation、ledger skip の variant を持つ。producer の未知意味フィールドを透過せず、対応する公開型がない場合は `DETAIL_UNAVAILABLE` とする。保存済み `continue_nonblocking` は ledger を正本に `kind=lifecycle-skip` として投影する。

criterion の `category` と `title` は保存された値を個別に返す。Gate criterion の `authority` は必須 nullable (`null` または `mechanical`) とし、正規 Gate producer の機械的判定 authority を保持する。Gate の target、level、phase、構造化 reasons、issues、failureKind / failureCode、prescription、diagnosisSummary は `gate-evaluation@1` に保持し、共通 explanation の値を上書きしない。公開 `gate-evaluation@1` specific は `taskId` (必須 nullable string)、`sourceFingerprint` (必須 nullable lowercase SHA-256)、`failureCategory` (必須 nullable。値がある場合は `{category: semantic|local|tooling, code: string|null}`)、`evaluationScope` (必須 nullable。値がある場合は `{phase,taskId,sourceFingerprint,contentFingerprint}`)、`warnings` (必須 nullable string 配列) を持つ。scope は保存値を既存 `GateEvaluationScope.fromJSON` で検証して公開する。制御 binding の lineage と Attempt は公開 source として検証にも使う。正規 `RunGateCommand` が保存した lineage / Attempt / scope / category を既存 API で検証し、Task 別 descriptor 選択および履歴 Attempt に結び付けて投影する。内部 `responseProtocolEvidence` も既存型で検証する既知フィールドだが、公開しない。

正規 `Observation` の既知 violation を `gate-finding@1` として返す。failureMode、requirementRef、where、refs、保存済み Spec revision / target / permission を型で検証する。NextAction diagnosis と criterion の同じ指摘を二重計数せず、鏡写しの本文が矛盾する場合は拒否する。Spec Gate の blocking 指摘には修復 producer と共通の完全 identity を使い、advisory が先に保存されていても blocking の既存 ID を変えない。未知 observation kind / 意味field は引き続き `DETAIL_UNAVAILABLE` とする。

Repair item の target は entity、id、field、relativePath、jsonPointer、collection、position を持つ。collection 対象の id は既存 `SpecRepairTarget.conflictKey(expectedDigest)` による locator とする。position が未指定でも保存済み expectedDigest で対象を区別できる。position の null は単なる append の補作ではなく、producer の digest による選択を保持する。no-op の修正は `status=skipped` とし nativeValue を保持し、適用・検証済みへ昇格しない。Spec Repair audit は `activityId` がなくても、validated descriptor と ActivityReviewPublication の identity / generation / digest / bytes / audit stage / outcome による既存の exact binding から正常な修正を返す。保存済み `activityId` がある場合は binding と矛盾する値を拒否する。現行 Review authority の形式と Flow 遷移は維持し、不変な Activity 証跡を追加する。

Gate の `plan_gate_repair` は issue-log 内の exact な計画と source evidence を検証し、`status=planned` の Repair として返す。適用操作を補作せず、元の Gate 指摘を参照する。Spec Gate Repair の checkpoint / claimed / worker publication は typed 実行管理として扱い、terminal の保存 audit から実際の採用操作と拒否診断を返す。完全な worker lifecycle、terminal Result、元 Gate Attempt / finding identity、計画、保存操作 digest を検証する。worker の semantic inputRevision と Spec bytes の baseRevision は異なる契約として検証する。拒否 group に保存されていない操作・対象・指摘を推測で埋めない。

旧 evaluationIds / findingIds / repairIds は保存された参照 ID のまま維持する。referenceBindings の各群は `{reference:{id,label},detailIds,availability,reason}` を持ち、reference.id は群内で一意、集合は対応する旧 ID 一覧と厳密に一致する。detailIds は対応する entity 群へ解決し、evaluation 参照を finding で代用しない。1つの旧参照が複数の観測へ解決されてもよい。旧 ID 欄が空でも producer artifact に保存された詳細は detailRefs に含める。

entities は各ページの detailRefs と、そこから辿れる evaluation / finding / repair 参照の推移閉包を含める。依存元 Activity が filter 外でも、その詳細は entities に含める。items へ filter 外 Activity を追加しない。artifact 参照は同一 snapshot の metadata.artifacts に解決する。

## deterministic ID と hash

以下で `C(value)` は JSON object key を各階層で辞書順に並べ、配列順序を維持した canonical JSON の UTF-8 bytes、`H(bytes)` は SHA-256 lowercase 64桁 hex とする。入力は有限数と正規の JSON 値に限定する。識別に使う整数は safe integer とする。

| ID | 計算 |
| --- | --- |
| 既存 artifactId | `H(C(descriptor publication identity))`。現行の logicalKey、kind、relativePath、hash、size、mediaType、authority、cardinality、memberId、publicationStep、retention、activityId、migrationMaterialization の組み合わせを維持 |
| artifactKey | `artifact:` + `H(C({flowVersionId,relativePath,kind,authority,cardinality,memberId}))` |
| findingKey | `finding:` + `H(C({flowVersionId,identity}))` |
| finding.id | `finding:` + `H(C({flowVersionId,producerActivityId,observationId,identity}))` |
| evaluation.id | `evaluation:` + `H(C({flowVersionId,producerActivityId,observationId,sourceEntryId}))` |
| repair.id | `repair:` + `H(C({flowVersionId,producerActivityId,observationId,sourceEntryId}))` |
| Spec Repair audit item.id | `repair-item:` + `H(C({flowVersionId,producerActivityId,observationId,jsonPointer}))`。`jsonPointer` は検証済み audit 内の正確な保存位置（`acceptedOperations` または `discardedOperations` とその index） |
| snapshot.id | `sha256:` + `H(C(snapshot identity inputs))` |

Finding の identity は `sourceArtifact` / `sourceStep` / `sourceFindingId` / `fingerprint` の4項目をすべて使う。sourceFindingId や fingerprint だけの代替検索はしない。本文や disposition の差は既存 fingerprint にすべて含まれるとは限らないため、findingKey と観測ごとの entity ID を分ける。不変 record のない可変配列の現在 index を過去 observation ID として使わない。

Spec Repair の audit item ID は producer Activity、publication generation、検証済み audit bytes 内の JSON pointer を address として決定的に作る。同じ operationDigest を持つ破棄 proposal が複数あっても保存件数を保ち、既存 `operationDigest` は非公開の参照 alias として旧 `repairIds` から detail へ解決する。この pointer は当時の generation / digest / bytes で内容が証明された record の位置であり、失われた履歴を現在の配列 index から補作しない。lifecycle-skip の item ID は保存された node reference ID を維持する。

artifactKey は path と公開責務に結び付き、同じ path・authority の内容更新では維持される。artifactId は publication に結び付き、内容 hash とは別である。既存 AuthoritySlot の claimKey を公開 key の代わりにしない。

artifact hash / size は保存 bytes に対して計算する。`flow.activities` だけは未 confirmed suffix を除いた prefix を対象とし、`hashScope=confirmed-prefix` とする。他は `file-bytes`。relativePath は指定 Version directory からの POSIX 相対 path で、authority は OS 権限ではなく公開責務の所有分類である。singleton の memberId は null、collection は非 null。

producerActivityId は保存 descriptor.activityId とする。system / import で未記録なら null。referencingActivityIds は正規 resolver が解決した confirmed Activity の全参照であり、既存 activityIds / nodeIds / taskIds の producer 関係は維持する。

## snapshot と cursor

snapshot は id、algorithm、capturedAt、confirmationOrder、catalogHash、projectionHash、availableFlowVersionsHash を持つ。identity 入力は次の閉じた object とする。

```text
{schemaRevision:2,flowVersionId,specId,flowVersion,catalogHash,
 confirmedLedgerHash,confirmationOrder,stateHash,specHash,
 projectionHash,availableFlowVersionsHash}
```

catalogHash は既存 catalog content hash。stateHash / specHash は同じ committed snapshot の保存 bytes、confirmedLedgerHash は confirmed prefix の bytes から計算する。projectionHash は使用した Definition、公開 mapping / Schema、表示資源の内容 digest を含む。availableFlowVersionsHash は昇順の保存 Version 一覧から計算する。

capturedAt は UTC とし ID 入力に含めない。同じ ID は同じ公開データ世代を示し、同じ wall-clock 時刻を意味しない。未 confirmed suffix の追加で ID は変化しない。Version 一覧は capture 前後で比較し、新 Version の追加も検出する。有限 retry で安定しない場合は `SNAPSHOT_UNSTABLE` とする。

cursor version 2 の payload は `{version,schemaRevision,specId,flowVersion,resource,gte,lt,order,snapshotId,digest}` とする。digest は自身を除く payload の canonical JSON SHA-256。digest を含む payload 全体も canonical JSON にした UTF-8 bytes を padding のない base64url として符号化する。digest は認証・署名ではない。

cursor は条件、resource、filter、confirmationOrder、snapshot ID に束縛する。別条件は `CURSOR_QUERY_MISMATCH`、整合しない digest や旧 cursor は `INVALID_CURSOR`、世代の変化は `SNAPSHOT_CHANGED` とする。v1 cursor の自動変換はせず `after=null` から再取得する。

## ページングと完了条件

recordedAt は従来どおり `timing.finishedAt` に `gte` inclusive / `lt` exclusive で適用する。時刻のない Activity は filter 使用時に除外する。詳細自身の時刻では絞らない。totalItems は snapshot 内の filter 一致 Activity 件数であり、cursor より後だけの件数ではない。

response の UTF-8 byte 上限は現行の 2 MiB、単一 artifact は 16 MiB とする。items と詳細 closure を分割せず、収まる単位で limit より小さいページを返してよい。単一 Activity と closure、または metadata が上限を超えた場合は `RESPONSE_TOO_LARGE`。途中省略、4 KiB の新規長文切り詰め、`items=[]` と `hasNext=true` は成功としない。

全ページ ok、同 snapshot、Activity の重複なし、returnedItems 合計と totalItems の一致、参照閉包の解決、`details=complete`、`sourceHistory=complete` のすべてが成立して初めて全履歴と詳細の取得完了である。filter 使用時の完了範囲は一致 Activity と依存詳細に限定する。enumeration=complete は保存済み record の走査完了を意味し、失われた過去履歴の完全性を保証しない。

## null と coverage と error

revision 3 の追加プロパティは各 variant で必須。未関連 scalar は null、空配列は `[]` とし、undefined を使わない。null は保存元に値がないことを表し、取得失敗の代用にはしない。

| detailCoverage.availability | reason | count と意味 |
| --- | --- | --- |
| available | null | 確認済みの件数。0件でも可 |
| not-applicable | NOT_APPLICABLE | 0。producer 契約上の対象外 |
| not-recorded | PRODUCER_DID_NOT_RECORD | 0。producer が記録していない根拠がある |

空 ID 欄や source 未発見だけで not-recorded としない。参照した artifact の欠落・破損・hash / size 不一致は `CANONICAL_RECORD_UNREADABLE` / `CANONICAL_RECORD_INCONSISTENT`。過去 generation の本文不足、曖昧参照、未知 producer、保存時 truncation は `DETAIL_UNAVAILABLE`。success 本文へ読取失敗を混ぜない。

Finding / Repair status は value、availability、reason、nativeValue を持つ。保存 native status が正規化不能なら `DETAIL_UNAVAILABLE` とする。applied を verified、適用した修正を検証済み fixed へ昇格しない。currentState は保存根拠のある場合だけ status、asOfSnapshotId、sources を持ち、なければ null。

`ok=false` なら metadata.item は null、activities.items と entities の全配列は空にする。error は code、path、message、reason、referenceId を必須とし、snapshot を確定できなければ null。error 時の completeness は null とする。`hasNext=false` だけで成功完了と判定しない。

## 既存資産と実装時の検証境界

capture と hash / bytes 検証は `FlowArtifactCatalogSnapshotReader` / `FlowArtifactDescriptor`、confirmed ledger と構造は `FlowActivity` / `CurrentFlowStateValidator`、artifact 関係は `ReferenceResolver` / `FlowArtifactActivityIndex` を再利用する。Finding は `FlowFindingSourceIdentity` と既存 source resolver、producer 詳細は既存 Review / AttemptHistory class の責務で解釈する。

query に状態遷移、retry、route 判断、独自 fingerprint、別 canonical filesystem reader を追加しない。全 finding 列挙は既存 source module を拡張し、fallback ID / fingerprint を維持する。公開 view は既存の MetadataItem / ActivityItem / ArtifactDescriptorView を拡張し、必要な値は専用 class で invariant と toJSON を所有する。

metadata は詳細本文を保持しない。activities は公開ページと参照閉包に必要な descriptor のみを、既存 committed snapshot の capture 内で読み込む。未充足の型付き入力を満たしてから catalog 全体を検証し、成功または明示的な詳細拒否を確定する。過去の JSON 全体を保持して正当な大きい履歴を新たに拒否しない。detail completeness の集約は生成・検証とも `detailCompletenessFor` を再利用する。

Schema 案は Draft 2020-12 だが、現行 `validateSchema` は `$ref`、`allOf`、`uniqueItems`、`format` を完全処理しない。本案は既存 subset の inline Schema を使用し、木の整合、ID と旧参照 binding、snapshot digest、UTF-8 byte 上限、producer 投影の根拠は semantic checks で扱う。Schema 検証だけで全仕様適合や product 動作を主張しない。

## 互換性と producer 保存前提

全 response の schemaRevision は 3。既存 request と既存 response field の型・値・ID 一覧を保持する一方、旧 consumer の `additionalProperties=false` と revision 2 制約に対しては非互換であり、consumer 更新が必要である。旧 revision の出力モード、非推奨 path、旧 cursor 変換は作らない。query revision、保存 Flow revision、artifact revision、cursor version は別の番号である。

terminal typed Spec Review Result は ledger を verdict の正本とし、同一 Attempt・generation の retained publication を根拠として結び付ける。失われた過去 generation の本文を復元したり、別 generation の publication を代用したりしない。未保持の Version は `DETAIL_UNAVAILABLE` とする。過去 Definition / 表示名、raw log にしかない意味情報、切り詰め済み Draft finding、partial import も未保存を明示し、旧履歴の復元を主張しない。

Task source の no-change は、保存された typed evidence、指摘件数、accepted settlement の同一性、同 Activity に属する Gate 修正 outcome の不在を既存 producer 契約で確認した場合に取得できる。未対応の品質観測や修正情報を持つケースを空の指摘一覧へ置き換えない。詳細のない行政 Activity は producer の役割から not-applicable と判定し、空の参照欄だけで not-recorded を推測しない。
