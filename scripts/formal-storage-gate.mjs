import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { requireIsolationRoot, repository } from './isolation-gate.mjs';
// 基线定位可显式注入（供独立验收副本内的测试运行使用）；缺省指向已配置隔离根下的
// 正式基线，未配置 DAFAN_ISOLATION_ROOT 时由 requireIsolationRoot 快速清晰失败。
// 注入值必须是绝对路径；基线缺失/无效/repo 不符仍由下方校验与 ENOENT fail-closed，
// 不存在静默回退或自动更新。
export function resolveForwardBaseline(source = process.env) {
  const injected = source.DAFAN_FORWARD_BASELINE;
  if (injected === undefined) return resolve(requireIsolationRoot(source), 'evidence/formal-baseline-forward.json');
  if (!injected.trim() || !isAbsolute(injected))
    throw new Error('DAFAN_FORWARD_BASELINE must be a non-empty absolute path');
  return resolve(injected.trim());
}
export function assertFormalStorageUnchanged(source = process.env) {
  const root = requireIsolationRoot(source);
  const forwardBaseline = resolveForwardBaseline(source);
  const baseline = JSON.parse(readFileSync(forwardBaseline, 'utf8'));
  if (
    baseline.schemaVersion !== 2 ||
    baseline.status !== 'PASS' ||
    baseline.stable !== true ||
    baseline.repo !== repository
  )
    throw new Error('invalid forward-only formal baseline');
  const output = resolve(root, `evidence/formal-gate-${randomUUID()}.json`);
  const result = spawnSync(
    process.execPath,
    [resolve(repository, 'scripts/snapshot-formal-storage.mjs'), forwardBaseline, output],
    { cwd: repository, encoding: 'utf8' }
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`formal storage forward comparison FAIL; evidence=${output}; ${result.stdout}`);
  return { baseline: forwardBaseline, comparison: output, status: 'PASS', forwardOnly: true };
}
