// 家族の画面（GET /family）。API は src/api/README.md 2 節。
// 外部ライブラリなし。個人情報は URL に載せない（?hh= の世帯 ID だけ引き継ぐ）。
// 新しい API（/api/family/mode, /api/family/whereabouts）は 404 なら機能ごと隠す。
(() => {
  'use strict';

  // ---------- 小道具 ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const TZ = 'Asia/Tokyo';

  /** el('div', { class: 'x', onclick: fn }, '文字', child, [children]) */
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'class') n.className = v;
      else if (k === 'value') n.value = v;
      else if (k === 'checked') n.checked = Boolean(v);
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

  function toDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'object' && !(v instanceof Date)) {
      const s = v._seconds ?? v.seconds;
      if (typeof s === 'number') return new Date(s * 1000);
      return null;
    }
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const hmFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' });
  const mdFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: TZ, month: 'numeric', day: 'numeric' });
  const keyFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ });
  /** ISO → "8:05"（日本時間） */
  function hm(v) { const d = toDate(v); return d ? hmFmt.format(d) : ''; }
  /** ISO → "10/2" */
  function md(v) { const d = toDate(v); return d ? mdFmt.format(d) : ''; }
  /** ISO → "10月14日" */
  function mdJa(v) { const d = toDate(v); if (!d) return ''; const [m, dd] = mdFmt.format(d).split('/'); return `${m}月${dd}日`; }
  /** "08:05" → "8:05" */
  function hhmm(s) { return typeof s === 'string' ? s.replace(/^0(\d)/, '$1') : ''; }
  function todayKey() { return keyFmt.format(new Date()); }
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  /** "2026-10-02" → "10月2日（金）" */
  function dayLabel(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
    if (!m) return key || '';
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return `${+m[2]}月${+m[3]}日（${WD[d.getUTCDay()]}）`;
  }
  function shiftDay(key, n) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
    return d.toISOString().slice(0, 10);
  }

  // ---------- 世帯（?hh=） ----------
  const HH = (() => {
    const v = new URLSearchParams(location.search).get('hh');
    return v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
  })();
  function withQ(path, extra) {
    const p = new URLSearchParams();
    if (HH) p.set('hh', HH);
    for (const [k, v] of Object.entries(extra || {})) if (v != null && v !== '') p.set(k, v);
    const s = p.toString();
    return s ? path + (path.includes('?') ? '&' : '?') + s : path;
  }

  // ---------- API ----------
  class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
  async function api(method, path, body, opts = {}) {
    let res;
    try {
      res = await fetch(withQ(path, opts.query), {
        method,
        credentials: 'same-origin',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, '通信できませんでした。少し置いてからもう一度お試しください。');
    }
    let data = null;
    try { data = await res.json(); } catch { /* 空の返り */ }
    if (res.status === 401 && !opts.login) { showLogin(); throw new ApiError(401, 'ログインが必要です'); }
    if (!res.ok) throw new ApiError(res.status, (data && data.error) || `うまくいきませんでした（${res.status}）`);
    return data;
  }
  /** 新しい API 用。404 なら null（機能を隠す） */
  async function optional(method, path, body) {
    try { return await api(method, path, body); } catch (e) { if (e.status === 404) return null; throw e; }
  }

  let toastTimer = null;
  function toast(text, isErr) {
    const t = $('#toast');
    t.textContent = text;
    t.className = 'toast' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), isErr ? 6000 : 3000);
  }
  /** 失敗の小さな表示。401 はログイン欄へ回したので出さない */
  function report(e) {
    if (e && e.status === 401) return;
    const msg = e && e.status >= 500 ? `サーバーで問題が起きました（${e.status}）。少し置いてからもう一度お試しください。` : (e && e.message) || 'うまくいきませんでした';
    toast(msg, true);
  }

  // ---------- 言葉 ----------
  const STATUS = {
    done: ['できたと返答', 'c-done'],
    not_yet: ['まだ', 'c-wait'],
    no_answer: ['お返事なし', 'c-no'],
    unclear: ['判断できない', 'c-unc'],
  };
  const LEVEL = {
    urgent: ['至急', 'c-red'],
    check: ['確認のお願い', 'c-wait'],
    info: ['お知らせ', 'c-done'],
  };
  const CHANNEL = { line: 'LINE', email: 'メール', slack: 'Slack', log: '記録のみ' };
  const RECIPIENT = { care_manager: 'ケアマネジャー', doctor: 'かかりつけ医' };
  const TOOL = {
    record_observation: '記録', schedule_recheck: '聞き直しの予約', notify_family: 'ご家族へのお知らせ',
    share_external: '外部への共有', call_outside: '外への連絡',
  };
  const CONCERN_ORIGINS = ['l4_words', 'fire', 'pain', 'pain_followup'];
  const ABOUT_DEFAULT = 'この記録は AI が声かけへのお返事から作っています。体調や病気の判断は含みません。';

  const S = {
    tab: 'today',
    date: null, // null は今日
    labels: {},
    settings: null,
    members: {},
    killSwitch: false,
    l4: null,
    modeAvail: false,
    mode: null,
    apprCount: 0,
    ledgerFilter: 'all',
    form: null,
    started: false,
  };
  const label = (task) => S.labels[task] || task || '';
  function chip(text, cls) { return el('span', { class: 'chip ' + cls }, text); }
  function statusChip(st) { const s = STATUS[st] || [st || '—', 'c-no']; return chip(s[0], s[1]); }
  function memberName(id) {
    if (!id) return 'ご家族';
    if (S.members[id]) return S.members[id];
    return 'ご家族';
  }

  // ---------- ログイン ----------
  function showLogin(note) {
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
    const err = $('#loginErr');
    if (note) { err.textContent = note; err.classList.remove('hidden'); } else err.classList.add('hidden');
    setTimeout(() => $('#pass').focus(), 0);
  }
  $('#loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('#loginForm button');
    btn.disabled = true;
    try {
      await api('POST', '/api/family/login', { passphrase: $('#pass').value }, { login: true });
      $('#pass').value = '';
      start();
    } catch (e) {
      const msg = e.status === 401 ? '合言葉が違います。' : e.status === 503 ? 'サーバー側で合言葉が設定されていません。' : e.message;
      showLogin(msg);
    } finally { btn.disabled = false; }
  });

  // ---------- 上の帯 ----------
  function renderHeader() {
    const st = $('#runState');
    const modeText = S.mode ? ` ・ ${S.mode === 'bath' ? 'お風呂モード' : '寝室モード'}` : '';
    st.textContent = S.killSwitch ? '● 止めています' : '● 動いています' + modeText;
    st.classList.toggle('off', S.killSwitch);
    const sb = $('#stopBtn');
    sb.textContent = S.killSwitch ? '再開する' : '今すぐ止める';
    sb.classList.toggle('resume', S.killSwitch);
    $('#pausebar').classList.toggle('hidden', !S.killSwitch);
    $('#l4bar').classList.toggle('hidden', !S.l4);
    $('#modeBox').classList.toggle('hidden', !S.modeAvail);
    $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.m === (S.mode || 'bedroom')));
    $('#modeNote').classList.toggle('hidden', !(S.modeAvail && S.mode === 'bath'));
    const badge = $('#apprBadge');
    badge.textContent = String(S.apprCount);
    badge.classList.toggle('hidden', !S.apprCount);
    const name = S.settings && S.settings.name;
    $('#ttl').textContent = name ? `見守り ・ ${name}` : '見守り';
  }
  function statusFromToday(r) {
    if (!r) return;
    if (r.household) S.killSwitch = Boolean(r.household.killSwitch);
    S.l4 = r.l4 || null;
    // L4 は端末の次の取り出しで解除される。家族が確認済みにした通知なら、帯はその時点で消す
    if (S.l4 && Array.isArray(r.notices)) {
      const n = r.notices.find(x => x.id === S.l4.noticeId);
      if (n && (n.state === 'acked' || n.state === 'closed' || n.falseAlarm)) S.l4 = null;
    }
    if (typeof r.mode === 'string') S.mode = r.mode;
    renderHeader();
  }

  async function loadMode() {
    const r = await optional('GET', '/api/family/mode');
    S.modeAvail = Boolean(r && typeof r.mode === 'string');
    if (S.modeAvail) S.mode = r.mode;
    renderHeader();
  }
  $$('#modeSeg button').forEach(b => b.addEventListener('click', async () => {
    const m = b.dataset.m;
    if (m === S.mode) return;
    $$('#modeSeg button').forEach(x => { x.disabled = true; });
    try {
      const r = await optional('PUT', '/api/family/mode', { mode: m });
      if (!r) { S.modeAvail = false; toast('モードの切り替えは、まだ使えません', true); }
      else { S.mode = typeof r.mode === 'string' ? r.mode : m; toast(S.mode === 'bath' ? 'お風呂モードにしました' : '寝室モードにしました'); }
    } catch (e) { report(e); }
    $$('#modeSeg button').forEach(x => { x.disabled = false; });
    renderHeader();
  }));

  async function setKill(on) {
    const sb = $('#stopBtn');
    sb.disabled = true;
    try {
      const r = await api('POST', '/api/family/kill-switch', { on });
      S.killSwitch = Boolean(r.killSwitch);
      toast(S.killSwitch ? '止めました。声かけもお知らせもしません。' : '再開しました');
      if (S.tab === 'ledger') loadTab();
    } catch (e) { report(e); }
    sb.disabled = false;
    renderHeader();
  }
  $('#stopBtn').addEventListener('click', () => { if (S.killSwitch) setKill(false); else openSheet('#stopBg'); });
  $('#stopNo').addEventListener('click', () => closeSheet('#stopBg'));
  $('#stopYes').addEventListener('click', () => { closeSheet('#stopBg'); setKill(true); });
  $('#resumeBtn').addEventListener('click', () => setKill(false));
  $('#l4Go').addEventListener('click', async () => {
    S.date = null;
    await showTab('today');
    const id = S.l4 && S.l4.noticeId;
    const n = id && document.getElementById('notice-' + id);
    if (n) { n.scrollIntoView({ behavior: 'smooth', block: 'center' }); n.classList.remove('flash'); void n.offsetWidth; n.classList.add('flash'); }
  });

  // ---------- 下から出る紙 ----------
  function openSheet(sel) { $(sel).classList.add('on'); }
  function closeSheet(sel) { $(sel).classList.remove('on'); }
  $$('.sheet-bg').forEach(bg => bg.addEventListener('click', (e) => { if (e.target === bg) bg.classList.remove('on'); }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.sheet-bg.on').forEach(b => b.classList.remove('on')); });

  async function openTurn(turnId) {
    const sh = $('#turnSheet');
    sh.replaceChildren(el('p', { class: 'loading' }, '会話を読み込んでいます…'));
    openSheet('#turnBg');
    const close = el('div', { class: 'btns' }, el('button', { type: 'button', class: 'btn ghost', onclick: () => closeSheet('#turnBg') }, '閉じる'));
    let t;
    try {
      t = (await api('GET', `/api/family/turn/${encodeURIComponent(turnId)}`)).turn;
    } catch (e) {
      if (e.status === 404) {
        sh.replaceChildren(el('h3', {}, '会話が見つかりません'), el('p', {}, 'この会話は 7 日を過ぎて削除された可能性があります。音声は最初から残していません。'), close);
      } else { closeSheet('#turnBg'); report(e); }
      return;
    }
    const c = t.classified || {};
    const at = hm(t.promptedAt) || hm(t.repliedAt);
    const kindNote = t.kind === 'followup' ? '（聞き直し）' : t.kind === 'l4' ? '（至急のあと）' : '';
    const by = c.by === 'llm' ? 'Gemini（文脈を読んで判定）' : c.by === 'rules' ? '規則（回数・時刻・言葉で判定）' : '—';
    const conf = typeof c.confidence === 'number' ? `確かさ ${c.confidence.toFixed(2)}` : null;
    const tools = (t.toolCalls || []).map(tc => {
      const nm = TOOL[tc.name] || tc.name;
      return tc.blocked ? `止めた: ${nm}${tc.reason ? `（${tc.reason}）` : ''}` : nm;
    });
    const exp = toDate(t.expiresAt);
    sh.replaceChildren(
      el('h3', {}, `${at} ${label(t.task)}${kindNote}`),
      el('div', { class: 'conv' },
        t.promptText ? el('div', { class: 'ai' }, el('small', {}, 'AI の声かけ'), t.promptText) : null,
        el('div', { class: 'me' }, el('small', {}, 'お母さまのお返事'), t.replyText ? `「${t.replyText}」` : '（お返事なし）'),
        t.say ? el('div', { class: 'ai' }, el('small', {}, 'AI の一言'), t.say) : null),
      el('dl', { class: 'kv' },
        el('dt', {}, '判定'), el('dd', {}, t.kind === 'l4' ? chip('判定しません', 'c-no') : statusChip(c.status),
          c.uncertain ? el('span', { class: 'meta' }, ' 判定に自信がないため、決めつけていません') : null),
        el('dt', {}, '決めたもの'), el('dd', {}, by, conf ? `（${conf}）` : ''),
        c.note ? [el('dt', {}, 'メモ'), el('dd', {}, c.note)] : null,
        tools.length ? [el('dt', {}, '次の行動'), el('dd', {}, tools.join('、'))] : null),
      el('p', { class: 'meta' }, exp ? `この会話の文字は ${mdJa(exp)}に削除されます（7 日）。音声は残していません。` : '会話の文字は 7 日で削除します。音声は残していません。'),
      close,
    );
  }

  // ---------- タブ ----------
  const TABS = ['today', 'plan', 'appr', 'ledger', 'settings', 'caps'];
  $$('#tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.p)));
  async function showTab(p) {
    if (!TABS.includes(p)) p = 'today';
    S.tab = p;
    $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.p === p));
    $$('.pane').forEach(x => x.classList.toggle('on', x.id === 'p-' + p));
    try { history.replaceState(null, '', location.pathname + location.search + (p === 'today' ? '' : '#' + p)); } catch { /* 無視 */ }
    window.scrollTo(0, 0);
    await loadTab();
  }
  async function loadTab(silent) {
    const p = $('#p-' + S.tab);
    if (!silent) p.replaceChildren(el('p', { class: 'loading' }, '読み込んでいます…'));
    try { await LOADERS[S.tab](p); } catch (e) {
      if (!silent) p.replaceChildren(el('p', { class: 'empty' }, e.status === 401 ? '' : '読み込めませんでした。'));
      report(e);
    }
  }

  // ---------- 今日 ----------
  /** 要約の sentences を歩いて、節ごとの行 → 引用（番号と turnId）を作る */
  function citeMap(summary) {
    const titles = { 'お返事の記録': 'replies', '気になったこと': 'concerns', 'お知らせの続き': 'continued', '昨日までとの比較': 'comparison', 'この記録について': 'about' };
    const sorted = [...(summary.citations || [])].sort((a, b) => a.sentenceIndex - b.sentenceIndex);
    const num = new Map(sorted.map((c, i) => [c, i + 1]));
    const bySentence = new Map();
    for (const c of sorted) {
      if (!bySentence.has(c.sentenceIndex)) bySentence.set(c.sentenceIndex, []);
      bySentence.get(c.sentenceIndex).push({ n: num.get(c), turnId: c.turnId });
    }
    const map = {};
    let cur = null; let li = 0;
    (summary.sentences || []).forEach((s, i) => {
      if (i === 1) { map.conclusion = [bySentence.get(i) || []]; return; }
      if (titles[s]) { cur = titles[s]; li = 0; map[cur] = []; return; }
      if (cur && s.startsWith('・')) { map[cur][li++] = bySentence.get(i) || []; }
    });
    return { map, bySentence };
  }
  function citeButtons(list) {
    return (list || []).map(c => el('button', { type: 'button', class: 'cite', title: 'もとの会話を見る', 'aria-label': `引用 ${c.n} の会話を見る`, onclick: () => openTurn(c.turnId) }, String(c.n)));
  }
  function sectionLines(lines, cites) {
    if (!lines || !lines.length) return el('p', {}, '・ありません。');
    return lines.map((t, i) => el('p', {}, '・' + t, citeButtons(cites && cites[i])));
  }

  function renderNotice(n, onDone) {
    const lv = LEVEL[n.level] || [n.level, 'c-no'];
    const acked = n.state === 'acked' || n.state === 'closed';
    const done = acked || n.falseAlarm;
    const sentTo = (n.steps || []).filter(s => s.sentAt).map(s => `${CHANNEL[s.channel] || s.channel} → ${memberName(s.memberId)}`);
    const ackStep = (n.steps || []).find(s => s.ackedAt);
    const metaBits = [hm(n.createdAt)];
    if (sentTo.length) metaBits.push(sentTo.join('、'));
    if (n.level === 'info') metaBits.push('返信不要');
    let deferred = null;
    if (n.state === 'deferred' || n.deferredReason) {
      deferred = n.deferredReason === 'daily_cap'
        ? 'お知らせが 1 日 5 件を超えたので送らず、夕方の「お知らせの続き」にまとめます。'
        : n.deferredReason === 'quiet_hours' ? '静かな時間帯なので、翌朝にお送りします。' : null;
    }
    const ack = async (falseAlarm, btn) => {
      btn.disabled = true;
      try {
        await api('POST', `/api/family/notices/${encodeURIComponent(n.id)}/ack`, falseAlarm ? { falseAlarm: true } : {});
        toast(falseAlarm ? '誤報として記録しました。判定の見直しに使います。' : '確認済みにしました。次の人へのお知らせを止めます。');
        onDone();
      } catch (e) { btn.disabled = false; report(e); }
    };
    const actions = [];
    const askAck = n.level !== 'info'; // お知らせ（L2）は返信不要。「確認した」「誤報だった」は出さない
    if (n.falseAlarm) actions.push(chip('誤報として記録しました', 'c-no'));
    else if (askAck) {
      if (acked) actions.push(chip(`確認済み${ackStep ? ' ' + hm(ackStep.ackedAt) : ''}`, 'c-done'));
      else actions.push(el('button', { type: 'button', class: 'btn', onclick: (e) => ack(false, e.currentTarget) }, '確認した'));
      actions.push(el('button', { type: 'button', class: 'btn ghost', onclick: (e) => ack(true, e.currentTarget) }, '誤報だった'));
    }
    if (n.turnId) actions.push(el('button', { type: 'button', class: 'link', onclick: () => openTurn(n.turnId) }, '会話を見る ›'));
    return el('div', { class: `notice ${n.level}${done ? ' done' : ''}`, id: 'notice-' + n.id },
      el('div', { class: 'nh' }, chip(lv[0], lv[1]), el('span', { class: 'meta' }, metaBits.filter(Boolean).join(' ・ '))),
      el('div', { class: 'nb' }, n.reason || ''),
      n.evidence && n.origin !== 'summary' ? el('div', { class: 'ev' }, '根拠: ', clip(/「/.test(n.evidence) ? n.evidence : `「${n.evidence}」`, 120)) : null,
      n.uncertain ? el('div', { class: 'flag' }, 'AI の判定が確かでないまま、早めにお送りしたものです。') : null,
      deferred ? el('div', { class: 'flag' }, deferred) : null,
      askAck && !done && (n.state === 'waiting' || n.state === 'escalated') ? el('div', { class: 'meta', style: 'margin:0 0 6px' }, 'まだ確認されていません。') : null,
      el('div', { class: 'btns' }, actions));
  }

  function clip(t, max) { return t.length > max ? t.slice(0, max) + '…' : t; }
  function turnRows(turns) {
    const list = [...turns].sort((a, b) => (toDate(a.promptedAt || a.repliedAt) || 0) - (toDate(b.promptedAt || b.repliedAt) || 0));
    return el('ul', { class: 'rows' }, list.map(t => {
      const c = t.classified || {};
      const subs = [];
      if (t.kind === 'followup') subs.push('痛みの聞き直しへのお返事です。');
      if (t.kind === 'l4') subs.push('至急のお知らせのあとのお返事です（判定はしません）。');
      if (c.uncertain) subs.push(`AI の判定に自信がありません${typeof c.confidence === 'number' ? `（確かさ ${c.confidence.toFixed(2)}）` : ''}。決めつけていません。`);
      if (c.status === 'unclear' && !c.uncertain) subs.push('このお返事からは判断できないので、決めつけていません。');
      return el('li', { class: 'clickable', onclick: () => openTurn(t.id), title: '会話を見る' },
        el('span', { class: 't' }, hm(t.promptedAt) || hm(t.repliedAt)),
        el('span', { class: 'q' }, el('b', {}, label(t.task)), t.replyText ? `「${t.replyText}」` : '（お返事なし）'),
        t.kind === 'l4' ? chip('判定しません', 'c-no') : statusChip(c.status),
        subs.length ? el('span', { class: 'sub' }, subs.join(' ')) : null);
    }));
  }

  function renderToday(p, r) {
    const day = r.day;
    const sm = day && day.summary;
    const sec = sm && sm.sections;
    const cm = sm ? citeMap(sm) : { map: {}, bySentence: new Map() };
    const notices = [...(r.notices || [])].sort((a, b) => (toDate(a.createdAt) || 0) - (toDate(b.createdAt) || 0));
    const turns = r.turns || [];
    const isToday = r.date === todayKey();
    const reload = () => loadTab(true);

    // 日付の行
    const nav = el('div', { class: 'daynav span' },
      el('button', { type: 'button', class: 'btn ghost sm', onclick: () => { S.date = shiftDay(r.date, -1); loadTab(); } }, '‹ 前の日'),
      el('span', { class: 'd' }, dayLabel(r.date), isToday ? ' ・ 今日' : ''),
      el('button', { type: 'button', class: 'btn ghost sm', disabled: isToday, onclick: () => { const nx = shiftDay(r.date, 1); S.date = nx >= todayKey() ? null : nx; loadTab(); } }, '次の日 ›'));

    if (!day) {
      p.replaceChildren(el('div', { class: 'grid' }, nav, el('div', { class: 'card' }, el('p', { class: 'empty' }, 'この日の記録はありません。'))));
      return;
    }

    // 結論
    const alerts = notices.filter(n => (n.level === 'check' || n.level === 'urgent') && !n.falseAlarm).length;
    const conclusionText = (sec && sec.conclusion && sec.conclusion[0]) || (sm && sm.sentences && sm.sentences[1])
      || (alerts ? `今日は ${alerts} 件、確認をお願いしたいことがあります。` : '今日の記録には、確認をお願いする返答はありませんでした。');
    const sentNote = sm ? (sm.sentAt ? ` ・ ${hm(sm.sentAt)} にお届け済み` : '') : (isToday ? ' ・ 18:00 にまとめてお届けします' : '');
    const conclusion = el('div', { class: 'card conclusion span' + (alerts ? '' : ' calm') },
      el('div', { class: 'meta' }, `今日の様子 ${dayLabel(r.date)}`, sentNote, day.isDayservice ? ' ・ デイの日' : ''),
      el('div', { class: 'big' }, conclusionText, citeButtons(cm.map.conclusion && cm.map.conclusion[0])),
      !sm && isToday ? el('p', { class: 'meta' }, 'ここまでの記録から出しています。夕方に「今日の様子」として確定します。') : null);

    // お返事の記録
    const repliesCard = el('div', { class: 'card report' },
      el('h3', {}, 'お返事の記録', el('span', { class: 'r' }, `声かけへのお返事 ${turns.length} 件`)),
      sec ? sectionLines(sec.replies, cm.map.replies) : null,
      turns.length
        ? el('details', { class: 'more', open: S.turnsOpen ?? !sec, ontoggle: (e) => { S.turnsOpen = e.currentTarget.open; } },
          el('summary', {}, `声かけごとの記録（${turns.length} 件）`), turnRows(turns))
        : (!sec ? el('p', { class: 'empty' }, 'まだお返事の記録はありません。') : null),
      el('p', { class: 'meta' }, '記録は「お母さまがそう答えた」ものです。実際にできたかは確かめていません。'));

    // 気になったこと
    let concernsBody;
    if (sec) concernsBody = sectionLines(sec.concerns, cm.map.concerns);
    else {
      const cs = notices.filter(n => CONCERN_ORIGINS.includes(n.origin) || ((n.level === 'check' || n.level === 'urgent') && !n.origin));
      concernsBody = cs.length
        ? cs.map(n => el('p', {}, `・${hm(n.createdAt)} ${n.evidence ? `「${n.evidence.replace(/^「|」$/g, '')}」とおっしゃいました。` : n.reason}`, n.turnId ? citeButtons([{ n: '会話', turnId: n.turnId }]) : null))
        : el('p', {}, '・ありません。');
    }
    const concernsCard = el('div', { class: 'card report' }, el('h3', {}, '気になったこと'), concernsBody);

    // 通知一覧
    const open = notices.filter(n => !(n.state === 'acked' || n.state === 'closed' || n.falseAlarm)).length;
    const noticesCard = el('div', { class: 'card', id: 'noticesCard' },
      el('h3', {}, '今日のお知らせ', el('span', { class: 'r' }, `${notices.length} 件${open ? `（未確認 ${open}）` : ''}`)),
      notices.length ? notices.map(n => renderNotice(n, reload)) : el('p', { class: 'empty' }, 'お知らせはありません。'));

    // お知らせの続き → 昨日までとの比較 → この記録について
    let tail;
    if (sec) {
      tail = el('div', { class: 'card report span' },
        el('h3', {}, 'お知らせの続き'), sectionLines(sec.continued, cm.map.continued),
        el('h3', { style: 'margin-top:12px' }, '昨日までとの比較'), sectionLines(sec.comparison, cm.map.comparison),
        el('h3', { style: 'margin-top:12px' }, 'この記録について'),
        (sec.about && sec.about.length ? sec.about : [ABOUT_DEFAULT]).map(t => el('p', { class: 'fine' }, '・' + t)));
    } else if (sm) {
      // 古い形の要約（sections なし）は本文をそのまま
      const lines = sm.sentences && sm.sentences.length ? sm.sentences : String(sm.text || '').split('\n');
      tail = el('div', { class: 'card report span' },
        el('h3', {}, '夕方の「今日の様子」', el('span', { class: 'r' }, '［番号］を押すと会話が出ます')),
        lines.map((s, i) => el('p', {}, s, citeButtons(cm.bySentence.get(i)))));
    } else {
      tail = el('div', { class: 'card report span' },
        el('h3', {}, 'お知らせの続き・昨日までとの比較'),
        el('p', { class: 'empty' }, isToday ? '18:00 の「今日の様子」でまとめます。' : 'この日の「今日の様子」はありません。'),
        el('h3', { style: 'margin-top:12px' }, 'この記録について'),
        el('p', { class: 'fine' }, '・' + ABOUT_DEFAULT));
    }

    p.replaceChildren(el('div', { class: 'grid two' },
      nav, conclusion, repliesCard,
      el('div', { class: 'stack' }, concernsCard, noticesCard),
      tail));
  }

  // ---------- 計画 ----------
  function renderPlan(p, r) {
    const head = el('div', { class: 'card span' },
      el('div', { class: 'inline', style: 'justify-content:space-between' },
        el('div', {}, el('div', { class: 'meta' }, r.date === todayKey() ? '今日の声かけ計画' : '声かけ計画'),
          el('div', { style: 'font-weight:700;font-size:17px' }, dayLabel(r.date), r.isDayservice == null ? '' : r.isDayservice ? ' ・ デイの日' : ' ・ 在宅の日')),
        r.planApproved ? chip(`承認済み ${md(r.planApproved.at)} ${hm(r.planApproved.at)}`, 'c-done') : chip('まだ承認していません', 'c-wait')),
      el('p', { class: 'meta' }, '中身を確かめて「この計画で承認する」を押してください。時刻や声かけの文を変えるときは「設定」の声かけ時刻の表で直します（次に作る計画から使います）。'));
    if (!r.plan) {
      p.replaceChildren(el('div', { class: 'grid' }, head, el('div', { class: 'card' }, el('p', { class: 'empty' }, 'この日の計画はありません。'))));
      return;
    }
    const groups = [['朝', (t) => t < '12:00'], ['昼', (t) => t >= '12:00' && t < '17:00'], ['夕方・夜', (t) => t >= '17:00']];
    const items = [...r.plan].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    const cards = groups.map(([name, f]) => {
      const list = items.filter(it => f(it.time || ''));
      if (!list.length) return null;
      return el('div', { class: 'card' }, el('h3', {}, name),
        el('ul', { class: 'rows plan' }, list.map(it => el('li', {},
          el('span', { class: 't' }, hhmm(it.time)),
          el('span', { class: 'q' }, label(it.task)),
          el('span', {}, it.recheckMinutes === 0 ? chip('1 回のみ', 'c-no') : typeof it.recheckMinutes === 'number' ? chip(`${it.recheckMinutes} 分後に聞き直し`, 'c-no') : null,
            it.escalate ? [' ', chip('家族へ', 'c-wait')] : null),
          it.text ? el('span', { class: 'say' }, `「${it.text}」`) : null))));
    });
    const approve = r.planApproved ? null : el('div', { class: 'span btns' },
      el('button', { type: 'button', class: 'btn', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { await api('POST', '/api/family/plan/approve', { date: r.date }); toast('計画を承認しました'); loadTab(true); } catch (er) { e.currentTarget.disabled = false; report(er); }
      } }, 'この計画で承認する'));
    p.replaceChildren(el('div', { class: 'grid two' }, head, cards, approve));
  }

  // ---------- 承認待ち ----------
  const PAYLOAD_LABEL = { recipient: '共有先', period: '期間', items: '項目', reason: '理由', consent: 'ご本人', from: 'いま', to: '変えたあと', field: '項目' };
  const EDITABLE = ['summary', 'text', 'message'];
  function approvalTitle(ap) {
    const pl = ap.payload || {};
    if (ap.kind === 'share_external') return `${RECIPIENT[pl.recipient] || pl.recipient || '外部'}へ、様子を共有`;
    return pl.title || pl.description || '設定の変更';
  }
  function fmtVal(v) {
    if (v == null) return '';
    if (Array.isArray(v)) return v.map(fmtVal).join('・');
    if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k}: ${fmtVal(x)}`).join('、');
    return String(v);
  }
  function renderApprovals(p, pending, decided) {
    S.apprCount = pending.length;
    renderHeader();
    const cards = pending.map(ap => {
      const pl = ap.payload || {};
      const editKey = EDITABLE.find(k => typeof pl[k] === 'string');
      const ta = editKey ? el('textarea', { class: 'tx', 'aria-label': '共有する文' }) : null;
      if (ta) ta.value = pl[editKey];
      const kv = Object.entries(pl).filter(([k]) => k !== editKey && k !== 'title' && k !== 'description' && !(ap.kind === 'share_external' && k === 'recipient'));
      const decide = async (decision, btn) => {
        btn.disabled = true;
        const body = { decision };
        if (decision === 'approved' && ta && ta.value.trim() && ta.value !== pl[editKey]) body.editedPayload = { ...pl, [editKey]: ta.value.trim() };
        try {
          await api('POST', `/api/family/approvals/${encodeURIComponent(ap.id)}`, body);
          toast(decision === 'approved' ? (body.editedPayload ? '直した文で承認しました（台帳に残ります）' : '承認しました（台帳に残ります）') : '見送りました');
          loadTab(true);
        } catch (e) {
          btn.disabled = false;
          if (e.status === 409) { toast('この依頼はすでに決まっています', true); loadTab(true); } else report(e);
        }
      };
      return el('div', { class: 'card' },
        el('div', { class: 'inline', style: 'justify-content:space-between' },
          chip(ap.kind === 'share_external' ? '共有の承認' : '設定変更の承認', 'c-wait'),
          el('span', { class: 'meta' }, `${md(ap.requestedAt)} ${hm(ap.requestedAt)} にお願い`)),
        el('h3', { style: 'margin-top:8px;color:var(--ink);font-size:15px' }, approvalTitle(ap)),
        kv.length ? el('dl', { class: 'kv' }, kv.map(([k, v]) => [el('dt', {}, PAYLOAD_LABEL[k] || k), el('dd', {}, fmtVal(v))])) : null,
        ta ? [el('label', { class: 'f' }, ap.kind === 'share_external' ? '共有する文（直してから承認できます）' : '内容（直してから承認できます）'), ta] : null,
        el('div', { class: 'btns', style: 'margin-top:8px' },
          el('button', { type: 'button', class: 'btn', onclick: (e) => decide('approved', e.currentTarget) }, ap.kind === 'share_external' ? '承認して共有' : '承認する'),
          el('button', { type: 'button', class: 'btn ghost', onclick: (e) => decide('rejected', e.currentTarget) }, '見送る')),
        ap.kind === 'share_external' ? el('p', { class: 'meta' }, '提出版では実際には送らず、行動台帳に「共有した」と残すだけです。') : null);
    });
    p.replaceChildren(el('div', { class: 'grid two' },
      cards.length ? cards : el('div', { class: 'card span' }, el('p', { class: 'empty' }, 'いま承認をお待ちしているものはありません。')),
      el('div', { class: 'card span' }, el('h3', {}, '決まったもの'),
        decided.length ? el('ul', { class: 'rows' }, decided.map(ap => el('li', {},
          el('span', { class: 't' }, md(ap.decidedAt || ap.requestedAt)),
          el('span', { class: 'q' }, approvalTitle(ap), ap.editedPayload ? el('span', { class: 'meta' }, '（ご家族が直して承認）') : null),
          ap.decision === 'approved' ? chip('承認', 'c-done') : chip('見送り', 'c-no'))))
          : el('p', { class: 'empty' }, 'まだありません。'))));
  }
  async function loadApprCount() {
    try { const r = await api('GET', '/api/family/approvals'); S.apprCount = (r.approvals || []).length; renderHeader(); } catch (e) { if (e.status !== 401) { /* 件数は出さないだけ */ } }
  }

  // ---------- 台帳 ----------
  const EVENT = {
    prompt_sent: '声かけ', reply_received: 'お返事を受け取った', turn_classified: 'お返事を判定', tool_call: '道具を使った',
    tool_blocked: '権限が無いので止めた', recheck_scheduled: '聞き直しを予約', notice_sent: 'お知らせを送った', notice_acked: '「確認した」が押された',
    notice_escalated: '確認が無いので次の方へ送った', approval_requested: '承認をお願いした', approval_decided: '承認・見送りが決まった',
    summary_sent: '今日の様子を送った', plan_proposed: '声かけ計画を作った', plan_approved: '計画が承認された', kill_switch_on: '「今すぐ止める」で止めた',
    kill_switch_off: '再開した', heartbeat_lost: 'iPad から応答が無い', health_incident: '不具合を見つけた', health_recovered: '不具合から戻った',
    followup_scheduled: '痛みの聞き直しを予約', followup_skipped: '聞き直しを省いた', l4_started: '至急の対応を始めた', l4_cleared: '至急の対応を終えた',
    settings_change: '設定を変えた', line_follow: 'LINE の登録', mode_changed: 'iPad のモードを変えた', utterance_received: '話しかけを受け取った', idle_chat_sent: 'ときたまの声かけ',
  };
  function actorChip(a) {
    if (a === 'agent') return el('span', { class: 'who w-agent' }, 'エージェント');
    if (a === 'ops') return el('span', { class: 'who w-ops' }, '運用');
    if (a === 'system') return el('span', { class: 'who w-sys' }, 'システム');
    if (typeof a === 'string' && a.startsWith('member:')) return el('span', { class: 'who w-fam' }, memberName(a.slice(7)));
    return el('span', { class: 'who w-sys' }, a || '—');
  }
  function describe(e) {
    const a = e.args || {};
    const res = e.result && typeof e.result === 'object' ? e.result : {};
    const t = a.task ? label(a.task) : '';
    switch (e.name) {
      case 'prompt_sent': return `${t}の${a.isReassurance ? '安心の一言' : a.followup ? '聞き直し' : a.isRecheck ? '声かけ（もう一度）' : '声かけ'}${a.text ? `「${a.text}」` : ''}`;
      case 'reply_received': return `${t}にお返事${a.reply ? `「${a.reply}」` : '（お返事なし）'}`;
      case 'turn_classified': return `${t}のお返事を「${(STATUS[res.status] || [res.status || '—'])[0]}」と判定（${res.by === 'llm' ? 'Gemini' : '規則'}${typeof res.confidence === 'number' && res.by === 'llm' ? `・確かさ ${res.confidence.toFixed(2)}` : ''}）`;
      case 'recheck_scheduled': return `${t}を${a.minutes ? ` ${a.minutes} 分後に` : ''}聞き直す予約${res.runAt ? `（${hm(res.runAt)}）` : ''}`;
      case 'followup_scheduled': return `${t}の聞き直しを予約${res.runAt ? `（${hm(res.runAt)}）` : ''}`;
      case 'notice_sent': return `${(LEVEL[a.level] || [a.level || ''])[0]}を${memberName(a.memberId)}へ（${CHANNEL[a.channel] || a.channel || ''}）${a.reason ? `: ${a.reason}` : ''}${res.delivered === false ? ' ※届きませんでした' : ''}`;
      case 'notice_escalated': return `確認が無いので次の方へ${a.reason ? `: ${a.reason}` : ''}`;
      case 'notice_acked': return a.falseAlarm ? '「誤報だった」が押された' : '「確認した」が押された';
      case 'tool_call': return a.name === 'share_external' ? `${RECIPIENT[a.recipient] || '外部'}への共有を実行（提出版では記録のみ）` : `${TOOL[a.name] || a.name || '道具'}を使った`;
      case 'tool_blocked': return `${TOOL[a.tool] || a.tool || '道具'}を頼まれたが止めた${res.reason ? `（${res.reason}）` : ''}`;
      case 'approval_decided': return `${a.kind === 'share_external' ? '共有' : '設定変更'}を${a.decision === 'approved' ? '承認' : '見送り'}${a.edited ? '（直して承認）' : ''}`;
      case 'settings_change': return `設定を変えた${Array.isArray(a.fields) ? `（${a.fields.join('・')}）` : ''}`;
      case 'health_incident': return `不具合を見つけた${a.kind ? `（${a.kind}）` : ''}${a.action ? ` → ${a.action}` : ''}`;
      case 'mode_changed': return `iPad を${a.mode === 'bath' ? 'お風呂' : '寝室'}モードに`;
      default: return EVENT[e.name] || e.name;
    }
  }
  const FILTERS = [
    ['all', 'すべて', () => true],
    ['prompt', '声かけ', (e) => e.kind === 'prompt' || e.name === 'recheck_scheduled' || e.name === 'followup_scheduled'],
    ['notice', 'お知らせ', (e) => e.kind === 'notice' || e.kind === 'summary'],
    ['judge', '判定', (e) => e.name === 'turn_classified'],
    ['block', '止めたこと', (e) => e.kind === 'blocked' || e.name === 'kill_switch_on'],
    ['approval', '承認・設定', (e) => e.kind === 'approval' || e.kind === 'plan' || e.name === 'settings_change' || e.name === 'mode_changed'],
    ['ops', '運用', (e) => e.actor === 'ops' || e.kind === 'health'],
  ];
  function renderLedger(p, r) {
    const entries = [...(r.entries || [])].sort((a, b) => (toDate(a.at) || 0) - (toDate(b.at) || 0));
    const cnt = (f) => entries.filter(f).length;
    const counts = [
      [cnt(e => e.name === 'prompt_sent' && !(e.args && e.args.isRecheck)), '声かけ'],
      [cnt(e => e.name === 'recheck_scheduled' || e.name === 'followup_scheduled'), '聞き直し'],
      [cnt(e => e.name === 'notice_sent'), 'お知らせ'],
      [cnt(e => e.name === 'tool_call' && e.args && e.args.name === 'share_external'), '外への共有'],
      [cnt(e => e.name === 'tool_blocked'), '止めたこと'],
    ];
    const listBox = el('div', { class: 'card' });
    const draw = () => {
      const f = (FILTERS.find(x => x[0] === S.ledgerFilter) || FILTERS[0])[2];
      const shown = entries.filter(f);
      listBox.replaceChildren(shown.length ? el('ul', { class: 'rows ledger' }, shown.map(e => el('li', {},
        el('span', { class: 't' }, hm(e.at)),
        el('span', { class: 'q' }, actorChip(e.actor), describe(e), ' ', el('span', { class: 'evn' }, e.name),
          e.turnId ? [' ', el('button', { type: 'button', class: 'link', onclick: () => openTurn(e.turnId) }, '会話 ›')] : null))))
        : el('p', { class: 'empty' }, 'この種類の記録はありません。'));
      $$('button', filters).forEach(b => b.classList.toggle('on', b.dataset.f === S.ledgerFilter));
    };
    const filters = el('div', { class: 'filters' }, FILTERS.map(([k, name]) => el('button', { type: 'button', 'data-f': k, onclick: () => { S.ledgerFilter = k; draw(); } }, name)));
    const isToday = r.date === todayKey();
    p.replaceChildren(el('div', { class: 'stack' },
      el('div', { class: 'card' },
        el('div', { class: 'daynav' },
          el('button', { type: 'button', class: 'btn ghost sm', onclick: () => { S.date = shiftDay(r.date, -1); loadTab(); } }, '‹ 前の日'),
          el('span', { class: 'd' }, `${dayLabel(r.date)}にエージェントがしたこと`),
          el('button', { type: 'button', class: 'btn ghost sm', disabled: isToday, onclick: () => { const nx = shiftDay(r.date, 1); S.date = nx >= todayKey() ? null : nx; loadTab(); } }, '次の日 ›')),
        el('div', { class: 'counts' }, counts.map(([n, name]) => el('div', {}, el('b', { style: name === '止めたこと' && n ? 'color:var(--red)' : null }, String(n)), el('span', {}, name)))),
        filters),
      listBox));
    draw();
  }

  // ---------- 設定 ----------
  const WORDING_LABEL = { diaper: 'おむつの呼び方', medicine: 'お薬の呼び方', medicinePlace: 'お薬の置き場所', medicineCount: 'お薬の数（例 2 錠）' };
  const WEEK = [['Sun', '日'], ['Mon', '月'], ['Tue', '火'], ['Wed', '水'], ['Thu', '木'], ['Fri', '金'], ['Sat', '土']];
  const PLACES = ['仕事', '買い物', '病院', '外出'];
  const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

  function planTable(items, taskKeys) {
    const box = el('div', { class: 'ptable-wrap' });
    const draw = () => {
      items.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
      const tbody = el('tbody', {}, items.map((it, i) => {
        const time = el('input', { class: 'tx sm', type: 'time', value: it.time || '', 'aria-label': '時刻', onchange: (e) => { it.time = e.target.value; } });
        const sel = el('select', { class: 'tx sm', 'aria-label': '声かけの種類', onchange: (e) => { it.task = e.target.value; } },
          taskKeys.map(k => el('option', { value: k, selected: k === it.task }, label(k))));
        const txt = el('input', { class: 'tx sm txtcell', value: it.text || '', placeholder: '（既定の文）', 'aria-label': '声かけの文', oninput: (e) => { it.text = e.target.value; } });
        const rc = el('input', { class: 'tx sm', type: 'number', min: '0', max: '180', value: it.recheckMinutes ?? '', placeholder: '—', 'aria-label': '聞き直すまでの分（0 は 1 回のみ）', oninput: (e) => { it.recheckMinutes = e.target.value === '' ? undefined : Number(e.target.value); } });
        const esc = el('input', { type: 'checkbox', checked: it.escalate === true, 'aria-label': '取れなければ家族へ', onchange: (e) => { it.escalate = e.target.checked; } });
        const del = el('button', { type: 'button', class: 'iconbtn', title: 'この行を外す', 'aria-label': 'この行を外す', onclick: () => { items.splice(i, 1); draw(); } }, '×');
        return el('tr', {}, el('td', {}, time), el('td', {}, sel), el('td', { class: 'txt' }, txt), el('td', {}, rc), el('td', {}, el('label', { class: 'meta' }, esc, ' 家族へ')), el('td', {}, del));
      }));
      box.replaceChildren(
        el('table', { class: 'ptable' },
          el('thead', {}, el('tr', {}, el('th', {}, '時刻'), el('th', {}, '声かけ'), el('th', {}, '文（空なら既定）'), el('th', {}, '聞き直し（分）'), el('th', {}, ''), el('th', {}, ''))),
          tbody),
        el('button', { type: 'button', class: 'btn ghost sm', style: 'margin-top:6px', onclick: () => {
          const last = items[items.length - 1];
          items.push({ time: last ? last.time : '08:00', task: taskKeys[0] });
          draw();
        } }, '＋ 行を足す'));
    };
    draw();
    return box;
  }

  function membersList(members) {
    const box = el('div');
    const draw = () => {
      box.replaceChildren(
        el('ul', { class: 'rows members' }, members.map((m, i) => el('li', {},
          el('span', { class: 'n' }, String(i + 1)),
          el('div', { class: 'q' },
            el('div', { class: 'two-in' },
              el('input', { class: 'tx sm', value: m.name || '', placeholder: '名前（例 長男）', 'aria-label': '名前', oninput: (e) => { m.name = e.target.value; } }),
              el('input', { class: 'tx sm', type: 'email', value: m.email || '', placeholder: 'メール（任意）', 'aria-label': 'メール', oninput: (e) => { m.email = e.target.value; } })),
            el('div', { class: 'inline meta', style: 'margin-top:4px' },
              m.lineLinked ? chip('LINE 登録済み', 'c-done') : chip('LINE 未登録', 'c-no'),
              '「確認した」を',
              el('input', { class: 'tx sm', type: 'number', min: '1', max: '240', value: m.waitMinutes ?? 10, style: 'width:64px', 'aria-label': '待つ分', oninput: (e) => { m.waitMinutes = Number(e.target.value); } }),
              '分待つ')),
          el('span', { class: 'btns' },
            el('button', { type: 'button', class: 'iconbtn', disabled: i === 0, 'aria-label': '順番を上げる', onclick: () => { [members[i - 1], members[i]] = [members[i], members[i - 1]]; draw(); } }, '▲'),
            el('button', { type: 'button', class: 'iconbtn', disabled: i === members.length - 1, 'aria-label': '順番を下げる', onclick: () => { [members[i + 1], members[i]] = [members[i], members[i + 1]]; draw(); } }, '▼'),
            el('button', { type: 'button', class: 'iconbtn', disabled: members.length <= 1, 'aria-label': '外す', onclick: () => { members.splice(i, 1); draw(); } }, '×'))))),
        el('button', { type: 'button', class: 'btn ghost sm', style: 'margin-top:6px', onclick: () => { members.push({ name: '', email: '', waitMinutes: 10 }); draw(); } }, '＋ 通知先を足す'));
    };
    draw();
    return box;
  }

  async function whereaboutsCard() {
    const r = await optional('GET', '/api/family/whereabouts');
    if (!r) return null; // まだ API が無い
    const w = r.whereabouts !== undefined ? r.whereabouts : (r.place !== undefined ? r : null);
    const curSay = r.say || (w && w.say) || '';
    let place = w && PLACES.includes(w.place) ? w.place : PLACES[0];
    const pills = el('div', { class: 'pills', role: 'group', 'aria-label': '行き先' });
    const drawPills = () => pills.replaceChildren(...PLACES.map(pl => el('button', { type: 'button', class: pl === place ? 'on' : '', onclick: () => { place = pl; drawPills(); } }, pl)));
    drawPills();
    const back = el('input', { class: 'tx', type: 'time', value: (w && w.backAt) || '18:00', 'aria-label': '帰る時刻' });
    const preview = el('div', { class: 'preview' });
    const showSay = (title, say) => preview.replaceChildren(el('small', {}, title), say || '（登録すると、ここに読み上げる文が出ます）');
    showSay(w ? 'いまの答え方' : 'まだ登録していません', curSay);
    const save = async (body, btn, msg) => {
      btn.disabled = true;
      try {
        const res = await optional('PUT', '/api/family/whereabouts', body);
        if (!res) { toast('居場所の登録は、まだ使えません', true); return; }
        const say = res.say || (res.whereabouts && res.whereabouts.say) || '';
        showSay('本人にはこう答えます', say);
        toast(msg);
      } catch (e) { report(e); } finally { btn.disabled = false; }
    };
    return el('div', { class: 'card span' },
      el('h3', {}, '居場所（お母さまに「どこに行ったの」と聞かれたときの答え）'),
      el('label', { class: 'f' }, 'いま、どこにいますか'), pills,
      el('div', { class: 'inline', style: 'margin-top:8px' }, el('label', { class: 'f' }, '帰る時刻'), back, el('span', { class: 'meta' }, '（分からなければ空のまま）')),
      preview,
      el('p', { class: 'meta' }, '何度聞かれても、同じ言い方でお答えします。帰る時刻を過ぎたら「もうすぐ帰ってきます」に変えます。'),
      el('div', { class: 'btns', style: 'margin-top:8px' },
        el('button', { type: 'button', class: 'btn', onclick: (e) => save({ place, backAt: back.value || null }, e.currentTarget, '居場所を登録しました') }, 'この内容で登録'),
        el('button', { type: 'button', class: 'btn ghost', onclick: (e) => save({ place: null, backAt: null }, e.currentTarget, '居場所を消しました') }, '帰ってきた（消す）')));
  }

  async function renderSettings(p) {
    const [st, whereCard] = await Promise.all([api('GET', '/api/family/settings'), whereaboutsCard().catch((e) => { report(e); return null; })]);
    applySettingsMeta(st);
    const f = JSON.parse(JSON.stringify(st));
    S.form = f;
    const taskKeys = st.taskKeys || Object.keys(S.labels);
    f.person = f.person || {};
    f.person.wording = f.person.wording || {};
    f.policy = f.policy || {};
    f.contacts = f.contacts || {};
    f.plan = f.plan || { weekday: { default: [], dayservice: [] }, dayserviceDays: [] };
    f.plan.weekday = f.plan.weekday || { default: [], dayservice: [] };
    f.plan.weekday.default = f.plan.weekday.default || [];
    f.plan.weekday.dayservice = f.plan.weekday.dayservice || [];
    f.plan.dayserviceDays = f.plan.dayserviceDays || [];
    f.members = f.members || [];

    const inp = (val, attrs) => el('input', { class: 'tx', value: val ?? '', ...attrs });
    const callName = inp(f.person.callName, { 'aria-label': 'お母さまの呼び方' });
    const wordingKeys = [...new Set([...Object.keys(WORDING_LABEL), ...Object.keys(f.person.wording)])];
    const wordingInputs = wordingKeys.map(k => [k, inp(f.person.wording[k], { 'aria-label': WORDING_LABEL[k] || k })]);

    const recheckMin = inp(f.policy.recheckMinutes ?? 15, { type: 'number', min: '1', max: '180', style: 'width:76px' });
    const maxRe = el('select', { class: 'tx', style: 'width:auto' }, [0, 1, 2, 3, 4, 5].map(n => el('option', { value: String(n), selected: n === (f.policy.maxRechecks ?? (f.policy.recheckOnce === false ? 0 : 2)) }, n === 0 ? '0 回（聞き直さない）' : `${n} 回（計 ${n + 1} 回）`)));
    const sleepFrom = inp((f.policy.sleepHours || {}).from || '21:30', { type: 'time' });
    const sleepTo = inp((f.policy.sleepHours || {}).to || '07:30', { type: 'time' });
    const quietFrom = inp((f.policy.quietHours || {}).from || '21:30', { type: 'time' });
    const quietTo = inp((f.policy.quietHours || {}).to || '07:30', { type: 'time' });

    const homePhone = inp(f.contacts.homePhone, { type: 'tel', placeholder: '例 03-0000-0000' });
    const nearName = inp(f.contacts.nearby && f.contacts.nearby.name, { placeholder: '例 佐藤さん' });
    const nearPhone = inp(f.contacts.nearby && f.contacts.nearby.phone, { type: 'tel', placeholder: '例 090-0000-0000' });

    const days = el('div', { class: 'days' }, WEEK.map(([k, j]) => el('label', {},
      el('input', { type: 'checkbox', checked: f.plan.dayserviceDays.includes(k), onchange: (e) => {
        const set = new Set(f.plan.dayserviceDays);
        if (e.target.checked) set.add(k); else set.delete(k);
        f.plan.dayserviceDays = WEEK.map(w => w[0]).filter(x => set.has(x));
      } }), j)));
    const pickup = inp(f.plan.pickupTime, { type: 'time', style: 'width:auto' });

    const saveBtn = el('button', { type: 'button', class: 'btn' }, '保存する');
    saveBtn.addEventListener('click', async () => {
      const err = (m) => { toast(m, true); };
      const cleanPlan = (items, name) => {
        const out = [];
        for (const it of items) {
          if (!HHMM_RE.test(it.time || '')) throw new Error(`${name}の時刻を「08:05」の形で入れてください`);
          const x = { time: it.time, task: it.task };
          if (it.text && it.text.trim()) x.text = it.text.trim();
          if (typeof it.recheckMinutes === 'number' && !Number.isNaN(it.recheckMinutes)) x.recheckMinutes = Math.round(it.recheckMinutes);
          if (typeof it.escalate === 'boolean') x.escalate = it.escalate;
          out.push(x);
        }
        return out.sort((a, b) => (a.time < b.time ? -1 : 1));
      };
      let body;
      try {
        if (!callName.value.trim()) throw new Error('お母さまの呼び方を入れてください');
        const wording = {};
        for (const [k, i] of wordingInputs) if (i.value.trim()) wording[k] = i.value.trim();
        for (const [a, b, name] of [[sleepFrom, sleepTo, '就寝時間帯'], [quietFrom, quietTo, '静かな時間']]) {
          if (!HHMM_RE.test(a.value) || !HHMM_RE.test(b.value)) throw new Error(`${name}の時刻を入れてください`);
        }
        const nn = nearName.value.trim(); const np = nearPhone.value.trim();
        if (Boolean(nn) !== Boolean(np)) throw new Error('近くの方は、名前と電話番号を両方入れてください（消すときは両方空に）');
        const members = f.members.map((m, i) => {
          if (!m.name || !m.name.trim()) throw new Error(`通知先 ${i + 1} 番の名前を入れてください`);
          const w = Number(m.waitMinutes);
          if (!Number.isInteger(w) || w < 1 || w > 240) throw new Error(`通知先 ${i + 1} 番の待つ分は 1〜240 で`);
          return { ...(m.id ? { id: m.id } : {}), name: m.name.trim(), order: i + 1, email: (m.email || '').trim(), waitMinutes: w };
        });
        if (!members.length) throw new Error('通知先を 1 人以上入れてください');
        const rm = Number(recheckMin.value);
        if (!Number.isInteger(rm) || rm < 1 || rm > 180) throw new Error('聞き直すまでの分は 1〜180 で');
        body = {
          person: { callName: callName.value.trim(), wording },
          plan: {
            weekday: { default: cleanPlan(f.plan.weekday.default, '在宅の日'), dayservice: cleanPlan(f.plan.weekday.dayservice, 'デイの日') },
            dayserviceDays: f.plan.dayserviceDays,
            ...(HHMM_RE.test(pickup.value) ? { pickupTime: pickup.value } : {}),
          },
          policy: { recheckMinutes: rm, maxRechecks: Number(maxRe.value), sleepHours: { from: sleepFrom.value, to: sleepTo.value }, quietHours: { from: quietFrom.value, to: quietTo.value } },
          contacts: { homePhone: homePhone.value.trim(), nearby: nn ? { name: nn, phone: np } : null },
          members,
        };
      } catch (e) { err(e.message); return; }
      saveBtn.disabled = true;
      try {
        await api('PUT', '/api/family/settings', body);
        toast('保存しました。変えた内容は行動台帳に残ります。');
        await loadTab(true);
      } catch (e) { report(e); } finally { saveBtn.disabled = false; }
    });

    const row = (lab, ...kids) => el('div', { class: 'inline', style: 'margin-top:6px' }, el('label', { class: 'f', style: 'min-width:9.5em' }, lab), ...kids);
    p.replaceChildren(el('div', { class: 'grid two' },
      whereCard,
      el('div', { class: 'card' }, el('h3', {}, '呼び方と言葉'),
        el('label', { class: 'f' }, 'お母さまの呼び方'), callName,
        wordingInputs.map(([k, i]) => [el('label', { class: 'f' }, WORDING_LABEL[k] || k), i]),
        el('p', { class: 'meta' }, '声かけの文の中で、この言葉に置きかえて話します。')),
      el('div', { class: 'card' }, el('h3', {}, '聞き直しと時間'),
        row('聞き直すまで', recheckMin, '分'),
        row('聞き直しの回数', maxRe),
        row('就寝時間帯', sleepFrom, '〜', sleepTo),
        row('静かな時間', quietFrom, '〜', quietTo),
        el('p', { class: 'meta' }, '就寝時間帯は声かけをしません。静かな時間のお知らせは翌朝にまとめます（「痛い」「転んだ」などは除く）。')),
      el('div', { class: 'card span' }, el('h3', {}, '声かけ時刻の表'),
        el('label', { class: 'f' }, 'デイサービスの曜日'), days,
        el('div', { class: 'inline', style: 'margin-top:6px' }, el('label', { class: 'f' }, 'お迎えの時刻'), pickup),
        el('label', { class: 'f', style: 'margin-top:12px;font-weight:700;color:var(--ink-2)' }, '在宅の日'), planTable(f.plan.weekday.default, taskKeys),
        el('label', { class: 'f', style: 'margin-top:12px;font-weight:700;color:var(--ink-2)' }, 'デイの日'), planTable(f.plan.weekday.dayservice, taskKeys),
        el('p', { class: 'meta' }, '「聞き直し」は、お返事が「まだ」や無いときに、もう一度聞くまでの分です（0 は 1 回だけ）。「家族へ」は、取れないときにご家族へお知らせします。')),
      el('div', { class: 'card' }, el('h3', {}, 'お知らせの順番'), membersList(f.members),
        el('p', { class: 'meta' }, 'LINE の登録は、LINE で友だち追加をすると決まります。')),
      el('div', { class: 'card' }, el('h3', {}, '連絡先（お知らせの文に書きます）'),
        el('label', { class: 'f' }, '家の電話'), homePhone,
        el('label', { class: 'f' }, '近くの方（見に行ってもらえる人）'), el('div', { class: 'two-in' }, nearName, nearPhone),
        el('p', { class: 'meta' }, '住所や持病はここに書きません。')),
      el('div', { class: 'span savebar' }, saveBtn, el('span', { class: 'meta' }, '保存した変更は行動台帳に残ります。')),
      el('div', { class: 'span', style: 'text-align:right' }, el('button', { type: 'button', class: 'btn ghost sm', onclick: logout }, 'ログアウト'))));
  }
  async function logout() {
    try { await api('POST', '/api/family/logout', {}); } catch { /* 無視 */ }
    S.started = false;
    clearInterval(liveTimer);
    showLogin();
  }
  function applySettingsMeta(st) {
    if (!st) return;
    S.settings = st;
    S.labels = { ...S.labels, ...(st.taskLabels || {}) };
    S.members = Object.fromEntries((st.members || []).map(m => [m.id, m.name]));
    if (typeof st.killSwitch === 'boolean') S.killSwitch = st.killSwitch;
    renderHeader();
  }

  // ---------- できること ----------
  const CAP_CLASS = { auto: 'c-done', auto_with_evidence: 'c-wait', after_approval: 'c-unc', never: 'c-red' };
  function renderCaps(p, r) {
    p.replaceChildren(el('div', { class: 'card' },
      el('h3', { style: 'color:var(--ink);font-size:16px' }, r.title || 'できること・できないこと'),
      r.note ? el('p', { class: 'meta', style: 'margin:0 0 6px' }, r.note) : null,
      (r.levels || []).map(l => el('div', { class: 'lv' },
        el('h4', {}, chip(l.label, CAP_CLASS[l.key] || 'c-no')),
        l.description ? el('p', {}, l.description) : null,
        el('ul', {}, (l.examples || []).map(x => el('li', {}, x))))),
      S.modeAvail ? el('div', { class: 'lv' }, el('h4', {}, 'お風呂モードについて'), el('p', {}, '体を洗うことと歯磨きを促すだけです。安全の確認はしません。転んだことなどは分かりません。')) : null,
      r.privacy && r.privacy.length ? el('div', { class: 'lv' }, el('h4', {}, '記録の扱い'), el('ul', {}, r.privacy.map(x => el('li', {}, x)), el('li', {}, 'カメラは使いません。'))) : null,
      r.stopSwitch ? el('div', { class: 'lv' }, el('h4', {}, '今すぐ止める'), el('p', {}, r.stopSwitch)) : null));
  }

  // ---------- 読み込み ----------
  const LOADERS = {
    async today(p) {
      const r = await api('GET', '/api/family/today', undefined, { query: { date: S.date || '' } });
      S.labels = { ...S.labels, ...(r.taskLabels || {}) };
      if (r.date === todayKey()) statusFromToday(r);
      renderToday(p, r);
    },
    async plan(p) {
      const r = await api('GET', '/api/family/plan', undefined, { query: { date: S.date || '' } });
      S.labels = { ...S.labels, ...(r.taskLabels || {}) };
      renderPlan(p, r);
    },
    async appr(p) {
      const [pend, all] = await Promise.all([api('GET', '/api/family/approvals'), api('GET', '/api/family/approvals', undefined, { query: { all: '1' } })]);
      const decided = (all.approvals || []).filter(a => a.decision).sort((a, b) => (toDate(b.decidedAt) || 0) - (toDate(a.decidedAt) || 0)).slice(0, 20);
      renderApprovals(p, pend.approvals || [], decided);
    },
    async ledger(p) {
      const r = await api('GET', '/api/family/ledger', undefined, { query: { date: S.date || '' } });
      renderLedger(p, r);
    },
    async settings(p) { await renderSettings(p); },
    async caps(p) { renderCaps(p, await api('GET', '/api/family/capabilities')); },
  };

  // 1 分ごとに L4・停止・モード・承認待ちの数を見直す（今日タブなら中身も）
  let liveTimer = null;
  async function refreshLive() {
    if (document.visibilityState !== 'visible' || !S.started) return;
    if ($$('.sheet-bg.on').length) return;
    try {
      if (S.tab === 'today' && !S.date) await loadTab(true);
      else statusFromToday(await api('GET', '/api/family/today'));
      await Promise.all([S.modeAvail ? loadMode() : Promise.resolve(), loadApprCount()]);
    } catch { /* 次の回に任せる */ }
  }

  async function start() {
    S.started = true;
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    renderHeader();
    const first = location.hash.slice(1);
    const tab = TABS.includes(first) ? first : 'today';
    // 名前と通知先（台帳・通知の「誰へ」に使う）、モード、承認待ちの数
    const meta = Promise.all([
      api('GET', '/api/family/settings').then(applySettingsMeta).catch(report),
      loadMode().catch(() => { /* モードは無くても動く */ }),
      loadApprCount(),
    ]);
    if (tab !== 'today') api('GET', '/api/family/today').then(statusFromToday).catch(() => { /* 次の回に */ });
    await meta;
    await showTab(tab);
    clearInterval(liveTimer);
    liveTimer = setInterval(refreshLive, 60000);
  }

  (async () => {
    try {
      const s = await api('GET', '/api/family/session', undefined, { login: true });
      if (s && s.authed) start();
      else showLogin(s && s.passphraseConfigured === false ? 'サーバー側で合言葉が設定されていません。' : '');
    } catch (e) { showLogin(e.message); }
  })();
})();
