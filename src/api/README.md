# HTTP API の入出力（画面を作る人向け）

Cloud Run 1 サービスのパスごとの約束です。設計の元は `docs/02_設計書.md §3`。
ここに書いたフィールド名は画面が使うので、変えるときは先にこのファイルと docs/02 を直してください。

- すべて JSON（`Content-Type: application/json; charset=utf-8`）。時刻は ISO 8601（UTC の `Z` 付き）で返ります。画面では `Asia/Tokyo` で表示してください。
- 日付 `date` は `YYYY-MM-DD`（日本時間）。省略すると今日。
- 失敗したときは HTTP ステータスと `{ "ok": false, "error": "日本語の説明" }` が返ります。

| ステータス | 意味 |
|---|---|
| 400 | 入力の形が違う（`error` に何が違うか） |
| 401 | 認証がない・違う（家族画面ならログイン画面へ） |
| 403 | 端末トークンと `hh` が食い違う |
| 404 | 見つからない |
| 409 | すでに決まっている（承認の二重送信など） |
| 415 | 家族 API の書き込みで `Content-Type: application/json` になっていない |
| 503 | サーバー側の設定が足りない（合言葉、LINE の秘密鍵） |

## 認証

| 対象 | 方法 |
|---|---|
| 端末（`/api/device/*`） | ヘッダ `X-Device-Token: <端末トークン>`。トークンから世帯が決まる。`hh` を送るならトークンの世帯と同じ値に |
| 家族（`/api/family/*`） | 合言葉でログイン → Cookie `mimamori_session`（HttpOnly、12 時間）。`fetch` は `credentials: 'same-origin'` で。書き込み（POST/PUT）は `Content-Type: application/json` 必須 |
| 内部（`/internal/*`） | Cloud Scheduler／Tasks の OIDC（`Authorization: Bearer <ID トークン>`）か、`X-Internal-Token` |
| LINE（`/webhook/line`） | `x-line-signature` の署名検証 |

家族画面の世帯は既定の 1 世帯です（提出版）。別の世帯を見るときだけ `?hh=hh_xxx` を付けます。

---

## 1. 端末（iPad の顔画面）

### POST /api/device/heartbeat（60 秒ごと）

```json
// 送る
{ "hh": "hh_main", "batteryPct": 82, "appVersion": "0.1.0" }
// 返る
{ "ok": true, "killSwitch": false, "nextPrompt": { "at": "2026-10-02T00:15:00.000Z", "task": "teeth" } }
```

- `nextPrompt` は「次に話す予定」（まだ話していない声かけのうち一番早いもの）。無ければ `null`。
- `killSwitch: true` のあいだは声かけが来ません。

### GET /api/device/next-prompt?hh=hh_main（5 秒ごとなど）

```json
{ "prompt": { "id": "pr_m1abc", "task": "teeth", "text": "歯を磨きましょう", "ttsUrl": "data:audio/mp3;base64,...", "expression": "smile" } }
{ "prompt": null }
```

- `ttsUrl` は無いことがあります。無ければ端末の読み上げ（`speechSynthesis`、ja-JP）で読みます。
- 受け取った声かけは「話した」扱いになります。同じ `id` をもう一度読み上げないでください。
- L4 モード（至急の通知のあと。下の `today` の `l4`）の間は、通常の声かけは来ず、3 分ごとに安心の一文だけが `"isReassurance": true` 付きで来ます。質問ではないので、読み上げたら返事を待たなくてかまいません（返事を送っても判定はされず、記録に残るだけです）。
- 就寝時間帯（設定の `policy.sleepHours`、既定 21:30〜07:30）は声かけが来ません。

```json
{ "prompt": { "id": "pr_m1r01", "task": "water", "text": "ご家族に連絡しました。無理に立ち上がらず、そのままお待ちください。", "expression": "worry", "isReassurance": true } }
```

### POST /api/device/reply（本人の返事 1 回）

```json
// 送る（文字起こしした返事）
{ "hh": "hh_main", "promptId": "pr_m1abc", "text": "はいはい、磨いたよ", "source": "ipad" }
// 送る（20 秒待っても返事がなかった）
{ "hh": "hh_main", "promptId": "pr_m1abc", "noAnswer": true, "source": "ipad" }
// 返る
{
  "turnId": "tn_m1xyz",
  "say": "さっぱりしましたね。",
  "expression": "smile",
  "followUp": null
}
// 再確認するとき
{ "turnId": "tn_m1xyz", "say": "では、あとでまた声をかけますね。", "expression": "listen", "followUp": { "at": "2026-10-02T00:40:00.000Z", "task": "face" } }
```

