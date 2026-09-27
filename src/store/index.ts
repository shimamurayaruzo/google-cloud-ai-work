// Store の入口。STORE=memory ならメモリ、それ以外は config.firestoreDatabase の Firestore。
import type { Store } from './types.js';
import { MemoryStore } from './memory.js';
import { FirestoreStore } from './firestore.js';

export function createStore(): Store {
  if (process.env.STORE === 'memory') return new MemoryStore();
  return new FirestoreStore();
}

export { MemoryStore, FirestoreStore };
export type { Store };
