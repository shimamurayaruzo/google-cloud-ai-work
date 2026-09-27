# agent-spike — ADK (TypeScript) 1日試作（2026-09-27）

目的: 「1回の声かけターン」を ADK のエージェント + 型付き道具で書き、権限段階を beforeToolCallback 一か所で強制できるか、トレースが行動台帳に使えるかを確かめる。

## 実行

```bash
cd agent-spike && npm install
# Avast 等で TLS が差し替えられる PC では Node にも CA を渡す
export NODE_EXTRA_CA_CERTS="$LOCALAPPDATA/Google/Cloud SDK/ca-bundle.pem"
export GOOGLE_GENAI_USE_ENTERPRISE=true GOOGLE_CLOUD_PROJECT=eco-diode-508102-q7 GOOGLE_CLOUD_LOCATION=global
npx tsx run.ts     # 5 パターン（まだ／できた／痛い／テレビの音／電話して）
npx tsx block.ts   # 承認なし・ありで share_external が止まる／通る
```

## 結果（2026-09-27）

| 返事 | 呼ばれた道具 | 判定 |
|---|---|---|
| まだ | record_observation(not_yet) → schedule_recheck(15分) | 正 |
| 着替えたよ | record_observation(done) | 正 |
| 疲れた。腰が痛い | record_observation → notify_family(urgent, 根拠付き) | 正 |
| （テレビの音） | record_observation(unclear)。判定せず | 正 |
| 妹に電話して | record_observation(done) → notify_family(check「頼まれました」)。call_outside は呼ばれず | 正 |
| 家族承認なしで医師へ共有 | share_external → beforeToolCallback が blocked を返す | 止まる |
| 家族承認ありで医師へ共有 | share_external 実行 | 通る |

1ターン 2.4〜4.4 秒（gemini-2.5-flash、Vertex、global）。

## 採用範囲（結論）

- 会話ターンの実行、道具の型定義、権限段階の一元化（beforeToolCallback）、トレース → ADK を使う
- 声かけの時刻・再確認・日次要約の起動・Firestore の設計 → 自前の状態機械（ADK に載せない）
