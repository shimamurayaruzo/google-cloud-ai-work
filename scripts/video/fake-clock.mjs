// デモ動画の録画用: サーバー（子プロセス）の時計だけをずらす preload。src/ は変えない。
//   node --import tsx --import ./scripts/video/fake-clock.mjs src/dev.ts
// Date（new Date() と Date.now()）だけを「録画の中の時刻」にずらす。時刻は実時間の速さで進む。
// setTimeout などのタイマーは実時間のまま（TASKS_MODE=inline の予約は、録画の手順側で /internal/recheck を直接呼ぶ）。
//
// 時刻の操作（record.ts が呼ぶ。127.0.0.1 だけで待つ）:
//   POST http://127.0.0.1:$DEMO_CLOCK_PORT/clock  body: {"at":"2026-09-29T08:35:00+09:00"}  → {"now": ISO}
//   GET  http://127.0.0.1:$DEMO_CLOCK_PORT/clock  → {"now": ISO}
import http from 'node:http';

const RealDate = globalThis.Date;
let offset = 0;
if (process.env.DEMO_CLOCK_START) offset = new RealDate(process.env.DEMO_CLOCK_START).getTime() - RealDate.now();
const now = () => RealDate.now() + offset;

function FakeDate(...args) {
  if (!new.target) return new RealDate(now()).toString();
  return Reflect.construct(RealDate, args.length === 0 ? [now()] : args, new.target);
}
FakeDate.prototype = RealDate.prototype;
FakeDate.now = now;
FakeDate.parse = RealDate.parse;
FakeDate.UTC = RealDate.UTC;
Object.setPrototypeOf(FakeDate, RealDate);
globalThis.Date = FakeDate;

const port = Number(process.env.DEMO_CLOCK_PORT || 0);
if (port) {
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url !== '/clock') return send(404, { error: 'not found' });
    if (req.method === 'GET') return send(200, { now: new RealDate(now()).toISOString() });
    if (req.method !== 'POST') return send(405, { error: 'method' });
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      try {
        const at = new RealDate(JSON.parse(raw).at);
        if (Number.isNaN(at.getTime())) return send(400, { error: 'at' });
        offset = at.getTime() - RealDate.now();
        send(200, { now: new RealDate(now()).toISOString() });
      } catch (e) {
        send(400, { error: String(e) });
      }
    });
  });
  server.listen(port, '127.0.0.1');
  server.unref();
}
