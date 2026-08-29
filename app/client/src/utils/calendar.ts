export function parseLocalIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

export function toLocalIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function monthRange(year: number, month: number): { start: string; end: string } {
  return {
    start: toLocalIsoDate(new Date(year, month, 1)),
    end: toLocalIsoDate(new Date(year, month + 1, 0))
  };
}

export interface MonthGridCell {
  date: string;
  inCurrentMonth: boolean;
  isToday: boolean;
}

export function mondayFirstOffset(date: Date): number {
  return (date.getDay() + 6) % 7;
}

export function buildMonthGrid(year: number, month: number, today = new Date()): MonthGridCell[] {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const todayIso = toLocalIsoDate(today);
  const leading = mondayFirstOffset(first);
  const start = new Date(year, month, 1 - leading);
  const weeks = Math.ceil((leading + last.getDate()) / 7);
  return Array.from({ length: weeks * 7 }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    const iso = toLocalIsoDate(date);
    return {
      date: iso,
      inCurrentMonth: date.getMonth() === month,
      isToday: iso === todayIso
    };
  });
}
