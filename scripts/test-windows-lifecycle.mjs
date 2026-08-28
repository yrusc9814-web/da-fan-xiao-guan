import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows 发行包生命周期集成测试：真实执行 start.bat / stop.bat，
// 覆盖正常启停、重复启动、stale PID、PID 复用（身份不符）、端口占用、异常退出恢复六个场景。
// 用法：node scripts/test-windows-lifecycle.mjs --package <release包目录>
// 所有测试在发行包的临时副本（scratch）中进行，绝不污染原包；非 Windows 平台打印 SKIP 后退出 0。

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = 8787;
const healthUrl = `http://127.0.0.1:${port}/api/v1/health`;
const appTag = '--app-id=dafan-xiaoguan';
const startTimeoutMs = 120_000;
const stopTimeoutMs = 60_000;

function printUsage() {
  console.log('用法：node scripts/test-windows-lifecycle.mjs --package <release包目录>');
}

let packageArgument;
const cliArguments = process.argv.slice(2);
for (let index = 0; index < cliArguments.length; index += 1) {
  if (cliArguments[index] === '--package') {
    packageArgument = cliArguments[index + 1];
    index += 1;
  }
}
if (!packageArgument) {
  printUsage();
  process.exit(1);
}

if (process.platform !== 'win32') {
  console.log(`SKIP: windows only（当前平台 ${process.platform}，跳过 Windows 生命周期测试）`);
  process.exit(0);
}

const packageRoot = resolve(packageArgument);
if (!existsSync(resolve(packageRoot, 'start.bat')) || !existsSync(resolve(packageRoot, 'runtime', 'node.exe'))) {
  console.error(`[FATAL] --package 不是有效的 Windows 发行包目录（缺 start.bat 或 runtime\\node.exe）：${packageRoot}`);
  process.exit(1);
}

let scratchRoot = '';
const startBatPath = () => resolve(scratchRoot, 'start.bat');
const stopBatPath = () => resolve(scratchRoot, 'stop.bat');
const pidFilePath = () => resolve(scratchRoot, 'data', 'app.pid');

const gbkDecoder = new TextDecoder('gbk');

function decodeOutput(buffer) {
  // cmd 在不同代码页（936/65001）下 echo 的中文字节不同，同时按 UTF-8 与 GBK 解码供断言匹配。
  return [buffer.toString('utf8'), gbkDecoder.decode(buffer)];
}

function outputIncludes(buffer, needle) {
  const mojibakeNeedle = gbkDecoder.decode(Buffer.from(needle, 'utf8'));
  return decodeOutput(buffer).some((text) => text.includes(needle) || text.includes(mojibakeNeedle));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

// 最近一次 runBat 的输出转储（双编码），用例失败时打印，便于在 CI 上定位 bat 失败原因。
let lastBatTranscript = '';

function batOutputTail() {
  if (!lastBatTranscript) return '（无 bat 输出）';
  const tail = lastBatTranscript.slice(-1200);
  return `最近 bat 输出（末尾）：\n${tail}`;
}

function runBat(batPath, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn('cmd.exe', ['/d', '/c', batPath], {
      cwd: scratchRoot,
      env: { ...process.env, DF_NO_BROWSER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      // 双编码（UTF-8 / GBK）转储，选可读性最好的一份用于失败诊断。
      const candidates = [
        stdout.toString('utf8'),
        gbkDecoder.decode(stdout),
        `${stdout.toString('utf8')}\n[stderr]\n${stderr.toString('utf8')}`,
        `${gbkDecoder.decode(stdout)}\n[stderr]\n${gbkDecoder.decode(stderr)}`
      ];
      lastBatTranscript = candidates.reduce(
        (longest, current) => (current.length > longest.length ? current : longest),
        ''
      );
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({
        code: -1,
        timedOut: true,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks)
      });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.once('exit', (code) => {
      finish({ code, timedOut: false, stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks) });
    });
    child.once('error', (error) => {
      finish({
        code: -1,
        error,
        timedOut: false,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks)
      });
    });
  });
}

function runPowerShell(script) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true
  });
}

function processAlive(pid) {
  const result = runPowerShell(
    `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue; if($p){exit 0}else{exit 1}`
  );
  return result.status === 0;
}

function serviceInstanceCount() {
  const result = runPowerShell(
    `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${appTag}*' -and $_.CommandLine -like '*${scratchRoot}*' }).Count`
  );
  return Number.parseInt((result.stdout ?? '').trim(), 10) || 0;
}