- `text` が空で `noAnswer: true` でもないと 400。`audioBase64` はまだ受け付けません（400）。
- `expression` は `smile` / `listen` / `think` / `worry` の 4 種。端末は `say` と `expression` をそのまま出すだけです。
- `say` は空文字のことがあります（3 回続けて返事が無く L4 になったときは本人へ何も言いません）。空なら何も読み上げないでください。
- 転倒などの言葉で L4 になったターンの `say` は定型文「大丈夫ですか。ご家族に連絡します。そのまま動かずにお待ちください。」です。

### POST /api/device/noise-level（5 分ごと。録音しない）

```json
{ "hh": "hh_main", "rms": 0.031, "at": "2026-10-02T01:05:00.000Z" }
// → { "ok": true }
```

---

## 2. 家族画面

### ログイン

| パス | 入力 | 出力 |
|---|---|---|
| `POST /api/family/login` | `{ "passphrase": "…" }` | `{ "ok": true }` と Set-Cookie。違えば 401 |
| `POST /api/family/logout` | `{}` | `{ "ok": true }`（Cookie を消す） |
| `GET /api/family/session` | なし（認証不要） | `{ "ok": true, "authed": false, "passphraseConfigured": true }` |
| `GET /login` ／ `POST /login` ／ `/logout` | 画面（HTML のフォーム）。`/login?next=/family` でログイン後に戻る先 | |

### GET /api/family/today?date=2026-10-02

```json
{
  "date": "2026-10-02",
  "day": {
    "hh": "hh_main", "date": "2026-10-02", "isDayservice": true,
    "plan": [ { "time": "08:00", "task": "greeting" }, { "time": "08:05", "task": "diaper" } ],
    "planApproved": { "by": "family", "at": "2026-10-01T21:10:00.000Z" },
    "tasks": {
      "dress": { "state": "done", "status": "done", "at": "2026-10-01T23:45:00.000Z", "evidence": "着替えたよ", "recheckCount": 1, "promptIds": ["pr_a", "pr_b"], "lastTurnId": "tn_b" },
      "face":  { "state": "rechecking", "status": "no_answer", "recheckCount": 1, "promptIds": ["pr_c"] }
    },
    "summary": {
      "text": "今日の様子 10月2日（金）\n今日は 1 件、確認をお願いしたいことがあります。\nお返事の記録\n・8:45 着替えの声かけに「着替えたよ」とお返事がありました。\n…",
      "sentences": ["今日の様子 10月2日（金）", "今日は 1 件、確認をお願いしたいことがあります。", "お返事の記録", "・8:45 着替えの声かけに「着替えたよ」とお返事がありました。", "…"],
      "citations": [ { "sentenceIndex": 3, "turnId": "tn_b" } ],
      "sections": {
        "heading": ["今日の様子 10月2日（金）"],
        "conclusion": ["今日は 1 件、確認をお願いしたいことがあります。"],
        "replies": ["8:45 着替えの声かけに「着替えたよ」とお返事がありました。", "16:00 帰宅の声かけに「疲れた。腰がちょっと痛い」とお返事がありました。"],
        "concerns": ["16:00 「疲れた。腰がちょっと痛い」とおっしゃいました。そのときにお知らせ済みです。19:00 に聞き直したところ「もう大丈夫」とのことでした。"],
        "continued": ["ありません。"],
        "comparison": ["記録を集めている期間です（4 日目）。", "同じ質問の記録は、今日は 0 回でした。"],
        "about": ["この記録は AI が声かけへのお返事から作っています。体調や病気の判断は含みません。"]
      },
      "changeNote": "記録を集めている期間です（4 日目）。同じ質問の記録は、今日は 0 回でした。",
      "sentAt": "2026-10-02T09:00:00.000Z"
    },
    "signals": { "unclearCount": 0, "noAnswerCount": 1, "repeatedQuestions": 0, "urgentCount": 0, "falseAlarmCount": 0 },
    "l4": null
  },
  "l4": null,
  "prompts": [ { "id": "pr_a", "task": "dress", "text": "お着替えは済みましたか？", "scheduledAt": "…", "isRecheck": false, "state": "answered", "expression": "smile" } ],
  "turns": [
    {
      "id": "tn_b", "task": "dress", "promptId": "pr_b", "promptedAt": "…", "promptText": "そろそろお着替えどうですか？",
      "replyText": "着替えたよ", "replySource": "ipad", "repliedAt": "…",
      "classified": { "status": "done", "note": "…", "by": "llm" },
      "say": "よくできましたね。", "expression": "smile", "blockedCount": 0
    }
  ],
  "notices": [
    { "id": "nt_1", "level": "check", "origin": "pain", "reason": "腰が痛いとおっしゃいました。どの程度か、動けるかは分かりません。", "evidence": "疲れた。腰がちょっと痛い", "turnId": "tn_k", "task": "return",
      "steps": [ { "memberId": "mem_1", "channel": "line", "sentAt": "…", "ackedAt": null } ], "state": "waiting", "createdAt": "…" },
    { "id": "nt_2", "level": "info", "origin": "not_done", "reason": "着替えがまだのようです", "evidence": "着替え: 8:35「まだ」／8:45「まだよ」", "turnId": "tn_c", "task": "dress",
      "steps": [], "state": "deferred", "deferredReason": "daily_cap", "createdAt": "…" }
  ],
  "health": { "hh": "hh_main", "date": "2026-10-02", "lastHeartbeatAt": "…", "incidents": [] },
  "household": { "killSwitch": false, "members": [ { "name": "長男", "order": 1 }, { "name": "次男", "order": 2 } ] },
  "taskLabels": { "greeting": "起床の挨拶", "diaper": "おむつ交換", "…": "…" }
}
```

