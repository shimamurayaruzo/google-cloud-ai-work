// 音声合成（docs/02 §10 未決: 端末の読み上げか Cloud Text-to-Speech か）。
//   device … 何もしない（端末の Web Speech で読み上げる）
//   cloud  … Cloud TTS。ttsTimeoutMs で打ち切り、タイムアウトは 1 回だけ再試行、だめなら端末に代替
// health への記録はここではしない。結果の incident を呼び出し側（state/）が recordIncident する。
// 呼び出し側が記録しない構成のために onIncident フックも用意する（両方で記録すると二重になるので片方だけ使う）。

import { config } from './config.js';
import { logError, logWarn } from './log.js';
import type { Tts, TtsResult } from './services.js';

export type TtsIncident = NonNullable<TtsResult['incident']>;

/** TextToSpeechClient の必要な部分だけ（テストで差し替えられるように） */
export interface TtsClientLike {
  synthesizeSpeech(request: Record<string, unknown>): Promise<[{ audioContent?: Uint8Array | string | null }, ...unknown[]]>;
}

export interface TtsOptions {
  mode?: 'device' | 'cloud';
  client?: TtsClientLike;
  timeoutMs?: number;
  voice?: string;
  /** 代替に切り替えたときに呼ぶ（kind は結果の incident と同じ） */
  onIncident?: (kind: TtsIncident) => void;
}

class TtsTimeoutError extends Error {
  constructor(ms: number) { super(`TTS が ${ms}ms で応答しませんでした`); this.name = 'TtsTimeoutError'; }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TtsTimeoutError(ms)), ms);
    timer.unref();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function toBase64(audio: Uint8Array | string): string {
  // gRPC 版は Buffer（Uint8Array）、REST 版は base64 文字列で返る
  return typeof audio === 'string' ? audio : Buffer.from(audio).toString('base64');
}

export function createTts(opts: TtsOptions = {}): Tts {
  const mode = opts.mode ?? config.ttsMode;
  if (mode !== 'cloud') {
    return { async synthesize() { return {}; } };
  }

  const timeoutMs = opts.timeoutMs ?? config.ttsTimeoutMs;
  const voice = opts.voice ?? config.ttsVoice;
  let client: TtsClientLike | undefined = opts.client;

  async function getClient(): Promise<TtsClientLike> {
    if (!client) {
      const mod = await import('@google-cloud/text-to-speech');
      client = new mod.TextToSpeechClient() as unknown as TtsClientLike;
    }
    return client;
  }

  function fail(kind: TtsIncident): TtsResult {
    try { opts.onIncident?.(kind); } catch (e) { logError('tts_on_incident_error', e); }
    return { fallback: 'device', incident: kind };
  }

  async function once(text: string): Promise<string> {
    const c = await getClient();
    const [res] = await withTimeout(c.synthesizeSpeech({
      input: { text },
      voice: { languageCode: 'ja-JP', name: voice },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 0.95 },
    }), timeoutMs);
    if (!res?.audioContent || res.audioContent.length === 0) throw new Error('音声が空でした');
    return `data:audio/mp3;base64,${toBase64(res.audioContent)}`;
  }

  return {
    async synthesize(text: string): Promise<TtsResult> {
      if (!text.trim()) return {};
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          return { url: await once(text) };
        } catch (e) {
          if (e instanceof TtsTimeoutError) {
            logWarn('tts_timeout', { attempt, timeoutMs, chars: text.length });
            if (attempt < 2) continue;
            return fail('tts_timeout');
          }
          logError('tts_error', e, { attempt, chars: text.length });
          return fail('tts_error');
        }
      }
      return fail('tts_timeout');
    },
  };
}
