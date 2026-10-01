# HomeChef

家庭食材库存管理工具。

HomeChef 的核心目标是管理家中已有的食材及其库存：记录家里有什么、有多少、什么时候买的、什么时候过期，并支持在使用食材后手动扣减相应库存。

当前为 **v0.1**，处于**基础库存管理阶段**。菜谱、推荐、AI 等功能尚未实现，属于后续规划。

---

## 当前已实现功能

**食材库存管理**

- 添加食材
- 查看食材库存
- 编辑食材
- 删除食材
- 消耗食材并扣减库存
- 库存不足时拒绝消耗（不允许负库存）

**食材信息**

- 购买日期
- 过期日期
- 备注

**食材别名**

- 一个标准食材可以拥有多个别名（例如「番茄」可以有别名「西红柿」）
- 一个别名只能属于一个标准食材

> 别名目前只提供**后端 API**，尚未实现前端管理界面。

**数据校验**

- 基础数量校验（必须为有限的非负数字）
- 单位校验（限定在固定单位枚举内）

---

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | React + TypeScript + Vite |
| 后端 | Node.js + TypeScript + Fastify |
| 数据库 | SQLite + Drizzle ORM |

---

## 本地运行

需要 Node.js 20 或更高版本。

首次运行先安装依赖（在仓库根目录执行）：

```bash
npm install
```

初始化数据库（生成 SQLite 文件并建表）：

```bash
npm run db:migrate --workspace server
```

### 启动后端

在仓库根目录执行：

```bash
npm run dev:server
```

- 地址：http://localhost:3001
- 健康检查：http://localhost:3001/health

### 启动前端

另开一个终端，在仓库根目录执行：

```bash
npm run dev:client
```

- 地址：http://localhost:5173

前端开发服务器已配置代理，会把 `/api` 请求转发到后端 `http://localhost:3001`，因此本地开发无需额外配置跨域。

### 构建

```bash
npm run build
```

---

## 项目结构

```
HomeChef/
├── client/      前端（React + TypeScript + Vite）
├── server/      后端（Node.js + TypeScript + Fastify + SQLite）
└── *.md         项目文档（见下）
```

**主要文档**

| 文档 | 用途 |
| --- | --- |
| `PROJECT_SPEC.md` | 项目目标、功能范围与开发阶段 |
| `TECH_STACK.md` | 技术选型与理由 |
| `ARCHITECTURE.md` | 系统架构与各层职责 |
| `DATABASE_DESIGN.md` | 数据库设计（表结构、约束、索引） |

---

## 后续规划

以下方向尚未实现，仅作为后续计划：

- 设置页面
- 食材管理功能增强（例如别名管理界面）
- 菜谱
- 根据库存进行菜品推荐
- 后续可能加入 AI 功能

---

## 项目原则

> 先做出一个真正能用的 HomeChef，再让它变得更复杂。