function portListenerPids() {
  const result = spawnSync('netstat', ['-ano'], { encoding: 'latin1', windowsHide: true });
  const pids = [];
  for (const line of (result.stdout ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
    if (match && Number(match[1]) === port) {
      pids.push(Number(match[2]));
    }
  }
  return pids;
}

function ensurePortFree(when) {
  const pids = portListenerPids();
  if (pids.length > 0) {
    throw new Error(`${when}端口 ${port} 被意外占用（PID ${pids.join(', ')}），需要人工检查，测试中止`);
  }
}

async function waitForPortRelease(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (portListenerPids().length === 0) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }
  throw new Error(`端口 ${port} 在 ${timeoutMs}ms 内未被释放（占用 PID：${portListenerPids().join(', ') || '未知'}）`);
}

async function fetchHealthOnce() {
  try {
    const response = await fetch(healthUrl);
    return response.status;
  } catch {
    return null;
  }
}

async function waitForHealth(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await fetchHealthOnce()) === 200) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  return false;
}

async function waitForProcessGone(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }
  throw new Error(`进程 ${pid} 在 ${timeoutMs}ms 后仍存活`);
}

async function readPidFile() {
  if (!existsSync(pidFilePath())) return null;
  const content = (await readFile(pidFilePath(), 'utf8')).trim();
  const match = content.match(/^(\d+)\|([0-9a-f]{16})$/);
  if (!match) return null;
  return { pid: Number(match[1]), token: match[2] };
}

function killByPid(pid) {
  return spawnSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8', windowsHide: true });
}

const placeholders = new Map();

// 各 case 直接向 servicePidsStartedByTest 记录由 start.bat 拉起的服务 PID（读自 PID 文件），
// 用于失败路径兜底清理，防止进程泄漏。
let servicePidsStartedByTest = new Set();

async function killTrackedServicePids() {
  for (const pid of servicePidsStartedByTest) {
    if (processAlive(pid)) {
      killByPid(pid);
      await waitForProcessGone(pid, 10_000).catch(() => undefined);
    }
  }
  servicePidsStartedByTest = new Set();
}