- `day` は記録が無い日（過去・未来）だと `null`。今日なら計画の雛形から作って返します。
- `turns[].replyText` は 40 文字まで（超えると末尾が `…`）。全文は次の `turn/:turnId` で。
- `tasks[*].state` は `pending` / `asked` / `rechecking` / `done` / `escalated` / `suspended`、`status` は `done` / `not_yet` / `no_answer` / `unclear`。`failCount` はその一巡で取れなかった回数（3 回で家族へ）、`noAnswerStreak` は続けて返事が無かった回数。
- `notices[*].state` は `open` / `waiting` / `acked` / `escalated` / `closed` / `deferred`、`level` は `urgent`（至急・L4）/ `check`（確認のお願い・L3）/ `info`（お知らせ・L2）。
- `notices[*].origin` は文面の由来: `l4_words`（転んだ等）/ `fire` / `pain` / `pain_followup`（痛みの聞き直し）/ `no_answer` / `not_done` / `contact`（本人からの連絡の依頼）/ `departure` / `repeat`（同じ質問の増加）/ `summary` / `plan` / `device` / `other` / `bath`（お風呂モード。info「体を洗い始めました」、check「お風呂で声かけに返事がありません」）。
- `notices[*].deferredReason` は `deferred` の理由: `quiet_hours`（静かな時間帯。翌朝に送る）/ `daily_cap`（お知らせは 1 日 5 件まで。送らずに夕方の「お知らせの続き」へ）。
- `notices[*].falseAlarm` は家族が「誤報だった」を付けた通知で `true`。`notices[*].uncertain` は AI の判定が未確定のまま送った通知で `true`。
- `turns[*].classified.confidence`（0〜1）と `uncertain`（0.7 未満で `true`）。`turns[*].kind` は `normal` / `followup`（痛みの聞き直しへの返事）/ `l4`（L4 モード中の返事。判定しない）/ `utterance`（本人からの発話。`task` は `talk`、`utteranceKind` は下の 6 節の `kind`。夕方の「お返事の記録」には載りません）。
- `l4`（`day.l4` と同じ）は L4 モードのあいだ `{ "noticeId", "since", "task", "reason", "origin" }`、それ以外は `null`。立っている間は通常の声かけを止め、3 分ごとに安心文だけを流します。該当の通知を「確認した」（または「誤報だった」）にすると、その場で解除されます（台帳 `l4_cleared`）。
- `day.summary.sections` は「今日の様子」の構造（report-design v2 1 節の型）。キーは `heading` / `conclusion` / `replies`（お返事の記録）/ `concerns`（気になったこと）/ `continued`（お知らせの続き）/ `comparison`（昨日までとの比較）/ `about`（この記録について）。各行に箇条書きの「・」は付いていません。`sentences` は見出しと「・」付きの行を順に並べたもので、`citations[].sentenceIndex` はこの並びの番号です。
- `health` は無ければ `null`。

### GET /api/family/turn/:turnId（要約の引用から飛ぶ先）

```json
{ "turn": { "id": "tn_b", "task": "dress", "promptText": "…", "replyText": "着替えたよ", "classified": { "status": "done", "note": "…", "by": "llm" },
            "toolCalls": [ { "name": "record_observation", "args": {}, "result": {}, "blocked": false } ], "say": "…", "expression": "smile", "latencyMs": 820, "…": "…" } }
```

7 日を過ぎて削除されたターンは 404。

### GET /api/family/plan?date= ／ POST /api/family/plan/approve

