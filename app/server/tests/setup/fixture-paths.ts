import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
export const prismaConfigImport = createRequire(import.meta.url)
  .resolve('prisma/config')
  .replaceAll('\\', '/');
import { assertIsolatedPath, resolveIsolationTempDirectory } from '../../src/database/paths.js';

/** Every writable fixture is under the isolated root when isolation is requested. */
export function fixtureDirectory(): string {
  const path = resolveIsolationTempDirectory();
  assertIsolatedPath(path);
  mkdirSync(path, { recursive: true });
  return path;
}

export function fixtureDataRoot(projectRoot: string): string {
  return process.env.DAFAN_ISOLATION_ROOT ? fixtureDirectory() : resolve(projectRoot, 'data');
}
