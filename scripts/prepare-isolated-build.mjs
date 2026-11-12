import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { configuration, fingerprintBuild, isolatedEnvironment, isolationRoot, repository } from './isolation-gate.mjs';
const env = isolatedEnvironment();
await configuration(env);
const result = spawnSync(
  process.execPath,
  [resolve(repository, 'node_modules/typescript/bin/tsc'), '-p', 'app/server/tsconfig.build.json'],
  { cwd: repository, env, stdio: 'inherit' }
);
if (result.error || result.status !== 0) throw result.error ?? new Error(`build failed: ${result.status}`);
const source = await configuration(env);
const built = await configuration(env, true);
if (JSON.stringify(source) !== JSON.stringify(built)) throw new Error('source/dist resolver mismatch');
writeFileSync(
  resolve(isolationRoot, 'evidence/build-receipt.json'),
  JSON.stringify(
    { schemaVersion: 1, repository, builtAt: new Date().toISOString(), files: fingerprintBuild() },
    null,
    2
  )
);
console.log(JSON.stringify({ status: 'PASS', configuration: built }));
