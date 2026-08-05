# 搭饭小馆

- 项目名称：搭饭小馆
- 当前状态：节点 3 设计系统与响应式框架已完成，等待验收
- 权威开发文档：`agent.md`、`docs/PRD.md`
- 视觉依据：`docs/design/desktop-home-reference.png`、`docs/design/mobile-home-reference.png`

## 当前开发阶段

节点 3：设计系统与响应式框架。

## 节点 3：设计系统与响应式框架

统一视觉变量位于 `app/client/src/styles/tokens.css`，全局样式拆分为 reset、global、utilities 与组件样式。页面主色为粉白色系，公共组件覆盖卡片、按钮、表单控件、标签、Tabs、Dialog、Drawer、Toast、Skeleton、空状态、错误状态和区块标题。

响应式断点固定为：手机 `0–767px`、平板 `768–1199px`、桌面 `1200px 及以上`。桌面端使用固定侧栏与顶部栏，移动端使用品牌栏与固定底部导航；页面内容支持安全区并在 360px 宽度下避免横向溢出。

桌面导航：首页、菜谱推荐、饮食记录、食材库存、饮食日历、统计分析、收藏夹、购物清单、设置。

移动导航：首页、厨师、觅食、日记；设置入口位于顶部品牌栏右侧。

本节点只包含框架、占位路由和公共组件预览，不包含正式首页、业务 CRUD、Mock 业务数据或数据库业务查询。小羊素材目录已建立，统一本地透明资产待提供，当前使用无外部依赖的占位组件。

## 节点 2：SQLite、Prisma 与 API 数据契约。

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
