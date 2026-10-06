// 部品の組み立て。テストでは createApp({ store: new MemoryStore(), clock, ... }) で差し替える。

import { config } from './config.js';
import { systemClock, type Clock } from './time.js';
import type { AppContext } from './services.js';
import type { Store } from './store/types.js';
import { createStore } from './store/index.js';
import { createTurnRunner } from './agent/index.js';
import { createNotifier, createFamilyNotify } from './notify/index.js';
import { createTaskScheduler } from './tasks/index.js';
import { createTts } from './tts.js';
import { logEvent } from './log.js';

export interface AppOverrides {
  store?: Store;
  clock?: Clock;
  turnRunner?: AppContext['turnRunner'];
  notifier?: AppContext['notifier'];
  familyNotify?: AppContext['familyNotify'];
  tasks?: AppContext['tasks'];
  tts?: AppContext['tts'];
}

export async function createApp(overrides: AppOverrides = {}): Promise<AppContext> {
  const store = overrides.store ?? createStore();
  const clock = overrides.clock ?? systemClock;
  const notifier = overrides.notifier ?? createNotifier();
  const tasks = overrides.tasks ?? createTaskScheduler();
  const familyNotify = overrides.familyNotify ?? createFamilyNotify({ store, notifier, tasks, clock });
  const turnRunner = overrides.turnRunner ?? createTurnRunner();
  const tts = overrides.tts ?? createTts();

  logEvent('app_started', {
    firestoreDatabase: config.firestoreDatabase,
    tasksMode: config.tasksMode,
    ttsMode: config.ttsMode,
    agentMode: config.agentMode,
    lineConfigured: Boolean(config.line.channelAccessToken),
    slackConfigured: Boolean(config.slackWebhookUrl),
  });

  return { store, clock, turnRunner, notifier, familyNotify, tasks, tts };
}
