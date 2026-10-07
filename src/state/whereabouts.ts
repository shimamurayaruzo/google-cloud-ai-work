// 家族の居場所（docs/02 §11.1・§11.2）。本人の「○○さんはどこ？」に、毎回同じ言い方で短く答える。
// 「さっきも言った」系の言葉は決して出さない（何度聞かれても同じ文を返す）。
// 登録は家族画面（PUT /api/family/whereabouts）。その日に登録したものだけを使う（前の日の行き先は言わない）。

import { dateKey, hhmm, spokenTime, toMinutes } from '../time.js';
import type { Household, Whereabouts } from '../types.js';

/** 居場所の質問の印（「どこ」「行った」「いない」「帰って」「出かけ」）。「家に帰りたい」は拾わない */
const WHEREABOUTS_WORDS = /どこ|何処|行った|いった|行ってる|いってる|いない|居ない|帰って|かえって|出かけ|でかけ|出掛け/;

/** 答えに使う家族の名前（通知の順番が一番の人）。無ければ「ご家族」 */
export function familyName(h: Pick<Household, 'members'>): string {
  const first = [...(h.members ?? [])].sort((a, b) => a.order - b.order)[0];
  const name = first?.name?.trim();
  return name ? name.replace(/さん$/, '') : 'ご家族';
}

/** 今日登録された居場所（前の日のものは古いので使わない） */
export function currentWhereabouts(h: Pick<Household, 'whereabouts'>, now: Date): Whereabouts | null {
  const w = h.whereabouts;
  if (!w || !w.place) return null;
  const at = w.updatedAt instanceof Date ? w.updatedAt : new Date(w.updatedAt);
  if (Number.isNaN(at.getTime()) || dateKey(at) !== dateKey(now)) return null;
  return w;
}

/** 居場所の質問か（家族の名前が出てくる、「○○さんは」、または居場所の印） */
export function isWhereaboutsQuestion(text: string, h: Pick<Household, 'members'>): boolean {
  const t = text.trim();
  if (!t) return false;
  const names = (h.members ?? []).map(m => m.name?.trim()).filter((n): n is string => Boolean(n));
  if (names.some(n => t.includes(n.replace(/さん$/, '')))) return true;
  if (/さんは/.test(t)) return true;
  return WHEREABOUTS_WORDS.test(t);
}

/**
 * 本人へ読み上げる答え（毎回同じ文）。
 *  登録あり・帰る時刻の前 …「{name}さんは、{place}に行っています。{H 時 M 分}ごろ帰ります。」
 *                          （仕事→お仕事に行っています、買い物・病院→…に行っています、外出→出かけています）
 *  帰る時刻を過ぎた       …「{name}さんは、もうすぐ帰ってきます。」
 *  帰る時刻が未定         …「{name}さんは、{place}に行っています。」
 *  未登録                 …「{name}さんは出かけています。もうすぐ帰ってきますよ。」
 */
export function whereaboutsSay(h: Pick<Household, 'members' | 'whereabouts'>, now: Date): string {
  const name = familyName(h);
  const w = currentWhereabouts(h, now);
  if (!w) return `${name}さんは出かけています。もうすぐ帰ってきますよ。`;
  if (w.backAt && toMinutes(hhmm(now)) >= toMinutes(w.backAt)) return `${name}さんは、もうすぐ帰ってきます。`;
  const going = placePhrase(w.place);
  if (w.backAt) return `${name}さんは、${going}。${spokenTime(w.backAt)}ごろ帰ります。`;
  return `${name}さんは、${going}。`;
}

/** 行き先ごとの言い方（家族画面は「仕事／買い物／病院／外出」をそのまま送る）。それ以外は「{place}に行っています」 */
const PLACE_PHRASES: Record<string, string> = {
  仕事: 'お仕事に行っています',
  お仕事: 'お仕事に行っています',
  買い物: '買い物に行っています',
  病院: '病院に行っています',
  外出: '出かけています',
};

export function placePhrase(place: string): string {
  const p = place.trim();
  return PLACE_PHRASES[p] ?? `${p}に行っています`;
}
