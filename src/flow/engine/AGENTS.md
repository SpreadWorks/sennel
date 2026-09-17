# Flow 実行機構

このディレクトリには、実行する `Step` の共通契約、`StepOutput`、`StepFactory`、`StepConnector`、Flow 固有のエラー情報クラスを置く。Flow 全体の状態遷移規約は親の `src/flow/AGENTS.md` を正とし、ここでは実行機構固有の境界だけを定める。

- `Step` は自身の処理と Step 内で完結する限定的な再試行を担当し、`execute()` から `StepOutput` を返す。遷移先は選ばない。
- `StepOutput` は一引数で非エラー結果の定数または `Error` を受け取る。通常の `Error` と `FlowExecutionError` の区別を保存・復元後も維持し、存在しない Flow 情報を補作しない。
- `StepFactory` は Step 側の依存宣言に従ってサービスを生成・注入する。Step 固有の依存一覧や成果物の取得・保存処理を Factory に集めない。
- `StepConnector` は Definition が選んだ接続の準備・適用を担当する。接続元 Attempt と成果物の版を固定するが、遷移先や成果物の品質は判断しない。
- canonical Store を状態と成果物の唯一の正本とする。Step や Factory は成果物のパスを推測しない。
- Draft／Review などの成果物の読み書き・スキーマ検証は、将来の `src/flow/services/` に置く各サービスが既存の成果物クラスと canonical Store の API を使って担う。サービスはこのディレクトリに置かない。
- `src/flow/lib/` 全体をこのディレクトリへ移す対象とはしない。状態、成果物、遷移判断など責務の異なるコードを一括して収容しない。
