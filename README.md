# BANK（まなび銀行）

セキュリティ学習用の架空の銀行サイトです。Web版の `index.html` をVercelで公開できます。

## Vercelで公開する

1. この変更をGitHubの `main` ブランチに反映します。Pull Requestから反映する場合は「Merge pull request」を押します。
2. https://vercel.com/new を開き、GitHubアカウントでログインします。
3. 「Import Git Repository」で `mazikaru492/BANK` を選び、「Import」を押します。
4. 次の設定を確認して「Deploy」を押します。

| 項目 | 設定 |
| --- | --- |
| Framework Preset | Other |
| Root Directory | リポジトリ直下（変更不要） |
| Build Command | `node scripts/build.mjs` |
| Output Directory | `dist` |
| Install Command | 空欄（インストール不要） |
| Environment Variables | 不要 |

ビルド・出力・インストールの設定は `vercel.json` に記載済みです。通常は手動入力せず、そのままDeployできます。

完了すると `https://プロジェクト名.vercel.app` の公開URLが表示されます。GitHubと連携した後は `main` への更新で再デプロイされます。

## 動作を確認する

- 練習用暗証番号は `9314` です。
- 初期残高は0円です。まず「入金」で金額を追加します。
- 残高照会・入金・出金・振込はブラウザ内の模擬操作です。
- 残高は保存されません。再読み込みすると0円に戻り、他の利用者とは共有されません。
- 実際の銀行サービスには接続しません。暗証番号は学習用の固定値で、本物の認証機能ではありません。

## ローカルで確認する

`index.html` をブラウザで開くと利用できます。公開用ファイルの生成にはNode.jsを使用します。

```bash
node scripts/build.mjs
python -m http.server 8000 --directory dist
```

http://localhost:8000 を開きます。

## ファイル構成

- `index.html`: Web版の画面・スタイル・操作処理
- `vercel.json`: Vercelの公開設定
- `scripts/build.mjs`: `index.html` だけを `dist` にコピーするビルド処理（外部パッケージ不要）
- `SimpleBankSystem.java` / `SimpleBankSystem.class`: Java Swingのデスクトップ版。Vercelの公開ファイルには含めません。

画像・CSS・JavaScriptを別ファイルに分ける場合は、`scripts/build.mjs` にそのファイルのコピー処理も追加してください。

公式ドキュメント: https://vercel.com/docs/project-configuration/vercel-json
