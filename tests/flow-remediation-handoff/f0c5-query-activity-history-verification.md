# f0c5 Activity当時のレビュー・Gate・修復履歴

ユーザーが明確化した到達点は、修正前のレビュー・Gateの判定と指摘、修復の内容・結果、
修正後の再判定を、それぞれ当時のActivityに結び付けてqueryで取得することである。
任意日時のFlow全体復元、Spec等の文書全文・Git差分取得、未保存情報の補作は含めない。
既存Schema Revision 2、metadata/activities request、検索条件、snapshotとcoverageを維持する。

作業branchは`codex/f0c5`、worktreeは`.sennel/worktree/f0c5`。
基準commitは`3ff0e282d8651d462ed7671963465a820085cb2e`。
最初のDraft修正とその時点の証跡は`f0c5-query-draft-review-verification.md`に保持している。
その記録の「Spec世代の受入判断待ち」は、今回のユーザー指示より前の状態である。

## 保存と読み出し

Draft questions/coverage Reviewは既存Attempt履歴をexactに読み、checkpoint/claimedを
評価へ昇格しない。publicationのverdict・指摘を公開し、terminalは同じentityを参照する。
内部worker output/evidence/targetは既存型と共有publication identityで検証して公開しない。

Specの既存auditは、再レビューで置き換えられた旧指摘本文を常には保持しない。
そこで、現行review.jsonを後続判断のauthorityとして維持し、正規Review/Triage/Repairの
各publicationと同じStore transactionで、その時点のReview記録を既存activity.evidenceに
専用型として不変保存する。保存するのは指摘・分類・修復auditで、文書全文ではない。
revisionを更新するRepairでは実destinationのReviewを保存する。

新証跡は、閉じたfield集合、厳密round-trip、Activity ID/owner/選択Spec、
publication generation/identity/digest/auditを検証する。writerだけが新publicationの実保存時刻を
記録し、Activity.timingや過去の未記録時刻は補作しない。queryは時計を呼ばない。
既存のnote証跡は引き続き別の正規用途として扱う。

queryは同じcapture内の証跡を読む。Findingの完全identityは元Review pathを維持し、
保存位置のsourceは不変証跡の`/review`以下を指す。terminal Resultは既存pure Result factoryと
照合する。普通Repairの項目は、inputDigestが一致する先行Triage/Reviewの当時の指摘を参照する。
不正な専用証跡から現行本文へfallbackしない。証跡がない場合は、現行本文が当該Activityの
owner/generation/digest/選択Flowに完全一致するときだけ読める。失われた旧本文は拒否する。

Gateは既存Attempt履歴を使い、正規Observationの既知violationを`gate-finding@1`として公開する。
criterion/diagnosisの同じ指摘を二重計数せず、矛盾するmirrorや未知型は拒否する。
Spec Gateのblocking identityは修復producerと共通で、advisoryの配列位置により変えない。
計画を記録したActivityは`planned`、実際に適用したSpec Gate Repairは`applied`等を返す。
execution checkpoint/claim/publicationを適用済み修復へ昇格しない。

Gate Repairは保存済み操作auditと計画・元Gate・元Findingを結び付ける。
拒否groupに未保存のtarget/operation/findingは補作しない。worker semantic inputRevisionと
Spec rawbytes baseRevisionを混同せず、前者はpublication/terminalの完全lifecycle、
後者は同captureの不変Spec snapshotで検証する。以前のReviewを参照する正規lineageは、
現在のbase Specと別のrevisionになり得るため、両者を同一視しない。

## 既存責務の再利用

不変なowner-bound証跡、content契約、catalog association、atomic writeは既存activity.evidenceを
拡張した。Step/Definitionのroute・retry・意味判断は変更しない。
caller intentのreceipt publicationDigestは維持し、自動revision publicationと同じ責務で
派生証跡を保存する。queryからStep実行やpersistを呼び直さない。

Finding identity・facet・JSON pointerは共通source API、Gateの意味は既存Observationとpermission型、
Spec Reviewのverdictは既存pure Result factoryを使う。保存Gate operation auditの型とdigest、
Review preservation reasonはwriterとreaderが同じ実装を使う。
captured negativeのreceipt再署名は専用test supportへ集約し、Draft/Specで再利用する。

## 正規経路の受入テスト

