import { assertFreshBuild, configuration, isolatedEnvironment } from './isolation-gate.mjs';
import { assertFormalStorageUnchanged } from './formal-storage-gate.mjs';
assertFormalStorageUnchanged();
const env = isolatedEnvironment();
assertFreshBuild();
console.log(
  JSON.stringify({
    event: 'isolated-service-configuration',
    servicePid: process.pid,
    ...(await configuration(env, true))
  })
);
await import('../dist-server/server/src/server.js');
