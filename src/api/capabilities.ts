// 「できること・できないこと」の一覧（docs/01 §6.1 の権限段階）。
// GET /api/family/capabilities がこのまま返す。家族画面はそのまま表示する。
// 段階を変えるときは docs/01 §6.1 と docs/02 §4 を先に直す。

export interface CapabilityLevel {
  /** 機械向けのキー */
  key: 'auto' | 'auto_with_evidence' | 'after_approval' | 'never';
  /** 画面に出す名前 */
  label: string;
  /** 何をするか（1 文） */
  description: string;
  examples: string[];
}

export const CAPABILITIES: {
  version: string;
  title: string;
  note: string;
  levels: CapabilityLevel[];
  stopSwitch: string;
  privacy: string[];
} = {
  version: '2026-09-27',
  title: 'このエージェントができること・できないこと',
  note: '判断に迷うことは決めつけず、ご家族に「確認してほしい」とお返しします。',
  levels: [
    {
      key: 'auto',
      label: '自動で行う',
      description: 'ご家族の操作なしで行います。行ったことはすべて行動台帳に残ります。',
      examples: [
        '決まった時刻の声かけ（着替え、歯磨き、昼食、服薬など）',
        '返事がないときや「まだ」のときの再確認（同じ項目は 1 回まで）',
        '夕方の「今日の様子」のお届け（引用付き）',
        'ご家族への注意のお知らせ（静かな時間帯は翌朝にまとめます）',
      ],
    },
    {
      key: 'auto_with_evidence',
      label: '自動で行い、根拠を添える',
      description: 'すぐにお知らせし、きっかけになった言葉や状態を添えます。「確認した」が押されなければ次のご家族へ順にお知らせします。',
      examples: [
        '「痛い」「転んだ」などの言葉があったとき',
        '声かけへの返事が続けてないとき',
        '端末（iPad）が応答しなくなったとき',
      ],
    },
    {
      key: 'after_approval',
      label: 'ご家族の承認後に行う',
      description: 'ご家族が内容を確認して「承認」したときだけ行います。一文だけ直して承認することもできます。',
      examples: [
        '医師・ケアマネジャーへの様子の共有',
        '声かけ計画や通知先などの設定の変更',
        '朝の声かけ計画の確定',
      ],
    },
    {
      key: 'never',
      label: '行わない',
      description: '頼まれても行いません。代わりにご家族へ「こう頼まれました」とお伝えします。',
      examples: [
        '病気の診断や薬の量の判断',
        'ご本人に頼まれた外部への電話・連絡',
        'カメラでの撮影、会話の録音の保存',
      ],
    },
  ],
  stopSwitch: '「今すぐ止める」を押すと、声かけとお知らせをすべて止めます。ご本人には「少し休みますね」とだけお伝えします。',
  privacy: [
    '音声は保存しません。文字にした短い抜粋だけを残し、7 日で削除します。',
    'テレビや来訪者の声など、ご本人の言葉か分からないものは「判定できない」として扱います。',
  ],
};
