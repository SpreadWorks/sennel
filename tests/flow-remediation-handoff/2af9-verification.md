# 2af9 実装・検証記録

作業ブランチは `codex/2af9`。作業用 worktree は `.sennel/worktree/2af9`。
開始 commit は `c8f736d92af9da9b7aca0cd4ccde91bb353579b4`（main）。
対象ボードの最新本文は作業開始時に `sennel workflow show 2af9` で取得した。
コミット、merge、push、ボード更新、実 Flow の開始・継続は実施していない。

## 実装と再利用

通常修復と Gate 修復の `SpecRepairOperation`、Batch、immutable-base application、
canonical validator を再利用した。修復値・編集 payload・編集結果だけに課されていた
32 KiB 制限と Task acceptance 専用の例外契約を削除した。
候補適用・canonical validation・拒否理由は `SpecRepairCandidateInspection` に集約した。
schema validation 本体、権限、digest、操作数、UTF-8 境界、worker payload 制限は変更していない。
scope proposal の独立した 32 KiB 制限を維持している。

Gate の公開 `SpecGateRepairOperationInspection` は副作用を持たない。
Step の既存 pure factory `selectSpecGateRepair` も同じ Inspection を使う。
canonical worker facts を使った preview の候補・audit が Step の保存結果と完全一致し、
preview が state・ledger・catalog を変更しないことを検証した。
工程の採用・Review 判定は Step に保持し、Definition・Service・Store に再実装していない。
88bb の復旧 CLI consumer の追加・動作確認を実施したとの意味ではない。

共有 API、ordinal の snapshot lookup、f0be の typed publication limits と writer の保存接続は
開始時のコードに存在した。保存責務そのものは変更していない。
新しい依存、agent host 固有の機能、特定 Issue の例外を追加していない。

## 受入条件と証拠

| 条件 | 正規の生成・保存・読み戻し・利用経路 | 結果 |
| --- | --- | --- |
| 1. 合法な大値の通常／Gate 修復 | Requirement は両経路で 34,522 bytes。Task acceptance も JSON 値 34,522 bytes。sealed handoff、実 Step、Store、manager 再構築、catalog artifact で完全一致 | 達成 |
| 2. 後続利用 | Spec 工程シナリオが両 Requirement の実 Review snapshot・identity、reload、Approval、Test、Acceptance を検証。Task は通常／Gate 各保存テストで後続 Gate／Review 入力の保持を別途検証 | 達成 |
| 3. 編集境界 | 固定操作テストが adjacent、overlap、immutable-base array positions、alias、rollback、同内容 operation の coalescing を検証 | 達成 |
| 4. 安全な拒否・診断 | UTF-8 途中 byte、unauthorized、stale、schema-invalid を拒否。1024-byte の診断を完全な UTF-8 境界で切り、invalid enum worker 値を診断に含めない | 達成 |
| 5. 独立した既存制限 | 固定操作テストと handoff 関連 24 ケースで権限、digest、操作数、worker payload、scope proposal を確認。実保存経路の publication limits 接続を維持 | 達成 |
| 6. 共通 Inspection・責務 | pure preview と Step 保存候補・audit の一致、preview 無副作用、production registration を使う Spec structure check、独立した差分監査 | 達成 |
| 7. 修正前後の同一回帰 | 最終 canonical-value テストを同一 bytes で基準 commit の detached worktree へ配置。修正前は expected `spec-gate-repair-review-required` に対し actual `spec-gate-repair-no-progress`。修正後は PASS | 達成 |
| 8. 妥当な期待値の維持 | 固定 branch の元ファイルを移行 manifest の hash と照合。旧 Service 再利用 fixture だけ現行の正規 Store receipt replay 契約へ訂正。値、Result kind、receipt ID、状態・catalog・ledger 無変更、予算、snapshot 数の保証を維持 | 達成 |

Task acceptance の固定操作テストだけで保存・後続利用を証明したとは扱わない。
保存・入力保持は追加の通常／Gate テストで別々に確認した。
実 agent/provider の非決定的な応答を fake に置き換え、内部の Step・Definition・Service・Store・consumer を実行した。

## 実測結果

ログの基点はこの worktree の `.tmp/2af9/`。

