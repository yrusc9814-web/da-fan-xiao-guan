export function itemsFrom<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object' && 'items' in value && Array.isArray((value as { items: unknown }).items)) {
    return (value as { items: T[] }).items;
  }
  return [];
}

export function withSelected<T extends { id: string }>(items: T[], selectedIds: string[], cache: T[]): T[] {
  const seen = new Set(items.map((item) => item.id));
  const extra = cache.filter((item) => selectedIds.includes(item.id) && !seen.has(item.id));
  return extra.length ? [...extra, ...items] : items;
}
