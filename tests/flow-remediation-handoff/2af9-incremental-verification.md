# 2af9 通常修復の incremental staging 修正

作業場所: `.sennel/worktree/2af9`、branch: `codex/2af9`。
今回の基準は commit の状態ではなく、レビュー済みの未コミット実装の作業開始時 snapshot。
既存の `2af9-verification.md`、`.tmp/2af9/`、レビュー元の証跡は書き換えていない。
新しい証拠は `.tmp/verify-2af9-incremental-LPQj9G/` に保存した。

## 変更と理由

`src/flow/lib/spec-repair-operations.js` の `SpecRepairCandidateInspection` が
候補、immutable base、application context、受理済み履歴を保持する。
通常の `applySpecRepairOperations()` はバッチで一度作成し、次の1操作だけを
`inspect([operation])` に渡す。候補適用、canonical validation、拒否診断は
同じ共通クラスに集約したままで、呼び出し側へのコピーや並列実装はない。

schema 拒否など、試行した操作が候補を変更した場合だけ、immutable base から
受理済み履歴を replay して値と array lineage を復元する。
既存 operation の non-OK は変更前に返るため、そこでの不要な replay は行わない。
最後の操作が拒否でも、通常修復は最後に受理した候補を公開する。
公開時だけ root を freeze し、入力 Spec や後続の別 apply と値を共有しない。

Gate は従来の一括 operation-list constructor を利用する。
group 全体の原子的な採用・拒否、拒否時の `spec=null`、公開 pure Inspection、
Step と preview の一致、Gate の外側のアルゴリズムを維持している。
32KiB 修復値上限・Task 専用例外を復活させていない。
権限、digest、重複・競合、UTF-8、操作数、worker payload、scope proposal、
typed rejection と1024-byte診断、Step/Definition/Store/publication limits は維持した。

## 同じ入力による資源比較

既存の `/home/nakano/workspace/sennel/.tmp/review-2af9-HVNJoE/resource-comparison.mjs` をコピーした。
同じ fixture と検証条件のまま、`before/src` と `after/src` を参照する。
warm 3回平均、追加1回の apply/clone 計数を使用した。
完全出力の JSON sidecar 保存だけを元の計測・集計出力の後ろに追加した。
前後は別 process を順番に実行し、テストとの並行実行を避けて計測した。

入力 Spec は 1,284,258 bytes、worker payload は 1,296,977 bytes。
canonical validator に適合し、2MiB worker payload 境界内の64操作がすべて受理される。

| 項目 | 修正前 | 修正後 |
| --- | ---: | ---: |
| 操作適用回数 | 2,080 | 64 |
| Spec全文 structuredClone 回数 | 129 | 2 |
| 全 structuredClone 回数（値・auditも含む） | 6,689 | 4,546 |
| 処理時間（warm 3回平均） | 422.923 ms | 180.289 ms |
| CPU時間（warm 3回平均） | 398.642 ms | 169.272 ms |
| process 最大RSS | 128,368 KiB（125.4 MiB） | 138,644 KiB（135.4 MiB） |

Spec と audit の完全 JSON bytes、および parsed value を前後で照合して一致した。
全出力 SHA-256 は両方とも
`a482784ef565b61d4d806472fc96bd05939c058fcb70287698f3c988857984f2`。
合否は出力一致、64回適用、全文複製が初回2回に限られることに基づく。
処理時間・CPU・RSSは環境依存の参考実測。RSS削減とは報告しない。

詳細は `resource-results-controlled.json`、`resource-before-controlled.log`、
`resource-after-controlled.log`、`resource-before-output.json`、`resource-after-output.json`。
最初の計測記録もそのまま保持している。

## テスト

| 対象 | 結果 |
| --- | --- |
| `tests/integration/flow/spec-repair-operations.test.js` | PASS |
| `tests/integration/flow/spec-gate-repair-canonical-value.test.js` | PASS |
| `tests/integration/flow/spec-gate-repair-replay.test.js` | PASS |
| `tests/integration/flow-cli/spec-artifact-scenario.test.js` | PASS |
| `tests/structure/spec.test.js` | PASS |
| `worker-artifact-handoff.test.js` のレビューと同じ selection | 24/24 PASS、skipなし |
| 同じ操作テストを修正前 snapshot に配置した比較 | PASS |

指定4ファイルと構造検査のログは `targeted-tests.log`。
この sandbox の集計は5つのファイル単位であり、内側のケース数を実測件数として捏造していない。
修正前の操作テストは `operations-before.log`。
handoff の sandbox 実行は詳細のない子プロセス単位の失敗で、
同じ selection を制限外で再実行し `handoff-24-verified.log` の24/24 PASSを確認した。
失敗ログ `handoff-24-tests.log` も保存している。

selection は変更していない:

```text
Task acceptance above 32 KiB|completed prepared Service|oversized|payload|unauthori[sz]ed|immutable|stale|UTF-8|Spec repair|Spec Repair
```

既存テストの入力・期待値・拒否条件は変更していない。
操作テストに公開結果の分離を確認する1ケースだけ追加した。
受理操作の後で最後のschema拒否が起きても受理状態が公開されること、入力Spec不変更、
公開root/auditのfreeze、別applyや呼出し元の後続変更との分離を確認する。
この追加ブロックを除いた既存テスト bytes は作業開始時 hash と一致する。
既存の拒否後の正常 sibling、配列削除後の位置、schema rollback後の位置、
合法大値の保存/reload/consumer利用、preview/audit、receipt/Review/Gate遷移の保証を維持した。

## Hash と変更範囲

対象 source のSHA-256:

- 修正前: `139be632a9ffac38b03255f7ca013bd029249ead9cd435d64ff2ac5282f1c0e0`
- 修正後: `0974209c02540a4f3f2a21ec8f7a266fa00161e5f7bace8354bc65ea58d145a7`

`before-manifest.json` に作業開始時の全src/tests hash、
`verification-test-hashes-final.json` と `final-verification.json` に比較用・最終テストと source のhash、
`existing-tests-preserved.json` に既存テスト bytes の照合、
`scope-verified.json` に他の既存 source/test が不変であることを記録した。
比較 snapshot にはGit metadataや実Flow状態をコピーしていない。
今回変更した既存ファイルは対象 source と操作テストのみ。別の実装担当と独立監査を使用し、
管理者も差分・完全出力・計数・ログを直接確認した。

既知の `SpecGateRepairSettlementWriter` import循環は別件として保持。
その source/test のhashが作業開始時から不変であることを確認した。
今回の仕様範囲に未確認事項はない。性能の絶対値・RSS改善は保証しない。
docs freshnessはstaleで、`sennel docs build` を提案済み。docs生成は行っていない。

commit、merge、push、ボード変更、実Issue Flowの開始・再開は行っていない。
作業用worktreeと新しい検証記録を再レビュー用に保持した。