| 検証 | 結果 | ログ |
| --- | --- | --- |
| `spec-artifact-scenario.test.js` | 6/6 PASS。通常／Gate の大値を含む | `spec-scenarios.log` |
| `draft-artifact-scenario.test.js` | 6/6 PASS。保存、reload、Spec／Acceptance 利用、ordinal を含む | `draft-scenario.log` |
| `spec-gate-repair-canonical-value.test.js` 最終版 | 2/2 PASS。Gate Requirement／Task、pure preview、receipt replay | `canonical-value-final.log` |
| `worker-artifact-handoff.test.js` 関連 case selection | 24/24 PASS。通常 Task 大値、payload、権限、stale、保存 rollback を含む | `handoff-boundaries.log` |
| 操作、canonical-value、Gate replay、Task schema、catalog limits、Spec structure の関連実行 | 54 PASS、既存 import 循環による 1 FAIL | `related-regression.log` |
| 基準 commit の同一 canonical-value Requirement 回帰 | 対象の契約違反で FAIL | `baseline-canonical-value.log` |
| 基準 commit の settlement limits unit | 修正後と同じ import 循環で FAIL | `baseline-settlement-limits.log` |

`spec-scenarios.log` の複合起動には、後続の追加 Task fixture の失敗も記録されている。
Spec 工程自身の 6 ケースはすべて PASS。追加 Task fixture は正規の未承認 Task proposal producer と
typed revision 参照へ訂正し、`canonical-value-final.log` で最終 2 ケースの PASS を確認した。
既存シナリオの期待値を緩和・skip していない。

固定テストの出典は `test/flow-remediation-contracts` の HEAD
`55d97f30809547c05e95040dc6fbba7b47b714a8` と、その
`tests/flow-remediation-handoff/migration-manifest.json`。
元ファイル hash、最終テスト hash、修正前後の同一性、source hash は
`.tmp/2af9/fixed-test-manifest.json` に保存している。
基準比較中の source は無変更。比較用 detached worktree は検証後に削除済み。

固定 fixture の訂正根拠は、既存 `worker-artifact-handoff.test.js` の完成済み Service 再利用拒否と、
`spec-gate-repair-replay.test.js` の exact Store publication replay。
完了済み handoff は payload を消費するため、その Service の再実行は正規の replay ではない。
本回帰は実 writer の入力を観測し、実保存処理を置換せず、新しい manager で同じ Store receipt を再取得する。

## 既存障害と適用範囲

`tests/unit/spec-gate-repair-settlement-limits.test.js` は、開始 commit と変更後の双方で
`ReferenceError: Cannot access 'SpecGateRepairSettlementWriter' before initialization` により
import 時に停止する。修復値の回帰検出証拠には数えていない。
実 Flow の composition／writer／Store 接続は上記の保存シナリオと Gate replay で検証済み。
この独立した既存 import 循環を隠すためのテスト変更や保存責務の変更はしていない。

docs freshness は `stale`。`sennel docs build` を提案済みで、docs 生成は実施していない。
判断はボード本文、現行コード、実測結果に基づく。
2af9 の到達点は実装・検証済み。共同C全4ボードの実装全体や88bb consumerの新規実装を
完了したとの報告ではない。

## 再検証

worktree 内で実行する。ログを保存してから結果を確認する。

```sh
node --test tests/integration/flow/spec-repair-operations.test.js tests/integration/flow/spec-gate-repair-canonical-value.test.js > .tmp/2af9/fixed-regression-repeat.log 2>&1
node --test tests/integration/flow-cli/spec-artifact-scenario.test.js > .tmp/2af9/spec-repeat.log 2>&1
node --test tests/integration/flow-cli/draft-artifact-scenario.test.js > .tmp/2af9/draft-repeat.log 2>&1
node --test --test-name-pattern 'Task acceptance above 32 KiB|completed prepared Service|oversized|payload|unauthori[sz]ed|immutable|stale|UTF-8|Spec repair|Spec Repair' tests/integration/flow/worker-artifact-handoff.test.js > .tmp/2af9/handoff-repeat.log 2>&1
```

実装担当と検証担当の独立監査を使用した。管理者自身も主要差分と全受入証拠を確認した。
受入に必要な証拠を残し、作業用 worktree はレビュー・引継ぎ用に保持する。
