import { assertFreshBuild, configuration, isolatedEnvironment } from './isolation-gate.mjs';
import { assertFormalStorageUnchanged } from './formal-storage-gate.mjs';
const formal = assertFormalStorageUnchanged();
const env = isolatedEnvironment();
assertFreshBuild();
const source = await configuration(env);
const built = await configuration(env, true);
if (JSON.stringify(source) !== JSON.stringify(built)) throw new Error('source/dist resolver mismatch');
console.log(JSON.stringify({ status: 'READY_FOR_MAIN_GATE', formal, ...built, probePid: process.pid }, null, 2));
