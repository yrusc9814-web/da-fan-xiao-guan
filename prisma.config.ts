import 'dotenv/config';

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'prisma/config';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const schemaDirectory = resolve(projectRoot, 'app/server/prisma');
const rawDatabaseUrl = process.env.DATABASE_URL ?? 'file:../../../data/app.db';

function resolveDatabaseUrl(databaseUrl: string): string {
  if (!databaseUrl.startsWith('file:')) {
    return databaseUrl;
  }

  const databasePath = databaseUrl.slice('file:'.length);
  if (databasePath.startsWith('/')) {
    return databaseUrl;
  }

  return `file:${resolve(schemaDirectory, databasePath)}`;
}

export default defineConfig({
  schema: 'app/server/prisma/schema.prisma',
  migrations: {
    path: 'app/server/prisma/migrations'
  },
  datasource: {
    url: resolveDatabaseUrl(rawDatabaseUrl)
  }
});
