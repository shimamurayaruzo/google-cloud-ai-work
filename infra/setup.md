# Google Cloud 側の準備（手順書）

プロジェクト `eco-diode-508102-q7`、リージョン `asia-northeast1`、Cloud Run サービス `hello-google-cloud`。
gcloud はこの PC では `%LOCALAPPDATA%\Google\Cloud SDK\shim\gcloud.cmd`（PATH 登録済み）。

## 済んでいること（2026-09-27）

| 項目 | 状態 |
|---|---|
| API 有効化 | cloudscheduler / cloudtasks / texttospeech を有効化 |
| Firestore | `default`（本番）と `develop`（開発）。**ID は 4 文字以上が必須なので `dev` にはできない** |
| Cloud Tasks キュー | `mimamori`（asia-northeast1） |
| Cloud Run 環境変数 | `APP_PASSPHRASE`, `SLACK_WEBHOOK_URL` が設定済み |
| Cloud Run の実行 SA | `705310679922-compute@developer.gserviceaccount.com` |
| Cloud Run URL | `https://hello-google-cloud-3g7542tlla-an.a.run.app` |

## デプロイ前に Cloud Run に足す環境変数

値はここに書かない。Cloud Run コンソールか下のコマンドで個別に設定する。

```bash
gcloud run services update hello-google-cloud --region asia-northeast1 \
  --update-env-vars FIRESTORE_DATABASE=default,TASKS_MODE=cloud,TTS_MODE=device,AGENT_MODE=adk,\
SERVICE_URL=https://hello-google-cloud-3g7542tlla-an.a.run.app,\
TASKS_SERVICE_ACCOUNT=705310679922-compute@developer.gserviceaccount.com,\
GOOGLE_GENAI_USE_ENTERPRISE=true,GOOGLE_CLOUD_PROJECT=eco-diode-508102-q7,GOOGLE_CLOUD_LOCATION=global,\
HOUSEHOLD_ID=hh_main
# 秘密情報は個別に（値はチャットに貼らない）
gcloud run services update hello-google-cloud --region asia-northeast1 --update-env-vars INTERNAL_TOKEN=...
gcloud run services update hello-google-cloud --region asia-northeast1 --update-env-vars DEVICE_TOKENS=hh_main:...,hh_demo:...
gcloud run services update hello-google-cloud --region asia-northeast1 --update-env-vars LINE_CHANNEL_ACCESS_TOKEN=...,LINE_CHANNEL_SECRET=...
```

## Cloud Tasks / Scheduler が Cloud Run を OIDC で呼ぶための権限

実行 SA が自分自身の ID トークンを作れるように、また Cloud Run を呼べるように付与する。

```bash
SA=705310679922-compute@developer.gserviceaccount.com
gcloud run services add-iam-policy-binding hello-google-cloud --region asia-northeast1 \
  --member serviceAccount:$SA --role roles/run.invoker
gcloud iam service-accounts add-iam-policy-binding $SA \
  --member serviceAccount:$SA --role roles/iam.serviceAccountTokenCreator
gcloud projects add-iam-policy-binding eco-diode-508102-q7 \
  --member serviceAccount:$SA --role roles/cloudtasks.enqueuer
```

## Cloud Scheduler のジョブ（デプロイ後に作る。今作ると旧アプリに 404 を投げ続ける）

```bash
URL=https://hello-google-cloud-3g7542tlla-an.a.run.app
SA=705310679922-compute@developer.gserviceaccount.com
common="--location asia-northeast1 --time-zone Asia/Tokyo --http-method POST --headers Content-Type=application/json --oidc-service-account-email $SA --oidc-token-audience $URL"

gcloud scheduler jobs create http mimamori-plan    --schedule "0 6 * * *"   --uri $URL/internal/plan    --message-body '{}' $common
gcloud scheduler jobs create http mimamori-summary --schedule "0 18 * * *"  --uri $URL/internal/summary --message-body '{}' $common
gcloud scheduler jobs create http mimamori-health  --schedule "*/5 * * * *" --uri $URL/internal/health  --message-body '{}' $common
```

声かけの時刻は Scheduler ではなく、`/internal/plan` が当日分の Prompt を queued で積み、端末が `GET /api/device/next-prompt` で取りに来る方式なので、項目ごとのジョブは要らない。再確認と段階上げは Cloud Tasks。

## Firestore の TTL（会話の文字起こしを 7 日で消す）

```bash
gcloud firestore fields ttls update expiresAt --collection-group=turns --database=develop --enable-ttl
gcloud firestore fields ttls update expiresAt --collection-group=turns --database=default --enable-ttl
```

## 手元での確認

```bash
cp .env.example .env   # 値を自分用に変える
npm run seed:dev       # develop に世帯を入れる
npm run dev            # http://localhost:8080
# 別ターミナルで
curl -X POST localhost:8080/internal/plan -H "X-Internal-Token: $INTERNAL_TOKEN" -H "Content-Type: application/json" -d '{}'
```

## 予算アラート

Billing → Budgets で月額の上限を設定する（コンソール操作。企画書 §6.2）。