`query-activity-history-producer.test.js`は次の正規chainを保存・reloadする。

```text
Draft → questions Review → refine → coverage Review → Draft Gate → Spec
→ Review REJECTED → Triage apply → Repair changed（採用＋拒否）
→ Gate FAIL → Gate Repair changed / review-required
→ Review PASS → Triage → Repair unchanged → Gate PASS
```

外部provider応答だけをfakeとし、registered command/Step/Service/Storeと後続判断は実際の経路を使う。
8つの保存時点でmetadataと先頭からのactivitiesを取得し、後段で過去のverdict・指摘本文・分類・
修復項目・source・参照が変わらないことを比較する。修復が当時の入力指摘へ結び付くことも検証する。
最終状態は実CLIでも同snapshot・全件・closure・coverage・状態不変を確認する。

append-only ledger/historyのhashは後続保存で変わるため、異なるsnapshot間ではそのenclosing hashを
履歴本文の変更と混同しない。同snapshot内の同ID/同JSONは厳密に比較する。
不変証跡のhash・artifactIdは保存時点間でも同一である。

## 修正前の検出と途中の失敗

再開前のsource（Draft修正を含む）をGit metadataなしで固定し、最新の成功期待testと支援を
同じbytesで配置した。`query-activity-history-frozen-before.log`では、正規chainの最後のGate PASSまで
完走した後、Triage以後の7時点の`SOURCE_GENERATION_NOT_RETAINED`を検出した。
import/setup/timeoutの失敗ではない。先行する未保持SpecがGateの未対応をmaskするため、
この比較だけで全ての既知Gate障害まで検出したとは扱わない。

初回の保存observedAt不足、test collectorのAPIエラー応答扱い、読み出し側の別契約hash比較など、
途中に発見した失敗ログも保持している。正当な既存期待値、skip、timeoutを変更して隠していない。
before/currentの新success test hashは
`88224de6f4d9523a12c1cddb4d8ae0c857dc981b1575b5c01e8e9031e5e153df`。
test用sourceコピーのhashもログで確認する。
比較sourceの元839ファイルも保存manifestと再照合し、変更・欠損0件、Git metadataなしを確認した。
展開コピーは片付け、manifest・照合結果・同一test本文・before/currentログを保持した。

## 検証結果

ログはworktree内`.tmp/f0c5/`を基準とする。実行対象が重複するため件数を合算しない。

| 対象 | 結果・ログ |
| --- | --- |
| Spec不変証跡のunit/storage | unit5・正規storage1成功。`query-spec-review-history-storage-unit-final.log`、`query-spec-review-history-storage-integration-r2.log` |
| Spec当時の記録→query接続と未保持拒否 | 成功。`query-spec-missing-evidence-no-fallback.log` |
| Spec archive境界 | foreignSpec/未知/欠損/duplicate/noteと当時本文の証明、terminal判定との矛盾拒否11件成功。`query-spec-review-history-binding-terminal.log` |
| Gate Findingと既存consumer | 14件成功。`query-gate-details-unit-final.log` |
| Gate操作auditと既存操作 | 23件成功。`query-spec-gate-repair-details-final.log` |
| worker semantic revision/Spec rawbaseの分離 | 10件成功。`query-spec-gate-repair-base-spec-contract-final.log` |
| 最終値型・Draft captured binding | 61件成功。`activity-history-values-final.log` |
| 新履歴chain・実CLI | 1件成功。8保存時点の当時の情報を比較し、最後は実CLIで同snapshotの全履歴を取得。`query-activity-history-final-stable.log` |
| 既存query 6ファイル | 113件中112成功。唯一の失敗は旧本文が未保持というfixture前提が新writerでは成立しなくなったもの。拒否期待を保ったsetup修正後に当該1件も成功。full runが全成功したという意味ではない。`query-history-regression-final.log`、`query-history-missing-generation-final.log` |
| Draft/Spec専用シナリオ | 14件成功・失敗/中断/skip0。Draft再生成、strict stopと再開枠、advisory、大きなGate指摘と34,522-byteの修復内容、Approval/Test/Acceptanceでの実利用を確認。`activity-history-phase-scenarios.log` |

