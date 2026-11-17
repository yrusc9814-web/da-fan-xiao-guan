# 搭饭小馆 · Google2 V1

搭饭小馆是本地优先的家庭饮食决策与记录应用，覆盖菜谱、店铺、食用者与忌口、推荐、用餐计划、饮食日记、库存、购物清单、统计、PIN 与备份恢复。业务数据存储于本机 SQLite，用户图片保存在本机目录中。

## 当前架构

- **生产界面**：`app/client/index.html` 是 Google2 V1 的实际入口，包含页面结构、交互与主题；`app/client/public/google2-adapter.js` 将界面接入真实的 `/api/v1` API。它不依赖 `src/main.ts` 挂载 Vue。
- **兼容代码与测试**：`app/client/src/` 保留 Vue 3、Vue Router、Pinia、TypeScript 页面、组件、业务客户端与本地素材，前端回归测试位于 `app/client/tests/`；两者仍纳入类型检查和回归测试。Vue 路由不能直接当作 Google2 页面导航使用。
- **构建**：Vite 以 `index.html` 为入口，复制 `public/` 下的适配脚本、离线 Tailwind 浏览器脚本及三个 `.m4a` 音效；构建产物不含图片，页面运行不需要 Tailwind CDN。Google2 只显示 `/uploads/` 下的受控上传图片，缺少图片时回退为 Emoji。
- **后端**：Node.js、Fastify、TypeScript；Prisma 6 管理 SQLite 与版本化 Migration。生产模式由同一个 Fastify 服务提供页面、静态文件、上传图片和 API。
- **验证**：Vitest、Fastify inject、Vue Test Utils、ESLint、Prettier 与 GitHub Actions。

工程规则见 [agent.md](agent.md)，业务基线见 [docs/PRD.md](docs/PRD.md)。旧设计与整改文档保留用于追溯；当前运行入口以上述 Google2 文件为准。

## 仓库内容与数据边界

| 路径                                | 内容                                          |
| ----------------------------------- | --------------------------------------------- |
| `app/client/index.html`             | Google2 V1 生产界面                           |
| `app/client/public/`                | Google2 适配层、音效、离线 Tailwind 脚本      |
| `app/client/src/`                   | Vue 兼容源码、图标、小羊与菜谱素材            |
| `app/client/tests/`                 | 前端回归测试（Vitest）                        |
| `app/server/src/`                   | API、业务规则、存储与安全实现                 |
| `app/server/prisma/`                | Schema、全部 Migration 与迁移锁文件           |
| `app/shared/`                       | 前后端共享类型                                |
| `scripts/`                          | 建库、种子、测试、隔离验证与 Windows 发行脚本 |
| `.env.example`                      | 可公开的环境变量模板                          |
| `package.json`、`package-lock.json` | npm workspace 脚本及锁定依赖                  |
| `data/`                             | 本机数据库、上传与备份，不入库                |

源码仓库不携带现有用户数据、`.env`、`node_modules/`、`runtime/` 或构建产物。新环境通过迁移创建空数据库，可按需执行 `seed:dev` 生成示例数据，无需复制开发者的数据库或其他工作目录。

## 新环境从零克隆

需要 Git、Node.js 与 npm。建议使用与 Windows 发行流程一致的 **Node.js v22.23.2、Windows x64**；npm 随 Node 安装。源码也可在支持这些依赖的平台开发，Windows 发行包只能在 Windows x64 生成。首次安装需联网下载 npm 包与 Prisma 原生引擎；Windows 打包还需从 `nodejs.org` 下载固定版本 runtime。

以下命令从一个新的父目录执行；所有后续 `npm` 命令均在克隆仓库根目录执行。不要在已有项目目录上覆盖操作。

```powershell
git clone https://github.com/yrusc9814-web/da-fan-xiao-guan.git repo
Set-Location repo
git branch -r
git rev-parse HEAD
node --version
npm --version
Copy-Item .env.example .env
npm ci
npm run prisma:generate
npm run prisma:migrate:deploy
npm run prisma:validate
```