```json
// GET の返り
{ "date": "2026-10-02", "isDayservice": true, "plan": [ { "time": "08:00", "task": "greeting" } ], "planApproved": null, "taskLabels": { "…": "…" } }
// POST で送る
{ "date": "2026-10-02" }
// POST の返り
{ "ok": true, "date": "2026-10-02", "planApproved": { "by": "family", "at": "2026-10-01T21:10:00.000Z" } }
```

その日の記録が無いと `plan: null`、承認は 404。

### GET /api/family/approvals ／ POST /api/family/approvals/:ap

```json
// GET（承認待ちだけ。?all=1 で決まったものも）
{ "approvals": [ { "id": "ap_1", "kind": "share_external", "payload": { "recipient": "care_manager", "summary": "…" },
                   "requestedAt": "…", "decidedAt": null, "decidedBy": null, "decision": null } ] }
// POST で送る（一文だけ直して承認するときは editedPayload）
{ "decision": "approved", "editedPayload": { "recipient": "care_manager", "summary": "直した文" } }
{ "decision": "rejected" }
// POST の返り
{ "ok": true, "approval": { "id": "ap_1", "decision": "approved", "decidedBy": "member:family", "…": "…" }, "executed": true }
```

- 決まったものにもう一度送ると 409。
- `executed` は「承認された外部共有を実行した」とき true。提出版では実際には送らず、台帳に記録だけ残します。

### GET /api/family/ledger?date=

```json
{ "date": "2026-10-02", "entries": [
  { "id": "lg_1", "at": "…", "actor": "agent", "kind": "prompt", "name": "prompt_sent", "args": { "task": "dress" }, "turnId": null, "noticeId": null },
  { "id": "lg_2", "at": "…", "actor": "member:family", "kind": "system", "name": "kill_switch_on", "args": { "on": true } }
] }
```

`actor` は `agent` / `ops` / `system` / `member:family`。`name` は docs/02 §6 のイベント名（ほかに `settings_change`、`line_follow`）。

### GET /api/family/settings ／ PUT /api/family/settings

```json
// GET の返り
{
  "name": "島村家",
  "person": { "callName": "お母さん", "wording": { "diaper": "おむつ", "medicine": "脳の薬", "medicinePlace": "黒い机の上" } },
  "plan": { "weekday": { "default": [ { "time": "08:00", "task": "greeting" } ], "dayservice": [ { "time": "08:00", "task": "greeting" } ] },
            "dayserviceDays": ["Tue", "Fri"], "pickupTime": "09:00" },
  "policy": { "recheckOnce": true, "maxRechecks": 2, "recheckMinutes": 15, "quietHours": { "from": "21:30", "to": "07:30" }, "sleepHours": { "from": "21:30", "to": "07:30" } },
  "contacts": { "homePhone": "03-0000-0000", "nearby": { "name": "佐藤", "phone": "090-0000-0000" } },
  "members": [ { "id": "mem_1", "name": "長男", "order": 1, "email": "", "waitMinutes": 10, "lineLinked": true } ],
  "killSwitch": false,
  "taskKeys": ["greeting", "diaper", "…"],
  "taskLabels": { "…": "…" }
}
// PUT で送る（変えたいところだけ。person と policy は部分でよい。plan と members は丸ごと）
{
  "person": { "callName": "かあさん" },
  "policy": { "quietHours": { "from": "22:00", "to": "07:00" } },
  "members": [
    { "id": "mem_1", "name": "長男", "order": 2, "email": "", "waitMinutes": 15 },
    { "id": "mem_2", "name": "次男", "order": 1, "waitMinutes": 10 },
    { "name": "新しい人", "order": 3, "email": "new@example.com", "waitMinutes": 10 }
  ]
}
// PUT の返り
{ "ok": true, "changed": ["person", "policy", "members"], "settings": { "…GET と同じ形（taskKeys・taskLabels なし）…": "" } }
```

- 時刻は `HH:MM`（例 `08:05`）、`task` は `taskKeys` のどれか、曜日は `Sun`〜`Sat`。違うと 400 で `error` にどこが違うか。
- `members` の `id` を省くと新しい人として追加、送らなかった人は外れます。`order` の重なりは 400。
- LINE の登録（`lineLinked`）はここでは変えられません（友だち追加で決まる）。停止スイッチも別の API です。
- `policy.maxRechecks` は 1 確認あたりの再確認の上限（0〜5、既定 2 = 初回と合わせて計 3 回）。あれば `recheckOnce` より優先します。
- `policy.sleepHours` は就寝時間帯（声かけをしない・無反応判定の対象外）。`quietHours`（通知を翌朝に回す）とは別です。
- `contacts` は通知文に書く連絡先。`homePhone` が空文字なら消えます、`nearby: null` で近くの人を消します。未設定なら通知文の該当の一文を省きます。住所・持病はここに置きません。

