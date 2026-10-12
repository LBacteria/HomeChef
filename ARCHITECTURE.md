# HomeChef 系统架构

> 状态：Draft
> 日期：2026-10-02（v0.2.0 章节补充于 2026-10-12）
> 适用范围：**库存系统 v0.1 + 菜谱模块 v0.2.0（当前已实现）**

## 0. 本文档的范围

本文档描述 **HomeChef v0.2.0** 的系统架构，与实际实现保持一致。

v0.1 实现「家庭食材库存系统」；**v0.2.0 增加菜谱模块**（菜谱 CRUD、多 Tag、
名称搜索、Tag 筛选、排序、列表设置持久化，以及详情 / 编辑 / 删除界面）与**库存搜索**。
推荐、AI、采购清单仍未实现。

关于完整 HomeChef 的长期目标，见 `PROJECT_SPEC.md`。
关于技术选型理由，见 `TECH_STACK.md`。
关于表结构，见 `DATABASE_DESIGN.md`。

### v0.1 已实现功能

1. 食材定义（默认名称、别名、允许单位、预计保质期）
2. 食材库搜索（默认名称 + 别名的包含匹配）
3. 别名管理（新增、修改、删除、设为默认名称）
4. 允许单位管理
5. 库存记录增删改查（一个定义对应 0..N 条记录）
6. 消耗库存并扣减
7. 库存不足时拒绝消耗
8. 入库日期、生产日期、到期日期、储存方式、备注
9. 到期日期自动估算与来源追踪（`estimated` / `manual`）
10. 数量与单位校验

### v0.2.0 新增

1. 菜谱主表与食材组成（**允许重复关联同一食材**，按添加顺序展示）
2. 多 Tag 标签系统（自由创建 + 复用已有；同名不重复）
3. 菜谱**名称搜索**（只匹配名称，Tag 名称不参与）
4. Tag 筛选（**AND / OR**，默认 AND，可在选择窗口中切换）
5. 菜谱列表排序（最近修改 / 创建 / 名称 × 升降序）与**设置持久化**
6. **菜谱详情 / 编辑 / 删除**的前端界面
7. 库存搜索（按库存记录对应的食材名称本地过滤）

### v0.2.0 仍不做

菜谱推荐、根据库存判断能否制作（库存联动）、DeepSeek AI、采购清单、多用户、
图片识别、条码识别、菜谱份数 / 照片 / 完整制作流程编辑，
以及其他未明确的需求。

架构上不为这些未实现功能预留表或接口。

---

## 1. 系统整体结构

整个系统是**单进程、单数据库文件**的本地 Web 应用，数据通路是一条直线：

```
┌──────────────────────────────────────────┐
│  浏览器                                    │
│  React + TypeScript SPA（Vite 构建）       │
│  库存页（按 definition 分组） / 食材库页     │
└─────────────────┬────────────────────────┘
                  │ HTTP + JSON
                  ▼
┌──────────────────────────────────────────┐
│  Node.js 进程（本地运行）                   │
│                                           │
│  ┌─────────────────────────────────────┐ │
│  │ ① Fastify 路由层                     │ │
│  │   路由、JSON Schema/AJV 校验、         │ │
│  │   请求解析、统一错误映射                │ │
│  └──────────────┬──────────────────────┘ │
│                 ▼                          │
│  ┌─────────────────────────────────────┐ │
│  │ ② Service 业务层                     │ │
│  │   业务规则、事务、名称归一化、          │ │
│  │   名称/别名解析、日期与 expiry、        │ │
│  │   库存规则                            │ │
│  └──────────────┬──────────────────────┘ │
│                 ▼                          │
│  ┌─────────────────────────────────────┐ │
│  │ ③ Drizzle ORM                        │ │
│  └──────────────┬──────────────────────┘ │
└─────────────────┼────────────────────────┘
                  ▼
          ┌──────────────┐
          │ SQLite 文件   │
          │ （唯一事实源） │
          └──────────────┘
```

**关键点：**

- 没有 AI，没有外部服务，没有第二个数据源。
- 只有后端能访问数据库，前端只能通过 HTTP API。
- 名称解析、日期估算与库存判断**只发生在 Service 层**。

---

## 2. 各层职责

### 2.1 前端（React + TypeScript + Vite）

**负责：**

- UI 渲染：库存页（按 definition 分组）、食材库页
- 收集用户输入，做**基础格式校验**：必填项、是否为数字、是否大于 0、日期是否填写
- 调用后端 API，展示 loading / 成功 / 失败
- 展示后端返回的错误信息（优先使用后端 `message`）
- 通过 API 获取 definition 列表，并用 `definition_id` 映射库存记录的名称
- 区分显示 `estimated`（预计到期）与 `manual`（到期）

**不负责：**

- ❌ 不判断库存是否足够（权威判定在后端）
- ❌ 不做名称归一化、别名唯一性判断
- ❌ **不做日期计算**（到期日期估算完全由后端负责）
- ❌ 不判断单位是否正在被使用、能否删除
- ❌ 不直接访问 SQLite
- ❌ 不决定任何业务规则

