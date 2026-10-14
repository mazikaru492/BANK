# BANK 銀行シミュレーター

SQLの顧客・口座・取引データを使うWebアプリです。このPCではMySQL、VercelではSupabase PostgreSQLに接続できます。

## このPCで起動

Node.js 22以上とMySQL 8を使います。`npm ci`を実行し、`.env.example`を`.env`にコピーしてMySQLの接続情報を入力してください。

```powershell
npm run db:import -- "C:\Users\yukij\BANK 1.sql"
npm start
```

http://localhost:8000 を開き、SQLの`kouza_master`にある銀行コード4桁、支店コード3桁、口座番号7桁、暗証番号4桁でログインします。先頭の0も入力してください。

## Supabaseに移行

Supabaseに専用プロジェクトを作成し、Connect → Direct → Transaction poolerのURIをコピーします。`.env.supabase.example`を`.env.supabase.local`にコピーし、`DATABASE_URL`にパスワードを含むURIを設定してください。パスワードに記号を含む場合はpercent-encodeが必要です。

```powershell
npm run db:supabase -- "C:\Users\yukij\BANK 1.sql"
```

MySQLのダンプを解析し、PostgreSQLの専用`bank`スキーマへ顧客・口座・取引を一括移行します。既存のデータは上書きしません。Data APIは不要です。テーブルにはRLSを設定し、ブラウザから直接アクセスせずサーバーのAPIで認証します。

## Vercelで公開

GitHubの`mazikaru492/BANK`を接続し、本番ブランチを`main`に設定します。FrameworkはOther、Install Commandは`npm ci`、Build Commandは`npm run build`、Output Directoryは`dist`です。`vercel.json`にも同じ設定と東京リージョンを指定しています。

VercelのProduction環境に、Supabaseの接続URIを`DATABASE_URL`というSecret変数として保存してください。`DATABASE_SCHEMA`は省略すると`bank`です。Supabase公式の公開CA証明書を同梱し、TLS証明書を検証します。証明書を更新する場合は`DATABASE_CA_CERT`で上書きできます。Previewに本番DBの接続情報を設定せず、変更したら再デプロイします。このPCのMySQLの接続情報はVercelで使えません。

接続設定がない場合はデモモード（暗証番号9314、初期残高0円）になります。DB接続が設定済みで接続に失敗した場合はエラーを表示します。

## 投資・引き出し上限・背景・カード明細

上部メニューまたはお取引タブから「投資」「カード明細」「設定」を開けます。

- **投資**: 架空のMANABI インデックスを1口単位で購入・売却します。チャートは画面表示中に約3秒ごとにランダムに動き、保有数量・評価額・評価損益を表示します。購入代金は口座残高から差し引き、売却代金は残高に戻します。残高不足・保有数量不足・価格の変更時は取引を確定しません。実際の市場・証券会社とは連携していません。
- **引き出し上限**: 「設定」で暗証番号を入力して1日の合計上限を保存します。日本時間0時からの出金だけが対象で、設定前の当日出金も含みます。0円で出金停止、空欄で上限なし。振込・投資には適用しません。DBモードでは口座行のロック中に上限をチェックするため、同時出金でも超過しません。
- **背景**: 桜・森・海の実写写真を選ぶと、その場で適用・保存されます。写真はアプリに同梱しています。標準・自由な色・PNG/JPEG/WebP画像（2MBまで）も選び、プレビューを確認して適用できます。このブラウザに口座ごとに保存します。保存容量が不足した場合はエラーを表示し、現在の背景を保ちます。
- **カード明細**: バーチャル／リアルカードと月を選び、サンプル明細・手入力の利用記録を表示します。それぞれの合計を分けて表示し、サンプルは非表示にもできます。手入力の記録は保存されます。カード会社の実請求・決済・口座引き落としは行いません。

デモモードでは残高・保有数量・当日の出金額・上限・手入力明細をブラウザに保存し、再読み込みや再ログイン後も復元します。DBモードではこれらを口座ごとにDBに保存します（背景のみブラウザ保存）。

既存DBには、公開する前に追加テーブルを作成してください。既存の顧客・口座・取引は変更しません。

```powershell
# このPCのMySQL
npm run db:upgrade
# Supabase
node --env-file=.env.supabase.local scripts/upgrade-db.mjs
```

新規のSQLインポートでは、追加テーブルも自動作成します。追加するテーブルは`bank_preferences`、`bank_market`、`bank_holdings`、`bank_card_entries`です。SupabaseではRLSを有効化し、ブラウザから直接読み書きせず認証済みAPIを使います。

## 動作と設定

口座名義・残高はDBから読み込みます。入金・出金・振込は口座行をロックし、残高と取引履歴を同じトランザクションで更新します。振込は送金先も更新し、失敗したらすべて取り消します。履歴は直近20件を表示し、ログイン状態はDBに保存した8時間有効のセッションで管理します。レシートは取引日時と口座情報を反映します。

| 変数 | 用途 |
| --- | --- |
| DATABASE_URL | SupabaseのTransaction pooler URI。指定時はMySQLより優先 |
| DATABASE_SCHEMA | PostgreSQLのスキーマ。既定値bank |
| DATABASE_CA_CERT | TLS検証に使うPEM証明書 |
| DB_HOST / DB_PORT | ローカルMySQLのホストとポート（既定3306） |
| DB_NAME / DB_USER / DB_PASSWORD | ローカルMySQLのDB名・ユーザー・パスワード |
| DB_SSL | 外部MySQLでTLSを使う場合true |
| PORT | ローカルWebサーバーのポート（既定8000） |

取引コードは0=初期残高、1=入金、2=出金、3=振込、4=振込入金、5=投資購入、6=投資売却です。`torihiki_table.bank_id`は口座の`account_id`を参照します。金額は1円単位の非負整数で、JavaScriptで正確に表現できる範囲を検証します。

`.env`、`.env.supabase.local`、SQLの実データ、ログイン案内`.local-login.txt`はGitにもデプロイにも含めません。`supabase/schema.sql`にはテーブル定義だけを保存しています。

## 検証

```powershell
npm test
npm run build
# Supabaseへの接続情報が設定済みの場合
node --env-file=.env.supabase.local --test
```

DBテストはランダムな専用DB（MySQL）または専用スキーマ（PostgreSQL）に架空の口座を作り、ログイン・入力検証・同時更新・振込・ロールバック・ログアウトを確認して専用領域だけ削除します。MySQLのテストユーザーにはテストDBの作成権限が必要です。DB未設定時はDBテストをスキップします。

主要ファイルは`index.html`（画面）、`api/bank.mjs`（API）、`lib/bank.mjs`（取引処理）、`lib/db.mjs`（DB接続）、`scripts/serve.mjs`（ローカル起動）です。Java Swing版の`SimpleBankSystem.java`は別プログラムです。

参考: [Supabaseのサーバーレス接続](https://supabase.com/docs/guides/database/connecting-to-postgres/serverless-drivers)、[Vercel Node.js Functions](https://vercel.com/docs/functions/runtimes/node-js)
