# 見張らない見守り — 予定と返答で次の声かけを変える在宅介護エージェント

第5回 Agentic AI Hackathon with Google Cloud 提出プロジェクト。
日中ひとりで過ごす認知症の母に iPad からやさしく声をかけ、当日の予定と返答から次の声かけの時刻と内容を自分で変える。夕方に家族へ「今日の様子」を届け、外へ出す判断は家族が握る。止まっても自分で気づく。

- 企画: [docs/01_企画書.md](docs/01_企画書.md)
- 部品の境目（API・データの形・権限段階・状態機械）: [docs/02_設計書.md](docs/02_設計書.md)
- 声かけ計画の初期値と再生モードの台本: [docs/03_声かけ計画_初期値.md](docs/03_声かけ計画_初期値.md)
- 画面を作る人向けの API 入出力例: [src/api/README.md](src/api/README.md)
- Google Cloud 側の準備手順: [infra/setup.md](infra/setup.md)
- AI（Claude Code など）が最初に読む入口: [CLAUDE.md](CLAUDE.md)

## 構成

Cloud Run 1 サービス（TypeScript / Node.js）。パスで役割を分ける。

```
src/
  index.ts      Cloud Run の入口（functions-framework）      dev.ts   手元用（Express）
  app.ts        部品の組み立て                               config.ts / log.ts / time.ts / types.ts / services.ts
  agent/        会話ターン（ADK: 5 つの道具、権限段階は beforeToolCallback 一か所、規則による代替）
  state/        状態機械（計画・声かけ・再確認・段階上げ・日次要約・変化評価・再生モード）
  store/        Firestore（default / develop）と、テスト・再生用のメモリ実装
  notify/       LINE / Slack / メール（スタブ）、通知の作成と段階上げ
  tasks/        Cloud Tasks（本番）と inline（手元）の時刻予約
  ops/          運用エージェント（生存信号・障害の数え上げ・代替への切替・Slack 報告）
  tts.ts        音声合成（端末の読み上げ / Cloud Text-to-Speech）
  api/          端末用・家族用・内部用・LINE Webhook のルート、認証、静的配信
web/            開発者向けの確認ページ（/device, /family）。本画面は別に作る
eval/scenarios/ 再生モードの台本（期待値付き）
scripts/        seed-dev（世帯の初期値の投入）、replay（台本の実行）、try-turn（Gemini で 5 パターン）
test/           node:test（ネットワーク不要）
```

## 手元で動かす

```bash
npm install
cp .env.example .env        # 値は自分用に変える。本物の秘密情報は Cloud Run の環境変数にだけ置く
npm run seed:dev            # Firestore develop に世帯の初期値を入れる（gcloud auth application-default login 済みが前提）
npm run dev                 # http://localhost:8080 （/family で合言葉ログイン、/device で端末の確認ページ）
```

Avast などで TLS が差し替えられる PC では `NODE_EXTRA_CA_CERTS` に gcloud の ca-bundle を指定する（.env.example 参照）。

```bash
npm test                    # 単体テスト（LLM もネットワークも使わない）
npm run build && npm start  # 本番と同じ functions-framework で起動
npm run replay              # 台本を規則の分類で流す（AGENT_MODE=adk なら Gemini で）
```

## 提出版でやらないこと

常時カメラ、映像の保存、GPS、本人への採点、医療診断、本人に頼まれた外部連絡。詳細は企画書 §7.4。