> 前端可以有用于即时提示的逻辑，但**权威永远在后端**。

### 2.2 后端路由层（Fastify）

**负责：**

- 定义路由（`/api/definitions/**`、`/api/ingredients/**`）
- 解析请求体、查询参数、路径参数
- **入口校验**：使用 Fastify JSON Schema / AJV 校验字段存在性、类型、基本范围
- 解析并校验路径中的 ID（必须是正整数）
- 调用对应的 Service 函数
- 把结果序列化为 JSON
- **统一错误出口**：任何异常都转换成一致的错误格式

**AJV 配置（重要）：**

Fastify 默认的 AJV 行为会削弱校验，因此显式关闭：

```
coerceTypes: false      // 不要让 "3" 自动变成 3
removeAdditional: false // 不要静默删除未知字段
```

**不负责：**

- ❌ 不写业务规则（库存够不够、名称如何解析、日期如何估算）
- ❌ 不直接查库（一律经过 Service）

### 2.3 后端业务层（Service）

这是整个系统的核心，也是**唯一允许做业务判断的地方**：

| 能力 | 说明 |
|---|---|
| **名称归一化** | `trim()` + `toLowerCase()`，唯一实现 |
| **跨表唯一性** | 默认名称与别名之间不能重名（数据库无法跨表强制） |
| **名称/别名解析** | 归一化后的精确匹配，优先默认名称 |
| **食材库搜索** | 默认名称 + 别名的包含匹配（与精确解析严格区分） |
| **默认名称切换** | 事务内完成：旧默认名称降级为别名，新默认名称从别名移除 |
| **允许单位校验** | 库存单位必须属于该定义的允许单位 |
| **到期日期估算** | `estimated` / `manual` 来源判定与计算 |
| **删除保护** | 有库存时拒绝删除定义；单位被使用时拒绝移除 |
| **消耗事务** | 读取 → 校验 → 扣减，原子执行 |

### 2.4 Drizzle ORM

- 定义数据库 schema
- 生成类型安全的查询
- 管理迁移
- 提供事务接口

**不负责**：任何业务判断。

### 2.5 SQLite

- **数据的唯一事实来源**（single source of truth）
- 保证事务
- 通过约束强制数据完整性：
  - 食材定义名称唯一（`name_normalized`）
  - 别名文本全局唯一（`alias_normalized`）
  - 同一食材不重复声明同一单位
  - 外键（别名/允许单位随定义级联删除；库存不被级联删除）
  - 数量非负、单位枚举、储存方式枚举（CHECK 约束）
  - 到期日期与来源成对一致、生产日期不晚于入库日期（CHECK 约束）

**硬性规定：**

- 库存数量、单位一律以数据库为准。
- 任何写操作都必须经过 Service 层。
- 前端永远不接触数据库文件。

---

## 3. 食材定义、名称与别名建模

这是 v0.1 的核心概念。

### 3.1 概念

- **食材定义（ingredient definition）**：食材的稳定身份，拥有一个不可复用的 ID。
- **默认名称（name）**：该定义当前的显示名称，只有一个。
- **别名（alias）**：同一食材的其他叫法，可以有 0..N 个。

```
ingredient_definition #10023
  默认名称：番茄
  别名：
   ├── 西红柿
   └── 番茄子
```

- **一个定义 → 一个默认名称**
- **一个定义 → 0..N 个别名**
- **一个别名 → 只能属于一个定义**（全局唯一）

### 3.2 名称不是身份

**`ingredient_definition.id` 是稳定内部身份：**

- 由数据库生成（`INTEGER PRIMARY KEY AUTOINCREMENT`）
- **改名不改变 ID**
- **删除后的 ID 不允许重新使用**（AUTOINCREMENT 保证）
- 所有业务关联使用 `definition_id`，**不允许依赖名称**

> 使用 AUTOINCREMENT 的理由：普通 `INTEGER PRIMARY KEY` 使用"当前最大 rowid + 1"分配，
> 删除最大 ID 的行后会复用该 ID。ID 即身份时，这不可接受。

### 3.3 默认名称切换

用户可以把某个别名设为默认名称：

```
番茄 ★默认 / 别名：西红柿、番茄子
   ↓ 把「西红柿」设为默认
西红柿 ★默认 / 别名：番茄、番茄子
```

规则（由 Service 在事务内保证）：

- definition ID 不变
- 新默认名称**从别名中移除**
- 原默认名称**自动成为别名**
- 别名总数不变

### 3.4 名称归一化与解析规则

**归一化（所有名称处理前先执行）：**

```
input.trim().toLowerCase()
```

就这两步，全项目只有一个实现。

**明确不做：**

- ❌ 模糊匹配
- ❌ 编辑距离 / 相似度
- ❌ 拼音
- ❌ 繁简转换
- ❌ 全角 / 半角转换
- ❌ 内部空格折叠
- ❌ 用 AI 推断

