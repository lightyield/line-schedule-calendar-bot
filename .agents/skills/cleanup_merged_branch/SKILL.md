---
name: cleanup_merged_branch
description: PRがmainにマージされた後、作業ブランチをローカルとリモートの両方から削除し、mainブランチにチェックアウトする。「マージしました」「ブランチを削除して」「後片付けして」などの発言をトリガーとして実行する。
---

# PRマージ後のブランチクリーンアップ手順

PRが `main` にマージされた後、以下の手順で作業ブランチを完全に削除し、`main` に切り替える。

## 手順

1. **`main` に切り替えてリモートの最新を取得**
   ```bash
   git checkout main && git pull origin main
   ```

2. **ローカルブランチを削除**（マージ済みであれば `-d`、未マージ強制削除は `-D`）
   ```bash
   git branch -d <branch-name>
   ```

3. **リモートブランチを削除**
   ```bash
   git push origin --delete <branch-name>
   ```

## ルール

- 削除対象のブランチ名は、現在の作業ブランチ（直前まで使っていたブランチ）を使用する。
- `main` や `master` など保護ブランチは削除しない。
- コマンドは1行にまとめて実行してよい（例: `git checkout main && git pull origin main && git branch -d <branch> && git push origin --delete <branch>`）。
- 完了後、ユーザーに「ブランチ `<branch-name>` をローカル・リモートから削除し、`main` に切り替えました」と報告する。