初期Draft修正の同入力CLI比較とAI実行結果は前段の検証記録を参照する。
変更後に必要なconsumer/工程検証を優先し、未変更AI経路の実行を成功件数へ重複加算しない。
初回AI全体テストは10成功・1失敗・2中断・既存opt-in skip1であり、全成功とは扱わない。
失敗・中断した各ケースは個別実行で成功したが、初回失敗の原因は確定していない。

サブエージェントの最終独立レビューは`activity-history-integration-review.md`に保存した。
選択Specの照合、terminal判定と保存本文の照合、元Gate Attemptの照合に関する指摘を反映し、
最終chain成功とsourceコピーのhash一致を確認したうえで、追加の実装上の阻害事項なしと判定した。

既存`query.test.js`の未保持世代拒否ケースは、正規ReviewとTriageを今のwriterで保存するため、
旧Reviewの専用不変証跡が残り、当初の拒否期待に対してCLIが取得成功した。
この結果はユーザーの要求した動作であり、productを旧世代拒否へ戻す根拠にはならない。
独立レビューで、派生archiveがActivity/fact/receiptの必須path参照ではないことを確認した。
そこでtest-local入力の元publication専用archiveだけを型・digest確認後に除去し、
既存Catalog APIでinventory/hashを再構成・verifyして、実際に未保持の過去データを表した。
旧本文の代用拒否、error/reason/referenceId、query状態不変という元の期待値は変更していない。
sourceは変更せず、この1ケースだけ再実行して成功した。

## 受入条件との対応

| 条件 | 根拠 |
| --- | --- |
| 1: 元のDraft拒否の解消 | 前段の同入力・同期待実CLI比較と再open全件走査。修正前に元の`PRODUCER_NOT_SUPPORTED`を検出 |
| 2: 実行と評価の区別 | Draft正規producerの未publication/publication/terminalケース、61件の型・binding検証。checkpoint/claimはnot-applicable0 |
| 3: 保存意味・公開境界 | Draft PASS/ADVISORY/REJECTED/repairTargetsと新8時点chain。既知意味だけを公開し内部3項目は非公開 |
| 4: 履歴とbinding | Draft retry/reopen、publication digestと完全lifecycle、Spec archive/terminal11件、Store rollback/retry/replay、元Gate Attempt照合 |
| 5: 全件・closure | 8時点と最終実CLIの同snapshot、全ledger件数、ID/JSON/参照とcoverage。既存query検索・recordedAt境界も検証 |
| 6: 正規producerの接続 | 正規Draft→Spec→Review/Triage/Repair→Gate FAIL/Gate Repair→再Review→Gate PASSの保存・reload・実CLI取得、工程専用シナリオ |
| 7: 明示拒否と状態不変 | 新archive/内部型/terminal矛盾の拒否、未保持旧世代のCLI拒否、既存snapshot/上限/corrupt/hash/参照拒否、query前後state/catalog/ledger比較 |

## 再検証と状態

```sh
node --test tests/integration/flow/query-activity-history-producer.test.js > /tmp/f0c5-activity-history.log 2>&1
node --test tests/integration/flow/query-spec-review-history-binding.test.js tests/integration/flow/query-draft-review-binding.test.js > /tmp/f0c5-bindings.log 2>&1
```

worktreeと受入証跡を残す。Flow開始/再開、commit、merge、push、ボード更新は行わない。
docs freshnessはstaleで、docs buildを提案済み。手動設計資料と公開Schema mirrorは今回の契約に同期した。
受入条件1〜7は上記の実行結果と独立レビューで達成した。最終判定は実装・ローカル検証完了。
現在の判定とsource/test/log hashは`.tmp/f0c5/activity-history-acceptance.json`と
`.tmp/f0c5/activity-history-final-manifest.json`へ記録する。前段の`acceptance.json`と
`final-evidence-manifest.json`はユーザーの明確化前の履歴であり、今回の記録がそれらを置き換える。

過去に既に失われたSpec本文は復元できず、明示拒否のままである。新しい正規publicationは
当時の意味情報を保持する。初回AI全体実行の原因未確定の失敗と生成docsのstaleは前述の制限として残す。
今回の到達点は、正規保存した当時のレビュー・Gate・修復・再判定を履歴として取得することであり、
任意時刻のFlow復元や文書全文取得の完了を意味しない。

## 追加監査で判明した修正内容の不足と追加修正

