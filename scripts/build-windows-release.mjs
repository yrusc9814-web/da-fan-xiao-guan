import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const releaseRoot = resolve(projectRoot, 'release', '搭饭小馆');
const nodeVersion = 'v22.23.2';
const nodeArchiveName = `node-${nodeVersion}-win-x64.zip`;
const nodeArchiveUrl = `https://nodejs.org/dist/${nodeVersion}/${nodeArchiveName}`;
const nodeArchiveSha256 = '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97';
const nodeExecutableSha256 = '0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4';
const maximumArchiveSize = 100 * 1024 * 1024;
const manifestFilePaths = [
  'runtime/node.exe',
  'dist-server/server/src/server.js',
  'app/client/dist/index.html',
  'app/server/prisma/schema.prisma',
  'app/server/prisma/migrations/migration_lock.toml',
  'app/server/src/database/paths.ts',
  'prisma.config.ts',
  'scripts/ensure-sqlite-file.mjs',
  'scripts/launch-server.mjs',
  'start.bat',
  'stop.bat',
  'README.txt',
  'package.json',
  'package-lock.json'
];

function fail(message) {
  throw new Error(`[Windows release build] ${message}`);
}

function run(command, argumentsList, options = {}) {
  const result = spawnSync(command, argumentsList, {
    cwd: releaseRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    ...options
  });

  if (result.error) {
    fail(`无法执行 ${basename(command)}：${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${basename(command)} 退出码为 ${result.status}`);
  }
}

function npmCliPath() {
  const executableDirectory = dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    resolve(executableDirectory, 'node_modules/npm/bin/npm-cli.js'),
    resolve(executableDirectory, '../lib/node_modules/npm/bin/npm-cli.js')
  ];
  const npmCli = candidates.find((candidate) => candidate && existsSync(candidate));

  if (!npmCli) {
    fail('找不到 npm-cli.js，无法以跨平台方式运行发行包依赖命令');
  }

  return npmCli;
}