### POST /api/family/kill-switch

```json
{ "on": true }   // → { "ok": true, "killSwitch": true }
{ "on": false }  // → { "ok": true, "killSwitch": false }
```

### GET /api/family/capabilities（画面にそのまま出す固定の一覧）

```json
{
  "version": "2026-09-27",
  "title": "このエージェントができること・できないこと",
  "note": "…",
  "levels": [
    { "key": "auto", "label": "自動で行う", "description": "…", "examples": ["…"] },
    { "key": "auto_with_evidence", "label": "自動で行い、根拠を添える", "description": "…", "examples": ["…"] },
    { "key": "after_approval", "label": "ご家族の承認後に行う", "description": "…", "examples": ["…"] },
    { "key": "never", "label": "行わない", "description": "…", "examples": ["…"] }
  ],
  "stopSwitch": "…",
  "privacy": ["…"]
}
```

中身は `src/api/capabilities.ts`。

### POST /api/family/notices/:nt/ack（LINE が無い間の「確認した」「誤報だった」）

```json
{}                     // 確認した → { "ok": true, "notice": { "id": "nt_1", "state": "acked", "…": "…" }, "l4Cleared": false }
{ "falseAlarm": true } // 誤報だった → { "ok": true, "notice": { "id": "nt_1", "state": "acked", "falseAlarm": true, "…": "…" } }
```

- どちらも段階上げと L4 モードの安心文を止めます。L4 を立てた通知なら、その場で L4 を下ろし `l4Cleared: true`（LINE のボタンも同じ）。「誤報だった」はその通知の日の `signals.falseAlarmCount` に数えます（閾値は自動では変えません）。
- `falseAlarm` が真偽値でなければ 400。「確認した」の後から「誤報だった」を付けることもできます。

### GET /api/family/replay/scenarios ／ POST /api/family/replay（再生モード）

```json
// GET の返り（eval/scenarios/*.json の名前）
{ "names": ["dayservice-day", "dress-three-times", "no-answer-escalation", "weekday"] }
// POST で送る（どれか 1 つ）
{ "name": "dayservice-day" }
{ "scenario": { "date": "2026-10-02", "isDayservice": true, "turns": [ { "at": "08:00", "task": "greeting", "reply": "うん、まあまあ", "expect": { "status": "done" } } ] } }
{ "date": "2026-10-02", "isDayservice": true, "turns": [ { "at": "08:25", "task": "face", "reply": null, "expect": { "status": "no_answer" } } ] }
// POST の返り（state/replay.ts の ReplayResult）
{
  "date": "2026-10-02", "name": "dayservice-day", "passCount": 11, "failCount": 1,
  "steps": [
    { "at": "08:25", "task": "face", "prompt": "顔を洗ってさっぱりしましょう", "reply": null, "status": "no_answer",
      "say": "…", "intents": [ { "type": "recheck", "minutes": 15, "reason": "…" } ], "notices": [],
      "followUpAt": "08:40", "turnId": "tn_…", "expected": { "status": "no_answer" }, "pass": true },
    { "at": "16:00", "task": "return", "prompt": "…", "reply": "疲れた。腰がちょっと痛い", "status": "done",
      "say": "…", "intents": [], "notices": ["check: 腰が痛いとおっしゃいました。どの程度か、動けるかは分かりません。"], "expected": { "status": "done", "notify": "check" }, "pass": true }
  ],
  "summary": { "text": "…", "sentences": ["…"], "citations": [ { "sentenceIndex": 0, "turnId": "tn_…" } ] }
}
```

- `pass` は期待値（`expect`）があるステップだけ。`status` が一致し、`expect.notify` があればその段階の通知が出ていること、無ければ urgent／check の通知が出ていないこと。

- 本番とは別の記憶領域（MemoryStore）で流し、LINE・メール・Slack には何も送りません。本番の停止スイッチは写しません。世帯が無ければデモ世帯で流します。
- 判定は既定で規則（LLM なし）。`?agent=adk` で Gemini を使います。`{"withSummary": false}` か `?summary=0` で要約を省きます。

---

## 3. 内部（Scheduler／Tasks から。画面からは呼びません）

すべて POST。body の `hh`・`date` は省略可（既定の世帯と今日）。