function spawnPlaceholder(script) {
  const child = spawn(process.execPath, ['-e', script], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  placeholders.set(child.pid, child);
  return child;
}

async function killPlaceholder(pid) {
  killByPid(pid);
  await waitForProcessGone(pid, 10_000);
  placeholders.delete(pid);
}

async function cleanupPlaceholders() {
  for (const pid of [...placeholders.keys()]) {
    await killPlaceholder(pid);
  }
}

function pickNonexistentPid(candidates) {
  for (const candidate of candidates) {
    if (!processAlive(candidate)) return candidate;
  }
  throw new Error('找不到确定不存在的候选 PID，无法构造 stale PID 文件');
}

async function caseA_normalLifecycle() {
  const started = await runBat(startBatPath(), startTimeoutMs);
  assert(!started.timedOut && started.code === 0, `start.bat 退出码 ${started.code}（预期 0）`);
  assert(await waitForHealth(), '启动后 health 未返回 200');

  const metadata = await readPidFile();
  assert(metadata, 'data/app.pid 缺失或不是 PID|token 格式');
  assert(processAlive(metadata.pid), `PID 文件指向的进程 ${metadata.pid} 不存在`);
  servicePidsStartedByTest.add(metadata.pid);

  const stopped = await runBat(stopBatPath(), stopTimeoutMs);
  assert(stopped.code === 0, `stop.bat 退出码 ${stopped.code}（预期 0）`);
  await waitForProcessGone(metadata.pid);
  assert((await fetchHealthOnce()) === null, 'stop 后 health 仍可访问，服务未真正停止');
  assert(!existsSync(pidFilePath()), 'stop 后 data/app.pid 未被删除');
}

async function caseB_duplicateStart() {
  const firstStart = await runBat(startBatPath(), startTimeoutMs);
  assert(firstStart.code === 0, `首次 start.bat 退出码 ${firstStart.code}（预期 0）`);
  assert(await waitForHealth(), '首次启动后 health 未返回 200');
  const firstMetadata = await readPidFile();
  assert(firstMetadata, '首次启动后 PID 文件缺失或格式非法');
  servicePidsStartedByTest.add(firstMetadata.pid);

  const secondStart = await runBat(startBatPath(), startTimeoutMs);
  assert(secondStart.code === 0, `重复 start.bat 退出码 ${secondStart.code}（预期 0）`);
  assert(outputIncludes(secondStart.stdout, '已经在运行'), '重复启动输出缺少"已经在运行"提示');

  const secondMetadata = await readPidFile();
  assert(secondMetadata, '重复启动后 PID 文件缺失');
  assert(
    secondMetadata.pid === firstMetadata.pid && secondMetadata.token === firstMetadata.token,
    `PID 文件被改动：${firstMetadata.pid}|${firstMetadata.token} -> ${secondMetadata.pid}|${secondMetadata.token}`
  );
  assert(await waitForHealth(), '重复启动后 health 未返回 200');
  const instanceCount = serviceInstanceCount();
  assert(instanceCount === 1, `命令行匹配 ${appTag} 的服务进程数为 ${instanceCount}（预期 1，出现第二实例）`);

  const stopped = await runBat(stopBatPath(), stopTimeoutMs);
  assert(stopped.code === 0, `stop.bat 退出码 ${stopped.code}（预期 0）`);
  await waitForProcessGone(firstMetadata.pid);
}

async function caseC_stalePid() {
  const stalePid = pickNonexistentPid([99999, 99998, 99997]);
  await writeFile(pidFilePath(), `${stalePid}|deadbeefdeadbeef`, 'utf8');

  const started = await runBat(startBatPath(), startTimeoutMs);
  assert(started.code === 0, `start.bat 遇到 stale PID 文件后退出码 ${started.code}（预期 0）`);
  assert(await waitForHealth(), 'stale PID 恢复启动后 health 未返回 200');

  const metadata = await readPidFile();
  assert(metadata, '启动成功后 PID 文件缺失');
  assert(metadata.pid !== stalePid, `PID 文件仍是 stale PID ${stalePid}，未被新服务覆写`);
  assert(processAlive(metadata.pid), `新 PID 文件指向的进程 ${metadata.pid} 不存在`);
  servicePidsStartedByTest.add(metadata.pid);

  const stopped = await runBat(stopBatPath(), stopTimeoutMs);
  assert(stopped.code === 0, `stop.bat 退出码 ${stopped.code}（预期 0）`);
  await waitForProcessGone(metadata.pid);
}

async function caseD_pidReuseIdentityMismatch() {
  const worker = spawnPlaceholder('setInterval(() => {}, 1000);');
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  assert(processAlive(worker.pid), `占位进程 ${worker.pid} 未能启动`);

  await writeFile(pidFilePath(), `${worker.pid}|${randomBytes(8).toString('hex')}`, 'utf8');

  const started = await runBat(startBatPath(), startTimeoutMs);
  assert(started.code === 0, `start.bat 遇到身份不符 PID 后退出码 ${started.code}（预期 0）`);
  assert(await waitForHealth(), '身份不符恢复启动后 health 未返回 200');
  assert(processAlive(worker.pid), '无辜占位进程被 start.bat 杀死（绝不允许）');

  const metadata = await readPidFile();
  assert(metadata, '启动成功后 PID 文件缺失');
  assert(metadata.pid !== worker.pid, `PID 文件仍指向占位进程 ${worker.pid}，未被新服务覆写`);
  servicePidsStartedByTest.add(metadata.pid);

  const stopped = await runBat(stopBatPath(), stopTimeoutMs);
  assert(stopped.code === 0, `stop.bat 退出码 ${stopped.code}（预期 0）`);
  await waitForProcessGone(metadata.pid);
  assert(processAlive(worker.pid), 'stop.bat 误杀了无辜占位进程');
  await killPlaceholder(worker.pid);
}

async function caseE_portOccupiedByOtherProgram() {
  const holder = spawnPlaceholder(
    `require('node:net').createServer().listen(${port}, '0.0.0.0', () => {});setInterval(() => {}, 1000);`
  );
  const deadline = Date.now() + 10_000;
  while (!portListenerPids().includes(holder.pid)) {
    if (Date.now() > deadline) {
      throw new Error(`占位监听进程 ${holder.pid} 未在 10 秒内持有端口 ${port}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }

  const attempted = await runBat(startBatPath(), startTimeoutMs);
  assert(attempted.code !== 0, `start.bat 在端口被占时退出码 ${attempted.code}（预期非 0）`);
  assert(outputIncludes(attempted.stdout, '已被其他程序占用'), '输出缺少"端口已被其他程序占用"提示');
  assert(processAlive(holder.pid), '端口占用者被 start.bat 杀死（必须拒绝启动而不是杀占用者）');
  assert(portListenerPids().includes(holder.pid), '端口占用者不再持有端口，占用状态被破坏');
  assert(!existsSync(pidFilePath()), '端口占用拒绝启动时不应创建 data/app.pid');

  await killPlaceholder(holder.pid);
}

async function caseF_crashRecovery() {
  const firstStart = await runBat(startBatPath(), startTimeoutMs);
  assert(firstStart.code === 0, `首次 start.bat 退出码 ${firstStart.code}（预期 0）`);
  assert(await waitForHealth(), '首次启动后 health 未返回 200');
  const firstMetadata = await readPidFile();
  assert(firstMetadata, '首次启动后 PID 文件缺失');
  servicePidsStartedByTest.add(firstMetadata.pid);

  const killResult = killByPid(firstMetadata.pid);
  assert(killResult.status === 0, `taskkill /PID ${firstMetadata.pid} /F 失败（模拟崩溃失败）`);
  await waitForProcessGone(firstMetadata.pid);
  assert(existsSync(pidFilePath()), '模拟崩溃后 PID 文件应保留（模拟 crash 后未清理）');

  const secondStart = await runBat(startBatPath(), startTimeoutMs);
  assert(secondStart.code === 0, `崩溃后再次 start.bat 退出码 ${secondStart.code}（预期 0）`);
  assert(await waitForHealth(), '崩溃恢复启动后 health 未返回 200');

  const secondMetadata = await readPidFile();
  assert(secondMetadata, '崩溃恢复后 PID 文件缺失');
  assert(processAlive(secondMetadata.pid), `恢复后的 PID 文件指向的进程 ${secondMetadata.pid} 不存在`);
  servicePidsStartedByTest.add(secondMetadata.pid);

  const stopped = await runBat(stopBatPath(), stopTimeoutMs);
  assert(stopped.code === 0, `stop.bat 退出码 ${stopped.code}（预期 0）`);
  await waitForProcessGone(secondMetadata.pid);
}

const cases = [
  ['A', '正常生命周期：start -> health -> stop', caseA_normalLifecycle],
  ['B', '重复启动：识别已运行实例并拒绝二次拉起', caseB_duplicateStart],
  ['C', 'stale PID：假 PID 被清理并正常启动', caseC_stalePid],
  ['D', 'PID 复用/身份不符：不杀无辜进程并正常启动', caseD_pidReuseIdentityMismatch],
  ['E', '端口被其他程序占用：拒绝启动且不杀占用者', caseE_portOccupiedByOtherProgram],
  ['F', '异常退出恢复：崩溃后残留 PID 可自愈', caseF_crashRecovery]
];

const results = [];
let failed = false;

async function runCase(name, description, caseFunction) {
  console.log(`\n[CASE ${name}] ${description}`);
  try {
    await caseFunction();
    console.log(`[CASE ${name}] PASS`);
    results.push({ name, passed: true });
  } catch (error) {
    failed = true;
    console.error(`[CASE ${name}] FAIL：${error instanceof Error ? error.message : String(error)}`);
    console.error(`[CASE ${name}] ${batOutputTail()}`);
    results.push({ name, passed: false });
  } finally {
    // 容错清理：若 PID 文件残留则尝试 stop 后删除；清理本 case 的占位进程与本测试拉起的服务进程；确认端口已释放。
    try {
      if (existsSync(pidFilePath())) {
        await runBat(stopBatPath(), stopTimeoutMs);
        await rm(pidFilePath(), { force: true });
      }
    } catch {
      await rm(pidFilePath(), { force: true });
    }
    await killTrackedServicePids();
    await cleanupPlaceholders();
    try {
      await waitForPortRelease(15_000);
      ensurePortFree(`用例 ${name} 结束后，`);
    } catch (error) {
      failed = true;
      console.error(`[CASE ${name}] 清理检查失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

scratchRoot = resolve(tmpdir(), `df-lifecycle-${randomBytes(4).toString('hex')}`);

try {
  console.log(`[SETUP] 复制发行包到临时目录：${scratchRoot}`);
  // dereference: 发行包 node_modules 内含 npm workspace 链接（如 @dafan/client -> app/client），
  // Windows 普通权限下重建 symlink 会 EPERM，故解引用为真实目录内容复制。
  await cp(packageRoot, scratchRoot, { recursive: true, dereference: true });
  // 用仓库当前 start.bat 覆盖 scratch 副本：对正式包（字节一致）为 no-op；
  // 对旧构建产物（如 regression-pkg，其 start.bat 仍含已知 bug）则注入修复版后再测。
  await copyFile(resolve(projectRoot, 'start.bat'), resolve(scratchRoot, 'start.bat'));
  console.log('[SETUP] 复制完成');

  ensurePortFree('测试开始前，');
  if (existsSync(pidFilePath())) {
    await rm(pidFilePath(), { force: true });
  }

  for (const [name, description, caseFunction] of cases) {
    await runCase(name, description, caseFunction);
  }
} finally {
  await killTrackedServicePids();
  await cleanupPlaceholders();
  console.log(`\n[CLEANUP] 删除临时目录：${scratchRoot}`);
  await rm(scratchRoot, { recursive: true, force: true, maxRetries: 3 }).catch((error) => {
    console.error(
      `[CLEANUP] 临时目录删除失败（可手动清理）：${error instanceof Error ? error.message : String(error)}`
    );
  });
}

console.log('\n========== 生命周期测试汇总 ==========');
for (const result of results) {
  console.log(`[CASE ${result.name}] ${result.passed ? 'PASS' : 'FAIL'}`);
}
const passedCount = results.filter((result) => result.passed).length;
console.log(`结果：${passedCount}/${results.length} 通过`);
if (failed) {
  process.exit(1);
}
