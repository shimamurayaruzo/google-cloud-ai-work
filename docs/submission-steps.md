# 提出手順書（Zenn ダッシュボード）— 2026-10-15（木）23:59 まで

島村さんが行う操作だけを、画面の順に書いた。文章の中身は docs/submission.md からコピーする。

## 0. 先に用意するもの

| もの | ある場所 |
|---|---|
| デプロイ URL | `https://hello-google-cloud-3g7542tlla-an.a.run.app` |
| プロジェクト説明の文章 | docs/submission.md の「1. プロジェクト説明」 |
| 動作確認の方法の文章 | docs/submission.md の「2. 動作確認の方法」（＜合言葉＞と＜hh_demo の端末トークン＞を埋める） |
| アーキテクチャ図の画像 | docs/infographic/system-overview.png |
| デモ動画の URL | YouTube に限定公開でアップした URL（手順 4） |
| 合言葉（新しい値） | 手順 1 で作る |
| hh_demo の端末トークン | Documents\mimamori-secrets.txt の `DEVICE_TOKENS=hh_main:…,hh_demo:` の右側 32 文字 |

## 1. 合言葉を新しい値に変える（提出前に 1 回）

古い合言葉はコンソールのスクショに写ったことがあるので、提出用に作り直す。PowerShell で:

```powershell
$pp = -join ((1..12) | ForEach-Object { 'abcdefghjkmnpqrstuvwxyz23456789'[(Get-Random -Maximum 31)] })
gcloud run services update hello-google-cloud --region asia-northeast1 --update-env-vars "APP_PASSPHRASE=$pp"
"`nAPP_PASSPHRASE（提出用、2026-10-14）=$pp" | Add-Content "$HOME\Documents\mimamori-secrets.txt"
$pp
```

最後の行で新しい合言葉が画面に出る。これを提出フォームの「動作確認の方法」に書く。家族画面（/family）のログインも同じ値になる。

## 2. GitHub リポジトリを連携する（GitHub App）

1. https://zenn.dev にログイン → https://zenn.dev/hackathons/google-cloud-japan-ai-hackathon-vol5 を開く → 上部の **「ダッシュボード」**
2. プロジェクト「見張らない見守り」を開く（無ければ「プロジェクトを作成」。名前は後から変えられる）
3. 「GitHub リポジトリ」の欄 → **「GitHub App をインストール」**（または「連携」）
4. GitHub の画面: インストール先に **`shimamurayaruzo`**（ご自身のアカウント）→ **Only select repositories** → `google-cloud-ai-work` にチェック → **Install**
5. Zenn に戻り、リポジトリの選択欄で `shimamurayaruzo/google-cloud-ai-work` を選んで保存。非公開のままでよい

審査はデフォルトブランチ（main）を見る。提出後は main に触らない（12/1 まで）。続きの開発は別ブランチで。

## 3. 提出項目を入力する

ダッシュボードのプロジェクトの各欄に、次を入れる。

| 欄 | 入れるもの |
|---|---|
| プロジェクト名 | 見張らない見守り — 予定と返答で次の声かけを変える在宅介護エージェント |
| デプロイ URL | `https://hello-google-cloud-3g7542tlla-an.a.run.app` |
| プロジェクト説明 | docs/submission.md「1. プロジェクト説明」を丸ごと貼る |
| システムアーキテクチャ図 | docs/infographic/system-overview.png をアップロード |
| 動作確認の方法 | docs/submission.md「2. 動作確認の方法」を貼り、＜合言葉＞と＜hh_demo の端末トークン＞を実際の値に置き換える。「サンプルデータは架空です」の一文があることを確認 |
| デモ動画 URL | YouTube の URL（手順 4） |
| Zenn 記事 URL | 任意。書かなければ空欄 |
| 使った技術 | Cloud Run、Agent Development Kit（TypeScript）、Gemini（Vertex AI / Gemini Enterprise Agent Platform 経由）、Firestore、Cloud Tasks、Cloud Scheduler、Cloud Logging、Cloud Text-to-Speech（切替可）。Flutter / Firebase は「使っていない」 |
| 12/1 の現地登壇の同意 | チェック |

入力後、**「提出」**を押す。締切前なら提出後も編集できる。締切後は一切変更できない。

## 4. デモ動画を YouTube に限定公開でアップする

1. 島村さんが撮った写真または動画を `C:\Users\shima\Documents\google-cloud-ai-work\tmp\video\live\` に `c02.jpg`（または .mp4）、`c05.jpg`（または .mp4）の名前で置く
2. Claude が `npm run video` で `tmp\video\demo-draft.mp4` を作り直す
3. https://studio.youtube.com → 「作成」→「動画をアップロード」→ mp4 を選ぶ → タイトル「見張らない見守り — 第5回 Agentic AI Hackathon with Google Cloud」→ 「子ども向けではない」→ 公開設定 **「限定公開」** → 保存
4. 動画の URL（`https://youtu.be/…`）をコピーして手順 3 の欄へ

## 5. 提出直前の確認（docs/submission.md のチェックリストと同じ）

- [ ] ログインしていないブラウザで入口 → 合言葉 → 「① 1 日分を再生」が最後まで流れ「期待値との一致 13 / 13」が出る
- [ ] 「③ 家族の画面」でテスト世帯の記録と通知が見える（本物の母の記録ではない）
- [ ] 「② 母側の画面」が開く（PC ではマイクなしでも文字入力に切り替わる）
- [ ] 動作確認の方法に、合言葉・hh_demo のトークン・「サンプルは架空」の 3 つが入っている
- [ ] 審査員用の履歴を入れ直した（文字起こしは 7 日で消える。10/14 に `npm run seed:demo` を本番に対して実行。Claude が行う）
- [ ] YouTube の動画が限定公開で開ける
- [ ] 12/1（火）に渋谷へ行ける

## 6. 提出後にやること

- main に触らない。以後の開発は `feature/…` ブランチで
- Cloud Run を 12/1 まで止めない（Scheduler も動かしたまま）
- Zenn 記事は任意。書くなら docs/article-outline.md の章立てで、締切に関係なく後からでもよい
