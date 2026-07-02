/**
 * rate-limit.ts — Parse rate-limit error từ Claude output.
 * Match cả 2 pattern:
 *   - "You've hit your session limit · resets 12pm (Asia/Saigon)"
 *   - "You've hit your Claude usage limit. Your limit will reset at 5am Asia/Ho_Chi_Minh"
 * Trả về ISO timestamp reset, hoặc null nếu không phải rate-limit error.
 */
export function parseRateLimitReset(text: string): string | null {
  if (!/session limit|usage limit|resets? \d/i.test(text)) return null;
  const m = text.match(/reset(?:s| at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return new Date(Date.now() + 60 * 60 * 1000).toISOString();  // fallback +1h
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3]?.toLowerCase();
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  // Message dùng Asia/Saigon (VN, UTC+7). Convert sang UTC.
  const target = new Date();
  let utcH = h - 7;
  if (utcH < 0) utcH += 24;
  target.setUTCHours(utcH, min, 0, 0);
  if (target.getTime() <= Date.now()) target.setUTCDate(target.getUTCDate() + 1);
  return target.toISOString();
}