### 3.5 搜索与精确解析（重要区分）

这是两个**不同**的能力，不能混为一谈：

| | 食材库搜索 | 精确解析 |
|---|---|---|
| 函数 | `searchDefinitions(query)` | `resolveDefinitionByName(input)` |
| 匹配方式 | **包含匹配**（substring） | **归一化精确匹配** |
| 匹配范围 | 默认名称 + 别名 | 默认名称（优先）+ 别名 |
| 返回 | **多个** definition | **一个** definition |
| 用途 | 食材库 UI 搜索框 | 用户明确选定某个名称 |
| 示例 | 输入「土」→ 土豆、土鸡、观音土 | 输入「地瓜」→ 番薯；输入「地」→ 无结果 |

### 3.6 跨表唯一性

数据库有两张表各自的 UNIQUE 约束，但**无法跨表强制**，因此这条规则由 Service 保证（不引入 Trigger）：

> 一个字符串经过归一化后，**不能同时作为任何默认名称或任何别名存在**。

| 场景 | 数据库行为 | Service 行为 |
|---|---|---|
| 名称重复（同表） | UNIQUE 违反 | 提前检查，返回 `DUPLICATE_NAME` |
| 别名重复（同表） | UNIQUE 违反 | 提前检查，返回 `DUPLICATE_NAME` |
| 名称/别名跨表重名 | **拦不住** | 必须跨表检查，返回 `DUPLICATE_NAME` |

### 3.7 别名数据

- 用户可以手动新增、修改、删除别名
- 别名冲突直接报错，不提供自动迁移
- 默认名称允许修改，但必须检查唯一性
- **不做"合并两个食材定义"功能**

---

## 4. 库存模型（1 : N）

### 4.1 一个定义对应多条库存记录

```
ingredient_definition（土豆）
   ├── standard_ingredient #1 → 3 个
   ├── standard_ingredient #2 → 1 袋
   └── standard_ingredient #3 → 1 千克
```

**为什么不是 1:1**：不同批次可能有不同的单位、入库日期、生产日期、到期日期、储存方式、备注。
强行合并会产生无法表达的语义（`3 个` + `1 袋` 在"不做单位换算"的前提下无法相加）。

### 4.2 硬性规则

| 规则 | 说明 |
|---|---|
| 一个定义可有 **0..N** 条库存记录 | 数据库**不允许** `UNIQUE(definition_id)` |
| 添加同种食材**创建新记录** | 不拒绝"重复食材"，不自动合并 |
| **不做跨单位汇总** | 前端分组展示时只显示记录条数，不显示错误的数量合计 |
| 每条记录**独立**编辑/删除/消耗 | 互不影响 |
| 消耗针对**库存记录 ID** | 不是 definition ID |
| 消耗不得超过当前库存 | 不允许负库存 |
| 扣减到 0 | **允许**，记录保留 |

### 4.3 ID 区分（极其重要）

| 操作 | 使用哪个 ID |
|---|---|
| 编辑 / 删除 / 消耗库存 | **`standard_ingredient.id`**（库存记录 ID） |
| 修改名称、别名、单位、保质期、删除定义 | **`ingredient_definition.id`**（定义 ID） |

### 4.4 零数量处理

- 消耗到 0 后，数据库记录**保留**（未来可能需要历史数据）
- Service **不自动删除**
- 当前库存接口与 UI **隐藏** `quantity = 0` 的记录
- 若某定义的所有库存记录都是 0，该定义不出现在当前库存列表中
- 但**只有 0 数量记录时，定义仍不能删除**（有记录即视为"有库存"）

### 4.5 删除行为

| 操作 | 库存记录 | 别名 / 允许单位 | 食材定义 |
|---|---|---|---|
| 删除**库存记录** | 删除该条 | 不受影响 | **保留** |
| 删除**定义**（无任何库存） | — | **级联删除** | 删除 |
| 删除**定义**（有任何库存） | **拒绝，返回 `HAS_STOCK`** | 保留 | 保留 |

**库存绝不会因为删除定义而被级联删除。**
数据库外键使用 `ON DELETE RESTRICT` 作为最后防线，Service 提前检查并返回友好错误。

---

## 5. 数量和单位处理

| 项目 | v0.1 方案 |
|---|---|
| **数量类型** | **实数**（SQLite REAL） |
| **数量精度** | 写入前舍入到 3 位小数；容差 `1e-9` 用于钳制与比较 |
| **单位** | **固定枚举**，不是自由文本 |
| **单位枚举** | `个`、`克`、`千克`、`毫升`、`升`、`包`、`袋`、`瓶`、`盒`、`罐` |
| **定义允许单位** | 每个定义**至少一个**；库存单位必须属于该列表 |
| **单位换算** | **不做** |
| **跨单位比较/消耗** | **不允许** |

**为什么单位用枚举：** 自由文本会导致"克""g""G""公克"并存，之后任何涉及单位的比较或计算都无法可靠进行。

**舍入与钳制集中在一处实现**（`services/quantity.ts`），不允许散落在各个调用点。