追加監査`query-followup-audit.json`で、当時の修復操作を保存していても、public Repair itemには
対象・操作種類・結果・理由だけを返し、実際のreplacement/editsを落としていたことが判明した。
前段の「完了」判定はこの公開内容の検証が不足していた。ユーザーが修正を明示した後、
保存された適用済み操作を`RecordedRepairChange`へ型付けし、`item.change`として公開した。

`change`は閉じた`{replacement, edits}`である。置換・追加では保存値を返し、text editでは元UTF-8
本文に対する保存済み`startByte/endByte/replacement`を返す。削除は両値nullで、既存target/operationKindが
削除内容を示す。discarded/skippedはchange=nullであり、未適用のproposalを修正結果にしない。
既存nominal operationとserializerを使い、適用判断、grammar、保存形式、Step/Definition/Storeは変更しない。
内部のexpectedDigest、worker情報、元全文、推測したcurrent stateはchangeに加えない。
Revision 2の既存request/required fieldsを維持する追加propertyとしてSchema全4箇所とdocsへ反映した。

同値finding identityを再探索し同じfindingを二度cloneする処理と、使われていないGate修復のlocal IDを
除去した。blocking用identityIndexesと、discarded groupの実参照に必要なreferenceIdは維持した。
変更した共通finding observation APIのproduction callerはquery-details/query-gate-detailsのみである。

正規producerシナリオは同じ8時点を維持し、普通Repairの実replacement、却下change=null、日本語原稿の
文字数とUTF-8 byte数の違い、先頭と末尾への2編集、その実Store反映、後続の再Review/Repair/Gate後の
内容保持、最終実CLI応答にある同じchange値を追加検証した。
外部fakeのpayload生成だけを既存共通support APIのoptional editsで拡張した。

変更前840sourceファイルをGit metadataなしで固定し、同一のtest/supportを配置した。
test hashは`2cbf0b42379c3b1901ddeb8eb70d01da1f76c184ba0b00b6354ba3b4718cd697`。
変更前は正規chainを完走した後、保存済みreplacementに対してchangeがundefinedである違反を検出した。
変更後は同じ期待値で1/1成功し、実CLIでも当時の内容を取得した。

| 追加検証 | 結果・ログ |
| --- | --- |
| 修正前の不足検出 | 期待したchange欠損で1失敗。setup/timeout失敗ではない。`repair-content-before.log` |
| 修正後の8時点と実CLI | 1/1成功、失敗/中断/skip0。`repair-content-after.log` |
| 公開値・閉じたSchema | 7/7成功。文字列/JSON/null、UTF-8編集、削除、private除外、clone隔離、出荷Schema全4箇所。`repair-change-unit-final.log` |
| 既存query・共通identity/consumer | 87件中85成功。残り2件は旧replacement非公開の期待で失敗。`repair-content-regression.log` |
| 最新要望と旧期待値の整合 | 同じseed/status/source/参照/locator/currentStateを維持し、旧非公開assertをexact changeへ更新して2/2成功。全文・内部authorityの非公開も確認。`repair-content-contract-corrected.log` |
| response byte limit | 2/2成功。本文を切り詰めずpageを縮小し、単一Activity閉包の上限超過は明示拒否。`repair-content-response-limits.log` |

旧2件はreplacementを`"sensitive-replacement"`/`"private-replacement"`というtest literalにしているが、
privacy分類や秘匿metadataを持たない。保存修復内容の公開という最新の明示要望と非公開期待が衝突する。
独立レビューでこの契約更新を確認し、seedの文字列は変更せず、採用結果・既存参照・文書全文や内部情報の
非公開を維持したまま期待を更新した。正当なprivacy失敗を値変更やskipで隠していない。

本追加修正の独立レビューでは実装上の阻害事項なし。前段の工程14件・storage/bindingの結果は
変更していないproducer/保存/後続利用の証跡として保持する。追加のテストはquery投影と今回の
変更内容・共通identityのconsumerに限定し、前段と件数を重複合算しない。
最終の追加修正判定は、修正内容の公開・保存時点の保持・実CLI・拒否境界・局所的な冗長除去を確認し完了。
現在の受入判定とhashは`.tmp/f0c5/repair-content-acceptance.json`と
`.tmp/f0c5/repair-content-final-manifest.json`を正とし、前段の完了判定と追加監査の不足判定を置き換える。
branch/worktreeは維持し、commit/merge/push/Flow/ボード更新は実施しない。
