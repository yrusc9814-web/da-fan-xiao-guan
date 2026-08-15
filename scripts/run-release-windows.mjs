import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// release:windows 的 Node 编排脚本。
// 背景：原 package.json 的 && 链 `npm run prisma:generate && ... && node scripts/build-windows-release.mjs`
// 经 npm.cmd -> cmd.exe 多级嵌套运行，且每个外部子进程都无超时；一旦某步（如 Node runtime 下载）卡住，
// 整条链永久挂起且难以定位/清理。
// 本脚本改为 Node 顺序执行每一步：显式超时、超时即明确报错并清理对应 Windows 进程树、非 0 退出。
// 不使用 shell:true；所有命令都通过 node 直跑（npm-cli.js / build 脚本），避免 cmd.exe 嵌套。

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function npmCliPath() {
  const executableDirectory = dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    resolve(executableDirectory, 'node_modules/npm/bin/npm-cli.js'),
    resolve(executableDirectory, '../lib/node_modules/npm/bin/npm-cli.js')
  ];
  const npmCli = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!npmCli) {
    throw new Error('找不到 npm-cli.js，无法运行发布工作区命令');
  }
  return npmCli;
}

async function killProcessTree(childPid) {
  // 在子进程仍存活时用 taskkill /T /F 清理整棵进程树（Windows）。
  try {
    const result = spawnSync('taskkill', ['/PID', String(childPid), '/T', '/F'], {
      stdio: 'ignore',
      timeout: 15000
    });
    return result.status ?? -1;
  } catch (error) {
    console.error(`[run-release:windows] 进程树清理异常：${error instanceof Error ? error.message : String(error)}`);
    return -1;
  }
}

async function runStep(step, command, args, timeoutMs, extraEnv = {}) {
  const started = Date.now();
  console.log(`[run-release:windows] ▶ ${step}：${command} ${args.join(' ')}（超时 ${Math.round(timeoutMs / 1000)}s）`);
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
    shell: false,
    windowsHide: true
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.error(`[run-release:windows] ✖ ${step} 超时（${timeoutMs}ms），正在清理进程树（PID ${child.pid}）...`);
    const status = killProcessTree(child.pid);
    console.error(`[run-release:windows] ✖ ${step} 进程树已清理（taskkill 退出码 ${status}）`);
    child.kill('SIGKILL');
  }, timeoutMs);

  const code = await new Promise((resolveExit) => {
    child.once('exit', (exitCode, signal) => resolveExit(exitCode ?? (signal ? 1 : 0)));
    child.once('error', (error) => {
      console.error(`[run-release:windows] ✖ ${step} 启动失败：${error.message}`);
      resolveExit(-1);
    });
  });
  clearTimeout(timer);
  const elapsed = Math.round((Date.now() - started) / 100) / 10;

  if (timedOut) {
    throw new Error(`${step} 超时（${timeoutMs}ms），已在第 ${elapsed}s 清理进程树`);
  }
  if (code !== 0) {
    throw new Error(`${step} 失败，退出码 ${code}（耗时 ${elapsed}s）`);
  }
  console.log(`[run-release:windows] ✔ ${step} 完成（${elapsed}s，退出码 0）`);
  return code;
}

async function main() {
  const npmCli = npmCliPath();
  const steps = [
    { name: 'prisma:generate', command: process.execPath, args: [npmCli, 'run', 'prisma:generate'], timeout: 120_000 },
    { name: 'prisma:validate', command: process.execPath, args: [npmCli, 'run', 'prisma:validate'], timeout: 120_000 },
    { name: 'build', command: process.execPath, args: [npmCli, 'run', 'build'], timeout: 600_000 },
    { name: 'build-windows-release', command: process.execPath, args: ['scripts/build-windows-release.mjs'], timeout: 1_200_000 }
  ];

  console.log('[run-release:windows] 开始编排执行（Node 顺序，逐步骤超时保护）');
  for (const step of steps) {
    try {
      await runStep(step.name, step.command, step.args, step.timeout);
    } catch (error) {
      console.error(`[run-release:windows] ✖ 步骤「${step.name}」失败：${error instanceof Error ? error.message : String(error)}`);
      console.error('[run-release:windows] 发行构建中止（非 0 退出）');
      process.exit(1);
    }
  }
  console.log('[run-release:windows] 全部步骤通过');
}

await main();
