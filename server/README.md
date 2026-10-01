# server —— 后端

Node.js + TypeScript + Fastify。见 `ARCHITECTURE.md` 第 2.2、2.3、7 节。

## 启动

```bash
# 在仓库根目录
npm run dev:server

# 或在 server/ 目录
npm install
npm run dev
```

默认地址：http://localhost:3001
健康检查：http://localhost:3001/health

> 端口可用 `PORT` 环境变量覆盖，例如 `$env:PORT=3210; npm run dev:server`。
> 默认值原为 3000，因本机 3000 已被其他程序占用，改为 3001。

## 当前状态

项目初始化阶段（Phase 1）。只包含 Fastify 启动文件和健康检查，**不含任何业务 API、数据库、Service**。

## 目录说明

`ARCHITECTURE.md` 第 7 节规划的目录结构：

```
server/
├── src/
│   ├── routes/     接口层：路由与入口校验
│   ├── services/   业务层：归一化、别名解析、库存校验、消耗事务
│   ├── db/         Drizzle schema、配置、迁移、内置别名种子数据
│   ├── types/      类型定义
│   └── server.ts   应用入口
└── data/           SQLite 数据库文件（.gitignore）
```

其中 `routes/`、`services/`、`db/`、`types/`、`data/` **尚未创建**。

原因：当前是初始化阶段，这些目录还没有任何内容。
按任务要求「不要为了未来扩展提前创建大量空目录」，等 Phase 2 实际实现对应功能时再创建。

**重要**：`routes/` 与 `services/` 必须分开（`ARCHITECTURE.md` 第 7 节），
一个写「HTTP 怎么进怎么出」，一个写「业务怎么算」。实现时不要合并。

## 注意

`data/` 用于存放 SQLite 数据库文件，已在根目录 `.gitignore` 中排除。
