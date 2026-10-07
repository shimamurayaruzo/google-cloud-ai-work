// 会話ターンの決定論の層（LLM を呼ばない）。
// 1) LLM が使えないとき（停止中・タイムアウト・例外・AGENT_MODE=rules）の代替
// 2) LLM の結果に最低限の保証をかける postProcess
// 確実に判定できるもの（無反応・L4 の語・痛み・外部連絡の依頼・テレビの音）はここで決め、
// 文脈が要るものだけ LLM に任せる（docs/01 §6.2「止まる設計」、docs/criteria.md 2 節の A 層）。
// 通知の段階（criteria v2 1 節・3-2）: L4 の語 → urgent（至急）、「〜が痛い」→ check（確認のお願い）＋3 時間後の聞き直し、
// 「だるい・眠い・疲れた」→ 記録のみ（夕方の要約へ）。

import { TASK_KEYS, TASK_LABELS } from '../types.js';
import type { Classification, Expression, Household, NoticeOrigin, TaskKey } from '../types.js';
import type { Intent, TurnInput, TurnOutcome, TurnRunner } from '../services.js';
import { hhmm, toMinutes } from '../time.js';
import { NO_ANSWER_RECHECK_MINUTES, NO_SCHEDULE_RECHECK_MINUTES } from '../state/plan.js';

// ---------------------------------------------------------------------------
// L4 の語・痛み・軽い不調（criteria v2 3-2）
// ---------------------------------------------------------------------------

/**
 * L4（至急）の語（部分一致。初期値、家族が追加できる想定）。医療の判断はしない。語があれば知らせるだけ。
 *  群 A（位置・動作）・群 B（症状）・群 C（訴えの強さ）。「〜が痛い」の L3 より優先する。
 */
export const L4_WORDS: Readonly<Record<'A' | 'B' | 'C', readonly string[]>> = {
  A: [
    '転んだ', '転んじゃ', '転んで', 'ころんだ', 'ころんじゃ', '転倒', '倒れた', '倒れて', '倒れちゃ', 'たおれた',
    '動けない', 'うごけない', '起き上がれない', '起きあがれない', 'おきあがれない', '立てない', '立ち上がれない',
    '頭を打', '頭打', '頭をぶつけ', 'あたまをうった',
  ],
  B: [
    '息苦しい', 'いきぐるしい', '息ができない', '息が出来ない', '息ができません',
    '胸が痛', '胸がいた', 'むねがいた', '胸が苦し', '胸がくるし',
    '血が出', '血がで', '血が止まらない', '血を吐',
    'のどに詰ま', '喉に詰ま', 'のどにつま', 'けいれん', '痙攣',
    '手が動かない', '足が動かない', '手足が動かない', '手や足が動かない',
    '力が入らない', '力がはいらない', 'ちからが入らない',
    'しびれる', 'しびれて', '痺れ', 'ろれつが回らない', '呂律が回らない', 'ろれつがまわらない',
    '目が見えない', 'めがみえない', '二重に見える', 'だぶって見える', '激しい頭痛', '頭が割れ',
  ],
  C: ['助けて', 'たすけて', '苦しい', 'くるしい'],
};

/** 火事・煙・熱い（火災の可能性として L4 扱い）。「熱い」は飲み物・お風呂などの文脈では拾わない */
const FIRE_WORDS = ['火事', '煙', 'けむり', '焦げ臭', 'こげくさ', '熱い'];
const HOT_DRINK_CONTEXT = /お?茶|お湯|湯のみ|湯呑|ご飯|ごはん|味噌汁|みそ汁|スープ|コーヒー|紅茶|風呂|ふろ|シャワー|料理|飲み物|鍋|うどん|そば|ラーメン/;

/** 互換のため残す: L4 の語の平らな一覧 */
export const URGENT_KEYWORDS: readonly string[] = [...L4_WORDS.A, ...L4_WORDS.B, ...L4_WORDS.C];

/** 否定形・複合語の除外。検出の前に取り除く（「痛くない」「転んでない」「血圧」など） */
const L4_EXCLUDE: RegExp[] = [
  /(痛|いた|苦し|くるし)く(は|も)?(ない|なかった|ありません|なくなった)/g,
  /(転ん|ころん)で(は|も)?(ない|いない|ません)/g,
  /倒れて(は|も)?(ない|いない|ません)/g,
  /(打っ|ぶつけ)て(は|も)?(ない|いない|ません)/g,
  /(出|で)て(は|も)?(ない|いない|ません)/g,
  /しびれ(て)?(は|も)?(ない|いない|ません)/g,
  /血圧|血糖|献血|血液検査/g,
  /役に立て/g,
];