| パス | 送る | 返る |
|---|---|---|
| `/internal/plan` | `{}` | `{ ok, hh, date, flushed, isDayservice, planApproved, prompts: [ { id, task, scheduledAt } ] }` |
| `/internal/prompt` | `{ "task": "water", "text": "お茶をどうぞ" }`（text は省略可） | `{ ok, hh, date, prompt: { id, task, scheduledAt, state } }` |
| `/internal/recheck` | `{ "hh", "date", "task": "face", "promptId": "pr_c" }` | `{ ok, hh, date, task, promptId }` |
| `/internal/escalate` | `{ "hh", "noticeId": "nt_1" }` | `{ ok, hh, notice: { id, state, steps } }` |
| `/internal/summary` | `{}` | `{ ok, hh, date, summary }` |
| `/internal/health` | `{}` | `{ ok, hh, expired, report }`（report は ops/health.ts の HealthReport） |
| `/internal/bath-return` | `{ "hh", "startedAt": "…" }`（お風呂の流れが Cloud Tasks に予約する） | `{ ok, hh, switched, reason?, mode }`。予約したときと違うお風呂・既に寝室なら `switched: false`（`reason`: `other_session` / `not_bath`） |

## 4. LINE Webhook

`POST /webhook/line`。署名が正しければ処理に失敗しても 200（LINE の再送を避ける）。署名違いは 401、`LINE_CHANNEL_SECRET` 未設定は 503。

- `follow`: 順番の若い「LINE 未登録」の家族に userId を登録（台帳 `line_follow`）。
- `postback` の `data: "ack:<noticeId>"`: その通知を確認済みに。
- `postback` の `data: "false:<noticeId>"`: 「誤報だった」。確認済みにしたうえで誤報として記録（台帳 `notice_acked` の args に `falseAlarm: true`）。
- テキスト「確認した」「OK」: 開いている通知（送ったもの）のうち、至急 → 確認のお願い → お知らせ の順、同じ段階なら一番新しいものを確認済みに。

## 5. 画面と静的ファイル

| パス | 中身 |
|---|---|
| `GET /` | `web/index.html`（入口） |
| `GET /device` | `web/device.html`（本画面）。無ければ `web/dev/device.html`（開発者向け確認ページ） |
| `GET /family` | `web/family.html`（本画面）。無ければ `web/dev/family.html` |
| `GET /dev/…` | `web/dev/…` |
| `GET /assets/…`、`GET /<ファイル名>.<拡張子>` | `web/assets/…`、`web/` 直下のファイル（本画面の JS・CSS・画像） |
| `GET /healthz` | `{ "ok": true }` |

配れる拡張子: html, js, mjs, css, png, svg, json, mp3, ico, webp, jpg。`..` を含むパスや `.` で始まるファイルは 404。

---

## 6. 起動モード（寝室／お風呂）・家族の居場所・本人からの質問（docs/02 §11.4）

### モードの形（device と family で同じ）

```json
{
  "mode": "bath",                       // "bedroom" | "bath"
  "bath": { "startedAt": "2026-10-01T10:30:00.000Z", "washAskedAt": "…", "washDoneAt": "…", "teethAskedAt": "…", "returnAt": "…", "noAnswerNotifiedAt": "…", "exitAskedAt": "…", "exitDoneAt": "…", "exitNotifiedAt": "…", "returnReason": "exit_not_yet" },
  "whereabouts": { "place": "仕事", "backAt": "18:00", "say": "はなこさんは、お仕事に行っています。18 時ごろ帰ります。" },
  "killSwitch": false
}
```

- `bath` は寝室のとき `null`。お風呂の中の項目は進んだものだけ入ります（`returnAt` は寝室へ自動で戻る予定の時刻）。
- `whereabouts` は今日登録した居場所が無ければ `null`（前の日の登録は使いません）。

### GET /api/device/mode ／ POST /api/device/mode（iPad 右上の家族用ボタン）

```json
// 送る
{ "hh": "hh_demo", "mode": "bath" }
// 返る: 上の「モードの形」
```

- `mode` が `bedroom` / `bath` 以外は 400。同じモードへの切替は何もしません（そのまま返る）。
- 切替直後の一言（「お風呂の時間ですね。ゆっくりどうぞ」／「ゆっくり休んでくださいね」）は返りに入れず、いつもどおり `next-prompt` で届きます（二重に読み上げないため）。
- 停止中（killSwitch）でも切替はできます（声かけは出ません）。台帳 `mode_changed`（actor は端末 `member:device`、家族画面 `member:family`、自動の戻り `system`）。

### GET /api/device/next-prompt（追加分）

