import type { PrismaClient } from '@prisma/client';

export const tokens = (value: string | null | undefined) =>
  value
    ?.split(/[、,，;；\s]+/)
    .map((x) => x.trim().toLocaleLowerCase())
    .filter(Boolean) ?? [];

export function forbidden(haystack: string, words: string[]) {
  const lower = haystack.toLocaleLowerCase();
  return words.some((word) => lower.includes(word));
}

export async function loadForbiddenWords(database: PrismaClient, dinerIds?: string[]): Promise<string[]> {
  if (!dinerIds?.length) return [];
  const diners = await database.diner.findMany({ where: { id: { in: dinerIds }, active: true } });
  return diners.flatMap((d) => [...tokens(d.allergyText), ...tokens(d.tabooText), ...tokens(d.dislikesText)]);
}
