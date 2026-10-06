# AI文章レビュー

Google Cloud Run と Gemini を使った文章評価アプリです。

## 使用技術
- Google Cloud Run
- Gemini / Agent Platform
- Node.js

## 機能
- 文章入力
- AIによる100点満点評価
- 良い点
- 改善点

---

## このフォルダについて

ハッカソン着手前に作った Cloud Run + Gemini + Firestore の最初のサンプル（2026-09-22〜27、`index.js` 1 ファイル）。
文章を 100 点満点で評価し、80 点未満なら最大 2 回まで自動改善し、履歴を Firestore に保存、人が最終承認する。
見守りエージェント本体（`src/`）とは別物で、学習用に残している。動かすならこのフォルダで `npm install && npm start`（`APP_PASSPHRASE` が必要）。
削除前の最後のコミットにはタグ `sample-ai-text-review` を付けてある。
