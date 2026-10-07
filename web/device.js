// 見守り（母側）— iPad の顔画面。本人は操作しない。端末は判断せず、サーバーの say と expression をそのまま出す。
// API: src/api/README.md 1 節（heartbeat / next-prompt / reply）と docs/02 §11（mode / utterance、next-prompt の mode）。
// mode・utterance が未実装（404）の間は、その機能だけ止めて動き続ける。
// 本人の発話の全文は console に出さない（長さだけ）。外部ライブラリなし、ES2020。
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 定数
  // ---------------------------------------------------------------------------
  var LS_KEY = 'mimamori.device';
  var APP_VERSION = 'device-web-0.1.0';
  var TZ = 'Asia/Tokyo';
  var HEARTBEAT_MS = 60000;
  var HEARTBEAT_RETRY_MS = 15000;     // つながらないときは早めに試す
  var POLL_MS = 5000;
  var POLL_AUTH_MS = 30000;           // トークン違いのときは間をあける
  var NO_ANSWER_MS = 60000;           // 無音 60 秒で noAnswer を 1 回送る
  var IDLE_ERROR_RETRY_MS = 10000;    // 合間の聞き取りがエラーのときは 10 秒おく
  var IDLE_RESTART_MS = 300;
  var LINGER_MS = 20000;              // AI の一言を出したままにする時間
  var LINGER_NOREPLY_MS = 60000;      // 安心文など返事を待たない声かけ
  var REST_VIEW_MS = 60000;           // 「少し休みますね」を出しておく時間（その後は時計）
  var API_RETRY_PROBE_MS = 10 * 60000; // 404 だった新 API をもう一度試すまで
  var DRAWER_AUTOCLOSE_MS = 30000;
  var PENDING_MAX_AGE_MS = 10 * 60000;

  // 次の声かけ・最後のやりとりに出す名前（src/types.ts の TASK_LABELS に合わせる）
  var TASK_LABELS = {
    greeting: '起床の挨拶', diaper: 'おむつ交換', teeth: '歯磨き', face: '洗顔', dress: '着替え',
    belongings: '持ち物', pickup: 'お迎え', lunch: '昼食', water: '水分', return: '帰宅',
    dinner: '夕食', medicine: '服薬', bedtime: '就寝準備', bath: 'お風呂', talk: '会話',
  };

  // ---- 顔（紙芝居 01 の線の絵）。expression: smile / listen / think / worry ----
  var SKIN = '<circle cx="100" cy="104" r="88" fill="var(--skin)"/>';
  var CHEEKS = '<circle cx="52" cy="122" r="11" fill="var(--cheek)" opacity=".55"/><circle cx="148" cy="122" r="11" fill="var(--cheek)" opacity=".55"/>';
  var S = 'stroke="var(--eye)" stroke-width="6" stroke-linecap="round" fill="none"';
  var FACES = {
    smile: SKIN + CHEEKS +
      '<path d="M58 96 q12 -14 24 0" ' + S + '/><path d="M118 96 q12 -14 24 0" ' + S + '/>' +
      '<path d="M72 128 q28 26 56 0" ' + S + '/>',
    listen: SKIN + CHEEKS +
      '<circle cx="70" cy="94" r="8" fill="var(--eye)"/><circle cx="130" cy="94" r="8" fill="var(--eye)"/>' +
      '<path d="M60 74 q10 -6 20 -2" ' + S + ' stroke-width="4"/><path d="M120 72 q10 -4 20 2" ' + S + ' stroke-width="4"/>' +
      '<path d="M88 132 q12 8 24 0" ' + S + '/>' +
      '<path d="M186 86 q8 18 0 36" ' + S + ' stroke="#7fb9a6" stroke-width="5"/><path d="M196 76 q14 28 0 56" ' + S + ' stroke="#a9d3c5" stroke-width="5"/>',
    think: SKIN + CHEEKS +
      '<circle cx="72" cy="94" r="7" fill="var(--eye)"/><circle cx="132" cy="94" r="7" fill="var(--eye)"/>' +
      '<circle cx="75" cy="91" r="2.4" fill="#fff"/><circle cx="135" cy="91" r="2.4" fill="#fff"/>' +
      '<path d="M58 70 q12 -10 26 -4" ' + S + ' stroke-width="4"/><path d="M118 76 h24" ' + S + ' stroke-width="4"/>' +
      '<path d="M82 134 q9 -5 18 0 q9 5 18 0" ' + S + '/>' +
      '<circle cx="168" cy="40" r="6" fill="#d8ccb8"/><circle cx="182" cy="24" r="8" fill="#d8ccb8"/>',
    worry: SKIN +
      '<circle cx="72" cy="98" r="7" fill="var(--eye)"/><circle cx="128" cy="98" r="7" fill="var(--eye)"/>' +
      '<path d="M56 82 L82 72" ' + S + ' stroke-width="4"/><path d="M144 82 L118 72" ' + S + ' stroke-width="4"/>' +
      '<path d="M78 140 q22 -12 44 0" ' + S + '/>',
  };

  var $ = function (id) { return document.getElementById(id); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // 記録は出来事の名前と長さだけ（本人の発話の中身は出さない）
  function dbg(event, info) {
    try { console.info('[device]', event, info || ''); } catch (e) { /* 無視 */ }
  }

  // ---------------------------------------------------------------------------
  // 端末の設定（localStorage の mimamori.device。?hh=&token= でも受け取る）
  // ---------------------------------------------------------------------------
  function loadCfg() {
    try {
      var v = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (v && typeof v.hh === 'string' && typeof v.token === 'string' && v.hh && v.token) return { hh: v.hh, token: v.token };
    } catch (e) { /* 保存できない環境でも動く */ }
    return null;
  }
  function saveCfg(c) {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ hh: c.hh, token: c.token })); } catch (e) { /* 保存できなくてもこの画面の間は使う */ }
  }

  var cfg = loadCfg();
  var qs = new URLSearchParams(location.search);
  var urlHh = (qs.get('hh') || '').trim();
  var urlToken = (qs.get('token') || '').trim();
  if (urlToken) {
    cfg = { hh: urlHh || (cfg && cfg.hh) || 'hh_main', token: urlToken };
    saveCfg(cfg);
  }
  if (urlHh || urlToken) {
    // トークンを URL に残さない（履歴・画面に出さない）
    qs.delete('token'); qs.delete('hh');
    var rest = qs.toString();
    try { history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash); } catch (e) { /* 無視 */ }
  }
  var forceText = qs.get('text') === '1';

  // ---------------------------------------------------------------------------
  // 状態
  // ---------------------------------------------------------------------------
  var st = {
    started: false,
    epoch: 0,                 // 止めたら増やす。非同期の続きが古くなったら捨てる
    mode: 'bedroom',
    modeSince: null,
    bath: null,
    bathTeethDone: false,
    whereaboutsSay: null,
    modeApi: 'unknown',       // unknown | ok | missing
    modeMissingAt: 0,
    utterApi: 'unknown',
    utterMissingAt: 0,
    killSwitch: false,
    localPause: false,
    busy: false,              // 声かけ・返事・発話の処理中
    current: null,            // 返事を待っている声かけ
    pending: null,            // 処理中に届いた声かけ
    seen: [],
    nextPrompt: null,
    conn: 'connecting',       // connecting | ok | offline | auth
    mic: 'off',               // off | on | blocked | unsupported
    rec: null,
    recKind: null,            // reply | idle
    speaking: false,
    textMode: forceText,
    replyDeadline: null,
    lingerTimer: null,
    restTimer: null,
    idleTimer: null,
    hbTimer: null,
    pollTimer: null,
    drawerTimer: null,
    flash: '',
    flashTimer: null,
    last: null,               // { at, label } 最後のやりとり（ご家族用。中身は持たない）
    wake: null,
    battery: null,
  };

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------
  function ApiError(status, message) { this.status = status; this.message = message; }

  function api(method, path, body, timeoutMs) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 20000) : null;
    var opts = {
      method: method,
      headers: { 'Content-Type': 'application/json', 'X-Device-Token': cfg ? cfg.token : '' },
      cache: 'no-store',
    };
    if (body) opts.body = JSON.stringify(body);
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(path, opts).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.json().catch(function () { return null; }).then(function (data) {
        if (res.ok) { setConn('ok'); return data || {}; }
        if (res.status === 401 || res.status === 403) setConn('auth');
        else if (res.status >= 500) setConn('offline');
        else setConn('ok'); // 400・404 はサーバーには届いている
        throw new ApiError(res.status, (data && data.error) || res.statusText || String(res.status));
      });
    }, function () {
      if (timer) clearTimeout(timer);
      setConn('offline');
      throw new ApiError(0, 'network');
    });
  }

  function hhParam() { return encodeURIComponent(cfg ? cfg.hh : ''); }
  function apiUsable(kind) {
    var s = kind === 'mode' ? st.modeApi : st.utterApi;
    var at = kind === 'mode' ? st.modeMissingAt : st.utterMissingAt;
    return s !== 'missing' || Date.now() - at > API_RETRY_PROBE_MS;
  }
  function markMissing(kind) {
    if (kind === 'mode') { st.modeApi = 'missing'; st.modeMissingAt = Date.now(); }
    else { st.utterApi = 'missing'; st.utterMissingAt = Date.now(); }
    dbg('api_missing', kind);
  }

  // ---------------------------------------------------------------------------
  // 時計
  // ---------------------------------------------------------------------------
  var fmtParts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: TZ, month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
  });
  function jstParts(d) {
    var o = {};
    fmtParts.formatToParts(d).forEach(function (p) { o[p.type] = p.value; });
    return { month: o.month, day: o.day, wd: o.weekday, hour: Number(o.hour), minute: o.minute };
  }
  function hm(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var p = jstParts(d);
    return p.hour + ':' + p.minute;
  }
  // HH:MM（JST、時も 2 桁）
  function hhmm(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var p = jstParts(d);
    return (p.hour < 10 ? '0' : '') + p.hour + ':' + p.minute;
  }
  function timeWord(h) {
    if (h < 4) return '夜です';
    if (h < 10) return '朝です';
    if (h < 12) return '午前中です';
    if (h < 14) return 'お昼です';
    if (h < 17) return '午後です';
    if (h < 19) return '夕方です';
    return '夜です';
  }
  function tickClock() {
    var p = jstParts(new Date());
    var time = p.hour + ':' + p.minute;
    $('clockSmallDate').textContent = p.month + '月' + p.day + '日（' + p.wd + '）';
    $('clockSmallTime').textContent = time;
    $('bigDay').textContent = p.month + '月' + p.day + '日　' + p.wd + '曜日';
    $('bigClock').textContent = time;
    $('clockSoft').textContent = st.mode === 'bath' ? 'ゆっくりどうぞ' : timeWord(p.hour);
  }

  // ---------------------------------------------------------------------------
  // 画面
  // ---------------------------------------------------------------------------
  function setFace(name) {
    var key = FACES[name] ? name : 'smile';
    var f = $('face');
    f.innerHTML = FACES[key];
    f.classList.toggle('tilt', key === 'listen');
    f.setAttribute('data-expression', key);
  }

  // 文ごとに改行して大きく出す（中身は textContent。HTML として解釈しない）
  function renderSay(el, text) {
    el.textContent = '';
    var parts = String(text).match(/[^。？！?!\n]+[。？！?!]*|\n/g) || [String(text)];
    parts.forEach(function (s) {
      s = s.trim();
      if (!s) return;
      var span = document.createElement('span');
      span.textContent = s;
      el.appendChild(span);
    });
    var n = String(text).length;
    var bath = st.mode === 'bath';
    el.classList.remove('long', 'longer', 'longest');
    if (bath) {
      if (n > 50) el.classList.add('longest');
      else if (n > 30) el.classList.add('longer');
      else if (n > 18) el.classList.add('long');
    } else {
      if (n > 80) el.classList.add('longer');
      else if (n > 48) el.classList.add('long');
    }
  }

  var view = { reply: null, replyLabel: 'お返事', say: null, dim: false, sub: null, listening: false };

  function showIdle() {
    cancelLinger();
    view = { reply: null, replyLabel: 'お返事', say: null, dim: false, sub: null, listening: false };
    document.body.classList.add('idle');
    $('clockView').hidden = false;
    $('replyBubble').hidden = true;
    $('sayText').hidden = true;
    $('subText').hidden = true;
    $('listenMark').hidden = true;
    setFace('smile');
  }

  function showTalk(v) {
    view = {
      reply: v.reply || null, replyLabel: v.replyLabel || 'お返事', say: v.say || null,
      dim: !!v.dim, sub: v.sub || null, listening: !!v.listening,
    };
    redrawTalk();
  }
  function redrawTalk() {
    var v = view;
    if (!v.reply && !v.say && !v.sub && !v.listening) { showIdle(); return; }
    document.body.classList.remove('idle');
    $('clockView').hidden = true;
    $('replyBubble').hidden = !v.reply;
    if (v.reply) {
      $('replyBubble').querySelector('small').textContent = v.replyLabel;
      $('replyText').textContent = '「' + v.reply + '」';
    }
    var say = $('sayText');
    say.hidden = !v.say;
    if (v.say) { renderSay(say, v.say); say.classList.toggle('dim', v.dim); }
    $('subText').hidden = !v.sub;
    $('subText').textContent = v.sub || '';
    $('listenMark').hidden = !v.listening;
    $('listenLabel').textContent = st.mode === 'bath' ? '聞いています' : 'お返事を聞いています';
  }

  function cancelLinger() { if (st.lingerTimer) { clearTimeout(st.lingerTimer); st.lingerTimer = null; } }
  function lingerThenIdle(ms) {
    cancelLinger();
    st.lingerTimer = setTimeout(function () { st.lingerTimer = null; if (!st.busy && !isHalted()) showIdle(); }, ms);
  }

  function setConn(c) { if (st.conn !== c) { st.conn = c; renderState(); } }
  function setMic(m) { if (st.mic !== m) { st.mic = m; renderState(); } }
  function flash(msg) {
    st.flash = msg; renderState();
    if (st.flashTimer) clearTimeout(st.flashTimer);
    st.flashTimer = setTimeout(function () { st.flash = ''; renderState(); }, 6000);
  }

  function renderState() {
    var c = $('stConn');
    c.className = '';
    if (st.conn === 'ok') { c.textContent = '● つながっています'; c.className = 'on'; }
    else if (st.conn === 'offline') { c.textContent = '● つながっていません（もう一度つなぎます）'; c.className = 'bad'; }
    else if (st.conn === 'auth') { c.textContent = '● 端末の登録を確認してください'; c.className = 'bad'; }
    else c.textContent = '● つないでいます';

    var m = $('stMic');
    m.className = '';
    if (st.killSwitch) m.textContent = '● 停止中（ご家族の画面で止めています）';
    else if (st.localPause) m.textContent = '● いったん止めています';
    else if (st.mic === 'on') { m.textContent = 'マイク: 聞いています'; m.className = 'on'; }
    else if (st.mic === 'blocked') m.textContent = 'マイク: 使えません（文字で入れられます）';
    else if (st.mic === 'unsupported') m.textContent = 'マイク: このブラウザでは使えません';
    else m.textContent = 'マイク: 聞いていません';
    if (st.killSwitch || st.localPause) m.className = 'bad';

    var md = $('stMode');
    md.textContent = st.flash || modeLabel();
    md.className = st.flash ? 'bad' : '';
  }

  function modeLabel() {
    if (st.mode === 'bath') return 'お風呂モード' + (st.modeSince ? '（' + hm(st.modeSince) + ' から）' : '');
    return '寝室モード';
  }

  function renderModeButtons() {
    $('modeBedroom').classList.toggle('on', st.mode === 'bedroom');
    $('modeBath').classList.toggle('on', st.mode === 'bath');
    $('modeBedroom').setAttribute('aria-pressed', String(st.mode === 'bedroom'));
    $('modeBath').setAttribute('aria-pressed', String(st.mode === 'bath'));
    var missing = !apiUsable('mode');
    ['modeBedroom', 'modeBath'].forEach(function (id) {
      $(id).disabled = missing;
      $(id).title = missing ? 'サーバーがまだモードの切り替えに対応していません' : '';
    });
  }

  function renderPause() {
    var b = $('pauseBtn');
    if (st.killSwitch) {
      b.textContent = '停止中';
      b.disabled = true;
      b.title = 'ご家族の画面の「今すぐ止める」で止まっています。再開もご家族の画面から行ってください';
    } else {
      b.textContent = st.localPause ? '再開する' : 'いったん止める';
      b.disabled = false;
      b.title = st.localPause ? '' : 'この iPad の読み上げと聞き取りだけを止めます';
    }
    b.classList.toggle('on', st.localPause);
    $('pausedBand').hidden = !isHalted();
  }

  function renderBath() {
    var b = st.bath || {};
    // 「上がりましたか？」まで来たら、それより前で声をかけた段は済んだ印にする
    var exitOn = !!(b.exitAskedAt || b.exitDoneAt);
    var wash = b.washDoneAt || (exitOn && b.washAskedAt) ? 'done' : (b.washAskedAt ? 'now' : '');
    var teeth = st.bathTeethDone || (exitOn && b.teethAskedAt) ? 'done' : (b.teethAskedAt ? 'now' : '');
    var exit = b.exitDoneAt ? 'done' : (b.exitAskedAt ? 'now' : '');
    $('stepWash').className = 'step ' + wash;
    $('stepTeeth').className = 'step ' + teeth;
    $('stepExit').className = 'step ' + exit;
  }

  function renderNext() {
    var n = st.nextPrompt;
    var text = '';
    // 寝室モードだけ。もう時刻を過ぎたもの（いま話している声かけ）は出さない
    if (st.mode === 'bedroom' && n && n.at && !isHalted() && new Date(n.at).getTime() > Date.now()) {
      var label = TASK_LABELS[n.task] || '';
      text = '次は ' + hhmm(n.at) + ' に ' + (label ? label : '声をかけます');
    }
    $('nextLine').textContent = text;
    renderDrawer();
  }

  function renderDrawer() {
    var n = st.nextPrompt;
    if (n && n.at && new Date(n.at).getTime() <= Date.now()) n = null;
    $('drNext').textContent = n && n.at ? hm(n.at) + '　' + (TASK_LABELS[n.task] || n.task || '') : '今のところありません';
    if (!apiUsable('mode')) $('drWhere').textContent = '（サーバーがまだ対応していません）';
    else $('drWhere').textContent = st.whereaboutsSay ? '「' + st.whereaboutsSay + '」と答えます' : '（まだ登録がありません。ご家族の画面で登録できます）';
    $('drMode').textContent = modeLabel() + (st.mode === 'bath' ? '。この iPad は安全の確認をしません。' : '');
    $('drLast').textContent = st.last ? hm(st.last.at) + '　' + st.last.label : 'まだありません';
    $('drText').textContent = st.textMode ? '文字で入れる欄を隠す' : '文字で入れる欄を出す';
  }

  function renderTextbar() {
    var show = st.started && st.textMode && !isHalted();
    $('textbar').hidden = !show;
    if (!show) return;
    var awaiting = !!(st.current && !st.current._done && !st.speaking);
    $('textInput').placeholder = awaiting ? 'お返事を文字で入れる' : '話しかける内容を文字で入れる（例: ○○はどこ？）';
    $('textNoAnswer').disabled = !awaiting;
    var canIdle = !st.current && !st.busy && apiUsable('utter');
    $('textSend').disabled = !(awaiting || canIdle);
  }

  function renderAll() {
    tickClock(); renderState(); renderModeButtons(); renderPause(); renderBath(); renderNext(); renderTextbar();
  }

  // ---------------------------------------------------------------------------
  // 音声（読み上げ）
  // ---------------------------------------------------------------------------
  var audioEl = new Audio();
  audioEl.preload = 'auto';
  var keepUtterance = null; // Chrome で onend が来なくなるのを防ぐため参照を持つ

  function silentWavUrl() {
    var n = 800, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    var w = function (o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 2, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  // 「はじめる」のタップの中で呼ぶ（Safari はユーザー操作なしに音を出せないため）
  function unlockAudio() {
    try {
      if ('speechSynthesis' in window) {
        var u = new SpeechSynthesisUtterance('');
        u.lang = 'ja-JP'; u.volume = 0;
        speechSynthesis.speak(u);
      }
    } catch (e) { /* 無視 */ }
    try {
      audioEl.src = silentWavUrl();
      var p = audioEl.play();
      if (p && p.catch) p.catch(function () { /* 無視 */ });
    } catch (e) { /* 無視 */ }
  }

  function jaVoice() {
    try {
      var vs = speechSynthesis.getVoices() || [];
      return vs.find(function (v) { return v.lang === 'ja-JP' && v.localService; }) ||
        vs.find(function (v) { return /^ja/i.test(v.lang); }) || null;
    } catch (e) { return null; }
  }

  function synthSpeak(text) {
    return new Promise(function (resolve) {
      if (!('speechSynthesis' in window)) { resolve(); return; }
      try {
        if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
        var u = new SpeechSynthesisUtterance(text);
        u.lang = 'ja-JP';
        u.rate = 0.95;
        var v = jaVoice();
        if (v) u.voice = v;
        u.onend = function () { resolve(); };
        u.onerror = function () { resolve(); };
        keepUtterance = u;
        speechSynthesis.speak(u);
      } catch (e) { resolve(); }
    });
  }

  function audioSpeak(text, url) {
    return new Promise(function (resolve) {
      var done = false;
      var fallback = function () { if (done) return; done = true; cleanup(); dbg('tts_audio_failed'); synthSpeak(text).then(resolve); };
      var ok = function () { if (done) return; done = true; cleanup(); resolve(); };
      var cleanup = function () { audioEl.onended = null; audioEl.onerror = null; };
      audioEl.onended = ok;
      audioEl.onerror = fallback;
      try {
        audioEl.src = url;
        var p = audioEl.play();
        if (p && p.catch) p.catch(fallback);
      } catch (e) { fallback(); }
    });
  }

  function stopSpeech() {
    try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch (e) { /* 無視 */ }
    try { audioEl.onended = null; audioEl.onerror = null; audioEl.pause(); } catch (e) { /* 無視 */ }
  }

  // 読み上げ。終わらない環境でも先へ進めるよう、長さに応じた上限で打ち切る。
  // 読み上げ中は聞き取りを止める（自分の声を拾わないように）
  function speak(text, ttsUrl) {
    if (!text) return Promise.resolve();
    stopRecognition();
    st.speaking = true;
    renderTextbar();
    var limitMs = 6000 + String(text).length * 400;
    var timedOut = false;
    var main = ttsUrl ? audioSpeak(text, ttsUrl) : synthSpeak(text);
    return Promise.race([main, sleep(limitMs).then(function () { timedOut = true; })]).then(function () {
      if (timedOut) stopSpeech();
      return sleep(400); // 残響を拾わないよう少し待つ
    }).then(function () {
      st.speaking = false;
      renderTextbar();
    });
  }

  // ---------------------------------------------------------------------------
  // 聞き取り（webkitSpeechRecognition）
  // ---------------------------------------------------------------------------
  function recognitionSupported() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
  function micUsable() { return st.mic !== 'blocked' && st.mic !== 'unsupported' && recognitionSupported(); }

  function newRecognition() {
    var R = window.SpeechRecognition || window.webkitSpeechRecognition;
    var r = new R();
    r.lang = 'ja-JP';
    r.continuous = false;
    r.interimResults = true;
    r.maxAlternatives = 1;
    return r;
  }

  function collect(ev) {
    var fin = '', interim = '';
    for (var i = 0; i < ev.results.length; i++) {
      var res = ev.results[i];
      if (res.isFinal) fin += res[0].transcript; else interim += res[0].transcript;
    }
    return { fin: fin.trim(), interim: interim.trim() };
  }

  function stopRecognition() {
    var r = st.rec;
    st.rec = null; st.recKind = null;
    if (r) {
      r.onresult = null; r.onerror = null; r.onend = null; r.onstart = null;
      try { r.abort(); } catch (e) { /* 無視 */ }
    }
    if (st.idleTimer) { clearTimeout(st.idleTimer); st.idleTimer = null; }
    if (st.mic === 'on') setMic('off');
  }

  function isBlockingError(err) {
    return err === 'not-allowed' || err === 'service-not-allowed' || err === 'audio-capture' || err === 'language-not-supported';
  }

  // マイクが使えない。聞き取りをやめて、文字で入れる欄を出す
  function micBlocked(err) {
    dbg('mic_blocked', err);
    stopRecognition();
    st.mic = 'blocked';
    st.textMode = true;
    renderState(); renderTextbar(); renderDrawer();
  }

  // ---- 声かけへの返事 ----
  function startReplyRecognition(p) {
    if (!micUsable() || st.current !== p || p._done || isHalted()) return;
    stopRecognition();
    var rec;
    try { rec = newRecognition(); } catch (e) { st.mic = 'unsupported'; st.textMode = true; renderAll(); return; }
    st.rec = rec; st.recKind = 'reply';
    var heard = { fin: '', interim: '' };
    var softError = false;
    rec.onstart = function () { if (st.rec === rec) setMic('on'); };
    rec.onresult = function (ev) {
      if (st.rec !== rec) return;
      heard = collect(ev);
      var shown = heard.fin || heard.interim;
      if (shown) showTalk({ reply: shown, say: p.text, dim: true, listening: true });
      if (heard.fin) finishReply(p, heard.fin);
    };
    rec.onerror = function (ev) {
      if (st.rec !== rec) return;
      if (isBlockingError(ev.error)) { micBlocked(ev.error); return; }
      if (ev.error !== 'no-speech' && ev.error !== 'aborted') { softError = true; dbg('rec_error', ev.error); }
    };
    rec.onend = function () {
      if (st.rec !== rec) return;
      st.rec = null; st.recKind = null; setMic('off');
      if (st.current !== p || p._done) return;
      var t = heard.fin || heard.interim;
      if (t) { finishReply(p, t); return; }
      // 60 秒たつまでは聞き直す（無音ですぐ切れるブラウザがあるため）
      setTimeout(function () { startReplyRecognition(p); }, softError ? 1500 : 250);
    };
    try { rec.start(); } catch (e) {
      st.rec = null; st.recKind = null;
      setTimeout(function () { startReplyRecognition(p); }, 1000);
    }
  }

  // ---- 声かけの合間（本人からの質問。docs/02 §11.2） ----
  function scheduleIdle(ms) {
    if (st.idleTimer) clearTimeout(st.idleTimer);
    st.idleTimer = setTimeout(function () { st.idleTimer = null; startIdleListening(); }, ms);
  }

  function startIdleListening() {
    if (!st.started || st.busy || st.current || st.speaking || isHalted() || st.rec) return;
    if (!micUsable() || !apiUsable('utter')) return;
    var rec;
    try { rec = newRecognition(); } catch (e) { st.mic = 'unsupported'; st.textMode = true; renderAll(); return; }
    st.rec = rec; st.recKind = 'idle';
    var heard = { fin: '', interim: '' };
    var errored = false;
    rec.onstart = function () { if (st.rec === rec) setMic('on'); };
    rec.onresult = function (ev) { if (st.rec === rec) heard = collect(ev); };
    rec.onerror = function (ev) {
      if (st.rec !== rec) return;
      if (isBlockingError(ev.error)) { micBlocked(ev.error); return; }
      if (ev.error !== 'no-speech' && ev.error !== 'aborted') { errored = true; dbg('idle_rec_error', ev.error); }
    };
    rec.onend = function () {
      if (st.rec !== rec) return;
      st.rec = null; st.recKind = null; setMic('off');
      var t = heard.fin || heard.interim;
      if (t) handleUtterance(t);
      else scheduleIdle(errored ? IDLE_ERROR_RETRY_MS : IDLE_RESTART_MS);
    };
    try { rec.start(); } catch (e) {
      st.rec = null; st.recKind = null;
      scheduleIdle(IDLE_ERROR_RETRY_MS);
    }
  }

  // ---------------------------------------------------------------------------
  // 声かけ → 読み上げ → 聞き取り → 返事
  // ---------------------------------------------------------------------------
  function isHalted() { return st.killSwitch || st.localPause; }
  function canTakePrompt() { return st.started && !st.busy && !isHalted(); }

  function rememberSeen(id) {
    st.seen.push(id);
    if (st.seen.length > 100) st.seen.shift();
  }

  function takePrompt(p) {
    if (!p || !p.id || st.seen.indexOf(p.id) >= 0) return;
    rememberSeen(p.id);
    p._receivedAt = Date.now();
    noteBathPrompt(p);
    if (canTakePrompt()) presentPrompt(p);
    else st.pending = p; // 受け取った声かけは「話した」扱いになるので、捨てずに後で出す
  }

  function presentPrompt(p) {
    var ep = st.epoch;
    st.busy = true;
    st.current = p;
    p._done = false;
    cancelLinger();
    stopRecognition();
    var noReply = p.isReassurance === true || p.expectsReply === false;
    setFace(p.expression || 'smile');
    showTalk({ say: p.text });
    renderTextbar();
    dbg('prompt', { task: p.task, len: String(p.text || '').length, reassurance: !!p.isReassurance, tts: !!p.ttsUrl });
    return speak(p.text, p.ttsUrl).then(function () {
      if (ep !== st.epoch || st.current !== p) return;
      if (noReply) {
        st.current = null;
        noteLast(p.task, p.isReassurance ? '安心の声かけ' : '声かけ');
        endActivity(LINGER_NOREPLY_MS);
        return;
      }
      awaitReply(p);
    });
  }

  function awaitReply(p) {
    setFace('listen');
    showTalk({ say: p.text, dim: true, listening: micUsable() });
    armNoAnswer(p);
    renderTextbar();
    if (micUsable()) startReplyRecognition(p);
  }

  function armNoAnswer(p) {
    if (st.replyDeadline) clearTimeout(st.replyDeadline);
    st.replyDeadline = setTimeout(function () { st.replyDeadline = null; finishReply(p, null); }, NO_ANSWER_MS);
  }

  function finishReply(p, text) {
    if (st.current !== p || p._done) return Promise.resolve();
    p._done = true;
    var ep = st.epoch;
    if (st.replyDeadline) { clearTimeout(st.replyDeadline); st.replyDeadline = null; }
    stopRecognition();
    setFace('think');
    showTalk({ reply: text, say: p.text, dim: true });
    renderTextbar();
    var body = text
      ? { hh: cfg.hh, promptId: p.id, text: text, source: 'ipad' }
      : { hh: cfg.hh, promptId: p.id, noAnswer: true, source: 'ipad' };
    dbg('reply_send', { task: p.task, noAnswer: !text, len: text ? text.length : 0 });
    return postWithRetry('/api/device/reply', body).then(function (r) {
      if (ep !== st.epoch) return;
      st.current = null;
      noteLast(p.task, text ? 'お返事がありました' : 'お返事はありませんでした');
      if (st.mode === 'bath') refreshMode(); // お風呂の進み具合をすぐ合わせる
      if (p.task === 'teeth' && st.mode === 'bath' && text) { st.bathTeethDone = true; renderBath(); }
      if (r) noteFollowUp(r.followUp);
      if (!r) { setFace('smile'); endActivity(text ? 8000 : 0); return; }
      setFace(r.expression || 'smile');
      if (r.say) {
        showTalk({ reply: text, say: r.say });
        return speak(r.say).then(function () { if (ep === st.epoch) endActivity(LINGER_MS); });
      }
      // say が空（L4 になったとき等）は何も読み上げない
      endActivity(text ? 8000 : 0);
    });
  }

  // 返事は取りこぼしたくないので、つながらないときだけ 3 回まで送り直す
  function postWithRetry(path, body) {
    var tries = 0;
    var attempt = function () {
      tries++;
      return api('POST', path, body, 45000).catch(function (e) {
        dbg('post_failed', { path: path, status: e.status });
        if (e.status === 0 && tries < 3) return sleep(3000).then(attempt);
        return null;
      });
    };
    return attempt();
  }

  function handleUtterance(text, fromText) {
    if (!st.started || st.busy || st.current || isHalted() || !apiUsable('utter')) { scheduleIdle(IDLE_RESTART_MS); return Promise.resolve(); }
    var ep = st.epoch;
    st.busy = true;
    renderTextbar();
    dbg('utterance_send', { len: text.length });
    return api('POST', '/api/device/utterance', { hh: cfg.hh, text: text, source: 'ipad' }, 45000).then(function (r) {
      st.utterApi = 'ok';
      return r;
    }, function (e) {
      if (e.status === 404) { markMissing('utter'); if (fromText) flash('話しかけの受け付けはまだ使えません'); }
      else { dbg('utterance_failed', { status: e.status }); if (fromText) flash('送れませんでした'); }
      return null;
    }).then(function (r) {
      if (ep !== st.epoch) return;
      if (r && r.say && r.kind !== 'ignored') {
        noteLast('talk', '話しかけに答えました' + (r.kind ? '（' + kindLabel(r.kind) + '）' : ''));
        cancelLinger();
        setFace(r.expression || 'smile');
        showTalk({ reply: text, replyLabel: 'お話', say: r.say });
        return speak(r.say).then(function () { if (ep === st.epoch) endActivity(LINGER_MS); });
      }
      // 本人向けでない（テレビ等）・API が無い：何も出さない
      endActivity(null);
    });
  }

  function kindLabel(k) {
    return { whereabouts: '居場所', medicine: 'お薬', notice: 'お知らせ', chat: 'おしゃべり' }[k] || k;
  }

  // 1 つのやりとりが終わった。lingerMs: その後時計に戻すまでの時間（null なら画面はそのまま）
  function endActivity(lingerMs) {
    st.busy = false;
    renderTextbar();
    if (isHalted()) return;
    if (st.pending) {
      var p = st.pending;
      st.pending = null;
      if (Date.now() - p._receivedAt < PENDING_MAX_AGE_MS) { presentPrompt(p); return; }
    }
    if (lingerMs === 0) showIdle();
    else if (lingerMs != null) lingerThenIdle(lingerMs);
    scheduleIdle(IDLE_RESTART_MS);
  }

  // reply の followUp（あとでもう一度聞く予定）を、heartbeat を待たずに「次は」へ反映する。
  // heartbeat の nextPrompt の方が早ければそちらのまま（次の heartbeat でサーバーの値に揃う）
  function noteFollowUp(f) {
    if (!f || !f.at || isNaN(new Date(f.at).getTime())) return;
    var at = new Date(f.at).getTime();
    var n = st.nextPrompt;
    var nAt = n && n.at ? new Date(n.at).getTime() : NaN;
    if (!isNaN(nAt) && nAt > Date.now() && nAt <= at) return;
    st.nextPrompt = { at: f.at, task: f.task };
    renderNext();
  }

  function noteLast(task, what) {
    st.last = { at: new Date().toISOString(), label: (TASK_LABELS[task] ? TASK_LABELS[task] + ': ' : '') + what };
    renderDrawer();
  }

  // ---------------------------------------------------------------------------
  // 止める（停止スイッチ・いったん止める）
  // ---------------------------------------------------------------------------
  function haltActivity() {
    st.epoch++;
    if (st.replyDeadline) { clearTimeout(st.replyDeadline); st.replyDeadline = null; }
    if (st.current && !st.current._done) {
      // 返事を待っていた声かけは、再開したら出し直さない（止めたのはご家族がそばにいるとき）
      st.current._done = true;
    }
    st.current = null;
    st.busy = false;
    st.speaking = false;
    stopRecognition();
    stopSpeech();
    cancelLinger();
  }

  function showRest() {
    setFace('smile');
    showTalk({ say: '少し休みますね。', sub: 'また後でお話ししましょう' });
    if (st.restTimer) clearTimeout(st.restTimer);
    st.restTimer = setTimeout(function () { st.restTimer = null; if (isHalted()) showIdle(); }, REST_VIEW_MS);
    var ep = st.epoch;
    if (st.started) {
      synthOnce('少し休みますね。', ep);
    }
  }
  function synthOnce(text, ep) {
    // 止めた直後の一言だけ読む（聞き取りはしない）
    sleep(300).then(function () { if (ep === st.epoch && isHalted()) synthSpeak(text); });
  }

  function resumeActivity() {
    if (st.restTimer) { clearTimeout(st.restTimer); st.restTimer = null; }
    stopSpeech();
    showIdle();
    renderAll();
    if (st.pending) endActivity(0);
    else scheduleIdle(IDLE_RESTART_MS);
  }

  function applyKill(on) {
    if (on === st.killSwitch) return;
    st.killSwitch = on;
    dbg('kill_switch', on);
    if (on) {
      var wasLocal = st.localPause;
      st.localPause = false; // 家族画面の停止が優先。再開も家族画面から
      if (!wasLocal) { haltActivity(); showRest(); }
    } else if (!st.localPause) {
      resumeActivity();
    }
    renderAll();
  }

  function toggleLocalPause() {
    if (st.killSwitch) return;
    st.localPause = !st.localPause;
    dbg('local_pause', st.localPause);
    if (st.localPause) { haltActivity(); showRest(); }
    else resumeActivity();
    renderAll();
  }

  // ---------------------------------------------------------------------------
  // モード（寝室／お風呂）。サーバーが真
  // ---------------------------------------------------------------------------
  function applyMode(m, since) {
    if (m !== 'bedroom' && m !== 'bath') return false;
    var changed = m !== st.mode;
    if (changed) {
      st.mode = m;
      st.bathTeethDone = false;
      if (m !== 'bath') st.bath = null;
      st.modeSince = m === 'bath' ? (since || new Date().toISOString()) : null;
      document.body.classList.toggle('mode-bath', m === 'bath');
      document.body.classList.toggle('mode-bedroom', m === 'bedroom');
      try { document.querySelector('meta[name="theme-color"]').setAttribute('content', m === 'bath' ? '#f2f7f6' : '#fbf7ef'); } catch (e) { /* 無視 */ }
      dbg('mode', m);
      redrawTalk();
    } else if (m === 'bath' && since) {
      st.modeSince = since;
    }
    renderAll();
    return changed;
  }

  function applyModeInfo(r) {
    if (!r) return;
    if (typeof r.killSwitch === 'boolean') applyKill(r.killSwitch);
    var bath = r.bath && typeof r.bath === 'object' ? r.bath : null;
    applyMode(r.mode, bath && bath.startedAt ? bath.startedAt : (r.modeChangedAt || null));
    st.bath = r.mode === 'bath' ? bath : null;
    if (r.whereabouts && typeof r.whereabouts.say === 'string') st.whereaboutsSay = r.whereabouts.say;
    else if (r.whereabouts === null) st.whereaboutsSay = null;
    renderAll();
  }

  function refreshMode() {
    if (!apiUsable('mode')) return Promise.resolve();
    return api('GET', '/api/device/mode?hh=' + hhParam()).then(function (r) {
      st.modeApi = 'ok';
      applyModeInfo(r);
    }, function (e) {
      if (e.status === 404) markMissing('mode');
      renderAll();
    });
  }

  function requestMode(m) {
    if (m === st.mode || !apiUsable('mode')) return;
    if (m === 'bath' && !window.confirm('お風呂モードにします。\nこの iPad は安全の確認をしません。転んだことなどは分かりません。')) return;
    $('modeBedroom').disabled = true; $('modeBath').disabled = true;
    api('POST', '/api/device/mode', { hh: cfg.hh, mode: m }).then(function (r) {
      st.modeApi = 'ok';
      applyModeInfo(r && r.mode ? r : { mode: m });
    }, function (e) {
      if (e.status === 404) { markMissing('mode'); flash('モードの切り替えはまだ使えません'); }
      else flash('切り替えられませんでした。もう一度押してください');
    }).then(renderAll);
  }

  // お風呂の進み具合（サーバーの bath を待たずに、届いた声かけで先に印を付ける）。
  // bathStep: start / wash / wash_recheck / teeth / exit / end（src/api/README.md 6 節）
  function noteBathPrompt(p) {
    if (st.mode !== 'bath') return;
    var b = st.bath || {};
    var now = new Date().toISOString();
    var step = p.bathStep || (p.task === 'bath' ? 'wash' : p.task === 'teeth' ? 'teeth' : null);
    if (step === 'wash' || step === 'wash_recheck') {
      if (!b.washAskedAt) b.washAskedAt = now;
    } else if (step === 'teeth') {
      if (!b.washDoneAt) b.washDoneAt = now;
      if (!b.teethAskedAt) b.teethAskedAt = now;
    } else if (step === 'exit') {
      // 「お風呂から上がりましたか？」（再確認も exit）。洗い始め・歯磨きはもう過ぎている
      if (!b.washDoneAt && b.washAskedAt) b.washDoneAt = now;
      if (b.teethAskedAt) st.bathTeethDone = true;
      if (!b.exitAskedAt) b.exitAskedAt = now;
    } else if (step === 'end') {
      if (!b.washDoneAt) b.washDoneAt = now;
      st.bathTeethDone = true;
    }
    st.bath = b;
    renderBath();
  }

  // ---------------------------------------------------------------------------
  // ループ
  // ---------------------------------------------------------------------------
  function heartbeat() {
    if (st.hbTimer) { clearTimeout(st.hbTimer); st.hbTimer = null; }
    var body = { hh: cfg.hh, appVersion: APP_VERSION };
    if (st.battery && typeof st.battery.level === 'number') body.batteryPct = Math.round(st.battery.level * 100);
    var delay = HEARTBEAT_MS;
    return api('POST', '/api/device/heartbeat', body).then(function (r) {
      applyKill(r.killSwitch === true);
      st.nextPrompt = r.nextPrompt && r.nextPrompt.at ? r.nextPrompt : null;
      renderNext();
    }, function (e) {
      if (e.status === 0 || e.status >= 500) delay = HEARTBEAT_RETRY_MS;
    }).then(function () {
      return refreshMode();
    }).then(function () {
      // 合間の聞き取りが止まったままなら起こす（utterance が 404 だったあとの再挑戦も兼ねる）
      if (st.started && !st.busy && !st.current && !st.rec && !st.idleTimer && !st.speaking) scheduleIdle(IDLE_RESTART_MS);
      st.hbTimer = setTimeout(heartbeat, delay);
    });
  }

  function poll() {
    if (st.pollTimer) { clearTimeout(st.pollTimer); st.pollTimer = null; }
    var delay = POLL_MS;
    var work = Promise.resolve();
    // 止めている間は取りに行かない（受け取ると「話した」扱いになるため）
    if (canTakePrompt() && !st.pending) {
      work = api('GET', '/api/device/next-prompt?hh=' + hhParam()).then(function (r) {
        if (r.mode && r.mode !== st.mode) {
          applyMode(r.mode);
          refreshMode();
        }
        if (r.prompt) takePrompt(r.prompt);
      }, function (e) {
        if (e.status === 401 || e.status === 403) delay = POLL_AUTH_MS;
      });
    }
    work.then(function () { st.pollTimer = setTimeout(poll, delay); });
  }

  // ---------------------------------------------------------------------------
  // 画面の常時表示・全画面
  // ---------------------------------------------------------------------------
  function requestWakeLock() {
    try {
      if (!('wakeLock' in navigator) || st.wake) return;
      navigator.wakeLock.request('screen').then(function (lock) {
        st.wake = lock;
        lock.addEventListener('release', function () { st.wake = null; });
      }, function () { /* 失敗しても続ける */ });
    } catch (e) { /* 失敗しても続ける */ }
  }

  function tryFullscreen() {
    // PC では審査員の邪魔になるので、タッチ端末（iPad）だけ試す
    if (!(navigator.maxTouchPoints > 1)) return;
    try {
      var el = document.documentElement;
      var fn = el.requestFullscreen || el.webkitRequestFullscreen;
      if (fn) {
        var p = fn.call(el);
        if (p && p.catch) p.catch(function () { /* 無視 */ });
      }
    } catch (e) { /* 無視 */ }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || !st.started) return;
    requestWakeLock();
    heartbeat();
    var p = st.current;
    if (p && !p._done && !st.speaking && !st.rec) startReplyRecognition(p);
    else if (!st.busy && !st.rec) scheduleIdle(IDLE_RESTART_MS);
  });

  // ---------------------------------------------------------------------------
  // 設定と「はじめる」
  // ---------------------------------------------------------------------------
  function showSetup(prefillHh) {
    $('startOverlay').hidden = false;
    $('setupForm').hidden = false;
    $('startBox').hidden = true;
    $('setupHh').value = prefillHh || (cfg && cfg.hh) || 'hh_main';
    $('setupToken').value = '';
    $('setupErr').hidden = true;
    setTimeout(function () { try { $('setupToken').focus(); } catch (e) { /* 無視 */ } }, 50);
  }
  function showStartBox() {
    $('startOverlay').hidden = false;
    $('setupForm').hidden = true;
    $('startBox').hidden = false;
  }
  function setupError(msg) { $('setupErr').textContent = msg; $('setupErr').hidden = false; }

  $('setupForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var hh = $('setupHh').value.trim();
    var token = $('setupToken').value.trim();
    $('setupErr').hidden = true;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(hh)) { setupError('世帯 ID は英数字と _ - で入れてください（例: hh_main）'); return; }
    if (!token) { setupError('端末トークンを入れてください'); return; }
    var prev = cfg;
    cfg = { hh: hh, token: token };
    // 確かめてから保存する（つながらないときは保存だけして進む）
    api('POST', '/api/device/heartbeat', { hh: hh, appVersion: APP_VERSION }).then(function () {
      saveCfg(cfg);
      afterSetup();
    }, function (e) {
      if (e.status === 401) { cfg = prev; setupError('端末トークンが正しくありません'); return; }
      if (e.status === 403) { cfg = prev; setupError('端末トークンと世帯 ID が合っていません'); return; }
      saveCfg(cfg);
      afterSetup();
    });
  });

  function afterSetup() {
    if (st.started) {
      $('startOverlay').hidden = true;
      heartbeat(); poll();
    } else {
      showStartBox();
    }
  }

  $('editSetup').addEventListener('click', function () { showSetup(); });

  $('startBtn').addEventListener('click', function () {
    if (!cfg) { showSetup(); return; }
    // ここから先はタップの中で同期的に行う（Safari の制限）
    unlockAudio();
    tryFullscreen();
    st.started = true;
    $('startOverlay').hidden = true;
    if (!recognitionSupported()) { st.mic = 'unsupported'; st.textMode = true; }
    showIdle();
    renderAll();
    // マイクの許可：合間の聞き取りをこのタップの中で始める（許可の確認が出る）
    startIdleListening();
    requestWakeLock();
    try {
      if (navigator.getBattery) navigator.getBattery().then(function (b) { st.battery = b; }, function () { /* 無視 */ });
    } catch (e) { /* 無視 */ }
    dbg('started', { mic: recognitionSupported(), textMode: st.textMode });
    heartbeat();
    poll();
  });

  // ---------------------------------------------------------------------------
  // ご家族用の操作
  // ---------------------------------------------------------------------------
  $('modeBedroom').addEventListener('click', function () { requestMode('bedroom'); });
  $('modeBath').addEventListener('click', function () { requestMode('bath'); });
  $('pauseBtn').addEventListener('click', toggleLocalPause);

  function openDrawer() {
    renderDrawer();
    $('drawer').hidden = false;
    armDrawerClose();
  }
  function closeDrawer() {
    $('drawer').hidden = true;
    if (st.drawerTimer) { clearTimeout(st.drawerTimer); st.drawerTimer = null; }
  }
  function armDrawerClose() {
    if (st.drawerTimer) clearTimeout(st.drawerTimer);
    st.drawerTimer = setTimeout(closeDrawer, DRAWER_AUTOCLOSE_MS);
  }
  $('planBtn').addEventListener('click', function () { if ($('drawer').hidden) openDrawer(); else closeDrawer(); });
  $('drawerClose').addEventListener('click', closeDrawer);
  $('drawer').addEventListener('pointerdown', armDrawerClose);
  $('drText').addEventListener('click', function () {
    st.textMode = !st.textMode;
    renderTextbar(); renderDrawer();
  });
  $('drSettings').addEventListener('click', function () { closeDrawer(); showSetup(); });

  // ---- 文字で入れる欄 ----
  $('textbar').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var t = $('textInput').value.trim();
    if (!t) return;
    var p = st.current;
    if (p && !p._done && !st.speaking) {
      $('textInput').value = '';
      finishReply(p, t.slice(0, 500));
    } else if (!st.busy && !st.current && !isHalted()) {
      if (!apiUsable('utter')) { flash('話しかけの受け付けはまだ使えません'); return; }
      $('textInput').value = '';
      stopRecognition();
      handleUtterance(t.slice(0, 500), true);
    }
  });
  $('textInput').addEventListener('input', function () {
    // 打っている間に「返事なし」にならないよう、待ち時間を延ばす
    var p = st.current;
    if (p && !p._done && !st.speaking) armNoAnswer(p);
  });
  $('textNoAnswer').addEventListener('click', function () {
    var p = st.current;
    if (p && !p._done) finishReply(p, null);
  });
  $('textClose').addEventListener('click', function () { st.textMode = false; renderTextbar(); renderDrawer(); });

  // ---------------------------------------------------------------------------
  // 起動
  // ---------------------------------------------------------------------------
  setFace('smile');
  showIdle();
  renderAll();
  setInterval(tickClock, 1000);
  setInterval(renderNext, 15000);
  if (cfg) showStartBox(); else showSetup(urlHh);
})();
