# HomeChef

家庭食材库存管理工具。

HomeChef 的核心目标是管理家中已有的食材及其库存：记录家里有什么、有哪些可用的叫法、有多少、什么时候入库的、什么时候过期，并在使用食材后手动扣减相应库存。

当前为 **v0.1**，处于**基础库存管理阶段**。菜谱、推荐、AI 等功能尚未实现，见文末的 Future / Planned。

---

## 当前已实现功能

**食材库（Ingredient Definition）**

- 食材定义：默认名称 + 别名 + 允许单位 + 预计保质期
- 每个食材定义拥有稳定的内部 ID（SQLite `AUTOINCREMENT`，删除后不复用）
- 重命名不改变 ID；所有业务关联都通过 ID，而不是名称
- 食材库搜索（默认名称与别名的包含匹配，可返回多个结果）
- 别名管理：新增、修改、删除、**设为默认名称**
- 允许单位管理：新增、移除
- 删除食材定义（存在任何库存记录时被拒绝）

**库存（Inventory）**

- 一个食材定义可以有 **0 到多条**库存记录（例如「土豆 3 个」「土豆 1 袋」「土豆 1 千克」）
- 多条记录**不会自动合并**，也不做跨单位汇总
- 每条库存记录可**独立**查看、编辑、删除、消耗
- 消耗后自动扣减；消耗数量不能超过当前库存（不允许负库存）
- 消耗到 0 后数据库记录**保留**，但当前库存列表隐藏 `quantity = 0` 的记录

**日期**

- 入库日期（代码字段 `purchase_date`，必填，默认当天）
- 生产日期（`production_date`，可为空）
- 到期日期（`expiry_date`，可为空）及其来源（`expiry_date_source`：`estimated` / `manual`）
- 未填写到期日期时，按食材定义的预计保质期自动估算
- 用户手动填写的到期日期**永远优先**，且不会被自动覆盖

**其他库存属性**

- 储存方式（常温 / 冷藏 / 冷冻）
- 备注

**数据校验**

- 数量必须是有限的非负数字
- 单位必须属于固定枚举，且必须在该食材定义允许的单位内
- 日期关系校验（生产日期不晚于入库日期；手动到期日期不早于入库日期）

---

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React + TypeScript + Vite |
| 后端 | Node.js + TypeScript + Fastify |
| 数据库 | SQLite + Drizzle ORM |

不使用 Redux / Zustand 等全局状态管理，前端使用原生 `fetch` 与 `useState`。

---

## 本地运行

需要 Node.js 20 或更高版本。

安装依赖（在仓库根目录执行）：

```bash
npm install
```

### 数据库 migration

HomeChef 使用 Drizzle 迁移管理数据库结构。首次运行需执行：

```bash
npm run db:migrate --workspace server
```

- migration 文件位于 `server/drizzle/`
- 数据库文件生成在 `server/data/homechef.db`（已被 `.gitignore` 忽略）

其他数据库脚本：

```bash
# 生成新的 migration（修改 schema 后）
npm run db:generate --workspace server

# 可视化查看数据库
npm run db:studio --workspace server
```

### 启动后端

在仓库根目录执行：

```bash
npm run dev:server
```

- 地址：http://localhost:3001
- 健康检查：http://localhost:3001/health

> 端口可用 `PORT` 环境变量覆盖。

### 启动前端

另开一个终端，在仓库根目录执行：

```bash
npm run dev:client
```

- 地址：http://localhost:5173

Vite 开发服务器已配置代理，会把 `/api` 请求转发到后端 `http://localhost:3001`，因此本地开发无需额外配置跨域。

### 构建

```bash
npm run build
```

---

## 项目结构

```
HomeChef/
├── client/      前端（React + TypeScript + Vite）
│   └── src/
│       ├── api/         后端 API 调用封装
│       ├── types/       与后端对应的类型定义
│       ├── pages/       库存页 / 食材库页
│       ├── components/  表单与对话框
│       └── format.ts    显示格式化与分组
│
├── server/      后端（Node.js + TypeScript + Fastify）
│   ├── src/
│   │   ├── routes/      接口层：路由、请求校验、错误映射
│   │   ├── services/    业务层：业务规则、事务、日期与库存逻辑
│   │   └── db/          Drizzle schema、连接、迁移
│   ├── drizzle/         migration 文件
│   └── data/            SQLite 数据库文件（.gitignore）
│
└── *.md         项目文档
```

**主要文档**

| 文档 | 用途 |
| --- | --- |
| `PROJECT_SPEC.md` | 项目目标、功能范围与开发阶段 |
| `TECH_STACK.md` | 技术选型与理由 |
| `ARCHITECTURE.md` | 系统架构与各层职责 |
| `DATABASE_DESIGN.md` | 数据库设计（表结构、约束、索引） |

---

## 测试与验证情况

当前项目**尚未配置自动化测试框架**（没有 Vitest / Jest 等）。

已完成的验证方式为开发阶段使用的临时集成脚本（真实 HTTP 请求 + 真实 SQLite），覆盖：

- 数据库结构、约束与 migration
- Service 层行为（日期估算、多库存记录、别名与默认名称切换）
- API 端到端行为（定义、别名、单位、库存、消耗、错误码）
- 前端页面编译与 API 联通

这些脚本属于阶段验证用途，未作为长期测试套件保留。

---

## Future / Planned

以下功能**尚未实现**，属于后续规划：

- 菜谱（recipes）
- 根据库存进行菜品推荐（meal recommendation）
- DeepSeek AI 接入
- 采购清单（shopping list）
- 账户与多用户
- 桌面应用（例如 Tauri 打包）
- 图片 / 条形码识别

---

## 项目原则

> 先做出一个真正能用的 HomeChef，再让它变得更复杂。
