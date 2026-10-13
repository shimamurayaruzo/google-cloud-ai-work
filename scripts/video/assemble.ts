// デモ動画を組み立てる（ffmpeg）。scenes.json の尺どおりに、録画（webm）・静止画（png）・ナレーション（mp3）をつなぐ。
//
// 実行（リポジトリの直下で）: npm run video:assemble
// 入力: tmp/video/raw/<区間 id>.{webm,png,json}（record.ts）、tmp/video/narration/<カット id>.mp3 と index.json（narration.ts）
//       実写: tmp/video/live/<区間 id>.mp4（無ければ区間 id の代わりにカット id でも探す）を置くと、差し替え用の板の代わりに使う
// 出力: tmp/video/demo-draft.mp4（1920×1080・30fps・H.264・AAC。音は -14 LUFS ほどに正規化）
//       tmp/video/check/<カット id>.png（カットの頭）・-mid.png・-end.png（確認用の静止画）
//       tmp/video/assemble-report.json（カットごとの予定と実際の長さ、ナレーションのはみ出し、速めた区間）
//
// 決まり:
//  - 区間の長さは scenes.json の duration（区間が無いカットは end - start）。録画は start の印から使い、
//    中身（start〜end の印）が長ければ最大 maxSpeedup 倍まで速める。短ければ録画の続き（余白）を使い、それも尽きたら最後のコマで止める
//  - ナレーションはカットの頭から narrationLead 秒後に重ねる。カットに収まらないときは最後の区間を延ばしてカットごと長くする（報告に出す）
//  - title / diagram は全画面。それ以外は上に見出しの帯を置き、画面を帯の下の枠に収める

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const RAW = join(ROOT, 'tmp/video/raw');
const WORK = join(ROOT, 'tmp/video/work');
const CHECK = join(ROOT, 'tmp/video/check');
const LIVE = join(ROOT, 'tmp/video/live');
const OUT = join(ROOT, 'tmp/video/demo-draft.mp4');
const FONT = ['C:/Windows/Fonts/YuGothB.ttc', 'C:/Windows/Fonts/YuGothM.ttc'].find(f => existsSync(f)) ?? 'C:/Windows/Fonts/YuGothM.ttc';

interface Segment { id: string; kind: string; duration: number; card?: string }
interface Scene { id: string; start: number; end: number; kind: string; heading: string; narration?: string; segments?: Segment[]; card?: string }
interface OutputCfg {
  width: number; height: number; fps: number; background: string; headingBand: number;
  narrationLead: number; narrationTail: number; maxSpeedup: number;
}
const plan = JSON.parse(readFileSync(join(ROOT, 'scripts/video/scenes.json'), 'utf8')) as { scenes: Scene[]; output: OutputCfg };
const O = plan.output;
const MARGIN_X = 48;
const MARGIN_BOTTOM = 36;
const BOX_W = O.width - MARGIN_X * 2;
const BOX_H = O.height - O.headingBand - MARGIN_BOTTOM;
const FULL_KINDS = new Set(['title', 'diagram']);

