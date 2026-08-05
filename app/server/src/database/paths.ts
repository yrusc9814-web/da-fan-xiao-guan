import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const schemaDirectory = resolve(projectRoot, 'app/server/prisma');

export const defaultDatabaseUrl = 'file:../../../data/app.db';

export function filePathFromDatabaseUrl(databaseUrl: string): string | null {
  if (!databaseUrl.startsWith('file:')) {
    return null;
  }

  const databasePath = databaseUrl.slice('file:'.length);
  return databasePath.startsWith('/') ? databasePath : resolve(schemaDirectory, databasePath);
}

export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const rawUrl = env.TEST_DATABASE_URL ?? env.DATABASE_URL ?? defaultDatabaseUrl;

  if (!rawUrl.startsWith('file:')) {
    return rawUrl;
  }

  const absolutePath = filePathFromDatabaseUrl(rawUrl);
  return absolutePath ? `file:${absolutePath}` : rawUrl;
}
