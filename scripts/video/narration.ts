// デモ動画のナレーションを Cloud Text-to-Speech で作る（scripts/video/scenes.json の narration）。
//
// 実行（リポジトリの直下で。ADC は gcloud auth application-default login 済みが前提）:
//   npm run video:narration
//   声を変えるとき: TTS_VOICE=ja-JP-Chirp3-HD-Aoede npm run video:narration
// NODE_EXTRA_CA_CERTS が未設定で %LOCALAPPDATA%/Google/Cloud SDK/ca-bundle.pem があれば、それを付けて自分を起動し直す。
//
// 出力:
//   tmp/video/narration/<カット id>.mp3      … 文ごとに合成し、文の間に 0.6 秒の間を入れてつないだもの
//   tmp/video/narration/index.json           … 各 mp3 の長さ（ffprobe）とカットの尺
//   tmp/video/narration/parts/<hash>.mp3     … 文ごとのキャッシュ（声・速さ・文が同じなら合成し直さない）
// 長さ（＋前後の間）がカットの尺を超えたものは最後に一覧で警告する（台本を縮める判断材料。assemble.ts はその分カットを延ばす）。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const OUT = join(ROOT, 'tmp/video/narration');
const PARTS = join(OUT, 'parts');
const VOICE = process.env.TTS_VOICE || 'ja-JP-Chirp3-HD-Leda';
const RATE = 0.95;
const GAP_SEC = 0.6;
const SAMPLE_RATE = 24000;

// ---- 社内プロキシの証明書（Node は起動時にしか読まないので、無ければ付けて起動し直す） ----
if (!process.env.NODE_EXTRA_CA_CERTS && process.env.LOCALAPPDATA) {
  const bundle = join(process.env.LOCALAPPDATA, 'Google/Cloud SDK/ca-bundle.pem');
  if (existsSync(bundle)) {
    const r = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      stdio: 'inherit', env: { ...process.env, NODE_EXTRA_CA_CERTS: bundle },
    });
    process.exit(r.status ?? 1);
  }
}

interface Scene { id: string; start: number; end: number; narration?: string }
interface Output { narrationLead: number; narrationTail: number }
const plan = JSON.parse(readFileSync(join(ROOT, 'scripts/video/scenes.json'), 'utf8')) as { scenes: Scene[]; output: Output };

/** 「。」「？」「！」で文に分ける（括弧の中の句点では切らない） */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  for (const ch of text) {
    cur += ch;
    if (ch === '「' || ch === '（') depth++;
    else if ((ch === '」' || ch === '）') && depth > 0) depth--;
    else if (depth === 0 && /[。？！]/.test(ch)) { out.push(cur.trim()); cur = ''; }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

function ffprobeDuration(file: string): number {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffprobe に失敗: ${file}\n${r.stderr}`);
  return Number(r.stdout.trim());
}

function ffmpeg(args: string[]): void {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg に失敗: ffmpeg ${args.join(' ')}\n${r.stderr}`);
}

mkdirSync(PARTS, { recursive: true });

const { TextToSpeechClient } = await import('@google-cloud/text-to-speech');
const client = new TextToSpeechClient();
let rateSupported = true;

async function synthesize(text: string): Promise<string> {
  const hash = createHash('sha1').update(`${VOICE}|${RATE}|${text}`).digest('hex').slice(0, 16);
  const file = join(PARTS, `${hash}.mp3`);
  if (existsSync(file)) return file;
  const request = {
    input: { text },
    voice: { languageCode: 'ja-JP', name: VOICE },
    audioConfig: { audioEncoding: 'MP3' as const, sampleRateHertz: SAMPLE_RATE, ...(rateSupported ? { speakingRate: RATE } : {}) },
  };
  try {
    const [res] = await client.synthesizeSpeech(request);
    writeFileSync(file, res.audioContent as Uint8Array);
  } catch (e) {
    const msg = (e as Error).message;
    if (rateSupported && /speaking.?rate|speakingRate|not supported/i.test(msg)) {
      console.warn(`  この声は速さの指定に対応していません。速さ 1.0 で作ります（${msg.slice(0, 120)}）`);
      rateSupported = false;
      return synthesize(text);
    }
    throw e;
  }
  return file;
}

interface IndexEntry {
  id: string; file: string; duration: number; slot: number; need: number; over: number; sentences: number;
}
const entries: IndexEntry[] = [];
console.log(`声: ${VOICE}　速さ: ${RATE}　文の間: ${GAP_SEC} 秒`);

for (const s of plan.scenes) {
  if (!s.narration) continue;
  const sentences = splitSentences(s.narration);
  const parts: string[] = [];
  for (const t of sentences) parts.push(await synthesize(t));

  // 文の間に無音を挟んでつなぐ（24 kHz・モノラルにそろえる）
  const out = join(OUT, `${s.id}.mp3`);
  const inputs = parts.flatMap(p => ['-i', p]);
  const chains: string[] = [];
  const labels: string[] = [];
  parts.forEach((_, i) => {
    chains.push(`[${i}:a]aresample=${SAMPLE_RATE},aformat=channel_layouts=mono[s${i}]`);
    labels.push(`[s${i}]`);
    if (i < parts.length - 1) {
      chains.push(`anullsrc=r=${SAMPLE_RATE}:cl=mono,atrim=duration=${GAP_SEC}[g${i}]`);
      labels.push(`[g${i}]`);
    }
  });
  const graph = `${chains.join(';')};${labels.join('')}concat=n=${labels.length}:v=0:a=1[out]`;
  ffmpeg([...inputs, '-filter_complex', graph, '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '128k', out]);

  const duration = ffprobeDuration(out);
  const slot = s.end - s.start;
  const need = plan.output.narrationLead + duration + plan.output.narrationTail;
  const over = Math.max(0, Math.round((need - slot) * 100) / 100);
  entries.push({ id: s.id, file: `tmp/video/narration/${s.id}.mp3`, duration: Math.round(duration * 100) / 100, slot, need: Math.round(need * 100) / 100, over, sentences: sentences.length });
  console.log(`${s.id}  ${duration.toFixed(2).padStart(6)} 秒 / 尺 ${String(slot).padStart(3)} 秒  ${over > 0 ? `← ${over.toFixed(2)} 秒はみ出す` : ''}`);
}

writeFileSync(join(OUT, 'index.json'), JSON.stringify({ voice: VOICE, speakingRate: rateSupported ? RATE : 1.0, gapSec: GAP_SEC, createdAt: new Date().toISOString(), scenes: entries }, null, 2));

const overs = entries.filter(e => e.over > 0);
if (overs.length) {
  console.warn('\n警告: ナレーションがカットの尺を超えています（前後の間を含む）。台本を縮めるか尺を延ばしてください。');
  for (const e of overs) console.warn(`  ${e.id}: ナレーション ${e.duration} 秒 ＋ 間 → ${e.need} 秒 / 尺 ${e.slot} 秒（${e.over} 秒超過）`);
} else {
  console.log('\nすべてのナレーションがカットの尺に収まっています。');
}
console.log(`→ ${join('tmp/video/narration', 'index.json')}`);