function segmentsOf(s: Scene): Segment[] {
  return s.segments ?? [{ id: s.id, kind: s.kind, duration: s.end - s.start, card: s.card }];
}

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} に失敗:\n${cmd} ${args.join(' ')}\n${(r.stderr || '').slice(-3000)}`);
  return `${r.stdout}${r.stderr}`;
}
const ffmpeg = (args: string[]) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
function duration(file: string): number {
  return Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).trim());
}
const r2 = (n: number) => Math.round(n * 100) / 100;
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
/** ffmpeg のフィルタの中で使うパス（: をエスケープ） */
const fpath = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:');

// ---------------------------------------------------------------------------
// 区間 1 つ → 映像だけの mp4（1920×1080・30fps・ちょうど d 秒）
// ---------------------------------------------------------------------------
interface SegInfo { start?: number; end?: number; viewport?: { width: number; height: number }; video?: string; image?: string }
interface SegResult { id: string; kind: string; source: string; planned: number; used: number; speed: number; truncated: number; frozen: number }

function layout(kind: string, w: number, h: number): string {
  if (FULL_KINDS.has(kind)) {
    return `scale=${O.width}:${O.height}:force_original_aspect_ratio=decrease,pad=${O.width}:${O.height}:(ow-iw)/2:(oh-ih)/2:color=${O.background},setsar=1`;
  }
  const f = Math.min(BOX_W / w, BOX_H / h);
  const sw = even(w * f);
  const sh = even(h * f);
  const x = Math.round((O.width - sw) / 2);
  const y = O.headingBand + Math.round((BOX_H - sh) / 2);
  return [
    `scale=${sw}:${sh}:flags=lanczos`,
    `pad=${O.width}:${O.height}:${x}:${y}:color=${O.background}`,
    `drawbox=x=${x - 1}:y=${y - 1}:w=${sw + 2}:h=${sh + 2}:color=0xd9dfda:t=1`,
    'setsar=1',
  ].join(',');
}

function buildSegment(scene: Scene, seg: Segment, d: number): { file: string; result: SegResult } {
  const out = join(WORK, `${seg.id}.mp4`);
  const frames = Math.round(d * O.fps);
  const common = ['-r', String(O.fps), '-frames:v', String(frames), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p'];
  const live = [join(LIVE, `${seg.id}.mp4`), join(LIVE, `${scene.id}.mp4`)].find(p => existsSync(p));
  const info: SegInfo = existsSync(join(RAW, `${seg.id}.json`)) ? JSON.parse(readFileSync(join(RAW, `${seg.id}.json`), 'utf8')) : {};
  const base: SegResult = { id: seg.id, kind: seg.kind, source: '', planned: seg.duration, used: d, speed: 1, truncated: 0, frozen: 0 };

  if (seg.kind === 'live' && live) {
    // 実写の差し替え（頭から d 秒。足りなければ最後のコマで止める）
    const avail = duration(live);
    const probe = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', live]).trim().split(',').map(Number);
    const vf = `setpts=PTS-STARTPTS,fps=${O.fps},tpad=stop_mode=clone:stop_duration=${d},trim=duration=${d},${layout('live', probe[0], probe[1])},format=yuv420p`;
    ffmpeg(['-i', live, '-vf', vf, ...common, out]);
    return { file: out, result: { ...base, source: live.replace(ROOT, '').replace(/\\/g, '/'), frozen: r2(Math.max(0, d - avail)) } };
  }
  if (info.image || existsSync(join(RAW, `${seg.id}.png`))) {
    const img = join(RAW, info.image ?? `${seg.id}.png`);
    const vp = info.viewport ?? { width: O.width, height: O.height };
    const vf = `${layout(seg.kind, vp.width, vp.height)},format=yuv420p`;
    ffmpeg(['-loop', '1', '-framerate', String(O.fps), '-t', String(d), '-i', img, '-vf', vf, ...common, out]);
    return { file: out, result: { ...base, source: `raw/${seg.id}.png` } };
  }
  if (info.video) {
    const src = join(RAW, info.video);
    const start = info.start ?? 0;
    const content = (info.end ?? duration(src)) - start;
    const avail = duration(src) - start;
    let speed = 1;
    let truncated = 0;
    if (content > d) {
      speed = Math.min(content / d, O.maxSpeedup);
      truncated = Math.max(0, content / speed - d);
    }
    const frozen = Math.max(0, d - avail / speed);
    const vp = info.viewport!;
    const vf = [
      `setpts=(PTS-STARTPTS)/${speed.toFixed(4)}`,
      `fps=${O.fps}`,
      `tpad=stop_mode=clone:stop_duration=${Math.ceil(d + 1)}`,
      `trim=duration=${d}`,
      layout(seg.kind, vp.width, vp.height),
      'format=yuv420p',
    ].join(',');
    ffmpeg(['-ss', start.toFixed(3), '-i', src, '-vf', vf, ...common, out]);
    return { file: out, result: { ...base, source: `raw/${info.video}`, speed: r2(speed), truncated: r2(truncated), frozen: r2(frozen) } };
  }
  throw new Error(`区間 ${seg.id} の素材がありません（npm run video:record を先に）`);
}

// ---------------------------------------------------------------------------
// カット 1 つ → 見出し・ナレーション入りの mp4
// ---------------------------------------------------------------------------
interface NarrIndex { scenes: Array<{ id: string; duration: number }> }
const narrIndex: NarrIndex = existsSync(join(ROOT, 'tmp/video/narration/index.json'))
  ? JSON.parse(readFileSync(join(ROOT, 'tmp/video/narration/index.json'), 'utf8'))
  : { scenes: [] };

interface CutResult {
  id: string; heading: string; planned: number; actual: number; narration: number | null; over: number; startAt: number; segments: SegResult[];
}

function buildCut(scene: Scene, index: number, total: number, startAt: number): CutResult {
  const planned = scene.end - scene.start;
  const mp3 = join(ROOT, 'tmp/video/narration', `${scene.id}.mp3`);
  const narr = existsSync(mp3) ? duration(mp3) : null;
  if (scene.narration && narr === null) console.warn(`[assemble] ${scene.id} のナレーションがありません（npm run video:narration）。無音で組みます`);
  const need = narr === null ? 0 : O.narrationLead + narr + O.narrationTail;
  const over = Math.max(0, need - planned);
  const segs = segmentsOf(scene).map(s => ({ ...s }));
  const sum = segs.reduce((a, s) => a + s.duration, 0);
  if (Math.abs(sum - planned) > 0.01) console.warn(`[assemble] ${scene.id}: 区間の長さの合計 ${sum} 秒が尺 ${planned} 秒と違います`);
  if (over > 0) segs[segs.length - 1].duration = r2(segs[segs.length - 1].duration + over);
  const actual = r2(segs.reduce((a, s) => a + s.duration, 0));

  const built = segs.map(s => buildSegment(scene, s, s.duration));

  // 見出しの帯・フェード・ナレーション
  const inputs = built.flatMap(b => ['-i', b.file]);
  const vLabels = built.map((_, i) => `[${i}:v]`).join('');
  const vf: string[] = [];
  if (scene.heading && !FULL_KINDS.has(scene.kind)) {
    const txt = join(WORK, `${scene.id}.heading.txt`);
    writeFileSync(txt, scene.heading, 'utf8');
    vf.push(`drawbox=x=${MARGIN_X}:y=26:w=8:h=46:color=0x1f6f5b:t=fill`);
    vf.push(`drawtext=fontfile='${fpath(FONT)}':textfile='${fpath(txt)}':x=${MARGIN_X + 24}:y=27:fontsize=40:fontcolor=0x1f2a24`);
  }
  if (index === 0) vf.push('fade=t=in:st=0:d=0.6');
  if (index === total - 1) vf.push(`fade=t=out:st=${r2(actual - 0.9)}:d=0.9`);
  const vChain = `${vLabels}concat=n=${built.length}:v=1:a=0${vf.length ? `,${vf.join(',')}` : ''}[v]`;
  const aIn = built.length;
  const aChain = narr === null
    ? `anullsrc=r=48000:cl=stereo,atrim=duration=${actual}[a]`
    : `[${aIn}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(O.narrationLead * 1000)}:all=1,apad,atrim=duration=${actual}[a]`;
  const out = join(WORK, `cut-${scene.id}.mp4`);
  ffmpeg([
    ...inputs, ...(narr === null ? [] : ['-i', mp3]),
    '-filter_complex', `${vChain};${aChain}`,
    '-map', '[v]', '-map', '[a]',
    '-r', String(O.fps), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-t', String(actual), out,
  ]);
  return { id: scene.id, heading: scene.heading, planned, actual, narration: narr === null ? null : r2(narr), over: r2(over), startAt: r2(startAt), segments: built.map(b => b.result) };
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
mkdirSync(CHECK, { recursive: true });

const cuts: CutResult[] = [];
let t = 0;
plan.scenes.forEach((s, i) => {
  const c = buildCut(s, i, plan.scenes.length, t);
  cuts.push(c);
  t += c.actual;
  console.log(`[assemble] ${s.id} ${String(c.actual).padStart(5)} 秒（予定 ${c.planned}）${c.over ? `  ナレーションが ${c.over} 秒はみ出したので延ばしました` : ''}`);
});

// つなぐ → 音の大きさをそろえる（loudnorm 2 回通し）
const list = join(WORK, 'cuts.txt');
writeFileSync(list, cuts.map(c => `file '${join(WORK, `cut-${c.id}.mp4`).replace(/\\/g, '/')}'`).join('\n'));
const joined = join(WORK, 'joined.mp4');
ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);

const measure = run('ffmpeg', ['-hide_banner', '-i', joined, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']);
const m = JSON.parse(measure.slice(measure.lastIndexOf('{'), measure.lastIndexOf('}') + 1)) as Record<string, string>;
const ln = `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
ffmpeg(['-i', joined, '-c:v', 'copy', '-af', ln, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', OUT]);

// 確認用の静止画（カットの頭・中ほど・終わり）
for (const c of cuts) {
  const shots: Array<[string, number]> = [[`${c.id}.png`, c.startAt + 0.5], [`${c.id}-mid.png`, c.startAt + c.actual / 2], [`${c.id}-end.png`, c.startAt + c.actual - 0.4]];
  for (const [name, at] of shots) ffmpeg(['-ss', at.toFixed(2), '-i', OUT, '-frames:v', '1', join(CHECK, name)]);
}

const final = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', OUT]);
const after = run('ffmpeg', ['-hide_banner', '-i', OUT, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']);
const lufs = JSON.parse(after.slice(after.lastIndexOf('{'), after.lastIndexOf('}') + 1)) as Record<string, string>;
const report = {
  output: 'tmp/video/demo-draft.mp4', createdAt: new Date().toISOString(),
  totalSeconds: r2(t), plannedSeconds: plan.scenes[plan.scenes.length - 1].end, loudnessLUFS: Number(lufs.input_i),
  probe: JSON.parse(final), cuts,
  narrationOver: cuts.filter(c => c.over > 0).map(c => ({ id: c.id, over: c.over })),
  speededUp: cuts.flatMap(c => c.segments.filter(s => s.speed > 1).map(s => ({ id: s.id, speed: s.speed, truncated: s.truncated }))),
};
writeFileSync(join(ROOT, 'tmp/video/assemble-report.json'), JSON.stringify(report, null, 2));
console.log(`[assemble] 完了 → tmp/video/demo-draft.mp4（${r2(t)} 秒、${lufs.input_i} LUFS）`);
if (report.narrationOver.length) console.warn('[assemble] ナレーションがはみ出したカット:', report.narrationOver.map(o => `${o.id} +${o.over} 秒`).join(', '));
if (report.speededUp.length) console.log('[assemble] 速めた区間:', report.speededUp.map(o => `${o.id} ×${o.speed}${o.truncated ? `（${o.truncated} 秒切れた）` : ''}`).join(', '));
console.log('[assemble] 確認用の静止画 → tmp/video/check/');
