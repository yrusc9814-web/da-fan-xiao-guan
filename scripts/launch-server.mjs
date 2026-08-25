import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';

// 在正式发行包内启动服务进程，并写入 PID 文件。
// 由 start.bat 调用；所有路径/参数通过环境变量传入，避免 cmd.exe 引号解析问题。
// 身份令牌（launch token）随进程命令行传入，stop.bat 据此精确确认要终止的是本服务进程。

const { APP_ROOT, NODE_EXE, SERVER_ENTRY, LOG_FILE, ERROR_LOG, PID_FILE, SERVICE_TAG } = process.env;

function fail(message) {
  console.error(`[launch-server] ${message}`);
  process.exit(2);
}

if (!APP_ROOT || !NODE_EXE || !SERVER_ENTRY || !PID_FILE || !LOG_FILE || !ERROR_LOG) {
  fail('缺少必需环境变量（APP_ROOT/NODE_EXE/SERVER_ENTRY/PID_FILE/LOG_FILE/ERROR_LOG）');
}

const launchToken = randomBytes(8).toString('hex');
const stdout = await open(LOG_FILE, 'a');
const stderr = await open(ERROR_LOG, 'a');

const child = spawn(
  NODE_EXE,
  [SERVER_ENTRY, SERVICE_TAG ?? '--app-id=dafan-xiaoguan', `--launch-token=${launchToken}`],
  {
    cwd: APP_ROOT,
    // Windows 上 Node 22 的 detached:true 底层即 DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP：
    // 服务进程不继承父控制台，彻底脱离调用方（cmd/PowerShell）的进程树等待语义。
    detached: true,
    stdio: ['ignore', stdout.fd, stderr.fd],
    windowsHide: true
  }
);

try {
  await new Promise((resolvePromise, rejectPromise) => {
    child.once('spawn', resolvePromise);
    child.once('error', rejectPromise);
  });
} catch (error) {
  fail(`服务进程启动失败：${error instanceof Error ? error.message : String(error)}`);
}

await writeFile(PID_FILE, `${child.pid}|${launchToken}`, 'utf8');
console.log(`[launch-server] 服务已启动，PID ${child.pid}，令牌 ${launchToken}`);

// unref()：让本 launcher 的 event loop 不再因 ChildProcess handle 而等待服务器结束，
// 配合 detached:true 即可让 launcher 正常退出、服务器继续后台存活。
child.unref();

// 父进程（本脚本）退出后，子进程仍持有继承的日志文件句柄，可继续写日志。
await Promise.all([stdout.close(), stderr.close()]).catch(() => undefined);