### 5.1 允许单位的管理规则

- 每个定义必须至少保留一个允许单位 → 删除最后一个被拒绝（400）
- 移除正在被库存记录使用的单位 → 返回 `UNIT_IN_USE`（409）
- 库存的单位必须属于该定义的允许单位 → 否则 `UNIT_NOT_ALLOWED`（400）

---

## 6. 日期与到期日期

### 6.1 字段

| 字段 | 含义 | 必填 |
|---|---|---|
| `purchase_date` | **入库日期**（文档/UI 用词；代码保留该字段名） | **是**，缺省为当前日期 |
| `production_date` | 生产日期 | 否 |
| `expiry_date` | 到期日期 | 否 |
| `expiry_date_source` | 到期日期来源：`estimated` / `manual` / NULL | 与 `expiry_date` 成对 |

### 6.2 成对约束

```
expiry_date IS NULL      → expiry_date_source IS NULL
expiry_date IS NOT NULL  → expiry_date_source IN ('estimated','manual')
```

由数据库 CHECK 约束强制。

> 注意 CHECK 的写法：SQLite 只在结果为 FALSE 时拒绝，结果为 NULL 时放行。
> 因此实现使用了显式返回 0/1 的 `CASE` 表达式，避免 `NULL IN (...)` 绕过约束。

### 6.3 到期日期计算（创建时）

```
用户提供了 expiry_date？
  ├─ 是 → 使用该值，source = manual（永远优先，不被覆盖）
  └─ 否 → 定义有 estimated_shelf_life_days？
        ├─ 有 → production_date 存在？
        │        ├─ 是 → production_date + shelf life，source = estimated
        │        └─ 否 → purchase_date + shelf life，source = estimated
        └─ 无 → expiry_date = NULL，source = NULL
```

### 6.4 更新时的规则

| 情况 | 行为 |
|---|---|
| PATCH **显式包含** `expiry_date`（非 null） | 设为该值，source = **manual** |
| PATCH **显式包含** `expiry_date: null` | 清空 expiry 与 source，**不自动重算** |
| PATCH 未包含 `expiry_date`，但改了 `purchase_date` / `production_date`，当前 source = `estimated` | **重新计算** |
| 同上，当前 source = `NULL` | 若定义此时有保质期则计算 |
| 同上，当前 source = `manual` | **保持原值，不自动修改** |
| 只改 `quantity` / `unit` / `note` / `storage_method` | **不重算** |

**一旦用户手动设置 expiry，永远不会自动变回 `estimated`。**

### 6.5 修改定义的保质期

修改 `estimated_shelf_life_days` **只影响以后新建的库存记录**。

**绝不自动修改已有库存记录**——那等于系统单方面改写用户数据。

### 6.6 日期合法性

| 规则 | 结果 |
|---|---|
| `production_date > purchase_date` | **拒绝**（`INVALID_DATE_RANGE`） |
| **manual** expiry `< purchase_date` | **拒绝**（`INVALID_DATE_RANGE`） |
| **estimated** expiry `< purchase_date` | **允许**（表示按默认保质期估算，入库时已超过预计日期） |

**不根据其他日期反推生产日期**——那会制造虚假事实。

### 6.7 日期计算实现

使用**纯日期运算 / UTC 安全**逻辑（`services/dates.ts`）：

- 输入输出均为 `YYYY-MM-DD`
- 全程使用 UTC，避免本地时区导致跨日错误
- 不使用 `new Date(year, month, day)` 这类受本地时区影响的构造

---

## 7. 储存方式

当前支持：**常温 / 冷藏 / 冷冻**。

- 这是**库存记录属性**（每条记录各自独立）
- 当前**不参与** shelf-life 计算
- 由数据库 CHECK 约束限定取值

---

## 8. 消耗事务设计

消耗是库存操作中**唯一需要事务**的地方。

```
BEGIN
  SELECT 当前数量, 单位 FROM standard_ingredient WHERE id = ?
     └─ 不存在 → ROLLBACK，返回 404
  校验 amount > 0（事务外先行校验）
  IF 请求数量 > 当前数量（考虑浮点容差）
     └─ ROLLBACK，返回 409 INSUFFICIENT_STOCK
  UPDATE quantity = quantity - ?
COMMIT
```

**设计决策：**

| 决策 | 行为 |
|---|---|
| **库存不足** | **拒绝整笔操作**，返回 409，**不部分扣减** |
| **强制消耗** | **不允许** |
| **负库存** | **绝对不允许**，这是红线 |
| **扣减到 0** | **允许**，**保留库存记录** |
| **浮点误差** | 使用容差比较；只有"真实不足"才拒绝，容差内的伪负值钳制为 0 |
| **跨记录消耗** | **不允许**（不自动寻找其他库存记录） |
| **FIFO** | **不做** |
| **消耗历史** | **不记录** |

---

## 9. 前后端通信

**方式：本地 HTTP + JSON。**

