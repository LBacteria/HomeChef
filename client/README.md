# client —— 前端

React + TypeScript + Vite。见 `ARCHITECTURE.md` 第 2.1、7 节。

## 启动

```bash
# 在仓库根目录
npm run dev:client

# 或在 client/ 目录
npm install
npm run dev
```

默认地址：http://localhost:5173

## 当前状态

项目初始化阶段（Phase 1）。只包含最小启动文件，**不含任何业务页面**。

`vite.config.ts` 已配置 `/api` 代理到 `http://localhost:3001`（见 `ARCHITECTURE.md` 第 8 节）。

## 目录说明

`ARCHITECTURE.md` 第 7 节规划的目录结构：

```
client/
├── src/
│   ├── pages/        库存列表 / 添加 / 编辑 / 消耗
│   ├── components/   表单、列表、单位选择器
│   ├── api/          后端 API 调用封装
│   └── types/        与后端共享的类型定义
└── vite.config.ts
```

其中 `pages/`、`components/`、`api/`、`types/` **尚未创建**。

原因：当前是初始化阶段，这些目录还没有任何内容。
按任务要求「不要为了未来扩展提前创建大量空目录」，等 Phase 2 实际实现对应功能时再创建。
届时按上述结构放置即可，架构不变。