macOS/Linux 可用 `cd repo` 和 `cp .env.example .env` 替换对应的 PowerShell 命令，其余 npm 命令相同。使用 `npm ci` 保持锁文件版本；不要以 `prisma db push` 代替 Migration。

### 环境变量

默认模板用于独立的新克隆：

```dotenv
NODE_ENV=development
HOST=0.0.0.0
PORT=8787
VITE_API_BASE_URL=/api
BACKEND_PROXY_TARGET=http://127.0.0.1:8787
DATABASE_URL=file:../../../data/app.db
TEST_DATABASE_URL=file:../../../data/test.db
```

| 变量                                       | 说明                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `NODE_ENV`                                 | 开发用 `development`，提供构建后的页面必须设为 `production`；测试脚本设置 `test`       |
| `HOST`、`PORT`                             | 后端监听地址与端口；仅本机访问可用 `127.0.0.1`                                         |
| `BACKEND_PROXY_TARGET`                     | Vite 开发时 `/api` 与 `/uploads` 的后端代理目标，改后端端口时同步更新                  |
| `VITE_API_BASE_URL`                        | Vue 兼容客户端的 API 前缀；Google2 适配层固定使用同源 `/api/v1`                        |
| `DATABASE_URL`                             | SQLite URL；相对路径以 `app/server/prisma/` 为锚点，模板解析到仓库根目录 `data/app.db` |
| `TEST_DATABASE_URL`                        | 独立测试库，禁止指向应用库；默认是根目录 `data/test.db`                                |
| `DAFAN_DATABASE_PATH`                      | 可选的数据库绝对路径；若同时设置 `DATABASE_URL`，两者必须指向同一文件                  |
| `DAFAN_UPLOADS_PATH`、`DAFAN_BACKUPS_PATH` | 可选的上传与备份绝对路径，未设置时使用根目录 `data/uploads`、`data/backups`            |

服务端读取根目录 `.env`；Prisma 的 `dotenv/config` 读取当前工作目录的 `.env`，因此应始终在仓库根目录执行命令。进程已有环境变量优先。迁移需要有效的 `DATABASE_URL`，请先复制模板。**`ensure-sqlite-file.mjs` 在 Prisma 加载 `.env` 之前执行**，因此修改数据库位置时，必须同时把 `DATABASE_URL` 导出到当前终端；仅修改 `.env` 不足以保证建库准备脚本使用相同路径。测试入口也应显式导出自定义的 `TEST_DATABASE_URL`。

下面是在新克隆中配置独立存储的 PowerShell 示例。路径根据当前目录生成，不依赖任何原机器盘符；Windows SQLite URL 使用正斜杠。将相同值填写到此克隆的 `.env`，后续新终端仍需导出自定义数据库 URL。

```powershell
$storageRoot = Join-Path (Get-Location).Path 'data'
New-Item -ItemType Directory -Force -Path $storageRoot | Out-Null
$env:DATABASE_URL = 'file:' + (Join-Path $storageRoot 'app.db').Replace('\', '/')
$env:TEST_DATABASE_URL = 'file:' + (Join-Path $storageRoot 'test.db').Replace('\', '/')
$env:DAFAN_UPLOADS_PATH = Join-Path $storageRoot 'uploads'
$env:DAFAN_BACKUPS_PATH = Join-Path $storageRoot 'backups'
npm run prisma:migrate:deploy
```

不要把指向实际用户上传、备份或应用数据库的存储覆盖变量传给测试。`npm test` 默认使用独立测试库和自动分配的临时上传、备份目录；如需自定义测试目录，应为测试单独设置绝对路径，并避免继承应用的 `DAFAN_DATABASE_PATH`。

### 初始化示例数据

空数据库可以直接启动使用；Google2 界面不含引导流程，引导只存在于 Vue 兼容界面。需要演示菜谱、店铺、库存等数据时，在应用数据库配置下执行：

```powershell
npm run seed:dev
```

