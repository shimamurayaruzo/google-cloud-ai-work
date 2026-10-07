// デモ動画の素材を Playwright で撮る（scripts/video/scenes.json のカット表どおり）。
//
// 実行（リポジトリの直下で）: npm run video:record
//   一部だけ撮り直す: npm run video:record -- c03 c07   （仮想の時刻が前のカットの記録に依存するので、録画は毎回最初から流し、
//                                                         指定したカットの動画だけを書き出す）
//
// やること:
//  1. 静止画のカット（タイトル・実写の差し替え板・Slack・全体像図）を HTML から撮る → tmp/video/raw/<id>.png
//     ついでに docs/infographic/system-overview.svg を撮って system-overview.png（2 倍）を作り直す
//  2. 自前でサーバーを起動する（子プロセス。STORE=memory・規則の判定・inline の予約・端末の読み上げ・DEMO_MODE）。
//     本物の Firestore・LINE・Slack・本番 URL には触れない。終わったら必ず止める
//     サーバーの時計は scripts/video/fake-clock.mjs でずらす（録画の中の 8:35 や 16:00 を本物の処理で作るため）
//  3. 画面のカットを recordOrder の順に撮る → tmp/video/raw/<区間 id>.webm と <区間 id>.json（使う範囲 start/end 秒）
//
// 母側画面では、読み上げ（speechSynthesis）とマイク（webkitSpeechRecognition）を録画用の偽物に差し替える
// （音は鳴らさず文字数に応じた時間で読み終わったことにし、本人の返事は steps の say を「聞き取った」ことにする）。
// 画面の時計はページの時計（page.clock）をサーバーと同じ仮想の時刻に合わせる。web/ のコードは変えない。

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

const ROOT = process.cwd();
const VIDEO_DIR = join(ROOT, 'scripts/video');
const RAW = join(ROOT, 'tmp/video/raw');
const PORT = 8097;
const CLOCK_PORT = 8098;
const BASE = `http://localhost:${PORT}`;
const PASSPHRASE = 'demo-pass';
const INTERNAL_TOKEN = 'demo-internal';
const DEVICE_TOKEN = 'demo-device';
const TAIL_MS = 2500;

// ---------------------------------------------------------------------------
// カット表
// ---------------------------------------------------------------------------
type Step = { do: string; [k: string]: unknown };
interface Segment { id: string; kind: string; duration: number; steps?: Step[]; card?: string }
interface Scene {
  id: string; start: number; end: number; kind: string; heading: string; narration: string;
  card?: string; steps?: Step[]; segments?: Segment[]; before?: Step[]; after?: Step[];
}
interface Plan {
  viewports: Record<string, { width: number; height: number }>;
  hh: string;
  prepare: Step[];
  recordOrder: string[];
  scenes: Scene[];
}
const plan = JSON.parse(readFileSync(join(VIDEO_DIR, 'scenes.json'), 'utf8')) as Plan;
const only = new Set(process.argv.slice(2).filter(a => /^c\d+/.test(a)));
const wanted = (id: string) => only.size === 0 || only.has(id) || only.has(id.split('-')[0]);

export function segmentsOf(s: Scene): Segment[] {
  return s.segments ?? [{ id: s.id, kind: s.kind, duration: s.end - s.start, steps: s.steps, card: s.card }];
}
const CARD_KINDS = new Set(['title', 'live', 'slack', 'diagram']);

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log('[record]', ...a);

/** "2026-09-29T08:35:00" → 日本時間の Date（タイムゾーンが書いてあればそのまま） */
function jst(at: string): Date {
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(at) ? at : `${at}+09:00`);
}

const vars: Record<string, unknown> = {};
/** 文字列の ${a.b.c} を保存した値に置き換える（深く） */
function fill<T>(v: T): T {
  if (typeof v === 'string') {
    return v.replace(/\$\{([\w.]+)\}/g, (_, path: string) => {
      const val = path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], vars);
      if (val === undefined) throw new Error(`変数 ${path} がありません`);
      return String(val);
    }) as T;
  }
  if (Array.isArray(v)) return v.map(fill) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) as T;
  return v;
}

