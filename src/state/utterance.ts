// 本人からの発話（声かけへの返事ではないもの。docs/02 §11.2）。POST /api/device/utterance と、
// 返事を求めない声かけ（ときたまの声かけ等）への返事がここに来る。規則を先に、文脈が要るものだけ LLM。
//
//   1. L4 の語・痛みの語 → 基準 v2 と同じ通知（urgent は L4 モードへ、check は 3 時間後の聞き直し付き）。外部連絡の依頼も check
//   2. テレビ・雑音の印（本人の発話か分からない）→ 返事をしない（say 空）。記録は turn に残す（unclear）
//   3. 薬の質問（「何の薬」「どこにある」）→ docs/03 の決まり文句
//   4. 居場所の質問（「どこ」「行った」「いない」「帰って」「○○さんは」）→ whereabouts から毎回同じ文
//   5. それ以外 → 小さな LLM 呼び出しで 1 文（agent/chat.ts）。AGENT_MODE=rules・失敗・確信度 0.7 未満は固定文。
//      本人に向けた発話でない（テレビ等）と LLM が判断したら返事をしない
// 記録は turns（kind: utterance, task: talk）。本文は 7 日 TTL。夕方要約の「お返事の記録」には載せない（summary.ts の isNormal）。
// 同じ種類の質問が 30 分以内に繰り返されたら signals.repeatedQuestions に数える。

import { config, type AgentMode } from '../config.js';
import { logError, logEvent } from '../log.js';
import type { AppContext, NotifyRequest } from '../services.js';
import { addMinutes, dateKey, hm } from '../time.js';
import {
  newId, type Classification, type Expression, type HouseholdId, type Notice, type Prompt, type ReplySource, type Turn,
  type UtteranceKind,
} from '../types.js';
import {
  CONFIDENCE_THRESHOLD, CONTACT_SAY, L4_SAY, contactReason, PAIN_FOLLOWUP_MINUTES, PAIN_SAY, REASSURANCE_SAY, analyzeReply, detectL4,
  detectPain, excerpt as ruleExcerpt, isLikelyNotPerson, l4Reason, painFollowupText, painReason,
} from '../agent/rules.js';
import { CHAT_FALLBACK_SAY, chatReply as defaultChatReply, isAcceptableChatSay, type ChatReplyFn } from '../agent/chat.js';
import { currentDegraded, recordIncident } from '../ops/health.js';
import { ensureDay } from './day.js';
import { NotFoundError } from './errors.js';
import { appendLedger, excerpt } from './ledger.js';
import { currentL4, startL4 } from './l4.js';
import { REPEAT_WINDOW_MINUTES, TURN_TTL_MINUTES, isRepeatedQuestion, safeNotify, scheduleFollowup } from './turn.js';
import { isWhereaboutsQuestion, whereaboutsSay } from './whereabouts.js';

const MAX_TEXT = 500;
/** 停止中の一言（docs/02 §4） */
const PAUSED_SAY = '少し休みますね。';

export interface UtteranceArgs {
  hh: HouseholdId;
  text: string;
  source: ReplySource;
  now: Date;
  /** 返事を求めない声かけへの返事のとき、その声かけ */
  prompt?: Prompt | null;
}

export interface UtteranceResult {
  turn: Turn;
  say: string;
  expression: Expression;
  kind: UtteranceKind;
  notices: Notice[];
}

export interface UtteranceOptions {
  /** テスト用: LLM 呼び出しの差し替え */
  chat?: ChatReplyFn;
  /** 省略時 config.agentMode。rules なら LLM を呼ばない */
  agentMode?: AgentMode;
}

/** 薬の質問か（「何の薬」「薬はどこ」）。答えは呼び方の決まりから */
function medicineAnswer(text: string, household: Parameters<typeof analyzeReply>[2]): string | null {
  if (!/薬|くすり/.test(text)) return null;
  return analyzeReply('talk', text, household).medicineAnswer;
}

