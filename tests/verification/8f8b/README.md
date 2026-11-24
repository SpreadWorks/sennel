# 8f8b テスト契約の訂正と引継ぎ

基準は `main` の `2ca911cb6b19c4e7108d66479f45e2b4a5f9cd54`、作業ブランチは
`codex/8f8b`。ボードの最新本文は worktree 作成前に `sennel workflow show 8f8b`
で取得した。開始時の main にあった AGENTS.md の変更と process-management
prototype は取り込んでいない。実装・検証は専用 worktree 内で行った。

この記録はボードAのテスト訂正を対象とする。製品コード、共有support、runner、
package/CI、実行中Flowのcanonical状態は変更していない。製品939ファイルの
開始時hashを保存し、変更がないことを照合する。通常の開発Flow、コミット、merge、
push、Issue公開、ボード更新はこの作業の対象外。

## 訂正の根拠と維持した検出

| 対象 | 元の誤りと正規契約 | 訂正後も検出する結果 |
| --- | --- | --- |
| Resultのunit 2ファイル | `5d2fd96be98d6f8dda79636f10813dc34011f074` で導入済みの12 producerのrecovery Resultが独立した固定期待一覧から欠落。`step-result.js:932`、Definition `:4205`、`worker-artifact-handoff.js:9402` が正規の生成・利用経路 | registryの完全一致、余分登録・重複・未知kind・不正type/producerの拒否。既存26 semantic契約を維持。専用 `ArtifactWorkerRecoverySelection` の復元と専用Settlement、余分field・不正証拠・generic operandの拒否 |
| Acceptanceの2ケース | `fromSeed → create → initialize → get("agent")` が初期化中にcallbackを評価し、未初期化の `const scenario` を読む。`installGateProviderFake` の既存lookupと `run-acceptance-review.js:508,1023` がprovider設定と保存済み制限の境界 | 初期化済みscalarで対象工程から制限を有効化し、実providerの16,000を確認。durableは現在設定20,000と保存済み契約16,000を区別。map/reduction/scoped-final、完了応答の重複防止、uncertain claimの再実行拒否、Attempt・予算・状態の不変を保持 |
| 要約の2ケース | 作業Specが `874b47dfe187a85e0524bd9a52be334343329519` で削除済み。元bytesをimmutable fixtureへ移し、テストの参照先だけを変更 | 元の84,467 bytesとSHA-256、60,000文字以内、source unit省略なし、別CLIからのcache読み戻し、cache hit時のprovider不使用、canonical無変更、改変excerpt拒否 |
| skill namespace | setup結果の未確認、存在した時だけのassert、`--agent` 未指定で生成を期待する前提。`setup.js:696-713,845-859` と既存 `deploySkills` が正規契約 | 両targetの正確なskill集合、regular file、展開内容。CLIはerror・signal・exitを必須確認し、明示的agent指定時の生成と未指定時の非生成を分離。10秒制限は維持 |
| Draft dispatcher/admission | 独自Agentがprovider admissionを通さず、新しいrequest/Prompt publicationが厳格な旧catalog期待値から欠落 | 既存 `withScenarioProviderAdmission` / `createScenarioProviderFake` を再利用。requestの契約・digest・producer、Prompt eventのscope・契約・Attempt・順序・予算と最新frontierを確認した正確なpathだけを差分に認め、他のartifactは完全一致 |
| Draft refine/replay | missing/unsealedを一律停止とする旧期待値、失敗Envelopeへの旧 `nextAction.directive` 参照、旧request拒否コード | 未使用の元権限による同じgenerationの1回だけの再開、消費済みunsealed claimの明示recoveryと直接worker拒否。Envelopeと選択済みblocked directiveを区別。publication改変は元の型付き原因コードと、公開fingerprint失敗のcause・phaseを両方確認し、dispatch 0、provider不使用、canonical・lifecycle・receipt不変を維持 |

recovery Resultの12 producerは `draft`、`draft-questions-triage`、
`draft-questions-repair`、`draft-refine`、`draft-gate-repair`、
`draft-coverage-triage`、`draft-coverage-repair`、`spec`、`spec-triage`、
`spec-repair`、`test-generate`、`test-repair`。実registryから期待一覧を生成しない。