// ---------------------------------------------------------------------------
// サーバー（子プロセス）
// ---------------------------------------------------------------------------
let server: ChildProcess | null = null;

async function isUp(url: string): Promise<boolean> {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
}

async function startServer(): Promise<void> {
  if (await isUp(`${BASE}/healthz`)) throw new Error(`ポート ${PORT} で何かが動いています。止めてからやり直してください`);
  mkdirSync(join(ROOT, 'tmp/video'), { recursive: true });
  const logFile = createWriteStream(join(ROOT, 'tmp/video/server.log'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    STORE: 'memory', AGENT_MODE: 'rules', TASKS_MODE: 'inline', TTS_MODE: 'device', PORT: String(PORT),
    APP_PASSPHRASE: PASSPHRASE, INTERNAL_TOKEN, DEVICE_TOKENS: `${plan.hh}:${DEVICE_TOKEN}`, HOUSEHOLD_ID: plan.hh,
    FIRESTORE_DATABASE: 'unused', DEMO_MODE: 'true', DEMO_CLOCK_PORT: String(CLOCK_PORT),
    DEMO_CLOCK_START: '2026-09-01T09:00:00+09:00',
    // 外へは何も送らない（手元の環境変数に本物が入っていても使わない）
    LINE_CHANNEL_ACCESS_TOKEN: '', LINE_CHANNEL_SECRET: '', SLACK_WEBHOOK_URL: '', SERVICE_URL: '', TASKS_SERVICE_ACCOUNT: '',
  };
  // npx tsx src/dev.ts と同じ（tsx をローダーとして読み込む）。npx を挟まないので、止めるときに孫プロセスが残らない
  server = spawn(process.execPath, ['--import', 'tsx', '--import', pathToFileURL(join(VIDEO_DIR, 'fake-clock.mjs')).href, 'src/dev.ts'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout!.pipe(logFile);
  server.stderr!.pipe(logFile);
  server.on('exit', code => { if (code !== null && code !== 0) console.error(`[record] サーバーが止まりました（code ${code}）。tmp/video/server.log を見てください`); server = null; });
  for (let i = 0; i < 60; i++) {
    if (await isUp(`${BASE}/healthz`)) { log('サーバー起動', BASE); return; }
    if (!server) break;
    await sleep(500);
  }
  throw new Error('サーバーが起動しませんでした（tmp/video/server.log）');
}

function stopServer(): void {
  if (server && server.exitCode === null) {
    server.kill();
    log('サーバー停止');
  }
  server = null;
}
process.on('exit', stopServer);
process.on('SIGINT', () => { stopServer(); process.exit(130); });

// ---- 時計 ----
async function setServerClock(d: Date): Promise<void> {
  const r = await fetch(`http://127.0.0.1:${CLOCK_PORT}/clock`, { method: 'POST', body: JSON.stringify({ at: d.toISOString() }) });
  if (!r.ok) throw new Error(`時計を合わせられません: ${r.status}`);
}
async function serverNow(): Promise<Date> {
  const r = await fetch(`http://127.0.0.1:${CLOCK_PORT}/clock`);
  return new Date(((await r.json()) as { now: string }).now);
}

// ---- API ----
let familyCookie = '';
async function familyLogin(): Promise<void> {
  const r = await fetch(`${BASE}/api/family/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: PASSPHRASE }),
  });
  if (!r.ok) throw new Error(`家族のログインに失敗: ${r.status}`);
  familyCookie = r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
}

async function api(as: string, method: string, path: string, body?: unknown, retried = false): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (as === 'internal') headers['X-Internal-Token'] = INTERNAL_TOKEN;
  else if (as === 'family') { if (!familyCookie) await familyLogin(); headers.Cookie = familyCookie; }
  else if (as === 'device') headers['X-Device-Token'] = DEVICE_TOKEN;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data: unknown = null;
  try { data = JSON.parse(text); } catch { data = text; }
  // 仮想の時計を日単位で進めるとログイン（12 時間）が切れるので、1 回だけ入り直す
  if (r.status === 401 && as === 'family' && !retried) { await familyLogin(); return api(as, method, path, body, true); }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 300)}`);
  return data;
}

// ---------------------------------------------------------------------------
// 母側画面の録画用の偽物（読み上げ・マイク）
// ---------------------------------------------------------------------------
const DEVICE_STUB = `(() => {
  // 読み上げ: 音は出さず、文字数に応じた時間で「読み終わった」ことにする
  const synth = {
    speaking: false, pending: false, paused: false, _t: null,
    getVoices() { return []; },
    cancel() { if (this._t) clearTimeout(this._t); this._t = null; this.speaking = false; window.__demoSpeaking = false; },
    pause() {}, resume() {}, addEventListener() {}, removeEventListener() {},
    speak(u) {
      this.cancel();
      const n = String((u && u.text) || '').length;
      if (!n) { setTimeout(() => { if (u.onend) u.onend({}); }, 0); return; }
      this.speaking = true; window.__demoSpeaking = true;
      this._t = setTimeout(() => {
        this._t = null; this.speaking = false; window.__demoSpeaking = false;
        if (u.onend) u.onend({});
      }, Math.max(1200, n * 110));
    },
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.__demoSpeaking = false;

  // マイク: 聞き取りを始めたことにして待つ。__demoSay(text) で本人の言葉が聞こえたことにする
  class FakeRecognition {
    constructor() { this.lang = ''; this.continuous = false; this.interimResults = false; this.maxAlternatives = 1;
      this.onstart = null; this.onresult = null; this.onerror = null; this.onend = null; this.started = false; this.dead = false; }
    start() { window.__demoRec = this; setTimeout(() => { if (this.dead) return; this.started = true; if (this.onstart) this.onstart({}); }, 30); }
    stop() { this.abort(); }
    abort() { this.dead = true; if (window.__demoRec === this) window.__demoRec = null; }
  }
  Object.defineProperty(window, 'webkitSpeechRecognition', { value: FakeRecognition, configurable: true, writable: true });
  Object.defineProperty(window, 'SpeechRecognition', { value: FakeRecognition, configurable: true, writable: true });
  const ev = (text, fin) => { const r = [{ transcript: text }]; r.isFinal = fin; return { results: [r] }; };
  window.__demoSay = async (text) => {
    const rec = window.__demoRec;
    if (!rec || !rec.started || rec.dead) return false;
    // 文字が少しずつ出る（聞き取りの途中経過）→ 確定
    const chars = Array.from(text);
    const steps = Math.min(4, chars.length);
    for (let i = 1; i < steps; i++) {
      if (rec.dead || !rec.onresult) break;
      rec.onresult(ev(chars.slice(0, Math.ceil(chars.length * i / steps)).join(''), false));
      await new Promise(r => setTimeout(r, 160));
    }
    if (rec.dead) return true;
    if (rec.onresult) rec.onresult(ev(text, true));
    if (!rec.dead && rec.onend) { rec.dead = true; if (window.__demoRec === rec) window.__demoRec = null; rec.onend({}); }
    return true;
  };
})();`;

// ---------------------------------------------------------------------------
// 静止画のカット
// ---------------------------------------------------------------------------
function cardUrl(card: string): string {
  const [file, qs] = card.split('?');
  const u = pathToFileURL(join(VIDEO_DIR, 'cards', file));
  if (qs) u.search = new URLSearchParams(qs).toString();
  return u.href;
}

async function renderCards(browser: Browser): Promise<void> {
  mkdirSync(RAW, { recursive: true });
  for (const s of plan.scenes) {
    for (const seg of segmentsOf(s)) {
      if (!CARD_KINDS.has(seg.kind) || !seg.card || !wanted(seg.id)) continue;
      const vp = seg.kind === 'title' || seg.kind === 'diagram' ? plan.viewports.full : plan.viewports.card;
      const page = await browser.newPage({ viewport: vp });
      await page.goto(cardUrl(seg.card));
      await page.evaluate(() => document.fonts.ready);
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: join(RAW, `${seg.id}.png`) });
      await page.close();
      writeFileSync(join(RAW, `${seg.id}.json`), JSON.stringify({ id: seg.id, kind: seg.kind, image: `${seg.id}.png`, viewport: vp }, null, 2));
      log('静止画', seg.id);
    }
  }
  // 全体像図の PNG（docs。2 倍）
  if (wanted('c10')) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 820 }, deviceScaleFactor: 2 });
    await page.goto(pathToFileURL(join(ROOT, 'docs/infographic/system-overview.svg')).href);
    await page.screenshot({ path: join(ROOT, 'docs/infographic/system-overview.png') });
    await page.close();
    log('docs/infographic/system-overview.png を作り直しました');
  }
}

