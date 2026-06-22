# GAS CI/CD 環境 構築ガイド

本プロジェクトでは、GitHub リポジトリの `main` ブランチにソースコードがプッシュ（または Pull Request がマージ）された際に、Google Apps Script (GAS) へ自動的にソースコードを反映（およびデプロイ更新）する CI/CD パイプラインを GitHub Actions で構築しています。

---

## 🛠 事前準備

### 1. Node.js のセットアップ
ローカル環境に **Node.js (v22以降)** がインストールされていることを確認してください。
その後、プロジェクトのルートディレクトリで依存パッケージをインストールします。

```bash
npm install
```

### 2. Google Apps Script API の有効化
`clasp` を使って外部から GAS を操作するために、Google アカウント側で API を有効化する必要があります。

1. [Google Apps Script ユーザー設定](https://script.google.com/home/usersettings) にアクセスします。
2. **「Google Apps Script API」** を **「オン」** に変更します。

---

## 🔑 認証情報の取得とローカルでの設定

### 1. `clasp` へのログイン
ローカル環境で以下のコマンドを実行し、Google アカウントでログインします。

```bash
npm run login
```

ブラウザが起動し、Google アカウントの認証画面が表示されます。GASプロジェクトを所有している（または編集権限のある）Google アカウントでログインし、アクセスを許可してください。

ログインが成功すると、ローカルマシンのホームディレクトリに認証情報ファイル `.clasprc.json` が生成されます。

- **macOS / Linux**: `~/.clasprc.json`
- **Windows**: `C:\Users\<ユーザー名>\.clasprc.json`

> [!WARNING]
> `.clasprc.json` には Google アカウントの非常に強力な権限（GASプロジェクトの作成や編集など）が含まれています。**絶対に Git にコミットしたり、公開したりしないでください。** （本プロジェクトでは `.gitignore` で除外設定済みです）

### 2. ローカルでの `.clasp.json` の作成
デプロイ先となる GAS プロジェクトの **スクリプト ID** を取得し、ローカルに設定ファイルを作成します。
※ `.clasp.json` はスクリプトIDを含むため、セキュリティ保護の観点から Git 管理から除外されています（`.gitignore` に登録済み）。

1. 対象の GAS プロジェクトをブラウザで開きます。
2. 左メニューの **「プロジェクトの設定（歯車アイコン）」** をクリックします。
3. **「スクリプト ID」** の項目に表示されている文字列（長い英数字）をコピーします。
4. プロジェクトルートに **`.clasp.json`** という名前のファイルを新規作成し、以下の内容を記述します。 `"コピーしたスクリプトID"` の部分を実際にコピーした値に置き換えてください。

```json
{
  "scriptId": "コピーしたスクリプトID",
  "rootDir": "src"
}
```

---

## 🚀 GitHub Actions CI/CD の設定

GitHub にソースコードをプッシュした際に自動デプロイを実行するため、GitHub リポジトリの **Secrets** に認証情報などを設定します。

### 1. GitHub Secrets の登録
GitHub のリポジトリを開き、**Settings > Secrets and variables > Actions** に進みます。
**「New repository secret」** から以下の 3 つのシークレットを登録します。

| シークレット名 | 値の説明 | 必須/任意 |
| :--- | :--- | :--- |
| `CLASPRC_JSON` | ローカルで取得した `~/.clasprc.json` の**中身（JSONテキスト）を丸ごとコピー**して貼り付けます。 | **必須** |
| `GAS_SCRIPT_ID` | 上記手順で取得した GAS の **スクリプト ID**。 | **必須** |
| `GAS_DEPLOYMENT_ID` | Web App (LINE Webhook) 用の **デプロイ ID**。 | 任意 |

> [!NOTE]
> **`GAS_DEPLOYMENT_ID` について**:
> - これを設定しない場合、GitHub Actions は `clasp push`（コードのアップロード）のみを実行し、本番の Web App は更新されません。
> - これを設定した場合、コードをアップロードした後に、そのデプロイ ID のバージョンを自動で更新（`clasp deploy`）します。LINE Bot の本番環境に自動で変更を反映させたい場合は、設定することを強く推奨します。
> - デプロイ ID は、GASエディタ右上「デプロイ」＞「デプロイを管理」から、対象のデプロイ（ウェブアプリ）の「アクティブなデプロイ」欄にある「デプロイ ID」から取得できます。

---

## 💻 ローカル開発での便利なコマンド

セットアップ完了後、ローカルから手動で GAS プロジェクトを操作することも可能です。

- **ローカルのコードを GAS へ送信**:
  ```bash
  npm run push
  ```
- **GAS 上の最新コードをローカルへ取得**:
  ```bash
  npm run pull
  ```
- **手動での新規デプロイ作成**:
  ```bash
  npm run deploy
  ```