```json
{ "prompt": { "id": "pr_…", "task": "bath", "text": "そろそろ体を洗いましょうか", "expression": "smile", "bathStep": "wash" }, "mode": "bath" }
{ "prompt": { "id": "pr_…", "task": "talk", "text": "今は 10 時 30 分です。今日は火曜日ですよ", "expression": "smile", "expectsReply": false }, "mode": "bedroom" }
```

- `mode` を足しました。お風呂モードの間は、お風呂の声かけ（`task` が `bath`、お風呂の歯磨きは `teeth`）だけが来ます。寝室の声かけは止まり、戻ったとき 30 分以上前のものは話しません。
- `bathStep`: `start`（お風呂の時間ですね）/ `wash`（体を洗いましょうか）/ `wash_recheck`（その再確認、2 分後に 1 回）/ `teeth`（歯を磨きましょう）/ `exit`（お風呂から上がりましたか？。再確認も `exit` で、`isRecheck` の有無は返りに入りません）/ `end`（ゆっくり休んでくださいね）。字幕を大きく短くする目印に。
- `expectsReply: false` は返事を求めない声かけ（お風呂の最初と最後の一言、寝室の「ときたまの声かけ」）。読み上げたら返事を待たず、`noAnswer` も送らないでください。返事が来たら `reply` に送ってかまいません（本人からの発話として扱います）。
- 寝室モードで話すものが無いとき、直近 90 分（設定 `policy.idleChatMinutes`、0 で無効）に声かけが無く、前後 45 分に計画の声かけも無ければ「ときたまの声かけ」（`task: "talk"`）が来ます。時刻と曜日／「お水を一口どうですか」を交互に。就寝時間帯・L4 中・お風呂・デイで不在の間は来ません。

お風呂の流れ（docs/02 §11.3。間隔は `policy.bath`、既定 10/15/10/2/5 分）:

| 時刻 | 声かけ | 返事 | 動き |
|---|---|---|---|
| 切替 | 「お風呂の時間ですね。ゆっくりどうぞ」 | 求めない | |
| +10 分 | 「そろそろ体を洗いましょうか」 | 「はい」等 | 家族へお知らせ（info「体を洗い始めました」）。本人には「ゆっくりどうぞ。」 |
| | | 「まだ」・返事なし | 2 分後に「体を洗えそうですか？」を 1 回 |
| | | 再確認も返事なし | 家族へ確認のお願い（check「お風呂で声かけに返事がありません。様子を見に行ってください」）。L4 にはしません |
| 洗い始め +15 分 | 「歯を磨きましょう」 | 何でも | 記録だけ |
| その +10 分 | 「お風呂から上がりましたか？」（`bathStep: "exit"`） | 「はい」「上がった」「出たよ」等 | 家族へお知らせ（info「お風呂から上がりました」）。本人には「ゆっくり休んでくださいね」（`reply` の `say`）。その場で寝室へ戻る（`end` の一言は来ません） |
| | | 「まだ」 | 5 分後にもう一度だけ同じ声かけ（`exit`）。それも「まだ」なら 10 分後に寝室へ戻り、家族へお知らせ（info「お風呂モードを終えました（まだ入っているとのことでした）」） |
| | | 返事なし | 2 分後にもう一度。それも返事なしなら家族へ確認のお願い（check「お風呂から上がったか確認できませんでした。様子を見に行ってください」）をして寝室へ戻る。L4 にはしません |
| 「上がりましたか」の予定 +30 分 | （時間切れ） | | 上の流れが終わっていなければ寝室へ戻る（`/internal/bath-return`。知らせません） |

- 洗う声かけに 2 回返事が無かったときは歯磨きを飛ばし、確認のお願いから 10 分後に「お風呂から上がりましたか？」が来ます。
- 家族が途中で寝室へ戻したとき（`POST /api/device/mode`・`PUT /api/family/mode`）は、家族へのお知らせは送りません（台帳 `mode_changed` の `reason: "manual"` には残ります）。
- `/internal/bath-return` の body は `{ hh, startedAt, reason }`（`reason` は `timeout` / `exit_not_yet` / `exit_unclear`。記録用で、渡されなくても世帯の `bath.returnReason` で同じに動きます）。戻りの時刻（`bath.returnAt`）より 1 分以上早く届いた予約は何もしません（`reason: "not_due"`）。
- 端末が `noAnswer` を送らないまま 3 分たったお風呂の声かけは、`/internal/health`（5 分ごと）が返事なしとして締めます。
- お風呂の間も「転んだ」「助けて」などは寝室と同じく至急（L4）です。

### POST /api/device/utterance（声かけへの返事ではない本人の発話）

