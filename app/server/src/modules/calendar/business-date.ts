/**
 * 业务日期（YYYY-MM-DD）严格校验：形状 + 真实日历日期。
 *
 * 只接受四位年、补零月日；`2026-02-31`（不存在的日期）、平年 `02-29`、
 * `2026-13-01` 等一律 false，不做 rollover 归一，也不把 `2026-9-1` 当成合法值。
 * 日历接口与即时用餐写入共用同一口径，避免出现「库里有一条但任何视图都不显示」的记录。
 */
export function isValidBusinessDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  // 显式 UTC 构造：new Date(year, ...) 对 0..99 年会加 1900 偏移；逐字段回读拒绝 rollover。
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
