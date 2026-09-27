import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTts, type TtsClientLike } from '../src/tts.js';

test('device モードは {} を返す（端末で読み上げ）', async () => {
  const tts = createTts({ mode: 'device' });
  assert.deepEqual(await tts.synthesize('おはようございます'), {});
});

function client(behaviors: Array<'hang' | 'ok' | 'error'>): TtsClientLike & { calls: number; lastRequest?: Record<string, unknown> } {
  const c = {
    calls: 0,
    lastRequest: undefined as Record<string, unknown> | undefined,
    async synthesizeSpeech(req: Record<string, unknown>) {
      const b = behaviors[c.calls] ?? 'ok';
      c.calls += 1;
      c.lastRequest = req;
      if (b === 'hang') return new Promise<never>(() => {});
      if (b === 'error') throw new Error('PERMISSION_DENIED');
      return [{ audioContent: new Uint8Array([1, 2, 3]) }] as [{ audioContent: Uint8Array }];
    },
  };
  return c;
}

test('cloud: 成功なら data URL（MP3）', async () => {
  const c = client(['ok']);
  const r = await createTts({ mode: 'cloud', client: c, timeoutMs: 50, voice: 'ja-JP-Neural2-B' }).synthesize('こんにちは');
  assert.equal(r.url, 'data:audio/mp3;base64,AQID');
  assert.equal(r.fallback, undefined);
  assert.deepEqual(c.lastRequest, {
    input: { text: 'こんにちは' },
    voice: { languageCode: 'ja-JP', name: 'ja-JP-Neural2-B' },
    audioConfig: { audioEncoding: 'MP3', speakingRate: 0.95 },
  });
});

test('cloud: タイムアウト → 1 回再試行 → 成功', async () => {
  const c = client(['hang', 'ok']);
  const incidents: string[] = [];
  const r = await createTts({ mode: 'cloud', client: c, timeoutMs: 30, onIncident: k => incidents.push(k) }).synthesize('こんにちは');
  assert.equal(c.calls, 2);
  assert.ok(r.url);
  assert.deepEqual(incidents, []);
});

test('cloud: タイムアウトが 2 回続けば device に代替し tts_timeout（onIncident も 1 回）', async () => {
  const c = client(['hang', 'hang']);
  const incidents: string[] = [];
  const r = await createTts({ mode: 'cloud', client: c, timeoutMs: 30, onIncident: k => incidents.push(k) }).synthesize('こんにちは');
  assert.equal(c.calls, 2);
  assert.deepEqual(r, { fallback: 'device', incident: 'tts_timeout' });
  assert.deepEqual(incidents, ['tts_timeout']);
});

test('cloud: その他の例外は再試行せず tts_error', async () => {
  const c = client(['error', 'ok']);
  const r = await createTts({ mode: 'cloud', client: c, timeoutMs: 30 }).synthesize('こんにちは');
  assert.equal(c.calls, 1);
  assert.deepEqual(r, { fallback: 'device', incident: 'tts_error' });
});