- 后端默认监听 `http://localhost:3001`（可用 `PORT` 覆盖）
- 前端开发服务器（`5173`）通过 **Vite proxy** 把 `/api` 转发到后端，开发期避开跨域问题
- 本地使用时，可由后端托管构建好的前端静态文件，**只跑一个进程**

### 9.1 食材定义 API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/definitions` | 列出 / 搜索定义（`?search=` 为包含匹配） |
| GET | `/api/definitions/:id` | 查看单个定义（含 aliases、allowed_units） |
| POST | `/api/definitions` | 新增定义 |
| PATCH | `/api/definitions/:id` | 修改默认名称 / 预计保质期 |
| PATCH | `/api/definitions/:id/full` | **统一保存**（v0.1.4）：基础字段 + 别名 + 单位 + 设为默认，**单事务** |
| DELETE | `/api/definitions/:id` | 删除定义（有库存时 409 `HAS_STOCK`） |
| POST | `/api/definitions/:id/default-name` | 把某别名设为默认名称 |
| GET | `/api/definitions/:id/aliases` | 别名列表 |
| POST | `/api/definitions/:id/aliases` | 新增别名 |
| PATCH | `/api/definitions/:id/aliases/:aliasId` | 修改别名 |
| DELETE | `/api/definitions/:id/aliases/:aliasId` | 删除别名 |
| GET | `/api/definitions/:id/units` | 允许单位列表 |
| POST | `/api/definitions/:id/units` | 新增允许单位 |
| DELETE | `/api/definitions/:id/units/:unit` | 移除允许单位 |

### 9.2 库存 API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/ingredients` | 库存列表（默认隐藏 `quantity = 0`；`?includeZero=true` 可包含） |
| GET | `/api/ingredients/:id` | 查看单条库存记录（`:id` 为库存记录 ID） |
| POST | `/api/ingredients` | 新增库存记录（需 `definition_id`） |
| PATCH | `/api/ingredients/:id` | 修改库存记录 |
| DELETE | `/api/ingredients/:id` | 删除库存记录 |
| POST | `/api/ingredients/:id/consume` | 消耗库存 |

**说明：**

- 一律返回 JSON
- 菜谱相关接口见 **第 15 节**
- **不为推荐、采购清单等未实现功能预留任何接口**
- v0.1 **没有**独立的名称解析接口（解析由 Service 内部使用）

---

## 10. 错误处理和数据验证

### 10.1 验证分层

| 层 | 验证内容 |
|---|---|
| **前端** | 表单基础格式：必填、数字、大于 0、日期是否填写 |
| **Fastify 路由层** | 请求结构：字段存在、类型正确、ID 为正整数（JSON Schema / AJV） |
| **Service 业务层** | **业务规则**：名称唯一性、别名冲突、单位是否允许、库存是否足够、日期关系、删除保护 |
| **数据库层** | UNIQUE、外键、CHECK —— 最后一道防线 |

