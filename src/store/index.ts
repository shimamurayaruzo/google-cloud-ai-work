// Store の入口。STORE=memory ならメモリ、それ以外は config.firestoreDatabase の Firestore。
// STORE=memory（手元・デモ動画の録画）のときは、空のままだと画面が動かないので
// 既定の世帯（defaultHousehold）と審査員向けのデモ世帯（demoHousehold）を最初から入れておく。
import type { Store } from './types.js';
import { MemoryStore } from './memory.js';
import { FirestoreStore } from './firestore.js';
import { defaultHousehold, demoHousehold } from '../seed/household.js';

export function createStore(): Store {
  if (process.env.STORE === 'memory') return seededMemoryStore();
  return new FirestoreStore();
}

/** 既定の世帯とデモ世帯を入れた MemoryStore（MemoryStore の putHousehold は同期で入るので await は要らない） */
export function seededMemoryStore(): MemoryStore {
  const store = new MemoryStore();
  for (const h of [defaultHousehold(), demoHousehold()]) void store.putHousehold(h);
  return store;
}

export { MemoryStore, FirestoreStore };
export type { Store };
