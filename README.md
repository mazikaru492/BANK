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

取引コードは0=初期残高、1=入金、2=出金、3=振込、4=振込入金です。`torihiki_table.bank_id`は口座の`account_id`を参照します。金額は1円単位の非負整数で、JavaScriptで正確に表現できる範囲を検証します。

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