### 10.2 统一错误格式

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "库存不足：需要 2，现有 1（单位：个）"
  }
}
```

### 10.3 错误处理原则

- 路由层用统一的错误处理器兜底
- 业务错误使用明确的 `code`，前端优先显示 `message`
- **业务失败返回 4xx，而不是 500** —— 这是正常业务结果
- 未捕获异常返回 500，并记录日志

### 10.4 主要错误码

| code | HTTP | 说明 |
|---|---|---|
| `VALIDATION_ERROR` | 400 | 请求字段不合法 |
| `UNIT_NOT_ALLOWED` | 400 | 单位不在该定义的允许单位内 |
| `INVALID_DATE_RANGE` | 400 | 日期关系不合法 |
| `INGREDIENT_NOT_FOUND` | 404 | 库存记录 / 别名不存在 |
| `DEFINITION_NOT_FOUND` | 404 | 食材定义不存在 |
| `INGREDIENT_EXISTS` | 409 | 食材（同表）已存在 |
| `DUPLICATE_NAME` | 409 | 名称重复（含跨表名称/别名冲突、别名重复） |
| `INSUFFICIENT_STOCK` | 409 | 库存不足 |
| `HAS_STOCK` | 409 | 该定义仍有库存记录，无法删除 |
| `UNIT_IN_USE` | 409 | 该单位仍被库存记录使用，无法移除 |
| （未知） | 500 | `INTERNAL_ERROR` |

---

## 11. 架构原则总结

1. **ID 即身份**：`definition_id` 稳定且不复用；名称只是可修改的显示属性
2. **只有 Service 层能做业务判断**
3. **只有后端能访问数据库**，前端只能通过 HTTP API
4. **数据库是唯一事实来源**
5. **搜索与精确解析严格区分**（包含匹配 vs 归一化精确匹配）
6. **一个定义对应 0..N 条库存记录**，不自动合并、不跨单位汇总
7. **库存扣减必须在一个事务里**
8. **不猜、不模糊匹配** —— 匹配不上就是匹配不上
9. **不制造虚假事实** —— 不反推生产日期，不自动改写用户手动设置的日期

---

## 12. 临期状态与排序（v0.1.2）

### 12.1 临期状态

四种状态，**全部由后端计算**，前端只做文案映射：

| 状态 | 含义 |
|---|---|
| `no_expiry` | `expiry_date IS NULL`，无到期日期 |
| `expired` | 已超过 `expiry_date` |
| `expiring` | 未过期，且满足临期规则 |
| `normal` | 未过期，且不满足临期规则 |

**判定顺序（严格）**：

```
1. expiry_date === null            → no_expiry
2. today > expiry_date             → expired      ← 永远优先
3. 未过期 → 按模式判断 expiring / normal
```

- **`expired` 优先于 `expiring`**：过期就是过期，不会再被判为临期
- **到期当天不算过期**（`today == expiry_date` → `days_remaining = 0`），归入临期

### 12.2 days 模式

```
days_remaining <= threshold  →  expiring
```

`days_remaining` = 从今天到 `expiry_date` 的天数（可为负）。
阈值使用 `<=`（含等于）。

### 12.3 percentage 模式

把百分比**折算成天数**再比较：

```
expiring_days = ceil(total_shelf_life_days × threshold / 100)
days_remaining <= expiring_days  →  expiring
```

> ⚠️ **不是** `remaining_percentage <= threshold`。
> 例如总保质期 10 天、阈值 15% ⇒ `ceil(1.5) = 2` 天，剩余 2 天即为临期。

`total_shelf_life_days` 的起点为 `production_date ?? purchase_date`。

### 12.4 返回字段

| 字段 | 说明 |
|---|---|
| `expiry_status` | 上述四态之一 |
| `days_remaining` | 剩余天数，`no_expiry` 时为 `null` |
| `remaining_percentage` | 剩余百分比，无法计算时为 `null`；**仅用于展示**，不参与状态判定 |

`remaining_percentage` 是展示字段，**不参与临期判断**（判定只用折算天数）。

### 12.5 到期日期来源

| 来源 | 含义 |
|---|---|
| `estimated` | 由 `estimated_shelf_life_days` 自动估算 |
| `manual` | 用户手动填写 |
| `NULL` | 无到期日期（对应 `no_expiry`） |

**`manual` 永远不会自动变回 `estimated`**：一旦用户手动设置到期日期，
之后即使修改入库/生产日期，也只**保留原值**，不自动重算。

### 12.6 排序

排序**全部在后端执行**，前端只传参。两个排序功能**完全独立**：

**库存排序**（`stockSortService`）：

| `sort` | 含义 |
|---|---|
| `default` | 按临期状态分组：`expired → expiring → normal → no_expiry` |
| `expiry` | 按剩余天数 |
| `purchase_date` | 按入库日期 |
| `name` | 按食材名称 |
| `quantity` | 按数量 |

`order` 为 `asc` / `desc`。

> **无保质期的记录在两个方向上都排在最后**，不会被当成 0 天参与比较。

**食材库排序**（`definitionSortService`）：

| `sort` | `order` | 含义 |
|---|---|---|
| `name` | `asc` | 名称 A → Z（默认） |
| `name` | `desc` | 名称 Z → A |

排序**不持久化**（不写数据库、不写 localStorage），刷新后回到 A → Z。

两个排序都支持与 `search` / `category_id` 组合使用。

### 12.7 设置

`app_settings` 为单行表，通过 `GET /api/settings` / `PATCH /api/settings` 读写：

| 设置 | 取值 |
|---|---|
| `expiry_warning_mode` | `days` / `percentage` |
| `expiry_warning_threshold` | `days` 模式为整数；`percentage` 模式为 0–100 |
| `allow_expired_for_recipe` | 布尔（**当前仅保存**，供后续食谱功能使用） |

`PATCH` 会校验**合并后的最终组合**（例如切到 `days` 模式时阈值必须是整数）。

---

## 13. 食材分类与调味品（v0.1.3）

### 13.1 分类模型

```
category  1 ──── N  ingredient_definition
```

- 只有**一套**分类机制：`category` 表 + `ingredient_definition.category_id`
- **不存在** `ingredient_type` / `seasoning_type` / `builtin_category` / `custom_category`
- 内置分类与用户自定义分类使用**完全相同**的结构
- 分类名称**唯一**（归一化后判重）

### 13.2 分类不是食材身份

| | 身份 | 可修改 |
|---|---|---|
| `ingredient_definition.id` | ✅ **稳定内部 identity**，永不复用 | ❌ |
| `name` | ❌ 只是显示属性 | ✅ |
| `category_id` | ❌ 只是归类属性 | ✅ |

- **改名不改变 `id`**
- **改分类不改变 `id`**
- 别名与分类都不参与身份判定

### 13.3 19 个默认分类

```
蔬菜    水果    水产    蛋类    豆制品
乳制品  主食/谷物  干货/菌菇  冷冻食品  调味品
其他/饮品

