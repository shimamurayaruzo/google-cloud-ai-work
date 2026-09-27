// ログに個人を特定できる値をそのまま出さないためのマスク。

/** LINE の userId などの ID。先頭 4 文字と末尾 2 文字だけ残す */
export function maskId(id: string | undefined | null): string {
  if (!id) return '';
  if (id.length <= 6) return '***';
  return `${id.slice(0, 4)}***${id.slice(-2)}`;
}

/** メールアドレス。ローカル部の先頭 1 文字とドメインの先頭 1 文字だけ残す */
export function maskEmail(email: string | undefined | null): string {
  if (!email) return '';
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot >= 0 ? domain.slice(dot) : '';
  return `${local[0]}***@${domain[0] ?? ''}***${tld}`;
}

/** 文字数で切り詰める（サロゲートペアを壊さない） */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}