// ---------------------------------------------------------------------------
// 手順
// ---------------------------------------------------------------------------
interface Rec { page: Page | null; t0: number; marks: Record<string, number> }

async function pageNow(page: Page): Promise<Date> {
  return new Date(await page.evaluate(() => Date.now()));
}

async function runStep(step: Step, rec: Rec): Promise<void> {
  const s = fill(step);
  const page = rec.page;
  const needPage = () => { if (!page) throw new Error(`${s.do} は画面の録画の中でしか使えません`); return page; };
  switch (s.do) {
    case 'clock': {
      const d = jst(String(s.at));
      await setServerClock(d);
      if (page) await page.clock.setSystemTime(d);
      return;
    }
    case 'serverClock': {
      const d = s.sync === 'page' ? await pageNow(needPage()) : jst(String(s.at));
      await setServerClock(d);
      return;
    }
    case 'api': {
      const r = await api(String(s.as ?? 'internal'), String(s.method ?? 'POST'), String(s.path), s.body);
      if (s.save) vars[String(s.save)] = r;
      return;
    }
    case 'replay': {
      const body: Record<string, unknown> = { hh: plan.hh, withSummary: false };
      if (s.name) body.name = s.name;
      if (s.scenario) body.scenario = s.scenario;
      if (s.date) body.date = s.date;
      const r = await api('internal', 'POST', '/internal/replay-into-store', body) as { date: string; steps: unknown[]; passCount: number; failCount: number };
      log(`台本を流しました ${r.date}（${r.steps.length} 手順、期待値 一致 ${r.passCount}／不一致 ${r.failCount}）`);
      return;
    }
    case 'history': {
      // 過去の記録（昨日までとの比較の材料）。デイの曜日は dayservice の台本、それ以外は default の台本を日付を変えて流す
      const household = await api('family', 'GET', '/api/family/settings') as { plan: { dayserviceDays: string[] } };
      const days = household.plan.dayserviceDays;
      const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      let n = 0;
      for (let d = jst(`${s.from}T12:00:00`); d <= jst(`${s.to}T12:00:00`); d = new Date(d.getTime() + 86_400_000)) {
        const key = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
        const isDs = days.includes(wd[new Date(`${key}T12:00:00+09:00`).getUTCDay()]);
        await api('internal', 'POST', '/internal/replay-into-store', { hh: plan.hh, name: isDs ? s.dayservice : s.default, date: key, withSummary: false });
        n++;
      }
      log(`過去 ${n} 日分の記録を作りました（${s.from}〜${s.to}）`);
      return;
    }
    case 'wait':
      await sleep(Number(s.ms ?? 1000));
      return;
    case 'mark':
      rec.marks[String(s.name)] = (Date.now() - rec.t0) / 1000;
      return;
    case 'poll': {
      // 母側画面の「次の声かけを取りに行く」（5 秒ごと）を今すぐ動かす。進んだ分はサーバーの時計も合わせる
      const p = needPage();
      await p.clock.fastForward(5000);
      await setServerClock(await pageNow(p));
      return;
    }
    case 'heartbeat':
      await needPage().evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      return;
    case 'waitText':
      await needPage().waitForFunction(([sel, text]) => {
        const el = document.querySelector(sel);
        return !!el && !el.closest('[hidden]') && !el.closest('.hidden') && (el.textContent ?? '').includes(text);
      }, [String(s.selector), String(s.text)] as const, { timeout: Number(s.timeout ?? 20000) });
      return;
    case 'waitHidden':
      await needPage().waitForSelector(String(s.selector), { state: 'hidden', timeout: Number(s.timeout ?? 20000) });
      return;
    case 'say': {
      const p = needPage();
      await p.waitForFunction(() => {
        const r = (window as unknown as { __demoRec?: { started: boolean; dead: boolean } }).__demoRec;
        return !!r && r.started && !r.dead && !(window as unknown as { __demoSpeaking?: boolean }).__demoSpeaking;
      }, undefined, { timeout: 20000 });
      // 「聞いています」の顔を少し見せてから話す
      await sleep(Number(s.pause ?? 800));
      const respP = p.waitForResponse(r => /\/api\/device\/(reply|utterance)$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 30000 });
      const okSay = await p.evaluate(t => (window as unknown as { __demoSay: (t: string) => Promise<boolean> }).__demoSay(t), String(s.text));
      if (!okSay) throw new Error('マイクが聞き取りを始めていません');
      const resp = await respP;
      const json = await resp.json() as { say?: string; kind?: string; expression?: string };
      log(`  「${s.text}」 → 「${json.say ?? ''}」${json.kind ? `（${json.kind}）` : ''} ${json.expression ?? ''}`);
      if (json.say) {
        const head = json.say.replace(/\s/g, '').slice(0, 8);
        await p.waitForFunction(h => (document.getElementById('sayText')?.textContent ?? '').replace(/\s/g, '').includes(h), head, { timeout: 20000 });
        await p.waitForFunction(() => !(window as unknown as { __demoSpeaking?: boolean }).__demoSpeaking, undefined, { timeout: 30000 });
      }
      return;
    }
    case 'click':
      await needPage().locator(String(s.selector)).first().click({ timeout: Number(s.timeout ?? 15000) });
      return;
    case 'select': {
      const p = needPage();
      await p.waitForSelector(`${s.selector} option[value="${s.value}"]`, { state: 'attached', timeout: 15000 });
      await p.selectOption(String(s.selector), String(s.value));
      return;
    }
    case 'scrollTo':
      await needPage().locator(String(s.selector)).first().evaluate(el => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      await sleep(Number(s.ms ?? 900));
      return;
    case 'wheel':
      await needPage().evaluate(y => window.scrollBy({ top: y, behavior: 'smooth' }), Number(s.y ?? 300));
      await sleep(Number(s.ms ?? 1000));
      return;
    default:
      throw new Error(`知らない手順です: ${s.do}`);
  }
}