function packageInfo(requireFromServer, packageName) {
  let entry;
  for (const specifier of [packageName, `${packageName}/package`]) {
    try {
      entry = requireFromServer.resolve(specifier);
      break;
    } catch {
      // 解析失败时尝试下一个 specifier，全部失败由下方 fail() 兜底
    }
  }
  if (!entry) {
    fail(`无法从 @dafan/server 上下文解析 npm 包：${packageName}`);
  }

  let directory = dirname(entry);
  for (let depth = 0; depth < 8; depth += 1) {
    const directoryFromRelease = relative(releaseRoot, directory);
    if (directoryFromRelease.startsWith('..') || directoryFromRelease === '') {
      break;
    }
    const packageJson = resolve(directory, 'package.json');
    if (existsSync(packageJson)) {
      const metadata = JSON.parse(readFileSync(packageJson, 'utf8'));
      if (metadata.name === packageName) {
        return { entry, metadata, packageJson, root: directory };
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  fail(`无法定位 npm 包根目录：${packageName}`);
}

function packageVersion(metadata, packageName, dependencyGroups) {
  for (const dependencyGroup of dependencyGroups) {
    const version = metadata[dependencyGroup]?.[packageName];
    if (typeof version === 'string' && version.length > 0) return version;
  }
  fail(`Sharp 元数据未声明 ${packageName} 的可用版本`);
}

function packagePath(relativePath, packageRoot) {
  const path = resolve(packageRoot, relativePath);
  const pathFromPackage = relative(packageRoot, path);
  if (pathFromPackage.startsWith('..') || pathFromPackage === '' || pathFromPackage.includes('..')) {
    fail(`拒绝读取 npm 包目录外的文件：${relativePath}`);
  }
  return path;
}

async function ensurePackage(requireFromServer, npmCli, packageName, version) {
  try {
    const installed = packageInfo(requireFromServer, packageName);
    if (installed.metadata.version === version) return installed;
    console.log(
      `Replacing mismatched Windows native package ${packageName}@${installed.metadata.version} with ${version}`
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes(`无法从 @dafan/server 上下文解析 npm 包：${packageName}`)
    ) {
      throw error;
    }
  }

  console.log(`Installing missing Windows native package ${packageName}@${version}`);
  run(
    process.execPath,
    [
      npmCli,
      'install',
      '--no-save',
      '--package-lock=false',
      '--ignore-scripts',
      '--include=optional',
      `${packageName}@${version}`
    ],
    {
      env: { ...process.env, NODE_ENV: 'production' }
    }
  );
  const installed = packageInfo(requireFromServer, packageName);
  if (installed.metadata.version !== version) {
    fail(`安装后的 ${packageName} 版本不匹配 Sharp 声明：需要 ${version}，实际 ${installed.metadata.version}`);
  }
  return installed;
}

async function sharpArtifacts(requireFromServer, npmCli) {
  const sharp = packageInfo(requireFromServer, 'sharp');
  const sharpRequire = createRequire(sharp.entry);
  const platformKey = `${process.platform}-${process.arch}`;
  const addonName = `@img/sharp-${platformKey}`;
  const addonVersion = packageVersion(sharp.metadata, addonName, ['optionalDependencies']);
  const addon = await ensurePackage(sharpRequire, npmCli, addonName, addonVersion);
  try {
    sharpRequire.resolve(`${addonName}/sharp.node`);
  } catch {
    fail(`Sharp loader 无法解析 native addon：${addonName}/sharp.node`);
  }

  const libvipsName = `@img/sharp-libvips-${platformKey}`;
  const libvipsVersion = packageVersion(sharp.metadata, libvipsName, ['optionalDependencies', 'devDependencies']);
  const libvips = await ensurePackage(sharpRequire, npmCli, libvipsName, libvipsVersion);

  const addonLib = packagePath('lib', addon.root);
  const addonFiles = (await readdir(addonLib, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(?:node|dll)$/i.test(entry.name))
    .map((entry) => packagePath(`lib/${entry.name}`, addon.root));
  const nativeAddon = addonFiles.find((path) => path.toLowerCase().endsWith('.node'));
  const bundledLibvips = addonFiles.filter((path) => path.toLowerCase().endsWith('.dll'));
  if (!nativeAddon) fail(`Sharp Windows 包缺少 native addon：${addonName}`);
  if (bundledLibvips.length === 0) fail(`Sharp Windows 包缺少随附 libvips DLL：${addonName}`);

  const libvipsLib = packagePath('lib', libvips.root);
  const libvipsFiles = (await readdir(libvipsLib, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.dll'))
    .map((entry) => packagePath(`lib/${entry.name}`, libvips.root));
  if (libvipsFiles.length === 0) fail(`Sharp Windows libvips 包缺少 DLL：${libvipsName}`);

  return {
    package: { name: sharp.metadata.name, version: sharp.metadata.version, path: sharp.packageJson },
    nativePackage: { name: addon.metadata.name, version: addon.metadata.version, packageJson: addon.packageJson },
    nativeAddon,
    bundledLibvips,
    libvipsPackage: {
      name: libvips.metadata.name,
      version: libvips.metadata.version,
      packageJson: libvips.packageJson,
      files: libvipsFiles
    }
  };
}

function prismaQueryEngine(requireFromServer) {
  const clientEntry = requireFromServer.resolve('@prisma/client');
  const clientRequire = createRequire(clientEntry);
  const generatedClient = clientRequire.resolve('.prisma/client/index.js');
  const generatedClientRoot = dirname(generatedClient);
  const source = readFileSync(generatedClient, 'utf8');
  const engineName = source.match(/(?:lib)?query_engine-[A-Za-z0-9._-]+\.node/)?.[0];
  if (!engineName) fail('Prisma 生成客户端未声明 query engine 文件');
  const engine = resolve(generatedClientRoot, engineName);
  if (!existsSync(engine)) fail(`Prisma query engine 不存在：${engineName}`);
  return engine;
}

function prismaSchemaEngine(requireFromServer) {
  const prismaCli = requireFromServer.resolve('prisma/build/index.js');
  const prismaRequire = createRequire(prismaCli);
  const schemaEnginePackage = packageInfo(prismaRequire, '@prisma/engines');
  const schemaEngineName =
    process.platform === 'win32' ? 'schema-engine-windows.exe' : `schema-engine-${process.platform}`;
  try {
    return prismaRequire.resolve(`@prisma/engines/${schemaEngineName}`);
  } catch {
    const fallback = resolve(schemaEnginePackage.root, schemaEngineName);
    if (existsSync(fallback)) return fallback;
    fail(`Prisma engines 包缺少 ${schemaEngineName}`);
  }
}

function manifestPath(path) {
  const pathFromRelease = relative(releaseRoot, path);
  if (pathFromRelease.startsWith('..') || pathFromRelease === '' || pathFromRelease.includes(`..${sep}`)) {
    fail(`拒绝将发行目录外文件写入 manifest：${path}`);
  }
  return pathFromRelease.split(sep).join('/');
}

function assertSourceExists(relativePath) {
  const source = resolve(projectRoot, relativePath);
  if (!existsSync(source)) {
    fail(`缺少构建输入：${relativePath}。请先运行 npm run build。`);
  }
  return source;
}

async function copyIntoRelease(relativePath) {
  const source = assertSourceExists(relativePath);
  const destination = resolve(releaseRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function migrationNames() {
  const migrationsDirectory = resolve(releaseRoot, 'app', 'server', 'prisma', 'migrations');
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    fail('正式包中没有 Prisma migrations');
  }
  for (const name of names) {
    if (!existsSync(resolve(migrationsDirectory, name, 'migration.sql'))) {
      fail(`Prisma migration 缺少 migration.sql：${name}`);
    }
  }
  return names;
}

async function criticalFileHashes(migrations, artifactPaths) {
  const relativePaths = [
    ...manifestFilePaths,
    ...migrations.map((migrationName) => `app/server/prisma/migrations/${migrationName}/migration.sql`),
    ...artifactPaths.map(manifestPath)
  ];
  const uniquePaths = [...new Set(relativePaths)];
  const entries = await Promise.all(
    uniquePaths.map(async (relativePath) => {
      const path = resolve(releaseRoot, relativePath);
      if (!existsSync(path)) {
        fail(`无法写入发行清单，缺少关键文件：${relativePath}`);
      }
      return [relativePath, await sha256(path)];
    })
  );
  return Object.fromEntries(entries);
}

async function downloadOfficialNodeArchive(destination) {
  // 根因（已在真机用 AB 测试确认）：本机 Node 24 的 fetch/https 默认不读 HTTP_PROXY/HTTPS_PROXY
  // （需 NODE_USE_ENV_PROXY=1 才会走代理），因此走直连；而本机到 nodejs.org（Cloudflare IPv6）的
  // 直连路径在 bulk 传输时极慢（约 312KB/s）且会停滞，导致 await fetch/arrayBuffer 永久挂起。
  // curl.exe 会读取 HTTPS_PROXY 走本地 Clash 代理（约 6.5MB/s、5.5s 完成）。
  // 因此下载改用 curl.exe（自带 connect/总时长/低速超时 + 重试），并以固定 SHA-256 校验完整性。
  const temporary = `${destination}.tmp`;
  const curlArgs = [
    '--fail',
    '--location',
    '--retry',
    '3',
    '--retry-all-errors',
    '--connect-timeout',
    '15',
    '--max-time',
    '600',
    '--speed-time',
    '30',
    '--speed-limit',
    '1024',
    '--output',
    temporary,
    nodeArchiveUrl
  ];
  // spawnSync 自身也带超时（略大于 curl --max-time），确保即使 curl 异常也不会拖死构建。
  const result = spawnSync('curl.exe', curlArgs, {
    cwd: releaseRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: 620_000
  });
  if (result.error || result.status !== 0) {
    fail(
      `无法下载 Node 官方 runtime（curl 退出码 ${result.status ?? 'n/a'}${result.error ? `，${result.error.message}` : ''}）`
    );
  }

  const size = (await stat(temporary)).size;
  if (size > maximumArchiveSize) {
    await rm(temporary, { force: true });
    fail(`Node runtime ZIP 超过允许大小：${size}`);
  }
  if ((await sha256(temporary)) !== nodeArchiveSha256) {
    await rm(temporary, { force: true });
    fail(`Node 官方 ZIP 的 SHA-256 不匹配 ${nodeVersion} Windows x64 发布清单`);
  }
  await rename(temporary, destination);
}

function assertWindowsX64() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    fail('只能在 Windows x64 上构建正式 Windows 包；不会在当前平台伪造 node.exe。');
  }
}

async function main() {
  assertWindowsX64();

  for (const relativePath of [
    'dist-server/server/src/server.js',
    'app/client/dist/index.html',
    'app/server/prisma/schema.prisma',
    'app/server/prisma/migrations/migration_lock.toml'
  ]) {
    assertSourceExists(relativePath);
  }

  const pathFromProject = relative(projectRoot, releaseRoot);
  if (pathFromProject.startsWith('..') || pathFromProject === '') {
    fail(`拒绝写入项目外的发行目录：${releaseRoot}`);
  }

  await rm(releaseRoot, { recursive: true, force: true });
  await mkdir(releaseRoot, { recursive: true });

  for (const relativePath of [
    'README.txt',
    'start.bat',
    'stop.bat',
    'package.json',
    'package-lock.json',
    'prisma.config.ts',
    'app/client/package.json',
    'app/client/dist',
    'app/server/package.json',
    'app/server/prisma',
    'app/server/src/database/paths.ts',
    'dist-server',
    'scripts/ensure-sqlite-file.mjs',
    'scripts/launch-server.mjs'
  ]) {
    await copyIntoRelease(relativePath);
  }

  const temporaryDirectory = resolve(releaseRoot, '.release-tmp');
  const archivePath = resolve(temporaryDirectory, nodeArchiveName);
  const extractedDirectory = resolve(temporaryDirectory, 'node');
  await mkdir(temporaryDirectory, { recursive: true });
  await downloadOfficialNodeArchive(archivePath);
  run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${extractedDirectory}' -Force`
  ]);

  const extractedNode = resolve(extractedDirectory, `node-${nodeVersion}-win-x64`, 'node.exe');
  if (!existsSync(extractedNode)) {
    fail('Node 官方 ZIP 中缺少 runtime node.exe');
  }
  await mkdir(resolve(releaseRoot, 'runtime'), { recursive: true });
  await cp(extractedNode, resolve(releaseRoot, 'runtime', 'node.exe'));
  await rm(temporaryDirectory, { recursive: true, force: true });

  const runtimeNode = resolve(releaseRoot, 'runtime', 'node.exe');
  if ((await sha256(runtimeNode)) !== nodeExecutableSha256) {
    fail(`runtime/node.exe 的 SHA-256 不匹配 ${nodeVersion} Windows x64 官方文件`);
  }
  const runtimeIdentity = spawnSync(runtimeNode, ['-p', '`${process.platform}:${process.arch}:${process.version}`'], {
    cwd: releaseRoot,
    encoding: 'utf8'
  });
  if (runtimeIdentity.status !== 0 || runtimeIdentity.stdout.trim() !== `win32:x64:${nodeVersion}`) {
    fail(`runtime/node.exe 身份校验失败：${runtimeIdentity.stderr || runtimeIdentity.stdout || '无输出'}`);
  }

  const npmCli = npmCliPath();
  run(process.execPath, [npmCli, 'ci', '--include=optional', '--omit=dev', '--no-audit', '--fund=false'], {
    env: { ...process.env, NODE_ENV: 'production' }
  });

  const serverRequire = createRequire(resolve(releaseRoot, 'app', 'server', 'package.json'));
  const prismaCli = serverRequire.resolve('prisma/build/index.js');
  const sharp = await sharpArtifacts(serverRequire, npmCli);

  run(
    process.execPath,
    [
      npmCli,
      'ls',
      '--include=optional',
      '--omit=dev',
      '--all',
      'prisma',
      '@prisma/client',
      'sharp',
      '@img/sharp-win32-x64',
      '@img/sharp-libvips-win32-x64'
    ],
    {
      env: { ...process.env, NODE_ENV: 'production' }
    }
  );
  run(runtimeNode, [
    prismaCli,
    'generate',
    '--schema',
    resolve(releaseRoot, 'app', 'server', 'prisma', 'schema.prisma')
  ]);

  const migrations = await migrationNames();
  const prismaQuery = prismaQueryEngine(serverRequire);
  const prismaSchema = prismaSchemaEngine(serverRequire);
  const serverEntry = resolve(releaseRoot, 'dist-server', 'server', 'src', 'server.js');
  const clientEntry = resolve(releaseRoot, 'app', 'client', 'dist', 'index.html');
  const artifactPaths = [
    serverEntry,
    clientEntry,
    prismaCli,
    prismaQuery,
    prismaSchema,
    sharp.package.path,
    sharp.nativePackage.packageJson,
    sharp.nativeAddon,
    ...sharp.bundledLibvips,
    sharp.libvipsPackage.packageJson,
    ...sharp.libvipsPackage.files
  ];
  const files = await criticalFileHashes(migrations, artifactPaths);
  const descriptor = (path) => ({ path: manifestPath(path), sha256: files[manifestPath(path)] });

  await writeFile(
    resolve(releaseRoot, 'release-manifest.json'),
    `${JSON.stringify(
      {
        formatVersion: 2,
        target: { platform: 'win32', arch: 'x64' },
        node: {
          version: nodeVersion,
          archiveUrl: nodeArchiveUrl,
          archiveSha256: nodeArchiveSha256,
          executableSha256: nodeExecutableSha256
        },
        prisma: {
          cli: descriptor(prismaCli),
          queryEngine: descriptor(prismaQuery),
          schemaEngine: descriptor(prismaSchema),
          migrations
        },
        entrypoints: {
          server: descriptor(serverEntry),
          client: descriptor(clientEntry)
        },
        sharp: {
          package: {
            name: sharp.package.name,
            version: sharp.package.version,
            packageJson: descriptor(sharp.package.path)
          },
          nativePackage: {
            name: sharp.nativePackage.name,
            version: sharp.nativePackage.version,
            packageJson: descriptor(sharp.nativePackage.packageJson)
          },
          nativeAddon: descriptor(sharp.nativeAddon),
          bundledLibvips: sharp.bundledLibvips.map(descriptor),
          libvipsPackage: {
            name: sharp.libvipsPackage.name,
            version: sharp.libvipsPackage.version,
            packageJson: descriptor(sharp.libvipsPackage.packageJson),
            files: sharp.libvipsPackage.files.map(descriptor)
          }
        },
        files
      },
      null,
      2
    )}\n`
  );

  run(process.execPath, [resolve(projectRoot, 'scripts', 'verify-windows-release.mjs'), releaseRoot]);
  console.log(`Windows release created: ${releaseRoot}`);
}

await main();