要約fixtureの元commit・path・hashは
[PROVENANCE.md](../../fixtures/artifact-summary-original-spec/PROVENANCE.md) に保存した。
fixture内の `.gitattributes` の `spec.json -text` でcheckout時の改行変換を防ぐ。

## 状態の生成・保存・読み戻し・後続判断

| 保証する結果 | 正規の生成と保存 | 読み戻し・実際の利用 |
| --- | --- | --- |
| 回復Resultだけから専用Settlementを選ぶ | 既存契約から `ArtifactWorkerRecoveryEvidence.selection()`、登録済みStep/Service、canonical Store | codec/Definition unit、全producerのService準備、既存の未使用権限・stopped unsealed回復シナリオを再利用 |
| 保存済みmapを重複せず完了する | 正規03 producerからRetro、登録済みAcceptance、16,000のepisodeとmap completionを保存 | managerを再生成し現在設定を20,000へ変更、保存契約16,000で複数reductionとscoped-finalを実行 |
| 不確かなprovider応答を再実行しない | 正規03 producer、mapの1件の保存応答、2件目の実provider境界で応答喪失 | claim・予算・中間scopeを再読込み、Definitionの停止選択を実dispatchが消費。provider回数とAttempt・canonical snapshotを比較 |
| refineの未使用権限だけを再利用する | 実dispatcherでclaim後・provider前に中断、元contractと予算0を保存 | fresh managerの実観測から元権限を選び、1回のworker実行と質問Await、同じAttempt・generation・予算を確認 |
| unsealedの直接再実行と改変replayを拒否する | admission対応fakeの正規Prompt予約、保存済みsealed/publicationへの境界入力の改変 | 型付きcontinuation、直接worker admission、実dispatchの拒否を確認。provider・canonical・receipt不変を検証 |

外部provider・worker応答だけをfakeにし、内部のpublication、Definition、Store、
保存receiptや後続判断を手書きで補作しない。共有supportは変更せず、同じ判断matrixを
別層へ複製しない。既存 `tests/run.js --file ... --jobs 1` とNode標準のname filterを使う。

## 実行結果

最終的な限定検証は130ケース成功、未解消の失敗0、skip 0。
Draftの16成功は、後の訂正で影響しないケースの結果を再利用した。

| 確認集合 | 結果 | 根拠log（worktree rootからの相対path） |
| --- | --- | --- |
| Result、continuation、checkpoint unit 4ファイル | 93成功 | `.tmp/8f8b/result-final.log` |
| skill 2ファイル、要約、全recovery producerのService準備 | 13成功 | `.tmp/8f8b/local-integration-final.log` |
| Acceptance map・複数reduction・scoped-finalの保存再開 | 1成功 | `.tmp/8f8b/acceptance-durable-final.log` |
| Acceptance保存応答・uncertain claimの再読込みと停止 | 1成功 | `.tmp/8f8b/acceptance-phase-final.log` |
| 元の未使用権限、stopped unsealed回復とCoverage消費 | 2成功 | `.tmp/8f8b/recovery-durable-final.log` |
| Draftの変更影響先2ファイル | 16成功を再利用＋訂正後4成功 | `.tmp/8f8b/draft-affected.log`、`.tmp/8f8b/draft-corrections-final.log` |

[results.json](results.json) に各コマンド、exit code、log hash、ケース名・結果・所要時間、
現在有効な結果と履歴を保存した。[inputs.json](inputs.json) は開始commit、Node version、
テストの修正前後hash、途中のDraft入力、939製品ファイルの同一性を記録する。
[inventory.json](inventory.json) は全740ファイルのhashと実行範囲を区別する。
13ファイルが今回の実行対象で、うち一部はname filterによる限定実行。残る727ファイルは未実行。

Draftの最初の変更影響先実行は16成功・4失敗だった。追加した検証補助が既にJSONである
descriptorへ `.toJSON()` を呼んだこと、seal時に拒否される入力へ後続Prompt完了の保存を
期待したこと、および公開fingerprint Envelopeと元の原因コードを同じ層で期待したことが
テスト側の不整合だった。正規APIと実際のproducer順序を照合して訂正し、該当4ケースだけ
再実行してすべて成功した。その他16ケースの実行経路は変更していない。
途中の4失敗と入力hashも残し、現在の失敗や製品不具合へ読み替えない。