async function runSteps(steps: Step[] | undefined, rec: Rec): Promise<void> {
  for (const [i, st] of (steps ?? []).entries()) {
    // 録画の中の手順は、何秒目に始めたかを残す（assemble.ts の調整や、ずれの確認に使う）
    if (rec.page) rec.marks[`step${String(i).padStart(2, '0')}_${st.do}`] = Math.round((Date.now() - rec.t0) * 10) / 10000;
    await runStep(st, rec);
  }
}

// ---------------------------------------------------------------------------
// 画面の録画（1 区間 = 1 ページ = 1 本の webm）
// ---------------------------------------------------------------------------
async function recordSegment(browser: Browser, seg: Segment, save: boolean): Promise<void> {
  const vp = plan.viewports[seg.kind];
  if (!vp) throw new Error(`viewport がありません: ${seg.kind}`);
  const tmpDir = join(RAW, '_video', seg.id);
  rmSync(tmpDir, { recursive: true, force: true });
  const context = await browser.newContext({
    viewport: vp, deviceScaleFactor: 1, locale: 'ja-JP', timezoneId: 'Asia/Tokyo',
    ...(save ? { recordVideo: { dir: tmpDir, size: vp } } : {}),
  });
  try {
    if (seg.kind === 'family' || seg.kind === 'judge') {
      const r = await context.request.post(`${BASE}/api/family/login`, { data: { passphrase: PASSPHRASE } });
      if (!r.ok()) throw new Error(`家族のログインに失敗: ${r.status()}`);
    }
    if (seg.kind === 'device') await context.addInitScript(DEVICE_STUB);
    const page = await context.newPage();
    const rec: Rec = { page, t0: Date.now(), marks: {} };
    await page.clock.install({ time: await serverNow() });

    if (seg.kind === 'device') {
      await page.goto(`${BASE}/device?hh=${plan.hh}&token=${DEVICE_TOKEN}`);
      await page.locator('#startBtn').click();
      await page.waitForSelector('#startOverlay', { state: 'hidden' });
      await page.waitForSelector('#stConn.on', { timeout: 15000 });
      await page.waitForSelector('#stMic.on', { timeout: 15000 });
    } else if (seg.kind === 'family') {
      await page.goto(`${BASE}/family`);
      await page.waitForSelector('#app:not(.hidden)');
      await page.waitForSelector('#p-today .grid', { timeout: 15000 });
    } else if (seg.kind === 'judge') {
      await page.goto(`${BASE}/`);
      await page.waitForSelector('#v-menu:not(.hidden)', { timeout: 15000 });
    } else {
      throw new Error(`録画できない種類です: ${seg.kind}`);
    }
    await page.evaluate(() => document.fonts.ready);
    await sleep(400);
    const hasStartMark = (seg.steps ?? []).some(st => st.do === 'mark' && st.name === 'start');
    if (!hasStartMark) rec.marks.start = (Date.now() - rec.t0) / 1000;
    await runSteps(seg.steps, rec);
    if (rec.marks.end === undefined) rec.marks.end = (Date.now() - rec.t0) / 1000;
    // 録画の最後の 1〜2 秒が書き出されずに切れることがあるので、使う範囲の後ろに余白を撮っておく
    await sleep(TAIL_MS);

    const video = page.video();
    await context.close();
    if (save && video) {
      const src = await video.path();
      const dst = join(RAW, `${seg.id}.webm`);
      rmSync(dst, { force: true });
      renameSync(src, dst);
      rmSync(tmpDir, { recursive: true, force: true });
      const used = rec.marks.end - rec.marks.start;
      writeFileSync(join(RAW, `${seg.id}.json`), JSON.stringify({
        id: seg.id, kind: seg.kind, video: `${seg.id}.webm`, viewport: vp,
        start: Math.round(rec.marks.start * 100) / 100, end: Math.round(rec.marks.end * 100) / 100, marks: rec.marks,
        planned: seg.duration,
      }, null, 2));
      log(`録画 ${seg.id}（${seg.kind}）使う長さ ${used.toFixed(1)} 秒 / 予定 ${seg.duration} 秒${used > seg.duration ? '  ← 長い（assemble で少し速めます）' : ''}`);
    } else {
      log(`（書き出さずに流しました）${seg.id}`);
    }
  } catch (e) {
    await context.close().catch(() => { /* 無視 */ });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------
async function launch(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: 'chromium' });
  } catch (e) {
    log('channel: chromium で起動できないので既定で起動します', (e as Error).message.split('\n')[0]);
    return chromium.launch();
  }
}