export async function handleUtterance(
  ctx: AppContext,
  args: UtteranceArgs,
  opts: UtteranceOptions = {},
): Promise<UtteranceResult> {
  const { hh, source, now, prompt } = args;
  const household = await ctx.store.getHousehold(hh);
  if (!household) throw new NotFoundError(`household not found: ${hh}`);
  const text = args.text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  const date = dateKey(now);
  const day = await ensureDay(ctx, hh, date);
  const todayTurns = await ctx.store.listTurns(hh, date);
  const startedAt = Date.now();
  const turnId = newId('tn');

  let kind: UtteranceKind;
  let say = '';
  let expression: Expression = 'listen';
  let status: Classification = 'done';
  let note: string;
  let by: 'rules' | 'llm' = 'rules';
  let confidence = 1;
  const pending: Array<Omit<NotifyRequest, 'hh' | 'date' | 'turnId' | 'now'>> = [];
  let painFollow: { text: string; reason: string } | null = null;
  let l4NoticeId: string | null = null;

  const l4Active = household.killSwitch ? null : await currentL4(ctx, hh, date, day, now);
  if (household.killSwitch) {
    kind = 'ignored'; say = PAUSED_SAY; expression = 'think'; status = 'unclear'; note = '停止中'; confidence = 0.5;
  } else if (l4Active) {
    // L4 の間は判定しない。安心文を返し、言葉と時刻を通知の根拠に追記する（state/turn.ts の L4 中の返事と同じ）
    kind = 'notice'; say = REASSURANCE_SAY; expression = 'worry'; status = 'unclear'; note = 'L4 の間のお言葉（判定しない）';
    l4NoticeId = l4Active.noticeId;
  } else {
    const l4 = detectL4(text);
    const pain = l4 ? null : detectPain(text);
    const analysis = analyzeReply('talk', text, household);
    const medicine = medicineAnswer(text, household);
    if (l4) {
      kind = 'notice'; say = L4_SAY; expression = 'worry'; note = `L4 の語「${l4.word}」`;
      pending.push({ level: 'urgent', reason: l4Reason(l4), evidence: ruleExcerpt(text, 40), task: 'talk', origin: l4.group === 'fire' ? 'fire' : 'l4_words' });
    } else if (pain) {
      kind = 'notice'; say = PAIN_SAY; expression = 'worry'; note = `痛みの言葉「${pain.word}」`;
      pending.push({ level: 'check', reason: painReason(pain), evidence: ruleExcerpt(text, 40), task: 'talk', origin: 'pain' });
      painFollow = { text: painFollowupText(pain), reason: `痛みの聞き直し（${pain.part ?? '場所は不明'}）` };
    } else if (isLikelyNotPerson(text)) {
      kind = 'ignored'; say = ''; expression = 'think'; status = 'unclear'; confidence = 0.5;
      note = '本人の声か分からない（テレビ・来客・雑音の可能性）';
    } else if (analysis.contactRequest) {
      kind = 'notice'; say = CONTACT_SAY; expression = 'listen'; note = '外部への連絡の依頼';
      pending.push({ level: 'check', reason: contactReason(text), evidence: ruleExcerpt(text, 40), task: 'talk', origin: 'contact' });
    } else if (medicine) {
      kind = 'medicine'; say = medicine; expression = 'smile'; note = '服薬の質問';
    } else if (isWhereaboutsQuestion(text, household)) {
      kind = 'whereabouts'; say = whereaboutsSay(household, now); expression = 'smile'; note = '居場所の質問';
    } else {
      kind = 'chat'; note = '会話';
      const degraded = currentDegraded(await ctx.store.getHealth(hh, date), now);
      const mode = opts.agentMode ?? config.agentMode;
      if (mode === 'rules' || degraded?.llm === 'rules') {
        say = CHAT_FALLBACK_SAY; expression = 'smile';
      } else {
        try {
          const out = await (opts.chat ?? defaultChatReply)({
            text, callName: household.person.callName, now, ...(prompt?.text ? { promptText: prompt.text } : {}),
          });
          by = 'llm';
          confidence = out.confidence;
          if (!out.addressed) {
            // 本人に向けた発話ではなさそう（テレビ等）→ 返事をしない
            kind = 'ignored'; say = ''; status = 'unclear'; expression = 'think'; note = '本人に向けた言葉ではない（LLM の判断）';
          } else if (out.confidence < CONFIDENCE_THRESHOLD || !isAcceptableChatSay(out.say)) {
            say = CHAT_FALLBACK_SAY; expression = 'smile'; note = '会話（固定文で返した）';
          } else {
            say = out.say; expression = 'smile';
          }
        } catch (error) {
          logError('chat_reply_failed', error, { hh, date });
          await recordIncident(ctx.store, hh, 'llm_error', 'fallback', 'chat_reply_failed', now);
          say = CHAT_FALLBACK_SAY; expression = 'smile'; note = '会話（LLM が失敗したため固定文）';
        }
      }
    }
  }

  const turn: Turn = {
    id: turnId, hh, date,
    promptId: prompt?.id ?? 'utterance',
    task: 'talk',
    promptedAt: prompt?.deliveredAt ?? prompt?.scheduledAt ?? now,
    promptText: prompt?.text ?? '',
    replyText: text,
    replySource: source,
    repliedAt: now,
    classified: { status, note, by, confidence, uncertain: confidence < CONFIDENCE_THRESHOLD },
    kind: 'utterance',
    utteranceKind: kind,
    toolCalls: [],
    say,
    expression,
    latencyMs: Date.now() - startedAt,
    expiresAt: addMinutes(now, TURN_TTL_MINUTES),
  };
  // 通知の引用先として先に保存する
  await ctx.store.putTurn(turn);
  await appendLedger(ctx, {
    hh, date, at: now, kind: 'prompt', name: 'utterance_received', turnId, ...(l4NoticeId ? { noticeId: l4NoticeId } : {}),
    args: { kind, source, text: excerpt(text, 20), ...(prompt ? { promptId: prompt.id } : {}) },
    result: { by, say: say ? excerpt(say, 40) : '' },
  });

  // ---- 通知（基準 v2 と同じ）----
  const notices: Notice[] = [];
  let l4Started = false;
  for (const req of pending) {
    const n = await safeNotify(ctx, { hh, date, turnId, now, ...req });
    if (!n) continue;
    notices.push(n);
    if (n.level === 'urgent') l4Started = Boolean(await startL4(ctx, hh, date, day, n, 'talk', now)) || l4Started;
    if (n.origin === 'pain' && painFollow) {
      await scheduleFollowup(ctx, household, {
        hh, date, now, turnId, noticeId: n.id,
        intent: { type: 'followup', minutes: PAIN_FOLLOWUP_MINUTES, task: 'talk', text: painFollow.text, reason: painFollow.reason },
      });
    }
  }
  if (l4NoticeId && !isLikelyNotPerson(text)) {
    const n = await ctx.store.getNotice(hh, l4NoticeId);
    if (n) {
      const add = `${hm(now)}「${ruleExcerpt(text, 30)}」`;
      const evidence = Array.from(n.evidence ? `${n.evidence}／${add}` : add).slice(0, 300).join('');
      await ctx.store.updateNotice(hh, l4NoticeId, { evidence });
    }
  }

  // ---- 変化評価の元データ: 同じ種類の質問が 30 分以内に繰り返されたら数える ----
  const signals = { ...day.signals };
  let changed = false;
  if (repeatedKind(kind, text, todayTurns, now)) { signals.repeatedQuestions += 1; changed = true; }
  if (l4Started) { signals.urgentCount += 1; changed = true; }
  if (changed) await ctx.store.updateDay(hh, date, { signals });

  logEvent('utterance_received', {
    hh, date, turnId, kind, by, textLength: text.length, notices: notices.map(n => n.level), source,
  });
  return { turn, say, expression, kind, notices };
}

/** 同じ種類の質問の繰り返しか（居場所・薬は種類で、それ以外は同じ文の質問で。30 分以内） */
function repeatedKind(kind: UtteranceKind, text: string, todayTurns: Turn[], now: Date): boolean {
  if (kind === 'whereabouts' || kind === 'medicine') {
    const since = addMinutes(now, -REPEAT_WINDOW_MINUTES).getTime();
    return todayTurns.some(t => t.kind === 'utterance' && t.utteranceKind === kind
      && t.repliedAt.getTime() >= since && t.repliedAt.getTime() <= now.getTime());
  }
  if (kind === 'chat') return isRepeatedQuestion(text, todayTurns, now);
  return false;
}
