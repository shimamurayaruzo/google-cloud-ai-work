// Cloud Text-to-Speech の日本語音声を聞き比べるための mp3 を作る。
//
// 実行（リポジトリの直下で。ADC は gcloud auth application-default login 済みが前提）:
//   NODE_EXTRA_CA_CERTS="$LOCALAPPDATA/Google/Cloud SDK/ca-bundle.pem" npx tsx --env-file-if-exists=.env scripts/try-tts.ts [出力先フォルダ] [声の名前...]
// 声を省くと下の候補を全部作る。出力は <フォルダ>/<声の名前>.mp3。
//
// 候補の選び方: 母に聞き取りやすい落ち着いた女性の声を中心に、比較用に男性 1 つと旧世代（Neural2）を入れている。
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_VOICES = [
  'ja-JP-Chirp3-HD-Aoede',
  'ja-JP-Chirp3-HD-Kore',
  'ja-JP-Chirp3-HD-Leda',
  'ja-JP-Chirp3-HD-Sulafat',
  'ja-JP-Chirp3-HD-Charon',
  'ja-JP-Neural2-B',
];

// 声かけ計画（docs/03）から、毎日聞く文を 3 つ。
const TEXT = [
  'おはようございます。よく眠れましたか？',
  '今日はデイサービスの日です。9時にお迎えが来ます。お着替えは済みましたか？',
  'ご飯のあとのお薬を飲みましょう。黒い机の上に2錠ありますよ。',
].join(' ');

const [outDir = 'tmp/tts', ...voices] = process.argv.slice(2);
const targets = voices.length ? voices : DEFAULT_VOICES;
mkdirSync(outDir, { recursive: true });

const client = new TextToSpeechClient();
for (const name of targets) {
  const t0 = Date.now();
  try {
    const [res] = await client.synthesizeSpeech({
      input: { text: TEXT },
      voice: { languageCode: 'ja-JP', name },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 0.95 },
    });
    const path = join(outDir, `${name}.mp3`);
    writeFileSync(path, res.audioContent as Uint8Array);
    console.log(`${name.padEnd(30)} ${String(Date.now() - t0).padStart(5)} ms  ${(res.audioContent as Uint8Array).length} bytes  -> ${path}`);
  } catch (e) {
    console.log(`${name.padEnd(30)} 失敗: ${(e as Error).message}`);
  }
}