async function main(): Promise<void> {
  mkdirSync(RAW, { recursive: true });
  const browser = await launch();
  try {
    await renderCards(browser);
    await startServer();
    const noPage: Rec = { page: null, t0: Date.now(), marks: {} };
    await runSteps(plan.prepare, noPage);
    for (const id of plan.recordOrder) {
      const scene = plan.scenes.find(s => s.id === id);
      if (!scene) throw new Error(`recordOrder の ${id} がカット表にありません`);
      log(`カット ${id}: ${scene.heading}`);
      await runSteps(scene.before, noPage);
      for (const seg of segmentsOf(scene)) {
        if (CARD_KINDS.has(seg.kind)) continue;
        await recordSegment(browser, seg, wanted(seg.id));
      }
      await runSteps(scene.after, noPage);
    }
    // 撮っていない画面のカットが無いか
    const missing = plan.scenes.flatMap(segmentsOf).filter(seg => !existsSync(join(RAW, `${seg.id}.json`)));
    if (missing.length) console.warn('[record] 素材が無い区間:', missing.map(m => m.id).join(', '));
    log('完了 → tmp/video/raw/');
  } finally {
    await browser.close().catch(() => { /* 無視 */ });
    stopServer();
  }
}

main().catch(e => {
  console.error('[record] 失敗:', e instanceof Error ? e.stack ?? e.message : e);
  stopServer();
  process.exit(1);
});
