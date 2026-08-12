import 'dotenv/config';

import { defineConfig } from 'prisma/config';

import { resolveDatabaseUrl } from './app/server/src/database/paths.ts';

export default defineConfig({
  schema: 'app/server/prisma/schema.prisma',
  migrations: {
    path: 'app/server/prisma/migrations'
  },
  datasource: {
    url: resolveDatabaseUrl()
  }
});
