// 開発用 Firestore に世帯の初期値（docs/03）を入れる。
//
// 実行（リポジトリの直下で）:
//   gcloud auth application-default login   … 済んでいれば不要
//   NODE_EXTRA_CA_CERTS="$LOCALAPPDATA/Google/Cloud SDK/ca-bundle.pem" FIRESTORE_DATABASE=develop npx tsx scripts/seed-dev.ts
//   （npm run seed:dev でも同じ。FIRESTORE_DATABASE を省くと develop）
//
// 本番（default）への書き込みは --force-default を付けたときだけ。
// 入れるもの: defaultHousehold（HOUSEHOLD_ID、既定 hh_main）と demoHousehold（hh_demo、審査員向け）。
// 既にある世帯は丸ごと上書きする（家族画面で変えた設定も戻る）ので注意。

import { FirestoreStore } from '../src/store/firestore.js';
import { defaultHousehold, demoHousehold } from '../src/seed/household.js';
import { config } from '../src/config.js';

const database = process.env.FIRESTORE_DATABASE ?? 'develop';
const forceDefault = process.argv.includes('--force-default');

if (database === 'default' && !forceDefault) {
  console.error('本番（default）データベースには書きません。本当に書くときは --force-default を付けてください。');
  process.exit(1);
}

const store = new FirestoreStore({ projectId: config.projectId, databaseId: database });
const households = [defaultHousehold(), demoHousehold()];
for (const h of households) {
  await store.putHousehold({ ...h, createdAt: new Date() });
  console.log(`書き込み: ${config.projectId}/${database} households/${h.id}（${h.name}）`);
}
console.log('完了');