此命令先准备数据库、部署 Migration，再运行幂等开发种子。它会写入示例数据，应只用于新建的开发或验收库；生产用户数据不需要种子。种子菜谱的 `imagePath` 只写入裸文件名（如 `tomato-eggs.png`），不会复制图片文件；Google2 只渲染 `/uploads/` 下的受控上传图片，因此这些示例菜谱以 Emoji 回退，需要封面时通过上传接口生成受控图片。原始图片素材位于 `app/client/src/assets/` 并已纳入版本跟踪，但不会直接复制到 Google2 构建或发行目录。音效随仓库提供，不需要另行下载。

## 开发启动

完成依赖安装、Prisma 生成和迁移后：

```powershell
npm run dev
```

前端地址为 `http://localhost:5173`，后端为 `http://127.0.0.1:8787`。Vite 代理 API 和上传图片到后端。也可在两个终端分别执行 `npm run dev:server`、`npm run dev:client`。开发服务没有配置源码自动重启，修改服务端代码后需重新启动。

如 8787 已占用，在 `.env` 中同时修改 `PORT` 和 `BACKEND_PROXY_TARGET` 后重启开发服务。前端 5173 由 Vite 配置和客户端启动命令指定，不随 `.env` 的 `PORT` 改变。Google2 的核心页面通过界面内导航切换。

## 检查、构建与完整测试

```powershell
npm run prisma:validate
npm run typecheck
npm run lint
npm run format:check
npm run build
npm test
```

`npm test` 会生成 Prisma Client、重建独立测试库，依次执行完整前端与后端测试；默认不会修改 `data/app.db`，并校验应用库指纹。不要把测试库指向需要保留的数据。迁移验证必须使用 `npm run prisma:migrate:deploy`，已有数据库也通过该命令升级。

前端构建输出到 `app/client/dist/`，后端输出到 `dist-server/`，生产构建不生成 sourcemap。

质量门禁注意：`npm run format:check` 在干净克隆上仍有 6 个已跟踪文件未通过 Prettier 检查（已复核）：`app/client/public/google2-adapter.js`、`app/client/src/pages/ShoppingPage.vue`、`app/client/tests/google2-adapter.test.ts`、`app/client/tests/google2-t007-taboo.test.ts`、`app/server/src/modules/backup/service.ts`、`app/server/tests/google2-shopping-d5.test.ts`。这是既有基线，会使 GitHub CI 在格式门禁处失败，并阻止自动发行流程继续；本次发布仅格式化 README，保留这些代码文件原样。若在开发工作区执行，未跟踪的验收工件（如 `closeout-browser-sol1/`）也会被 `prettier --check .` 计入，失败清单因此可能多于上述 6 个文件。只需格式化 README 时使用 `npx --no-install prettier --write README.md`，避免改动其他文件。

## 生产构建与运行

在仓库根目录安装依赖、生成 Prisma Client、迁移数据库后构建，并明确设置生产环境：

```powershell
npm run build
$env:NODE_ENV = 'production'
$env:HOST = '127.0.0.1'
$env:PORT = '8787'
npm run start:prod
```

等价启动入口为 `node dist-server/server/src/server.js`。**必须从仓库根目录运行**，静态文件根目录根据当前工作目录解析。打开 `http://127.0.0.1:8787`，健康检查为 `http://127.0.0.1:8787/api/v1/health`。`start:prod` 本身不设置 `NODE_ENV`；缺少 `production` 时不会提供前端静态页面。

macOS/Linux 的生产启动可使用：

```bash
NODE_ENV=production HOST=127.0.0.1 PORT=8787 npm run start:prod
```

隔离演练可把端口改为未使用的 `18988`，并将数据库、上传和备份全部指向新克隆下的临时目录。停止时在该服务终端使用 Ctrl+C；不要按进程名称批量结束 Node 服务。

首次验收应覆盖首页、菜谱、推荐、计划、日记、库存、购物清单与设置，并在浏览器网络面板确认 `/api/v1/health`、业务 API、`/google2-adapter.js`、`/assets/tailwind/tailwindcss-3.4.17.browser.min.js` 与 `/assets/audio/*.m4a` 正常返回。静态构建产物不含图片：需先用 `POST /api/v1/uploads/images` 上传一张图片生成受控图片，再确认 `/uploads/*` 返回并在页面显示；`app/client/src/assets/` 的原始素材只用于 Vue 兼容界面，不会直接复制到 Google2 构建或发行目录。音效通常需用户手势后播放，媒体范围请求可能返回 206。

