# google-cloud-ai-work — 見守りエージェント（第5回 Agentic AI Hackathon with Google Cloud）

このリポジトリで作業する AI（Claude Code など）が最初に読むファイル。詳細は docs/ にある。

## 何を作っているか

認知症の母と暮らす家のための「見張らない見守り」エージェント。決まった時刻の電話ではなく、当日の予定と返答から次の声かけの時刻と内容を自分で変える。夕方に家族へ「今日の様子」を届け、外へ出す判断は家族が握る。止まっても自分で気づく。

- 企画: docs/01_企画書.md（v0.3、チーム合意済み）
- 部品の境目: docs/02_設計書.md（API・Firestore のデータの形・権限段階・状態機械・台帳イベント・環境変数）
- 声かけ計画の初期値と再生モードの台本: docs/03_声かけ計画_初期値.md
- 直近の状況共有: docs/04_状況共有_2026-09-27.html
- ADK（TypeScript）の試作と結果: agent-spike/README.md

## 決まっていること（変えるときは docs を先に直す）

- 言語は TypeScript/Node.js に一本化。ADK は @google/adk（TypeScript）を「会話ターンの実行・型付き道具・権限段階の一元化（beforeToolCallback）・トレース」にだけ使う。時刻・再確認・要約の起動は自前の状態機械。
- 実行基盤は Cloud Run 1 サービス（hello-google-cloud、asia-northeast1、プロジェクト eco-diode-508102-q7）。GitHub の main への反映で自動デプロイされるので、main は常に動く状態を保つ。
- Firestore は `default`（本番）と `dev`（開発）。手元では `FIRESTORE_DATABASE=dev`。
- 秘密情報（合言葉、Slack Webhook、LINE トークン）は Cloud Run の環境変数にだけ置く。リポジトリとチャットに書かない。
- 権限段階: 家族への通知は自動／医師・ケアマネへの共有は家族の承認後／本人に頼まれた外部連絡はしない。
- 入力を疑う: テレビや来訪者の声など本人の発話か分からないものは `unclear` として判定しない。
- カメラは使わない。音声は保存しない（文字起こしと短い抜粋のみ、7 日で削除）。
- 提出版に入れないもの: 思い出モード、GPS、電話の自動音声、コード修正の自動化。

## 開発の作法

- ブランチ `feature/名前-内容` → PR → 島村がマージ。本番コードの変更は PR 本文に動作確認の方法を書く。
- コミットは日本語で要点。共同作業者の行は `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
- この PC は Avast が TLS を差し替える。git は `-c http.sslBackend=schannel`、Node は `NODE_EXTRA_CA_CERTS=%LOCALAPPDATA%\Google\Cloud SDK\ca-bundle.pem`、gcloud は `%LOCALAPPDATA%\Google\Cloud SDK\shim\gcloud.cmd`（PATH 登録済み）。
- Gemini は Vertex 経由: `GOOGLE_GENAI_USE_ENTERPRISE=true GOOGLE_CLOUD_PROJECT=eco-diode-508102-q7 GOOGLE_CLOUD_LOCATION=global`、モデルは gemini-2.5-flash。
- 手元の認証は `gcloud auth application-default login`（済）。鍵ファイルは作らない。

## 締切

提出 2026-10-15（木）23:59。ファイナリスト発表 10-28。最終ピッチ 12-01 渋谷ストリーム。提出後はデフォルトブランチを凍結し、デプロイは 12-01 まで維持。