修正前のResult 2ファイルは74成功・2失敗。Acceptanceの2ケースはそれぞれ
初期化前参照のReferenceErrorを再現した。Draftの限定実行は5失敗で、出力に現れなかった
missingケースだけを追加で単独実行し1失敗を記録した。これらのsetup/期待値の失敗を
製品の回帰検出成功とは数えない。

skillの修正前8成功は同じ基点・同じテストhashの既存結果を再利用した。
元テストSHA-256は `748bda8e6d6849c83acf16b93462fae3d19e031fb6feb0ff5a0c1c3f52308d5a`。
元の条件付きassertが十分だったことの証明にはしない。要約の修正前は元テストhash
`39d59e90228fb67f683b4920061215af3d404871142ef205502313e16e056950` と
`fs.readFileSync(SPECIMEN)` のENOENTを最小境界で確認し、scenario実行とは区別した。

stdout/stderrは一度だけ `.tmp/8f8b/` の各logへ保存する。テストのskip追加、
timeout引上げ、不正状態の成功扱い、妥当なassertの削除は行わない。
基準との比較のために製品修正を外したり、既存Flowの証拠を変更したりしていない。

## 7227への引継ぎ

今回の限定検証で確定した製品不具合は0件。8f8b内で製品修正は行っていない。
以前の2bfcで解消したcatalog hash・衝突拒否の契約も変更していない。

調査母集団はGit管理済み740ファイル。今回の確認対象は13ファイルで、一部は
ケースを限定する。母集団全件の個別レビュー・実行完了を意味しない。
旧全件ログの欠けたleaf明細、過去のsetup timeout、実agentのUnicode findingや
process観測の不安定性は、この限定検証で原因を確定したものとして扱わない。

後続7227は、確定した製品不具合があれば同じ入力・期待値の失敗ケースから修正し、
保存・読み戻し・後続判断のconsumerへ影響確認を広げる。製品不具合が0件でも、
未確定と未実行範囲を解決済みにせず、固定母集団の残りを既存selectorで確認する。
成功済みの高コストケースは入力変更・新たな失敗・具体的な未解決懸念がある場合だけ
再実行する。新runner、永続cache基盤、並列実行設計は追加しない。

docs freshnessは `stale`。`sennel docs build` を提案し、この作業ではコードと実行結果を
根拠にした。実agent CLIを使う試験は今回実行していない。

## 受入判定

| 条件 | 判定・証拠 |
| --- | --- |
| 訂正と正規契約の根拠・維持した検出を対応付ける | 達成。上記の対応表、fixtureの出典、型付き原因と公開応答の二段の検証 |
| 期待値緩和・skip・timeout延長・不正状態の成功扱いをしない | 達成。独立した固定期待一覧、元のhashと10秒制限、厳密なcatalog差分・保存状態の比較を維持 |
| 確定したテスト不備を直し目的のassertまで限定検証する | 達成。130ケースの現在有効な成功結果と、修正前・途中結果を別々に保存 |
| 妥当な製品失敗を維持しsetup失敗と区別する | 達成。製品939ファイルは開始時と同一。今回確定した製品失敗0件、setup/テスト不備の履歴は別分類 |
| テスト、ケース別台帳、不具合・環境・未確定・未実行範囲、後続手順を渡す | 達成。修正8テスト、immutable fixture、当READMEと3つのJSON、必要なraw logを保存 |
| テスト訂正の完了と製品・全体テストの判定を分ける | テスト訂正と引継ぎは完了。全740ファイルの検証と製品全体の判定は未実施 |

## 追加レビューとマージ時の証拠保存

追加レビューでは、まとめ実行logで明細が欠けていた変更影響先8ケースを単独確認し、
小ケース込み11件すべて成功、skip 0。結果とraw logのhashを
[review-results.json](review-results.json) に保存した。元の130件とは別の確認記録である。
テスト13対象ファイルと既存実行logのhashが記録と一致すること、製品939ファイルが
基準時と同一であることも再確認した。

ユーザーの追加指示により、この修正をコミットしてmainへマージし、確認後に
作業worktreeとブランチを削除する。本文中のworktreeパスは作業時点の記録である。
raw log、開始入力の詳細、ボード引継ぎ記録は、mainリポジトリの
`.tmp/8f8b-evidence.tar.gz` に元の `.tmp/8f8b/` 相対pathで保存してから削除する。
通常テスト全体の検証と未確定事項の分類は、7227の引継ぎ範囲として維持する。
