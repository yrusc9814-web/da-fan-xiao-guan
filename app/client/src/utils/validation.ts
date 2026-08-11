export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

export function finiteInRange(value: string | number, minimum: number, maximum = Number.POSITIVE_INFINITY): boolean {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum;
}

export function positiveInteger(value: string | number): boolean {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1;
}