猪肉    牛肉    羊肉    其他畜肉
鸡肉    鸭肉    鹅肉    其他禽肉
```

共 **19 个**。

- `食用油` **不再是独立分类** —— 花生油 / 菜籽油 / 橄榄油 / 大豆油 / 玉米油 / 猪油 均归 **`调味品`**
- `畜肉` 与 `禽肉` **不是最终分类**，已按具体食材拆分到上述细分类

### 13.4 冷冻食品语义

**`冷冻食品` 表示食材本身就是冷冻 / 速冻成品或半成品**，例如：

```
冷冻饺子  馄饨  汤圆  薯条  鸡块  鱼丸
冰淇淋    冷冻包子  牛肉丸  薯饼  冷冻鸡翅
```

> ⚠️ **`冷冻食品` ≠ 储存方式为冷冻。**
>
> `牛肉` 即使库存 `storage_method = 冷冻`，分类**仍然是 `牛肉`**。
> 分类描述「这是什么食材」，储存方式描述「怎么存放」，两者无关。

### 13.5 调味品 = presence-only

调味品**不是数量型库存**，业务语义只有：

```
有 / 无
```

**调味品 definition**：

- **不要求** `allowed_units`，可以为**空数组**
- **不要求** 预计保质期
- 不使用占位单位伪装

**调味品 inventory** 内部使用 B2 兼容值（见 `DATABASE_DESIGN.md` 第 15.7 节）：

```
quantity = 0
unit = "个"
purchase_date = today
storage_method = "常温"
expiry_date = NULL
expiry_date_source = NULL
```

> `unit = "个"` 只是**内部 sentinel**，不代表用户实际选择了「个」作为调味品计量单位。

由此推导出的行为：

| 行为 | 说明 |
|---|---|
| 不为 sentinel 自动给调味品加 `个` | 调味品的 `allowed_units` 保持为空 |
| 调味品 → 调味品 切换**跳过** allowed-unit 校验 | sentinel 不参与调味品语义 |
| 调味品不进临期系统 | `expiry_date = NULL` ⇒ `no_expiry` |
| 调味品的 `quantity = 0` **仍显示在列表** | 普通食材的 `quantity <= 0` 隐藏规则**不适用于调味品**，反之该规则也**未被放宽** |
| UI 显示「有」 | 不显示数量 / 单位 / 入库日期 / 生产日期 / 保质期 / 储存方式 |
| 重复添加同一调味品保持幂等 | 返回已有记录，不新增第二条「有」 |

### 13.6 食材库存的跨类切换

修改库存的 `definition_id` 时：

| 切换 | 结果 |
|---|---|
| 普通 → 普通 | ✅ 允许（仍执行普通 unit 校验） |
| 调味品 → 调味品 | ✅ 允许（**跳过** allowed-unit 校验） |
| 普通 → 调味品 | ❌ `409 CATEGORY_TRANSITION_NOT_ALLOWED` |
| 调味品 → 普通 | ❌ `409 CATEGORY_TRANSITION_NOT_ALLOWED` |

**为什么拒绝跨类**：

普通库存携带真实的数量 / 单位 / 日期 / 储存方式；调味品库存是 presence-only。
两者的字段语义不同，系统**无法猜测**跨类时这些字段应该如何转换
（把真实数量静默改成 sentinel，或让 sentinel 继承真实数量，都会产生语义错误的库存）。
因此**直接拒绝，由用户删除后重新添加**。

**失败必须是完全原子性的 no-op**，以下字段**全部保持不变**：

```
definition_id      quantity           unit
purchase_date      production_date    expiry_date
expiry_date_source storage_method     note
updated_at
```

### 13.7 分类管理

- 入口位于**设置页**，点击后在**当前 React 应用内**打开 Modal/Dialog
  （不使用 `window.open`，不打开新窗口 / 新标签页）
- 支持新建（仅名称，自动 trim）、删除（二次确认）、Escape 关闭、列表滚动

| 操作 | 结果 |
|---|---|
| `GET /api/categories` | 列出全部分类（按 `sort_order`），含 `color`（v0.1.4） |
| `POST /api/categories` | 201 / 400（空名称）/ 409（重名） |
| `PATCH /api/categories/:id` | 200 / 400 / 404，**更新分类颜色**（v0.1.4，仅 `color` 字段） |
| `DELETE /api/categories/:id` | 204 / 400 / 404 / **409 `CATEGORY_IN_USE`** |

**删除保护**：只要仍有**任何** `ingredient_definition` 引用该分类，就拒绝删除。

- ❌ 不级联删除食材
- ❌ 不自动移动食材到其他分类
- ❌ 不把 `category_id` 置 NULL
- ✅ 删除失败时**原子性保持**（category 表与 definition 表均不变）

---

## 14. 架构原则总结（补充）

在原有 9 条之外，v0.1.2 / v0.1.3 增加：

10. **临期状态由后端计算**，前端只做文案映射，不自行判断日期
11. **排序由后端执行**，前端只传参，不复制排序规则；库存排序与食材库排序相互独立
12. **分类不是身份** —— `definition_id` 是唯一稳定 identity
13. **不猜测用户的真实意图** —— 跨类切换语义无法推断时直接拒绝，而不是替用户决定
14. **特殊行为由分类推导**（`category === '调味品'`），不引入 `type` 字段
15. **内部兼容值不下沉到业务语义** —— sentinel 只在存储层，UI 与 API 表达「有 / 无」

---

## 15. 菜谱模块（v0.2.0）

### 15.1 分层

| 层 | 位置 | 职责 |
|---|---|---|
| 路由层 | `server/src/routes/recipes.ts` | query / body schema 校验（`additionalProperties: false`）、错误映射 |
| 业务层 | `server/src/services/recipeService.ts` | 列表、详情、新建、**统一保存**、删除、Tag 关联、搜索 / 筛选 / 排序 |
| 业务层 | `server/src/services/recipeListSettingsService.ts` | 列表设置读写（**复用 `app_settings` 单行表**，不新建独立表） |
| 数据层 | `server/drizzle/0007_recipe.sql`、`0008_recipe_list_settings.sql` | 四张新表 + `app_settings` 4 个可空列 |
| 前端 | `client/src/pages/RecipesPage.tsx` 等 | 列表 / 详情 / 表单 / Tag 弹窗 |

### 15.2 数据模型

- `recipe` —— 菜谱主表（名称唯一）
- `recipe_ingredient` —— 菜谱与食材定义的关系，
  **允许重复关联同一食材**，按 `sort_order` 固定展示顺序
- `recipe_tag` —— Tag（同名不重复）
- `recipe_tag_link` —— 菜谱与 Tag 的多对多关系

字段与约束详见 `DATABASE_DESIGN.md` 第 16 节。

### 15.3 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/recipes` | 列表（`search` / `tags`（可重复）/ `tag_mode` / `sort` / `order`） |
| GET | `/api/recipes/:id` | 详情（含食材明细与 Tag） |
| POST | `/api/recipes` | 新建（**单事务**：菜谱 + 食材关联 + Tag 关联） |
| PATCH | `/api/recipes/:id/full` | **统一保存**（基本信息 + 食材关联 + Tag 关联，单事务） |
| DELETE | `/api/recipes/:id` | 删除菜谱**及其关联**（不删除食材定义，也不删除 Tag 本身） |
| GET | `/api/tags` | Tag 列表 |
| POST | `/api/tags` | 新建 Tag（同名返回 `DUPLICATE_NAME`） |
| DELETE | `/api/tags/:id` | 删除 Tag |
| GET | `/api/recipe-list-settings` | 读取列表设置 |
| PATCH | `/api/recipe-list-settings` | 更新列表设置（部分更新） |

