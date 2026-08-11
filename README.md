# 搭饭小馆

搭饭小馆是一款本地优先的家庭饮食决策与记录应用，覆盖菜谱、店铺、食用者、推荐、饮食计划、日记、库存、购物清单、统计与完整备份恢复。

## 当前状态

P0–P6 整改已进入最终验收。业务数据来自本地 SQLite；首页视觉以 `docs/design/` 中的桌面端和移动端最终参考图为准。权威工程规则见 `agent.md`，业务规则见 `docs/PRD.md`。

## 技术架构

- 前端：Vue 3、Vue Router、Pinia、Vite、TypeScript
- 后端：Node.js 22、Fastify、TypeScript
- 数据：SQLite、Prisma Migration
- 测试：Vitest、Fastify inject、Vue Test Utils
- 工程门禁：ESLint、Prettier、GitHub Actions

## 目录

- `app/client/`：前端页面、组件、样式与本地图片
- `app/server/`：API、Prisma schema、Migration 与服务测试
- `app/shared/`：前后端共享类型
- `data/`：运行数据库、用户上传、备份与测试数据库（不提交）
- `docs/`：PRD、最终视觉依据、整改指令与历史资料
- `scripts/`：数据库初始化、测试重建与开发数据脚本

## 开发启动

```bash
npm install
npm run prisma:generate
npm run prisma:migrate:deploy
npm run dev
```

前端开发地址默认为 `http://localhost:5173`，API 默认为 `http://127.0.0.1:8787`。

## 测试与质量门禁

```bash
npm run prisma:validate
npm run typecheck
npm run lint
npm run format:check
npm test
```

测试会重建独立的 `data/test.db`，不会修改 `data/app.db`。

## 构建

```bash
npm run build
```

前端输出到 `app/client/dist/`，后端输出到 `dist-server/`。生产模式不会生成 sourcemap。

## Windows 正式运行

正式分发包应包含 `runtime/node.exe`、生产依赖、Prisma CLI、Prisma Windows engine、schema、Migration、前后端构建结果及启动脚本。用户双击 `start.bat`；脚本固定使用 8787 端口，自动创建数据库、执行 `migrate deploy`、轮询 API 与首页后打开浏览器。`stop.bat` 仅停止 PID 文件指向且命令行匹配本应用的进程。

## 数据位置

- 数据库：`data/app.db`
- 用户图片：`data/uploads/`
- 自动备份：`data/backups/`
- PID：`data/app.pid`

这些运行数据均应被 Git 忽略。不要在服务运行期间手工替换数据库。

## 图片位置

首页小羊与快捷入口图位于 `app/client/src/assets/`；菜谱演示照片位于 `app/client/src/assets/recipe-photos/`；用户上传只进入 `data/uploads/`。

## 备份与恢复

设置页可导出包含 SQLite、配置快照和上传文件的 ZIP。恢复会校验路径、文件集合、大小、SHA-256、SQLite 完整性与 Migration，并要求一次性高风险授权；替换失败会回滚。

## 手机局域网访问

电脑与手机连接同一可信 Wi‑Fi，在设置页生成当前地址二维码。Windows 防火墙仅应允许专用网络访问 8787。正式环境会拒绝不匹配当前请求来源的浏览器 Origin。

## 安全说明

- PIN 会以加盐 scrypt 哈希保存；普通会话不能直接执行恢复。
- 恢复授权短效且一次性，PIN 关闭时仍要求独立的高风险意图确认。
- 首次引导只能成功一次，并以数据库条件更新保证并发安全。
- 备份恢复采用流式上限，拒绝路径穿越、重复/大小写冲突、符号链接、加密与未知文件。

## 已知限制

- 本项目是个人本地应用，不提供云同步或远程账户体系。
- 固定正式端口为 8787。
- macOS/Linux 自动测试不能证明 Windows 双击、路径特殊字符、防火墙与跨平台 Prisma engine 的发行行为；正式发布前仍需在干净 Windows 10/11 机器完成发布 smoke test。
- 默认餐次数量当前没有独立 schema 承载，首次引导不提供该设置。
