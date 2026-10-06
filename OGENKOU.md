# Ogenkou用Core

このforkはVivliostyleの上流履歴を保持し、fork作成時のmaster
`a90d13def0817ef4c67a6780cdbad80e460068db`へOgenkou用変更を1コミット追加します。
上流masterのCore修正を保持し、旧2.45.1向けの独自処理と重なる計測処理は上流実装を使います。

## 変更の範囲

`packages/core/`に、メモリ原稿入力、ページ再利用、Committed／Workingの表示、
focused組版、更新制御、iframe間のDocument所有の取り扱いを追加しています。
VS CodeのUIと原稿記法の変換はOgenkou側に置きます。CLIは変更しません。
元の著作権表示とAGPLライセンスを維持します。

## Core単独のビルド

Node.js 22.12以降を使用します。リポジトリ直下で実行してください。

```console
npm ci --prefix packages/core --ignore-scripts
npm run build --prefix packages/core
```

`packages/core/lib/`へESM、CommonJS、Webview用IIFE、型定義を生成します。
packageは`@ogenkou/vivliostyle-core-adaptive`です。
上流のViewer・CLIがこのfork packageを使う構成には変更していません。

表示・revision・再利用の回帰はOgenkouの単体試験、組版試験、Extension Host試験で検証します。