> ⚠️ `PATCH /api/recipes/:id/full` 采用「**全删后重建**」实现关联更新，
>    因此返回详情中的 `recipe_ingredient.id` 会变化 —— 前端**不得**用它做渲染 key。

### 15.4 搜索与筛选语义（重要）

- **搜索只匹配菜谱名称**（大小写不敏感、子字符串匹配）
- **Tag 名称不参与搜索**；Tag 只通过 `tags` 参数筛选
- 搜索与 Tag 筛选同时使用时为 **AND** 关系
- Tag 筛选支持 **AND / OR**（默认 AND，可在选择窗口切换并持久化）

### 15.5 前端组件

| 文件 | 职责 |
|---|---|
| `client/src/pages/RecipesPage.tsx` | 列表 / 详情视图切换、搜索防抖、请求序号竞态保护、设置串行化持久化 |
| `client/src/components/RecipeDetailView.tsx` | 详情只读展示（含空数据提示） |
| `client/src/components/RecipeCreateForm.tsx` | **新建与编辑共用**（`initial` 决定模式），含同步提交锁 |
| `client/src/components/RecipeFilterBar.tsx` | 名称搜索 + 排序行、已选 Tag + 选择入口行 |
| `client/src/components/TagSelectDialog.tsx` | 独立 Tag 选择弹窗（多选 / AND-OR / 新建 Tag） |
| `client/src/components/RecipeList.tsx` | 列表渲染 |

### 15.6 已知未覆盖（不阻塞发布）

- **快速切换菜谱的竞态窗口未能在浏览器中制造**（详情加载中界面只渲染「加载中…」，
  没有返回入口），代码层面已用请求序号 + 卸载时失效在途请求保护
- **中文 IME 组合输入**与**键盘可达性**（Tab 顺序、`Escape` 关闭弹窗）未专门验证；
  既有弹窗同样不具备焦点陷阱，属项目现状

---

## 16. 后续阶段

以下内容**尚未实现**，在后续阶段确定：

- 根据库存判断菜谱能否制作（库存联动）
- 菜品推荐（meal recommendation）
- DeepSeek AI 接入
- 采购清单
- 消耗历史记录
- 单位换算
- 食材定义合并
- 录入时的名称解析实时预览接口
- 菜谱份数系统、照片上传、完整制作流程编辑
