// 審査員の入口（GET /）。合言葉 → 3 つのボタン → 「1 日分を再生」。
// 再生は POST /api/family/replay の steps と summary をそのまま描く（src/api/README.md 2 節）。
// 外部ライブラリなし。合言葉は URL に入れない。
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const HH = 'hh_demo';
  const STEP_MS = 2000;

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'class') n.className = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    const add = (c) => {
      if (c == null || c === false) return;
      if (Array.isArray(c)) { c.forEach(add); return; }
      n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    };
    kids.forEach(add);
    return n;
  }
  const hhmm = (s) => (typeof s === 'string' ? s.replace(/^0(\d)/, '$1') : '');
  function dayLabel(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
    if (!m) return key || '';
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return `${+m[2]}月${+m[3]}日・${'日月火水木金土'[d.getUTCDay()]}`;
  }

  class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method, credentials: 'same-origin',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch { throw new ApiError(0, '通信できませんでした。少し置いてからもう一度お試しください。'); }
    let data = null;
    try { data = await res.json(); } catch { /* 空 */ }
    if (!res.ok) throw new ApiError(res.status, (data && data.error) || `うまくいきませんでした（${res.status}）`);
    return data;
  }

  // ---------- 言葉 ----------
  const STATUS = { done: ['できたと返答', 'c-done'], not_yet: ['まだ', 'c-wait'], no_answer: ['お返事なし', 'c-no'], unclear: ['判断できない', 'c-unc'] };
  const LEVEL = { urgent: ['至急', 'c-red'], check: ['確認のお願い', 'c-wait'], info: ['お知らせ', 'c-done'] };
  const SCENARIO = { 'dayservice-day': 'デイサービスの日', weekday: '在宅の日', 'dress-three-times': '着替えを 3 回聞く', 'no-answer-escalation': 'お返事が続けて無い' };
  const CAP_CLASS = { auto: 'c-done', auto_with_evidence: 'c-wait', after_approval: 'c-unc', never: 'c-red' };
  const chip = (t, c) => el('span', { class: 'chip ' + c }, t);
  const statusChip = (st) => { const s = STATUS[st] || [st || '—', 'c-no']; return chip(s[0], s[1]); };

  // ---------- 画面の切り替え ----------
  function view(v) {
    $('#v-login').classList.toggle('hidden', v !== 'login');
    $('#v-menu').classList.toggle('hidden', v === 'login');
    $('#v-replay').classList.toggle('hidden', v !== 'replay');
    $('#who').textContent = v === 'login' ? '審査員の方へ' : 'テスト世帯でログイン中';
  }

  // ---------- 合言葉 ----------
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#loginForm button');
    const err = $('#loginErr');
    btn.disabled = true; err.classList.add('hidden');
    try {
      await api('POST', '/api/family/login', { passphrase: $('#pass').value });
      $('#pass').value = '';
      afterLogin();
    } catch (er) {
      err.textContent = er.status === 401 ? '合言葉が違います。提出フォームの合言葉をもう一度お確かめください。'
        : er.status === 503 ? 'サーバー側で合言葉が設定されていません。' : er.message;
      err.classList.remove('hidden');
    } finally { btn.disabled = false; }
  });
  function backToLogin(msg) {
    stop();
    view('login');
    if (msg) { $('#loginErr').textContent = msg; $('#loginErr').classList.remove('hidden'); }
  }

  async function afterLogin() {
    view('menu');
    loadCaps();
    loadDemoDevice();
    loadScenarios();
  }

  // ---------- 右の欄: できること ----------
  async function loadCaps() {
    const box = $('#caps');
    try {
      const r = await api('GET', `/api/family/capabilities?hh=${HH}`);
      box.replaceChildren(el('div', {}, el('h3', {}, 'できること・できないこと'),
        (r.levels || []).map(l => [el('div', { class: 'lv' }, chip(l.label, CAP_CLASS[l.key] || 'c-no')), el('ul', {}, (l.examples || []).map(x => el('li', {}, x)))]),
        el('div', { class: 'lv' }, chip('お風呂モードでも行わない', 'c-red')),
        el('ul', {}, el('li', {}, '転倒などの安全の確認')),
        el('p', { class: 'meta' }, '家族の画面には「今すぐ止める」があります。')));
    } catch (e) {
      if (e.status === 401) return;
      box.replaceChildren(el('h3', {}, 'できること・できないこと'), el('p', { class: 'meta' }, '読み込めませんでした。'));
    }
  }

  // ---------- ② 母側の画面 ----------
  // トークンは URL に載せない。ログイン後に GET /api/family/demo-device で受け取り、
  // 母側画面（web/device.js）が読む localStorage['mimamori.device'] = { hh, token } に書いてから開く。
  // 404（デモ世帯が無い等）のときだけ入力欄を出し、入れたトークンも同じ場所に書く。
  const DEVICE_KEY = 'mimamori.device';
  let demoDevice; // undefined = 未取得、null = 使えない、{ hh, token } = 取得済み
  async function loadDemoDevice() {
    try {
      const r = await api('GET', `/api/family/demo-device?hh=${HH}`);
      demoDevice = r && typeof r.token === 'string' && r.token ? { hh: typeof r.hh === 'string' && r.hh ? r.hh : HH, token: r.token } : null;
    } catch { demoDevice = null; }
    $('#tokBox').classList.toggle('hidden', Boolean(demoDevice));
    return demoDevice;
  }
  function saveDevice(cfg) {
    try { localStorage.setItem(DEVICE_KEY, JSON.stringify({ hh: cfg.hh, token: cfg.token })); return true; } catch { return false; }
  }
  $('#deviceLink').addEventListener('click', async (e) => {
    e.preventDefault();
    const url = `/device?hh=${HH}`;
    if (demoDevice === undefined) {
      // まだ取得していない: ポップアップを止められないよう先にタブを開き、あとで行き先を入れる
      const w = window.open('about:blank', '_blank');
      const got = await loadDemoDevice();
      if (got) saveDevice(got);
      if (w) { try { w.opener = null; } catch { /* 無視 */ } w.location.href = url; }
      if (!got) $('#token').focus();
      return;
    }
    if (demoDevice) saveDevice(demoDevice);
    else {
      const tok = $('#token').value.trim();
      if (tok) saveDevice({ hh: HH, token: tok });
    }
    window.open(url, '_blank', 'noopener');
  });

  // ---------- ① 再生 ----------
  async function loadScenarios() {
    const sel = $('#scenario');
    let names = ['dayservice-day'];
    try { names = (await api('GET', `/api/family/replay/scenarios?hh=${HH}`)).names || names; } catch (e) { if (e.status === 401) { backToLogin('もう一度合言葉を入れてください。'); return; } }
    if (!names.includes('dayservice-day')) names.unshift('dayservice-day');
    sel.replaceChildren(...names.map(n => el('option', { value: n, selected: n === 'dayservice-day' }, SCENARIO[n] ? `${SCENARIO[n]}（${n}）` : n)));
  }

  let timer = null;
  let rowsEls = [];
  let shown = 0;
  let current = null;
  function stop() { clearInterval(timer); timer = null; }

  function actionCell(s) {
    const lines = [];
    for (const t of s.notices || []) {
      const m = /^(urgent|check|info):\s*(.*)$/.exec(t);
      const lv = m ? LEVEL[m[1]] : null;
      lines.push(el('div', {}, lv ? chip(lv[0], lv[1]) : null, ' ご家族へ: ', m ? m[2] : t));
    }
    for (const i of s.intents || []) {
      if (i.type === 'recheck') lines.push(el('div', {}, `${s.followUpAt ? hhmm(s.followUpAt) + ' に' : `${i.minutes} 分後に`}聞き直しを予約`));
      else if (i.type === 'followup') lines.push(el('div', {}, `${i.minutes >= 60 ? `${Math.round(i.minutes / 60)} 時間後` : `${i.minutes} 分後`}に聞き直す（「${i.text}」）`));
      else if (i.type === 'share_external') lines.push(el('div', {}, '外部への共有を頼まれた → ご家族の承認待ちへ'));
      else if (i.type === 'blocked') lines.push(el('div', {}, `止めた: ${i.tool}（${i.reason}）`));
    }
    if (s.followUpAt && !(s.intents || []).some(i => i.type === 'recheck')) lines.push(el('div', {}, `${hhmm(s.followUpAt)} にもう一度`));
    if (!lines.length) lines.push(el('div', { class: 'na' }, '記録'));
    return el('td', { class: 'act' }, lines, s.say ? el('span', { class: 'say' }, `一言:「${s.say}」`) : null);
  }
  function expectCell(s) {
    if (s.pass === true) return el('td', {}, el('span', { class: 'ok' }, '✓ 一致'));
    if (s.pass === false) {
      const ex = s.expected || {};
      const want = [(STATUS[ex.status] || [ex.status])[0], ex.notify ? `通知「${(LEVEL[ex.notify] || [ex.notify])[0]}」` : null].filter(Boolean).join('・');
      return el('td', {}, el('span', { class: 'ng' }, '✗ 不一致'), el('span', { class: 'by' }, `期待: ${want}`));
    }
    return el('td', {}, el('span', { class: 'na' }, '期待値なし'));
  }

  function buildRows(res, adk) {
    const steps = [...(res.steps || [])].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const tbody = $('#rows');
    const trs = [];
    let sysDone = !res.summary;
    steps.forEach((s, i) => {
      if (!sysDone && s.at >= '18:00') {
        trs.push(el('tr', { class: 'sys', 'data-sys': '1' }, el('td', { class: 't' }, '18:00'), el('td', { colspan: '4' }, '夕方の「今日の様子」を作る（再生ではどこにも送りません）'), el('td', { class: 'na' }, '—')));
        sysDone = true;
      }
      trs.push(el('tr', { id: 'step-' + i, 'data-turn': s.turnId || '' },
        el('td', { class: 't' }, hhmm(s.at)),
        el('td', { class: 'ai' }, s.prompt ? `「${s.prompt}」` : el('span', { class: 'na' }, '（続き）')),
        el('td', { class: 'me' }, s.reply ? `「${s.reply}」` : el('span', { class: 'na' }, '（お返事なし）')),
        el('td', {}, statusChip(s.status), el('span', { class: 'by' }, adk ? 'Gemini ＋ 規則' : '規則')),
        actionCell(s),
        expectCell(s)));
    });
    if (!sysDone) trs.push(el('tr', { class: 'sys', 'data-sys': '1' }, el('td', { class: 't' }, '18:00'), el('td', { colspan: '4' }, '夕方の「今日の様子」を作る（再生ではどこにも送りません）'), el('td', { class: 'na' }, '—')));
    tbody.replaceChildren(...trs);
    rowsEls = trs;
    return steps;
  }

  function reveal(n) {
    const total = rowsEls.length;
    rowsEls.forEach((tr, i) => {
      tr.classList.toggle('hide', i >= n);
      if (i === n - 1) { tr.classList.remove('new'); void tr.offsetWidth; tr.classList.add('new'); }
    });
    const res = current.res;
    const steps = current.steps;
    const turnsShown = rowsEls.slice(0, n).filter(tr => !tr.dataset.sys).length;
    $('#bar').style.width = (total ? (n / total) * 100 : 100) + '%';
    const fin = n >= total;
    const judged = (res.passCount || 0) + (res.failCount || 0);
    const sc = $('#score');
    if (fin) {
      sc.className = 'score' + (res.failCount ? ' ng' : '');
      sc.textContent = `期待値との一致 ${res.passCount} / ${judged}`;
    } else {
      sc.className = 'score run';
      sc.textContent = `再生中 ${turnsShown} / ${steps.length}`;
    }
    $('#summary').classList.toggle('hidden', !fin || !res.summary);
    $('#skip').disabled = fin;
    if (n > 0 && n <= total && timer) rowsEls[n - 1].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function citeBtns(list) {
    return (list || []).map(c => el('button', { type: 'button', class: 'cite', title: 'もとの行へ移る', onclick: () => jumpTo(c.turnId) }, String(c.n)));
  }
  function jumpTo(turnId) {
    $$('#rows tr').forEach(tr => tr.classList.remove('hl'));
    const tr = rowsEls.find(r => r.dataset.turn === turnId);
    if (!tr) return;
    tr.classList.remove('hide');
    tr.classList.add('hl');
    tr.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function renderSummary(res) {
    const sm = res.summary;
    const box = $('#summary');
    if (!sm) { box.replaceChildren(); return; }
    const titles = { 'お返事の記録': 'replies', '気になったこと': 'concerns', 'お知らせの続き': 'continued', '昨日までとの比較': 'comparison', 'この記録について': 'about' };
    const sorted = [...(sm.citations || [])].sort((a, b) => a.sentenceIndex - b.sentenceIndex);
    const bySentence = new Map();
    sorted.forEach((c, i) => { if (!bySentence.has(c.sentenceIndex)) bySentence.set(c.sentenceIndex, []); bySentence.get(c.sentenceIndex).push({ n: i + 1, turnId: c.turnId }); });
    const sentences = sm.sentences && sm.sentences.length ? sm.sentences : String(sm.text || '').split('\n');
    const out = [el('h2', {}, '夕方の「今日の様子」（再生で作った要約）')];
    if (sm.sections) {
      // report-design 1 節の型: 見出し → 結論 → 各節（「・」付き）。引用は sentences の番号で付く
      sentences.forEach((s, i) => {
        if (i === 0) out.push(el('p', { class: 'fine' }, s));
        else if (i === 1) out.push(el('p', { class: 'conc' }, s, citeBtns(bySentence.get(i))));
        else if (titles[s]) out.push(el('p', { class: 'sec' }, s));
        else out.push(el('p', { class: titles[sentences.slice(0, i).reverse().find(x => titles[x])] === 'about' ? 'fine' : '' }, s, citeBtns(bySentence.get(i))));
      });
    } else {
      sentences.forEach((s, i) => out.push(el('p', {}, s, citeBtns(bySentence.get(i)))));
    }
    out.push(el('p', { class: 'meta' }, '［番号］を押すと、もとの会話の行に移ります。'));
    out.push(el('div', { class: 'next' },
      el('a', { class: 'btn sec sm', href: `/family?hh=${HH}`, target: '_blank', rel: 'noopener' }, '③ 家族の画面で通知と承認を見る ↗'),
      el('a', { class: 'btn sec sm', href: `/device?hh=${HH}`, target: '_blank', rel: 'noopener' }, '② 母側の画面を見る ↗'),
      el('button', { type: 'button', class: 'btn sec sm', onclick: () => play() }, 'もう一度再生')));
    box.replaceChildren(...out);
  }

  async function play() {
    stop();
    view('replay');
    const name = $('#scenario').value || 'dayservice-day';
    const adk = $('#useAdk').checked;
    $('#rows').replaceChildren();
    $('#summary').classList.add('hidden');
    $('#bar').style.width = '0';
    $('#score').className = 'score run';
    $('#score').textContent = '準備中';
    $('#rpTitle').textContent = `再生: ${SCENARIO[name] || name}`;
    $('#rpNote').textContent = adk ? '台本を流しています… Gemini で判定するので、1 行 3 秒ほどかかります。' : '台本を流しています…';
    $('#skip').disabled = true; $('#again').disabled = true;
    let res;
    try {
      const q = new URLSearchParams({ hh: HH });
      if (adk) q.set('agent', 'adk');
      res = await api('POST', `/api/family/replay?${q}`, { name, hh: HH });
    } catch (e) {
      $('#again').disabled = false;
      if (e.status === 401) { backToLogin('ログインが切れました。もう一度合言葉を入れてください。'); return; }
      $('#score').className = 'score ng';
      $('#score').textContent = '再生できませんでした';
      $('#rpNote').textContent = e.status >= 500 ? `サーバーで問題が起きました（${e.status}）。少し置いてからもう一度お試しください。` : e.message;
      return;
    }
    $('#again').disabled = false;
    $('#rpTitle').textContent = `再生: ${SCENARIO[name] || res.name || name}（${dayLabel(res.date)}）`;
    $('#rpNote').textContent = `期待値（台本の expect）がある ${(res.passCount || 0) + (res.failCount || 0)} 行で、判定と通知が合っているかを見ます。判定: ${adk ? 'Gemini（回数・時刻・言葉は規則）' : '規則（LLM なし）'}。`;
    const steps = buildRows(res, adk);
    current = { res, steps };
    renderSummary(res);
    shown = 0;
    reveal(0);
    timer = setInterval(() => {
      shown++;
      reveal(shown);
      if (shown >= rowsEls.length) {
        stop();
        $('#summary').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, STEP_MS);
  }
  function finish() {
    if (!current) return;
    stop();
    shown = rowsEls.length;
    reveal(shown);
    $('#summary').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('#playBtn').addEventListener('click', () => play());
  $('#again').addEventListener('click', () => play());
  $('#skip').addEventListener('click', finish);

  // ---------- 起動 ----------
  (async () => {
    try {
      const s = await api('GET', '/api/family/session');
      if (s && s.authed) afterLogin();
      else {
        view('login');
        if (s && s.passphraseConfigured === false) { $('#loginErr').textContent = 'サーバー側で合言葉が設定されていません。'; $('#loginErr').classList.remove('hidden'); }
      }
    } catch { view('login'); }
  })();
})();