```json
// 送る
{ "hh": "hh_demo", "text": "はなこはどこに行ったの", "source": "ipad" }
// 返る
{ "turnId": "tn_…", "say": "はなこさんは、お仕事に行っています。18 時ごろ帰ります。", "expression": "smile", "kind": "whereabouts" }
```

- `text` が空なら 400。`say` が空文字のときは何も読み上げないでください（テレビの音など）。
- `kind`:

| kind | いつ | say |
|---|---|---|
| `notice` | 「転んだ」「助けて」など（至急・L4 モードへ）、「腰が痛い」（確認のお願い＋3 時間後の聞き直し）、「○○に伝えて／電話して／呼んで」（自分では連絡せず家族へ確認のお願い） | 定型文（「大丈夫ですか。ご家族に連絡します。…」「それはつらいですね。…」「ご家族に伝えておきますね。」） |
| `medicine` | 「何の薬？」「薬はどこ？」 | 「脳の薬ですよ。」「黒い机の上にありますよ。」（家族が決めた言葉） |
| `whereabouts` | 「どこ」「行った」「いない」「帰って」「出かけ」、家族の名前、「○○さんは」 | 居場所の答え（何度聞かれても同じ文。「さっきも言った」とは言いません） |
| `ignored` | テレビ・雑音の印、本人に向けた言葉でない（Gemini の判断）、停止中（say は「少し休みますね。」） | 空文字 |
| `chat` | それ以外 | Gemini の 1 文。`AGENT_MODE=rules`・失敗・確信度 0.7 未満は「はい、聞いていますよ。」 |

- 記録は `turns`（`kind: "utterance"`, `task: "talk"`, 本文は 7 日で削除）。夕方の「お返事の記録」には載りません。同じ種類の質問が 30 分以内に続くと「同じ質問」の回数に数えます。台帳 `utterance_received`（本文は 20 文字まで）。

### GET /api/family/mode ／ PUT /api/family/mode（家族画面からの遠隔切替）

```json
// PUT で送る
{ "mode": "bedroom" }
// 返る: 上の「モードの形」
```

### GET /api/family/whereabouts ／ PUT /api/family/whereabouts ／ DELETE /api/family/whereabouts（家族の居場所）

```json
// PUT で送る（place は 1〜30 文字、backAt は "HH:MM" か null、note は任意）
{ "place": "仕事", "backAt": "18:00", "note": "残業かも" }
// 消す（DELETE と同じ）
{ "place": null, "backAt": null }
// 返る（GET も同じ）
{ "whereabouts": { "place": "仕事", "backAt": "18:00", "note": "残業かも", "updatedAt": "…" }, "say": "はなこさんは、お仕事に行っています。18 時ごろ帰ります。" }
```

- `say` は本人に読み上げる文（画面の確認用）。名前は通知の順番が一番の家族。行き先の言い方: 仕事→「お仕事に行っています」、買い物→「買い物に行っています」、病院→「病院に行っています」、外出→「出かけています」、それ以外→「{place}に行っています」。
- 帰る時刻を過ぎたら「はなこさんは、もうすぐ帰ってきます。」、未登録・前の日の登録なら「はなこさんは出かけています。もうすぐ帰ってきますよ。」
- 形が違えば 400。台帳 `whereabouts_updated`（actor `member:family`）。

### GET /api/family/today（追加分）

```json
{ "…": "…", "mode": "bath", "bath": { "startedAt": "…" }, "whereabouts": { "place": "仕事", "backAt": "18:00", "say": "…" } }
```

### GET /api/family/demo-device?hh=hh_demo（審査員の入口用）

```json
{ "hh": "hh_demo", "token": "…" }
```

- 家族の認証（合言葉）が要ります。`hh_demo` のときだけ端末トークン（`DEVICE_TOKENS` の hh_demo）を返し、他の世帯は 404。入口ページはこれを localStorage に入れて `/device` を開きます（URL にトークンを載せない）。

### 再生モードの台本（追加分）

- ステップに `"mode": "bath"` を書くと、そのステップの前に家族の操作としてモードを切り替えます。`task` を省くと切り替えだけのステップになります。`expect.mode` でステップ後のモードも照合します。
- 返りの `steps[]` に `kind`（`turn` / `mode`）、`mode`（ステップ後のモード）、`modeBy`（`family` / `system`。お風呂の自動の戻りは `system` のステップとして入ります）を足しました。台本の例は `eval/scenarios/bath.json`。

### 審査員向けの 14 日分の履歴

`scripts/seed-demo-history.ts` が `hh_demo` に架空の 14 日分（今日の前日まで）を入れます（実行方法はファイルの先頭）。返事の本文は 7 日で消えるので、デモの前に流し直してください。
