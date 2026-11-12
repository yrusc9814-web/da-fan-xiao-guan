import { spawn } from 'node:child_process';
import { assertPortAvailable } from './check-isolated-port.mjs';
import { resolve } from 'node:path';
import { assertFreshBuild, configuration, isolatedEnvironment, repository } from './isolation-gate.mjs';
import { assertFormalStorageUnchanged } from './formal-storage-gate.mjs';
assertFormalStorageUnchanged();
const env = isolatedEnvironment();
assertFreshBuild();
const source = await configuration(env);
const built = await configuration(env, true);
if (JSON.stringify(source) !== JSON.stringify(built)) throw new Error('source/dist resolver mismatch');
await assertPortAvailable(env.HOST, env.PORT);
assertFreshBuild();
const child = spawn(process.execPath, [resolve(repository, 'scripts/isolated-service.mjs')], {
  cwd: repository,
  env,
  stdio: 'inherit'
});
console.log(JSON.stringify({ event: 'isolated-spawn', launcherPid: process.pid, servicePid: child.pid, ...built }));
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
