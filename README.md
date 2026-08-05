# 搭饭小馆

- 项目名称：搭饭小馆
- 当前状态：开发准备阶段
- 权威开发文档：`agent.md`、`docs/PRD.md`
- 视觉依据：`docs/design/desktop-home-reference.png`、`docs/design/mobile-home-reference.png`

## 当前开发阶段

节点 2：SQLite、Prisma 与 API 数据契约。

## 开发命令

首次使用先安装依赖：

```bash
npm install
```

分别启动前端或后端：

```bash
npm run dev:client
npm run dev:server
```

同时启动前端和后端：

```bash
npm run dev
```

检查类型、运行测试和构建：

```bash
npm run typecheck
npm run test
npm run build
```

## 节点 2：数据库基础

SQLite 数据库由 Prisma 管理，开发数据库位于 `data/app.db`，正式结构通过 Migration 建立。

测试使用独立的 `data/test.db`，每次测试前重建并执行同一套 Migration，不污染开发数据库。

```bash
npm run prisma:generate
npm run prisma:validate
npm run prisma:migrate
npm run prisma:migrate:status
```