/** 本人の発話か分からない印（文字起こしが付けるもの） */
const NOISE_MARKER = /^\s*[（(]\s*(テレビ|ラジオ|雑音|来客|音)/;
/** 緊急語を拾わない印（機械の音。来客の声は人が言っているので緊急語は拾う） */
const MACHINE_MARKER = /^\s*[（(]\s*(テレビ|ラジオ|雑音|音)/;
/** ニュース・番組の口調（本人向けの発話ではない） */
const BROADCAST_TONE = /続いては|天気です|天気予報|気象情報|ニュースです|お伝えします|番組|ご覧の|提供は|コマーシャル|CMの|速報/;

/** 本人以外の声・音の可能性が高い返事か（要約に原文を載せない判断に使う。criteria 2「家族にも送らない」） */
export function isLikelyNotPerson(text: string | null | undefined): boolean {
  if (!text) return false;
  return NOISE_MARKER.test(text) || BROADCAST_TONE.test(text);
}

function cleaned(text: string): string {
  let t = text;
  for (const re of L4_EXCLUDE) t = t.replace(re, '');
  return t;
}

export interface L4Hit { word: string; group: 'A' | 'B' | 'C' | 'fire' }

/** L4 の語（群 A/B/C）か火災の語があれば返す。テレビ・雑音の印が付いた文は対象外 */
export function detectL4(text: string | null | undefined): L4Hit | null {
  if (!text) return null;
  if (MACHINE_MARKER.test(text)) return null;
  const t = cleaned(text);
  for (const group of ['A', 'B', 'C'] as const) {
    for (const w of L4_WORDS[group]) if (t.includes(w)) return { word: w, group };
  }
  for (const w of FIRE_WORDS) {
    if (!t.includes(w)) continue;
    if (w === '熱い' && HOT_DRINK_CONTEXT.test(t)) continue;
    return { word: w, group: 'fire' };
  }
  return null;
}

/** 互換のため残す: L4 の語（根拠の語）。「痛い」だけでは拾わない（L3 は detectPain） */
export function detectUrgent(text: string | null | undefined): string | null {
  return detectL4(text)?.word ?? null;
}

export interface PainHit {
  /** 根拠の語（例「痛い」） */
  word: string;
  /** 痛む場所（例「腰」）。分からなければ null */
  part: string | null;
}

const PAIN = /痛い|痛む|痛み|痛く|痛っ|[がもは]いた(い|む|く)/;
/** 「○○が（ちょっと）痛い」の○○（漢字・カタカナの連なり、または決まったひらがな）。直前の文字列の末尾に当てる */
const PART_BEFORE = /(お?[一-龥ァ-ヶー]{1,4}|おなか|あたま|こし|ひざ|あし|せなか|うで|かた|くび|のど)(?:が|も|は|の)?(?:ちょっと|少し|すこし|まだ|とても|すごく|ずっと|なんだか|なんか)?$/;

/** 痛みの言葉（L3）。否定形は除く。L4 の語（胸が痛い 等）の判定は detectL4 を先に */
export function detectPain(text: string | null | undefined): PainHit | null {
  if (!text) return null;
  if (MACHINE_MARKER.test(text)) return null;
  const t = cleaned(text);
  const m = PAIN.exec(t);
  if (!m) return null;
  const pm = PART_BEFORE.exec(t.slice(0, m.index));
  return { word: m[0].replace(/^[がもは]/, ''), part: pm ? pm[1] : null };
}

const MILD = /だるい|ダルい|眠い|ねむい|疲れた|つかれた|しんどい|くたびれた/;

/** 「だるい」「眠い」「疲れた」などの軽い不調（L1: 記録して夕方の要約へ。通知しない） */
export function detectMildDiscomfort(text: string | null | undefined): string | null {
  if (!text || MACHINE_MARKER.test(text)) return null;
  return MILD.exec(text)?.[0] ?? null;
}

/** L4 の語のときに本人へ 1 回だけ伝える定型文（criteria 3-2） */
export const L4_SAY = '大丈夫ですか。ご家族に連絡します。そのまま動かずにお待ちください。';
/** L4 モード中に 3 分ごとに流す安心の一文（質問はしない） */
export const REASSURANCE_SAY = 'ご家族に連絡しました。無理に立ち上がらず、そのままお待ちください。';
/** 痛みの聞き直しまでの分（criteria 3-2「3 時間ほど後」） */
export const PAIN_FOLLOWUP_MINUTES = 180;

export function painReason(p: PainHit): string {
  return `${p.part ? `${p.part}が` : ''}痛いとおっしゃいました。どの程度か、動けるかは分かりません。`;
}

export function l4Reason(hit: L4Hit): string {
  return hit.group === 'fire'
    ? `火災の可能性（「${hit.word}」とおっしゃいました）`
    : `「${hit.word}」とおっしゃいました`;
}

export function painFollowupText(p: PainHit): string {
  return `さっき${p.part ? `${p.part}が` : ''}痛いとおっしゃっていましたが、今はどうですか？`;
}

// ---------------------------------------------------------------------------
// 返事の分析
// ---------------------------------------------------------------------------

/** 外部（家族以外を含む）への連絡の依頼 */
/** 外部（家族以外を含む）への連絡の依頼（「電話して」「連絡して」「呼んで」「伝えて」）。docs/02 §4 の call_outside 相当で、常にしない */
const CONTACT_REQUEST = /(電話|でんわ|連絡|れんらく)[^。！？!?]{0,6}?(して|かけて|ちょうだい|頂戴|ください|頼む|たのむ)|呼んで|よんで|(伝え|つたえ)て(ほしい|欲しい|ちょうだい|頂戴|ください|くれ(?!て)|おいて|$|[。！？!?、よねなお])/;
/** 誰に連絡してほしいか（「ケアマネさんに伝えて」の「ケアマネさん」） */
const CONTACT_WHO = /([^\s、。！？!?「」]{1,10}?)(さん|ちゃん)?(に|へ)[^。！？!?]{0,4}?(伝え|つたえ|連絡|れんらく|電話|でんわ)/;

const NOT_YET = /まだ|あとで|後で|これから|今から|いまから|待って|まって|(て|で)(い)?ない|いらない|要らない|いいえ|後にする|あとにする/;

const GENERIC_DONE = ['した', 'しました', '済んだ', '済ん', 'すんだ', '済ませ', '終わった', 'おわった', 'できた', 'できました', 'やった', 'はい', 'はーい', 'うん', 'ええ', 'そうよ', 'そうだよ'];

const TASK_DONE: Record<TaskKey, string[]> = {
  greeting: ['おはよう', '眠れ', 'ねむれ', '寝れ', 'まあまあ', '起きた', '元気'],
  diaper: ['替えた', 'かえた', '替えました', '取り替え', 'とりかえ'],
  teeth: ['磨いた', 'みがいた', '磨きました'],
  face: ['洗った', 'あらった', '洗いました'],
  dress: ['着替えた', 'きがえた', '着替えました', '着た'],
  belongings: ['入れた', '入って', 'いれた', 'はいって', '持った', 'もった', 'あるよ', 'あります'],
  pickup: ['来た', 'きた', '来ました', '行ってきます', 'いってきます', '行ってくる'],
  lunch: ['食べた', 'たべた', '食べました', 'いただいた'],
  water: ['飲んだ', 'のんだ', '飲みます', '飲む', 'のむ', 'いただきます', 'もらう'],
  return: ['ただいま', '帰った', '帰りました', '帰ってきた', 'かえってきた'],
  dinner: ['食べた', 'たべた', '食べました', 'いただいた'],
  medicine: ['飲んだ', 'のんだ', '飲みました'],
  bedtime: ['おやすみ', '寝る', '寝ます', 'ねる', '磨いた', '替えた'],
  // お風呂モードの「そろそろ体を洗いましょうか」（docs/02 §11.3）
  bath: ['洗う', '洗います', '洗った', 'あらう', 'あらった', '洗ってる', '洗っている', 'そうする', 'そうします'],
  // 会話（ときたまの声かけ）は済み・まだを決めない
  talk: [],
};

/** 何か返事があれば「済み」としてよい項目（起床の挨拶・帰宅は返事そのものが確認になる） */
const ANY_REPLY_IS_DONE: TaskKey[] = ['greeting', 'return'];

const MED_WHAT = /(何|なん|なに)の(薬|くすり)|(薬|くすり)[^。]{0,4}(何|なに|なん)|これ(何|なに|なん)/;
const MED_WHERE = /どこ/;

export interface ReplyAnalysis {
  status: Classification;
  /** 分類の根拠（短く。本人の言葉は抜粋のみ） */
  note: string;
  /** L4 の語（根拠の語）。互換のため残す（= l4?.word） */
  urgentWord: string | null;
  /** L4 の語・火災の語 */
  l4: L4Hit | null;
  /** 痛みの言葉（L4 の語があるときは null。L4 を優先する） */
  pain: PainHit | null;
  /** 軽い不調（だるい・眠い・疲れた。記録のみ） */
  mild: string | null;
  /** 「電話して」などの外部連絡の依頼 */
  contactRequest: boolean;
  /** 服薬の質問への答え（呼び方の決まりから） */
  medicineAnswer: string | null;
}

/** 返事の抜粋（ログ・note・evidence 用。全文は残さない） */
export function excerpt(text: string | null | undefined, max = 30): string {
  if (!text) return '';
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max) + '…';
}

function wordingOf(h: Household, key: string, fallback: string): string {
  const v = h.person.wording?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

export function analyzeReply(task: TaskKey, replyText: string | null, household: Household): ReplyAnalysis {
  const text = (replyText ?? '').trim();
  if (!text) {
    return { status: 'no_answer', note: '返事なし', urgentWord: null, l4: null, pain: null, mild: null, contactRequest: false, medicineAnswer: null };
  }
  const l4 = detectL4(text);
  const pain = l4 ? null : detectPain(text);
  const mild = detectMildDiscomfort(text);
  const contactRequest = !MACHINE_MARKER.test(text) && CONTACT_REQUEST.test(text);
  const base = { urgentWord: l4?.word ?? null, l4, pain, mild, contactRequest, medicineAnswer: null as string | null };

  // 入力を疑う: 本人の発話か分からないものは判定しない
  if (NOISE_MARKER.test(text) || BROADCAST_TONE.test(text)) {
    return { ...base, status: 'unclear', note: '本人の声か分からない（テレビ・来客・雑音の可能性）' };
  }

  // 服薬の質問: 決めた言葉で答えるだけ。まだ飲んでいないので not_yet
  const aboutMedicine = task === 'medicine' || /薬|くすり/.test(text);
  const asksWhat = MED_WHAT.test(text);
  const asksWhere = MED_WHERE.test(text);
  if (aboutMedicine && (asksWhat || asksWhere)) {
    const parts: string[] = [];
    if (asksWhat) parts.push(`${wordingOf(household, 'medicine', 'いつものお薬')}ですよ。`);
    if (asksWhere) parts.push(`${wordingOf(household, 'medicinePlace', 'いつもの場所')}にありますよ。`);
    return { ...base, medicineAnswer: parts.join(''), status: 'not_yet', note: `服薬の質問「${excerpt(text, 12)}」` };
  }

  if (NOT_YET.test(text)) {
    return { ...base, status: 'not_yet', note: `「${excerpt(text, 20)}」` };
  }
  const own = [...GENERIC_DONE, ...TASK_DONE[task]];
  if (own.some(w => text.includes(w))) {
    return { ...base, status: 'done', note: `「${excerpt(text, 20)}」` };
  }
  if (ANY_REPLY_IS_DONE.includes(task)) {
    return { ...base, status: 'done', note: `返事あり「${excerpt(text, 20)}」` };
  }
  // 別の項目の語彙だけに当たる（例: 服薬の確認に「食べた」）→ 曖昧なので判定しない
  const other = TASK_KEYS.find(k => k !== task && TASK_DONE[k].some(w => text.includes(w)));
  if (other) {
    return { ...base, status: 'unclear', note: `別の項目（${TASK_LABELS[other]}）の返事の可能性「${excerpt(text, 16)}」` };
  }
  return { ...base, status: 'unclear', note: `判定できない返事「${excerpt(text, 16)}」` };
}

/** 規則の確信度: 判定できたものは 1.0、unclear は 0.5（criteria 2 ★2 の閾値 0.7 未満＝判定未確定） */
export function rulesConfidence(status: Classification): number {
  return status === 'unclear' ? 0.5 : 1.0;
}

/** LLM の確信度の閾値（criteria 2 ★2） */
export const CONFIDENCE_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// 再確認の分数
// ---------------------------------------------------------------------------

/** お迎えの前に残しておく余裕（分） */
const PICKUP_BUFFER_MIN = 15;
export const MIN_RECHECK = 5;
export const MAX_RECHECK = 60;

/**
 * 再確認までの分（criteria v2 3-1・3-3 ★4 ★7。最終的な時刻は state/plan.ts の recheckIntervalMinutes が決める）。
 *  - 返事なし（no_answer）… 常に 15 分
 *  - デイの日 … 計画の recheckMinutes → policy.recheckMinutes。お迎え前なら、お迎えの 15 分前までに再確認できるよう短縮（5 分以上）
 *    例: 8:35 に着替え「まだ」、お迎え 9:00 → 10 分後（8:45）
 *  - 予定が無い日 … 30 分
 */
export function recheckMinutesFor(input: TurnInput, status?: Classification): number {
  if (status === 'no_answer') return NO_ANSWER_RECHECK_MINUTES;
  if (!input.day.isDayservice) return NO_SCHEDULE_RECHECK_MINUTES;
  const task = input.prompt.task;
  const planItem = input.day.plan.find(p => p.task === task);
  let minutes = planItem?.recheckMinutes || input.household.policy.recheckMinutes || 15;
  const pickup = input.household.plan.pickupTime;
  if (pickup) {
    const untilPickup = toMinutes(pickup) - toMinutes(hhmm(input.now));
    if (untilPickup > 0) minutes = Math.min(minutes, untilPickup - PICKUP_BUFFER_MIN);
  }
  return clamp(Math.round(minutes), MIN_RECHECK, MAX_RECHECK);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
}

// ---------------------------------------------------------------------------
// 本人へ返す一言（責めない、短い、固定文）
// ---------------------------------------------------------------------------

function doneSay(task: TaskKey, h: Household): string {
  switch (task) {
    case 'greeting': return 'よかったです。今日もよろしくお願いしますね。';
    case 'diaper': return `${wordingOf(h, 'diaper', 'おむつ')}、替えられましたね。さっぱりしましたね。`;
    case 'teeth': return '歯磨き、できましたね。すっきりしましたね。';
    case 'face': return 'さっぱりしましたね。';
    case 'dress': return 'お着替え、できましたね。';
    case 'belongings': return 'よかったです。準備ばっちりですね。';
    case 'pickup': return 'いってらっしゃい。楽しんできてくださいね。';
    case 'lunch': return 'よかったです。ごちそうさまでした。';
    case 'water': return 'よかったです。';
    case 'return': return 'おかえりなさい。ゆっくり休んでくださいね。';
    case 'dinner': return 'よかったです。ごちそうさまでした。';
    case 'medicine': return 'お薬、飲めましたね。ありがとうございます。';
    case 'bedtime': return 'おやすみなさい。ゆっくり休んでくださいね。';
    case 'bath': return 'ゆっくりどうぞ。';
    case 'talk': return 'はい、聞いていますよ。';
  }
}

export const PAIN_SAY = 'それはつらいですね。無理をしないでくださいね。';

/**
 * 規則で決めた一言（LLM の最終テキストが無いときにも使う）。
 * 催促に「家族に知らせる」を添えない（criteria 3-1 注記）。L4 だけは定型文で「ご家族に連絡します」と伝える。
 */
export function fixedSay(status: Classification, task: TaskKey, household: Household, opts: {
  recheck: boolean; urgent: boolean; contactRequest: boolean; medicineAnswer: string | null; pain?: boolean;
}): string {
  if (opts.urgent) return L4_SAY;
  if (opts.pain) return PAIN_SAY;
  if (opts.medicineAnswer) return opts.medicineAnswer;
  let s: string;
  switch (status) {
    case 'done': s = doneSay(task, household); break;
    case 'not_yet': s = opts.recheck ? 'わかりました。また少ししたら声をかけますね。' : 'わかりました。'; break;
    case 'no_answer': s = opts.recheck ? 'また少ししたら声をかけますね。' : 'また声をかけますね。'; break;
    case 'unclear': s = 'また後で声をかけますね。'; break;
  }
  // 本人からの依頼への断り（criteria 3-5）。催促ではないので家族の名前を出してよい
  if (opts.contactRequest) s = CONTACT_SAY + (status === 'done' ? s : '');
  return s;
}

export function expressionFor(status: Classification, urgent: boolean): Expression {
  if (urgent) return 'worry';
  switch (status) {
    case 'done': return 'smile';
    case 'not_yet': return 'listen';
    default: return 'think';
  }
}

// ---------------------------------------------------------------------------
// 規則だけの TurnRunner
// ---------------------------------------------------------------------------

/** 停止中（killSwitch）の応答。道具は何も使わない */
export function killSwitchOutcome(startedAt: number): TurnOutcome {
  return {
    classified: { status: 'unclear', note: '停止中', by: 'rules' },
    say: '少し休みますね。',
    expression: 'think',
    toolCalls: [],
    intents: [],
    latencyMs: Date.now() - startedAt,
  };
}

/** 規則で record intent を作る（postProcess の補完にも使う） */
export function ruleRecord(input: TurnInput, a?: ReplyAnalysis): Extract<Intent, { type: 'record' }> {
  const r = a ?? analyzeReply(input.prompt.task, input.replyText, input.household);
  return { type: 'record', task: input.prompt.task, status: r.status, note: r.note, confidence: rulesConfidence(r.status) };
}

export const CONTACT_REASON = '本人から外部への連絡を頼まれました（こちらからは連絡していません）';
/** 本人に頼まれた外部連絡への一言（自分では連絡しない。criteria 3-5） */
export const CONTACT_SAY = 'ご家族に伝えておきますね。';

/** 外部連絡の依頼の通知の理由。「○○に伝えてほしいと頼まれました（こちらからは連絡していません）」 */
export function contactReason(text: string | null | undefined): string {
  const m = text ? CONTACT_WHO.exec(text) : null;
  if (!m) return CONTACT_REASON;
  const verb = /電話|でんわ/.test(m[4]) ? '電話してほしい' : /連絡|れんらく/.test(m[4]) ? '連絡してほしい' : '伝えてほしい';
  return `${m[1]}${m[2] ?? ''}に${verb}と頼まれました（こちらからは連絡していません）`;
}

/**
 * 家族への通知の理由の言い回しを会話調に揃える（report-design 0 節:「訴え」「発話」「発言」は使わない）。
 * LLM が道具に書いた理由（例「転倒の訴えがありました」）にかける最後の守り
 */
export function familyWording(reason: string): string {
  return reason
    .replace(/(転倒|転んだこと)の訴えが?(ありました|あります)?/g, '転んだとおっしゃいました')
    .replace(/痛みの訴えが?(ありました|あります)?/g, '痛いとおっしゃいました')
    .replace(/の訴えが(ありました|あります)/g, 'についてお話がありました')
    .replace(/を訴え(ました|ています|た)/g, 'とおっしゃいました')
    .replace(/訴え/g, 'お話')
    .replace(/発話|発言/g, 'お言葉');
}
const DEPARTURE_REASON = '準備完了、デイへ出発';

/** お迎えが来て出発したら家族へ info で短く知らせる（docs/03 §4、docs/01 §5.1）。urgent/check があるときは足さない */
function wantsDepartureNotice(task: TaskKey, status: Classification, hasHigherNotice: boolean): boolean {
  return task === 'pickup' && status === 'done' && !hasHigherNotice;
}

function l4Intent(input: TurnInput, hit: L4Hit): Extract<Intent, { type: 'notify' }> {
  return {
    type: 'notify', level: 'urgent', reason: l4Reason(hit), evidence: excerpt(input.replyText, 40),
    origin: hit.group === 'fire' ? 'fire' : 'l4_words',
  };
}

function painNotify(input: TurnInput, p: PainHit): Extract<Intent, { type: 'notify' }> {
  return { type: 'notify', level: 'check', reason: painReason(p), evidence: excerpt(input.replyText, 40), origin: 'pain' };
}

function painFollowup(input: TurnInput, p: PainHit): Extract<Intent, { type: 'followup' }> {
  return {
    type: 'followup', minutes: PAIN_FOLLOWUP_MINUTES, task: input.prompt.task, text: painFollowupText(p),
    reason: `痛みの聞き直し（${p.part ?? '場所は不明'}）`,
  };
}

export function buildRulesOutcome(input: TurnInput, startedAt = Date.now()): TurnOutcome {
  const task = input.prompt.task;
  const a = analyzeReply(task, input.replyText, input.household);
  const intents: Intent[] = [ruleRecord(input, a)];
  const urgent = Boolean(a.l4);

  if (a.l4) intents.push(l4Intent(input, a.l4));
  else if (a.pain) intents.push(painNotify(input, a.pain), painFollowup(input, a.pain));
  if (a.contactRequest) {
    intents.push({ type: 'notify', level: 'check', reason: contactReason(input.replyText), evidence: excerpt(input.replyText, 40), origin: 'contact' });
  }
  if (wantsDepartureNotice(task, a.status, urgent || Boolean(a.pain) || a.contactRequest)) {
    intents.push({ type: 'notify', level: 'info', reason: DEPARTURE_REASON, evidence: excerpt(input.replyText, 40), origin: 'departure' });
  }
  // 転倒・痛みなどを訴えた人に同じ確認を繰り返さない（家族へ知らせたので再確認は入れない）
  const wantsRecheck = a.status !== 'done' && !urgent && !a.pain && input.recheckAllowed;
  if (wantsRecheck) {
    intents.push({ type: 'recheck', minutes: recheckMinutesFor(input, a.status), reason: `${TASK_LABELS[task]}: ${a.status}` });
  }
  const confidence = rulesConfidence(a.status);
  return {
    classified: { status: a.status, note: a.note, by: 'rules', confidence, uncertain: confidence < CONFIDENCE_THRESHOLD },
    say: fixedSay(a.status, task, input.household, {
      recheck: wantsRecheck, urgent, contactRequest: a.contactRequest, medicineAnswer: a.medicineAnswer, pain: Boolean(a.pain),
    }),
    expression: expressionFor(a.status, urgent || Boolean(a.pain)),
    toolCalls: [],
    intents,
    latencyMs: Date.now() - startedAt,
  };
}

export class RulesTurnRunner implements TurnRunner {
  async run(input: TurnInput): Promise<TurnOutcome> {
    const startedAt = Date.now();
    if (input.household.killSwitch) return killSwitchOutcome(startedAt);
    const out = postProcess(buildRulesOutcome(input, startedAt), input);
    out.latencyMs = Date.now() - startedAt;
    return out;
  }
}

// ---------------------------------------------------------------------------
// LLM の結果に決定論の保証をかける
// ---------------------------------------------------------------------------

const MAX_SAY_CHARS = 80;
const MAX_SAY_SENTENCES = 2;

/** 本人へ返す一言を整える: Markdown 記号・絵文字を除き、2 文・80 文字以内 */
export function sanitizeSay(raw: string): string {
  let s = raw
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')            // [文](url) → 文
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '') // 見出し・引用・箇条書き
    .replace(/[*_`~#|]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s*\n+\s*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const sentences = s.match(/[^。！？!?]+[。！？!?]*/g) ?? [];
  s = sentences.slice(0, MAX_SAY_SENTENCES).join('').trim();
  if (s.length > MAX_SAY_CHARS) {
    const cut = s.slice(0, MAX_SAY_CHARS);
    const lastEnd = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
    s = lastEnd >= 10 ? cut.slice(0, lastEnd + 1) : cut;
  }
  return s;
}

/** 本人に「家族に知らせた」と告げる言い回し（催促に監視の構図を添えない。criteria 3-1 注記） */
const TELLS_FAMILY_NOTICE = /(ご)?家族[^。]{0,6}(知らせ|お知らせ|連絡|伝え)/;

function notifyKey(i: Extract<Intent, { type: 'notify' }>): string {
  return `${i.level}:${i.origin ?? 'other'}`;
}

/** 由来の付いていない notify（LLM の道具から来たもの）に、返事の分析から由来を付ける */
function inferOrigin(n: Extract<Intent, { type: 'notify' }>, a: ReplyAnalysis, task: TaskKey): NoticeOrigin {
  if (n.level === 'urgent') return a.l4?.group === 'fire' ? 'fire' : 'l4_words';
  if (n.level === 'check' && a.pain) return 'pain';
  if (n.level === 'check' && a.contactRequest) return 'contact';
  if (n.level === 'info' && task === 'pickup') return 'departure';
  return 'other';
}

/**
 * LLM（または規則）の結果に決定論の保証をかける。
 * - record intent はちょうど 1 つ（無ければ規則で補う、複数なら最初）。項目はこのターンの項目に固定
 * - 確信度: 規則の record は 1.0（unclear は 0.5）。LLM が付けた値はそのまま。0.7 未満は uncertain
 * - L4 は群 A/B/C の語と火災の語だけ（criteria 3-2）。語が無いのに LLM が urgent を出したら check に下げる
 * - L4 の語があるのに urgent が無ければ足す。痛みの言葉（L4 でない）に check と 3 時間後の聞き直し（followup）を足す
 * - 外部連絡の依頼に check（contact）を足す。お迎え（pickup）done で他の通知が無ければ info（出発）を足す
 * - 同じ段階・同じ由来の notify は 1 件に
 * - recheckAllowed=false なら recheck を消す。recheck は 1 つ、分は 5 以上・規則の分数以下に丸める
 * - done 以外で recheck が無く、再確認できて L4・痛みでもなければ recheck を補う
 * - 承認のない share_external は blocked に変える（beforeToolCallback との二重の守り）
 * - say は Markdown 除去、2 文・80 文字以内。空なら規則の固定文。L4 は定型文。本人に「家族に知らせた」とは言わない
 * - blocked intent はそのまま残す（台帳に「止めた」を残すため）
 */
export function postProcess(outcome: TurnOutcome, input: TurnInput): TurnOutcome {
  const task = input.prompt.task;
  const analysis = analyzeReply(task, input.replyText, input.household);
  const intents: Intent[] = [];
  let record: Extract<Intent, { type: 'record' }> | null = null;
  let recheckIn: Extract<Intent, { type: 'recheck' }> | null = null;
  const notices: Array<Extract<Intent, { type: 'notify' }>> = [];
  const others: Intent[] = [];
  const keys = new Set<string>();
  const pushNotify = (n: Extract<Intent, { type: 'notify' }>) => {
    const k = notifyKey(n);
    if (keys.has(k)) return;
    keys.add(k);
    notices.push(n);
  };

  for (const it of outcome.intents) {
    switch (it.type) {
      case 'record':
        if (!record) record = { ...it, task };
        break;
      case 'recheck':
        if (input.recheckAllowed && !recheckIn) recheckIn = it;
        break;
      case 'followup':
        // 聞き直しは規則で決める（痛みのときだけ）。下で付け直す
        break;
      case 'notify': {
        let n = it;
        if (n.level === 'urgent' && !analysis.l4) {
          // L4 は語で決める。語が無ければ check に下げる（痛みなら L3 の痛み）
          n = { ...n, level: 'check', origin: analysis.pain ? 'pain' : (n.origin && n.origin !== 'l4_words' && n.origin !== 'fire' ? n.origin : 'other') };
        }
        if (!n.origin) n = { ...n, origin: inferOrigin(n, analysis, task) };
        if (analysis.l4 && n.origin === 'pain') break;   // L4 を優先し、痛みの check を重ねない
        // 理由は規則で決まるものは規則の文に揃え、それ以外も会話調にする（LLM の「転倒の訴えがありました」等を残さない）
        if ((n.origin === 'l4_words' || n.origin === 'fire') && analysis.l4) n = { ...n, reason: l4Reason(analysis.l4) };
        else if (n.origin === 'pain' && analysis.pain) n = { ...n, reason: painReason(analysis.pain) };
        else if (n.origin === 'contact') n = { ...n, reason: contactReason(input.replyText) };
        else n = { ...n, reason: familyWording(n.reason) };
        pushNotify(n);
        break;
      }
      case 'share_external':
        if (input.familyApprovedShare) others.push(it);
        else others.push({ type: 'blocked', tool: 'share_external', args: { recipient: it.recipient }, reason: '家族の承認がない' });
        break;
      case 'blocked':
        others.push(it);
        break;
    }
  }

  if (!record) record = ruleRecord(input, analysis);
  const hasLevel = (lv: string) => notices.some(n => n.level === lv);
  if (analysis.l4 && !hasLevel('urgent')) pushNotify(l4Intent(input, analysis.l4));
  let followup: Extract<Intent, { type: 'followup' }> | null = null;
  if (analysis.pain) {
    if (!keys.has('check:pain')) pushNotify(painNotify(input, analysis.pain));
    followup = painFollowup(input, analysis.pain);
  }
  if (analysis.contactRequest && !keys.has('check:contact')) {
    pushNotify({ type: 'notify', level: 'check', reason: contactReason(input.replyText), evidence: excerpt(input.replyText, 40), origin: 'contact' });
  }
  if (!hasLevel('info') && wantsDepartureNotice(task, record.status, hasLevel('urgent') || hasLevel('check'))) {
    pushNotify({ type: 'notify', level: 'info', reason: DEPARTURE_REASON, evidence: excerpt(input.replyText, 40), origin: 'departure' });
  }

  const urgent = hasLevel('urgent');
  const alerted = urgent || Boolean(analysis.pain);
  const maxMinutes = recheckMinutesFor(input, record.status);
  let recheck: Extract<Intent, { type: 'recheck' }> | null = null;
  if (input.recheckAllowed && !alerted && record.status !== 'done') {
    recheck = recheckIn
      // 規則の分数（お迎えからの逆算・予定の無い日の 30 分・返事なしの 15 分）より長くはしない
      ? { ...recheckIn, minutes: clamp(Math.min(Math.round(recheckIn.minutes), maxMinutes), MIN_RECHECK, MAX_RECHECK) }
      // 取れなかった項目は再確認の対象（docs/02 §4, §5）
      : { type: 'recheck', minutes: maxMinutes, reason: `${TASK_LABELS[task]}: ${record.status}（規則で補完）` };
  }

  intents.push(record);
  if (recheck) intents.push(recheck);
  intents.push(...notices);
  if (followup) intents.push(followup);
  intents.push(...others);

  // 確信度
  const confidence = typeof record.confidence === 'number' && Number.isFinite(record.confidence)
    ? Math.max(0, Math.min(1, record.confidence))
    : (outcome.classified.by === 'rules' || record.status === 'unclear' ? rulesConfidence(record.status) : undefined);
  const classified: TurnOutcome['classified'] = { status: record.status, note: record.note, by: outcome.classified.by };
  if (confidence !== undefined) {
    classified.confidence = confidence;
    classified.uncertain = confidence < CONFIDENCE_THRESHOLD;
  }

  let say = sanitizeSay(outcome.say ?? '');
  // 本人に頼まれた外部連絡: 自分では連絡しないので「かしこまりました」等で終えず、家族に伝えると返す（criteria 3-5）
  const declinesContact = /家族[^。]{0,8}(伝え|お伝え|知らせ)|連絡(は)?でき(ない|ません)/.test(say);
  if (urgent) {
    say = L4_SAY;
  } else if (!say || (TELLS_FAMILY_NOTICE.test(say) && !analysis.contactRequest) || (analysis.contactRequest && !declinesContact)) {
    say = fixedSay(record.status, task, input.household, {
      recheck: Boolean(recheck), urgent, contactRequest: analysis.contactRequest, medicineAnswer: analysis.medicineAnswer,
      pain: Boolean(analysis.pain),
    });
  }

  return {
    ...outcome,
    classified,
    say,
    expression: expressionFor(record.status, alerted),
    intents,
  };
}