## Windows 打包与分发

### 在 Windows x64 本地生成

在独立源码克隆中准备 Node.js v22.23.2 与 npm，执行：

```powershell
npm ci
npm run release:windows
npm run release:windows:verify -- release/搭饭小馆
```

`release:windows` 依次生成 Prisma Client、验证 Schema、构建前后端并生成发行目录。下载 runtime 需要 Windows 自带的 `curl.exe` 与 PowerShell。脚本会重新生成 `release/搭饭小馆/`，其中包含校验过的 `runtime/node.exe`、生产依赖、Prisma CLI 与 Windows engine、Schema、全部 Migration、静态素材、构建产物、`release-manifest.json`、`start.bat` 和 `stop.bat`。不会携带源码仓库的用户数据库、上传与备份。

可在一次性的全新发行目录执行 smoke test；该脚本固定使用 **18787** 端口，并会在结束时清理该发行目录的 `data/` 与 `logs/`。先确认 18787 未被使用，且目标发行目录没有需保留的数据；已有预览占用该端口时跳过此命令，不停止原预览：

```powershell
node scripts/smoke-windows-release.mjs release/搭饭小馆
Compress-Archive -Path 'release/搭饭小馆' -DestinationPath 'release/搭饭小馆-windows-x64.zip'
```

解压发行包后双击 `start.bat`：固定使用包内 runtime 与 8787 端口，准备数据库并部署 Migration，等待健康检查与首页成功后打开浏览器。`stop.bat` 只停止 PID 文件指向且命令行匹配本应用的进程；缺少包内 runtime 时启动失败，不回退到系统 Node。源码模式可配置端口，发行启动脚本固定使用 8787。

### GitHub Actions 生成

GitHub 的 **Windows Release Artifact** workflow 在 `main` 的 **CI** 成功后自动运行，也支持手动 `workflow_dispatch`。流程固定到相应提交，执行检查、测试、打包、结构校验、解压 smoke、升级与生命周期验证，上传 `搭饭小馆-windows-x64` artifact，内含 ZIP。需在 Actions 页面确认该提交的任务成功后下载；推送源码本身不等于发行包构建已通过。

## 持久化、备份与局域网

默认数据位置为 `data/app.db`、`data/uploads/`、`data/backups/`，Windows 启动 PID 位于 `data/app.pid`，启动日志为 `logs/app.log`、`logs/app-error.log`。这些文件均被 Git 忽略。不要在服务运行期间手工替换数据库。

### 既有验收脚本的机器绑定限制

`scripts/isolation-gate.mjs` 内的隔离根固定为原开发机的绝对路径，相关 `start-isolated.mjs`、`prepare-isolated-build.mjs` 等历史验收脚本不能直接用于其他机器。本手册的克隆、迁移、种子、开发、构建、`npm test` 与生产启动流程不使用这些脚本。应用本身可通过上述环境变量设置新环境路径；不要照搬旧验收目录或将 `DAFAN_ISOLATION_ROOT` 指向旧机器路径。

设置页可导出包含 SQLite、配置快照和上传文件的 ZIP；恢复会验证路径、文件集合、大小、SHA-256、SQLite 完整性与 Migration，并要求一次性高风险授权，替换失败会回滚。PIN 以加盐 scrypt 哈希保存；普通会话不能直接执行恢复。

手机与电脑连接同一可信 Wi-Fi，服务监听 `0.0.0.0` 后使用电脑局域网地址访问；设置页可生成地址二维码。Windows 防火墙弹窗时建议仅允许家庭/专用网络；这是用户侧配置建议，应用不自动配置防火墙。生产模式校验浏览器 Origin。此应用不提供云同步或远程账户体系，跨设备访问使用同一台电脑上的服务和数据。
